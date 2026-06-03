import { describe, it, expect } from 'vitest';
import { partitionData } from './data-partition.js';
import { syntheticCryptoSeries } from './synthetic.js';
import { BacktestRunner } from './runner.js';
import type { Candle } from '@trading-app/shared';

function series(days: number): Candle[] {
  // ~6 4H bars/day; this gives plenty of bars to partition.
  return syntheticCryptoSeries(days, 'BTC-USD', 30_000, 240, 31);
}

describe('partitionData (spec §3)', () => {
  it('splits into optimization / gap / holdout with a purge+embargo gap', () => {
    const candles = series(400);
    const p = partitionData(candles, { optimizationFraction: 0.7, warmupBars: 250, embargoBars: 5 });

    expect(p.boundaries.gapBars).toBe(255);
    expect(p.boundaries.optBars).toBe(Math.floor(candles.length * 0.7));
    // No overlap and a real chronological gap between the segments.
    expect(p.boundaries.optEndTs).toBeLessThan(p.boundaries.holdoutStartTs);
    // Segments + gap reconstruct the whole series.
    expect(p.boundaries.optBars + p.boundaries.gapBars + p.boundaries.holdoutBars)
      .toBe(candles.length);
  });

  it('throws when the series is too short to partition', () => {
    const candles = series(20); // far fewer bars than the 255-bar gap needs
    expect(() => partitionData(candles, { warmupBars: 250, embargoBars: 5 })).toThrow();
  });

  it('the optimization segment contains NO holdout bars (chronological fence)', () => {
    const candles = series(400);
    const p = partitionData(candles);
    const holdout = p.openHoldout();
    const optMaxTs = Math.max(...p.optimization.map(c => c.timestamp));
    const holdoutMinTs = Math.min(...holdout.map(c => c.timestamp));
    // Every optimization bar is strictly before every holdout bar, with a gap.
    expect(optMaxTs).toBeLessThan(holdoutMinTs);
    const optSet = new Set(p.optimization.map(c => c.timestamp));
    expect(holdout.some(c => optSet.has(c.timestamp))).toBe(false);
  });

  it('FAILS the leak check if holdout bars are read during optimization', async () => {
    const candles = series(400);
    const p = partitionData(candles);

    // Simulate a full optimization phase: a runner sweep over ONLY the
    // optimization segment. The holdout vault must stay untouched.
    const runner = new BacktestRunner();
    await runner.run(
      {
        symbol: 'BTC-USD',
        startDate: p.optimization[0].timestamp,
        endDate: p.optimization[p.optimization.length - 1].timestamp,
        initialEquity: 25_000,
        strategyType: 'reversal',
        reversalOpts: { enforceTimeFilter: false },
      },
      p.optimization,
    );

    // The whole point of the vault: optimization never opened the holdout.
    expect(p.holdoutAccessCount).toBe(0);
  });

  it('releases the holdout exactly once and throws on a second look', () => {
    const candles = series(400);
    const p = partitionData(candles);
    expect(p.holdoutAccessCount).toBe(0);
    const bars = p.openHoldout();
    expect(bars.length).toBeGreaterThan(0);
    expect(p.holdoutAccessCount).toBe(1);
    expect(() => p.openHoldout()).toThrow(/exactly once|already consumed/i);
  });
});
