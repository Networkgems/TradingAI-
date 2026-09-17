// TRA-422 — sort-key types and value resolvers for the Stocks dashboard
// tables. Extracted verbatim from Dashboard.tsx so the panel components and
// the SortableTH headers stay in sync; adding a column means adding a key to
// the union here and a branch to the matching resolver.
import type { Position, OptionPosition } from '@trading-app/shared';
import { displayOptionMark } from '@trading-app/shared';
import type { SymbolState } from '../types/app';
import { isQuoteMoveUnreliable } from './format';
import { closeRejectLatch } from './optionRowState';

// TRA-339 — Stock-dashboard sort keys, including the Open / Closed Options
// tables.
export type StockWatchSortKey =
  | 'symbol' | 'price' | 'change' | 'changePct' | 'volume' | 'updated';
export type StockOpenPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'cost' | 'current'
  | 'pnlPct' | 'pnlDollar' | 'stop' | 'target' | 'opened';
export type StockClosedPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'exit'
  | 'pnlPct' | 'pnlDollar' | 'reason' | 'closed';
export type OptionOpenSortKey =
  | 'symbol' | 'type' | 'contracts' | 'premiumPaid'
  | 'currentMark' | 'pnlDollar' | 'status' | 'opened';
export type OptionClosedSortKey =
  | 'symbol' | 'type' | 'contracts' | 'premiumPaid'
  | 'exitPremium' | 'pnlPct' | 'pnlDollar' | 'closed';

export function getStockWatchSortValue(s: SymbolState, key: StockWatchSortKey): unknown {
  if (s.lastUpdated === 0 && key !== 'symbol' && key !== 'updated') return null;
  // TRA-2379 — a suspect row has a live, sortable PRICE but an unbelievable
  // published move, and CHANGE % is this table's DEFAULT sort key (desc). Return
  // null for the two move columns so `compareSortValues` parks the row at the
  // bottom in BOTH directions — the same mechanism the never-quoted rows use.
  // The raw values are still rendered (degraded); this only refuses to RANK them.
  // TRA-2610 — via `isQuoteMoveUnreliable`, not `quoteStatus === 'suspect'`: that
  // read was erased by the next failed fetch, which is how a fabricated move got
  // back to the top of a table whose default sort is exactly this column.
  if ((key === 'change' || key === 'changePct') && isQuoteMoveUnreliable(s)) return null;
  switch (key) {
    case 'symbol': return s.symbol;
    case 'price': return s.price;
    case 'change': return s.change;
    case 'changePct': return s.changePct;
    case 'volume': return s.volume;
    case 'updated': return s.lastUpdated;
  }
}

export function getStockOpenPosSortValue(p: Position, key: StockOpenPosSortKey, symbols: readonly SymbolState[]): unknown {
  const sym = symbols.find(s => s.symbol === p.symbol);
  const currentPrice = sym?.price ?? p.entryPrice;
  const multiplier = p.side === 'buy' ? 1 : -1;
  switch (key) {
    case 'symbol': return p.symbol;
    case 'side': return p.side;
    case 'qty': return p.quantity;
    case 'entry': return p.entryPrice;
    case 'cost': return p.entryPrice * p.quantity;
    case 'current': return currentPrice;
    case 'pnlPct': return ((currentPrice - p.entryPrice) / p.entryPrice) * 100 * multiplier;
    case 'pnlDollar': return (currentPrice - p.entryPrice) * p.quantity * multiplier;
    case 'stop': return p.stopLoss;
    case 'target': return p.takeProfit;
    case 'opened': return p.openedAt;
  }
}

export function getStockClosedPosSortValue(p: Position, key: StockClosedPosSortKey): unknown {
  const exit = p.exitPrice ?? p.entryPrice;
  const multiplier = p.side === 'buy' ? 1 : -1;
  switch (key) {
    case 'symbol': return p.symbol;
    case 'side': return p.side;
    case 'qty': return p.quantity;
    case 'entry': return p.entryPrice;
    case 'exit': return exit;
    case 'pnlPct': return ((exit - p.entryPrice) / p.entryPrice) * 100 * multiplier;
    case 'pnlDollar': return p.pnl ?? (exit - p.entryPrice) * p.quantity * multiplier;
    case 'reason': return p.exitReason ?? '';
    case 'closed': return p.closedAt ?? 0;
  }
}

export function getOptionOpenSortValue(o: OptionPosition, key: OptionOpenSortKey): unknown {
  switch (key) {
    case 'symbol': return o.symbol;
    case 'type': return o.optionType;
    case 'contracts': return o.contracts;
    case 'premiumPaid': return o.premiumPaid;
    // TRA-2890 — sort on the same display mark the cells render (live rows:
    // broker-tape last trade), so ordering matches what's on screen.
    case 'currentMark': return displayOptionMark(o);
    case 'pnlDollar': {
      const unrealized = (displayOptionMark(o) - o.premiumPaid) * o.contractsRemaining * 100;
      return unrealized + (o.pnl ?? 0);
    }
    // TRA-4282 — the cell renders LATCHED over TRAILING/OPEN, so sort on the
    // same precedence; a latched row must group with latched rows, not hide
    // among open ones.
    case 'status': return closeRejectLatch(o) ? 'latched' : o.trailingActive ? 'trailing' : 'open';
    case 'opened': return o.openedAt;
  }
}

export function getOptionClosedSortValue(o: OptionPosition, key: OptionClosedSortKey): unknown {
  switch (key) {
    case 'symbol': return o.symbol;
    case 'type': return o.optionType;
    case 'contracts': return o.contracts;
    case 'premiumPaid': return o.premiumPaid;
    case 'exitPremium': return o.currentPremium;
    // TRA-367 — sort key for the P&L % column. Computes from the stored exit
    // premium (`currentPremium`) vs entry, ignoring partial-exit P&L already
    // realised on `o.pnl` — that's how it's displayed in the cell.
    case 'pnlPct': {
      if (!(o.premiumPaid > 0)) return 0;
      return ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100;
    }
    case 'pnlDollar': return o.pnl ?? 0;
    case 'closed': return o.closedAt ?? 0;
  }
}
