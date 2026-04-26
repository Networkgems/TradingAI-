import { useEffect, useRef, useState } from 'react';
import type { TradeSignal, Position, AccountState, OptionPosition, OptionsAccountState, EodReport, CryptoEngineState, NewsItem } from '@trading-app/shared';
import { OPTIONS_DAILY_LIMIT } from '@trading-app/shared';
import LoginPage from './LoginPage.tsx';
import ForgotPasswordPage from './ForgotPasswordPage.tsx';
import SettingsPage, { ChangePasswordSection, UserManagementSection } from './SettingsPage.tsx';
import { CalendarTab } from './CalendarTab.tsx';
import './index.css';

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

function DashboardSelector({ onSelect }: { onSelect: (mode: 'stocks' | 'crypto') => void }) {
  return (
    <div className="selector-screen">
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

function CryptoDashboard({ token, onBack, onLogout }: { token: string; onBack: () => void; onLogout: () => void }) {
  const [state, setState] = useState<CryptoEngineState | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [everConnected, setEverConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions' | 'news' | 'calendar' | 'settings'>('watchlist');
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileModal, setProfileModal] = useState<null | 'change-password' | 'user-management'>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const [tradingToggling, setTradingToggling] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(`${SERVER_URL}?token=${token}`);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = (e) => {
        setConnected(false);
        if (e.code === 1008) { onBack(); return; }
        reconnectTimer.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'crypto_state') { setState(msg.payload as CryptoEngineState); setEverConnected(true); }
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
        if (r.status === 401) { onBack(); return; }
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
    if (!profileOpen) return;
    function handleClick(e: MouseEvent) {
      if (!(e.target as HTMLElement).closest('.profile-wrap')) setProfileOpen(false);
    }
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [profileOpen]);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
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
    await fetch(`${HTTP_URL}/api/crypto/positions/${positionId}/close`, {
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
          <span className="subtitle">Reversal · MACD · Ichimoku · 20 Symbols · 24/7</span>
        </div>
        <div className="header-right">
          {account && (
            <>
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
            </>
          )}
          <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live' : 'Reconnecting...'} />
          <span className="status-label">{connected ? 'LIVE' : 'Reconnecting'}</span>
          {state && <span className="last-tick">Updated {timeAgo(state.lastTick)}</span>}
          <button
            className={`logout-btn${autoTradingEnabled ? ' trading-active' : ' trading-stopped'}`}
            onClick={toggleAutoTrading}
            disabled={tradingToggling}
            title={autoTradingEnabled ? 'Stop auto trading' : 'Start auto trading'}
          >
            {autoTradingEnabled ? '⏹ Stop Trading' : '▶ Start Trading'}
          </button>
          <button
            className={`logout-btn${tab === 'settings' ? ' active' : ''}`}
            onClick={() => setTab(t => t === 'settings' ? 'watchlist' : 'settings')}
            title="Account settings"
          >
            ⚙ Settings
          </button>
          <div className="profile-wrap">
            <button
              className="logout-btn"
              onClick={() => setProfileOpen(o => !o)}
              title="Profile menu"
            >
              &#x1F464; Profile &#9660;
            </button>
            {profileOpen && (
              <div className="profile-dropdown">
                <button
                  className="profile-dropdown-item"
                  onClick={() => { setProfileModal('change-password'); setProfileOpen(false); }}
                >
                  Change Password
                </button>
                {isAdmin && (
                  <button
                    className="profile-dropdown-item"
                    onClick={() => { setProfileModal('user-management'); setProfileOpen(false); }}
                  >
                    Account Management
                  </button>
                )}
                <div className="profile-dropdown-divider" />
                <button
                  className="profile-dropdown-item danger"
                  onClick={onLogout}
                >
                  Sign Out
                </button>
              </div>
            )}
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

      {tab === 'settings' && (
        <SettingsPage token={token} httpUrl={HTTP_URL} context="crypto" />
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

      <main className="content" style={tab === 'settings' ? { display: 'none' } : undefined}>
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
            <table>
              <thead>
                <tr>
                  <th>Symbol</th><th>Price</th><th>Change</th><th>Change %</th><th>Volume</th><th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {symbols.sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct)).map(s => (
                  <tr key={s.symbol} className={s.change >= 0 ? 'up' : 'down'}>
                    <td className="symbol">{s.symbol}</td>
                    <td className="price">${fmt(s.price)}</td>
                    <td className={s.change >= 0 ? 'green' : 'red'}>{fmtDollar(s.change)}</td>
                    <td className={s.changePct >= 0 ? 'green' : 'red'}>{fmtPct(s.changePct)}</td>
                    <td>{(s.volume / 1_000_000).toFixed(1)}M</td>
                    <td className="muted">{timeAgo(s.lastUpdated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {state && tab === 'signals' && (
          <div className="signals-panel">
            {signals.length === 0 ? (
              <div className="empty">No signals yet — engine is scanning {symbols.length} symbols…</div>
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
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {state && tab === 'positions' && (
          <div className="positions-panel">
            {openPositions.length > 0 && (
              <>
                <h3>Open Positions</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Current</th>
                      <th>P&amp;L %</th><th>P&amp;L $</th><th>Stop</th><th>Target</th><th>Opened</th><th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map(p => {
                      const sym = symbols.find(s => s.symbol === p.symbol);
                      const currentPrice = sym?.price ?? p.entryPrice;
                      const multiplier = p.side === 'buy' ? 1 : -1;
                      const pnlPct = ((currentPrice - p.entryPrice) / p.entryPrice) * 100 * multiplier;
                      const pnlDollar = (currentPrice - p.entryPrice) * p.quantity * multiplier;
                      return (
                        <tr key={p.id}>
                          <td className="symbol">{p.symbol}</td>
                          <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                          <td>{p.quantity}</td>
                          <td>${fmt(p.entryPrice)}</td>
                          <td>${fmt(currentPrice)}</td>
                          <td className={pnlPct >= 0 ? 'green' : 'red'}>{fmtPct(pnlPct)}</td>
                          <td className={pnlDollar >= 0 ? 'green' : 'red'}>{fmtDollar(pnlDollar)}</td>
                          <td className="red">${fmt(p.stopLoss)}</td>
                          <td className="green">${fmt(p.takeProfit)}</td>
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
                <h3 style={{ marginTop: '1.5rem' }}>Recent Closed</h3>
                <table>
                  <thead>
                    <tr><th>Symbol</th><th>Side</th><th>Qty</th><th>Entry</th><th>Exit</th><th>P&amp;L</th><th>Closed</th></tr>
                  </thead>
                  <tbody>
                    {closedPositions.map(p => (
                      <tr key={p.id}>
                        <td className="symbol">{p.symbol}</td>
                        <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                        <td>{p.quantity}</td>
                        <td>${fmt(p.entryPrice)}</td>
                        <td>${fmt(p.side === 'buy' ? p.takeProfit : p.stopLoss)}</td>
                        <td className={(p.pnl ?? 0) >= 0 ? 'green' : 'red'}>{fmtDollar(p.pnl ?? 0)}</td>
                        <td className="muted">{p.closedAt ? formatTime(p.closedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
            {openPositions.length === 0 && closedPositions.length === 0 && (
              <div className="empty">No positions yet. Signals will auto-open paper positions.</div>
            )}
          </div>
        )}

        {tab === 'news' && (
          <div className="signals-panel">
            {news.length === 0 ? (
              <div className="empty">Loading crypto news…</div>
            ) : (
              <div className="signal-list">
                {news.slice(0, 10).map((item) => (
                  <div key={item.url} className="news-card">
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
                ))}
              </div>
            )}
          </div>
        )}

        {tab === 'calendar' && (
          <CalendarTab token={token} httpUrl={HTTP_URL} reportsPath="/api/crypto/reports" />
        )}
      </main>
    </div>
  );
}

const SERVER_URL: string = import.meta.env.VITE_SERVER_URL ??
  (typeof window !== 'undefined' && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1'
    ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
    : 'ws://localhost:4242');
const HTTP_URL = SERVER_URL.replace(/^ws/, 'http');

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

function fmt(n: number, decimals = 2) {
  return n.toLocaleString('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function fmtDollar(n: number) {
  const sign = n >= 0 ? '+' : '';
  return `${sign}$${fmt(Math.abs(n))}`;
}

function fmtPct(n: number) {
  const sign = n >= 0 ? '+' : '';
  return `${sign}${fmt(n, 2)}%`;
}

function timeAgo(ts: number) {
  const secs = Math.floor((Date.now() - ts) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function signalLabel(type: string) {
  switch (type) {
    case 'orb_breakout': return 'ORB';
    case 'reversal': return 'Reversal';
    case 'macd_cross': return 'MACD';
    case 'ichimoku': return 'Ichimoku';
    default: return type;
  }
}

function Dashboard({ token, onLogout, onGoHome }: { token: string; onLogout: () => void; onGoHome: () => void }) {
  const [state, setState] = useState<AppState | null>(null);
  const [eodReport, setEodReport] = useState<EodReport | null>(null);
  const [eodCollapsed, setEodCollapsed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions' | 'options' | 'settings' | 'calendar'>('watchlist');
  const [tradingToggling, setTradingToggling] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

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
          if (msg.type === 'eod_report') setEodReport(msg.payload as EodReport);
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

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  const closedPositions = state?.closedPositions ?? [];
  const optionsState = state?.options;
  const openOptions: OptionPosition[] = optionsState?.openOptions ?? [];
  const closedOptions: OptionPosition[] = optionsState?.closedOptions ?? [];
  const autoTradingEnabled = state?.autoTradingEnabled ?? true;

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

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="back-btn" onClick={onGoHome} title="Back to dashboard selector">&#8592; Home</button>
          <h1>TradingAI <span className="mode-badge stocks">Stocks</span></h1>
          <span className="subtitle">ORB · Reversal · MACD · Ichimoku · 25 Symbols</span>
        </div>
        <div className="header-right">
          {account && (
            <>
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
              {optionsState && (
                <>
                  <div className="stat">
                    <span className="stat-label">Options P&amp;L</span>
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
                    <span className={`stat-value ${optionsState.dailyOptionsCount >= OPTIONS_DAILY_LIMIT ? 'red' : ''}`}>
                      {optionsState.dailyOptionsCount}/{OPTIONS_DAILY_LIMIT}
                    </span>
                  </div>
                </>
              )}
            </>
          )}
          <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live' : 'Reconnecting...'} />
          <span className="status-label">{connected ? 'LIVE' : 'Reconnecting'}</span>
          {state && <span className="last-tick">Updated {timeAgo(state.lastTick)}</span>}
          <button
            className={`logout-btn${autoTradingEnabled ? ' trading-active' : ' trading-stopped'}`}
            onClick={toggleAutoTrading}
            disabled={tradingToggling}
            title={autoTradingEnabled ? 'Stop auto trading' : 'Start auto trading'}
          >
            {autoTradingEnabled ? '⏹ Stop Trading' : '▶ Start Trading'}
          </button>
          <button
            className={`logout-btn${tab === 'settings' ? ' active' : ''}`}
            onClick={() => setTab(t => t === 'settings' ? 'watchlist' : 'settings')}
            title="Account settings"
          >
            ⚙ Settings
          </button>
          <button className="logout-btn" onClick={onLogout} title="Sign out">
            Sign out
          </button>
        </div>
      </header>

      <nav className="tabs">
        {(['watchlist', 'signals', 'positions', 'options'] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'watchlist' ? `Watchlist (${symbols.length})` :
             t === 'signals' ? `Signals (${signals.length})` :
             t === 'positions' ? `Positions (${openPositions.length})` :
             `Options (${openOptions.length})`}
          </button>
        ))}
        <button className={`tab ${tab === 'calendar' ? 'active' : ''}`} onClick={() => setTab('calendar')}>
          Calendar
        </button>
      </nav>

      {tab === 'settings' && (
        <SettingsPage token={token} httpUrl={HTTP_URL} />
      )}

      <main className="content">
        {tab !== 'settings' && !state && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to trading engine…</p>
            <p className="hint">Make sure the server is running: <code>pnpm server:dev</code></p>
          </div>
        )}

        {state && tab === 'watchlist' && (
          <div className="watchlist">
            <table>
              <thead>
                <tr>
                  <th>Symbol</th>
                  <th>Price</th>
                  <th>Change</th>
                  <th>Change %</th>
                  <th>Volume</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>
                {symbols
                  .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct))
                  .map(s => (
                  <tr key={s.symbol} className={s.change >= 0 ? 'up' : 'down'}>
                    <td className="symbol">{s.symbol}</td>
                    <td className="price">${fmt(s.price)}</td>
                    <td className={s.change >= 0 ? 'green' : 'red'}>{fmtDollar(s.change)}</td>
                    <td className={s.changePct >= 0 ? 'green' : 'red'}>{fmtPct(s.changePct)}</td>
                    <td>{(s.volume / 1_000_000).toFixed(1)}M</td>
                    <td className="muted">{timeAgo(s.lastUpdated)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {state && tab === 'signals' && (
          <div className="signals-panel">
            {signals.length === 0 ? (
              <div className="empty">No signals yet — engine is scanning {symbols.length} symbols…</div>
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

        {state && tab === 'positions' && (
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
                      <th>Current</th>
                      <th>P&amp;L %</th>
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
                      return (
                        <tr key={p.id}>
                          <td className="symbol">{p.symbol}</td>
                          <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                          <td>{p.quantity}</td>
                          <td>${fmt(p.entryPrice)}</td>
                          <td>${fmt(currentPrice)}</td>
                          <td className={pnlPct >= 0 ? 'green' : 'red'}>{fmtPct(pnlPct)}</td>
                          <td className="red">${fmt(p.stopLoss)}</td>
                          <td className="green">${fmt(p.takeProfit)}</td>
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
                <h3 style={{ marginTop: '1.5rem' }}>Recent Closed</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Side</th>
                      <th>Qty</th>
                      <th>Entry</th>
                      <th>Exit</th>
                      <th>P&amp;L</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedPositions.map(p => (
                      <tr key={p.id}>
                        <td className="symbol">{p.symbol}</td>
                        <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                        <td>{p.quantity}</td>
                        <td>${fmt(p.entryPrice)}</td>
                        <td>${fmt(p.side === 'buy' ? p.takeProfit : p.stopLoss)}</td>
                        <td className={(p.pnl ?? 0) >= 0 ? 'green' : 'red'}>{fmtDollar(p.pnl ?? 0)}</td>
                        <td className="muted">{p.closedAt ? formatTime(p.closedAt) : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}

            {openPositions.length === 0 && closedPositions.length === 0 && (
              <div className="empty">No positions yet. Signals will auto-open paper positions.</div>
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
                <h3 style={{ marginTop: '1.5rem' }}>Recent Closed Options</h3>
                <table>
                  <thead>
                    <tr>
                      <th>Symbol</th>
                      <th>Type</th>
                      <th>Contracts</th>
                      <th>Entry Premium</th>
                      <th>Exit Premium</th>
                      <th>P&amp;L</th>
                      <th>Signal</th>
                      <th>Closed</th>
                    </tr>
                  </thead>
                  <tbody>
                    {closedOptions.map(o => {
                      const exitPremium = o.closedAt ? o.currentPremium : 0;
                      return (
                        <tr key={o.id}>
                          <td className="symbol">{o.symbol}</td>
                          <td className={o.optionType === 'call' ? 'green' : 'red'}>
                            {o.optionType.toUpperCase()}
                          </td>
                          <td>{o.contracts}</td>
                          <td>${fmt(o.premiumPaid)}</td>
                          <td>${fmt(exitPremium)}</td>
                          <td className={(o.pnl ?? 0) >= 0 ? 'green' : 'red'}>{fmtDollar(o.pnl ?? 0)}</td>
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
                No option positions yet. Options (calls/puts) are auto-opened when any signal triggers (ORB, Reversal, MACD, or Ichimoku).
                <br /><br />
                <strong>Strategy:</strong> Bullish signals → buy CALL · Bearish signals → buy PUT<br />
                <strong>Take profit:</strong> +25% → activates trailing stop (15% below peak) · <strong>Stop loss:</strong> −35% · <strong>Max:</strong> 5 trades/day
              </div>
            )}

            {optionsState && (
              <div style={{ marginTop: '1.5rem', display: 'flex', gap: '2rem', fontSize: '0.85rem', color: 'var(--muted)' }}>
                <span>Options Cash: <strong>${fmt(optionsState.optionsCash)}</strong></span>
                <span>Total Options P&amp;L: <strong className={optionsState.optionsPnl >= 0 ? 'green' : 'red'}>{fmtDollar(optionsState.optionsPnl)}</strong></span>
                <span>Daily Trades: <strong className={optionsState.dailyOptionsCount >= OPTIONS_DAILY_LIMIT ? 'red' : ''}>{optionsState.dailyOptionsCount}/{OPTIONS_DAILY_LIMIT}</strong></span>
              </div>
            )}
          </div>
        )}

        {tab === 'calendar' && (
          <CalendarTab token={token} httpUrl={HTTP_URL} />
        )}
      </main>

      {/* ── EOD Report Panel ─────────────────────────────────────────────── */}
      {eodReport && (
        <section className="eod-panel">
          <div className="eod-header" onClick={() => setEodCollapsed(c => !c)}>
            <span className="eod-title">EOD Report — {eodReport.date}</span>
            <span className="eod-summary">
              <span className={eodReport.combinedPnl >= 0 ? 'green' : 'red'}>
                {fmtDollar(eodReport.combinedPnl)}
              </span>
              &nbsp;·&nbsp;Win rate {(eodReport.winRate * 100).toFixed(0)}%
              &nbsp;·&nbsp;{eodReport.totalTrades} trades
            </span>
            <span className="eod-toggle">{eodCollapsed ? '▲ Show' : '▼ Hide'}</span>
          </div>

          {!eodCollapsed && (
            <div className="eod-body">
              <div className="eod-stats-row">
                <div className="eod-stat">
                  <span className="eod-stat-label">Realized P&amp;L</span>
                  <span className={`eod-stat-value ${eodReport.realizedPnl >= 0 ? 'green' : 'red'}`}>
                    {fmtDollar(eodReport.realizedPnl)}
                  </span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Unrealized P&amp;L</span>
                  <span className={`eod-stat-value ${eodReport.unrealizedPnl >= 0 ? 'green' : 'red'}`}>
                    {fmtDollar(eodReport.unrealizedPnl)}
                  </span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Options P&amp;L</span>
                  <span className={`eod-stat-value ${eodReport.optionsPnl >= 0 ? 'green' : 'red'}`}>
                    {fmtDollar(eodReport.optionsPnl)}
                  </span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Combined P&amp;L</span>
                  <span className={`eod-stat-value ${eodReport.combinedPnl >= 0 ? 'green' : 'red'}`}>
                    {fmtDollar(eodReport.combinedPnl)}
                  </span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Win Rate</span>
                  <span className="eod-stat-value">{(eodReport.winRate * 100).toFixed(1)}%</span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Avg R:R</span>
                  <span className="eod-stat-value">1:{eodReport.avgRR.toFixed(2)}</span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Signals Fired</span>
                  <span className="eod-stat-value">{eodReport.signalAccuracy.totalSignals}</span>
                </div>
                <div className="eod-stat">
                  <span className="eod-stat-label">Signal Win %</span>
                  <span className="eod-stat-value">
                    {(eodReport.signalAccuracy.winRate * 100).toFixed(1)}%
                  </span>
                </div>
              </div>

              {eodReport.top5Movers.length > 0 && (
                <div className="eod-movers">
                  <span className="eod-section-label">Top 5 Movers:</span>
                  {eodReport.top5Movers.map(m => (
                    <span key={m.symbol} className="eod-mover">
                      <strong>{m.symbol}</strong>
                      <span className={m.changePct >= 0 ? 'green' : 'red'}>
                        &nbsp;{m.changePct >= 0 ? '+' : ''}{m.changePct.toFixed(2)}%
                      </span>
                    </span>
                  ))}
                </div>
              )}

              {eodReport.trades.length > 0 && (
                <div className="eod-trades">
                  <span className="eod-section-label">Trade Log ({eodReport.trades.length})</span>
                  <table>
                    <thead>
                      <tr>
                        <th>Symbol</th>
                        <th>Strategy</th>
                        <th>Side</th>
                        <th>Qty</th>
                        <th>Entry</th>
                        <th>Exit</th>
                        <th>P&amp;L</th>
                        <th>R:R</th>
                      </tr>
                    </thead>
                    <tbody>
                      {eodReport.trades.map(t => (
                        <tr key={t.id}>
                          <td className="symbol">{t.symbol}</td>
                          <td>{t.strategy}</td>
                          <td className={t.side === 'buy' ? 'green' : 'red'}>{t.side.toUpperCase()}</td>
                          <td>{t.quantity}</td>
                          <td>${fmt(t.entryPrice)}</td>
                          <td>${fmt(t.exitPrice)}</td>
                          <td className={t.pnl >= 0 ? 'green' : 'red'}>{fmtDollar(t.pnl)}</td>
                          <td>1:{t.rr}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              <div className="eod-generated">
                Generated at {new Date(eodReport.generatedAt).toLocaleTimeString()}
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

type AuthScreen = 'login' | 'forgot';

export default function App() {
  const [token, setToken] = useState<string | null>(() => localStorage.getItem('auth_token'));
  const [authScreen, setAuthScreen] = useState<AuthScreen>('login');
  const [appMode, setAppMode] = useState<null | 'stocks' | 'crypto'>(() => {
    const stored = localStorage.getItem('tradingMode');
    return stored === 'stocks' || stored === 'crypto' ? stored : null;
  });

  function handleLogout() {
    localStorage.removeItem('auth_token');
    localStorage.removeItem('tradingMode');
    setToken(null);
    setAuthScreen('login');
    setAppMode(null);
  }

  function selectMode(mode: 'stocks' | 'crypto') {
    localStorage.setItem('tradingMode', mode);
    setAppMode(mode);
  }

  function goHome() {
    localStorage.removeItem('tradingMode');
    setAppMode(null);
  }

  if (!token) {
    if (authScreen === 'forgot') {
      return <ForgotPasswordPage onBack={() => setAuthScreen('login')} />;
    }
    return <LoginPage onLogin={setToken} onForgotPassword={() => setAuthScreen('forgot')} />;
  }

  if (appMode === null) {
    return <DashboardSelector onSelect={selectMode} />;
  }

  if (appMode === 'crypto') {
    return <CryptoDashboard token={token} onBack={goHome} onLogout={handleLogout} />;
  }

  return <Dashboard token={token} onLogout={handleLogout} onGoHome={goHome} />;
}
