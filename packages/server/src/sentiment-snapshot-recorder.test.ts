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

/**
 * TRA-2519 — the bug that zeroed 2026-07-27 and 2026-07-28 on bqb1.
 *
 * The scheduler's chain-record hook dedupes on IN-MEMORY state, so every restart
 * inside the 15:55–20:00 ET window re-fires the sweep (~50 times on 07-27 under
 * the TRA-2476 restart storm). The write was a blind `writeFile`, so the LAST
 * run of the day won — and the last run is the one most likely to open inside a
 * rate-limit cooldown, where the whole sweep is a ~3ms no-op returning `no_data`
 * for all 25 symbols.
 *
 * The instrument was the real problem: a partition reading `recorded: 0` looked
 * exactly the same whether the day never had data or whether a real capture had
 * been overwritten with nothing. These tests pin the ratchet that makes those two
 * states distinguishable AND makes the second one impossible.
 */
describe('recordSentimentSnapshot — same-day re-run must not destroy a capture (TRA-2519)', () => {
  it('keeps the earlier recorded read when a later sweep finds nothing', async () => {
    const first = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async (sym) => reading(sym, 0.42),
      outDir: tmpRoot,
      now: NOW,
    });
    expect(first.symbols.every((s) => s.outcome === 'recorded')).toBe(true);

    // Same ET day, breaker open: every fetch short-circuits to null.
    const second = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async () => null,
      describeUnavailable: () => 'breaker_open',
      outDir: tmpRoot,
      now: NOW,
    });

    // The sweep itself genuinely found nothing — that must stay visible...
    expect(second.swept.every((s) => s.outcome === 'no_data')).toBe(true);
    // ...but the PARTITION must still hold the good read.
    expect(second.symbols.every((s) => s.outcome === 'recorded')).toBe(true);
    expect(second.preservedFromPrior).toEqual(['AAPL', 'MSFT']);

    const parsed = JSON.parse(readFileSync(second.filePath, 'utf-8'));
    expect(parsed.symbols).toHaveLength(2);
    expect(parsed.symbols.every((s: { outcome: string }) => s.outcome === 'recorded')).toBe(true);
    expect(parsed.symbols[0].sentiment.netScore).toBe(0.42);
  });

  it('upgrades a no_data row when a later sweep does get the read', async () => {
    await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async (sym) => (sym === 'AAPL' ? null : reading(sym, 0.1)),
      outDir: tmpRoot,
      now: NOW,
    });

    const second = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async (sym) => reading(sym, sym === 'AAPL' ? 0.77 : 0.2),
      outDir: tmpRoot,
      now: NOW,
    });

    const aapl = second.symbols.find((s) => s.symbol === 'AAPL');
    expect(aapl?.outcome).toBe('recorded');
    expect(aapl?.sentiment?.netScore).toBe(0.77);
    expect(second.preservedFromPrior).toEqual([]);
  });

  it('does not let an error row overwrite a prior recorded read', async () => {
    await recordSentimentSnapshot({
      symbols: ['NVDA'],
      fetchSentiment: async (sym) => reading(sym, 0.5),
      outDir: tmpRoot,
      now: NOW,
    });

    const second = await recordSentimentSnapshot({
      symbols: ['NVDA'],
      fetchSentiment: async () => { throw new Error('stocktwits 429'); },
      outDir: tmpRoot,
      now: NOW,
    });

    expect(second.symbols[0].outcome).toBe('recorded');
    expect(second.symbols[0].sentiment?.netScore).toBe(0.5);
  });

  it('carries forward a prior symbol dropped from the current universe', async () => {
    await recordSentimentSnapshot({
      symbols: ['AAPL', 'TSLA'],
      fetchSentiment: async (sym) => reading(sym, 0.3),
      outDir: tmpRoot,
      now: NOW,
    });

    // Universe shrinks mid-day (e.g. SENTIMENT_WATCHLIST edited) — TSLA's real
    // read must survive rather than vanishing from the partition.
    const second = await recordSentimentSnapshot({
      symbols: ['AAPL'],
      fetchSentiment: async (sym) => reading(sym, 0.9),
      outDir: tmpRoot,
      now: NOW,
    });

    expect(second.symbols.map((s) => s.symbol).sort()).toEqual(['AAPL', 'TSLA']);
    expect(second.symbols.find((s) => s.symbol === 'TSLA')?.sentiment?.netScore).toBe(0.3);
    expect(second.symbols.find((s) => s.symbol === 'AAPL')?.sentiment?.netScore).toBe(0.9);
  });

  it('records WHY a row is unavailable so a zero day is attributable', async () => {
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async () => null,
      describeUnavailable: (sym) => (sym === 'AAPL' ? 'breaker_open' : 'fetch_failed'),
      outDir: tmpRoot,
      now: NOW,
    });

    expect(result.symbols.map((s) => s.reason)).toEqual(['breaker_open', 'fetch_failed']);
    const meta = JSON.parse(readFileSync(join(tmpRoot, result.date, '_meta.json'), 'utf-8'));
    expect(meta.reasons).toEqual({ breaker_open: 1, fetch_failed: 1 });
  });

  it('meta exposes the sweep-vs-partition gap the old overwrite hid', async () => {
    await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async (sym) => reading(sym, 0.4),
      outDir: tmpRoot,
      now: NOW,
    });
    const second = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async () => null,
      outDir: tmpRoot,
      now: NOW,
    });

    const meta = JSON.parse(readFileSync(join(tmpRoot, second.date, '_meta.json'), 'utf-8'));
    expect(meta.recorded).toBe(2);      // what the day HAS
    expect(meta.sweptRecorded).toBe(0); // what THIS run found
    expect(meta.preservedFromPrior).toEqual(['AAPL', 'MSFT']);
  });
});

/**
 * TRA-2519 ask #2 — a sweep that opens inside an already-open rate-limit
 * cooldown returns `no_data` for the entire universe in ~3ms and, before this,
 * never looked again. The breaker on bqb1 CYCLES (68 opens across 07-27/07-28,
 * each the 5-minute default) rather than latching, so the very next window
 * would have served data.
 */
describe('recordSentimentSnapshot — bounded half-open retry (TRA-2519)', () => {
  it('recovers symbols on a later pass once the breaker closes', async () => {
    const slept: number[] = [];
    let breakerOpen = true;

    const result = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async (sym) => (breakerOpen ? null : reading(sym, 0.6)),
      describeUnavailable: () => 'breaker_open',
      outDir: tmpRoot,
      now: NOW,
      retry: {
        maxAttempts: 2,
        budgetMs: 12 * 60_000,
        nextDelayMs: () => 5 * 60_000,
        sleep: async (ms) => { slept.push(ms); breakerOpen = false; },
      },
    });

    expect(slept).toEqual([5 * 60_000]);
    expect(result.attempts).toBe(2);
    expect(result.symbols.every((s) => s.outcome === 'recorded')).toBe(true);
    expect(result.symbols.every((s) => s.attempt === 2)).toBe(true);
  });

  it('does not retry when the first pass already recorded everything', async () => {
    const slept: number[] = [];
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL'],
      fetchSentiment: async (sym) => reading(sym, 0.2),
      outDir: tmpRoot,
      now: NOW,
      retry: {
        maxAttempts: 2,
        budgetMs: 12 * 60_000,
        nextDelayMs: () => 5 * 60_000,
        sleep: async (ms) => { slept.push(ms); },
      },
    });

    expect(slept).toEqual([]);
    expect(result.attempts).toBe(1);
  });

  it('clamps a long cooldown to the remaining budget and stops', async () => {
    const slept: number[] = [];
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL'],
      fetchSentiment: async () => null,
      outDir: tmpRoot,
      now: NOW,
      retry: {
        maxAttempts: 5,
        budgetMs: 60_000,
        // A breaker deadline an hour out must NOT park the sweep for an hour —
        // the watchdog can kill this process at any moment (TRA-2476).
        nextDelayMs: () => 60 * 60_000,
        sleep: async (ms) => { slept.push(ms); },
      },
    });

    expect(slept).toEqual([60_000]);
    expect(result.attempts).toBe(2);
    expect(result.symbols[0].outcome).toBe('no_data');
  });

  it('stops retrying when the policy declines a next delay', async () => {
    const slept: number[] = [];
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL'],
      fetchSentiment: async () => null,
      outDir: tmpRoot,
      now: NOW,
      retry: {
        maxAttempts: 3,
        budgetMs: 12 * 60_000,
        nextDelayMs: () => null,
        sleep: async (ms) => { slept.push(ms); },
      },
    });

    expect(slept).toEqual([]);
    expect(result.attempts).toBe(1);
  });

  it('never downgrades a pass-1 read when a retry pass regresses', async () => {
    let call = 0;
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      // AAPL reads on pass 1; MSFT does not, forcing a retry pass in which the
      // feed has gone fully dark. AAPL must keep its pass-1 value.
      fetchSentiment: async (sym) => {
        call += 1;
        if (call <= 2) return sym === 'AAPL' ? reading(sym, 0.55) : null;
        return null;
      },
      outDir: tmpRoot,
      now: NOW,
      retry: {
        maxAttempts: 1,
        budgetMs: 60_000,
        nextDelayMs: () => 1_000,
        sleep: async () => {},
      },
    });

    expect(result.symbols.find((s) => s.symbol === 'AAPL')?.sentiment?.netScore).toBe(0.55);
    expect(result.symbols.find((s) => s.symbol === 'MSFT')?.outcome).toBe('no_data');
  });

  // TRA-2519 — a sweep the watchdog kills mid-pass must leave an attributable
  // artifact, not a 404. The partition is stamped with an all-`sweep_incomplete`
  // skeleton BEFORE the first fetch.
  it('writes a sweep_incomplete skeleton before the first fetch', async () => {
    let skeletonAtFirstFetch: unknown;
    let metaAtFirstFetch: unknown;
    await recordSentimentSnapshot({
      symbols: ['AAPL', 'MSFT'],
      fetchSentiment: async (sym) => {
        if (sym === 'AAPL' && skeletonAtFirstFetch === undefined) {
          skeletonAtFirstFetch = JSON.parse(
            readFileSync(join(tmpRoot, '2026-05-15', 'sentiment.json'), 'utf-8'),
          );
          metaAtFirstFetch = JSON.parse(
            readFileSync(join(tmpRoot, '2026-05-15', '_meta.json'), 'utf-8'),
          );
        }
        return reading(sym, 0.2);
      },
      outDir: tmpRoot,
      now: NOW,
    });

    const skeleton = skeletonAtFirstFetch as { symbols: Array<Record<string, unknown>> };
    expect(skeleton.symbols.map((s) => s['symbol'])).toEqual(['AAPL', 'MSFT']);
    expect(skeleton.symbols.every((s) => s['outcome'] === 'no_data')).toBe(true);
    expect(skeleton.symbols.every((s) => s['reason'] === 'sweep_incomplete')).toBe(true);
    // attempts: 0 is the "no completed sweep ever wrote this" discriminator.
    const meta = metaAtFirstFetch as Record<string, unknown>;
    expect(meta['attempts']).toBe(0);
    expect(meta['reasons']).toEqual({ sweep_incomplete: 2 });

    // The completed sweep replaces every skeleton row and stamps attempts >= 1.
    const final = JSON.parse(readFileSync(join(tmpRoot, '2026-05-15', 'sentiment.json'), 'utf-8'));
    expect(final.symbols.every((s: Record<string, unknown>) => s['outcome'] === 'recorded')).toBe(true);
    const finalMeta = JSON.parse(readFileSync(join(tmpRoot, '2026-05-15', '_meta.json'), 'utf-8'));
    expect(finalMeta.attempts).toBeGreaterThanOrEqual(1);
    expect(finalMeta.reasons).toEqual({});
  });

  it('does not overwrite an existing partition with the skeleton', async () => {
    // First run banks a real AAPL read.
    await recordSentimentSnapshot({
      symbols: ['AAPL'],
      fetchSentiment: async (sym) => reading(sym, 0.9),
      outDir: tmpRoot,
      now: NOW,
    });

    // Second run of the same day: at first-fetch time the partition must still
    // hold the prior real row, not a skeleton downgrade.
    let partitionAtFirstFetch: unknown;
    const result = await recordSentimentSnapshot({
      symbols: ['AAPL'],
      fetchSentiment: async () => {
        partitionAtFirstFetch ??= JSON.parse(
          readFileSync(join(tmpRoot, '2026-05-15', 'sentiment.json'), 'utf-8'),
        );
        return null;
      },
      outDir: tmpRoot,
      now: NOW,
    });

    const seen = partitionAtFirstFetch as { symbols: Array<Record<string, unknown>> };
    expect(seen.symbols[0]?.['outcome']).toBe('recorded');
    // And the ratchet still preserves it against the null sweep.
    expect(result.symbols[0]?.outcome).toBe('recorded');
    expect(result.preservedFromPrior).toEqual(['AAPL']);
  });
});
