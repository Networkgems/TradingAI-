import type { Candle } from '@trading-app/shared';

/**
 * Average True Range (ATR) — Wilder's smoothed measure of realized volatility.
 *
 * True range for bar i is max(high-low, |high-prevClose|, |low-prevClose|).
 * Returns the latest smoothed ATR (alpha = 1/period). Needs at least
 * `period + 1` candles; returns null when data is insufficient.
 *
 * Useful for volatility-adaptive stops/targets: a stop placed at
 * `k × ATR` widens in high-vol regimes and tightens in low-vol regimes,
 * which keeps achieved R:R stable across market conditions.
 */
export function atr(candles: Candle[], period = 14): number | null {
  if (candles.length < period + 1) return null;

  const trueRanges: number[] = [];
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    trueRanges.push(tr);
  }

  // Seed with the simple average of the first `period` true ranges,
  // then apply Wilder smoothing for the remainder.
  let smoothed = trueRanges.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < trueRanges.length; i++) {
    smoothed = (smoothed * (period - 1) + trueRanges[i]) / period;
  }
  return smoothed;
}

/**
 * ATR expressed as a fraction of the latest close. Convenient for
 * volatility regime gates ("skip when 24h ATR/price < 0.3%") and for
 * computing percentage-based ATR stops without dividing at every call site.
 */
export function atrPct(candles: Candle[], period = 14): number | null {
  if (candles.length === 0) return null;
  const value = atr(candles, period);
  if (value === null) return null;
  const lastClose = candles[candles.length - 1].close;
  if (lastClose <= 0) return null;
  return value / lastClose;
}
