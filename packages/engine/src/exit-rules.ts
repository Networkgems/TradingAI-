import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  PROFIT_LOCK_ARM_R,
  PROFIT_LOCK_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_PEAK_R,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
  BOOK_GIVEBACK_CAP_PCT,
  TAKE_PROFIT_EARLY_CAPTURE_PCT,
  CORRELATED_EXPOSURE_CAP_PCT,
  CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT,
  ENTRY_SHORT_DELTA_MIN,
  ENTRY_SHORT_DELTA_MAX,
  ENTRY_DELTA_THETA_RATIO_FLOOR,
} from '@trading-app/shared';

/**
 * TRA-1250 — exit-side loss-control rules (phase-1, board-approved via
 * TRA-1249, request_confirmation `d7175f7e`).
 *
 * These are PURE decision helpers with no I/O and no position mutation. The
 * hot exit/entry loops (`PaperOptionsAccount.checkExits`,
 * `PaperAccount.checkExits`, `DailyRiskGovernor`) own the running state
 * (extreme-since-entry, peak price, peak book gain) and call these functions
 * to decide whether to exit / halt. Keeping the arithmetic here makes every
 * threshold unit-testable in isolation and lets demo, live, and backtest paths
 * share one implementation.
 *
 * Convention: `side: 'buy'` = long, `side: 'sell'` = short. All prices are on
 * the position's own instrument (underlying for equities; for options the
 * caller reinterprets the chandelier on the underlying and profit-lock on
 * premium-derived R — see the wiring issues).
 */

export type Side = 'buy' | 'sell';

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 — ATR chandelier trailing stop
// ─────────────────────────────────────────────────────────────────────────────

export interface ChandelierParams {
  side: Side;
  /** Hard stop captured at entry; the trail never loosens past it. */
  initialStop: number;
  /** Highest high (long) / lowest low (short) seen since entry. */
  extremeSinceEntry: number;
  /** ATR(14) on the position's timeframe. */
  atr: number;
  /** ATR / price, used to pick the high-beta multiplier. Optional. */
  atrPct?: number;
  /**
   * Prior trail-stop level, if any. The chandelier ratchets only in the
   * favorable direction, so we clamp against the previous stop as well as the
   * initial stop — a rising ATR must never widen (loosen) the protective stop.
   */
  prevTrailStop?: number;
  /** Override the default 3.0 / 3.5 multipliers (mostly for tests). */
  atrMult?: number;
  atrMultHighBeta?: number;
  highBetaAtrPct?: number;
}

/** The ATR multiplier this position should use given its volatility regime. */
export function chandelierMultiplier(
  atrPct: number | undefined,
  opts: Pick<ChandelierParams, 'atrMult' | 'atrMultHighBeta' | 'highBetaAtrPct'> = {},
): number {
  const base = opts.atrMult ?? EXIT_CHANDELIER_ATR_MULT;
  const highBeta = opts.atrMultHighBeta ?? EXIT_CHANDELIER_ATR_MULT_HIGHBETA;
  const threshold = opts.highBetaAtrPct ?? EXIT_CHANDELIER_HIGHBETA_ATRPCT;
  return atrPct !== undefined && atrPct > threshold ? highBeta : base;
}

/**
 * Compute the chandelier trail-stop level. Longs:
 * `max(initialStop, prevTrailStop, highestHigh − mult×ATR)`. Shorts mirror.
 * Returns the new (ratcheted) stop; the caller persists it as `prevTrailStop`.
 */
export function chandelierStop(p: ChandelierParams): number {
  const mult = chandelierMultiplier(p.atrPct, p);
  const raw =
    p.side === 'buy'
      ? p.extremeSinceEntry - mult * p.atr
      : p.extremeSinceEntry + mult * p.atr;

  if (p.side === 'buy') {
    // Long: stop can only ratchet UP. Floor at the initial hard stop.
    let stop = Math.max(p.initialStop, raw);
    if (p.prevTrailStop !== undefined) stop = Math.max(stop, p.prevTrailStop);
    return stop;
  }
  // Short: stop can only ratchet DOWN. Cap at the initial hard stop.
  let stop = Math.min(p.initialStop, raw);
  if (p.prevTrailStop !== undefined) stop = Math.min(stop, p.prevTrailStop);
  return stop;
}

/** Whether the current price has crossed the chandelier stop and should exit. */
export function chandelierExitTriggered(
  side: Side,
  price: number,
  trailStop: number,
): boolean {
  return side === 'buy' ? price <= trailStop : price >= trailStop;
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 1 (live-equity path, TRA-1269) — broker stop-leg modify gate
// ─────────────────────────────────────────────────────────────────────────────

export interface StopModifyParams {
  side: Side;
  /** The stop currently resting on the broker (last value we sent / know). */
  brokerStop: number;
  /** The freshly-computed chandelier stop for this tick. */
  desiredStop: number;
  /**
   * Minimum favorable move (in price) required before we spend a broker
   * order-modify round-trip. Guards against churning Tradier with sub-tick
   * ratchets and tripping its throttle.
   */
  minTick: number;
}

export interface StopModifyDecision {
  /** True ⇒ issue a broker order-modify to `nextStop`. */
  shouldModify: boolean;
  /** The stop to send. Always in the tighten-only direction; else `brokerStop`. */
  nextStop: number;
}

/**
 * Decide whether a live-equity chandelier ratchet warrants a broker stop-leg
 * modify. The stop may ONLY tighten — raise for a long, lower for a short — and
 * only when it has moved by at least `minTick`. A loosening or too-small
 * `desiredStop` is a no-op that leaves the broker's resting stop untouched.
 * This is the single choke point that enforces "never loosen; never touch the
 * TP leg" for the live path; the caller does the I/O.
 */
export function stopModifyDecision(p: StopModifyParams): StopModifyDecision {
  const tightens =
    p.side === 'buy' ? p.desiredStop > p.brokerStop : p.desiredStop < p.brokerStop;
  if (!tightens) return { shouldModify: false, nextStop: p.brokerStop };

  const move = Math.abs(p.desiredStop - p.brokerStop);
  // `>=` with a strictly-positive floor: a NaN/degenerate minTick can never
  // admit a modify (NaN comparisons are false), failing safe to "don't touch".
  if (!(p.minTick > 0) || !(move >= p.minTick)) {
    return { shouldModify: false, nextStop: p.brokerStop };
  }
  return { shouldModify: true, nextStop: p.desiredStop };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 2 — trade-level profit-lock (give-back cap per position)
// ─────────────────────────────────────────────────────────────────────────────

export interface ProfitLockParams {
  side: Side;
  entry: number;
  /** Hard stop captured at entry; defines R = |entry − initialStop|. */
  initialStop: number;
  /** Peak favorable price: highest high (long) / lowest low (short) since entry. */
  peakPrice: number;
  currentPrice: number;
  armR?: number;
  giveBackR?: number;
  tightenPeakR?: number;
  tightenGiveBackR?: number;
}

export interface ProfitLockDecision {
  /** Risk unit in price terms (|entry − initialStop|). */
  R: number;
  /** Peak favorable excursion in R (max over life). */
  peakR: number;
  /** Current open profit in R. */
  currentR: number;
  /** True once peakR ≥ armR (profit-lock is active). */
  armed: boolean;
  /** The give-back allowance in R currently in force (1.0R, or 0.5R once big). */
  giveBackR: number;
  /** True ⇒ close the position now (open R retraced past the allowance). */
  shouldExit: boolean;
}

/**
 * Profit-lock give-back cap. Track peakR (peak favorable excursion / R). Once
 * peakR ≥ 1.0, exit if open R retraces 1.0R from the peak; tighten the allowance
 * to 0.5R once peakR ≥ 2.0 so a big winner keeps more of its gain.
 */
export function profitLockDecision(p: ProfitLockParams): ProfitLockDecision {
  const armR = p.armR ?? PROFIT_LOCK_ARM_R;
  const baseGiveBack = p.giveBackR ?? PROFIT_LOCK_GIVEBACK_R;
  const tightenPeakR = p.tightenPeakR ?? PROFIT_LOCK_TIGHTEN_PEAK_R;
  const tightenGiveBack = p.tightenGiveBackR ?? PROFIT_LOCK_TIGHTEN_GIVEBACK_R;

  const R = Math.abs(p.entry - p.initialStop);
  // Degenerate risk unit (no room between entry and stop): can't compute R
  // multiples, so the profit-lock stays disarmed and defers to other exits.
  if (!(R > 0)) {
    return { R: 0, peakR: 0, currentR: 0, armed: false, giveBackR: baseGiveBack, shouldExit: false };
  }

  const favPeak = p.side === 'buy' ? p.peakPrice - p.entry : p.entry - p.peakPrice;
  const favNow = p.side === 'buy' ? p.currentPrice - p.entry : p.entry - p.currentPrice;
  const peakR = favPeak / R;
  const currentR = favNow / R;

  const armed = peakR >= armR;
  const giveBackR = peakR >= tightenPeakR ? tightenGiveBack : baseGiveBack;
  const shouldExit = armed && currentR <= peakR - giveBackR;

  return { R, peakR, currentR, armed, giveBackR, shouldExit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 3 — book-level daily give-back cap (the board's headline ask)
// ─────────────────────────────────────────────────────────────────────────────

export interface BookGiveBackParams {
  /** Intraday peak of (realized + open) book P&L this session, floored at 0. */
  peakOpenGain: number;
  /** Current (realized + open) book P&L. */
  currentTotalPnl: number;
  /**
   * Absolute gain (in book currency) the book must have reached this session
   * to arm the hard session stop — the caller computes this as
   * `max(BOOK_SESSION_STOP_R × bookRiskUnit, BOOK_SESSION_STOP_ARM_ABS_FLOOR_USD)`
   * (TRA-3218: 1R of book equity, never below +$100). When the book has been up
   * at least this much, a subsequent flip to net-negative halts.
   */
  sessionStopArmGain: number;
  giveBackCapPct?: number;
  /**
   * TRA-1435 — minimum ARM floor for the GIVE-BACK cap (NOT the session stop):
   * the give-back cap only arms/trips once `peakOpenGain` reaches this absolute
   * gain. Below it a trivial peak (e.g. +$7 on a $2.2k book that gives back $5
   * inside spread/noise) can never latch a session halt. The caller computes it
   * as `max(BOOK_GIVEBACK_ARM_ABS_FLOOR_USD, BOOK_GIVEBACK_ARM_FLOOR_R ×
   * bookRiskUnit)` — mirroring `sessionStopArmGain` so the give-back cap is never
   * stricter than the session stop at small peaks. Defaults to 0 (no floor →
   * legacy behavior: the cap arms at any positive peak).
   */
  giveBackArmFloor?: number;
}

export type BookHaltReason = 'giveback_cap' | 'session_net_negative';

export interface BookGiveBackDecision {
  /** Dollar floor: peakOpenGain × (1 − cap). Dropping below it trips the cap. */
  retainedFloor: number;
  /**
   * TRA-1435 — the give-back cap's minimum arm floor in force (0 ⇒ none). The cap
   * is only live once `peakOpenGain ≥ giveBackArmFloor`.
   */
  giveBackArmFloor: number;
  /** True ⇒ flatten discretionary/open risk and halt NEW entries for the session. */
  shouldFlattenAndHalt: boolean;
  reason: BookHaltReason | null;
}

/**
 * Book-level give-back / session-stop decision.
 *
 *  - Give-back cap: once the book has a positive peak open gain AT OR ABOVE the
 *    `giveBackArmFloor` (TRA-1435), surrendering more than `giveBackCapPct` (40%)
 *    of it flattens and halts for the session. Example: peak +$1,599 → floor ≈
 *    +$960; dropping below that trips the halt. Below the arm floor a trivial
 *    peak can never latch a halt (defaults to 0 ⇒ legacy: arms at any peak).
 *  - Session stop: if the book was up at least `sessionStopArmGain` (TRA-3218:
 *    max(1R of book equity, +$100)) and then goes net-negative, halt for the
 *    session.
 *
 * The caller owns the running `peakOpenGain` (monotonic max, reset on the ET day
 * roll) and decides how to flatten; this returns only the decision.
 */
export function bookGiveBackDecision(p: BookGiveBackParams): BookGiveBackDecision {
  const cap = p.giveBackCapPct ?? BOOK_GIVEBACK_CAP_PCT;
  const peak = Math.max(0, p.peakOpenGain);
  const retainedFloor = peak * (1 - cap);
  // TRA-1435 — the give-back cap's minimum arm floor (0 ⇒ none / legacy behavior).
  // Clamp to ≥0 so a negative/NaN caller value never re-enables at any peak.
  const giveBackArmFloor = Math.max(0, p.giveBackArmFloor ?? 0);

  // Session stop takes precedence — a net-negative book after a real up-move is
  // the worst state and should latch regardless of the give-back arithmetic. Note
  // this keeps its OWN arm (`sessionStopArmGain`) and is NOT gated by the
  // give-back arm floor — a real up-move that flips net-negative always latches.
  if (p.sessionStopArmGain > 0 && peak >= p.sessionStopArmGain && p.currentTotalPnl < 0) {
    return { retainedFloor, giveBackArmFloor, shouldFlattenAndHalt: true, reason: 'session_net_negative' };
  }

  // Give-back cap: only arms once the day's peak reaches the arm floor, so a
  // tiny-peak day (peak below the floor) can never trip it.
  if (peak > 0 && peak >= giveBackArmFloor && p.currentTotalPnl < retainedFloor) {
    return { retainedFloor, giveBackArmFloor, shouldFlattenAndHalt: true, reason: 'giveback_cap' };
  }

  return { retainedFloor, giveBackArmFloor, shouldFlattenAndHalt: false, reason: null };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 4 (TRA-1294) — take-profit-early (the PROFIT-side mirror of Rule 2)
// ─────────────────────────────────────────────────────────────────────────────

export interface TakeProfitEarlyParams {
  side: Side;
  /** Entry price/premium. For a short this is the credit received. */
  entry: number;
  /** Current mark. */
  currentPrice: number;
  /**
   * Price at which 100% of the position's available profit is realized:
   *   - long  (`side: 'buy'`):  the profit target / max-value price (available
   *     profit = maxProfitPrice − entry).
   *   - short (`side: 'sell'`): the price at which the full credit is captured
   *     (0 for a naked short — the option/spread expires worthless; the
   *     structure's floor value otherwise; available profit = entry −
   *     maxProfitPrice).
   * A non-finite or unfavorable value yields a degenerate span and the rule
   * defers to the other exits.
   */
  maxProfitPrice: number;
  /** Fraction of available profit to bank (default 0.60; board range 0.50–0.70). */
  captureFrac?: number;
}

export interface TakeProfitEarlyDecision {
  /** Favorable span from entry to the max-profit price (available profit, price terms). */
  availableProfit: number;
  /** Current open profit (price terms). */
  currentProfit: number;
  /** currentProfit / availableProfit, floored at 0. */
  capturedFrac: number;
  /** The capture threshold in force. */
  captureFrac: number;
  /** True ⇒ auto-close now (captured ≥ threshold). */
  shouldExit: boolean;
}

/**
 * Take-profit-early: bank the win once the position has captured `captureFrac`
 * (50–70%) of its available profit. This is the symmetric PROFIT-side mirror of
 * the per-trade give-back cap (Rule 2): where the give-back cap trails from the
 * peak to protect an open gain, this fires on an ABSOLUTE capture level to take
 * a large fraction of the target off the table before the market can hand it
 * back. A level trigger, so it needs no peak-tracking. Long and short share one
 * implementation via the `maxProfitPrice` reference (see the param docs).
 */
export function takeProfitEarlyDecision(p: TakeProfitEarlyParams): TakeProfitEarlyDecision {
  const captureFrac = p.captureFrac ?? TAKE_PROFIT_EARLY_CAPTURE_PCT;
  const availableProfit =
    p.side === 'buy' ? p.maxProfitPrice - p.entry : p.entry - p.maxProfitPrice;

  // Degenerate / undefined runway (non-finite target, or an inverted
  // maxProfitPrice that implies no profit to bank): can't form a capture
  // fraction, so defer to the other exits.
  if (!(availableProfit > 0) || !Number.isFinite(availableProfit)) {
    return { availableProfit: 0, currentProfit: 0, capturedFrac: 0, captureFrac, shouldExit: false };
  }

  const currentProfit = p.side === 'buy' ? p.currentPrice - p.entry : p.entry - p.currentPrice;
  const capturedFrac = Math.max(0, currentProfit / availableProfit);
  const shouldExit = capturedFrac >= captureFrac;

  return { availableProfit, currentProfit, capturedFrac, captureFrac, shouldExit };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rule 5 (TRA-1295) — correlated-exposure cap (the "7%" leg of the 3-5-7 governor)
// ─────────────────────────────────────────────────────────────────────────────

/** The grain at which a correlated group is formed. */
export type ExposureLevel = 'underlying' | 'sector' | 'assetClass';

/**
 * One correlated group the candidate belongs to, carrying the Σ open per-trade
 * dollar risk already committed to it. The candidate is evaluated against ALL of
 * its buckets (underlying, sector, asset-class); the most-binding one governs.
 */
export interface ExposureBucket {
  /** Which grain this bucket is (for the surfaced reason / logging). */
  level: ExposureLevel;
  /** The group value at that grain, e.g. `'AAPL'` / `'technology'` / `'equity'`. */
  key: string;
  /** Sum of OPEN per-trade dollar risk already committed to this group. */
  openRisk: number;
  /** Per-bucket cap fraction of managed equity; defaults to `capPct` / 7%. */
  capPct?: number;
}

export interface CorrelatedExposureParams {
  /** The candidate entry's per-trade dollar risk = `|entry − stop| × qty`. */
  candidateRisk: number;
  /** Managed book equity the cap is expressed as a fraction of. */
  managedEquity: number;
  /** The correlated groups the candidate lands in (underlying / sector / asset-class). */
  buckets: readonly ExposureBucket[];
  /** Fallback cap fraction for buckets without their own `capPct` (default 7%). */
  capPct?: number;
  /** Reject rather than scale a candidate below this fraction of equity (default 0.25%). */
  minTradeRiskPct?: number;
}

/** Which bucket bound the candidate's size, if any. */
export interface CorrelatedExposureBinding {
  level: ExposureLevel;
  key: string;
}

export interface CorrelatedExposureDecision {
  /** True ⇒ the trade may open (possibly scaled down). */
  admitted: boolean;
  /**
   * Position-size multiplier in (0, 1]. `1` ⇒ full size; `< 1` ⇒ scaled down to
   * the most-binding bucket's exact headroom; `0` ⇒ rejected (see `reason`).
   */
  scale: number;
  /** The bucket that bound the candidate's size, or `null` when none did. */
  bindingBucket: CorrelatedExposureBinding | null;
  /** Dollar headroom in the binding bucket (floored at 0), or +∞ when unbound. */
  headroom: number;
  /** Set when `admitted` is false. */
  reason: 'below_min_trade_risk' | 'non_positive_risk' | null;
}

/**
 * Correlated-exposure cap admission for a new entry.
 *
 * Each bucket is a correlated group the candidate belongs to (its underlying,
 * its sector, its asset-class), carrying the Σ open per-trade dollar risk already
 * in that group. The cap on each is `capPct × managedEquity`; the candidate is
 * scaled down to the SMALLEST headroom across its buckets (the most-binding
 * grain wins), and rejected outright if that headroom falls below the
 * `minTradeRiskPct` floor — a token-sized correlated add is not worth the ticket.
 *
 * Pure: the caller owns the open-book snapshot (it computes each bucket's
 * `openRisk` from live positions) exactly as `markBook`'s caller owns the running
 * book P&L. Complements — does not replace — the per-trade breaker and the book
 * give-back cap. A candidate with no measurable risk cannot be scaled and is
 * rejected rather than dividing by zero.
 */
export function correlatedExposureDecision(
  p: CorrelatedExposureParams,
): CorrelatedExposureDecision {
  if (!(p.candidateRisk > 0)) {
    return { admitted: false, scale: 0, bindingBucket: null, headroom: 0, reason: 'non_positive_risk' };
  }

  const fallbackCapPct = p.capPct ?? CORRELATED_EXPOSURE_CAP_PCT;
  const equity = Math.max(0, p.managedEquity);

  // riskAllowed = min headroom across every bucket, never above the candidate's
  // intended risk. Track the bucket that bound it for the surfaced reason.
  let riskAllowed = p.candidateRisk;
  let bindingBucket: CorrelatedExposureBinding | null = null;
  for (const b of p.buckets) {
    const capPct = b.capPct ?? fallbackCapPct;
    const headroom = capPct * equity - Math.max(0, b.openRisk);
    if (headroom < riskAllowed) {
      riskAllowed = headroom;
      bindingBucket = { level: b.level, key: b.key };
    }
  }

  // No bucket bound the candidate — admit at full size.
  if (bindingBucket === null) {
    return { admitted: true, scale: 1, bindingBucket: null, headroom: Number.POSITIVE_INFINITY, reason: null };
  }

  const floor = (p.minTradeRiskPct ?? CORRELATED_EXPOSURE_MIN_TRADE_RISK_PCT) * equity;
  // Below the floor (which also catches a fully-exhausted or over-committed
  // group where riskAllowed ≤ 0), reject instead of shrinking to a token size.
  if (riskAllowed < floor) {
    return {
      admitted: false,
      scale: 0,
      bindingBucket,
      headroom: Math.max(0, riskAllowed),
      reason: 'below_min_trade_risk',
    };
  }

  return {
    admitted: true,
    scale: riskAllowed / p.candidateRisk,
    bindingBucket,
    headroom: riskAllowed,
    reason: null,
  };
}

/**
 * A position/candidate reduced to the fields the correlated-exposure cap groups
 * on: its correlated keys at each grain plus its per-trade dollar risk. The
 * caller resolves the keys (for an option, the `underlying` is the underlier's
 * ticker; `assetClass` is e.g. `'equity'` / `'crypto'`; `sector` is optional —
 * omit it and the sector grain is simply not evaluated for that name).
 */
export interface ExposurePositionRisk {
  underlying: string;
  sector?: string;
  assetClass: string;
  /** Per-trade dollar risk = `|entry − stop| × qty`. */
  risk: number;
}

/**
 * Build the candidate's correlated-exposure buckets from an open-position
 * snapshot: for each grain (underlying / sector / asset-class) the candidate has
 * a key for, sum the OPEN per-trade risk sharing that key. The candidate's own
 * risk is deliberately excluded — the cap compares it against the group's
 * existing commitment. A grain the candidate has no key for (e.g. missing
 * sector) is skipped, never treated as a catch-all bucket. `capPctByLevel` lets
 * the caller tighten an individual grain; unspecified grains fall back to the
 * decision's default cap.
 */
export function buildExposureBuckets(
  candidate: ExposurePositionRisk,
  open: readonly ExposurePositionRisk[],
  capPctByLevel?: Partial<Record<ExposureLevel, number>>,
): ExposureBucket[] {
  const grains: Array<{ level: ExposureLevel; keyOf: (p: ExposurePositionRisk) => string | undefined }> = [
    { level: 'underlying', keyOf: (p) => p.underlying },
    { level: 'sector', keyOf: (p) => p.sector },
    { level: 'assetClass', keyOf: (p) => p.assetClass },
  ];
  const out: ExposureBucket[] = [];
  for (const { level, keyOf } of grains) {
    const key = keyOf(candidate);
    if (!key) continue;
    const openRisk = open.reduce(
      (s, p) => (keyOf(p) === key ? s + Math.max(0, p.risk) : s),
      0,
    );
    out.push({ level, key, openRisk, capPct: capPctByLevel?.[level] });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// TRA-1293 — PoP / delta entry gate + Delta/Theta ratio floor (entry-side)
// ─────────────────────────────────────────────────────────────────────────────

export interface EntryGreeksGateParams {
  /**
   * The short-strike |delta| the PoP band is enforced on. For a defined-risk
   * spread this is the short leg's |delta|; for a single-leg position it is the
   * traded strike's |delta|. Sign is irrelevant — the gate takes |·|.
   */
  shortDelta: number;
  /**
   * The position |delta| used for the delta/theta ratio (usually the same strike
   * as `shortDelta` on a single leg; the position net |delta| on a spread).
   */
  delta: number;
  /**
   * Position theta in per-DAY premium terms (negative for long premium, positive
   * when short premium). The ratio uses |·|, so the sign only documents intent.
   * Callers holding BS per-YEAR theta must divide by 365 before passing it here.
   */
  thetaPerDay: number;
  /** Lower bound of the admissible short-strike |delta| band (default 0.30). */
  deltaBandMin?: number;
  /** Upper bound of the admissible short-strike |delta| band (default 0.40). */
  deltaBandMax?: number;
  /** Minimum admissible |delta| / |thetaPerDay| ratio (default 6.0). */
  ratioFloor?: number;
}

export interface EntryGreeksGateDecision {
  /** True ⇒ the candidate clears both the PoP band and the D/T ratio floor. */
  admitted: boolean;
  /** |shortDelta| the band was checked against. */
  shortDelta: number;
  deltaBandMin: number;
  deltaBandMax: number;
  /** |delta| / |thetaPerDay|; `+∞` when |thetaPerDay| ≈ 0 (no decay to fight). */
  deltaThetaRatio: number;
  ratioFloor: number;
  /** Set when `admitted` is false; identifies which gate rejected the candidate. */
  reason: 'delta_out_of_band' | 'delta_theta_ratio_too_low' | 'non_finite_greeks' | null;
}

/**
 * PoP / delta entry gate (TRA-1293): a HARD pre-open filter operationalizing the
 * board's Greeks guidance from the Greeks already captured at entry.
 *
 * Two independent gates, both must pass:
 *   1. Short-strike |delta| band — a probability-of-profit proxy. Only admit
 *      strikes whose |delta| sits in [deltaBandMin, deltaBandMax] (default
 *      0.30–0.40, i.e. ~60–70% PoP on the short side), rejecting deep-ITM (too
 *      much premium at risk) and far-OTM (lottery-ticket) strikes.
 *   2. Delta/Theta ratio floor — require |delta| / |thetaPerDay| ≥ ratioFloor so
 *      a position's directional sensitivity is large enough relative to its daily
 *      decay: time decay only "works for us" when we aren't paying (or granting)
 *      an outsized theta for the delta on the ticket. A position with ~zero theta
 *      has no decay to fight and clears the ratio unconditionally (ratio = +∞).
 *
 * Pure: the caller supplies the entry Greeks (from the option journal / a BS
 * greeks call at the gate site) and owns the open decision. Complements — does
 * not replace — the IVR ceiling, earnings gate, and correlated-exposure cap.
 * Non-finite Greeks are rejected rather than silently admitted.
 */
export function entryGreeksGateDecision(p: EntryGreeksGateParams): EntryGreeksGateDecision {
  const deltaBandMin = p.deltaBandMin ?? ENTRY_SHORT_DELTA_MIN;
  const deltaBandMax = p.deltaBandMax ?? ENTRY_SHORT_DELTA_MAX;
  const ratioFloor = p.ratioFloor ?? ENTRY_DELTA_THETA_RATIO_FLOOR;

  const shortDelta = Math.abs(p.shortDelta);
  const delta = Math.abs(p.delta);
  const theta = Math.abs(p.thetaPerDay);

  // Any non-finite Greek ⇒ we can't reason about PoP or decay; reject.
  if (!Number.isFinite(shortDelta) || !Number.isFinite(delta) || !Number.isFinite(theta)) {
    return {
      admitted: false,
      shortDelta,
      deltaBandMin,
      deltaBandMax,
      deltaThetaRatio: NaN,
      ratioFloor,
      reason: 'non_finite_greeks',
    };
  }

  // Gate 1 — short-strike |delta| PoP band.
  if (shortDelta < deltaBandMin || shortDelta > deltaBandMax) {
    return {
      admitted: false,
      shortDelta,
      deltaBandMin,
      deltaBandMax,
      deltaThetaRatio: theta > 0 ? delta / theta : Number.POSITIVE_INFINITY,
      ratioFloor,
      reason: 'delta_out_of_band',
    };
  }

  // Gate 2 — delta/theta ratio floor. Zero decay ⇒ nothing to fight ⇒ pass.
  const deltaThetaRatio = theta > 0 ? delta / theta : Number.POSITIVE_INFINITY;
  if (deltaThetaRatio < ratioFloor) {
    return {
      admitted: false,
      shortDelta,
      deltaBandMin,
      deltaBandMax,
      deltaThetaRatio,
      ratioFloor,
      reason: 'delta_theta_ratio_too_low',
    };
  }

  return {
    admitted: true,
    shortDelta,
    deltaBandMin,
    deltaBandMax,
    deltaThetaRatio,
    ratioFloor,
    reason: null,
  };
}
