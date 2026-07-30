/**
 * TRA-2643 — importance ordering for the whole-universe quote fan-out.
 *
 * ## Why this file exists
 *
 * `fetchQuotes`' secondary fan-out is bounded by `FEED_FANOUT_BUDGET_MS`, and
 * that budget is spent on *politeness sleeps*, not on work:
 *
 * ```
 * ceiling = floor(FEED_FANOUT_BUDGET_MS / FANOUT_SLEEP_MS) * QUOTE_BATCH
 *         = floor(8000 / 200) * 5
 *         = 200 symbols      ← before ANY network time is counted
 * ```
 *
 * (see `secondaryFanoutCeiling()` in `yahoo-feed.ts`). The live universe is
 * **614**. So whenever Tradier is dark, ~414 symbols are unpriced by arithmetic
 * alone — measured on the tape at 2026-07-29T00:30:10.147Z: `395/597 symbols
 * failed (feed budget exhausted)`, i.e. 202 covered against a predicted 200.
 *
 * The count is not the expensive part. `remaining` is iterated in whatever
 * order the universe happened to be in, so a budget-exhausted tick keeps an
 * **arbitrary** 200 and drops the rest. On 2026-07-29 the dropped set included
 * `^VIX` (measured: index 510 of 614 on bqb1, 2026-07-30) plus the entire
 * energy complex on a day crude moved +7.32%, which then had to be published as
 * "real in sign, unverified in magnitude".
 *
 * **A 67% loss ordered by importance is a different incident from a 67% loss
 * ordered by nothing.** This module makes the truncation keep the right 200. It
 * adds no requests and no wall-time — raising the budget re-opens the defect
 * TRA-1940 bounded, and raising throughput drives the Yahoo per-IP 429 that
 * started the incident. Ordering is the option with no downside.
 *
 * ## The latent bug this also closes
 *
 * `getActiveSymbols()` appended open-option underlyings **LAST**, after the
 * entire discovery tail. TRA-931 forced those underlyings into the universe
 * precisely so an off-watchlist position (its example was `SPCX`) still had a
 * live spot for the portfolio-Greeks gate and the stale-mark exit backstop. An
 * off-watchlist underlying is by construction neither in `WATCHLIST` nor in the
 * discovery set, so it landed at index >= 614 — **beyond the ceiling on every
 * degraded tick**. The fan-out truncation silently undid TRA-931 for exactly
 * the symbols TRA-931 exists to cover. Held risk now sorts first.
 *
 * ## The invariant
 *
 * {@link prioritizeQuoteUniverse} is a **permutation**: same multiset in, same
 * multiset out (deduped), never a filter. Nothing is dropped here — dropping is
 * the fan-out deadline's job, and it must stay the only place it happens.
 */

/**
 * Index / risk-input symbols that gate the whole session's regime read, not any
 * one position. `market-review.ts` resolves these (`^GSPC`/`^NDX` trend, `^VIX`
 * level, `^TNX` yield) and the composite trend gate decides whether ORB longs
 * are enabled at all — so one unpriced row here costs more than any single
 * discovery name. `SPY`/`QQQ` are the documented ETF proxies for `^GSPC`/`^NDX`
 * (TRA-469 / TRA-2197) and `VIX` is Tradier's un-prefixed spelling of `^VIX`
 * (TRA-586); the proxies matter most when the index leg is dark, which is
 * exactly a degraded tick, so they are prioritised alongside the indexes.
 */
export const RISK_INPUT_SYMBOLS: readonly string[] = [
  '^VIX', 'VIX', '^GSPC', '^NDX', '^TNX', 'SPY', 'QQQ',
] as const;

export interface QuotePriorityInput {
  /**
   * The full universe, in its natural order. The result is a permutation of the
   * deduped form of this array — every element survives.
   */
  universe: readonly string[];
  /**
   * Underlyings of open positions (equity + option). Highest priority: this is
   * risk already on the book, and its spot feeds exit backstops and the
   * portfolio-Greeks rollup.
   */
  held?: readonly string[];
  /**
   * Symbols carrying a live, unexpired signal. Second: these are the rows a
   * tick may actually act on, and an unpriced one is a decision skipped.
   */
  signalled?: readonly string[];
  /**
   * Curated base watchlist. Ranks under held/signalled but over the discovery
   * tail — it is the set a human chose.
   */
  base?: readonly string[];
  /** Override for {@link RISK_INPUT_SYMBOLS}; defaults to that list. */
  riskInputs?: readonly string[];
}

/**
 * Reorder `universe` most-important-first so a truncated fan-out keeps the rows
 * that carry money.
 *
 * Tiers, in order: **held → signalled → risk inputs → base watchlist →
 * discovery tail**. Within every tier the caller's original relative order is
 * preserved, so this is stable and the tail is untouched.
 *
 * A symbol named in `held`/`signalled`/`base`/`riskInputs` that is **not** in
 * `universe` is ignored — this function reorders, it never widens the fan-out.
 */
export function prioritizeQuoteUniverse(input: QuotePriorityInput): string[] {
  // Dedup up front, preserving first-seen order, so the tier walk below can be
  // a simple stable partition and the output length is well-defined.
  const ordered: string[] = [];
  const seen = new Set<string>();
  for (const sym of input.universe) {
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    ordered.push(sym);
  }

  // Rank each symbol by the FIRST tier that claims it. Membership sets, not
  // arrays, so a 614-symbol universe stays O(n) rather than O(n·tier).
  const tiers: ReadonlyArray<ReadonlySet<string>> = [
    new Set(input.held ?? []),
    new Set(input.signalled ?? []),
    new Set(input.riskInputs ?? RISK_INPUT_SYMBOLS),
    new Set(input.base ?? []),
  ];
  const TAIL = tiers.length;
  const rankOf = (sym: string): number => {
    for (let t = 0; t < tiers.length; t++) if (tiers[t].has(sym)) return t;
    return TAIL;
  };

  // Stable bucket partition. Deliberately NOT `ordered.sort(by rank)`: V8's
  // sort is stable today, but leaning on that would make the tail order an
  // implementation detail of the runtime rather than of this function, and the
  // whole point of the ticket is that order here is load-bearing.
  const buckets: string[][] = Array.from({ length: TAIL + 1 }, () => []);
  for (const sym of ordered) buckets[rankOf(sym)].push(sym);
  return buckets.flat();
}
