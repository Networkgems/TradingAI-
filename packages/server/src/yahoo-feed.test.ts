import { describe, it, expect } from 'vitest';

import {
  evaluateTwelveDataGate,
  isTradierStocksConfigured,
  setTradierStocksFeedClient,
} from './yahoo-feed.js';

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
