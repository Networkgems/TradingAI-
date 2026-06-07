// TRA-339 — coverage for the Crypto-dashboard sort-value resolvers. Mirrors the
// Stock resolver tests (symbol both ways, P&L %, P&L $, cost, short-side sign)
// and adds the perp-only leverage / liquidation columns, which must resolve to
// null for spot positions so they sink to the bottom rather than sorting as 0.
import { describe, expect, it } from 'vitest';
import type { CryptoSymbolState, Position } from '@trading-app/shared';
import { sortRows } from './sort';
import {
  getCryptoClosedPosSortValue,
  getCryptoOpenPosSortValue,
  getCryptoWatchSortValue,
} from './cryptoSort';

function pos(over: Partial<Position> = {}): Position {
  return {
    id: 'p1',
    symbol: 'BTC-USD',
    side: 'buy',
    signalType: 'momentum',
    entryPrice: 100,
    quantity: 2,
    stopLoss: 90,
    takeProfit: 120,
    openedAt: 1_000,
    ...over,
  };
}

function sym(over: Partial<CryptoSymbolState> = {}): CryptoSymbolState {
  return { symbol: 'BTC-USD', price: 110, volume: 0, change: 0, changePct: 0, lastUpdated: 5_000, ...over };
}

describe('getCryptoOpenPosSortValue', () => {
  const symbols = [sym({ symbol: 'BTC-USD', price: 110 })];

  it('returns cost as entry × quantity', () => {
    expect(getCryptoOpenPosSortValue(pos(), 'cost', symbols)).toBe(200);
  });

  it('computes P&L % and P&L $ off the live quote for a long', () => {
    expect(getCryptoOpenPosSortValue(pos(), 'pnlPct', symbols)).toBeCloseTo(10);
    expect(getCryptoOpenPosSortValue(pos(), 'pnlDollar', symbols)).toBeCloseTo(20);
  });

  it('flips P&L sign for a short position', () => {
    const short = pos({ side: 'sell' });
    expect(getCryptoOpenPosSortValue(short, 'pnlPct', symbols)).toBeCloseTo(-10);
  });

  it('returns null leverage/liquidation for spot positions', () => {
    expect(getCryptoOpenPosSortValue(pos(), 'leverage', symbols)).toBeNull();
    expect(getCryptoOpenPosSortValue(pos(), 'liquidation', symbols)).toBeNull();
  });

  it('returns perp leverage/liquidation when present', () => {
    const perp = pos({ productType: 'perp', leverage: 5, liquidationPrice: 80 });
    expect(getCryptoOpenPosSortValue(perp, 'leverage', symbols)).toBe(5);
    expect(getCryptoOpenPosSortValue(perp, 'liquidation', symbols)).toBe(80);
  });
});

describe('getCryptoClosedPosSortValue', () => {
  it('uses the recorded exit price for P&L % and prefers stored pnl for P&L $', () => {
    const p = pos({ exitPrice: 120, pnl: 37 });
    expect(getCryptoClosedPosSortValue(p, 'pnlPct')).toBeCloseTo(20);
    expect(getCryptoClosedPosSortValue(p, 'pnlDollar')).toBe(37);
  });

  it('falls back to entry price when exit is missing', () => {
    expect(getCryptoClosedPosSortValue(pos(), 'exit')).toBe(100);
  });
});

describe('getCryptoWatchSortValue', () => {
  it('nulls out numeric columns for an unquoted symbol', () => {
    const cold = sym({ lastUpdated: 0, price: 0 });
    expect(getCryptoWatchSortValue(cold, 'changePct')).toBeNull();
    expect(getCryptoWatchSortValue(cold, 'symbol')).toBe('BTC-USD');
  });
});

describe('end-to-end: sortRows with a crypto resolver', () => {
  const symbols = [sym({ symbol: 'BTC-USD', price: 110 }), sym({ symbol: 'ETH-USD', price: 90 })];
  const rows = [pos({ id: 'a', symbol: 'ETH-USD' }), pos({ id: 'b', symbol: 'BTC-USD' })];

  it('orders symbols alphabetically both ways', () => {
    const asc = sortRows(rows, { key: 'symbol', dir: 'asc' }, (p, k) => getCryptoOpenPosSortValue(p, k, symbols));
    expect(asc.map(p => p.symbol)).toEqual(['BTC-USD', 'ETH-USD']);
    const desc = sortRows(rows, { key: 'symbol', dir: 'desc' }, (p, k) => getCryptoOpenPosSortValue(p, k, symbols));
    expect(desc.map(p => p.symbol)).toEqual(['ETH-USD', 'BTC-USD']);
  });
});
