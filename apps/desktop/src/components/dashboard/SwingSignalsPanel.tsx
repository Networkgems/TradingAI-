// TRA-4626 — Swing Signals panel displaying fusion engine candidates.
// Shows ranked swing signal candidates with composite scores (0-100) and
// breakdown across 8 dimensions: technical, momentum, mean reversion,
// relative strength, IV/RV, IV skew, OTM mispricing, liquidity.
//
// TRA-4706 — observe-only. The status line reads the pass's own summary, so an
// empty list says WHY it is empty (never ran / nothing readable / no setup).
// Stop and target are UNDERLYING levels; entry is the option premium.
import type { SwingScanSummary, SwingSignalCandidate } from '@trading-app/shared';
import { formatTime } from '../../lib/format';

const STRATEGY_LABEL: Record<SwingSignalCandidate['signal']['type'], string> = {
  post_earnings_iv_crush: 'Post-Earnings IV Crush',
  momentum_breakout_iv_lag: 'Momentum Breakout IV Lag',
  panic_reversal: 'Panic Reversal',
};

const BREAKDOWN_ROWS: Array<[keyof SwingSignalCandidate['breakdown'], string]> = [
  ['technical', 'Technical'],
  ['momentum', 'Momentum'],
  ['meanReversion', 'Mean Reversion'],
  ['relativeStrength', 'Relative Strength'],
  ['ivRv', 'IV/RV'],
  ['ivSkew', 'IV Skew'],
  ['otmMispricing', 'OTM Mispricing'],
  ['liquidity', 'Liquidity'],
];

/** Why the list looks the way it does, from the pass's own counts. */
export function swingScanStatus(summary: SwingScanSummary | null | undefined): string {
  if (!summary) return 'Scanner has not run (ENABLE_SWING_SIGNAL_SCANNER off, market closed, or first pass pending)';
  const unreadable = summary.dailySeriesUnreadable + summary.chainUnreadable + summary.ivUnreadable;
  const parts = [
    `Last scan ${formatTime(summary.at)}`,
    `${summary.symbolsScored}/${summary.symbolsConsidered} symbols scored`,
  ];
  if (unreadable > 0) {
    parts.push(`unreadable: ${summary.dailySeriesUnreadable} daily series · ${summary.chainUnreadable} chain · ${summary.ivUnreadable} IV`);
  }
  if (summary.earnings.unreadable > 0) parts.push(`earnings calendar unreadable for ${summary.earnings.unreadable}`);
  parts.push(`${summary.ranked} ranked`);
  return parts.join(' — ');
}

export function SwingSignalsPanel({
  swingSignals,
  summary,
}: {
  swingSignals: SwingSignalCandidate[];
  summary?: SwingScanSummary | null;
}) {
  return (
    <div className="swing-signals-panel">
      <div className="signals-toolbar">
        <span className="scan-status" title="Observe-only: these candidates never route an order">
          {swingScanStatus(summary)}
        </span>
      </div>
      {swingSignals.length === 0 ? (
        <div className="empty">
          {summary && summary.symbolsScored === 0
            ? 'No symbol could be scored — see the unreadable counts above.'
            : 'No swing setups in the latest pass.'}
        </div>
      ) : (
        <div className="swing-signal-list">
          {swingSignals.map((candidate) => {
            const sig = candidate.signal;
            const breakdown = candidate.breakdown;
            return (
              <div key={sig.id} className={`swing-signal-card ${sig.side}`}>
                <div className="signal-header">
                  <div className="signal-title">
                    <span className="symbol">{sig.symbol}</span>
                    <span className={`side-badge ${sig.side}`}>{sig.side.toUpperCase()}</span>
                    <span className="composite-score" title="Composite score (0-100) over the measured dimensions">
                      {candidate.score.toFixed(0)}/100
                    </span>
                  </div>
                  <div className="strategy-label">{STRATEGY_LABEL[sig.type]}</div>
                </div>

                <div className="option-details">
                  <div className="option-spec">
                    <span className="option-type">{sig.optionType}</span>
                    <span className="strike">${sig.strike.toFixed(2)}</span>
                    <span className="expiry">exp {sig.expiration}</span>
                  </div>
                  <div className="option-metrics">
                    <span className="entry" title="Option premium (mid)">Premium: ${sig.entryPrice.toFixed(2)}</span>
                    <span className="delta">Δ {sig.delta.toFixed(2)}</span>
                  </div>
                </div>

                <div className="risk-metrics" title="Underlying price levels">
                  <div className="levels">
                    <span className="spot">Underlying: ${sig.underlyingPrice.toFixed(2)}</span>
                    <span className="stop">Stop: ${sig.stopLoss.toFixed(2)}</span>
                    <span className="target">Target: ${sig.takeProfit.toFixed(2)}</span>
                  </div>
                  <div className="r-r">R:R (underlying): {sig.riskRewardRatio.toFixed(2)}</div>
                </div>

                <div className="score-breakdown">
                  <div className="breakdown-title">Score Breakdown:</div>
                  <div className="breakdown-grid">
                    {BREAKDOWN_ROWS.map(([key, label]) => {
                      const v = breakdown[key];
                      return (
                        <div key={key} className="breakdown-item">
                          <span className="label">{label}:</span>
                          <span className="value" title={v === null ? 'Not measured for this setup' : undefined}>
                            {v === null ? '—' : v.toFixed(0)}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
