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

/**
 * TRA-3071 — the archived `latest.json` is read OFF DISK by this module, so
 * neither of the shipped defences reaches it: TRA-2610 guards report
 * GENERATION (a file already on disk is untouched) and TRA-2631 stamps the
 * archive at the HTTP/WS RESPONSE boundary (this consumer never crosses it).
 * The guard therefore has to live at the consumer, exactly as TRA-2610 put it
 * on the other ranking consumers.
 *
 * The two rows below straddle `SUSPECT_MOVE_RATIO_FLOOR` (1.9) from both
 * sides, so together they pin the bar rather than just one side of it:
 *
 *   - SELX  $0.34 / +1316.67%  ⇒ prev 0.34/14.1667 = 0.024,  r = 14.167  SUSPECT
 *   - QMCO  $19.34 /  +64.18%  ⇒ prev 19.34/1.6418 = 11.780, r =  1.6418 CLEAN
 *
 * QMCO is the false-positive control (real 2026-08-11 tape row, the day's
 * largest plausibly-genuine mover). The old control here — INLF $6.27/+97.17%,
 * r = 1.9717, "deliberately a near-miss" — was retired by TRA-3241: it sits
 * INSIDE the k = 2 proximity band, so the rule now suppresses it CORRECTLY. A
 * guard that quietly tightened the threshold further, or that keyed on "big
 * percentage" instead of the ratio, still fails on QMCO.
 *
 * NEITHER row carries `moveSuspect`. That is not an omission in the fixture —
 * `moveSuspect` is never persisted, so EVERY archived row lacks it, which is
 * why the guard must RE-EXECUTE the rule and not merely read the flag.
 */
describe('scoreSymbols — archived top5Movers plausibility guard (TRA-3071)', () => {
  const SELX = { symbol: 'SELX', price: 0.34, changePct: 1316.67 };
  const QMCO = { symbol: 'QMCO', price: 19.34, changePct: 64.18 };

  it('does not bump a suspect archived mover into the eod_mover bucket', () => {
    const eod = fakeEod({ top5Movers: [SELX] });
    const ranked = scoreSymbols(eod, []);
    expect(ranked.map(r => r.symbol)).not.toContain('SELX');
    expect(ranked).toEqual([]);
  });

  it('still bumps a clean archived mover — the false-positive control', () => {
    const eod = fakeEod({ top5Movers: [QMCO] });
    const ranked = scoreSymbols(eod, []);
    expect(ranked).toEqual([
      { symbol: 'QMCO', score: 5, sources: ['eod_mover'] },
    ]);
  });

  it('drops only the suspect row from a mixed archive', () => {
    const eod = fakeEod({ top5Movers: [SELX, QMCO] });
    const ranked = scoreSymbols(eod, []);
    expect(ranked.map(r => r.symbol)).toEqual(['QMCO']);
  });

  it('honours a persisted moveSuspect flag even when the rule itself is clean', () => {
    // Belt-and-braces: a row whose numbers pass (r = 1.9717) but which the
    // PRODUCER condemned — e.g. off an input the row no longer carries. The
    // consumer must not silently overrule the stamp.
    const eod = fakeEod({
      top5Movers: [{ ...QMCO, moveSuspect: true } as unknown as EodReport['top5Movers'][number]],
    });
    expect(scoreSymbols(eod, [])).toEqual([]);
  });

  it('does not suppress a symbol that also has an independent pre-market source', () => {
    // The guard removes the UNEARNED weight-5 bump, not the symbol. SELX
    // showing up on today's live gainers screener is real, current evidence
    // and still earns its weight-4 `gainer` bump.
    const eod = fakeEod({ top5Movers: [SELX] });
    const scan: ScanResult[] = [{ symbol: 'SELX', reason: 'gainer', changePct: 9 }];
    const ranked = scoreSymbols(eod, scan);
    expect(ranked).toEqual([
      { symbol: 'SELX', score: 4, sources: ['gainer'] },
    ]);
  });

  it('leaves the eod_traded bucket alone — it is not a plausibility claim', () => {
    // `eod_traded` says the engine HELD this name yesterday, which is a fact
    // about our own book, not about a provider's quote arithmetic. An open
    // swing must keep being watched regardless of what the movers table says.
    const eod = fakeEod({
      top5Movers: [SELX],
      trades: [{ symbol: 'SELX' } as unknown as EodReport['trades'][number]],
    });
    const ranked = scoreSymbols(eod, []);
    expect(ranked).toEqual([
      { symbol: 'SELX', score: 3, sources: ['eod_traded'] },
    ]);
  });
});

describe('filterByPriceFloor — suspect rows do not seed the price map (TRA-3071)', () => {
  it('prices a suspect mover off a FRESH quote instead of the archived row', async () => {
    // The archived price ($0.34) would fail the floor outright. The guard's
    // job here is not to change that verdict but to stop the untrusted number
    // deciding it: the symbol falls through to the live lookup, which is
    // strictly better evidence. Here the fresh quote says $12.40 — a real
    // price for a row whose *changePct* was the fabricated part — and the
    // symbol is correctly kept.
    const eod = fakeEod({ top5Movers: [{ symbol: 'SELX', price: 0.34, changePct: 1316.67 }] });
    const scan: ScanResult[] = [{ symbol: 'SELX', reason: 'gainer', changePct: 9 }];
    const ranked = scoreSymbols(eod, scan);

    const fetched: string[][] = [];
    const { kept, dropped } = await filterByPriceFloor(
      ranked,
      eod,
      async (syms) => {
        fetched.push([...syms]);
        return new Map([['SELX', { price: 12.40 }]]);
      },
    );

    expect(fetched).toEqual([['SELX']]);   // the archived seed was NOT used
    expect(kept.map(r => r.symbol)).toEqual(['SELX']);
    expect(dropped).toEqual([]);
  });

  it('still seeds from a clean archived row without a quote round-trip', async () => {
    // The false-positive control on the price leg: QMCO's $19.34 clears the
    // $5 floor off the archive alone, and the lookup must not be invoked.
    const eod = fakeEod({ top5Movers: [{ symbol: 'QMCO', price: 19.34, changePct: 64.18 }] });
    const ranked = scoreSymbols(eod, []);

    const { kept, dropped } = await filterByPriceFloor(
      ranked,
      eod,
      async () => { throw new Error('quote lookup should not be invoked for a clean archived row'); },
    );

    expect(kept.map(r => r.symbol)).toEqual(['QMCO']);
    expect(dropped).toEqual([]);
  });
});
