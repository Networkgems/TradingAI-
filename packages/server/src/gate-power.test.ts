import { describe, it, expect } from 'vitest';
import {
  evaluateUnitPower,
  requiredN,
  sampleStdev,
  sigmaParametric,
  POWER_CONFIDENCE_SIGMA,
  SIGMA_DEGENERATE_EPS,
  TARGET_EFFECT_R,
  type GatePowerInputs,
  type SleevePowerObservation,
} from './gate-power.js';
import {
  evaluateLiveCapitalGate,
  resolveLiveCapitalGateCriteria,
  LIVE_CAPITAL_GATE,
  type GateCriterionStatus,
  type LiveCapitalGateResult,
} from './live-capital-gate.js';
import { buildForwardTestReport, type ForwardTestReport } from './options-forward-test.js';
import { MONOTONICITY_CASES } from './gate-sleeve-blocking-fixtures.js';

// TRA-3368 (parent TRA-2346 → TRA-2335 → TRA-2332) — the POWER-BASED DETECTABILITY
// criterion that replaces the raw `minResolvedIdeas = 30` floor.
//
// ⚠️ THE SUITE MUST DISCRIMINATE STATES, NOT JUST "NOT PASS" (ratified acceptance).
// A gate has FOUR verdicts now and three of them are `pass: false`, so a test that only
// asserts `passed === false` is GREEN IN THREE DIFFERENT WORLDS — the book underperformed
// a reachable bar (`FAIL`), the bar cannot be tested at all (`INFEASIBLE`), and the sample
// cannot resolve the question (`UNDERPOWERED`). Those three carry OPPOSITE instructions —
// INFEASIBLE says "more sample cannot resolve it", UNDERPOWERED says "more sample is the
// only remedy" — so collapsing them prints an actively misdirecting order. Every fixture
// below therefore asserts the `status`, and the seven ratified fixtures (a)–(g) are named
// as such in their test titles.

// The live cost-aware bar (0.20R safety margin) — the world the criterion was ratified
// against, and the same bar `gate-sleeve-blocking.test.ts` grades its fixtures on.
const CRITERIA = resolveLiveCapitalGateCriteria({ ENABLE_OPTION_COST_AWARE_GATE: '1' });

// The live book's pooled credit/width (TRA-2332 measurement) and a realistic R-scale sd
// for a defined-risk options book. Together they set the reference requirement used by
// most fixtures below: σ_param(0.0366) = 0.1949 < σ̂ = 0.9 ⇒ σ = 0.9 ⇒ n_req = 3600.
const POOLED_C = 0.0366;
const BOOK_SIGMA = 0.9;
const BOOK_N_REQ = 3600;

/**
 * A report carrying only the fields the gate reads. Everything not under test is set to a
 * comfortably-passing value (8 weeks, 6 positive, calibrated POP, zero breaches, a 2:1
 * payoff ceiling) so a failure below can only be the power criterion talking.
 */
function reportWith(over: {
  resolved: number;
  expectancyNetR: number;
  powerInputs?: GatePowerInputs;
  ceilingNetR?: number;
}): ForwardTestReport {
  return {
    asOfDate: '2026-08-13',
    totals: {
      weeksWithResolved: 8,
      weeksPositiveExpectancyNet: 6,
      popCalibrationGap: 0.05,
      maxLossBreaches: 0,
      avgCostR: 0.05,
      ceilingGrossR: 2.0,
      ceilingNetR: over.ceilingNetR ?? 1.95,
      ceilingGrossRPriced: 2.0,
      ceilingSourceCounts: { priced_structure: over.resolved, sketch_capped: 0, unusable: 0 },
      resolved: over.resolved,
      expectancyNetR: over.expectancyNetR,
      ...(over.powerInputs == null ? {} : { powerInputs: over.powerInputs }),
    },
  } as unknown as ForwardTestReport;
}

const sleeve = (
  key: string,
  n: number,
  weight: number,
  c: number | null,
  sigmaSample: number | null,
): SleevePowerObservation => ({ key, n, weight, c, sigmaSample });

const statusOf = (g: LiveCapitalGateResult, name: string): GateCriterionStatus =>
  g.criteria.find((c) => c.name === name)!.status;

// ── The R-SCALE reference table (ratified) ──────────────────────────────────────
//
// This is the arithmetic the whole ticket turns on, so it is pinned first and pinned
// twice: once as the required n, once as the numbers it must NOT be.

describe('TRA-3368 — the ratified R-scale required-n table', () => {
  it('FIXTURE (g) — c = 0.03 / 0.20 / 0.30 require 138 / 1112 / 1905, NOT 129 / 711 / 933', () => {
    // ⚠️ `√(p(1−p))` at p = 1−c is the sd of the WIN INDICATOR; the gate grades R. Per-idea
    // R is two-point (`+c/(1−c)` win, `−1` loss), so σ_R = √(p(1−p))/(1−c) and every
    // requirement is the hit-rate-scale number ÷ (1−c)² — 1.6–2.0× larger on exactly the
    // 0.20–0.30 credit sleeves where the criterion has to bite. Reading the hit-rate table
    // onto an R-scale gate under-demands sample by that factor, silently and fail-open.
    const nReq = (c: number): number => requiredN(sigmaParametric(c)!, LIVE_CAPITAL_GATE.minResolvedIdeas);
    expect(nReq(0.03)).toBe(138);
    expect(nReq(0.2)).toBe(1112);
    expect(nReq(0.3)).toBe(1905);
    // The hit-rate-scale numbers, asserted absent. Without this half, a regression that
    // dropped the `(1−c)` divisor would still satisfy the table above at c = 0.03 (129 vs
    // 138 is a plausible-looking rounding difference) and only bite on the heavy sleeves.
    expect([nReq(0.03), nReq(0.2), nReq(0.3)]).not.toEqual([129, 711, 933]);
    expect(nReq(0.3)).not.toBe(933);
  });

  it('the requirement is exactly (z·σ/δ)², floored at the surviving 30 (Q5)', () => {
    // The floor SURVIVES the redesign: strictly monotone on the sample axis, and the hard
    // bar when the computed requirement degenerates toward zero.
    expect(requiredN(0.0001, 30)).toBe(30);
    // …and it is a FLOOR, never a cap — it must not clamp a genuine requirement down.
    expect(requiredN(0.5, 30)).toBe(1112);
    expect(requiredN(0.5, 30)).toBe(
      Math.ceil(((POWER_CONFIDENCE_SIGMA * 0.5) / TARGET_EFFECT_R) ** 2),
    );
  });

  it('σ_param(c) = √(c/(1−c)) and is NULL outside c ∈ (0,1) — never a fabricated floor', () => {
    expect(sigmaParametric(0.2)).toBeCloseTo(0.5, 12);
    expect(sigmaParametric(0.0366)).toBeCloseTo(Math.sqrt(0.0366 / 0.9634), 12);
    // A net-DEBIT population has a breakeven p ≥ 1: the two-point model degenerates and
    // there is no floor. Reporting one anyway would be a fabricated bar on a real sleeve.
    for (const c of [null, 0, -0.2, 1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(sigmaParametric(c), `c=${String(c)}`).toBeNull();
    }
  });
});

// ── The n−1 helper, and the reason it is not the existing one ───────────────────

describe('TRA-3368 — sampleStdev is n−1 and returns null (never 0) below n = 2', () => {
  it('uses the n−1 denominator, not the population n', () => {
    // [0, 2]: population sd = 1, sample sd = √2. Downward bias is worst at small n, which
    // is exactly where this criterion has to bite, so the distinction is not cosmetic.
    expect(sampleStdev([0, 2])).toBeCloseTo(Math.SQRT2, 12);
    expect(sampleStdev([0, 2])).not.toBeCloseTo(1, 6);
  });

  it('n < 2 is NULL — a fabricated 0 reads as "infinitely well powered at n = 1"', () => {
    // `strategy-introspection.ts`'s population helper returns 0 here. Correct for ITS
    // subject, catastrophic for this one: 0 in the numerator of n_req = (2σ/δ)² makes the
    // requirement collapse to the floor on a one-row book. Null is not "zero dispersion",
    // it is "no dispersion measurable", and the evaluator treats it as UNDERPOWERED.
    expect(sampleStdev([])).toBeNull();
    expect(sampleStdev([0.5])).toBeNull();
  });
});

// ── The seven ratified fixtures ─────────────────────────────────────────────────

describe('TRA-3368 — the seven ratified fixtures (a)–(g)', () => {
  it('FIXTURE (a) — ADEQUATELY POWERED and genuinely underperforming ⇒ FAIL, not UNDERPOWERED', () => {
    // The positive control for the whole criterion. If nothing can reach `FAIL` any more,
    // the criterion has not been added — the gate has just been welded shut, and a welded
    // gate cannot distinguish a bad book from a small one.
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 4000,
        expectancyNetR: 0.1, // under the 0.20R bar, and the 1.95R ceiling makes it reachable
        powerInputs: {
          pooled: { n: 4000, c: POOLED_C, sigmaSample: BOOK_SIGMA },
          // A material sleeve that IS powered — so the ∀ conjunct is satisfied by
          // evidence, not vacuously by an empty axis.
          byStructure: [sleeve('bull_put_spread', 4000, 1, POOLED_C, BOOK_SIGMA)],
          byPremiumDirection: [sleeve('credit', 4000, 1, POOLED_C, BOOK_SIGMA)],
        },
      }),
      CRITERIA,
    );
    expect(g.power.powered).toBe(true);
    expect(g.power.nRequired).toBe(BOOK_N_REQ);
    expect(g.power.forcedBy).toEqual([]);
    expect(statusOf(g, 'sample_size')).toBe('PASS');
    expect(statusOf(g, 'positive_expectancy')).toBe('FAIL');
    expect(g.passed).toBe(false);
    // The headline is the ordinary shortfall sentence — neither loud stop fires.
    expect(g.summary).toContain('HOLD');
    expect(g.summary).not.toContain('UNDERPOWERED');
    expect(g.summary).not.toContain('CANNOT BE TESTED');
  });

  it('FIXTURE (b) — UNDER-POWERED ⇒ UNDERPOWERED on BOTH criteria, pre-empting a PASS', () => {
    // The mean CLEARS the bar (0.45R vs 0.20R). Under the old floor this book promoted on
    // 500 rows; the whole point is that a mean clearing the bar on an unpowered sample is
    // a coin flip, so UNDERPOWERED must pre-empt PASS and not merely PASS-with-a-warning.
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 500,
        expectancyNetR: 0.45,
        powerInputs: {
          pooled: { n: 500, c: POOLED_C, sigmaSample: BOOK_SIGMA },
          byStructure: [sleeve('bull_put_spread', 500, 1, POOLED_C, BOOK_SIGMA)],
          byPremiumDirection: [],
        },
      }),
      CRITERIA,
    );
    expect(g.power.powered).toBe(false);
    expect(g.power.nRequired).toBe(BOOK_N_REQ);
    expect(g.power.nObserved).toBe(500);
    // It attaches to BOTH — a `sample_size: PASS` beside a bare `positive_expectancy: FAIL`
    // is the conflation this fixture exists to forbid.
    expect(statusOf(g, 'sample_size')).toBe('UNDERPOWERED');
    expect(statusOf(g, 'positive_expectancy')).toBe('UNDERPOWERED');
    expect(g.passed).toBe(false);
    // 500 ≥ 30, so the OLD floor read this book as adequately sampled. Pin that, because
    // it is the entire delta: this criterion is not a restatement of the floor.
    expect(g.criteria.find((c) => c.name === 'sample_size')!.actual!).toBeGreaterThanOrEqual(
      CRITERIA.minResolvedIdeas,
    );
    // ⚠️ THE REMEDY POINTS THE OPPOSITE WAY FROM INFEASIBLE'S, and the headline must say so.
    expect(g.summary).toContain('UNDERPOWERED — live capital stays gated');
    expect(g.summary).toContain('MORE SAMPLE IS THE ONLY REMEDY');
    expect(g.summary).not.toContain('MORE SAMPLE CANNOT RESOLVE IT');
  });

  it('FIXTURE (c) — n = 5, ALL WINS, σ̂ = 0 ⇒ UNDERPOWERED, never PASS (the σ̂ fail-open)', () => {
    // ⚠️ THE DEFECT THIS FIXTURE EXISTS TO KILL. n_req = (2σ̂/δ)² on a book that has not
    // lost yet gives σ̂ ≈ 0 ⇒ n_req ≈ 0 ⇒ "adequately powered at n = 5" — a fail-open that
    // is strictly WORSE than the constant it replaces, because it opens widest on exactly
    // the thinnest books. Debit rows have no credit/width ratio, so there is no parametric
    // floor to catch it either: the ratified rule is that `sample_only` with a degenerate
    // σ̂ is UNDERPOWERED outright, with `nRequired: null` rather than a fabricated bar.
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 5,
        expectancyNetR: 0.45,
        powerInputs: {
          pooled: { n: 5, c: null, sigmaSample: 0 },
          byStructure: [sleeve('long_call', 5, 1, null, 0)],
          byPremiumDirection: [sleeve('debit', 5, 1, null, 0)],
        },
      }),
      CRITERIA,
    );
    expect(g.power.sigmaSource).toBe('sample_only');
    expect(g.power.nRequired).toBeNull(); // never 0, and never the floor dressed as a bar
    expect(g.power.powered).toBe(false);
    expect(statusOf(g, 'sample_size')).toBe('UNDERPOWERED');
    expect(statusOf(g, 'positive_expectancy')).toBe('UNDERPOWERED');
    expect(g.passed).toBe(false);
    expect(g.summary).toContain('uncomputable');
  });

  it('FIXTURE (c′) — σ̂ arriving as FLOAT DUST (1e−17) is the same state, not a live sd', () => {
    // An all-identical sample computes to ~1e−17, not bit-exact 0, so an `=== 0` check is
    // a label-match on a float and (c)'s fail-open walks straight through it. Both the
    // dust value and a null σ̂ must land in the same place.
    for (const sigmaSample of [1e-17, SIGMA_DEGENERATE_EPS, null]) {
      const u = evaluateUnitPower({ n: 5, c: null, sigmaSample }, 30);
      expect(u.powered, `σ̂=${String(sigmaSample)}`).toBe(false);
      expect(u.nRequired, `σ̂=${String(sigmaSample)}`).toBeNull();
      expect(u.sigmaSource).toBe('sample_only');
    }
    // …and a σ̂ genuinely above the dust guard is graded, not swallowed.
    const live = evaluateUnitPower({ n: 5, c: null, sigmaSample: 1e-9 }, 30);
    expect(live.nRequired).toBe(30);
    expect(live.powered).toBe(false); // 5 < 30 — the floor still binds
  });

  it('FIXTURE (c″) — a CREDIT sleeve with σ̂ = 0 is caught by the PARAMETRIC FLOOR instead', () => {
    // The same all-wins book, but on a credit sleeve where a breakeven c exists. Here the
    // floor does the work: σ = max(0, σ_param(0.20)) = 0.5 ⇒ n_req = 1112, so an all-wins
    // 5-row sleeve is UNDERPOWERED by arithmetic rather than by the degenerate-σ̂ rule.
    // Both routes must close; a suite that only exercised one would miss a regression in
    // the other, and they are the two halves of `max(σ̂, σ_param)`.
    const u = evaluateUnitPower({ n: 5, c: 0.2, sigmaSample: 0 }, 30);
    expect(u.sigmaSource).toBe('parametric_floor');
    expect(u.sigmaUsed).toBeCloseTo(0.5, 12);
    expect(u.nRequired).toBe(1112);
    expect(u.powered).toBe(false);
  });

  it('FIXTURE (d) — under-powered AND the bar unreachable ⇒ INFEASIBLE wins (precedence)', () => {
    // PRECEDENCE: INFEASIBLE > UNDERPOWERED > FAIL/PASS. When the bar cannot be reached at
    // a 100% hit rate, accruing the required sample resolves nothing — so the criterion
    // whose headline says "more sample cannot resolve it" must win, or the gate orders the
    // desk to keep accruing toward a number the instrument cannot produce.
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 40,
        expectancyNetR: 0.01,
        ceilingNetR: 0.05, // < the 0.20R bar, provenance known ⇒ positively `infeasible`
        powerInputs: {
          pooled: { n: 40, c: POOLED_C, sigmaSample: BOOK_SIGMA },
          byStructure: [sleeve('bull_put_spread', 40, 1, POOLED_C, BOOK_SIGMA)],
          byPremiumDirection: [],
        },
      }),
      CRITERIA,
    );
    expect(g.feasibility.verdict).toBe('infeasible');
    expect(g.power.powered).toBe(false); // both conditions genuinely hold on this fixture
    expect(statusOf(g, 'positive_expectancy')).toBe('INFEASIBLE');
    // `sample_size` still states its own fact — the sample really cannot resolve anything —
    // but it does not get to own the headline.
    expect(statusOf(g, 'sample_size')).toBe('UNDERPOWERED');
    expect(g.summary).toContain('MORE SAMPLE CANNOT RESOLVE IT');
    expect(g.summary).not.toContain('MORE SAMPLE IS THE ONLY REMEDY');
    // ⚠️ AND THE TWO SENTENCES MUST NOT BOTH LAND ON THE SAME CRITERION. The expectancy
    // criterion is INFEASIBLE, so its note carries the ceiling story only; the opposite
    // remedy beside it would be self-contradicting in the one field a reader lands on.
    const c3 = g.criteria.find((c) => c.name === 'positive_expectancy')!;
    expect(c3.feasibilityNote).not.toContain('MORE SAMPLE IS THE ONLY REMEDY');
    expect(g.passed).toBe(false);
  });

  it('FIXTURE (e) — pooled-powered book, ONE ≥20% sleeve under-powered at its own c ⇒ UNDERPOWERED', () => {
    // The mean-over-a-mixed-population defect, on the sample axis this time: a book can be
    // pooled-powered while a material sleeve inside it is not, and promoting on the pooled
    // number promotes on evidence the heavy sleeve does not have.
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 4000,
        expectancyNetR: 0.45,
        powerInputs: {
          pooled: { n: 4000, c: POOLED_C, sigmaSample: BOOK_SIGMA }, // 4000 ≥ 3600 ⇒ powered
          byStructure: [
            // 80% of the book, needs 3600, has 3200 ⇒ NOT powered, and material.
            sleeve('bull_put_spread', 3200, 0.8, POOLED_C, BOOK_SIGMA),
            // 20% exactly — material, and comfortably powered at its own (much smaller) c.
            sleeve('bull_call_spread', 800, 0.2, 0.01, 0.08),
          ],
          byPremiumDirection: [],
        },
      }),
      CRITERIA,
    );
    expect(g.power.pooled.powered).toBe(true); // ← the pooled conjunct is NOT what fires
    const [heavy, light] = g.power.byAxis.byStructure;
    expect(heavy.key).toBe('bull_put_spread');
    expect(heavy.material).toBe(true);
    expect(heavy.powered).toBe(false);
    expect(heavy.nRequired).toBe(BOOK_N_REQ);
    expect(light.material).toBe(true); // weight 0.2 is INSIDE the threshold, not outside
    expect(light.powered).toBe(true);
    expect(light.nRequired).toBe(45); // graded at ITS c, never the book's pooled c
    // The reader must see WHICH conjunct forced it without re-deriving anything.
    expect(g.power.forcedBy).toEqual(['byStructure:bull_put_spread']);
    expect(g.power.powered).toBe(false);
    expect(statusOf(g, 'positive_expectancy')).toBe('UNDERPOWERED');
    expect(g.summary).toContain('byStructure:bull_put_spread');
    expect(g.passed).toBe(false);
  });

  it('FIXTURE (f) — FRAGMENTED book, no sleeve ≥20%, pooled n < pooled n_req ⇒ UNDERPOWERED', () => {
    // ⚠️ THE FIXTURE THAT FAILS IF THE POOLED CONJUNCT IS DROPPED IN REVIEW. "Blocked iff
    // any ≥20% sleeve is unpowered" is VACUOUSLY TRUE on six 15% sleeves — a
    // materiality-quantified ∀ fails open on a fragmented population, which is exactly
    // TRA-2607's mixed-population fail-open wearing a quantifier. The pooled conjunct is
    // the backstop, and this is the only fixture that can see it.
    const six = Array.from({ length: 6 }, (_, i) =>
      sleeve(`sleeve-${i}`, 100, 1 / 6, POOLED_C, BOOK_SIGMA),
    );
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 600,
        expectancyNetR: 0.45,
        powerInputs: {
          pooled: { n: 600, c: POOLED_C, sigmaSample: BOOK_SIGMA }, // 600 < 3600
          byStructure: six,
          byPremiumDirection: six.map((s) => ({ ...s, key: `pd-${s.key}` })),
        },
      }),
      CRITERIA,
    );
    // Every sleeve is BELOW the materiality threshold, so the per-sleeve ∀ is vacuous…
    expect(g.power.byAxis.byStructure.every((s) => !s.material)).toBe(true);
    expect(g.power.byAxis.byPremiumDirection.every((s) => !s.material)).toBe(true);
    // …and the ONLY thing standing between this book and a promotion is the pooled term.
    expect(g.power.forcedBy).toEqual(['pooled']);
    expect(g.power.powered).toBe(false);
    expect(statusOf(g, 'sample_size')).toBe('UNDERPOWERED');
    expect(statusOf(g, 'positive_expectancy')).toBe('UNDERPOWERED');
    expect(g.passed).toBe(false);
  });

  it('FIXTURE (g) — a c = 0.30 sleeve PUBLISHES nRequired 1905, not 933, on the gate result', () => {
    // (g) at the unit level is pinned in the table above; this is the same claim carried
    // all the way through the gate onto the object the health route publishes, because a
    // correct helper behind a wrong call site is still a wrong bar on the readout.
    const g = evaluateLiveCapitalGate(
      reportWith({
        resolved: 2000,
        expectancyNetR: 0.45,
        powerInputs: {
          pooled: { n: 2000, c: 0.3, sigmaSample: 0.1 },
          byStructure: [sleeve('bull_put_spread', 2000, 1, 0.3, 0.1)],
          byPremiumDirection: [],
        },
      }),
      CRITERIA,
    );
    const s = g.power.byAxis.byStructure[0]!;
    expect(s.nRequired).toBe(1905);
    expect(s.nRequired).not.toBe(933);
    // σ̂ = 0.1 is BELOW σ_param(0.30) = 0.6547, so the floor is what is being reported —
    // which is the half of `max(σ̂, σ_param)` that stops a quiet book certifying itself.
    expect(s.sigmaSource).toBe('parametric_floor');
    expect(s.sigmaUsed).toBeCloseTo(Math.sqrt(0.3 / 0.7), 12);
    expect(g.power.nRequired).toBe(1905);
    expect(g.power.powered).toBe(true); // 2000 ≥ 1905
    expect(statusOf(g, 'sample_size')).toBe('PASS');
  });
});

// ── Degradation, and the direction the criterion may move ───────────────────────

describe('TRA-3368 — a report with no power inputs FAILS CLOSED', () => {
  it('grades UNDERPOWERED rather than skipping the criterion', () => {
    // A persisted snapshot or a hand-built partial report predates `powerInputs`. The
    // criterion is ratified monotone non-increasing, so the degraded read must CLOSE the
    // path: a report that cannot show its σ and c cannot certify that its sample resolves
    // anything, and "the field is missing" is not evidence of adequacy.
    const g = evaluateLiveCapitalGate(
      reportWith({ resolved: 4000, expectancyNetR: 0.45 }),
      CRITERIA,
    );
    expect(g.power.powered).toBe(false);
    expect(g.power.forcedBy).toEqual(['pooled (power inputs unavailable on this report)']);
    expect(statusOf(g, 'sample_size')).toBe('UNDERPOWERED');
    expect(g.passed).toBe(false);
  });

  it('and it never throws — this sits on `/api/health/live-capital-gate`', () => {
    // A probe that 500s removes the whole readout, including the criteria that are still
    // perfectly measurable. Same contract the ceiling degradation already carries.
    expect(() =>
      evaluateLiveCapitalGate(
        { asOfDate: '2026-08-13', totals: { resolved: 0 } } as unknown as ForwardTestReport,
        CRITERIA,
      ),
    ).not.toThrow();
  });
});

describe('TRA-3368 · the MONOTONICITY property, pinned from a real differential', () => {
  /**
   * `passed′ ≤ passed` pointwise is the whole safety argument for shipping this into a
   * live-capital path, and it is a claim about the RELATION BETWEEN TWO BUILDS — so a
   * green suite on this build cannot see it. It was measured by running the pre-fix build
   * and this one over the SAME fixtures:
   *
   *   cd packages/server && node --import tsx/esm ../../scripts/tra3368-monotonicity-matrix.mjs
   *   (pre-fix `1d7f180d`, run 2026-08-13)
   *
   * The vector below is a RECORDING of that run's PRE column, not a reading of the old
   * source. Re-derive it with the script — never by reasoning about the old code, which is
   * the exact substitution TRA-2361 AC5 forbids and for the same reason.
   */
  const PRE_TRA3368_PASSED: Record<string, boolean> = {
    'known-bad-25pct-infeasible-sleeve': false,
    'known-good-5pct-infeasible-sleeve': true,
    'premium-axis-only-block': false,
    'unknown-heavy-sleeve-never-blocks': true,
    'unusable-rows-count-toward-weight': false,
    'clean-book-all-sleeves-feasible': true,
    'book-level-infeasible': false,
    'failing-book-below-bar': false,
    'thin-book-below-sample-floor': false,
    'approaching-not-yet-blocking': true,
  };

  const matrix = () => {
    const promoted: string[] = [];
    const demoted: string[] = [];
    for (const c of MONOTONICITY_CASES()) {
      const pre = PRE_TRA3368_PASSED[c.key];
      expect(pre, `no recorded pre-fix value for ${c.key} — re-run the script`).not.toBe(undefined);
      const post = evaluateLiveCapitalGate(
        buildForwardTestReport(c.outcomes, { asOf: Date.parse('2026-02-23T16:00:00.000Z') }),
        CRITERIA,
      ).passed;
      if (pre && !post) demoted.push(c.key);
      if (!pre && post) promoted.push(c.key);
    }
    return { promoted, demoted };
  };

  it('ZERO `false → true` cells — the criterion can only ever CLOSE a capital path', () => {
    const { promoted } = matrix();
    expect(promoted, 'a fixture the pre-fix gate REFUSED now PASSES').toEqual([]);
  });

  it('the four `true → false` cells are NAMED — otherwise the change is inert', () => {
    // All four are books of 40-odd rows whose sleeves are single-valued, i.e. exactly the
    // population the criterion exists to refuse. That every TRA-2361 fixture demotes is
    // the finding, not an accident: those books were built to exercise sleeve blocking at
    // n ≈ 48, and n ≈ 48 cannot resolve a 0.03R effect at any σ.
    const { demoted } = matrix();
    expect(demoted.sort()).toEqual([
      'approaching-not-yet-blocking',
      'clean-book-all-sleeves-feasible',
      'known-good-5pct-infeasible-sleeve',
      'unknown-heavy-sleeve-never-blocks',
    ]);
  });

  it('the fixture set spans both outcomes under the PRE build (no one-sided matrix)', () => {
    // A transition matrix whose PRE column is all-false cannot exhibit a `false → true`
    // cell even if the change manufactured one — the property would be untestable.
    const pre = MONOTONICITY_CASES().map((c) => PRE_TRA3368_PASSED[c.key]);
    expect(pre.some((x) => x === true)).toBe(true);
    expect(pre.some((x) => x === false)).toBe(true);
  });
});
