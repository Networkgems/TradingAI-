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
}

export function cachePathFor(symbol: string): string {
  return resolve(DATA_DIR, `${symbol.toLowerCase()}.json`);
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
  return quotes
    .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({
      symbol,
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume ?? 0,
    }));
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

async function main() {
  const fromMs = Date.UTC(2022, 0, 1);
  const toMs = Date.now();
  console.log(`Fetching daily bars for ${PERP_SHORTS_UNIVERSE.join(', ')} from ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}`);

  for (const symbol of PERP_SHORTS_UNIVERSE) {
    try {
      const bars = await loadOrFetchDailyBars(symbol, fromMs, toMs);
      const yearsCovered = (bars[bars.length - 1].timestamp - bars[0].timestamp) / (365.25 * 24 * 60 * 60 * 1000);
      const status = yearsCovered >= 4 ? 'OK' : 'SHORT';
      console.log(`  ${symbol}: ${bars.length} bars, ${yearsCovered.toFixed(2)}y [${status}]`);
    } catch (err: unknown) {
      console.error(`  ${symbol}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}

const invoked = process.argv[1] && /[\\/]fetch-tra266-data\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
