import { describe, it, expect, vi } from 'vitest';
import type { TradeSignal } from '@trading-app/shared';
import { CryptoPaperAccount, CRYPTO_MAX_EQUITY, CRYPTO_SLIPPAGE_BPS } from './crypto-account.js';

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

describe('CryptoPaperAccount mark-to-market reconciliation (TRA-703)', () => {
  it('keeps marked equity >= cash for a long-only book (the regression invariant)', () => {
    const acct = new CryptoPaperAccount(25_000);
    const long = buildSignal({ side: 'buy', entryPrice: 100, stopLoss: 99, takeProfit: 110 });
    acct.openPosition(long, 100);
    const cash = acct.getState().availableCash;
    // Even with the price flat at entry, equity (cash + position value) must be
    // >= cash for a long — the exact invariant the header violated in TRA-703.
    const marked = acct.markToMarketEquity(new Map([['BTC-USD', 100]]));
    expect(marked).toBeGreaterThanOrEqual(cash);
  });

  it('reconciles an open short so marked equity tracks cash minus the buyback liability', () => {
    const acct = new CryptoPaperAccount(25_000);
    const short = buildSignal({ side: 'sell', entryPrice: 100, stopLoss: 105, takeProfit: 90 });
    acct.openPosition(short, 100);
    const state = acct.getState();
    // Realized-basis equity sits at the baseline while cash is inflated by the
    // short proceeds — the inconsistent KPI the dashboard surfaced.
    expect(state.availableCash).toBeGreaterThan(state.totalEquity);
    // Marked to the entry price, equity is below cash by exactly the open
    // buyback liability (qty * mark) — i.e. ~the baseline net of the entry fee.
    const marked = acct.markToMarketEquity(new Map([['BTC-USD', 100]]));
    expect(marked).toBeLessThan(state.availableCash);
    expect(marked).toBeCloseTo(state.availableCash - 100 * short_qty(acct), 6);
  });

  it('falls back to entry price when a symbol has no live quote', () => {
    const acct = new CryptoPaperAccount(25_000);
    const long = buildSignal({ side: 'buy', entryPrice: 100, stopLoss: 99, takeProfit: 110 });
    acct.openPosition(long, 100);
    const withQuote = acct.markToMarketEquity(new Map([['BTC-USD', 100]]));
    const noQuote = acct.markToMarketEquity(new Map());
    const zeroQuote = acct.markToMarketEquity(new Map([['BTC-USD', 0]]));
    expect(noQuote).toBeCloseTo(withQuote, 6);
    expect(zeroQuote).toBeCloseTo(withQuote, 6);
  });

  it('getMarkedState derives dailyPnl from the marked equity', () => {
    const acct = new CryptoPaperAccount(25_000);
    const long = buildSignal({ side: 'buy', entryPrice: 100, stopLoss: 99, takeProfit: 110 });
    acct.openPosition(long, 100);
    // Price rallies — a long-only book should show positive daily P&L and
    // equity above cash.
    const marked = acct.getMarkedState(new Map([['BTC-USD', 110]]));
    expect(marked.totalEquity).toBeGreaterThan(marked.availableCash);
    expect(marked.dailyPnl).toBeGreaterThan(0);
    expect(marked.dailyPnl).toBeCloseTo(marked.totalEquity - 25_000, 6);
  });
});

function short_qty(acct: CryptoPaperAccount): number {
  const positions = acct.getState().openPositions;
  return positions.reduce((sum, p) => sum + p.quantity, 0);
}

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
    // TRA-414 — the invariant-breach warning now routes through the structured
    // logger; a `warn` record is written to stderr as a JSON line.
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(acct.enforceEquityInvariant(25_000)).toBe(true);
    expect(
      warn.mock.calls.some((c) => String(c[0]).includes('INVARIANT BREACH')),
    ).toBe(true);
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
    // TRA-414 — suppress the structured-logger stderr line for this case.
    const warn = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(acct.enforceEquityInvariant(25_000)).toBe(true);
    warn.mockRestore();
    expect(acct.getState().availableCash).toBe(25_000);
  });
});

describe('CryptoPaperAccount slippage instrumentation (TRA-536)', () => {
  it('stamps realized (fill-vs-intended drift) and modeled (5 bps budget) slippage at open', () => {
    const acct = new CryptoPaperAccount(25_000);
    // Intended entry 100; live Coinbase fill drifts to 100.4.
    const signal = buildSignal({ entryPrice: 100, stopLoss: 95, takeProfit: 110 });
    const opened = acct.openPosition(signal, 100.4);
    expect(opened).not.toBeNull();
    const qty = opened!.quantity;
    expect(opened!.realizedSlippage).toBeCloseTo(Math.abs(100.4 - 100) * qty, 9);
    expect(opened!.modeledSlippage).toBeCloseTo((CRYPTO_SLIPPAGE_BPS / 10_000) * 100.4 * qty, 9);
  });

  it('carries both slippage figures through the close onto the realized position', () => {
    const acct = new CryptoPaperAccount(25_000);
    const signal = buildSignal({ entryPrice: 100, stopLoss: 95, takeProfit: 110 });
    const opened = acct.openPosition(signal, 100.4);
    const closed = acct.checkExits(new Map([['BTC-USD', 110]]));
    expect(closed).toHaveLength(1);
    expect(closed[0].realizedSlippage).toBeCloseTo(opened!.realizedSlippage!, 9);
    expect(closed[0].modeledSlippage).toBeCloseTo(opened!.modeledSlippage!, 9);
  });
});
