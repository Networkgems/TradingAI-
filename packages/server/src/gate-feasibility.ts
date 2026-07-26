// TRA-2335 (parent TRA-2332) — the FEASIBILITY PRECONDITION for R-denominated gate bars.
//
// ── The defect this exists to make impossible ────────────────────────────────
//
// R is denominated in MAX LOSS everywhere in this program (`pnlR = pnl ÷ maxLossUsd`,
// `options-forward-test.ts`; `lossR ≡ 1`, `option-modeled-gross-r.ts`). That pins the
// per-trade outcome set of any defined-risk structure: the downside is exactly −1R and
// the upside is exactly `maxProfitUsd ÷ maxLossUsd`. Write that ratio `rewardR`. Then
//
//     realized pnlR_i ≤ rewardR_i     — PATHWISE, trade by trade
//     ⇒ mean(pnlR) ≤ mean(rewardR)    — an ACCOUNTING IDENTITY, not an expectation
//
// This needs no probability model at all: it is not `sup over p` of anything, it is the
// per-trade maximum averaged. (The `E[R] = p·rewardR − (1 − p)` route reaches the same
// number via `p = 1`, but only under a model; the pathwise bound is the stronger footing
// and it survives early management — closing a winner early only LOWERS the left side.)
//
// A bar above that ceiling therefore cannot be cleared at ANY hit rate, including 100%.
// The live instance (TRA-2332): a credit-vertical book at pooled credit/width k = 0.0366
// has `rewardR = k ÷ (1 − k) = +0.0380R` gross and ≈ 0.000R cost-net, graded against a
// `minExpectancyR` of +0.20R — a bar 5.3× the arithmetic maximum of the instrument. It
// ran for four weeks emitting `FAIL`, and a `FAIL` reads as "the book underperformed".
//
// ── Why a third verdict state and not a smaller number ───────────────────────
//
// `FAIL` asserts a fact about the BOOK. `INFEASIBLE` asserts a fact about the
// EXPERIMENT: this bar cannot be tested with this instrument, so no amount of sample
// can settle it. Collapsing the two is precisely what let the defect run — and it is
// why `INFEASIBLE` must never read as "pending" and must never be satisfiable by
// accruing more trades. It is a LOUDER stop than `FAIL`, not a softer one.
//
// ── The one-sided-bound discipline (read before changing `ceilingGrossR`) ────
//
// Two doors fabricate `rewardR` and BOTH inflate it, i.e. both fail toward a false
// "feasible" — the exact direction that hides the defect this module detects:
//
//   1. `options-ideas-feed.ts` fallback pricing — when the legs cannot be priced it sets
//      `maxProfitUsd = maxLossUsd` ⇒ `rewardR ≡ 1.000` (26× a real vertical's 0.0380).
//      These are stamped `priced: false` and the forward test already excludes them
//      (`excludeReason: 'fallback_priced'`), so the graded-set filter keeps them out —
//      but ONLY if the ceiling is averaged over the SAME population the expectancy is.
//      That is why this module never re-derives a filter; the caller passes the already
//      -filtered array in. Two filters that must agree is a defect with a delivery date.
//   2. `long_call` / `long_put` sketch caps — a long call's upside is genuinely unbounded,
//      so the feed stamps `maxProfitUsd = debit·100·2` ⇒ `rewardR ≡ 2.000` with
//      `priced: TRUE`. These sail past the `!excluded` filter. They do not bite the
//      current book (100% credit verticals) but the day a directional single lands in
//      the graded set the ceiling drifts toward 2.0 and the check fails open.
//
// The resolution is an ASYMMETRY, not a discard. `ceilingGrossR` is computed over the
// whole graded set using each outcome's STATED reward — sketch caps included at their
// inflated value — which makes it an UPPER BOUND on the true book ceiling. Therefore:
//
//   • `barR ≥ ceilingNetR`  ⇒ INFEASIBLE is SOUND. The true ceiling is ≤ this one, so a
//     bar above the optimistic ceiling is above the real one too. Never a false alarm.
//   • `barR < ceilingNetR`  ⇒ "feasible" is only PROVISIONAL when any reward was
//     fabricated. We report it as `unknown`, never as a clean pass, and the per-source
//     count histogram travels with it.
//
// Hence {@link RewardProvenance} and the histogram are not decoration: a bare ceiling
// reads IDENTICALLY whether it came from real prices or from a 2.0 sketch cap, and that
// indistinguishability is the property that let a 5.3×-unreachable bar run for a month.
// The instrument must separate those two states, not average them.
//
// Pure — no I/O, no env, no clock. Leaf module by construction: `live-capital-gate.ts`
// (book-level, cost-NET) and `option-cost-gate.ts` (per-open, cost-INCLUSIVE bar) both
// need it, and `options-forward-test.ts` already had to route around one import cycle.

/** Where an outcome's `rewardR` came from — the histogram key. */
export type RewardProvenance =
  /** `maxProfitUsd` derived from real priced legs (verticals, condors). Trustworthy. */
  | 'priced_structure'
  /** A feed sketch cap (`long_call`/`long_put`, 2×-debit). Inflates the ceiling. */
  | 'sketch_capped'
  /** No usable denominator (non-finite / non-positive max-loss). Contributes nothing. */
  | 'unusable';

/**
 * Strategies whose `maxProfitUsd` is a SKETCH, not a priced structure.
 *
 * `long_call` / `long_put`: `options-ideas-feed.ts` caps upside at 2× debit (a call's is
 * genuinely unbounded) and stamps `priced: true`, so the forward test's `!excluded`
 * filter does NOT drop them.
 *
 * `call_calendar` / `put_calendar`: the scanners surface single-expiration candidates, so
 * the feed falls back to a ~1:1 sketch. Those are stamped `priced: false` and are already
 * excluded upstream — listed here so the classification is complete rather than relying
 * on a second module's filter to cover them.
 */
const SKETCH_CAPPED_STRATEGIES: ReadonlySet<string> = new Set([
  'long_call',
  'long_put',
  'call_calendar',
  'put_calendar',
]);

/** Classify one outcome's reward provenance. Pure. */
export function classifyRewardProvenance(strategy: string, maxProfitUsd: number, maxLossUsd: number): RewardProvenance {
  if (!Number.isFinite(maxProfitUsd) || !Number.isFinite(maxLossUsd) || maxLossUsd <= 0) return 'unusable';
  return SKETCH_CAPPED_STRATEGIES.has(strategy) ? 'sketch_capped' : 'priced_structure';
}

/** The minimum an outcome must carry for its reward ceiling to be derivable. */
export interface CeilingInput {
  strategy: string;
  maxProfitUsd: number;
  maxLossUsd: number;
}

/** Per-provenance counts — ships next to every ceiling so the premise stays visible. */
export interface RewardSourceCounts {
  priced_structure: number;
  sketch_capped: number;
  unusable: number;
}

/** The payoff ceiling of a graded book. */
export interface BookCeiling {
  /**
   * `mean(rewardR)` over the graded set using each outcome's STATED reward — sketch caps
   * included at their inflated value. An UPPER BOUND on the true ceiling, which is what
   * makes an `INFEASIBLE` verdict derived from it sound. Null when nothing is usable.
   */
  ceilingGrossR: number | null;
  /**
   * `mean(rewardR)` over the `priced_structure` subset only — the honest ceiling, with no
   * fabricated rewards in it. Reported for audit; NOT what the verdict is derived from
   * (that would make `INFEASIBLE` unsound whenever a sketch cap is present).
   */
  ceilingGrossRPriced: number | null;
  /** Outcomes contributing to {@link ceilingGrossR} (priced + sketch-capped). */
  n: number;
  /** The count histogram. A bare ceiling cannot distinguish real prices from 2.0 caps. */
  sourceCounts: RewardSourceCounts;
}

const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * Compute a book's payoff ceiling from the ALREADY-FILTERED graded set.
 *
 * ⚠️ The caller MUST pass the identical array the expectancy is averaged over
 * (`status === 'resolved' && !o.excluded`). Do NOT re-derive a population here — a
 * ceiling from one population compared against a measurement from another is not a
 * comparison, and the looser `maxLossUsd > 0` predicate in particular re-admits the
 * fabricated `rewardR ≡ 1.000` fallback-priced entries this check exists to keep out.
 * That failure is silent and fails OPEN: the check built to catch the defect would
 * report that there is nothing to catch.
 */
export function computeBookCeiling(graded: readonly CeilingInput[]): BookCeiling {
  const counts: RewardSourceCounts = { priced_structure: 0, sketch_capped: 0, unusable: 0 };
  const all: number[] = [];
  const priced: number[] = [];
  for (const o of graded) {
    const provenance = classifyRewardProvenance(o.strategy, o.maxProfitUsd, o.maxLossUsd);
    counts[provenance] += 1;
    if (provenance === 'unusable') continue;
    const rewardR = o.maxProfitUsd / o.maxLossUsd;
    all.push(rewardR);
    if (provenance === 'priced_structure') priced.push(rewardR);
  }
  const mean = (xs: number[]): number | null =>
    xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  return {
    ceilingGrossR: mean(all),
    ceilingGrossRPriced: mean(priced),
    n: all.length,
    sourceCounts: counts,
  };
}

// ── TRA-2353 · the SLEEVE decomposition ─────────────────────────────────────
//
// `computeBookCeiling` returns ONE number for the whole graded book. That bound is
// mathematically correct on any mix — the pathwise identity `mean(pnlR) ≤ mean(rewardR)`
// needs no homogeneity assumption — but on a MIXED book it averages an infeasible sleeve
// into a `feasible` verdict. Measured live on bqb1 (build `7161d2be3f2b`, 2026-07-26):
//
//   graded book     n=47  ceiling gross 0.2882 → net 0.2391   `feasible` vs the 0.20R bar
//   credit sleeve   n=35  ceiling ≈0.04 gross / ≈0.00 net     flatly INFEASIBLE
//   debit sleeve    n=12  rewardR ≈ 1.012                     carries the whole verdict
//
// 74% of the graded book was being measured against a bar it provably cannot reach, and
// the instrument built to detect exactly that reported `feasible`. The credit read needs
// no model: `bull_put_spread` resolved n=31 at a hit rate of 1.00 for +0.04R gross and
// 0.00R net — every trade a winner and the sleeve returns zero. It has ATTAINED its
// ceiling.
//
// ⚠️ THE PARTITION IS SOUND FOR THE SAME REASON THE BOOK IS. The pathwise bound restricts
// to any subset: `mean_S(pnlR) ≤ mean_S(rewardR)` for every sleeve S, because it is an
// inequality on each individual trade. A per-sleeve `infeasible` is therefore exactly as
// sound as the book-level one — it is not a weaker heuristic read.
//
// ⚠️ TRA-2361 SUPERSEDES TRA-2353 ON WHETHER A SLEEVE BLOCKS. This block used to read
// "the sleeve verdict is NOT the blocking one" — TRA-2353 deliberately shipped it as pure
// reporting and reserved the policy call for QuantTrader. QuantTrader has since ruled, and
// PRE-REGISTERED the rule before the first per-sleeve read: see {@link BLOCKING_SLEEVE_WEIGHT}
// for R1 verbatim. A `blocking` sleeve now makes `positive_expectancy` INFEASIBLE.
//
// ⚠️ The safety argument is MONOTONICITY, and it is a claim about the relation between two
// builds, so no green suite on this one can see it: adding a conjunct to a conjunction is
// monotone non-increasing, therefore `passed′ ≤ passed` pointwise and this can only ever
// CLOSE a capital path, never open one. Proven differentially against the pre-fix build by
// `scripts/tra2361-monotonicity-matrix.mjs`, not by reading this paragraph.

/** One graded outcome as the sleeve partition reads it: ceiling inputs + its cost drag. */
export interface SleeveCeilingInput extends CeilingInput {
  /**
   * `cost ÷ maxLossUsd` for this outcome; null when it could not be priced. The SAME
   * per-row field the book's `avgCostR` averages, so a sleeve's netting is the book's
   * netting restricted to the sleeve rather than a differently-scoped approximation.
   */
  costEfficiencyRatio: number | null;
}

/** One partition's ceiling — `computeBookCeiling` over a subset, plus its weight. */
export interface SleeveCeiling {
  key: string;
  /**
   * ALL partition members, including `unusable` ones. This is the sleeve's WEIGHT in the
   * book — deliberately not `nUsable`, because a sleeve whose rewards are underivable
   * still occupies its share of the population the book verdict is averaged over.
   */
  n: number;
  /** Of `n`, those contributing to {@link ceilingGrossR} (priced + sketch-capped). */
  nUsable: number;
  /** `n ÷ bookN`, 0–1 at 4dp. Null only when the book is empty. */
  weight: number | null;
  /** `mean(rewardR)` over the sleeve, sketch caps included at their inflated value. */
  ceilingGrossR: number | null;
  /** The same over the `priced_structure` subset only — no fabricated rewards. */
  ceilingGrossRPriced: number | null;
  /** `mean(costEfficiencyRatio)` over the sleeve's priced rows. */
  avgCostR: number | null;
  /** `ceilingGrossR − avgCostR` — what a cost-NET bar must sit below for this sleeve. */
  ceilingNetR: number | null;
  sourceCounts: RewardSourceCounts;
}

/**
 * AC3 — the book ceiling recomputed with one whole sleeve removed.
 *
 * The live margin is `0.039R` resting on 12 of 47 ideas: `ceilingGrossR ≤ 0.2491` flips
 * the book to INFEASIBLE. So the verdict can change **on composition alone, with no code
 * change** — if TRA-1965's cut fork removes the credit sleeve, or if the debit sleeve
 * simply stops resolving. A single book-level boolean cannot express that; this can.
 */
export interface LeaveOneOutCeiling {
  excludedKey: string;
  /** Rows removed. */
  excludedN: number;
  /** Rows remaining (the population the recomputed ceiling is averaged over). */
  remainingN: number;
  ceilingGrossR: number | null;
  avgCostR: number | null;
  ceilingNetR: number | null;
  sourceCounts: RewardSourceCounts;
}

/** A whole partition of the graded book along one key, with its leave-one-out sweep. */
export interface CeilingAxis {
  /** What the key MEANS — e.g. `strategy`, `premium_direction`. Part of the number. */
  axis: string;
  /** The graded book size this partition covers. `sum(sleeves.n) === bookN` by construction. */
  bookN: number;
  /** Sleeves ordered by weight DESCENDING (ties alphabetical) — the offender reads first. */
  sleeves: SleeveCeiling[];
  /** One entry per sleeve. Empty when there is 0 or 1 sleeve (nothing to remove). */
  leaveOneOut: LeaveOneOutCeiling[];
  /** The sleeve carrying the most rows — AC3 names it explicitly. Null on an empty book. */
  largestSleeveKey: string | null;
}

const meanOrNull = (xs: readonly number[]): number | null =>
  xs.length ? round4(xs.reduce((a, b) => a + b, 0) / xs.length) : null;

/**
 * The book's own netting rule, factored out so a sleeve, the whole book and a
 * leave-one-out complement can never be computed three slightly different ways.
 * `avgCostR` is the mean over rows that HAVE a cost ratio; unpriced rows drop out
 * exactly as they do at book level.
 */
function nettedCeiling(rows: readonly SleeveCeilingInput[]): {
  ceiling: BookCeiling;
  avgCostR: number | null;
  ceilingNetR: number | null;
} {
  const ceiling = computeBookCeiling(rows);
  const avgCostR = meanOrNull(
    rows.map((o) => o.costEfficiencyRatio).filter((x): x is number => x != null),
  );
  const ceilingNetR =
    ceiling.ceilingGrossR == null ? null : round4(ceiling.ceilingGrossR - (avgCostR ?? 0));
  return { ceiling, avgCostR, ceilingNetR };
}

/**
 * Partition an ALREADY-FILTERED graded set and compute each sleeve's ceiling (AC1).
 *
 * ⚠️ This is a PARTITION OF THE CALLER'S ARRAY, never a second filter — the same §2 rule
 * that governs `computeBookCeiling`, applied one level down. Re-deriving the graded
 * population here would re-admit the fabricated `rewardR ≡ 1.000` fallback-priced rows,
 * and it would do it silently and in the fail-open direction. Because every sleeve is a
 * subset of the array the book ceiling is averaged over, `sum(sleeve.n) === bookN` holds
 * by construction and is asserted in the tests.
 */
export function computeCeilingAxis<T extends SleeveCeilingInput>(
  graded: readonly T[],
  axis: string,
  keyFn: (o: T) => string,
): CeilingAxis {
  const groups = new Map<string, T[]>();
  for (const o of graded) {
    const k = keyFn(o);
    const arr = groups.get(k) ?? [];
    arr.push(o);
    groups.set(k, arr);
  }
  const bookN = graded.length;
  const sleeves: SleeveCeiling[] = [...groups.entries()]
    .map(([key, rows]) => {
      const { ceiling, avgCostR, ceilingNetR } = nettedCeiling(rows);
      return {
        key,
        n: rows.length,
        nUsable: ceiling.n,
        weight: bookN > 0 ? round4(rows.length / bookN) : null,
        ceilingGrossR: ceiling.ceilingGrossR,
        ceilingGrossRPriced: ceiling.ceilingGrossRPriced,
        avgCostR,
        ceilingNetR,
        sourceCounts: ceiling.sourceCounts,
      };
    })
    .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key));

  // Removing the only sleeve leaves an empty book, whose "ceiling" is null — a
  // vacuous `unknown`, not a fragility signal. Emit nothing rather than noise.
  const leaveOneOut: LeaveOneOutCeiling[] =
    groups.size < 2
      ? []
      : sleeves.map((s) => {
          const rest = graded.filter((o) => keyFn(o) !== s.key);
          const { ceiling, avgCostR, ceilingNetR } = nettedCeiling(rest);
          return {
            excludedKey: s.key,
            excludedN: s.n,
            remainingN: rest.length,
            ceilingGrossR: ceiling.ceilingGrossR,
            avgCostR,
            ceilingNetR,
            sourceCounts: ceiling.sourceCounts,
          };
        });

  return { axis, bookN, sleeves, leaveOneOut, largestSleeveKey: sleeves[0]?.key ?? null };
}

/** An axis with nothing in it — the degraded read for a legacy/partial report. */
export function emptyCeilingAxis(axis: string): CeilingAxis {
  return { axis, bookN: 0, sleeves: [], leaveOneOut: [], largestSleeveKey: null };
}

/** The three states a bar can be in against its instrument's ceiling. */
export type FeasibilityVerdict =
  /** The bar is strictly below the ceiling — the comparison carries information. */
  | 'feasible'
  /** The bar is at or above the ceiling — unreachable at any hit rate, sample size irrelevant. */
  | 'infeasible'
  /** The ceiling could not be established (no usable rewards, or every reward fabricated). */
  | 'unknown';

export interface FeasibilityResult {
  verdict: FeasibilityVerdict;
  /** The bar being graded against. */
  barR: number;
  /** The ceiling the bar was compared to (cost-adjusted where the gate grades cost-net). */
  ceilingR: number | null;
  /** True only for `feasible`; `unknown` and `infeasible` are both NOT feasible. */
  feasible: boolean;
  /** Human-readable, always naming BOTH the bar and the ceiling (AC2). */
  reason: string;
}

const fmt = (v: number): string => (Math.abs(v) < 0.01 && v !== 0 ? v.toFixed(4) : v.toFixed(3));

/**
 * The core comparison. `ceilingR` must ALREADY be on the same side of the cost as the
 * bar — the two gates differ here and getting it wrong double-counts cost:
 *
 *  • `live-capital-gate` grades `expectancyNetR` (cost-NET) against a cost-FREE bar
 *    ⇒ pass `ceilingR = ceilingGrossR − avgCostR`.
 *  • `option-cost-gate` grades modeled GROSS R against a cost-INCLUSIVE bar
 *    (`admissionBarR` = `max(costModel + safetyMargin, optionsMinGrossR)`)
 *    ⇒ pass `ceilingR = rewardR` UN-netted. Netting cost off there too would subtract it
 *    twice and manufacture spurious `INFEASIBLE`s.
 *
 * `provenanceKnown: false` downgrades a would-be `feasible` to `unknown` — never an
 * `infeasible`, which stays sound because it is derived from an upper bound.
 */
export function evaluateFeasibility(input: {
  barR: number;
  ceilingR: number | null;
  provenanceKnown?: boolean;
  /** Names the instrument in the reason string, e.g. "graded book" / "bull_put_spread". */
  subject?: string;
}): FeasibilityResult {
  const { barR, ceilingR } = input;
  const subject = input.subject ?? 'the graded instrument';
  if (ceilingR == null || !Number.isFinite(ceilingR) || !Number.isFinite(barR)) {
    return {
      verdict: 'unknown',
      barR,
      ceilingR: ceilingR ?? null,
      feasible: false,
      reason: `feasibility UNKNOWN — no payoff ceiling could be established for ${subject}; the ${Number.isFinite(barR) ? `${fmt(barR)}R ` : ''}bar is ungraded, not cleared`,
    };
  }
  if (barR >= ceilingR) {
    return {
      verdict: 'infeasible',
      barR,
      ceilingR,
      feasible: false,
      reason: `INFEASIBLE — the ${fmt(barR)}R bar is at or above the ${fmt(ceilingR)}R payoff ceiling of ${subject}, so it cannot be cleared at ANY hit rate (loss is pinned at −1R; reward is capped at maxProfit ÷ maxLoss). This is not a shortfall of evidence and MORE SAMPLE CANNOT SATISFY IT — the bar is untestable with this instrument.`,
    };
  }
  if (input.provenanceKnown === false) {
    return {
      verdict: 'unknown',
      barR,
      ceilingR,
      feasible: false,
      reason: `feasibility UNKNOWN — the ${fmt(barR)}R bar sits below the ${fmt(ceilingR)}R ceiling, but that ceiling is computed partly from FABRICATED rewards (sketch-capped/defaulted), so it is an upper bound only and cannot certify reachability for ${subject}`,
    };
  }
  return {
    verdict: 'feasible',
    barR,
    ceilingR,
    feasible: true,
    reason: `feasible — the ${fmt(barR)}R bar is below the ${fmt(ceilingR)}R payoff ceiling of ${subject}, so the comparison carries information`,
  };
}

// ── TRA-2353 · sleeve VERDICTS ──────────────────────────────────────────────

/** AC2's payload shape: one sleeve's verdict against the book's bar. */
export interface SleeveFeasibility {
  key: string;
  n: number;
  /** Share of the graded book, 0–1. The number that makes "74% of the book" legible. */
  weight: number | null;
  ceilingNetR: number | null;
  verdict: FeasibilityVerdict;
  /** True when this sleeve is at or above {@link MATERIAL_SLEEVE_WEIGHT} of the book. */
  material: boolean;
  /**
   * TRA-2361 rule R1 — this sleeve BLOCKS the `positive_expectancy` criterion.
   *
   * Exactly `R1(1) ∧ R1(2)`:
   *   1. `verdict === 'infeasible'` — a POSITIVE determination. `unknown` NEVER blocks.
   *   2. `weight >= BLOCKING_SLEEVE_WEIGHT`, where `weight = n ÷ bookN` over ALL partition
   *      members INCLUDING `unusable` ones.
   * There is no sample-size floor and no exemption; see {@link BLOCKING_SLEEVE_WEIGHT}.
   *
   * ⚠️ This is a LABEL like {@link material}. It is emitted on every sleeve at every
   * weight and it filters nothing — the gate reads it, it does not hide behind it.
   */
  blocking: boolean;
  /**
   * TRA-2361 AC4 — WEIGHT-ONLY and verdict-INDEPENDENT: this sleeve sits in
   * `[APPROACHING_BLOCKING_SLEEVE_WEIGHT, BLOCKING_SLEEVE_WEIGHT)`, i.e. one or two
   * resolutions from being able to block if its verdict is (or becomes) `infeasible`.
   *
   * Set on EVERY sleeve regardless of verdict, deliberately: "this verdict can change on
   * COMPOSITION ALONE, with no code change" is a documented property of this instrument,
   * and a gate that flips to `INFEASIBLE` with no prior warning is one nobody can plan
   * around. Live 2026-07-26 `bull_call_spread` sat at 9/47 = 19.15%, 0.85pp under the
   * threshold — one more resolution (10/48 = 20.83%) crosses it.
   */
  approachingBlockingThreshold: boolean;
  reason: string;
}

/** AC3 — one sleeve's removal, graded. */
export interface LeaveOneOutVerdict extends LeaveOneOutCeiling {
  verdict: FeasibilityVerdict;
  /** True when removing this sleeve alone CHANGES the book's verdict. */
  flipsBookVerdict: boolean;
}

export interface AxisFragility {
  /** Repeated here so this block reads standalone in a payload dump. */
  bookVerdict: FeasibilityVerdict;
  largestSleeveKey: string | null;
  /** AC3's stated minimum, named explicitly rather than left to be found in the list. */
  largestSleeveExcluded: LeaveOneOutVerdict | null;
  /** Every single-sleeve removal — a flip is legible wherever in the mix it lives. */
  leaveOneOut: LeaveOneOutVerdict[];
  /** True when ANY single sleeve's removal changes the book verdict. */
  flipsOnSingleSleeveRemoval: boolean;
  flippingSleeves: string[];
}

export interface AxisFeasibility {
  axis: string;
  barR: number;
  bookN: number;
  /** Every sleeve, weight-descending. Emitted whole — nothing is filtered out of here. */
  sleeves: SleeveFeasibility[];
  /**
   * TRA-2361 — the keys of every sleeve with `blocking: true`, weight-descending.
   *
   * ⚠️ A DERIVED PROJECTION of {@link sleeves}, never an independent computation: it is
   * `sleeves.filter(s => s.blocking).map(s => s.key)` and nothing else, so the axis
   * summary and the per-sleeve flags cannot drift apart. The live prover asserts that
   * agreement against the deployed bytes rather than trusting this sentence.
   */
  blockingSleeves: string[];
  /** The `infeasible` sleeve carrying the most weight. Null when none is infeasible. */
  worstSleeve: SleeveFeasibility | null;
  /** Share of the graded book (0–1) sitting inside an `infeasible` sleeve. */
  infeasibleWeight: number | null;
  fragility: AxisFragility;
  /** The sentence AC2 requires in the verdict, or null when there is nothing to say. */
  note: string | null;
}

/**
 * The weight at which an infeasible sleeve is flagged `material`.
 *
 * ⚠️ This is a LABEL, not a filter. Every sleeve verdict is emitted regardless, and the
 * headline note names the worst offender at ANY weight — a threshold that SUPPRESSES is
 * a new blind spot in an instrument that exists because a true state was invisible. The
 * flag is here so a consumer that wants to triage can, without this module deciding for
 * it.
 *
 * ⚠️ TRA-2361 — DO NOT raise this to 0.2 and reuse it as the blocking threshold. The two
 * constants have two different jobs and collapsing them REDUCES VISIBILITY: a sleeve at
 * 12% reads `material: true` today and would silently stop doing so. See
 * {@link BLOCKING_SLEEVE_WEIGHT}.
 */
export const MATERIAL_SLEEVE_WEIGHT = 0.1;

/**
 * TRA-2361 — the weight at which an `infeasible` sleeve BLOCKS the capital path.
 *
 * ── Rule R1, pre-registered by QuantTrader on TRA-2353 before the first read ──────────
 *
 *   A sleeve BLOCKS the `positive_expectancy` criterion of `live-capital-gate.ts` iff ALL
 *   of:
 *     1. `verdict === 'infeasible'` — a POSITIVE determination. `unknown` NEVER blocks.
 *     2. `weight >= 0.20`, where `weight = sleeve.n / bookN` and `n` counts ALL partition
 *        members INCLUDING `unusable` ones (the sleeve's share of the population the book
 *        verdict is averaged over — NOT `nUsable`, which would shrink an offender's
 *        apparent weight exactly when its rewards are underivable).
 *     3. the condition holds on EITHER axis — `byStructure` OR `byPremiumDirection`.
 *   The gate blocks iff ≥1 sleeve blocks. There is NO sample-size floor and NO exemption
 *   — deliberately; the only available justification for one was a composition argument
 *   that dies if `minResolvedIdeas` moves.
 *
 * ⚠️ 0.20 was PRE-REGISTERED before the first per-sleeve read precisely so it cannot be
 * tuned to a result afterwards. Do not substitute another threshold or add an exemption
 * without going back to QuantTrader — the pre-registration is the point.
 *
 * ⚠️ INVARIANT, asserted in `gate-sleeve-blocking.test.ts`:
 *   `BLOCKING_SLEEVE_WEIGHT >= MATERIAL_SLEEVE_WEIGHT`
 * The LABEL must fire no later than the BLOCK, so a sleeve is always SEEN before it BITES.
 * Whoever moves either constant has to keep that ordering or the suite goes red.
 */
export const BLOCKING_SLEEVE_WEIGHT = 0.2;

/**
 * TRA-2361 AC4 — the weight at which a sleeve is flagged as APPROACHING the block.
 *
 * A pure early-warning band, `[this, BLOCKING_SLEEVE_WEIGHT)`, applied WEIGHT-ONLY to
 * every sleeve regardless of verdict. It exists because a sleeve's weight moves on
 * composition alone: live 2026-07-26 `bull_call_spread` sat at 9/47 = 19.15%, 0.85pp
 * under the threshold, and ONE more resolution (10/48 = 20.83%) makes it blocking-eligible
 * with no code change anywhere. A gate that flips to `INFEASIBLE` with no prior warning is
 * one nobody can plan around.
 *
 * ⚠️ INVARIANT, asserted in the same test:
 *   `MATERIAL_SLEEVE_WEIGHT <= APPROACHING_BLOCKING_SLEEVE_WEIGHT < BLOCKING_SLEEVE_WEIGHT`
 */
export const APPROACHING_BLOCKING_SLEEVE_WEIGHT = 0.15;

const pctOf = (w: number | null): string => (w == null ? 'unknown share' : `${Math.round(w * 100)}%`);

/**
 * Grade every sleeve of an axis against the book's bar, and sweep the composition
 * fragility (AC2 + AC3).
 *
 * `bookVerdict` is passed in rather than re-derived: the book verdict is netted against
 * the book's own `avgCostR` and carries the book's provenance, and re-deriving it from
 * the axis would produce a second number that must agree with the first — the exact
 * "two computations that must agree" shape the §2 rule exists to forbid.
 */
export function evaluateAxisFeasibility(
  axis: CeilingAxis,
  barR: number,
  bookVerdict: FeasibilityVerdict,
): AxisFeasibility {
  const gradeSleeve = (s: SleeveCeiling): SleeveFeasibility => {
    const f = evaluateFeasibility({
      barR,
      ceilingR: s.ceilingNetR,
      // Same rule as the book: a fabricated reward can never certify reachability, but
      // it CAN sustain an `infeasible` (the ceiling is an upper bound either way).
      provenanceKnown: s.sourceCounts.sketch_capped === 0,
      subject: `sleeve ${s.key} (n=${s.n}, ${pctOf(s.weight)} of the graded book)`,
    });
    return {
      key: s.key,
      n: s.n,
      weight: s.weight,
      ceilingNetR: s.ceilingNetR,
      verdict: f.verdict,
      material: s.weight != null && s.weight >= MATERIAL_SLEEVE_WEIGHT,
      // TRA-2361 R1(1) ∧ R1(2). Graded on the PUBLISHED (4dp-rounded) `weight`, not on a
      // re-divided `n / bookN`: a reader who checks `0.1915 < 0.20` off the payload must
      // get the same answer the gate got. Two computations that must agree is the shape
      // the §2 rule forbids, and here the second one would live in the operator's head.
      // ⚠️ `verdict === 'infeasible'` is the POSITIVE determination — `unknown` (an
      // unestablished or fabricated-reward ceiling) never blocks.
      blocking:
        f.verdict === 'infeasible' && s.weight != null && s.weight >= BLOCKING_SLEEVE_WEIGHT,
      // Weight-only, verdict-independent — AC4. A `feasible` sleeve crossing into the band
      // is exactly as newsworthy: if its ceiling later drops it is already heavy enough.
      approachingBlockingThreshold:
        s.weight != null &&
        s.weight >= APPROACHING_BLOCKING_SLEEVE_WEIGHT &&
        s.weight < BLOCKING_SLEEVE_WEIGHT,
      reason: f.reason,
    };
  };

  const sleeves = axis.sleeves.map(gradeSleeve);
  // A DERIVED PROJECTION — see AxisFeasibility.blockingSleeves. `sleeves` is already
  // weight-descending, so the heaviest offender reads first here too.
  const blockingSleeves = sleeves.filter((s) => s.blocking).map((s) => s.key);
  const infeasible = sleeves.filter((s) => s.verdict === 'infeasible');
  const worstSleeve = infeasible[0] ?? null; // already weight-descending
  const infeasibleWeight = axis.bookN
    ? round4(infeasible.reduce((a, s) => a + s.n, 0) / axis.bookN)
    : null;

  const leaveOneOut: LeaveOneOutVerdict[] = axis.leaveOneOut.map((l) => {
    const v = evaluateFeasibility({
      barR,
      ceilingR: l.ceilingNetR,
      provenanceKnown: l.sourceCounts.sketch_capped === 0,
      subject: `the graded book excluding ${l.excludedKey}`,
    }).verdict;
    return { ...l, verdict: v, flipsBookVerdict: v !== bookVerdict };
  });
  const flipping = leaveOneOut.filter((l) => l.flipsBookVerdict);

  const fragility: AxisFragility = {
    bookVerdict,
    largestSleeveKey: axis.largestSleeveKey,
    largestSleeveExcluded:
      leaveOneOut.find((l) => l.excludedKey === axis.largestSleeveKey) ?? null,
    leaveOneOut,
    flipsOnSingleSleeveRemoval: flipping.length > 0,
    flippingSleeves: flipping.map((l) => l.excludedKey),
  };

  // The note answers exactly AC2's question — "is a `feasible` book hiding an infeasible
  // sleeve?" — so it is withheld in the two cases where it can only restate the headline:
  //
  //  • ONE sleeve. Its rows ARE the book's rows and the formula is identical, so its
  //    verdict is the book's verdict by construction. "Sleeve X (100% of the book) is
  //    infeasible" beside "the book is infeasible" is the same sentence twice.
  //  • The book is ALREADY `infeasible`. The loudest available stop is published; adding
  //    a sleeve warning under it dilutes the one line that must be read.
  //
  // ⚠️ TRA-2361 — BOTH SUPPRESSIONS SURVIVE R1, and that was re-derived rather than
  // assumed. The question a blocking sleeve raises is "can this hide the REASON THE GATE
  // STOPS?", and the answer is no, twice over:
  //
  //   • `bookVerdict === 'infeasible'` ⇒ the gate is ALREADY stopping on `barUnreachable`
  //     and the headline prints the book pair. The sleeve adds no new cause.
  //   • ONE sleeve ⇒ its rows ARE the book's rows and the netting/provenance rules are
  //     identical, so its verdict IS the book's verdict — which puts it in the case above.
  //
  //   • and independently: `live-capital-gate.ts` builds its INFEASIBLE headline clause
  //     from `sleeves.filter(s => s.blocking)` directly, never from this sentence. A
  //     blocking sleeve is named in the headline whether or not this note is emitted.
  //
  // (The first draft overrode both suppressions "to be safe" and made a single-sleeve
  // infeasible book print `sleeve X (100% of the graded book) … the book verdict rests on
  // the remainder` directly under `the book is infeasible` — the same sentence twice, with
  // a remainder that does not exist. Caught by running the reconstruction prover, not by
  // reading the diff.)
  //
  // Neither case suppresses DATA: `sleeves`, `worstSleeve`, `blockingSleeves` and
  // `infeasibleWeight` are populated regardless. Only the sentence is conditioned — the
  // distinction that keeps "an alarm that is always on is one nobody reads" from
  // becoming the fix.
  const parts: string[] = [];
  const worstBlocks = worstSleeve?.blocking === true;
  if (worstSleeve && axis.sleeves.length > 1 && bookVerdict !== 'infeasible') {
    parts.push(
      // ⚠️ The word after "SLEEVE INFEASIBLE" is load-bearing and it used to be the
      // constant "non-blocking". Under R1 that sentence would be FALSE exactly when it
      // matters most — a stale summary is a false all-clear wearing the fix's clothes.
      `SLEEVE INFEASIBLE (${worstBlocks ? `⛔ BLOCKING — TRA-2361 R1, weight ≥ ${BLOCKING_SLEEVE_WEIGHT}` : 'non-blocking'}, ${axis.axis}) — the book verdict is \`${bookVerdict}\` in aggregate, but sleeve \`${worstSleeve.key}\` (n=${worstSleeve.n}, ${pctOf(worstSleeve.weight)} of the graded book) has a cost-net payoff ceiling of ${worstSleeve.ceilingNetR == null ? 'unknown' : `${fmt(worstSleeve.ceilingNetR)}R`} against the ${fmt(barR)}R bar and CANNOT reach it at any hit rate. ${pctOf(infeasibleWeight)} of the graded book sits in an infeasible sleeve; the book verdict rests on the remainder.${blockingSleeves.length > 1 ? ` Blocking sleeves on this axis: ${blockingSleeves.map((k) => `\`${k}\``).join(', ')}.` : ''}`,
    );
  }
  // TRA-2361 AC4 — the EARLY WARNING. Published for every sleeve in the band regardless
  // of verdict, per R1's companion rule: weight moves on composition alone, so a sleeve
  // that is merely heavy today is a sleeve that can block the day its ceiling drops.
  const approaching = sleeves.filter((s) => s.approachingBlockingThreshold);
  if (approaching.length > 0) {
    parts.push(
      `APPROACHING THE BLOCKING THRESHOLD (${axis.axis}) — ${approaching
        .map(
          (s) =>
            `\`${s.key}\` (n=${s.n}, ${pctOf(s.weight)}, verdict \`${s.verdict}\`)`,
        )
        .join(', ')} ${approaching.length === 1 ? 'sits' : 'sit'} in [${APPROACHING_BLOCKING_SLEEVE_WEIGHT}, ${BLOCKING_SLEEVE_WEIGHT}) of the graded book. At weight ≥ ${BLOCKING_SLEEVE_WEIGHT} an \`infeasible\` verdict there BLOCKS the capital path (TRA-2361 R1) — and weight moves on COMPOSITION ALONE, with no code change.`,
    );
  }
  if (fragility.flipsOnSingleSleeveRemoval) {
    const worstFlip = flipping[0];
    parts.push(
      `COMPOSITION-FRAGILE (${axis.axis}) — removing ${flipping.length === 1 ? 'sleeve' : 'any one of the sleeves'} ${flipping.map((l) => `\`${l.excludedKey}\``).join(', ')} alone changes the book verdict (e.g. without \`${worstFlip.excludedKey}\` (n=${worstFlip.excludedN}) the cost-net ceiling is ${worstFlip.ceilingNetR == null ? 'unknown' : `${fmt(worstFlip.ceilingNetR)}R`} ⇒ \`${worstFlip.verdict}\`). This verdict can therefore change on COMPOSITION ALONE, with no code change.`,
    );
  }

  return {
    axis: axis.axis,
    barR,
    bookN: axis.bookN,
    sleeves,
    blockingSleeves,
    worstSleeve,
    infeasibleWeight,
    fragility,
    note: parts.length ? parts.join(' ') : null,
  };
}

/**
 * The per-open (admission) instance — AC4. LATENT, not live: the vertical book does not
 * route through `admitByCostAwareGate`, and today's live bar (0.485R) sits far under the
 * defaulted `rewardR` of 2.0. It shares the identical `safetyMarginR` constant as the
 * book gate, so it is fixed in the same change to stop it becoming live silently.
 *
 * ⚠️ `rewardSource === 'default'` means `rewardR` is `config.defaultRewardR` — a CONFIG
 * CONSTANT, not a property of the trade. A feasibility verdict computed from it measures
 * our own config, so it is `unknown` and can never be `infeasible`. `risk_reward_ratio`
 * is a DECLARED input (whatever the signal asserted), not a derived one — it fails open
 * in the same direction, so it is allowed as a ceiling but never without its provenance
 * travelling alongside.
 *
 * ⚠️ Pass `barR` from {@link admissionBarR} itself — never recompute `cost + margin`
 * inline. The real bar is `max(costModel + safetyMargin, optionsMinGrossR)`; today the
 * sum (0.485) wins so an inline recompute agrees BY LUCK, and stops agreeing the moment
 * `safetyMarginR < 0.015`, where the 0.3 floor binds.
 */
export function evaluatePerOpenFeasibility(input: {
  rewardR: number;
  rewardSource: 'target_stop' | 'risk_reward_ratio' | 'default';
  barR: number;
  structure: string;
}): FeasibilityResult {
  const derivedFromConstant = input.rewardSource === 'default' || !Number.isFinite(input.rewardR);
  if (derivedFromConstant) {
    return {
      verdict: 'unknown',
      barR: input.barR,
      ceilingR: Number.isFinite(input.rewardR) ? input.rewardR : null,
      feasible: false,
      reason: `feasibility UNKNOWN for ${input.structure} — rewardR came from the config default, not the trade, so a verdict from it would measure our configuration rather than the instrument`,
    };
  }
  return evaluateFeasibility({
    barR: input.barR,
    // Cost is ALREADY inside `admissionBarR`; do not net it off here (double-count).
    ceilingR: input.rewardR,
    provenanceKnown: input.rewardSource === 'target_stop',
    subject: input.structure,
  });
}
