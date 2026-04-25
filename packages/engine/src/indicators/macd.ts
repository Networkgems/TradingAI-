export interface MacdResult {
  macd: number;
  signal: number;
  histogram: number;
}

function emaOf(values: number[], period: number): number {
  if (values.length < period) return NaN;
  const k = 2 / (period + 1);
  let e = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < values.length; i++) e = values[i] * k + e * (1 - k);
  return e;
}

/**
 * MACD (12/26/9 default). Builds the MACD line by running two independent EMAs,
 * then computes a signal-line EMA of the MACD series.
 * Returns null when there are insufficient candles.
 */
export function macd(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): MacdResult | null {
  if (closes.length < slowPeriod + signalPeriod - 1) return null;

  const kFast = 2 / (fastPeriod + 1);
  const kSlow = 2 / (slowPeriod + 1);

  let emaFast = closes.slice(0, fastPeriod).reduce((a, b) => a + b, 0) / fastPeriod;
  let emaSlow = closes.slice(0, slowPeriod).reduce((a, b) => a + b, 0) / slowPeriod;

  // Advance fast EMA to the same index where slow EMA starts
  for (let i = fastPeriod; i < slowPeriod; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
  }

  const macdSeries: number[] = [emaFast - emaSlow];
  for (let i = slowPeriod; i < closes.length; i++) {
    emaFast = closes[i] * kFast + emaFast * (1 - kFast);
    emaSlow = closes[i] * kSlow + emaSlow * (1 - kSlow);
    macdSeries.push(emaFast - emaSlow);
  }

  if (macdSeries.length < signalPeriod) return null;

  const signalLine = emaOf(macdSeries, signalPeriod);
  if (isNaN(signalLine)) return null;

  const macdLine = macdSeries[macdSeries.length - 1];
  return { macd: macdLine, signal: signalLine, histogram: macdLine - signalLine };
}

/**
 * Returns 'bullish' when the MACD histogram just turned positive (line crossed above signal),
 * 'bearish' when it just turned negative, or null if no cross occurred.
 */
export function macdCross(
  closes: number[],
  fastPeriod = 12,
  slowPeriod = 26,
  signalPeriod = 9,
): 'bullish' | 'bearish' | null {
  if (closes.length < slowPeriod + signalPeriod) return null;

  const curr = macd(closes, fastPeriod, slowPeriod, signalPeriod);
  const prev = macd(closes.slice(0, -1), fastPeriod, slowPeriod, signalPeriod);
  if (!curr || !prev) return null;

  if (prev.histogram <= 0 && curr.histogram > 0) return 'bullish';
  if (prev.histogram >= 0 && curr.histogram < 0) return 'bearish';
  return null;
}
