import type { Candle, Position } from '@trading-app/shared';
import { atr } from './indicators/atr.js';
import { donchian } from './indicators/donchian.js';
import { rsi } from './indicators/rsi.js';

/**
 * TRA-211: per-strategy lifecycle helpers (time stops, trailing stops, RSI-50
 * alternate exit).
 *
 * The B5–B8 entry-signal classes (`MomentumStrategy`,
 * `MeanReversionCryptoStrategy`, `BreakoutVolStrategy`) deliberately stay
 * stateless — they only emit entries. Per-position bar-by-bar lifecycle
 * (TRA-197 spec §3–§5) lives here so it can be unit-tested in isolation and
 * driven by the `BacktestRunner` (and, eventually, the live position manager)
 * with a single shared implementation.
 *
 * Each helper is a pure function over `(position, candles, opts)` so the
 * runner can call it once per open bar without caring which strategy emitted
 * the entry. The lifecycle state the helpers need (entry RSI, peak / trough
 * since entry) is owned by the caller — see {@link LifecycleState}.
 */

/**
 * Per-strategy time-stop caps from TRA-197 spec §3 (mean reversion) and §4
 * (breakout). Momentum has no time stop — trend rides until the trail or hard
 * stop hits.
 */
export const TIME_STOP_BARS: Readonly<Record<string, number>> = {
  mean_reversion: 10,
  breakout_vol: 15,
};

/**
 * Per-position lifecycle state owned by the caller (runner or future live
 * position manager). The runner mutates these between bars; the helpers below
 * are pure functions that only read state and return the bar's new stop /
 * exit decision.
 */
export interface LifecycleState {
  /** Bars elapsed since entry (entry bar is bar 0). */
  barsHeld: number;
  /** RSI at the entry bar, snapshotted for the mean-reversion alt-exit cross. */
  entryRsi?: number;
  /**
   * Highest close (longs) / lowest close (shorts) seen since entry. Drives the
   * breakout BE-then-trail logic — without a watermark we'd have to walk the
   * full bar window every tick.
   */
  extremeSinceEntry: number;
  /** ATR at entry, frozen for the breakout BE trigger (`+2 × entryAtr`). */
  entryAtr?: number;
  /**
   * `true` once a trailing-stop ratchet has moved the position's stop level
   * away from the entry signal's original stop. Lets the runner classify a
   * subsequent stop hit as `trailing` rather than the initial hard `stop`.
   */
  trailed: boolean;
  /**
   * Stop level captured at entry. Used for R-multiple bookkeeping so trailing
   * ratchets don't shrink the denominator and inflate reported R.
   */
  initialStopLoss: number;
}

/**
 * Construct an initial lifecycle-state record from a freshly opened position.
 * `candles` should include the entry bar as the last element so RSI / ATR /
 * extreme are seeded against the same data the entry signal saw.
 *
 * The runner calls this once per `open` and then calls the per-bar helpers on
 * each subsequent bar.
 */
export function initLifecycleState(
  position: Position,
  candlesAtEntry: Candle[],
  opts: { rsiPeriod?: number; atrPeriod?: number } = {},
): LifecycleState {
  const closes = candlesAtEntry.map((c) => c.close);
  const rsiPeriod = opts.rsiPeriod ?? 14;
  const atrPeriod = opts.atrPeriod ?? 14;
  const entryRsiRaw = rsi(closes, rsiPeriod);
  const entryAtrRaw = atr(candlesAtEntry, atrPeriod);
  return {
    barsHeld: 0,
    entryRsi: Number.isFinite(entryRsiRaw) ? entryRsiRaw : undefined,
    entryAtr: entryAtrRaw ?? undefined,
    extremeSinceEntry: position.entryPrice,
    trailed: false,
    initialStopLoss: position.stopLoss,
  };
}

/**
 * Update the running extreme (peak for longs, trough for shorts) using the
 * bar's high/low. Called by the runner each bar before the lifecycle
 * decisions so trailing helpers see the freshest watermark.
 */
export function advanceExtreme(
  state: LifecycleState,
  position: Position,
  bar: Candle,
): void {
  if (position.side === 'buy') {
    if (bar.high > state.extremeSinceEntry) state.extremeSinceEntry = bar.high;
  } else {
    if (bar.low < state.extremeSinceEntry) state.extremeSinceEntry = bar.low;
  }
}

/**
 * Momentum trailing stop (TRA-197 spec §2). Trail at the prior-N-bar Donchian
 * low for longs / Donchian high for shorts. Tightens monotonically — never
 * widens — so a one-bar pullback can't loosen the protective stop.
 *
 * Returns `null` when the channel cannot be computed (insufficient bars) or
 * when the candidate trail would loosen the existing stop.
 */
export function momentumTrailStop(
  position: Position,
  candles: Candle[],
  donchianPeriod: number,
): number | null {
  const channel = donchian(candles, donchianPeriod, true);
  if (!channel) return null;
  if (position.side === 'buy') {
    // Long trails at Donchian_low. Only ratchet up.
    if (channel.lower > position.stopLoss) return channel.lower;
    return null;
  }
  // Short trails at Donchian_high. Only ratchet down.
  if (channel.upper < position.stopLoss) return channel.upper;
  return null;
}

export interface BreakoutTrailOptions {
  /** ATR multiplier for the BE trigger (spec §4 default: 2.0 — engage at +2·ATR). */
  beTriggerMultiplier?: number;
  /** ATR multiplier for the post-BE trail width (spec §4 default: 2.0). */
  trailMultiplier?: number;
  /** ATR period to use for the live trail width recomputation. */
  atrPeriod?: number;
}

/**
 * Breakout / volatility trailing stop (TRA-197 spec §4). Two-stage:
 *   1. Once price has moved `+beTriggerMultiplier × entryAtr` in our favour,
 *      ratchet stop to break-even (`entryPrice`).
 *   2. After the BE move, trail at `trailMultiplier × ATR` from the local
 *      extreme (peak for longs, trough for shorts). Trail never loosens.
 *
 * Returns the new stop level or `null` if no change is warranted. Uses the
 * frozen `entryAtr` for the BE trigger so the threshold doesn't shift with
 * regime changes — matches how a discretionary trader would size it at entry.
 */
export function breakoutTrailStop(
  position: Position,
  candles: Candle[],
  state: LifecycleState,
  opts: BreakoutTrailOptions = {},
): number | null {
  const beMult = opts.beTriggerMultiplier ?? 2.0;
  const trailMult = opts.trailMultiplier ?? 2.0;
  const atrPeriod = opts.atrPeriod ?? 14;
  if (state.entryAtr === undefined || state.entryAtr <= 0) return null;

  const beTriggerDistance = beMult * state.entryAtr;
  const movedFavour = position.side === 'buy'
    ? state.extremeSinceEntry - position.entryPrice
    : position.entryPrice - state.extremeSinceEntry;
  if (movedFavour < beTriggerDistance) return null;

  // BE has triggered — pick the tighter of break-even and the ATR-trail.
  const liveAtr = atr(candles, atrPeriod);
  // Freeze trail width at entry-ATR if the live ATR collapses to zero / null.
  const trailAtr = liveAtr && liveAtr > 0 ? liveAtr : state.entryAtr;
  const trailDistance = trailMult * trailAtr;
  const candidate = position.side === 'buy'
    ? Math.max(position.entryPrice, state.extremeSinceEntry - trailDistance)
    : Math.min(position.entryPrice, state.extremeSinceEntry + trailDistance);

  if (position.side === 'buy') {
    return candidate > position.stopLoss ? candidate : null;
  }
  return candidate < position.stopLoss ? candidate : null;
}

/**
 * Mean-reversion alternate exit (TRA-197 spec §3): close when RSI re-crosses
 * 50 from the entry-side extreme. A long entered at oversold RSI < 25 exits
 * the moment current RSI crosses up through 50; the symmetric case for shorts.
 *
 * Returns true iff the current bar's RSI has crossed 50 in the favourable
 * direction since entry. Cheaper / faster than waiting for BB-middle when the
 * snap-back is sharp — the runner takes whichever exit fires first.
 */
export function meanReversionRsiAltExitTriggered(
  position: Position,
  candles: Candle[],
  rsiPeriod: number,
  state: LifecycleState,
): boolean {
  if (state.entryRsi === undefined || !Number.isFinite(state.entryRsi)) return false;
  const closes = candles.map((c) => c.close);
  const currentRsi = rsi(closes, rsiPeriod);
  if (!Number.isFinite(currentRsi)) return false;
  if (position.side === 'buy') {
    // Long entered oversold — exit when RSI re-crosses up through 50.
    return state.entryRsi < 50 && currentRsi >= 50;
  }
  // Short entered overbought — exit when RSI re-crosses down through 50.
  return state.entryRsi > 50 && currentRsi <= 50;
}

/**
 * Returns the per-strategy time-stop bar cap, or `null` when the strategy has
 * no time stop (momentum rides trends to a structural exit).
 */
export function timeStopBarsFor(signalType: string): number | null {
  const cap = TIME_STOP_BARS[signalType];
  return cap === undefined ? null : cap;
}
