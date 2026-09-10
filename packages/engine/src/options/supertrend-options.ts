import type { OptionType, Side } from '@trading-app/shared';
import { blackScholesDelta } from './black-scholes.js';
import type { RiskManager } from '../risk.js';

/**
 * TRA-728 (Phase 1) — options-selection + IV-gate + exit/sizing hooks for the
 * SupertrendConfluence signal.
 *
 * STRUCTURE-ONLY scaffold: every threshold below is a starting point exposed as
 * a parameter so the Phase-2 sweep can tune it. Nothing here routes to live; the
 * functions are pure (apart from {@link sizeOptionContracts}, which reads live
 * equity off the supplied {@link RiskManager}) so they are golden-fixture
 * testable. Greeks/IV reads reuse {@link blackScholesDelta}; IV-rank is passed in
 * by the caller (the IV store lives in the server package — the engine stays
 * dependency-free and never fabricates a rank).
 */

// ---------------------------------------------------------------------------
// 1. IV gate → structure selection
// ---------------------------------------------------------------------------

export type OptionsStructure = 'single_leg' | 'debit_vertical' | 'credit_spread';

export interface IvGateParams {
  /** Below this IV-rank, prefer a single-leg call/put (default 40). */
  singleLegMaxIvRank: number;
  /** At/above this IV-rank, switch to a debit vertical to cut vega (default 60). */
  verticalMinIvRank: number;
  /**
   * TRA-1974 — event-IV "sell-the-crush" min IV-rank (default 50). When a
   * scheduled catalyst (earnings — primary; FOMC — secondary) sits INSIDE the
   * candidate's expiry AND IV-rank ≥ this, prefer a net-credit defined-risk
   * structure over any long-vega debit: a long-premium debit into the event gets
   * IV-crushed on the post-event vol collapse, so we sell the rich premium with a
   * capped wing instead. Set deliberately BELOW {@link verticalMinIvRank} (60):
   * a known catalyst LOWERS the bar for going credit, because the post-event
   * crush is the specific, dated risk the rule exists to dodge.
   */
  eventIvMinRank: number;
}

export const DEFAULT_IV_GATE: IvGateParams = {
  singleLegMaxIvRank: 40,
  verticalMinIvRank: 60,
  eventIvMinRank: 50,
};

export interface StructureDecision {
  structure: OptionsStructure;
  reason: string;
}

/**
 * TRA-1974 — point-in-time catalyst proximity for the event-IV rule. A catalyst
 * "sits inside" the expiry when it is scheduled at/before the candidate's
 * expiration (`0 <= daysAway <= daysToExpiration`), so the option is still open
 * across the vol event. Absent/`null` → uncovered (no trigger; we never fabricate
 * a catalyst).
 */
export interface EventProximity {
  /** Days to next scheduled earnings (C1), or `null` if none/uncovered. Primary trigger. */
  nextEarningsInDays: number | null;
  /** Days to the next FOMC decision (C2), or `null` if unknown. Secondary, lower-priority trigger. */
  daysToFOMC: number | null;
  /** The candidate's days-to-expiration — the window the catalyst must sit inside. */
  daysToExpiration: number;
}

/** A catalyst `daysAway` sits inside a `dte`-day expiry when 0 ≤ daysAway ≤ dte. */
function catalystInsideExpiry(daysAway: number | null, dte: number): boolean {
  return daysAway !== null && Number.isFinite(daysAway) && daysAway >= 0 && daysAway <= dte;
}

/**
 * TRA-1974 — is the event-IV "sell-the-crush" rule active? True when IV is
 * elevated (`ivRank >= params.eventIvMinRank`) AND a scheduled catalyst sits
 * inside the candidate's expiry (earnings primary, FOMC secondary). Pure;
 * unknown IV-rank or no in-window catalyst → false (no fabricated edge).
 */
export function preferCreditForEvent(
  ivRank: number | null,
  event: EventProximity,
  params: IvGateParams = DEFAULT_IV_GATE,
): boolean {
  if (ivRank === null || !Number.isFinite(ivRank) || ivRank < params.eventIvMinRank) return false;
  return (
    catalystInsideExpiry(event.nextEarningsInDays, event.daysToExpiration) ||
    catalystInsideExpiry(event.daysToFOMC, event.daysToExpiration)
  );
}

/**
 * Pick the option structure from the underlying's IV-rank (0–100). Low IV → buy
 * premium outright (single leg); high IV → a debit vertical so we are not long
 * pure vega into a rich tape. In the in-between band (and when IV-rank is
 * unknown) we default to the single leg — the cheaper, simpler expression — and
 * let Phase 2 decide whether the dead-zone deserves its own rule.
 *
 * TRA-1974 — when `event` is supplied and the "sell-the-crush" rule is active
 * (catalyst inside the expiry + elevated IV), it takes PRIORITY over the plain
 * IV-rank bands and routes to a net-credit defined-risk structure: a long-vega
 * debit held across an earnings/FOMC print is exactly what the post-event vol
 * collapse crushes, so we sell the rich premium (capped wing) instead. Omitting
 * `event` preserves the legacy IV-rank-only behaviour verbatim.
 */
export function selectStructureByIv(
  ivRank: number | null,
  params: IvGateParams = DEFAULT_IV_GATE,
  event?: EventProximity,
): StructureDecision {
  // TRA-1974 — event-IV "sell-the-crush" first: a dated catalyst inside the
  // expiry with elevated IV overrides the plain IV bands (the debit would be
  // crushed post-event). Earnings is the primary trigger; FOMC the secondary.
  if (event && preferCreditForEvent(ivRank, event, params)) {
    const earningsInside = catalystInsideExpiry(event.nextEarningsInDays, event.daysToExpiration);
    const which = earningsInside
      ? `earnings in ${event.nextEarningsInDays}d`
      : `FOMC in ${event.daysToFOMC}d`;
    return {
      structure: 'credit_spread',
      reason: `sell_the_crush: ${which} inside ${event.daysToExpiration}d DTE, iv_rank ${(ivRank as number).toFixed(0)} >= ${params.eventIvMinRank}`,
    };
  }
  if (ivRank === null || !Number.isFinite(ivRank)) {
    return { structure: 'single_leg', reason: 'iv_rank_unknown' };
  }
  if (ivRank >= params.verticalMinIvRank) {
    return { structure: 'debit_vertical', reason: `iv_rank ${ivRank.toFixed(0)} >= ${params.verticalMinIvRank}` };
  }
  if (ivRank < params.singleLegMaxIvRank) {
    return { structure: 'single_leg', reason: `iv_rank ${ivRank.toFixed(0)} < ${params.singleLegMaxIvRank}` };
  }
  return { structure: 'single_leg', reason: `iv_rank ${ivRank.toFixed(0)} in dead-zone, defaulting single_leg` };
}

// ---------------------------------------------------------------------------
// 2. Expiry selection — 2-4 weeks out, no weeklies
// ---------------------------------------------------------------------------

export interface ExpiryParams {
  /** Minimum days-to-expiry (default 14 — two weeks). */
  minDays: number;
  /** Maximum days-to-expiry (default 28 — four weeks). */
  maxDays: number;
  /** Preferred target days-to-expiry; nearest wins (default 21 — three weeks). */
  targetDays: number;
  /** Reject weekly expirations (keep only standard monthlies). Default true. */
  excludeWeeklies: boolean;
}

export const DEFAULT_EXPIRY_PARAMS: ExpiryParams = {
  minDays: 14,
  maxDays: 28,
  targetDays: 21,
  excludeWeeklies: true,
};

export interface ExpiryCandidate {
  /** ISO `YYYY-MM-DD` expiration date. */
  expiration: string;
  /** Calendar days to expiry from the evaluation instant. */
  daysToExpiry: number;
  /**
   * Whether this is a standard monthly expiration (3rd Friday). When the chain
   * source does not flag it, callers can derive it via {@link isThirdFriday}.
   */
  isMonthly: boolean;
}

/** Is `YYYY-MM-DD` the third Friday of its month (the standard monthly expiry)? */
export function isThirdFriday(isoDate: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return false;
  const year = Number(m[1]);
  const month = Number(m[2]) - 1;
  const day = Number(m[3]);
  const dow = new Date(Date.UTC(year, month, day)).getUTCDay();
  if (dow !== 5) return false; // not a Friday
  return day >= 15 && day <= 21; // the Friday in this range is the 3rd Friday
}

/**
 * Choose the expiry closest to `targetDays` within `[minDays, maxDays]`,
 * optionally restricted to standard monthlies (no weeklies on this slow
 * confluence signal). Returns `null` when no candidate qualifies.
 */
export function selectExpiry(
  candidates: readonly ExpiryCandidate[],
  params: ExpiryParams = DEFAULT_EXPIRY_PARAMS,
): ExpiryCandidate | null {
  const eligible = candidates.filter(
    c =>
      c.daysToExpiry >= params.minDays &&
      c.daysToExpiry <= params.maxDays &&
      (!params.excludeWeeklies || c.isMonthly),
  );
  if (eligible.length === 0) return null;
  return eligible.reduce((best, c) =>
    Math.abs(c.daysToExpiry - params.targetDays) < Math.abs(best.daysToExpiry - params.targetDays)
      ? c
      : best,
  );
}

// ---------------------------------------------------------------------------
// 3. Delta-target strike selection (~0.60–0.70, slightly ITM)
// ---------------------------------------------------------------------------

export interface DeltaTargetParams {
  /** Preferred absolute delta (default 0.65 — slightly ITM). */
  target: number;
  /** Inclusive absolute-delta band (default [0.60, 0.70]). */
  band: [number, number];
}

export const DEFAULT_DELTA_PARAMS: DeltaTargetParams = {
  target: 0.65,
  band: [0.6, 0.7],
};

export interface StrikeCandidate {
  strike: number;
  /** Signed delta (calls positive, puts negative); use |delta| for selection. */
  delta: number;
}

/**
 * Pick the strike whose absolute delta is nearest `target`, preferring one
 * inside `band`. If no candidate falls inside the band, the nearest-to-target
 * outside it is returned (Phase 2 decides whether to harden this into a reject).
 * Returns `null` only when there are no candidates.
 */
export function selectStrikeByDelta(
  candidates: readonly StrikeCandidate[],
  params: DeltaTargetParams = DEFAULT_DELTA_PARAMS,
): StrikeCandidate | null {
  if (candidates.length === 0) return null;
  const [lo, hi] = params.band;
  const inBand = candidates.filter(c => Math.abs(c.delta) >= lo && Math.abs(c.delta) <= hi);
  const pool = inBand.length > 0 ? inBand : candidates;
  return pool.reduce((best, c) =>
    Math.abs(Math.abs(c.delta) - params.target) < Math.abs(Math.abs(best.delta) - params.target)
      ? c
      : best,
  );
}

/**
 * Build {@link StrikeCandidate}s by pricing Black-Scholes delta for a set of
 * strikes — used when the chain source omits Greeks. Reuses {@link blackScholesDelta}.
 */
export function deltasForStrikes(
  strikes: readonly number[],
  ctx: { spot: number; timeToExpiryYears: number; riskFreeRate: number; volatility: number; optionType: OptionType },
): StrikeCandidate[] {
  return strikes.map(strike => ({
    strike,
    delta: blackScholesDelta({
      spot: ctx.spot,
      strike,
      timeToExpiryYears: ctx.timeToExpiryYears,
      riskFreeRate: ctx.riskFreeRate,
      volatility: ctx.volatility,
      optionType: ctx.optionType,
    }),
  }));
}

/** The option type a side wants: long → call, short → put. */
export function optionTypeForSide(side: Side): OptionType {
  return side === 'buy' ? 'call' : 'put';
}

// ---------------------------------------------------------------------------
// 4. Exit rules (parameterized)
// ---------------------------------------------------------------------------

export interface ExitParams {
  /** Exit when Supertrend flips against the position. Default true. */
  supertrendFlipExit: boolean;
  /**
   * TRA-1409 — number of CONSECUTIVE bars the Supertrend must be flipped against
   * the position before the `supertrend_flip` exit fires. Default 1 (legacy
   * single-bar flip). Set >1 (RV demo sleeve = 2) to cut single-bar whipsaw
   * scratches so winners survive to `ma20_close_through`. Only tightens when
   * {@link ExitState.recentSupertrendDirections} is supplied; absent/short
   * history holds the flip exit (conservative) rather than firing on one bar.
   */
  supertrendFlipConfirmBars?: number;
  /**
   * TRA-1480 (v2, TRA-1409 follow-up) — winner-protect P&L gate on the
   * `supertrend_flip` structural exit. When set, a (confirmed) Supertrend flip
   * only exits a position whose premium P&L is AT OR BELOW this fraction
   * (a loss threshold, e.g. -0.20 = only flip-exit once down ≥20%). A
   * flat-or-winning RV position IGNORES the flip and runs to
   * `ma20_close_through` / `trail` / take-profit — the real winner exits.
   * This fixes the v1 residual where the 2-bar-confirmed flip still scratched
   * ~97% of RV exits at breakeven before MA20 developed. Undefined (the default)
   * keeps the legacy behaviour: the flip fires at any P&L. The flip stays fully
   * PROTECTIVE on real losers, and the risk-side stops are unaffected. Expected
   * range (-1, 0]; a value ≤ {@link ExitParams.premiumStopPct} is harmless (the
   * hard premium stop already fires first).
   */
  supertrendFlipMinLossPctToExit?: number;
  /** Exit when the underlying closes through its MA20. Default true. */
  ma20CloseThroughExit: boolean;
  /**
   * TRA-2949 — number of CONSECUTIVE bars the underlying must close through its
   * MA20 against the position before `ma20_close_through` fires (the same
   * confirm-bars idea as {@link ExitParams.supertrendFlipConfirmBars}). Default
   * 1 (legacy single-bar through). Only tightens when
   * {@link ExitState.recentMa20Through} is supplied; absent/short history holds
   * the exit (conservative) rather than firing on one bar.
   */
  ma20ConfirmBars?: number;
  /** Premium stop as a fraction of entry premium (default -0.50 = -50%). */
  premiumStopPct: number;
  /** Premium take-profit as a fraction of entry premium (default +1.00 = +100%). */
  premiumTakeProfitPct: number;
  /** Time stop in bars with no follow-through (default 5). Set 0 to disable. */
  timeStopBars: number;
  /**
   * TRA-2949 — trading-day time stop for SWING-HELD rows (live rows and demo
   * rows under `swingHoldOptions`). Those rows are suppressed by the PDT /
   * swing-hold gates on entry day, so by the time the hold releases at the next
   * open the bar-count stop ({@link ExitParams.timeStopBars}) is trivially
   * exceeded and mechanically closes the row at the open — the exact behaviour
   * the board rejected (TRA-2946). When {@link ExitState.swingHeld} is set,
   * this REPLACES the bar-count stop: the time stop fires only once the row has
   * been held ≥ this many TRADING days with no follow-through AND the
   * Supertrend is confirmed against the position (per
   * {@link ExitParams.supertrendFlipConfirmBars}). Default 4. Set 0 to disable
   * the time stop entirely for swing-held rows.
   */
  timeStopTradingDays?: number;
  /**
   * TRA-4500 (parent TRA-4290/TRA-4230, D1) — DTE-proportional minimum hold on
   * the two CHURN exits, `time_stop` and `ma20_close_through`. Neither may fire
   * on a position whose {@link ExitState.entryDte} is ≥
   * {@link ExitParams.dteMinHoldEntryDteFloor} until
   * `max(1, dteMinHoldFactor × entryDte)` full trading sessions have elapsed
   * (per {@link ExitState.tradingDaysHeld}). TRA-4230 measured these two exits
   * booking ~34-DTE options out after 33 min–2 h — 39% of desk closes, net
   * −7.8R to −36.6R once the measured spread cross is charged. Default 0.10
   * (34 DTE ⇒ 3.4 sessions). The gate binds ONLY the two churn exits: the
   * premium stop / take-profit above it and the `supertrend_flip` structural
   * exit are untouched, and the account-level stop family (`sl`, chandeliers,
   * `profit_lock`, `trail`) never flows through this function at all.
   */
  dteMinHoldFactor?: number;
  /**
   * TRA-4500 (D1) — entry-DTE floor at which the churn-exit minimum hold
   * engages. Positions with `entryDte` below this keep the legacy behaviour.
   * Default 21.
   */
  dteMinHoldEntryDteFloor?: number;
}

export const DEFAULT_EXIT_PARAMS: ExitParams = {
  supertrendFlipExit: true,
  supertrendFlipConfirmBars: 1,
  ma20CloseThroughExit: true,
  premiumStopPct: -0.5,
  premiumTakeProfitPct: 1.0,
  timeStopBars: 5,
  // TRA-2949 — in the default set so the swing-held trading-day stop is the
  // baseline behaviour (it only activates when the caller marks the state
  // `swingHeld`; bar-driven callers are unaffected).
  timeStopTradingDays: 4,
  // TRA-4500 (D1) — in the default set so every params object built by
  // spreading DEFAULT_EXIT_PARAMS (the RV re-tune branches included) carries
  // the churn-exit minimum hold. Only activates when the caller supplies
  // `ExitState.entryDte`; state-less callers (backtests) are byte-identical.
  dteMinHoldFactor: 0.1,
  dteMinHoldEntryDteFloor: 21,
};

export type ExitReason =
  | 'supertrend_flip'
  | 'ma20_close_through'
  | 'premium_stop'
  | 'premium_take_profit'
  | 'time_stop';

export interface ExitState {
  /** Position direction. */
  side: Side;
  /** Current Supertrend direction on the signal timeframe. */
  supertrendDirection: 'green' | 'red';
  /**
   * TRA-1409 — the last N Supertrend directions, MOST-RECENT-LAST (the final
   * element is this bar's direction, equal to {@link supertrendDirection}). Used
   * by {@link ExitParams.supertrendFlipConfirmBars} to require a multi-bar
   * confirmed flip. Optional: when absent the exit falls back to the legacy
   * single-bar behaviour.
   */
  recentSupertrendDirections?: readonly ('green' | 'red')[];
  /** Underlying close this bar. */
  underlyingClose: number;
  /** Underlying MA20 this bar. */
  ma20: number;
  /** Entry premium per share. */
  entryPremium: number;
  /** Current premium per share. */
  currentPremium: number;
  /** Bars elapsed since entry. */
  barsHeld: number;
  /**
   * Whether the trade has shown follow-through (e.g. made a new favorable
   * extreme). The time stop only fires when this is false.
   */
  hadFollowThrough: boolean;
  /**
   * TRA-2949 — whether this row is swing-held (a live row under the PDT
   * overnight hold, or a demo row under `swingHoldOptions`). When true and
   * {@link ExitParams.timeStopTradingDays} is set, the time stop counts
   * TRADING days ({@link ExitState.tradingDaysHeld}) instead of bars, and
   * additionally requires the Supertrend to be confirmed against the position.
   * Absent/false keeps the legacy bar-count stop.
   */
  swingHeld?: boolean;
  /** TRA-2949 — whole trading days (Mon–Fri) held since entry. */
  tradingDaysHeld?: number;
  /**
   * TRA-2949 — most-recent-last history of whether each recent bar's
   * underlying close was through the MA20 AGAINST the position. Consulted only
   * when {@link ExitParams.ma20ConfirmBars} > 1; its final element is this
   * bar's through-state.
   */
  recentMa20Through?: boolean[];
  /**
   * TRA-4500 (D1) — calendar days to expiration AT ENTRY. Consulted only by
   * the churn-exit minimum hold ({@link ExitParams.dteMinHoldFactor}): when
   * present and ≥ {@link ExitParams.dteMinHoldEntryDteFloor}, `time_stop` and
   * `ma20_close_through` are held until the position has been held
   * `max(1, dteMinHoldFactor × entryDte)` trading sessions (per
   * {@link ExitState.tradingDaysHeld}). Absent ⇒ the gate is inert (legacy
   * behaviour for callers that do not track entry DTE).
   */
  entryDte?: number;
}

/**
 * Evaluate the exit rule set against the current position state. Returns the
 * first triggered {@link ExitReason} (checked stop → target → structure → time),
 * or `null` to hold. Pure.
 */
export function evaluateExit(state: ExitState, params: ExitParams = DEFAULT_EXIT_PARAMS): ExitReason | null {
  const pnlPct =
    state.entryPremium > 0 ? (state.currentPremium - state.entryPremium) / state.entryPremium : 0;

  // Premium stop / take-profit first — hard risk limits.
  if (pnlPct <= params.premiumStopPct) return 'premium_stop';
  if (pnlPct >= params.premiumTakeProfitPct) return 'premium_take_profit';

  // TRA-1409 — optional N-bar confirmation of a Supertrend flip against the
  // position. With supertrendFlipConfirmBars>1 the flip must persist for that
  // many consecutive bars before it counts (cuts single-bar whipsaw scratches
  // on the RV sleeve). N<=1 (the global default) keeps the legacy single-bar
  // read. When N>1 but no `recentSupertrendDirections` history is available, we
  // treat the flip as UNCONFIRMED rather than fire on one bar — the other
  // structural/time exits below still apply, and the risk-side stops are
  // unaffected. TRA-2949 — hoisted out of the flip-exit branch because the
  // swing-held trading-day time stop also requires a confirmed trend-against
  // read before it may close the row.
  const flippedDir = state.side === 'buy' ? 'red' : 'green';
  const flipped = state.supertrendDirection === flippedDir;
  const confirmBars = params.supertrendFlipConfirmBars ?? 1;
  const recent = state.recentSupertrendDirections;
  const flipConfirmed =
    flipped &&
    (confirmBars <= 1 ||
      (recent !== undefined &&
        recent.length >= confirmBars &&
        recent.slice(-confirmBars).every(d => d === flippedDir)));

  // TRA-4500 (D1) — DTE-proportional minimum hold on the two CHURN exits
  // (`ma20_close_through`, `time_stop`): a ~34-DTE position must not be booked
  // out by a 20-period intraday rule or a bar-count stall inside its first
  // sessions (TRA-4230: 39% of desk closes, 33 min–2 h holds, net negative once
  // the spread cross is charged). `entryDte` absent ⇒ inert (legacy callers).
  // With `entryDte` present but `tradingDaysHeld` absent the gate HOLDS the two
  // churn exits (conservative, matching the confirm-bars absent-history rule)
  // rather than fire on an unmeasured hold. The premium stop / take-profit
  // above and the `supertrend_flip` exit are DELIBERATELY outside this gate.
  const churnMinHoldMet =
    state.entryDte === undefined ||
    state.entryDte < (params.dteMinHoldEntryDteFloor ?? 21) ||
    (state.tradingDaysHeld ?? 0) >= Math.max(1, (params.dteMinHoldFactor ?? 0.1) * state.entryDte);

  // Structure-based exits.
  if (params.supertrendFlipExit && flipConfirmed) {
    // TRA-1480 (v2) — winner-protect P&L gate. When
    // `supertrendFlipMinLossPctToExit` is set, the confirmed flip only exits a
    // position that is at/below that loss threshold; a flat-or-winning RV
    // position ignores the flip and runs to `ma20_close_through` / `trail` /
    // take-profit (the winner exits). Undefined = legacy (fires at any P&L).
    // The flip stays PROTECTIVE on real losers; the hard premium stop already
    // fired above so this never loosens a risk-side exit.
    const pnlGateOpen =
      params.supertrendFlipMinLossPctToExit === undefined ||
      pnlPct <= params.supertrendFlipMinLossPctToExit;
    if (pnlGateOpen) return 'supertrend_flip';
  }
  if (params.ma20CloseThroughExit) {
    const through = state.side === 'buy' ? state.underlyingClose < state.ma20 : state.underlyingClose > state.ma20;
    if (through) {
      // TRA-2949 — same confirm-bars idea as the flip: with ma20ConfirmBars>1
      // the close-through must persist for N consecutive bars (per
      // `recentMa20Through`) before the exit fires; absent/short history holds.
      const maConfirmBars = params.ma20ConfirmBars ?? 1;
      const maRecent = state.recentMa20Through;
      const maConfirmed =
        maConfirmBars <= 1 ||
        (maRecent !== undefined &&
          maRecent.length >= maConfirmBars &&
          maRecent.slice(-maConfirmBars).every(Boolean));
      // TRA-4500 (D1) — a confirmed close-through still waits out the
      // DTE-proportional minimum hold; the row falls through to the (equally
      // gated) time stop and, in the caller, to the untouched stop family.
      if (maConfirmed && churnMinHoldMet) return 'ma20_close_through';
    }
  }

  // Time stop only when the move has not followed through.
  // TRA-2949 — swing-held rows (PDT overnight hold / `swingHoldOptions`) count
  // TRADING days instead of bars: the hold releases at the next open with the
  // bar count already far past `timeStopBars`, so the bar stop would
  // mechanically close every swing row at the open (the behaviour the board
  // rejected in TRA-2946). The trading-day stop additionally requires the
  // Supertrend confirmed AGAINST the position — a stale row whose trend is
  // still with it keeps riding to the risk-side exits.
  // TRA-4500 (D1) — both time-stop arms sit behind the churn minimum hold.
  if (state.swingHeld && params.timeStopTradingDays !== undefined) {
    if (
      params.timeStopTradingDays > 0 &&
      (state.tradingDaysHeld ?? 0) >= params.timeStopTradingDays &&
      !state.hadFollowThrough &&
      flipConfirmed &&
      churnMinHoldMet
    ) {
      return 'time_stop';
    }
  } else if (
    params.timeStopBars > 0 &&
    state.barsHeld >= params.timeStopBars &&
    !state.hadFollowThrough &&
    churnMinHoldMet
  ) {
    return 'time_stop';
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Position sizing through the risk manager (per-name / per-sector caps)
// ---------------------------------------------------------------------------

export interface OptionSizingParams {
  /** Max fraction of managed equity at risk on one name (default 0.05 = 5%). */
  perNameCap: number;
  /** Max fraction of managed equity at risk across one sector (default 0.15 = 15%). */
  perSectorCap: number;
  /** Optional per-trade risk override fed to the RiskManager (else its default). */
  riskPct?: number;
}

export const DEFAULT_OPTION_SIZING: OptionSizingParams = {
  perNameCap: 0.05,
  perSectorCap: 0.15,
};

export interface OptionSizingInputs {
  /** Entry premium per share. */
  entryPremium: number;
  /** Premium stop fraction (negative, e.g. -0.50). Used to derive $-at-risk per contract. */
  premiumStopPct: number;
  /** Dollars already at risk on this name (existing positions). */
  nameRiskUsed: number;
  /** Dollars already at risk in this sector (existing positions). */
  sectorRiskUsed: number;
  /** Contract multiplier (default 100 — US equity options). */
  contractMultiplier?: number;
}

export interface OptionSizingResult {
  contracts: number;
  /** Dollars of premium at risk for the sized position. */
  riskDollars: number;
  /** Binding constraint that set the size. */
  bound: 'risk_budget' | 'per_name_cap' | 'per_sector_cap' | 'zero';
}

/**
 * Size an options position in whole contracts, routing the dollar risk budget
 * through the existing {@link RiskManager} (so the drawdown brake and equity
 * compounding apply) and then clamping to per-name and per-sector caps.
 *
 * Per-contract dollar risk = `entryPremium × |premiumStopPct| × multiplier`
 * (the premium we forfeit if the -50% stop hits). The budget is the smallest of
 * the risk-manager allowance and the remaining headroom under each cap.
 */
export function sizeOptionContracts(
  riskManager: RiskManager,
  inputs: OptionSizingInputs,
  params: OptionSizingParams = DEFAULT_OPTION_SIZING,
): OptionSizingResult {
  const multiplier = inputs.contractMultiplier ?? 100;
  const perContractRisk = inputs.entryPremium * Math.abs(inputs.premiumStopPct) * multiplier;
  if (!(perContractRisk > 0)) return { contracts: 0, riskDollars: 0, bound: 'zero' };

  const equity = riskManager.managedEquity();
  const riskBudget = riskManager.maxRiskPerTrade(params.riskPct);
  const nameHeadroom = Math.max(0, equity * params.perNameCap - inputs.nameRiskUsed);
  const sectorHeadroom = Math.max(0, equity * params.perSectorCap - inputs.sectorRiskUsed);

  const budgets: Array<{ dollars: number; bound: OptionSizingResult['bound'] }> = [
    { dollars: riskBudget, bound: 'risk_budget' },
    { dollars: nameHeadroom, bound: 'per_name_cap' },
    { dollars: sectorHeadroom, bound: 'per_sector_cap' },
  ];
  const binding = budgets.reduce((min, b) => (b.dollars < min.dollars ? b : min));

  const contracts = Math.floor(binding.dollars / perContractRisk);
  if (contracts <= 0) return { contracts: 0, riskDollars: 0, bound: 'zero' };
  return { contracts, riskDollars: contracts * perContractRisk, bound: binding.bound };
}
