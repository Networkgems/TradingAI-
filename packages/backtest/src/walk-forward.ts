/**
 * Walk-forward optimization (TRA-172).
 *
 * Why walk-forward instead of a single in-sample sweep: a one-shot grid search
 * over the full history is the textbook recipe for over-fitting — the chosen
 * parameters will look great on the data they were tuned on and quietly fall
 * apart out of sample. Walk-forward fixes that by: (1) splitting history into
 * rolling (train, test) windows; (2) sweeping parameters on `train` only;
 * (3) picking the best-Sharpe params; and (4) reporting the *out-of-sample*
 * performance on `test`. The aggregated test-window stats are the realistic
 * estimate of forward performance.
 *
 * Run with the workspace tsx wrapper:
 *   pnpm --filter @trading-app/backtest exec tsx src/walk-forward.ts
 *
 * Outputs `walk-forward-results.csv` in the package root with one row per
 * (strategy, window, picked-params, oos metrics).
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRunner } from './runner.js';
import { syntheticCryptoSeries } from './synthetic.js';
import type { Candle } from '@trading-app/shared';
import type { BacktestConfig, BacktestResult } from './types.js';

const INITIAL_EQUITY = 25_000;
const SYMBOL = 'BTC-USD';
const DAYS = 90;
const BAR_INTERVAL_MIN = 60; // hourly candles → 24 bars/day

const BARS_PER_DAY = Math.floor((24 * 60) / BAR_INTERVAL_MIN);

export interface WindowSpec {
  trainStart: number; // bar index (inclusive)
  trainEnd: number;   // bar index (exclusive)
  testStart: number;  // bar index (inclusive)
  testEnd: number;    // bar index (exclusive)
}

/**
 * Rolling-origin window split. Both windows are expressed in *bar counts* so
 * the splitter is calendar-agnostic — callers pass any candle series and the
 * train/test sizes appropriate to its bar interval.
 */
export function buildWindows(
  totalBars: number,
  trainBars: number,
  testBars: number,
  step: number = testBars,
): WindowSpec[] {
  const windows: WindowSpec[] = [];
  let origin = 0;
  while (origin + trainBars + testBars <= totalBars) {
    windows.push({
      trainStart: origin,
      trainEnd: origin + trainBars,
      testStart: origin + trainBars,
      testEnd: origin + trainBars + testBars,
    });
    origin += step;
  }
  return windows;
}

/**
 * TRA-203 walk-forward harness. Runs `config` on each rolling test slice and
 * returns one {@link BacktestResult} per window plus an aggregate that
 * concatenates the per-window trade lists and recomputes headline metrics.
 *
 * The aggregate exposes the *out-of-sample* picture you'd report when
 * pitching the strategy: train slices are intentionally not run here because
 * walk-forward cares about OOS performance — parameter sweeps live in the
 * harness script (see {@link main} below).
 */
export interface WalkForwardOptions {
  trainBars: number;
  testBars: number;
  /** Window advance per step. Defaults to `testBars` (non-overlapping tests). */
  stepBars?: number;
}

export interface WalkForwardReport {
  windows: BacktestResult[];
  /**
   * Concatenated trades across every test window with metrics recomputed.
   * `config.startDate`/`endDate` are clamped to the first window's start and
   * the last window's end so downstream consumers see the OOS span as a
   * single contiguous run. The bar series passed to the runner is the union
   * of test slices, so per-bar Sharpe annualization stays valid.
   */
  aggregate: BacktestResult;
}

export async function walkForward(
  config: BacktestConfig,
  candles: Candle[],
  opts: WalkForwardOptions,
): Promise<WalkForwardReport> {
  const stepBars = opts.stepBars ?? opts.testBars;
  const windows = buildWindows(candles.length, opts.trainBars, opts.testBars, stepBars);
  const runner = new BacktestRunner();

  const windowResults: BacktestResult[] = [];
  const aggregateCandles: Candle[] = [];
  for (const win of windows) {
    const slice = candles.slice(win.testStart, win.testEnd);
    if (slice.length === 0) continue;
    const result = await runner.run(
      {
        ...config,
        startDate: slice[0].timestamp,
        endDate: slice[slice.length - 1].timestamp,
      },
      slice,
    );
    windowResults.push(result);
    aggregateCandles.push(...slice);
  }

  if (windowResults.length === 0) {
    // No valid windows — return an empty aggregate so callers don't have to
    // special-case `undefined`. Matches the shape a single empty run would
    // produce, with the original config echoed back for traceability.
    const empty = await runner.run(config, []);
    return { windows: [], aggregate: empty };
  }

  // Aggregate: rerun the config across the union of test slices. This is
  // cheaper than stitching per-window stats and keeps Sharpe/MDD computed by
  // the same code path used elsewhere — drift would silently bias headline
  // numbers.
  const aggregate = await runner.run(
    {
      ...config,
      startDate: aggregateCandles[0].timestamp,
      endDate: aggregateCandles[aggregateCandles.length - 1].timestamp,
    },
    aggregateCandles,
  );

  return { windows: windowResults, aggregate };
}

interface ParamPoint {
  label: string;
  reversalOpts?: BacktestConfig['reversalOpts'];
  macdBollingerOpts?: BacktestConfig['macdBollingerOpts'];
}

const REVERSAL_GRID: ParamPoint[] = [];
for (const rsiOverbought of [65, 70, 75]) {
  for (const lookback of [4, 5, 7]) {
    REVERSAL_GRID.push({
      label: `rsiOB=${rsiOverbought},lookback=${lookback}`,
      reversalOpts: {
        rsiOverbought,
        rsiOversold: 100 - rsiOverbought,
        lookback,
        enforceTimeFilter: false,
      },
    });
  }
}

const MACD_GRID: ParamPoint[] = [];
for (const bbPeriod of [15, 20, 25]) {
  for (const volumeMultiplier of [1.2, 1.5, 2.0]) {
    MACD_GRID.push({
      label: `bb=${bbPeriod},vol×=${volumeMultiplier}`,
      macdBollingerOpts: {
        bbPeriod,
        volumeMultiplier,
        enforceTimeFilter: false,
      },
    });
  }
}

const STRATEGIES: Array<{
  name: string;
  type: BacktestConfig['strategyType'];
  grid: ParamPoint[];
}> = [
  { name: 'reversal', type: 'reversal', grid: REVERSAL_GRID },
  { name: 'macd_bollinger', type: 'macd_bollinger', grid: MACD_GRID },
];

async function evaluateOnSlice(
  runner: BacktestRunner,
  slice: Candle[],
  type: BacktestConfig['strategyType'],
  point: ParamPoint,
): Promise<BacktestResult> {
  const start = slice[0].timestamp;
  const end = slice[slice.length - 1].timestamp;
  return runner.run(
    {
      symbol: SYMBOL,
      startDate: start,
      endDate: end,
      initialEquity: INITIAL_EQUITY,
      strategyType: type,
      reversalOpts: point.reversalOpts,
      macdBollingerOpts: point.macdBollingerOpts,
      portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
    },
    slice,
  );
}

async function main() {
  const candles = syntheticCryptoSeries(DAYS, SYMBOL, 30_000, BAR_INTERVAL_MIN, 31);
  const trainBars = 60 * BARS_PER_DAY;
  const testBars = 30 * BARS_PER_DAY;
  const windows = buildWindows(candles.length, trainBars, testBars);

  console.log(`Generated ${candles.length} ${BAR_INTERVAL_MIN}-min candles for ${SYMBOL} (${DAYS} days).`);
  console.log(`Walk-forward: train=${trainBars} bars (${trainBars / BARS_PER_DAY}d), test=${testBars} bars (${testBars / BARS_PER_DAY}d), windows=${windows.length}`);

  const runner = new BacktestRunner();
  const rows: string[] = [
    'strategy,window,trainStart,trainEnd,testStart,testEnd,pickedParams,trainSharpe,trainTrades,testSharpe,testPnl,testWinRate,testTrades,testSignalEdgePct',
  ];

  for (const strat of STRATEGIES) {
    for (let w = 0; w < windows.length; w++) {
      const win = windows[w];
      const trainSlice = candles.slice(win.trainStart, win.trainEnd);
      const testSlice = candles.slice(win.testStart, win.testEnd);

      let best: { point: ParamPoint; sharpe: number; trades: number } | null = null;
      for (const point of strat.grid) {
        const r = await evaluateOnSlice(runner, trainSlice, strat.type, point);
        // Tie-break: prefer the point with more trades when sharpe is degenerate
        // (zero trades or near-zero variance both yield sharpe = 0).
        if (
          best === null ||
          r.sharpeRatio > best.sharpe ||
          (r.sharpeRatio === best.sharpe && r.totalTrades > best.trades)
        ) {
          best = { point, sharpe: r.sharpeRatio, trades: r.totalTrades };
        }
      }
      if (best === null) continue;

      const oos = await evaluateOnSlice(runner, testSlice, strat.type, best.point);
      rows.push([
        strat.name,
        String(w),
        String(win.trainStart),
        String(win.trainEnd),
        String(win.testStart),
        String(win.testEnd),
        `"${best.point.label}"`,
        best.sharpe.toFixed(4),
        String(best.trades),
        oos.sharpeRatio.toFixed(4),
        oos.totalPnl.toFixed(2),
        (oos.winRate * 100).toFixed(2),
        String(oos.totalTrades),
        oos.signalEdge?.hitRatePct.toFixed(2) ?? '0.00',
      ].join(','));

      console.log(
        `  [${strat.name} window ${w}] train sharpe=${best.sharpe.toFixed(3)} (${best.trades} trades) → ` +
          `OOS sharpe=${oos.sharpeRatio.toFixed(3)} pnl=$${oos.totalPnl.toFixed(2)} ` +
          `winRate=${(oos.winRate * 100).toFixed(1)}% trades=${oos.totalTrades} ` +
          `picked=[${best.point.label}]`,
      );
    }
  }

  // Anchor output to the package root regardless of cwd.
  const here = dirname(fileURLToPath(import.meta.url));
  const outPath = resolve(here, '..', 'walk-forward-results.csv');
  writeFileSync(outPath, rows.join('\n') + '\n');
  console.log(`\nWrote ${rows.length - 1} rows to ${outPath}`);
}

// Anchor to a path separator so files like `run-tra203-walk-forward.ts` don't
// also trigger this main() — without the separator, `walk-forward.ts` is a
// suffix match and both scripts execute on a single tsx invocation.
const invoked = process.argv[1] && /[\\/]walk-forward\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch(err => { console.error(err); process.exit(1); });
