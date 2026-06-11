import { describe, it, expect } from 'vitest';
import type { TradierCashEvent, TradierTradeHistoryFill } from '@trading-app/engine';
import {
  aggregateCashFlowByDate,
  aggregateRealizedOptionsPnl,
  aggregateOptionCloses,
  computeBalanceDailyPnl,
  findPreviousBalanceSnapshot,
  isOptionCloseDescription,
  realizedOptionsPnlByCloseDate,
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

// TRA-359 — broker-truth Live calendar.
//
// The Live P&L calendar was sourcing daily P&L from engine state, which
// drifted from Tradier reality whenever imported positions closed
// (gross proceeds were booked as P&L) or stocks moved on imported rows
// without a mark refresh. These tests pin the new broker-truth path:
// per-day cash flow aggregation, balance-delta P&L, and dedup-cursor
// behaviour so a re-fetch doesn't double-count a single deposit.

function cashEvent(overrides: Partial<TradierCashEvent> = {}): TradierCashEvent {
  return {
    date: '2026-05-07',
    type: 'ach',
    amount: 500,
    transactionId: 'cash-1',
    ...overrides,
  };
}

describe('aggregateCashFlowByDate (TRA-359)', () => {
  it('sums per-day signed amounts across deposits and withdrawals', () => {
    const totals = aggregateCashFlowByDate(
      [
        cashEvent({ date: '2026-05-01', amount: 300, transactionId: 'a' }),
        cashEvent({ date: '2026-05-07', amount: 500, transactionId: 'b' }),
        cashEvent({ date: '2026-05-07', amount: -50, transactionId: 'c', type: 'withdrawal' }),
      ],
      new Set<string>(),
    );
    expect(totals.netByDate.get('2026-05-01')).toBe(300);
    expect(totals.netByDate.get('2026-05-07')).toBe(450);
    expect(totals.seenTransactionIds.size).toBe(3);
  });

  it('skips already-seen transaction ids (dedup cursor)', () => {
    const totals = aggregateCashFlowByDate(
      [
        cashEvent({ amount: 500, transactionId: 'a' }),
        cashEvent({ amount: 200, transactionId: 'b' }),
      ],
      new Set(['a']),
    );
    expect(totals.netByDate.get('2026-05-07')).toBe(200);
    expect(totals.seenTransactionIds.size).toBe(1);
    expect(totals.seenTransactionIds.has('b')).toBe(true);
  });

  it('returns empty totals when every event is already seen', () => {
    const totals = aggregateCashFlowByDate(
      [cashEvent({ transactionId: 'a' }), cashEvent({ transactionId: 'b' })],
      new Set(['a', 'b']),
    );
    expect(totals.netByDate.size).toBe(0);
    expect(totals.seenTransactionIds.size).toBe(0);
  });
});

describe('computeBalanceDailyPnl (TRA-359)', () => {
  it('subtracts net cash flow from the balance delta', () => {
    // 5/7 user reality: balance went $300 → $800 because of a $500 ACH deposit,
    // not a $500 trading win. P&L = 800 − 300 − 500 = 0.
    expect(computeBalanceDailyPnl(800, 300, 500)).toBe(0);
  });

  it('reports a clean loss when no cash flow', () => {
    // 5/13: $759.29 → $591.22 with no deposits → P&L = −168.07.
    expect(computeBalanceDailyPnl(591.22, 759.29, 0)).toBeCloseTo(-168.07, 2);
  });

  it('handles a withdrawal (negative cash flow) without booking it as a gain', () => {
    // Withdrew $100 and balance dropped from $1000 → $880 → P&L = 880 − 1000 − (−100) = −20.
    expect(computeBalanceDailyPnl(880, 1000, -100)).toBe(-20);
  });

  it('returns null when prev balance is unknown', () => {
    expect(computeBalanceDailyPnl(500, null, 0)).toBeNull();
    expect(computeBalanceDailyPnl(500, undefined, 0)).toBeNull();
  });

  it('returns null when today balance is unknown / non-finite', () => {
    expect(computeBalanceDailyPnl(null, 400, 0)).toBeNull();
    expect(computeBalanceDailyPnl(Number.NaN, 400, 0)).toBeNull();
  });

  it('treats a non-finite cash flow as zero rather than poisoning the P&L', () => {
    // Bad data shouldn't cascade — fall back to delta-only and let the
    // user see the unadjusted P&L instead of NaN in the calendar cell.
    expect(computeBalanceDailyPnl(500, 400, Number.NaN)).toBe(100);
  });
});

describe('findPreviousBalanceSnapshot (TRA-359)', () => {
  it('returns the most recent prior date when one exists', () => {
    const snapshots = {
      '2026-05-08': 801.22,
      '2026-05-11': 785.98,
      '2026-05-12': 759.29,
    };
    // 5/13 → prev = 5/12
    expect(findPreviousBalanceSnapshot(snapshots, '2026-05-13')).toEqual({
      date: '2026-05-12',
      balance: 759.29,
    });
  });

  it('skips over weekend gaps (Sat/Sun have no snapshot)', () => {
    const snapshots = {
      '2026-05-08': 801.22, // Friday
      '2026-05-11': 785.98, // Monday — Sat/Sun had no snapshot
    };
    expect(findPreviousBalanceSnapshot(snapshots, '2026-05-11')).toEqual({
      date: '2026-05-08',
      balance: 801.22,
    });
  });

  it('returns null when no prior date exists', () => {
    const snapshots = {
      '2026-05-13': 591.22,
      '2026-05-14': 600.00,
    };
    // 5/01 → no prior snapshot (file was just seeded)
    expect(findPreviousBalanceSnapshot(snapshots, '2026-05-01')).toBeNull();
  });

  it('excludes a snapshot dated exactly on the target', () => {
    const snapshots = {
      '2026-05-12': 759.29,
      '2026-05-13': 591.22,
    };
    // Asking for prev of 5/13 must not return 5/13 itself.
    expect(findPreviousBalanceSnapshot(snapshots, '2026-05-13')).toEqual({
      date: '2026-05-12',
      balance: 759.29,
    });
  });

  it('returns null for an empty snapshots map', () => {
    expect(findPreviousBalanceSnapshot({}, '2026-05-13')).toBeNull();
  });
});

describe('realizedOptionsPnlByCloseDate', () => {
  // TRA-244 — the real ENOCK ETIENNE (#80154) June fills from the Tradier
  // brokerage confirmations the board attached. Opens Jun 2/3, closes Jun 4.
  // `amount` is signed broker net cash (buys negative, sells positive).
  const juneFills: TradierTradeHistoryFill[] = [
    // Jun 2 open: 1 NVDA $250 ADJ call
    fill({ date: '2026-06-02', symbol: 'NVDA_250_ADJ', description: 'OPEN CONTRACT', quantity: 1, amount: -123.11, transactionId: 'o1' }),
    // Jun 3 opens
    fill({ date: '2026-06-03', symbol: 'NU_14', description: 'OPEN CONTRACT', quantity: 3, amount: -105.33, transactionId: 'o2' }),
    fill({ date: '2026-06-03', symbol: 'NVDA_230', description: 'OPEN CONTRACT', quantity: 4, amount: -96.43, transactionId: 'o3' }),
    fill({ date: '2026-06-03', symbol: 'NVDA_240_ADJ', description: 'OPEN CONTRACT', quantity: 1, amount: -124.11, transactionId: 'o4' }),
    fill({ date: '2026-06-03', symbol: 'NVDA_250_ADJ', description: 'OPEN CONTRACT', quantity: 1, amount: -60.11, transactionId: 'o5' }),
    // Jun 4 closes (Sell to Close everything)
    fill({ date: '2026-06-04', symbol: 'NU_14', description: 'CLOSING CONTRACT', quantity: 3, amount: 173.65, transactionId: 'c1' }),
    fill({ date: '2026-06-04', symbol: 'NVDA_230', description: 'CLOSING CONTRACT', quantity: 4, amount: 19.55, transactionId: 'c2' }),
    fill({ date: '2026-06-04', symbol: 'NVDA_240_ADJ', description: 'CLOSING CONTRACT', quantity: 1, amount: 67.87, transactionId: 'c3' }),
    fill({ date: '2026-06-04', symbol: 'NVDA_250_ADJ', description: 'CLOSING CONTRACT', quantity: 2, amount: 67.75, transactionId: 'c4' }),
  ];

  it('books the Jun 4 round-trip at broker-truth realized −$180.27, all other days flat', () => {
    const { realizedByDate, closeCountByDate } = realizedOptionsPnlByCloseDate(juneFills);
    expect(realizedByDate.get('2026-06-04')!).toBeCloseTo(-180.27, 2);
    // Opens-only days are NOT realized P&L days.
    expect(realizedByDate.has('2026-06-02')).toBe(false);
    expect(realizedByDate.has('2026-06-03')).toBe(false);
    expect(closeCountByDate.get('2026-06-04')).toBe(4);
  });

  it('matches a 2-contract close across two separate open lots (FIFO)', () => {
    // NVDA_250_ADJ: opened 1 @ $123.11 (Jun 2) + 1 @ $60.11 (Jun 3) = $183.22
    // cost; closed 2 @ $67.75 proceeds ⇒ 67.75 − 183.22 = −115.47.
    const only250 = juneFills.filter(f => f.symbol === 'NVDA_250_ADJ');
    const { realizedByDate } = realizedOptionsPnlByCloseDate(only250);
    expect(realizedByDate.get('2026-06-04')!).toBeCloseTo(-115.47, 2);
  });

  it('skips an unmatched close instead of booking gross proceeds (the old bug)', () => {
    const orphanClose: TradierTradeHistoryFill[] = [
      fill({ date: '2026-06-05', symbol: 'IMPORTED', description: 'CLOSING CONTRACT', quantity: 1, amount: 79.5, transactionId: 'x1' }),
    ];
    const { realizedByDate } = realizedOptionsPnlByCloseDate(orphanClose);
    expect(realizedByDate.has('2026-06-05')).toBe(false);
  });

  it('ignores equity legs (out of scope — long options only)', () => {
    const withEquity: TradierTradeHistoryFill[] = [
      ...juneFills,
      fill({ date: '2026-06-08', symbol: 'LASE', tradeType: 'equity', description: 'Sell', quantity: 2, amount: 13.36, transactionId: 'e1' }),
    ];
    const { realizedByDate } = realizedOptionsPnlByCloseDate(withEquity);
    expect(realizedByDate.has('2026-06-08')).toBe(false);
  });
});
