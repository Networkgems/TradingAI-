/**
 * TRA-267 — public Coinbase Exchange candles fetch for the Phase-1 perp shorts
 * universe. Powers the offline 4H bar backfill consumed by TRA-261's §8
 * walk-forward sweep and the live `_4hCandleCache` on `CryptoSignalEngine`.
 *
 * Granularity note: TRA-267's spec calls for `granularity=14400` against
 * `https://api.exchange.coinbase.com/products/{}/candles`, but the Exchange
 * public-candles endpoint rejects anything outside `{60, 300, 900, 3600,
 * 21600, 86400}`. The supported neighbour at the right resolution is 3600 (1H).
 * We fetch 1H bars and aggregate to 4H locally on UTC `00/04/08/12/16/20`
 * boundaries — same downstream Candle shape, no engine-side change.
 */

import type { Candle } from '@trading-app/shared';

const COINBASE_BASE = 'https://api.exchange.coinbase.com';
const GRANULARITY_1H = 3600;
const MAX_CANDLES_PER_REQUEST = 300;
const REQUEST_GAP_MS = 150;
const FOUR_HOURS_MS = 4 * 60 * 60 * 1000;
const ONE_HOUR_MS = 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type CoinbaseCandleRow = [number, number, number, number, number, number];

/**
 * Pulls 1H OHLCV bars from Coinbase Exchange's public candles endpoint over
 * `[fromMs, toMs)`, paginating in 300-bar windows (≈12.5 days each).
 * Returns ascending-by-timestamp, deduped on the bar's open second.
 */
export async function fetchCoinbaseHourlyBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  if (toMs <= fromMs) return [];
  const stepMs = MAX_CANDLES_PER_REQUEST * GRANULARITY_1H * 1000;
  const all: Candle[] = [];

  let cursor = fromMs;
  while (cursor < toMs) {
    const winEnd = Math.min(cursor + stepMs, toMs);
    const url = new URL(`${COINBASE_BASE}/products/${symbol}/candles`);
    url.searchParams.set('granularity', String(GRANULARITY_1H));
    url.searchParams.set('start', new Date(cursor).toISOString());
    url.searchParams.set('end', new Date(winEnd).toISOString());

    const res = await fetch(url.toString(), { headers: { 'User-Agent': 'TRA-267/1.0' } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Coinbase ${res.status} for ${symbol} 1h candles: ${body}`);
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
