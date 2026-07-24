import { describe, it, expect } from 'vitest';
import {
  computeStrategyIntrospection,
  computePerformanceStats,
  optionJournalToStrategyRows,
  type IntrospectionOptions,
  type StrategyTradeRow,
} from './strategy-introspection.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// TRA-995 — the self-awareness layer: per-strategy attribution (P&L, expectancy,
// Sharpe, win-rate, by regime) + an edge-decay detector on a degrading strategy.

function row(
  strategy: string,
  closeTs: number,
  realizedR: number,
  regime: StrategyTradeRow['regime'] = 'trend_up',
): StrategyTradeRow {
  return { strategy, closeTs, realizedR, realizedPnlUsd: realizedR * 100, regime };
}

describe('computePerformanceStats', () => {
  it('returns null stats on an empty set', () => {
    const s = computePerformanceStats([]);
    expect(s.trades).toBe(0);
    expect(s.expectancy).toBeNull();
    expect(s.sharpe).toBeNull();
    expect(s.winRate).toBeNull();
  });

  it('computes expectancy, win-rate and Sharpe', () => {
    const rows = [row('s', 1, 2), row('s', 2, -1), row('s', 3, 2), row('s', 4, -1)];
    const s = computePerformanceStats(rows);
    expect(s.trades).toBe(4);
    expect(s.expectancy).toBeCloseTo(0.5, 6); // (2-1+2-1)/4
    expect(s.winRate).toBe(0.5);
    expect(s.realizedPnlUsd).toBeCloseTo(200, 6);
    expect(s.sharpe).not.toBeNull();
    expect(s.sharpe!).toBeGreaterThan(0);
  });

  it('returns null Sharpe when variance is zero', () => {
    const rows = [row('s', 1, 1), row('s', 2, 1)];
    expect(computePerformanceStats(rows).sharpe).toBeNull();
  });
});

describe('computeStrategyIntrospection — attribution', () => {
  it('attributes P&L per strategy and breaks down by regime', () => {
    const rows = [
      row('alpha', 1, 1, 'trend_up'),
      row('alpha', 2, 1, 'range'),
      row('beta', 3, -1, 'high_vol'),
    ];
    const out = computeStrategyIntrospection(rows);
    const alpha = out.strategies.find((s) => s.strategy === 'alpha')!;
    expect(alpha.trades).toBe(2);
    expect(alpha.realizedPnlUsd).toBeCloseTo(200, 6);
    expect(alpha.byRegime.map((r) => r.regime).sort()).toEqual(['range', 'trend_up']);
    // strategies sorted by trade count desc
    expect(out.strategies[0].strategy).toBe('alpha');
  });
});

describe('computeStrategyIntrospection — edge-decay detector', () => {
  const opts = { recentWindow: 5, minWindowTrades: 5 };

  it('flags a strategy whose previously-positive edge has turned negative', () => {
    const rows: StrategyTradeRow[] = [];
    // baseline: 5 winners (+1.5R)
    for (let i = 0; i < 5; i++) rows.push(row('decayer', i, 1.5));
    // recent: 5 losers (−1R)
    for (let i = 0; i < 5; i++) rows.push(row('decayer', 100 + i, -1));
    const out = computeStrategyIntrospection(rows, opts);
    const flag = out.edgeDecay.find((e) => e.strategy === 'decayer')!;
    expect(flag.degrading).toBe(true);
    expect(flag.baselineExpectancy).toBeCloseTo(1.5, 6);
    expect(flag.recentExpectancy).toBeCloseTo(-1, 6);
    expect(out.degradingStrategies).toContain('decayer');
  });

  it('flags a strategy whose edge has merely eroded below half of baseline', () => {
    const rows: StrategyTradeRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('fader', i, 2)); // baseline +2R
    for (let i = 0; i < 5; i++) rows.push(row('fader', 100 + i, 0.5)); // recent +0.5R < 1R
    const out = computeStrategyIntrospection(rows, opts);
    expect(out.edgeDecay.find((e) => e.strategy === 'fader')!.degrading).toBe(true);
  });

  it('does NOT flag a strategy whose edge is intact', () => {
    const rows: StrategyTradeRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('steady', i, 1.0));
    for (let i = 0; i < 5; i++) rows.push(row('steady', 100 + i, 1.2));
    const out = computeStrategyIntrospection(rows, opts);
    const flag = out.edgeDecay.find((e) => e.strategy === 'steady')!;
    expect(flag.degrading).toBe(false);
    expect(out.degradingStrategies).not.toContain('steady');
  });

  it('does NOT flag with too few trades to judge', () => {
    const rows = [row('thin', 1, 2), row('thin', 2, -2), row('thin', 3, -2)];
    const out = computeStrategyIntrospection(rows, opts);
    expect(out.edgeDecay.find((e) => e.strategy === 'thin')!.degrading).toBe(false);
  });

  it('does NOT flag a never-profitable strategy (nothing to decay from)', () => {
    const rows: StrategyTradeRow[] = [];
    for (let i = 0; i < 5; i++) rows.push(row('loser', i, -1));
    for (let i = 0; i < 5; i++) rows.push(row('loser', 100 + i, -1.5));
    const out = computeStrategyIntrospection(rows, opts);
    expect(out.edgeDecay.find((e) => e.strategy === 'loser')!.degrading).toBe(false);
  });
});

// TRA-2215 — CALIBRATION. The edge-decay detector hands a flagged strategy to
// `runRiskAutopilot`, which cuts the risk budget by 50%. A detector that fires on
// data containing no decay BY CONSTRUCTION is not an instrument, it is a coin
// flip — and because position size is not constant across the sample, it corrupts
// every forward-validation grade running through the book.
//
// The null: take a realistic fat-tailed R series and SHUFFLE ITS ORDER. Shuffling
// destroys any time trend (so "no decay" holds exactly) while preserving every
// other property of the distribution. A calibrated detector fires ~5% of the time.
//
// The shipped rule (recent = last 10, flag if recent < 0 or recent < baseline/2)
// measured 50.3% / 64.3% on the real live rows — see TRA-2215.

/** Deterministic PRNG (mulberry32) — no `Math.random`, so the suite cannot flake. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gaussian(rand: () => number): number {
  // Box-Muller. `1 - rand()` keeps the log argument off zero.
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * A realistic realized-R series: mostly scratches, with a fat two-sided tail.
 * Parameterised to reproduce the MEASURED first two moments of the live
 * populations (asserted below), because the whole question is whether the
 * decision boundary sits inside the noise of THIS distribution.
 */
function fatTailedRSeries(
  rand: () => number,
  n: number,
  p: { scratchProb: number; scratchSd: number; tailMean: number; tailSd: number },
): number[] {
  const out: number[] = [];
  for (let i = 0; i < n; i++) {
    out.push(
      rand() < p.scratchProb
        ? gaussian(rand) * p.scratchSd
        : p.tailMean + gaussian(rand) * p.tailSd,
    );
  }
  return out;
}

// Tuned so the realized sample moments match the live rows off a0f64a5791d0.
const RV_LIKE = { scratchProb: 0.83, scratchSd: 0.02, tailMean: 0.169, tailSd: 0.63 };
const OTM_LIKE = { scratchProb: 0.83, scratchSd: 0.05, tailMean: 0.248, tailSd: 1.9 };

function shuffled(xs: number[], rand: () => number): number[] {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
}

function rowsFromR(rs: number[], strategy = 'null_series'): StrategyTradeRow[] {
  return rs.map((r, i) => ({
    strategy,
    closeTs: i + 1,
    realizedR: r,
    realizedPnlUsd: r * 100,
    regime: 'unknown' as const,
  }));
}

/** Fraction of shuffled (= no-decay-by-construction) draws on which the detector fires. */
function falsePositiveRate(
  series: number[],
  seed: number,
  draws: number,
  opts?: IntrospectionOptions,
): number {
  const rand = mulberry32(seed);
  let fired = 0;
  for (let d = 0; d < draws; d++) {
    const out = computeStrategyIntrospection(rowsFromR(shuffled(series, rand)), opts);
    if (out.degradingStrategies.length > 0) fired++;
  }
  return fired / draws;
}

describe('edge-decay detector — false-positive rate under a shuffled null (TRA-2215)', () => {
  const DRAWS = 400;

  // The fixtures are only evidence if they actually look like the live book.
  it('the fixture series reproduce the measured live moments', () => {
    const rv = fatTailedRSeries(mulberry32(11), 1249, RV_LIKE);
    const otm = fatTailedRSeries(mulberry32(22), 1055, OTM_LIKE);
    const stats = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      const sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / xs.length);
      return { m, sd };
    };
    // live single_leg_rv:  n=1249  mean +0.0288  sd 0.270
    expect(stats(rv).m).toBeCloseTo(0.029, 1);
    expect(stats(rv).sd).toBeCloseTo(0.27, 1);
    // live single_leg_otm: n=1055  mean +0.0421  sd 0.699
    expect(stats(otm).m).toBeCloseTo(0.042, 1);
    expect(stats(otm).sd).toBeCloseTo(0.70, 1);
  });

  // The ceiling is the defect gate: this assertion measured 0.565 on the rule
  // shipped before TRA-2215. The floor is the liveness gate — a detector wired to
  // never fire would sail through a ceiling-only test, and "0 fires" is exactly
  // what a broken instrument and a calm market both look like. With a seeded PRNG
  // both bounds are deterministic, so neither can flake.
  it('fires on ~5% of no-decay draws — not 56% (rv-like series)', () => {
    const series = fatTailedRSeries(mulberry32(11), 1249, RV_LIKE);
    const fpr = falsePositiveRate(series, 101, DRAWS); // 0.0525
    expect(fpr).toBeLessThanOrEqual(0.1);
    expect(fpr).toBeGreaterThan(0);
  });

  it('fires on ~5% of no-decay draws — not 52% (otm-like, fatter tail)', () => {
    const series = fatTailedRSeries(mulberry32(22), 1055, OTM_LIKE);
    const fpr = falsePositiveRate(series, 202, DRAWS); // 0.0475
    expect(fpr).toBeLessThanOrEqual(0.1);
    expect(fpr).toBeGreaterThan(0);
  });

  // "That gap is the bug in one number" (TRA-2215). The shipped rule fired at
  // +0.0152R / +0.0082R — on the WRONG SIDE of zero, and so ~110-146% past the
  // 5% floor of the null it was supposed to be testing against.
  it('places the decision boundary BELOW zero, where the null 5% floor actually is', () => {
    const series = fatTailedRSeries(mulberry32(11), 1249, RV_LIKE);
    const out = computeStrategyIntrospection(rowsFromR(series));
    const flag = out.edgeDecay.find((e) => e.strategy === 'null_series')!;
    expect(flag.decayThresholdR).not.toBeNull();
    expect(flag.decayThresholdR!).toBeLessThan(0);
    // and it is reported, so the boundary is auditable in health/EOD
    expect(flag.reason).toContain(flag.decayThresholdR!.toFixed(4));
  });

  // Calibration is worthless if it is bought by never firing. An instrument whose
  // correct output is silence has to be PROVEN to fire on the thing it watches for.
  it('still fires on a real decay: a genuinely collapsed recent window', () => {
    const rand = mulberry32(33);
    const healthy = fatTailedRSeries(rand, 400, RV_LIKE);
    const collapsed = fatTailedRSeries(rand, 40, RV_LIKE).map((r) => r - 0.5);
    const out = computeStrategyIntrospection(rowsFromR([...healthy, ...collapsed]));
    const flag = out.edgeDecay.find((e) => e.strategy === 'null_series')!;
    expect(flag.degrading).toBe(true);
  });
});

describe('optionJournalToStrategyRows adapter', () => {
  it('keeps only closed rows and maps trend → regime', () => {
    const records: OptionTradeJournalRecord[] = [
      {
        id: '1',
        openTs: 1,
        symbol: 'AAPL',
        structure: 'bull_put',
        mode: 'demo',
        ivRank: 50,
        trend: 'up',
        sentiment: null,
        entryDelta: 0.3,
        entryDte: 30,
        atRiskUsd: 100,
        outcome: 'WIN',
        closeTs: 5,
        realizedPnlUsd: 80,
        realizedR: 0.8,
        exitReason: 'tp1',
        holdDays: 4,
      },
      {
        id: '2',
        openTs: 2,
        symbol: 'MSFT',
        structure: 'single_leg_rv',
        mode: 'demo',
        ivRank: 20,
        trend: 'down',
        sentiment: null,
        entryDelta: 0.5,
        entryDte: 20,
        atRiskUsd: 200,
        outcome: 'OPEN', // still open — dropped
      },
    ];
    const rows = optionJournalToStrategyRows(records);
    expect(rows).toHaveLength(1);
    // TRA-2215 — keyed structure::entryArchetype; this record carries no
    // archetype, so it lands in the explicit `unspecified` sleeve.
    expect(rows[0]).toMatchObject({
      strategy: 'bull_put::unspecified',
      realizedR: 0.8,
      regime: 'trend_up',
    });
  });

  // TRA-2215 / TRA-2193b — `structure` is a STRUCTURE LABEL, not a sleeve. Keyed
  // on the bare label, one spurious flag throttled all four sleeves sharing
  // `single_leg_rv`, and a real decay in one was diluted by the other three.
  it('separates sleeves that share a structure label', () => {
    const base = {
      openTs: 1,
      symbol: 'AAPL',
      mode: 'demo' as const,
      ivRank: 50,
      trend: 'up' as const,
      sentiment: null,
      entryDelta: 0.3,
      entryDte: 30,
      atRiskUsd: 100,
      outcome: 'WIN' as const,
      closeTs: 5,
      realizedPnlUsd: 80,
      realizedR: 0.8,
      exitReason: 'tp1',
      holdDays: 4,
      structure: 'single_leg_rv',
    };
    const records = [
      { ...base, id: 'a', entryArchetype: 'otm_delta_floor' },
      { ...base, id: 'b', entryArchetype: 'rv_band' },
    ] as OptionTradeJournalRecord[];
    const rows = optionJournalToStrategyRows(records);
    expect(rows.map((r) => r.strategy)).toEqual([
      'single_leg_rv::otm_delta_floor',
      'single_leg_rv::rv_band',
    ]);
    // …and therefore attribute as two independent cohorts, not one pooled blob.
    expect(computeStrategyIntrospection(rows).strategies).toHaveLength(2);
  });
});
