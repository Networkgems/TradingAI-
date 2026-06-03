import { describe, it, expect } from 'vitest';
import {
  normalCdf,
  normalPpf,
  sampleMoments,
  probabilisticSharpeRatio,
  expectedMaxSharpe,
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
} from './overfitting-stats.js';

// Mulberry32 — same generator the bootstrap/synthetic modules use, inlined so
// the PBO matrix tests are fully seeded and reproducible.
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('normal distribution helpers', () => {
  it('Φ matches known quantiles', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(2.326348)).toBeCloseTo(0.99, 4);
  });

  it('Φ⁻¹ matches known quantiles', () => {
    expect(normalPpf(0.5)).toBeCloseTo(0, 6);
    expect(normalPpf(0.975)).toBeCloseTo(1.959964, 4);
    expect(normalPpf(0.9)).toBeCloseTo(1.281552, 4);
    expect(normalPpf(0.025)).toBeCloseTo(-1.959964, 4);
  });

  it('Φ and Φ⁻¹ round-trip', () => {
    for (const p of [0.05, 0.2, 0.5, 0.8, 0.95]) {
      expect(normalCdf(normalPpf(p))).toBeCloseTo(p, 4);
    }
  });
});

describe('sampleMoments', () => {
  it('computes mean and sample std (ddof=1)', () => {
    const m = sampleMoments([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(m.mean).toBeCloseTo(5, 10);
    // sample std of this classic dataset is exactly √(32/7) ≈ 2.13809.
    expect(m.std).toBeCloseTo(Math.sqrt(32 / 7), 6);
  });

  it('reports near-zero skew and ~3 kurtosis for a symmetric set', () => {
    const m = sampleMoments([-2, -1, 0, 1, 2]);
    expect(m.skew).toBeCloseTo(0, 10);
    // Non-excess kurtosis of a symmetric 5-point uniform-ish set is 1.7 (< 3).
    expect(m.kurtosis).toBeLessThan(3);
  });
});

describe('probabilisticSharpeRatio (G2 core)', () => {
  it('matches the closed-form Φ(z) for skew=0, kurt=3', () => {
    // z = 0.1·√100 / √(1 + (3-1)/4·0.01) = 1/√1.005 = 0.997509 → Φ ≈ 0.84075.
    const psr = probabilisticSharpeRatio(0.1, 0, 101, 0, 3);
    expect(psr).toBeCloseTo(normalCdf(1 / Math.sqrt(1.005)), 6);
    expect(psr).toBeCloseTo(0.84075, 4);
  });

  it('is 0.5 when the observed Sharpe equals the benchmark', () => {
    expect(probabilisticSharpeRatio(0.2, 0.2, 50, 0, 3)).toBeCloseTo(0.5, 6);
  });

  it('rises with more observations (n) at fixed Sharpe gap', () => {
    const lo = probabilisticSharpeRatio(0.15, 0, 30, 0, 3);
    const hi = probabilisticSharpeRatio(0.15, 0, 300, 0, 3);
    expect(hi).toBeGreaterThan(lo);
  });

  it('negative skew and fat tails depress the PSR', () => {
    const benign = probabilisticSharpeRatio(0.2, 0, 100, 0, 3);
    const ugly = probabilisticSharpeRatio(0.2, 0, 100, -1.5, 8);
    expect(ugly).toBeLessThan(benign);
  });
});

describe('expectedMaxSharpe (DSR deflation benchmark)', () => {
  it('is 0 with fewer than two trials or zero variance', () => {
    expect(expectedMaxSharpe(1, 1)).toBe(0);
    expect(expectedMaxSharpe(0, 50)).toBe(0);
  });

  it('matches the published closed form for N=10, Var=1', () => {
    // SR*(10) = (1-γ)·Φ⁻¹(0.9) + γ·Φ⁻¹(1-1/(10e)) ≈ 1.575.
    expect(expectedMaxSharpe(1, 10)).toBeCloseTo(1.575, 2);
  });

  it('grows with the number of trials (multiple-testing inflation)', () => {
    expect(expectedMaxSharpe(1, 100)).toBeGreaterThan(expectedMaxSharpe(1, 10));
  });
});

describe('deflatedSharpeRatio (G2 guard)', () => {
  it('passes a strong, low-trial-spread strategy', () => {
    // Tight positive-mean returns, only a handful of near-identical trials.
    const returns = Array.from({ length: 200 }, (_, i) => 0.4 + 0.05 * Math.sin(i));
    const trialSharpes = [1.9, 2.0, 2.1, 1.95, 2.05];
    const r = deflatedSharpeRatio({ returns, trialSharpes });
    expect(r.observedSharpe).toBeGreaterThan(0);
    expect(r.sharpeStar).toBeGreaterThan(0);
    expect(r.pass).toBe(true);
    expect(r.psr).toBeGreaterThan(0.95);
  });

  it('fails when the trial spread inflates the benchmark above the observed Sharpe', () => {
    const returns = Array.from({ length: 60 }, (_, i) => 0.05 + 0.5 * Math.sin(i));
    // Wildly dispersed Sharpes across 500 trials → large SR*(N).
    const trialSharpes = Array.from({ length: 40 }, (_, i) => -2 + 0.1 * i);
    const r = deflatedSharpeRatio({ returns, trialSharpes, trialCount: 500 });
    expect(r.sharpeStar).toBeGreaterThan(r.observedSharpe);
    expect(r.pass).toBe(false);
  });
});

describe('probabilityOfBacktestOverfitting (G3 / CSCV)', () => {
  it('reports PBO≈0 when one trial dominates every observation', () => {
    // 4 trials × 12 observations; trial 0 is best everywhere → never overfit.
    const matrix = [
      Array.from({ length: 12 }, () => 1.0),
      Array.from({ length: 12 }, () => 0.5),
      Array.from({ length: 12 }, () => 0.2),
      Array.from({ length: 12 }, () => -0.1),
    ];
    const r = probabilityOfBacktestOverfitting({ matrix, partitions: 6 });
    expect(r.combinations).toBe(20); // C(6,3)
    expect(r.partitions).toBe(6);
    expect(r.pbo).toBe(0);
    expect(r.pass).toBe(true);
  });

  it('auto-reduces S to an even number ≤ observation count', () => {
    const matrix = [
      [1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1],
    ];
    const r = probabilityOfBacktestOverfitting({ matrix, partitions: 16 });
    expect(r.partitions).toBe(4); // largest even ≤ 5
    expect(r.combinations).toBe(6); // C(4,2)
  });

  it('reports a high PBO for a pure curve-fit matrix (IS winner is OOS loser)', () => {
    // Each trial spikes on exactly one observation and is flat-negative
    // elsewhere: whatever wins in-sample paid its spike there and slumps OOS.
    const T = 8;
    const N = 8;
    const matrix: number[][] = [];
    for (let t = 0; t < N; t++) {
      const row = Array.from({ length: T }, () => -0.1);
      row[t % T] = 5; // its single lucky observation
      matrix.push(row);
    }
    const r = probabilityOfBacktestOverfitting({ matrix, partitions: 8 });
    expect(r.pbo).toBeGreaterThan(0.5);
    expect(r.pass).toBe(false);
  });

  it('lands near 0.5 for a seeded pure-noise matrix', () => {
    const rand = mulberry32(12345);
    const N = 10;
    const T = 12;
    const matrix = Array.from({ length: N }, () =>
      Array.from({ length: T }, () => rand() - 0.5),
    );
    const r = probabilityOfBacktestOverfitting({ matrix, partitions: 8 });
    expect(r.pbo).toBeGreaterThan(0.2);
    expect(r.pbo).toBeLessThan(0.8);
    expect(r.lambdas).toHaveLength(r.combinations);
  });
});
