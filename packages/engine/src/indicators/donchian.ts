import type { Candle } from '@trading-app/shared';

export interface DonchianChannel {
  /** Highest high over the lookback window. */
  upper: number;
  /** Lowest low over the lookback window. */
  lower: number;
  /** Midpoint of the channel. */
  middle: number;
}

/**
 * Donchian channel — highest high / lowest low over a fixed lookback.
 *
 * The classical "turtle" breakout uses the *previous N bars excluding the
 * current bar* so a fresh close beyond the band is unambiguously a breakout
 * rather than a tautology (the current bar's high is by definition ≤ the
 * window's high if the window includes it). Set `excludeCurrent` to false
 * if you want the inclusive variant.
 *
 * Returns null when there are fewer than `period` bars available for the
 * requested window.
 */
export function donchian(
  candles: Candle[],
  period = 20,
  excludeCurrent = true,
): DonchianChannel | null {
  if (period <= 0) return null;
  const end = excludeCurrent ? candles.length - 1 : candles.length;
  const start = end - period;
  if (start < 0) return null;

  let upper = -Infinity;
  let lower = Infinity;
  for (let i = start; i < end; i++) {
    const c = candles[i];
    if (c.high > upper) upper = c.high;
    if (c.low < lower) lower = c.low;
  }
  if (!Number.isFinite(upper) || !Number.isFinite(lower)) return null;
  return { upper, lower, middle: (upper + lower) / 2 };
}
