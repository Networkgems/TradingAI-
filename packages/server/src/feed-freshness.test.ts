import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Candle, CryptoSymbolState } from '@trading-app/shared';

import {
  evaluateFeedFreshness,
  latestCandleTimestamp,
  MAX_QUOTE_AGE_MS,
  MAX_CANDLE_AGE_MS,
  CRYPTO_FEED_FAILOVER_ORDER,
  EQUITY_QUOTE_FAILOVER_ORDER,
  EQUITY_CANDLE_FAILOVER_ORDER,
} from './feed-freshness.js';
import { CryptoSignalEngine } from './crypto-engine.js';

// TRA-418 — data-feed freshness gating + ordered failover (TRA-408 review §5).
//
// Before this change, candle/quote caches were used even when stale: a feed
// outage left the last successful data in memory and a strategy could fire a
// brand-new entry signal off a quote that was minutes or hours old. These
// tests pin the freshness-gate decision function and the engine wiring that
// excludes a stale-feed symbol from signal evaluation.

const NOW = 1_700_000_000_000;

function candle(timestamp: number): Candle {
  return { symbol: 'BTC-USD', timestamp, open: 100, high: 101, low: 99, close: 100, volume: 10 };
}

describe('latestCandleTimestamp', () => {
  it('returns null for an empty or undefined series', () => {
    expect(latestCandleTimestamp(undefined)).toBeNull();
    expect(latestCandleTimestamp([])).toBeNull();
  });

  it('returns the most recent timestamp regardless of array order', () => {
    expect(latestCandleTimestamp([candle(NOW - 5_000), candle(NOW - 60_000), candle(NOW - 1_000)]))
      .toBe(NOW - 1_000);
  });

  it('ignores non-finite timestamps', () => {
    expect(latestCandleTimestamp([candle(NOW - 1_000), candle(Number.NaN)])).toBe(NOW - 1_000);
  });
});

describe('evaluateFeedFreshness — freshness gate decision (TRA-418)', () => {
  it('is fresh when both the quote and the latest candle are recent', () => {
    const verdict = evaluateFeedFreshness(
      { quoteLastUpdated: NOW - 30_000, candles: [candle(NOW - 90_000)] },
      NOW,
    );
    expect(verdict.stale).toBe(false);
    expect(verdict.reason).toBeUndefined();
  });

  it('flags stale when the quote is older than the threshold', () => {
    const verdict = evaluateFeedFreshness(
      { quoteLastUpdated: NOW - (MAX_QUOTE_AGE_MS + 60_000), candles: [candle(NOW - 1_000)] },
      NOW,
    );
    expect(verdict.stale).toBe(true);
    expect(verdict.reason).toMatch(/quote/);
  });

  it('flags stale when the latest candle is older than the threshold', () => {
    // Quote is fresh, but the candle feed died — a strategy would otherwise
    // evaluate (and could fire an entry) off hours-old bars.
    const verdict = evaluateFeedFreshness(
      { quoteLastUpdated: NOW - 10_000, candles: [candle(NOW - (MAX_CANDLE_AGE_MS + 60_000))] },
      NOW,
    );
    expect(verdict.stale).toBe(true);
    expect(verdict.reason).toMatch(/candle/);
  });

  it('does not flag stale exactly at the threshold (uses strict >)', () => {
    expect(evaluateFeedFreshness({ quoteLastUpdated: NOW - MAX_QUOTE_AGE_MS }, NOW).stale).toBe(false);
    expect(evaluateFeedFreshness({ candles: [candle(NOW - MAX_CANDLE_AGE_MS)] }, NOW).stale).toBe(false);
  });

  it('treats a never-quoted symbol (lastUpdated 0/undefined) as loading, not stale', () => {
    // A missing quote is handled by the caller's `if (!price) continue` guard;
    // the freshness gate must not mis-classify "loading" as "stale".
    expect(evaluateFeedFreshness({ quoteLastUpdated: 0 }, NOW).stale).toBe(false);
    expect(evaluateFeedFreshness({ quoteLastUpdated: undefined }, NOW).stale).toBe(false);
  });

  it('treats an empty candle cache as loading, not stale', () => {
    expect(evaluateFeedFreshness({ quoteLastUpdated: NOW - 1_000, candles: [] }, NOW).stale).toBe(false);
  });

  it('honours custom thresholds passed via opts', () => {
    const input = { quoteLastUpdated: NOW - 120_000 };
    expect(evaluateFeedFreshness(input, NOW, { maxQuoteAgeMs: 60_000 }).stale).toBe(true);
    expect(evaluateFeedFreshness(input, NOW, { maxQuoteAgeMs: 300_000 }).stale).toBe(false);
  });
});

describe('feed failover order constants (TRA-418)', () => {
  it('crypto fails over coinbase → yahoo → cmc', () => {
    expect(CRYPTO_FEED_FAILOVER_ORDER).toEqual(['coinbase', 'yahoo', 'cmc']);
  });

  it('equity quotes fail over tradier → yahoo → stooq', () => {
    expect(EQUITY_QUOTE_FAILOVER_ORDER).toEqual(['tradier', 'yahoo', 'stooq']);
  });

  it('equity candles fail over tradier → yahoo → twelvedata (no stooq — EOD only)', () => {
    expect(EQUITY_CANDLE_FAILOVER_ORDER).toEqual(['tradier', 'yahoo', 'twelvedata']);
    expect(EQUITY_CANDLE_FAILOVER_ORDER).not.toContain('stooq');
  });
});

// ── Engine-level gate wiring ─────────────────────────────────────────────────
// Acceptance: "Symbols whose feed is stale beyond the threshold do not produce
// signals." `markStaleSymbols` is the private gate the demo + live tick loops
// call before strategy evaluation; we exercise it directly via a typed cast.
interface CryptoEngineGateInternals {
  symbolState: Map<string, CryptoSymbolState>;
  candleCache: Map<string, Candle[]>;
  markStaleSymbols: (symbols: readonly string[]) => Set<string>;
}

describe('CryptoSignalEngine.markStaleSymbols — engine freshness gate (TRA-418)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  function freshCandles(now: number): Candle[] {
    return [candle(now - 180_000), candle(now - 120_000), candle(now - 60_000)];
  }

  it('excludes a symbol whose quote has gone stale and marks quoteStatus=stale', () => {
    const engine = new CryptoSignalEngine() as unknown as CryptoEngineGateInternals;
    const now = Date.now();
    // FRESH-USD: quote + candles current → still evaluated.
    engine.symbolState.set('FRESH-USD', {
      symbol: 'FRESH-USD', price: 1, volume: 0, change: 0, changePct: 0,
      lastUpdated: now - 10_000, quoteStatus: 'ok',
    });
    engine.candleCache.set('FRESH-USD', freshCandles(now));
    // STALE-USD: quote last updated well past the threshold (feed down).
    engine.symbolState.set('STALE-USD', {
      symbol: 'STALE-USD', price: 2, volume: 0, change: 0, changePct: 0,
      lastUpdated: now - (MAX_QUOTE_AGE_MS + 120_000), quoteStatus: 'ok',
    });
    engine.candleCache.set('STALE-USD', freshCandles(now));

    const stale = engine.markStaleSymbols(['FRESH-USD', 'STALE-USD']);

    expect(stale.has('STALE-USD')).toBe(true);
    expect(stale.has('FRESH-USD')).toBe(false);
    // The stale symbol is marked so the watchlist UI surfaces the degraded feed.
    expect(engine.symbolState.get('STALE-USD')?.quoteStatus).toBe('stale');
    expect(engine.symbolState.get('FRESH-USD')?.quoteStatus).toBe('ok');
    // Last known price is preserved under the stale badge — no Loading… reset.
    expect(engine.symbolState.get('STALE-USD')?.price).toBe(2);
  });

  it('excludes a symbol whose candle cache has gone stale even when the quote is fresh', () => {
    const engine = new CryptoSignalEngine() as unknown as CryptoEngineGateInternals;
    const now = Date.now();
    engine.symbolState.set('BTC-USD', {
      symbol: 'BTC-USD', price: 50_000, volume: 0, change: 0, changePct: 0,
      lastUpdated: now - 5_000, quoteStatus: 'ok',
    });
    // Candle feed died: the latest bar is far past the candle threshold.
    engine.candleCache.set('BTC-USD', [candle(now - (MAX_CANDLE_AGE_MS + 600_000))]);

    const stale = engine.markStaleSymbols(['BTC-USD']);

    expect(stale.has('BTC-USD')).toBe(true);
    expect(engine.symbolState.get('BTC-USD')?.quoteStatus).toBe('stale');
  });
});
