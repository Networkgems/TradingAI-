/**
 * TRA-427 — clean regeneration of the BTC-USD / SOL-USD 4H Coinbase caches.
 *
 * The TRA-423 §8 validation surfaced a `macd_bollinger` OOS regression traced
 * to silent grid gaps in the on-disk 4H caches: `aggregate1hTo4h` only emits a
 * 4H bar when all four 1H constituents are present, so genuine Coinbase
 * exchange gaps (verified missing 1H rows, e.g. BTC-USD 2025-10-25 16:00–20:00
 * UTC) left holes in the grid. Holes shift MACD / Bollinger signal timing and
 * make the cache non-deterministic across fetch snapshots.
 *
 * This fetcher rebuilds the two caches the live book trades against from
 * scratch, paginating 1H bars burst-free (1.5 s spacing, 429-aware backoff),
 * aggregating to 4H, and then **gap-filling** the grid via `fillGrid4h` so the
 * result is contiguous and snapshot-deterministic. Genuine exchange gaps are
 * bridged with synthetic flat bars (O=H=L=C = prior close, volume 0,
 * `synthetic: true`) — explicit, audited handling, not silent omission. The
 * `gaps` audit field is persisted into the `CacheEntry` so `verify-4h-cache.ts`
 * can confirm the grid without re-fetching.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra427-fetch.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { aggregate1hTo4h, fillGrid4h, summarize4hGaps } from './coinbase-feed.js';
import { cachePathFor4h, type CacheEntry } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const COINBASE = 'https://api.exchange.coinbase.com';

// Match the validation harnesses' DATA_START_MS so indicators warm up the same
// way they did for TRA-405 §4.1 / TRA-423 §8.
const FROM_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const TO_MS = Date.now();
const SYMBOLS = ['BTC-USD', 'SOL-USD'];
const GRAN = 3600; // 1H native
const STEP_MS = 300 * GRAN * 1000; // 300-bar window
const GAP_MS = 1500; // burst-free spacing
const RETRY_MS = 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fetchWindow(symbol: string, startMs: number, endMs: number): Promise<Candle[]> {
  const url = new URL(`${COINBASE}/products/${symbol}/candles`);
  url.searchParams.set('granularity', String(GRAN));
  url.searchParams.set('start', new Date(startMs).toISOString());
  url.searchParams.set('end', new Date(endMs).toISOString());
  for (let attempt = 1; attempt <= 6; attempt++) {
    const res = await fetch(url.toString(), { headers: { 'User-Agent': 'TRA-427/1.0' } });
    if (res.ok) {
      const rows = (await res.json()) as ReadonlyArray<[number, number, number, number, number, number]>;
      return rows.map(([t, low, high, open, close, volume]) => ({
        symbol,
        timestamp: t * 1000,
        open,
        high,
        low,
        close,
        volume,
      }));
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
  const path = cachePathFor4h(symbol);
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

  // Aggregate to 4H then gap-fill the grid so the cache is contiguous and
  // snapshot-deterministic — the TRA-427 fix.
  const aggregated = aggregate1hTo4h(deduped);
  const candles = fillGrid4h(aggregated);
  if (candles.length === 0) throw new Error(`${symbol}: 0 4H bars after aggregation`);
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
  const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5);
  console.log(
    `  ${symbol}: ${reqs} reqs → ${candles.length} 4H bars (${aggregated.length} real + ${synthetic} synthetic), ` +
      `${years.toFixed(2)}y, ${gaps.length} exchange gap(s) [OK]`,
  );
  for (const g of gaps) {
    console.log(
      `    gap: ${new Date(g.fromTimestamp).toISOString()} … ${new Date(g.toTimestamp).toISOString()} (${g.filledBars} bar(s) bridged)`,
    );
  }
}

async function main() {
  mkdirSync(DATA_DIR, { recursive: true });
  for (const symbol of SYMBOLS) {
    await fetchSymbol(symbol);
    await sleep(GAP_MS);
  }
  console.log('TRA-427 fetch: done');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
