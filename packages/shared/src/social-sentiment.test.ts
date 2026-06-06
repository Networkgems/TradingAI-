import { describe, it, expect } from 'vitest';
import { aggregateStockTwitsSentiment } from './index.js';
import type { StockTwitsMessage } from './index.js';

// Fixed clock so recency weighting is deterministic.
const NOW = Date.parse('2026-06-06T16:00:00.000Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

let nextId = 1;
function msg(sentiment: StockTwitsMessage['sentiment'], ageMin = 30): StockTwitsMessage {
  return { id: nextId++, createdAt: minutesAgo(ageMin), sentiment };
}

function bull(ageMin = 30) { return msg('Bullish', ageMin); }
function bear(ageMin = 30) { return msg('Bearish', ageMin); }
function untagged(ageMin = 30) { return msg(null, ageMin); }

describe('aggregateStockTwitsSentiment', () => {
  it('is deterministic given a fixed clock', () => {
    const messages = [bull(10), bear(20), bull(5)];
    const a = aggregateStockTwitsSentiment({ symbol: 'AAPL', messages, now: NOW });
    const b = aggregateStockTwitsSentiment({ symbol: 'AAPL', messages, now: NOW });
    expect(a).toEqual(b);
    expect(a.source).toBe('stocktwits');
    expect(a.symbol).toBe('AAPL');
  });

  it('uppercases the symbol and tags the window/source', () => {
    const r = aggregateStockTwitsSentiment({ symbol: 'aapl', messages: [], now: NOW });
    expect(r.symbol).toBe('AAPL');
    expect(r.window).toBe('24h');
    expect(r.source).toBe('stocktwits');
  });

  it('returns a neutral, zero aggregate for no messages', () => {
    const r = aggregateStockTwitsSentiment({ symbol: 'AAPL', messages: [], now: NOW });
    expect(r.netScore).toBe(0);
    expect(r.messageCount).toBe(0);
    expect(r.taggedCount).toBe(0);
    expect(r.tilt).toBe('neutral');
    expect(r.freshnessMinutes).toBe(0);
  });

  it('counts untagged messages as buzz but excludes them from the score', () => {
    const messages = [bull(10), untagged(10), untagged(10)];
    const r = aggregateStockTwitsSentiment({ symbol: 'AAPL', messages, now: NOW });
    expect(r.messageCount).toBe(3);
    expect(r.taggedCount).toBe(1);
    expect(r.bullishCount).toBe(1);
    expect(r.bearishCount).toBe(0);
    expect(r.netScore).toBe(1); // the lone tagged message is fully bullish
  });

  it('drives netScore bullish/bearish with the directional crowd', () => {
    const bullHeavy = aggregateStockTwitsSentiment({
      symbol: 'NVDA',
      messages: [bull(5), bull(5), bull(5), bull(5), bull(5), bear(5)],
      now: NOW,
    });
    expect(bullHeavy.netScore).toBeGreaterThan(0.25);
    expect(bullHeavy.tilt).toBe('bullish');

    const bearHeavy = aggregateStockTwitsSentiment({
      symbol: 'NVDA',
      messages: [bear(5), bear(5), bear(5), bear(5), bear(5), bull(5)],
      now: NOW,
    });
    expect(bearHeavy.netScore).toBeLessThan(-0.25);
    expect(bearHeavy.tilt).toBe('bearish');
  });

  it('forces neutral tilt below the minimum tagged-message floor', () => {
    // 4 unanimous bulls — netScore is +1 but below MIN_TAGGED_FOR_TILT (5).
    const r = aggregateStockTwitsSentiment({
      symbol: 'AAPL',
      messages: [bull(5), bull(5), bull(5), bull(5)],
      now: NOW,
    });
    expect(r.netScore).toBe(1);
    expect(r.taggedCount).toBe(4);
    expect(r.tilt).toBe('neutral');
  });

  it('forces neutral tilt when the newest tagged message is stale (>12h)', () => {
    const stale = 13 * 60; // 13h ago
    const r = aggregateStockTwitsSentiment({
      symbol: 'AAPL',
      messages: [bull(stale), bull(stale), bull(stale), bull(stale), bull(stale)],
      now: NOW,
    });
    expect(r.taggedCount).toBe(5);
    expect(r.freshnessMinutes).toBeGreaterThan(720);
    expect(r.tilt).toBe('neutral');
  });

  it('recency-weights fresh messages above stale ones', () => {
    // Fresh bulls + old bears: weighting should tip the net positive even though
    // the raw counts are balanced.
    const r = aggregateStockTwitsSentiment({
      symbol: 'TSLA',
      messages: [bull(5), bull(5), bull(5), bear(700), bear(700), bear(700)],
      now: NOW,
    });
    expect(r.bullishCount).toBe(3);
    expect(r.bearishCount).toBe(3);
    expect(r.netScore).toBeGreaterThan(0);
  });

  it('drops messages with unparseable timestamps without throwing', () => {
    const messages: StockTwitsMessage[] = [
      { id: 1, createdAt: 'not-a-date', sentiment: 'Bullish' },
      bull(10),
    ];
    const r = aggregateStockTwitsSentiment({ symbol: 'AAPL', messages, now: NOW });
    expect(r.messageCount).toBe(1);
    expect(r.bullishCount).toBe(1);
  });

  it('reports freshness as the age of the newest tagged message', () => {
    const r = aggregateStockTwitsSentiment({
      symbol: 'AAPL',
      messages: [bull(120), bear(45), bull(300)],
      now: NOW,
    });
    expect(r.freshnessMinutes).toBe(45);
  });
});
