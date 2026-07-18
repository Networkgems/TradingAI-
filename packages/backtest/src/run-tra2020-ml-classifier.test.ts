import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  computeFeatureBundle,
  featureVectorAt,
  labelAt,
  translateToR,
  FEATURE_COUNT,
  LABEL_HORIZON,
  CLASS_UP,
  CLASS_DOWN,
} from './tra2020-ml-features.js';
import { MultinomialLogReg, ShallowGBM, Standardizer, softmax, argmax } from './tra2020-ml-models.js';
import { runAll, profileFor, renderReport } from './run-tra2020-ml-classifier.js';

// ── deterministic synthetic bars (self-contained; no network) ────────────────
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCandles(bars: number, seed = 42): Candle[] {
  const rand = mulberry32(seed);
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < bars; i++) {
    const ret = 0.0005 + Math.sin(i / 20) * 0.008 + (rand() - 0.5) * 0.02;
    const prev = price;
    price = Math.max(1, price * (1 + ret));
    out.push({
      symbol: 'TEST',
      timestamp: Date.UTC(2023, 0, 1) + i * 24 * 60 * 60 * 1000,
      open: prev,
      high: Math.max(prev, price) * (1 + rand() * 0.006),
      low: Math.min(prev, price) * (1 - rand() * 0.006),
      close: price,
      volume: 1_000_000 + Math.floor(rand() * 500_000),
    });
  }
  return out;
}

describe('TRA-2024 ML features — no-lookahead invariant (highest-risk leak)', () => {
  const candles = makeCandles(160);
  const T = 100;

  it('featureVectorAt(T) is a full 16-vector once indicators are warm', () => {
    const v = featureVectorAt(candles, T);
    expect(v).not.toBeNull();
    expect(v!).toHaveLength(FEATURE_COUNT);
    for (const x of v!) expect(Number.isFinite(x)).toBe(true);
  });

  it('mutating ANY bar > T leaves the feature vector at T byte-identical', () => {
    const before = featureVectorAt(candles, T)!;
    // Corrupt every future bar dramatically — a leak would move the T vector.
    const mutated = candles.map((c, i) =>
      i > T
        ? { ...c, open: c.open * 3, high: c.high * 3, low: c.low * 0.2, close: c.close * 3, volume: c.volume * 9 }
        : c,
    );
    const after = featureVectorAt(mutated, T)!;
    expect(after).toEqual(before);

    // The batch path must agree with the leak-proof reference AND be causal too.
    const batch = computeFeatureBundle(candles).features[T]!;
    expect(batch).toEqual(before);
    const batchMutated = computeFeatureBundle(mutated).features[T]!;
    expect(batchMutated).toEqual(before);
  });

  it('is not vacuous: mutating bar T itself DOES change the T vector', () => {
    const before = featureVectorAt(candles, T)!;
    const mutated = candles.map((c, i) => (i === T ? { ...c, close: c.close * 1.05, high: c.high * 1.05 } : c));
    const after = featureVectorAt(mutated, T)!;
    expect(after).not.toEqual(before);
  });

  it('label reads only forward data (T+1..T+H) and classifies by the vol band', () => {
    const bundle = computeFeatureBundle(candles);
    const lab = labelAt(bundle, T, LABEL_HORIZON);
    expect(lab).not.toBeNull();
    expect([0, 1, 2]).toContain(lab!.cls);
    // Mutating a bar at/after T+H+1 must NOT change the label (only T+1..T+H matter).
    const mutated = candles.map((c, i) => (i > T + LABEL_HORIZON ? { ...c, close: c.close * 2 } : c));
    const lab2 = labelAt(computeFeatureBundle(mutated), T, LABEL_HORIZON);
    expect(lab2!.cls).toBe(lab!.cls);
  });
});

describe('TRA-2024 net-of-fee R translation (pre-reg §6)', () => {
  const bundle = computeFeatureBundle(makeCandles(160));

  it('subtracts round-trip slippage so a flat move is negative net R', () => {
    // With zero slippage the cost term vanishes; with 5bps it must be strictly worse.
    const t = 100;
    const gross = translateToR(bundle, t, 1, 0, LABEL_HORIZON);
    const net = translateToR(bundle, t, 1, 5, LABEL_HORIZON);
    expect(gross).not.toBeNull();
    expect(net).not.toBeNull();
    expect(net!).toBeLessThan(gross!);
  });

  it('returns null when the H-bar forward window runs off the end', () => {
    const n = bundle.closes.length;
    expect(translateToR(bundle, n - 1, 1, 5, LABEL_HORIZON)).toBeNull();
  });
});

describe('TRA-2024 ML models — deterministic + learn a separable signal', () => {
  it('softmax + argmax are stable and normalized', () => {
    const p = softmax([1, 2, 3]);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 12);
    expect(argmax(p)).toBe(2);
  });

  // A cleanly separable 3-class problem: class is decided by feature 0's sign/mag.
  function separable(seed: number): { X: number[][]; y: number[] } {
    const rand = mulberry32(seed);
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 0; i < 150; i++) {
      const cls = i % 3;
      const base = cls === CLASS_DOWN ? -2 : cls === CLASS_UP ? 2 : 0;
      X.push([base + (rand() - 0.5) * 0.3, (rand() - 0.5) * 0.1]);
      y.push(cls);
    }
    return { X, y };
  }

  it('logistic regression is deterministic and separates the classes', () => {
    const { X, y } = separable(7);
    const scaler = Standardizer.fit(X);
    const Xs = scaler.transform(X);
    const m1 = MultinomialLogReg.fit(Xs, y, { C: 1.0, epochs: 200 });
    const m2 = MultinomialLogReg.fit(Xs, y, { C: 1.0, epochs: 200 });
    // Determinism: identical predictions on the same inputs.
    for (const row of Xs) expect(m1.predictClass(row)).toBe(m2.predictClass(row));
    // Accuracy on train ≥ 90% on a cleanly separable problem.
    const acc = Xs.filter((row, i) => m1.predictClass(row) === y[i]).length / Xs.length;
    expect(acc).toBeGreaterThan(0.9);
  });

  it('shallow GBM is deterministic and separates the classes', () => {
    const { X, y } = separable(11);
    const m1 = ShallowGBM.fit(X, y, { nEstimators: 40 });
    const m2 = ShallowGBM.fit(X, y, { nEstimators: 40 });
    for (const row of X) expect(m1.predictClass(row)).toBe(m2.predictClass(row));
    const acc = X.filter((row, i) => m1.predictClass(row) === y[i]).length / X.length;
    expect(acc).toBeGreaterThan(0.9);
  });
});

describe('TRA-2024 --smoke wiring — full pipeline end-to-end', () => {
  it('produces a stamped-shape verdict with the five §8 pass-bar booleans', async () => {
    const verdict = await runAll(profileFor('smoke-deterministic'));

    expect(verdict.mode).toBe('smoke-deterministic');
    expect(verdict.features).toHaveLength(FEATURE_COUNT);
    expect(verdict.config.trials).toHaveLength(5);

    // Walk-forward + PBO wiring populated.
    expect(verdict.walkForward.byTrial).toHaveLength(5);
    expect(verdict.pbo.pbo).toBeGreaterThanOrEqual(0);
    expect(verdict.pbo.pbo).toBeLessThanOrEqual(1);

    // Holdout: one-shot access held, blessed model present, 5 model rows + B1.
    expect(verdict.holdout.accessCountsOk).toBe(true);
    expect(verdict.holdout.models).toHaveLength(5);
    expect(verdict.holdout.blessed).toBeDefined();
    expect(typeof verdict.holdout.marginVsB1).toBe('number');

    // All five §8 booleans + the mechanical AND exist and are booleans.
    for (const k of ['b1Margin', 'pbo', 'psr', 'sampleN', 'stability', 'mechanicalAll'] as const) {
      expect(typeof verdict.passBar[k]).toBe('boolean');
    }

    // Report renders and carries the non-grading disclaimer + the bar.
    const md = renderReport(verdict);
    expect(md).toContain('PRE-REGISTERED PASS/KILL BAR');
    expect(md).toContain('does not pronounce the official');
  }, 120_000);
});
