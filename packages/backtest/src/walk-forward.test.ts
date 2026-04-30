import { describe, it, expect } from 'vitest';
import { buildWindows, walkForward } from './walk-forward.js';
import { syntheticCryptoSeries } from './synthetic.js';
import type { BacktestConfig } from './types.js';

describe('buildWindows', () => {
  it('produces non-overlapping train/test slices when step = testBars (default)', () => {
    const windows = buildWindows(300, 60, 30);
    // Each origin = i*30, valid while origin + 60 + 30 ≤ 300 → origin ≤ 210 → 8 windows.
    expect(windows).toHaveLength(8);
    expect(windows[0]).toEqual({ trainStart: 0, trainEnd: 60, testStart: 60, testEnd: 90 });
    expect(windows[1]).toEqual({ trainStart: 30, trainEnd: 90, testStart: 90, testEnd: 120 });
    expect(windows[windows.length - 1].testEnd).toBeLessThanOrEqual(300);
  });

  it('returns no windows when the series is shorter than train+test', () => {
    expect(buildWindows(50, 60, 30)).toEqual([]);
    expect(buildWindows(89, 60, 30)).toEqual([]);
    expect(buildWindows(90, 60, 30)).toHaveLength(1);
  });

  it('honours custom step size', () => {
    const windows = buildWindows(300, 60, 30, 60);
    // origin advances by 60: 0, 60, 120, 180, 210 (210+60+30=300 ✓), 240+60+30=330 ✗
    expect(windows.map(w => w.trainStart)).toEqual([0, 60, 120, 180]);
  });

  it('keeps train and test windows contiguous (test starts at trainEnd)', () => {
    const windows = buildWindows(500, 100, 50);
    for (const w of windows) {
      expect(w.testStart).toBe(w.trainEnd);
      expect(w.trainEnd - w.trainStart).toBe(100);
      expect(w.testEnd - w.testStart).toBe(50);
    }
  });
});

// ── TRA-203 walkForward harness ───────────────────────────────────────────────

function reversalConfig(): BacktestConfig {
  return {
    symbol: 'BTC-USD',
    startDate: 0,
    endDate: Number.MAX_SAFE_INTEGER,
    initialEquity: 25_000,
    strategyType: 'reversal',
    reversalOpts: { enforceTimeFilter: false },
  };
}

describe('walkForward (TRA-203)', () => {
  it('produces one BacktestResult per rolling test window', async () => {
    const candles = syntheticCryptoSeries(30, 'BTC-USD', 30_000, 60, 31);
    const trainBars = 14 * 24;
    const testBars = 7 * 24;
    const expected = buildWindows(candles.length, trainBars, testBars);

    const report = await walkForward(reversalConfig(), candles, { trainBars, testBars });
    expect(report.windows).toHaveLength(expected.length);
    expect(expected.length).toBeGreaterThan(0);
  });

  it('respects stepBars for window cadence', async () => {
    const candles = syntheticCryptoSeries(30, 'BTC-USD', 30_000, 60, 31);
    const trainBars = 14 * 24;
    const testBars = 7 * 24;
    const stepBars = trainBars + testBars; // non-overlapping shifts
    const expected = buildWindows(candles.length, trainBars, testBars, stepBars);

    const report = await walkForward(reversalConfig(), candles, { trainBars, testBars, stepBars });
    expect(report.windows).toHaveLength(expected.length);
  });

  it('aggregate runs across the union of test slices and reports finite Sharpe + maxDD', async () => {
    const candles = syntheticCryptoSeries(45, 'BTC-USD', 30_000, 60, 31);
    const report = await walkForward(reversalConfig(), candles, {
      trainBars: 14 * 24,
      testBars: 7 * 24,
    });
    // Aggregate trade count can differ from the per-window sum in either
    // direction: indicators stay warm across slice boundaries so the
    // continuous run can catch signals an isolated window slice would miss
    // during warmup, and the runner's same-strategy already-open guard can
    // also suppress one. We only assert finiteness + sane bounds.
    expect(report.aggregate.totalTrades).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.maxDrawdown).toBeGreaterThanOrEqual(0);
    expect(report.aggregate.maxDrawdown).toBeLessThanOrEqual(1);
    expect(Number.isFinite(report.aggregate.sharpeRatio)).toBe(true);
    expect(Number.isFinite(report.aggregate.expectancy)).toBe(true);
  });

  it('returns an empty report when the series is shorter than train+test', async () => {
    const candles = syntheticCryptoSeries(5, 'BTC-USD', 30_000, 60, 31);
    const report = await walkForward(reversalConfig(), candles, {
      trainBars: 14 * 24,
      testBars: 7 * 24,
    });
    expect(report.windows).toHaveLength(0);
    expect(report.aggregate.totalTrades).toBe(0);
  });
});
