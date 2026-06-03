// TRA-419 — NewsCard component extracted from App.tsx.
// TRA-227 — News tab card. Yahoo headlines render as a plain external link;
// QuantTrader research items render with a "Research" badge and an
// expand/collapse button that reveals the formatted markdown body. Identifiable
// via `bodyMarkdown` and the `kind` field set by the server.
import { useState } from 'react';
import type { NewsItem, NewsSentiment } from '@trading-app/shared';
import { timeAgo, researchKindLabel, renderResearchMarkdown } from '../lib/format';

// TRA-534 — pos/neg/neutral sentiment badge for a scored headline. Renders
// nothing for unscored items (older cache / research posts) so the card looks
// unchanged when no sentiment is present.
function SentimentBadge({ sentiment }: { sentiment?: NewsSentiment }) {
  if (!sentiment) return null;
  const label =
    sentiment.label === 'positive' ? 'Bullish'
    : sentiment.label === 'negative' ? 'Bearish'
    : 'Neutral';
  return (
    <span
      className={`sentiment-badge sentiment-${sentiment.label}`}
      title={`score ${sentiment.score.toFixed(2)} · confidence ${(sentiment.confidence * 100).toFixed(0)}% · ${sentiment.method}`}
    >
      {label}
    </span>
  );
}

export function NewsCard({ item }: { item: NewsItem }) {
  const isResearch = !!item.bodyMarkdown && item.source === 'QuantTrader';
  const [expanded, setExpanded] = useState(false);
  if (!isResearch) {
    return (
      <div className="news-card">
        <div className="signal-header">
          <span className="signal-symbol">
            {item.source}
            <SentimentBadge sentiment={item.sentiment} />
          </span>
          <span className="signal-time muted">{timeAgo(new Date(item.publishedAt).getTime())}</span>
        </div>
        <div style={{ padding: '0.5rem 0' }}>
          <a href={item.url} target="_blank" rel="noopener noreferrer"
             style={{ color: 'var(--blue)', textDecoration: 'none', fontWeight: 500 }}>
            {item.title}
          </a>
          {item.summary && (
            <p style={{ marginTop: '0.3rem', color: 'var(--muted)', fontSize: '0.75rem', lineHeight: 1.5 }}>
              {item.summary}
            </p>
          )}
        </div>
      </div>
    );
  }
  const kindLabel = researchKindLabel(item.kind);
  return (
    <div className="news-card research">
      <div className="signal-header">
        <span className="signal-symbol">
          <span className="research-badge">Research</span>
          {item.source}
          {kindLabel && <span className="research-kind">{kindLabel}</span>}
        </span>
        <span className="signal-time muted">{timeAgo(new Date(item.publishedAt).getTime())}</span>
      </div>
      <div style={{ padding: '0.5rem 0' }}>
        <button
          type="button"
          onClick={() => setExpanded(e => !e)}
          style={{
            background: 'none', border: 'none', padding: 0, cursor: 'pointer',
            color: 'var(--blue)', textDecoration: 'none', fontWeight: 500,
            fontSize: 'inherit', textAlign: 'left',
          }}
        >
          {item.title}
        </button>
        <div>
          <button
            type="button"
            className="research-toggle"
            onClick={() => setExpanded(e => !e)}
            aria-expanded={expanded}
          >
            {expanded ? 'Hide report' : 'Read report'}
          </button>
        </div>
        {expanded && (
          <div
            className="research-body"
            dangerouslySetInnerHTML={{ __html: renderResearchMarkdown(item.bodyMarkdown ?? '') }}
          />
        )}
      </div>
    </div>
  );
}
