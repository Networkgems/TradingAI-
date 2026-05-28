// TRA-422 — the Stocks Positions tab, extracted from Dashboard.tsx. Owns the
// manual position-close mutation; the open / closed position lists and live
// quotes are passed in from the parent.
// TRA-503 — also owns the "Sync Tradier {env} positions" button (live only),
// which forces the engine's equity-portfolio reconcile so out-of-band Tradier
// opens land in the Positions table without waiting for the cadence.
import type { Position } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmtDollar, fmtPct, fmtPrice, formatTime, quoteStatusLabel, exitReasonLabel } from '../../lib/format';
import { useTableSort, sortRows, SortableTH } from '../../lib/sort.tsx';
import { positionSignalCell } from '../../lib/cells';
import { getStockOpenPosSortValue, getStockClosedPosSortValue } from '../../lib/stockSort';
import type { StockOpenPosSortKey, StockClosedPosSortKey } from '../../lib/stockSort';
import type { SymbolState } from '../../types/app';
import { useTradierEquitySync } from '../../hooks/useTradierEquitySync';

export function StockPositionsPanel({
  token,
  openPositions,
  closedPositions,
  symbols,
  accountMode,
  tradierEnv,
}: {
  token: string;
  openPositions: Position[];
  closedPositions: Position[];
  symbols: SymbolState[];
  accountMode: 'demo' | 'live';
  tradierEnv: 'sandbox' | 'production';
}) {
  const openPosSort = useTableSort<StockOpenPosSortKey>('opened', 'desc');
  const closedPosSort = useTableSort<StockClosedPosSortKey>('closed', 'desc');
  const toast = useToast();
  const {
    syncTradierEquityPositions,
    syncing: equitySyncing,
    status: equitySyncStatus,
  } = useTradierEquitySync(token, tradierEnv);
  // TRA-503 — Demo doesn't route equities through Tradier, so the sync would
  // never pull anything. Match the gate on the Options panel.
  const showTradierSync = accountMode === 'live';

  async function closePosition(positionId: string) {
    try {
      const r = await fetch(`${HTTP_URL}/api/positions/${positionId}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success('Position close submitted');
      else toast.error(`Close failed (HTTP ${r.status})`);
    } catch (err) {
      logger.error('stock-close', 'position close failed', err);
      toast.error('Position close failed — network error');
    }
  }

  return (
    <div className="positions-panel">
      {/* TRA-503 — pull open equity positions from Tradier into TradeAI so the
          Positions table catches out-of-band opens before the cadence sweep. */}
      {showTradierSync && (
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
          <button
            className="btn-secondary"
            onClick={syncTradierEquityPositions}
            disabled={equitySyncing}
            title={`Pull open equity positions from Tradier ${tradierEnv} into TradeAI`}
          >
            {equitySyncing ? 'Syncing…' : `Sync Tradier ${tradierEnv} positions`}
          </button>
          {equitySyncStatus && (
            <span className="muted" style={{ fontSize: '0.85rem' }}>{equitySyncStatus}</span>
          )}
        </div>
      )}
      {openPositions.length > 0 && (
        <>
          <h3>Open Positions</h3>
          <table>
            <thead>
              <tr>
                <SortableTH label="Symbol" sortKey="symbol" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Side" sortKey="side" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Qty" sortKey="qty" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Entry" sortKey="entry" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Cost" sortKey="cost" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Current" sortKey="current" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label={<>P&amp;L %</>} sortKey="pnlPct" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label={<>P&amp;L $</>} sortKey="pnlDollar" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Stop" sortKey="stop" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <SortableTH label="Target" sortKey="target" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <th>Signal</th>
                <SortableTH label="Opened" sortKey="opened" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                <th></th>
              </tr>
            </thead>
            <tbody>
              {sortRows(openPositions, openPosSort.sort, (p, k) => getStockOpenPosSortValue(p, k, symbols)).map(p => {
                const sym = symbols.find(s => s.symbol === p.symbol);
                // TRA-344 — treat price=0 / quoteStatus≠ok as "no live quote".
                const hasLiveQuote = !!sym
                  && sym.price > 0
                  && sym.lastUpdated > 0
                  && sym.quoteStatus !== 'unavailable'
                  && sym.quoteStatus !== 'rate_limited';
                const currentPrice = hasLiveQuote ? sym!.price : p.entryPrice;
                const multiplier = p.side === 'buy' ? 1 : -1;
                const pnlPct = hasLiveQuote
                  ? ((currentPrice - p.entryPrice) / p.entryPrice) * 100 * multiplier
                  : 0;
                const pnlDollar = hasLiveQuote
                  ? (currentPrice - p.entryPrice) * p.quantity * multiplier
                  : 0;
                const totalCost = p.entryPrice * p.quantity;
                const quoteTitle = hasLiveQuote ? undefined : quoteStatusLabel(sym ?? { lastUpdated: 0 });
                return (
                  <tr key={p.id}>
                    <td className="symbol">{p.symbol}</td>
                    <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                    <td>{p.quantity}</td>
                    <td>{fmtPrice(p.entryPrice)}</td>
                    <td>{fmtPrice(totalCost)}</td>
                    <td className={hasLiveQuote ? '' : 'muted'} title={quoteTitle}>
                      {hasLiveQuote ? fmtPrice(currentPrice) : '—'}
                    </td>
                    <td className={!hasLiveQuote ? 'muted' : pnlPct >= 0 ? 'green' : 'red'} title={quoteTitle}>
                      {hasLiveQuote ? fmtPct(pnlPct) : '—'}
                    </td>
                    <td className={!hasLiveQuote ? 'muted' : pnlDollar >= 0 ? 'green' : 'red'} title={quoteTitle}>
                      {hasLiveQuote ? fmtDollar(pnlDollar) : '—'}
                    </td>
                    <td className="red">{fmtPrice(p.stopLoss)}</td>
                    <td className="green">{fmtPrice(p.takeProfit)}</td>
                    <td title={p.signalId ?? ''}>{positionSignalCell(p)}</td>
                    <td className="muted">{formatTime(p.openedAt)}</td>
                    <td><button className="btn-close-pos" onClick={() => closePosition(p.id)}>Close</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {closedPositions.length > 0 && (
        <>
          <h3 style={{ marginTop: openPositions.length > 0 ? '1.5rem' : 0 }}>
            Closed Today ({closedPositions.length})
          </h3>
          <table>
            <thead>
              <tr>
                <SortableTH label="Symbol" sortKey="symbol" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label="Side" sortKey="side" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label="Qty" sortKey="qty" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label="Entry" sortKey="entry" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label="Exit" sortKey="exit" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label={<>P&amp;L %</>} sortKey="pnlPct" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label={<>P&amp;L $</>} sortKey="pnlDollar" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <SortableTH label="Reason" sortKey="reason" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
                <th>Signal</th>
                <SortableTH label="Closed" sortKey="closed" sort={closedPosSort.sort} onSort={closedPosSort.onSort} />
              </tr>
            </thead>
            <tbody>
              {sortRows(closedPositions, closedPosSort.sort, getStockClosedPosSortValue).map(p => {
                const exit = p.exitPrice ?? p.entryPrice;
                const multiplier = p.side === 'buy' ? 1 : -1;
                const pnlPct = ((exit - p.entryPrice) / p.entryPrice) * 100 * multiplier;
                const pnlDollar = p.pnl ?? (exit - p.entryPrice) * p.quantity * multiplier;
                return (
                  <tr key={p.id}>
                    <td className="symbol">{p.symbol}</td>
                    <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                    <td>{p.quantity}</td>
                    <td>{fmtPrice(p.entryPrice)}</td>
                    <td>{fmtPrice(exit)}</td>
                    <td className={pnlPct >= 0 ? 'green' : 'red'}>{fmtPct(pnlPct)}</td>
                    <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
                    <td className="muted">{exitReasonLabel(p.exitReason)}</td>
                    <td title={p.signalId ?? ''}>{positionSignalCell(p)}</td>
                    <td className="muted">{p.closedAt ? formatTime(p.closedAt) : '—'}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}

      {openPositions.length === 0 && closedPositions.length === 0 && (
        <div className="empty">
          No open positions. Signals will auto-open paper positions.
          <br /><br />
          <span className="muted">Closed trades stay listed here until the 9:00 PM ET archive — full per-day history is under the <strong>Calendar</strong> tab.</span>
        </div>
      )}
    </div>
  );
}
