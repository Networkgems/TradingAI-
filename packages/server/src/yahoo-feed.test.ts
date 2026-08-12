import { describe, it, expect, vi } from 'vitest';

import {
  fetchQuote,
  fetchQuotes,
  recordTradierUnmatched,
  __resetTradierUnmatchedForTests,
  evaluateTwelveDataGate,
  isTradierStocksConfigured,
  setTradierStocksFeedClient,
  partitionCachedQuotes,
  requestsInWindow,
  requestsInFixedWindow,
  quoteReservationReqPerMin,
  resolveBarPullCeiling,
  quotaCrossingVerdict,
  getTradierQuotaBudgetState,
  getTradierAccountSpendThisMinute,
  accountMinuteStats,
  canReuseCachedTradierBars,
  getTradierBarPullRateState,
  chartQuoteFromResult,
  shouldTripTradierBreaker,
  getFeedDegradationState,
  tradierBreakerGate,
  barPullThrottleGate,
  secondaryFanoutCeiling,
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

// ── TRA-3104 — match the enforcement window: FIXED and minute-ALIGNED ─────────
// Tradier's quota is enforced on a fixed, minute-ALIGNED window: 26/26 `HTTP 400:
// Quota Violation` responses measured on bqb1 2026-08-06 carried an `Expires`
// landing exactly on the next `:00` boundary (11 distinct values, all aligned).
// Our meter was `requestsInWindow(..., 60_000)` — sliding.
//
// ⚠️ THE FILED FINDING OVERSTATED THIS AND THESE TESTS ARE WHAT CAUGHT IT. TRA-3104
// claimed the sliding meter "gives no bound on the count inside any fixed minute"
// and "fails in both directions". The under-fire half is FALSE: the aligned bucket
// is always a SUBSET of the trailing 60s, so `slidingCount >= fixedCount` always,
// and a sliding gate at N is strictly MORE conservative than a fixed gate at N.
// The test below is the retraction, encoded — it asserts the bound HOLDS under the
// old reducer, so nobody can re-derive the withdrawn claim from this file. What
// remains is real and one-directional: the sliding meter OVER-fires, refusing cold
// pulls while the enforced minute still has headroom.
describe('requestsInFixedWindow (TRA-3104 fixed minute-aligned enforcement)', () => {
  const W = 60_000;
  // A clean minute boundary to reason against: t=600_000 is exactly 10:00.000.
  const B = 600_000;

  it('counts only the aligned bucket containing `now`, and includes its start', () => {
    const ts = [B - 1, B, B + 10, B + 30_000];
    const { count, windowStart } = requestsInFixedWindow(ts, B + 30_000, W);
    expect(windowStart).toBe(B);
    // B - 1 belongs to the PREVIOUS enforced minute and must not count.
    expect(count).toBe(3);
  });

  it('resets to zero the instant the boundary is crossed (the quota does too)', () => {
    const ts = Array.from({ length: 50 }, (_, i) => B - 1_000 - i); // all in minute N-1
    expect(requestsInFixedWindow(ts, B - 1, W).count).toBe(50);
    expect(requestsInFixedWindow(ts, B, W).count).toBe(0);
  });

  it('never needs a timestamp the rolling prune would have dropped', () => {
    // The aligned bucket start is always >= now - windowMs, so the array the
    // rolling meter keeps is always a superset of what the fixed counter reads.
    // This is why the two meters share one array with no extra storage.
    for (const now of [B, B + 1, B + 59_999, B + 60_000, B + 123_456]) {
      const { windowStart } = requestsInFixedWindow([], now, W);
      expect(windowStart).toBeGreaterThanOrEqual(now - W);
      expect(windowStart).toBeLessThanOrEqual(now);
    }
  });

  it('is never negative-length or ahead of `now` for a non-aligned clock', () => {
    const { windowStart, count } = requestsInFixedWindow([B + 137], B + 137, W);
    expect(windowStart).toBe(B);
    expect(count).toBe(1);
  });
});

describe('TRA-3104 — the sliding-vs-fixed mismatch, in the direction it actually fails', () => {
  const W = 60_000;
  const B = 600_000;
  const CEILING = 100;

  // Replay a spend decision request-by-request under a given reducer and return
  // the timestamps actually allowed through — the only honest way to compare two
  // limiters, since each one's refusals change what the next one sees.
  const replay = (
    attempts: readonly number[],
    countPrior: (spent: readonly number[], at: number) => number,
  ): number[] => {
    const spent: number[] = [];
    for (const a of attempts) if (countPrior(spent, a) < CEILING) spent.push(a);
    return spent;
  };
  const sliding = (spent: readonly number[], at: number) => requestsInWindow(spent, at, W).count;
  const fixed = (spent: readonly number[], at: number) => requestsInFixedWindow(spent, at, W).count;
  const peakPerFixedMinute = (spent: readonly number[]): number => {
    const buckets = new Map<number, number>();
    for (const t of spent) {
      const b = Math.floor(t / W);
      buckets.set(b, (buckets.get(b) ?? 0) + 1);
    }
    return buckets.size === 0 ? 0 : Math.max(...buckets.values());
  };

  it('RETRACTION: a sliding gate at N never permits MORE than N inside an enforced minute', () => {
    // The withdrawn claim was that 99 spends at :59 plus 99 at :01 slip past a
    // sliding gate at 100 and burn 198 in one enforced minute. They do not: the
    // trailing window still sees the first half, so the gate refuses. Replaying
    // the decision — rather than counting a static array — is what shows it.
    const attempts = [
      ...Array.from({ length: 99 }, (_, i) => B - 1_000 + i),
      ...Array.from({ length: 99 }, (_, i) => B + 1_000 + i),
    ];
    const bySliding = replay(attempts, sliding);
    const byFixed = replay(attempts, fixed);
    // Neither reducer ever exceeds the ceiling inside a fixed minute.
    expect(peakPerFixedMinute(bySliding)).toBeLessThanOrEqual(CEILING);
    expect(peakPerFixedMinute(byFixed)).toBeLessThanOrEqual(CEILING);
    // And the sliding gate is the STRICTER of the two — it lets fewer through,
    // which is the whole reason the mismatch cannot cause a Quota Violation.
    expect(bySliding.length).toBeLessThan(byFixed.length);
  });

  it('the aligned bucket is always a SUBSET of the trailing window (why the bound holds)', () => {
    // The structural reason, asserted directly rather than left as prose.
    const ts = Array.from({ length: 200 }, (_, i) => B - 45_000 + i * 400);
    for (const now of [B - 1, B, B + 137, B + 30_000, B + 59_999]) {
      expect(requestsInFixedWindow(ts, now, W).count).toBeLessThanOrEqual(
        requestsInWindow(ts, now, W).count,
      );
    }
  });

  it('OVER-fires: a quiet enforced minute reads AT the ceiling because its trailing 60s straddles a busy one', () => {
    // 100 requests late in minute N-1; minute N is nearly silent (2 requests).
    const ts = [
      ...Array.from({ length: 100 }, (_, i) => B - 30_000 + i),
      B + 1_000,
      B + 2_000,
    ];
    const now = B + 2_500;
    // OLD (sliding): 102 in the trailing 60s => at the ceiling => the gate defers
    // COLD pulls, aging cold candles (the TRA-1539 regression) while the enforced
    // minute has 98 units of quota going completely unused.
    expect(requestsInWindow(ts, now, W).count).toBeGreaterThanOrEqual(CEILING);
    // NEW (fixed): 2 spent in enforced minute N => correctly wide open.
    expect(requestsInFixedWindow(ts, now, W).count).toBe(2);
    expect(
      barPullThrottleGate({
        isActiveInterest: false,
        isDeepMtf: false,
        accountSpendThisMinute: requestsInFixedWindow(ts, now, W).count,
        ceiling: CEILING,
      }),
    ).toEqual({ allowed: true, reason: 'under_ceiling' });
    // The same gate fed the OLD statistic refuses — the mismatch, demonstrated
    // through the real gate rather than asserted about it.
    expect(
      barPullThrottleGate({
        isActiveInterest: false,
        isDeepMtf: false,
        accountSpendThisMinute: requestsInWindow(ts, now, W).count,
        ceiling: CEILING,
      }),
    ).toEqual({ allowed: false, reason: 'cold_deferred_ceiling' });
  });
});

// TRA-3104 — quotes get a FLOOR, bars get the remainder. The point of deriving
// these is that an ABSOLUTE constant bounding a quantity that scales with a
// growing universe goes stale silently, in the direction of the regression it was
// calibrated to avoid.
describe('quoteReservationReqPerMin (TRA-3104 explicit quote reservation)', () => {
  it('uses the structural floor when nothing has been observed yet', () => {
    // 60_000 / 20_000ms TTL = 3 structural calls/min, +max(2, ceil(3*0.25)) = 2.
    expect(quoteReservationReqPerMin({ structuralFloor: 3, observedPeak: 0 })).toBe(5);
  });

  it('lets the observed peak dominate the floor once quotes are actually flowing', () => {
    // The 2026-08-06 measurement: quote path 14-16 req/min at universe 640.
    expect(quoteReservationReqPerMin({ structuralFloor: 3, observedPeak: 16 })).toBe(20);
  });

  it('scales its margin as a FRACTION, so the margin cannot go stale', () => {
    const small = quoteReservationReqPerMin({ structuralFloor: 3, observedPeak: 16 });
    const large = quoteReservationReqPerMin({ structuralFloor: 3, observedPeak: 160 });
    expect(large - 160).toBeGreaterThan(small - 16);
  });

  it('is monotone non-decreasing in the observed peak — the fail-open direction', () => {
    // Fed a HIGH-WATER (never the instantaneous rate) precisely because when
    // Tradier starts refusing us the observed rate FALLS. A reservation that
    // tracked it down would hand the freed budget back to the bar path that
    // caused the trip.
    let prev = -1;
    for (const observedPeak of [0, 1, 5, 14, 16, 40, 199]) {
      const r = quoteReservationReqPerMin({ structuralFloor: 3, observedPeak });
      expect(r).toBeGreaterThanOrEqual(prev);
      prev = r;
    }
  });

  it('never returns a reservation below its own base', () => {
    for (const observedPeak of [0, 7, 16, 300]) {
      expect(quoteReservationReqPerMin({ structuralFloor: 3, observedPeak })).toBeGreaterThan(
        Math.max(3, observedPeak),
      );
    }
  });
});

// TRA-3104 — one resolver, explicit precedence, and DISABLED by default on every
// box (which is what makes the whole budget block provably inert until opted in).
describe('resolveBarPullCeiling (TRA-3104 derived budget precedence)', () => {
  it('derives budget - reservation when enforcement is opted in', () => {
    // The measured world: budget 200, quote reservation 20 => bars get 180.
    expect(
      resolveBarPullCeiling({ enforceDerived: true, accountBudget: 200, quoteReservation: 20, absoluteCeiling: Number.POSITIVE_INFINITY }),
    ).toEqual({ ceiling: 180, source: 'derived_budget' });
  });

  it('prefers the derived budget over the superseded absolute knob', () => {
    expect(
      resolveBarPullCeiling({ enforceDerived: true, accountBudget: 200, quoteReservation: 20, absoluteCeiling: 999 }).source,
    ).toBe('derived_budget');
  });

  it('clamps to >=1 rather than going negative when the reservation exceeds the budget', () => {
    // Degrades to "defer cold pulls", never to a negative that would read as
    // disabled and silently fail OPEN.
    const r = resolveBarPullCeiling({ enforceDerived: true, accountBudget: 10, quoteReservation: 50, absoluteCeiling: Number.POSITIVE_INFINITY });
    expect(r.ceiling).toBe(1);
    expect(r.source).toBe('derived_budget');
  });

  it('falls back to the legacy absolute knob when enforcement is off but the knob is set', () => {
    expect(
      resolveBarPullCeiling({ enforceDerived: false, accountBudget: 200, quoteReservation: 20, absoluteCeiling: 200 }),
    ).toEqual({ ceiling: 200, source: 'absolute_env' });
  });

  it('is DISABLED when neither is set — the default on every box today', () => {
    const r = resolveBarPullCeiling({ enforceDerived: false, accountBudget: 200, quoteReservation: 20, absoluteCeiling: Number.POSITIVE_INFINITY });
    expect(r).toEqual({ ceiling: Number.POSITIVE_INFINITY, source: 'disabled' });
    // …and a disabled ceiling short-circuits the gate before any counter is read.
    expect(
      barPullThrottleGate({ isActiveInterest: false, isDeepMtf: false, accountSpendThisMinute: 10_000, ceiling: r.ceiling }),
    ).toEqual({ allowed: true, reason: 'ceiling_disabled' });
  });
});

// TRA-3104 — the CROSSING, made self-reporting, and THREE-VALUED because the
// remedies are opposite. Every branch must be reachable: a verdict that can only
// ever say "fine" is decoration, and one that collapses capacity into burst is
// what produced this ticket's wrong headline.
describe('quotaCrossingVerdict (TRA-3104 capacity vs burst)', () => {
  it('is BURST-BOUND on the corrected 2026-08-06 world: mean 184 under a 200 plan, peak 260 over it', () => {
    // ⚠️ The account meter already INCLUDES the quote calls, so the filed
    // "184 + 16 = 200 = fully consumed" double-counted. Mean is 184 of 200.
    const v = quotaCrossingVerdict({ barCeiling: 180, accountObservedPeak: 260, accountObservedMean: 184, accountBudget: 200 });
    expect(v.burstBound).toBe(true);
    expect(v.budgetExhausted).toBe(false);       // NOT a capacity condition
    expect(v.crossed).toBe(true);
    expect(v.headroomReqPerMin).toBe(16);        // real headroom on the mean
    expect(v.peakOverBudgetReqPerMin).toBe(60);
  });

  it('is BUDGET-EXHAUSTED only when the MEAN reaches the plan — the one case no throttle fixes', () => {
    const v = quotaCrossingVerdict({ barCeiling: 180, accountObservedPeak: 260, accountObservedMean: 205, accountBudget: 200 });
    expect(v.budgetExhausted).toBe(true);
    expect(v.burstBound).toBe(false);            // mutually exclusive by construction
    expect(v.headroomReqPerMin).toBe(-5);        // negative, never clamped
  });

  it('is NOT crossed when both mean and peak fit under the plan (the green branch)', () => {
    const v = quotaCrossingVerdict({ barCeiling: 180, accountObservedPeak: 150, accountObservedMean: 120, accountBudget: 200 });
    expect(v.crossed).toBe(false);
    expect(v.burstBound).toBe(false);
    expect(v.budgetExhausted).toBe(false);
    expect(v.ceilingUnsatisfiable).toBe(false);
    expect(v.headroomReqPerMin).toBe(80);
  });

  it('still decides against the BUDGET when the ceiling is disabled (Infinity)', () => {
    // A gate satisfied by the absence of the thing it grades: reading `crossed`
    // off an Infinity ceiling alone would report false on every default box.
    expect(
      quotaCrossingVerdict({ barCeiling: Number.POSITIVE_INFINITY, accountObservedPeak: 260, accountObservedMean: 184, accountBudget: 200 }).crossed,
    ).toBe(true);
    expect(
      quotaCrossingVerdict({ barCeiling: Number.POSITIVE_INFINITY, accountObservedPeak: 150, accountObservedMean: 120, accountBudget: 200 }).crossed,
    ).toBe(false);
  });

  it('flags ceilingUnsatisfiable independently of the budget verdict', () => {
    // Peak over the derived allowance but the whole account comfortably under the
    // plan: enabling the throttle would bite for no quota benefit.
    const v = quotaCrossingVerdict({ barCeiling: 100, accountObservedPeak: 140, accountObservedMean: 90, accountBudget: 200 });
    expect(v.ceilingUnsatisfiable).toBe(true);
    expect(v.budgetExhausted).toBe(false);
    expect(v.burstBound).toBe(false);
    expect(v.crossed).toBe(true);
  });
});

// TRA-3104 — mean and peak must come from the same bounded window of COMPLETED
// minutes, or the verdict latches on one open-bell burst and answers "did this
// ever happen?" while reading like "is this happening?".
describe('accountMinuteStats (TRA-3104 recent-window mean/peak)', () => {
  const W = 60_000;
  const b = (n: number) => n; // bucket index

  it('excludes the CURRENT partial minute, which would drag the mean to a false all-clear', () => {
    // Three completed minutes at 180 each, plus 3 requests so far in the current one.
    const counts = new Map([[b(10), 180], [b(11), 180], [b(12), 180], [b(13), 3]]);
    const s = accountMinuteStats(counts, 13 * W + 3_000, W);
    expect(s.minutes).toBe(3);
    expect(s.mean).toBe(180);
    expect(s.peak).toBe(180);
  });

  it('separates a burst from a sustained load — the distinction the remedy turns on', () => {
    const burst = new Map([[b(10), 60], [b(11), 260], [b(12), 60]]);
    const sustained = new Map([[b(10), 200], [b(11), 205], [b(12), 202]]);
    const sb = accountMinuteStats(burst, 13 * W, W);
    const ss = accountMinuteStats(sustained, 13 * W, W);
    expect(sb.peak).toBeGreaterThan(ss.peak);          // burst has the higher peak
    expect(sb.mean).toBeLessThan(ss.mean);             // …and the lower mean
    // Same budget, opposite verdicts.
    expect(quotaCrossingVerdict({ barCeiling: 180, accountObservedPeak: sb.peak, accountObservedMean: sb.mean, accountBudget: 200 }).burstBound).toBe(true);
    expect(quotaCrossingVerdict({ barCeiling: 180, accountObservedPeak: ss.peak, accountObservedMean: ss.mean, accountBudget: 200 }).budgetExhausted).toBe(true);
  });

  it('reports zero minutes observed rather than a fabricated rate when nothing completed', () => {
    // BLIND, not "quiet" — an empty history must not read as a clean all-clear.
    expect(accountMinuteStats(new Map(), 13 * W, W)).toEqual({ mean: 0, peak: 0, minutes: 0 });
    expect(accountMinuteStats(new Map([[b(13), 50]]), 13 * W + 1_000, W).minutes).toBe(0);
  });
});

// TRA-3104 — the hole NO window shape and NO ceiling value closes. The quota is
// account-wide; this gate governs only the COLD, deferrable subset. Asserted so a
// future reader cannot mistake `enforcing: true` for "account spend is bounded" —
// which is exactly why the capacity question is upstream of this whole mechanism.
describe('TRA-3104 — the ceiling bounds only the DEFERRABLE subset', () => {
  const CEILING = 180;

  it('lets hot and deep-MTF pulls through at ANY spend level, so the total is unbounded', () => {
    for (const accountSpendThisMinute of [0, 180, 1_000, 100_000]) {
      expect(
        barPullThrottleGate({ isActiveInterest: true, isDeepMtf: false, accountSpendThisMinute, ceiling: CEILING }).allowed,
      ).toBe(true);
      expect(
        barPullThrottleGate({ isActiveInterest: false, isDeepMtf: true, accountSpendThisMinute, ceiling: CEILING }).allowed,
      ).toBe(true);
    }
  });

  it('reserves the quote slice by counting ACCOUNT-WIDE spend, not bar pulls alone', () => {
    // Budget 200, reservation 20 => cold pulls stand down once the account total
    // (bars + quotes) reaches 180, leaving the reservation genuinely available.
    const ceiling = resolveBarPullCeiling({
      enforceDerived: true, accountBudget: 200, quoteReservation: 20, absoluteCeiling: Number.POSITIVE_INFINITY,
    }).ceiling;
    const gate = (accountSpendThisMinute: number) =>
      barPullThrottleGate({ isActiveInterest: false, isDeepMtf: false, accountSpendThisMinute, ceiling }).allowed;
    expect(gate(179)).toBe(true);
    expect(gate(180)).toBe(false);
    // Bar pulls alone at 170 with 12 quote calls already spent = 182 account-wide
    // => refuse. Metering bars only would have allowed it and eaten the reserve.
    expect(gate(170 + 12)).toBe(false);
  });

  it('reads account-wide spend as a single non-negative number', () => {
    const spend = getTradierAccountSpendThisMinute();
    expect(Number.isFinite(spend)).toBe(true);
    expect(spend).toBeGreaterThanOrEqual(0);
  });
});

describe('getTradierQuotaBudgetState (TRA-3104 health block)', () => {
  it('publishes the budget block INERT by default, with the fixed enforcement window named', () => {
    const s = getTradierQuotaBudgetState();
    expect(s.accountBudgetReqPerMin).toBe(200);
    expect(s.ceilingSource).toBe('disabled');
    expect(s.enforcing).toBe(false);
    expect(s.barCeilingReqPerMin).toBeNull();
    // The window is published so a consumer cannot mistake this for the rolling
    // telemetry meter next to it.
    expect(s.enforcementWindow).toBe('fixed_minute_aligned');
    expect(typeof s.crossed).toBe('boolean');
    expect(s.quoteReservationReqPerMin).toBeGreaterThan(0);
    // The caveat travels WITH the payload — a consumer reading `enforcing` must
    // not conclude the account total is bounded.
    expect(s.boundsDeferrableSubsetOnly).toBe(true);
    expect(typeof s.ceilingUnsatisfiable).toBe('boolean');
    expect(typeof s.budgetExhausted).toBe('boolean');
    expect(typeof s.burstBound).toBe('boolean');
    // The quote path is published as a SUBSET, and named as one, so no consumer
    // repeats the double-count that produced this ticket's headline.
    expect(s.quoteSubsetThisMinute).toBeLessThanOrEqual(s.accountThisMinute);
    expect(typeof s.accountMeanReqPerMin).toBe('number');
    expect(typeof s.accountMinutesObserved).toBe('number');
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
  const base = { isActiveInterest: false, isDeepMtf: false, accountSpendThisMinute: 999, ceiling: 150 };

  it('defers a COLD pull once bar-pull rate reaches the ceiling', () => {
    expect(barPullThrottleGate({ ...base, accountSpendThisMinute: 150 })).toEqual({ allowed: false, reason: 'cold_deferred_ceiling' });
    expect(barPullThrottleGate({ ...base, accountSpendThisMinute: 220 }).allowed).toBe(false);
  });

  it('allows a COLD pull while under the ceiling', () => {
    expect(barPullThrottleGate({ ...base, accountSpendThisMinute: 149 })).toEqual({ allowed: true, reason: 'under_ceiling' });
  });

  it('NEVER defers an active-interest (hot) pull, even far over the ceiling', () => {
    expect(barPullThrottleGate({ ...base, isActiveInterest: true, accountSpendThisMinute: 500 })).toEqual({ allowed: true, reason: 'active_interest' });
  });

  it('NEVER defers a deep-MTF snapshot pull, even far over the ceiling', () => {
    expect(barPullThrottleGate({ ...base, isDeepMtf: true, accountSpendThisMinute: 500 })).toEqual({ allowed: true, reason: 'deep_mtf' });
  });

  it('is DISABLED (never defers) for an unset / non-positive / non-finite ceiling', () => {
    for (const ceiling of [Number.POSITIVE_INFINITY, 0, -1, Number.NaN]) {
      expect(barPullThrottleGate({ ...base, accountSpendThisMinute: 10_000, ceiling })).toEqual({ allowed: true, reason: 'ceiling_disabled' });
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

/**
 * TRA-2627 — the secondary fan-out's coverage ceiling.
 *
 * Provenance: on 2026-07-29 the report tape showed 42.5% of the stock universe on
 * `quoteStatus:'unavailable'` in two discrete staleness buckets. The feed logs
 * (bqb1, `resource=srv-d7mb7rr7uimc73ev0chg`) attribute it to a Tradier **HTTP 503**
 * — `messaging.adaptors.http.flow.ServiceUnavailable`, NOT a quota violation — at
 * 19:10:21.876Z, tripping the quote breaker for 90s and dumping the whole universe
 * onto the secondary chain, which then reported `288/614`, `280/614` and `105/361`
 * twice, all `(feed budget exhausted)`.
 *
 * The budget is spent on SLEEPS, not on work, so the coverage ceiling is a pure
 * function of three constants and is reached before any network time is counted.
 */
describe('secondaryFanoutCeiling (TRA-2627 fan-out coverage bound)', () => {
  it('caps at floor(budget/sleep) * batch — the shipped default is 200 symbols', () => {
    // floor(8000/200) = 40 batches, 5 symbols each.
    expect(secondaryFanoutCeiling(8_000, 200, 5)).toBe(200);
  });

  it('MEASURED CONTROL — predicts the 2026-07-29T00:30:10Z observation', () => {
    // That line read `395/597 symbols failed (feed budget exhausted)` with Tradier
    // dark, i.e. 597 - 395 = 202 symbols actually covered, against a predicted
    // ceiling of 200. This asserts the bound is a bound (covered <= ceiling + one
    // in-flight batch), not merely a number that happens to look close.
    const ceiling = secondaryFanoutCeiling(8_000, 200, 5);
    const covered = 597 - 395;
    expect(covered).toBeLessThanOrEqual(ceiling + 5);
    expect(covered).toBeGreaterThan(ceiling - 5);
  });

  it('is BELOW the live bqb1 universe — the shortfall is arithmetic, not transient', () => {
    // 614 symbols on 2026-07-29. This test is the reason the ticket exists: the
    // constant was sized against the comment above it ("comfortably covers the
    // 25-symbol watchlist") and the universe grew 24x underneath it.
    const LIVE_UNIVERSE = 614;
    const ceiling = secondaryFanoutCeiling(8_000, 200, 5);
    expect(ceiling).toBeLessThan(LIVE_UNIVERSE);
    expect(LIVE_UNIVERSE - ceiling).toBe(414);
  });

  it('KNOWN-GOOD control — a budget that DOES cover the universe reports no shortfall', () => {
    // A test that only ever asserts "the ceiling is too small" would also pass
    // against a function hard-coded to return 0. Prove it moves with its inputs and
    // can clear the universe, so the failing assertions above mean something.
    expect(secondaryFanoutCeiling(30_000, 200, 5)).toBeGreaterThan(614);
    expect(secondaryFanoutCeiling(8_000, 50, 5)).toBe(800);
    expect(secondaryFanoutCeiling(8_000, 200, 20)).toBe(800);
  });

  it('degenerate inputs return 0 rather than Infinity/NaN', () => {
    // A zero sleep would otherwise divide to Infinity and silently report the
    // universe as fully covered — a fail-open on the very number this guards.
    expect(secondaryFanoutCeiling(8_000, 0, 5)).toBe(0);
    expect(secondaryFanoutCeiling(0, 200, 5)).toBe(0);
    expect(secondaryFanoutCeiling(8_000, 200, 0)).toBe(0);
    expect(secondaryFanoutCeiling(Number.NaN, 200, 5)).toBe(0);
  });
});

// TRA-3385 — the primary Tradier batch never knew Tradier's `VIX` spelling for
// the universe's `^VIX`, so `^VIX` fell to the Yahoo secondary chain on every
// tick and was lost 100% of the time the breaker was open (TRA-2682). The alias
// is request-scoped in TradierStocksClient; these tests pin the two behaviours
// the ticket names as the acceptance criteria that CAN be pinned off-box:
// `^VIX` resolves from the primary, and readVix()'s TRA-586 `fetchQuote('VIX')`
// fallback keeps resolving too.
describe('TRA-3385 — ^VIX served by the Tradier primary, both spellings resolve', () => {
  const vixEnvelope = {
    quotes: { quote: { symbol: 'VIX', last: 14.80, change: 0.20, change_percentage: 1.37, volume: 0 } },
  };
  const jsonResponse = (body: unknown): Response =>
    new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

  it('fetchQuote resolves ^VIX AND bare VIX from the Tradier primary (TRA-586 pinned)', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_url: unknown) => jsonResponse(vixEnvelope));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      setTradierStocksFeedClient('tra3385-tok', 'production');
      const caret = await fetchQuote('^VIX');
      const bare = await fetchQuote('VIX');
      expect(caret?.price).toBe(14.80);
      expect(bare?.price).toBe(14.80);
      // Both requests went to Tradier's /markets/quotes under the bare wire
      // spelling — neither leaked a literal ^VIX to the wire nor fell through
      // to the Yahoo secondary chain.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      for (const call of fetchMock.mock.calls) {
        const url = String(call[0]);
        expect(url).toContain('/markets/quotes');
        expect(url).toContain('symbols=VIX');
        expect(url).not.toContain('%5EVIX');
      }
    } finally {
      globalThis.fetch = realFetch;
      setTradierStocksFeedClient('', 'production');
    }
  });

  it('fetchQuotes serves ^VIX from the primary batch — it never reaches the secondary remainder', async () => {
    const realFetch = globalThis.fetch;
    const fetchMock = vi.fn(async (_url: unknown) => jsonResponse(vixEnvelope));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    try {
      setTradierStocksFeedClient('tra3385-tok-2', 'production');
      const out = await fetchQuotes(['^VIX']);
      expect(out.get('^VIX')?.price).toBe(14.80);
      // One Tradier round-trip, zero secondary (Yahoo/chart/Stooq) calls: the
      // symbol was satisfied before the fan-out, which is criterion 1's
      // mechanism (`^VIX` is not in `remaining`).
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain('/markets/quotes');
    } finally {
      globalThis.fetch = realFetch;
      setTradierStocksFeedClient('', 'production');
    }
  });
});

// TRA-3385 (Remedy B) — the un-servable set is logged as a FULL membership once
// per session (again only on change), never a capped 20-name prefix.
describe('recordTradierUnmatched (TRA-3385 un-servable class measurement)', () => {
  it('emits the full sorted membership with counts on first sight', () => {
    __resetTradierUnmatchedForTests();
    const line = recordTradierUnmatched(['BAYN.DE', 'ARX.TO', '2330.TW'], 670);
    expect(line).toContain('3/670');
    expect(line).toContain('unmatched_symbols');
    expect(line).toContain('2330.TW, ARX.TO, BAYN.DE');
  });

  it('suppresses a repeat of the same membership (once per session)', () => {
    __resetTradierUnmatchedForTests();
    expect(recordTradierUnmatched(['ARX.TO'], 670)).not.toBeNull();
    expect(recordTradierUnmatched(['ARX.TO'], 670)).toBeNull();
    // Order must not defeat the dedupe key.
    expect(recordTradierUnmatched(['ARX.TO'], 671)).toBeNull();
  });

  it('re-emits when the membership changes', () => {
    __resetTradierUnmatchedForTests();
    expect(recordTradierUnmatched(['ARX.TO'], 670)).not.toBeNull();
    expect(recordTradierUnmatched(['ARX.TO', 'BB.TO'], 670)).not.toBeNull();
  });

  it('stays silent on an empty set without consuming the session slot', () => {
    __resetTradierUnmatchedForTests();
    expect(recordTradierUnmatched([], 670)).toBeNull();
    expect(recordTradierUnmatched(['ARX.TO'], 670)).not.toBeNull();
  });
});
