/**
 * TRA-2917 — isotonic (PAVA) monotone repair for the OTM theo surface.
 *
 * Vertical-spread monotonicity is model-free: within one (expiration, optionType)
 * bucket, call prices must be non-increasing in strike and put prices
 * non-decreasing. The vendor's per-contract `smv_vol` carries no cross-strike
 * constraint, so the Black-Scholes theo built on it violates that condition on
 * live chains (TRA-2662: 11/143 pairs; the failing cell rotates capture to
 * capture — TRA-2669).
 *
 * The repair is the L2 projection onto the monotone cone: pool-adjacent-violators
 * with equal weights. Chosen (TRA-2917, QuantTrader 2026-08-05) over a smile fit
 * or a sigma-space bound because:
 *
 *   - it is the MINIMAL change — the closest monotone sequence in L2;
 *   - every value outside a violating run is returned BYTE-UNCHANGED (an
 *     unmerged block is the original element, no arithmetic touches it), so
 *     discrimination retention is structural, not tuned;
 *   - it has zero fit parameters to rotate out from under us.
 *
 * Ties are allowed on purpose: the TRA-2662 guard's violation predicate is
 * strict inequality, so the flat segments PAVA produces pass it.
 */

export type MonotoneDirection = 'nonincreasing' | 'nondecreasing';

/**
 * Project `values` onto the nearest monotone sequence (unweighted L2).
 *
 * Standard pool-adjacent-violators: scan left to right keeping a stack of
 * blocks; while the top two blocks violate the direction, merge them and
 * replace both with their (weighted) mean. Pure — returns a new array, input
 * untouched. Values inside a merged block all take the block mean; values never
 * merged are returned exactly as given (`===` on the original element).
 */
export function pavaMonotone(values: number[], direction: MonotoneDirection): number[] {
  if (values.length <= 1) return [...values];

  // A block is a maximal pooled run: `sum`/`count` give its mean, `len` how
  // many input slots it covers. `raw` keeps the original value so an unmerged
  // singleton reproduces its input bit-for-bit instead of via sum/count.
  interface Block {
    sum: number;
    len: number;
    raw: number;
  }
  const violates =
    direction === 'nondecreasing'
      ? (prev: Block, next: Block) => prev.sum / prev.len > next.sum / next.len
      : (prev: Block, next: Block) => prev.sum / prev.len < next.sum / next.len;

  const stack: Block[] = [];
  for (const v of values) {
    let block: Block = { sum: v, len: 1, raw: v };
    while (stack.length > 0 && violates(stack[stack.length - 1], block)) {
      const prev = stack.pop()!;
      block = { sum: prev.sum + block.sum, len: prev.len + block.len, raw: NaN };
    }
    stack.push(block);
  }

  const out: number[] = [];
  for (const block of stack) {
    const value = block.len === 1 ? block.raw : block.sum / block.len;
    for (let i = 0; i < block.len; i += 1) out.push(value);
  }
  return out;
}
