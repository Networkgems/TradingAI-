import type { Candle } from '@trading-app/shared';

/**
 * Average True Range (ATR) — Wilder's smoothed measure of realized volatility.
 *
 * True range for bar i is max(high-low, |high-prevClose|, |low-prevClose|).
 * Returns the latest smoothed ATR (alpha = 1/period).
 *
 * ⚠️ **`period` IS NOT A WINDOW, AND SERIES LENGTH IS NOT EITHER.** This does
 * **not** slice to the last `period` candles. It **seeds** on the first `period`
 * true ranges with a flat simple average and then Wilder-smooths **all the way
 * to the END of the series**. So:
 *
 * - **`period` sets the MEMORY** — weights decay as `((period-1)/period)^k`
 *   back from the last bar, whatever length you hand in.
 * - **The series LENGTH is a CONVERGENCE parameter** — it controls one thing
 *   only: how much of that flat seed block survives to the end. The seed's
 *   residual weight is `((period-1)/period)^(len-1-period)`, so at `period = 14`
 *   a 40-candle series still carries **15.7%** of its answer on 14 true ranges
 *   from 27–40 bars back, while a 150-candle series carries 0.000%.
 *
 * **Two different lengths of the same series therefore return two different
 * numbers**, and the shorter one is not a shorter-memory measure — it is the
 * same `period`-bar EMA with a stale lump in it, and it is irreproducible (one
 * bar of provider-window difference visibly moves a 40-bar read). Hand in a
 * series deep enough to converge, not one sized to `period`. Measured on the
 * live universe at `period = 14`: depth 40 deviates a median 3.5% (max 25.8%)
 * from the converged read, 60 → 0.38%, 100 → 0.013%, **150 → 0.000%**.
 * (TRA-4943 / TRA-4989 — a 40-bar pull was sized on exactly the belief this
 * paragraph exists to kill, and it was stamping live exit levels.)
 *
 * Needs at least `period + 1` candles or it returns null — but `period + 1` is
 * the point at which a number exists, **not** the point at which it is the same
 * number a deep series would give you.
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

  // Seed with the simple average of the FIRST `period` true ranges, then Wilder-
  // smooth over every remaining bar — to the END of the series, not to a window.
  // See the docblock: series length is a convergence parameter.
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
