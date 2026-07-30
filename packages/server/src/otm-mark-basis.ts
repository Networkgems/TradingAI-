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
 * `?basis=` exists so the re-measure could grade all three in ONE pass instead
 * of waiting on a deploy per candidate. It did, and it decided — see below.
 */

/**
 * ## ✅ DECIDED 2026-07-30 (TRA-2659, executed here as TRA-2661) — THE DEFAULT IS `max`
 *
 * QuantTrader graded all three bases over 15 live cells, each gated on
 * `http == 200 AND reason == "ok"` AND the `mispricingBasis` echo matching what
 * was asked for, and chose `max`. The default moved `mark` → `max`. `?basis=`
 * still reaches all three, and the echo still reports what was APPLIED.
 *
 * The reason `max` won is not that it is smaller. It is that it is not a NEW
 * statistic at all — it is the piecewise selection of whichever EXISTING basis
 * is bounded on that row's side:
 *
 *   `max(m,t) == t` when `m < t` (cheap)     ⇒ the `max` basis IS the theo basis
 *   `max(m,t) == m` when `m > t` (expensive) ⇒ the `max` basis IS the mark basis
 *
 * Verified live on 153 rows: cheap side 69 rows, `max |max − theo| = 0.000e+00`;
 * expensive side 84 rows, `max |max − mark| = 0.000e+00`.
 *
 * The consequence that decided it: the ENGINE emits the theo basis
 * (`otm-mispricing.ts:252`), so on the cheap side — the ONLY side the live
 * `single_leg_otm` sleeve gates on (`candidates.find(c => c.classification ===
 * 'cheap')`) — the panel's numbers become bit-identical to the engine's. The
 * `mark` default this replaces labelled 5 of 153 rows differently from the
 * engine, 4 of them `fair` → `cheap`. `max` labels 1 of 153 differently, and that
 * one is `expensive` → `fair`, a band the sleeve does not gate on.
 *
 * ## ⛔ THE PERCENTAGE ACCEPTANCE BAR IS RETIRED, NOT RE-TUNED
 *
 * Do NOT re-introduce "max |mispricingPct| < 100%" (or `< 75%`) as an acceptance
 * criterion on this module. Under `max`, `|(m−t)/max(m,t)| < 1` holds
 * ALGEBRAICALLY for every finite positive pair — so that predicate passes on
 * every chain forever, INCLUDING one whose `theo` is garbage. It reads identically
 * in the pass and the fail state: a statistic bounded by construction has no fail
 * state, which is the same defect as the unbounded tail with the sign flipped.
 * For the record `max` read 76.9% on the deciding chain, which MISSES the `< 75%`
 * bar TRA-2564 set — the bar was retired rather than tuned by 2pp to fit.
 *
 * `|r| < 1` survives below only as a TAUTOLOGY CHECK ON THE IMPLEMENTATION — if
 * it ever fails, this code is wrong, not the tape. It is not evidence about the
 * market and must never be published as a finding.
 *
 * What replaces it as the load-bearing property is CHEAP-SIDE ENGINE PARITY:
 * every row with `mark < theo` must carry exactly `(mark − theo)/theo`. That is
 * what makes the flip safe for the sleeve, and it is the thing that breaks if
 * someone later "improves" the formula. It is pinned in
 * `otm-mark-basis.wire.test.ts` against the REAL engine, in both directions.
 *
 * ## ⚠️ What this does NOT fix
 *
 * The `theo` surface itself is arbitrage-incoherent: 11 of 143 adjacent strike
 * pairs violate vertical-spread monotonicity, while `mark` violates 0 of 143. No
 * choice of DENOMINATOR repairs a corrupt NUMERATOR. Root cause is TRA-2662
 * (LeadDev). A green acceptance here means the headline is bounded and
 * engine-consistent — NOT that the OTM panel is correct.
 */

/** Classification band — structurally identical to the engine's `Mispricing`. */
export type MarkBasisClassification = 'expensive' | 'cheap' | 'fair';

/**
 * Denominators `/api/options/otm-mispricing?basis=` accepts.
 *
 *  - `max`  — `(mark − theo)/max(mark, theo)`. **THE DEFAULT (TRA-2659).** The
 *    piecewise selection of whichever of the other two is bounded on that row's
 *    side, so |r| < 1 identically AND the cheap side is bit-identical to what the
 *    engine emits.
 *  - `mark` — `(mark − theo)/mark`. The TRA-2562 default, superseded by TRA-2659
 *    but kept reachable. Bounded on the expensive side only.
 *  - `theo` — `(mark − theo)/theo`. The pre-TRA-2564 basis, and what the engine
 *    itself emits. Kept reachable so a re-measure can quote every basis from ONE
 *    build rather than inferring an old number from an older deploy. Bounded on
 *    the cheap side only.
 *
 * All three stay reachable on purpose: grading a basis change in one pass, off
 * one deploy, is what made TRA-2659 decidable against a box that reboots several
 * times a day.
 */
export const OTM_MISPRICING_BASES = ['mark', 'theo', 'max'] as const;
export type MispricingBasis = (typeof OTM_MISPRICING_BASES)[number];

/**
 * The basis the route applies when the caller sends no `?basis=`, and the
 * fallback an unrecognised `?basis=` degrades to.
 *
 * TRA-2659: `mark` → `max`. THE ONLY COPY — a second `as const` spelling of this
 * value used to sit further down this file and was deleted with the flip, because
 * a stale second copy of a default reads exactly like a live one.
 */
export const OTM_DEFAULT_MISPRICING_BASIS: MispricingBasis = 'max';

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
 * **The re-sort is load-bearing, not cosmetic**, and it stays load-bearing under
 * every basis including the TRA-2659 default. Writing `r` for the theo-basis
 * ratio the engine hands us, the mark basis is `r / (1 + r)`, strictly increasing
 * in `r` — so order is preserved WITHIN each sign but NOT across signs, which is
 * what the panel actually ranks on (`|mispricingPct|` descending). A row at
 * `r = +2.0` re-bases to +0.667 while one at `r = −0.5` re-bases to −1.00: the
 * old ranking puts the expensive row first, the new one puts the cheap row first.
 *
 * `max` does not escape this — it COMPRESSES the expensive side (to `r/(1+r)`)
 * and leaves the cheap side at `r`, so it too re-orders across signs, just less
 * violently. Re-basing without re-sorting would emit new numbers in the old order
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

/*
 * TRA-2659 — `rebaseOnMark(candidates, threshold)`, the
 * `rebaseMispricing(candidates, 'mark', threshold)` convenience wrapper, was
 * DELETED here.
 *
 * It was justified as "`mark` is the shipped default and the overwhelming
 * majority of call sites want exactly it". Both halves are now false: `mark` is
 * not the default, and it had ZERO non-test call sites even while it was. What it
 * actually left behind was a second, hardcoded spelling of the default under a
 * name that reads like the standard entry point — so a caller reaching for it
 * after the flip would silently have got the SUPERSEDED basis while the route got
 * the new one. Call `rebaseMispricing` and spell the basis, or omit it to take
 * {@link OTM_DEFAULT_MISPRICING_BASIS}.
 */
