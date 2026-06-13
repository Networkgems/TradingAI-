import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SocialSentiment } from '@trading-app/shared';
import { recordSentimentSnapshot } from './sentiment-snapshot-recorder.js';

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), 'sentiment-recorder-test-'));
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

function reading(symbol: string, netScore: number, over: Partial<SocialSentiment> = {}): SocialSentiment {
  return {
    symbol,
    asOf: '2026-05-15T19:55:00.000Z',
    window: '24h',
    source: 'stocktwits',
    netScore,
    bullishCount: 8,
    bearishCount: 2,
    taggedCount: 10,
    curatedCount: 1,
    messageCount: 25,
    freshnessMinutes: 12,
    tilt: netScore >= 0.25 ? 'bullish' : netScore <= -0.25 ? 'bearish' : 'neutral',
    ...over,
  };
}

const NOW = () => Date.parse('2026-05-15T19:55:00Z');

describe('recordSentimentSnapshot', () => {
  it('writes a date-partitioned sentiment.json with one row per symbol', async () => {
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL', 'msft'],
      fetchSentiment: async (sym) => reading(sym, sym === 'AAPL' ? 0.42 : -0.31),
      outDir: tmpRoot,
      now: NOW,
    });

    expect(result.date).toBe('2026-05-15');
    expect(result.symbols.map((s) => s.symbol)).toEqual(['AAPL', 'MSFT']);
    expect(result.symbols.every((s) => s.outcome === 'recorded')).toBe(true);

    const file = join(tmpRoot, result.date, 'sentiment.json');
    expect(existsSync(file)).toBe(true);
    const parsed = JSON.parse(readFileSync(file, 'utf-8'));
    expect(parsed.date).toBe('2026-05-15');
    expect(parsed.symbols).toHaveLength(2);
    expect(parsed.symbols[0].symbol).toBe('AAPL');
    expect(parsed.symbols[0].sentiment.netScore).toBe(0.42);
    expect(parsed.symbols[1].sentiment.tilt).toBe('bearish');
  });

  it('records a null fetch as no_data without a sentiment payload', async () => {
    const result = await recordSentimentSnapshot({
      symbols: ['NVDA'],
      fetchSentiment: async () => null,
      outDir: tmpRoot,
      now: NOW,
    });

    expect(result.symbols[0].outcome).toBe('no_data');
    expect(result.symbols[0].sentiment).toBeNull();
  });

  it('isolates a throwing symbol as error and keeps recording the rest', async () => {
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL', 'BAD', 'MSFT'],
      fetchSentiment: async (sym) => {
        if (sym === 'BAD') throw new Error('stocktwits 429');
        return reading(sym, 0.3);
      },
      outDir: tmpRoot,
      now: NOW,
    });

    const bad = result.symbols.find((s) => s.symbol === 'BAD');
    expect(bad?.outcome).toBe('error');
    expect(bad?.errorMessage).toContain('429');
    expect(result.symbols.filter((s) => s.outcome === 'recorded')).toHaveLength(2);
  });

  it('writes a _meta.json summarising the run', async () => {
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT', 'NVDA'],
      fetchSentiment: async (sym) => (sym === 'NVDA' ? null : reading(sym, 0.2)),
      outDir: tmpRoot,
      now: NOW,
    });

    const meta = JSON.parse(readFileSync(join(tmpRoot, result.date, '_meta.json'), 'utf-8'));
    expect(meta.symbolCount).toBe(3);
    expect(meta.recorded).toBe(2);
    expect(meta.noData).toBe(1);
    expect(meta.errored).toBe(0);
  });
});
