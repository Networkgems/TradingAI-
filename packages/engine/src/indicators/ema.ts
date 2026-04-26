/** Exponential Moving Average (EMA). Returns NaN if insufficient data. */
export function ema(closes: number[], period: number): number {
  if (closes.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = closes.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < closes.length; i++) e = closes[i] * k + e * (1 - k);
  return e;
}

/**
 * Returns 'bullish' when the fast EMA just crossed above the slow EMA,
 * 'bearish' when it just crossed below, or null if no cross occurred on the latest bar.
 */
export function emaCross(
  closes: number[],
  fastPeriod: number,
  slowPeriod: number,
): 'bullish' | 'bearish' | null {
  if (closes.length < slowPeriod + 1) return null;

  const currFast = ema(closes, fastPeriod);
  const currSlow = ema(closes, slowPeriod);
  const prevFast = ema(closes.slice(0, -1), fastPeriod);
  const prevSlow = ema(closes.slice(0, -1), slowPeriod);

  if (isNaN(currFast) || isNaN(currSlow) || isNaN(prevFast) || isNaN(prevSlow)) return null;

  if (prevFast <= prevSlow && currFast > currSlow) return 'bullish';
  if (prevFast >= prevSlow && currFast < currSlow) return 'bearish';
  return null;
}
