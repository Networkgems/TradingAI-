/**
 * TRA-427 — `macd_bollinger` OOS re-validation on the regenerated 4H cache.
 *
 * Re-runs the exact TRA-405 §4.1 / TRA-423 §8 cap-OFF configuration —
 * `macd_bollinger`, `cryptoTieredCostModel`, $25k, `portfolioOpts {3,3}`, OOS
 * 2025-01-01 → now — and reports trades / return% / profit-factor / Sharpe so
 * the numbers are directly comparable to the TRA-405 §4.1 validated GO.
 *
 * It reads an on-disk 4H cache directly (no network). Pass a cache-variant
 * suffix to A/B the gap-filled cache against a saved pre-fix snapshot:
 *
 *   tsx src/run-tra427-validation.ts                 # current .4h.json (clean)
 *   tsx src/run-tra427-validation.ts pre-tra427      # .4h.pre-tra427.json (old)
 *
 * Writes reports/tra427-validation.json.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position } from '@trading-app/shared';
import { BacktestRunner } from './runner.js';
import { cryptoTieredCostModel } from '@trading-app/engine';
import { summarize4hGaps } from './coinbase-feed.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');
const DATA_DIR = resolve(HERE, '..', 'data');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01 — indicator warmup
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01
const OOS_END_MS = Date.now();

const SYMBOLS = ['BTC-USD', 'SOL-USD'] as const;
const INITIAL_EQUITY = 25_000;

/** TRA-405 §4.1 validated GO baseline (cap OFF) — the reproduction target. */
const TRA405_BASELINE: Record<string, { trades: number; returnPct: number; profitFactor: number; sharpe: number }> = {
  'BTC-USD': { trades: 24, returnPct: 4.12, profitFactor: 1.62, sharpe: 0.77 },
  'SOL-USD': { trades: 31, returnPct: 5.78, profitFactor: 1.61, sharpe: 0.86 },
};

function cachePath(symbol: string, variant: string): string {
  const suffix = variant ? `4h.${variant}.json` : '4h.json';
  return resolve(DATA_DIR, `${symbol.toLowerCase()}.${suffix}`);
}

function cfg(symbol: string, start: number, end: number): BacktestConfig {
  return {
    symbol,
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'macd_bollinger',
    macdBollingerOpts: { enforceTimeFilter: false },
    costModel: cryptoTieredCostModel(),
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
    // cap OFF — no correlationCapOpts, matching the TRA-405 §4.1 baseline.
  };
}

function metricsOf(r: BacktestResult) {
  return {
    trades: r.totalTrades,
    winRatePct: r.winRate * 100,
    profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : -1,
    sharpe: r.sharpeRatio,
    maxDdPct: r.maxDrawdown * 100,
    totalPnlUsd: r.totalPnl,
    returnPct: (r.totalPnl / INITIAL_EQUITY) * 100,
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const variant = (process.argv[2] ?? '').trim();
  const runner = new BacktestRunner();
  const cells: Array<Record<string, unknown>> = [];

  console.log(`TRA-427 macd_bollinger OOS re-validation — cache variant: ${variant || '(clean .4h.json)'}\n`);

  for (const symbol of SYMBOLS) {
    const path = cachePath(symbol, variant);
    if (!existsSync(path)) {
      console.error(`  ${symbol}: cache ${path} missing — skipping`);
      continue;
    }
    const entry = JSON.parse(readFileSync(path, 'utf-8')) as { candles: Candle[]; gaps?: unknown[] };
    const candles = entry.candles.filter((b) => b.timestamp >= DATA_START_MS && b.timestamp <= OOS_END_MS);
    const synthetic = candles.filter((c) => c.synthetic).length;
    const gapRuns = summarize4hGaps(candles);

    const res = await runner.run(cfg(symbol, OOS_START_MS, OOS_END_MS), candles);
    const m = metricsOf(res);
    const base = TRA405_BASELINE[symbol];
    const pnls = res.trades.map((t: Position) => t.pnl ?? 0);

    const cell = {
      symbol,
      cacheVariant: variant || 'clean',
      bars: candles.length,
      syntheticBars: synthetic,
      gapRuns: gapRuns.length,
      tra405Baseline: base,
      current: m,
      deltaReturnPp: base ? m.returnPct - base.returnPct : null,
      reproducesWithinTolerance: base ? Math.abs(m.returnPct - base.returnPct) <= 1.0 : null,
    };
    cells.push(cell);

    console.log(
      `[${symbol}] ${candles.length} bars (${synthetic} synthetic, ${gapRuns.length} gap run(s))\n` +
        `  TRA-405 §4.1 GO : ${base.trades} tr  ret=${base.returnPct.toFixed(2)}%  PF=${base.profitFactor.toFixed(2)}  shp=${base.sharpe.toFixed(2)}\n` +
        `  clean cache     : ${m.trades} tr  ret=${m.returnPct.toFixed(2)}%  PF=${m.profitFactor.toFixed(2)}  shp=${m.sharpe.toFixed(2)}\n` +
        `  Δ return        : ${(m.returnPct - base.returnPct >= 0 ? '+' : '')}${(m.returnPct - base.returnPct).toFixed(2)}pp  ` +
        `(${Math.abs(m.returnPct - base.returnPct) <= 1.0 ? 'within ±1pp tolerance' : 'OUTSIDE tolerance'})\n` +
        `  trades n=${pnls.length}`,
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-427',
    cacheVariant: variant || 'clean',
    oosWindow: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
    initialEquity: INITIAL_EQUITY,
    strategy: 'macd_bollinger',
    correlationCap: 'OFF',
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    cells,
  };
  const out = resolve(REPORT_DIR, variant ? `tra427-validation.${variant}.json` : 'tra427-validation.json');
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${out}`);
}

const invoked = process.argv[1] && /run-tra427-validation\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
