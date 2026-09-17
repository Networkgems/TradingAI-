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
 * (TRA-4629 removed the retired CLI sweep that drove this harness over the
 * old 4H exchange caches; the exported `buildWindows` / `walkForward` API is
 * unchanged and is consumed by the equity/options gate harnesses.)
 */

import { BacktestRunner } from './runner.js';
import type { Candle } from '@trading-app/shared';
import type { BacktestConfig, BacktestResult } from './types.js';

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
 * caller's harness script.
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
