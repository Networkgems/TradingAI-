import type { Candle } from '@trading-app/shared';

export type CandlePattern =
  | 'hammer'
  | 'shooting_star'
  | 'bullish_engulfing'
  | 'bearish_engulfing'
  | 'doji'
  | 'head_and_shoulders'
  | 'inverse_head_and_shoulders'
  | 'double_top'
  | 'double_bottom'
  | 'swing_failure';

/** Minimal swing descriptor — avoids importing from support-resistance (circular dep). */
type MinimalSwing = { price: number; kind: 'high' | 'low'; index: number };

export interface MultiBarPatternOptions {
  /** Fraction of price used as tolerance to call two swing levels "the same". */
  clusterPct?: number;
  /** Maximum bars back considered for pattern swings. */
  lookbackBars?: number;
}

const DEFAULT_MULTI_CLUSTER = 0.006; // 0.6 %
const DEFAULT_LOOKBACK_BARS = 40;

const DOJI_BODY_RATIO = 0.1;   // body < 10% of total range
const WICK_BODY_RATIO = 2.0;   // wick must be 2× the body

export function detectPattern(candles: Candle[]): CandlePattern | null {
  if (candles.length < 2) return null;

  const current = candles[candles.length - 1];
  const prev = candles[candles.length - 2];

  const body = Math.abs(current.close - current.open);
  const range = current.high - current.low;
  if (range === 0) return null;

  const upperWick = current.high - Math.max(current.open, current.close);
  const lowerWick = Math.min(current.open, current.close) - current.low;

  // Doji: tiny body relative to total range
  if (body / range < DOJI_BODY_RATIO) return 'doji';

  // Hammer: bullish candle, long lower wick, small upper wick
  if (
    current.close > current.open &&
    lowerWick > body * WICK_BODY_RATIO &&
    upperWick < body * 0.5
  ) return 'hammer';

  // Shooting star: bearish candle, long upper wick, small lower wick
  if (
    current.close < current.open &&
    upperWick > body * WICK_BODY_RATIO &&
    lowerWick < body * 0.5
  ) return 'shooting_star';

  const prevBody = Math.abs(prev.close - prev.open);
  if (prevBody === 0) return null;

  // Bullish engulfing: current bullish candle fully engulfs prior bearish candle
  if (
    prev.close < prev.open &&
    current.close > current.open &&
    current.open < prev.close &&
    current.close > prev.open
  ) return 'bullish_engulfing';

  // Bearish engulfing: current bearish candle fully engulfs prior bullish candle
  if (
    prev.close > prev.open &&
    current.close < current.open &&
    current.open > prev.close &&
    current.close < prev.open
  ) return 'bearish_engulfing';

  return null;
}

export function isBullishPattern(p: CandlePattern | null): boolean {
  return (
    p === 'hammer' ||
    p === 'bullish_engulfing' ||
    p === 'inverse_head_and_shoulders' ||
    p === 'double_bottom' ||
    p === 'swing_failure'
  );
}

export function isBearishPattern(p: CandlePattern | null): boolean {
  return (
    p === 'shooting_star' ||
    p === 'bearish_engulfing' ||
    p === 'doji' ||
    p === 'head_and_shoulders' ||
    p === 'double_top' ||
    p === 'swing_failure'
  );
}

/**
 * Detect multi-bar reversal patterns using confirmed swing pivots.
 *
 * Designed to complement single-bar `detectPattern()` as checklist leg 4:
 *   - swing_failure   — current bar pokes through a prior swing extreme but closes back;
 *                       the market faked out and rejected (strongest signal)
 *   - head_and_shoulders / inverse_head_and_shoulders
 *   - double_top / double_bottom
 *
 * `side` is the REVERSAL direction we want to confirm (long = bullish pattern,
 * short = bearish pattern). The function only returns a pattern aligned with
 * that direction so callers don't need a secondary directional filter.
 *
 * `swings` should be the confirmed pivots from `findSwings()`, already filtered
 * to exclude the current (unconfirmed) bar — pass them through unchanged.
 */
export function detectMultiBarPattern(
  candles: Candle[],
  swings: MinimalSwing[],
  side: 'long' | 'short',
  opts: MultiBarPatternOptions = {},
): CandlePattern | null {
  if (candles.length < 2 || swings.length === 0) return null;

  const last = candles[candles.length - 1];
  const ref = last.close;
  const clusterPct = opts.clusterPct ?? DEFAULT_MULTI_CLUSTER;
  const lookbackBars = opts.lookbackBars ?? DEFAULT_LOOKBACK_BARS;
  const tol = ref * clusterPct;
  const minIdx = candles.length - 1 - lookbackBars;

  // Callers pass pre-confirmed swings from findSwings(), which already excludes
  // the current bar, so we only need the lookback-window lower bound.
  const recent = swings.filter((s) => s.index >= minIdx);

  if (side === 'long') {
    const lows = recent.filter((s) => s.kind === 'low').sort((a, b) => a.index - b.index);

    // Swing Failure Pattern (long): current bar undercuts a prior swing low but closes above it.
    // The market trapped shorts below support — strongest single-bar multi-swing signal.
    for (let i = lows.length - 1; i >= 0; i--) {
      const sl = lows[i];
      if (last.low <= sl.price && last.close > sl.price) return 'swing_failure';
    }

    // Inverse Head & Shoulders: three swing lows where the middle is the deepest.
    if (lows.length >= 3) {
      const [l1, l2, l3] = lows.slice(-3);
      if (
        l2.price < l1.price &&
        l2.price < l3.price &&
        Math.abs(l3.price - l1.price) <= tol * 3
      ) return 'inverse_head_and_shoulders';
    }

    // Double Bottom: two swing lows at approximately the same price.
    if (lows.length >= 2) {
      const [l1, l2] = lows.slice(-2);
      if (Math.abs(l1.price - l2.price) <= tol) return 'double_bottom';
    }
  } else {
    const highs = recent.filter((s) => s.kind === 'high').sort((a, b) => a.index - b.index);

    // Swing Failure Pattern (short): current bar exceeds a prior swing high but closes below it.
    for (let i = highs.length - 1; i >= 0; i--) {
      const sh = highs[i];
      if (last.high >= sh.price && last.close < sh.price) return 'swing_failure';
    }

    // Head & Shoulders: three swing highs where the middle is the tallest.
    if (highs.length >= 3) {
      const [h1, h2, h3] = highs.slice(-3);
      if (
        h2.price > h1.price &&
        h2.price > h3.price &&
        Math.abs(h3.price - h1.price) <= tol * 3
      ) return 'head_and_shoulders';
    }

    // Double Top: two swing highs at approximately the same price.
    if (highs.length >= 2) {
      const [h1, h2] = highs.slice(-2);
      if (Math.abs(h1.price - h2.price) <= tol) return 'double_top';
    }
  }

  return null;
}
