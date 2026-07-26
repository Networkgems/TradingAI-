// TRA-2379 (parent TRA-2304) — plausibility check for a quote's session move.
//
// The defect: `yahoo-feed.ts` computes `changePct = (price - prevClose)/prevClose
// * 100` and guards `prevClose` only with `> 0`. When the provider returns an
// UNADJUSTED prev close across a corporate action, that guard passes and the
// arithmetic is faithfully wrong — FFAI published `price 6.49 / prevClose 0.07 /
// changePct 8951.61` with `quoteStatus:'ok'`, and every ranking consumer put it
// first.
//
// Per TRA-2379 decision 1 this module FLAGS, it never CLAMPS. `change` and
// `changePct` are published raw; consumers read the verdict and degrade. A clamp
// would hide the bad prev close and convert a visible data-quality failure into an
// invisible one.
//
// This is a standalone pure predicate rather than a field threaded down from the
// feed, because the two boundaries that need it do not share a data path:
// `signal-engine.applyQuotes` stamps `quoteStatus` for the whole stock universe,
// while `market-scanner` never touches `symbolState` at all — it reads its own
// Yahoo *screener* responses. A flag stamped in the engine is invisible to the
// scanner. See the pre-patch consumer enumeration on TRA-2379.

/**
 * Ratio at or above which a session move is treated as implausible.
 *
 * DERIVED, not picked (TRA-2379 decision 3). On the 07-26 tape every candidate in
 * `[1.75, 10]` produces the identical partition, so the tape cannot choose; the
 * number comes from the tolerances instead:
 *
 *  - The statistic must be SYMMETRIC IN DIRECTION. `changePct` is bounded below at
 *    -100% and unbounded above, so an unadjusted 1:k REVERSE split reads
 *    `+(k-1)*100%` while an unadjusted k:1 FORWARD split of the same factor reads
 *    `(1/k - 1)*100%`. A flat percentage threshold of 100% therefore catches NO
 *    forward-split artefact at any k, and a flat 40% catches both directions only
 *    by also firing on the genuine 25-40% single-session microcap moves that are
 *    real (six of them on the 07-26 tape). `max(price/prev, prev/price)` gives the
 *    same value whichever way the action went.
 *  - It must cover the SMALLEST corporate action that can produce the artefact,
 *    which is a factor of 2 (2:1 forward, 1:2 reverse) => r = 2 exactly. Any
 *    higher value opens a hole at the most common split factor.
 *
 * False-positive check on the 07-26 tape (587 symbols, FFAI excluded as the known
 * bad): 0 flagged rows. Sub-$7 microcaps taken separately — the partition where
 * large genuine moves live — top out at r = 1.670 (GSUN, -39.60%), i.e. 1.20x of
 * headroom; the other five genuine 25-40% movers sit at r = 1.335-1.389. FFAI is
 * at r = 92.71.
 *
 * That headroom is deliberately thin. A genuine -50% microcap session WILL be
 * flagged, and that is the right trade because decision 1 makes a false positive
 * cheap: the row keeps its raw numbers and loses a badge and its place in a
 * *suggestion* list. A false negative published +8,951.61% as fact and ranked it
 * first.
 */
export const SUSPECT_MOVE_RATIO = 2;

export type QuoteSuspectReason =
  /** `changePct` (or the price it was derived from) is not a finite number. */
  | 'non_finite'
  /** The implied previous close is <= 0 — an impossible datum, not merely a large one. */
  | 'nonpositive_prev_close'
  /** `max(price/prev, prev/price) >= SUSPECT_MOVE_RATIO`. */
  | 'implausible_move_ratio';

export interface QuotePlausibilityInput {
  price: number;
  /** Absolute session change. Optional: some providers supply only a percentage. */
  change?: number;
  /** Session change in percent. Optional: some providers supply only an absolute. */
  changePct?: number;
}

export interface QuotePlausibilityVerdict {
  suspect: boolean;
  reason?: QuoteSuspectReason;
  /** The prev close the published numbers imply. `null` when it cannot be recovered. */
  impliedPrevClose: number | null;
  /** `max(price/prev, prev/price)`. `null` when `impliedPrevClose` is unusable. */
  ratio: number | null;
}

const OK: QuotePlausibilityVerdict = { suspect: false, impliedPrevClose: null, ratio: null };

/**
 * Recover the previous close the published `change` / `changePct` imply.
 *
 * Prefers the absolute `change` (an exact subtraction) and falls back to the
 * percentage, which is what the Tradier and Yahoo-quote paths supply directly. A
 * genuinely flat session (`change === 0`) resolves through the percentage branch
 * to the same answer, so the preference order costs nothing.
 */
export function impliedPrevClose(q: QuotePlausibilityInput): number | null {
  const { price, change, changePct } = q;
  if (!Number.isFinite(price)) return null;
  if (typeof change === 'number' && Number.isFinite(change) && change !== 0) return price - change;
  if (typeof changePct === 'number' && Number.isFinite(changePct)) {
    const denom = 1 + changePct / 100;
    if (denom === 0) return null;
    return price / denom;
  }
  if (typeof change === 'number' && change === 0) return price;
  return null;
}

/**
 * Decide whether a quote's published session move is trustworthy.
 *
 * Returns `suspect: false` for any quote with `price <= 0` or a non-finite price:
 * those are already handled by the existing `'unavailable'` / `'rate_limited'`
 * statuses and must not be reclassified. (SBLX on the 07-26 tape is exactly this
 * case — `price 0`, already `'unavailable'`.)
 */
export function assessQuotePlausibility(q: QuotePlausibilityInput): QuotePlausibilityVerdict {
  const { price, change, changePct } = q;

  // Not our jurisdiction: the no-quote paths own these.
  if (!Number.isFinite(price) || price <= 0) return OK;

  // A quote carrying neither a change nor a percentage says nothing about a move;
  // there is nothing to disbelieve.
  const hasChange = typeof change === 'number';
  const hasPct = typeof changePct === 'number';
  if (!hasChange && !hasPct) return OK;

  if ((hasChange && !Number.isFinite(change)) || (hasPct && !Number.isFinite(changePct))) {
    return { suspect: true, reason: 'non_finite', impliedPrevClose: null, ratio: null };
  }

  const prev = impliedPrevClose(q);
  if (prev === null || !Number.isFinite(prev) || prev <= 0) {
    return { suspect: true, reason: 'nonpositive_prev_close', impliedPrevClose: prev, ratio: null };
  }

  const ratio = Math.max(price / prev, prev / price);
  if (!Number.isFinite(ratio)) {
    return { suspect: true, reason: 'non_finite', impliedPrevClose: prev, ratio: null };
  }
  if (ratio >= SUSPECT_MOVE_RATIO) {
    return { suspect: true, reason: 'implausible_move_ratio', impliedPrevClose: prev, ratio };
  }
  return { suspect: false, impliedPrevClose: prev, ratio };
}

/** Convenience wrapper for the many call sites that only need the boolean. */
export function isQuoteMoveSuspect(q: QuotePlausibilityInput): boolean {
  return assessQuotePlausibility(q).suspect;
}

/**
 * One-line, log-ready explanation. Used by the market-scanner exclusion log so a
 * dropped row is never silent — per TRA-2379 decision 2, "a silent drop reads
 * identically to nothing was wrong."
 */
export function describeQuoteSuspicion(symbol: string, q: QuotePlausibilityInput): string {
  const v = assessQuotePlausibility(q);
  if (!v.suspect) return `${symbol}: plausible`;
  const prev = v.impliedPrevClose === null ? 'n/a' : v.impliedPrevClose.toFixed(4);
  const ratio = v.ratio === null ? 'n/a' : v.ratio.toFixed(2);
  return `${symbol}: ${v.reason} (price=${q.price}, changePct=${q.changePct ?? 'n/a'}, `
    + `impliedPrevClose=${prev}, ratio=${ratio}, threshold=${SUSPECT_MOVE_RATIO})`;
}
