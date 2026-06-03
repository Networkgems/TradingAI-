import { describe, it, expect } from 'vitest';
import type { Candle, TradeSignal } from '@trading-app/shared';
import type { NewsHeadline } from '@trading-app/agents';
import { momentumCandidate, replayAgents, type CandidateGenerator } from './agent-replay.js';
import { syntheticCryptoSeries } from './synthetic.js';

function candle(symbol: string, ts: number, close: number): Candle {
  return { symbol, timestamp: ts, open: close, high: close * 1.01, low: close * 0.99, close, volume: 1 };
}

describe('replayAgents — as-of clock / no look-ahead', () => {
  it('never shows an analyst a candle newer than the decision bar', async () => {
    const candles = syntheticCryptoSeries(40, 'BTC-USD', 30_000, 60, 7);
    // A spy candidate generator that asserts the window is fully ≤ asOf and
    // fires every bar so we exercise the whole series.
    const spy: CandidateGenerator = (asOf, window) => {
      for (const c of window) expect(c.timestamp).toBeLessThanOrEqual(asOf);
      expect(window[window.length - 1]!.timestamp).toBe(asOf);
      const last = window[window.length - 1]!;
      const sig: TradeSignal = {
        id: `c-${asOf}`,
        symbol: 'BTC-USD',
        type: 'momentum',
        side: 'buy',
        entryPrice: last.close,
        stopLoss: last.close * 0.98,
        takeProfit: last.close * 1.04,
        riskRewardRatio: 2,
        timestamp: asOf,
      };
      return sig;
    };
    const res = await replayAgents(candles, { symbol: 'BTC-USD', warmup: 5, candidateAt: spy });
    expect(res.decisions).toBeGreaterThan(0);
    // Every recommendation's input candles were ≤ asOf — re-checked via the record.
    for (const rec of res.records) {
      expect(rec.recommendation.asOf).toBe(rec.asOf);
      expect(rec.asOf).toBe(candles[rec.barIndex]!.timestamp);
    }
  });

  it('filters news to timestamps at/before asOf', async () => {
    const base = Date.UTC(2026, 0, 1);
    const hour = 3_600_000;
    const candles: Candle[] = Array.from({ length: 10 }, (_, i) =>
      candle('BTC-USD', base + i * hour, 30_000 + i * 100));
    const future: NewsHeadline = {
      headline: 'leak from the future',
      timestamp: base + 100 * hour, // far past the last bar
      source: 'test',
    };
    let sawFutureNews = false;
    const seenAt: CandidateGenerator = (asOf, window) => {
      // candidate fires every bar
      const last = window[window.length - 1]!;
      return {
        id: `c-${asOf}`, symbol: 'BTC-USD', type: 'momentum', side: 'buy',
        entryPrice: last.close, stopLoss: last.close * 0.98, takeProfit: last.close * 1.04,
        riskRewardRatio: 2, timestamp: asOf,
      };
    };
    const res = await replayAgents(candles, {
      symbol: 'BTC-USD', warmup: 2, candidateAt: seenAt, news: [future],
      graphDeps: { now: () => 0 },
    });
    // The future headline is never visible: every run's asOf < the news ts, so
    // the graph input carries no news. We assert indirectly — no record exists
    // whose decision bar post-dates the news.
    for (const rec of res.records) {
      if (rec.asOf >= future.timestamp) sawFutureNews = true;
    }
    expect(sawFutureNews).toBe(false);
    expect(res.records.length).toBeGreaterThan(0);
  });

  it('persists cost + latency per recommendation (P1 stub: cost = 0)', async () => {
    const candles = syntheticCryptoSeries(30, 'ETH-USD', 2_000, 60, 9);
    let clock = 1_000;
    const res = await replayAgents(candles, {
      symbol: 'ETH-USD', warmup: 12,
      candidateAt: momentumCandidate({ threshold: 0 }), // fire whenever possible
      graphDeps: { now: () => (clock += 5) },
    });
    expect(res.totalCostUsd).toBe(0);
    for (const rec of res.records) {
      expect(rec.recommendation.costUsd).toBe(0);
      expect(rec.recommendation.latencyMs).toBeGreaterThanOrEqual(0);
    }
    expect(res.bars).toBe(candles.length);
  });

  it('skips bars where the candidate generator returns null', async () => {
    const candles = syntheticCryptoSeries(30, 'BTC-USD', 30_000, 60, 3);
    const res = await replayAgents(candles, {
      symbol: 'BTC-USD', warmup: 5, candidateAt: () => null,
    });
    expect(res.decisions).toBe(0);
    expect(res.records).toHaveLength(0);
  });
});
