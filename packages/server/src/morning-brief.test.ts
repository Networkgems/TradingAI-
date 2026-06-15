import { describe, it, expect } from 'vitest';
import { buildBriefForUser } from './morning-brief.js';
import type { UserContext } from './user-context.js';

// Minimal engine-state stubs — buildBriefForUser only reads getState()/getNews().
function fakeCtx(opts: {
  username?: string;
  stocksSignals?: unknown[];
  cryptoSignals?: unknown[];
  stocksPositions?: unknown[];
  cryptoPositions?: unknown[];
  openOptions?: unknown[];
  stocksNews?: unknown[];
  cryptoNews?: unknown[];
}): UserContext {
  const stocksState = {
    signals: opts.stocksSignals ?? [],
    account: { openPositions: opts.stocksPositions ?? [] },
    options: { openOptions: opts.openOptions ?? [] },
  };
  const cryptoState = {
    signals: opts.cryptoSignals ?? [],
    account: { openPositions: opts.cryptoPositions ?? [] },
  };
  return {
    username: opts.username ?? 'alice',
    engine: {
      getState: () => stocksState,
      getNews: () => opts.stocksNews ?? [],
    },
    cryptoEngine: {
      getState: () => cryptoState,
      getNews: () => opts.cryptoNews ?? [],
    },
  } as unknown as UserContext;
}

const MACRO = {
  regime: 'yellow',
  rationale: 'VIX elevated',
  indexes: [{ label: 'VIX', value: 24, note: 'hot' }],
};
const TS = Date.parse('2026-05-17T12:30:00Z');

describe('buildBriefForUser', () => {
  it('threads macro, setups, positions and news into a briefing event', () => {
    const ctx = fakeCtx({
      stocksSignals: [
        { symbol: 'AAPL', type: 'orb_long', side: 'buy', entryPrice: 150, stopLoss: 147, takeProfit: 156, timestamp: 2 },
      ],
      cryptoSignals: [
        { symbol: 'BTC-USD', type: 'momentum', side: 'buy', entryPrice: 65000, stopLoss: 64000, takeProfit: 67000, timestamp: 5 },
      ],
      stocksPositions: [{ symbol: 'MSFT', side: 'buy', quantity: 10, entryPrice: 400 }],
      cryptoPositions: [{ symbol: 'ETH-USD', side: 'buy', quantity: 2, entryPrice: 3140, productType: 'perp' }],
      openOptions: [
        { symbol: 'NVDA', optionType: 'call', strike: 900, expiration: '2026-06-19', contracts: 3, contractsRemaining: 3, premiumPaid: 10, currentPremium: 12 },
      ],
      stocksNews: [{ title: 'Apple ships', source: 'WSJ', publishedAt: '2026-05-17T05:00:00Z' }],
      cryptoNews: [{ title: 'BTC rallies', source: 'CoinDesk', publishedAt: '2026-05-17T06:00:00Z' }],
    });

    const e = buildBriefForUser(ctx, MACRO, '2026-05-17', TS);

    expect(e.kind).toBe('briefing');
    expect(e.username).toBe('alice');
    expect(e.date).toBe('2026-05-17');
    expect(e.macro.regime).toBe('yellow');

    // Setups sorted newest-first (BTC ts=5 before AAPL ts=2).
    expect(e.setups.map((s) => s.symbol)).toEqual(['BTC-USD', 'AAPL']);

    // Positions: stocks, crypto (perp tagged), options (with estimated P&L).
    expect(e.positions.map((p) => p.market)).toEqual(['stocks', 'crypto', 'options']);
    expect(e.positions[1]?.detail).toBe('perp');
    const opt = e.positions[2]!;
    expect(opt.detail).toBe('call 900 2026-06-19');
    expect(opt.pnl).toBeCloseTo((12 - 10) * 3 * 100); // +$600

    // News merged + recency-sorted (crypto 06:00 before stocks 05:00).
    expect(e.news.map((n) => n.title)).toEqual(['BTC rallies', 'Apple ships']);
  });

  it('dedupes news by title and caps the list', () => {
    // Two newest items share a title (must collapse); rest are unique fillers.
    const dupNews = Array.from({ length: 10 }, (_, i) => ({
      title: i < 2 ? 'Same headline' : `Headline ${i}`,
      source: 'X',
      // Higher i → earlier time, so i=0 and i=1 are the two most recent.
      publishedAt: `2026-05-17T${String(20 - i).padStart(2, '0')}:00:00Z`,
    }));
    const ctx = fakeCtx({ stocksNews: dupNews });
    const e = buildBriefForUser(ctx, MACRO, '2026-05-17', TS);
    // Capped at 6 and the duplicate title collapses to one.
    expect(e.news.length).toBe(6);
    expect(e.news.filter((n) => n.title === 'Same headline').length).toBe(1);
    // No duplicate titles survive.
    expect(new Set(e.news.map((n) => n.title)).size).toBe(e.news.length);
  });

  it('produces empty sections (not crashes) for an idle user', () => {
    const e = buildBriefForUser(fakeCtx({}), MACRO, '2026-05-17', TS);
    expect(e.setups).toEqual([]);
    expect(e.positions).toEqual([]);
    expect(e.news).toEqual([]);
  });
});
