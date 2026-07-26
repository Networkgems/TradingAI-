import { describe, it, expect } from 'vitest';
import {
  buildForwardTestReport,
  evaluateBookFeasibility,
  evaluateBookSleeveFeasibility,
  type IdeaOutcome,
} from './options-forward-test.js';
import { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } from './live-capital-gate.js';
import { computeCeilingAxis, MATERIAL_SLEEVE_WEIGHT } from './gate-feasibility.js';

// TRA-2353 (parent TRA-2335 → TRA-2332) — PER-SLEEVE payoff-ceiling feasibility.
//
// ⚠️ TRA-2361 SUPERSEDES ONE DECISION IN HERE. TRA-2353 shipped this decomposition as
// pure REPORTING and reserved "should an infeasible sleeve block?" for QuantTrader. It
// now does block (rule R1) — see `gate-sleeve-blocking.test.ts`, which owns that rule.
// This file keeps owning the DECOMPOSITION: the partition invariant, the credit/debit
// derivation, the leave-one-out sweep and the `unknown` handling are all unchanged.
//
// ⚠️ AC6, and the whole reason this file is separate from `gate-feasibility.test.ts`:
// A POSITIVE CONTROL MUST CONTAIN WHAT IT DETECTS. A mixed-book fixture in which every
// sleeve happens to be feasible passes in BOTH worlds — the one where the partition
// exists and the one where it does not. Every test below is built on a book that is
// `feasible` IN AGGREGATE while a sleeve inside it is provably `infeasible`, which is
// the only shape that can tell those two worlds apart. The clean-mix fixture is kept as
// the NEGATIVE control (it must stay silent), never as the evidence.

const ET_NOON = (d: string): number => Date.parse(`${d}T16:00:00.000Z`);
const BAR = 0.2;
const CRITERIA = { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR };

/**
 * THE LIVE SHAPE, reproduced. bqb1 build `7161d2be3f2b`, 2026-07-26:
 *
 *   graded book    n=47   gross 0.2882 → net 0.2391   `feasible` vs the 0.20R bar
 *   credit sleeve  n=35   ≈0.04 gross / ≈0.00 net     flatly INFEASIBLE
 *   debit sleeve   n=12   rewardR ≈ 1.012             carries the whole verdict
 *
 * ⚠️ THE DEBIT ROW WAS NEVER DIRECTLY READ — it is arithmetic by difference from the
 * live totals, because no route exposed a per-sleeve ceiling (which is the gap TRA-2353
 * closes). So this fixture reproduces the live SHAPE and the two DIRECTLY-MEASURED
 * numbers (credit `36.6 / 963.4` and the 0.20R bar); the debit leg is chosen to land the
 * book near the live 0.2391R net, and the assertions below are on the fixture's OWN
 * arithmetic, not on the live digits. Calling it a reproduction of the live book would
 * be stating a derived number as a measured one — the error the TRA-2335 sign-off
 * retracted its own headline for.
 */
const CREDIT_MAX_PROFIT = 36.6; // rewardR = 36.6 / 963.4 = 0.037990
const CREDIT_MAX_LOSS = 963.4;
const CREDIT_COST_R = 0.0389;
const DEBIT_MAX_PROFIT = 253; // rewardR = 253 / 250 = 1.012
const DEBIT_MAX_LOSS = 250;
const DEBIT_COST_R = 0.0789;

function credit(over: Partial<IdeaOutcome> & { key: string }): IdeaOutcome {
  return {
    ticker: 'SPY',
    strategy: 'bull_put_spread',
    surfacedDate: '2026-01-05',
    surfacedWeek: '2026-W02',
    expiration: '2026-02-20',
    pop: 0.96,
    maxLossUsd: CREDIT_MAX_LOSS,
    maxProfitUsd: CREDIT_MAX_PROFIT,
    // + = net credit collected. This sign is what `byPremiumDirection` partitions on.
    entryNetUsd: CREDIT_MAX_PROFIT,
    status: 'resolved',
    valuedAt: '2026-02-20',
    liquidationUsd: 0,
    pnlUsd: CREDIT_MAX_PROFIT,
    pnlR: 0.038,
    costsUsd: CREDIT_MAX_LOSS * CREDIT_COST_R,
    pnlNetUsd: -0.9,
    pnlNetR: -0.001,
    costEfficiencyRatio: CREDIT_COST_R,
    // The load-bearing live fact: 31 credit spreads, EVERY ONE A WINNER, netting 0.00R.
    // The sleeve has ATTAINED its ceiling; no model is needed to read it.
    win: true,
    maxLossBreached: false,
    excluded: false,
    excludeReason: null,
    settleLagDays: 0,
    ...over,
  };
}

function debit(over: Partial<IdeaOutcome> & { key: string }): IdeaOutcome {
  return credit({
    strategy: 'bull_call_spread',
    maxProfitUsd: DEBIT_MAX_PROFIT,
    maxLossUsd: DEBIT_MAX_LOSS,
    // − = net debit paid.
    entryNetUsd: -DEBIT_MAX_LOSS,
    costEfficiencyRatio: DEBIT_COST_R,
    pnlUsd: 20,
    pnlR: 0.08,
    pnlNetUsd: 0.3,
    pnlNetR: 0.0011,
    ...over,
  });
}

const rows = <T>(n: number, f: (i: number) => T): T[] => Array.from({ length: n }, (_, i) => f(i));

/** FIXTURE A — the live mix: 35 credit (infeasible) + 12 debit, book `feasible`. */
const MIXED_BOOK = (): IdeaOutcome[] => [
  ...rows(31, (i) => credit({ key: `bps-${i}` })),
  ...rows(4, (i) => credit({ key: `bcs-${i}`, strategy: 'bear_call_spread' })),
  ...rows(9, (i) => debit({ key: `bcls-${i}` })),
  ...rows(3, (i) => debit({ key: `bps-d-${i}`, strategy: 'bear_put_spread' })),
];

/** FIXTURE B — the NEGATIVE control: same 47-row mix, every sleeve comfortably feasible. */
const CLEAN_MIXED_BOOK = (): IdeaOutcome[] => [
  ...rows(31, (i) =>
    credit({ key: `ok-a-${i}`, maxProfitUsd: 200, maxLossUsd: 100, costEfficiencyRatio: 0.05 }),
  ),
  ...rows(4, (i) =>
    credit({
      key: `ok-b-${i}`,
      strategy: 'bear_call_spread',
      maxProfitUsd: 150,
      maxLossUsd: 100,
      costEfficiencyRatio: 0.05,
    }),
  ),
  ...rows(12, (i) => debit({ key: `ok-c-${i}` })),
];

const reportFor = (o: IdeaOutcome[]) => buildForwardTestReport(o, { asOf: ET_NOON('2026-02-23') });

describe('TRA-2353 · AC1 — the per-sleeve ceiling is a PARTITION, not a second filter', () => {
  it('every sleeve is a subset of the graded array: sum(sleeve.n) === bookN, both axes', () => {
    // ⚠️ The book under test MUST contain rows the graded filter drops, or this invariant
    // is vacuous: on an all-included book the loose `maxLossUsd > 0` predicate selects the
    // identical set, and a partition re-derived from it satisfies the sum anyway. (Found
    // by mutation: re-deriving the population slipped past the first draft of this test.)
    const outcomes = [
      ...MIXED_BOOK(),
      credit({ key: 'x1', excluded: true, excludeReason: 'fallback_priced' }),
      credit({ key: 'x2', status: 'open' }),
    ];
    const t = reportFor(outcomes).totals;
    expect(t.surfaced).toBe(49);
    expect(t.resolved).toBe(47);
    for (const axis of [t.ceilingAxes.byStructure, t.ceilingAxes.byPremiumDirection]) {
      expect(axis.bookN).toBe(t.resolved);
      expect(axis.sleeves.reduce((a, s) => a + s.n, 0)).toBe(t.resolved);
    }
  });

  it('an EXCLUDED fallback-priced row is absent from every sleeve, not just from the book', () => {
    // ⚠️ The §2 fail-open, one level down. The feed fabricates `maxProfit = maxLoss` when
    // legs cannot be priced ⇒ `rewardR ≡ 1.000`, 26× a real vertical. If the partition
    // re-derived its own population (rather than partitioning the caller's array) that
    // row would re-enter — and it would land in `bull_put_spread`, lifting the single
    // sleeve this ticket exists to expose from infeasible toward feasible.
    const polluted = reportFor([
      ...MIXED_BOOK(),
      credit({
        key: 'fabricated',
        maxProfitUsd: 500,
        maxLossUsd: 500,
        excluded: true,
        excludeReason: 'fallback_priced',
      }),
    ]);
    const clean = reportFor(MIXED_BOOK());
    // The fixture really CONTAINS the thing it detects.
    expect(polluted.totals.surfaced).toBe(48);
    expect(polluted.totals.excluded).toBe(1);

    const sleeve = (r: typeof clean, key: string) =>
      r.totals.ceilingAxes.byStructure.sleeves.find((s) => s.key === key)!;
    expect(sleeve(polluted, 'bull_put_spread').n).toBe(sleeve(clean, 'bull_put_spread').n);
    expect(sleeve(polluted, 'bull_put_spread').ceilingNetR).toBe(
      sleeve(clean, 'bull_put_spread').ceilingNetR,
    );
  });

  it('reproduces the book ceiling from the sleeves it partitions (the axis reconciles)', () => {
    const t = reportFor(MIXED_BOOK()).totals;
    const axis = t.ceilingAxes.byPremiumDirection;
    // Weighted mean of the sleeve gross ceilings === the book gross ceiling. If these
    // ever diverge, one of the two is being computed over a different population.
    const weighted =
      axis.sleeves.reduce((a, s) => a + (s.ceilingGrossR ?? 0) * s.n, 0) / axis.bookN;
    expect(weighted).toBeCloseTo(t.ceilingGrossR!, 3);
  });

  it('partitions credit vs debit from the SIGN OF THE ENTRY, not from a name list', () => {
    const axis = reportFor(MIXED_BOOK()).totals.ceilingAxes.byPremiumDirection;
    expect(axis.sleeves.map((s) => s.key)).toEqual(['credit', 'debit']);
    expect(axis.sleeves.find((s) => s.key === 'credit')!.n).toBe(35);
    expect(axis.sleeves.find((s) => s.key === 'debit')!.n).toBe(12);
  });

  it('a zero/unformable entry lands in `unknown` rather than being folded into a sleeve', () => {
    const axis = computeCeilingAxis(
      [credit({ key: 'z', entryNetUsd: 0 }), credit({ key: 'c' }), debit({ key: 'd' })],
      'premium_direction',
      (o) => (o.entryNetUsd === 0 ? 'unknown' : o.entryNetUsd > 0 ? 'credit' : 'debit'),
    );
    expect(axis.sleeves.find((s) => s.key === 'unknown')!.n).toBe(1);
  });
});

describe('TRA-2353 · AC2 — a `feasible` book hiding an `infeasible` sleeve MUST say so', () => {
  it('THE POSITIVE CONTROL: book feasible in aggregate, credit sleeve infeasible, sleeve NAMED', () => {
    const report = reportFor(MIXED_BOOK());
    const gate = evaluateLiveCapitalGate(report, CRITERIA);

    // (1) The book really is `feasible` — this fixture is green in the pre-fix world.
    expect(gate.feasibility.verdict).toBe('feasible');
    expect(report.totals.ceilingNetR!).toBeGreaterThan(BAR);

    // (2) ...and the sleeve carrying 74% of it provably cannot reach the same bar.
    const worst = gate.sleeveFeasibility.byStructure.worstSleeve!;
    expect(worst).not.toBeNull();
    expect(worst.key).toBe('bull_put_spread');
    expect(worst.n).toBe(31);
    expect(worst.verdict).toBe('infeasible');
    expect(worst.material).toBe(true);
    // 36.6/963.4 = 0.03799 gross, less the 0.0389 cost drag ⇒ zero to measurement noise.
    expect(worst.ceilingNetR!).toBeCloseTo(-0.0009, 4);

    // (3) The 74% headline is a NUMBER on the payload, not a claim in a comment.
    expect(gate.sleeveFeasibility.byStructure.infeasibleWeight).toBeCloseTo(35 / 47, 4);
    expect(gate.sleeveFeasibility.byPremiumDirection.worstSleeve!.key).toBe('credit');

    // (4) And it reaches the two surfaces an operator actually reads.
    expect(gate.summary).toContain('SLEEVE INFEASIBLE');
    expect(gate.summary).toContain('bull_put_spread');
    expect(gate.summary).toContain('74%');
    const c3 = gate.criteria.find((c) => c.name === 'positive_expectancy')!;
    expect(c3.feasibilityNote).toContain('bull_put_spread');
  });

  it('THE NEGATIVE CONTROL: a mixed book with every sleeve feasible stays SILENT', () => {
    // ⚠️ Without this, the assertions above would also pass on an implementation that
    // simply always prints a warning. An alarm that is always on is one nobody reads.
    const gate = evaluateLiveCapitalGate(reportFor(CLEAN_MIXED_BOOK()), CRITERIA);
    expect(gate.feasibility.verdict).toBe('feasible');
    expect(gate.sleeveFeasibility.byStructure.sleeves).toHaveLength(3);
    expect(gate.sleeveFeasibility.byStructure.worstSleeve).toBeNull();
    expect(gate.sleeveFeasibility.byStructure.infeasibleWeight).toBe(0);
    expect(gate.sleeveFeasibility.note).toBeNull();
    expect(gate.summary).not.toContain('SLEEVE INFEASIBLE');
    expect(gate.summary).not.toContain('COMPOSITION-FRAGILE');
  });

  it('SUPERSEDED BY TRA-2361 (R1): a 74% infeasible sleeve now DOES block', () => {
    // ⚠️ THIS TEST HAS CHANGED SIDES, DELIBERATELY. It used to be titled "NOT IN SCOPE: an
    // infeasible sleeve changes NOTHING about what blocks" and asserted `c3.status ===
    // 'FAIL'` — encoding TRA-2353's decision to ship the sleeve decomposition as pure
    // reporting and reserve the policy call for QuantTrader. QuantTrader has since ruled
    // (TRA-2361, rule R1, PRE-REGISTERED before the first per-sleeve read), so that
    // assertion is now a pin on a retired policy. It is REWRITTEN rather than deleted: a
    // deleted test leaves no trace that the semantics moved, and this one is the record.
    const report = reportFor(MIXED_BOOK());
    const gate = evaluateLiveCapitalGate(report, CRITERIA);
    const c3 = gate.criteria.find((c) => c.name === 'positive_expectancy')!;

    // The BOOK-level verdict is still `feasible` and still means exactly what it meant —
    // R1 did not change book semantics (TRA-2361 "not in scope").
    expect(gate.feasibility.feasible).toBe(true);
    // …but the credit sleeve carries 35/47 = 74% of the graded book at a cost-net ceiling
    // of ≈0.00R, which is ≥ the 0.20 blocking weight and a POSITIVE `infeasible`.
    expect(gate.sleeveFeasibility.byPremiumDirection.blockingSleeves).toEqual(['credit']);
    expect(c3.status).toBe('INFEASIBLE');
    expect(c3.pass).toBe(false);
    // The one invariant that did NOT move: `passed` still derives from `pass` alone, so no
    // downstream consumer has to learn a third state to stay correct.
    expect(gate.passed).toBe(gate.criteria.every((c) => c.pass));
  });

  it('the sleeve block is a SIBLING of `feasibility`, which keeps its exact prior value', () => {
    // Guards the TRA-2335 invariant that the gate's verdict and the monitor's verdict are
    // the SAME object: folding sleeve data into `feasibility` would silently break it.
    const report = reportFor(MIXED_BOOK());
    expect(evaluateLiveCapitalGate(report, CRITERIA).feasibility).toEqual(
      evaluateBookFeasibility(report, BAR),
    );
  });
});

describe('TRA-2353 · AC3 — composition fragility must be LEGIBLE', () => {
  it('names the flip: removing a 9-row DEBIT sleeve turns the book INFEASIBLE', () => {
    const gate = evaluateLiveCapitalGate(reportFor(MIXED_BOOK()), CRITERIA);
    const frag = gate.sleeveFeasibility.byStructure.fragility;

    expect(frag.bookVerdict).toBe('feasible');
    expect(frag.flipsOnSingleSleeveRemoval).toBe(true);
    // Both debit sleeves carry the verdict; removing EITHER drops the book under the bar.
    expect(frag.flippingSleeves.sort()).toEqual(['bear_put_spread', 'bull_call_spread']);
    const flip = frag.leaveOneOut.find((l) => l.excludedKey === 'bull_call_spread')!;
    expect(flip.verdict).toBe('infeasible');
    expect(flip.remainingN).toBe(38);
    expect(gate.summary).toContain('COMPOSITION-FRAGILE');
    expect(gate.summary).toContain('COMPOSITION ALONE');
  });

  it('⚠️ the LARGEST sleeve is NOT the fragile one — the full sweep is what catches it', () => {
    // AC3's stated minimum is "recompute with the largest sleeve excluded". On the live
    // mix that read is REASSURING AND WRONG: the largest sleeve is the 31-row credit one,
    // and removing it RAISES the ceiling (0.0380 → 0.77) because the sleeve dragging the
    // mean down is the infeasible one. The verdict-carrying sleeves are the two SMALL
    // debit ones. A largest-sleeve-only guard would have printed "still feasible" and
    // reported no fragility at all.
    const frag = evaluateLiveCapitalGate(reportFor(MIXED_BOOK()), CRITERIA).sleeveFeasibility
      .byStructure.fragility;
    expect(frag.largestSleeveKey).toBe('bull_put_spread');
    expect(frag.largestSleeveExcluded!.verdict).toBe('feasible');
    expect(frag.largestSleeveExcluded!.flipsBookVerdict).toBe(false);
    // ...while the sweep the same block publishes does catch it.
    expect(frag.flippingSleeves).toContain('bull_call_spread');
  });

  it('emits no leave-one-out sweep for a single-sleeve book (removal leaves nothing)', () => {
    const axis = reportFor(rows(35, (i) => credit({ key: `c-${i}` }))).totals.ceilingAxes
      .byStructure;
    expect(axis.sleeves).toHaveLength(1);
    expect(axis.leaveOneOut).toEqual([]);
  });
});

describe('TRA-2353 · AC4 — `unknown` must render AS UNKNOWN in the headline', () => {
  it('a FAIL on an unestablished ceiling no longer reads as a bare "book underperformed"', () => {
    // The conflation TRA-2335 exists to prevent, surviving in the one field the operator
    // reads first. `feasibilityNote` carried it on the criterion; the headline did not.
    const legacy = {
      asOfDate: '2026-07-11',
      totals: {
        weeksWithResolved: 8,
        weeksPositiveExpectancyNet: 6,
        popCalibrationGap: 0.05,
        resolved: 30,
        expectancyNetR: 0.1, // below the 0.20R bar ⇒ criterion 3 FAILs
        maxLossBreaches: 0,
      },
    } as unknown as Parameters<typeof evaluateBookFeasibility>[0];

    const gate = evaluateLiveCapitalGate(legacy, CRITERIA);
    expect(gate.feasibility.verdict).toBe('unknown');
    expect(gate.criteria.find((c) => c.name === 'positive_expectancy')!.status).toBe('FAIL');
    expect(gate.summary).toContain('REACHABILITY UNKNOWN');
    expect(gate.summary).toContain('UNGRADED for reachability, not cleared');
  });

  it('stays silent when the book PASSES on an unknown ceiling (a measured pass IS proof)', () => {
    // `expectancyNetR ≤ ceiling` holds pathwise, so clearing the bar is itself
    // constructive proof of reachability. Warning there would be noise, not caution.
    const legacy = {
      asOfDate: '2026-07-11',
      totals: {
        weeksWithResolved: 8,
        weeksPositiveExpectancyNet: 6,
        popCalibrationGap: 0.05,
        resolved: 30,
        expectancyNetR: 0.45,
        maxLossBreaches: 0,
      },
    } as unknown as Parameters<typeof evaluateBookFeasibility>[0];
    const gate = evaluateLiveCapitalGate(legacy, CRITERIA);
    expect(gate.feasibility.verdict).toBe('unknown');
    expect(gate.summary).not.toContain('REACHABILITY UNKNOWN');
  });

  it('a sleeve whose ceiling rests on a SKETCH CAP is `unknown`, never a clean feasible', () => {
    // `long_call` upside is capped at 2× debit with `priced: true`, so it sails past the
    // `!excluded` filter. It may sustain an `infeasible` (the ceiling is an upper bound)
    // but it can never certify reachability.
    const axis = reportFor([
      ...rows(31, (i) => credit({ key: `c-${i}` })),
      ...rows(12, (i) =>
        debit({ key: `lc-${i}`, strategy: 'long_call', maxProfitUsd: 600, maxLossUsd: 300 }),
      ),
    ]).totals.ceilingAxes.byStructure;
    const lc = axis.sleeves.find((s) => s.key === 'long_call')!;
    expect(lc.sourceCounts.sketch_capped).toBe(12);

    const graded = evaluateLiveCapitalGate(
      reportFor([
        ...rows(31, (i) => credit({ key: `c-${i}` })),
        ...rows(12, (i) =>
          debit({ key: `lc-${i}`, strategy: 'long_call', maxProfitUsd: 600, maxLossUsd: 300 }),
        ),
      ]),
      CRITERIA,
    ).sleeveFeasibility.byStructure.sleeves.find((s) => s.key === 'long_call')!;
    expect(graded.verdict).toBe('unknown');
    // ...and the credit sleeve beside it is still called out.
    expect(graded.ceilingNetR!).toBeGreaterThan(BAR); // it WOULD have read feasible
  });
});

describe('TRA-2353 · degradation and thresholds', () => {
  it('a report with no `ceilingAxes` degrades to empty axes and never throws', () => {
    // This sits on `/api/health/live-capital-gate`. A probe that throws removes the whole
    // readout, including the five criteria that are still perfectly measurable.
    const legacy = {
      asOfDate: '2026-07-11',
      totals: { resolved: 30, expectancyNetR: 0.45, maxLossBreaches: 0 },
    } as unknown as Parameters<typeof evaluateBookFeasibility>[0];
    expect(() => evaluateBookSleeveFeasibility(legacy, BAR, 'unknown')).not.toThrow();
    const s = evaluateBookSleeveFeasibility(legacy, BAR, 'unknown');
    expect(s.byStructure.sleeves).toEqual([]);
    expect(s.byStructure.worstSleeve).toBeNull();
    expect(s.note).toBeNull();
    // Null-never-0: an unpartitioned book has no infeasible SHARE, it has no share at all.
    expect(s.byStructure.infeasibleWeight).toBeNull();
  });

  it('`material` LABELS, it never FILTERS — a sub-threshold sleeve is still reported', () => {
    // A threshold that suppresses is a new blind spot in an instrument that exists
    // because a true state was invisible. One infeasible credit row in 100 debit rows.
    const gate = evaluateLiveCapitalGate(
      reportFor([...rows(1, (i) => credit({ key: `c-${i}` })), ...rows(100, (i) => debit({ key: `d-${i}` }))]),
      CRITERIA,
    );
    const worst = gate.sleeveFeasibility.byStructure.worstSleeve!;
    expect(worst.key).toBe('bull_put_spread');
    expect(worst.weight!).toBeLessThan(MATERIAL_SLEEVE_WEIGHT);
    expect(worst.material).toBe(false);
    // Reported anyway — at ANY weight.
    expect(gate.summary).toContain('SLEEVE INFEASIBLE');
  });
});
