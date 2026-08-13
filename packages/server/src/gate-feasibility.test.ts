import { describe, it, expect } from 'vitest';
import {
  buildForwardTestReport,
  buildAccumulationMonitor,
  evaluateBookFeasibility,
  renderWeeklyRollupMarkdown,
  type IdeaOutcome,
} from './options-forward-test.js';
import { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } from './live-capital-gate.js';
import { computeBookCeiling, evaluatePerOpenFeasibility } from './gate-feasibility.js';
import { admissionBarR, DEFAULT_COST_GATE_CONFIG } from './option-cost-gate.js';

// TRA-2335 (parent TRA-2332) — the payoff-ceiling feasibility precondition.
//
// ⚠️ AC6, and the reason this file exists at all: a suite that only asserts
// "criterion 3 does not pass" is GREEN IN BOTH WORLDS — the book underperforming a
// reachable bar, and the bar being arithmetically unreachable. That is exactly the
// hole that let a bar 5.3× the instrument's maximum grade a live book for four weeks.
// Every test below therefore asserts the DISTINCTION (`status`), never just the
// absence of a pass.

const ET_NOON = (d: string): number => Date.parse(`${d}T16:00:00.000Z`);

/** Build one graded (resolved, included) outcome. Only the fields the ceiling reads matter. */
function outcome(over: Partial<IdeaOutcome> & { key: string }): IdeaOutcome {
  return {
    ticker: 'SPY',
    strategy: 'bull_put_spread',
    surfacedDate: '2026-01-05',
    surfacedWeek: '2026-W02',
    expiration: '2026-02-20',
    pop: 0.96,
    maxLossUsd: 963.4,
    maxProfitUsd: 36.6,
    entryNetUsd: 36.6,
    status: 'resolved',
    valuedAt: '2026-02-20',
    liquidationUsd: 0,
    pnlUsd: 36.6,
    pnlR: 0.038,
    costsUsd: 37.5,
    pnlNetUsd: -0.9,
    pnlNetR: -0.001,
    costEfficiencyRatio: 0.0389,
    win: true,
    maxLossBreached: false,
    excluded: false,
    excludeReason: null,
    settleLagDays: 0,
    ...over,
  };
}

/**
 * FIXTURE 2 — THE LIVE BOOK, so this test doubles as the record (AC6).
 *
 * Credit verticals at the pooled credit/width k = 0.0366 measured on the live book
 * (n=35: 31 `bull_put_spread` + 4 `bear_call_spread`, `GET /api/health/
 * options-ideas-decomposition`, 2026-07-25, build `073b2b94161d`).
 *
 *   rewardR = k ÷ (1 − k) = 36.6 ÷ 963.4 = +0.0380R   ← the ceiling at a 100% hit rate
 *   costR   = 0.0389                                   ← the measured cost drag
 *   ceilingNetR = 0.0380 − 0.0389 = −0.0009R          ← what criterion 3 grades against
 *   bar     = +0.20R                                   ← 5.3× the gross ceiling
 *
 * `+0.20R` would require a hit rate of 1.19; `+0.05R` a hit rate of 1.05. Probabilities
 * greater than one.
 */
const LIVE_CREDIT_BOOK = (n = 35): IdeaOutcome[] =>
  Array.from({ length: n }, (_, i) => outcome({ key: `live-${i}` }));

describe('TRA-2335 · computeBookCeiling — the payoff ceiling and its provenance', () => {
  it('reproduces the live credit book ceiling of +0.0380R from maxProfit ÷ maxLoss', () => {
    const c = computeBookCeiling(LIVE_CREDIT_BOOK());
    expect(c.ceilingGrossR).toBeCloseTo(0.038, 4);
    expect(c.n).toBe(35);
    expect(c.sourceCounts).toEqual({ priced_structure: 35, sketch_capped: 0, unusable: 0 });
    // Cross-check from an entirely separate direction: solving E[R] = 0 for the
    // risk-neutral hit rate gives 1 ÷ 1.03799 = 0.9634, the book's own hit rate.
    expect(1 / (1 + c.ceilingGrossR!)).toBeCloseTo(0.9634, 4);
  });

  it('classifies a long_call 2×-debit SKETCH CAP separately from a priced structure', () => {
    // ⚠️ These are `priced: true` in the feed, so the `!excluded` filter does NOT drop
    // them. Left uncounted they drag the ceiling toward 2.0 and the check fails OPEN.
    const c = computeBookCeiling([
      ...LIVE_CREDIT_BOOK(4),
      { strategy: 'long_call', maxProfitUsd: 600, maxLossUsd: 300 },
    ]);
    expect(c.sourceCounts.sketch_capped).toBe(1);
    // The honest (priced-only) ceiling is untouched by the sketch cap...
    expect(c.ceilingGrossRPriced).toBeCloseTo(0.038, 4);
    // ...while the headline ceiling deliberately INCLUDES it, so it stays an upper
    // bound — which is what makes an INFEASIBLE verdict derived from it sound.
    expect(c.ceilingGrossR!).toBeGreaterThan(c.ceilingGrossRPriced!);
  });

  it('counts a non-positive max-loss as unusable rather than dividing by it', () => {
    const c = computeBookCeiling([{ strategy: 'bull_put_spread', maxProfitUsd: 10, maxLossUsd: 0 }]);
    expect(c.sourceCounts.unusable).toBe(1);
    expect(c.ceilingGrossR).toBeNull();
  });
});

describe('TRA-2335 · AC6 — FAIL and INFEASIBLE must be DISTINGUISHABLE', () => {
  const CRITERIA = { ...LIVE_CAPITAL_GATE, minExpectancyR: 0.2 };

  /**
   * FIXTURE 1 — a REACHABLE bar the book simply underperformed. Must read FAIL.
   *
   * ⚠️ TRA-3368 — n IS 700, NOT 35, AND THAT IS THE POINT OF THE FIXTURE, NOT PADDING.
   * `FAIL` asserts "the book underperformed a bar it could have cleared", and a 35-row
   * book cannot support that claim about a 0.03R effect — the power criterion pre-empts
   * it with `UNDERPOWERED`, which is a fact about the SAMPLE and not about the book. To
   * keep asserting the FAIL/INFEASIBLE distinction, the fixture has to be a book that
   * genuinely resolves: at c = 36.6/300 = 0.122 the parametric floor σ_param = 0.3728
   * puts n_req at 618, so 700 rows clear it. Every per-row number is unchanged, so the
   * ceiling this fixture exists to exercise is still exactly 2.0 gross / 1.95 net.
   */
  const underperformingBook = (): IdeaOutcome[] =>
    Array.from({ length: 700 }, (_, i) =>
      outcome({
        key: `u-${i}`,
        // rewardR = 200/100 = 2.0 — the 0.20R bar is comfortably reachable here.
        maxProfitUsd: 200,
        maxLossUsd: 100,
        costEfficiencyRatio: 0.05,
        pnlUsd: -10,
        pnlR: -0.1,
        pnlNetUsd: -15,
        pnlNetR: -0.15,
        win: false,
      }),
    );

  it('fixture 1 — book underperforms a REACHABLE bar → FAIL (not INFEASIBLE)', () => {
    const report = buildForwardTestReport(underperformingBook(), { asOf: ET_NOON('2026-02-23') });
    expect(report.totals.ceilingNetR).toBeCloseTo(1.95, 4);
    const gate = evaluateLiveCapitalGate(report, CRITERIA);
    const c3 = gate.criteria.find((c) => c.name === 'positive_expectancy')!;

    expect(c3.status).toBe('FAIL');
    expect(c3.pass).toBe(false);
    expect(gate.feasibility.verdict).toBe('feasible');
    // The bar was testable and the book lost the test — the summary must NOT claim
    // the criterion was untestable.
    expect(gate.summary).not.toContain('INFEASIBLE');
    expect(gate.summary).toContain('Unmet:');
  });

  it('fixture 2 — the LIVE numbers: bar exceeds rewardR − costR → INFEASIBLE', () => {
    const report = buildForwardTestReport(LIVE_CREDIT_BOOK(), { asOf: ET_NOON('2026-02-23') });
    // The record, asserted: gross ceiling +0.0380R, cost drag 0.0389R, net ≈ 0.000R.
    expect(report.totals.ceilingGrossR).toBeCloseTo(0.038, 4);
    expect(report.totals.avgCostR).toBeCloseTo(0.0389, 4);
    expect(report.totals.ceilingNetR).toBeCloseTo(-0.0009, 4);

    const gate = evaluateLiveCapitalGate(report, CRITERIA);
    const c3 = gate.criteria.find((c) => c.name === 'positive_expectancy')!;

    expect(c3.status).toBe('INFEASIBLE');
    expect(c3.pass).toBe(false); // AC3 — blocks promotion exactly as FAIL does.
    expect(gate.passed).toBe(false);
    // AC2 — the summary names BOTH the bar and the ceiling.
    expect(c3.barR).toBeCloseTo(0.2, 10);
    expect(c3.ceilingR).toBeCloseTo(-0.0009, 4);
    expect(gate.summary).toContain('INFEASIBLE');
    expect(gate.summary).toContain('0.2');
    expect(gate.summary).toContain('CANNOT BE TESTED');
    // AC3 — it must never read as "pending"/"not yet".
    expect(gate.summary).toContain('MORE SAMPLE CANNOT RESOLVE IT');
  });

  it('AC3 — INFEASIBLE is NOT satisfiable by accruing sample', () => {
    // 35 → 3,500 resolved ideas and 100 weeks of evidence changes nothing: the bar is
    // above the arithmetic maximum of the instrument, so sample size is irrelevant.
    const huge = Array.from({ length: 3500 }, (_, i) =>
      outcome({ key: `big-${i}`, surfacedWeek: `2026-W${String((i % 100) + 1).padStart(2, '0')}` }),
    );
    const report = buildForwardTestReport(huge, { asOf: ET_NOON('2026-02-23') });
    expect(report.totals.resolved).toBe(3500);
    expect(report.totals.weeksWithResolved).toBe(100);

    const gate = evaluateLiveCapitalGate(report, CRITERIA);
    // The two sample-size criteria now PASS — and the expectancy one is still stopped.
    expect(gate.criteria.find((c) => c.name === 'sample_size')!.pass).toBe(true);
    expect(gate.criteria.find((c) => c.name === 'weeks_of_evidence')!.pass).toBe(true);
    expect(gate.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('INFEASIBLE');
    expect(gate.passed).toBe(false);
  });

  it('AC5 — lowering the bar to 0.0 does NOT rescue it (the fix is the check)', () => {
    // The shipped `LIVE_CAPITAL_GATE.minExpectancyR = 0.0` fallback is ALSO unreachable
    // for this book: the cost-net ceiling is −0.0009R, i.e. zero to within measurement
    // precision. A strictly-positive cost-net bar of ANY size is at best marginally
    // attainable, and only at a literally perfect hit rate.
    const report = buildForwardTestReport(LIVE_CREDIT_BOOK(), { asOf: ET_NOON('2026-02-23') });
    const gate = evaluateLiveCapitalGate(report, { ...LIVE_CAPITAL_GATE, minExpectancyR: 0.0 });
    expect(gate.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('INFEASIBLE');
  });
});

describe('TRA-2335 · §2 — the ceiling must use the GRADED population, not a looser one', () => {
  it('fixture 3 — an EXCLUDED fallback-priced outcome does not move the ceiling', () => {
    // ⚠️ THE POSITIVE CONTROL MUST CONTAIN WHAT IT DETECTS. This fixture holds a real
    // F2 `fallback_priced` entry: the feed fabricates `maxProfitUsd = maxLossUsd` when
    // the legs cannot be priced, giving `rewardR ≡ 1.000` — 26× the true book ceiling
    // of 0.0380. A ceiling averaged over the looser `maxLossUsd > 0` predicate ADMITS
    // it (maxLoss ≥ 1 > 0) and drifts up until an unreachable bar reads as reachable —
    // the check built to catch this defect reporting that there is nothing to catch.
    const withFabricated: IdeaOutcome[] = [
      ...LIVE_CREDIT_BOOK(35),
      outcome({
        key: 'fallback',
        maxProfitUsd: 500,
        maxLossUsd: 500, // rewardR ≡ 1.000, the 1:1 placeholder
        excluded: true,
        excludeReason: 'fallback_priced',
      }),
    ];
    const clean = buildForwardTestReport(LIVE_CREDIT_BOOK(35), { asOf: ET_NOON('2026-02-23') });
    const polluted = buildForwardTestReport(withFabricated, { asOf: ET_NOON('2026-02-23') });

    // The fabricated entry IS present and IS surfaced — the fixture really contains it.
    expect(polluted.totals.surfaced).toBe(36);
    expect(polluted.totals.excluded).toBe(1);
    // ...and the ceiling is byte-identical to the clean book.
    expect(polluted.totals.ceilingGrossR).toBe(clean.totals.ceilingGrossR);
    expect(polluted.totals.ceilingNetR).toBe(clean.totals.ceilingNetR);
    expect(polluted.totals.ceilingSourceCounts.priced_structure).toBe(35);
    // Guard the negative control too: had it leaked in, the ceiling would have moved
    // to (35·0.038 + 1·1.0)/36 ≈ 0.0647 — comfortably detectable at 4 dp.
    expect(polluted.totals.ceilingGrossR!).toBeLessThan(0.05);
  });

  it('§2 — avgCostR is over the GRADED set and reconciles with expectancyR − expectancyNetR', () => {
    const report = buildForwardTestReport(LIVE_CREDIT_BOOK(), { asOf: ET_NOON('2026-02-23') });
    // Cross-check to ±0.01, NOT equality — both sides are 2-dp rounded upstream.
    const implied = (report.totals.expectancyR ?? 0) - (report.totals.expectancyNetR ?? 0);
    expect(Math.abs(implied - (report.totals.avgCostR ?? 0))).toBeLessThanOrEqual(0.01);
  });
});

describe('TRA-2335 · §6 — the accumulation monitor must not publish a false countdown', () => {
  const monitorFor = (outcomes: IdeaOutcome[], minExpectancyR: number) =>
    buildAccumulationMonitor({
      report: buildForwardTestReport(outcomes, { asOf: ET_NOON('2026-02-23') }),
      gate: { minWeeksWithResolved: 8, minResolvedIdeas: 30, minExpectancyR },
      chainOutDir: '/data/option-chains',
      chainDates: ['2026-01-05'],
      journalCount: outcomes.length,
      firstJournaledDate: '2026-01-05',
      lastJournaledDate: '2026-01-05',
      tradierConfigured: true,
      anthropicConfigured: true,
    });

  it('WITHHOLDS the countdown when the bar is unreachable', () => {
    const m = monitorFor(LIVE_CREDIT_BOOK(), 0.2);
    expect(m.gate.feasible).toBe(false);
    expect(m.gate.feasibility.verdict).toBe('infeasible');
    // The defect: this used to render "7 weeks to go" every Monday, toward an event
    // that could not occur. A withheld countdown must be null — never 0, which is the
    // single worst available rendering because it reads as "you have arrived".
    expect(m.gate.weeksRemaining).toBeNull();
    expect(m.gate.resolvedRemaining).toBeNull();
    expect(m.gate.ceilingNetR).toBeCloseTo(-0.0009, 4);
  });

  it('STILL publishes the countdown on an empty/early book (unknown ≠ infeasible)', () => {
    // The monitor's whole purpose is the pre-accrual phase. `unknown` means "no ceiling
    // established yet", not "shown unreachable" — suppressing here would destroy the
    // instrument's primary function and fire the alarm every week from day one.
    const m = monitorFor([], 0.2);
    expect(m.gate.feasibility.verdict).toBe('unknown');
    expect(m.gate.weeksRemaining).toBe(8);
    expect(m.gate.resolvedRemaining).toBe(30);
  });

  it('the weekly roll-up REPLACES the countdown with the reachability statement', () => {
    const report = buildForwardTestReport(LIVE_CREDIT_BOOK(), { asOf: ET_NOON('2026-02-23') });
    const m = monitorFor(LIVE_CREDIT_BOOK(), 0.2);
    const md = renderWeeklyRollupMarkdown({
      monitor: m,
      report,
      gatePassed: false,
      gateSummary: evaluateLiveCapitalGate(report, { ...LIVE_CAPITAL_GATE, minExpectancyR: 0.2 })
        .summary,
    });
    expect(md).toContain('Gate not reachable');
    expect(md).toContain('NOT a sample-size problem');
    expect(md).toContain('No amount of additional sample can clear this bar');
    expect(md).toContain('(bar unreachable)');
    // ⚠️ The old artifact's exact reading must be GONE, not merely accompanied.
    expect(md).not.toMatch(/\|\s*8\s*\|\s*7\s*\|/);
  });
});

describe('TRA-2335 · AC4 — the per-open bar shares the constant (LATENT, not live)', () => {
  it('is comfortably feasible today at the live 0.485R bar', () => {
    const bar = admissionBarR('single_leg_otm', DEFAULT_COST_GATE_CONFIG);
    expect(bar).toBeCloseTo(0.485, 3);
    const f = evaluatePerOpenFeasibility({
      rewardR: 2.0,
      rewardSource: 'target_stop',
      barR: bar,
      structure: 'single_leg_otm',
    });
    expect(f.verdict).toBe('feasible');
  });

  it('refuses to publish a verdict when rewardR came from the CONFIG DEFAULT', () => {
    // ⚠️ `rewardSource === 'default'` means rewardR is `config.defaultRewardR` (2.0) —
    // a constant, not a property of the trade. A verdict from it would measure our own
    // configuration. It is `unknown`, and can never be `infeasible`.
    const f = evaluatePerOpenFeasibility({
      rewardR: 2.0,
      rewardSource: 'default',
      barR: 5.0, // far above the "ceiling" — still must NOT claim infeasible
      structure: 'single_leg_otm',
    });
    expect(f.verdict).toBe('unknown');
    expect(f.feasible).toBe(false);
  });

  it('treats a NaN rewardR as unknown even though its source string says default', () => {
    // `estimateModeledGrossR`'s unusable-inputs early return yields NaN WITH
    // `rewardSource: 'default'`, so the string test happens to cover this today — but
    // that is coincidence, not contract. Gate on non-finite explicitly.
    const f = evaluatePerOpenFeasibility({
      rewardR: Number.NaN,
      rewardSource: 'risk_reward_ratio',
      barR: 0.485,
      structure: 'single_leg_rv',
    });
    expect(f.verdict).toBe('unknown');
  });

  it('goes INFEASIBLE when a REAL target/stop reward sits under the bar', () => {
    const f = evaluatePerOpenFeasibility({
      rewardR: 0.3,
      rewardSource: 'target_stop',
      barR: admissionBarR('single_leg_otm', DEFAULT_COST_GATE_CONFIG),
      structure: 'single_leg_otm',
    });
    expect(f.verdict).toBe('infeasible');
    expect(f.reason).toContain('0.485');
    expect(f.reason).toContain('0.300');
  });

  it('AC5 at this site — the optionsMinGrossR floor blocks the constant-lowering escape', () => {
    // An operator lowering OPTION_COST_GATE_SAFETY_MARGIN_R to buy feasibility bottoms
    // out at the 0.3R floor — still ~8× the vertical book's +0.0380R ceiling.
    const bar = admissionBarR('single_leg_otm', { ...DEFAULT_COST_GATE_CONFIG, safetyMarginR: 0 });
    expect(bar).toBeCloseTo(0.3, 10);
    expect(bar).toBeGreaterThan(0.038 * 7);
  });
});

describe('TRA-2335 · a report without the ceiling fields degrades, never throws', () => {
  it('reports unknown (not a 500) on a partial/legacy report', () => {
    // The gate is served by `/api/health/live-capital-gate`. A probe that THROWS takes
    // the whole readout down — including the five criteria that are still perfectly
    // measurable — which is strictly worse than reporting "ceiling not established".
    const legacy = {
      asOfDate: '2026-07-11',
      totals: {
        weeksWithResolved: 8,
        weeksPositiveExpectancyNet: 6,
        popCalibrationGap: 0.05,
        resolved: 4000,
        expectancyNetR: 0.45,
        maxLossBreaches: 0,
        // ⚠️ TRA-3368 — the claim under test is that an UNKNOWN CEILING does not block a
        // book that empirically clears the bar. `UNDERPOWERED` pre-empts `PASS`, so
        // without a powered observation the assertion below would go green against a
        // verdict reached for an entirely different reason — the ceiling degradation
        // could be broken outright and this test would not notice.
        powerInputs: {
          pooled: { n: 4000, c: 0.0366, sigmaSample: 0.9 },
          byStructure: [],
          byPremiumDirection: [],
        },
      },
    } as unknown as Parameters<typeof evaluateBookFeasibility>[0];

    expect(() => evaluateBookFeasibility(legacy, 0.2)).not.toThrow();
    expect(evaluateBookFeasibility(legacy, 0.2).verdict).toBe('unknown');
    // And `unknown` must not block a book that empirically clears the bar.
    const gate = evaluateLiveCapitalGate(legacy, { ...LIVE_CAPITAL_GATE, minExpectancyR: 0.2 });
    expect(gate.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('PASS');
  });
});

describe('TRA-2335 · evaluateBookFeasibility — one code path for gate and monitor', () => {
  it('the gate verdict and the monitor verdict are the same object shape and value', () => {
    const report = buildForwardTestReport(LIVE_CREDIT_BOOK(), { asOf: ET_NOON('2026-02-23') });
    const direct = evaluateBookFeasibility(report, 0.2);
    const viaGate = evaluateLiveCapitalGate(report, {
      ...LIVE_CAPITAL_GATE,
      minExpectancyR: 0.2,
    }).feasibility;
    expect(viaGate).toEqual(direct);
  });
});
