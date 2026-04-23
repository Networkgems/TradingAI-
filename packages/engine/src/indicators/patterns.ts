import type { Candle } from '@trading-app/shared';

export type CandlePattern = 'hammer' | 'shooting_star' | 'bullish_engulfing' | 'bearish_engulfing' | 'doji';

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
  return p === 'hammer' || p === 'bullish_engulfing';
}

export function isBearishPattern(p: CandlePattern | null): boolean {
  return p === 'shooting_star' || p === 'bearish_engulfing' || p === 'doji';
}
