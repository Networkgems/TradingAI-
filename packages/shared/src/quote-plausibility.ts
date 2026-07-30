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
 */
export function isMoveSuspect(row: QuoteMoveRow): boolean {
  if (row.moveSuspect === true) return true;
  return assessQuotePlausibility({
    price: row.price ?? NaN,
    change: row.change,
    changePct: row.changePct,
  }).suspect;
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
// against a reference that is not our own prior artifact — which is exactly
// what an unadjusted prev close across a corporate action looks like.
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
  | 'republished_prior_row';

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
}

/**
 * Is today's published session move continuous with the close we published for
 * the prior session?
 *
 * `prior` must be the IMMEDIATELY PRECEDING trading session's row for the same
 * symbol. Adjacency is the caller's job — a gap of even one session makes the
 * comparison a multi-day move and the residual meaningless, so pass `null`
 * rather than the nearest row you happen to have and take the `abstain`.
 */
export function assessLevelContinuity(
  prior: QuotePlausibilityInput | null | undefined,
  current: QuotePlausibilityInput,
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
): string {
  const v = assessLevelContinuity(prior, current);
  const n = (x: number | null | undefined) =>
    x === null || x === undefined || !Number.isFinite(x) ? 'n/a' : String(x);
  const head = `${symbol}: ${v.verdict}`
    + `${v.reason ? ` (${v.reason})` : ''}`
    + ` today=${n(current.price)}/${n(current.changePct)}%`
    + ` prior[${priorDate}]=${n(prior?.price)}/${n(prior?.changePct)}%`;
  if (v.residual === null) return head;
  return `${head} impliedPrevClose=${v.impliedPrevClose === null ? 'n/a' : v.impliedPrevClose.toFixed(4)}`
    + ` publishedPriorClose=${v.priorClose === null ? 'n/a' : v.priorClose.toFixed(4)}`
    + ` residual=${v.residual.toFixed(6)} tolerance=${CONTINUITY_RESIDUAL_TOLERANCE}`;
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
