import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { CryptoEngineState, NewsItem, Position, AccountSettings, LiveSkip } from '@trading-app/shared';
import SettingsPage from './SettingsPage.tsx';
import { CalendarTab } from './CalendarTab.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SERVER_URL, HTTP_URL } from './server-url';
import { logger } from './lib/logger';
import { useToast } from './lib/toast.tsx';
import { createReconnectController } from './lib/backoff';
import { fmt, fmtDollar, fmtPrice, timeAgo, quoteStatusLabel, formatTime, signalLabel, exitReasonLabel } from './lib/format';
import { useTableSort, sortRows, SortableTH } from './lib/sort.tsx';
import type { SortState } from './lib/sort.tsx';
import { ThemeToggle } from './components/ThemeToggle';
import type { Theme } from './components/ThemeToggle';
import { ProfileMenu } from './components/ProfileMenu';
import { AccountModeSwitcher } from './components/AccountModeSwitcher';
import { SignalOptionRow } from './components/SignalOptionRow';
import { SkippedSignalsPanel } from './components/SkippedSignalsPanel';
import { positionSignalCell } from './lib/cells';
import type { SymbolState } from './types/app';

// TRA-339 — sortable column keys per Crypto dashboard table. Kept narrow
// (string-literal unions) so the SortableTH component and the value
// resolver below stay in sync; adding a column means adding a key here
// and a branch in getCryptoWatchSortValue / getCryptoOpenPosSortValue /
// getCryptoClosedPosSortValue.
type CryptoWatchSortKey = 'symbol' | 'price' | 'change' | 'changePct' | 'volume' | 'updated';
type CryptoOpenPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'cost' | 'current'
  | 'pnlPct' | 'pnlDollar' | 'stop' | 'target'
  | 'leverage' | 'liquidation' | 'opened';
type CryptoClosedPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'exit'
  | 'pnlPct' | 'pnlDollar' | 'reason' | 'closed';

function getCryptoWatchSortValue(s: SymbolState, key: CryptoWatchSortKey): unknown {
  if (s.lastUpdated === 0 && key !== 'symbol' && key !== 'updated') return null;
  switch (key) {
    case 'symbol': return s.symbol;
    case 'price': return s.price;
    case 'change': return s.change;
    case 'changePct': return s.changePct;
    case 'volume': return s.volume;
    case 'updated': return s.lastUpdated;
  }
}

function getCryptoOpenPosSortValue(p: Position, key: CryptoOpenPosSortKey, symbols: readonly SymbolState[]): unknown {
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

function getCryptoClosedPosSortValue(p: Position, key: CryptoClosedPosSortKey): unknown {
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

export default function CryptoDashboard({ token, onBack, onLogout, onActivity, theme, onToggleTheme }: { token: string; onBack: () => void; onLogout: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [state, setState] = useState<CryptoEngineState | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions' | 'news' | 'calendar'>('watchlist');
  const [profileModal, setProfileModal] = useState<null | 'settings' | 'change-password' | 'user-management'>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tradingToggling, setTradingToggling] = useState(false);
  const [accountMode, setAccountMode] = useState<'demo' | 'live'>('demo');
  const [watchlistInput, setWatchlistInput] = useState('');
  const [watchlistError, setWatchlistError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  // TRA-320 — surface Coinbase reject reasons on a manual close so the user
  // knows the position stayed open instead of silently disappearing.
  const [closeError, setCloseError] = useState('');
  // TRA-339 — per-table sort state for the Crypto dashboard.
  const watchlistSort = useTableSort<CryptoWatchSortKey>('changePct', 'desc');
  const openPosSort = useTableSort<CryptoOpenPosSortKey>('opened', 'desc');
  const closedPosSort = useTableSort<CryptoClosedPosSortKey>('closed', 'desc');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const toast = useToast();

  useEffect(() => {
    // TRA-419 — exponential reconnect backoff (was a flat 3s timer that
    // hammered the server during an outage). reset() on a healthy open.
    const reconnect = createReconnectController();
    function connect() {
      const ws = new WebSocket(`${SERVER_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => { setConnected(true); reconnect.reset(); };
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 1008) { onLogout(); return; }
        reconnectTimer.current = setTimeout(connect, reconnect.nextDelay());
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'crypto_state') { setState(msg.payload as CryptoEngineState); setEverConnected(true); }
          onActivity?.();
        } catch (err) { logger.warn('crypto-ws', 'dropped malformed WebSocket message', err); }
      };
    }
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActivity/onLogout are event-style callbacks; adding them would tear down and reconnect the WebSocket on every parent render
  }, [token, onBack]);

  useEffect(() => {
    if (connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 401) { onLogout(); return; }
        if (r.ok) setState(await r.json() as CryptoEngineState);
      } catch (err) { logger.warn('crypto-http', 'state poll failed; will retry', err); }
    }, 5000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onLogout is an event-style callback; adding it would restart the polling interval on every parent render
  }, [connected, token, onBack]);

  useEffect(() => {
    async function loadNews() {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/news`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) setNews(await r.json() as NewsItem[]);
      } catch (err) { logger.warn('crypto-http', 'news fetch failed; keeping previous items', err); }
    }
    loadNews();
    const id = setInterval(loadNews, 5 * 60_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      // Background probe — a non-admin token gets 401/403, which is expected;
      // a network failure is logged (not toasted) so it stays diagnosable
      // without nagging the user on a screen they didn't ask anything of.
      .catch(err => logger.warn('admin-check', 'admin probe failed', err));
  }, [token]);

  // TRA-327 — apply a fresh AccountSettings snapshot after the initial fetch
  // and after the SettingsPage `onSettingsSaved` callback fires so a save
  // takes effect without a hard refresh. Crypto only cares about `mode`
  // today; other fields are harmlessly ignored.
  const applyAccountSettings = useCallback((s: Partial<AccountSettings> | null | undefined) => {
    if (!s) return;
    if (s.mode === 'demo' || s.mode === 'live') setAccountMode(s.mode);
  }, []);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/account/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((s: Partial<AccountSettings> | null) => applyAccountSettings(s))
      // Background settings refresh on tab switch — log a fetch failure for
      // diagnosis; the cached settings stay in effect, so no toast is needed.
      .catch(err => logger.warn('account-settings', 'settings refresh failed', err));
  }, [tab, token, applyAccountSettings]);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  // TRA-238 — surface closed crypto trades in the Positions tab until the 9 PM
  // ET archive sweep clears them; per-day history then lives under the
  // P&L Calendar tab.
  const closedPositions = state?.closedPositions ?? [];
  const autoTradingEnabled = state?.autoTradingEnabled ?? true;

  async function toggleAutoTrading() {
    setTradingToggling(true);
    const next = autoTradingEnabled ? 'stop' : 'start';
    try {
      const r = await fetch(`${HTTP_URL}/api/crypto/trading/${next}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        toast.success(next === 'start' ? 'Auto-trading started' : 'Auto-trading stopped');
      } else {
        logger.warn('crypto-trading', `${next} returned HTTP ${r.status}`);
        toast.error(`Could not ${next} auto-trading (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('crypto-trading', `failed to ${next} auto-trading`, err);
      toast.error(`Could not ${next} auto-trading — network error`);
    } finally {
      setTradingToggling(false);
    }
  }

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
        // is still open at the broker (the next state broadcast will keep
        // surfacing it instead of optimistically removing it).
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

  async function addToWatchlist() {
    const sym = watchlistInput.trim().toUpperCase();
    if (!sym) return;
    if (!/^[A-Z]{2,10}-USD$/.test(sym)) {
      setWatchlistError('Invalid symbol. Use format XXX-USD (e.g. ETH-USD)');
      return;
    }
    if (symbols.some(s => s.symbol === sym)) {
      setWatchlistError('Symbol already in watchlist');
      return;
    }
    setWatchlistError('');
    setWatchlistInput('');
    try {
      const r = await fetch(`${HTTP_URL}/api/watchlist/crypto`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: sym }),
      });
      if (r.ok) toast.success(`${sym} added to watchlist`);
      else toast.error(`Could not add ${sym} (HTTP ${r.status})`);
    } catch (err) {
      logger.error('crypto-watchlist', `failed to add ${sym}`, err);
      toast.error(`Could not add ${sym} — network error`);
    }
  }

  async function removeFromWatchlist(symbol: string) {
    try {
      const r = await fetch(`${HTTP_URL}/api/watchlist/crypto/${encodeURIComponent(symbol)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success(`${symbol} removed from watchlist`);
      else toast.error(`Could not remove ${symbol} (HTTP ${r.status})`);
    } catch (err) {
      logger.error('crypto-watchlist', `failed to remove ${symbol}`, err);
      toast.error(`Could not remove ${symbol} — network error`);
    }
  }

  async function scanCryptoMarket() {
    setScanning(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/watchlist/crypto/scan`, {
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
        logger.warn('crypto-scan', `scan returned HTTP ${r.status}`);
        toast.error(`Market scan failed (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('crypto-scan', 'market scan failed', err);
      toast.error('Market scan failed — network error');
    } finally {
      setScanning(false);
    }
  }

  async function resetSignals() {
    try {
      const r = await fetch(`${HTTP_URL}/api/crypto/signals/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success('Signals cleared');
      else toast.error(`Could not reset signals (HTTP ${r.status})`);
    } catch (err) {
      logger.error('crypto-signals', 'reset signals failed', err);
      toast.error('Could not reset signals — network error');
    }
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="back-btn" onClick={onBack} title="Back to dashboard selector">&#8592; Home</button>
          <h1>TradingAI <span className="mode-badge crypto">Crypto</span></h1>
          <AccountModeSwitcher mode={accountMode} onChange={setAccountMode} market="crypto" token={token} />
        </div>
        <div className="header-right">
          {account && (
            <div className="stat-group">
              <div className="stat">
                <span className="stat-label">Equity</span>
                <span className="stat-value">${fmt(account.totalEquity)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Today P&amp;L</span>
                <span className={`stat-value ${account.dailyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.dailyPnl)}
                </span>
              </div>
              {account.weeklyPnl !== undefined && (
                <div className="stat">
                  <span className="stat-label">Week P&amp;L</span>
                  <span className={`stat-value ${account.weeklyPnl >= 0 ? 'green' : 'red'}`}>
                    {fmtDollar(account.weeklyPnl)}
                  </span>
                </div>
              )}
              <div className="stat">
                <span className="stat-label">Cash</span>
                <span className="stat-value">${fmt(account.availableCash)}</span>
              </div>
              <div className="stat">
                <span className="stat-label">Positions</span>
                <span className="stat-value">{openPositions.length}</span>
              </div>
            </div>
          )}
          <div className="stat-divider" />
          <div className="status-group">
            <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live' : 'Reconnecting...'} />
            <div className="status-text">
              <span className="status-label">{connected ? 'LIVE' : 'OFFLINE'}</span>
              {state && <span className="last-tick">Updated {timeAgo(state.lastTick)}</span>}
            </div>
          </div>
          <div className="stat-divider" />
          <div className="action-group">
            <button
              className={`logout-btn${autoTradingEnabled ? ' trading-active' : ' trading-stopped'}`}
              onClick={toggleAutoTrading}
              disabled={tradingToggling}
              title={autoTradingEnabled ? 'Stop auto trading' : 'Start auto trading'}
            >
              {autoTradingEnabled ? '⏹ Stop Trading' : '▶ Start Trading'}
            </button>
            <ThemeToggle theme={theme} onToggle={onToggleTheme} />
            <ProfileMenu
              onSettings={() => setProfileModal('settings')}
              onChangePassword={() => setProfileModal('change-password')}
              onUserManagement={() => setProfileModal('user-management')}
              onLogout={onLogout}
              isAdmin={isAdmin}
            />
          </div>
        </div>
      </header>

      <nav className="tabs">
        {(['watchlist', 'signals', 'positions', 'news'] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'watchlist' ? `Watchlist (${symbols.length})` :
             t === 'signals' ? `Signals (${signals.length})` :
             t === 'positions' ? `Positions (${openPositions.length})` :
             `News (${news.length})`}
          </button>
        ))}
        <button className={`tab ${tab === 'calendar' ? 'active' : ''}`} onClick={() => setTab('calendar')}>
          P&amp;L Calendar
        </button>
      </nav>

      {profileModal === 'settings' && (
        <div className="modal-backdrop" onClick={() => setProfileModal(null)}>
          <div className="modal-card modal-card-settings" onClick={e => e.stopPropagation()}>
            <button
              className="modal-close-corner"
              onClick={() => setProfileModal(null)}
              aria-label="Close settings"
              title="Close"
            >
              &#x2715;
            </button>
            <SettingsPage token={token} httpUrl={HTTP_URL} context="crypto" onModeChange={setAccountMode} onSettingsSaved={applyAccountSettings} onLogout={onLogout} />
          </div>
        </div>
      )}

      {profileModal === 'change-password' && (
        <div className="modal-backdrop" onClick={() => setProfileModal(null)}>
          <div className="modal-card" onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Change Password</h3>
              <button className="btn-secondary btn-sm" onClick={() => setProfileModal(null)}>&#x2715;</button>
            </div>
            <ChangePasswordSection token={token} httpUrl={HTTP_URL} />
          </div>
        </div>
      )}

      {profileModal === 'user-management' && isAdmin && (
        <div className="modal-backdrop" onClick={() => setProfileModal(null)}>
          <div className="modal-card" style={{ maxWidth: '660px' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
              <h3 style={{ fontSize: '0.95rem', fontWeight: 700 }}>Account Management</h3>
              <button className="btn-secondary btn-sm" onClick={() => setProfileModal(null)}>&#x2715;</button>
            </div>
            <UserManagementSection token={token} httpUrl={HTTP_URL} />
          </div>
        </div>
      )}

      <main className="content">
       {/* TRA-398 — per-tab error boundary. `key={tab}` remounts it on tab
           switch so a render crash in one tab cannot white-screen the app. */}
       <ErrorBoundary key={tab} label={`crypto:${tab}`} variant="panel">
        {!state && !everConnected && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to crypto engine…</p>
          </div>
        )}
        {!state && everConnected && (
          <div className="loading">
            <div className="spinner" />
            <p>Connection lost — reconnecting…</p>
          </div>
        )}

        {state && tab === 'watchlist' && (
          <div className="watchlist">
            <div className="watchlist-toolbar">
              <input
                className="watchlist-add-input"
                placeholder="Add symbol (e.g. ETH-USD)"
                value={watchlistInput}
                onChange={e => { setWatchlistInput(e.target.value); setWatchlistError(''); }}
                onKeyDown={e => e.key === 'Enter' && addToWatchlist()}
              />
              <button className="btn-secondary btn-sm" onClick={addToWatchlist} disabled={!watchlistInput.trim()}>Add</button>
              <button className="btn-secondary btn-sm" onClick={scanCryptoMarket} disabled={scanning}>
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
                  <SortableTH label="Updated" sortKey="updated" sort={watchlistSort.sort} onSort={watchlistSort.onSort} />
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sortRows(symbols, watchlistSort.sort, getCryptoWatchSortValue).map(s => (
                  <tr key={s.symbol} className={s.lastUpdated === 0 ? '' : s.change >= 0 ? 'up' : 'down'}>
                    <td className="symbol">{s.symbol}</td>
                    <td className="price">{s.lastUpdated === 0 ? '—' : `$${fmt(s.price)}`}</td>
                    <td className={s.lastUpdated === 0 ? 'muted' : s.change >= 0 ? 'green' : 'red'}>{s.lastUpdated === 0 ? '—' : fmtDollar(s.change)}</td>
                    <td className={s.lastUpdated === 0 ? 'muted' : s.changePct >= 0 ? 'green' : 'red'}>{s.lastUpdated === 0 ? '—' : fmtPct(s.changePct)}</td>
                    <td>{s.lastUpdated === 0 ? '—' : (s.volume / 1_000_000).toFixed(1) + 'M'}</td>
                    <td className="muted">{quoteStatusLabel(s)}</td>
                    <td><button className="watchlist-remove-btn" onClick={() => removeFromWatchlist(s.symbol)} title="Remove">&#xd7;</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {state && tab === 'signals' && (
          <div className="signals-panel">
            <div className="signals-toolbar">
              <button
                className="btn-secondary btn-sm"
                onClick={resetSignals}
                disabled={signals.length === 0}
                title="Clear the signal list"
              >
                Reset Signals
              </button>
            </div>
            {signals.length === 0 ? (
              <div className="empty">No signals yet — engine is scanning {symbols.filter(s => s.lastUpdated > 0).length} symbols…</div>
            ) : (
              <div className="signal-list">
                {signals.map(sig => (
                  <div key={sig.id} className={`signal-card ${sig.side}`}>
                    <div className="signal-header">
                      <span className="signal-symbol">{sig.symbol}</span>
                      <span className={`signal-side ${sig.side}`}>{sig.side.toUpperCase()}</span>
                      <span className="signal-type">{signalLabel(sig.type)}</span>
                      <span className="signal-time" title={formatTime(sig.timestamp)}>{timeAgo(sig.timestamp)}</span>
                    </div>
                    <div className="signal-body">
                      <div className="sig-stat"><span>Entry</span><strong>${fmt(sig.entryPrice)}</strong></div>
                      <div className="sig-stat">
                        <span>Stop</span>
                        <strong className="red">
                          ${fmt(sig.stopLoss)}
                          {sig.entryPrice > 0 && (
                            <span className="sig-stat-pct"> ({fmtSignedIntPct((sig.stopLoss - sig.entryPrice) / sig.entryPrice * 100)})</span>
                          )}
                        </strong>
                      </div>
                      <div className="sig-stat">
                        <span>Target</span>
                        <strong className="green">
                          ${fmt(sig.takeProfit)}
                          {sig.entryPrice > 0 && (
                            <span className="sig-stat-pct"> ({fmtSignedIntPct((sig.takeProfit - sig.entryPrice) / sig.entryPrice * 100)})</span>
                          )}
                        </strong>
                      </div>
                      <div className="sig-stat"><span>R:R</span><strong>1:{sig.riskRewardRatio}</strong></div>
                    </div>
                    <SignalOptionRow sig={sig} />
                    {sig.signalSkipReason && (
                      // TRA-261 — pre-route suppression (universe gate, §5
                      // short filters, MR-shorts off-strategy). Distinct from
                      // liveSkipReason which is a broker-side skip; the
                      // strategy fired and the engine deliberately blocked
                      // routing it, surfaced verbatim from the spec strings.
                      <div className="signal-skip-reason" title={sig.signalSkipReason}>
                        <span>Suppressed: {sig.signalSkipReason}</span>
                      </div>
                    )}
                    {sig.liveSkipReason && (
                      <div className="signal-skip-reason" title={sig.liveSkipReason}>
                        <span>Not opened: {sig.liveSkipReason}</span>
                        {sig.liveSkipReason.includes('not listed on Coinbase') && (
                          // TRA-243 — one-click watchlist prune for symbols Coinbase
                          // doesn't list (LUNC, MATIC after the POL rename, etc.) so
                          // the user doesn't have to open the watchlist tab and
                          // hunt for the row on every dead ticker. removeFromWatchlist
                          // routes through DELETE /api/watchlist/crypto/:symbol which
                          // hides curated symbols and drops dynamic ones outright.
                          <button
                            className="btn-secondary btn-sm signal-skip-action"
                            onClick={() => removeFromWatchlist(sig.symbol)}
                            title={`Remove ${sig.symbol} from the crypto watchlist`}
                          >
                            Remove {sig.symbol}
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state && tab === 'positions' && (
          <div className="positions-panel">
            {closeError && (
              // TRA-320 — Coinbase rejected the manual close. The position is
              // still open in the broker; this banner tells the user why so
              // they can act (top up cash, retry, etc.) instead of believing
              // the silent fire-and-forget worked.
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
                {/* TRA-249-E — Leverage / Liquidation columns are rendered only
                    when at least one open row is a perp. Spot-only sessions
                    keep the previous header layout byte-identical. */}
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
                          // so a delisted/unmapped ticker (e.g. RNDR-USD post-rebrand,
                          // PLUME-USD only on Coinbase) doesn't render -100% P&L.
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
            {/* TRA-249-E — collapsible aggregate of recent live-broker skip
                events. Hidden when the buffer is empty, which means demo
                runs and pristine live runs see no extra panel. */}
            <SkippedSignalsPanel skips={state.liveSkips ?? []} />
          </div>
        )}

        {tab === 'news' && (
          <div className="signals-panel">
            {news.length === 0 ? (
              <div className="empty">Loading crypto news…</div>
            ) : (
              <div className="signal-list">
                {news.slice(0, 10).map((item) => (
                  <NewsCard key={item.id ?? item.url} item={item} />
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'calendar' && (
          <CalendarTab
            token={token}
            httpUrl={HTTP_URL}
            reportsPath="/api/crypto/reports"
            mode={accountMode}
            market="crypto"
          />
        )}
       </ErrorBoundary>
      </main>
    </div>
  );
}


