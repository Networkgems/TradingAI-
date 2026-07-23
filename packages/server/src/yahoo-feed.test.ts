import { describe, it, expect } from 'vitest';

import {
  evaluateTwelveDataGate,
  isTradierStocksConfigured,
  setTradierStocksFeedClient,
  partitionCachedQuotes,
  requestsInWindow,
  canReuseCachedTradierBars,
  getTradierBarPullRateState,
  chartQuoteFromResult,
  shouldTripTradierBreaker,
  getFeedDegradationState,
  tradierBreakerGate,
  barPullThrottleGate,
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

// TRA-554 / TRA-735 — minute-bar coalescing must key on the *requested* depth,
// not the returned bar count. The old `bars.length >= count` guard could never
// be met by the 80-bar candle loop before 80 RTH minutes elapse, nor by the
// 2,000-bar MTF snapshot pull (a session has ~390 minutes), so those callers
// refetched Tradier every 30s tick — the ~1,300–2,300 req/min RTH volume QA
// measured on prod bqb1.
describe('canReuseCachedTradierBars (TRA-554 minute-bar coalescing)', () => {
  const now = 1_000_000;
  const future = now + 30_000; // still inside this minute
  const entry = (over: Partial<{ source: 'tradier' | 'yahoo' | 'twelvedata' | 'none'; expiresAt: number; requestedCount: number; cold: boolean }> = {}) => ({
    source: 'tradier' as const,
    expiresAt: future,
    requestedCount: 80,
    cold: false,
    ...over,
  });

  it('reuses when a fresh Tradier entry already requested at least `count`', () => {
    expect(canReuseCachedTradierBars(entry({ requestedCount: 80 }), 80, now)).toBe(true);
    expect(canReuseCachedTradierBars(entry({ requestedCount: 2000 }), 80, now)).toBe(true);
  });

  it('reuses a short result the upstream returned for an equal-or-deeper request', () => {
    // The 2,000-bar MTF pull stores requestedCount=2000 but only ~390 bars
    // exist; a second MTF call the same minute must still coalesce.
    expect(canReuseCachedTradierBars(entry({ requestedCount: 2000 }), 2000, now)).toBe(true);
  });

  it('refetches when the caller wants strictly more bars than were last requested', () => {
    expect(canReuseCachedTradierBars(entry({ requestedCount: 80 }), 2000, now)).toBe(false);
  });

  it('refetches once the minute boundary has passed (entry expired)', () => {
    expect(canReuseCachedTradierBars(entry({ expiresAt: now - 1 }), 80, now)).toBe(false);
  });

  it('does not reuse a non-Tradier entry so a recovered primary can reclaim it', () => {
    expect(canReuseCachedTradierBars(entry({ source: 'yahoo' }), 80, now)).toBe(false);
    expect(canReuseCachedTradierBars(entry({ source: 'twelvedata' }), 80, now)).toBe(false);
    expect(canReuseCachedTradierBars(entry({ source: 'none' }), 80, now)).toBe(false);
  });

  it('returns false for a cold symbol (no cache entry)', () => {
    expect(canReuseCachedTradierBars(undefined, 80, now)).toBe(false);
  });

  // TRA-739 — cold (long-TTL discovery) entries must not serve a symbol that
  // has since become active-interest; live decisions need minute-fresh bars.
  it('refetches a cold-cached entry once its symbol becomes active-interest', () => {
    // Cold entry, still inside its (longer) TTL, but the symbol is now hot.
    expect(canReuseCachedTradierBars(entry({ cold: true }), 80, now, true)).toBe(false);
    // Same cold entry while the symbol is still cold → reuse is fine.
    expect(canReuseCachedTradierBars(entry({ cold: true }), 80, now, false)).toBe(true);
    // A hot-cached entry is always reusable regardless of current interest.
    expect(canReuseCachedTradierBars(entry({ cold: false }), 80, now, true)).toBe(true);
  });
});

// TRA-739 — the bar-pull meter is the restart-resilient companion to the quote
// meter. `fallbackRequestsToday.tradier` is cumulative and resets on process
// restart, so the sampler must read this 60s rolling gauge instead of
// differencing the daily counter. It is wired off `bumpFallbackCounter('tradier')`
// and shares the (already-tested) `requestsInWindow` math.
describe('getTradierBarPullRateState (TRA-739 bar-pull req/min meter)', () => {
  it('exposes a 60s rolling window and a non-negative count', () => {
    const state = getTradierBarPullRateState();
    expect(state.windowSec).toBe(60);
    expect(typeof state.requestsLastMin).toBe('number');
    expect(state.requestsLastMin).toBeGreaterThanOrEqual(0);
  });
});

// TRA-1035 — the keyless Yahoo chart-quote fallback. When the Yahoo quote
// endpoint fails closed without a crumb but the chart endpoint still resolves
// (the demo trading-server's egress), a quote is synthesised from the chart
// result's `meta`, falling back to the latest non-null bar close.
describe('chartQuoteFromResult (TRA-1035 keyless chart-quote)', () => {
  it('builds a quote from meta.regularMarketPrice with change vs chartPreviousClose', () => {
    const q = chartQuoteFromResult({
      meta: { regularMarketPrice: 105, chartPreviousClose: 100, regularMarketVolume: 4200 },
      quotes: [],
    });
    expect(q).not.toBeNull();
    expect(q!.price).toBe(105);
    expect(q!.volume).toBe(4200);
    expect(q!.change).toBe(5);
    expect(q!.changePct).toBeCloseTo(5, 6);
  });

  it('falls back to previousClose when chartPreviousClose is absent', () => {
    const q = chartQuoteFromResult({ meta: { regularMarketPrice: 50, previousClose: 40 } });
    expect(q!.change).toBe(10);
    expect(q!.changePct).toBeCloseTo(25, 6);
  });

  it('uses the latest non-null bar close when meta has no live price', () => {
    const q = chartQuoteFromResult({
      meta: { previousClose: 9 },
      quotes: [
        { close: 8, volume: 1 },
        { close: 10, volume: 7 },
        { close: null, volume: null },
      ],
    });
    expect(q!.price).toBe(10);
    expect(q!.volume).toBe(7);
    expect(q!.change).toBe(1);
  });

  it('reports zero change when no previous close is available', () => {
    const q = chartQuoteFromResult({ meta: { regularMarketPrice: 12 } });
    expect(q!.price).toBe(12);
    expect(q!.change).toBe(0);
    expect(q!.changePct).toBe(0);
  });

  it('returns null when no usable price exists (null result, no price, non-positive)', () => {
    expect(chartQuoteFromResult(null)).toBeNull();
    expect(chartQuoteFromResult(undefined)).toBeNull();
    expect(chartQuoteFromResult({ meta: {}, quotes: [{ close: null, volume: null }] })).toBeNull();
    expect(chartQuoteFromResult({ meta: { regularMarketPrice: 0 }, quotes: [{ close: 0 }] })).toBeNull();
  });
});

// TRA-1940 — feed-provider fallback hardening.
//
// Root cause: a Tradier account-wide quota breach surfaces as `HTTP 400: Quota
// Violation`, which the old breaker predicate (429/5xx only) did NOT match — so the
// client was re-hammered as "primary" every tick, every leftover symbol spilled onto
// the degraded Yahoo chain, doTick stretched to minutes, and trade accrual zeroed
// (the trade-volume-zero symptom). shouldTripTradierBreaker now also opens the
// breaker on a quota violation so the tick backs off instead of hot-looping.
describe('shouldTripTradierBreaker (TRA-1940 quota back-off)', () => {
  it('trips on a Tradier account-wide quota violation (HTTP 400 body)', () => {
    // The exact message the client throws: `Tradier quotes HTTP 400: Quota Violation`.
    expect(shouldTripTradierBreaker('Tradier quotes HTTP 400: Quota Violation')).toBe(true);
  });

  it('trips on transient 429 / 5xx errors (unchanged behavior)', () => {
    expect(shouldTripTradierBreaker('Tradier quotes HTTP 429: Too Many Requests')).toBe(true);
    expect(shouldTripTradierBreaker('Tradier quotes HTTP 503: Service Unavailable')).toBe(true);
    expect(shouldTripTradierBreaker('Tradier quotes HTTP 500: err')).toBe(true);
  });

  it('does NOT trip on a benign HTTP 400 (e.g. bad symbol) — breaker stays closed', () => {
    // A non-quota 400 must not disable the primary feed for the whole cooldown.
    expect(shouldTripTradierBreaker('Tradier quotes HTTP 400: Invalid symbol')).toBe(false);
    expect(shouldTripTradierBreaker('Tradier quotes HTTP 404: Not Found')).toBe(false);
  });
});

// TRA-1996 — the Tradier market-data breaker is tracked PER SOURCE. The bug it
// fixes: bar-pull (`timesales`) volume across the grown 545-symbol universe trips
// the account quota, which under TRA-1940's SINGLE shared breaker also blocked the
// cheap once-per-tick quote batch for 90s → quotes aged past MAX_QUOTE_AGE_MS →
// 0/545 fresh 6×/session. The split lets a BAR trip back off bar pulls only while
// quotes keep flowing; a QUOTE trip (account genuinely saturated) backs off both.
describe('tradierBreakerGate (TRA-1996 per-source breaker split)', () => {
  const NOW = 1_000_000;
  const OPEN = NOW + 90_000; // a future cooldown expiry
  const PAST = NOW - 1;      // already recovered

  it('a BAR-pull trip backs off bars but NOT the quote path', () => {
    const g = tradierBreakerGate(NOW, /*bar*/ OPEN, /*quote*/ 0);
    expect(g.barBlocked).toBe(true);
    expect(g.quoteBlocked).toBe(false); // quotes keep refreshing — the fix
  });

  it('a QUOTE trip backs off BOTH paths (account genuinely over quota)', () => {
    const g = tradierBreakerGate(NOW, /*bar*/ 0, /*quote*/ OPEN);
    expect(g.barBlocked).toBe(true);
    expect(g.quoteBlocked).toBe(true);
  });

  it('both closed once cooldowns elapse', () => {
    const g = tradierBreakerGate(NOW, PAST, PAST);
    expect(g.barBlocked).toBe(false);
    expect(g.quoteBlocked).toBe(false);
  });

  it('a stale BAR block never keeps the quote path down after a QUOTE recovery', () => {
    // Quote path recovered (quoteUntil in the past) but a bar-pull storm is still
    // cooling down: quotes must be free even though bars remain blocked.
    const g = tradierBreakerGate(NOW, /*bar*/ OPEN, /*quote*/ PAST);
    expect(g.barBlocked).toBe(true);
    expect(g.quoteBlocked).toBe(false);
  });
});

// TRA-2170 — process-global bar-pull ceiling. Reserves account-quota headroom for
// the freshness-critical quote path by deferring COLD bar pulls once the reserved
// ceiling is reached. NB: this is NOT the TRA-1996 C4 fix (that theory was falsified
// at the byte level; `e5f43b4` decoupled-quote-refresh is the C4 fix) — it is opt-in
// quota-headroom / doTick-I/O-relief insurance, DISABLED by default.
describe('barPullThrottleGate (TRA-2170 bar-pull ceiling)', () => {
  const base = { isActiveInterest: false, isDeepMtf: false, barPullsLastMin: 999, ceiling: 150 };

  it('defers a COLD pull once bar-pull rate reaches the ceiling', () => {
    expect(barPullThrottleGate({ ...base, barPullsLastMin: 150 })).toEqual({ allowed: false, reason: 'cold_deferred_ceiling' });
    expect(barPullThrottleGate({ ...base, barPullsLastMin: 220 }).allowed).toBe(false);
  });

  it('allows a COLD pull while under the ceiling', () => {
    expect(barPullThrottleGate({ ...base, barPullsLastMin: 149 })).toEqual({ allowed: true, reason: 'under_ceiling' });
  });

  it('NEVER defers an active-interest (hot) pull, even far over the ceiling', () => {
    expect(barPullThrottleGate({ ...base, isActiveInterest: true, barPullsLastMin: 500 })).toEqual({ allowed: true, reason: 'active_interest' });
  });

  it('NEVER defers a deep-MTF snapshot pull, even far over the ceiling', () => {
    expect(barPullThrottleGate({ ...base, isDeepMtf: true, barPullsLastMin: 500 })).toEqual({ allowed: true, reason: 'deep_mtf' });
  });

  it('is DISABLED (never defers) for an unset / non-positive / non-finite ceiling', () => {
    for (const ceiling of [Number.POSITIVE_INFINITY, 0, -1, Number.NaN]) {
      expect(barPullThrottleGate({ ...base, barPullsLastMin: 10_000, ceiling })).toEqual({ allowed: true, reason: 'ceiling_disabled' });
    }
  });
});

describe('getFeedDegradationState (TRA-1940 observability)', () => {
  it('reports a closed-breaker snapshot with the enforced fan-out budget', () => {
    const s = getFeedDegradationState();
    // Shape the /api/health/quotes route surfaces so ops can see which provider is
    // degraded, why, and when it recovers.
    expect(s).toHaveProperty('tradier');
    expect(s).toHaveProperty('yahoo');
    expect(typeof s.fanoutBudgetMs).toBe('number');
    expect(s.fanoutBudgetMs).toBeGreaterThan(0);
    // With no breaker tripped in this unit context, both providers read closed and
    // carry no expiry timestamp (null, not a stale 1970 date).
    expect(typeof s.tradier.open).toBe('boolean');
    expect(typeof s.yahoo.open).toBe('boolean');
    if (!s.tradier.open) {
      expect(s.tradier.reason).toBeNull();
      expect(s.tradier.blockedUntil).toBeNull();
    }
    if (!s.yahoo.open) expect(s.yahoo.blockedUntil).toBeNull();
    // TRA-2073 invariant: the reported bar path is BLOCKED exactly when the overall
    // Tradier breaker is open. `barPathOpen` must equal `tradier.open` (both route
    // through the effective `now < max(bar, quote)` gate). The old code read the raw
    // `tradierBarBlockedUntil` epoch, so on a QUOTE-side quota trip it printed
    // `barPathOpen:false` while `tradier.open` was true — the contradiction this locks.
    expect(s.tradier.barPathOpen).toBe(s.tradier.open);
  });
});
