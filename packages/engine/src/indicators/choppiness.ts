import type { Candle } from '@trading-app/shared';

/**
 * Choppiness Index (CHOP) — TRA-1220 (spec §2.2, parent TRA-1218).
 *
 * A range-boundedness measure orthogonal to ADX: it compares the sum of true
 * ranges (total path travelled) to the size of the overall high-low envelope.
 * A market that grinds one direction covers little envelope per unit of path
 * ⇒ high ratio ⇒ LOW CHOP (trending); a market that oscillates inside a band
 * covers lots of path within a small envelope ⇒ HIGH CHOP (consolidating).
 *
 *   CHOP = 100 · log10( Σ TR_i / (maxHigh_n − minLow_n) ) / log10(n)
 *
 * where `TR_i` is the standard true range (same as ADX/ATR) and the envelope is
 * the highest high / lowest low over the trailing `n` bars. Bounded ~[0,100].
 *
 * Computed on CLOSED bars only (no lookahead — the caller drops the forming
 * bar). FAIL-CLOSED → `null` when:
 *   - fewer than `n + 1` candles (need one prior close for the first TR), or
 *   - the envelope `maxHigh − minLow ≤ 0` (degenerate/flat range → div-by-zero), or
 *   - the result is non-finite.
 *
 * Never returns a default/invented value — a null propagates up to a null regime.
 */
export function choppinessIndex(candles: Candle[], period = 14): number | null {
  if (!Number.isInteger(period) || period < 1) return null;
  if (candles.length < period + 1) return null;

  // True ranges over the last `period` bars (each needs its prior bar's close).
  const window = candles.slice(candles.length - period);
  let sumTr = 0;
  let maxHigh = -Infinity;
  let minLow = Infinity;
  for (let i = 0; i < window.length; i++) {
    const curr = window[i];
    // The bar preceding `curr` in the full series (guaranteed to exist because
    // we required `length ≥ period + 1` and window is the trailing `period`).
    const prevIdx = candles.length - period + i - 1;
    const prev = candles[prevIdx];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    sumTr += tr;
    if (curr.high > maxHigh) maxHigh = curr.high;
    if (curr.low < minLow) minLow = curr.low;
  }

  const envelope = maxHigh - minLow;
  if (!Number.isFinite(envelope) || envelope <= 0) return null; // degenerate range
  if (!Number.isFinite(sumTr) || sumTr <= 0) return null;

  const chop = (100 * Math.log10(sumTr / envelope)) / Math.log10(period);
  return Number.isFinite(chop) ? chop : null;
}
