/**
 * TRA-405 — slow, burst-free 4H bar prefetch.
 *
 * `loadOrFetch4hBars` paginates ~88 Coinbase requests ~270ms apart; that burst
 * trips the Exchange public rate limiter and 429s every symbol after the
 * first. This fetcher makes the same paginated 1H pulls but spaces them 3s
 * apart so the rolling rate window never fills, aggregates to 4H with the
 * shared `aggregate1hTo4h`, and writes the on-disk cache file in the exact
 * `CacheEntry` shape `loadOrFetch4hBars` reads — so the validation harness
 * runs entirely off cache with no further network.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { aggregate1hTo4h } from './coinbase-feed.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const COINBASE = 'https://api.exchange.coinbase.com';

const FROM_MS = Date.UTC(2023, 4, 1);
const TO_MS = Date.now();
const SYMBOLS = ['SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD'];
const GRAN = 3600; // 1H native
const STEP_MS = 300 * GRAN * 1000; // 300-bar window
const GAP_MS = 3000; // burst-free spacing
const RETRY_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWindow(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const url = new URL(`${COINBASE}/products/${symbol}/candles`);
  url.searchParams.set('granularity', String(GRAN));
  url.searchParams.set('start', new Date(startMs).toISOString());
  url.searchParams.set('end', new Date(endMs).toISOString());
  for (let attempt = 1; attempt <= 5; attempt++) {
    const res = await fetch(url.toString(), { headers: { 'User-Agent': 'TRA-405/1.0' } });
    if (res.ok) {
      const rows = (await res.json()) as ReadonlyArray<[number, number, number, number, number, number]>;
      return rows.map(([t, low, high, open, close, volume]) => ({ symbol, timestamp: t * 1000, open, high, low, close, volume }));
    }
    if (res.status === 429) {
      console.error(`    429 — backing off ${RETRY_MS / 1000}s (attempt ${attempt})`);
      await sleep(RETRY_MS);
      continue;
    }
    throw new Error(`Coinbase ${res.status} for ${symbol}: ${(await res.text()).slice(0, 120)}`);
  }
  throw new Error(`${symbol}: exhausted retries on window ${new Date(startMs).toISOString()}`);
}

async function fetchSymbol(symbol: string): Promise<void> {
  const path = resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`);
  if (existsSync(path)) {
    console.log(`  ${symbol}: cache present, skipping`);
    return;
  }
  console.log(`  ${symbol}: fetching 1H ${new Date(FROM_MS).toISOString().slice(0, 10)} → now…`);
  const hourly: Candle[] = [];
  let cursor = FROM_MS;
  let reqs = 0;
  while (cursor < TO_MS) {
    const winEnd = Math.min(cursor + STEP_MS, TO_MS);
    hourly.push(...(await fetchWindow(symbol, cursor, winEnd)));
    reqs++;
    cursor = winEnd;
    if (cursor < TO_MS) await sleep(GAP_MS);
  }
  hourly.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<number>();
  const deduped = hourly.filter((c) => (seen.has(c.timestamp) ? false : (seen.add(c.timestamp), true)));
  const candles = aggregate1hTo4h(deduped);
  if (candles.length === 0) throw new Error(`${symbol}: 0 4H bars after aggregation`);
  const entry = { symbol, fetchedAt: Date.now(), start: candles[0].timestamp, end: Date.now(), candles };
  writeFileSync(path, JSON.stringify(entry));
  const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5);
  console.log(`  ${symbol}: ${reqs} reqs → ${candles.length} 4H bars, ${years.toFixed(2)}y [OK]`);
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const symbol of SYMBOLS) {
    try {
      await fetchSymbol(symbol);
    } catch (err) {
      console.error(`  ${symbol}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    }
    await sleep(GAP_MS);
  }
  console.log('done');
}

main().catch((err) => { console.error(err); process.exit(1); });
