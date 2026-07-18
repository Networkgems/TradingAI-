import { describe, it, expect } from 'vitest';
import {
  DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG,
  blockBootstrapExpectancyCi,
  computeEffectiveSampleSize,
  evaluateShadowExpectancyGuard,
  type ShadowExpectancyGuardConfig,
  type ShadowExpectancySample,
} from './shadow-expectancy-guard.js';

/** N singleton-cluster signals (each its own trading episode → independent). */
function independentSamples(values: readonly number[]): ShadowExpectancySample[] {
  return values.map((netR, i) => ({ netR, clusterKey: `ep-${i}` }));
}

/**
 * `clusters` day/episode blocks, each holding the given net-R values. Signals in
 * the same block share a `clusterKey`, so they are treated as correlated.
 */
function clusteredSamples(clusters: readonly (readonly number[])[]): ShadowExpectancySample[] {
  const out: ShadowExpectancySample[] = [];
  clusters.forEach((vals, c) => {
    for (const netR of vals) out.push({ netR, clusterKey: `day-${c}` });
  });
  return out;
}

/** A comfortably, confidently positive independent sample (mean +0.3R, N=40). */
function positiveSample(): ShadowExpectancySample[] {
  // Alternate 0.2 / 0.4 so every bootstrap resample mean lands in [0.2, 0.4] —
  // the CI lower bound is > 0 regardless of the seed.
  return independentSamples(Array.from({ length: 40 }, (_, i) => (i % 2 === 0 ? 0.2 : 0.4)));
}

describe('computeEffectiveSampleSize', () => {
  it('effectiveN === rawN for independent (singleton-cluster) signals', () => {
    const s = independentSamples([0.1, -0.2, 0.3, 0.0, 0.5, -0.1]);
    const es = computeEffectiveSampleSize(s);
    expect(es.rawN).toBe(6);
    expect(es.clusterCount).toBe(6);
    expect(es.icc).toBe(0);
    expect(es.designEffect).toBe(1);
    expect(es.effectiveN).toBe(6);
  });

  it('effectiveN < rawN on a correlated fixture (within-cluster identical → ICC≈1)', () => {
    // 5 episodes × 10 identical-within values: perfectly correlated inside each
    // block, so the 50 raw rows collapse toward the 5 independent blocks.
    const clusters = [-0.2, -0.1, 0.0, 0.1, 0.2].map((v) => Array.from({ length: 10 }, () => v));
    const es = computeEffectiveSampleSize(clusteredSamples(clusters));
    expect(es.rawN).toBe(50);
    expect(es.clusterCount).toBe(5);
    expect(es.effectiveN).toBeLessThan(es.rawN); // the headline TRA-2036 property
    expect(es.icc).toBeGreaterThan(0.9);
    // With ICC≈1 and mean cluster size 10, design effect ≈ 10 → effectiveN ≈ 5.
    expect(es.effectiveN).toBeCloseTo(5, 1);
  });

  it('effectiveN ≈ rawN when multi-member clusters carry no intra-cluster correlation', () => {
    // 10 blocks × 4 rows, but each block spans the SAME spread of values, so
    // within-cluster variance ≈ between-cluster variance → ICC≈0 → little penalty.
    const clusters = Array.from({ length: 10 }, () => [-0.3, -0.1, 0.1, 0.3]);
    const es = computeEffectiveSampleSize(clusteredSamples(clusters));
    expect(es.rawN).toBe(40);
    expect(es.icc).toBeLessThan(0.05);
    expect(es.effectiveN).toBeGreaterThan(38);
  });

  it('clamps effectiveN to [clusterCount, rawN]', () => {
    const clusters = [-0.5, 0.5].map((v) => Array.from({ length: 20 }, () => v));
    const es = computeEffectiveSampleSize(clusteredSamples(clusters));
    expect(es.effectiveN).toBeGreaterThanOrEqual(es.clusterCount);
    expect(es.effectiveN).toBeLessThanOrEqual(es.rawN);
  });
});

describe('blockBootstrapExpectancyCi', () => {
  it('returns block-bootstrap bounds bracketing the point estimate on a real sample', () => {
    const ci = blockBootstrapExpectancyCi(positiveSample(), DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG);
    expect(ci.method).toBe('block-bootstrap');
    expect(ci.point).toBeCloseTo(0.3, 6);
    expect(ci.lo).toBeLessThanOrEqual(ci.point);
    expect(ci.hi).toBeGreaterThanOrEqual(ci.point);
    expect(ci.lo).toBeGreaterThan(0);
  });

  it('is deterministic for a fixed seed', () => {
    const a = blockBootstrapExpectancyCi(positiveSample(), DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG);
    const b = blockBootstrapExpectancyCi(positiveSample(), DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG);
    expect(a.lo).toBe(b.lo);
    expect(a.hi).toBe(b.hi);
  });

  it('is fail-closed (insufficient / NaN bounds) with < 2 clusters', () => {
    const ci = blockBootstrapExpectancyCi(
      clusteredSamples([[0.3, 0.3, 0.3, 0.3]]),
      DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG,
    );
    expect(ci.method).toBe('insufficient');
    expect(Number.isNaN(ci.lo)).toBe(true);
    expect(Number.isNaN(ci.hi)).toBe(true);
  });
});

describe('evaluateShadowExpectancyGuard', () => {
  const enforcing: ShadowExpectancyGuardConfig = { ...DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG, enforce: true };

  it('blocks a negative-expectancy candidate when enforcing', () => {
    // 40 independent signals averaging -0.2R (the shape of the frozen NO-GO
    // shadow ledger: net E[R] < 0).
    const sample = independentSamples(Array.from({ length: 40 }, () => -0.2));
    const v = evaluateShadowExpectancyGuard(sample, enforcing);
    expect(v.expectancyR).toBeCloseTo(-0.2, 6);
    expect(v.wouldBlock).toBe(true);
    expect(v.blocks).toBe(true); // enforcing → real block
    expect(v.reasons.join(' ')).toMatch(/net shadow E\[R]/);
  });

  it('does NOT block, but still reports the would-block decision, in observe-only mode', () => {
    const sample = independentSamples(Array.from({ length: 40 }, () => -0.2));
    const v = evaluateShadowExpectancyGuard(sample, DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG);
    expect(v.enforced).toBe(false);
    expect(v.wouldBlock).toBe(true); // observe still logs "would block: yes"
    expect(v.blocks).toBe(false); // …but contributes no promotion block
  });

  it('passes a confidently-positive, well-sampled candidate', () => {
    const v = evaluateShadowExpectancyGuard(positiveSample(), enforcing);
    expect(v.expectancyR).toBeGreaterThan(0);
    expect(v.ci.lo).toBeGreaterThan(0);
    expect(v.effectiveN).toBeGreaterThanOrEqual(DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG.minEffectiveN);
    expect(v.wouldBlock).toBe(false);
    expect(v.blocks).toBe(false);
    expect(v.reasons).toEqual([]);
  });

  it('is fail-closed on an empty sample', () => {
    const v = evaluateShadowExpectancyGuard([], enforcing);
    expect(v.rawN).toBe(0);
    expect(v.wouldBlock).toBe(true);
    expect(v.blocks).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/no shadow signals/);
  });

  it('is fail-closed when the effective sample is too thin after correlation adjustment', () => {
    // 100 raw signals but only 4 episodes, perfectly correlated within each →
    // effectiveN ≈ 4 ≪ minEffectiveN, even though the raw mean is positive.
    const clusters = [0.3, 0.3, 0.3, 0.3].map((v) => Array.from({ length: 25 }, () => v));
    const v = evaluateShadowExpectancyGuard(clusteredSamples(clusters), enforcing);
    expect(v.rawN).toBe(100);
    expect(v.effectiveN).toBeLessThan(DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG.minEffectiveN);
    expect(v.wouldBlock).toBe(true);
    expect(v.reasons.join(' ')).toMatch(/effective N/);
  });
});
