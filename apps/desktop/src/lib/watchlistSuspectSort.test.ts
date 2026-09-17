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
import type { SymbolState } from '../types/app';
import { sortRows } from './sort';
import { getStockWatchSortValue } from './stockSort';
import { isQuoteMoveUnreliable, quoteStatusLabel } from './format';

function sym(over: Partial<SymbolState> = {}): SymbolState {
  return { symbol: 'AAPL', price: 110, volume: 0, change: 0, changePct: 0, lastUpdated: 5_000, ...over };
}

/** Live 2026-07-26 bqb1 rows. */
// TRA-2610 — the verdict moved off `quoteStatus` (freshness only) onto its own
// `moveSuspect` field. This row is ALSO rule-suspect on its numbers alone, which the
// erasure block at the bottom of this file relies on.
const FFAI = sym({ symbol: 'FFAI', price: 6.49, change: 6.42, changePct: 8951.61, quoteStatus: 'ok', moveSuspect: true });
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

/**
 * TRA-2610 — the flag used to live in `quoteStatus`, so the next failed fetch
 * overwrote it with `'unavailable'` and the row came back to the top of a table whose
 * DEFAULT sort is CHANGE % desc. FGMC (`$8.30`, `+110.66%`, `ratio 2.107`) sat there
 * for two sessions.
 */
describe('TRA-2610 a failed fetch cannot un-flag a fabricated move', () => {
  /** The live 07-29 row, after the failed fetch that used to erase its verdict. */
  const FGMC = sym({
    symbol: 'FGMC', price: 8.30, change: 4.36, changePct: 110.66,
    lastUpdated: 4_000, quoteStatus: 'unavailable', moveSuspect: true,
  });

  it('still parks it at the bottom of CHANGE % desc', () => {
    const out = sortRows([AAPL, FGMC, JEM], { key: 'changePct', dir: 'desc' }, getStockWatchSortValue);
    expect(out[0].symbol).toBe('JEM');
    expect(out[out.length - 1].symbol).toBe('FGMC');
  });

  it('parks it even with the flag ERASED — the rule is re-executed', () => {
    const { moveSuspect: _dropped, ...noFlag } = FGMC;
    const out = sortRows([AAPL, noFlag, JEM], { key: 'changePct', dir: 'desc' }, getStockWatchSortValue);
    expect(out[0].symbol).toBe('JEM');
    expect(out[out.length - 1].symbol).toBe('FGMC');
    expect(isQuoteMoveUnreliable(noFlag)).toBe(true);
  });

  it('names BOTH facts in the Updated cell — a dead feed AND an unbelievable move', () => {
    // The old single field could only ever report whichever write landed last. On
    // FGMC that was "Quote unavailable", with nothing to say the +110.66% beside it
    // was fabricated.
    const label = quoteStatusLabel(FGMC);
    expect(label).toContain('Change % unreliable');
    expect(label).toContain('Quote unavailable');
  });

  it('KNOWN-GOOD control — a stale row with a believable move keeps its ranking', () => {
    // Staleness alone must not park a row; 42% of the universe was unavailable on the
    // tape this was found on, and "exclude everything stale" would empty the table.
    const stale = sym({ symbol: 'USO', price: 88.12, change: 6.01, changePct: 7.32, lastUpdated: 4_000, quoteStatus: 'unavailable' });
    const out = sortRows([AAPL, stale, JEM], { key: 'changePct', dir: 'desc' }, getStockWatchSortValue);
    expect(out.map(r => r.symbol)).toEqual(['JEM', 'USO', 'AAPL']);
    expect(isQuoteMoveUnreliable(stale)).toBe(false);
    expect(quoteStatusLabel(stale)).toBe('Quote unavailable');
  });

});
