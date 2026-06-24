import { describe, it, expect } from 'vitest';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { outcomeForR } from './option-trade-journal.js';
import {
  computeOptionLearnedWeights,
  optionSetupMultiplier,
  ivRankBand,
  sentimentBand,
  dteBand,
  sentimentIcBandKey,
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

  it('keys the TRA-993 sentiment-IC band, bucketing a missing grade under unknown', () => {
    expect(sentimentIcBandKey('strong')).toBe('strong');
    expect(sentimentIcBandKey('weak')).toBe('weak');
    expect(sentimentIcBandKey('none')).toBe('none');
    expect(sentimentIcBandKey(null)).toBe('unknown');
    expect(sentimentIcBandKey(undefined)).toBe('unknown');
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

  it('folds the TRA-993 sentiment-IC band as a 6th dimension; ungraded rows bucket under unknown', () => {
    // 20 graded `strong` rows (16 win) + 5 ungraded rows.
    const rows = [
      ...bucket(20, 16, { sentimentIcBand: 'strong' }),
      ...bucket(5, 5), // no sentimentIcBand -> 'unknown'
    ];
    const w = computeOptionLearnedWeights(rows);
    const strong = w.bySentimentIc.find((x) => x.key === 'strong')!;
    expect(strong.resolved).toBe(20);
    expect(strong.confident).toBe(true);
    const unknown = w.bySentimentIc.find((x) => x.key === 'unknown')!;
    expect(unknown.resolved).toBe(5);
    expect(unknown.confident).toBe(false); // below min-sample guard
  });

  it('keeps the TRA-993 sentiment-IC fold OUT of the decision multiplier (observe-only)', () => {
    // A confident, hugely up-weighted `strong` band must not move the product.
    const rows = bucket(20, 20, { sentimentIcBand: 'strong' });
    const w = computeOptionLearnedWeights(rows);
    expect(w.bySentimentIc.find((x) => x.key === 'strong')!.confident).toBe(true);
    // structure/ivRank/trend/sentiment/dte are all the SAME single bucket here,
    // each at ceil; the product clamps to ceil regardless of the IC band.
    const m = optionSetupMultiplier(w, {
      structure: 'bull_put',
      ivRank: 60,
      trend: 'up',
      sentiment: 0.4,
      dte: 38,
    });
    expect(m).toBe(DEFAULT_LEARNED_PARAMS.ceil);
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

// ── TRA-1056 (TRA-1041c L3) cold-start weak-prior shrinkage ──────────────────

describe('computeOptionLearnedWeights — shrinkage wiring', () => {
  it('exposes the global win-rate prior and BOTH multipliers per bucket', () => {
    const w = computeOptionLearnedWeights(bucket(20, 16));
    expect(w.generatedFrom.priorRate).toBeCloseTo(0.8, 5);
    const s = w.byStructure.find((x) => x.key === 'bull_put')!;
    expect(s.multiplier).toBe(s.multiplierHardGate);
    expect(s.multiplierHardGate).toBeCloseTo(1.3, 5);
    expect(s.multiplierShrunk).toBeGreaterThan(0);
  });

  it('reports a null prior (no prior-on-prior) when the journal is below the guard', () => {
    const w = computeOptionLearnedWeights(bucket(5, 5));
    expect(w.generatedFrom.priorRate).toBeNull();
    expect(w.byStructure.every((x) => x.multiplierShrunk === 1)).toBe(true);
  });

  it('is deterministic — same rows in, same weights out', () => {
    const rows = [...bucket(20, 16), ...bucket(7, 5, { structure: 'iron_condor' })];
    expect(computeOptionLearnedWeights(rows)).toEqual(computeOptionLearnedWeights(rows));
  });
});

describe('optionSetupMultiplier — flag-gated shrinkage switch', () => {
  // Confident bull_put pool provides the prior; a thin iron_condor bucket on an
  // ISOLATED regime (low IVR / down / bearish / gt45) is gated to neutral under the
  // hard gate but earns a shrunk weight once the prior exists.
  const rows = [
    ...bucket(20, 16), // bull_put / high / up / bullish / 30to45, confident
    ...bucket(4, 4, {
      structure: 'iron_condor',
      ivRank: 10, // low
      trend: 'down',
      sentiment: -0.5, // bearish
      entryDte: 60, // gt45
    }),
  ];
  const w = computeOptionLearnedWeights(rows);
  const setup = { structure: 'iron_condor', ivRank: 10, trend: 'down' as const, sentiment: -0.5, dte: 60 };

  it('hard-gate (flag OFF) leaves the thin regime neutral', () => {
    expect(optionSetupMultiplier(w, setup, false)).toBe(1);
  });

  it('shrinkage (flag ON) lets the thin regime contribute its shrunk weight', () => {
    const ic = w.byStructure.find((x) => x.key === 'iron_condor')!;
    expect(ic.confident).toBe(false);
    expect(ic.multiplierShrunk).toBeGreaterThan(1);
    // structure × ivRank(low) × trend(down) × sentiment(bearish) × dte(gt45) are all
    // the SAME thin iron_condor bucket, each at the tapered shrunk weight.
    const each = ic.multiplierShrunk;
    expect(optionSetupMultiplier(w, setup, true)).toBeCloseTo(
      Math.min(each * each * each * each * each, DEFAULT_LEARNED_PARAMS.ceil),
      5,
    );
  });
});
