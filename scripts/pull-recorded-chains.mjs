#!/usr/bin/env node
/**
 * TRA-1049 — pull the recorded option-chain dataset from the Render box onto the
 * local backtest box.
 *
 * The daily recorder (TRA-380) writes real Tradier chains to the Render
 * persistent disk at `/data/option-chains/<YYYY-MM-DD>/<SYMBOL>.json`. The
 * backtest box has no shell access to that disk, so this script mirrors the
 * partitions locally via the read-only export endpoints:
 *   GET /api/health/chain-capture                 -> list of captured dates
 *   GET /api/health/chain-capture/partition/:date -> one date's per-symbol files
 *
 * Output layout matches what `loadChainDays` (packages/backtest) expects, so the
 * TRA-1047 T2/T3 replay sweeps read it with no further conversion:
 *   <OUT_DIR>/<YYYY-MM-DD>/<SYMBOL>.json
 *   <OUT_DIR>/<YYYY-MM-DD>/_meta.json
 *
 * Usage:
 *   node scripts/pull-recorded-chains.mjs
 *   BASE=https://tradingai-bqb1.onrender.com OUT_DIR=./data/option-chains node scripts/pull-recorded-chains.mjs
 *
 * Env:
 *   BASE     server base URL (default https://tradingai-bqb1.onrender.com)
 *   OUT_DIR  local mirror root (default ./data/option-chains)
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const BASE = (process.env.BASE ?? 'https://tradingai-bqb1.onrender.com').replace(/\/+$/, '');
const OUT_DIR = process.env.OUT_DIR ?? './data/option-chains';

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(90_000) });
  if (!res.ok) throw new Error(`${path} -> HTTP ${res.status}`);
  return res.json();
}

async function main() {
  console.log(`[pull-recorded-chains] base=${BASE} out=${OUT_DIR}`);
  const cap = await getJson('/api/health/chain-capture');
  const dates = [];
  // chain-capture exposes first/last + count but not the full list; enumerate
  // the inclusive trading-day range and skip dates with no partition (404).
  if (cap.firstDate && cap.lastDate) {
    for (let d = new Date(`${cap.firstDate}T00:00:00Z`); ; d.setUTCDate(d.getUTCDate() + 1)) {
      const key = d.toISOString().slice(0, 10);
      dates.push(key);
      if (key === cap.lastDate) break;
    }
  }
  console.log(
    `[pull-recorded-chains] tradingDaysCaptured=${cap.tradingDaysCaptured} ` +
      `range=${cap.firstDate}..${cap.lastDate} candidates=${dates.length}`,
  );

  let pulledDays = 0;
  let pulledFiles = 0;
  for (const date of dates) {
    let part;
    try {
      part = await getJson(`/api/health/chain-capture/partition/${date}`);
    } catch (err) {
      // Weekend / holiday / non-trading day has no partition — skip quietly.
      if (String(err).includes('HTTP 404')) continue;
      console.warn(`[pull-recorded-chains] ${date}: ${err.message}`);
      continue;
    }
    const dir = join(OUT_DIR, date);
    await mkdir(dir, { recursive: true });
    if (part.meta) {
      await writeFile(join(dir, '_meta.json'), JSON.stringify(part.meta, null, 2), 'utf-8');
    }
    for (const snap of part.symbols ?? []) {
      if (!snap || typeof snap.symbol !== 'string') continue;
      await writeFile(join(dir, `${snap.symbol.toUpperCase()}.json`), JSON.stringify(snap), 'utf-8');
      pulledFiles += 1;
    }
    pulledDays += 1;
    const hasIvr = (part.symbols ?? []).filter((s) => s && s.ivRank != null).length;
    console.log(
      `[pull-recorded-chains] ${date}: ${part.symbolCount} symbols, ivRank populated on ${hasIvr}`,
    );
  }
  console.log(`[pull-recorded-chains] done: ${pulledDays} days, ${pulledFiles} files -> ${OUT_DIR}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
