import type { Candle } from '@trading-app/shared';
import { bollinger, type BollingerState } from './bollinger.js';

/**
 * TRA-843 — Double Bollinger Bands ("Double B" / WB) indicator engine.
 *
 * Reproduces the two-band setup from the source video (issue TRA-843):
 *
 *   - The "one" (fast/red) band: a deliberately WIDE, fast band — period 4,
 *     std-dev 4, sourced from the bar OPEN. It frames the very-recent
 *     (last-few-bars) extreme and only the most violent thrusts tag it.
 *   - The standard (slow/white) band: the conventional 20-period, 2-std-dev
 *     band sourced from the CLOSE. This is the band "every trader recognises",
 *     where ~80% of bars mean-revert back inside and the 20% that don't are the
 *     breakouts.
 *
 * The engine is pure and deterministic (depends only on OHLC), so every output
 * is golden-fixture testable, matching the rest of `indicators/`.
 *
 * Two trade reads are classified, exactly as the video describes:
 *
 *   1. REVERSAL (fade): price tags the bands but the candle closes back inside
 *      leaving a rejection wick — a "failed new high/low". Short the failed
 *      high / long the failed low; target the opposite standard band.
 *   2. BREAKOUT: the candle closes THROUGH both bands AND clears the prior
 *      swing high/low (the "supply/demand zone") on an expansion candle — a
 *      confirmed one-way move. Trade in the breakout direction.
 *
 * The classifier returns the structural read plus an entry/stop/target and the
 * resulting risk:reward. It does NOT gate on R:R or regime — that is the
 * strategy layer's job (see bb-fade for the single-band analogue).
 */

export type BandSource = 'open' | 'close' | 'high' | 'low' | 'hl2';

export interface DoubleBollingerOptions {
  /** Fast "one" band period (default 4). */
  fastPeriod?: number;
  /** Fast "one" band std-dev multiplier (default 4). */
  fastMultiplier?: number;
  /** Fast "one" band price source (default 'open'). */
  fastSource?: BandSource;
  /** Standard band period (default 20). */
  slowPeriod?: number;
  /** Standard band std-dev multiplier (default 2). */
  slowMultiplier?: number;
  /** Standard band price source (default 'close'). */
  slowSource?: BandSource;
  /**
   * Lookback (bars, excluding the latest) used to locate the prior swing
   * high/low that a breakout must clear — the "supply/demand zone" (default 20).
   */
  swingLookback?: number;
  /**
   * Minimum rejection-wick fraction of the candle range for a reversal read
   * (default 0.3). A 30% wick is the smallest "failed new high/low" worth
   * fading; below it the bar is treated as indecisive, not a rejection.
   */
  minWickFraction?: number;
  /**
   * Minimum candle range vs the slow bandwidth for a breakout to count as an
   * "expansion candle" (default 0.5 — body+wicks span at least half the band
   * width). Filters limp pokes through the band from genuine thrusts.
   */
  minExpansionFraction?: number;
}

export const DBB_DEFAULTS = {
  fastPeriod: 4,
  fastMultiplier: 4,
  fastSource: 'open' as BandSource,
  slowPeriod: 20,
  slowMultiplier: 2,
  slowSource: 'close' as BandSource,
  swingLookback: 20,
  minWickFraction: 0.3,
  minExpansionFraction: 0.5,
} as const;

export interface DoubleBollingerState {
  /** The wide, fast "one" (red) band. */
  fast: BollingerState;
  /** The standard 20/2 (white) band. */
  slow: BollingerState;
}

export type DbbSignalType =
  | 'reversal_short'
  | 'reversal_long'
  | 'breakout_long'
  | 'breakout_short'
  | 'none';

export interface DbbSignal {
  type: DbbSignalType;
  /** Human-readable rationale (the "why" the video insists every trade has). */
  reason: string;
  /** Suggested entry (latest close), or null on `none`. */
  entry: number | null;
  /** Suggested protective stop, or null on `none`. */
  stop: number | null;
  /** Suggested target (opposite band / projection), or null on `none`. */
  target: number | null;
  /** reward / risk for the suggested levels, or null on `none`. */
  riskReward: number | null;
}

const NONE: DbbSignal = {
  type: 'none',
  reason: 'no setup',
  entry: null,
  stop: null,
  target: null,
  riskReward: null,
};

/** Extract a price series for the requested band source. */
function sourceSeries(candles: Candle[], source: BandSource): number[] {
  switch (source) {
    case 'open':
      return candles.map(c => c.open);
    case 'high':
      return candles.map(c => c.high);
    case 'low':
      return candles.map(c => c.low);
    case 'hl2':
      return candles.map(c => (c.high + c.low) / 2);
    case 'close':
    default:
      return candles.map(c => c.close);
  }
}

/**
 * Both bands for the latest bar, or null when there are not enough candles for
 * the longer (standard) band.
 */
export function doubleBollinger(
  candles: Candle[],
  opts: DoubleBollingerOptions = {},
): DoubleBollingerState | null {
  const fastPeriod = opts.fastPeriod ?? DBB_DEFAULTS.fastPeriod;
  const fastMultiplier = opts.fastMultiplier ?? DBB_DEFAULTS.fastMultiplier;
  const fastSource = opts.fastSource ?? DBB_DEFAULTS.fastSource;
  const slowPeriod = opts.slowPeriod ?? DBB_DEFAULTS.slowPeriod;
  const slowMultiplier = opts.slowMultiplier ?? DBB_DEFAULTS.slowMultiplier;
  const slowSource = opts.slowSource ?? DBB_DEFAULTS.slowSource;

  if (candles.length < Math.max(fastPeriod, slowPeriod)) return null;

  const fast = bollinger(sourceSeries(candles, fastSource), fastPeriod, fastMultiplier);
  const slow = bollinger(sourceSeries(candles, slowSource), slowPeriod, slowMultiplier);
  if (!fast || !slow) return null;

  return { fast, slow };
}

/** Prior swing high over the lookback window, excluding the latest bar. */
function priorSwingHigh(candles: Candle[], lookback: number): number {
  const start = Math.max(0, candles.length - 1 - lookback);
  let hi = -Infinity;
  for (let i = start; i < candles.length - 1; i++) hi = Math.max(hi, candles[i].high);
  return hi;
}

/** Prior swing low over the lookback window, excluding the latest bar. */
function priorSwingLow(candles: Candle[], lookback: number): number {
  const start = Math.max(0, candles.length - 1 - lookback);
  let lo = Infinity;
  for (let i = start; i < candles.length - 1; i++) lo = Math.min(lo, candles[i].low);
  return lo;
}

/**
 * Classify the latest bar into a Double-Bollinger read.
 *
 * Reversal short: the bar's high tags BOTH upper bands but it closes back below
 * the standard upper band leaving an upper rejection wick — a failed new high.
 * Reversal long is the mirror on the lower bands.
 *
 * Breakout long: the close clears BOTH upper bands AND the prior swing high on
 * an expansion candle — the supply zone is broken with acceptance. Breakout
 * short is the mirror.
 *
 * Reversal is checked first: a bar that pokes the band and closes back inside is
 * a rejection, not a breakout, even if it briefly traded through.
 */
export function doubleBollingerSignal(
  candles: Candle[],
  opts: DoubleBollingerOptions = {},
): DbbSignal {
  const bands = doubleBollinger(candles, opts);
  if (!bands) return NONE;

  const swingLookback = opts.swingLookback ?? DBB_DEFAULTS.swingLookback;
  const minWickFraction = opts.minWickFraction ?? DBB_DEFAULTS.minWickFraction;
  const minExpansionFraction = opts.minExpansionFraction ?? DBB_DEFAULTS.minExpansionFraction;

  const c = candles[candles.length - 1];
  const { fast, slow } = bands;

  const range = c.high - c.low;
  if (range <= 0) return NONE;

  const upperUpper = Math.max(fast.upper, slow.upper);
  const lowerLower = Math.min(fast.lower, slow.lower);
  const bodyTop = Math.max(c.open, c.close);
  const bodyBottom = Math.min(c.open, c.close);
  const upperWick = c.high - bodyTop;
  const lowerWick = bodyBottom - c.low;
  const expansion = range >= minExpansionFraction * (slow.upper - slow.lower);

  // --- Reversal (fade) — failed new high/low, closes back inside the standard band.
  const taggedUpper = c.high >= upperUpper;
  if (taggedUpper && c.close < slow.upper && upperWick >= minWickFraction * range) {
    const entry = c.close;
    const stop = c.high; // above the failed high
    const target = slow.lower; // opposite standard band
    const risk = stop - entry;
    const reward = entry - target;
    if (risk > 0 && reward > 0) {
      return {
        type: 'reversal_short',
        reason: 'failed new high: tagged both upper bands, closed back inside standard band with rejection wick',
        entry,
        stop,
        target,
        riskReward: reward / risk,
      };
    }
  }

  const taggedLower = c.low <= lowerLower;
  if (taggedLower && c.close > slow.lower && lowerWick >= minWickFraction * range) {
    const entry = c.close;
    const stop = c.low; // below the failed low
    const target = slow.upper; // opposite standard band
    const risk = entry - stop;
    const reward = target - entry;
    if (risk > 0 && reward > 0) {
      return {
        type: 'reversal_long',
        reason: 'failed new low: tagged both lower bands, closed back inside standard band with rejection wick',
        entry,
        stop,
        target,
        riskReward: reward / risk,
      };
    }
  }

  // --- Breakout — close through both bands AND clears the prior swing zone.
  const swingHigh = priorSwingHigh(candles, swingLookback);
  if (
    c.close > fast.upper &&
    c.close > slow.upper &&
    Number.isFinite(swingHigh) &&
    c.close > swingHigh &&
    expansion
  ) {
    const entry = c.close;
    const stop = slow.middle; // back inside the standard band invalidates
    const risk = entry - stop;
    if (risk > 0) {
      const target = entry + 3 * risk; // video's ≥3:1 structural projection
      return {
        type: 'breakout_long',
        reason: 'breakout: closed above both upper bands and prior swing high on an expansion candle',
        entry,
        stop,
        target,
        riskReward: (target - entry) / risk,
      };
    }
  }

  const swingLow = priorSwingLow(candles, swingLookback);
  if (
    c.close < fast.lower &&
    c.close < slow.lower &&
    Number.isFinite(swingLow) &&
    c.close < swingLow &&
    expansion
  ) {
    const entry = c.close;
    const stop = slow.middle;
    const risk = stop - entry;
    if (risk > 0) {
      const target = entry - 3 * risk;
      return {
        type: 'breakout_short',
        reason: 'breakout: closed below both lower bands and prior swing low on an expansion candle',
        entry,
        stop,
        target,
        riskReward: (entry - target) / risk,
      };
    }
  }

  return NONE;
}
