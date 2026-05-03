/**
 * TRA-267 — coverage for the Coinbase 4H feed.
 *
 * Two seams under test:
 *   1. {@link aggregate1hTo4h}: pure function — UTC bucketing on 00/04/08/12/
 *      16/20, OHLCV math, contiguity guard (drops partial 4H buckets).
 *   2. {@link fetchCoinbaseHourlyBars}: HTTP pagination — verifies the loop
 *      walks `[from, to)` in 300-bar windows, dedups on bar timestamp, and
 *      surfaces upstream errors without swallowing them. Uses a hand-rolled
 *      `vi.stubGlobal('fetch', …)` rather than a heavyweight HTTP mock so
 *      the assertions stay close to the request shape Coinbase actually sees.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { aggregate1hTo4h, fetchCoinbaseHourlyBars, fetchCoinbase4hBars } from './coinbase-feed.js';

const ONE_HOUR_MS = 60 * 60 * 1000;
const FOUR_HOURS_MS = 4 * ONE_HOUR_MS;

function hourlyBar(symbol: string, ts: number, close: number): Candle {
  return { symbol, timestamp: ts, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
}

describe('aggregate1hTo4h', () => {
  it('aggregates 4 contiguous 1H bars into one 4H bar with correct OHLCV', () => {
    const bucketStart = Date.UTC(2025, 0, 1, 0, 0, 0); // 00:00 UTC — clean 4H boundary
    const bars: Candle[] = [
      { symbol: 'BTC-USD', timestamp: bucketStart + 0 * ONE_HOUR_MS, open: 100, high: 105, low: 99, close: 102, volume: 10 },
      { symbol: 'BTC-USD', timestamp: bucketStart + 1 * ONE_HOUR_MS, open: 102, high: 108, low: 101, close: 107, volume: 20 },
      { symbol: 'BTC-USD', timestamp: bucketStart + 2 * ONE_HOUR_MS, open: 107, high: 110, low: 104, close: 105, volume: 15 },
      { symbol: 'BTC-USD', timestamp: bucketStart + 3 * ONE_HOUR_MS, open: 105, high: 106, low: 100, close: 103, volume: 25 },
    ];
    const out = aggregate1hTo4h(bars);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({
      symbol: 'BTC-USD',
      timestamp: bucketStart,
      open: 100,
      high: 110,
      low: 99,
      close: 103,
      volume: 70,
    });
  });

  it('drops 4H buckets that are missing one or more 1H constituents', () => {
    const bucketStart = Date.UTC(2025, 0, 1, 4, 0, 0);
    const partial: Candle[] = [
      hourlyBar('ETH-USD', bucketStart + 0 * ONE_HOUR_MS, 100),
      hourlyBar('ETH-USD', bucketStart + 1 * ONE_HOUR_MS, 101),
      hourlyBar('ETH-USD', bucketStart + 2 * ONE_HOUR_MS, 102),
      // missing the 4th hour
    ];
    expect(aggregate1hTo4h(partial)).toEqual([]);
  });

  it('drops a bucket where the 4 bars are non-contiguous (e.g. skipped hour padded)', () => {
    const bucketStart = Date.UTC(2025, 0, 1, 8, 0, 0);
    const noncontiguous: Candle[] = [
      hourlyBar('SOL-USD', bucketStart + 0 * ONE_HOUR_MS, 100),
      hourlyBar('SOL-USD', bucketStart + 1 * ONE_HOUR_MS, 101),
      hourlyBar('SOL-USD', bucketStart + 2 * ONE_HOUR_MS, 102),
      // 4th bar lands in the next bucket — this bucket has 3 bars only
      hourlyBar('SOL-USD', bucketStart + 4 * ONE_HOUR_MS, 103),
    ];
    expect(aggregate1hTo4h(noncontiguous)).toEqual([]);
  });

  it('emits 6 bars per UTC day from a clean 24h 1H feed (TRA-267 acceptance ratio)', () => {
    const dayStart = Date.UTC(2025, 0, 1, 0, 0, 0);
    const oneDay: Candle[] = [];
    for (let h = 0; h < 24; h++) {
      oneDay.push(hourlyBar('XRP-USD', dayStart + h * ONE_HOUR_MS, 100 + h));
    }
    const out = aggregate1hTo4h(oneDay);
    expect(out).toHaveLength(6);
    // Buckets land on 00, 04, 08, 12, 16, 20 UTC.
    expect(out.map((b) => b.timestamp)).toEqual([0, 1, 2, 3, 4, 5].map((i) => dayStart + i * FOUR_HOURS_MS));
  });

  it('returns ascending by timestamp regardless of input order', () => {
    const dayStart = Date.UTC(2025, 0, 1, 0, 0, 0);
    const shuffled: Candle[] = [];
    for (let h = 0; h < 8; h++) {
      shuffled.push(hourlyBar('DOGE-USD', dayStart + h * ONE_HOUR_MS, 100 + h));
    }
    shuffled.reverse();
    const out = aggregate1hTo4h(shuffled);
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBeLessThan(out[1].timestamp);
  });
});

describe('fetchCoinbaseHourlyBars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('paginates the request window and merges results in ascending order', async () => {
    // 700-hour span ≈ 2 windows at the 300-bar limit. We mock two responses:
    // first window returns 300 bars (descending — Coinbase's native order),
    // second window returns 400 bars.
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const end = start + 700 * ONE_HOUR_MS;

    const calls: string[] = [];
    const fetchMock = vi.fn(async (input: string | URL) => {
      const url = String(input);
      calls.push(url);
      const u = new URL(url);
      const reqStart = new Date(u.searchParams.get('start') ?? 0).getTime();
      const reqEnd = new Date(u.searchParams.get('end') ?? 0).getTime();
      const rows: Array<[number, number, number, number, number, number]> = [];
      for (let t = reqStart; t < reqEnd; t += ONE_HOUR_MS) {
        rows.push([t / 1000, 99, 105, 100, 102, 50]);
      }
      // Coinbase returns descending — flip to mirror reality so the dedupe path is exercised.
      rows.reverse();
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchCoinbaseHourlyBars('BTC-USD', start, end);
    // Drive the inter-call sleep
    await vi.runAllTimersAsync();
    const bars = await promise;

    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(bars).toHaveLength(700);
    // Ascending
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].timestamp).toBeGreaterThan(bars[i - 1].timestamp);
    }
    // Field shape parity with `fetchCryptoDailyBars`
    expect(bars[0]).toMatchObject({
      symbol: 'BTC-USD',
      open: 100,
      high: 105,
      low: 99,
      close: 102,
      volume: 50,
    });
    expect(typeof bars[0].timestamp).toBe('number');
  });

  it('dedupes on overlapping bar timestamps across windows', async () => {
    // Force the second window's start to overlap the first window's end by 5 bars
    // by making each window emit the same 5 boundary bars. The dedupe pass
    // should drop the duplicates.
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const end = start + 600 * ONE_HOUR_MS;
    const fetchMock = vi.fn(async (input: string | URL) => {
      const u = new URL(String(input));
      const reqStart = new Date(u.searchParams.get('start') ?? 0).getTime();
      const reqEnd = new Date(u.searchParams.get('end') ?? 0).getTime();
      const rows: Array<[number, number, number, number, number, number]> = [];
      // 5 extra bars before reqStart to simulate Coinbase returning a bit of overlap.
      for (let t = reqStart - 5 * ONE_HOUR_MS; t < reqEnd; t += ONE_HOUR_MS) {
        if (t < start) continue;
        rows.push([t / 1000, 99, 105, 100, 102, 50]);
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchCoinbaseHourlyBars('BTC-USD', start, end);
    await vi.runAllTimersAsync();
    const bars = await promise;

    expect(bars).toHaveLength(600);
    const seen = new Set(bars.map((b) => b.timestamp));
    expect(seen.size).toBe(bars.length);
  });

  it('throws with the response body on non-2xx', async () => {
    const start = Date.UTC(2025, 0, 1);
    const end = start + ONE_HOUR_MS;
    vi.stubGlobal('fetch', vi.fn(async () => new Response('rate limit', { status: 429 })));
    await expect(fetchCoinbaseHourlyBars('BTC-USD', start, end)).rejects.toThrow(/Coinbase 429/);
  });

  it('returns empty array when toMs <= fromMs (no network)', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const out = await fetchCoinbaseHourlyBars('BTC-USD', 1000, 1000);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('fetchCoinbase4hBars', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('fetches 1H bars and aggregates to 4H end-to-end', async () => {
    // 24-hour window aligned to a 4H boundary so we expect 6 4H bars.
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const end = start + 24 * ONE_HOUR_MS;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const u = new URL(String(input));
      const reqStart = new Date(u.searchParams.get('start') ?? 0).getTime();
      const reqEnd = new Date(u.searchParams.get('end') ?? 0).getTime();
      const rows: Array<[number, number, number, number, number, number]> = [];
      for (let t = reqStart; t < reqEnd; t += ONE_HOUR_MS) {
        rows.push([t / 1000, 99, 105, 100, 102, 50]);
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    }));

    const promise = fetchCoinbase4hBars('BTC-USD', start, end);
    await vi.runAllTimersAsync();
    const bars = await promise;
    expect(bars).toHaveLength(6);
    expect(bars[0].timestamp).toBe(start);
    expect(bars[5].timestamp).toBe(start + 5 * FOUR_HOURS_MS);
    expect(bars[0].volume).toBe(200); // 4 × 50
  });
});
