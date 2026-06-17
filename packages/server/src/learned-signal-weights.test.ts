import { describe, it, expect } from 'vitest';
import type { ReversalShadowRecord } from './reversal-shadow-ledger.js';
import {
  computeLearnedWeights,
  reversalSignalMultiplier,
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
