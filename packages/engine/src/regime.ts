import type { Candle } from '@trading-app/shared';
import { adx } from './indicators/adx.js';
import { atr } from './indicators/atr.js';
import { maSlope } from './indicators/ma.js';

/**
 * Market regime label, per the strategy spec (TRA-197 spec §1).
 *
 * Strategies subscribe to specific labels:
 *   - Momentum  → trend_up | trend_down
 *   - MeanRev   → range
 *   - Breakout  → high_vol (and the flat → high_vol transition bar)
 *   - flat      → no strategy fires
 */
export type Regime = 'trend_up' | 'trend_down' | 'range' | 'high_vol' | 'flat';

export interface RegimeDetectorOptions {
  /** ADX period and thresholds. Spec: 14, trending ≥ 25, ranging < 20. */
  adxPeriod?: number;
  adxTrend?: number;
  adxRange?: number;
  /** ATR period and high-vol threshold (multiple of trailing-window ATR median). */
  atrPeriod?: number;
  atrHighVolMultiple?: number;
  atrMedianWindow?: number;
  /** Volatility floor (ATR/close) below which trend labels are suppressed. */
  atrPctFloor?: number;
  /** EMA period and bar-lookback used to compute MA slope. */
  maPeriod?: number;
  maSlopeLookback?: number;
  maSlopeThreshold?: number;
  /** Hysteresis: bars of agreement required before flipping the active regime. */
  flipBars?: number;
  /** Faster re-engagement when leaving `flat`. */
  flatExitBars?: number;
  /** Cooldown bars during which the previous label is locked out after a flip. */
  cooldownBars?: number;
}

interface Resolved extends Required<RegimeDetectorOptions> {}

const DEFAULTS: Resolved = {
  adxPeriod: 14,
  adxTrend: 25,
  adxRange: 20,
  atrPeriod: 14,
  atrHighVolMultiple: 1.5,
  atrMedianWindow: 90,
  atrPctFloor: 0.005,
  maPeriod: 50,
  maSlopeLookback: 5,
  maSlopeThreshold: 0.0005,
  flipBars: 3,
  flatExitBars: 2,
  cooldownBars: 2,
};

function median(values: number[]): number {
  if (values.length === 0) return NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Compute the *candidate* regime label for the latest bar, applying the
 * deterministic decision order from TRA-197 spec §1:
 *
 *   1. ATR spike (vs trailing-window median) and ADX < trend → high_vol
 *   2. ADX ≥ trend and MA slope sign agrees → trend_up / trend_down
 *   3. ADX < range and ATR/close ≥ floor   → range
 *   4. otherwise                            → flat
 *
 * Returns `flat` whenever any required input is unavailable; the hysteresis
 * layer in `RegimeDetector` then decides whether to actually flip.
 */
export function classifyRegime(
  candles: Candle[],
  options: RegimeDetectorOptions = {},
): Regime {
  const opt: Resolved = { ...DEFAULTS, ...options };
  if (candles.length === 0) return 'flat';

  const adxRes = adx(candles, opt.adxPeriod);
  const currentAtr = atr(candles, opt.atrPeriod);
  const closes = candles.map((c) => c.close);
  const slope = maSlope(closes, opt.maPeriod, opt.maSlopeLookback);
  const lastClose = candles[candles.length - 1].close;

  if (adxRes === null || currentAtr === null || lastClose <= 0) return 'flat';

  // Trailing-window ATR median: walk the tail of the candle series and compute
  // ATR for each suffix ending at offsets 0..N-1 from the latest bar. We need
  // at least `atrPeriod + 1` candles per ATR sample, so the deepest reachable
  // offset is `candles.length − (atrPeriod + 1)`.
  const samples: number[] = [];
  const maxBack = Math.min(opt.atrMedianWindow, candles.length - (opt.atrPeriod + 1));
  for (let back = 0; back <= maxBack; back++) {
    const slice = back === 0 ? candles : candles.slice(0, candles.length - back);
    const v = atr(slice, opt.atrPeriod);
    if (v !== null) samples.push(v);
  }
  const atrMedian = samples.length > 0 ? median(samples) : currentAtr;

  const atrPct = currentAtr / lastClose;
  const atrSpike = atrMedian > 0 && currentAtr > opt.atrHighVolMultiple * atrMedian;
  const isTrending = adxRes.adx >= opt.adxTrend;
  const isRanging = adxRes.adx < opt.adxRange;

  // 1. High-vol takes precedence over range/flat but not over an active trend.
  if (atrSpike && !isTrending) return 'high_vol';

  // 2. Trend with confirmed slope direction. Volatility floor suppresses fake
  //    trend labels in dead tape.
  if (isTrending && atrPct >= opt.atrPctFloor && slope !== null) {
    if (slope >= opt.maSlopeThreshold) return 'trend_up';
    if (slope <= -opt.maSlopeThreshold) return 'trend_down';
  }

  // 3. Range only when ADX is clearly low and there is enough vol to trade.
  if (isRanging && atrPct >= opt.atrPctFloor) return 'range';

  // 4. Anything else (including the 20–25 ADX dead zone with no slope) → flat.
  return 'flat';
}

/**
 * Stateful regime detector. Feed it the rolling candle window each bar via
 * `update(candles)`; it returns the active label *after* applying hysteresis
 * and the post-flip cooldown described in TRA-197 spec §1.
 *
 * Hysteresis rules:
 *   - A new candidate label must agree for `flipBars` consecutive bars before
 *     the active label flips. Default 3.
 *   - Leaving `flat` is faster: only `flatExitBars` consecutive bars of the
 *     same non-flat candidate are required. Default 2.
 *   - After a flip, the *previous* label is locked out for `cooldownBars`
 *     bars regardless of any new candidate stream. Default 2.
 */
export class RegimeDetector {
  private readonly opt: Resolved;
  private active: Regime = 'flat';
  private streakLabel: Regime | null = null;
  private streakCount = 0;
  private cooldownLabel: Regime | null = null;
  private cooldownLeft = 0;

  constructor(options: RegimeDetectorOptions = {}) {
    this.opt = { ...DEFAULTS, ...options };
  }

  /** Apply one bar of evidence; return the active regime after this bar. */
  update(candles: Candle[]): Regime {
    const candidate = classifyRegime(candles, this.opt);

    if (this.streakLabel === candidate) {
      this.streakCount += 1;
    } else {
      this.streakLabel = candidate;
      this.streakCount = 1;
    }

    // Cooldown ticks down on every bar regardless of what the candidate is;
    // the lockout exists to keep the detector from immediately bouncing back
    // to the label it just left, even if that label re-asserts strongly.
    if (this.cooldownLeft > 0) this.cooldownLeft -= 1;
    if (this.cooldownLeft === 0) this.cooldownLabel = null;

    if (candidate !== this.active) {
      const required = this.active === 'flat' ? this.opt.flatExitBars : this.opt.flipBars;
      const lockedOut = this.cooldownLabel !== null && candidate === this.cooldownLabel;
      if (!lockedOut && this.streakCount >= required) {
        const previous = this.active;
        this.active = candidate;
        this.cooldownLabel = previous;
        this.cooldownLeft = this.opt.cooldownBars;
      }
    }

    return this.active;
  }

  /** Active regime without consuming a new bar. */
  current(): Regime {
    return this.active;
  }

  /** Reset all hysteresis state. Mostly useful in tests / backtests. */
  reset(): void {
    this.active = 'flat';
    this.streakLabel = null;
    this.streakCount = 0;
    this.cooldownLabel = null;
    this.cooldownLeft = 0;
  }
}
