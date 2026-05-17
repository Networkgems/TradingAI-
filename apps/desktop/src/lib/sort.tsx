// TRA-419 — generic per-table sort utilities extracted from App.tsx.
// TRA-339 — generic per-table sort. Each dashboard table picks a column
// type (a string-literal union of its sortable keys), wires its header
// cells through SortableTH, and resolves sort values via getSortValue
// keyed by that union. Default direction is desc so monetary/quantity
// columns lead with the largest first; clicking the active key toggles.
import React, { useCallback, useState } from 'react';

export type SortDir = 'asc' | 'desc';
export type SortState<K extends string> = { key: K; dir: SortDir };

export function useTableSort<K extends string>(defaultKey: K, defaultDir: SortDir = 'desc') {
  const [state, setState] = useState<SortState<K>>({ key: defaultKey, dir: defaultDir });
  const onSort = useCallback((next: K) => {
    setState(prev => prev.key === next
      ? { key: next, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key: next, dir: 'desc' });
  }, []);
  return { sort: state, onSort };
}

export function compareSortValues(a: unknown, b: unknown, dir: SortDir): number {
  // null / undefined / NaN sort to the bottom regardless of direction so
  // unpriced or "—" rows don't pollute the top of either order.
  const aMissing = a == null || (typeof a === 'number' && Number.isNaN(a));
  const bMissing = b == null || (typeof b === 'number' && Number.isNaN(b));
  if (aMissing && bMissing) return 0;
  if (aMissing) return 1;
  if (bMissing) return -1;
  let cmp: number;
  if (typeof a === 'number' && typeof b === 'number') {
    cmp = a - b;
  } else {
    cmp = String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
  }
  return dir === 'asc' ? cmp : -cmp;
}

export function sortRows<T, K extends string>(
  rows: readonly T[],
  state: SortState<K>,
  getValue: (row: T, key: K) => unknown,
): T[] {
  return [...rows].sort((a, b) => compareSortValues(getValue(a, state.key), getValue(b, state.key), state.dir));
}

export function SortableTH<K extends string>({ label, sortKey, sort, onSort }: {
  label: React.ReactNode;
  sortKey: K;
  sort: SortState<K>;
  onSort: (k: K) => void;
}) {
  const active = sort.key === sortKey;
  const arrow = active ? (sort.dir === 'asc' ? '▲' : '▼') : '↕';
  const titleLabel = typeof label === 'string' ? label : sortKey;
  return (
    <th
      className={`th-sortable${active ? ' is-active' : ''}`}
      onClick={() => onSort(sortKey)}
      role="button"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onSort(sortKey);
        }
      }}
      title={`Sort by ${titleLabel}`}
    >
      <span className="th-sortable-label">{label}</span>
      <span className={`th-sortable-arrow${active ? '' : ' th-sortable-arrow-idle'}`} aria-hidden="true">{arrow}</span>
    </th>
  );
}
