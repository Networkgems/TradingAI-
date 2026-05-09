import { describe, it, expect } from 'vitest';
import type { TradierTradeHistoryFill } from '@trading-app/engine';
import {
  aggregateRealizedOptionsPnl,
  aggregateOptionCloses,
  isOptionCloseDescription,
} from './tradier-reconcile.js';

function fill(overrides: Partial<TradierTradeHistoryFill> = {}): TradierTradeHistoryFill {
  return {
    date: '2026-05-08',
    symbol: 'SPY260515C00450000',
    tradeType: 'option',
    description: 'Sell to Close 2 SPY May 15 2026 $450 Call',
    price: 1.85,
    quantity: 2,
    amount: 370,
    commission: 0,
    transactionId: 'tx-1',
    ...overrides,
  };
}

describe('isOptionCloseDescription', () => {
  it('matches Sell to Close (long close)', () => {
    expect(isOptionCloseDescription('Sell to Close 2 SPY ...')).toBe(true);
  });

  it('matches Buy to Close (short close)', () => {
    expect(isOptionCloseDescription('Buy to Close 1 SPY ...')).toBe(true);
  });

  it('rejects Buy to Open', () => {
    expect(isOptionCloseDescription('Buy to Open 2 SPY ...')).toBe(false);
  });
});

describe('aggregateOptionCloses', () => {
  it('sums per-day amounts for sell-to-close fills', () => {
    const totals = aggregateOptionCloses(
      [
        fill({ amount: 370, transactionId: 'a', date: '2026-05-08' }),
        fill({ amount: 120, transactionId: 'b', date: '2026-05-09' }),
      ],
      new Set<string>(),
    );
    expect(totals.realizedByDate.get('2026-05-08')).toBe(370);
    expect(totals.realizedByDate.get('2026-05-09')).toBe(120);
    expect(totals.seenTransactionIds.size).toBe(2);
  });

  it('skips already-seen transaction ids (dedup)', () => {
    const totals = aggregateOptionCloses(
      [
        fill({ amount: 370, transactionId: 'a' }),
        fill({ amount: 120, transactionId: 'b' }),
      ],
      new Set(['a']),
    );
    expect(totals.realizedByDate.get('2026-05-08')).toBe(120);
    expect(totals.seenTransactionIds.size).toBe(1);
    expect(totals.seenTransactionIds.has('b')).toBe(true);
  });

  it('skips equity legs', () => {
    const totals = aggregateOptionCloses(
      [
        fill({ tradeType: 'equity', description: 'Sell 100 AAPL', amount: 19000 }),
      ],
      new Set<string>(),
    );
    expect(totals.realizedByDate.size).toBe(0);
  });

  it('skips opening fills', () => {
    const totals = aggregateOptionCloses(
      [
        fill({ description: 'Buy to Open 2 SPY ...', amount: -370, transactionId: 'open' }),
      ],
      new Set<string>(),
    );
    expect(totals.realizedByDate.size).toBe(0);
  });
});

describe('aggregateRealizedOptionsPnl', () => {
  it('pairs Buy-to-Open with Sell-to-Close to compute realized P&L', () => {
    const totals = aggregateRealizedOptionsPnl(
      [
        fill({
          description: 'Buy to Open 2 SPY ...',
          amount: -300,
          transactionId: 'open',
          date: '2026-05-01',
        }),
        fill({
          description: 'Sell to Close 2 SPY ...',
          amount: 370,
          transactionId: 'close',
          date: '2026-05-08',
        }),
      ],
      new Set<string>(),
    );
    // Realized = close proceeds (+370) + open cost (−300) = +70
    expect(totals.realizedByDate.get('2026-05-08')).toBe(70);
    // Only the close emits a seen-id; opens are tracked as cost basis only.
    expect(totals.seenTransactionIds.size).toBe(1);
    expect(totals.seenTransactionIds.has('close')).toBe(true);
  });

  it('falls back to close proceeds when the open lives outside the window', () => {
    const totals = aggregateRealizedOptionsPnl(
      [
        fill({
          description: 'Sell to Close 2 SPY ...',
          amount: 370,
          transactionId: 'close',
        }),
      ],
      new Set<string>(),
    );
    // No matching open in the window → fall back to raw close proceeds.
    expect(totals.realizedByDate.get('2026-05-08')).toBe(370);
  });

  it('respects the dedup cursor', () => {
    const totals = aggregateRealizedOptionsPnl(
      [fill({ description: 'Sell to Close 2 SPY ...', transactionId: 'seen' })],
      new Set(['seen']),
    );
    expect(totals.realizedByDate.size).toBe(0);
    expect(totals.seenTransactionIds.size).toBe(0);
  });
});
