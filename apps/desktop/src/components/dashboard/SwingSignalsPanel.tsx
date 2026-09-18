// TRA-4626 — Swing Signals panel displaying fusion engine candidates.
// Shows ranked swing signal candidates with composite scores (0-100) and
// breakdown across 8 dimensions: technical, momentum, mean reversion,
// relative strength, IV/RV, IV skew, OTM mispricing, liquidity.
import type { SwingSignalCandidate } from '@trading-app/shared';
import { HTTP_URL } from '../../server-url';
import { logger } from '../../lib/logger';
import { useToast } from '../../lib/toast.tsx';
import { formatTime } from '../../lib/format';

export function SwingSignalsPanel({
  token,
  swingSignals,
  lastScanAt,
  marketOpen,
}: {
  token: string;
  swingSignals: SwingSignalCandidate[];
  lastScanAt?: number;
  marketOpen?: boolean;
}) {
  const toast = useToast();

  // Scan status line (similar to StockSignalsPanel)
  const marketLabel = marketOpen === false ? 'Market closed' : marketOpen === true ? 'Market open' : null;
  const setupCount = `${swingSignals.length} candidate${swingSignals.length === 1 ? '' : 's'}`;
  const scanStatus = lastScanAt && lastScanAt > 0
    ? `${marketLabel ? marketLabel + ' · ' : ''}Last scan ${formatTime(lastScanAt)} — ${setupCount}`
    : `${marketLabel ? marketLabel + ' · ' : ''}Waiting for first scan…`;

  async function resetSwingSignals() {
    try {
      const r = await fetch(`${HTTP_URL}/api/swing-signals/reset`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
      });
      if (r.ok) toast.success('Swing signals cleared');
      else toast.error(`Could not reset swing signals (HTTP ${r.status})`);
    } catch (err) {
      logger.error('swing-signals', 'reset signals failed', err);
      toast.error('Could not reset swing signals — network error');
    }
  }

  return (
    <div className="swing-signals-panel">
      <div className="signals-toolbar">
        <span className="scan-status" title="Timestamp of the last completed swing signal scan">
          {scanStatus}
        </span>
        <button
          className="btn-secondary btn-sm"
          onClick={resetSwingSignals}
          disabled={swingSignals.length === 0}
          title="Clear the swing signal list"
        >
          Reset Signals
        </button>
      </div>
      {swingSignals.length === 0 ? (
        <div className="empty">No swing signals yet — fusion engine scanning for setups…</div>
      ) : (
        <div className="swing-signal-list">
          {swingSignals.map((candidate, idx) => {
            const sig = candidate.signal;
            const score = candidate.score;
            const breakdown = candidate.breakdown;

            // Determine signal type label
            let strategyLabel = 'Unknown';
            if (sig.type === 'post_earnings_iv_crush') {
              strategyLabel = 'Post-Earnings IV Crush';
            } else if (sig.type === 'momentum_breakout_iv_lag') {
              strategyLabel = 'Momentum Breakout IV Lag';
            } else if (sig.type === 'panic_reversal') {
              strategyLabel = 'Panic Reversal';
            }

            return (
              <div key={idx} className={`swing-signal-card ${sig.side}`}>
                <div className="signal-header">
                  <div className="signal-title">
                    <span className="symbol">{sig.symbol}</span>
                    <span className={`side-badge ${sig.side}`}>{sig.side.toUpperCase()}</span>
                    <span className="composite-score" title="Composite score (0-100)">
                      {score}/100
                    </span>
                  </div>
                  <div className="strategy-label">{strategyLabel}</div>
                </div>

                <div className="option-details">
                  <div className="option-spec">
                    <span className="option-type">{sig.optionType}</span>
                    <span className="strike">${sig.strike?.toFixed(2)}</span>
                    <span className="expiry">exp {sig.expiry}</span>
                  </div>
                  <div className="option-metrics">
                    <span className="entry">Entry: ${sig.entryPrice?.toFixed(2)}</span>
                    <span className="delta">Δ {sig.delta?.toFixed(2)}</span>
                  </div>
                </div>

                <div className="risk-metrics">
                  <div className="levels">
                    <span className="stop">Stop: ${sig.stopLoss?.toFixed(2)}</span>
                    <span className="target">Target: ${sig.takeProfit?.toFixed(2)}</span>
                  </div>
                  <div className="r-r">R:R: {sig.riskRewardRatio?.toFixed(2)}</div>
                </div>

                <div className="score-breakdown">
                  <div className="breakdown-title">Score Breakdown:</div>
                  <div className="breakdown-grid">
                    <div className="breakdown-item">
                      <span className="label">Technical:</span>
                      <span className="value">{breakdown.technical}</span>
                    </div>
                    <div className="breakdown-item">
                      <span className="label">Momentum:</span>
                      <span className="value">{breakdown.momentum}</span>
                    </div>
                    <div className="breakdown-item">
                      <span className="label">Relative Strength:</span>
                      <span className="value">{breakdown.relativeStrength}</span>
                    </div>
                    <div className="breakdown-item">
                      <span className="label">IV/RV:</span>
                      <span className="value">{breakdown.ivRv}</span>
                    </div>
                    <div className="breakdown-item">
                      <span className="label">IV Skew:</span>
                      <span className="value">{breakdown.ivSkew}</span>
                    </div>
                    <div className="breakdown-item">
                      <span className="label">OTM Mispricing:</span>
                      <span className="value">{breakdown.otmMispricing}</span>
                    </div>
                    <div className="breakdown-item">
                      <span className="label">Liquidity:</span>
                      <span className="value">{breakdown.liquidity}</span>
                    </div>
                  </div>
                </div>

                {sig.reason && (
                  <div className="signal-reason" title="Signal reasoning">
                    {sig.reason}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
