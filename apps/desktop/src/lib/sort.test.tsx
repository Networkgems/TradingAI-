// TRA-339 — regression coverage for the generic per-table sort primitives that
// power the sortable column headers in the Crypto + Stock dashboards. The
// feature shipped in d27c0cf and survived the TRA-419 decomposition, but the
// core comparator / sortRows / useTableSort toggle had no tests. These lock in
// the behaviour the dashboard tables rely on: alphabetic-both-ways on strings,
// numeric ordering on money/quantity columns, missing values sinking to the
// bottom in either direction, and the click-to-toggle direction state.
import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { compareSortValues, sortRows, useTableSort } from './sort';

describe('compareSortValues', () => {
  it('orders numbers ascending when dir is asc', () => {
    expect(compareSortValues(1, 2, 'asc')).toBeLessThan(0);
    expect(compareSortValues(2, 1, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(5, 5, 'asc')).toBe(0);
  });

  it('flips numeric order when dir is desc', () => {
    expect(compareSortValues(1, 2, 'desc')).toBeGreaterThan(0);
    expect(compareSortValues(2, 1, 'desc')).toBeLessThan(0);
  });

  it('orders strings alphabetically both ways', () => {
    expect(compareSortValues('AAPL', 'TSLA', 'asc')).toBeLessThan(0);
    expect(compareSortValues('AAPL', 'TSLA', 'desc')).toBeGreaterThan(0);
  });

  it('compares strings case-insensitively', () => {
    expect(compareSortValues('aapl', 'AAPL', 'asc')).toBe(0);
  });

  it('uses numeric-aware string comparison so item2 < item10', () => {
    expect(compareSortValues('item2', 'item10', 'asc')).toBeLessThan(0);
  });

  it('sinks null/undefined to the bottom regardless of direction', () => {
    // a missing → a after b (positive) in both directions.
    expect(compareSortValues(null, 5, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(null, 5, 'desc')).toBeGreaterThan(0);
    // b missing → b after a (negative) in both directions.
    expect(compareSortValues(5, undefined, 'asc')).toBeLessThan(0);
    expect(compareSortValues(5, undefined, 'desc')).toBeLessThan(0);
  });

  it('treats NaN as a missing value that sinks to the bottom', () => {
    expect(compareSortValues(NaN, 1, 'asc')).toBeGreaterThan(0);
    expect(compareSortValues(1, NaN, 'desc')).toBeLessThan(0);
  });

  it('treats two missing values as equal', () => {
    expect(compareSortValues(null, undefined, 'asc')).toBe(0);
    expect(compareSortValues(NaN, null, 'desc')).toBe(0);
  });
});

describe('sortRows', () => {
  type Row = { sym: string; pnl: number | null };
  const rows: Row[] = [
    { sym: 'TSLA', pnl: -3 },
    { sym: 'AAPL', pnl: 10 },
    { sym: 'NVDA', pnl: null },
  ];
  const get = (r: Row, k: 'sym' | 'pnl') => r[k];

  it('does not mutate the input array', () => {
    const before = [...rows];
    sortRows(rows, { key: 'sym', dir: 'asc' }, get);
    expect(rows).toEqual(before);
  });

  it('sorts symbols ascending and descending', () => {
    const asc = sortRows(rows, { key: 'sym', dir: 'asc' }, get).map(r => r.sym);
    expect(asc).toEqual(['AAPL', 'NVDA', 'TSLA']);
    const desc = sortRows(rows, { key: 'sym', dir: 'desc' }, get).map(r => r.sym);
    expect(desc).toEqual(['TSLA', 'NVDA', 'AAPL']);
  });

  it('keeps missing numeric values last in both directions', () => {
    const asc = sortRows(rows, { key: 'pnl', dir: 'asc' }, get).map(r => r.sym);
    expect(asc).toEqual(['TSLA', 'AAPL', 'NVDA']); // -3, 10, null
    const desc = sortRows(rows, { key: 'pnl', dir: 'desc' }, get).map(r => r.sym);
    expect(desc).toEqual(['AAPL', 'TSLA', 'NVDA']); // 10, -3, null
  });
});

describe('useTableSort', () => {
  it('starts at the provided default key and direction', () => {
    const { result } = renderHook(() => useTableSort('symbol', 'asc'));
    expect(result.current.sort).toEqual({ key: 'symbol', dir: 'asc' });
  });

  it('defaults to descending when no direction is given', () => {
    const { result } = renderHook(() => useTableSort('cost'));
    expect(result.current.sort.dir).toBe('desc');
  });

  it('toggles direction when the active key is clicked again', () => {
    const { result } = renderHook(() => useTableSort('cost', 'desc'));
    act(() => result.current.onSort('cost'));
    expect(result.current.sort).toEqual({ key: 'cost', dir: 'asc' });
    act(() => result.current.onSort('cost'));
    expect(result.current.sort).toEqual({ key: 'cost', dir: 'desc' });
  });

  it('switches to a new key and resets direction to desc', () => {
    const { result } = renderHook(() => useTableSort('symbol', 'asc'));
    act(() => result.current.onSort('pnlDollar'));
    expect(result.current.sort).toEqual({ key: 'pnlDollar', dir: 'desc' });
  });
});
