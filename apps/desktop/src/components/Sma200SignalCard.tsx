// TRA-451 — card for the "SMA-200" Signals-tab category. Renders the spec UI
// row: symbol, signal type, entry, suggested stop, RSI, dist_atr, and the
// trend-quality badge. SMA-200 signals are display-only (no trade is opened
// off them until QuantTrader clears the backtest acceptance gate), so the
// card intentionally omits the Target / R:R chips the trading signals carry.
import type { TradeSignal, Sma200Signal } from '@trading-app/shared';
import { fmt, fmtPrice, formatTime, signalLabel } from '../lib/format';

/** Narrow a generic signal to an Sma200Signal. */
export function isSma200Signal(sig: TradeSignal): sig is Sma200Signal {
  return sig.type === 'sma200_pullback' || sig.type === 'sma200_reclaim';
}

export function Sma200SignalCard({ sig }: { sig: Sma200Signal }) {
  return (
    <div className="signal-card buy sma200-card">
      <div className="signal-header">
        <span className="signal-symbol">{sig.symbol}</span>
        <span className="signal-type">{signalLabel(sig.type)}</span>
        <span
          className={`sma200-badge ${sig.trendQuality ? 'ok' : 'off'}`}
          title="Signal 1 — uptrend-quality trend/quality filter"
        >
          {sig.trendQuality ? 'Uptrend quality' : 'No trend gate'}
        </span>
        <span className="signal-time">{formatTime(sig.timestamp)}</span>
      </div>
      <div className="signal-body sma200-body">
        <div className="sig-stat">
          <span>Entry</span>
          <strong>{fmtPrice(sig.entryPrice)}</strong>
        </div>
        <div className="sig-stat">
          <span>Sugg. Stop</span>
          <strong className="red">{fmtPrice(sig.stopLoss)}</strong>
        </div>
        <div className="sig-stat">
          <span>RSI(14)</span>
          <strong>{fmt(sig.rsi, 1)}</strong>
        </div>
        <div className="sig-stat">
          <span>Dist (ATR)</span>
          <strong>{fmt(sig.distAtr, 2)}</strong>
        </div>
      </div>
      <div className="sma200-context">
        {sig.context}
        {sig.goldenCross && <span className="sma200-chip">Golden cross</span>}
      </div>
    </div>
  );
}
