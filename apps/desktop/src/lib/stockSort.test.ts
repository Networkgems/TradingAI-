// TRA-339 — coverage for the Stock-dashboard sort-value resolvers. These feed
// SortableTH/sortRows on the Positions and Options tabs, so a wrong branch here
// silently mis-sorts a column. The issue specifically asked for symbol (both
// ways), P&L %, P&L $ and cost to be sortable — those are asserted directly,
// including the short-side sign flip and the live-quote / fallback paths.
import { describe, expect, it } from 'vitest';
import type { OptionPosition, Position } from '@trading-app/shared';
import type { SymbolState } from '../types/app';
import { sortRows } from './sort';
import {
  getOptionClosedSortValue,
  getOptionOpenSortValue,
  getStockClosedPosSortValue,
  getStockOpenPosSortValue,
  getStockWatchSortValue,
} from './stockSort';

function pos(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'AAPL',
    side: 'buy',
    signalType: 'momentum',
    entryPrice: 100,
    quantity: 10,
    stopLoss: 90,
    takeProfit: 120,
    openedAt: 1_000,
    ...over,
  };
}

function sym(over: Partial<SymbolState> = {}): SymbolState {
  return { symbol: 'AAPL', price: 110, volume: 0, change: 0, changePct: 0, lastUpdated: 5_000, ...over };
}

function opt(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'o1',
    symbol: 'AAPL',
    optionType: 'call',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 1.0,
    currentPremium: 1.5,
    tp1Premium: 1.25,
    tp1Hit: false,
    stopLossPremium: 0.75,
    peakPremium: 1.6,
    trailingActive: false,
    trailingStopPremium: 1.4,
    underlyingEntryPrice: 100,
    openedAt: 1_000,
    signalId: 's1',
    signalType: 'otm_mispricing',
    ...over,
  };
}

describe('getStockOpenPosSortValue', () => {
  const symbols = [sym({ symbol: 'AAPL', price: 110 })];

  it('returns cost as entry × quantity', () => {
    expect(getStockOpenPosSortValue(pos(), 'cost', symbols)).toBe(1_000);
  });

  it('computes P&L % off the live quote for a long', () => {
    // (110 - 100) / 100 * 100 = +10%
    expect(getStockOpenPosSortValue(pos(), 'pnlPct', symbols)).toBeCloseTo(10);
  });

  it('computes P&L $ off the live quote for a long', () => {
    // (110 - 100) * 10 = +100
    expect(getStockOpenPosSortValue(pos(), 'pnlDollar', symbols)).toBeCloseTo(100);
  });

  it('flips P&L sign for a short position', () => {
    const short = pos({ side: 'sell' });
    expect(getStockOpenPosSortValue(short, 'pnlPct', symbols)).toBeCloseTo(-10);
    expect(getStockOpenPosSortValue(short, 'pnlDollar', symbols)).toBeCloseTo(-100);
  });

  it('falls back to entry price (flat P&L) when there is no live quote', () => {
    expect(getStockOpenPosSortValue(pos({ symbol: 'ZZZZ' }), 'pnlDollar', symbols)).toBe(0);
    expect(getStockOpenPosSortValue(pos({ symbol: 'ZZZZ' }), 'current', symbols)).toBe(100);
  });
});

describe('getStockClosedPosSortValue', () => {
  it('uses the recorded exit price for P&L %', () => {
    const p = pos({ exitPrice: 120 });
    expect(getStockClosedPosSortValue(p, 'pnlPct')).toBeCloseTo(20);
  });

  it('prefers the stored realised pnl for P&L $ when present', () => {
    const p = pos({ exitPrice: 120, pnl: 42 });
    expect(getStockClosedPosSortValue(p, 'pnlDollar')).toBe(42);
  });

  it('falls back to entry price when exit is missing', () => {
    expect(getStockClosedPosSortValue(pos(), 'exit')).toBe(100);
  });
});

describe('getStockWatchSortValue', () => {
  it('returns the symbol for the symbol key', () => {
    expect(getStockWatchSortValue(sym({ symbol: 'NVDA' }), 'symbol')).toBe('NVDA');
  });

  it('nulls out numeric columns for an unquoted symbol so it sinks to the bottom', () => {
    const cold = sym({ lastUpdated: 0, price: 0 });
    expect(getStockWatchSortValue(cold, 'price')).toBeNull();
    // symbol + updated stay sortable even with no quote yet.
    expect(getStockWatchSortValue(cold, 'symbol')).toBe('AAPL');
    expect(getStockWatchSortValue(cold, 'updated')).toBe(0);
  });
});

describe('option resolvers', () => {
  it('computes open-option P&L $ from mark vs paid over remaining contracts', () => {
    // (1.5 - 1.0) * 2 * 100 = +100, plus realised pnl (0 here)
    expect(getOptionOpenSortValue(opt(), 'pnlDollar')).toBeCloseTo(100);
  });

  it('reports the trailing status string', () => {
    expect(getOptionOpenSortValue(opt({ trailingActive: true }), 'status')).toBe('trailing');
    expect(getOptionOpenSortValue(opt({ trailingActive: false }), 'status')).toBe('open');
  });

  it('computes closed-option P&L % from exit premium vs entry', () => {
    // (1.5 - 1.0) / 1.0 * 100 = +50%
    expect(getOptionClosedSortValue(opt(), 'pnlPct')).toBeCloseTo(50);
  });

  it('guards closed-option P&L % against a zero entry premium', () => {
    expect(getOptionClosedSortValue(opt({ premiumPaid: 0 }), 'pnlPct')).toBe(0);
  });
});

describe('end-to-end: sortRows with a stock resolver', () => {
  const symbols = [sym({ symbol: 'AAPL', price: 110 }), sym({ symbol: 'TSLA', price: 90 })];
  const rows = [
    pos({ id: 'a', symbol: 'TSLA' }),
    pos({ id: 'b', symbol: 'AAPL' }),
  ];

  it('orders symbols alphabetically both ways', () => {
    const asc = sortRows(rows, { key: 'symbol', dir: 'asc' }, (p, k) => getStockOpenPosSortValue(p, k, symbols));
    expect(asc.map(p => p.symbol)).toEqual(['AAPL', 'TSLA']);
    const desc = sortRows(rows, { key: 'symbol', dir: 'desc' }, (p, k) => getStockOpenPosSortValue(p, k, symbols));
    expect(desc.map(p => p.symbol)).toEqual(['TSLA', 'AAPL']);
  });
});
