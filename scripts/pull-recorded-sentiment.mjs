#!/usr/bin/env node
/**
 * TRA-1324 (TRA-820 Step 1) — pull the recorded StockTwits sentiment dataset
 * from the Render box onto the local backtest/grading box.
 *
 * The daily recorder (TRA-822) writes real StockTwits sentiment snapshots to the
 * Render persistent disk at
 * `/data/sentiment-snapshots/<YYYY-MM-DD>/sentiment.json` (+ `_meta.json`). The
 * grading box has no shell access to that disk, so this script mirrors the
 * partitions locally via the read-only export endpoints:
 *   GET /api/health/sentiment-capture                 -> captured date range
 *   GET /api/health/sentiment-capture/partition/:date -> one date's rows + meta
 *
 * Output layout matches what `loadSentimentDays` (packages/backtest,
 * sentiment-snapshot-store.ts) expects, so `run-tra822-sentiment-ic.ts` reads it
 * with no further conversion:
 *   <OUT_DIR>/<YYYY-MM-DD>/sentiment.json
 *   <OUT_DIR>/<YYYY-MM-DD>/_meta.json
 *
 * This is the sentiment sibling of TRA-1049's `pull-recorded-chains.mjs`; run
 * both to mirror bqb1's full co-accrued IC/flow dataset locally.
 *
 * Usage:
 *   node scripts/pull-recorded-sentiment.mjs
 *   BASE=https://tradingai-bqb1.onrender.com OUT_DIR=./data/sentiment-snapshots \
 *     node scripts/pull-recorded-sentiment.mjs
 *
 * Env:
 *   BASE     server base URL (default https://tradingai-bqb1.onrender.com)
 *   OUT_DIR  local mirror root (default ./data/sentiment-snapshots)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = (process.env.BASE ?? 'https://tradingai-bqb1.onrender.com').replace(/\/+$/, '');
const OUT_DIR = process.env.OUT_DIR ?? './data/sentiment-snapshots';

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`[pull-recorded-sentiment] base=${BASE} out=${OUT_DIR}`);
  const cap = await getJson('/api/health/sentiment-capture');
  const dates = [];
  // sentiment-capture exposes first/last + count but not the full list; enumerate
  // the inclusive trading-day range and skip dates with no partition (404).
  if (cap.firstDate && cap.lastDate) {
    for (let d = new Date(`${cap.firstDate}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      dates.push(key);
      if (key === cap.lastDate) break;
    }
  }
  console.log(
    `[pull-recorded-sentiment] tradingDaysCaptured=${cap.tradingDaysCaptured} ` +
      `range=${cap.firstDate}..${cap.lastDate} candidates=${dates.length}`,
  );

  let pulledDays = 0;
  let recordedRows = 0;
  for (const date of dates) {
    let part;
    try {
      part = await getJson(`/api/health/sentiment-capture/partition/${date}`);
    } catch (err) {
      // Weekend / holiday / non-trading day has no partition — skip quietly.
      if (String(err).includes('HTTP 404')) continue;
      console.warn(`[pull-recorded-sentiment] ${date}: ${err.message}`);
      continue;
    }
    if (!part.sentiment || !Array.isArray(part.sentiment.symbols)) {
      console.warn(`[pull-recorded-sentiment] ${date}: no sentiment payload, skipping`);
      continue;
    }
    const dir = join(OUT_DIR, date);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'sentiment.json'), JSON.stringify(part.sentiment), 'utf-8');
    if (part.meta) {
      await writeFile(join(dir, '_meta.json'), JSON.stringify(part.meta, null, 2), 'utf-8');
    }
    pulledDays += 1;
    const recorded = part.sentiment.symbols.filter((s) => s && s.outcome === 'recorded').length;
    recordedRows += recorded;
    console.log(
      `[pull-recorded-sentiment] ${date}: ${part.symbolCount} symbols, recorded on ${recorded}`,
    );
  }
  console.log(
    `[pull-recorded-sentiment] done: ${pulledDays} days, ${recordedRows} recorded rows -> ${OUT_DIR}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
