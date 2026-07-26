// TRA-2379 — the watchlist must not sort a `suspect` row to the top of CHANGE %.
//
// CHANGE % is the DEFAULT sort key on both watchlist panels, direction `desc`, so
// before this change the FFAI row (+8,951.61%) was row 1 of the Stocks dashboard on
// every page load. The mechanism is `getStockWatchSortValue` returning `null` for
// the two move columns, which `compareSortValues` parks at the bottom in BOTH
// directions — the same path the never-quoted rows already used.
//
// Asserting on the SORTED OUTPUT rather than on the resolver's return value: the
// resolver returning null is the implementation, "it isn't first" is the promise.
import { describe, expect, it } from 'vitest';
import type { CryptoSymbolState } from '@trading-app/shared';
import type { SymbolState } from '../types/app';
import { sortRows } from './sort';
import { getStockWatchSortValue } from './stockSort';
import { getCryptoWatchSortValue } from './cryptoSort';
import { isQuoteMoveUnreliable, quoteStatusLabel } from './format';

function sym(over: Partial<SymbolState> = {}): SymbolState {
  return { symbol: 'AAPL', price: 110, volume: 0, change: 0, changePct: 0, lastUpdated: 5_000, ...over };
}

/** Live 2026-07-26 bqb1 rows. */
const FFAI = sym({ symbol: 'FFAI', price: 6.49, change: 6.42, changePct: 8951.61, quoteStatus: 'suspect' });
const JEM = sym({ symbol: 'JEM', price: 6.35, change: 1.61, changePct: 33.97, quoteStatus: 'ok' });
const GSUN = sym({ symbol: 'GSUN', price: 0.21, change: -0.14, changePct: -39.60, quoteStatus: 'ok' });
const AAPL = sym({ symbol: 'AAPL', price: 333.02, change: 11.36, changePct: 3.54, quoteStatus: 'ok' });

const ROWS = [AAPL, FFAI, JEM, GSUN];

describe('TRA-2379 stock watchlist CHANGE % sort', () => {
  it('does not put the suspect row first on the default desc sort', () => {
    const out = sortRows(ROWS, { key: 'changePct', dir: 'desc' }, getStockWatchSortValue);
    expect(out[0].symbol).toBe('JEM'); // the largest GENUINE gainer
    expect(out[out.length - 1].symbol).toBe('FFAI');
  });

  it('does not put it first on asc either — null sorts to the bottom both ways', () => {
    const out = sortRows(ROWS, { key: 'changePct', dir: 'asc' }, getStockWatchSortValue);
    expect(out[0].symbol).toBe('GSUN'); // the largest GENUINE loser
    expect(out[out.length - 1].symbol).toBe('FFAI');
  });

  it('applies the same rule to the absolute CHANGE column', () => {
    const out = sortRows(ROWS, { key: 'change', dir: 'desc' }, getStockWatchSortValue);
    expect(out[out.length - 1].symbol).toBe('FFAI');
  });

  it('still ranks the suspect row normally on columns that are not in doubt', () => {
    // Only the MOVE is untrustworthy. The price is live and must stay sortable —
    // degrading the whole row would be a clamp by another name.
    const out = sortRows(ROWS, { key: 'price', dir: 'desc' }, getStockWatchSortValue);
    expect(out.map(r => r.symbol)).toEqual(['AAPL', 'FFAI', 'JEM', 'GSUN']);
  });

  it('leaves an ordinary board completely unchanged (known-good control)', () => {
    const clean = [AAPL, JEM, GSUN];
    const out = sortRows(clean, { key: 'changePct', dir: 'desc' }, getStockWatchSortValue);
    expect(out.map(r => r.symbol)).toEqual(['JEM', 'AAPL', 'GSUN']);
  });
});

describe('TRA-2379 crypto watchlist CHANGE % sort (same shared code)', () => {
  const c = (over: Partial<CryptoSymbolState>): CryptoSymbolState =>
    ({ symbol: 'BTC-USD', price: 1, volume: 0, change: 0, changePct: 0, lastUpdated: 5_000, ...over }) as CryptoSymbolState;

  it('parks a suspect row at the bottom', () => {
    const rows = [c({ symbol: 'A', changePct: 5 }), c({ symbol: 'B', changePct: 9999, quoteStatus: 'suspect' })];
    const out = sortRows(rows, { key: 'changePct', dir: 'desc' }, getCryptoWatchSortValue);
    expect(out[0].symbol).toBe('A');
  });
});

describe('TRA-2379 watchlist rendering', () => {
  it('reports the row as unreliable so the cells render degraded', () => {
    expect(isQuoteMoveUnreliable(FFAI)).toBe(true);
    expect(isQuoteMoveUnreliable(JEM)).toBe(false);
  });

  it('labels it as a bad change %, NOT as a dead or delayed feed', () => {
    const label = quoteStatusLabel(FFAI);
    expect(label).toContain('Change % unreliable');
    expect(label).not.toContain('Quote unavailable');
    expect(label).not.toContain('feed delayed');
  });

  it('leaves the existing status labels alone', () => {
    expect(quoteStatusLabel({ lastUpdated: 1, quoteStatus: 'unavailable' })).toBe('Quote unavailable');
    expect(quoteStatusLabel({ lastUpdated: 1, quoteStatus: 'stale' })).toBe('Quote stale — feed delayed');
    expect(quoteStatusLabel({ lastUpdated: 0 })).toBe('Loading…');
  });
});
