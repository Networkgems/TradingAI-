import { useEffect, useRef, useState } from 'react';
import type { TradeSignal, Position, AccountState } from '@trading-app/shared';
import './index.css';

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

export default function App() {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const [tab, setTab] = useState<'watchlist' | 'signals' | 'positions'>('watchlist');
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
          if (msg.type === 'state') setState(msg.payload as AppState);
        } catch { /* ignore malformed */ }
      };
    }

    // Try WS first; if server not running, fall back to polling REST
    connect();
    return () => {
      wsRef.current?.close();
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
    };
  }, []);

  // Fallback REST polling when WS isn't connected
  useEffect(() => {
    if (connected) return;
    const id = setInterval(async () => {
      try {
        const r = await fetch(`${HTTP_URL}/api/state`);
        if (r.ok) setState(await r.json() as AppState);
      } catch { /* ignore */ }
    }, 5000);
    return () => clearInterval(id);
  }, [connected]);

  const account = state?.account;
  const signals = state?.signals ?? [];
  const symbols = state?.symbols ?? [];
  const openPositions = account?.openPositions ?? [];
  const closedPositions = state?.closedPositions ?? [];

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <h1>TradingAI</h1>
          <span className="subtitle">ORB + Reversal · 25 Symbols</span>
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
            </>
          )}
          <div className={`status-dot ${connected ? 'live' : 'offline'}`} title={connected ? 'Live' : 'Reconnecting...'} />
          <span className="status-label">{connected ? 'LIVE' : 'Reconnecting'}</span>
          {state && <span className="last-tick">Updated {timeAgo(state.lastTick)}</span>}
        </div>
      </header>

      <nav className="tabs">
        {(['watchlist', 'signals', 'positions'] as const).map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>
            {t === 'watchlist' ? `Watchlist (${symbols.length})` :
             t === 'signals' ? `Signals (${signals.length})` :
             `Positions (${openPositions.length})`}
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
                      <span className="signal-type">{sig.type === 'orb_breakout' ? 'ORB' : 'Reversal'}</span>
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
                      <th>Stop</th>
                      <th>Target</th>
                      <th>Opened</th>
                    </tr>
                  </thead>
                  <tbody>
                    {openPositions.map(p => (
                      <tr key={p.id}>
                        <td className="symbol">{p.symbol}</td>
                        <td className={p.side === 'buy' ? 'green' : 'red'}>{p.side.toUpperCase()}</td>
                        <td>{p.quantity}</td>
                        <td>${fmt(p.entryPrice)}</td>
                        <td className="red">${fmt(p.stopLoss)}</td>
                        <td className="green">${fmt(p.takeProfit)}</td>
                        <td className="muted">{formatTime(p.openedAt)}</td>
                      </tr>
                    ))}
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
      </main>
    </div>
  );
}
