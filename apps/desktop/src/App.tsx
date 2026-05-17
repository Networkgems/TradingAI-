import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { TradeSignal, Position, AccountState, OptionPosition, OptionsAccountState, CryptoEngineState, LiveSkip, NewsItem, AccountSettings, OptionType, EngineMarketReviewState } from '@trading-app/shared';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

// TRA-327 — surface the options-daily cap that matches the active mode.
// Live and Demo each store an independent limit; the Live field falls back
// to the legacy un-suffixed demo field for settings saved before TRA-327.
function pickOptionsDailyLimit(s: Partial<AccountSettings> | null | undefined): number | undefined {
  if (!s) return undefined;
  if (s.mode === 'live') {
    return typeof s.optionsDailyTradesLimitLive === 'number'
      ? s.optionsDailyTradesLimitLive
      : s.optionsDailyTradesLimit;
  }
  return s.optionsDailyTradesLimit;
}
import LoginPage from './LoginPage.tsx';
import ForgotPasswordPage from './ForgotPasswordPage.tsx';
import SignUpPage from './SignUpPage.tsx';
import SettingsPage, { ChangePasswordSection, UserManagementSection } from './SettingsPage.tsx';
import { CalendarTab } from './CalendarTab.tsx';
import { ErrorBoundary } from './ErrorBoundary.tsx';
import { SERVER_URL, HTTP_URL } from './server-url';
import { logger } from './lib/logger';
import { useFocusTrap } from './lib/useFocusTrap';
import { useToast } from './lib/toast.tsx';
import { createReconnectController } from './lib/backoff';
import { validateLimitPrice, validateCloseQty } from './lib/validation';
import './index.css';

// TRA-339 — generic per-table sort. Each dashboard table picks a column
// type (a string-literal union of its sortable keys), wires its header
// cells through SortableTH, and resolves sort values via getSortValue
// keyed by that union. Default direction is desc so monetary/quantity
// columns lead with the largest first; clicking the active key toggles.
type SortDir = 'asc' | 'desc';
type SortState<K extends string> = { key: K; dir: SortDir };

function useTableSort<K extends string>(defaultKey: K, defaultDir: SortDir = 'desc') {
  const [state, setState] = useState<SortState<K>>({ key: defaultKey, dir: defaultDir });
  const onSort = useCallback((next: K) => {
    setState(prev => prev.key === next
      ? { key: next, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key: next, dir: 'desc' });
  }, []);
  return { sort: state, onSort };
}

function compareSortValues(a: unknown, b: unknown, dir: SortDir): number {
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

function sortRows<T, K extends string>(
  rows: readonly T[],
  state: SortState<K>,
  getValue: (row: T, key: K) => unknown,
): T[] {
  return [...rows].sort((a, b) => compareSortValues(getValue(a, state.key), getValue(b, state.key), state.dir));
}

function SortableTH<K extends string>({ label, sortKey, sort, onSort }: {
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

type Theme = 'light' | 'dark';
const THEME_STORAGE_KEY = 'tradingai_theme';

function readInitialTheme(): Theme {
  try {
    const stored = localStorage.getItem(THEME_STORAGE_KEY);
    if (stored === 'dark' || stored === 'light') return stored;
  } catch (err) { logger.warn('theme', 'could not read stored theme preference', err); }
  return 'light';
}

function useTheme(): { theme: Theme; toggleTheme: () => void } {
  const [theme, setTheme] = useState<Theme>(() => readInitialTheme());

  useEffect(() => {
    const root = document.documentElement;
    root.classList.remove('theme-light', 'theme-dark');
    root.classList.add(theme === 'dark' ? 'theme-dark' : 'theme-light');
    try { localStorage.setItem(THEME_STORAGE_KEY, theme); } catch (err) { logger.warn('theme', 'could not persist theme preference', err); }
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
  const toast = useToast();

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
      if (r.ok) {
        onChange(next);
        toast.success(`Switched to ${next === 'live' ? 'Live' : 'Demo'} account`);
      } else {
        logger.warn('account-mode', `mode switch returned HTTP ${r.status}`);
        toast.error(`Could not switch to ${next} account (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('account-mode', `failed to switch to ${next} account`, err);
      toast.error(`Could not switch to ${next} account — network error`);
    } finally {
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

interface SymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
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
  // TRA-389 — market-review regime context. `enabled` is false when the
  // gate-consumption flag is off (or no review exists yet); optional so a
  // server running a pre-TRA-389 build still type-checks against this state.
  marketReview?: EngineMarketReviewState;
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

// TRA-372 — compact signed-integer percent for the signal-card Target/Stop
// chips: "+50%" / "−25%" (proper U+2212 minus). Returns '—' on sentinel input.
function fmtSignedIntPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  const rounded = Math.round(n);
  if (rounded === 0) return '0%';
  return rounded > 0 ? `+${rounded}%` : `−${Math.abs(rounded)}%`;
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

// TRA-372 — parse a YYYY-MM-DD option-expiration string as a local-date
// (avoids the UTC interpretation new Date('2026-05-29') would give and the
// off-by-one display on Pacific timezones).
function parseExpirationDate(iso: string | undefined | null): Date | null {
  if (!iso) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

// TRA-372 — "May 29, 2026" for the signal card. Returns '' if unparseable so
// the caller can short-circuit rendering.
function formatExpirationFull(iso: string | undefined | null): string {
  const d = parseExpirationDate(iso);
  if (!d) return '';
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// TRA-372 — compact "May 29" (or "May 29, 2027" off-year) for the table cell.
function formatExpirationShort(iso: string | undefined | null): string {
  const d = parseExpirationDate(iso);
  if (!d) return '';
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString('en-US', sameYear
    ? { month: 'short', day: 'numeric' }
    : { month: 'short', day: 'numeric', year: 'numeric' });
}

// TRA-372 — integer days from a reference timestamp to a yyyy-mm-dd expiration.
// Floors to the calendar-day boundary so "fires at 3pm, expires same day" reads
// as 0d, not −0d.
function daysToExpiration(iso: string | undefined | null, fromTs: number): number | null {
  const exp = parseExpirationDate(iso);
  if (!exp) return null;
  const from = new Date(fromTs);
  const fromDay = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const ms = exp.getTime() - fromDay.getTime();
  return Math.round(ms / 86_400_000);
}

// TRA-372 — contract detail row rendered under the entry/stop/target/RR block
// on option signals (currently relative_value; future option SignalTypes fall
// through the same render path as long as `strike`/`expiration` are present).
// Returns null for non-option signals so the crypto signal feed renders byte
// identical to before.
function SignalOptionRow({ sig }: { sig: TradeSignal }) {
  const opt = sig as TradeSignal & { optionType?: OptionType; strike?: number; expiration?: string };
  if (sig.type !== 'relative_value') return null;
  if (opt.strike == null || !opt.expiration) return null;
  const expFull = formatExpirationFull(opt.expiration);
  if (!expFull) return null;
  const dte = daysToExpiration(opt.expiration, sig.timestamp);
  const optType = opt.optionType ?? 'call';
  return (
    <div className="signal-option-row">
      <span className={`option-badge ${optType}`}>{optType.toUpperCase()}</span>
      <span className="option-strike">Strike ${Math.round(opt.strike)}</span>
      <span className="option-exp">
        Exp {expFull}
        {dte != null && <span className="option-dte"> ({dte}d)</span>}
      </span>
    </div>
  );
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
    case 'tradier_import': return 'Tradier Import';
    default: return type;
  }
}

// TRA-333 — render the Signal column for an equity/crypto position. Positions
// opened from a TradeSignal carry `signalId` (stamped by the open paths in
// paper-account / crypto-account / crypto-live-account); imported wallet
// holdings (TRA-318) reach the dashboard with no signalId and a synthetic
// `id` prefix of `imported-spot-` — surface those as "Imported" so the user
// can tell signal-driven entries apart from balance-mirrored ones at a glance.
function positionSignalCell(p: Position) {
  if (!p.signalId) {
    if (p.id.startsWith('imported-spot-')) return <span className="muted">Imported</span>;
    return <span className="muted">—</span>;
  }
  return signalLabel(p.signalType);
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

/**
 * TRA-389 — market-review regime banner for the Stocks dashboard. Renders the
 * GREEN / YELLOW / RED regime classified by the TRA-386 review plus the list
 * of strategies the regime gates currently suppress. Returns null when the
 * gate-consumption flag is off (or no review has been generated yet) so the
 * banner only appears once an operator has opted into regime gating.
 */
function RegimeBanner({ review }: { review?: EngineMarketReviewState }) {
  if (!review || !review.enabled || !review.regime) return null;
  const dot = review.regime === 'green' ? '🟢' : review.regime === 'yellow' ? '🟡' : '🔴';
  const label = review.regime.toUpperCase();
  const bg = review.regime === 'green'
    ? 'rgba(34,197,94,0.12)'
    : review.regime === 'yellow'
      ? 'rgba(234,179,8,0.14)'
      : 'rgba(239,68,68,0.14)';
  const border = review.regime === 'green'
    ? 'rgba(34,197,94,0.5)'
    : review.regime === 'yellow'
      ? 'rgba(234,179,8,0.55)'
      : 'rgba(239,68,68,0.55)';
  return (
    <div
      className="regime-banner"
      style={{
        marginBottom: '0.75rem',
        padding: '0.6rem 0.85rem',
        background: bg,
        border: `1px solid ${border}`,
        borderRadius: '6px',
        fontSize: '0.85rem',
      }}
    >
      <div style={{ fontWeight: 600 }}>
        Regime: {dot} {label}
        {review.reviewDate ? <span className="muted"> · premarket {review.reviewDate}</span> : null}
      </div>
      {review.regimeRationale && (
        <div className="muted" style={{ marginTop: '0.2rem' }}>{review.regimeRationale}</div>
      )}
      {review.gatedStrategies.length > 0 && (
        <div style={{ marginTop: '0.35rem' }}>
          {review.gatedStrategies.map(g => (
            <div key={g.strategy} style={{ marginTop: '0.1rem' }}>
              <strong>{g.strategy}</strong> gated off — <span className="muted">{g.reason}</span>
            </div>
          ))}
        </div>
      )}
      {review.gates && review.gates.sizingMultiplier < 1 && (
        <div style={{ marginTop: '0.25rem' }}>
          Position sizing trimmed to{' '}
          <strong>{Math.round(review.gates.sizingMultiplier * 100)}%</strong> by the regime.
        </div>
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

// TRA-339 — Stock-dashboard sort keys mirror the Crypto set, minus the
// perp-only leverage / liquidation columns (Stocks have no perps), and
// add Open / Closed Options tables.
type StockOpenPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'cost' | 'current'
  | 'pnlPct' | 'pnlDollar' | 'stop' | 'target' | 'opened';
type StockClosedPosSortKey =
  | 'symbol' | 'side' | 'qty' | 'entry' | 'exit'
  | 'pnlPct' | 'pnlDollar' | 'reason' | 'closed';
type OptionOpenSortKey =
  | 'symbol' | 'type' | 'contracts' | 'premiumPaid'
  | 'currentMark' | 'pnlDollar' | 'status' | 'opened';
type OptionClosedSortKey =
  | 'symbol' | 'type' | 'contracts' | 'premiumPaid'
  | 'exitPremium' | 'pnlPct' | 'pnlDollar' | 'closed';

function getStockOpenPosSortValue(p: Position, key: StockOpenPosSortKey, symbols: readonly SymbolState[]): unknown {
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

function getStockClosedPosSortValue(p: Position, key: StockClosedPosSortKey): unknown {
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

function getOptionOpenSortValue(o: OptionPosition, key: OptionOpenSortKey): unknown {
  switch (key) {
    case 'symbol': return o.symbol;
    case 'type': return o.optionType;
    case 'contracts': return o.contracts;
    case 'premiumPaid': return o.premiumPaid;
    case 'currentMark': return o.currentPremium;
    case 'pnlDollar': {
      const unrealized = (o.currentPremium - o.premiumPaid) * o.contractsRemaining * 100;
      return unrealized + (o.pnl ?? 0);
    }
    case 'status': return o.trailingActive ? 'trailing' : 'open';
    case 'opened': return o.openedAt;
  }
}

function getOptionClosedSortValue(o: OptionPosition, key: OptionClosedSortKey): unknown {
  switch (key) {
    case 'symbol': return o.symbol;
    case 'type': return o.optionType;
    case 'contracts': return o.contracts;
    case 'premiumPaid': return o.premiumPaid;
    case 'exitPremium': return o.currentPremium;
    // TRA-367 — sort key for the new P&L % column. Computes from the stored
    // exit premium (`currentPremium`) vs entry, ignoring partial-exit P&L
    // already realised on `o.pnl` — that's how it's displayed in the cell.
    case 'pnlPct': {
      if (!(o.premiumPaid > 0)) return 0;
      return ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100;
    }
    case 'pnlDollar': return o.pnl ?? 0;
    case 'closed': return o.closedAt ?? 0;
  }
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
  // TRA-323 — Tradier-positions sync state. Drives the "Sync Tradier
  // positions" button label, disabled state, and the toast that confirms
  // how many rows changed on the last sync.
  const [tradierSyncing, setTradierSyncing] = useState(false);
  const [tradierSyncStatus, setTradierSyncStatus] = useState('');
  const tradierSyncStatusTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // TRA-358 — Tradier-style close drawer for engine-opened LIVE option
  // positions. Mirrors the price/qty/duration form Tradier shows on its
  // web close panel; submit posts a sell_to_close LIMIT and the row
  // transitions into a "Pending #N" state with a Cancel button until
  // Tradier fills (or rejects, surfacing exitErrorReason). Demo and
  // imported positions skip the drawer and use the legacy direct close.
  type CloseDrawerState = {
    optionId: string;
    symbol: string;
    optionSymbol?: string | undefined;
    optionType: 'call' | 'put';
    contractsRemaining: number;
    defaultPrice: number;
    price: string;
    qty: string;
    duration: 'day' | 'gtc' | 'pre' | 'post';
    submitting: boolean;
    error?: string | undefined;
  };
  const [closeDrawer, setCloseDrawer] = useState<CloseDrawerState | null>(null);
  // TRA-358 — Cancel button on a pending-exit row uses this to lock the
  // button while the cancel POST is in flight; per-row state keyed by
  // option id so multiple in-flight cancels don't fight for one boolean.
  const [cancellingExits, setCancellingExits] = useState<Record<string, boolean>>({});
  // TRA-407 (C4) — per-row lock while a close POST is in flight. Closes the
  // narrow double-click window before the server's `pendingCloseOrderId`
  // (which swaps the button for a "Pending #N" badge) round-trips back, so a
  // single contract can't get two `sell_to_close` orders working at once.
  const [closingOptions, setClosingOptions] = useState<Record<string, boolean>>({});
  // TRA-339 — per-table sort state for the Stocks dashboard.
  const watchlistSort = useTableSort<CryptoWatchSortKey>('changePct', 'desc');
  const openPosSort = useTableSort<StockOpenPosSortKey>('opened', 'desc');
  const closedPosSort = useTableSort<StockClosedPosSortKey>('closed', 'desc');
  const openOptSort = useTableSort<OptionOpenSortKey>('opened', 'desc');
  const closedOptSort = useTableSort<OptionClosedSortKey>('closed', 'desc');
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
        if (e.code === 1008) {
          onLogout();
          return;
        }
        reconnectTimer.current = setTimeout(connect, reconnect.nextDelay());
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'state') setState(msg.payload as AppState);
          // EOD report payloads are now consumed by the Calendar tab via the
          // `/api/reports/:date` REST endpoint, not pushed into the dashboard.
          onActivity?.();
        } catch (err) { logger.warn('stock-ws', 'dropped malformed WebSocket message', err); }
      };
    }

    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- onActivity is an event-style callback; adding it would tear down and reconnect the WebSocket on every parent render
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
      } catch (err) { logger.warn('stock-http', 'state poll failed; will retry', err); }
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
      } catch (err) { logger.warn('stock-http', 'news fetch failed; keeping previous items', err); }
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

  // TRA-327 — apply a fresh AccountSettings snapshot to the dashboard's
  // cached fields (account mode, daily-options badge, Tradier env). Used by
  // both the initial fetch below and the SettingsPage `onSettingsSaved`
  // callback so saves take effect without a hard page refresh.
  const applyAccountSettings = useCallback((s: Partial<AccountSettings> | null | undefined) => {
    if (!s) return;
    if (s.mode === 'demo' || s.mode === 'live') setAccountMode(s.mode);
    const limit = pickOptionsDailyLimit(s);
    if (typeof limit === 'number') setOptionsDailyLimit(limit);
    if (s.liveTradierEnvOptions === 'sandbox' || s.liveTradierEnvOptions === 'production') {
      setTradierEnv(s.liveTradierEnvOptions);
    }
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
    const next = autoTradingEnabled ? 'stop' : 'start';
    try {
      const r = await fetch(`${HTTP_URL}/api/trading/${next}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) {
        toast.success(next === 'start' ? 'Auto-trading started' : 'Auto-trading stopped');
      } else {
        logger.warn('stock-trading', `${next} returned HTTP ${r.status}`);
        toast.error(`Could not ${next} auto-trading (HTTP ${r.status})`);
      }
    } catch (err) {
      logger.error('stock-trading', `failed to ${next} auto-trading`, err);
      toast.error(`Could not ${next} auto-trading — network error`);
    } finally {
      setTradingToggling(false);
    }
  }

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

  // TRA-358 — direct close path used by the imported and demo branches
  // (no user-facing limit form: imported runs through the smart-walk on
  // the server, demo is paper-only). The engine-opened LIVE branch goes
  // through `submitCloseDrawer` instead because the user is choosing
  // price + qty + duration in a Tradier-style panel.
  async function closeOption(optionId: string, body?: Record<string, unknown>) {
    const r = await fetch(`${HTTP_URL}/api/options/${optionId}/close`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }).catch(() => null);
    // TRA-323 / TRA-348 / TRA-358 — surface broker-side rejection
    // (sell_to_close failed) so the row doesn't sit stuck. The 202 path
    // (Tradier accepted but the order didn't reach a terminal state in
    // the wait window) leaves the row visible with a Pending badge.
    if (!r) {
      logger.error('stock-close', 'network error closing option', { optionId });
      toast.error('Close failed — network error');
      return { ok: false as const, error: 'Network error' };
    }
    const data = await r.json().catch(() => ({} as { error?: string; status?: string; orderId?: number | string; fillPrice?: number }));
    if (r.status === 202 && data?.status === 'pending') {
      setTradierSyncStatus(`Tradier close pending #${data.orderId ?? '?'} — row will drop once Tradier fills`);
      if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
      tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), 8000);
      toast.info(`Tradier close pending #${data.orderId ?? '?'}`);
      return { ok: true as const, status: 'pending' as const, orderId: data?.orderId };
    }
    if (!r.ok) {
      const message = data?.error ?? `Close failed (${r.status})`;
      logger.warn('stock-close', 'option close rejected', { optionId, status: r.status, message });
      setTradierSyncStatus(`Close failed: ${message}`);
      if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
      tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), 6000);
      toast.error(`Close failed: ${message}`);
      return { ok: false as const, error: message };
    }
    toast.success('Option close submitted');
    return { ok: true as const, status: data?.status ?? 'filled', orderId: data?.orderId, fillPrice: data?.fillPrice };
  }

  // TRA-358 — open the limit-close drawer for a position. The drawer
  // mirrors Tradier's web close panel (price + qty + duration). Engine-
  // opened live positions submit through this path; everything else
  // (imported, engine-opened demo) skips the drawer and runs the direct
  // close which keeps the existing TRA-352 / TRA-348 behaviour.
  function openCloseDrawer(o: OptionPosition, isLiveEngineOpened: boolean) {
    if (!isLiveEngineOpened) {
      // TRA-407 (C4) — direct close path (imported / engine-opened demo).
      // Lock the row while the POST is in flight so a double-click can't
      // fire a second sell_to_close before the server's pendingCloseOrderId
      // round-trips back and swaps the button for a "Pending #N" badge.
      if (closingOptions[o.id]) return;
      setClosingOptions(prev => ({ ...prev, [o.id]: true }));
      void closeOption(o.id).finally(() => {
        setClosingOptions(prev => {
          const next = { ...prev };
          delete next[o.id];
          return next;
        });
      });
      return;
    }
    if (o.pendingExit) {
      // Already pending — let the user cancel from the row's badge.
      return;
    }
    const defaultPrice = Number.isFinite(o.currentPremium) && o.currentPremium > 0
      ? o.currentPremium
      : o.premiumPaid;
    setCloseDrawer({
      optionId: o.id,
      symbol: o.symbol,
      optionSymbol: o.optionSymbol,
      optionType: o.optionType,
      contractsRemaining: o.contractsRemaining,
      defaultPrice,
      price: defaultPrice.toFixed(2),
      qty: String(o.contractsRemaining),
      duration: 'day',
      submitting: false,
    });
  }

  function closeDrawerCancel() {
    setCloseDrawer(prev => (prev?.submitting ? prev : null));
  }

  // TRA-409 — keyboard accessibility for the close drawer: trap Tab focus
  // inside the dialog while it is open, close it on Esc, and restore focus to
  // the triggering control once it closes.
  const closeDrawerRef = useFocusTrap<HTMLDivElement>(closeDrawer != null, closeDrawerCancel);

  async function submitCloseDrawer() {
    if (!closeDrawer || closeDrawer.submitting) return;
    // TRA-419 — validation routed through src/lib/validation.ts so the
    // close-drawer rules are unit-tested and stay in sync with the server.
    const priceError = validateLimitPrice(closeDrawer.price);
    if (priceError) {
      setCloseDrawer(prev => prev ? { ...prev, error: priceError } : prev);
      return;
    }
    const qtyError = validateCloseQty(closeDrawer.qty, closeDrawer.contractsRemaining);
    if (qtyError) {
      setCloseDrawer(prev => prev ? { ...prev, error: qtyError } : prev);
      return;
    }
    const limitPrice = Number(closeDrawer.price);
    const qty = Number(closeDrawer.qty);
    setCloseDrawer(prev => prev ? { ...prev, submitting: true, error: undefined } : prev);
    const result = await closeOption(closeDrawer.optionId, {
      limitPrice,
      qty,
      duration: closeDrawer.duration,
    });
    if (result.ok) {
      setCloseDrawer(null);
    } else {
      setCloseDrawer(prev => prev ? {
        ...prev,
        submitting: false,
        error: result.error ?? 'Close failed.',
      } : prev);
    }
  }

  // TRA-358 — fire the matching Tradier cancel for an in-flight pending
  // exit. On success the server clears the position's pendingExit and
  // the next state broadcast re-renders the Close button on the row.
  async function cancelPendingExit(optionId: string) {
    setCancellingExits(prev => ({ ...prev, [optionId]: true }));
    try {
      const r = await fetch(`${HTTP_URL}/api/options/${optionId}/cancel-pending-exit`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      }).catch(() => null);
      if (!r) {
        logger.error('stock-close', 'network error cancelling pending exit', { optionId });
        setTradierSyncStatus('Cancel failed: network error');
        toast.error('Cancel failed — network error');
      } else if (!r.ok) {
        const data = await r.json().catch(() => ({} as { error?: string }));
        const message = data?.error ?? String(r.status);
        logger.warn('stock-close', 'cancel pending exit rejected', { optionId, message });
        setTradierSyncStatus(`Cancel failed: ${message}`);
        toast.error(`Cancel failed: ${message}`);
      } else {
        setTradierSyncStatus('Tradier cancel accepted');
        toast.success('Tradier cancel accepted');
      }
      if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
      tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), 6000);
    } finally {
      setCancellingExits(prev => {
        const next = { ...prev };
        delete next[optionId];
        return next;
      });
    }
  }

  // TRA-323 — pull open option positions from Tradier into TradeAI so the
  // user can close them from here. Defaults to whichever Tradier env is
  // currently selected (sandbox / production); the server-side handler
  // routes the import into the matching env bucket.
  async function syncTradierPositions() {
    setTradierSyncing(true);
    try {
      const r = await fetch(
        `${HTTP_URL}/api/tradier/positions/sync?env=${encodeURIComponent(tradierEnv)}`,
        { method: 'POST', headers: { Authorization: `Bearer ${token}` } },
      );
      const data = await r.json().catch(() => ({} as { error?: string; added?: number; updated?: number; removed?: number; total?: number }));
      if (!r.ok) {
        const message = data?.error ?? `Sync failed (${r.status})`;
        logger.warn('tradier-sync', 'positions sync rejected', { env: tradierEnv, message });
        setTradierSyncStatus(message);
        toast.error(`Tradier sync failed: ${message}`);
      } else {
        const added = data.added ?? 0;
        const updated = data.updated ?? 0;
        const removed = data.removed ?? 0;
        const total = data.total ?? 0;
        if (total === 0) {
          setTradierSyncStatus(`Tradier ${tradierEnv}: no open positions`);
          toast.info(`Tradier ${tradierEnv}: no open positions`);
        } else {
          const summary = `Synced ${total} Tradier ${tradierEnv} position(s): +${added} new, ~${updated} updated, −${removed} closed`;
          setTradierSyncStatus(summary);
          toast.success(summary);
        }
      }
    } catch (err) {
      logger.error('tradier-sync', 'positions sync failed', err);
      setTradierSyncStatus(`Sync error: ${err instanceof Error ? err.message : String(err)}`);
      toast.error('Tradier sync failed — network error');
    } finally {
      setTradierSyncing(false);
      if (tradierSyncStatusTimer.current) clearTimeout(tradierSyncStatusTimer.current);
      tradierSyncStatusTimer.current = setTimeout(() => setTradierSyncStatus(''), 6000);
    }
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

  async function removeFromStocksWatchlist(symbol: string) {
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

  async function resetSignals() {
    try {
      const r = await fetch(`${HTTP_URL}/api/signals/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success('Signals cleared');
      else toast.error(`Could not reset signals (HTTP ${r.status})`);
    } catch (err) {
      logger.error('stock-signals', 'reset signals failed', err);
      toast.error('Could not reset signals — network error');
    }
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
            <SettingsPage token={token} httpUrl={HTTP_URL} context="stocks" onModeChange={setAccountMode} onSettingsSaved={applyAccountSettings} onLogout={onLogout} />
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
       {/* TRA-398 — per-tab error boundary. `key={tab}` remounts it on tab
           switch so a render crash in one tab cannot white-screen the app. */}
       <ErrorBoundary key={tab} label={`stocks:${tab}`} variant="panel">
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
                    <td><button className="watchlist-remove-btn" onClick={() => removeFromStocksWatchlist(s.symbol)} title="Remove">&#xd7;</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {state && tab === 'signals' && (
          <div className="signals-panel">
            {/* TRA-389 — regime banner: shown once the operator opts into
                market-review gating, explains why a strategy is gated off. */}
            <RegimeBanner review={state.marketReview} />
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
                      <div className="sig-stat">
                        <span>R:R</span>
                        <strong>1:{sig.riskRewardRatio}</strong>
                      </div>
                    </div>
                    <SignalOptionRow sig={sig} />
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
                      // TRA-344 — see notes on the other Open Positions table above.
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
        )}

        {state && tab === 'options' && (
          <div className="positions-panel">
            {/* TRA-323 — let the user pull open option positions from Tradier
                into TradeAI so they can be closed from here. The button targets
                the Tradier env currently selected in Settings (sandbox or
                production); the toast that follows reports the count summary. */}
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', marginBottom: '0.75rem', flexWrap: 'wrap' }}>
              <button
                className="btn-secondary"
                onClick={syncTradierPositions}
                disabled={tradierSyncing}
                title={`Pull open option positions from Tradier ${tradierEnv} into TradeAI`}
              >
                {tradierSyncing ? 'Syncing…' : `Sync Tradier ${tradierEnv} positions`}
              </button>
              {tradierSyncStatus && (
                <span className="muted" style={{ fontSize: '0.85rem' }}>{tradierSyncStatus}</span>
              )}
            </div>
            {openOptions.length > 0 && (
              <>
                <h3>Open Option Positions</h3>
                <table>
                  <thead>
                    <tr>
                      <SortableTH label="Symbol" sortKey="symbol" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <SortableTH label="Type" sortKey="type" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      {/* TRA-372 — surface contract detail directly on the table so the user can confirm which contract is open on the broker without drilling into the position. */}
                      <th>Strike</th>
                      <th>Expiration</th>
                      <SortableTH label="Contracts" sortKey="contracts" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <SortableTH label="Premium Paid" sortKey="premiumPaid" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <SortableTH label="Current Mark" sortKey="currentMark" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <SortableTH label={<>P&amp;L $</>} sortKey="pnlDollar" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <SortableTH label="Status" sortKey="status" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <th>Trail / SL</th>
                      <th>Signal</th>
                      <SortableTH label="Opened" sortKey="opened" sort={openOptSort.sort} onSort={openOptSort.onSort} />
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(openOptions, openOptSort.sort, getOptionOpenSortValue).map(o => {
                      // TRA-367 — imports flow through the same auto-managed
                      // pipeline as engine-opened rows since TRA-361 (live
                      // marks via `refreshImportedMarks`, SL/TP1/trail
                      // installed in `reconcileTradierPositions`). The old
                      // "—" / "TRADIER" short-circuit hid information the
                      // user needs to manage the position; render Current
                      // Mark / P&L / Status / Trail-SL the same way for
                      // both origins. The `(Tradier)` badge next to the
                      // symbol still flags origin so the user knows
                      // closing routes a real `sell_to_close`.
                      const isImported = !!o.importedFromTradier;
                      const hasMark = Number.isFinite(o.currentPremium) && o.currentPremium > 0 && o.premiumPaid > 0;
                      const pnlPct = hasMark ? ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100 : 0;
                      const unrealized = hasMark ? (o.currentPremium - o.premiumPaid) * o.contractsRemaining * 100 : 0;
                      const pnlDollar = unrealized + (o.pnl ?? 0);
                      // Auto-managed imports get RV-default thresholds; legacy
                      // imports with auto-management off keep sentinels
                      // (`tp1 = +Inf`, `SL/trail = 0`) and we render "—" so the
                      // user sees the row isn't auto-managed.
                      const hasStopSchedule = o.stopLossPremium > 0 && Number.isFinite(o.tp1Premium);
                      return (
                        <tr key={o.id}>
                          <td className="symbol">
                            {o.symbol}
                            {isImported && (
                              <span
                                className="muted"
                                title="Imported from Tradier — closing here will submit a sell-to-close order on Tradier"
                                style={{ marginLeft: '0.4rem', fontSize: '0.75rem' }}
                              >
                                (Tradier)
                              </span>
                            )}
                          </td>
                          <td className={o.optionType === 'call' ? 'green' : 'red'}>
                            {o.optionType.toUpperCase()}
                          </td>
                          <td>{o.strike != null ? `$${Math.round(o.strike)}` : '—'}</td>
                          <td className="muted">{o.expiration ? formatExpirationShort(o.expiration) : '—'}</td>
                          <td>{o.contracts}</td>
                          <td>${fmt(o.premiumPaid)}</td>
                          <td className={!hasMark ? 'muted' : (pnlPct >= 0 ? 'green' : 'red')}>
                            {hasMark ? `$${fmt(o.currentPremium)} (${fmtPct(pnlPct)})` : '—'}
                          </td>
                          <td className={!hasMark ? 'muted' : (pnlDollar >= 0 ? 'green' : 'red')}>
                            {hasMark ? fmtDollar(pnlDollar) : '—'}
                          </td>
                          <td className={o.trailingActive ? 'green' : 'muted'}>
                            {o.trailingActive ? 'TRAILING' : 'OPEN'}
                          </td>
                          <td className={hasStopSchedule ? 'red' : 'muted'}>
                            {!hasStopSchedule
                              ? '—'
                              : o.trailingActive
                                ? `$${fmt(o.trailingStopPremium)} (trail)`
                                : `$${fmt(o.stopLossPremium)} (SL)`}
                          </td>
                          <td>{signalLabel(o.signalType)}</td>
                          <td className="muted">{formatTime(o.openedAt)}</td>
                          <td>
                            {/* TRA-348 — once a sell_to_close has been
                                accepted by Tradier but not yet filled, the
                                Close button is replaced with a disabled
                                "Pending #N" indicator so the user can see
                                that the close is in flight without firing
                                a duplicate order. The flag clears once
                                Tradier drops the position from /positions
                                (broker confirms flat).
                                TRA-358 — engine-opened LIVE rows now use
                                `pendingExit` instead (carries the user's
                                limit + qty + duration). The badge stays
                                visible while Tradier works the order, and
                                the Cancel button fires the matching
                                Tradier cancel; reject reasons land on
                                `exitErrorReason`. */}
                            {(() => {
                              const isLiveEngineOpened = !isImported && o.mode === 'live';
                              if (o.pendingCloseOrderId != null) {
                                return (
                                  <button
                                    className="btn-close-pos"
                                    disabled
                                    title="Tradier sell_to_close accepted but not yet filled"
                                  >
                                    Pending #{o.pendingCloseOrderId}
                                  </button>
                                );
                              }
                              if (o.pendingExit) {
                                const orderRef = o.pendingExit.tradierOrderId === '' || o.pendingExit.tradierOrderId === undefined
                                  ? '?'
                                  : String(o.pendingExit.tradierOrderId);
                                const cancelInFlight = cancellingExits[o.id] === true;
                                return (
                                  <span style={{ display: 'inline-flex', gap: '0.4rem', alignItems: 'center' }}>
                                    <button
                                      className="btn-close-pos"
                                      disabled
                                      title={`Tradier sell_to_close ${o.pendingExit.kind} qty=${o.pendingExit.qty} @ $${o.pendingExit.limitPrice.toFixed(2)} duration=${o.pendingExit.duration ?? 'day'}`}
                                    >
                                      Pending #{orderRef}
                                    </button>
                                    <button
                                      className="btn-secondary"
                                      style={{ padding: '0.2rem 0.5rem', fontSize: '0.75rem' }}
                                      disabled={cancelInFlight}
                                      onClick={() => cancelPendingExit(o.id)}
                                      title="Cancel the working Tradier sell_to_close"
                                    >
                                      {cancelInFlight ? 'Cancelling…' : 'Cancel'}
                                    </button>
                                  </span>
                                );
                              }
                              const closeInFlight = closingOptions[o.id] === true;
                              return (
                                <button
                                  className="btn-close-pos"
                                  disabled={closeInFlight}
                                  onClick={() => openCloseDrawer(o, isLiveEngineOpened)}
                                  title={isLiveEngineOpened
                                    ? 'Open the limit-close panel (mirrors Tradier price/qty/duration)'
                                    : 'Close this position'}
                                >
                                  {closeInFlight ? 'Closing…' : 'Close'}
                                </button>
                              );
                            })()}
                            {o.exitErrorReason && (
                              <div className="muted" style={{ fontSize: '0.7rem', marginTop: '0.25rem', maxWidth: '12rem', whiteSpace: 'normal' }}>
                                {o.exitErrorReason}
                              </div>
                            )}
                          </td>
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
                      <SortableTH label="Symbol" sortKey="symbol" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      <SortableTH label="Type" sortKey="type" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      {/* TRA-372 — mirror Open Options contract detail on the closed table too. */}
                      <th>Strike</th>
                      <th>Expiration</th>
                      <SortableTH label="Contracts" sortKey="contracts" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      <SortableTH label="Premium Paid" sortKey="premiumPaid" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      <SortableTH label="Exit Premium" sortKey="exitPremium" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      <SortableTH label={<>P&amp;L %</>} sortKey="pnlPct" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      <SortableTH label={<>P&amp;L $</>} sortKey="pnlDollar" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                      <th>Signal</th>
                      <SortableTH label="Closed" sortKey="closed" sort={closedOptSort.sort} onSort={closedOptSort.onSort} />
                    </tr>
                  </thead>
                  <tbody>
                    {sortRows(closedOptions, closedOptSort.sort, getOptionClosedSortValue).map(o => {
                      const pnlDollar = o.pnl ?? 0;
                      // TRA-367 — P&L % from entry-to-exit premium. Used
                      // alongside the dollar P&L column so the user can see
                      // returns on imported / partial-exit closes in
                      // percentage terms without doing the math.
                      const hasEntry = o.premiumPaid > 0;
                      const pnlPct = hasEntry ? ((o.currentPremium - o.premiumPaid) / o.premiumPaid) * 100 : 0;
                      return (
                        <tr key={o.id}>
                          <td className="symbol">{o.symbol}</td>
                          <td className={o.optionType === 'call' ? 'green' : 'red'}>
                            {o.optionType.toUpperCase()}
                          </td>
                          <td>{o.strike != null ? `$${Math.round(o.strike)}` : '—'}</td>
                          <td className="muted">{o.expiration ? formatExpirationShort(o.expiration) : '—'}</td>
                          <td>{o.contracts}</td>
                          <td>${fmt(o.premiumPaid)}</td>
                          <td>${fmt(o.currentPremium)}</td>
                          <td className={!hasEntry ? 'muted' : pnlPct >= 0 ? 'green' : 'red'}>
                            {hasEntry ? fmtPct(pnlPct) : '—'}
                          </td>
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

            {optionsState && (() => {
              // TRA-367 — on Live mode the paper "Options Cash" bucket
              // is misleading: it gets drained by both demo and live
              // opens because `openOptionFromRvCandidate` deducts
              // `cost` unconditionally. The user wants the broker-side
              // option buying power instead. `account.optionBuyingPower`
              // is set from `liveTradierBalance.optionBuyingPower` (or
              // `totalCash` fallback) in `getState()`; absent in demo
              // and before the first Tradier balance fetch lands.
              const isLive = accountMode === 'live';
              const liveOptionBP = isLive ? account?.optionBuyingPower : undefined;
              const showLiveBP = isLive && typeof liveOptionBP === 'number';
              return (
                <div style={{ marginTop: '1.5rem', display: 'flex', gap: '2rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                  {showLiveBP ? (
                    <span title="Tradier option buying power for the active live env">
                      Options Buying Power: <strong>${fmt(liveOptionBP!)}</strong>
                    </span>
                  ) : (
                    <span>Options Cash: <strong>${fmt(optionsState.optionsCash)}</strong></span>
                  )}
                  <span>Total Options P&amp;L: <strong className={optionsState.optionsPnl >= 0 ? 'green' : 'red'}>{fmtDollar(optionsState.optionsPnl)}</strong></span>
                  <span>Daily Trades: <strong className={optionsState.dailyOptionsCount >= optionsDailyLimit ? 'red' : ''}>{optionsState.dailyOptionsCount}/{optionsDailyLimit}</strong></span>
                  {/* TRA-374 — surface the demo cost-model drag (slippage + per-contract fee)
                      so the dashboard P&L breakdown is reconcilable. Hidden in live (the model
                      is demo-only) and when both buckets are 0 so legacy demo accounts that
                      never enabled the haircut don't see two empty pills. */}
                  {accountMode === 'demo'
                    && (typeof optionsState.demoSlippageCost === 'number' || typeof optionsState.demoFeeCost === 'number')
                    && ((optionsState.demoSlippageCost ?? 0) > 0 || (optionsState.demoFeeCost ?? 0) > 0) ? (
                    <>
                      <span title="Demo-only modelled slippage haircut paid across opens + closes (TRA-374).">
                        Demo Slippage: <strong className="red">−${fmt(optionsState.demoSlippageCost ?? 0)}</strong>
                      </span>
                      <span title="Demo-only modelled per-contract fee debited across opens + closes (TRA-374).">
                        Demo Fees: <strong className="red">−${fmt(optionsState.demoFeeCost ?? 0)}</strong>
                      </span>
                    </>
                  ) : null}
                </div>
              );
            })()}
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
       </ErrorBoundary>
      </main>
      {/* TRA-358 — Tradier-style limit-close drawer for engine-opened LIVE
          option positions. Mirrors the price/qty/duration form Tradier shows
          on its web close panel. Submit posts a sell_to_close LIMIT and the
          row transitions to a Pending #N badge with a Cancel button until
          Tradier fills (or rejects, surfacing exitErrorReason). */}
      {closeDrawer && createPortal(
        <>
          <div
            className="profile-dropdown-backdrop"
            onClick={closeDrawerCancel}
            style={{ background: 'rgba(0,0,0,0.4)' }}
          />
          <div
            ref={closeDrawerRef}
            className="profile-dropdown"
            role="dialog"
            aria-modal="true"
            aria-label="Close option position"
            style={{
              position: 'fixed',
              top: '50%',
              left: '50%',
              transform: 'translate(-50%, -50%)',
              width: 'min(28rem, 92vw)',
              padding: '1rem',
              maxHeight: '90vh',
              overflowY: 'auto',
            }}
          >
            <h3 style={{ marginTop: 0, marginBottom: '0.75rem' }}>
              Close {closeDrawer.symbol} {closeDrawer.optionType.toUpperCase()}
            </h3>
            <div className="muted" style={{ fontSize: '0.8rem', marginBottom: '0.75rem' }}>
              {closeDrawer.optionSymbol ? (<>OCC <code>{closeDrawer.optionSymbol}</code> · </>) : null}
              Submits Tradier <code>sell_to_close</code> LIMIT.
            </div>
            <label style={{ display: 'block', marginBottom: '0.6rem' }}>
              <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}>
                Limit price (per share)
              </span>
              <input
                type="number"
                step="0.01"
                min="0.01"
                value={closeDrawer.price}
                onChange={(e) => setCloseDrawer(prev => prev ? { ...prev, price: e.target.value, error: undefined } : prev)}
                style={{ width: '100%', padding: '0.4rem' }}
                disabled={closeDrawer.submitting}
              />
              <span className="muted" style={{ fontSize: '0.7rem' }}>
                Default: current mark ${closeDrawer.defaultPrice.toFixed(2)}
              </span>
            </label>
            <label style={{ display: 'block', marginBottom: '0.6rem' }}>
              <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}>
                Quantity (contracts, max {closeDrawer.contractsRemaining})
              </span>
              <input
                type="number"
                step="1"
                min="1"
                max={closeDrawer.contractsRemaining}
                value={closeDrawer.qty}
                onChange={(e) => setCloseDrawer(prev => prev ? { ...prev, qty: e.target.value, error: undefined } : prev)}
                style={{ width: '100%', padding: '0.4rem' }}
                disabled={closeDrawer.submitting}
              />
            </label>
            <label style={{ display: 'block', marginBottom: '0.75rem' }}>
              <span style={{ display: 'block', fontSize: '0.8rem', marginBottom: '0.2rem' }}>
                Duration
              </span>
              <select
                value={closeDrawer.duration}
                onChange={(e) => setCloseDrawer(prev => prev ? { ...prev, duration: e.target.value as 'day' | 'gtc' | 'pre' | 'post', error: undefined } : prev)}
                style={{ width: '100%', padding: '0.4rem' }}
                disabled={closeDrawer.submitting}
              >
                <option value="day">Day</option>
                <option value="gtc">GTC (Good Til Cancelled)</option>
                <option value="pre">Pre-market</option>
                <option value="post">Post-market</option>
              </select>
            </label>
            {closeDrawer.error && (
              <div className="red" style={{ fontSize: '0.8rem', marginBottom: '0.5rem' }}>
                {closeDrawer.error}
              </div>
            )}
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button
                className="btn-secondary"
                onClick={closeDrawerCancel}
                disabled={closeDrawer.submitting}
              >
                Cancel
              </button>
              <button
                className="btn-close-pos"
                onClick={submitCloseDrawer}
                disabled={closeDrawer.submitting}
              >
                {closeDrawer.submitting ? 'Submitting…' : 'Submit sell_to_close'}
              </button>
            </div>
          </div>
        </>,
        document.body,
      )}
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
  }, []);

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
