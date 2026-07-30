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

/**
 * ## ⚠️ MEASURED 2026-07-30 07:48Z — THE ACCEPTANCE PREMISE IS REFUTED
 *
 * The live re-measure at `17f9eae` (pre-open, SPY spot 729.46, exp 2026-09-04,
 * `limit=50&minDelta=0`) turned the caveat above from theoretical into the
 * governing fact. SPY's tail is currently on the CHEAP side — 25 of 50 rows have
 * `mark < theo`, worst row `SPY260904C00807000` at mark 0.1100 vs theo 0.47701:
 *
 * | symbol | theo basis | **mark basis** | mid basis | max(m,t) basis |
 * |--------|-----------:|---------------:|----------:|---------------:|
 * | SPY    |  **94.1%** |   **333.6%**   |    125.0% |      **76.9%** |
 * | TSLA   |      30.5% |         28.6%  |     26.5% |          23.4% |
 * | NVDA   |      15.0% |         13.1%  |     14.0% |          13.1% |
 * | QQQ    |       5.8% |          5.5%  |      5.7% |           5.5% |
 * | AAPL   |      13.8% |         12.1%  |     12.9% |          12.1% |
 *
 * On this tape the mark basis is **3.5× WORSE** than the theo basis it replaced
 * (333.6% vs 94.1%), and it MISSES both acceptance bars (<100%, <75%). The
 * reason is not a bug in this module — every row is self-consistent and the
 * transform is doing exactly what TRA-2562 ordered. It is that the two bases are
 * exact DUALS, and neither bounds both tails:
 *
 *   `(mark − theo)/theo` — cheap (m<t): r ∈ (−1, 0) **BOUNDED**
 *                        — expensive (m>t): r ∈ (0, ∞) UNBOUNDED
 *   `(mark − theo)/mark` — cheap (m<t): r ∈ (−∞, 0) UNBOUNDED
 *                        — expensive (m>t): r ∈ (0, 1) **BOUNDED**
 *
 * TRA-2388/TRA-2354 measured a chain whose tail was EXPENSIVE (mark pinned at a
 * tick, theo → 0), so normalising by mark bounds precisely that tail. TRA-2562
 * therefore did not remove the >100% tail — it SWAPPED WHICH TAIL EXPLODES. Any
 * ratio of the two prices has an unbounded side; the only question is which one.
 *
 * `(mark − theo)/max(mark, theo)` takes the BOUNDED branch on both sides (it IS
 * the theo basis on cheap rows and the mark basis on expensive rows), so
 * `|r| < 1` identically, for every chain, with no floor required. It reads 76.9%
 * on the same SPY chain — the only one of the four that clears <100%.
 *
 * Choosing between them is QuantTrader's call on TRA-2562, not this module's, so
 * the DEFAULT REMAINS `mark` exactly as ordered. `?basis=` exists so the RTH
 * re-measure can grade all three in ONE pass instead of waiting on a deploy per
 * candidate — the alternative is three deploy cycles against a box that is
 * already rebooting several times a day.
 */

/** Classification band — structurally identical to the engine's `Mispricing`. */
export type MarkBasisClassification = 'expensive' | 'cheap' | 'fair';

/**
 * Denominators `/api/options/otm-mispricing?basis=` accepts.
 *
 *  - `mark` — `(mark − theo)/mark`. THE SHIPPED DEFAULT (TRA-2562). Bounded on
 *    the expensive side only.
 *  - `theo` — `(mark − theo)/theo`. The pre-TRA-2564 basis, kept reachable so a
 *    re-measure can quote both from one build rather than inferring the old
 *    number from an older deploy. Bounded on the cheap side only.
 *  - `max`  — `(mark − theo)/max(mark, theo)`. Bounded on BOTH sides, |r| < 1
 *    identically. Offered for measurement; NOT the default, because switching
 *    the panel's headline statistic is a TRA-2562 decision.
 */
export const OTM_MISPRICING_BASES = ['mark', 'theo', 'max'] as const;
export type MispricingBasis = (typeof OTM_MISPRICING_BASES)[number];

/** The basis the route applies when the caller sends no `?basis=`. */
export const OTM_DEFAULT_MISPRICING_BASIS: MispricingBasis = 'mark';

/** Narrow an untrusted query value, falling back to the shipped default. */
export function parseMispricingBasis(raw: unknown): MispricingBasis {
  return typeof raw === 'string' && (OTM_MISPRICING_BASES as readonly string[]).includes(raw)
    ? (raw as MispricingBasis)
    : OTM_DEFAULT_MISPRICING_BASIS;
}

/** The denominator for one row under `basis`. */
function denominatorFor(mark: number, theo: number, basis: MispricingBasis): number {
  switch (basis) {
    case 'mark':
      return mark;
    case 'theo':
      return theo;
    case 'max':
      return Math.max(mark, theo);
  }
}

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
   * Every input candidate, ratio re-based, re-classified against `threshold`,
   * and RE-SORTED by |mispricingPct| descending.
   */
  candidates: T[];
  /**
   * The basis actually APPLIED — echoed rather than assumed, so a caller that
   * sent a typo'd `?basis=` reads the fallback it really got instead of the one
   * it asked for. That distinction is the whole point of the key.
   */
  basis: MispricingBasis;
  /** The classification threshold applied (a ratio, 0.15 = 15%). */
  threshold: number;
  /**
   * Rows whose DENOMINATOR under the applied basis was non-finite or
   * non-positive, so no ratio exists. Neutralised to 0 / `fair` rather than left
   * carrying a stale number under a fresh label. Rendered, never swallowed.
   */
  unbasisable: number;
}

function classify(pct: number, threshold: number): MarkBasisClassification {
  if (pct > threshold) return 'expensive';
  if (pct < -threshold) return 'cheap';
  return 'fair';
}

/**
 * Re-base each candidate's `mispricingPct` onto `basis`'s denominator (the
 * engine always emits the theo basis), re-classify, and re-rank.
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
export function rebaseMispricing<T extends MarkBasisCandidate>(
  candidates: readonly T[],
  basis: MispricingBasis = OTM_DEFAULT_MISPRICING_BASIS,
  threshold: number = OTM_PANEL_MISPRICING_THRESHOLD,
): MarkBasisResult<T> {
  const effective =
    Number.isFinite(threshold) && threshold >= 0 ? threshold : OTM_PANEL_MISPRICING_THRESHOLD;

  let unbasisable = 0;
  const rebased = candidates.map((c) => {
    const denom = denominatorFor(c.mark, c.theo, basis);
    if (!Number.isFinite(denom) || denom <= 0 || !Number.isFinite(c.mark - c.theo)) {
      unbasisable += 1;
      return { ...c, mispricingPct: 0, classification: 'fair' as const };
    }
    const pct = (c.mark - c.theo) / denom;
    return { ...c, mispricingPct: pct, classification: classify(pct, effective) };
  });

  rebased.sort((a, b) => Math.abs(b.mispricingPct) - Math.abs(a.mispricingPct));

  return { candidates: rebased, basis, threshold: effective, unbasisable };
}

/**
 * `rebaseMispricing(candidates, 'mark', threshold)`.
 *
 * Retained because `mark` is the SHIPPED default and the overwhelming majority
 * of call sites want exactly it — spelling the basis at every one of them would
 * make the default look like a per-caller choice rather than the TRA-2562
 * decision it is.
 */
export function rebaseOnMark<T extends MarkBasisCandidate>(
  candidates: readonly T[],
  threshold: number = OTM_PANEL_MISPRICING_THRESHOLD,
): MarkBasisResult<T> {
  return rebaseMispricing(candidates, 'mark', threshold);
}
