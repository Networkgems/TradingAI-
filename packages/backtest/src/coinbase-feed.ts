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
 */
const COINBASE_MIN_GAP_MS = 120;
let coinbaseChain: Promise<unknown> = Promise.resolve();
let coinbaseLastRequestAt = 0;
export async function paceCoinbaseFetch(
  url: string,
  init?: { headers?: Record<string, string> },
): Promise<Response> {
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
    return fetch(url, init);
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
 * Fetch 4H OHLCV bars for `symbol` over `[fromMs, toMs)`. Internally pulls
 * 1H bars from Coinbase Exchange and aggregates to 4H — see file-header note
 * on why we don't request `granularity=14400` directly. Returns the same
 * `Candle[]` shape as the existing minute / daily helpers in `crypto-feed.ts`.
 */
export async function fetchCoinbase4hBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  const hourly = await fetchCoinbaseHourlyBars(symbol, fromMs, toMs);
  return aggregate1hTo4h(hourly);
}
