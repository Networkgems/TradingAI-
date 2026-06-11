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
  _resetCoinbaseAdvancedTradeBreakerForTests,
  _resetCoinbaseBreakerForTests,
  aggregate1hTo4h,
  fetchCoinbaseHourlyBars,
  fetchCoinbase4hBars,
  fillGrid4h,
  isCoinbaseAdvancedTradeBreakerOpen,
  isCoinbaseBreakerOpen,
  paceCoinbaseAdvancedTradeFetch,
  paceCoinbaseFetch,
  summarize4hGaps,
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

describe('fillGrid4h / summarize4hGaps (TRA-427)', () => {
  function fourHourBar(symbol: string, ts: number, close: number): Candle {
    return { symbol, timestamp: ts, open: close - 1, high: close + 2, low: close - 2, close, volume: 100 };
  }

  it('returns the input unchanged when the 4H grid is already contiguous', () => {
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const bars = [0, 1, 2, 3, 4].map((i) => fourHourBar('BTC-USD', start + i * FOUR_HOURS_MS, 100 + i));
    const filled = fillGrid4h(bars);
    expect(filled).toEqual(bars);
    expect(filled.some((b) => b.synthetic)).toBe(false);
    expect(summarize4hGaps(filled)).toEqual([]);
  });

  it('bridges a single missing 4H slot with one flat synthetic bar carrying the prior close', () => {
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    // Slot index 2 (start + 2×4H) is missing.
    const bars = [
      fourHourBar('SOL-USD', start + 0 * FOUR_HOURS_MS, 100),
      fourHourBar('SOL-USD', start + 1 * FOUR_HOURS_MS, 110),
      fourHourBar('SOL-USD', start + 3 * FOUR_HOURS_MS, 130),
    ];
    const filled = fillGrid4h(bars);
    expect(filled).toHaveLength(4);
    const synth = filled[2];
    expect(synth.synthetic).toBe(true);
    expect(synth.timestamp).toBe(start + 2 * FOUR_HOURS_MS);
    // Flat bar carrying the prior real bar's close (110), zero volume.
    expect(synth).toMatchObject({ open: 110, high: 110, low: 110, close: 110, volume: 0 });
    // Grid is now contiguous.
    for (let i = 1; i < filled.length; i++) {
      expect(filled[i].timestamp - filled[i - 1].timestamp).toBe(FOUR_HOURS_MS);
    }
  });

  it('bridges a multi-bar gap (verified 2-bar exchange gap shape from the cache audit)', () => {
    const start = Date.UTC(2025, 9, 25, 12, 0, 0); // mirrors the real 2025-10-25 gap
    // 16:00 and 20:00 slots missing — jump straight from 12:00 to next-day 00:00.
    const bars = [
      fourHourBar('BTC-USD', start + 0 * FOUR_HOURS_MS, 111466),
      fourHourBar('BTC-USD', start + 3 * FOUR_HOURS_MS, 111900),
    ];
    const filled = fillGrid4h(bars);
    expect(filled).toHaveLength(4);
    expect(filled.filter((b) => b.synthetic)).toHaveLength(2);
    const gaps = summarize4hGaps(filled);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toEqual({
      fromTimestamp: start + 1 * FOUR_HOURS_MS,
      toTimestamp: start + 2 * FOUR_HOURS_MS,
      filledBars: 2,
    });
  });

  it('summarizes two separate gaps as two distinct runs', () => {
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const bars = [
      fourHourBar('ETH-USD', start + 0 * FOUR_HOURS_MS, 100),
      // slot 1 missing
      fourHourBar('ETH-USD', start + 2 * FOUR_HOURS_MS, 120),
      fourHourBar('ETH-USD', start + 3 * FOUR_HOURS_MS, 130),
      // slot 4 missing
      fourHourBar('ETH-USD', start + 5 * FOUR_HOURS_MS, 150),
    ];
    const gaps = summarize4hGaps(fillGrid4h(bars));
    expect(gaps).toHaveLength(2);
    expect(gaps[0].filledBars).toBe(1);
    expect(gaps[1].filledBars).toBe(1);
    expect(gaps[1].fromTimestamp).toBeGreaterThan(gaps[0].toTimestamp);
  });

  it('handles empty input', () => {
    expect(fillGrid4h([])).toEqual([]);
    expect(summarize4hGaps([])).toEqual([]);
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

  it('TRA-427 — gap-fills the 4H grid when the 1H feed has an exchange gap', async () => {
    // 24-hour window, but the exchange has no 1H rows for 16:00–20:00 UTC —
    // the verified shape of the real 2025-10-25 / 2026-05-08 cache gaps. The
    // 16:00 4H bucket loses all four constituents; the output must still be a
    // contiguous 6-bar grid with one synthetic bar bridging the hole.
    const start = Date.UTC(2025, 0, 1, 0, 0, 0);
    const end = start + 24 * ONE_HOUR_MS;
    const gapFrom = start + 16 * ONE_HOUR_MS;
    const gapTo = start + 20 * ONE_HOUR_MS;
    vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => {
      const u = new URL(String(input));
      const reqStart = new Date(u.searchParams.get('start') ?? 0).getTime();
      const reqEnd = new Date(u.searchParams.get('end') ?? 0).getTime();
      const rows: Array<[number, number, number, number, number, number]> = [];
      for (let t = reqStart; t < reqEnd; t += ONE_HOUR_MS) {
        if (t >= gapFrom && t < gapTo) continue; // exchange gap — no rows
        rows.push([t / 1000, 99, 105, 100, 102, 50]);
      }
      return new Response(JSON.stringify(rows), { status: 200 });
    }));

    const promise = fetchCoinbase4hBars('BTC-USD', start, end);
    await vi.runAllTimersAsync();
    const bars = await promise;

    expect(bars).toHaveLength(6); // contiguous grid, not 5
    for (let i = 1; i < bars.length; i++) {
      expect(bars[i].timestamp - bars[i - 1].timestamp).toBe(FOUR_HOURS_MS);
    }
    const synth = bars.find((b) => b.timestamp === start + 16 * ONE_HOUR_MS);
    expect(synth?.synthetic).toBe(true);
    expect(synth).toMatchObject({ volume: 0 });
    expect(summarize4hGaps(bars)).toHaveLength(1);
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

  it('trips on slow failures spaced beyond the old 30s window (TRA-804)', async () => {
    // Regression for the prod incident: when a Coinbase host hangs, each fetch
    // aborts only at the multi-second per-fetch timeout, so 5 serialized
    // failures span far longer than the legacy 30s sliding window. The old
    // window-based counter aged the earliest failures out before the 5th
    // landed, so the breaker never tripped and the dead host got hammered
    // every tick. With consecutive-failure semantics the breaker must still
    // trip even when each failure is >30s apart.
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
    for (let i = 0; i < 5; i++) {
      const p = paceCoinbaseFetch(`https://x/slow${i}`, {}, { timeoutMs: 100 }).catch((e) => e);
      await vi.runAllTimersAsync();
      await p;
      // Advance the clock well past the old 30s window between each failure.
      await vi.advanceTimersByTimeAsync(31_000);
    }
    expect(isCoinbaseBreakerOpen()).toBe(true);
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

/**
 * TRA-484 — sibling pacer for the keyless `api.coinbase.com` host. The
 * Exchange pacer above is *host-scoped*; the Advanced Trade pacer keeps its
 * own chain / breaker so a hang on one host does not poison the other.
 * Mirrors the coverage shape of the Exchange pacer block: abort, breaker
 * trip, counter reset, plus a cross-pacer isolation check.
 */
describe('paceCoinbaseAdvancedTradeFetch (TRA-484)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetCoinbaseAdvancedTradeBreakerForTests();
    _resetCoinbaseBreakerForTests();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    _resetCoinbaseAdvancedTradeBreakerForTests();
    _resetCoinbaseBreakerForTests();
  });

  it('aborts a hung fetch via AbortController so the chain is not poisoned', async () => {
    let abortedSignal: AbortSignal | null = null;
    const responses: Array<(req: { signal?: AbortSignal | null }) => Promise<Response>> = [
      (req) => new Promise<Response>((_resolve, reject) => {
        const sig = req.signal ?? null;
        abortedSignal = sig;
        if (!sig) return;
        const onAbort = () => {
          const reason = (sig as AbortSignal & { reason?: unknown }).reason;
          reject(reason instanceof Error ? reason : new DOMException('Aborted', 'AbortError'));
        };
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort);
      }),
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 }),
    ];
    let callIdx = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const handler = responses[callIdx++];
      return handler({ signal: init?.signal ?? null });
    }));

    const first = paceCoinbaseAdvancedTradeFetch(
      'https://api.coinbase.com/api/v3/brokerage/market/products',
      {},
      { timeoutMs: 500 },
    ).catch((e) => e);
    const second = paceCoinbaseAdvancedTradeFetch(
      'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles',
      {},
      { timeoutMs: 500 },
    );

    await vi.runAllTimersAsync();
    const firstErr = await first;
    expect(firstErr).toBeInstanceOf(Error);
    expect((firstErr as Error).message).toMatch(/Coinbase Advanced Trade fetch timed out after 500ms/);
    const resp = await second;
    expect(resp.ok).toBe(true);
    expect(abortedSignal).not.toBeNull();
    expect(abortedSignal!.aborted).toBe(true);
  });

  it('trips the breaker after 5 transport failures and fast-fails subsequent calls', async () => {
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sig = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        if (!sig) return;
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort);
      });
    }));

    expect(isCoinbaseAdvancedTradeBreakerOpen()).toBe(false);

    const failures: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      failures.push(
        paceCoinbaseAdvancedTradeFetch(
          `https://api.coinbase.com/api/v3/brokerage/market/products/SYM${i}/candles`,
          {},
          { timeoutMs: 100 },
        ).catch((e) => e),
      );
    }
    await vi.runAllTimersAsync();
    await Promise.all(failures);

    expect(isCoinbaseAdvancedTradeBreakerOpen()).toBe(true);

    const fetchMock = globalThis.fetch as unknown as ReturnType<typeof vi.fn>;
    const before = fetchMock.mock.calls.length;
    await expect(
      paceCoinbaseAdvancedTradeFetch(
        'https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles',
        {},
        { timeoutMs: 5_000 },
      ),
    ).rejects.toThrow(/Coinbase advanced-trade breaker open/);
    expect(fetchMock.mock.calls.length).toBe(before);
  });

  it('resets the failure counter on a successful fetch', async () => {
    let nextShouldHang = true;
    let callsObserved = 0;
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      callsObserved += 1;
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
      const p = paceCoinbaseAdvancedTradeFetch(`https://x/${i}`, {}, { timeoutMs: 50 }).catch((e) => e);
      await vi.runAllTimersAsync();
      await p;
    }
    nextShouldHang = false;
    const okPromise = paceCoinbaseAdvancedTradeFetch('https://x/ok', {}, { timeoutMs: 50 });
    await vi.runAllTimersAsync();
    const ok = await okPromise;
    expect(ok.ok).toBe(true);

    nextShouldHang = true;
    for (let i = 0; i < 4; i++) {
      const p = paceCoinbaseAdvancedTradeFetch(`https://x/post${i}`, {}, { timeoutMs: 50 }).catch((e) => e);
      await vi.runAllTimersAsync();
      await p;
    }

    expect(isCoinbaseAdvancedTradeBreakerOpen()).toBe(false);
    expect(callsObserved).toBe(4 + 1 + 4);
  });

  it('keeps Exchange and Advanced Trade pacers isolated — tripping one does not trip the other', async () => {
    // Five hung Advanced Trade fetches → AT breaker trips. Exchange breaker
    // must remain closed because each pacer owns its own failure counter.
    vi.stubGlobal('fetch', vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const sig = init?.signal ?? null;
      return new Promise<Response>((_resolve, reject) => {
        if (!sig) return;
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (sig.aborted) onAbort();
        else sig.addEventListener('abort', onAbort);
      });
    }));

    const failures: Promise<unknown>[] = [];
    for (let i = 0; i < 5; i++) {
      failures.push(
        paceCoinbaseAdvancedTradeFetch(
          `https://api.coinbase.com/api/v3/brokerage/market/products/SYM${i}/candles`,
          {},
          { timeoutMs: 100 },
        ).catch((e) => e),
      );
    }
    await vi.runAllTimersAsync();
    await Promise.all(failures);

    expect(isCoinbaseAdvancedTradeBreakerOpen()).toBe(true);
    expect(isCoinbaseBreakerOpen()).toBe(false);

    // And an Exchange call still goes through (mocked to hang, but the
    // breaker fast-fail is the bit we care about — it must NOT short-circuit).
    const exchangeAttempt = paceCoinbaseFetch(
      'https://api.exchange.coinbase.com/products/BTC-USD/stats',
      {},
      { timeoutMs: 100 },
    ).catch((e) => e);
    await vi.runAllTimersAsync();
    const exErr = await exchangeAttempt;
    expect(String((exErr as Error).message)).not.toMatch(/breaker open/);
  });

  it('paces requests with the 150 ms min-gap between calls', async () => {
    // Two back-to-back fetches must be ≥150 ms apart, observed via Date.now()
    // captured inside the mocked fetch.
    const stamps: number[] = [];
    vi.stubGlobal('fetch', vi.fn(async () => {
      stamps.push(Date.now());
      return new Response(JSON.stringify({}), { status: 200 });
    }));

    const a = paceCoinbaseAdvancedTradeFetch('https://api.coinbase.com/a', {}, { timeoutMs: 1_000 });
    const b = paceCoinbaseAdvancedTradeFetch('https://api.coinbase.com/b', {}, { timeoutMs: 1_000 });
    await vi.runAllTimersAsync();
    await a;
    await b;

    expect(stamps).toHaveLength(2);
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(150);
  });
});
