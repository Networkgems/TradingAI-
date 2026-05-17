import { describe, it, expect } from 'vitest';

import { evaluateTwelveDataGate } from './yahoo-feed.js';

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
