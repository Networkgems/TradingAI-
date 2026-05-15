import { describe, it, expect } from 'vitest';
import { scoreSymbols } from './premarket-watchlist.js';
import type { EodReport } from '@trading-app/shared';
import type { ScanResult } from './market-scanner.js';

/**
 * TRA-368 — coverage for the smart-watchlist scorer. The fan-out / per-user
 * flow is exercised end-to-end by the index.ts integration; here we lock in
 * the merge + rank semantics that decide which symbols the engine sees at
 * the open.
 */

function fakeEod(overrides: Partial<EodReport> = {}): EodReport {
  return {
    date: '2026-05-13',
    generatedAt: Date.now(),
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: 0,
    optionsPnl: 0,
    combinedPnl: 0,
    totalEquity: 100_000,
    managedEquity: 50_000,
    availableCash: 50_000,
    trades: [],
    openPositionCount: 0,
    winRate: 0,
    avgRR: 0,
    totalTrades: 0,
    winners: 0,
    losers: 0,
    expectancy: 0,
    maxDrawdown: 0,
    sharpeRatio: 0,
    top5Movers: [],
    signalAccuracy: { totalSignals: 0, winningSignals: 0, winRate: 0, avgRR: 0 },
    markdown: '',
    ...overrides,
  };
}

describe('scoreSymbols (TRA-368)', () => {
  it('returns an empty list when no inputs are present', () => {
    expect(scoreSymbols(null, [])).toEqual([]);
  });

  it('scores pre-market scanner sources by source weight', () => {
    const scan: ScanResult[] = [
      { symbol: 'AAA', reason: 'gainer', changePct: 8 },   // weight 4
      { symbol: 'BBB', reason: 'volume', volume: 1e9 },    // weight 3
      { symbol: 'CCC', reason: 'trending' },               // weight 1
    ];
    const ranked = scoreSymbols(null, scan);
    expect(ranked.map(r => r.symbol)).toEqual(['AAA', 'BBB', 'CCC']);
    expect(ranked[0]?.score).toBe(4);
    expect(ranked[2]?.score).toBe(1);
  });

  it('boosts symbols that appear in both post-market review and pre-market scan', () => {
    const eod = fakeEod({
      top5Movers: [
        { symbol: 'AAA', price: 100, changePct: 5 },  // +5 eod_mover
      ],
    });
    const scan: ScanResult[] = [
      { symbol: 'AAA', reason: 'gainer', changePct: 7 },  // +4 gainer
      { symbol: 'BBB', reason: 'gainer', changePct: 9 },  // +4 gainer
    ];
    const ranked = scoreSymbols(eod, scan);
    expect(ranked[0]?.symbol).toBe('AAA');
    expect(ranked[0]?.score).toBe(9);
    expect(ranked[0]?.sources).toContain('eod_mover');
    expect(ranked[0]?.sources).toContain('gainer');
  });

  it('propagates symbols the engine traded yesterday', () => {
    const eod = fakeEod({
      trades: [
        {
          id: 't1',
          symbol: 'XYZ',
          strategy: 'ORB',
          side: 'buy',
          entryPrice: 10,
          exitPrice: 11,
          quantity: 100,
          pnl: 100,
          rr: 1,
          openedAt: 0,
          closedAt: 0,
        },
      ],
    });
    const ranked = scoreSymbols(eod, []);
    expect(ranked.map(r => r.symbol)).toEqual(['XYZ']);
    expect(ranked[0]?.sources).toEqual(['eod_traded']);
  });

  it('deduplicates the same symbol within a single source', () => {
    // Yahoo's screeners can return the same name in multiple buckets — the
    // scorer should fold those into a single entry rather than double-count.
    const scan: ScanResult[] = [
      { symbol: 'AAA', reason: 'gainer', changePct: 5 },
      { symbol: 'AAA', reason: 'gainer', changePct: 5 },
    ];
    const ranked = scoreSymbols(null, scan);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.score).toBe(8); // two `gainer` hits = 4 + 4
    expect(ranked[0]?.sources).toEqual(['gainer']);
  });

  it('normalizes symbol case so mixed-case inputs collide on the same entry', () => {
    const eod = fakeEod({
      top5Movers: [{ symbol: 'aaa', price: 100, changePct: 5 }],
    });
    const scan: ScanResult[] = [{ symbol: 'AAA', reason: 'gainer', changePct: 7 }];
    const ranked = scoreSymbols(eod, scan);
    expect(ranked.length).toBe(1);
    expect(ranked[0]?.symbol).toBe('AAA');
  });
});
