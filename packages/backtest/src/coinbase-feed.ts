/**
 * Public Coinbase Exchange candles fetch.
 *
 * TRA-267 introduced this for the Phase-1 perp shorts 4H backfill. TRA-300
 * generalised it to also serve 1D and 1m crypto bars — same venue alignment
 * as TRA-300's quote fix, so signal price ↔ execution price stay matched and
 * Yahoo's per-IP rate-limiter is no longer a single point of failure.
 *
 * Granularity note: the Exchange public-candles endpoint rejects anything
 * outside `{60, 300, 900, 3600, 21600, 86400}`. The TRA-267 spec wanted
 * `granularity=14400` (4H) which Coinbase doesn't support — we fetch 1H bars
 * and aggregate to 4H locally on UTC `00/04/08/12/16/20` boundaries. 1m
 * (60) and 1D (86400) are native and don't need aggregation.
 */

import type { Candle } from '@trading-app/shared';

const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const GRANULARITY_1M = 60;
const GRANULARITY_1H = 3600;
const GRANULARITY_1D = 86_400;
const MAX_CANDLES_PER_REQUEST = 300;
const REQUEST_GAP_MS = 150;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CoinbaseCandleRow = [number, number, number, number, number, number];

/**
 * TRA-300 — global rate limiter for *all* Coinbase Exchange public-data
 * requests originating from this process. Coinbase enforces 10 req/s per IP
 * across the entire `api.exchange.coinbase.com` surface (candles, stats,
 * tickers, products, …), so the live engine's tick — which fans out ~50
 * stats + 50 minute + 50 daily + 5 4H requests within a few seconds — was
 * blowing the budget and getting bulk-429'd back to Yahoo. The scheduler
 * serialises every Coinbase fetch through a single Promise chain with a
 * 120 ms min gap (≈ 8.3 req/s sustained, leaving headroom for the
 * occasional retry without crossing 10/s). All call sites — including
 * `fetchCoinbaseStatsQuotes` in `packages/server/src/crypto-feed.ts` —
 * route through {@link paceCoinbaseFetch} so the limit is enforced
 * regardless of which file kicked off the request.
 *
 * TRA-329 — added a per-fetch `AbortController` and a circuit breaker.
 * The TRA-300 design only had an *outer* `withTimeout` wrapper around each
 * call (in `crypto-feed.ts`); when a single fetch hung longer than the
 * budget the outer wrapper rejected, but the underlying socket was still
 * waiting on Coinbase. The hung fetch held the rate-limiter chain link
 * open, and every subsequent enqueue piled up behind it — each timing out
 * at the outer 8 s wrapper too. One genuinely slow Coinbase response
 * therefore cascaded into "every call timed out, falling back to Yahoo"
 * for the remainder of the tick (TRA-329 prod symptom). The
 * `AbortController` here actually cancels the hung fetch so the chain
 * advances; the breaker stops us from burning the 8 s outer budget on
 * every symbol once we know Coinbase is unhealthy.
 */
const COINBASE_MIN_GAP_MS = 120;
const COINBASE_FETCH_TIMEOUT_MS = 7_000;
const COINBASE_BREAKER_FAILURE_THRESHOLD = 5;
const COINBASE_BREAKER_FAILURE_WINDOW_MS = 30_000;
const COINBASE_BREAKER_COOLDOWN_MS = 60_000;

let coinbaseChain: Promise<unknown> = Promise.resolve();
let coinbaseLastRequestAt = 0;
let recentCoinbaseFailures: number[] = [];
let coinbaseBreakerOpenUntil = 0;

export function isCoinbaseBreakerOpen(): boolean {
  return Date.now() < coinbaseBreakerOpenUntil;
}

/** Test seam — reset all breaker / chain state between unit tests. */
export function _resetCoinbaseBreakerForTests(): void {
  recentCoinbaseFailures = [];
  coinbaseBreakerOpenUntil = 0;
  coinbaseChain = Promise.resolve();
  coinbaseLastRequestAt = 0;
}

function recordCoinbaseFailure(): void {
  const now = Date.now();
  recentCoinbaseFailures.push(now);
  while (recentCoinbaseFailures.length > 0 && recentCoinbaseFailures[0] < now - COINBASE_BREAKER_FAILURE_WINDOW_MS) {
    recentCoinbaseFailures.shift();
  }
  if (recentCoinbaseFailures.length >= COINBASE_BREAKER_FAILURE_THRESHOLD) {
    coinbaseBreakerOpenUntil = now + COINBASE_BREAKER_COOLDOWN_MS;
    recentCoinbaseFailures = [];
    console.warn(
      `[coinbase-feed] circuit breaker tripped — skipping Coinbase for ${COINBASE_BREAKER_COOLDOWN_MS / 1000}s after ${COINBASE_BREAKER_FAILURE_THRESHOLD} consecutive transport failures`,
    );
  }
}

function recordCoinbaseSuccess(): void {
  recentCoinbaseFailures = [];
}

export async function paceCoinbaseFetch(
  url: string,
  init?: { headers?: Record<string, string> },
  options: { timeoutMs?: number } = {},
): Promise<Response> {
  // TRA-329 — fast-fail when the breaker is open so callers fall through to
  // Yahoo immediately instead of paying the outer 8 s budget per symbol.
  if (isCoinbaseBreakerOpen()) {
    throw new Error('Coinbase breaker open');
  }
  const timeoutMs = options.timeoutMs ?? COINBASE_FETCH_TIMEOUT_MS;
  const next = coinbaseChain.then(async () => {
    // Skip the wait when the gap is already exceeded *or* when `Date.now()`
    // appears to go backwards (vitest's fake timers reset the clock between
    // `it()`s, which would otherwise compute a huge positive wait against a
    // never-advancing fake clock and deadlock the suite).
    const elapsed = Date.now() - coinbaseLastRequestAt;
    if (elapsed >= 0 && elapsed < COINBASE_MIN_GAP_MS) {
      await sleep(COINBASE_MIN_GAP_MS - elapsed);
    }
    coinbaseLastRequestAt = Date.now();

    // TRA-329 — the AbortController is the load-bearing piece. Without it,
    // a slow fetch would leave the chain link open even after the outer
    // `withTimeout` rejected, blocking every subsequent enqueue.
    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const resp = await fetch(url, { ...init, signal: controller.signal });
      recordCoinbaseSuccess();
      return resp;
    } catch (err) {
      recordCoinbaseFailure();
      if (controller.signal.aborted) {
        throw new Error(`Coinbase fetch timed out after ${timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(abortTimer);
    }
  });
  // Keep the chain alive even if a call rejects, so a single failed request
  // doesn't poison every subsequent enqueue.
  coinbaseChain = next.catch(() => undefined);
  return next as Promise<Response>;
}

/**
 * Generic Coinbase candles fetch. Paginates `[fromMs, toMs)` in 300-bar
 * windows whose width scales with `granularitySeconds` (≈5h for 1m, ≈12.5d
 * for 1H, ≈300d for 1D). Returns ascending-by-timestamp, deduped on the
 * bar's open second.
 */
async function fetchCoinbaseCandles(
  symbol: string,
  granularitySeconds: number,
  fromMs: number,
  toMs: number,
  label: string,
): Promise<Candle[]> {
  if (toMs <= fromMs) return [];
  const stepMs = MAX_CANDLES_PER_REQUEST * granularitySeconds * 1000;
  const all: Candle[] = [];

  let cursor = fromMs;
  while (cursor < toMs) {
    const winEnd = Math.min(cursor + stepMs, toMs);
    const url = new URL(`${COINBASE_BASE}/products/${symbol}/candles`);
    url.searchParams.set('granularity', String(granularitySeconds));
    url.searchParams.set('start', new Date(cursor).toISOString());
    url.searchParams.set('end', new Date(winEnd).toISOString());

    const res = await paceCoinbaseFetch(url.toString(), { headers: { 'User-Agent': 'TRA-267/1.0' } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Coinbase ${res.status} for ${symbol} ${label} candles: ${body}`);
    }
    const rows = (await res.json()) as ReadonlyArray<CoinbaseCandleRow>;
    for (const [time, low, high, open, close, volume] of rows) {
      all.push({ symbol, timestamp: time * 1000, open, high, low, close, volume });
    }
    cursor = winEnd;
    if (cursor < toMs) await sleep(REQUEST_GAP_MS);
  }

  all.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<number>();
  return all.filter((c) => (seen.has(c.timestamp) ? false : (seen.add(c.timestamp), true)));
}

/** 1H bars — kept as an explicit export for the 4H aggregator. */
export async function fetchCoinbaseHourlyBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  return fetchCoinbaseCandles(symbol, GRANULARITY_1H, fromMs, toMs, '1h');
}

/**
 * TRA-300 — 1m bars. Coinbase returns the in-progress current minute, so
 * `crypto-feed.fetchCryptoMinuteBars` drops any bar whose timestamp ≥ the
 * current-minute boundary before passing into indicator math.
 */
export async function fetchCoinbaseMinuteBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  return fetchCoinbaseCandles(symbol, GRANULARITY_1M, fromMs, toMs, '1m');
}

/**
 * TRA-300 — 1D bars (UTC days). Coinbase returns the in-progress current
 * UTC day, so the live wrapper in `crypto-feed.fetchCryptoDailyBars` drops
 * any bar whose timestamp ≥ today's UTC midnight before returning.
 */
export async function fetchCoinbaseDailyBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  return fetchCoinbaseCandles(symbol, GRANULARITY_1D, fromMs, toMs, '1d');
}

/**
 * Aggregate 1H bars to 4H on UTC `00/04/08/12/16/20` boundaries. A 4H bar is
 * emitted only when all four 1H constituents are present and contiguous —
 * gaps in the 1H feed (Coinbase outages, Exchange rate-limit drops) drop the
 * partial 4H bar so downstream consumers don't see a half-built candle. Sum
 * of volumes; high/low across constituents; open from first, close from last.
 */
export function aggregate1hTo4h(hourly: ReadonlyArray<Candle>): Candle[] {
  if (hourly.length === 0) return [];
  const sorted = [...hourly].sort((a, b) => a.timestamp - b.timestamp);
  const buckets = new Map<number, Candle[]>();
  for (const bar of sorted) {
    const bucketStart = Math.floor(bar.timestamp / FOUR_HOURS_MS) * FOUR_HOURS_MS;
    const list = buckets.get(bucketStart) ?? [];
    list.push(bar);
    buckets.set(bucketStart, list);
  }

  const out: Candle[] = [];
  for (const [bucketStart, bars] of buckets) {
    if (bars.length !== 4) continue;
    bars.sort((a, b) => a.timestamp - b.timestamp);
    const expectedTimestamps = [0, 1, 2, 3].map((i) => bucketStart + i * ONE_HOUR_MS);
    const contiguous = bars.every((b, i) => b.timestamp === expectedTimestamps[i]);
    if (!contiguous) continue;
    const first = bars[0];
    const last = bars[bars.length - 1];
    out.push({
      symbol: first.symbol,
      timestamp: bucketStart,
      open: first.open,
      high: Math.max(...bars.map((b) => b.high)),
      low: Math.min(...bars.map((b) => b.low)),
      close: last.close,
      volume: bars.reduce((sum, b) => sum + b.volume, 0),
    });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/**
 * TRA-427 — a contiguous run of synthetic 4H bars inserted to bridge a
 * genuine Coinbase exchange data gap. `fromTimestamp`/`toTimestamp` are the
 * first and last *missing* 4H slots (inclusive); `filledBars` is the count
 * of synthetic bars used to bridge them.
 */
export interface GridGap {
  fromTimestamp: number;
  toTimestamp: number;
  filledBars: number;
}

/**
 * TRA-427 — make the 4H grid contiguous and deterministic.
 *
 * `aggregate1hTo4h` only emits a 4H bar when all four 1H constituents are
 * present and contiguous. When Coinbase itself has no 1H data for an interval
 * — verified exchange-side gaps, e.g. BTC-USD 2025-10-25 16:00–20:00 UTC and
 * 2026-05-08 00:00–04:00 UTC, where the public-candles endpoint returns no
 * rows — the affected 4H buckets are simply absent, leaving holes in the grid.
 *
 * A hole is not benign: it shifts every downstream MACD / Bollinger window by
 * one or more bars, and because the exact set of holes depends on which fetch
 * snapshot Coinbase served, two cache regenerations of the *same* history can
 * disagree. On a thin 24–35-trade OOS sample that non-determinism is enough to
 * flip the macd_bollinger edge sign (the TRA-423 §8 regression).
 *
 * This function walks the 4H grid from the first to the last real bar and
 * fills every missing slot with a synthetic **flat** bar — O=H=L=C carry the
 * prior bar's close, volume 0 — the neutral "no information" choice during an
 * exchange outage. Synthetic bars are flagged `synthetic: true` so the cache
 * audit (`verify-4h-cache.ts`) and any downstream consumer can see them. The
 * result is a gap-free, snapshot-independent grid: a regeneration tomorrow
 * produces byte-identical history for any window that ends in the past.
 *
 * Note this is forward-fill of *genuine exchange gaps only*. Transport-level
 * fetch failures (429s, timeouts) are handled separately by the breaker /
 * retry path and never reach here as gaps — a failed window aborts the fetch.
 */
export function fillGrid4h(bars: ReadonlyArray<Candle>): Candle[] {
  if (bars.length === 0) return [];
  const sorted = [...bars].sort((a, b) => a.timestamp - b.timestamp);
  const out: Candle[] = [sorted[0]];
  for (let i = 1; i < sorted.length; i++) {
    const cur = sorted[i];
    let expected = out[out.length - 1].timestamp + FOUR_HOURS_MS;
    // Bridge any missing slots between the previous real bar and `cur`.
    while (expected < cur.timestamp) {
      const last = out[out.length - 1];
      out.push({
        symbol: last.symbol,
        timestamp: expected,
        open: last.close,
        high: last.close,
        low: last.close,
        close: last.close,
        volume: 0,
        synthetic: true,
      });
      expected += FOUR_HOURS_MS;
    }
    out.push(cur);
  }
  return out;
}

/**
 * TRA-427 — collapse the synthetic bars in a gap-filled 4H series into the
 * contiguous {@link GridGap} runs they bridge. Used for fetch-time logging and
 * for the `gaps` audit field persisted into the on-disk cache entry.
 */
export function summarize4hGaps(candles: ReadonlyArray<Candle>): GridGap[] {
  const gaps: GridGap[] = [];
  let run: GridGap | null = null;
  for (const c of candles) {
    if (c.synthetic) {
      if (run && run.toTimestamp + FOUR_HOURS_MS === c.timestamp) {
        run.toTimestamp = c.timestamp;
        run.filledBars += 1;
      } else {
        if (run) gaps.push(run);
        run = { fromTimestamp: c.timestamp, toTimestamp: c.timestamp, filledBars: 1 };
      }
    }
  }
  if (run) gaps.push(run);
  return gaps;
}

/**
 * Fetch 4H OHLCV bars for `symbol` over `[fromMs, toMs)`. Internally pulls
 * 1H bars from Coinbase Exchange, aggregates to 4H — see file-header note on
 * why we don't request `granularity=14400` directly — and TRA-427 gap-fills
 * the 4H grid so the result is contiguous and snapshot-deterministic. Returns
 * the same `Candle[]` shape as the existing minute / daily helpers in
 * `crypto-feed.ts`; any bar with `synthetic: true` bridges an exchange gap.
 */
export async function fetchCoinbase4hBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const hourly = await fetchCoinbaseHourlyBars(symbol, fromMs, toMs);
  const filled = fillGrid4h(aggregate1hTo4h(hourly));
  const gaps = summarize4hGaps(filled);
  if (gaps.length > 0) {
    const total = gaps.reduce((s, g) => s + g.filledBars, 0);
    console.warn(
      `[coinbase-feed] ${symbol} 4H: bridged ${gaps.length} exchange gap(s) with ${total} synthetic bar(s):`,
    );
    for (const g of gaps) {
      console.warn(
        `  ${new Date(g.fromTimestamp).toISOString()} … ${new Date(g.toTimestamp).toISOString()} (${g.filledBars} bar(s))`,
      );
    }
  }
  return filled;
}
