/**
 * TRA-405 — Strategy profitability validation on REAL historical data.
 *
 * Spun out of the TRA-402 review (§2/§4): the canonical `walk-forward.ts` and
 * `run-monte-carlo.ts` run on `syntheticCryptoSeries`, so headline Sharpe /
 * drawdown numbers do not predict live performance. This harness re-runs the
 * backtest on real Coinbase Exchange 4H bars and reports in-sample vs
 * out-of-sample metrics separately, per strategy and per symbol, after the
 * tiered cost model.
 *
 * IS/OOS split rationale: TRA-402 §2 notes the production strategy constants
 * were "tuned in-sample on short windows of 2024 Coinbase data". So the honest
 * out-of-sample test is the period *after* that tuning:
 *   IS  = 2023-05-01 .. 2024-12-31  (overlaps the tuning era)
 *   OOS = 2025-01-01 .. now         (genuinely unseen by the parameter tuning)
 * Each window is run as one continuous expanding-window backtest so indicators
 * warm up naturally (no per-window cold-start starvation — see report caveats).
 *
 * It is a RESEARCH harness (QuantTrader-owned), not application code: it only
 * consumes existing exported APIs. Productionising the synthetic -> real swap
 * inside `walk-forward.ts` / `run-monte-carlo.ts` is delegated to LeadDev.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra405-validation.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position } from '@trading-app/shared';
import { BacktestRunner } from './runner.js';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';
import { cryptoTieredCostModel, cryptoTierOf } from '@trading-app/engine';
import type { BacktestConfig, BacktestResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_START_MS = Date.UTC(2023, 4, 1);
const IS_END_MS = Date.UTC(2025, 0, 1) - 1; // 2024-12-31 23:59:59.999
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01
const OOS_END_MS = Date.now();

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD'] as const;
const INITIAL_EQUITY = 25_000;

type StrategyType = BacktestConfig['strategyType'];

interface StrategySpec {
  name: string;
  type: StrategyType;
  extra: Partial<BacktestConfig>;
}

// Configs mirror the live router call-site / TRA-306 conventions.
const STRATEGIES: StrategySpec[] = [
  { name: 'reversal', type: 'reversal', extra: { reversalOpts: { enforceTimeFilter: false, rsiOverbought: 65, rsiOversold: 35 } } },
  { name: 'macd_bollinger', type: 'macd_bollinger', extra: { macdBollingerOpts: { enforceTimeFilter: false } } },
  { name: 'momentum', type: 'momentum', extra: { momentumOpts: {} } },
  { name: 'breakout_vol', type: 'breakout_vol', extra: { breakoutVolOpts: {} } },
  { name: 'mean_reversion', type: 'mean_reversion', extra: { meanReversionOpts: {}, meanReversionRiskPct: 0.0075 } },
];

interface SegMetrics {
  trades: number;
  winRatePct: number;
  expectancyR: number;
  profitFactor: number;
  sharpe: number;
  maxDdPct: number;
  totalPnlUsd: number;
  worstCasePnlUsd: number;
  returnPct: number;
}

function metricsOf(r: BacktestResult): SegMetrics {
  return {
    trades: r.totalTrades,
    winRatePct: r.winRate * 100,
    expectancyR: r.expectancy,
    profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : -1,
    sharpe: r.sharpeRatio,
    maxDdPct: r.maxDrawdown * 100,
    totalPnlUsd: r.totalPnl,
    worstCasePnlUsd: r.worstCaseTotalPnl,
    returnPct: (r.totalPnl / INITIAL_EQUITY) * 100,
  };
}

/**
 * Moving-block bootstrap over the realised per-trade PnL sequence. Unlike the
 * IID `bootstrapEquityCurves` (TRA-172), this resamples *blocks* of consecutive
 * trades so within-block autocorrelation (losing streaks, winning clusters)
 * survives the resample — the TRA-402 §4 fix for the Monte Carlo independence
 * flaw. Reports the dollar p5/p50/p95 final equity and the worst drawdown.
 */
function blockBootstrap(pnls: number[], initialEquity: number, blockLen = 5, iterations = 3000, seed = 405) {
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

interface Cell {
  symbol: string;
  costTier: string;
  strategy: string;
  is: SegMetrics;
  oos: SegMetrics;
  oosBlockBootstrap: ReturnType<typeof blockBootstrap>;
}

function cfg(symbol: string, spec: StrategySpec, start: number, end: number): BacktestConfig {
  return {
    symbol,
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: spec.type,
    costModel: cryptoTieredCostModel(),
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
    ...spec.extra,
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();
  const cells: Cell[] = [];

  for (const symbol of SYMBOLS) {
    process.stdout.write(`\n[${symbol}] loading 4H bars… `);
    let candles: Candle[];
    try {
      candles = await loadOrFetch4hBars(symbol, DATA_START_MS, OOS_END_MS);
    } catch (err) {
      console.error(`FAILED — ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5);
    const tier = cryptoTierOf(symbol);
    console.log(`${candles.length} bars, ${years.toFixed(2)}y, cost tier=${tier}`);

    for (const spec of STRATEGIES) {
      const isRes = await runner.run(cfg(symbol, spec, IS_START_MS, IS_END_MS), candles);
      const oosRes = await runner.run(cfg(symbol, spec, OOS_START_MS, OOS_END_MS), candles);
      const oosPnls = oosRes.trades.map((t: Position) => t.pnl ?? 0);
      const cell: Cell = {
        symbol,
        costTier: String(tier),
        strategy: spec.name,
        is: metricsOf(isRes),
        oos: metricsOf(oosRes),
        oosBlockBootstrap: oosPnls.length >= 8 ? blockBootstrap(oosPnls, INITIAL_EQUITY) : null,
      };
      cells.push(cell);
      console.log(
        `  ${spec.name.padEnd(15)} ` +
          `IS[${String(cell.is.trades).padStart(3)}tr exp=${cell.is.expectancyR.toFixed(2)}R ` +
          `ret=${cell.is.returnPct.toFixed(1)}% shp=${cell.is.sharpe.toFixed(2)}] ` +
          `OOS[${String(cell.oos.trades).padStart(3)}tr exp=${cell.oos.expectancyR.toFixed(2)}R ` +
          `wr=${cell.oos.winRatePct.toFixed(0)}% ret=${cell.oos.returnPct.toFixed(1)}% ` +
          `shp=${cell.oos.sharpe.toFixed(2)} ddMax=${cell.oos.maxDdPct.toFixed(1)}%]`,
      );
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    isWindow: { start: new Date(IS_START_MS).toISOString(), end: new Date(IS_END_MS).toISOString() },
    oosWindow: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
    initialEquity: INITIAL_EQUITY,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    costModel: 'cryptoTieredCostModel (TRA-185)',
    cells,
  };
  writeFileSync(resolve(REPORT_DIR, 'tra405-validation.json'), JSON.stringify(payload, null, 2));
  console.log(`\nWrote ${cells.length} cells -> reports/tra405-validation.json`);
}

const invoked = process.argv[1] && /run-tra405-validation\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
