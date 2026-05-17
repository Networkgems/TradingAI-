import { describe, it, expect } from 'vitest';
import type { Position } from '@trading-app/shared';
import { bootstrapEquityCurves, blockBootstrapEquityCurves } from './bootstrap.js';

function mkTrade(pnl: number): Position {
  return {
    id: 'pos-' + Math.random().toString(36).slice(2),
    symbol: 'TEST',
    side: 'buy',
    signalType: 'orb_breakout',
    entryPrice: 100,
    quantity: 10,
    stopLoss: 99,
    takeProfit: 103,
    openedAt: 0,
    closedAt: 1,
    exitPrice: 100 + pnl / 10,
    pnl,
  };
}

describe('bootstrapEquityCurves', () => {
  it('returns flat bands at initial equity when there are no trades', () => {
    const bands = bootstrapEquityCurves([], 25_000, { iterations: 100, seed: 1 });
    expect(bands.p5).toBe(25_000);
    expect(bands.p50).toBe(25_000);
    expect(bands.p95).toBe(25_000);
    expect(bands.worstDrawdown).toBe(0);
    expect(bands.iterations).toBe(100);
  });

  it('produces deterministic bands for a fixed seed', () => {
    const trades = [mkTrade(50), mkTrade(-30), mkTrade(80), mkTrade(-20), mkTrade(40)];
    const a = bootstrapEquityCurves(trades, 1_000, { iterations: 500, seed: 42 });
    const b = bootstrapEquityCurves(trades, 1_000, { iterations: 500, seed: 42 });
    expect(a).toEqual(b);
  });

  it('orders the percentile band p5 ≤ p50 ≤ p95', () => {
    const trades = [mkTrade(40), mkTrade(-20), mkTrade(35), mkTrade(-25), mkTrade(50)];
    const bands = bootstrapEquityCurves(trades, 1_000, { iterations: 1000, seed: 7 });
    expect(bands.p5).toBeLessThanOrEqual(bands.p50);
    expect(bands.p50).toBeLessThanOrEqual(bands.p95);
  });

  it('records a positive worst-case drawdown when losses exist', () => {
    const trades = [mkTrade(50), mkTrade(-200), mkTrade(60)];
    const bands = bootstrapEquityCurves(trades, 1_000, { iterations: 200, seed: 3 });
    expect(bands.worstDrawdown).toBeGreaterThan(0);
    expect(bands.worstDrawdown).toBeLessThanOrEqual(1);
  });

  it('centres the median near the realised total when sample is large', () => {
    // Stable distribution: each iteration draws 10 PnLs, median should land
    // close to initialEquity + meanPnl × 10.
    const pnls = [10, -5, 15, -10, 20];
    const trades = pnls.map(mkTrade);
    const meanPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const expectedFinal = 1_000 + meanPnl * pnls.length;
    const bands = bootstrapEquityCurves(trades, 1_000, { iterations: 5_000, seed: 11 });
    // Loose tolerance — bootstrap median ≈ expected final ± a few %.
    expect(Math.abs(bands.p50 - expectedFinal) / expectedFinal).toBeLessThan(0.15);
  });
});

// ── TRA-420 §2: moving-block bootstrap ────────────────────────────────────────

describe('blockBootstrapEquityCurves', () => {
  it('returns flat bands at initial equity when there are no trades', () => {
    const bands = blockBootstrapEquityCurves([], 25_000, { iterations: 100, seed: 1 });
    expect(bands.p5).toBe(25_000);
    expect(bands.p50).toBe(25_000);
    expect(bands.p95).toBe(25_000);
    expect(bands.worstDrawdown).toBe(0);
    expect(bands.iterations).toBe(100);
  });

  it('produces deterministic bands for a fixed seed', () => {
    const trades = [mkTrade(50), mkTrade(-30), mkTrade(80), mkTrade(-20), mkTrade(40), mkTrade(-15)];
    const a = blockBootstrapEquityCurves(trades, 1_000, { iterations: 500, seed: 42, blockLength: 3 });
    const b = blockBootstrapEquityCurves(trades, 1_000, { iterations: 500, seed: 42, blockLength: 3 });
    expect(a).toEqual(b);
  });

  it('orders the percentile band p5 ≤ p50 ≤ p95', () => {
    const trades = [mkTrade(40), mkTrade(-20), mkTrade(35), mkTrade(-25), mkTrade(50), mkTrade(-10)];
    const bands = blockBootstrapEquityCurves(trades, 1_000, { iterations: 1000, seed: 7 });
    expect(bands.p5).toBeLessThanOrEqual(bands.p50);
    expect(bands.p50).toBeLessThanOrEqual(bands.p95);
  });

  it('records a positive worst-case drawdown when losses exist', () => {
    const trades = [mkTrade(50), mkTrade(-200), mkTrade(60)];
    const bands = blockBootstrapEquityCurves(trades, 1_000, { iterations: 200, seed: 3 });
    expect(bands.worstDrawdown).toBeGreaterThan(0);
    expect(bands.worstDrawdown).toBeLessThanOrEqual(1);
  });

  it('with blockLength=1 is identical to the IID bootstrap (single-trade blocks)', () => {
    // A block of length 1 draws one trade per pick, n picks per iteration —
    // exactly the IID resample. Same generator, same draw count → same result.
    const trades = [mkTrade(50), mkTrade(-30), mkTrade(80), mkTrade(-20), mkTrade(40)];
    const iid = bootstrapEquityCurves(trades, 1_000, { iterations: 500, seed: 42 });
    const block1 = blockBootstrapEquityCurves(trades, 1_000, { iterations: 500, seed: 42, blockLength: 1 });
    expect(block1).toEqual(iid);
  });

  it('defaults to block length 5 and centres the median near the realised total', () => {
    const pnls = [10, -5, 15, -10, 20, -8, 12, -6, 18, -4];
    const trades = pnls.map(mkTrade);
    const meanPnl = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const expectedFinal = 1_000 + meanPnl * pnls.length;
    const bands = blockBootstrapEquityCurves(trades, 1_000, { iterations: 5_000, seed: 11 });
    expect(Math.abs(bands.p50 - expectedFinal) / expectedFinal).toBeLessThan(0.2);
  });
});
