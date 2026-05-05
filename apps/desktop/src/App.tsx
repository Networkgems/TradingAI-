import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TradeSignal, Position, AccountState, OptionPosition, OptionsAccountState, CryptoEngineState, LiveSkip, NewsItem } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import LoginPage from './LoginPage.tsx';
import ForgotPasswordPage from './ForgotPasswordPage.tsx';
import SignUpPage from './SignUpPage.tsx';
import SettingsPage, { ChangePasswordSection, UserManagementSection } from './SettingsPage.tsx';
import { CalendarTab } from './CalendarTab.tsx';
import { SERVER_URL, HTTP_URL } from './server-url';
import './index.css';

type Theme = 'light' | 'dark';
const THEME_STORAGE_KEY = 'tradingai_theme';

function readInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch { /* ignore */ }
  return 'light';
}

function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch { /* ignore */ }
  }, [theme]);

  const toggleTheme = useCallback(() => {
    setTheme(t => t === 'light' ? 'dark' : 'light');
  }, []);

  return { theme, toggleTheme };
}

function ThemeToggle({ theme, onToggle }: { theme: Theme; onToggle: () => void }) {
  const isDark = theme === 'dark';
  return (
    <button
      type="button"
      className="theme-toggle"
      onClick={onToggle}
      title={isDark ? 'Switch to light mode' : 'Switch to dark mode'}
      aria-label="Toggle theme"
    >
      <span aria-hidden="true">{isDark ? '☾' : '☀'}</span>
      <span className="theme-toggle-label">{isDark ? 'Dark' : 'Light'}</span>
    </button>
  );
}

function CandlestickIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect x="8" y="18" width="8" height="16" rx="1" fill="#3fb950" />
      <line x1="12" y1="10" x2="12" y2="18" stroke="#3fb950" strokeWidth="2" />
      <line x1="12" y1="34" x2="12" y2="42" stroke="#3fb950" strokeWidth="2" />
      <rect x="22" y="12" width="8" height="20" rx="1" fill="#f85149" />
      <line x1="26" y1="6" x2="26" y2="12" stroke="#f85149" strokeWidth="2" />
      <line x1="26" y1="32" x2="26" y2="40" stroke="#f85149" strokeWidth="2" />
      <rect x="36" y="16" width="8" height="14" rx="1" fill="#3fb950" />
      <line x1="40" y1="8" x2="40" y2="16" stroke="#3fb950" strokeWidth="2" />
      <line x1="40" y1="30" x2="40" y2="38" stroke="#3fb950" strokeWidth="2" />
    </svg>
  );
}

function BitcoinIcon() {
  return (
    <svg width="48" height="48" viewBox="0 0 48 48" fill="none" xmlns="http://www.w3.org/2000/svg">
      <circle cx="24" cy="24" r="20" stroke="#f7931a" strokeWidth="2.5" />
      <text x="24" y="31" textAnchor="middle" fontSize="22" fontWeight="bold" fill="#f7931a" fontFamily="monospace">₿</text>
    </svg>
  );
}

function DashboardSelector({ onSelect, onLogout, theme, onToggleTheme }: { onSelect: (mode: 'stocks' | 'crypto') => void; onLogout: () => void; theme: Theme; onToggleTheme: () => void }) {
  return (
    <div className="selector-screen">
      <div className="selector-topbar">
        <ThemeToggle theme={theme} onToggle={onToggleTheme} />
        <button className="logout-btn" onClick={onLogout}>Sign Out</button>
      </div>
      <div className="selector-header">
        <h1 className="selector-title">TradingAI</h1>
        <p className="selector-subtitle">Select your trading dashboard</p>
      </div>
      <div className="selector-cards">
        <button className="selector-card stocks" onClick={() => onSelect('stocks')}>
          <div className="selector-card-icon"><CandlestickIcon /></div>
          <div className="selector-card-title">Stocks Trading</div>
          <div className="selector-card-desc">Trade US equities with ORB, Reversal, MACD, and Ichimoku strategies</div>
        </button>
        <button className="selector-card crypto" onClick={() => onSelect('crypto')}>
          <div className="selector-card-icon"><BitcoinIcon /></div>
          <div className="selector-card-title">Crypto Trading</div>
          <div className="selector-card-desc">Trade crypto 24/7 with live data and algorithmic strategies</div>
        </button>
      </div>
    </div>
  );
}

function ProfileMenu({ onSettings, onChangePassword, onUserManagement, onLogout, isAdmin }: {
  onSettings: () => void;
  onChangePassword: () => void;
  onUserManagement: () => void;
  onLogout: () => void;
  isAdmin: boolean;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState({ top: 0, right: 0 });

  // Compute position synchronously before paint so the dropdown never flashes at (0,0).
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const rect = btnRef.current.getBoundingClientRect();
    const vw = window.innerWidth;
    const top = rect.bottom + 6;
    // Clamp `right` so the dropdown never escapes the viewport when the trigger
    // sits inside a horizontally-scrolled container (e.g. .header-right on mobile).
    const right = Math.max(8, Math.min(vw - 8, vw - rect.right));
    setPos({ top, right });
  }, [open]);

  // Close when the viewport changes (orientation, soft keyboard, address bar).
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    window.addEventListener('resize', close);
    window.addEventListener('orientationchange', close);
    return () => {
      window.removeEventListener('resize', close);
      window.removeEventListener('orientationchange', close);
    };
  }, [open]);

  return (
    <div className="profile-wrap">
      <button
        ref={btnRef}
        className="logout-btn"
        onClick={() => setOpen(o => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Profile menu"
      >
        &#x1F464; Profile &#9660;
      </button>
      {open && createPortal(
        <>
          {/* Transparent full-viewport backdrop. Catches the next outside tap reliably
              on mobile, where document-level click listeners race with the synthetic
              click that opened the menu. */}
          <div
            className="profile-dropdown-backdrop"
            onClick={() => setOpen(false)}
          />
          <div
            className="profile-dropdown"
            role="menu"
            style={{ position: 'fixed', top: pos.top, right: pos.right }}
          >
            <button
              className="profile-dropdown-item"
              role="menuitem"
              onClick={() => { onSettings(); setOpen(false); }}
            >
              Settings
            </button>
            <button
              className="profile-dropdown-item"
              role="menuitem"
              onClick={() => { onChangePassword(); setOpen(false); }}
            >
              Change Password
            </button>
            {isAdmin && (
              <button
                className="profile-dropdown-item"
                role="menuitem"
                onClick={() => { onUserManagement(); setOpen(false); }}
              >
                Account Management
              </button>
            )}
            <div className="profile-dropdown-divider" />
            <button
              className="profile-dropdown-item danger"
              role="menuitem"
              onClick={() => { setOpen(false); onLogout(); }}
            >
              Sign Out
            </button>
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

function AccountModeSwitcher({
  mode,
  onChange,
  market,
  token,
}: {
  mode: 'demo' | 'live';
  onChange: (mode: 'demo' | 'live') => void;
  market: 'stocks' | 'crypto';
  token: string;
}) {
  const [busy, setBusy] = useState(false);

  async function switchTo(next: 'demo' | 'live') {
    if (next === mode || busy) return;
    if (next === 'live') {
      const ackKey = `liveModeAcknowledged_${market}`;
      const alreadyAcknowledged = localStorage.getItem(ackKey) === 'true';
      if (!alreadyAcknowledged) {
        const ok = window.confirm(
          `Switch ${market === 'crypto' ? 'Crypto' : 'Stocks'} dashboard to LIVE account?\n\n` +
          'Live mode places real orders against your configured brokerage. ' +
          'Make sure your live credentials are set up in Settings.',
        );
        if (!ok) return;
        localStorage.setItem(ackKey, 'true');
      }
    }
    setBusy(true);
    try {
      const r = await fetch(`${HTTP_URL}/api/account/settings`, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode: next }),
      });
      if (r.ok) onChange(next);
    } catch { /* ignore */ } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`account-mode-switch${busy ? ' busy' : ''}`} role="group" aria-label="Account mode">
      <button
        type="button"
        className={`account-mode-option demo${mode === 'demo' ? ' active' : ''}`}
        onClick={() => switchTo('demo')}
        disabled={busy}
        aria-pressed={mode === 'demo'}
        title="Use the demo (paper) account"
      >
        Demo
      </button>
      <button
        type="button"
        className={`account-mode-option live${mode === 'live' ? ' active' : ''}`}
        onClick={() => switchTo('live')}
        disabled={busy}
        aria-pressed={mode === 'live'}
        title="Use the live brokerage account"
      >
        Live
      </button>
    </div>
  );
}

function CryptoDashboard({ token, onBack, onLogout, onActivity, theme, onToggleTheme }: { token: string; onBack: () => void; onLogout: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
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
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(`${SERVER_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 1008) { onLogout(); return; }
        reconnectTimer.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'crypto_state') { setState(msg.payload as CryptoEngineState); setEverConnected(true); }
          onActivity?.();
        } catch { /* ignore */ }
      };
    }
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
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
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(id);
  }, [connected, token, onBack]);

  useEffect(() => {
    async function loadNews() {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/news`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) setNews(await r.json() as NewsItem[]);
      } catch { /* ignore */ }
    }
    loadNews();
    const id = setInterval(loadNews, 5 * 60_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/account/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((s: { mode?: 'demo' | 'live' } | null) => { if (s?.mode) setAccountMode(s.mode); })
      .catch(() => {});
  }, [tab, token]);

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
    try {
      await fetch(`${HTTP_URL}/api/crypto/trading/${autoTradingEnabled ? 'stop' : 'start'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ } finally {
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
        setCloseError(body.reason || body.error || `Close failed (HTTP ${r.status})`);
      }
    } catch (err) {
      setCloseError(err instanceof Error ? err.message : 'Close failed');
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
    await fetch(`${HTTP_URL}/api/watchlist/crypto`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym }),
    }).catch(() => {});
  }

  async function removeFromWatchlist(symbol: string) {
    await fetch(`${HTTP_URL}/api/watchlist/crypto/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
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
      }
    } catch { /* ignore */ } finally {
      setScanning(false);
    }
  }

  async function resetSignals() {
    await fetch(`${HTTP_URL}/api/crypto/signals/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
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
            <SettingsPage token={token} httpUrl={HTTP_URL} context="crypto" onModeChange={setAccountMode} />
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
                  <th>Symbol</th><th>Price</th><th>Change</th><th>Change %</th><th>Volume</th><th>Updated</th><th></th>
                </tr>
              </thead>
              <tbody>
                {symbols.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).map(s => (
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
                      <div className="sig-stat"><span>Stop</span><strong className="red">${fmt(sig.stopLoss)}</strong></div>
                      <div className="sig-stat"><span>Target</span><strong className="green">${fmt(sig.takeProfit)}</strong></div>
                      <div className="sig-stat"><span>R:R</span><strong>1:{sig.riskRewardRatio}</strong></div>
                    </div>
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
                  return (
                    <table>
                      <thead>
                        <tr>
                          <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Cost</th><th>Current</th>
                          <th>P&amp;L %</th><th>P&amp;L $</th><th>Stop</th><th>Target</th>
                          {showPerpCols && <th>Leverage</th>}
                          {showPerpCols && <th>Liquidation</th>}
                          <th>Opened</th><th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {openPositions.map(p => {
                          const sym = symbols.find(s => s.symbol === p.symbol);
                          const currentPrice = sym?.price ?? p.entryPrice;
                          const multiplier = p.side === 'buy' ? 1 : -1;
                          const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100 * multiplier;
                          const pnlDollar = (currentPrice - p.entryPrice) * p.quantity * multiplier;
                          const totalCost = p.entryPrice * p.quantity;
                          const isPerp = p.productType === 'perp';
                          return (
                            <tr key={p.id}>
                              <td className="symbol">{p.symbol}</td>
                              <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                              <td>{p.quantity}</td>
                              <td>${fmt(p.entryPrice)}</td>
                              <td>${fmt(totalCost)}</td>
                              <td>${fmt(currentPrice)}</td>
                              <td className={pnlPct >= 0 ? 'green' : 'red'}>{fmtPct(pnlPct)}</td>
                              <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
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
                      <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th>
                      <th>P&amp;L %</th><th>P&amp;L $</th><th>Reason</th><th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...closedPositions].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).map(p => {
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
          />
        )}
      </main>
    </div>
  );
}

interface SymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
}

interface AppState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: Position[];
  options: OptionsAccountState;
  lastTick: number;
  tradingHalted: boolean;
  haltReason: string | null;
  autoTradingEnabled: boolean;
}

// TRA-318 follow-up: defend against null/undefined/NaN/non-finite numeric
// fields arriving from the API (e.g. `Number.POSITIVE_INFINITY` reconciled
// from a Coinbase wallet holding gets serialized to `null` over the wire).
// Without this guard the formatters threw and crashed the Positions tab to
// a white screen.
function fmt(n: number | null | undefined, decimals = 2) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollar(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${fmt(Math.abs(n))}`;
}

function fmtPct(n: number | null | undefined) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  const sign = n >= 0 ? '+' : '';
  return `${sign}${fmt(n, 2)}%`;
}

// Dollar-prefixed price for un-signed columns (entry, stop, target, cost).
// Returns "—" alone (no leading "$") when the value is missing/sentinel.
function fmtPrice(n: number | null | undefined, decimals = 2) {
  if (n == null || !Number.isFinite(n) || Math.abs(n) >= 1e15) return '—';
  return `$${fmt(n, decimals)}`;
}

function timeAgo(ts: number) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

/**
 * Human-readable label for the watchlist "Updated" column. Surfaces upstream
 * provider state so a rate-limited or down quote source shows actionable text
 * instead of a perpetual "Loading…" spinner.
 */
function quoteStatusLabel(s: { lastUpdated: number; quoteStatus?: 'ok' | 'rate_limited' | 'unavailable' }): string {
  if (s.quoteStatus === 'rate_limited') return 'Quote unavailable — provider rate-limited';
  if (s.quoteStatus === 'unavailable') return 'Quote unavailable';
  if (s.lastUpdated === 0) return 'Loading…';
  return timeAgo(s.lastUpdated);
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function signalLabel(type: string) {
  switch (type) {
    case 'orb_breakout': return 'ORB';
    case 'reversal': return 'Reversal';
    case 'macd_cross': return 'MACD';      // legacy positions still on disk
    case 'macd_trend': return 'MACD Trend';
    case 'bb_fade': return 'BB Fade';
    case 'ichimoku': return 'Ichimoku';
    case 'scalping': return 'Scalping';
    case 'swing_trade': return 'Swing';
    case 'relative_value': return 'Relative Value';
    case 'otm_mispricing': return 'OTM Mispricing';
    default: return type;
  }
}

function exitReasonLabel(reason?: string) {
  switch (reason) {
    case 'stop': return 'Stop';
    case 'target': return 'Target';
    case 'time_stop': return 'Time';
    case 'trailing': return 'Trail';
    case 'rsi_alt_exit': return 'RSI exit';
    default: return reason ?? '—';
  }
}

/**
 * TRA-249-E — collapsible "Recent skipped signals" panel rendered under the
 * crypto Positions table. Reads `liveSkips` off `CryptoEngineState` (the
 * aggregate ring buffer populated by `CryptoLiveAccount.recordSkip`). Hidden
 * entirely on demo and on live runs that have not skipped anything yet, so
 * the panel doesn't add visual noise to the spot-only experience. Newest
 * skips are shown first.
 */
export function SkippedSignalsPanel({ skips }: { skips: LiveSkip[] }) {
  const [expanded, setExpanded] = useState(false);
  if (skips.length === 0) return null;
  const ordered = [...skips].sort((a, b) => b.at - a.at);
  return (
    <div className="skipped-signals-panel" style={{ marginTop: '1.5rem' }}>
      <button
        type="button"
        className="btn-secondary btn-sm"
        onClick={() => setExpanded(v => !v)}
        aria-expanded={expanded}
      >
        {expanded ? '▾' : '▸'} Recent skipped signals ({ordered.length})
      </button>
      {expanded && (
        <table style={{ marginTop: '0.5rem' }}>
          <thead>
            <tr>
              <th>Symbol</th>
              <th>Side</th>
              <th>Reason</th>
              <th>When</th>
            </tr>
          </thead>
          <tbody>
            {ordered.map((s, i) => (
              <tr key={`${s.at}-${s.symbol}-${i}`}>
                <td className="symbol">{s.symbol}</td>
                <td className={s.side === 'buy' ? 'green' : 'red'}>{s.side.toUpperCase()}</td>
                <td className="muted" title={s.reason}>{s.reason}</td>
                <td className="muted">{timeAgo(s.at)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

function researchKindLabel(kind?: string) {
  switch (kind) {
    case 'premarket': return 'Pre-Market';
    case 'postmarket': return 'Post-Market';
    case 'weekly_review': return 'Weekly Review';
    default: return null;
  }
}

/**
 * TRA-227 — minimal markdown→HTML renderer for the QuantTrader research-body
 * surface. Handles the syntax the routine actually produces: ATX headings,
 * blockquotes, ordered/unordered lists, paragraphs, and inline `**bold**`
 * `*italic*` `` `code` `` and `[text](url)` links. HTML entities are escaped
 * BEFORE markdown transforms apply so any user-influenced content can't inject
 * raw HTML; only the markdown-derived tags reach the DOM. Anchor URLs are
 * scheme-validated (http/https/relative) so a malicious `javascript:` link in
 * a payload can't ride into an `href`.
 *
 * Kept inline rather than pulling react-markdown / marked because the surface
 * is small and the risk of bringing a sizable parser into the desktop bundle
 * outweighs the savings.
 */
function renderResearchMarkdown(md: string): string {
  const escaped = md
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

  const inline = (s: string): string => s
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text, href) => {
      const safe = /^(https?:\/\/|\/)/i.test(href) ? href : '#';
      return `<a href="${safe}" target="_blank" rel="noopener noreferrer">${text}</a>`;
    });

  // Re-decode `&gt;` at line start so blockquote/heading parsers see the
  // original markdown markers without re-introducing HTML elsewhere.
  const lines = escaped.replace(/^&gt;/gm, '>').split(/\r?\n/);
  const out: string[] = [];
  let i = 0;
  const isHeading = (l: string) => /^#{1,6}\s+/.test(l);
  const isBlockquote = (l: string) => /^>\s?/.test(l);
  const isUnordered = (l: string) => /^[-*]\s+/.test(l);
  const isOrdered = (l: string) => /^\d+\.\s+/.test(l);
  const isBlockStart = (l: string) =>
    isHeading(l) || isBlockquote(l) || isUnordered(l) || isOrdered(l);

  while (i < lines.length) {
    const line = lines[i];

    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length, 6);
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++; continue;
    }

    if (isBlockquote(line)) {
      const buf: string[] = [];
      while (i < lines.length && isBlockquote(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ''));
        i++;
      }
      out.push(`<blockquote>${inline(buf.join(' '))}</blockquote>`);
      continue;
    }

    if (isUnordered(line)) {
      const buf: string[] = [];
      while (i < lines.length && isUnordered(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^[-*]\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ul>${buf.join('')}</ul>`);
      continue;
    }

    if (isOrdered(line)) {
      const buf: string[] = [];
      while (i < lines.length && isOrdered(lines[i])) {
        buf.push(`<li>${inline(lines[i].replace(/^\d+\.\s+/, ''))}</li>`);
        i++;
      }
      out.push(`<ol>${buf.join('')}</ol>`);
      continue;
    }

    if (line.trim() === '') { i++; continue; }

    const buf: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('');
}

/**
 * TRA-227 — News tab card. Yahoo headlines render as a plain external link;
 * QuantTrader research items render with a "Research" badge and an
 * expand/collapse button that reveals the formatted markdown body. Identifiable
 * via `bodyMarkdown` and the `kind` field set by the server.
 */
function NewsCard({ item }: { item: NewsItem }) {
  const isResearch = !!item.bodyMarkdown && item.source === 'QuantTrader';
  const [expanded, setExpanded] = useState(false);
  if (!isResearch) {
    return (
      <div className="news-card">
        <div className="signal-header">
          <span className="signal-symbol">{item.source}</span>
          <span className="signal-time muted">{timeAgo(new Date(item.publishedAt).getTime())}</span>
        </div>
        <div style={{ padding: '0.5rem 0' }}>
          <a href={item.url} target="_blank" rel="noopener noreferrer"
             style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 500 }}>
            {item.title}
          </a>
          {item.summary && (
            <p style={{ marginTop: '0.3rem', color: 'var(--muted)', fontSize: '0.75rem', lineHeight: 1.5 }}>
              {item.summary}
            </p>
          )}
        </div>
      </div>
    );
  }
  const kindLabel = researchKindLabel(item.kind);
  return (
    <div className="news-card research">
      <div className="signal-header">
        <span className="signal-symbol">
          <span className="research-badge">Research</span>
          {item.source}
          {kindLabel && <span className="research-kind">{kindLabel}</span>}
        </span>
        <span className="signal-time muted">{timeAgo(new Date(item.publishedAt).getTime())}</span>
      </div>
      <div style={{ padding: '0.5rem 0' }}>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--blue)', textDecoration: 'none', fontWeight: 500,
            fontSize: 'inherit', textAlign: 'left',
          }}
        >
          {item.title}
        </button>
        <div>
          <button
            type="button"
            className="research-toggle"
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide report' : 'Read report'}
          </button>
        </div>
        {expanded && (
          <div
            className="research-body"
            dangerouslySetInnerHTML={{ __html: renderResearchMarkdown(item.bodyMarkdown ?? '') }}
          />
        )}
      </div>
    </div>
  );
}

function Dashboard({ token, onLogout, onGoHome, onActivity, theme, onToggleTheme }: { token: string; onLogout: () => void; onGoHome: () => void; onActivity?: () => void; theme: Theme; onToggleTheme: () => void }) {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions' | 'options' | 'news' | 'calendar'>('watchlist');
  const [news, setNews] = useState<NewsItem[]>([]);
  const [tradingToggling, setTradingToggling] = useState(false);
  const [profileModal, setProfileModal] = useState<null | 'settings' | 'change-password' | 'user-management'>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [accountMode, setAccountMode] = useState<'demo' | 'live'>('demo');
  // TRA-244 — drives the Calendar tab's per-account bucket. The stocks
  // calendar shows demo, live (Tradier production), or sandbox history based
  // on the active account so flipping `liveTradierEnvOptions` swaps the rows.
  const [tradierEnv, setTradierEnv] = useState<'sandbox' | 'production'>('sandbox');
  const [optionsDailyLimit, setOptionsDailyLimit] = useState<number>(DEFAULT_ACCOUNT_SETTINGS.optionsDailyTradesLimit);
  const [watchlistInput, setWatchlistInput] = useState('');
  const [watchlistError, setWatchlistError] = useState('');
  const [scanning, setScanning] = useState(false);
  const [scanStatus, setScanStatus] = useState('');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const scanStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(`${SERVER_URL}?token=${token}`);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 1008) {
          onLogout();
          return;
        }
        reconnectTimer.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'state') setState(msg.payload as AppState);
          // EOD report payloads are now consumed by the Calendar tab via the
          // `/api/reports/:date` REST endpoint, not pushed into the dashboard.
          onActivity?.();
        } catch { /* ignore malformed */ }
      };
    }

    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, [token, onLogout]);

  // Fallback REST polling when WS isn't connected
  useEffect(() => {
    if (connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/state`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.status === 401) { onLogout(); return; }
        if (r.ok) setState(await r.json() as AppState);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(id);
  }, [connected, token, onLogout]);

  useEffect(() => {
    async function loadNews() {
      try {
        const r = await fetch(`${HTTP_URL}/api/news`, {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (r.ok) setNews(await r.json() as NewsItem[]);
      } catch { /* ignore */ }
    }
    loadNews();
    const id = setInterval(loadNews, 5 * 60_000);
    return () => clearInterval(id);
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/admin/users`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => { if (r.ok) setIsAdmin(true); })
      .catch(() => {});
  }, [token]);

  useEffect(() => {
    fetch(`${HTTP_URL}/api/account/settings`, { headers: { Authorization: `Bearer ${token}` } })
      .then(r => r.ok ? r.json() : null)
      .then((s: { mode?: 'demo' | 'live'; optionsDailyTradesLimit?: number; liveTradierEnvOptions?: 'sandbox' | 'production' } | null) => {
        if (s?.mode) setAccountMode(s.mode);
        if (typeof s?.optionsDailyTradesLimit === 'number') setOptionsDailyLimit(s.optionsDailyTradesLimit);
        // TRA-244 — keep the Calendar tab in sync with whichever Tradier
        // environment is selected on the Settings page; sandbox is the
        // default if nothing was saved (matches the server-side fallback).
        if (s?.liveTradierEnvOptions === 'sandbox' || s?.liveTradierEnvOptions === 'production') {
          setTradierEnv(s.liveTradierEnvOptions);
        }
      })
      .catch(() => {});
  }, [tab, token]);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  // TRA-238 — closed trades stay visible in the Positions/Options tabs until
  // the 9:00 PM ET archive sweep clears them server-side; per-day history then
  // lives under the Calendar tab.
  const closedPositions = state?.closedPositions ?? [];
  const optionsState = state?.options;
  const openOptions: OptionPosition[] = optionsState?.openOptions ?? [];
  const closedOptions: OptionPosition[] = optionsState?.closedOptions ?? [];
  const autoTradingEnabled = state?.autoTradingEnabled ?? true;
  // TRA-326 — Stocks dashboard scoping per account/env:
  //   • Demo                              → Positions + Options
  //   • Live + Tradier sandbox            → Positions + Options
  //   • Live + Tradier production (margin)→ Options only (no equity positions
  //     panel — production is an options-only margin account).
  const showPositionsTab = !(accountMode === 'live' && tradierEnv === 'production');

  // If the user is on the Positions tab and flips to Live+Production (where
  // Positions is hidden), bounce them to Options so the content area doesn't
  // go blank.
  useEffect(() => {
    if (!showPositionsTab && tab === 'positions') setTab('options');
  }, [showPositionsTab, tab]);

  async function toggleAutoTrading() {
    setTradingToggling(true);
    try {
      await fetch(`${HTTP_URL}/api/trading/${autoTradingEnabled ? 'stop' : 'start'}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
    } catch { /* ignore */ } finally {
      setTradingToggling(false);
    }
  }

  async function closePosition(positionId: string) {
    await fetch(`${HTTP_URL}/api/positions/${positionId}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  async function closeOption(optionId: string) {
    await fetch(`${HTTP_URL}/api/options/${optionId}/close`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  async function addToStocksWatchlist() {
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
    await fetch(`${HTTP_URL}/api/watchlist/stocks`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol: sym }),
    }).catch(() => {});
  }

  async function removeFromStocksWatchlist(symbol: string) {
    await fetch(`${HTTP_URL}/api/watchlist/stocks/${encodeURIComponent(symbol)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  async function scanStocksMarket() {
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
      }
    } catch { /* ignore */ } finally {
      setScanning(false);
    }
  }

  async function resetSignals() {
    await fetch(`${HTTP_URL}/api/signals/reset`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }).catch(() => {});
  }

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="back-btn" onClick={onGoHome} title="Back to dashboard selector">&#8592; Home</button>
          <h1>TradingAI <span className="mode-badge stocks">Stocks</span></h1>
          <AccountModeSwitcher mode={accountMode} onChange={setAccountMode} market="stocks" token={token} />
        </div>
        <div className="header-right">
          {account && (
            <>
              <div className="stat-group">
                <div className="stat">
                  <span className="stat-label">Equity</span>
                  <span className="stat-value">${fmt(account.totalEquity)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Daily P&amp;L</span>
                  <span className={`stat-value ${account.dailyPnl >= 0 ? 'green' : 'red'}`}>
                    {fmtDollar(account.dailyPnl)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Cash</span>
                  <span className="stat-value">${fmt(account.availableCash)}</span>
                </div>
                <div className="stat">
                  <span className="stat-label">Positions</span>
                  <span className="stat-value">{openPositions.length}</span>
                </div>
              </div>
              {optionsState && (
                <>
                  <div className="stat-divider" />
                  <div className="stat-group">
                    <div className="stat">
                      <span className="stat-label">Opts P&amp;L</span>
                      <span className={`stat-value ${optionsState.optionsPnl >= 0 ? 'green' : 'red'}`}>
                        {fmtDollar(optionsState.optionsPnl)}
                      </span>
                    </div>
                    <div className="stat">
                      <span className="stat-label">Options</span>
                      <span className="stat-value">{openOptions.length}</span>
                    </div>
                    <div className="stat">
                      <span className="stat-label">Daily Trades</span>
                      <span className={`stat-value ${optionsState.dailyOptionsCount >= optionsDailyLimit ? 'red' : ''}`}>
                        {optionsState.dailyOptionsCount}/{optionsDailyLimit}
                      </span>
                    </div>
                  </div>
                </>
              )}
            </>
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
            <SettingsPage token={token} httpUrl={HTTP_URL} context="stocks" onModeChange={setAccountMode} />
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

      <nav className="tabs">
        {/* TRA-326 — drop the Positions tab in Live+Production (margin / options-only). */}
        {((['watchlist', 'signals', 'positions', 'options'] as const).filter(t => t !== 'positions' || showPositionsTab)).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'watchlist' ? `Watchlist (${symbols.length})` :
             t === 'signals' ? `Signals (${signals.length})` :
             t === 'positions' ? `Positions (${openPositions.length})` :
             `Options (${openOptions.length})`}
          </button>
        ))}
        <button className={`tab ${tab === 'news' ? 'active' : ''}`} onClick={() => setTab('news')}>
          {`News (${news.length})`}
        </button>
        <button className={`tab ${tab === 'calendar' ? 'active' : ''}`} onClick={() => setTab('calendar')}>
          Calendar
        </button>
      </nav>

      <main className="content">
        {!state && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to trading engine…</p>
          </div>
        )}

        {state && tab === 'watchlist' && (
          <div className="watchlist">
            <div className="watchlist-toolbar">
              <input
                className="watchlist-add-input"
                placeholder="Add symbol (e.g. NVDA)"
                value={watchlistInput}
                onChange={e => { setWatchlistInput(e.target.value); setWatchlistError(''); }}
                onKeyDown={e => e.key === 'Enter' && addToStocksWatchlist()}
              />
              <button className="btn-secondary btn-sm" onClick={addToStocksWatchlist} disabled={!watchlistInput.trim()}>Add</button>
              <button className="btn-secondary btn-sm" onClick={scanStocksMarket} disabled={scanning}>
                {scanning ? 'Scanning…' : '⚡ Scan Market'}
              </button>
            </div>
            {watchlistError && <div className="watchlist-error">{watchlistError}</div>}
            {scanStatus && <div className="watchlist-scan-status">{scanStatus}</div>}
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th>Change</th>
                  <th>Change %</th>
                  <th>Volume</th>
                  <th>Updated</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {symbols
                  .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
                  .map(s => (
                  <tr key={s.symbol} className={s.lastUpdated === 0 ? '' : s.change >= 0 ? 'up' : 'down'}>
                    <td className="symbol">{s.symbol}</td>
                    <td className="price">{s.lastUpdated === 0 ? '—' : `$${fmt(s.price)}`}</td>
                    <td className={s.lastUpdated === 0 ? 'muted' : s.change >= 0 ? 'green' : 'red'}>{s.lastUpdated === 0 ? '—' : fmtDollar(s.change)}</td>
                    <td className={s.lastUpdated === 0 ? 'muted' : s.changePct >= 0 ? 'green' : 'red'}>{s.lastUpdated === 0 ? '—' : fmtPct(s.changePct)}</td>
                    <td>{s.lastUpdated === 0 ? '—' : (s.volume / 1_000_000).toFixed(1) + 'M'}</td>
                    <td className="muted">{quoteStatusLabel(s)}</td>
                    <td><button className="watchlist-remove-btn" onClick={() => removeFromStocksWatchlist(s.symbol)} title="Remove">&#xd7;</button></td>
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
                      <span className="signal-time">{formatTime(sig.timestamp)}</span>
                    </div>
                    <div className="signal-body">
                      <div className="sig-stat">
                        <span>Entry</span>
                        <strong>${fmt(sig.entryPrice)}</strong>
                      </div>
                      <div className="sig-stat">
                        <span>Stop</span>
                        <strong className="red">${fmt(sig.stopLoss)}</strong>
                      </div>
                      <div className="sig-stat">
                        <span>Target</span>
                        <strong className="green">${fmt(sig.takeProfit)}</strong>
                      </div>
                      <div className="sig-stat">
                        <span>R:R</span>
                        <strong>1:{sig.riskRewardRatio}</strong>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state && tab === 'positions' && showPositionsTab && (
          <div className="positions-panel">
            {openPositions.length > 0 && (
              <>
                <h3>Open Positions</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>Cost</th>
                      <th>Current</th>
                      <th>P&amp;L %</th>
                      <th>P&amp;L $</th>
                      <th>Stop</th>
                      <th>Target</th>
                      <th>Opened</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map(p => {
                      const sym = symbols.find(s => s.symbol === p.symbol);
                      const currentPrice = sym?.price ?? p.entryPrice;
                      const multiplier = p.side === 'buy' ? 1 : -1;
                      const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100 * multiplier;
                      const pnlDollar = (currentPrice - p.entryPrice) * p.quantity * multiplier;
                      const totalCost = p.entryPrice * p.quantity;
                      return (
                        <tr key={p.id}>
                          <td className="symbol">{p.symbol}</td>
                          <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                          <td>{p.quantity}</td>
                          <td>{fmtPrice(p.entryPrice)}</td>
                          <td>{fmtPrice(totalCost)}</td>
                          <td>{fmtPrice(currentPrice)}</td>
                          <td className={pnlPct >= 0 ? 'green' : 'red'}>{fmtPct(pnlPct)}</td>
                          <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
                          <td className="red">{fmtPrice(p.stopLoss)}</td>
                          <td className="green">{fmtPrice(p.takeProfit)}</td>
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
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>P&amp;L %</th>
                      <th>P&amp;L $</th>
                      <th>Reason</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...closedPositions].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).map(p => {
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
        )}

        {state && tab === 'options' && (
          <div className="positions-panel">
            {openOptions.length > 0 && (
              <>
                <h3>Open Option Positions</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th>Contracts</th>
                      <th>Premium Paid</th>
                      <th>Current Mark</th>
                      <th>P&amp;L $</th>
                      <th>Status</th>
                      <th>Trail / SL</th>
                      <th>Signal</th>
                      <th>Opened</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {openOptions.map(o => {
                      const pnlPct = ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100;
                      const unrealized = (o.currentPremium - o.premiumPaid) * o.contractsRemaining * 100;
                      const pnlDollar = unrealized + (o.pnl ?? 0);
                      return (
                        <tr key={o.id}>
                          <td className="symbol">{o.symbol}</td>
                          <td className={o.optionType === 'call' ? 'green' : 'red'}>
                            {o.optionType.toUpperCase()}
                          </td>
                          <td>{o.contracts}</td>
                          <td>${fmt(o.premiumPaid)}</td>
                          <td className={pnlPct >= 0 ? 'green' : 'red'}>
                            ${fmt(o.currentPremium)} ({fmtPct(pnlPct)})
                          </td>
                          <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
                          <td className={o.trailingActive ? 'green' : 'muted'}>
                            {o.trailingActive ? 'TRAILING' : 'OPEN'}
                          </td>
                          <td className="red">
                            {o.trailingActive
                              ? `$${fmt(o.trailingStopPremium)} (trail)`
                              : `$${fmt(o.stopLossPremium)} (SL)`}
                          </td>
                          <td>{signalLabel(o.signalType)}</td>
                          <td className="muted">{formatTime(o.openedAt)}</td>
                          <td><button className="btn-close-pos" onClick={() => closeOption(o.id)}>Close</button></td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}

            {closedOptions.length > 0 && (
              <>
                <h3 style={{ marginTop: openOptions.length > 0 ? '1.5rem' : 0 }}>
                  Closed Today ({closedOptions.length})
                </h3>
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th>Contracts</th>
                      <th>Premium Paid</th>
                      <th>Exit Premium</th>
                      <th>P&amp;L $</th>
                      <th>Signal</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {[...closedOptions].sort((a, b) => (b.closedAt ?? 0) - (a.closedAt ?? 0)).map(o => {
                      const pnlDollar = o.pnl ?? 0;
                      return (
                        <tr key={o.id}>
                          <td className="symbol">{o.symbol}</td>
                          <td className={o.optionType === 'call' ? 'green' : 'red'}>
                            {o.optionType.toUpperCase()}
                          </td>
                          <td>{o.contracts}</td>
                          <td>${fmt(o.premiumPaid)}</td>
                          <td>${fmt(o.currentPremium)}</td>
                          <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
                          <td>{signalLabel(o.signalType)}</td>
                          <td className="muted">{o.closedAt ? formatTime(o.closedAt) : '—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </>
            )}

            {openOptions.length === 0 && closedOptions.length === 0 && (
              <div className="empty">
                No open option positions. Stock options are opened by the <strong>Relative Value</strong> scanner — it pulls each ticker's full chain, fits the IV skew across nearby strikes, and buys long premium on contracts that are statistically cheap vs. the local curve / monotonic price / no-arb checks.
                <br /><br />
                <strong>Strategy:</strong> long premium only · cheap call → buy CALL · cheap put → buy PUT · no naked short legs<br />
                <strong>Take profit:</strong> +40% partial exit (50%) → trailing stop activates at +25%, trails 15% below peak · <strong>Stop loss:</strong> −25% · <strong>Cap:</strong> {optionsDailyLimit} option trades/day per env
                <br /><br />
                <span className="muted">Closed contracts stay listed here until the 9:00 PM ET archive — full per-day history is under the <strong>Calendar</strong> tab.</span>
              </div>
            )}

            {optionsState && (
              <div style={{ marginTop: '1.5rem', display: 'flex', gap: '2rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                <span>Options Cash: <strong>${fmt(optionsState.optionsCash)}</strong></span>
                <span>Total Options P&amp;L: <strong className={optionsState.optionsPnl >= 0 ? 'green' : 'red'}>{fmtDollar(optionsState.optionsPnl)}</strong></span>
                <span>Daily Trades: <strong className={optionsState.dailyOptionsCount >= optionsDailyLimit ? 'red' : ''}>{optionsState.dailyOptionsCount}/{optionsDailyLimit}</strong></span>
              </div>
            )}
          </div>
        )}

        {tab === 'news' && (
          <div className="signals-panel">
            {news.length === 0 ? (
              <div className="empty">Loading market news…</div>
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
            mode={
              accountMode === 'demo'
                ? 'demo'
                : tradierEnv === 'production' ? 'live' : 'sandbox'
            }
          />
        )}
      </main>
    </div>
  );
}

const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const IDLE_WARN_MS = 2 * 60 * 1000;

type AuthScreen = 'login' | 'forgot' | 'signup';

export default function App() {
  const { theme, toggleTheme } = useTheme();

  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'));
  const [tokenChecked, setTokenChecked] = useState<boolean>(() => !localStorage.getItem('auth_token'));
  const [authScreen, setAuthScreen] = useState<AuthScreen>(() =>
    new URLSearchParams(window.location.search).has('reset_code') ? 'forgot' : 'login'
  );
  const [appMode, setAppMode] = useState<null | 'stocks' | 'crypto'>(() => {
    const stored = localStorage.getItem('tradingMode');
    return stored === 'stocks' || stored === 'crypto' ? stored : null;
  });
  const [idleWarning, setIdleWarning] = useState(false);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const warnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const resetIdleTimerRef = useRef<() => void>(() => {});

  function handleLogout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('tradingMode');
    setToken(null);
    setTokenChecked(true);
    setAuthScreen('login');
    setAppMode(null);
    setIdleWarning(false);
  }

  useEffect(() => {
    const stored = localStorage.getItem('auth_token');
    if (!stored) return;
    let cancelled = false;
    fetch(`${HTTP_URL}/api/auth/me`, {
      headers: { Authorization: `Bearer ${stored}` },
    }).then(r => {
      if (cancelled) return;
      if (r.status === 401) {
        handleLogout();
      } else {
        setTokenChecked(true);
      }
    }).catch(() => {
      if (!cancelled) setTokenChecked(true);
    });
    return () => { cancelled = true; };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function resetIdleTimer() {
    if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
    if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    setIdleWarning(false);
    warnTimerRef.current = setTimeout(() => setIdleWarning(true), IDLE_TIMEOUT_MS - IDLE_WARN_MS);
    idleTimerRef.current = setTimeout(handleLogout, IDLE_TIMEOUT_MS);
  }
  resetIdleTimerRef.current = resetIdleTimer;

  useEffect(() => {
    if (!token) return;
    const handler = () => resetIdleTimerRef.current();
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll'] as const;
    events.forEach(ev => document.addEventListener(ev, handler, { passive: true }));
    resetIdleTimerRef.current();
    return () => {
      events.forEach(ev => document.removeEventListener(ev, handler));
      if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
      if (warnTimerRef.current) clearTimeout(warnTimerRef.current);
    };
  }, [token]);

  function selectMode(mode: 'stocks' | 'crypto') {
    localStorage.setItem('tradingMode', mode);
    setAppMode(mode);
  }

  function goHome() {
    localStorage.removeItem('tradingMode');
    setAppMode(null);
  }

  // Floating toggle visible on auth/selector screens that don't have a header bar
  const floatingToggle = (
    <div className="theme-toggle-floating">
      <ThemeToggle theme={theme} onToggle={toggleTheme} />
    </div>
  );

  if (!token) {
    if (authScreen === 'forgot') {
      return (
        <>
          {floatingToggle}
          <ForgotPasswordPage onBack={() => setAuthScreen('login')} />
        </>
      );
    }
    if (authScreen === 'signup') {
      return (
        <>
          {floatingToggle}
          <SignUpPage onSignUp={(t) => { setTokenChecked(true); setToken(t); }} onBack={() => setAuthScreen('login')} />
        </>
      );
    }
    return (
      <>
        {floatingToggle}
        <LoginPage onLogin={(t) => { setTokenChecked(true); setToken(t); }} onForgotPassword={() => setAuthScreen('forgot')} onSignUp={() => setAuthScreen('signup')} />
      </>
    );
  }

  if (!tokenChecked) return null;

  const mainContent = appMode === null
    ? <DashboardSelector onSelect={selectMode} onLogout={handleLogout} theme={theme} onToggleTheme={toggleTheme} />
    : appMode === 'crypto'
      ? <CryptoDashboard token={token} onBack={goHome} onLogout={handleLogout} onActivity={() => resetIdleTimerRef.current()} theme={theme} onToggleTheme={toggleTheme} />
      : <Dashboard token={token} onLogout={handleLogout} onGoHome={goHome} onActivity={() => resetIdleTimerRef.current()} theme={theme} onToggleTheme={toggleTheme} />;

  return (
    <>
      {mainContent}
      {idleWarning && (
        <div className="idle-warning-banner">
          <span>You've been idle — you'll be signed out automatically in 2 minutes.</span>
          <button className="idle-warning-btn" onClick={() => resetIdleTimerRef.current()}>Stay signed in</button>
        </div>
      )}
    </>
  );
}
