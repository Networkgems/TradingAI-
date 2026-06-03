import { describe, it, expect } from 'vitest';
import { validateAnalystReport, type Candle } from '@trading-app/shared';
import { runAnalysts, technicalAnalyst, newsSentimentAnalyst } from './analysts.js';
import type { AgentGraphInput } from './types.js';

function candles(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    symbol: 'AAA', timestamp: 1000 + i * 60_000, open: c, high: c * 1.01, low: c * 0.99, close: c, volume: 100,
  }));
}

const asOf = 2_000_000;

describe('analyst tier (TRA-529 §3.1 deterministic fakes)', () => {
  it('every analyst returns a schema-valid report', () => {
    const input: AgentGraphInput = {
      symbol: 'AAA', asOf,
      candles: candles(Array.from({ length: 20 }, (_, i) => 100 + i)),
      candidateSignal: null,
      fundamentals: { peRatio: 15, revenueGrowth: 0.25, netMargin: 0.18, nextEarningsInDays: 12 },
      news: [{ headline: 'beat', timestamp: asOf - 1000, source: 'wire', sentiment: 0.6 }],
    };
    for (const r of runAnalysts(input)) {
      expect(validateAnalystReport(r)).toEqual([]);
      expect(r.stance).toBeGreaterThanOrEqual(-1);
      expect(r.stance).toBeLessThanOrEqual(1);
      expect(r.confidence).toBeGreaterThanOrEqual(0);
      expect(r.confidence).toBeLessThanOrEqual(1);
    }
  });

  it('technical analyst is bullish on an uptrend, bearish on a downtrend', () => {
    const up = technicalAnalyst({ symbol: 'AAA', asOf, candidateSignal: null, candles: candles(Array.from({ length: 20 }, (_, i) => 100 + i * 2)) });
    const down = technicalAnalyst({ symbol: 'AAA', asOf, candidateSignal: null, candles: candles(Array.from({ length: 20 }, (_, i) => 140 - i * 2)) });
    expect(up.stance).toBeGreaterThan(0.1);
    expect(down.stance).toBeLessThan(-0.1);
  });

  it('news analyst ignores headlines published after asOf (no look-ahead, §3.1)', () => {
    const r = newsSentimentAnalyst({
      symbol: 'AAA', asOf, candidateSignal: null, candles: candles([100, 101, 102]),
      news: [
        { headline: 'future bad news', timestamp: asOf + 10_000, source: 'wire', sentiment: -1 },
      ],
    });
    // The only headline is in the future → treated as no data → neutral, low confidence.
    expect(r.stance).toBe(0);
    expect(r.confidence).toBeLessThanOrEqual(0.1);
  });

  it('abstains with low confidence when fundamentals/news are absent', () => {
    const [, fundamental, news] = runAnalysts({ symbol: 'AAA', asOf, candidateSignal: null, candles: candles([100, 101, 102]) });
    expect(fundamental.confidence).toBeLessThanOrEqual(0.1);
    expect(news.confidence).toBeLessThanOrEqual(0.1);
  });
});
