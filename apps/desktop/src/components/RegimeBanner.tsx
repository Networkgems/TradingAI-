// TRA-419 — RegimeBanner component extracted from App.tsx.
// TRA-389 — market-review regime banner for the Stocks dashboard. Renders the
// GREEN / YELLOW / RED regime classified by the TRA-386 review plus the list
// of strategies the regime gates currently suppress. Returns null when the
// gate-consumption flag is off (or no review has been generated yet) so the
// banner only appears once an operator has opted into regime gating.
import type { EngineMarketReviewState } from '@trading-app/shared';

export function RegimeBanner({ review }: { review?: EngineMarketReviewState }) {
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
