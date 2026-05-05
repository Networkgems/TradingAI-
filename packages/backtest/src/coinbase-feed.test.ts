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
import {
  _resetCoinbaseBreakerForTests,
  aggregate1hTo4h,
  fetchCoinbaseHourlyBars,
  fetchCoinbase4hBars,
  isCoinbaseBreakerOpen,
  paceCoinbaseFetch,
} from './coinbase-feed.js';

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
    _resetCoinbaseBreakerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _resetCoinbaseBreakerForTests();
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
    _resetCoinbaseBreakerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _resetCoinbaseBreakerForTests();
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

describe('paceCoinbaseFetch (TRA-329)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCoinbaseBreakerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _resetCoinbaseBreakerForTests();
  });

  it('aborts a hung fetch via AbortController so the chain is not poisoned', async () => {
    // First call: never-resolving fetch. Second call: would hang behind the
    // first if the AbortController did not actually cancel the underlying
    // request. With the abort, the chain link rejects and the second call
    // proceeds to run a successful fetch.
    let abortedSignal: AbortSignal | null = null;
    const responses: Array<(req: { signal?: AbortSignal | null }) => Promise<Response>> = [
      // Hang until aborted; reject with the signal's reason when aborted.
      (req) => new Promise<Response>((_resolve, reject) => {
        const sig = req.signal ?? null;
        abortedSignal = sig;
        if (!sig) return; // never resolves
        const onAbort = () => {
          const reason = (sig as AbortSignal & { reason?: unknown }).reason;
          reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
        };
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort);
      }),
      // Fast success.
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    let callIdx = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const handler = responses[callIdx++];
      return handler({ signal: init?.signal ?? null });
    }));

    // Attach .catch eagerly so the rejection is observed during
    // `runAllTimersAsync`; otherwise vitest reports an unhandled rejection.
    const first = paceCoinbaseFetch('https://api.exchange.coinbase.com/products/BTC-USD/stats', {}, { timeoutMs: 500 })
      .catch((e) => e);
    // Second call — enqueued behind the first. Without the abort fix it
    // would never fire because the chain link is held open.
    const second = paceCoinbaseFetch('https://api.exchange.coinbase.com/products/ETH-USD/stats', {}, { timeoutMs: 500 });

    await vi.runAllTimersAsync();
    const firstErr = await first;
    expect(firstErr).toBeInstanceOf(Error);
    expect((firstErr as Error).message).toMatch(/timed out after 500ms/);
    const resp = await second;
    expect(resp.ok).toBe(true);
    expect(abortedSignal).not.toBeNull();
    expect(abortedSignal!.aborted).toBe(true);
  });

  it('trips the breaker after 5 transport failures and fast-fails subsequent calls', async () => {
    // Five hung fetches in a row should trip the breaker. The 6th call must
    // reject immediately with "Coinbase breaker open" without waiting for
    // any setTimeout/fetch budget.
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sig = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        if (!sig) return;
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort);
      });
    }));

    expect(isCoinbaseBreakerOpen()).toBe(false);

    const failures: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      failures.push(
        paceCoinbaseFetch(`https://api.exchange.coinbase.com/products/SYM${i}/stats`, {}, { timeoutMs: 100 })
          .catch((e) => e),
      );
    }
    await vi.runAllTimersAsync();
    await Promise.all(failures);

    expect(isCoinbaseBreakerOpen()).toBe(true);

    // Subsequent call: synchronous-ish fast-fail. The fetch mock is never invoked.
    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    await expect(
      paceCoinbaseFetch('https://api.exchange.coinbase.com/products/BTC-USD/stats', {}, { timeoutMs: 5_000 }),
    ).rejects.toThrow(/Coinbase breaker open/);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('resets the failure counter on a successful fetch', async () => {
    // Pattern: fail, fail, fail, fail, success — counter must reset so the
    // next 4 failures don't trip the breaker (threshold is 5).
    let nextShouldHang = true;
    let callsBeforeBreakerExpected = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      callsBeforeBreakerExpected += 1;
      if (nextShouldHang) {
        const sig = init?.signal ?? null;
        return new Promise<Response>((_resolve, reject) => {
          if (!sig) return;
          const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
          if (sig.aborted) onAbort();
          else sig.addEventListener('abort', onAbort);
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    for (let i = 0; i < 4; i++) {
      const p = paceCoinbaseFetch(`https://x/${i}`, {}, { timeoutMs: 50 }).catch((e) => e);
      await vi.runAllTimersAsync();
      await p;
    }
    // Now a success.
    nextShouldHang = false;
    const okPromise = paceCoinbaseFetch('https://x/ok', {}, { timeoutMs: 50 });
    await vi.runAllTimersAsync();
    const ok = await okPromise;
    expect(ok.ok).toBe(true);

    // 4 more failures: should NOT trip the breaker because the counter reset.
    nextShouldHang = true;
    for (let i = 0; i < 4; i++) {
      const p = paceCoinbaseFetch(`https://x/post${i}`, {}, { timeoutMs: 50 }).catch((e) => e);
      await vi.runAllTimersAsync();
      await p;
    }

    expect(isCoinbaseBreakerOpen()).toBe(false);
    expect(callsBeforeBreakerExpected).toBe(4 + 1 + 4);
  });
});
