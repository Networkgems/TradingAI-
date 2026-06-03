import { describe, it, expect } from 'vitest';

import {
  evaluateTwelveDataGate,
  isTradierStocksConfigured,
  setTradierStocksFeedClient,
  partitionCachedQuotes,
  requestsInWindow,
} from './yahoo-feed.js';

const Q = (price: number) => ({ price, volume: 0, change: 0, changePct: 0 });

// TRA-505 — the watchlist quote feed must follow the Tradier creds the user
// saves in the live Settings page, not only the boot-time TRADIER_* env vars.
// When no env token is set (the normal deployment), the feed has no Tradier
// source and quotes fall back to Yahoo's free per-IP feed, which 429s and shows
// "Quote unavailable — provider rate-limited". setTradierStocksFeedClient is the
// hook the signal-engine calls from applySettings to swap the feed onto the same
// account that already powers trading/balance.
describe('setTradierStocksFeedClient (TRA-505 live-creds quote feed)', () => {
  it('enables the Tradier feed once a token from settings is supplied', () => {
    // No TRADIER_* env vars in the test env → feed starts unconfigured.
    expect(isTradierStocksConfigured()).toBe(false);
    setTradierStocksFeedClient('test-prod-token', 'production');
    expect(isTradierStocksConfigured()).toBe(true);
  });

  it('disables the feed (back to Yahoo) when settings clear the token', () => {
    setTradierStocksFeedClient('test-prod-token', 'production');
    expect(isTradierStocksConfigured()).toBe(true);
    setTradierStocksFeedClient('', 'production');
    expect(isTradierStocksConfigured()).toBe(false);
  });

  it('treats a whitespace-only token as no token', () => {
    setTradierStocksFeedClient('   ', 'production');
    expect(isTradierStocksConfigured()).toBe(false);
  });
});

// TRA-572 — the stock quote feed is a PROCESS-GLOBAL singleton, but its token is
// supplied PER user context. Before this fix a single credential-less context
// (e.g. a fresh demo signup with no Tradier token) calling the setter with an
// empty string nulled the client for EVERY user — stock quotes went dark
// process-wide ("Quote unavailable — provider rate-limited") even while another
// logged-in account had a working Tradier production feed. The setter now tracks
// tokens per `contextKey`, so clearing one context can never evict another's.
describe('setTradierStocksFeedClient multi-tenant isolation (TRA-572)', () => {
  it('a credential-less context does not evict another context that has a token', () => {
    setTradierStocksFeedClient('live-prod-token', 'production', 'engine-A');
    expect(isTradierStocksConfigured()).toBe(true);
    // A fresh demo signup with no Tradier creds applies settings → empty token.
    setTradierStocksFeedClient('', 'production', 'engine-B');
    // Feed must stay live on engine-A's token.
    expect(isTradierStocksConfigured()).toBe(true);
    // Cleanup: clearing the provider context drops the feed.
    setTradierStocksFeedClient('', 'production', 'engine-A');
    expect(isTradierStocksConfigured()).toBe(false);
  });

  it('keeps the feed up while any one of several contexts still supplies a token', () => {
    setTradierStocksFeedClient('token-1', 'production', 'engine-1');
    setTradierStocksFeedClient('token-2', 'production', 'engine-2');
    expect(isTradierStocksConfigured()).toBe(true);
    setTradierStocksFeedClient('', 'production', 'engine-1');
    expect(isTradierStocksConfigured()).toBe(true); // engine-2 still has a token
    setTradierStocksFeedClient('', 'production', 'engine-2');
    expect(isTradierStocksConfigured()).toBe(false); // now nobody does
  });

  it('prefers a production token over a sandbox token for the data feed', () => {
    setTradierStocksFeedClient('sbx', 'sandbox', 'engine-sbx');
    expect(isTradierStocksConfigured()).toBe(true);
    setTradierStocksFeedClient('prod', 'production', 'engine-prod');
    expect(isTradierStocksConfigured()).toBe(true);
    // Dropping production falls back to the still-registered sandbox token.
    setTradierStocksFeedClient('', 'production', 'engine-prod');
    expect(isTradierStocksConfigured()).toBe(true);
    setTradierStocksFeedClient('', 'sandbox', 'engine-sbx');
    expect(isTradierStocksConfigured()).toBe(false);
  });
});

// TRA-439 — Twelve Data quota guard. Before this fix the minute-bar fallback
// had no breaker and no daily cap, so a degraded primary feed let one provider
// burn ~27.7k calls/day against an 800/day free-tier limit. `evaluateTwelveDataGate`
// is the pure decision function that bounds every outbound Twelve Data request.

const base = {
  hasApiKey: true,
  isActiveInterest: true,
  breakerOpenUntil: 0,
  callsToday: 0,
  dailyBudget: 700,
  now: 1_000_000,
};

describe('evaluateTwelveDataGate', () => {
  it('allows a call when key is set, symbol is active, breaker closed, budget remains', () => {
    expect(evaluateTwelveDataGate(base)).toEqual({ allowed: true, reason: 'ok' });
  });

  it('blocks when no API key is configured', () => {
    expect(evaluateTwelveDataGate({ ...base, hasApiKey: false })).toEqual({
      allowed: false,
      reason: 'no_key',
    });
  });

  it('blocks symbols outside the active-interest set', () => {
    expect(evaluateTwelveDataGate({ ...base, isActiveInterest: false })).toEqual({
      allowed: false,
      reason: 'not_active_interest',
    });
  });

  it('blocks while the credit/rate-limit breaker is open', () => {
    expect(
      evaluateTwelveDataGate({ ...base, breakerOpenUntil: base.now + 60_000 }),
    ).toEqual({ allowed: false, reason: 'breaker_open' });
  });

  it('allows again once the breaker window has elapsed', () => {
    expect(
      evaluateTwelveDataGate({ ...base, breakerOpenUntil: base.now - 1 }),
    ).toEqual({ allowed: true, reason: 'ok' });
  });

  it('blocks once the daily budget is fully spent', () => {
    expect(
      evaluateTwelveDataGate({ ...base, callsToday: 700, dailyBudget: 700 }),
    ).toEqual({ allowed: false, reason: 'quota_exhausted' });
  });

  it('allows the final call right below the budget cap', () => {
    expect(
      evaluateTwelveDataGate({ ...base, callsToday: 699, dailyBudget: 700 }),
    ).toEqual({ allowed: true, reason: 'ok' });
  });

  it('prioritises no_key over every other block reason', () => {
    expect(
      evaluateTwelveDataGate({
        ...base,
        hasApiKey: false,
        isActiveInterest: false,
        breakerOpenUntil: base.now + 60_000,
        callsToday: 9_999,
      }),
    ).toEqual({ allowed: false, reason: 'no_key' });
  });

  it('reports breaker_open ahead of quota_exhausted when both apply', () => {
    expect(
      evaluateTwelveDataGate({
        ...base,
        breakerOpenUntil: base.now + 60_000,
        callsToday: 9_999,
      }),
    ).toEqual({ allowed: false, reason: 'breaker_open' });
  });
});

// TRA-552 — short-TTL quote cache. Tradier is the sole stock-quote source, so
// repeated reads of the same symbol inside the TTL window (watchlist poll + RV
// scanner spot + signal-engine tick) must collapse to one upstream call.
// `partitionCachedQuotes` is the pure split that decides which symbols are
// served from cache and which still need a fetch.
describe('partitionCachedQuotes (TRA-552 quote cache TTL)', () => {
  const now = 1_000_000;

  it('serves a symbol cached inside the TTL window without a fetch', () => {
    const cache = new Map([['AAPL', { quote: Q(315), storedAt: now - 1_000 }]]);
    const { fresh, stale } = partitionCachedQuotes({ symbols: ['AAPL'], cache, ttlMs: 3_000, now });
    expect(stale).toEqual([]);
    expect(fresh.get('AAPL')).toEqual(Q(315));
  });

  it('treats an entry older than the TTL as stale (needs a fetch)', () => {
    const cache = new Map([['AAPL', { quote: Q(315), storedAt: now - 5_000 }]]);
    const { fresh, stale } = partitionCachedQuotes({ symbols: ['AAPL'], cache, ttlMs: 3_000, now });
    expect(fresh.size).toBe(0);
    expect(stale).toEqual(['AAPL']);
  });

  it('treats an exact-TTL-age entry as stale (boundary is exclusive)', () => {
    const cache = new Map([['AAPL', { quote: Q(315), storedAt: now - 3_000 }]]);
    const { stale } = partitionCachedQuotes({ symbols: ['AAPL'], cache, ttlMs: 3_000, now });
    expect(stale).toEqual(['AAPL']);
  });

  it('routes a cache miss to the stale set', () => {
    const cache = new Map<string, { quote: ReturnType<typeof Q>; storedAt: number }>();
    const { fresh, stale } = partitionCachedQuotes({ symbols: ['MSFT'], cache, ttlMs: 3_000, now });
    expect(fresh.size).toBe(0);
    expect(stale).toEqual(['MSFT']);
  });

  it('partitions a mixed list into fresh hits and the stale remainder', () => {
    const cache = new Map([
      ['AAPL', { quote: Q(315), storedAt: now - 500 }],   // fresh
      ['TSLA', { quote: Q(240), storedAt: now - 9_000 }], // expired
    ]);
    const { fresh, stale } = partitionCachedQuotes({
      symbols: ['AAPL', 'TSLA', 'NVDA'],
      cache,
      ttlMs: 3_000,
      now,
    });
    expect([...fresh.keys()]).toEqual(['AAPL']);
    expect(stale).toEqual(['TSLA', 'NVDA']);
  });

  it('treats every symbol as stale when the TTL is zero (cache disabled)', () => {
    const cache = new Map([['AAPL', { quote: Q(315), storedAt: now }]]);
    const { fresh, stale } = partitionCachedQuotes({ symbols: ['AAPL'], cache, ttlMs: 0, now });
    expect(fresh.size).toBe(0);
    expect(stale).toEqual(['AAPL']);
  });
});

// TRA-552 — rolling Tradier requests/min meter surfaced in /api/health/quotes.
// `requestsInWindow` is the pure window count: how many requests fall inside the
// last `windowMs`, plus the pruned list so expired timestamps drop off.
describe('requestsInWindow (TRA-552 req/min meter)', () => {
  const now = 1_000_000;
  const W = 60_000;

  it('counts only timestamps inside the window and prunes the rest', () => {
    const ts = [now - 70_000, now - 30_000, now - 5_000, now];
    const { count, kept } = requestsInWindow(ts, now, W);
    expect(count).toBe(3);
    expect(kept).toEqual([now - 30_000, now - 5_000, now]);
  });

  it('excludes a timestamp exactly at the window edge (boundary exclusive)', () => {
    const { count } = requestsInWindow([now - W], now, W);
    expect(count).toBe(0);
  });

  it('returns zero for an empty history', () => {
    expect(requestsInWindow([], now, W)).toEqual({ count: 0, kept: [] });
  });
});
