import { describe, it, expect } from 'vitest';
import {
  scoreNewsSentiment,
  aggregateSymbolSentiment,
  newsMentionsSymbol,
  SENTIMENT_METHOD,
} from './index.js';
import type { NewsItem } from './index.js';

// Fixed clock so recency weighting is deterministic (acceptance #1).
const NOW = Date.parse('2026-06-02T16:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

function item(partial: Partial<NewsItem> & { title: string }): NewsItem {
  return {
    url: `https://example.com/${encodeURIComponent(partial.title)}`,
    source: 'Test Wire',
    publishedAt: minutesAgo(30),
    ...partial,
  };
}

describe('scoreNewsSentiment (lexicon-v1)', () => {
  it('tags method and is deterministic', () => {
    const a = scoreNewsSentiment({ title: 'Apple shares surge to record high' });
    const b = scoreNewsSentiment({ title: 'Apple shares surge to record high' });
    expect(a).toEqual(b);
    expect(a.method).toBe(SENTIMENT_METHOD);
  });

  it('scores a clearly positive headline positive (acceptance #3)', () => {
    const s = scoreNewsSentiment({ title: 'NVIDIA stock soars after blowout earnings beat' });
    expect(s.label).toBe('positive');
    expect(s.score).toBeGreaterThan(0);
    expect(s.confidence).toBeGreaterThan(0);
  });

  it('scores a clearly negative headline negative', () => {
    const s = scoreNewsSentiment({ title: 'Tesla shares plunge after analyst downgrade and earnings miss' });
    expect(s.label).toBe('negative');
    expect(s.score).toBeLessThan(0);
  });

  it('returns neutral, zero-confidence when no lexicon tokens match', () => {
    const s = scoreNewsSentiment({ title: 'Company schedules annual shareholder meeting for Tuesday' });
    expect(s).toEqual({ score: 0, label: 'neutral', confidence: 0, method: SENTIMENT_METHOD });
  });

  it('weights the title 2x over the summary', () => {
    const titlePos = scoreNewsSentiment({ title: 'shares surge', summary: 'shares plunge' });
    const titleNeg = scoreNewsSentiment({ title: 'shares plunge', summary: 'shares surge' });
    expect(titlePos.score).toBeGreaterThan(0);
    expect(titleNeg.score).toBeLessThan(0);
    // golden: title 'surge' (+0.85, w2) + summary 'plunge' (-0.9, w1) → 0.8/3 = 0.2667
    expect(titlePos.score).toBe(0.2667);
    // golden: title 'plunge' (-0.9, w2) + summary 'surge' (+0.85, w1) → -0.95/3 = -0.3167
    expect(titleNeg.score).toBe(-0.3167);
  });

  it('flips polarity under negation', () => {
    const plain = scoreNewsSentiment({ title: 'earnings beat expectations' });
    const negated = scoreNewsSentiment({ title: 'earnings did not beat expectations' });
    expect(plain.label).toBe('positive');
    expect(negated.score).toBeLessThan(plain.score);
  });

  it('confidence scales with matched-token count', () => {
    const one = scoreNewsSentiment({ title: 'stock gains' });
    const many = scoreNewsSentiment({ title: 'stock surges, beats, gains and rallies strongly' });
    expect(many.confidence).toBeGreaterThan(one.confidence);
    expect(many.confidence).toBeLessThanOrEqual(1);
  });
});

describe('newsMentionsSymbol', () => {
  it('matches the ticker as a whole token', () => {
    expect(newsMentionsSymbol({ title: 'AAPL hits new high' }, 'AAPL')).toBe(true);
    expect(newsMentionsSymbol({ title: 'see the chapter on apples' }, 'AAPL')).toBe(false);
  });

  it('matches a company-name alias', () => {
    expect(newsMentionsSymbol({ title: 'Apple unveils new chip' }, 'AAPL', ['apple'])).toBe(true);
  });
});

describe('aggregateSymbolSentiment', () => {
  it('positive recent coverage ⇒ bullish tilt, netScore > 0 (acceptance #3)', () => {
    const news: NewsItem[] = [
      item({ title: 'AAPL shares surge to record high on strong demand', publishedAt: minutesAgo(20) }),
      item({ title: 'Apple beats earnings, raises guidance', publishedAt: minutesAgo(90) }),
    ];
    const agg = aggregateSymbolSentiment({ symbol: 'AAPL', names: ['apple'], news, now: NOW });
    expect(agg.articleCount).toBe(2);
    expect(agg.netScore).toBeGreaterThan(0);
    expect(agg.tilt).toBe('bullish');
    expect(agg.window).toBe('24h');
    expect(agg.topHeadlines.length).toBe(2);
  });

  it('mixed coverage is recency-weighted (golden, acceptance #3)', () => {
    // Fresh negative (10m) should outweigh older positive (8h) via 6h half-life.
    const news: NewsItem[] = [
      item({ title: 'TSLA stock plunges on demand fears', publishedAt: minutesAgo(10) }),
      item({ title: 'Tesla shares rally to new high', publishedAt: minutesAgo(480) }),
    ];
    const agg = aggregateSymbolSentiment({ symbol: 'TSLA', names: ['tesla'], news, now: NOW });
    // score(plunge|fears) weight ~ at 10m ≈ 1.0 ; score(rally|high) at 8h ≈ 0.397
    // weighted mean is dominated by the fresh negative.
    expect(agg.netScore).toBeLessThan(0);
    expect(agg.tilt).toBe('bearish');
    expect(agg.netScore).toBe(goldenMixed());
  });

  it('stale-only coverage ⇒ neutral tilt (acceptance #3)', () => {
    const news: NewsItem[] = [
      item({ title: 'NVDA shares surge to record high', publishedAt: minutesAgo(900) }), // 15h old
      item({ title: 'Nvidia rallies on strong demand', publishedAt: minutesAgo(800) }),  // >12h old
    ];
    const agg = aggregateSymbolSentiment({ symbol: 'NVDA', names: ['nvidia'], news, now: NOW });
    expect(agg.freshnessMinutes).toBeGreaterThan(720);
    expect(agg.tilt).toBe('neutral');
  });

  it('single article ⇒ neutral tilt regardless of score (articleCount < 2)', () => {
    const news: NewsItem[] = [
      item({ title: 'AMD shares soar on blowout earnings', publishedAt: minutesAgo(15) }),
    ];
    const agg = aggregateSymbolSentiment({ symbol: 'AMD', names: ['advanced micro'], news, now: NOW });
    expect(agg.articleCount).toBe(1);
    expect(agg.netScore).toBeGreaterThan(0);
    expect(agg.tilt).toBe('neutral');
  });

  it('no mapped articles ⇒ empty neutral aggregate', () => {
    const news: NewsItem[] = [item({ title: 'Microsoft launches new product' })];
    const agg = aggregateSymbolSentiment({ symbol: 'AAPL', names: ['apple'], news, now: NOW });
    expect(agg).toEqual({
      symbol: 'AAPL', asOf: new Date(NOW).toISOString(), window: '24h',
      netScore: 0, articleCount: 0, freshnessMinutes: 0, tilt: 'neutral', topHeadlines: [],
    });
  });

  it('is deterministic given a fixed clock (acceptance #1)', () => {
    const news: NewsItem[] = [
      item({ title: 'AAPL surges', publishedAt: minutesAgo(20) }),
      item({ title: 'Apple gains', publishedAt: minutesAgo(120) }),
    ];
    const a = aggregateSymbolSentiment({ symbol: 'AAPL', names: ['apple'], news, now: NOW });
    const b = aggregateSymbolSentiment({ symbol: 'AAPL', names: ['apple'], news, now: NOW });
    expect(a).toEqual(b);
  });
});

// Golden value for the mixed fixture, computed from the documented formula so
// the assertion documents intent rather than echoing the implementation.
function goldenMixed(): number {
  const round4 = (v: number) => Math.round(v * 1e4) / 1e4;
  // 'TSLA stock plunges on demand fears': plunge -0.9, fears -0.6 (title w=2)
  const neg = (-0.9 * 2 + -0.6 * 2) / (2 + 2); // -0.75
  // 'Tesla shares rally to new high': rally 0.7, high 0.35 (title w=2)
  const pos = (0.7 * 2 + 0.35 * 2) / (2 + 2); // 0.525
  const wNeg = Math.pow(0.5, (10 / 60) / 6);
  const wPos = Math.pow(0.5, (480 / 60) / 6);
  const negS = round4(neg);
  const posS = round4(pos);
  return round4((negS * wNeg + posS * wPos) / (wNeg + wPos));
}
