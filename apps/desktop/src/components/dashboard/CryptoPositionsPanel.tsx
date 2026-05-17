// TRA-422 — the Crypto Positions tab, extracted from CryptoDashboard.tsx. Owns
// the manual position-close mutation (with TRA-320 Coinbase reject surfacing);
// the open / closed lists, live quotes and live-skip buffer are passed in.
import { useState } from 'react';
import type { Position, CryptoSymbolState, LiveSkip } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmt, fmtDollar, fmtPct, fmtPrice, formatTime, quoteStatusLabel, exitReasonLabel } from '../../lib/format';
import { useTableSort, sortRows, SortableTH } from '../../lib/sort.tsx';
import { positionSignalCell } from '../../lib/cells';
import { getCryptoOpenPosSortValue, getCryptoClosedPosSortValue } from '../../lib/cryptoSort';
import type { CryptoOpenPosSortKey, CryptoClosedPosSortKey } from '../../lib/cryptoSort';
import { SkippedSignalsPanel } from '../SkippedSignalsPanel';

export function CryptoPositionsPanel({
  token,
  openPositions,
  closedPositions,
  symbols,
  liveSkips,
}: {
  token: string;
  openPositions: Position[];
  closedPositions: Position[];
  symbols: CryptoSymbolState[];
  liveSkips: LiveSkip[];
}) {
  // TRA-320 — surface Coinbase reject reasons on a manual close so the user
  // knows the position stayed open instead of silently disappearing.
  const [closeError, setCloseError] = useState('');
  const openPosSort = useTableSort<CryptoOpenPosSortKey>('opened', 'desc');
  const closedPosSort = useTableSort<CryptoClosedPosSortKey>('closed', 'desc');
  const toast = useToast();

  async function closePosition(positionId: string) {
    setCloseError('');
    try {
      const r = await fetch(`${HTTP_URL}/api/crypto/positions/${positionId}/close`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) {
        // TRA-320 — server returns 502 + { error, reason } when Coinbase
        // rejects the close. Show the reason so the user knows the position
        // is still open at the broker.
        const body = await r.json().catch(() => ({})) as { error?: string; reason?: string };
        const reason = body.reason || body.error || `Close failed (HTTP ${r.status})`;
        setCloseError(reason);
        toast.error(`Close rejected: ${reason}`);
      } else {
        toast.success('Position close submitted');
      }
    } catch (err) {
      logger.error('crypto-close', 'position close failed', err);
      const message = err instanceof Error ? err.message : 'Close failed';
      setCloseError(message);
      toast.error(`Close failed: ${message}`);
    }
  }

  return (
    <div className="positions-panel">
      {closeError && (
        // TRA-320 — Coinbase rejected the manual close. The position is still
        // open in the broker; this banner tells the user why.
        <div className="signal-skip-reason" role="alert" style={{ marginBottom: '0.75rem' }}>
          <span>Close rejected: {closeError}</span>
          <button
            className="btn-secondary btn-sm signal-skip-action"
            onClick={() => setCloseError('')}
          >
            Dismiss
          </button>
        </div>
      )}
      {openPositions.length > 0 && (
        <>
          <h3>Open Positions</h3>
          {/* TRA-249-E — Leverage / Liquidation columns are rendered only when
              at least one open row is a perp. */}
          {(() => {
            const showPerpCols = openPositions.some(p => p.productType === 'perp');
            const sortedOpen = sortRows(openPositions, openPosSort.sort, (p, k) => getCryptoOpenPosSortValue(p, k, symbols));
            return (
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
                    {showPerpCols && <SortableTH label="Leverage" sortKey="leverage" sort={openPosSort.sort} onSort={openPosSort.onSort} />}
                    {showPerpCols && <SortableTH label="Liquidation" sortKey="liquidation" sort={openPosSort.sort} onSort={openPosSort.onSort} />}
                    <th>Signal</th>
                    <SortableTH label="Opened" sortKey="opened" sort={openPosSort.sort} onSort={openPosSort.onSort} />
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedOpen.map(p => {
                    const sym = symbols.find(s => s.symbol === p.symbol);
                    // TRA-344 — treat price=0 / quoteStatus≠ok as "no live quote"
                    // so a delisted/unmapped ticker doesn't render -100% P&L.
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
                    const isPerp = p.productType === 'perp';
                    const quoteTitle = hasLiveQuote ? undefined : quoteStatusLabel(sym ?? { lastUpdated: 0 });
                    return (
                      <tr key={p.id}>
                        <td className="symbol">{p.symbol}</td>
                        <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                        <td>{p.quantity}</td>
                        <td>${fmt(p.entryPrice)}</td>
                        <td>${fmt(totalCost)}</td>
                        <td className={hasLiveQuote ? '' : 'muted'} title={quoteTitle}>
                          {hasLiveQuote ? `$${fmt(currentPrice)}` : '—'}
                        </td>
                        <td className={!hasLiveQuote ? 'muted' : pnlPct >= 0 ? 'green' : 'red'} title={quoteTitle}>
                          {hasLiveQuote ? fmtPct(pnlPct) : '—'}
                        </td>
                        <td className={!hasLiveQuote ? 'muted' : pnlDollar >= 0 ? 'green' : 'red'} title={quoteTitle}>
                          {hasLiveQuote ? fmtDollar(pnlDollar) : '—'}
                        </td>
                        <td className="red">${fmt(p.stopLoss)}</td>
                        <td className="green">${fmt(p.takeProfit)}</td>
                        {showPerpCols && (
                          <td className={isPerp ? '' : 'muted'}>
                            {isPerp && p.leverage != null ? `${p.leverage}×` : '—'}
                          </td>
                        )}
                        {showPerpCols && (
                          <td className={isPerp ? '' : 'muted'}>
                            {isPerp && p.liquidationPrice != null ? `$${fmt(p.liquidationPrice)}` : '—'}
                          </td>
                        )}
                        <td title={p.signalId ?? ''}>{positionSignalCell(p)}</td>
                        <td className="muted">{formatTime(p.openedAt)}</td>
                        <td><button className="btn-close-pos" onClick={() => closePosition(p.id)}>Close</button></td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            );
          })()}
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
              {sortRows(closedPositions, closedPosSort.sort, getCryptoClosedPosSortValue).map(p => {
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
          <span className="muted">Closed trades stay listed here until the 9:00 PM ET archive — full per-day history is under the <strong>P&amp;L Calendar</strong> tab.</span>
        </div>
      )}
      {/* TRA-249-E — collapsible aggregate of recent live-broker skip events.
          Hidden when the buffer is empty. */}
      <SkippedSignalsPanel skips={liveSkips} />
    </div>
  );
}
