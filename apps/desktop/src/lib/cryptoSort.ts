// TRA-422 — sort-key types and value resolvers for the Crypto dashboard
// tables. Extracted verbatim from CryptoDashboard.tsx. The watchlist resolver
// is typed against the shared `CryptoSymbolState` (its `quoteStatus` carries
// the extra `'stale'` member from TRA-418) so the panels stay type-correct.
import type { Position, CryptoSymbolState } from '@trading-app/shared';

// TRA-339 — sortable column keys per Crypto dashboard table. Kept narrow
// (string-literal unions) so the SortableTH component and the value resolver
// below stay in sync; adding a column means adding a key here and a branch in
// the matching resolver.
export type CryptoWatchSortKey =
  | 'symbol' | 'price' | 'change' | 'changePct' | 'volume' | 'updated';
export type CryptoOpenPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'cost' | 'current'
  | 'pnlPct' | 'pnlDollar' | 'stop' | 'target'
  | 'leverage' | 'liquidation' | 'opened';
export type CryptoClosedPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'exit'
  | 'pnlPct' | 'pnlDollar' | 'reason' | 'closed';

export function getCryptoWatchSortValue(s: CryptoSymbolState, key: CryptoWatchSortKey): unknown {
  if (s.lastUpdated === 0 && key !== 'symbol' && key !== 'updated') return null;
  // TRA-2379 — mirrors the stock resolver: never RANK a move the server flagged as
  // implausible. See getStockWatchSortValue. (The crypto feed does not currently
  // stamp `'suspect'` — its 24h % is a provider field with no prev close to test —
  // but the panel and this resolver are the same shared code, so the guard is here
  // and correct the moment that path ever does.)
  if ((key === 'change' || key === 'changePct') && s.quoteStatus === 'suspect') return null;
  switch (key) {
    case 'symbol': return s.symbol;
    case 'price': return s.price;
    case 'change': return s.change;
    case 'changePct': return s.changePct;
    case 'volume': return s.volume;
    case 'updated': return s.lastUpdated;
  }
}

export function getCryptoOpenPosSortValue(p: Position, key: CryptoOpenPosSortKey, symbols: readonly CryptoSymbolState[]): unknown {
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
    case 'leverage': return p.productType === 'perp' ? p.leverage ?? null : null;
    case 'liquidation': return p.productType === 'perp' ? p.liquidationPrice ?? null : null;
    case 'opened': return p.openedAt;
  }
}

export function getCryptoClosedPosSortValue(p: Position, key: CryptoClosedPosSortKey): unknown {
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
