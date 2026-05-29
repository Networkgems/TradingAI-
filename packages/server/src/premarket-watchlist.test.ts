import { describe, it, expect } from 'vitest';
import { scoreSymbols, filterByPriceFloor } from './premarket-watchlist.js';
import type { EodReport } from '@trading-app/shared';
import { WATCHLIST, WATCHLIST_MIN_PRICE } from '@trading-app/shared';
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

/**
 * TRA-510 — micro-cap price floor on the smart watchlist. The QuantTrader
 * post-mortem (TRA-508) traced 5/5 demo stop-outs to `eod_mover` micro-caps
 * fed in by this generator — e.g. QTEX as a short at $2.7472 with a 24%
 * stop distance. The floor gates the sub-$5 cohort out before the
 * MAX_NEW_SYMBOLS cap so that legitimate higher-priced movers (a $60 NVDA
 * on a +15% gap) don't get crowded out by micro-caps that score equally
 * highly on the `eod_mover` source.
 */
describe('filterByPriceFloor (TRA-510)', () => {
  // Ensures the in-source default the issue specified matches what the rest
  // of the suite reasons about. If someone tunes WATCHLIST_MIN_PRICE later,
  // they must update the test scenarios accordingly.
  it('uses the $5 default floor exported from @trading-app/shared', () => {
    expect(WATCHLIST_MIN_PRICE).toBe(5);
  });

  it('drops a $2.10 EOD mover with reason "below_min_price"', async () => {
    // QTEX-style micro-cap: prior-day top-5 mover, source-score 5, but the
    // last close sits below the floor.
    const eod = fakeEod({
      top5Movers: [{ symbol: 'QTEX', price: 2.10, changePct: 18 }],
    });
    const ranked = scoreSymbols(eod, []);

    const { kept, dropped } = await filterByPriceFloor(
      ranked,
      eod,
      // Quote lookup should never be called: QTEX's price comes from the
      // EOD movers list, which is the cheap path the filter takes first.
      async () => { throw new Error('quote lookup should not be invoked when EOD carries the price'); },
    );

    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      { symbol: 'QTEX', price: 2.10, reason: 'below_min_price' },
    ]);
  });

  it('keeps a $50 mover above the floor', async () => {
    // NVDA-style large-cap: even on the same `eod_mover` source the engine
    // can absorb the per-bar volatility, so the floor must not gate it.
    const eod = fakeEod({
      top5Movers: [{ symbol: 'BIG', price: 50, changePct: 12 }],
    });
    const ranked = scoreSymbols(eod, []);

    const { kept, dropped } = await filterByPriceFloor(
      ranked,
      eod,
      async () => new Map(),
    );

    expect(kept.map(r => r.symbol)).toEqual(['BIG']);
    expect(dropped).toEqual([]);
  });

  it('falls back to the quote lookup when the symbol is not in the EOD movers', async () => {
    // Pre-market scanner sources (gainer/loser/volume/trending) carry no
    // price field, so the filter must call the batched quote helper for
    // exactly those symbols. We assert both branches in one shot:
    // - LOW @ $3.00 → dropped via the quote lookup
    // - HI  @ $80   → kept
    const scan: ScanResult[] = [
      { symbol: 'LOW', reason: 'gainer', changePct: 25 },
      { symbol: 'HI',  reason: 'gainer', changePct: 10 },
    ];
    const ranked = scoreSymbols(null, scan);

    let lookupCallCount = 0;
    const { kept, dropped } = await filterByPriceFloor(
      ranked,
      null,
      async (syms) => {
        lookupCallCount += 1;
        // The filter batches the lookup to a single call.
        expect(new Set(syms)).toEqual(new Set(['LOW', 'HI']));
        return new Map([
          ['LOW', { price: 3.00 }],
          ['HI',  { price: 80.00 }],
        ]);
      },
    );

    expect(lookupCallCount).toBe(1);
    expect(kept.map(r => r.symbol)).toEqual(['HI']);
    expect(dropped).toEqual([
      { symbol: 'LOW', price: 3.00, reason: 'below_min_price' },
    ]);
  });

  it('does not gate base-WATCHLIST symbols (they are excluded upstream before the filter sees them)', async () => {
    // Reproduce the caller pattern from generateSmartWatchlist: split the
    // ranked list into (base members, newcomers) BEFORE calling
    // filterByPriceFloor. Even if a base WATCHLIST symbol has collapsed
    // below $5, it must remain on the user's watchlist — the floor only
    // gates net-new entries, not the always-watched core.
    expect(WATCHLIST).toContain('AAPL'); // sanity: AAPL is a base member
    const eod = fakeEod({
      top5Movers: [
        // AAPL crashed to $4 (hypothetical): still a base watchlist symbol.
        { symbol: 'AAPL', price: 4.00, changePct: -30 },
        // QTEX micro-cap newcomer at $2.10: should be filtered.
        { symbol: 'QTEX', price: 2.10, changePct: 18 },
      ],
    });
    const ranked = scoreSymbols(eod, []);

    // Caller pattern: drop base symbols up front (see generateSmartWatchlist).
    const baseSet = new Set((WATCHLIST as readonly string[]).map(s => s.toUpperCase()));
    const newcomers = ranked.filter(r => !baseSet.has(r.symbol));

    const { kept, dropped } = await filterByPriceFloor(
      newcomers,
      eod,
      async () => new Map(),
    );

    // AAPL never appears in the filter inputs or the drop list — it stays
    // on the base watchlist by virtue of being on the base watchlist, not
    // by virtue of clearing this filter.
    expect(newcomers.map(r => r.symbol)).not.toContain('AAPL');
    expect(dropped.map(d => d.symbol)).not.toContain('AAPL');
    // QTEX (a true newcomer) is correctly dropped.
    expect(kept.map(r => r.symbol)).toEqual([]);
    expect(dropped).toEqual([
      { symbol: 'QTEX', price: 2.10, reason: 'below_min_price' },
    ]);
  });

  it('drops symbols with no usable quote (defensive default)', async () => {
    // If we can't get a price for a newcomer, we can't prove it clears the
    // floor — and TRA-508 showed unfiltered micro-caps are exactly the
    // cohort we're trying to gate, so the safer default is to drop.
    const scan: ScanResult[] = [{ symbol: 'NOQUOTE', reason: 'gainer', changePct: 30 }];
    const ranked = scoreSymbols(null, scan);

    const { kept, dropped } = await filterByPriceFloor(
      ranked,
      null,
      async () => new Map(), // lookup returns empty
    );

    expect(kept).toEqual([]);
    expect(dropped).toEqual([
      { symbol: 'NOQUOTE', price: null, reason: 'no_quote' },
    ]);
  });

  it('returns empty kept+dropped when given no newcomers', async () => {
    const { kept, dropped } = await filterByPriceFloor([], null, async () => new Map());
    expect(kept).toEqual([]);
    expect(dropped).toEqual([]);
  });
});
