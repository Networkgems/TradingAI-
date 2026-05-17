/**
 * TRA-427 — on-disk 4H cache audit.
 *
 * Asserts every `<symbol>.4h.json` cache holds a contiguous 4H grid: bar
 * spacing is exactly 14,400,000 ms with no missing slots. Any genuine exchange
 * gap must be bridged by synthetic flat bars (`synthetic: true`) and recorded
 * in the entry's `gaps` audit field — silent omission is a hard failure.
 *
 * Exit code 0 = all caches contiguous and self-consistent; 1 = at least one
 * cache has an unbridged hole or a `gaps`/synthetic-bar mismatch.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/verify-4h-cache.ts
 *   pnpm --filter @trading-app/backtest exec tsx src/verify-4h-cache.ts BTC-USD SOL-USD
 */

import { existsSync, readFileSync } from 'node:fs';
import type { CacheEntry } from './fetch-tra266-data.js';
import { cachePathFor4h, DEFAULT_4H_SYMBOLS } from './fetch-tra266-data.js';
import { summarize4hGaps } from './coinbase-feed.js';

const FOUR_HOURS_MS = 14_400_000;

interface AuditResult {
  symbol: string;
  ok: boolean;
  bars: number;
  syntheticBars: number;
  realBars: number;
  recordedGaps: number;
  problems: string[];
}

function auditSymbol(symbol: string): AuditResult {
  const path = cachePathFor4h(symbol);
  const problems: string[] = [];
  if (!existsSync(path)) {
    return { symbol, ok: false, bars: 0, syntheticBars: 0, realBars: 0, recordedGaps: 0, problems: ['cache file missing'] };
  }
  const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  const candles = entry.candles ?? [];

  // 1. Grid contiguity — every step must be exactly one 4H slot.
  let holes = 0;
  for (let i = 1; i < candles.length; i++) {
    const delta = candles[i].timestamp - candles[i - 1].timestamp;
    if (delta !== FOUR_HOURS_MS) {
      holes++;
      const missing = delta / FOUR_HOURS_MS - 1;
      problems.push(
        `unbridged hole before ${new Date(candles[i].timestamp).toISOString()} ` +
          `(${delta} ms = ${missing} missing bar(s))`,
      );
    }
  }

  // 2. Synthetic bars are flat with zero volume.
  const syntheticBars = candles.filter((c) => c.synthetic).length;
  for (const c of candles) {
    if (c.synthetic && !(c.open === c.high && c.high === c.low && c.low === c.close && c.volume === 0)) {
      problems.push(`malformed synthetic bar at ${new Date(c.timestamp).toISOString()} (not flat / volume != 0)`);
    }
  }

  // 3. The persisted `gaps` audit field matches the synthetic bars on disk.
  const derived = summarize4hGaps(candles);
  const derivedSynthetic = derived.reduce((s, g) => s + g.filledBars, 0);
  if (syntheticBars !== derivedSynthetic) {
    problems.push(`synthetic-bar count ${syntheticBars} != gap-run total ${derivedSynthetic}`);
  }
  const recorded = entry.gaps ?? [];
  const recordedSynthetic = recorded.reduce((s, g) => s + g.filledBars, 0);
  if (entry.gaps === undefined) {
    problems.push('entry.gaps audit field missing (legacy cache — regenerate via run-tra427-fetch.ts)');
  } else if (recordedSynthetic !== syntheticBars) {
    problems.push(`entry.gaps total ${recordedSynthetic} != synthetic bars on disk ${syntheticBars}`);
  }

  return {
    symbol,
    ok: holes === 0 && problems.length === 0,
    bars: candles.length,
    syntheticBars,
    realBars: candles.length - syntheticBars,
    recordedGaps: recorded.length,
    problems,
  };
}

function main() {
  const argv = process.argv.slice(2);
  const symbols = argv.length > 0 ? argv : DEFAULT_4H_SYMBOLS;
  let failed = 0;
  console.log(`TRA-427 4H cache audit — ${symbols.length} symbol(s)\n`);
  for (const symbol of symbols) {
    const r = auditSymbol(symbol);
    const tag = r.ok ? 'OK ' : 'FAIL';
    console.log(
      `[${tag}] ${symbol}: ${r.bars} bars (${r.realBars} real + ${r.syntheticBars} synthetic), ${r.recordedGaps} gap(s)`,
    );
    for (const p of r.problems) console.log(`        - ${p}`);
    if (!r.ok) failed++;
  }
  console.log(`\n${failed === 0 ? 'All caches contiguous and self-consistent.' : `${failed} cache(s) FAILED audit.`}`);
  process.exit(failed === 0 ? 0 : 1);
}

const invoked = process.argv[1] && /verify-4h-cache\.(ts|js)$/.test(process.argv[1]);
if (invoked) main();
