// TRA-598 (TRA-595 C3) — order-time enforcement of the no-day-trading guardrail
// on PaperOptionsAccount: the entry-DTE floor blocks 0DTE / sub-threshold
// entries, and the discretionary-close gate blocks a same-session round trip
// while still allowing the close on a later session (no trap).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import { DAY_TRADING_GUARDRAIL } from '@trading-app/shared';
import type { RelativeValueSignal } from '@trading-app/shared';

// 2024-06-04 10:00 ET (Tuesday) — inside a valid ET trading window so the open
// paths' window guard passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const ONE_DAY_MS = 24 * 60 * 60_000;

function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-1',
    symbol: 'AAPL',
    type: 'relative_value',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05', // 31 DTE from TRADING_TIME — clears the 7-day floor
    mark: 1.0,
    fairPrice: 1.3,
    mispricingPct: -0.23,
    zScore: -2.1,
    ivFitted: 0.32,
    ivUsed: 0.28,
    delta: 0.18,
    reason: 'cheap-vs-curve',
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('no-day-trading entry-DTE guard (order time)', () => {
  it('opens an entry comfortably inside the DTE window', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo');
    expect(pos).not.toBeNull();
  });

  it('rejects a 0DTE entry', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildRvSignal({ optionSymbol: 'AAPL240604C00200000', expiration: '2024-06-04' });
    expect(acct.openOptionFromRvCandidate(sig, 'demo')).toBeNull();
    // Nothing consumed — the reject is before any cash/counter mutation.
    expect(acct.getState().dailyOptionsCount).toBe(0);
  });

  it('rejects a sub-threshold (3 DTE) entry', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildRvSignal({ optionSymbol: 'AAPL240607C00200000', expiration: '2024-06-07' });
    expect(acct.openOptionFromRvCandidate(sig, 'demo')).toBeNull();
  });

  it('respects a config override on the entry floor', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      dayTradingGuardrail: { ...DAY_TRADING_GUARDRAIL, minEntryDteDays: 40 },
    });
    // 31 DTE now falls below the raised 40-day floor.
    expect(acct.openOptionFromRvCandidate(buildRvSignal(), 'demo')).toBeNull();
  });
});

describe('no-day-trading discretionary-close guard (same-session round trip)', () => {
  it('blocks closing a position opened in the same session', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo')!;
    expect(pos).not.toBeNull();
    const verdict = acct.checkDayTradingClose(pos.id, TRADING_TIME);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/no day trading/i);
  });

  it('allows closing the same position on a later session', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo')!;
    const nextSession = TRADING_TIME + ONE_DAY_MS;
    expect(acct.checkDayTradingClose(pos.id, nextSession).allowed).toBe(true);
  });

  it('allows when the same-session block is disabled by config', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      dayTradingGuardrail: { ...DAY_TRADING_GUARDRAIL, blockSameSessionRoundTrip: false },
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo')!;
    expect(acct.checkDayTradingClose(pos.id, TRADING_TIME).allowed).toBe(true);
  });

  it('returns allowed for an unknown option id (caller resolves not-found)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.checkDayTradingClose('nope', TRADING_TIME).allowed).toBe(true);
  });
});
