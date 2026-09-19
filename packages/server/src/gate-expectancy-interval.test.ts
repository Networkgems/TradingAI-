import { describe, it, expect } from 'vitest';
import {
  buildExpectancyInterval,
  computeExpectancySeEstimates,
  cr1ClusterSe,
  type ExpectancyIntervalObservation,
  type ExpectancySeEstimates,
} from './gate-expectancy-interval.js';
import { evaluateLiveCapitalGate, LIVE_CAPITAL_GATE } from './live-capital-gate.js';
import { buildForwardTestReport, type ForwardTestReport } from './options-forward-test.js';
import { isoWeek } from './options-idea-journal.js';
import { debitWinner } from './gate-sleeve-blocking-fixtures.js';

// TRA-4735 (CFO ruling TRA-4734) — `positive_expectancy` grades FAIL when the 2σ upper
// bound (SE_eff = max of iid + three CR1 cluster-robust SEs) is below the bar, and
// UNDERPOWERED only when the interval straddles it.

/**
 * The live bqb1 graded book, `/api/health/options-ideas-journal?status=resolved`,
 * `excluded: false` rows, pulled 2026-09-19 (c94a5debce35).
 * `[pnlNetR, resolvedAt, surfacedWeek, ticker]`.
 */
const LIVE_63: ReadonlyArray<readonly [number, string, string, string]> = [
  [-1.14, '2026-07-17', '2026-W24', 'DIA'],
  [-0.02, '2026-07-17', '2026-W24', 'INTC'],
  [-0.01, '2026-07-10', '2026-W24', 'GOOGL'],
  [0.02, '2026-07-02', '2026-W24', 'MSFT'],
  [0.05, '2026-07-10', '2026-W24', 'AVGO'],
  [-0.01, '2026-07-17', '2026-W24', 'MSFT'],
  [0, '2026-07-17', '2026-W24', 'AAPL'],
  [-0.01, '2026-07-17', '2026-W24', 'AMZN'],
  [-0.01, '2026-07-17', '2026-W25', 'AMZN'],
  [-0.01, '2026-07-17', '2026-W25', 'MSFT'],
  [-0.05, '2026-07-17', '2026-W25', 'XLF'],
  [-0.02, '2026-07-17', '2026-W25', 'TSLA'],
  [-0.04, '2026-07-17', '2026-W25', 'AAPL'],
  [-0.01, '2026-07-17', '2026-W25', 'AMZN'],
  [0, '2026-07-17', '2026-W25', 'GOOGL'],
  [0, '2026-07-10', '2026-W25', 'AAPL'],
  [-0.09, '2026-07-10', '2026-W25', 'DIA'],
  [-0.01, '2026-07-17', '2026-W25', 'PYPL'],
  [0.14, '2026-07-17', '2026-W25', 'PYPL'],
  [-0.82, '2026-07-17', '2026-W25', 'PYPL'],
  [0, '2026-07-17', '2026-W25', 'MSFT'],
  [0.45, '2026-07-10', '2026-W25', 'CRM'],
  [0.06, '2026-07-10', '2026-W25', 'AMZN'],
  [0.05, '2026-07-17', '2026-W25', 'GOOGL'],
  [0.19, '2026-07-10', '2026-W25', 'XYZ'],
  [-0.09, '2026-07-17', '2026-W25', 'NVDA'],
  [-0.02, '2026-07-17', '2026-W25', 'NVDA'],
  [0.01, '2026-07-17', '2026-W25', 'AMD'],
  [-0.02, '2026-07-17', '2026-W25', 'DIA'],
  [-0.02, '2026-07-17', '2026-W25', 'NVDA'],
  [-0.02, '2026-07-17', '2026-W25', 'AAPL'],
  [-0.02, '2026-07-17', '2026-W26', 'META'],
  [-0.02, '2026-07-17', '2026-W26', 'MSFT'],
  [-0.09, '2026-07-17', '2026-W26', 'XLF'],
  [0.08, '2026-07-24', '2026-W26', 'DIA'],
  [-0.02, '2026-08-21', '2026-W26', 'AAPL'],
  [0, '2026-07-17', '2026-W26', 'AMZN'],
  [0.01, '2026-07-17', '2026-W26', 'MSTR'],
  [0.01, '2026-07-17', '2026-W26', 'AMD'],
  [-0.02, '2026-07-17', '2026-W26', 'AMZN'],
  [-0.01, '2026-07-17', '2026-W26', 'DIA'],
  [-0.01, '2026-07-17', '2026-W26', 'AMZN'],
  [-0.01, '2026-07-17', '2026-W26', 'AAPL'],
  [0.23, '2026-07-17', '2026-W26', 'XLF'],
  [0.05, '2026-07-17', '2026-W26', 'XLF'],
  [-0.08, '2026-08-21', '2026-W26', 'NFLX'],
  [-0.01, '2026-07-24', '2026-W26', 'DIA'],
  [-1.14, '2026-07-24', '2026-W26', 'AMZN'],
  [-1.13, '2026-08-21', '2026-W26', 'GOOGL'],
  [-0.08, '2026-08-21', '2026-W26', 'NFLX'],
  [-1.09, '2026-08-21', '2026-W26', 'GOOGL'],
  [-1.11, '2026-08-21', '2026-W27', 'AMZN'],
  [0.26, '2026-08-21', '2026-W27', 'INTC'],
  [-0.21, '2026-07-24', '2026-W27', 'NFLX'],
  [0, '2026-08-21', '2026-W28', 'AAPL'],
  [0.07, '2026-08-21', '2026-W28', 'COIN'],
  [0.03, '2026-08-21', '2026-W28', 'INTC'],
  [-0.01, '2026-08-21', '2026-W28', 'NVDA'],
  [1.3, '2026-08-21', '2026-W28', 'COIN'],
  [-0.02, '2026-08-07', '2026-W29', 'DIA'],
  [0.93, '2026-08-14', '2026-W30', 'PYPL'],
  [0.65, '2026-09-18', '2026-W35', 'ADBE'],
  [-1.05, '2026-09-18', '2026-W35', 'ORCL'],
];

const liveObs = (): ExpectancyIntervalObservation[] =>
  LIVE_63.map(([x, r, s, t]) => ({ x, resolvedWeek: isoWeek(r), surfacedWeek: s, ticker: t }));

/** The live bar: cost-aware gate on, safety margin 0.10R. */
const BAR = 0.1;
const CRITERIA = { ...LIVE_CAPITAL_GATE, minExpectancyR: BAR };

/**
 * A report stub carrying only what the gate reads. The power inputs are the live
 * σ ≈ 0.43 at n=63 — n_req in the hundreds — so the book is UNPOWERED unless a
 * test says otherwise; the ceiling is healthy so feasibility never interferes.
 */
function reportWith(
  est: ExpectancySeEstimates | undefined,
  over: { resolved?: number; weeks?: number; expectancyNetR?: number; powered?: boolean; ceilingNetR?: number } = {},
): ForwardTestReport {
  const n = over.resolved ?? est?.n ?? 63;
  const sigma = over.powered ? 0.3 : 0.43;
  const nPower = over.powered ? 4000 : n;
  const obs = { n: nPower, c: 0.0366, sigmaSample: sigma };
  return {
    asOfDate: '2026-09-19',
    totals: {
      weeksWithResolved: over.weeks ?? 8,
      weeksPositiveExpectancyNet: 2,
      popCalibrationGap: 0.13,
      resolved: over.powered ? 4000 : n,
      expectancyNetR: over.expectancyNetR ?? (est?.mean == null ? null : Math.round(est.mean * 100) / 100),
      powerInputs: {
        pooled: obs,
        byStructure: [{ key: 'bull_put_spread', weight: 1, ...obs }],
        byPremiumDirection: [{ key: 'credit', weight: 1, ...obs }],
      },
      expectancySe: est,
      maxLossBreaches: 0,
      avgCostR: 0.05,
      ceilingGrossR: (over.ceilingNetR ?? 1.95) + 0.05,
      ceilingNetR: over.ceilingNetR ?? 1.95,
      ceilingGrossRPriced: (over.ceilingNetR ?? 1.95) + 0.05,
      ceilingSourceCounts: { priced_structure: n, sketch_capped: 0, unusable: 0 },
    },
  } as unknown as ForwardTestReport;
}

const expectancy = (r: ReturnType<typeof evaluateLiveCapitalGate>) =>
  r.criteria.find((c) => c.name === 'positive_expectancy')!;

const synthetic = (mean: number, se: number, n = 63): ExpectancySeEstimates => ({
  n,
  mean,
  seIid: se,
  seClusterResolvedWeek: se,
  seClusterSurfacedWeek: se,
  seClusterTicker: se,
  clusters: { resolvedWeek: 8, surfacedWeek: 8, ticker: 20 },
});

describe('SE estimators reproduce the CFO working (TRA-4734, 2026-09-19 ~20:23Z)', () => {
  it('n=63, mean −0.0629, iid 0.0538, resolvedWeek 0.0363 (G=8), surfacedWeek 0.0556 (G=8), ticker 0.0561 (G=20)', () => {
    const e = computeExpectancySeEstimates(liveObs());
    expect(e.n).toBe(63);
    expect(e.mean!).toBeCloseTo(-0.0629, 4);
    expect(e.seIid!).toBeCloseTo(0.0538, 4);
    expect(e.seClusterResolvedWeek!).toBeCloseTo(0.0363, 4);
    expect(e.seClusterSurfacedWeek!).toBeCloseTo(0.0556, 4);
    expect(e.seClusterTicker!).toBeCloseTo(0.0561, 4);
    expect(e.clusters).toEqual({ resolvedWeek: 8, surfacedWeek: 8, ticker: 20 });
    const i = buildExpectancyInterval(e, BAR);
    expect(i.seEff).toBeCloseTo(0.0561, 4);
    expect(i.upper2Sigma!).toBeCloseTo(0.0493, 4);
    expect(i.upperBelowBar).toBe(true);
  });

  it('CR1 is null below two clusters', () => {
    expect(cr1ClusterSe([1, 2, 3], ['a', 'a', 'a'])).toEqual({ se: null, g: 1 });
  });
});

describe('positive_expectancy status (TRA-4735)', () => {
  it('(a) the live 63-row fixture grades FAIL, decided by the upper bound, and says so', () => {
    const r = evaluateLiveCapitalGate(reportWith(computeExpectancySeEstimates(liveObs())), CRITERIA);
    const c = expectancy(r);
    expect(r.power.powered).toBe(false);
    expect(c.status).toBe('FAIL');
    expect(c.pass).toBe(false);
    expect(r.expectancyInterval.decidedBy).toBe('upper_bound_below_bar');
    expect(r.expectancyInterval.barR).toBe(BAR);
    // sample_size keeps its truthful UNDERPOWERED label.
    expect(r.criteria.find((x) => x.name === 'sample_size')!.status).toBe('UNDERPOWERED');
    // The note + headline print the bound and the bar, and the right remedy.
    for (const text of [c.feasibilityNote!, r.summary]) {
      expect(text).toContain('+0.0493R');
      expect(text).toContain('0.1R bar');
      expect(text).toContain('More sample would only narrow an interval that already excludes the bar');
    }
    expect(r.summary.startsWith('FAIL')).toBe(true);
    expect(r.summary).not.toContain('MORE SAMPLE IS THE ONLY REMEDY');
    expect(c.feasibilityNote).not.toContain('coin flip');
  });

  it('(b) a straddling interval (mean 0.08, SE 0.05) grades UNDERPOWERED', () => {
    const r = evaluateLiveCapitalGate(reportWith(synthetic(0.08, 0.05)), CRITERIA);
    expect(expectancy(r).status).toBe('UNDERPOWERED');
    expect(r.expectancyInterval.upper2Sigma).toBeCloseTo(0.18, 4);
    expect(r.expectancyInterval.decidedBy).toBeNull();
    expect(r.summary).toContain('MORE SAMPLE IS THE ONLY REMEDY');
  });

  it('(c) a mean above the bar without power grades UNDERPOWERED, never PASS', () => {
    const r = evaluateLiveCapitalGate(reportWith(synthetic(0.3, 0.02)), CRITERIA);
    expect(expectancy(r).status).toBe('UNDERPOWERED');
    expect(expectancy(r).pass).toBe(false);
    expect(r.expectancyInterval.lower2Sigma!).toBeGreaterThan(BAR);
  });

  it('(d) G=1 on any clustering grades UNDERPOWERED (fail-closed to no verdict)', () => {
    const oneWeek = liveObs().map((o) => ({ ...o, resolvedWeek: '2026-W30' }));
    const r = evaluateLiveCapitalGate(reportWith(computeExpectancySeEstimates(oneWeek)), CRITERIA);
    expect(r.expectancyInterval.seClusterResolvedWeek).toBeNull();
    expect(r.expectancyInterval.seEff).toBeNull();
    expect(expectancy(r).status).toBe('UNDERPOWERED');
  });

  it('(e) INFEASIBLE still wins over an interval FAIL', () => {
    const r = evaluateLiveCapitalGate(
      reportWith(computeExpectancySeEstimates(liveObs()), { ceilingNetR: 0.01 }),
      CRITERIA,
    );
    expect(r.feasibility.verdict).toBe('infeasible');
    expect(expectancy(r).status).toBe('INFEASIBLE');
    expect(r.expectancyInterval.decidedBy).toBeNull();
    expect(r.expectancyInterval.upperBelowBar).toBe(true); // the working is still published
  });

  it('the hard floors hold: n < 30 or weeks < 8 cannot FAIL on the interval', () => {
    const est = synthetic(-0.3, 0.02, 20);
    expect(expectancy(evaluateLiveCapitalGate(reportWith(est), CRITERIA)).status).toBe('UNDERPOWERED');
    const est2 = synthetic(-0.3, 0.02);
    expect(
      expectancy(evaluateLiveCapitalGate(reportWith(est2, { weeks: 7 }), CRITERIA)).status,
    ).toBe('UNDERPOWERED');
  });

  it('absent estimates (legacy report) and a degenerate σ̂ never FAIL', () => {
    expect(
      expectancy(evaluateLiveCapitalGate(reportWith(undefined, { expectancyNetR: -0.5 }), CRITERIA)).status,
    ).toBe('UNDERPOWERED');
    expect(expectancy(evaluateLiveCapitalGate(reportWith(synthetic(-0.5, 0)), CRITERIA)).status).toBe(
      'UNDERPOWERED',
    );
  });

  it('PASS is unchanged: powered ∧ measured pass, decidedBy "powered"', () => {
    const r = evaluateLiveCapitalGate(reportWith(synthetic(0.3, 0.005, 4000), { powered: true }), CRITERIA);
    expect(r.power.powered).toBe(true);
    expect(expectancy(r).status).toBe('PASS');
    expect(r.expectancyInterval.decidedBy).toBe('powered');
  });

  it('pass === (status === "PASS") across every fixture', () => {
    const reports = [
      reportWith(computeExpectancySeEstimates(liveObs())),
      reportWith(synthetic(0.08, 0.05)),
      reportWith(synthetic(0.3, 0.02)),
      reportWith(synthetic(0.3, 0.005, 4000), { powered: true }),
      reportWith(synthetic(0.05, 0.005, 4000), { powered: true }),
    ];
    for (const rep of reports) {
      const c = expectancy(evaluateLiveCapitalGate(rep, CRITERIA));
      expect(c.pass).toBe(c.status === 'PASS');
    }
  });
});

describe('buildForwardTestReport wiring', () => {
  it('publishes expectancySe over the graded set, clustering resolved rows by ISO week of valuedAt', () => {
    const rows = Array.from({ length: 12 }, (_, i) =>
      debitWinner(i, {
        ticker: i % 3 === 0 ? 'SPY' : 'QQQ',
        valuedAt: i < 6 ? '2026-02-20' : '2026-02-27',
        pnlNetR: i % 2 ? 0.5 : -0.4,
      }),
    );
    const e = buildForwardTestReport([...rows, debitWinner(99, { excluded: true })]).totals.expectancySe!;
    expect(e.n).toBe(12);
    expect(e.clusters).toEqual({ resolvedWeek: 2, surfacedWeek: 8, ticker: 2 });
    expect(e.mean).toBeCloseTo(0.05, 10);
  });
});
