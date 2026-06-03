import { describe, it, expect } from 'vitest';
import { runOptimization, enumerateTrials, STRATEGY_SPECS } from './run-optimization.js';
import { syntheticCryptoSeries } from './synthetic.js';

describe('enumerateTrials', () => {
  it('builds the full Cartesian grid when it fits under maxTrials', () => {
    const trials = enumerateTrials(STRATEGY_SPECS.reversal);
    expect(trials).toHaveLength(9); // 3 rsiOverbought × 3 lookback
    // Coordinates are unique and labels are stable.
    const labels = new Set(trials.map((t) => t.label));
    expect(labels.size).toBe(9);
  });

  it('caps to maxTrials with a seeded sample for larger spaces', () => {
    const spec = { ...STRATEGY_SPECS.reversal, maxTrials: 4 };
    const a = enumerateTrials(spec, 7);
    const b = enumerateTrials(spec, 7);
    expect(a).toHaveLength(4);
    // Deterministic under the same seed.
    expect(a.map((t) => t.label)).toEqual(b.map((t) => t.label));
  });
});

describe('runOptimization end-to-end (synthetic)', () => {
  it('drives partition → sweep → walk-forward → 6 guards → holdout → verdict', async () => {
    // ~400 days of 4H bars so the optimization segment, 255-bar gap, and a
    // warmable (>250-bar) holdout all fit.
    const candles = syntheticCryptoSeries(400, 'BTC-USD', 30_000, 240, 31);
    const report = await runOptimization(STRATEGY_SPECS.reversal, candles, {
      symbol: 'BTC-USD',
      seed: 42,
      window: { trainDays: 20, testDays: 10, stepDays: 10 },
    });

    // Trial accounting (spec §5): N is recorded.
    expect(report.trialCount).toBe(9);

    // Partition is chronological with a real gap (spec §3).
    expect(report.partition.optEndTs).toBeLessThan(report.partition.holdoutStartTs);
    expect(report.partition.gapBars).toBe(255);

    // Walk-forward produced per-window rows.
    expect(report.windows.length).toBeGreaterThan(0);

    // All six guards present and evaluated.
    expect(report.guards.map((g) => g.id)).toEqual(['G1', 'G2', 'G3', 'G4', 'G5', 'G6']);
    for (const g of report.guards) {
      expect(typeof g.pass).toBe('boolean');
      expect(Number.isFinite(g.value)).toBe(true);
    }

    // Verdict PASS iff every guard passes.
    expect(report.verdict.pass).toBe(report.guards.every((g) => g.pass));

    // Verdict block carries the exact TRA-532 gate `backtest` field names.
    const m = report.verdict.backtestMetrics;
    expect(Object.keys(m).sort()).toEqual(
      ['expectancy', 'maxDrawdown', 'profitFactor', 'sharpe', 'tradeCount'].sort(),
    );
    expect(report.verdict.blessedParams).toHaveProperty('strategy', 'reversal');
  });
});
