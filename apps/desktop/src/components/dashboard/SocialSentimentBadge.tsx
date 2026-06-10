// TRA-745 — render the per-symbol StockTwits social-sentiment read surfaced by
// `GET /api/analysis/breadth/:symbol` (the `social` half). Shows the crowd +
// curated tilt alongside price/technical: a colored tilt chip with the signed
// netScore, a tagged/total buzz count, message freshness, and a "curated" marker
// when the higher-weight followed-account lane contributed (TRA-603). Degrades to
// a quiet placeholder (no error) when the feed is null — cold cache / throttled —
// using the `notes.social` reason the route returns.
import type { SocialSentiment } from '@trading-app/shared';

const TILT_GLYPH: Record<SocialSentiment['tilt'], string> = {
  bullish: '▲',
  bearish: '▼',
  neutral: '•',
};

/** Compact age label: minutes under an hour, then hours, then days. */
function formatFreshness(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'now';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Signed two-decimal score, e.g. `+0.42` / `-0.30` / `0.00`. */
function formatScore(netScore: number): string {
  return `${netScore >= 0 ? '+' : ''}${netScore.toFixed(2)}`;
}

export function SocialSentimentBadge({
  social,
  note,
}: {
  social: SocialSentiment | null;
  note?: string;
}) {
  // Null / throttled feed → quiet placeholder driven by notes.social.
  if (!social) {
    return (
      <span className="social-cell social-cell-empty" title={note ?? 'No social data yet'}>
        —
      </span>
    );
  }

  const { tilt, netScore, taggedCount, messageCount, freshnessMinutes, curatedCount } = social;
  const tiltLabel = tilt.charAt(0).toUpperCase() + tilt.slice(1);
  const curated = curatedCount > 0;

  return (
    <span className="social-cell">
      <span
        className={`social-tilt social-${tilt}`}
        aria-label={`Social tilt ${tiltLabel}, score ${formatScore(netScore)}`}
        title={`Crowd tilt ${tiltLabel} · net score ${formatScore(netScore)} over ${messageCount} messages (${taggedCount} tagged)`}
      >
        {TILT_GLYPH[tilt]} {formatScore(netScore)}
      </span>
      {curated && (
        <span
          className="social-curated"
          title={`${curatedCount} curated analyst post${curatedCount === 1 ? '' : 's'} contributed (higher weight)`}
        >
          ★ curated
        </span>
      )}
      <span
        className="social-meta"
        title={`${taggedCount} tagged of ${messageCount} messages · newest ${formatFreshness(freshnessMinutes)} ago`}
      >
        {taggedCount}/{messageCount} · {formatFreshness(freshnessMinutes)}
      </span>
    </span>
  );
}
