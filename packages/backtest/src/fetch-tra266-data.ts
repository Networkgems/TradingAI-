/**
 * TRA-266: pull daily OHLCV bars for the Phase-1 perp shorts universe and cache
 * to disk so the §8 walk-forward sweep doesn't re-hit Yahoo on every run.
 *
 * One JSON file per symbol under `packages/backtest/data/`. Cache TTL is
 * 12 hours — long enough to amortise the API hit across an iteration session,
 * short enough that re-running the sweep tomorrow picks up new bars without
 * the operator having to clear the cache.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/fetch-tra266-data.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';
import { PERP_SHORTS_UNIVERSE } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import { fetchCoinbase4hBars, fetchCoinbaseMinuteBars, summarize4hGaps } from './coinbase-feed.js';
import type { GridGap } from './coinbase-feed.js';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;

export interface CacheEntry {
  symbol: string;
  fetchedAt: number;
  start: number;
  end: number;
  candles: Candle[];
  /**
   * TRA-427 — genuine exchange gaps bridged with synthetic flat bars when the
   * cache was built. Present on 4H Coinbase caches; absent on legacy / daily
   * caches. An empty array means the grid was already contiguous.
   */
  gaps?: GridGap[];
}

export function cachePathFor(symbol: string): string {
  return resolve(DATA_DIR, `${symbol.toLowerCase()}.json`);
}

export function cachePathFor4h(symbol: string): string {
  return resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`);
}

/**
 * TRA-427 — symbols with an on-disk 4H Coinbase cache. Used by the cache
 * audit (`verify-4h-cache.ts`) as the default sweep set.
 */
export const DEFAULT_4H_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD'] as const;

/**
 * TRA-307 — 1m cache key includes the date range so a 30-day scalping cache
 * doesn't collide with any future longer fetches and vice-versa.
 */
function ymd(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');
}

export function cachePathFor1m(symbol: string, fromMs: number, toMs: number): string {
  return resolve(DATA_DIR, `${symbol.toLowerCase()}.1m_${ymd(fromMs)}_${ymd(toMs)}.json`);
}

function isFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  const ageMs = Date.now() - statSync(path).mtimeMs;
  return ageMs < CACHE_TTL_MS;
}

async function fetchYahooDaily(symbol: string, fromMs: number, toMs: number): Promise<Candle[]> {
  const result = await yf.chart(symbol, {
    period1: new Date(fromMs),
    period2: new Date(toMs),
    interval: '1d',
  });
  const quotes = result.quotes ?? [];
  return (
    quotes
      .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
      // TRA-2043 — equity daily fixtures now carry a dividend + split adjusted
      // TOTAL-RETURN series, not vendor-raw price. Yahoo returns `adjclose`
      // (back-adjusted to the latest bar); we scale the whole OHLC bar by the
      // per-bar factor `adjclose/close` so bar geometry (ranges, gaps, ATR)
      // stays internally consistent on the adjusted series rather than only the
      // close being adjusted (which would leave close < low on ex-div bars).
      //
      // Scope: backtest fixtures only. `volume` is left raw — the adjclose
      // factor conflates dividends and splits, so it can't be cleanly inverted
      // into a split-only volume adjustment; split events are absent from the
      // current fixture windows, so raw volume is faithful here. Crypto and the
      // live/server candle paths are untouched (this fn only feeds on-disk
      // equity/daily caches). If `adjclose` is missing for a bar the factor is
      // 1 (raw close), so the series never regresses below the old behaviour.
      .map((q) => {
        const rawClose = q.close!;
        const adjClose = q.adjclose ?? rawClose;
        const factor = rawClose !== 0 ? adjClose / rawClose : 1;
        return {
          symbol,
          timestamp: new Date(q.date).getTime(),
          open: q.open! * factor,
          high: q.high! * factor,
          low: q.low! * factor,
          close: adjClose,
          volume: q.volume ?? 0,
        };
      })
  );
}

export async function loadOrFetchDailyBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const path = cachePathFor(symbol);

  if (isFresh(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
    if (raw.start <= fromMs && raw.end >= toMs - 24 * 60 * 60 * 1000) {
      return raw.candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    }
  }

  console.log(`[fetch-tra266-data] Fetching ${symbol} from Yahoo (${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)})…`);
  const candles = await fetchYahooDaily(symbol, fromMs, toMs);
  if (candles.length === 0) {
    throw new Error(`Yahoo returned 0 daily bars for ${symbol} in [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}]`);
  }
  const entry: CacheEntry = {
    symbol,
    fetchedAt: Date.now(),
    start: candles[0].timestamp,
    end: candles[candles.length - 1].timestamp,
    candles,
  };
  writeFileSync(path, JSON.stringify(entry));
  console.log(`[fetch-tra266-data] ${symbol}: ${candles.length} bars cached (${new Date(entry.start).toISOString().slice(0, 10)} → ${new Date(entry.end).toISOString().slice(0, 10)})`);
  return candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
}

/**
 * TRA-267 — 4H bar variant of {@link loadOrFetchDailyBars}. Source is
 * Coinbase Exchange (1H aggregate, see `coinbase-feed.ts`), not Yahoo, so we
 * give it its own on-disk cache file (`<symbol>.4h.json`) and the same
 * 12-hour freshness window.
 *
 * The cache covers `[fromMs, toMs]`; if the requested span is wider than the
 * cached one, we re-fetch the whole window rather than splicing — Coinbase
 * pagination is fast enough on the Phase-1 universe (5 symbols) and a single
 * source-of-truth file avoids stale-edge bugs.
 */
export async function loadOrFetch4hBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const path = cachePathFor4h(symbol);

  if (isFresh(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
    if (raw.start <= fromMs && raw.end >= toMs - 4 * 60 * 60 * 1000) {
      return raw.candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    }
  }

  console.log(`[fetch-tra266-data] Fetching ${symbol} 4H from Coinbase (${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)})…`);
  const candles = await fetchCoinbase4hBars(symbol, fromMs, toMs);
  if (candles.length === 0) {
    throw new Error(`Coinbase returned 0 4H bars for ${symbol} in [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}]`);
  }
  // TRA-427 — `fetchCoinbase4hBars` returns a gap-filled, contiguous grid.
  // Persist the bridged exchange gaps alongside the bars so the cache is
  // self-describing and `verify-4h-cache.ts` can audit it without re-fetching.
  const gaps = summarize4hGaps(candles);
  const entry: CacheEntry = {
    symbol,
    fetchedAt: Date.now(),
    start: candles[0].timestamp,
    end: candles[candles.length - 1].timestamp,
    candles,
    gaps,
  };
  writeFileSync(path, JSON.stringify(entry));
  const synthetic = gaps.reduce((s, g) => s + g.filledBars, 0);
  console.log(`[fetch-tra266-data] ${symbol} 4H: ${candles.length} bars cached (${new Date(entry.start).toISOString().slice(0, 10)} → ${new Date(entry.end).toISOString().slice(0, 10)}), ${gaps.length} gap(s)/${synthetic} synthetic bar(s)`);
  return candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
}

/**
 * TRA-307 — 1m bar cache for the scalping sweep cell. Single-window 30-day
 * pulls only; the cache filename embeds the date range so re-running with a
 * different window writes to a separate file rather than poisoning the prior
 * fetch.
 */
export async function loadOrFetch1mBars(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const path = cachePathFor1m(symbol, fromMs, toMs);

  if (isFresh(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
    if (raw.start <= fromMs && raw.end >= toMs - 60 * 1000) {
      return raw.candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
    }
  }

  console.log(`[fetch-tra266-data] Fetching ${symbol} 1m from Coinbase (${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)})…`);
  const candles = await fetchCoinbaseMinuteBars(symbol, fromMs, toMs);
  if (candles.length === 0) {
    throw new Error(`Coinbase returned 0 1m bars for ${symbol} in [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}]`);
  }
  const entry: CacheEntry = {
    symbol,
    fetchedAt: Date.now(),
    start: candles[0].timestamp,
    end: candles[candles.length - 1].timestamp,
    candles,
  };
  writeFileSync(path, JSON.stringify(entry));
  console.log(`[fetch-tra266-data] ${symbol} 1m: ${candles.length} bars cached (${new Date(entry.start).toISOString().slice(0, 16)} → ${new Date(entry.end).toISOString().slice(0, 16)})`);
  return candles.filter((c) => c.timestamp >= fromMs && c.timestamp <= toMs);
}

async function main() {
  const fromMs = Date.UTC(2022, 0, 1);
  const toMs = Date.now();
  // TRA-267 — the §8 4H sweep needs both feeds present; do daily first (fast,
  // no network on cache hit) then 4H so a 4H-side failure doesn't block the
  // 1D-parked baseline already validated in TRA-266.
  console.log(`Fetching daily + 4H bars for ${PERP_SHORTS_UNIVERSE.join(', ')} from ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);

  for (const symbol of PERP_SHORTS_UNIVERSE) {
    try {
      const bars = await loadOrFetchDailyBars(symbol, fromMs, toMs);
      const yearsCovered = (bars[bars.length - 1].timestamp - bars[0].timestamp) / (365.25 * 24 * 60 * 60 * 1000);
      const status = yearsCovered >= 4 ? 'OK' : 'SHORT';
      console.log(`  ${symbol} 1D: ${bars.length} bars, ${yearsCovered.toFixed(2)}y [${status}]`);
    } catch (err: unknown) {
      console.error(`  ${symbol} 1D: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  for (const symbol of PERP_SHORTS_UNIVERSE) {
    try {
      const bars = await loadOrFetch4hBars(symbol, fromMs, toMs);
      const yearsCovered = (bars[bars.length - 1].timestamp - bars[0].timestamp) / (365.25 * 24 * 60 * 60 * 1000);
      // 6 4H bars per 24h day → expected count ≈ 6 × daily span (TRA-267 acceptance).
      const expectedFloor = Math.floor((toMs - fromMs) / (365.25 * 24 * 60 * 60 * 1000) * 365.25 * 6 * 0.95);
      const status = bars.length >= expectedFloor && yearsCovered >= 2 ? 'OK' : 'SHORT';
      console.log(`  ${symbol} 4H: ${bars.length} bars, ${yearsCovered.toFixed(2)}y [${status}]`);
    } catch (err: unknown) {
      console.error(`  ${symbol} 4H: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const invoked = process.argv[1] && /[\\/]fetch-tra266-data\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
