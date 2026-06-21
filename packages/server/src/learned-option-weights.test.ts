import { describe, it, expect } from 'vitest';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { outcomeForR } from './option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  optionSetupMultiplier,
  ivRankBand,
  sentimentBand,
  dteBand,
  DEFAULT_LEARNED_PARAMS,
} from './learned-option-weights.js';

let seq = 0;
/** Build a resolved journal row with a given outcome and realized R. */
function row(
  over: Partial<OptionTradeJournalRecord> & Pick<OptionTradeJournalRecord, 'outcome'>,
): OptionTradeJournalRecord {
  seq += 1;
  const realizedR =
    over.outcome === 'WIN' ? 2 : over.outcome === 'LOSS' ? -1 : 0;
  return {
    id: `SPY:bull_put:${seq}`,
    openTs: seq,
    symbol: 'SPY',
    structure: 'bull_put',
    mode: 'demo',
    ivRank: 60, // -> high
    trend: 'up',
    sentiment: 0.4, // -> bullish
    entryDelta: 0.25,
    entryDte: 38, // -> 30to45
    atRiskUsd: 100,
    closeTs: seq + 1,
    realizedPnlUsd: realizedR * 100,
    realizedR,
    exitReason: 'tp1',
    holdDays: 4,
    ...over,
  };
}

/** N rows: `wins` WIN (R=+2) then the rest LOSS (R=-1). */
function bucket(n: number, wins: number, over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord[] {
  return Array.from({ length: n }, (_, i) => row({ outcome: i < wins ? 'WIN' : 'LOSS', ...over }));
}

describe('bucket helpers', () => {
  it('bands IV-rank, sentiment, and DTE around the engine thresholds', () => {
    expect(ivRankBand(60)).toBe('high');
    expect(ivRankBand(40)).toBe('mid');
    expect(ivRankBand(10)).toBe('low');
    expect(sentimentBand(0.4)).toBe('bullish');
    expect(sentimentBand(-0.4)).toBe('bearish');
    expect(sentimentBand(0)).toBe('neutral');
    expect(sentimentBand(null)).toBe('neutral');
    expect(dteBand(20)).toBe('lt30');
    expect(dteBand(38)).toBe('30to45');
    expect(dteBand(60)).toBe('gt45');
  });

  it('classifies R into WIN/LOSS/SCRATCH with a scratch band', () => {
    expect(outcomeForR(0.5)).toBe('WIN');
    expect(outcomeForR(-0.5)).toBe('LOSS');
    expect(outcomeForR(0.05)).toBe('SCRATCH');
  });
});

describe('computeOptionLearnedWeights', () => {
  it('stays neutral below the min-sample guard', () => {
    const rows = bucket(DEFAULT_LEARNED_PARAMS.minSamples - 1, 9); // even a perfect record
    const w = computeOptionLearnedWeights(rows);
    const s = w.byStructure.find((x) => x.key === 'bull_put')!;
    expect(s.resolved).toBe(DEFAULT_LEARNED_PARAMS.minSamples - 1);
    expect(s.confident).toBe(false);
    expect(s.multiplier).toBe(1);
  });

  it('up-weights a confident structure that wins above baseline', () => {
    const rows = bucket(20, 16); // 80% win rate, avg R = (16*2 - 4)/20 = +1.4
    const w = computeOptionLearnedWeights(rows);
    const s = w.byStructure.find((x) => x.key === 'bull_put')!;
    expect(s.confident).toBe(true);
    expect(s.winRate).toBeCloseTo(0.8, 5);
    // 1 + 1.0*(0.8 - 0.5) = 1.3, no negative-R penalty.
    expect(s.multiplier).toBeCloseTo(1.3, 5);
  });

  it('down-weights and applies the expectancy penalty when wins are rare and R is negative', () => {
    const rows = bucket(20, 4); // 20% win rate, avg R = (4*2 - 16)/20 = -0.4
    const w = computeOptionLearnedWeights(rows);
    const s = w.byStructure.find((x) => x.key === 'bull_put')!;
    expect(s.winRate).toBeCloseTo(0.2, 5);
    expect(s.avgR).toBeCloseTo(-0.4, 5);
    // 1 + (0.2-0.5) + 0.1*(-0.4) = 1 - 0.3 - 0.04 = 0.66
    expect(s.multiplier).toBeCloseTo(0.66, 5);
  });

  it('clamps multipliers to [floor, ceil]', () => {
    const rows = bucket(20, 20); // 100% win rate -> raw 1.5; at ceil
    const w = computeOptionLearnedWeights(rows);
    expect(w.byStructure.find((x) => x.key === 'bull_put')!.multiplier).toBe(DEFAULT_LEARNED_PARAMS.ceil);
  });

  it('excludes OPEN rows from resolved stats but counts them in total', () => {
    const rows = [
      ...bucket(10, 8),
      row({ outcome: 'OPEN', realizedR: undefined, realizedPnlUsd: undefined, closeTs: undefined }),
    ];
    const w = computeOptionLearnedWeights(rows);
    const s = w.byStructure.find((x) => x.key === 'bull_put')!;
    expect(s.total).toBe(11);
    expect(s.resolved).toBe(10);
  });

  it('folds the same rows across every dimension', () => {
    const w = computeOptionLearnedWeights(bucket(20, 16));
    expect(w.byIvRank.find((x) => x.key === 'high')!.confident).toBe(true);
    expect(w.byTrend.find((x) => x.key === 'up')!.confident).toBe(true);
    expect(w.bySentiment.find((x) => x.key === 'bullish')!.confident).toBe(true);
    expect(w.byDte.find((x) => x.key === '30to45')!.confident).toBe(true);
  });
});

describe('optionSetupMultiplier', () => {
  it('multiplies confident dimensions and clamps the product', () => {
    // structure/ivRank/trend/sentiment/dte all confident & up-weighted (1.3 each).
    const w = computeOptionLearnedWeights(bucket(20, 16));
    const m = optionSetupMultiplier(w, {
      structure: 'bull_put',
      ivRank: 60,
      trend: 'up',
      sentiment: 0.4,
      dte: 38,
    });
    // Five dims each 1.3 -> 3.71, clamped to ceil 1.5.
    expect(m).toBe(DEFAULT_LEARNED_PARAMS.ceil);
  });

  it('treats unseen / non-confident dimensions as neutral', () => {
    const w = computeOptionLearnedWeights(bucket(5, 5)); // below min-sample -> neutral
    const m = optionSetupMultiplier(w, {
      structure: 'iron_condor',
      ivRank: 10,
      trend: 'down',
      sentiment: -0.5,
      dte: 60,
    });
    expect(m).toBe(1);
  });
});
