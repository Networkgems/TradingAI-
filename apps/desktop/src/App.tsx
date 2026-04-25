import { useEffect, useRef, useState } from 'react';
import type { TradeSignal, Position, AccountState, OptionPosition, OptionsAccountState, EodReport, CryptoEngineState, NewsItem } from '@trading-app/shared';
import { OPTIONS_DAILY_LIMIT } from '@trading-app/shared';
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

const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? 'ws://localhost:4242';
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

function CryptoDashboard({ onBack }: { onBack: () => void }) {
  const [state, setState] = useState<CryptoEngineState | null>(null);
  const [news, setNews] = useState<NewsItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions' | 'news'>('watchlist');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    function connect() {
      const ws = new WebSocket(SERVER_URL);
      wsRef.current = ws;
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        reconnectTimer.current = setTimeout(connect, 3000);
      };
      ws.onerror = () => ws.close();
      ws.onmessage = (e) => {
        try {
          const msg = JSON.parse(e.data as string);
          if (msg.type === 'crypto_state') setState(msg.payload as CryptoEngineState);
        } catch { /* ignore */ }
      };
    }
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, []);

  // Fallback REST polling when WS disconnected
  useEffect(() => {
    if (connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/state`);
        if (r.ok) setState(await r.json() as CryptoEngineState);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(id);
  }, [connected]);

  // News polling every 5 minutes
  useEffect(() => {
    async function loadNews() {
      try {
        const r = await fetch(`${HTTP_URL}/api/crypto/news`);
        if (r.ok) setNews(await r.json() as NewsItem[]);
      } catch { /* ignore */ }
    }
    loadNews();
    const id = setInterval(loadNews, 5 * 60_000);
    return () => clearInterval(id);
  }, []);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  const closedPositions = state?.closedPositions ?? [];

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="back-btn" onClick={onBack} title="Back to dashboard selector">&#8592; Home</button>
          <h1>TradingAI <span className="mode-badge crypto">Crypto</span></h1>
          <span className="subtitle">ORB · Reversal · 20 Symbols · 24/7</span>
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
              <div className="stat">
                <span className="stat-label">Week P&amp;L</span>
                <span className={`stat-value ${account.weeklyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.weeklyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Month P&amp;L</span>
                <span className={`stat-value ${account.monthlyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.monthlyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Year P&amp;L</span>
                <span className={`stat-value ${account.yearlyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.yearlyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">All-Time P&amp;L</span>
                <span className={`stat-value ${account.allTimePnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.allTimePnl)}
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
            </>
          )}
          <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live' : 'Reconnecting...'} />
          <span className="status-label">{connected ? 'LIVE' : 'Reconnecting'}</span>
          {state && <span className="last-tick">Updated {timeAgo(state.lastTick)}</span>}
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
      </nav>

      <main className="content">
        {!state && (
          <div className="loading">
            <div className="spinner" />
            <p>Connecting to crypto engine…</p>
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
                    <td>{(s.volume / 1_000_000).toFixed(2)}M</td>
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

        {tab === 'news' && (
          <div className="signals-panel">
            {news.length === 0 ? (
              <div className="empty">Loading crypto news…</div>
            ) : (
              <div className="signal-list">
                {news.slice(0, 10).map((item, i) => (
                  <div key={i} className="signal-card buy">
                    <div className="signal-header">
                      <span className="signal-symbol">{item.source}</span>
                      <span className="signal-time muted">
                        {timeAgo(new Date(item.publishedAt).getTime())}
                      </span>
                    </div>
                    <div style={{ padding: '0.5rem 0' }}>
                      <a href={item.url} target="_blank" rel="noopener noreferrer"
                         style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 500 }}>
                        {item.title}
                      </a>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </main>
    </div>
  );
}

export default function App() {
  const [appMode, setAppMode] = useState<null | 'stocks' | 'crypto'>(() => {
    const stored = localStorage.getItem('tradingMode');
    return stored === 'stocks' || stored === 'crypto' ? stored : null;
  });
  const [state, setState] = useState<AppState | null>(null);
  const [eodReport, setEodReport] = useState<EodReport | null>(null);
  const [eodCollapsed, setEodCollapsed] = useState(false);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions' | 'options'>('watchlist');
  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (appMode !== 'stocks') return;
    function connect() {
      const ws = new WebSocket(SERVER_URL);
      wsRef.current = ws;

      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
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
  }, [appMode]);

  // Fallback REST polling when WS isn't connected
  useEffect(() => {
    if (appMode !== 'stocks' || connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/state`);
        if (r.ok) setState(await r.json() as AppState);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(id);
  }, [appMode, connected]);

  function selectMode(mode: 'stocks' | 'crypto') {
    localStorage.setItem('tradingMode', mode);
    setAppMode(mode);
  }

  function goHome() {
    localStorage.removeItem('tradingMode');
    setAppMode(null);
  }

  if (appMode === null) {
    return <DashboardSelector onSelect={selectMode} />;
  }

  if (appMode === 'crypto') {
    return <CryptoDashboard onBack={goHome} />;
  }

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  const closedPositions = state?.closedPositions ?? [];
  const optionsState = state?.options;
  const openOptions: OptionPosition[] = optionsState?.openOptions ?? [];
  const closedOptions: OptionPosition[] = optionsState?.closedOptions ?? [];

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <button className="back-btn" onClick={goHome} title="Back to dashboard selector">&#8592; Home</button>
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
                <span className="stat-label">Today P&amp;L</span>
                <span className={`stat-value ${account.dailyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.dailyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Week P&amp;L</span>
                <span className={`stat-value ${account.weeklyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.weeklyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Month P&amp;L</span>
                <span className={`stat-value ${account.monthlyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.monthlyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">Year P&amp;L</span>
                <span className={`stat-value ${account.yearlyPnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.yearlyPnl)}
                </span>
              </div>
              <div className="stat">
                <span className="stat-label">All-Time P&amp;L</span>
                <span className={`stat-value ${account.allTimePnl >= 0 ? 'green' : 'red'}`}>
                  {fmtDollar(account.allTimePnl)}
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
      </nav>

      <main className="content">
        {!state && (
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
              {/* P&L summary row */}
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

              {/* Top 5 movers */}
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

              {/* Trade log */}
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
