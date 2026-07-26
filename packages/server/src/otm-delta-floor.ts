/**
 * TRA-2388 — |delta| floor for the read-only OTM mispricing panel.
 *
 * Implements the TRA-2354 decision (option 1: a panel-only floor of 0.02).
 * Options 2 (clamp the reported ratio) and 3 (rank on a different statistic)
 * were declined; the rationale is on TRA-2354.
 *
 * ## Why the theo floor was not enough
 *
 * TRA-2341 put a one-tick floor on the mispricing DENOMINATOR, which killed the
 * pathological `theo → 0` rows (SPY's 74215.7%). It did not fix the underlying
 * shape of the problem: `|mispricingPct|` is a RATIO, and ranking by a ratio
 * always returns the far tail. Just above the theo floor the model price is
 * still a rounding error next to a bid pinned near the minimum tick, so the
 * ratio still measures the tick — just less spectacularly. Live at `408f06a`
 * (with the theo floor deployed) SPY's default panel still topped out at
 * **1510.9%** and TSLA at **1312.2%**.
 *
 * `|delta|` is the right axis because it is the direct measure of "how far out
 * is this contract", it is already computed on every candidate, and unlike the
 * ratio it does not degrade as theo shrinks. The artifact band tops out at
 * |delta| 0.0116 (SPY) / 0.0106 (TSLA), so 0.02 clears it with margin.
 *
 * ## Why the route layer, and not `scanOtm`'s `minAbsDelta`
 *
 * The engine ALREADY has this filter — `otm-mispricing.ts:227`, TRA-1407's
 * `minAbsDelta`, defaulting to 0. Two reasons this route does not just forward a
 * default into it:
 *
 *  1. **It can count.** The engine filter `continue`s before the candidate
 *     exists, so a suppressed row leaves no trace: the panel would read
 *     "nothing found", which is indistinguishable from a thin chain. That is the
 *     exact failure mode TRA-2341 was written to avoid. Filtering the returned
 *     `candidates` array keeps the dropped rows countable.
 *  2. **Containment.** The `single_leg_otm` sleeve reaches `findMispricedOtmContracts`
 *     in-process via `signal-engine.ts:7297` with its own `otmScanOpts`, and
 *     TRA-1407's floor is board-tuned (recommend 0.40) and flag-gated. A default
 *     that lives in the route projection is structurally incapable of reaching a
 *     sleeve decision. Engine `DEFAULTS` (`otm-mispricing.ts:92`) stay
 *     byte-unchanged — a change there is live trading logic and a different
 *     decision.
 *
 * The two filters are provably equivalent on the kept set: TRA-1407 runs
 * post-greeks on the same `delta` value that lands on the candidate, the engine
 * derives no aggregate from `candidates` after the loop (it only sorts), and
 * `scanOtm` returns the array untouched. So moving the predicate downstream
 * changes only *observability*, never the rows. That is why this route no longer
 * forwards `minAbsDelta` at all: one authority, one honest count, for both the
 * default and an explicit `?minDelta=`.
 *
 * ## Never silent
 *
 * Same contract as the theo floor: report the suppressed COUNT and the largest
 * suppressed ratio, echo the applied floor, and let `?minDelta=0` restore the
 * raw tail for research. The echoed `deltaFloor` block also doubles as a free
 * deploy detector — a build predating this change omits the key entirely, so its
 * presence (not a SHA, not a commit subject) is what proves the build swapped.
 */

/**
 * |delta| floor applied by `/api/options/otm-mispricing` unless the caller
 * overrides it.
 *
 * Measured basis (live `408f06a`, one DTE-picked expiration per symbol,
 * `limit=15&minMispricing=0.15`) — max `|mispricingPct|` by floor:
 *
 * | symbol | 0       | 0.01   | **0.02** | 0.05  |
 * |--------|---------|--------|----------|-------|
 * | SPY    | 1510.9% |  66.0% | **19.5%**| 14.6% |
 * | TSLA   | 1312.2% | 130.1% | **34.4%**| 10.4% |
 * | NVDA   |   25.4% |  25.4% | **25.4%**| 15.1% |
 * | QQQ    |    9.5% |   9.5% | **9.5%** |  9.5% |
 * | AAPL   |   17.1% |  17.1% | **17.1%**| 17.1% |
 *
 * Positive control: SPY and TSLA collapse out of the artifact regime. Negative
 * control: NVDA / QQQ / AAPL are bit-identical from 0 through 0.03 with
 * `suppressed: 0` — the floor is a no-op on healthy symbols, which is the
 * property that made TRA-2341 credible and the one to re-establish after every
 * deploy.
 *
 * Not 0.01: SPY still reads 66.0% there, inside the artifact regime.
 * Not 0.05 (the number the ticket floated): NVDA's row at |delta| 0.0404 is the
 * ONLY `cheap` classification in the whole 5-symbol sweep and 0.05 deletes it;
 * AAPL loses an `expensive` too. 0.02 is the last floor before the panel starts
 * eating the reads it exists to show.
 *
 * ⚠️ Those numbers came off WEEKEND / stale marks (2026-07-26). The response
 * curve is smooth and monotone, so this is a POLICY choice on a continuum, not a
 * cliff the data picked out — re-measure during RTH and, if the knee has moved,
 * hand the number back to TRA-2354 rather than retuning silently.
 */
export const OTM_PANEL_DELTA_FLOOR = 0.02;

/** The subset of `OtmMispricingCandidate` this guard reads. */
export interface DeltaFloorCandidate {
  /** Sign-adjusted Black-Scholes delta — negative for puts, hence the abs. */
  delta: number;
  mispricingPct: number;
}

export interface DeltaFloorResult<T extends DeltaFloorCandidate> {
  /** Candidates at or above the floor, in the order they arrived (rank order). */
  kept: T[];
  /** The floor actually applied. 0 ⇒ disabled, every candidate kept. */
  floor: number;
  /** How many candidates the floor removed. Rendered, never swallowed. */
  suppressed: number;
  /**
   * Largest `|mispricingPct|` among the suppressed rows, so the footnote can say
   * HOW absurd the discarded reads were. `null` when nothing was dropped.
   */
  maxSuppressedMispricingPct: number | null;
}

/**
 * Drop candidates whose |delta| is below `floor`, reporting what was dropped.
 *
 * A non-finite or non-positive `floor` disables the guard (everything kept,
 * `floor` reported as 0) — that is the explicit `?minDelta=0` escape hatch, and
 * it also means a garbage query string degrades to the legacy projection rather
 * than to an empty table.
 *
 * A non-finite `delta` fails the floor, matching TRA-1407's engine-side
 * predicate (`!(Math.abs(delta) >= floor)`) exactly: an un-scored contract has
 * no business clearing a distance gate. Note that this is the OPPOSITE
 * disposition from a `floor` of NaN, which disables the guard — a broken CALLER
 * gets the raw view, a broken ROW gets suppressed.
 *
 * Rank order is preserved, and the caller slices to `limit` AFTER this runs,
 * which is the whole point: filtering after the slice would leave the tail
 * occupying the top N and merely blank the table.
 */
export function applyDeltaFloor<T extends DeltaFloorCandidate>(
  candidates: readonly T[],
  floor: number,
): DeltaFloorResult<T> {
  if (!Number.isFinite(floor) || floor <= 0) {
    return { kept: [...candidates], floor: 0, suppressed: 0, maxSuppressedMispricingPct: null };
  }

  const kept: T[] = [];
  let suppressed = 0;
  let maxSuppressed: number | null = null;

  for (const c of candidates) {
    if (Math.abs(c.delta) >= floor) {
      kept.push(c);
      continue;
    }
    suppressed += 1;
    const abs = Math.abs(c.mispricingPct);
    if (Number.isFinite(abs) && (maxSuppressed === null || abs > maxSuppressed)) {
      maxSuppressed = abs;
    }
  }

  return { kept, floor, suppressed, maxSuppressedMispricingPct: maxSuppressed };
}
