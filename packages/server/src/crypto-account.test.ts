import { describe, it, expect, vi } from 'vitest';
import type { TradeSignal } from '@trading-app/shared';
import { CryptoPaperAccount, CRYPTO_MAX_EQUITY } from './crypto-account.js';

function buildSignal(overrides: Partial<TradeSignal> = {}): TradeSignal {
  return {
    id: 'sig-1',
    symbol: 'BTC-USD',
    type: 'breakout_vol',
    side: 'buy',
    entryPrice: 100,
    stopLoss: 95,
    takeProfit: 110,
    riskRewardRatio: 2,
    timestamp: Date.now(),
    ...overrides,
  };
}

describe('CryptoPaperAccount short cash flow (TRA-330)', () => {
  it('opens a short by crediting cash with the entry notional, not debiting it', () => {
    const acct = new CryptoPaperAccount(25_000);
    const signal = buildSignal({
      side: 'sell',
      entryPrice: 100,
      stopLoss: 105, // tight stop → small risk slice → small qty
      takeProfit: 90,
    });
    const before = acct.getState();
    const opened = acct.openPosition(signal, 100);
    expect(opened).not.toBeNull();
    const after = acct.getState();
    // Short proceeds land in cash; equity is unchanged until the position closes.
    expect(after.availableCash).toBeGreaterThan(before.availableCash);
    expect(after.totalEquity).toBe(before.totalEquity);
  });

  it('keeps cash and equity in lock-step across a winning short cycle', () => {
    const acct = new CryptoPaperAccount(25_000);
    const signal = buildSignal({
      side: 'sell',
      entryPrice: 100,
      stopLoss: 105,
      takeProfit: 90,
    });
    const startingEquity = acct.getEquity();
    const opened = acct.openPosition(signal, 100);
    expect(opened).not.toBeNull();
    // Price drops to TP — short profits.
    const closed = acct.checkExits(new Map([['BTC-USD', 90]]));
    expect(closed).toHaveLength(1);
    const post = acct.getState();
    // No open positions ⇒ cash must equal equity, the invariant longs already
    // satisfied. Pre-fix the short path drove these apart.
    expect(post.availableCash).toBeCloseTo(post.totalEquity, 6);
    expect(post.totalEquity).toBeGreaterThan(startingEquity);
  });

  it('keeps cash and equity in lock-step across a losing short cycle', () => {
    const acct = new CryptoPaperAccount(25_000);
    const signal = buildSignal({
      side: 'sell',
      entryPrice: 100,
      stopLoss: 105,
      takeProfit: 90,
    });
    const startingEquity = acct.getEquity();
    const opened = acct.openPosition(signal, 100);
    expect(opened).not.toBeNull();
    // Price rises to SL — short loses.
    const closed = acct.checkExits(new Map([['BTC-USD', 105]]));
    expect(closed).toHaveLength(1);
    const post = acct.getState();
    expect(post.availableCash).toBeCloseTo(post.totalEquity, 6);
    expect(post.totalEquity).toBeLessThan(startingEquity);
  });

  it('does not gate shorts on the cash-cost check (shorts collateralise on equity)', () => {
    const acct = new CryptoPaperAccount(25_000);
    // Open longs to drain cash to ~0.
    const long = buildSignal({ side: 'buy', entryPrice: 100, stopLoss: 99, takeProfit: 110 });
    acct.openPosition(long, 100);
    // Despite low cash, a short should still be openable on margin.
    const short = buildSignal({
      id: 'sig-2',
      symbol: 'ETH-USD',
      side: 'sell',
      entryPrice: 200,
      stopLoss: 210,
      takeProfit: 180,
    });
    const opened = acct.openPosition(short, 200);
    expect(opened).not.toBeNull();
  });
});

describe('CryptoPaperAccount.enforceEquityInvariant (TRA-330)', () => {
  it('returns false and leaves state untouched when equity is healthy', () => {
    const acct = new CryptoPaperAccount(25_000);
    const before = acct.exportSnapshot();
    expect(acct.enforceEquityInvariant(25_000)).toBe(false);
    expect(acct.exportSnapshot()).toEqual(before);
  });

  it('rebases equity, cash, and openingEquity when equity exceeds CRYPTO_MAX_EQUITY', () => {
    const acct = new CryptoPaperAccount(25_000);
    const corrupt = CRYPTO_MAX_EQUITY * 25; // mimic the prod $2.5B drift
    acct.importSnapshot({
      cash: corrupt,
      equity: corrupt * 2,
      initialEquity: corrupt,
      openingEquityToday: corrupt,
      openPositions: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(acct.enforceEquityInvariant(25_000)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    const post = acct.getState();
    expect(post.totalEquity).toBe(25_000);
    expect(post.availableCash).toBe(25_000);
    expect(post.dailyPnl).toBe(0);
    expect(post.openPositions).toHaveLength(0);
    expect(acct.getInitialEquity()).toBe(25_000);
  });

  it('also trips when only cash is corrupted (e.g. equity tracked but cash drift)', () => {
    const acct = new CryptoPaperAccount(25_000);
    acct.importSnapshot({
      cash: -CRYPTO_MAX_EQUITY * 2,
      equity: 25_000,
      initialEquity: 25_000,
      openingEquityToday: 25_000,
      openPositions: [],
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(acct.enforceEquityInvariant(25_000)).toBe(true);
    warn.mockRestore();
    expect(acct.getState().availableCash).toBe(25_000);
  });
});
