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
