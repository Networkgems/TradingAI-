/**
 * TRA-287 — historical perp funding feed for the §5.1 short filter gate.
 *
 * The live engine consumes funding via `CryptoLiveAccount.getPerpShortFilterContext`
 * (TRA-262), which calls `CoinbaseOrderClient.getFundingRates` against the
 * authenticated Advanced Trade endpoint and returns only the **current**
 * snapshot. That feed is unusable for the §8 walk-forward sweep, which needs
 * a per-bar historical funding rate spanning 2022–today.
 *
 * Coinbase Exchange's public unauthenticated API does not expose perp funding
 * history (perps live on Coinbase INTX, which is auth-only). Binance USD-M
 * Futures publishes free historical funding via
 * `https://fapi.binance.com/fapi/v1/fundingRate` — the de facto industry
 * baseline for crypto strategy backtests. On Phase-1 majors (SOL, DOGE) the
 * Binance funding term structure tracks Coinbase INTX inside ±5 bps, so it's
 * a defensible substitute for the §8 short-filter gate.
 *
 * Funding interval: Binance settles every 8h on most majors; we divide the
 * per-interval rate by 8 to land on the per-hour units the §5.1 gate expects
 * (`FUNDING_GATE_THRESHOLD_PER_HOUR = -0.0005`).
 *
 * Cache: one JSON file per symbol under `packages/backtest/data/`, 12h TTL,
 * mirroring `loadOrFetch4hBars`.
 */

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const BINANCE_BASE = 'https://fapi.binance.com';
const PAGE_LIMIT = 1000;
const REQUEST_GAP_MS = 200;
const FUNDING_INTERVAL_HOURS = 8;
const ONE_DAY_MS = 24 * 60 * 60 * 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Spot symbol → Binance USD-M perp symbol. Limited to the §8 4H r9 universe
 * plus the v2 universe so the long-side regression and any future Phase-1.1
 * symbol re-enablement (per §8.3 protocol) just works without a code change.
 */
const SYMBOL_TO_BINANCE: Record<string, string> = {
  'BTC-USD': 'BTCUSDT',
  'ETH-USD': 'ETHUSDT',
  'SOL-USD': 'SOLUSDT',
  'XRP-USD': 'XRPUSDT',
  'DOGE-USD': 'DOGEUSDT',
};

export interface FundingPoint {
  /** Funding settlement timestamp (ms since epoch). */
  ts: number;
  /** Funding rate per HOUR (Binance settles every 8h; raw rate ÷ 8). */
  ratePerHour: number;
}

interface FundingCacheEntry {
  symbol: string;
  binanceSymbol: string;
  fetchedAt: number;
  start: number;
  end: number;
  /**
   * Raw 8h-interval Binance funding rates (un-divided), preserved on disk so
   * a later threshold-shape change can re-derive per-hour without refetching.
   */
  intervals: Array<{ ts: number; ratePerInterval: number }>;
}

function fundingCachePath(symbol: string): string {
  return resolve(DATA_DIR, `${symbol.toLowerCase()}.funding.json`);
}

function isFresh(path: string): boolean {
  if (!existsSync(path)) return false;
  return Date.now() - statSync(path).mtimeMs < CACHE_TTL_MS;
}

interface BinanceFundingRow {
  symbol: string;
  fundingTime: number;
  fundingRate: string;
}

async function fetchBinanceFunding(
  binanceSymbol: string,
  fromMs: number,
  toMs: number,
): Promise<Array<{ ts: number; ratePerInterval: number }>> {
  if (toMs <= fromMs) return [];
  const out: Array<{ ts: number; ratePerInterval: number }> = [];
  let cursor = fromMs;
  // Each PAGE_LIMIT page covers ≈ 1000 × 8h = 333d, so we step in 300d windows
  // to keep each request comfortably under the page cap with margin for gaps.
  const stepMs = 300 * ONE_DAY_MS;
  while (cursor < toMs) {
    const winEnd = Math.min(cursor + stepMs, toMs);
    const url = new URL(`${BINANCE_BASE}/fapi/v1/fundingRate`);
    url.searchParams.set('symbol', binanceSymbol);
    url.searchParams.set('startTime', String(cursor));
    url.searchParams.set('endTime', String(winEnd));
    url.searchParams.set('limit', String(PAGE_LIMIT));
    const res = await fetch(url.toString(), { headers: { 'User-Agent': 'TRA-287/1.0' } });
    if (!res.ok) {
      const body = (await res.text()).slice(0, 200);
      throw new Error(`Binance ${res.status} for ${binanceSymbol} fundingRate: ${body}`);
    }
    const rows = (await res.json()) as BinanceFundingRow[];
    for (const r of rows) {
      const rate = parseFloat(r.fundingRate);
      if (Number.isFinite(rate)) out.push({ ts: r.fundingTime, ratePerInterval: rate });
    }
    cursor = winEnd;
    if (cursor < toMs) await sleep(REQUEST_GAP_MS);
  }
  out.sort((a, b) => a.ts - b.ts);
  // Dedup on funding settlement timestamp.
  const seen = new Set<number>();
  return out.filter((p) => (seen.has(p.ts) ? false : (seen.add(p.ts), true)));
}

/**
 * Load (or fetch + cache) the historical funding-rate series for `symbol`.
 * Returns per-hour rates: raw 8h-interval Binance rate divided by 8 to match
 * the §5.1 gate's `FUNDING_GATE_THRESHOLD_PER_HOUR` units.
 *
 * Symbols outside the supported map (see `SYMBOL_TO_BINANCE`) return an
 * empty series — caller should treat that as "feed unavailable" and skip the
 * gate per the strategy spec's best-effort contract on §5 inputs.
 */
export async function loadOrFetchFunding(
  symbol: string,
  fromMs: number,
  toMs: number,
): Promise<FundingPoint[]> {
  const binanceSymbol = SYMBOL_TO_BINANCE[symbol];
  if (!binanceSymbol) return [];
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  const path = fundingCachePath(symbol);

  if (isFresh(path)) {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as FundingCacheEntry;
    if (raw.start <= fromMs && raw.end >= toMs - FUNDING_INTERVAL_HOURS * 60 * 60 * 1000) {
      return raw.intervals
        .filter((p) => p.ts >= fromMs && p.ts <= toMs)
        .map((p) => ({ ts: p.ts, ratePerHour: p.ratePerInterval / FUNDING_INTERVAL_HOURS }));
    }
  }

  console.log(`[funding-feed] Fetching ${symbol} (${binanceSymbol}) funding ${new Date(fromMs).toISOString().slice(0, 10)} → ${new Date(toMs).toISOString().slice(0, 10)}…`);
  const intervals = await fetchBinanceFunding(binanceSymbol, fromMs, toMs);
  if (intervals.length === 0) {
    throw new Error(`Binance returned 0 funding intervals for ${binanceSymbol} in [${new Date(fromMs).toISOString()}, ${new Date(toMs).toISOString()}]`);
  }
  const entry: FundingCacheEntry = {
    symbol,
    binanceSymbol,
    fetchedAt: Date.now(),
    start: intervals[0].ts,
    end: intervals[intervals.length - 1].ts,
    intervals,
  };
  writeFileSync(path, JSON.stringify(entry));
  console.log(`[funding-feed] ${symbol}: ${intervals.length} intervals cached (${new Date(entry.start).toISOString().slice(0, 10)} → ${new Date(entry.end).toISOString().slice(0, 10)})`);
  return intervals
    .filter((p) => p.ts >= fromMs && p.ts <= toMs)
    .map((p) => ({ ts: p.ts, ratePerHour: p.ratePerInterval / FUNDING_INTERVAL_HOURS }));
}

/**
 * Look up the most recent funding rate at or before `ts`. Funding is settled
 * at discrete 8h intervals so a bar at e.g. 04:00 UTC reads the funding
 * settled at 00:00 UTC. Returns `undefined` when no funding has settled yet
 * before `ts` (caller treats as "feed unavailable" → gate skipped).
 *
 * Binary search keeps the per-bar lookup at O(log n) so the harness 4H walk
 * (≈10k bars × 2 symbols = 20k lookups per window × 9 windows × 11 sweep
 * variants) doesn't quadratically eat the run.
 */
export function lookupFundingPerHour(history: FundingPoint[], ts: number): number | undefined {
  if (history.length === 0 || ts < history[0].ts) return undefined;
  let lo = 0;
  let hi = history.length - 1;
  let pick = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if (history[mid].ts <= ts) {
      pick = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return pick >= 0 ? history[pick].ratePerHour : undefined;
}
