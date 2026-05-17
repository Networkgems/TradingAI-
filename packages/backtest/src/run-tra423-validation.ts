/**
 * TRA-423 — Portfolio correlation / concentration cap §8 validation.
 *
 * QuantTrader-owned RESEARCH harness (not application code): re-runs the
 * backtest runner on the TRA-405 validated {BTC-USD, SOL-USD} `macd_bollinger`
 * book with the TRA-411 correlation/concentration cap toggled OFF vs ON, and
 * reports the spec §8 acceptance checks:
 *
 *   1. OOS return not materially degraded vs the cap-off baseline.
 *   2. Worst-case drawdown / 5th-percentile bootstrap path improve or unchanged.
 *   3. The cap actually binds (rejected + scaledDown > 0).
 *
 * Note on book construction: `BacktestRunner.run()` is single-symbol. The
 * `macd_bollinger` strategyType however fans out to TWO sub-strategies
 * (`macd_trend` + `bb_fade`), whose positions carry distinct `signalType`s and
 * therefore CAN be open simultaneously on one symbol. A single-symbol
 * `macd_bollinger` run is thus a real 2-position correlated book (same symbol
 * ⇒ ρ=1.0 ⇒ one cluster), which exercises the cluster risk / notional / count
 * caps. The cross-symbol BTC+SOL cluster (4 possible positions) needs a
 * multi-symbol portfolio runner — flagged in the report if it is missing.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra423-validation.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position } from '@trading-app/shared';
import { BacktestRunner } from './runner.js';
import { cachePathFor4h } from './fetch-tra266-data.js';
import { cryptoTieredCostModel } from '@trading-app/engine';
import type { BacktestConfig, BacktestResult, CorrelationCapOpts } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01 — genuinely unseen by tuning
const OOS_END_MS = Date.now();

const SYMBOLS = ['BTC-USD', 'SOL-USD'] as const;
const INITIAL_EQUITY = 25_000;

/** Resample 4H bars to daily UTC closes — the §3 correlation source. */
function toDailyCandles(bars: Candle[]): Candle[] {
  const byDay = new Map<number, Candle[]>();
  for (const b of bars) {
    const day = Math.floor(b.timestamp / 864e5) * 864e5;
    (byDay.get(day) ?? byDay.set(day, []).get(day)!).push(b);
  }
  return [...byDay.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([day, group]) => ({
      symbol: group[0].symbol,
      timestamp: day,
      open: group[0].open,
      high: Math.max(...group.map(g => g.high)),
      low: Math.min(...group.map(g => g.low)),
      close: group[group.length - 1].close,
      volume: group.reduce((s, g) => s + g.volume, 0),
    }));
}

/** Moving-block bootstrap (same estimator as run-tra405-validation.ts §5). */
function blockBootstrap(pnls: number[], initialEquity: number, blockLen = 5, iterations = 3000, seed = 423) {
  if (pnls.length === 0) return null;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = pnls.length;
  const finals: number[] = [];
  let worstDd = 0;
  for (let it = 0; it < iterations; it++) {
    let equity = initialEquity;
    let peak = initialEquity;
    let dd = 0;
    let drawn = 0;
    while (drawn < n) {
      const start = Math.floor(rand() * n);
      for (let k = 0; k < blockLen && drawn < n; k++, drawn++) {
        equity += pnls[(start + k) % n];
        peak = Math.max(peak, equity);
        if (peak > 0) dd = Math.max(dd, (peak - equity) / peak);
      }
    }
    finals.push(equity);
    worstDd = Math.max(worstDd, dd);
  }
  finals.sort((a, b) => a - b);
  const pct = (p: number) => finals[Math.min(finals.length - 1, Math.floor((p / 100) * finals.length))];
  return { p5: pct(5), p50: pct(50), p95: pct(95), worstDdPct: worstDd * 100, blockLen, iterations };
}

function metricsOf(r: BacktestResult) {
  return {
    trades: r.totalTrades,
    winRatePct: r.winRate * 100,
    expectancyR: r.expectancy,
    sharpe: r.sharpeRatio,
    maxDdPct: r.maxDrawdown * 100,
    totalPnlUsd: r.totalPnl,
    worstCasePnlUsd: r.worstCaseTotalPnl,
    returnPct: (r.totalPnl / INITIAL_EQUITY) * 100,
    worstCaseReturnPct: (r.worstCaseTotalPnl / INITIAL_EQUITY) * 100,
    correlationCap: r.correlationCap ?? null,
  };
}

function cfg(
  symbol: string,
  start: number,
  end: number,
  correlationCapOpts?: CorrelationCapOpts,
): BacktestConfig {
  return {
    symbol,
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'macd_bollinger',
    macdBollingerOpts: { enforceTimeFilter: false },
    costModel: cryptoTieredCostModel(),
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
    correlationCapOpts,
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();

  // Load 4H bars + derive the daily correlation source for both symbols.
  const bars: Record<string, Candle[]> = {};
  const daily: Record<string, Candle[]> = {};
  for (const symbol of SYMBOLS) {
    process.stdout.write(`[${symbol}] loading cached 4H bars… `);
    // Read the on-disk Coinbase cache directly — loadOrFetch4hBars would
    // re-fetch (12h freshness window) and the public endpoint is rate-limited.
    const cache = JSON.parse(readFileSync(cachePathFor4h(symbol), 'utf-8')) as { candles: Candle[] };
    const c = cache.candles.filter(b => b.timestamp >= DATA_START_MS && b.timestamp <= OOS_END_MS);
    bars[symbol] = c;
    daily[symbol] = toDailyCandles(c);
    console.log(`${c.length} 4H bars, ${daily[symbol].length} daily bars`);
  }

  const capOpts: CorrelationCapOpts = {
    enabled: true,
    // Real Coinbase daily history for the §3 correlation estimate.
    dailyCandlesBySymbol: { ...daily },
  };

  type CellEntry = ReturnType<typeof metricsOf> & {
    oosBlockBootstrap: ReturnType<typeof blockBootstrap>;
  };
  type Cell = { symbol: string; capOff: CellEntry; capOn: CellEntry };

  const cells: Cell[] = [];
  for (const symbol of SYMBOLS) {
    const off = await runner.run(cfg(symbol, OOS_START_MS, OOS_END_MS), bars[symbol]);
    const on = await runner.run(cfg(symbol, OOS_START_MS, OOS_END_MS, capOpts), bars[symbol]);

    const offPnls = off.trades.map((t: Position) => t.pnl ?? 0);
    const onPnls = on.trades.map((t: Position) => t.pnl ?? 0);

    const cell = {
      symbol,
      capOff: {
        ...metricsOf(off),
        oosBlockBootstrap: offPnls.length >= 8 ? blockBootstrap(offPnls, INITIAL_EQUITY) : null,
      },
      capOn: {
        ...metricsOf(on),
        oosBlockBootstrap: onPnls.length >= 8 ? blockBootstrap(onPnls, INITIAL_EQUITY) : null,
      },
    };
    cells.push(cell);
    const cc = on.correlationCap;
    console.log(
      `\n[${symbol}] OOS macd_bollinger\n` +
        `  cap OFF: ${off.totalTrades} tr  ret=${((off.totalPnl / INITIAL_EQUITY) * 100).toFixed(2)}%  ` +
        `ddMax=${(off.maxDrawdown * 100).toFixed(2)}%  shp=${off.sharpeRatio.toFixed(2)}\n` +
        `  cap ON : ${on.totalTrades} tr  ret=${((on.totalPnl / INITIAL_EQUITY) * 100).toFixed(2)}%  ` +
        `ddMax=${(on.maxDrawdown * 100).toFixed(2)}%  shp=${on.sharpeRatio.toFixed(2)}\n` +
        `  cap activity: rejected=${cc?.rejected ?? 0}  scaledDown=${cc?.scaledDown ?? 0}`,
    );
  }

  const totalRejected = cells.reduce((s, c) => s + (c.capOn.correlationCap?.rejected ?? 0), 0);
  const totalScaled = cells.reduce((s, c) => s + (c.capOn.correlationCap?.scaledDown ?? 0), 0);

  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-423',
    spec: 'TRA-411 correlation-cap-spec §8',
    oosWindow: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
    initialEquity: INITIAL_EQUITY,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    capConfig: 'recommended defaults (TRA-411 §5)',
    cells,
    capBindsTotal: { rejected: totalRejected, scaledDown: totalScaled },
  };
  writeFileSync(resolve(REPORT_DIR, 'tra423-validation.json'), JSON.stringify(payload, null, 2));
  console.log(`\nWrote reports/tra423-validation.json — cap binds total: rejected=${totalRejected} scaledDown=${totalScaled}`);
}

const invoked = process.argv[1] && /run-tra423-validation\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
