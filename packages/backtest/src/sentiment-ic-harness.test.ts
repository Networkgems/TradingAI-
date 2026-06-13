import { describe, it, expect } from 'vitest';
import type { OptionChainRow } from '@trading-app/engine';
import {
  spearman,
  pearson,
  median,
  netOTMflow,
  daysBetween,
  rawForwardReturns,
  deMarket,
  isConfirmed,
  computeIc,
  bucketByQuintile,
  isMonotoneIncreasing,
  runSentimentStudy,
  type SentimentSymbolDay,
  type Horizon,
  type DatedBar,
} from './sentiment-ic-harness.js';

function chainRow(over: Partial<OptionChainRow>): OptionChainRow {
  return {
    optionSymbol: 'X',
    underlying: 'AAPL',
    optionType: 'call',
    strike: 100,
    expiration: '2026-02-01',
    volume: 0,
    ...over,
  };
}

function symbolDay(over: Partial<SentimentSymbolDay>): SentimentSymbolDay {
  return {
    date: '2026-01-05',
    symbol: 'AAPL',
    netScore: 0,
    tilt: 'neutral',
    taggedCount: 10,
    curatedCount: 0,
    messageCount: 20,
    freshnessMinutes: 30,
    netOTMflow: null,
    usable: true,
    fwd: { '1d': null, '5d': null, '20d': null },
    ...over,
  };
}

describe('primitive stats', () => {
  it('spearman is 1 for a monotone-increasing relation regardless of scale', () => {
    expect(spearman([1, 2, 3, 4], [10, 20, 35, 40])).toBeCloseTo(1, 10);
    expect(spearman([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10);
  });
  it('pearson/spearman return null on a zero-variance side', () => {
    expect(pearson([1, 1, 1], [1, 2, 3])).toBeNull();
    expect(spearman([5], [5])).toBeNull();
  });
  it('median handles even and odd lengths', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('netOTMflow', () => {
  it('is +1 when only OTM calls trade and −1 when only OTM puts trade', () => {
    const calls = [chainRow({ optionType: 'call', strike: 110, volume: 500 })];
    const puts = [chainRow({ optionType: 'put', strike: 90, volume: 500 })];
    expect(netOTMflow(calls, 100, '2026-01-05')).toBe(1);
    expect(netOTMflow(puts, 100, '2026-01-05')).toBe(-1);
  });
  it('ignores ITM contracts and contracts outside the DTE window', () => {
    const rows = [
      chainRow({ optionType: 'call', strike: 90, volume: 999 }), // ITM call — ignored
      chainRow({ optionType: 'call', strike: 110, volume: 100, expiration: '2026-01-10' }), // ~5 DTE — out of window
      chainRow({ optionType: 'call', strike: 110, volume: 300, expiration: '2026-02-01' }), // ~27 DTE — in window
      chainRow({ optionType: 'put', strike: 90, volume: 100, expiration: '2026-02-01' }),
    ];
    // in-window: calls 300, puts 100 → (300-100)/400 = 0.5
    expect(netOTMflow(rows, 100, '2026-01-05')).toBeCloseTo(0.5, 10);
  });
  it('returns null without a spot or without OTM volume', () => {
    expect(netOTMflow([chainRow({ strike: 110, volume: 100 })], null, '2026-01-05')).toBeNull();
    expect(netOTMflow([], 100, '2026-01-05')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts calendar days', () => {
    expect(daysBetween('2026-01-05', '2026-02-01')).toBe(27);
  });
});

describe('forward returns (no look-ahead)', () => {
  const bars: DatedBar[] = [
    { date: '2026-01-05', open: 100, close: 101 }, // t (signal day)
    { date: '2026-01-06', open: 102, close: 103 }, // t+1 (entry open = 102)
    { date: '2026-01-07', open: 104, close: 105 },
    { date: '2026-01-08', open: 106, close: 107 },
    { date: '2026-01-09', open: 108, close: 109 },
    { date: '2026-01-12', open: 110, close: 120 }, // t+5 (exit close = 120)
  ];
  it('enters at t+1 open and exits at the horizon close', () => {
    const out = rawForwardReturns(['2026-01-05'], bars);
    const rec = out.get('2026-01-05')!;
    expect(rec['1d']).toBeCloseTo(103 / 102 - 1, 10); // exit close day t+1
    expect(rec['5d']).toBeCloseTo(120 / 102 - 1, 10); // exit close day t+5
    expect(rec['20d']).toBeNull(); // not enough forward bars
  });
  it('de-markets by subtracting the equal-weight cohort mean', () => {
    const raw = new Map<string, Record<Horizon, number | null>>([
      ['2026-01-05|AAPL', { '1d': 0.04, '5d': null, '20d': null }],
      ['2026-01-05|MSFT', { '1d': 0.02, '5d': null, '20d': null }],
    ]);
    const adj = deMarket(raw);
    // cohort mean = 0.03 → AAPL +0.01, MSFT -0.01
    expect(adj.get('2026-01-05|AAPL')!['1d']).toBeCloseTo(0.01, 10);
    expect(adj.get('2026-01-05|MSFT')!['1d']).toBeCloseTo(-0.01, 10);
  });
});

describe('isConfirmed (S2 subset)', () => {
  it('requires same-sign netScore/flow above both floors', () => {
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: 0.3 }))).toBe(true);
    expect(isConfirmed(symbolDay({ netScore: -0.4, netOTMflow: -0.3 }))).toBe(true);
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: -0.3 }))).toBe(false); // disagree
    expect(isConfirmed(symbolDay({ netScore: 0.1, netOTMflow: 0.3 }))).toBe(false); // netScore below floor
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: 0.05 }))).toBe(false); // flow below floor
    expect(isConfirmed(symbolDay({ netScore: 0.4, netOTMflow: null }))).toBe(false); // no chain
  });
});

describe('computeIc', () => {
  it('recovers a strong positive cross-sectional relation', () => {
    // One day, 5 symbols where higher netScore ⇒ higher forward return.
    const days: SentimentSymbolDay[] = [0.1, 0.2, 0.3, 0.4, 0.5].map((s, i) =>
      symbolDay({
        symbol: `S${i}`,
        netScore: s,
        fwd: { '1d': s * 0.1, '5d': null, '20d': null },
      }),
    );
    const ic = computeIc(days);
    expect(ic['1d'].nDays).toBe(1);
    expect(ic['1d'].meanIC).toBeCloseTo(1, 10);
    expect(ic['1d'].pooledIC).toBeCloseTo(1, 10);
  });
  it('skips days narrower than the minimum cross-section', () => {
    const days = [
      symbolDay({ symbol: 'A', netScore: 0.1, fwd: { '1d': 0.01, '5d': null, '20d': null } }),
      symbolDay({ symbol: 'B', netScore: 0.2, fwd: { '1d': 0.02, '5d': null, '20d': null } }),
    ];
    expect(computeIc(days)['1d'].nDays).toBe(0);
  });
});

describe('bucketByQuintile + monotonicity', () => {
  it('produces 5 ascending-mean buckets for a monotone signal', () => {
    const days: SentimentSymbolDay[] = [];
    for (let i = 0; i < 50; i++) {
      const s = i / 50;
      days.push(symbolDay({ symbol: `S${i}`, netScore: s, fwd: { '1d': s, '5d': null, '20d': null } }));
    }
    const buckets = bucketByQuintile(days, '1d');
    expect(buckets).toHaveLength(5);
    expect(isMonotoneIncreasing(buckets)).toBe(true);
  });
});

describe('runSentimentStudy + §4 gate', () => {
  it('returns INCONCLUSIVE on an empty / too-small sample', () => {
    const report = runSentimentStudy([]);
    expect(report.verdict).toBe('INCONCLUSIVE');
    expect(report.sample.nTradingDays).toBe(0);
    expect(report.verdictReasons[0]).toMatch(/Sample below the §4 bar/);
  });

  it('counts usable vs buzz-only cohorts and never throws on a thin real-ish sample', () => {
    const days: SentimentSymbolDay[] = [
      symbolDay({ symbol: 'AAPL', taggedCount: 10, usable: true, fwd: { '1d': 0.01, '5d': null, '20d': null } }),
      symbolDay({ symbol: 'MSFT', taggedCount: 2, usable: false, fwd: { '1d': 0.02, '5d': null, '20d': null } }),
    ];
    const report = runSentimentStudy(days);
    expect(report.sample.nUsableSymbolDays).toBe(1);
    expect(report.sample.nBuzzOnlySymbolDays).toBe(1);
    expect(report.verdict).toBe('INCONCLUSIVE');
  });
});
