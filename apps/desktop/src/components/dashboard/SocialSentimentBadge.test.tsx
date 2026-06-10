// TRA-745 — render tests for the social-sentiment watchlist badge: the
// populated read (tilt chip + score + buzz + freshness + curated marker) and the
// null/throttled placeholder driven by notes.social.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { SocialSentiment } from '@trading-app/shared';
import { SocialSentimentBadge } from './SocialSentimentBadge';

const base: SocialSentiment = {
  symbol: 'NVDA',
  asOf: '2026-06-09T16:00:00.000Z',
  window: '24h',
  source: 'stocktwits',
  netScore: 0.42,
  bullishCount: 8,
  bearishCount: 4,
  taggedCount: 12,
  curatedCount: 0,
  messageCount: 30,
  freshnessMinutes: 5,
  tilt: 'bullish',
};

describe('SocialSentimentBadge', () => {
  it('renders the populated bullish read with score, buzz, and freshness', () => {
    render(<SocialSentimentBadge social={base} />);
    expect(screen.getByText(/\+0\.42/)).toBeInTheDocument();
    // tagged/total buzz and freshness.
    expect(screen.getByText(/12\/30/)).toBeInTheDocument();
    expect(screen.getByText(/5m/)).toBeInTheDocument();
    // No curated lane contributed → no curated marker.
    expect(screen.queryByText(/curated/i)).not.toBeInTheDocument();
  });

  it('shows the curated marker when the curated lane contributed', () => {
    render(<SocialSentimentBadge social={{ ...base, curatedCount: 3 }} />);
    expect(screen.getByText(/curated/i)).toBeInTheDocument();
  });

  it('renders a negative score for a bearish tilt', () => {
    render(
      <SocialSentimentBadge
        social={{ ...base, tilt: 'bearish', netScore: -0.31, bullishCount: 4, bearishCount: 8 }}
      />,
    );
    expect(screen.getByText(/-0\.31/)).toBeInTheDocument();
  });

  it('renders a quiet placeholder (no error) when social is null', () => {
    const { container } = render(
      <SocialSentimentBadge social={null} note="social feed cold — no messages cached yet" />,
    );
    const empty = container.querySelector('.social-cell-empty');
    expect(empty).toBeInTheDocument();
    expect(empty).toHaveTextContent('—');
    expect(empty).toHaveAttribute('title', 'social feed cold — no messages cached yet');
  });

  it('falls back to a default title when social is null with no note', () => {
    const { container } = render(<SocialSentimentBadge social={null} />);
    expect(container.querySelector('.social-cell-empty')).toHaveAttribute(
      'title',
      'No social data yet',
    );
  });
});
