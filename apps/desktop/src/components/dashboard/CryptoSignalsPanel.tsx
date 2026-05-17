// TRA-422 — the Crypto Signals tab, extracted from CryptoDashboard.tsx. Owns
// the "Reset Signals" mutation and the one-click watchlist prune used by the
// "not listed on Coinbase" skip rows; the signal list is passed in.
import type { TradeSignal, CryptoSymbolState } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { fmt, fmtSignedIntPct, timeAgo, formatTime, signalLabel } from '../../lib/format';
import { SignalOptionRow } from '../SignalOptionRow';

export function CryptoSignalsPanel({
  token,
  signals,
  symbols,
}: {
  token: string;
  signals: TradeSignal[];
  symbols: CryptoSymbolState[];
}) {
  const toast = useToast();

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

  // TRA-243 — one-click prune for symbols Coinbase doesn't list (LUNC, MATIC
  // after the POL rename, etc.); routes through DELETE /api/watchlist/crypto.
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

  return (
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
                // TRA-261 — pre-route suppression (universe gate, §5 short
                // filters, MR-shorts off-strategy). Distinct from
                // liveSkipReason which is a broker-side skip.
                <div className="signal-skip-reason" title={sig.signalSkipReason}>
                  <span>Suppressed: {sig.signalSkipReason}</span>
                </div>
              )}
              {sig.liveSkipReason && (
                <div className="signal-skip-reason" title={sig.liveSkipReason}>
                  <span>Not opened: {sig.liveSkipReason}</span>
                  {sig.liveSkipReason.includes('not listed on Coinbase') && (
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
  );
}
