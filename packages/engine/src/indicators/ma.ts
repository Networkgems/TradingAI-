/**
 * Moving-average helpers used by the regime detector and trend-following
 * strategies. The existing `ema.ts` only returns the latest EMA value; we need
 * the full series here so we can read EMA[t] and EMA[t−lookback] for slope.
 */

/**
 * Exponential Moving Average series. The first `period − 1` entries are NaN
 * (insufficient data); the entry at index `period − 1` is seeded with the
 * simple average of the first `period` closes, after which the standard
 * EMA recurrence `e_i = c_i * k + e_{i-1} * (1 − k)` with `k = 2 / (period + 1)`
 * is applied.
 */
export function emaSeries(closes: number[], period: number): number[] {
  const out = new Array<number>(closes.length).fill(NaN);
  if (closes.length < period || period <= 0) return out;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += closes[i];
  e /= period;
  out[period - 1] = e;
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k);
    out[i] = e;
  }
  return out;
}

/**
 * Per-bar percentage slope of an EMA, defined per the regime spec
 * (TRA-197 spec §1) as:
 *
 *   slope = (EMA_t − EMA_{t − lookback}) / EMA_{t − lookback} / lookback
 *
 * Returns null when there is not enough data to read both endpoints (need at
 * least `period + lookback` closes). Result is a fraction-per-bar; for the
 * default ±0.05% threshold compare against `0.0005`.
 */
export function maSlope(
  closes: number[],
  period = 50,
  lookback = 5,
): number | null {
  if (lookback <= 0) return null;
  if (closes.length < period + lookback) return null;
  const series = emaSeries(closes, period);
  const last = series[series.length - 1];
  const prev = series[series.length - 1 - lookback];
  if (!Number.isFinite(last) || !Number.isFinite(prev) || prev === 0) return null;
  return (last - prev) / prev / lookback;
}
