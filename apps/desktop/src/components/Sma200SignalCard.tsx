// TRA-451 — card for the "SMA-200" Signals-tab category. Renders the spec UI
// row: symbol, signal type, entry, suggested stop, RSI, dist_atr, and the
// trend-quality badge. TRA-819 — pullback live entry is gated off pending an
// OOS capital-gate pass, so both pullbacks and reclaims are display-only; the
// card intentionally omits the Target / R:R chips the intraday trading signals
// carry, and renders no position/order state for either type.
import type { TradeSignal, Sma200Signal } from '@trading-app/shared';
import { fmt, fmtQuoteLevel, formatTime, signalLabel } from '../lib/format';

/** Narrow a generic signal to an Sma200Signal. */
export function isSma200Signal(sig: TradeSignal): sig is Sma200Signal {
  return sig.type === 'sma200_pullback' || sig.type === 'sma200_reclaim';
}

// TRA-3390 (impl child of TRA-2628) — THIS is the card the live `ENR.DE` buy
// renders on, and it printed `$165.70` / `$139.11` for a EUR instrument. The
// currency is passed in by the caller off the watchlist row for the same symbol
// (the Signals panel already holds `symbols`), so this card never re-derives it.
// `currency` is optional and an absent value renders the level BARE — unknown is
// not USD, and a card that quietly re-asserts dollars is the original defect.
export function Sma200SignalCard({ sig, currency }: { sig: Sma200Signal; currency?: string }) {
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
          <strong>{fmtQuoteLevel(sig.entryPrice, currency)}</strong>
        </div>
        <div className="sig-stat">
          <span>Sugg. Stop</span>
          <strong className="red">{fmtQuoteLevel(sig.stopLoss, currency)}</strong>
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
