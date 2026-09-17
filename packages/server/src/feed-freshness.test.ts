import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';

import {
  evaluateFeedFreshness,
  latestCandleTimestamp,
  MAX_QUOTE_AGE_MS,
  MAX_CANDLE_AGE_MS,
  EQUITY_QUOTE_FAILOVER_ORDER,
  EQUITY_CANDLE_FAILOVER_ORDER,
} from './feed-freshness.js';

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
  it('equity quotes fail over tradier → yahoo → yahooChart → stooq', () => {
    expect(EQUITY_QUOTE_FAILOVER_ORDER).toEqual(['tradier', 'yahoo', 'yahooChart', 'stooq']);
  });

  it('equity candles fail over tradier → yahoo → twelvedata (no stooq — EOD only)', () => {
    expect(EQUITY_CANDLE_FAILOVER_ORDER).toEqual(['tradier', 'yahoo', 'twelvedata']);
    expect(EQUITY_CANDLE_FAILOVER_ORDER).not.toContain('stooq');
  });
});
