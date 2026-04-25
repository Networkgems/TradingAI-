export interface BollingerState {
  upper: number;
  middle: number;
  lower: number;
  /** Normalized bandwidth: (upper - lower) / middle */
  bandwidth: number;
}

/**
 * Classic Bollinger Bands (20-period SMA ± 2 std dev by default).
 * Returns null when there are insufficient candles.
 */
export function bollinger(
  closes: number[],
  period = 20,
  multiplier = 2,
): BollingerState | null {
  if (closes.length < period) return null;

  const window = closes.slice(-period);
  const sma = window.reduce((a, b) => a + b, 0) / period;
  const variance = window.reduce((a, b) => a + (b - sma) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);

  const upper = sma + multiplier * stdDev;
  const lower = sma - multiplier * stdDev;
  return { upper, middle: sma, lower, bandwidth: sma > 0 ? (upper - lower) / sma : 0 };
}

/**
 * Returns where price sits relative to the bands.
 * 'above_upper' / 'below_lower' indicate band excursions.
 * 'near_upper' / 'near_lower' trigger within 10% of band width.
 */
export function bollingerZone(
  price: number,
  bands: BollingerState,
): 'above_upper' | 'near_upper' | 'middle' | 'near_lower' | 'below_lower' {
  const range = bands.upper - bands.lower;
  if (price >= bands.upper) return 'above_upper';
  if (price <= bands.lower) return 'below_lower';
  if (price >= bands.upper - range * 0.1) return 'near_upper';
  if (price <= bands.lower + range * 0.1) return 'near_lower';
  return 'middle';
}
