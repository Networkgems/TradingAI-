import type { Candle } from '@trading-app/shared';

export interface AdxResult {
  adx: number;
  plusDI: number;
  minusDI: number;
}

/**
 * Average Directional Index (ADX) with ±DI lines.
 *
 * Uses Wilder's smoothing (equivalent to EMA with alpha = 1/period).
 * Requires at least 2 * period candles; returns null when data is insufficient.
 *
 * Interpretation (rule-of-thumb used by this engine):
 *   ADX < 20 → ranging / choppy market (favour reversal signals; avoid ORB)
 *   ADX > 25 → trending market       (favour ORB / MACD / Ichimoku)
 */
export function adx(candles: Candle[], period = 14): AdxResult | null {
  if (candles.length < period * 2) return null;

  const trueRanges: number[] = [];
  const plusDMs: number[] = [];
  const minusDMs: number[] = [];

  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const upMove = curr.high - prev.high;
    const downMove = prev.low - curr.low;

    plusDMs.push(upMove > downMove && upMove > 0 ? upMove : 0);
    minusDMs.push(downMove > upMove && downMove > 0 ? downMove : 0);

    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  // Seed Wilder smoothing with the first period's sum
  let smoothTR = trueRanges.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothPlusDM = plusDMs.slice(0, period).reduce((a, b) => a + b, 0);
  let smoothMinusDM = minusDMs.slice(0, period).reduce((a, b) => a + b, 0);

  const dxSeries: number[] = [];

  for (let i = period; i < trueRanges.length; i++) {
    smoothTR = smoothTR - smoothTR / period + trueRanges[i];
    smoothPlusDM = smoothPlusDM - smoothPlusDM / period + plusDMs[i];
    smoothMinusDM = smoothMinusDM - smoothMinusDM / period + minusDMs[i];

    if (smoothTR === 0) continue;

    const diPlus = (smoothPlusDM / smoothTR) * 100;
    const diMinus = (smoothMinusDM / smoothTR) * 100;
    const diSum = diPlus + diMinus;
    const dx = diSum === 0 ? 0 : (Math.abs(diPlus - diMinus) / diSum) * 100;
    dxSeries.push(dx);
  }

  if (dxSeries.length < period) return null;

  // ADX = Wilder smooth of DX series
  let adxValue = dxSeries.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < dxSeries.length; i++) {
    adxValue = (adxValue * (period - 1) + dxSeries[i]) / period;
  }

  // Recompute final ±DI from the last smoothed values for the return value
  const lastTR = smoothTR;
  const diPlus = lastTR === 0 ? 0 : (smoothPlusDM / lastTR) * 100;
  const diMinus = lastTR === 0 ? 0 : (smoothMinusDM / lastTR) * 100;

  return { adx: adxValue, plusDI: diPlus, minusDI: diMinus };
}
