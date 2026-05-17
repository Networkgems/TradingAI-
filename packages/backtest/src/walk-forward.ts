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
import { loadOrFetch4hBars } from './fetch-tra266-data.js';
import { cryptoTieredCostModel } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import type { BacktestConfig, BacktestResult } from './types.js';

const INITIAL_EQUITY = 25_000;
const SYMBOL = 'BTC-USD';
// TRA-420 §1: the committed harness runs on real Coinbase 4H bars — 6 bars
// per 24h day — not the retired 90-day synthetic series.
const BARS_PER_DAY = 6;
// 4H bars: warmup must cover the slowest indicator window (200-bar EMA /
// 90-bar ATR-median regime window). 250 bars clears both with margin.
const WARMUP_BARS = 250;
// Aligned with the TRA-405 4H data window (the on-disk Coinbase cache).
const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01

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
  /**
   * TRA-420 §3: trailing warmup bars prefixed before each test slice. Without
   * it a 30-day 4H test slice (~180 bars) cannot warm a 200-bar EMA or a
   * 90-bar ATR-median regime window, so OOS trade counts get starved to ~0.
   * The warmup bars advance indicator state only — no trades are opened or
   * counted there. Defaults to 0 (cold start, legacy behaviour).
   */
  warmupBars?: number;
}

export interface WalkForwardReport {
  windows: BacktestResult[];
  /**
   * Out-of-sample aggregate: a single continuous run spanning the first test
   * window's start to the last test window's end, prefixed with `warmupBars`
   * of warmup history. With the default non-overlapping cadence the test
   * windows are contiguous, so this span is exactly their union and per-bar
   * Sharpe annualization stays valid. Metrics cover only the test span — the
   * warmup prefix advances indicator state but opens no positions.
   */
  aggregate: BacktestResult;
}

export async function walkForward(
  config: BacktestConfig,
  candles: Candle[],
  opts: WalkForwardOptions,
): Promise<WalkForwardReport> {
  const stepBars = opts.stepBars ?? opts.testBars;
  const warmupBars = Math.max(0, opts.warmupBars ?? 0);
  const windows = buildWindows(candles.length, opts.trainBars, opts.testBars, stepBars);
  const runner = new BacktestRunner();

  const windowResults: BacktestResult[] = [];
  for (const win of windows) {
    if (win.testEnd <= win.testStart) continue;
    // TRA-420 §3: pass the full candle array and carve the test window with
    // date bounds. `warmupStartDate` pulls trailing history into the runner's
    // view so indicators are warm by the first test bar; only trades opened
    // at-or-after `startDate` are counted.
    const warmupIdx = Math.max(0, win.testStart - warmupBars);
    const result = await runner.run(
      {
        ...config,
        warmupStartDate: candles[warmupIdx].timestamp,
        startDate: candles[win.testStart].timestamp,
        endDate: candles[win.testEnd - 1].timestamp,
      },
      candles,
    );
    windowResults.push(result);
  }

  if (windowResults.length === 0) {
    // No valid windows — return an empty aggregate so callers don't have to
    // special-case `undefined`. Matches the shape a single empty run would
    // produce, with the original config echoed back for traceability.
    const empty = await runner.run(config, []);
    return { windows: [], aggregate: empty };
  }

  // Aggregate: one continuous run over the span of every test window, warmed
  // by a trailing prefix before the first window. Keeps Sharpe/MDD on the
  // same code path used elsewhere — drift would silently bias headline numbers.
  const firstTest = windows[0].testStart;
  const lastTestEnd = windows[windows.length - 1].testEnd;
  const aggWarmupIdx = Math.max(0, firstTest - warmupBars);
  const aggregate = await runner.run(
    {
      ...config,
      warmupStartDate: candles[aggWarmupIdx].timestamp,
      startDate: candles[firstTest].timestamp,
      endDate: candles[lastTestEnd - 1].timestamp,
    },
    candles,
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

/**
 * Run one strategy/param point over a single warmed window. `candles` is the
 * full series; the runner carves `[evalStart, evalEnd]` for evaluation and
 * uses `[warmupStart, evalStart)` purely to warm indicators (TRA-420 §3).
 */
async function evaluateWindow(
  runner: BacktestRunner,
  candles: Candle[],
  type: BacktestConfig['strategyType'],
  point: ParamPoint,
  warmupStart: number,
  evalStart: number,
  evalEnd: number,
): Promise<BacktestResult> {
  return runner.run(
    {
      symbol: SYMBOL,
      warmupStartDate: warmupStart,
      startDate: evalStart,
      endDate: evalEnd,
      initialEquity: INITIAL_EQUITY,
      strategyType: type,
      // TRA-420 §1: real data → real costs. Same tiered crypto cost model the
      // TRA-405 validation harness and the live router use.
      costModel: cryptoTieredCostModel(),
      reversalOpts: point.reversalOpts,
      macdBollingerOpts: point.macdBollingerOpts,
      portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
    },
    candles,
  );
}

async function main() {
  // TRA-420 §1: real Coinbase 4H bars, not the retired synthetic series.
  const candles = await loadOrFetch4hBars(SYMBOL, DATA_START_MS, Date.now());
  const trainBars = 120 * BARS_PER_DAY;
  const testBars = 30 * BARS_PER_DAY;
  const windows = buildWindows(candles.length, trainBars, testBars);

  const span = candles.length
    ? (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5)
    : 0;
  console.log(`Loaded ${candles.length} real Coinbase 4H bars for ${SYMBOL} (${span.toFixed(2)}y).`);
  console.log(
    `Walk-forward: train=${trainBars} bars (${trainBars / BARS_PER_DAY}d, in-sample sweep), ` +
      `test=${testBars} bars (${testBars / BARS_PER_DAY}d, out-of-sample), ` +
      `warmup=${WARMUP_BARS} bars, windows=${windows.length}`,
  );
  if (windows.length === 0) {
    throw new Error(
      `Not enough bars (${candles.length}) for train+test = ${trainBars + testBars}`,
    );
  }

  const runner = new BacktestRunner();
  // IS (train-window sweep) and OOS (test-window) columns are reported side by
  // side so the in-sample vs out-of-sample gap is visible per row.
  const rows: string[] = [
    'strategy,window,trainStart,trainEnd,testStart,testEnd,pickedParams,' +
      'isSharpe,isTrades,isPnl,oosSharpe,oosPnl,oosWinRate,oosTrades,oosSignalEdgePct',
  ];

  for (const strat of STRATEGIES) {
    for (let w = 0; w < windows.length; w++) {
      const win = windows[w];
      const trainWarmup = candles[Math.max(0, win.trainStart - WARMUP_BARS)].timestamp;
      const trainStartTs = candles[win.trainStart].timestamp;
      const trainEndTs = candles[win.trainEnd - 1].timestamp;
      const testWarmup = candles[Math.max(0, win.testStart - WARMUP_BARS)].timestamp;
      const testStartTs = candles[win.testStart].timestamp;
      const testEndTs = candles[win.testEnd - 1].timestamp;

      // ── In-sample: sweep the grid on the warmed train window.
      let best: { point: ParamPoint; is: BacktestResult } | null = null;
      for (const point of strat.grid) {
        const r = await evaluateWindow(
          runner, candles, strat.type, point, trainWarmup, trainStartTs, trainEndTs,
        );
        // Tie-break: prefer the point with more trades when sharpe is degenerate
        // (zero trades or near-zero variance both yield sharpe = 0).
        if (
          best === null ||
          r.sharpeRatio > best.is.sharpeRatio ||
          (r.sharpeRatio === best.is.sharpeRatio && r.totalTrades > best.is.totalTrades)
        ) {
          best = { point, is: r };
        }
      }
      if (best === null) continue;

      // ── Out-of-sample: evaluate the picked params on the warmed test window.
      const oos = await evaluateWindow(
        runner, candles, strat.type, best.point, testWarmup, testStartTs, testEndTs,
      );
      rows.push([
        strat.name,
        String(w),
        String(win.trainStart),
        String(win.trainEnd),
        String(win.testStart),
        String(win.testEnd),
        `"${best.point.label}"`,
        best.is.sharpeRatio.toFixed(4),
        String(best.is.totalTrades),
        best.is.totalPnl.toFixed(2),
        oos.sharpeRatio.toFixed(4),
        oos.totalPnl.toFixed(2),
        (oos.winRate * 100).toFixed(2),
        String(oos.totalTrades),
        oos.signalEdge?.hitRatePct.toFixed(2) ?? '0.00',
      ].join(','));

      console.log(
        `  [${strat.name} window ${w}] ` +
          `IS sharpe=${best.is.sharpeRatio.toFixed(3)} trades=${best.is.totalTrades} ` +
          `pnl=$${best.is.totalPnl.toFixed(2)} → ` +
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
