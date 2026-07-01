/**
 * Kaufman Efficiency Ratio (ER) — TRA-1220 (spec §2.3, parent TRA-1218).
 *
 * Signal-to-noise of a move: the absolute NET change over the window divided by
 * the PATH length (sum of absolute bar-to-bar moves). A perfectly straight move
 * has net == path ⇒ ER = 1; pure back-and-forth noise has net ≈ 0 ⇒ ER → 0.
 *
 *   ER = | C_t − C_{t−n} | / Σ_{i=t−n+1..t} | C_i − C_{i−1} |
 *
 * Bounded [0,1]. Path-based, so it fails differently than ADX (lagging) and CHOP
 * (range-based) — the point of the 2-of-3 vote in the classifier.
 *
 * Computed on CLOSED bars only. FAIL-CLOSED → `null` when:
 *   - fewer than `n + 1` closes, or
 *   - the path length (denominator) is `≤ 0` (flat series), or
 *   - the result is non-finite.
 */
export function efficiencyRatio(closes: number[], period = 10): number | null {
  if (!Number.isInteger(period) || period < 1) return null;
  if (closes.length < period + 1) return null;

  const window = closes.slice(closes.length - period - 1); // period+1 closes → period steps
  const net = Math.abs(window[window.length - 1] - window[0]);
  let path = 0;
  for (let i = 1; i < window.length; i++) {
    path += Math.abs(window[i] - window[i - 1]);
  }

  if (!Number.isFinite(path) || path <= 0) return null; // flat series → div-by-zero
  const er = net / path;
  return Number.isFinite(er) ? er : null;
}
