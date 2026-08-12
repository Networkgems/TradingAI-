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
 * Ratio at or above which a session move is implausible ON MAGNITUDE ALONE.
 *
 * ⚠️ This is the ANCHOR, not the flag boundary. The boundary the predicate
 * actually tests is {@link SUSPECT_MOVE_RATIO_FLOOR} below — see the TRA-3241
 * correction there. Anything at or above THIS value is condemned by magnitude
 * with no proximity argument needed.
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
 *  - It is ANCHORED at the SMALLEST corporate action that can produce the
 *    artefact: a factor of 2 (2:1 forward, 1:2 reverse).
 *
 * ⛔ CORRECTED 2026-08-11 (TRA-3241). This derivation used to conclude
 * "=> r = 2 exactly. Any higher value opens a hole at the most common split
 * factor." That is one step short, and it was a false justification for using
 * the anchor AS the flag boundary. A factor-2 action lands at r = 2 EXACTLY
 * only when the price has not moved at all from the split-adjusted prior
 * close. With a genuine ex-date move `m`, an unadjusted 2:1 forward split
 * publishes `r = 2/(1+m)` and an unadjusted 1:2 reverse publishes
 * `r = 2*(1+m)` — any tick in the gap-closing direction pulls r STRICTLY
 * BELOW 2, and `>=` puts that on the fail-open side. At the modal split factor
 * the bare anchor is therefore a coin flip on the SIGN of the intraday move.
 * Measured live (bqb1, 2026-08-11): MNST oscillated between r = 1.99672
 * (unflagged, publishing -49.92% as the session's #1 loser) and r = 2.00022
 * (flagged) across ticks of the SAME session.
 */
export const SUSPECT_MOVE_RATIO = 2;

/**
 * TRA-3241 — fractional tolerance below {@link SUSPECT_MOVE_RATIO} that the
 * near-split proximity band covers. See {@link SUSPECT_MOVE_RATIO_FLOOR} for
 * the derivation; this constant exists so the floor's provenance is arithmetic
 * on the record rather than a bare literal.
 */
export const SPLIT_PROXIMITY_TOLERANCE = 0.05;

/**
 * TRA-3241 — the boundary the ratio rule actually tests: `r >= 1.9` flags.
 *
 * This is the union of two rules, and stating it as a union is what keeps both
 * derivations honest:
 *
 *  - the magnitude floor `r >= SUSPECT_MOVE_RATIO` (TRA-2379, unchanged), and
 *  - the k = 2 PROXIMITY BAND `[2*(1 - SPLIT_PROXIMITY_TOLERANCE), 2)`, which
 *    catches the factor-2 artefact when a genuine same-session move has pulled
 *    r under the anchor: coverage is every ex-date drift in (-5%, +5.26%),
 *    i.e. the modal split day, where the bare anchor was a coin flip.
 *
 * Why a band ONLY at k = 2: every integer split factor (2, 3, 4, 5, 10, 20 and
 * their reciprocals — r folds direction) is >= 2, so the bands around the
 * higher factors are subsumed by the magnitude floor; the k = 2 band below the
 * floor is the ENTIRE incremental surface of "proximity to a plausible integer
 * factor". A pure proximity test with no floor would be strictly worse — FFAI
 * at r = 92.71 is near no factor and would UNFLAG. Sub-2 FRACTIONAL factors
 * (3:2 at r = 1.5, 5:4 at 1.25) stay deliberately out: TRA-3065 measured that
 * region as dense with genuine movers (a 1.5 floor flags 53.9% of published
 * mover rows), and those actions are owned by the split-calendar leg
 * (TRA-3068) and TRA-2380, not by any ratio.
 *
 * Why 5%: the band must cover the genuine ex-date drift of a stock that split
 * overnight. Measured artefacts cluster tight — MNST at r = 1.99672 (0.16%
 * drift), WXM at 1.97774-1.99 (0.5-1.1%) on 2026-08-11 — while typical
 * same-session drift is low single digits; 5% covers the modal split day
 * without reaching the genuine-mover population. The 1.9 edge sits in the
 * measured EMPTY region between the two: the largest plausibly-genuine movers
 * are r = 1.670 (GSUN, 07-26 tape) and r = 1.642 (QMCO, 08-11 tape) ⇒ 1.14x
 * headroom below the edge; the nearest unflagged artefact-shaped row is FGMC's
 * frozen-price shape at 1.816 (owned by the continuity rule, not this one).
 * A hard cutoff must sit in a gap in the distribution, never inside a cluster
 * — the anchor at 2 sat INSIDE the k = 2 artefact cluster [1.97, 2.01], which
 * is the defect TRA-3241 was filed on.
 *
 * False-positive cost, re-measured on the 2026-08-11 tape (663 symbols):
 * 1.9 flags exactly PLAG (r = 10.80, split artefact), MNST and WXM (both
 * factor-2-shaped) — zero plausibly-genuine movers. A genuine +90-99% or
 * -47.4..-50% session WILL be flagged; that trade is accepted because TRA-2379
 * decision 1 makes a false positive cheap (the row keeps its raw numbers and
 * loses a badge and its place in a *suggestion* list) while the false negative
 * published the session's #1 loser off a fabricated denominator.
 *
 * A LITERAL, not `SUSPECT_MOVE_RATIO * (1 - SPLIT_PROXIMITY_TOLERANCE)`, on
 * purpose: the float product is 1.9000000000000001, strictly ABOVE the literal
 * 1.9, so deriving the edge at runtime would silently exclude the exact value
 * the docs and logs advertise (TRA-2689's strict-float-comparison shape). The
 * test suite asserts the literal and the product agree to 12 decimal places.
 */
export const SUSPECT_MOVE_RATIO_FLOOR = 1.9;

// ── TRA-3068 (measured on TRA-3065) — THE SPLIT CALENDAR ──────────────────────
//
// Both predicates in this module are INTERNAL-CONSISTENCY tests: they ask
// whether the numbers on a row — or on two adjacent rows — agree with each
// other. An unadjusted corporate action is internally CONSISTENT: the arithmetic
// is faithful, the INPUT is wrong. So neither statistic can reach the class at
// any threshold, and the fix has to come from OUTSIDE the row.
//
// ⛔ AND DO NOT REACH FOR `SUSPECT_MOVE_RATIO` INSTEAD. TRA-3065 measured the
// false-positive cost over 525 bqb1 symbol-rows (105 reports, 3 folds, 120d):
// relative to the deployed bar of 2 (131 rows flagged, 25.0%), a 3:2 needs
// R = 1.5, which flags 283 rows — 53.9% of everything we publish, 152 of them
// newly, against an archive holding ZERO confirmed corporate actions. And it
// still would not close the class: under an unadjusted feed the session ratio is
// `max((1+m)/k, k/(1+m))`, a function of the genuine ex-date move `m` as well as
// the factor `k`, so an action of factor `k` is caught only when `m <= k/R - 1`
// or `m >= R*k - 1`. For 3:2 at R = 1.5 the stock must ALSO genuinely move
// <= -25% or >= +200% on the ex-date. There is no R that closes it.
//
// ⚠️ RE-DERIVED 2026-08-11 (TRA-3241) AND THE PROHIBITION STANDS. The
// `SUSPECT_MOVE_RATIO_FLOOR` band at 1.9 is NOT the move this paragraph
// forbids and does NOT discharge it: the band closes the k = 2 PROXIMITY hole
// specifically (where the artefact cluster measurably sits and the genuine
// population measurably does not — see the floor's own derivation), while this
// paragraph's arithmetic is about chasing the class DOWN THE FACTOR GRID. That
// argument is untouched: 3:2 still lives at r ~ 1.5 inside the genuine-mover
// population, no floor OR band down there survives the 53.9% cost, and the
// split calendar remains the only instrument that reaches it.
//
// The ex-date is the one input that distinguishes a 3:2 split from a genuine
// -33% session, and it is nearly free: Yahoo's chart endpoint — which
// `yahoo-feed.ts` already calls per symbol — returns split events when asked, so
// this costs one query-string option, no new provider and no new HTTP call.
//
// ⛔ FLAG, NEVER CLAMP, AND NEVER AT THE READ PATH. TRA-2379 decision 1 and the
// TRA-3063 ruling both apply: `change` / `changePct` stay raw and the verdict is
// stamped where the row is GENERATED. Masking a fabricated headline at read time
// converts a loud failure into a silent one.

/**
 * A corporate action known from the provider's own event calendar, not inferred
 * from the price series.
 *
 * Shaped after Yahoo's `chart(..., { events: 'div|split' }).events.splits[]`
 * entry — `{ date, numerator, denominator, splitRatio }` — because that is the
 * only source wired today and re-shaping it would invite a lossy translation.
 */
export interface CorporateAction {
  /**
   * ET calendar date of the EX-date, `YYYY-MM-DD` — the session the action first
   * prices in, i.e. the ONE session whose `prevClose` straddles it.
   *
   * A string, not an epoch, and deliberately: every session boundary in the
   * report path is already an ET `YYYY-MM-DD` key (`etDateKey`,
   * `priorSessionDate`), the format sorts lexicographically in chronological
   * order, and comparing dates as dates keeps the DST/`hour24` hazards of
   * TRA-2498 out of a predicate that has no business owning a clock.
   */
  exDate: string;
  /** Yahoo's `numerator`: 10 for a 10:1 forward split, 1 for a 1:10 reverse. */
  numerator: number;
  /** Yahoo's `denominator`: 1 for a 10:1 forward split, 10 for a 1:10 reverse. */
  denominator: number;
  /** The provider's own label (`"10:1"`). Carried for the log; never parsed. */
  splitRatio?: string;
}

/**
 * The action factor `k = numerator / denominator`. `k > 1` is a forward split
 * (the traded price falls by `k`); `k < 1` a reverse split.
 *
 * Returns `null` — not `NaN`, not `Infinity` — on anything degenerate, INCLUDING
 * an exact 1:1. This is the fail-closed direction and it is load-bearing: a
 * known action SILENCES `assessLevelContinuity` and REDIRECTS
 * `assessQuotePlausibility`'s reason, so a provider row we cannot interpret must
 * never be able to switch a detector off. No interpretable factor => treated as
 * NO known action => the row stays subject to both rules exactly as before.
 */
export function corporateActionFactor(a: CorporateAction | null | undefined): number | null {
  if (a == null) return null;
  const n = a.numerator;
  const d = a.denominator;
  if (typeof n !== 'number' || typeof d !== 'number') return null;
  if (!Number.isFinite(n) || !Number.isFinite(d) || n <= 0 || d <= 0) return null;
  const k = n / d;
  if (!Number.isFinite(k) || k <= 0 || k === 1) return null;
  return k;
}

/**
 * The action, if any, whose ex-date lands in `(priorSessionDate, currentSessionDate]`
 * — the half-open window over which a published `changePct` is not a session move.
 *
 * HALF-OPEN ON PURPOSE. An action ex-dated ON the prior session is already
 * inside the close we published for it, so the current row's `prevClose` is
 * post-action and nothing is straddled; an action ex-dated on the CURRENT
 * session is exactly the one whose `prevClose` is pre-action. Including the
 * lower bound would flag a clean row one session late, every time.
 *
 * With no `priorSessionDate` the lower bound is unknown, and the window
 * collapses to `exDate === currentSessionDate` rather than opening to `-∞`: the
 * current row's `prevClose` can be no older than the immediately preceding
 * session, so that is the only ex-date we can prove straddles it. Widening it
 * would flag every row for weeks after a split.
 *
 * Comparison is lexicographic, which for zero-padded `YYYY-MM-DD` IS
 * chronological. Latest qualifying ex-date wins when two land in one window (a
 * Monday row after a Friday split and a Monday split) — that is the one whose
 * arithmetic is on the row.
 */
export function corporateActionInSessionWindow(
  actions: readonly CorporateAction[] | null | undefined,
  priorSessionDate: string | null | undefined,
  currentSessionDate: string | null | undefined,
): CorporateAction | null {
  if (!actions || actions.length === 0) return null;
  if (typeof currentSessionDate !== 'string' || currentSessionDate.length === 0) return null;
  let best: CorporateAction | null = null;
  for (const a of actions) {
    if (corporateActionFactor(a) === null) continue;
    const ex = a?.exDate;
    if (typeof ex !== 'string' || ex.length === 0) continue;
    if (ex > currentSessionDate) continue;
    const inWindow = typeof priorSessionDate === 'string' && priorSessionDate.length > 0
      ? ex > priorSessionDate
      : ex === currentSessionDate;
    if (!inWindow) continue;
    if (best === null || ex > best.exDate) best = a;
  }
  return best;
}

export type QuoteSuspectReason =
  /** `changePct` (or the price it was derived from) is not a finite number. */
  | 'non_finite'
  /** The implied previous close is <= 0 — an impossible datum, not merely a large one. */
  | 'nonpositive_prev_close'
  /** `max(price/prev, prev/price) >= SUSPECT_MOVE_RATIO`. */
  | 'implausible_move_ratio'
  /**
   * TRA-3241 — `ratio` is in `[SUSPECT_MOVE_RATIO_FLOOR, SUSPECT_MOVE_RATIO)`:
   * within the proximity band below the smallest integer split factor. Genuine
   * moves do not cluster on exact small-integer ratios; corporate actions are
   * the mechanism that puts them there, and a genuine same-session tick in the
   * gap-closing direction is what pulls the artefact under the anchor. Distinct
   * from `'implausible_move_ratio'` so a log line names WHICH rule condemned
   * the row — the magnitude, or the proximity.
   */
  | 'near_split_ratio'
  /**
   * TRA-3068 — a KNOWN corporate action ex-dated INTO this row's session, from
   * the provider's split calendar rather than from the row's own arithmetic.
   *
   * This is the only reason in the union that is not a function of the numbers,
   * and it is the only one that can fire on a row whose ratio is nowhere near
   * `SUSPECT_MOVE_RATIO`. The published `changePct` spans the action, so it is
   * not a session move and must not be ranked as one. The value stays raw.
   */
  | 'corporate_action';

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
  /**
   * The action that produced a `'corporate_action'` verdict. Present ONLY on
   * that reason, so a caller can log the ratio that condemned the row — a flag
   * whose cause is not on the record is an assertion, not evidence (TRA-2379
   * decision 2).
   */
  corporateAction?: CorporateAction;
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
 *
 * `action` (TRA-3068) is the OPTIONAL split-calendar leg: pass the entry
 * `corporateActionInSessionWindow` returned for this row's session pair, or
 * nothing. Omitting it reproduces the pre-TRA-3068 behaviour EXACTLY, which is
 * why every existing caller and both TRA-3065 checkers compile and grade
 * unchanged — the new leg can only ever ADD a verdict, never remove one.
 */
export function assessQuotePlausibility(
  q: QuotePlausibilityInput,
  action?: CorporateAction | null,
): QuotePlausibilityVerdict {
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

  // TRA-3068 — a KNOWN ex-date outranks the ratio test, and it is checked BEFORE
  // it so the reason names the CAUSE rather than the symptom. This is the whole
  // point of the leg: a 3:2 forward split sits at r = 1.5 and sails past both
  // the anchor AND the TRA-3241 proximity band, while the factor-2 rows the
  // ratio does catch are caught by arithmetic that cannot say WHICH action did
  // it. `ratio` is still carried so the log shows both numbers side by side.
  //
  // This fires in BOTH feed branches, deliberately, and TRA-3065 could not settle
  // which one we are in: under an UNADJUSTED prev close the published `changePct`
  // is fabricated, and under a RETROACTIVELY ADJUSTED one it is correct but is a
  // post-action move being ranked against pre-action peers. Neither belongs at
  // #1 in a document a human reads as the session summary, and decision 1 makes
  // the flag cheap — the row keeps its raw numbers and loses a badge and its
  // place in a *suggestion* list.
  const known = corporateActionFactor(action) === null ? null : (action as CorporateAction);
  if (known) {
    return { suspect: true, reason: 'corporate_action', impliedPrevClose: prev, ratio, corporateAction: known };
  }

  if (ratio >= SUSPECT_MOVE_RATIO) {
    return { suspect: true, reason: 'implausible_move_ratio', impliedPrevClose: prev, ratio };
  }
  // TRA-3241 — the k = 2 proximity band. Ordered AFTER the magnitude floor so
  // the reason partition is exact: at or above the anchor is magnitude, inside
  // the band is proximity, below the band is clean.
  if (ratio >= SUSPECT_MOVE_RATIO_FLOOR) {
    return { suspect: true, reason: 'near_split_ratio', impliedPrevClose: prev, ratio };
  }
  return { suspect: false, impliedPrevClose: prev, ratio };
}

/** Convenience wrapper for the many call sites that only need the boolean. */
export function isQuoteMoveSuspect(q: QuotePlausibilityInput): boolean {
  return assessQuotePlausibility(q).suspect;
}

/**
 * A published symbol row, as far as the plausibility question is concerned.
 *
 * TRA-2610 — `moveSuspect` is a field of its OWN, orthogonal to `quoteStatus`.
 * That separation is the whole fix: `quoteStatus` answers *can we see this symbol*
 * (`ok` / `rate_limited` / `unavailable` / `stale`) and `moveSuspect` answers *do we
 * believe its session move*. They were one field, so a failed fetch stamping
 * `'unavailable'` ERASED the `'suspect'` stamp written on the tick before.
 */
export interface QuoteMoveRow {
  /** Absent / non-finite ⇒ not our jurisdiction; the no-quote statuses own it. */
  price?: number;
  change?: number;
  changePct?: number;
  /** TRA-2610 — the producer's verdict, stamped by `signal-engine.applyQuotes`. */
  moveSuspect?: boolean;
  /**
   * TRA-3243 — the SESSION-SCOPED verdict: this row published an implausible move
   * at some point in today's session, ON A PREV CLOSE THAT IS STILL THE ONE IN USE.
   * See `advanceMoveSuspectSession` for the state machine that maintains it and
   * for why it is a different proposition from `moveSuspect`.
   */
  moveSuspectSession?: boolean;
}

/**
 * THE consumer-side predicate: may this row's `change` / `changePct` be ranked,
 * headlined or coloured?
 *
 * TRA-2610 — every ranking consumer used to key on `quoteStatus !== 'suspect'`,
 * i.e. on the ABSENCE of a flag, and `'unavailable' !== 'suspect'` is `true`. FGMC
 * (`price 8.30`, `changePct +110.66`, last quoted 104 min earlier) was flagged, then
 * demoted to `'unavailable'` by the next failed fetch, then passed the exclusion and
 * ranked #1 in the shipped EOD report on 2026-07-28 AND 2026-07-29.
 *
 * ⭐ It EXECUTES THE RULE as well as reading the flag, and that ordering is
 * deliberate. Reading the flag alone makes every consumer's correctness depend on
 * one producer never dropping a stamp — and the rows that drop it are exactly the
 * thin, sporadically-quoted names most likely to carry a corporate-action artefact,
 * so a flag-only guard is LEAST reliable on precisely the rows it exists to catch.
 * The rule is a pure function of the numbers the row publishes, so it cannot be
 * erased by a later write to a different field, and it fails CLOSED on any row
 * reached by a write path that never assessed plausibility at all.
 *
 * The flag is still honoured first because it is the producer's verdict on the
 * quote it actually saw (including inputs the row no longer carries), and because a
 * consumer must not silently disagree with the stamp on `/api/state`.
 *
 * TRA-3243 — this is the INSTANTANEOUS reading: *is the move this row is
 * publishing right now implausible*. It is no longer the default consumer
 * predicate; `isMoveSuspect` below is. Kept exported and named so the two
 * propositions can be told apart at a call site and in a census.
 */
export function isMoveSuspectNow(row: QuoteMoveRow): boolean {
  if (row.moveSuspect === true) return true;
  return assessQuotePlausibility({
    price: row.price ?? NaN,
    change: row.change,
    changePct: row.changePct,
  }).suspect;
}

/**
 * THE consumer-side predicate (TRA-3243): may this row's `change` / `changePct` be
 * ranked, headlined or coloured?
 *
 * ⭐ **The flag is a verdict on the DENOMINATOR, not on the ratio.** The ratio test
 * is only the detector. `isMoveSuspectNow` alone answers "is the ratio big *at this
 * instant*", and that made the guard non-monotonic within a session: a row condemned
 * at 15:00 read clean at the close because the NUMERATOR mean-reverted, while
 * `impliedPrevClose` — the datum actually under suspicion — was the same number in
 * both verdicts (AZI 08-06: condemned on prev `1.0100`, published `1.60 / +58.42%`
 * ⇒ prev `1.00998`; RDGT 08-10: condemned on prev `0.7390`, published
 * `0.9899 / +32.73%` ⇒ prev `0.7458`). `eod-report.ts` samples the CLOSING snapshot,
 * so the published exclusion set was strictly smaller than the set the feed flagged.
 *
 * So the session fact is ORed in. It is not a plain latch — see
 * `advanceMoveSuspectSession` for the discharge conditions.
 */
export function isMoveSuspect(row: QuoteMoveRow): boolean {
  if (row.moveSuspectSession === true) return true;
  return isMoveSuspectNow(row);
}

// ── TRA-3243 — WHICH FACT IS BEING LATCHED ───────────────────────────────────
//
// Two propositions, deliberately not merged:
//
//   P-now      this row's move is implausible AT THIS INSTANT.
//   P-session  this row published an implausible move AT SOME POINT in today's
//              session, ON A PREV CLOSE THAT IS STILL THE ONE IN USE.
//
// P-session is NOT "was suspect once today". A plain latch was the obvious remedy
// and it is the wrong one: it permanently badges a genuine intraday spike that
// mean-reverts, and on the sub-penny partition (FLYYQ, r >= 2 on 4 of 4 readable
// sessions, where one tick IS a factor of two) it would fire every session and
// never clear. What is latched here is the CONDEMNATION OF A SPECIFIC DENOMINATOR,
// and it is discharged the moment that denominator is re-derived to a materially
// different value — which is exactly the event that would mean the feed had
// corrected the datum under suspicion.

/**
 * The prev close a row was condemned on, carried across ticks so the suspicion can
 * be attached to the datum rather than to the row.
 */
export interface MoveSuspectSessionState {
  /** P-session. */
  moveSuspectSession?: boolean;
  /** ET session date key (`YYYY-MM-DD`) the fact belongs to. */
  moveSuspectSessionDay?: string;
  /** The `impliedPrevClose` that was condemned. The ANCHOR — never re-based. */
  moveSuspectPrevClose?: number;
}

export type MoveSuspectSessionTransition =
  /** Clean before, clean now. */
  | 'clean'
  /** Newly condemned this session. */
  | 'condemned'
  /** Already condemned, condemned again. */
  | 'sustained'
  /** Instantaneously clean, but on the SAME denominator ⇒ the fact stands. */
  | 'held'
  /** Instantaneously clean on a DIFFERENT denominator ⇒ the suspicion is spent. */
  | 'discharged'
  /** Instantaneously clean but the denominator is unreadable ⇒ fail closed. */
  | 'unreadable'
  /** The carried fact belonged to a previous session and was dropped. */
  | 'rolled_over';

export interface MoveSuspectSessionAdvance extends MoveSuspectSessionState {
  moveSuspectSession: boolean;
  moveSuspectSessionDay: string;
  transition: MoveSuspectSessionTransition;
}

/**
 * Two implied prev closes are THE SAME DATUM.
 *
 * The band is derived, not tuned. `impliedPrevClose` prefers `price - change`, and
 * providers quantise `change` to 2 dp while `price` carries 3-4, so the recovered
 * denominator of a FIXED true prev close wanders inside a +/- 0.005 half-ulp — two
 * reads can therefore differ by up to 0.01 with nothing having happened. The band
 * is set at twice that so it does not sit ON the edge of the population it must
 * absorb (TRA-3241: a threshold placed at the mode of its own population is a coin
 * flip), plus a 1% relative term so the same reasoning holds at any price level.
 *
 * The other population is orders of magnitude away: a denominator that genuinely
 * CHANGES does so because the feed swapped an unadjusted close for an adjusted one,
 * and the smallest corporate action in the grid (3:2) moves it 33%. 2c/1% sits in
 * the gap between the two, not on either.
 */
const PREV_CLOSE_IDENTITY_ABS = 0.02;
const PREV_CLOSE_IDENTITY_REL = 0.01;

export function isSameImpliedPrevClose(a: number | null | undefined, b: number | null | undefined): boolean {
  if (typeof a !== 'number' || typeof b !== 'number') return false;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  const tol = Math.max(PREV_CLOSE_IDENTITY_ABS, PREV_CLOSE_IDENTITY_REL * Math.max(Math.abs(a), Math.abs(b)));
  return Math.abs(a - b) <= tol;
}

/**
 * Advance the session-scoped verdict by one tick. PURE — the engine owns the
 * storage, this owns the rule, so the state machine is testable without a feed.
 *
 * | carried fact | this tick's verdict | denominator | result                  |
 * |---|---|---|---|
 * | any          | suspect             | -           | condemned (anchor := this prev close) |
 * | set          | clean               | same        | HELD                    |
 * | set          | clean               | different   | discharged              |
 * | set          | clean               | unreadable  | HELD (fail closed)      |
 * | unset        | clean               | -           | clean                   |
 *
 * The anchor is never re-based while the fact stands. Re-basing it every tick would
 * let the 0.005 quantisation wander ratchet the "same datum" band arbitrarily far
 * from the value that was actually condemned.
 *
 * A carried fact from a different ET session day is dropped before any of this: the
 * proposition is scoped to ONE session, and "implausible yesterday" is a claim about
 * a prev close that is not even in the arithmetic any more.
 */
export function advanceMoveSuspectSession(
  prev: MoveSuspectSessionState | null | undefined,
  verdict: QuotePlausibilityVerdict,
  sessionDay: string,
): MoveSuspectSessionAdvance {
  const sameSession = prev?.moveSuspectSessionDay === sessionDay;
  const carried = sameSession && prev?.moveSuspectSession === true;
  const rolledOver = !sameSession && prev?.moveSuspectSession === true;

  if (verdict.suspect) {
    const anchor = typeof verdict.impliedPrevClose === 'number' && Number.isFinite(verdict.impliedPrevClose)
      ? verdict.impliedPrevClose
      // A `non_finite` / unrecoverable verdict has no denominator to anchor to;
      // keep whatever we were condemned on so the fact stays discharge-able.
      : (carried ? prev?.moveSuspectPrevClose : undefined);
    return {
      moveSuspectSession: true,
      moveSuspectSessionDay: sessionDay,
      ...(typeof anchor === 'number' ? { moveSuspectPrevClose: anchor } : {}),
      transition: carried ? 'sustained' : 'condemned',
    };
  }

  if (!carried) {
    return {
      moveSuspectSession: false,
      moveSuspectSessionDay: sessionDay,
      transition: rolledOver ? 'rolled_over' : 'clean',
    };
  }

  const anchor = prev?.moveSuspectPrevClose;
  if (typeof anchor !== 'number' || !Number.isFinite(anchor)
    || typeof verdict.impliedPrevClose !== 'number' || !Number.isFinite(verdict.impliedPrevClose)) {
    // Cannot compare ⇒ cannot claim the suspicion was discharged. An unreadable
    // denominator is not evidence of a corrected one (TRA-2379's cost asymmetry:
    // a false positive costs one row a badge, a false negative headlines a
    // fabrication in a document a human reads as the session summary).
    return {
      moveSuspectSession: true,
      moveSuspectSessionDay: sessionDay,
      ...(typeof anchor === 'number' ? { moveSuspectPrevClose: anchor } : {}),
      transition: 'unreadable',
    };
  }

  if (isSameImpliedPrevClose(anchor, verdict.impliedPrevClose)) {
    return {
      moveSuspectSession: true,
      moveSuspectSessionDay: sessionDay,
      moveSuspectPrevClose: anchor,
      transition: 'held',
    };
  }

  return {
    moveSuspectSession: false,
    moveSuspectSessionDay: sessionDay,
    transition: 'discharged',
  };
}

// ── TRA-2634 — LEVEL CONTINUITY ACROSS TWO DATED ARTIFACTS ────────────────────
//
// `assessQuotePlausibility` above is a SESSION-MOVE test: it asks whether one
// row's own `price` and `changePct` are mutually believable. It cannot express
// the strongest evidence TRA-2610 was actually filed on — FGMC sitting at a
// FROZEN $8.30 on two consecutive days while `changePct` moved +69.04% ->
// +110.66%. A session-move ratio test cannot reach that at ANY threshold,
// because the whole point is that the PRICE DID NOT MOVE; only the denominator
// did. TRA-2634 measured the cost: the deployed r >= 2 rule catches the 07-29
// row (r = 2.1066) and passes the 07-28 one (r = 1.6904), so the guard misses
// day 1 of the exact fabrication it is named after.
//
// The invariant this expresses instead is an identity, not a heuristic:
//
//     YESTERDAY'S PUBLISHED CLOSE *IS* TODAY'S PREVIOUS CLOSE.
//
// So `impliedPrevClose(today)` must reproduce the close we ourselves published
// for the prior session. When it does not, the denominator today was re-derived
// against a reference that is not our own prior artifact.
//
// ⛔ CORRECTED 2026-08-06 (TRA-3068, off the TRA-3065 measurement). This
// paragraph used to end "— which is exactly what an unadjusted prev close across
// a corporate action looks like." THAT IS BACKWARDS, and it was the load-bearing
// sentence that made the sub-2.0 corporate-action gap look covered. The
// invariant below is SOUND; only the claimed coverage was wrong.
//
// Why the rule cannot see a corporate action: `impliedPrevClose(today)` INVERTS
// the same arithmetic `yahoo-feed.ts` used to BUILD the row, so what it recovers
// is THE FEED'S OWN `prevClose` — not an independent estimate of it. The
// residual therefore measures exactly one thing, and it is not plausibility:
//
//     residual != 1  <=>  the feed's prevClose today != the close WE published
//                         for the prior session
//
//  - UNADJUSTED prev close (the case the old sentence named — the FFAI
//    `6.49 / 0.07` shape): the feed's prevClose IS our published prior close, so
//    the residual is ALGEBRAICALLY FORCED to 1. Not near the tolerance, AT the
//    identity, for every action factor and every genuine ex-date move. Measured
//    over the 128-row evasion grid — `scripts/tra3065-corporate-action-evasion.mjs`,
//    which runs the DEPLOYED predicates rather than a re-implementation — max
//    residual 1.000142878 against a DERIVED 2-dp-rounding bound of 1.000214316,
//    i.e. 70x inside the 1.01 tolerance. The rule fired on 0 of 64 such rows.
//  - RETROACTIVELY ADJUSTED prev close: the published `changePct` is RIGHT and
//    nothing is fabricated — but our stored prior close is never back-adjusted,
//    so the residual is the action factor `k` and this rule fires on 64 of 64.
//    That is a FALSE POSITIVE on a correct row, not a defence.
//
// So the rule has no defensive value against a corporate action in EITHER feed
// branch, and no threshold change reaches the class. The corporate action is
// owned by the SPLIT CALENDAR ({@link CorporateAction}, read from the chart
// endpoint's `events` at the generation path) — NOT by this rule. When that
// calendar knows an ex-date landed in the pair, this rule ABSTAINS rather than
// firing: see `'corporate_action'` on {@link LevelContinuityAbstainReason}.
//
// What the rule DOES catch is the class all 11 of its real archive offenders
// belong to: the FGMC/FLYYQ FROZEN-PRICE shape — the numerator standing still
// while the denominator walks underneath it. That is a genuine re-derivation
// against a reference that is not our artifact, and no ratio test can express it
// at any threshold, which is the reason this instrument exists.
//
// MEASURED, 2026-07-30, over every adjacent-session pair in the stored archive
// on BOTH boxes (bqb1 2026-05-03 -> 07-30 all three folds, 223 pairs; the
// localhost archive, 37 pairs). The healthy population agrees with our own
// prior published close to 3-4 significant figures, and the offenders are an
// order of magnitude away — a genuinely bimodal separation:
//
//   healthy (59 pairs)   residual 1.000000 .. 1.005543   (worst: NVTS 06-04)
//   ---- empty band ----
//   offenders (11 pairs) residual 1.025008 .. 2.106599
//
// Six of those offenders are INVISIBLE to the deployed r >= 2 rule and were
// ranked anyway: TDIC 1.0250, 000660.KS 1.0369, ABTC 1.3021, FLYYQ 1.3334,
// VEEE 1.4483, CRNX 1.9874. FLYYQ (`$0.02` frozen, `+100.00%` -> `+33.34%`,
// r = 1.3334) is TRA-2634's second positive control and is caught here.
//
// ⛔ WHAT THIS DOES *NOT* RECOVER, stated because the ticket's own rule is to
// re-run its evidence row by row: FGMC's **07-28** row still passes. It is the
// symbol's FIRST appearance in the archive, so there is no prior observation to
// be continuous with, and the verdict is `abstain` — not `consistent`. A
// cross-artifact test is structurally blind to day 1 by construction. See the
// boundary note on TRA-2634 and the follow-up filed for the feed boundary,
// which holds the previous tick and can see a within-session denominator flip
// that this cannot.

/**
 * Residual at or above which the level break is treated as real.
 *
 * DERIVED from the published grid, not fitted to the tape — the measured band
 * above is empty from 1.0056 to 1.0250, so the archive cannot choose a number
 * inside it (the same situation `SUSPECT_MOVE_RATIO` faced on the 07-26 tape).
 * The two legitimate sources of divergence bound it:
 *
 *  - `changePct` ROUNDING. The Tradier path publishes 2 dp, so the half-grid is
 *    0.005 pct points and `d(impliedPrev)/impliedPrev = dpct / (100 + pct)`.
 *    That is 0.005% at a flat session, 0.01% at -50%, and 0.05% at -90%. A 1%
 *    tolerance covers every `changePct` above about -99.5% — and a row at
 *    -99.5% is already at r = 200, i.e. long since caught by the session-move
 *    rule.
 *  - PRICE rounding. The feed passes the provider's value through verbatim (the
 *    archive carries `0.0216`, `0.5412`, `0.9497`), so 4 significant figures is
 *    the floor: 0.005% relative. 1% leaves ~200x of headroom.
 *
 * Controls on both sides, from the measurement above: 1.8x above the worst
 * healthy pair (NVTS, 1.0056) and 2.5x below the tightest real offender (TDIC,
 * 1.0250). And 1% is far below the SMALLEST corporate action that produces the
 * artefact (a factor of 2 = 100%), so it cannot mask the class it exists to
 * catch.
 *
 * ⚠️ THE HEADROOM AGAINST *ONE* CONFOUND IS THIN AND MEASURED, NOT PROVEN. Our
 * published close is the last quote standing at 21:00 ET, not the official
 * close — FGMC's was 104 minutes stale. A prior row that was itself a stale
 * intraday quote will read as a continuity break here. NVTS at 1.0056 is most
 * likely exactly that (our $30.84 vs an implied $30.67). Zero of 59 healthy
 * pairs crossed 1.01, but `EodMover` does not persist `lastUpdated`, so that is
 * an empirical zero on a population whose staleness I could not read — not a
 * proof. It is why every fire is logged with its full arithmetic.
 */
export const CONTINUITY_RESIDUAL_TOLERANCE = 1.01;

/**
 * `|Δ changePct|` (in percentage points) at or below which two published rows
 * are treated as ONE observation re-served rather than two.
 *
 * This is the load-bearing exclusion, and it is why a tight residual threshold
 * is not a rubber stamp. 189 of 223 adjacent-session pairs on bqb1 are
 * REPUBLICATIONS — byte-identical `price` AND `changePct` under a different
 * `generatedAt`, i.e. a report generated for date D off a tape that never
 * advanced past D-1. Their residual is 1.22 .. 14.17 purely because a stale
 * table's `changePct` is compared to its own price, so grading them would fire
 * on 87% of everything and discriminate nothing. There is no second data point
 * in a republication, so there is nothing to be continuous WITH: `abstain`.
 * (Stale republication is a real defect — it is just a DIFFERENT one, and the
 * `lastUpdated > 0` freshness leg is what owns it.)
 *
 * ⛔ THE COMPARISON MUST BE A TOLERANCE, NOT EQUALITY. Measured: SNDK
 * `2184.75/11.5351` -> `2184.75/11.535121` and LEGN `27.93/-16.6766` ->
 * `27.93/-16.67661` are plainly the same observation re-serialised at a
 * different precision, and an exact `===` on `changePct` classes them as two
 * observations and fires (residual 1.1154 and 1.2001). 0.01 pct points is well
 * under the 2-dp publication grid and 4,000x under the smallest real offender's
 * 41.6-point move (FGMC).
 */
export const REPUBLICATION_CHANGE_PCT_EPSILON = 0.01;

/** Why a continuity verdict could not be reached. NEVER read one of these as clean. */
export type LevelContinuityAbstainReason =
  /** No prior-session observation of this symbol at all (its first appearance). */
  | 'no_prior_observation'
  /** The prior row's price is absent / non-finite / <= 0. */
  | 'prior_unusable'
  /** Today's numbers do not imply a usable prev close — the session-move rule owns this. */
  | 'current_unusable'
  /** Prior and current are the SAME observation re-served: no second data point. */
  | 'republished_prior_row'
  /**
   * TRA-3068 — a KNOWN corporate action ex-dated into this pair, so the residual
   * is UNINTERPRETABLE and no verdict is available from THIS instrument. The
   * session-move rule owns the row instead, via `'corporate_action'` on
   * {@link QuoteSuspectReason}.
   */
  | 'corporate_action';

export interface LevelContinuityVerdict {
  /**
   * Three-valued ON PURPOSE. `'abstain'` is not `'consistent'`: it says the
   * instrument was blind on this row. A caller that collapses the two has built
   * a gate that is satisfied by the absence of the thing it grades.
   */
  verdict: 'suspect' | 'consistent' | 'abstain';
  reason?: 'level_discontinuity' | LevelContinuityAbstainReason;
  /** `max(priorClose/impliedPrev, impliedPrev/priorClose)`. `null` unless computed. */
  residual: number | null;
  /** The prev close TODAY's published numbers imply. */
  impliedPrevClose: number | null;
  /** The close we ourselves published for the prior session. */
  priorClose: number | null;
  /**
   * The action that forced a `'corporate_action'` abstain. Present ONLY on that
   * reason.
   *
   * The abstain still carries `residual` whenever it is computable, and that is
   * not decoration: on a KNOWN ex-date the residual is the one live measurement
   * that separates the two feed branches TRA-3065 could not settle from the
   * archive — ~1 says the feed handed us an UNADJUSTED prev close, ~`k` says it
   * back-adjusted. Accumulating those is how the question gets answered from the
   * tape instead of from a two-year-old retrospective read.
   */
  corporateAction?: CorporateAction;
}

/**
 * Is today's published session move continuous with the close we published for
 * the prior session?
 *
 * `prior` must be the IMMEDIATELY PRECEDING trading session's row for the same
 * symbol. Adjacency is the caller's job — a gap of even one session makes the
 * comparison a multi-day move and the residual meaningless, so pass `null`
 * rather than the nearest row you happen to have and take the `abstain`.
 *
 * `action` (TRA-3068) is the OPTIONAL split-calendar leg: the entry
 * `corporateActionInSessionWindow` returned for `(priorSessionDate,
 * currentSessionDate]`, or nothing. Omitting it reproduces the pre-TRA-3068
 * behaviour EXACTLY — which is what keeps both TRA-3065 checkers and the TRA-2634
 * control set grading the same rule they were written against.
 */
export function assessLevelContinuity(
  prior: QuotePlausibilityInput | null | undefined,
  current: QuotePlausibilityInput,
  action?: CorporateAction | null,
): LevelContinuityVerdict {
  const blank = { residual: null, impliedPrevClose: null, priorClose: null };
  if (prior == null) return { verdict: 'abstain', reason: 'no_prior_observation', ...blank };

  const priorClose = prior.price;
  if (!Number.isFinite(priorClose) || priorClose <= 0) {
    return { verdict: 'abstain', reason: 'prior_unusable', ...blank };
  }

  // A republication carries no new information about the level. Compare the
  // PRICE exactly (it is the same stored number) and the PERCENTAGE within the
  // publication grid, because that is the field that gets re-serialised.
  const priorPct = prior.changePct;
  const curPct = current.changePct;
  if (
    current.price === priorClose &&
    typeof priorPct === 'number' && typeof curPct === 'number' &&
    Number.isFinite(priorPct) && Number.isFinite(curPct) &&
    Math.abs(curPct - priorPct) <= REPUBLICATION_CHANGE_PCT_EPSILON
  ) {
    return { verdict: 'abstain', reason: 'republished_prior_row', ...blank, priorClose };
  }

  const implied = impliedPrevClose(current);
  if (implied === null || !Number.isFinite(implied) || implied <= 0) {
    return { verdict: 'abstain', reason: 'current_unusable', ...blank, priorClose };
  }

  const residual = Math.max(priorClose / implied, implied / priorClose);
  if (!Number.isFinite(residual)) {
    return { verdict: 'abstain', reason: 'current_unusable', residual: null, impliedPrevClose: implied, priorClose };
  }

  // TRA-3068 — a KNOWN ex-date in this pair makes the residual UNINTERPRETABLE,
  // so this instrument abstains. `abstain`, NEVER `suspect`, and the distinction
  // is the whole point of the three-valued verdict: a blind instrument does not
  // get to look like a clean one, and it does not get to condemn a row either.
  //
  // ⛔ THE FIRE THIS SUPPRESSES IS A FALSE POSITIVE ON A CORRECT ROW, not a
  // catch. If the feed retroactively adjusts `prevClose` the published
  // `changePct` is RIGHT — but our stored prior close is never back-adjusted, so
  // the residual is the action factor `k` and the rule fires on 64 of 64 such
  // rows (TRA-3065). Suppressing it here is the only way the guard added by this
  // ticket does not INHERIT that misfire. In the other branch the rule was
  // already blind (residual forced to 1), so nothing real is lost either way:
  // both branches are ungradeable by THIS statistic, and the session-move rule
  // owns the row instead via `'corporate_action'`.
  //
  // Placed AFTER the republication guard on purpose. A stale republication's
  // residual is garbage by construction (1.22 .. 14.17 on bqb1) and would
  // contaminate the branch measurement this abstain's `residual` exists to feed.
  const known = corporateActionFactor(action) === null ? null : (action as CorporateAction);
  if (known) {
    return {
      verdict: 'abstain',
      reason: 'corporate_action',
      residual,
      impliedPrevClose: implied,
      priorClose,
      corporateAction: known,
    };
  }

  if (residual >= CONTINUITY_RESIDUAL_TOLERANCE) {
    return { verdict: 'suspect', reason: 'level_discontinuity', residual, impliedPrevClose: implied, priorClose };
  }
  return { verdict: 'consistent', residual, impliedPrevClose: implied, priorClose };
}

/**
 * One-line, log-ready explanation of a continuity verdict — the arithmetic, not
 * a label, so a false positive is auditable rather than asserted. Per TRA-2379
 * decision 2 a silent drop reads identically to nothing being wrong, and this
 * threshold's headroom against a stale prior snapshot is thin enough that a
 * reader needs the residual itself.
 */
export function describeLevelContinuity(
  symbol: string,
  priorDate: string,
  prior: QuotePlausibilityInput | null | undefined,
  current: QuotePlausibilityInput,
  action?: CorporateAction | null,
): string {
  const v = assessLevelContinuity(prior, current, action);
  const n = (x: number | null | undefined) =>
    x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : String(x);
  const head = `${symbol}: ${v.verdict}`
    + `${v.reason ? ` (${v.reason})` : ''}`
    + ` today=${n(current.price)}/${n(current.changePct)}%`
    + ` prior[${priorDate}]=${n(prior?.price)}/${n(prior?.changePct)}%`;
  if (v.residual === null) return head + describeCorporateAction(v.corporateAction);
  return `${head} impliedPrevClose=${v.impliedPrevClose === null ? 'n/a' : v.impliedPrevClose.toFixed(4)}`
    + ` publishedPriorClose=${v.priorClose === null ? 'n/a' : v.priorClose.toFixed(4)}`
    + ` residual=${v.residual.toFixed(6)} tolerance=${CONTINUITY_RESIDUAL_TOLERANCE}`
    + describeCorporateAction(v.corporateAction);
}

/**
 * TRA-3068 — the action's own arithmetic, appended to whichever verdict it
 * caused. Empty string when there is none, so it costs nothing on the common
 * path.
 *
 * `residualExpectedIfUnadjusted` / `IfAdjusted` are printed because they are the
 * discriminator: on a KNOWN ex-date, a residual landing at ~1 says the feed
 * handed us an UNADJUSTED prev close and the headline is fabricated, while ~`k`
 * says it back-adjusted and the headline is merely incomparable. TRA-3065 could
 * not settle that from the archive because the archive holds zero confirmed
 * corporate actions. Every line this prints is one row of the evidence that
 * settles it.
 */
export function describeCorporateAction(a: CorporateAction | null | undefined): string {
  const k = corporateActionFactor(a);
  if (k === null || a == null) return '';
  return ` corporateAction=${a.splitRatio ?? `${a.numerator}:${a.denominator}`}`
    + ` exDate=${a.exDate} factor=${k.toFixed(6)}`
    + ` residualExpectedIfUnadjusted=1 residualExpectedIfAdjusted=${Math.max(k, 1 / k).toFixed(6)}`;
}

/**
 * One-line, log-ready explanation. Used by the market-scanner exclusion log so a
 * dropped row is never silent — per TRA-2379 decision 2, "a silent drop reads
 * identically to nothing was wrong."
 */
export function describeQuoteSuspicion(
  symbol: string,
  q: QuotePlausibilityInput,
  action?: CorporateAction | null,
): string {
  const v = assessQuotePlausibility(q, action);
  if (!v.suspect) return `${symbol}: plausible`;
  const prev = v.impliedPrevClose === null ? 'n/a' : v.impliedPrevClose.toFixed(4);
  const ratio = v.ratio === null ? 'n/a' : v.ratio.toFixed(2);
  // TRA-3241 — print the boundary the row was actually tested against, so the
  // reader can re-derive the verdict from the line: the band edge for a
  // proximity fire, the anchor for a magnitude fire.
  const bar = v.reason === 'near_split_ratio' ? SUSPECT_MOVE_RATIO_FLOOR : SUSPECT_MOVE_RATIO;
  return `${symbol}: ${v.reason} (price=${q.price}, changePct=${q.changePct ?? 'n/a'}, `
    + `impliedPrevClose=${prev}, ratio=${ratio}, threshold=${bar})`
    + describeCorporateAction(v.corporateAction);
}
