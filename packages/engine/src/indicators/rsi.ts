/** Wilder's RSI (14-period default). Returns NaN if insufficient data. */
export function rsi(closes: number[], period = 14): number {
  if (closes.length < period + 1) return NaN;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const delta = closes[i] - closes[i - 1];
    if (delta > 0) gains += delta;
    else losses -= delta;
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? -delta : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

/** Returns true when RSI diverges: price makes new extreme but RSI does not. */
export function rsiDivergence(
  closes: number[],
  period = 14,
  lookback = 5,
): 'bullish' | 'bearish' | null {
  if (closes.length < period + lookback + 1) return null;

  const currentRsi = rsi(closes, period);
  const prevRsi = rsi(closes.slice(0, -lookback), period);
  if (isNaN(currentRsi) || isNaN(prevRsi)) return null;

  const currentPrice = closes[closes.length - 1];
  const prevPrice = closes[closes.length - 1 - lookback];

  // Bearish divergence: price higher, RSI lower
  if (currentPrice > prevPrice && currentRsi < prevRsi) return 'bearish';
  // Bullish divergence: price lower, RSI higher
  if (currentPrice < prevPrice && currentRsi > prevRsi) return 'bullish';
  return null;
}
