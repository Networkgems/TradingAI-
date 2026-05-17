// TRA-422 — the Stocks Signals tab, extracted from Dashboard.tsx. Owns the
// "Reset Signals" mutation; the signal list and regime context are passed in.
import type { TradeSignal, EngineMarketReviewState } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmt, fmtSignedIntPct, formatTime, signalLabel } from '../../lib/format';
import { RegimeBanner } from '../RegimeBanner';
import { SignalOptionRow } from '../SignalOptionRow';
import type { SymbolState } from '../../types/app';

export function StockSignalsPanel({
  token,
  signals,
  symbols,
  marketReview,
}: {
  token: string;
  signals: TradeSignal[];
  symbols: SymbolState[];
  marketReview: EngineMarketReviewState | undefined;
}) {
  const toast = useToast();

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
    <div className="signals-panel">
      {/* TRA-389 — regime banner: shown once the operator opts into
          market-review gating, explains why a strategy is gated off. */}
      <RegimeBanner review={marketReview} />
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
  );
}
