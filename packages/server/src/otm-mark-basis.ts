/**
 * TRA-2564 (TRA-2562 decision) — re-base the OTM panel's mispricing ratio on
 * `mark` instead of `theo`.
 *
 * ## The defect this closes
 *
 * `findMispricedOtmContracts` reports `mispricingPct = (mark − theo) / theo`
 * (`otm-mispricing.ts:252`). TRA-2341 floored the denominator at one tick and
 * TRA-2388 floored |delta| at 0.02; the RTH re-measure on TRA-2562 showed
 * neither closes it. The residual is not a `theo → 0` artifact at all — it is
 * the VOL SMILE. Far OTM the market pays a skew premium the flat-σ
 * Black-Scholes theo does not carry, so `mark / theo` stays large with a
 * perfectly healthy theo, and no floor on either axis can bound a ratio whose
 * denominator is the small side of a structural disagreement.
 *
 * Normalising by `mark` inverts which side of that disagreement is the unit:
 * the reported number becomes "what fraction of the price I would pay is
 * premium over model", which is the quantity a desk can actually act on, and on
 * the EXPENSIVE side it is bounded by construction — see the caveat below.
 *
 * ## Why this is a route-layer transform and `packages/engine/` is untouched
 *
 * The ticket names `otm-delta-floor.ts` as "the compute site". It is not one —
 * it is a panel-only filter. The only compute site is the ENGINE, and the
 * engine is shared: the live `single_leg_otm` sleeve reaches
 * `findMispricedOtmContracts` in-process via `signal-engine.ts:7517` and gates
 * its entry on `candidates.find(c => c.classification === 'cheap')`.
 * `classification` is derived from `mispricingPct`, so changing the engine
 * formula is a LIVE TRADING-LOGIC change, not a panel change.
 *
 * It is a change in a specific, measurable direction. Write `x = mark / theo`;
 * then the theo-basis ratio is `x − 1` and the mark-basis ratio is `1 − 1/x`.
 * On the cheap side (`x < 1`) the mark basis is STRICTLY LARGER IN MAGNITUDE:
 * `1/x − 1 > 1 − x` for all `x ∈ (0, 1)`. At the shipped 0.15 threshold the
 * `cheap` admission band therefore widens from `mark < 0.8500·theo` to
 * `mark < 0.8696·theo` — a ~2.3% relative loosening of a live entry gate,
 * against a sleeve whose engine count is no longer zero. That is a sleeve-owner
 * / board decision (TRA-1897 posture), not an implementation detail of a
 * read-only panel, and nothing in TRA-2562 asked for it.
 *
 * So this follows the containment precedent both prior floors set (TRA-2341
 * `otm-theo-floor.ts`, TRA-2388 `otm-delta-floor.ts`): the transform runs on the
 * candidates the route already has in hand. `packages/engine/` is byte-unchanged
 * and the sleeve is provably unreachable from here — it never calls this route.
 * Every acceptance criterion on TRA-2564 is a property of the HTTP response, so
 * the panel-scoped fix satisfies all of them.
 *
 * ## ⚠️ "bounded by construction" is only half true
 *
 * TRA-2564's acceptance says the mark basis is bounded by construction. It is
 * bounded on ONE side only:
 *
 *   • EXPENSIVE (`mark > theo`): `(mark − theo)/mark → +1` as `theo → 0`. Hard
 *     ceiling of **+100%**, and unreachable in practice. This is the side every
 *     observed artifact sat on (SPY's +74215.7% / +1510.9% reads), so the
 *     acceptance threshold does hold — but it holds because of WHICH SIDE the
 *     artifact is on, not because the statistic is two-sided bounded.
 *   • CHEAP (`mark < theo`): `(mark − theo)/mark = 1 − theo/mark` is UNBOUNDED
 *     below. A row at mark 0.05 against theo 0.50 reads −900%.
 *
 * Do not carry "bounded by construction" forward as a general property. A
 * future grader that asserts `|mispricingPct| < 1` on an arbitrary chain will
 * fail on a legitimately cheap row, and that failure would be the instrument
 * breaking, not the panel.
 *
 * ## Never silent
 *
 * Same contract as both floors. A row whose `mark` cannot serve as a
 * denominator cannot be re-based, and emitting its untouched theo-basis number
 * under a `mispricingBasis: 'mark'` label would make a broken row read exactly
 * like a working one. Those rows are neutralised (ratio 0, `fair`, so they sink
 * to the bottom of the ranking and can never be presented as a mispricing read)
 * and COUNTED, and the route renders the count.
 */

/** Classification band — structurally identical to the engine's `Mispricing`. */
export type MarkBasisClassification = 'expensive' | 'cheap' | 'fair';

/**
 * Threshold above which |mispricingPct| is labelled cheap/expensive when the
 * caller sends no `?minMispricing=`.
 *
 * MIRRORS `DEFAULTS.mispricingThresholdPct` in
 * `packages/engine/src/options/otm-mispricing.ts`, which is not exported. The
 * duplication is pinned by a test that drives the real engine across the
 * boundary — if the engine default moves and this does not, that test fails
 * rather than the panel silently classifying on a different cutoff than the
 * one its own UI advertises.
 */
export const OTM_PANEL_MISPRICING_THRESHOLD = 0.15;

/** The basis this module normalises on. Echoed on the wire as `mispricingBasis`. */
export const OTM_MISPRICING_BASIS = 'mark' as const;

/** The subset of `OtmMispricingCandidate` this transform reads and rewrites. */
export interface MarkBasisCandidate {
  mark: number;
  theo: number;
  mispricingPct: number;
  classification: MarkBasisClassification;
}

export interface MarkBasisResult<T extends MarkBasisCandidate> {
  /**
   * Every input candidate, ratio re-based on `mark`, re-classified against
   * `threshold`, and RE-SORTED by |mispricingPct| descending.
   */
  candidates: T[];
  /** The basis actually applied — a constant, but echoed so the wire self-describes. */
  basis: typeof OTM_MISPRICING_BASIS;
  /** The classification threshold applied (a ratio, 0.15 = 15%). */
  threshold: number;
  /**
   * Rows whose `mark` was non-finite or non-positive, so no mark-basis ratio
   * exists. Neutralised to 0 / `fair` rather than left carrying a theo-basis
   * number under a mark-basis label. Rendered, never swallowed.
   */
  unbasisable: number;
}

function classify(pct: number, threshold: number): MarkBasisClassification {
  if (pct > threshold) return 'expensive';
  if (pct < -threshold) return 'cheap';
  return 'fair';
}

/**
 * Re-base each candidate's `mispricingPct` from `(mark − theo)/theo` to
 * `(mark − theo)/mark`, re-classify, and re-rank.
 *
 * **The re-sort is load-bearing, not cosmetic.** Writing `r` for the theo-basis
 * ratio, the mark basis is `r / (1 + r)`, which is strictly increasing in `r` —
 * so the order is preserved WITHIN each sign, but NOT across signs, which is
 * what the panel actually ranks on (`|mispricingPct|` descending). A row at
 * `r = +2.0` re-bases to +0.667 while one at `r = −0.5` re-bases to −1.00: the
 * old ranking puts the expensive row first, the new one puts the cheap row
 * first. Re-basing without re-sorting would emit new numbers in the old order
 * and the top-N slice would drop the wrong rows — a defect invisible in any
 * single row's value, which is why the caller must slice only after this runs.
 *
 * A non-finite or non-positive `threshold` falls back to the panel default; a
 * garbage query string degrades to the shipped cutoff rather than labelling
 * every row `expensive`. (Note the deliberate asymmetry with the two floors,
 * where a NaN floor DISABLES the guard: there is no "disable" state for a
 * classification cutoff — every row must land in exactly one band.)
 *
 * Pure: inputs are not mutated, shallow copies are returned.
 */
export function rebaseOnMark<T extends MarkBasisCandidate>(
  candidates: readonly T[],
  threshold: number = OTM_PANEL_MISPRICING_THRESHOLD,
): MarkBasisResult<T> {
  const effective =
    Number.isFinite(threshold) && threshold >= 0 ? threshold : OTM_PANEL_MISPRICING_THRESHOLD;

  let unbasisable = 0;
  const rebased = candidates.map((c) => {
    if (!Number.isFinite(c.mark) || c.mark <= 0 || !Number.isFinite(c.theo)) {
      unbasisable += 1;
      return { ...c, mispricingPct: 0, classification: 'fair' as const };
    }
    const pct = (c.mark - c.theo) / c.mark;
    return { ...c, mispricingPct: pct, classification: classify(pct, effective) };
  });

  rebased.sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct));

  return {
    candidates: rebased,
    basis: OTM_MISPRICING_BASIS,
    threshold: effective,
    unbasisable,
  };
}
