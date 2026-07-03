import {
  EXIT_CHANDELIER_ATR_MULT,
  EXIT_CHANDELIER_ATR_MULT_HIGHBETA,
  EXIT_CHANDELIER_HIGHBETA_ATRPCT,
  PROFIT_LOCK_ARM_R,
  PROFIT_LOCK_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_PEAK_R,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
  BOOK_GIVEBACK_CAP_PCT,
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
   * `BOOK_SESSION_STOP_R × bookRiskUnit` (0.5R of book equity). When the book
   * has been up at least this much, a subsequent flip to net-negative halts.
   */
  sessionStopArmGain: number;
  giveBackCapPct?: number;
}

export type BookHaltReason = 'giveback_cap' | 'session_net_negative';

export interface BookGiveBackDecision {
  /** Dollar floor: peakOpenGain × (1 − cap). Dropping below it trips the cap. */
  retainedFloor: number;
  /** True ⇒ flatten discretionary/open risk and halt NEW entries for the session. */
  shouldFlattenAndHalt: boolean;
  reason: BookHaltReason | null;
}

/**
 * Book-level give-back / session-stop decision.
 *
 *  - Give-back cap: once the book has a positive peak open gain, surrendering
 *    more than `giveBackCapPct` (40%) of it flattens and halts for the session.
 *    Example: peak +$1,599 → floor ≈ +$960; dropping below that trips the halt.
 *  - Session stop: if the book was up at least `sessionStopArmGain` (0.5R of
 *    book equity) and then goes net-negative, halt for the session.
 *
 * The caller owns the running `peakOpenGain` (monotonic max, reset on the ET day
 * roll) and decides how to flatten; this returns only the decision.
 */
export function bookGiveBackDecision(p: BookGiveBackParams): BookGiveBackDecision {
  const cap = p.giveBackCapPct ?? BOOK_GIVEBACK_CAP_PCT;
  const peak = Math.max(0, p.peakOpenGain);
  const retainedFloor = peak * (1 - cap);

  // Session stop takes precedence — a net-negative book after a real up-move is
  // the worst state and should latch regardless of the give-back arithmetic.
  if (p.sessionStopArmGain > 0 && peak >= p.sessionStopArmGain && p.currentTotalPnl < 0) {
    return { retainedFloor, shouldFlattenAndHalt: true, reason: 'session_net_negative' };
  }

  if (peak > 0 && p.currentTotalPnl < retainedFloor) {
    return { retainedFloor, shouldFlattenAndHalt: true, reason: 'giveback_cap' };
  }

  return { retainedFloor, shouldFlattenAndHalt: false, reason: null };
}
