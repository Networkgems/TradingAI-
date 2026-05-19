/**
 * TRA-453 — bb_fade major-coin scope validation.
 *
 * The board's starting suggestion for the simplified crypto roster scopes to
 * BTC/ETH/SOL, but TRA-306's strategy ranking only swept SOL-USD + DOGE-USD.
 * This script fills the gap: it runs `bb_fade` on the same 12-month / 4H
 * window (2025-05-01 → 2026-04-30 UTC) for BTC, ETH, SOL and DOGE so the
 * roster recommendation has real-data evidence for every candidate symbol.
 *
 * Config mirrors run-tra306-sweep.ts exactly (initialEquity $25k, 40 bps
 * Coinbase taker, 5 bps slippage, fractionalQuantity true, bb_fade cell with
 * enforceTimeFilter:false). Live applyShortGates / regime / funding overlay
 * is NOT applied — this measures raw per-symbol bb_fade edge.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra453-bbfade-majors.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRunner } from './runner.js';
import type { BacktestConfig } from './types.js';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const WINDOW_START_MS = Date.UTC(2025, 4, 1);
const WINDOW_END_MS = Date.UTC(2026, 4, 1) - 1;
const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;
const FEE_BPS = 40;
const SLIPPAGE_BPS = 5;

function profitFactor(pnls: number[]): number {
  let gross = 0;
  let loss = 0;
  for (const p of pnls) {
    if (p > 0) gross += p;
    else loss += Math.abs(p);
  }
  return loss > 0 ? gross / loss : gross > 0 ? Infinity : 0;
}

async function main() {
  console.log(`[tra453] bb_fade 4H sweep — window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ${new Date(WINDOW_END_MS).toISOString().slice(0, 10)}`);
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();
  const rows: Record<string, unknown>[] = [];

  for (const symbol of SYMBOLS) {
    const candles = await loadOrFetch4hBars(symbol, WINDOW_START_MS, WINDOW_END_MS);
    const config: BacktestConfig = {
      symbol,
      startDate: WINDOW_START_MS,
      endDate: WINDOW_END_MS,
      initialEquity: INITIAL_EQUITY_USD,
      strategyType: 'bb_fade',
      feeBps: FEE_BPS,
      slippageBps: SLIPPAGE_BPS,
      fractionalQuantity: true,
      macdBollingerOpts: { enforceTimeFilter: false },
    };
    const result = await runner.run(config, candles);
    const longs = result.trades.filter((t) => t.side === 'buy');
    const longPnls = longs.map((t) => t.pnl ?? 0);
    const longWins = longPnls.filter((p) => p > 0).length;
    const row = {
      symbol,
      bars: candles.length,
      totalTrades: result.totalTrades,
      winRate: result.winRate,
      expectancy: result.expectancy,
      profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : 0,
      sharpeRatio: result.sharpeRatio,
      maxDrawdownPct: result.maxDrawdown,
      totalPnlUsd: result.totalPnl,
      longTrades: longs.length,
      longWinRate: longs.length > 0 ? longWins / longs.length : 0,
      longPnlUsd: longPnls.reduce((s, p) => s + p, 0),
      longProfitFactor: profitFactor(longPnls),
    };
    rows.push(row);
    console.log(
      `[tra453] ${symbol}: ${result.totalTrades} trades (${longs.length} long), ` +
      `WR=${(result.winRate * 100).toFixed(0)}%, exp=${result.expectancy >= 0 ? '+' : ''}${result.expectancy.toFixed(2)}R, ` +
      `PF=${row.profitFactor.toFixed(2)}, Sharpe=${result.sharpeRatio.toFixed(2)}, ` +
      `PnL=$${result.totalPnl.toFixed(0)} | long-only PnL=$${row.longPnlUsd.toFixed(0)} PF=${row.longProfitFactor.toFixed(2)}`,
    );
  }

  const path = resolve(REPORT_DIR, 'tra453-bbfade-majors.json');
  writeFileSync(path, JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowStart: new Date(WINDOW_START_MS).toISOString().slice(0, 10),
    windowEnd: new Date(WINDOW_END_MS).toISOString().slice(0, 10),
    strategy: 'bb_fade',
    timeframe: '4h',
    initialEquityUsd: INITIAL_EQUITY_USD,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    results: rows,
  }, null, 2));
  console.log(`[tra453] report written: ${path}`);
}

const invoked = process.argv[1] && /[\\/]run-tra453-bbfade-majors\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
