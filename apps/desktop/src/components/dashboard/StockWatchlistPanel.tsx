// TRA-422 — the Stocks Watchlist tab, extracted from Dashboard.tsx. Owns the
// add/scan toolbar state and the watchlist-mutation fetches (add / remove /
// scan); the symbol list and live quotes are passed in from the parent.
import { useRef, useState } from 'react';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmt, fmtDollar, fmtPct, quoteStatusLabel, isQuoteMoveUnreliable } from '../../lib/format';
import { useTableSort, sortRows, SortableTH } from '../../lib/sort.tsx';
import { getStockWatchSortValue } from '../../lib/stockSort';
import type { StockWatchSortKey } from '../../lib/stockSort';
import type { SymbolState } from '../../types/app';
import { useSocialSentiment } from '../../hooks/useSocialSentiment';
import { SocialSentimentBadge } from './SocialSentimentBadge';

export function StockWatchlistPanel({ token, symbols }: { token: string; symbols: SymbolState[] }) {
  const [watchlistInput, setWatchlistInput] = useState('');
  const [watchlistError, setWatchlistError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const watchlistSort = useTableSort<StockWatchSortKey>('changePct', 'desc');
  const scanStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();
  // TRA-745 — per-symbol StockTwits social-sentiment read (crowd + curated lane).
  const social = useSocialSentiment(token, symbols.map(s => s.symbol));

  async function addToWatchlist() {
    const sym = watchlistInput.trim().toUpperCase();
    if (!sym) return;
    if (!/^[A-Z]{1,5}$/.test(sym)) {
      setWatchlistError('Invalid symbol. Use 1–5 letters (e.g. NVDA)');
      return;
    }
    if (symbols.some(s => s.symbol === sym)) {
      setWatchlistError('Symbol already in watchlist');
      return;
    }
    setWatchlistError('');
    setWatchlistInput('');
    try {
      const r = await fetch(`${HTTP_URL}/api/watchlist/stocks`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym }),
      });
      if (r.ok) toast.success(`${sym} added to watchlist`);
      else toast.error(`Could not add ${sym} (HTTP ${r.status})`);
    } catch (err) {
      logger.error('stock-watchlist', `failed to add ${sym}`, err);
      toast.error(`Could not add ${sym} — network error`);
    }
  }

  async function removeFromWatchlist(symbol: string) {
    try {
      const r = await fetch(`${HTTP_URL}/api/watchlist/stocks/${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success(`${symbol} removed from watchlist`);
      else toast.error(`Could not remove ${symbol} (HTTP ${r.status})`);
    } catch (err) {
      logger.error('stock-watchlist', `failed to remove ${symbol}`, err);
      toast.error(`Could not remove ${symbol} — network error`);
    }
  }

  async function scanMarket() {
    setScanning(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/watchlist/stocks/scan`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        const data = await r.json() as { added?: string[] };
        const count = data.added?.length ?? 0;
        const msg = count > 0 ? `${count} new symbol(s) added` : 'Scan complete — no new symbols found';
        setScanStatus(msg);
        if (scanStatusTimer.current) clearTimeout(scanStatusTimer.current);
        scanStatusTimer.current = setTimeout(() => setScanStatus(''), 5000);
        toast.info(msg);
      } else {
        logger.warn('stock-scan', `scan returned HTTP ${r.status}`);
        toast.error(`Market scan failed (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('stock-scan', 'market scan failed', err);
      toast.error('Market scan failed — network error');
    } finally {
      setScanning(false);
    }
  }

  return (
    <div className="watchlist">
      <div className="watchlist-toolbar">
        <input
          className="watchlist-add-input"
          placeholder="Add symbol (e.g. NVDA)"
          value={watchlistInput}
          onChange={e => { setWatchlistInput(e.target.value); setWatchlistError(''); }}
          onKeyDown={e => e.key === 'Enter' && addToWatchlist()}
        />
        <button className="btn-secondary btn-sm" onClick={addToWatchlist} disabled={!watchlistInput.trim()}>Add</button>
        <button className="btn-secondary btn-sm" onClick={scanMarket} disabled={scanning}>
          {scanning ? 'Scanning…' : '⚡ Scan Market'}
        </button>
      </div>
      {watchlistError && <div className="watchlist-error">{watchlistError}</div>}
      {scanStatus && <div className="watchlist-scan-status">{scanStatus}</div>}
      <table>
        <thead>
          <tr>
            <SortableTH label="Symbol" sortKey="symbol" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
            <SortableTH label="Price" sortKey="price" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
            <SortableTH label="Change" sortKey="change" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
            <SortableTH label="Change %" sortKey="changePct" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
            <SortableTH label="Volume" sortKey="volume" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
            <th title="StockTwits crowd + curated-analyst social tilt (24h)">Social</th>
            <SortableTH label="Updated" sortKey="updated" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
            <th></th>
          </tr>
        </thead>
        <tbody>
          {sortRows(symbols, watchlistSort.sort, getStockWatchSortValue).map(s => {
            // TRA-2379 — the server flagged this row's published session move as
            // implausible (unadjusted prev close). Render the two move cells
            // visibly degraded — an em-dash plus the raw value in the tooltip —
            // instead of a coloured number that reads as real. The PRICE is still
            // live and is shown normally; only the move is in doubt.
            // TRA-2610 — `isQuoteMoveUnreliable` now reads the dedicated
            // `moveSuspect` field (and re-executes the rule), so a row whose quote
            // has since failed keeps its badge instead of silently losing it.
            const moveUnreliable = isQuoteMoveUnreliable(s);
            const moveTitle = moveUnreliable
              ? `Reported ${fmtPct(s.changePct)} (${fmtDollar(s.change)}) — rejected: implied previous close is not believable. Raw value retained; see moveSuspect.`
              : undefined;
            return (
            <tr key={s.symbol} className={s.lastUpdated === 0 || moveUnreliable ? '' : s.change >= 0 ? 'up' : 'down'}>
              <td className="symbol">{s.symbol}{moveUnreliable && <span className="quote-suspect-badge" title={moveTitle}> ⚠ suspect</span>}</td>
              <td className="price">{s.lastUpdated === 0 ? '—' : `$${fmt(s.price)}`}</td>
              <td className={s.lastUpdated === 0 || moveUnreliable ? 'muted' : s.change >= 0 ? 'green' : 'red'} title={moveTitle}>{s.lastUpdated === 0 || moveUnreliable ? '—' : fmtDollar(s.change)}</td>
              <td className={s.lastUpdated === 0 || moveUnreliable ? 'muted' : s.changePct >= 0 ? 'green' : 'red'} title={moveTitle}>{s.lastUpdated === 0 || moveUnreliable ? '—' : fmtPct(s.changePct)}</td>
              <td>{s.lastUpdated === 0 ? '—' : (s.volume / 1_000_000).toFixed(1) + 'M'}</td>
              <td className="social-td">
                <SocialSentimentBadge
                  social={social[s.symbol]?.social ?? null}
                  note={social[s.symbol]?.note}
                />
              </td>
              <td className="muted">{quoteStatusLabel(s)}</td>
              <td><button className="watchlist-remove-btn" onClick={() => removeFromWatchlist(s.symbol)} title="Remove">&#xd7;</button></td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
