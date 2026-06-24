import { describe, it, expect } from 'vitest';
import type { ReversalShadowRecord } from './reversal-shadow-ledger.js';
import {
  computeLearnedWeights,
  reversalSignalMultiplier,
  hardGateMultiplier,
  shrunkMultiplier,
  globalPriorRate,
  THIN_BUCKET_CEIL,
  DEFAULT_LEARNED_PARAMS,
} from './learned-signal-weights.js';

let seq = 0;
/** Build a resolved ledger row with a given outcome and realized R. */
function row(
  over: Partial<ReversalShadowRecord> & Pick<ReversalShadowRecord, 'outcome'>,
): ReversalShadowRecord {
  seq += 1;
  return {
    id: `SYM:long:${seq}`,
    ts: seq,
    symbol: 'SPY',
    side: 'long',
    atKeyLevel: true,
    trendBreak: true,
    unhealthyMove: true,
    pattern: true,
    patternName: 'hammer',
    score: 4,
    zoneTouches: 2,
    entry: 100,
    stop: 99,
    target: 103,
    realizedR: over.outcome === 'TP_HIT' ? 3 : over.outcome === 'SL_HIT' ? -1 : 0,
    barsToResolution: 5,
    resolvedAt: seq,
    ...over,
  };
}

/** N rows: `wins` TP_HIT (R=+3) then the rest SL_HIT (R=-1). */
function bucket(n: number, wins: number, over: Partial<ReversalShadowRecord> = {}): ReversalShadowRecord[] {
  return Array.from({ length: n }, (_, i) =>
    row({ outcome: i < wins ? 'TP_HIT' : 'SL_HIT', ...over }),
  );
}

describe('computeLearnedWeights', () => {
  it('stays neutral below the min-sample guard', () => {
    const rows = bucket(DEFAULT_LEARNED_PARAMS.minSamples - 1, 9); // even a perfect record
    const w = computeLearnedWeights(rows);
    const s4 = w.byScore.find((s) => s.key === '4')!;
    expect(s4.resolved).toBe(DEFAULT_LEARNED_PARAMS.minSamples - 1);
    expect(s4.confident).toBe(false);
    expect(s4.multiplier).toBe(1);
  });

  it('up-weights a confident bucket that hits above baseline', () => {
    const rows = bucket(20, 16); // 80% hit rate, avg R = (16*3 - 4)/20 = +2.2
    const w = computeLearnedWeights(rows);
    const s4 = w.byScore.find((s) => s.key === '4')!;
    expect(s4.confident).toBe(true);
    expect(s4.hitRate).toBeCloseTo(0.8, 5);
    // 1 + 1.0*(0.8 - 0.5) = 1.3, no negative-R penalty.
    expect(s4.multiplier).toBeCloseTo(1.3, 5);
  });

  it('down-weights and applies the expectancy penalty when wins are rare and R is negative', () => {
    const rows = bucket(20, 4); // 20% hit rate, avg R = (4*3 - 16)/20 = -0.2
    const w = computeLearnedWeights(rows);
    const s4 = w.byScore.find((s) => s.key === '4')!;
    expect(s4.hitRate).toBeCloseTo(0.2, 5);
    expect(s4.avgR).toBeCloseTo(-0.2, 5);
    // 1 + (0.2-0.5) + 0.1*(-0.2) = 1 - 0.3 - 0.02 = 0.68
    expect(s4.multiplier).toBeCloseTo(0.68, 5);
  });

  it('clamps multipliers to [floor, ceil]', () => {
    const rows = bucket(20, 20); // 100% hit rate -> raw 1.5; OK at ceil
    const w = computeLearnedWeights(rows);
    expect(w.byScore.find((s) => s.key === '4')!.multiplier).toBe(DEFAULT_LEARNED_PARAMS.ceil);
  });

  it('excludes OPEN rows from resolved stats but counts them in total', () => {
    const rows = [...bucket(10, 8), row({ outcome: 'OPEN', realizedR: undefined, resolvedAt: undefined })];
    const w = computeLearnedWeights(rows);
    const s4 = w.byScore.find((s) => s.key === '4')!;
    expect(s4.total).toBe(11);
    expect(s4.resolved).toBe(10);
  });

  it('buckets a leg-4-absent setup under the "none" pattern key', () => {
    const rows = bucket(10, 8, { pattern: false, patternName: null, score: 3 });
    const w = computeLearnedWeights(rows);
    expect(w.byPattern.find((s) => s.key === 'none')).toBeDefined();
    expect(w.byPattern.find((s) => s.key === 'hammer')).toBeUndefined();
  });
});

describe('reversalSignalMultiplier', () => {
  it('multiplies confident dimensions and clamps the product', () => {
    // score=4 and symbol=SPY both confident & up-weighted; pattern hammer too.
    const w = computeLearnedWeights(bucket(20, 16));
    const m = reversalSignalMultiplier(w, { score: 4, pattern: 'hammer', symbol: 'SPY' });
    // Three dims each 1.3 -> 2.197, clamped to ceil 1.5.
    expect(m).toBe(DEFAULT_LEARNED_PARAMS.ceil);
  });

  it('treats unseen / non-confident dimensions as neutral', () => {
    const w = computeLearnedWeights(bucket(5, 5)); // below min-sample -> neutral
    const m = reversalSignalMultiplier(w, { score: 4, pattern: 'doji', symbol: 'QQQ' });
    expect(m).toBe(1);
  });
});

// ── TRA-1056 (TRA-1041c L3) cold-start weak-prior shrinkage ──────────────────

const P = DEFAULT_LEARNED_PARAMS;

describe('hardGateMultiplier', () => {
  it('is neutral below the min-sample guard regardless of record', () => {
    expect(hardGateMultiplier({ resolved: 9, hits: 9, rate: 1, avgR: 3 }, P)).toBe(1);
  });

  it('reproduces the legacy hit-rate driver once confident', () => {
    // 1 + 1.0*(0.8 - 0.5) = 1.3, no negative-R penalty.
    expect(hardGateMultiplier({ resolved: 20, hits: 16, rate: 0.8, avgR: 2.2 }, P)).toBeCloseTo(1.3, 5);
  });
});

describe('globalPriorRate', () => {
  const isResolved = (r: ReversalShadowRecord) => r.outcome !== 'OPEN';
  const isHit = (r: ReversalShadowRecord) => r.outcome === 'TP_HIT';

  it('is null when the global pool itself is below the min-sample guard', () => {
    expect(globalPriorRate(bucket(9, 9), isResolved, isHit, P)).toBeNull();
  });

  it('is the pooled hit-rate once the pool clears the guard', () => {
    expect(globalPriorRate(bucket(20, 14), isResolved, isHit, P)).toBeCloseTo(0.7, 5);
  });
});

describe('shrunkMultiplier', () => {
  it('falls back to neutral 1.0 when there is no reliable prior (no prior-on-prior)', () => {
    expect(shrunkMultiplier({ resolved: 5, hits: 5, rate: 1, avgR: 3 }, null, P)).toBe(1);
  });

  it('a confident bucket (resolved >> k) converges to the empirical hard-gate value', () => {
    const stats = { resolved: 1000, hits: 800, rate: 0.8, avgR: 2.2 };
    const shrunk = shrunkMultiplier(stats, 0.5, P); // prior far from empirical
    const hard = hardGateMultiplier(stats, P);
    // posterior = (10*0.5 + 800)/1010 = 0.79703 -> 1.297, within 0.01 of hard 1.3.
    expect(shrunk).toBeCloseTo(1.297, 3);
    expect(Math.abs(shrunk - hard)).toBeLessThan(0.01);
  });

  it('tapers the ceil to 1.25 while the bucket is thin, even on a perfect prior', () => {
    // posterior = (10*1 + 3)/13 = 1.0 -> raw 1.5, but resolved 3 < minSamples.
    expect(shrunkMultiplier({ resolved: 3, hits: 3, rate: 1, avgR: 3 }, 1.0, P)).toBe(THIN_BUCKET_CEIL);
  });

  it('lifts the ceil back to the full 1.5 once the bucket is confident', () => {
    // posterior = (10*1 + 10)/20 = 1.0 -> raw 1.5, resolved 10 >= minSamples.
    expect(shrunkMultiplier({ resolved: 10, hits: 10, rate: 1, avgR: 3 }, 1.0, P)).toBe(P.ceil);
  });

  it('keeps the avgR expectancy penalty bucket-local (empirical, never shrunk)', () => {
    // posterior = (10*0.6 + 14)/30 = 0.6667; rGuard = 0.1*(-0.5) = -0.05.
    // 1 + (0.6667 - 0.5) - 0.05 = 1.1167, using the bucket's OWN negative avgR.
    expect(shrunkMultiplier({ resolved: 20, hits: 14, rate: 0.7, avgR: -0.5 }, 0.6, P)).toBeCloseTo(1.1167, 4);
  });
});

describe('computeLearnedWeights — shrinkage wiring', () => {
  it('exposes the global prior and BOTH multipliers per bucket', () => {
    const w = computeLearnedWeights(bucket(20, 14));
    expect(w.generatedFrom.priorRate).toBeCloseTo(0.7, 5);
    const s4 = w.byScore.find((s) => s.key === '4')!;
    // multiplier mirrors the hard gate (deterministic, flag-independent fold).
    expect(s4.multiplier).toBe(s4.multiplierHardGate);
    expect(s4.multiplierHardGate).toBeCloseTo(1.2, 5); // 1 + (0.7-0.5)
    expect(s4.multiplierShrunk).toBeGreaterThan(0);
  });

  it('reports a null prior when the whole ledger is below the guard', () => {
    const w = computeLearnedWeights(bucket(5, 5));
    expect(w.generatedFrom.priorRate).toBeNull();
    // No reliable prior -> every shrunk multiplier is neutral.
    expect(w.byScore.every((s) => s.multiplierShrunk === 1)).toBe(true);
  });

  it('is deterministic — same rows in, same weights out', () => {
    const rows = [...bucket(20, 14), ...bucket(7, 5, { score: 3 })];
    expect(computeLearnedWeights(rows)).toEqual(computeLearnedWeights(rows));
  });
});

describe('reversalSignalMultiplier — flag-gated shrinkage switch', () => {
  // A confident score=3 pool provides the prior; a thin score=4 bucket is gated to
  // neutral under the hard gate but earns a shrunk weight under the prior.
  const rows = [
    ...bucket(20, 14, { score: 3, symbol: 'OTHER', patternName: 'hammer' }),
    ...bucket(4, 4, { score: 4, symbol: 'OTHER', patternName: 'doji' }),
  ];
  const w = computeLearnedWeights(rows);
  // Query isolates the score dim: pattern/symbol are absent -> skipped both ways.
  const sig = { score: 4, pattern: null, symbol: 'NOPE' };

  it('hard-gate (flag OFF) leaves a thin bucket neutral', () => {
    expect(reversalSignalMultiplier(w, sig, false)).toBe(1);
  });

  it('shrinkage (flag ON) lets the thin bucket contribute its shrunk weight', () => {
    const s4 = w.byScore.find((s) => s.key === '4')!;
    expect(s4.confident).toBe(false);
    expect(s4.multiplierShrunk).toBeGreaterThan(1);
    expect(reversalSignalMultiplier(w, sig, true)).toBe(s4.multiplierShrunk);
  });
});
