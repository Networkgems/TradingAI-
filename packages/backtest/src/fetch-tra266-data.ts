/**
 * TRA-266: pull daily OHLCV bars and cache them to disk so validation
 * harnesses don't re-hit Yahoo on every run.
 *
 * One JSON file per symbol under `packages/backtest/data/`. Cache TTL is
 * 12 hours — long enough to amortise the API hit across an iteration session,
 * short enough that re-running a sweep tomorrow picks up new bars without
 * the operator having to clear the cache.
 *
 * (TRA-4629 removed the 4H / 1m exchange-bar variants along with the rest of
 * the retired non-equity data plumbing; only the Yahoo daily loader remains.)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';
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
      // current fixture windows, so raw volume is faithful here. The
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
