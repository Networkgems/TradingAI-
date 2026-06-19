// TRA-954 — Risk-capped conviction DCA (scale-in) for equities + options.
//
// Board request (TRA-951, local-board 2026-06-19): "add a DCA for options and
// stocks if we're holding and know it's a good position, calls or puts. we need
// time and hold a bit longer. don't break our stop-loss limit rules."
//
// This is the pure, config-driven decision core. It lives in
// `@trading-app/shared` so the SAME thresholds and the SAME risk arithmetic are
// used by every caller (equity engine, options account, backtester) — one
// source of truth, mirroring the no-day-trading guardrail (TRA-598).
//
// ── The non-negotiable invariant ───────────────────────────────────────────
// DCA averages SIZE, never the STOP. An add must NEVER push total per-position
// dollar risk above the per-position risk budget R (the same R the 5-layer risk
// gate enforces, e.g. 1% of equity). The classic DCA failure mode is widening
// the stop to "give it room" — that is explicitly forbidden here: the stop is an
// input, fixed, and the only free variable we solve for is the add quantity.
//
// ── Why the cap is exact (the key identity) ────────────────────────────────
// For a long, post-add dollar risk is, by definition,
//     risk = (blended_avg − stop) × total_qty
// Substituting blended_avg = (existing_qty·avg + add_qty·add_price) / total_qty
// and total_qty = existing_qty + add_qty, the total_qty cancels and the
// expression collapses to a form LINEAR in add_qty:
//     risk = existing_qty·(avg − stop) + add_qty·(add_price − stop)
// So the largest add that still satisfies risk ≤ R has a closed form:
//     max_add_qty = (R − existing_qty·(avg − stop)) / (add_price − stop)
// We size the add to min(requested, max_add_qty). If max_add_qty rounds below
// one tradable unit, the add cannot fit and is SKIPPED — we never breach R, and
// we never touch the stop to make room. Shorts are symmetric (stop above entry).
//
// ── Options ────────────────────────────────────────────────────────────────
// For defined-risk longs (long calls/puts, debit spreads) the dollar risk IS the
// premium paid — there is no stop to solve against. The cap is simply
//     total_premium_at_risk ≤ R
// and the max add in contracts is (R − premium_so_far) / (debit_per_contract).
// Adding to short premium is refused outright (unbounded / margin risk).

// ─────────────────────────────────────────────────────────────────────────────
// Config surface (TRA-954 §"Config surface" — exposed as preset params)
// ─────────────────────────────────────────────────────────────────────────────

/** Central, config-driven thresholds for the conviction-DCA sizing layer. */
export interface ConvictionDcaConfig {
  /** Master on/off. When false, every evaluator returns a `skip` verdict. */
  enabled: boolean;
  /**
   * Max number of ADDS after the initial entry (not counting the entry).
   * Default 2 → 3 tranches total (entry + 2 adds).
   */
  maxAdds: number;
  /**
   * Fraction of the R-budgeted full size allocated to each tranche, entry-first.
   * Default [0.5, 0.3, 0.2]. Length should be `maxAdds + 1`; the entry consumes
   * index 0, add #1 index 1, etc. Sizing still re-checks the hard R cap on every
   * add, so the split is a target — the cap is the law.
   */
  trancheSplit: readonly number[];
  /**
   * Equity pullback ladder spacing in ATR(14): an add is only eligible once price
   * has pulled back at least this many ATRs from the PRIOR fill. Default 1.0
   * (the ladder is −1.0 ATR then −2.0 ATR from each prior fill).
   */
  equityAddSpacingATR: number;
  /** Minimum bars between adds (anti-stacking). Default 1. */
  minSpacingBars: number;
  /**
   * Minimum ATR(14) of adverse move between adds, AND-ed with `minSpacingBars`
   * (TRA-954 equity "Guards": ">= 1 bar AND >= 0.75 ATR between adds"). Default 0.75.
   */
  minSpacingATR: number;
  /** Options: hard floor on remaining DTE to add. Adding into < this lets theta dominate. Default 21. */
  optionMinDTE: number;
  /**
   * Options liquidity guard: refuse the add when the spread's bid/ask width as a
   * fraction of its mid exceeds this. Default 0.10 (10%).
   */
  optionMaxSpreadWidthPct: number;
  /** When true (hard, default), a tripped daily-loss limit blocks ALL adds. */
  respectDailyLossLimit: boolean;
  /** No add inside the last N minutes of the session. Default 30. */
  noAddLastMinutes: number;
  /**
   * Options conviction floor (TRA-958 gate A): the add contract must carry real
   * directional exposure — `|delta| >= this`. Averaging into a far-OTM (low-delta)
   * contract is averaging into a decay machine, the opposite of a conviction add.
   * No upper cap — deep-ITM behaves like stock and is fine. Default 0.35.
   */
  optionMinAddDelta: number;
  /**
   * Event blackout (TRA-958 gate B): no ADD within this many trading days before a
   * scheduled underlying earnings date (equities + options). Conviction can
   * evaporate on a binary event; we never pyramid into one. The initial entry is
   * unaffected — adds only. Default 2.
   */
  earningsBlackoutTradingDays: number;
  /**
   * Per-name daily add cap (TRA-958 gate C): hard cap on adds for a single symbol
   * per session. `minSpacingBars=1` covers swing (1 daily bar = 1 day) but on an
   * intraday path it would permit stacking both adds in one ugly session; this
   * forbids that. Default 1.
   */
  maxAddsPerNamePerDay: number;
}

/** Documented shipped defaults. Changing the product stance is a one-line edit here. */
export const CONVICTION_DCA: ConvictionDcaConfig = {
  enabled: false, // opt-IN; promotion to live is gated on QuantTrader sign-off (acceptance #6)
  maxAdds: 2,
  trancheSplit: [0.5, 0.3, 0.2],
  equityAddSpacingATR: 1.0,
  minSpacingBars: 1,
  minSpacingATR: 0.75,
  optionMinDTE: 21,
  optionMaxSpreadWidthPct: 0.1,
  respectDailyLossLimit: true,
  noAddLastMinutes: 30,
  optionMinAddDelta: 0.35, // TRA-958 gate A
  earningsBlackoutTradingDays: 2, // TRA-958 gate B
  maxAddsPerNamePerDay: 1, // TRA-958 gate C
};

// ─────────────────────────────────────────────────────────────────────────────
// Shared types
// ─────────────────────────────────────────────────────────────────────────────

export type DcaSide = 'long' | 'short';

/** What an evaluator decided to do with a proposed add. */
export type DcaAction = 'add' | 'shrink' | 'skip';

/** A single fill making up the current position (chronological). */
export interface PositionTranche {
  /** Signed-magnitude quantity of this fill (always positive; `side` carries direction). */
  qty: number;
  /** Fill price (per share, or per-contract net debit for options). */
  price: number;
}

/** Outcome of an add evaluation. `add`/`shrink` carry the qty to execute; `skip` → qty 0. */
export interface DcaVerdict {
  action: DcaAction;
  /** Quantity to add now. 0 when `skip`. For `shrink`, < the requested qty. */
  qty: number;
  /** Human-readable reason (always present; explains a skip/shrink for logs + UI). */
  reason: string;
  /** R budget used for the cap (dollars), echoed for the audit log. */
  riskBudget: number;
  /** Blended average entry AFTER applying `qty` (present for add/shrink). */
  blendedAvg?: number;
  /** Total position dollar-risk AFTER applying `qty` — the audited `(avg−stop)·qty`. */
  projectedRisk?: number;
  /** Total quantity AFTER applying `qty`. */
  totalQty?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure math helpers
// ─────────────────────────────────────────────────────────────────────────────

/** Total signed quantity across tranches. */
export function totalQty(tranches: readonly PositionTranche[]): number {
  return tranches.reduce((s, t) => s + t.qty, 0);
}

/** Quantity-weighted average entry across tranches. Returns 0 for an empty position. */
export function blendedAverage(tranches: readonly PositionTranche[]): number {
  const q = totalQty(tranches);
  if (q <= 0) return 0;
  const notional = tranches.reduce((s, t) => s + t.qty * t.price, 0);
  return notional / q;
}

/**
 * Per-position dollar risk against a FIXED stop: `(avg − stop)·qty` for a long,
 * `(stop − avg)·qty` for a short. Never negative for a well-formed position
 * (stop below entry for longs, above for shorts); a "negative" result means the
 * stop is already on the wrong side, which the caller's bracket validation rejects.
 */
export function positionRiskDollars(avg: number, stop: number, qty: number, side: DcaSide): number {
  const perUnit = side === 'long' ? avg - stop : stop - avg;
  return perUnit * qty;
}

/**
 * Largest add quantity at `addPrice` that keeps post-add risk ≤ `riskBudget`,
 * holding the stop fixed. Closed form from the linearised risk identity (see
 * module header). Returns 0 when the existing position already consumes the full
 * budget, and `Infinity`-safe: a non-positive risk-per-added-unit (add on the
 * wrong side of the stop) yields 0 rather than an unbounded add.
 */
export function maxAddQtyWithinRisk(
  tranches: readonly PositionTranche[],
  addPrice: number,
  stop: number,
  side: DcaSide,
  riskBudget: number,
): number {
  const existingQty = totalQty(tranches);
  const avg = blendedAverage(tranches);
  const existingRisk = existingQty > 0 ? positionRiskDollars(avg, stop, existingQty, side) : 0;
  // Risk added per unit of the new tranche (long: add_price − stop; short: stop − add_price).
  const riskPerAddedUnit = side === 'long' ? addPrice - stop : stop - addPrice;
  if (riskPerAddedUnit <= 0) {
    // The add sits at/through the stop — it would carry zero or negative marginal
    // risk only because it is already a loser at entry; refuse rather than size up.
    return 0;
  }
  const headroom = riskBudget - existingRisk;
  if (headroom <= 0) return 0;
  return headroom / riskPerAddedUnit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Equity scale-in
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs describing the live equity position + market context for an add decision. */
export interface EquityAddContext {
  side: DcaSide;
  /** Chronological fills making up the open position (entry first). */
  tranches: readonly PositionTranche[];
  /** The single, fixed position stop. We size against this; we never move it. */
  stop: number;
  /** Per-position risk budget R in dollars (e.g. 1% of equity). */
  riskBudget: number;
  /** Current price of the proposed add fill. */
  addPrice: number;
  /** ATR(14) on the working timeframe, used for the pullback ladder + spacing. */
  atr: number;
  /** Trend reference (e.g. SMA-50). A long add requires price still above it. */
  trendRef: number;
  /** False once the original entry signal has flipped to exit — hard block. */
  signalStillValid: boolean;
  /** Bars elapsed since the most recent fill (entry or last add). */
  barsSinceLastFill: number;
  /** Minutes remaining in the session; an add inside `noAddLastMinutes` is blocked. */
  minutesToSessionClose: number;
  /** Portfolio gross-exposure cap already breached → block. */
  grossExposureBreached: boolean;
  /** Daily-loss limit already tripped → block (when `respectDailyLossLimit`). */
  dailyLossLimitBreached: boolean;
  /**
   * Trading days until this name's next scheduled earnings, or `null` when none is
   * scheduled/known. An add inside `earningsBlackoutTradingDays` is blocked (gate B).
   */
  tradingDaysToEarnings: number | null;
  /** Adds already executed for THIS name during the current session (gate C). */
  addsToday: number;
}

const MIN_EQUITY_UNIT = 1; // one share — the smallest add we will place

function skip(reason: string, riskBudget: number): DcaVerdict {
  return { action: 'skip', qty: 0, reason, riskBudget };
}

/**
 * Shared event + cadence hard gates (TRA-958 gates C and B) used by both the
 * equity and options evaluators. Returns a `skip` verdict when an add is blocked
 * by the per-name daily add cap or the earnings blackout, else `null`.
 *
 * `tradingDaysToEarnings` is `null` when no earnings is scheduled/known — the
 * blackout only fires against a known event (the caller owns supplying it).
 */
function eventCadenceSkip(
  addsToday: number,
  tradingDaysToEarnings: number | null,
  R: number,
  config: ConvictionDcaConfig,
): DcaVerdict | null {
  // ── Gate C: max adds per name per session ──
  if (addsToday >= config.maxAddsPerNamePerDay) {
    return skip(`already added ${addsToday}x today (max ${config.maxAddsPerNamePerDay}/name/day)`, R);
  }
  // ── Gate B: earnings/event blackout (adds only; initial entry is unaffected) ──
  if (tradingDaysToEarnings !== null && tradingDaysToEarnings <= config.earningsBlackoutTradingDays) {
    return skip(
      `earnings in ${tradingDaysToEarnings} trading day(s) — inside ${config.earningsBlackoutTradingDays}-day blackout, no add`,
      R,
    );
  }
  return null;
}

/**
 * Decide whether (and how much) to scale into an EQUITY position. Runs the
 * eligibility gates first (cheap, hard blocks), then solves the exact R cap.
 *
 * Returns `skip` (with a reason) when any gate fails or nothing fits; `add` when
 * the full requested ladder tranche fits; `shrink` when only a smaller add fits.
 */
export function evaluateEquityDcaAdd(
  ctx: EquityAddContext,
  config: ConvictionDcaConfig = CONVICTION_DCA,
): DcaVerdict {
  const R = ctx.riskBudget;
  if (!config.enabled) return skip('DCA disabled (dca.enabled=false)', R);

  // ── Hard portfolio gates (TRA-954 §"Guards" + acceptance #5) ──
  if (config.respectDailyLossLimit && ctx.dailyLossLimitBreached) {
    return skip('daily-loss limit tripped — all adds blocked', R);
  }
  if (ctx.grossExposureBreached) {
    return skip('portfolio gross-exposure cap breached — add blocked', R);
  }

  // ── Event + cadence hard gates (TRA-958 gates C + B) ──
  const eventSkip = eventCadenceSkip(ctx.addsToday, ctx.tradingDaysToEarnings, R, config);
  if (eventSkip) return eventSkip;

  // ── Tranche budget ──
  const addsUsed = Math.max(0, ctx.tranches.length - 1);
  if (addsUsed >= config.maxAdds) {
    return skip(`max adds reached (${addsUsed}/${config.maxAdds})`, R);
  }

  // ── Thesis + trend gates (acceptance #3: a trend break is an EXIT, not an add) ──
  if (!ctx.signalStillValid) {
    return skip('entry signal flipped to exit — thesis broken, no add', R);
  }
  const trendIntact = ctx.side === 'long' ? ctx.addPrice > ctx.trendRef : ctx.addPrice < ctx.trendRef;
  if (!trendIntact) {
    const rel = ctx.side === 'long' ? 'below' : 'above';
    return skip(`price ${rel} trend reference (${ctx.trendRef}) — trend break is an exit, not an add`, R);
  }

  // ── Session gate ──
  if (ctx.minutesToSessionClose < config.noAddLastMinutes) {
    return skip(`within last ${config.noAddLastMinutes}m of session — no add`, R);
  }

  // ── Spacing gate: bars AND ATR of adverse move since the last fill ──
  if (ctx.barsSinceLastFill < config.minSpacingBars) {
    return skip(`spacing: only ${ctx.barsSinceLastFill} bar(s) since last fill (need ${config.minSpacingBars})`, R);
  }
  const lastFill = ctx.tranches[ctx.tranches.length - 1];
  if (lastFill && ctx.atr > 0) {
    const adverseMove = ctx.side === 'long' ? lastFill.price - ctx.addPrice : ctx.addPrice - lastFill.price;
    const adverseAtr = adverseMove / ctx.atr;
    if (adverseAtr < config.minSpacingATR) {
      return skip(
        `spacing: ${adverseAtr.toFixed(2)} ATR pullback since last fill (need >= ${config.minSpacingATR})`,
        R,
      );
    }
    // Pullback ladder: the add level is at least `equityAddSpacingATR` ATR from the prior fill.
    if (adverseAtr < config.equityAddSpacingATR) {
      return skip(
        `not at add level: ${adverseAtr.toFixed(2)} ATR from last fill (ladder needs >= ${config.equityAddSpacingATR})`,
        R,
      );
    }
  }

  // ── Exact R cap (the invariant) ──
  const maxQty = maxAddQtyWithinRisk(ctx.tranches, ctx.addPrice, ctx.stop, ctx.side, R);
  if (maxQty < MIN_EQUITY_UNIT) {
    return skip(`add cannot fit risk budget R=${R} without widening the stop — skipped`, R);
  }

  // Target this tranche from the split, but the hard cap always wins.
  const fullSize = rBudgetedFullSize(ctx.stop, ctx.addPrice, ctx.side, R, ctx.tranches);
  const splitIdx = addsUsed + 1; // entry already placed → next add index
  const splitFrac = config.trancheSplit[splitIdx] ?? 0;
  const targetQty = Math.floor(fullSize * splitFrac);
  const requestedQty = Math.max(MIN_EQUITY_UNIT, targetQty);

  const cappedQty = Math.min(requestedQty, Math.floor(maxQty));
  const action: DcaAction = cappedQty < requestedQty ? 'shrink' : 'add';

  const newTranches = [...ctx.tranches, { qty: cappedQty, price: ctx.addPrice }];
  const newAvg = blendedAverage(newTranches);
  const newQty = totalQty(newTranches);
  const projectedRisk = positionRiskDollars(newAvg, ctx.stop, newQty, ctx.side);

  return {
    action,
    qty: cappedQty,
    reason:
      action === 'shrink'
        ? `shrunk to ${cappedQty} (from target ${requestedQty}) to hold (avg−stop)·qty <= R`
        : `add ${cappedQty}; blended risk ${projectedRisk.toFixed(2)} <= R=${R}`,
    riskBudget: R,
    blendedAvg: newAvg,
    projectedRisk,
    totalQty: newQty,
  };
}

/**
 * The R-budgeted "full size" the tranche split is a fraction OF: the share count
 * whose worst-case loss to the stop equals R, measured from the would-be blended
 * stop distance. We approximate with the current add level's per-share risk so
 * the 50/30/20 split lands tranches that, summed, sit at ~R against the stop.
 */
function rBudgetedFullSize(
  stop: number,
  addPrice: number,
  side: DcaSide,
  riskBudget: number,
  tranches: readonly PositionTranche[],
): number {
  const ref = tranches.length > 0 ? blendedAverage(tranches) : addPrice;
  const perUnit = side === 'long' ? ref - stop : stop - ref;
  if (perUnit <= 0) return 0;
  return riskBudget / perUnit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options scale-in (defined-risk only)
// ─────────────────────────────────────────────────────────────────────────────

/** Inputs describing a live defined-risk options position + add context. */
export interface OptionAddContext {
  /** True for long calls/puts + debit spreads. Adding to short premium is refused. */
  definedRisk: boolean;
  /** Existing tranches; `price` is the per-contract NET DEBIT paid (premium at risk). */
  tranches: readonly PositionTranche[];
  /** Per-position risk budget R in dollars. */
  riskBudget: number;
  /** Per-contract net debit of the proposed add (premium at risk per contract). */
  addDebitPerContract: number;
  /** Remaining days-to-expiration. Adding into < `optionMinDTE` is refused (theta). */
  dte: number;
  /**
   * Signed delta of the proposed ADD contract (calls positive, puts negative). The
   * add must carry `|delta| >= optionMinAddDelta` (gate A) — real directional
   * exposure, not a far-OTM lottery leg. No upper cap.
   */
  addDelta: number;
  /** Underlying still confirms the directional thesis (same SMA-50 / signal check as equities). */
  underlyingThesisConfirmed: boolean;
  /** Spread bid/ask width as a fraction of mid — liquidity guard. */
  spreadWidthPct: number;
  /** Already at the max contracts allowed for this name → block. */
  atMaxContracts: boolean;
  /** Daily-loss limit tripped → block (when `respectDailyLossLimit`). */
  dailyLossLimitBreached: boolean;
  /** Portfolio gross-exposure cap breached → block. */
  grossExposureBreached: boolean;
  /**
   * Trading days until the underlying's next scheduled earnings, or `null` when
   * none is scheduled/known. An add inside `earningsBlackoutTradingDays` is blocked (gate B).
   */
  tradingDaysToEarnings: number | null;
  /** Adds already executed for THIS name during the current session (gate C). */
  addsToday: number;
}

const MIN_OPTION_UNIT = 1; // one contract

/**
 * Decide whether (and how many contracts) to scale into a DEFINED-RISK options
 * position. The dollar risk IS the premium paid, so the cap is
 * `total_premium ≤ R` and the max add is `(R − premium_so_far)/debit_per_contract`.
 */
export function evaluateOptionDcaAdd(
  ctx: OptionAddContext,
  config: ConvictionDcaConfig = CONVICTION_DCA,
): DcaVerdict {
  const R = ctx.riskBudget;
  if (!config.enabled) return skip('DCA disabled (dca.enabled=false)', R);

  // ── Defined-risk gate (TRA-954: no adding to short premium) ──
  if (!ctx.definedRisk) {
    return skip('not defined-risk (short premium) — DCA refused', R);
  }

  // ── Hard portfolio gates (acceptance #5) ──
  if (config.respectDailyLossLimit && ctx.dailyLossLimitBreached) {
    return skip('daily-loss limit tripped — all adds blocked', R);
  }
  if (ctx.grossExposureBreached) {
    return skip('portfolio gross-exposure cap breached — add blocked', R);
  }

  // ── Event + cadence hard gates (TRA-958 gates C + B) ──
  const eventSkip = eventCadenceSkip(ctx.addsToday, ctx.tradingDaysToEarnings, R, config);
  if (eventSkip) return eventSkip;

  // ── Tranche budget ──
  const addsUsed = Math.max(0, ctx.tranches.length - 1);
  if (addsUsed >= config.maxAdds) {
    return skip(`max adds reached (${addsUsed}/${config.maxAdds})`, R);
  }

  // ── DTE gate (acceptance #4) ──
  if (ctx.dte < config.optionMinDTE) {
    return skip(`DTE ${ctx.dte} < ${config.optionMinDTE} — theta-dominated, no add`, R);
  }

  // ── Conviction delta floor (TRA-958 gate A): no averaging into a far-OTM decay leg ──
  if (Math.abs(ctx.addDelta) < config.optionMinAddDelta) {
    return skip(
      `add |delta| ${Math.abs(ctx.addDelta).toFixed(2)} < floor ${config.optionMinAddDelta} — too far OTM for a conviction add`,
      R,
    );
  }

  // ── Thesis gate (acceptance #4): the UNDERLYING must still confirm, not IV crush ──
  if (!ctx.underlyingThesisConfirmed) {
    return skip('underlying no longer confirms thesis — no averaging down on IV crush', R);
  }

  // ── Liquidity + capacity guards ──
  if (ctx.spreadWidthPct > config.optionMaxSpreadWidthPct) {
    return skip(
      `spread width ${(ctx.spreadWidthPct * 100).toFixed(1)}% > cap ${(config.optionMaxSpreadWidthPct * 100).toFixed(1)}%`,
      R,
    );
  }
  if (ctx.atMaxContracts) {
    return skip('already at max contracts for the name — no add', R);
  }

  // ── Premium-at-risk cap ──
  if (ctx.addDebitPerContract <= 0) {
    return skip(`invalid add debit (${ctx.addDebitPerContract})`, R);
  }
  const premiumSoFar = ctx.tranches.reduce((s, t) => s + t.qty * t.price, 0);
  const headroom = R - premiumSoFar;
  const maxContracts = Math.floor(headroom / ctx.addDebitPerContract);
  if (maxContracts < MIN_OPTION_UNIT) {
    return skip(`add cannot fit premium budget R=${R} (premium so far ${premiumSoFar.toFixed(2)}) — skipped`, R);
  }

  // Target from the split; cap always wins.
  const fullContracts = Math.floor(R / ctx.addDebitPerContract);
  const splitIdx = addsUsed + 1;
  const splitFrac = config.trancheSplit[splitIdx] ?? 0;
  const targetContracts = Math.max(MIN_OPTION_UNIT, Math.floor(fullContracts * splitFrac));
  const cappedContracts = Math.min(targetContracts, maxContracts);
  const action: DcaAction = cappedContracts < targetContracts ? 'shrink' : 'add';

  const projectedRisk = premiumSoFar + cappedContracts * ctx.addDebitPerContract;
  return {
    action,
    qty: cappedContracts,
    reason:
      action === 'shrink'
        ? `shrunk to ${cappedContracts} contract(s) (from ${targetContracts}) to hold total premium <= R`
        : `add ${cappedContracts} contract(s); total premium ${projectedRisk.toFixed(2)} <= R=${R}`,
    riskBudget: R,
    projectedRisk,
    totalQty: totalQty(ctx.tranches) + cappedContracts,
  };
}
