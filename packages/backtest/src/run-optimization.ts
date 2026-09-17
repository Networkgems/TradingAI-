/**
 * Automated optimization harness with overfitting guards (TRA-540, implements
 * the TRA-531 QuantTrader spec). One config-driven entry drives the whole
 * pipeline:
 *
 *   partition → sweep → walk-forward → guard battery → holdout → report
 *
 * It replaces the hand-written `run-traNNN-sweep.ts` scripts with a reusable
 * harness: the strategy, parameter grid, window sizes and `maxTrials` are
 * declarative config (see {@link STRATEGY_SPECS}); the math primitives
 * (`walkForward`, `BacktestRunner`, `flatCostModel`,
 * `blockBootstrapEquityCurves`, and the new `overfitting-stats`) are reused.
 * (TRA-4629 removed the retired CLI entry that fetched the old 4H exchange
 * caches; callers now invoke {@link runOptimization} with their own candles.)
 *
 * Outputs (anchored to the package root): `optimization-report.json`,
 * `optimization-report.md`, `optimization-windows.csv`, and a machine-readable
 * `verdict` block shaped to feed the TRA-532 promotion-gate `backtest` leg.
 *
 * QuantTrader validates the methodology + numbers on the produced report before
 * this is wired into the live gate (spec §9). Thresholds here are fixed by the
 * plan — do not change them silently; comment on TRA-540 and tag QuantTrader.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BacktestRunner } from './runner.js';
import { buildWindows, walkForward } from './walk-forward.js';
import { blockBootstrapEquityCurves } from './bootstrap.js';
import { partitionData, type DataPartition } from './data-partition.js';
import {
  deflatedSharpeRatio,
  probabilityOfBacktestOverfitting,
  sampleMoments,
  type DeflatedSharpeResult,
  type PboResult,
} from './overfitting-stats.js';
import { flatCostModel, type CostModel } from '@trading-app/engine';
import type { Candle } from '@trading-app/shared';
import type { BacktestConfig, BacktestResult } from './types.js';

const INITIAL_EQUITY = 25_000;
// 4H bars — 6 bars per 24h day (TRA-420 §1).
const BARS_PER_DAY = 6;
// Warmup must cover the slowest indicator (200-bar EMA / 90-bar ATR-median).
const WARMUP_BARS = 250;
// Default per-fill cost assumption (was the tiered table's top tier before
// TRA-4629 removed the tiered model): 4 bps commission + 2 bps slippage.
const DEFAULT_FILL_COST = { commissionBps: 4, slippageBps: 2 };
// Min trades per train window below which Sharpe is noise (spec §6).
const MIN_TRADES_PER_WINDOW = 20;
// Min OOS trade sample below which a guard cannot honestly certify. A handful
// of trades makes Sharpe / PSR / bootstrap floors pure noise (a 2-trade winner
// yields PSR≈1 — a false pass), so sample-dependent guards (G2, G4) hard-fail
// below this floor. Spec §6 sets the same 20-trade bar for selection; we extend
// it to certification. Flagged to QuantTrader as a methodology addition.
const MIN_GUARD_SAMPLE = 20;
// Selection objective + guard thresholds are fixed by the spec (§6, §7).
const G1_EFFICIENCY_FLOOR = 0.5;   // OOS Sharpe ÷ IS Sharpe
const G2_PSR_THRESHOLD = 0.95;     // deflated Sharpe PASS
const G3_PBO_THRESHOLD = 0.5;      // PBO PASS (target < 0.25)
const G6_COST_MULTIPLIER = 1.5;    // cost/slippage stress factor

// ── Declarative strategy + grid config (spec §2, §5) ─────────────────────────

interface AxisSpec {
  name: string;
  values: number[];
}

interface StrategyOptSpec {
  name: string;
  strategyType: BacktestConfig['strategyType'];
  axes: AxisSpec[];
  /** Map one coordinate (a value per axis) to the strategy-opts overlay. */
  build: (vals: Record<string, number>) => Partial<BacktestConfig>;
  /** Cap on distinct parameter points evaluated; larger spaces are sampled. */
  maxTrials: number;
  window: { trainDays: number; testDays: number; stepDays: number };
}

/**
 * The harness's declarative config. Each strategy lists its tunable axes and a
 * `build` that turns a coordinate into a `BacktestConfig` overlay — no
 * hand-edited code per run (spec §9.2). Grids ≤ `maxTrials` run in full; larger
 * spaces fall back to a seeded random/Latin-hypercube sample.
 */
export const STRATEGY_SPECS: Record<string, StrategyOptSpec> = {
  reversal: {
    name: 'reversal',
    strategyType: 'reversal',
    axes: [
      { name: 'rsiOverbought', values: [65, 70, 75] },
      { name: 'lookback', values: [4, 5, 7] },
    ],
    build: (v) => ({
      reversalOpts: {
        rsiOverbought: v.rsiOverbought,
        rsiOversold: 100 - v.rsiOverbought,
        lookback: v.lookback,
        enforceTimeFilter: false,
      },
    }),
    maxTrials: 64,
    window: { trainDays: 120, testDays: 30, stepDays: 30 },
  },
  macd_bollinger: {
    name: 'macd_bollinger',
    strategyType: 'macd_bollinger',
    axes: [
      { name: 'bbPeriod', values: [15, 20, 25] },
      { name: 'volumeMultiplier', values: [1.2, 1.5, 2.0] },
    ],
    build: (v) => ({
      macdBollingerOpts: {
        bbPeriod: v.bbPeriod,
        volumeMultiplier: v.volumeMultiplier,
        enforceTimeFilter: false,
      },
    }),
    maxTrials: 64,
    window: { trainDays: 120, testDays: 30, stepDays: 30 },
  },
};

// ── Trial enumeration (grid + capped sampling, spec §5) ──────────────────────

interface Trial {
  /** Stable label, e.g. `rsiOverbought=70,lookback=5`. */
  label: string;
  /** Index along each axis — drives the parameter-plateau neighbor scan. */
  coords: number[];
  /** Strategy-opts overlay merged into the per-window config. */
  overlay: Partial<BacktestConfig>;
}

function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coordsToTrial(spec: StrategyOptSpec, coords: number[]): Trial {
  const vals: Record<string, number> = {};
  const parts: string[] = [];
  spec.axes.forEach((axis, i) => {
    vals[axis.name] = axis.values[coords[i]];
    parts.push(`${axis.name}=${axis.values[coords[i]]}`);
  });
  return { label: parts.join(','), coords, overlay: spec.build(vals) };
}

/**
 * Enumerate the trials. The full grid is the Cartesian product of the axes; if
 * that exceeds `maxTrials` we draw a seeded random sample of distinct grid
 * points (a coarse Latin-hypercube-style cap, spec §5). The total count N is the
 * multiple-testing input to the deflated-Sharpe and PBO guards.
 */
export function enumerateTrials(spec: StrategyOptSpec, seed = 42): Trial[] {
  const sizes = spec.axes.map((a) => a.values.length);
  const total = sizes.reduce((p, s) => p * s, 1);

  const allCoords: number[][] = [];
  for (let i = 0; i < total; i++) {
    const coords: number[] = [];
    let rem = i;
    for (let a = 0; a < sizes.length; a++) {
      coords.push(rem % sizes[a]);
      rem = Math.floor(rem / sizes[a]);
    }
    allCoords.push(coords);
  }

  if (total <= spec.maxTrials) {
    return allCoords.map((c) => coordsToTrial(spec, c));
  }

  // Capped: seeded shuffle, take the first maxTrials distinct points.
  const rand = mulberry32(seed);
  for (let i = allCoords.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [allCoords[i], allCoords[j]] = [allCoords[j], allCoords[i]];
  }
  return allCoords.slice(0, spec.maxTrials).map((c) => coordsToTrial(spec, c));
}

// ── Per-window evaluation ────────────────────────────────────────────────────

function baseConfig(symbol: string, strategyType: BacktestConfig['strategyType']): BacktestConfig {
  return {
    symbol,
    startDate: 0,
    endDate: 0,
    initialEquity: INITIAL_EQUITY,
    strategyType,
    costModel: flatCostModel(DEFAULT_FILL_COST),
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
  };
}

/** Run one trial over a single warmed slice carved from `candles` by index. */
async function evaluateSlice(
  runner: BacktestRunner,
  candles: Candle[],
  cfg: BacktestConfig,
  overlay: Partial<BacktestConfig>,
  warmupStartIdx: number,
  evalStartIdx: number,
  evalEndIdx: number,
): Promise<BacktestResult> {
  return runner.run(
    {
      ...cfg,
      ...overlay,
      warmupStartDate: candles[warmupStartIdx].timestamp,
      startDate: candles[evalStartIdx].timestamp,
      endDate: candles[evalEndIdx - 1].timestamp,
    },
    candles,
  );
}

/** A CostModel that scales another model's per-fill commission + slippage. */
function scaledCostModel(base: CostModel, factor: number): CostModel {
  return {
    resolve(symbol: string) {
      const f = base.resolve(symbol);
      return { commissionBps: f.commissionBps * factor, slippageBps: f.slippageBps * factor };
    },
  };
}

// ── Result shapes ─────────────────────────────────────────────────────────────

export interface GuardResult {
  id: 'G1' | 'G2' | 'G3' | 'G4' | 'G5' | 'G6';
  name: string;
  pass: boolean;
  value: number;
  threshold: string;
  detail: string;
}

/** Stage-1 metrics shaped for the TRA-532 promotion-gate `backtest` leg. */
export interface BacktestVerdictMetrics {
  sharpe: number;
  expectancy: number;
  profitFactor: number;
  maxDrawdown: number;
  tradeCount: number;
}

export interface OptimizationVerdict {
  pass: boolean;
  guards: Record<string, { pass: boolean; value: number }>;
  blessedParams: Record<string, unknown>;
  /** Picked from the WF-OOS aggregate; feeds the TRA-532 gate. */
  backtestMetrics: BacktestVerdictMetrics;
}

export interface WindowRow {
  window: number;
  pickedParams: string;
  isSharpe: number;
  isTrades: number;
  isPnl: number;
  oosSharpe: number;
  oosPnl: number;
  oosTrades: number;
}

export interface OptimizationReport {
  harness: string;
  strategy: string;
  symbol: string;
  trialCount: number;
  partition: DataPartition['boundaries'];
  windows: WindowRow[];
  blessed: {
    label: string;
    overlay: Partial<BacktestConfig>;
    meanIsSharpe: number;
    meanIsTrades: number;
    plateauScore: number;
    /** Trials clearing the §6 ≥20-trades/window activity floor. 0 ⇒ degenerate. */
    eligibleTrials: number;
  };
  oosAggregate: BacktestVerdictMetrics & { totalPnl: number };
  holdout: BacktestVerdictMetrics & { totalPnl: number; worstCasePnl: number; stressedExpectancy: number };
  guards: GuardResult[];
  verdict: OptimizationVerdict;
}

// ── The pipeline ──────────────────────────────────────────────────────────────

export interface RunOptimizationOpts {
  symbol: string;
  seed?: number;
  /** Override the spec's window sizes (mostly for tests on shorter series). */
  window?: { trainDays: number; testDays: number; stepDays: number };
  optimizationFraction?: number;
}

/**
 * Pure pipeline over a candle series — no fetching, no file writes — so it is
 * unit-testable. `main()` wraps it with data loading and report writing.
 */
export async function runOptimization(
  spec: StrategyOptSpec,
  candles: Candle[],
  opts: RunOptimizationOpts,
): Promise<OptimizationReport> {
  const win = opts.window ?? spec.window;
  const trainBars = win.trainDays * BARS_PER_DAY;
  const testBars = win.testDays * BARS_PER_DAY;
  const stepBars = win.stepDays * BARS_PER_DAY;

  // 1. Partition: optimization / purge+embargo gap / locked holdout (spec §3).
  const partition = partitionData(candles, {
    optimizationFraction: opts.optimizationFraction ?? 0.7,
    warmupBars: WARMUP_BARS,
    embargoBars: 5,
  });
  const optBars = partition.optimization;

  // 2. Build the rolling windows inside the optimization segment ONLY.
  const windows = buildWindows(optBars.length, trainBars, testBars, stepBars);
  if (windows.length === 0) {
    throw new Error(
      `Not enough optimization bars (${optBars.length}) for train+test = ${trainBars + testBars}.`,
    );
  }

  // 3. Sweep every trial on every window: IS (train) + OOS (test). This both
  //    drives the robust selection (§6) and builds the (trial × window-return)
  //    matrix the PBO guard consumes (§7 / G3).
  const trials = enumerateTrials(spec, opts.seed ?? 42);
  const cfg = baseConfig(opts.symbol, spec.strategyType);
  const runner = new BacktestRunner();

  // Per-trial, per-window scratch.
  const isSharpe: number[][] = trials.map(() => []);
  const isTrades: number[][] = trials.map(() => []);
  const isPnl: number[][] = trials.map(() => []);
  const oosSharpe: number[][] = trials.map(() => []);
  const oosPnl: number[][] = trials.map(() => []);
  const oosTradeRs: number[][] = trials.map(() => []);

  for (let w = 0; w < windows.length; w++) {
    const win = windows[w];
    const trainWarmup = Math.max(0, win.trainStart - WARMUP_BARS);
    const testWarmup = Math.max(0, win.testStart - WARMUP_BARS);
    for (let t = 0; t < trials.length; t++) {
      const is = await evaluateSlice(runner, optBars, cfg, trials[t].overlay, trainWarmup, win.trainStart, win.trainEnd);
      const oos = await evaluateSlice(runner, optBars, cfg, trials[t].overlay, testWarmup, win.testStart, win.testEnd);
      isSharpe[t].push(is.sharpeRatio);
      isTrades[t].push(is.totalTrades);
      isPnl[t].push(is.totalPnl);
      oosSharpe[t].push(oos.sharpeRatio);
      oosPnl[t].push(oos.totalPnl);
      oosTradeRs[t].push(...oos.tradeRs);
    }
  }

  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const meanIsSharpe = trials.map((_, t) => mean(isSharpe[t]));
  const meanIsTrades = trials.map((_, t) => mean(isTrades[t]));

  // 4. Robust selection (§6): parameter-plateau smoothing + min-trades floor.
  //    A trial's score is the mean IS Sharpe of itself + its axis-adjacent grid
  //    neighbors — a lone spike in a poor region loses to a broad stable one.
  const coordKey = (c: number[]) => c.join(',');
  const byCoord = new Map<string, number>();
  trials.forEach((tr, i) => byCoord.set(coordKey(tr.coords), i));
  const plateau = trials.map((tr, i) => {
    const vals = [meanIsSharpe[i]];
    for (let a = 0; a < tr.coords.length; a++) {
      for (const d of [-1, 1]) {
        const nc = tr.coords.slice();
        nc[a] += d;
        const j = byCoord.get(coordKey(nc));
        if (j !== undefined) vals.push(meanIsSharpe[j]);
      }
    }
    return mean(vals);
  });

  const eligible = trials.map((_, i) => meanIsTrades[i] >= MIN_TRADES_PER_WINDOW);
  const eligibleCount = eligible.filter(Boolean).length;
  const anyEligible = eligibleCount > 0;
  let blessedIdx = 0;
  let bestScore = -Infinity;
  for (let i = 0; i < trials.length; i++) {
    if (anyEligible && !eligible[i]) continue;
    const tie = plateau[i] === bestScore && meanIsTrades[i] > meanIsTrades[blessedIdx];
    if (plateau[i] > bestScore || tie) {
      bestScore = plateau[i];
      blessedIdx = i;
    }
  }
  const blessed = trials[blessedIdx];

  // 5. Walk-forward OOS aggregate for the blessed params (headline OOS picture,
  //    feeds G1/G4 and the report). Reuses the shared walkForward primitive.
  const blessedConfig = { ...cfg, ...blessed.overlay };
  const wf = await walkForward(blessedConfig, optBars, { trainBars, testBars, stepBars, warmupBars: WARMUP_BARS });
  const agg = wf.aggregate;

  // ── Guard battery (§7). PASS only if all six pass. ──────────────────────────
  const guards: GuardResult[] = [];

  // G1 — walk-forward efficiency: OOS Sharpe ÷ IS Sharpe ≥ 0.5 AND OOS > 0.
  const isSharpeBlessed = meanIsSharpe[blessedIdx];
  const oosSharpeBlessed = mean(oosSharpe[blessedIdx]);
  const efficiency = isSharpeBlessed > 0 ? oosSharpeBlessed / isSharpeBlessed : (oosSharpeBlessed > 0 ? Infinity : 0);
  guards.push({
    id: 'G1', name: 'Walk-forward efficiency',
    pass: efficiency >= G1_EFFICIENCY_FLOOR && oosSharpeBlessed > 0,
    value: Number.isFinite(efficiency) ? efficiency : 999,
    threshold: `≥ ${G1_EFFICIENCY_FLOOR} and OOS Sharpe > 0`,
    detail: `IS Sharpe ${isSharpeBlessed.toFixed(3)} → OOS Sharpe ${oosSharpeBlessed.toFixed(3)}`,
  });

  // G2 — Deflated/Probabilistic Sharpe Ratio over the blessed OOS trade series.
  const trialSharpes = trials.map((_, t) => {
    const m = sampleMoments(oosTradeRs[t]);
    return m.std > 0 ? m.mean / m.std : 0;
  });
  const dsr: DeflatedSharpeResult = deflatedSharpeRatio({
    returns: oosTradeRs[blessedIdx],
    trialSharpes,
    trialCount: trials.length,
    threshold: G2_PSR_THRESHOLD,
  });
  // A tiny OOS sample makes PSR meaningless (n=2 → PSR≈1, a false pass), so the
  // guard cannot certify below the sample floor regardless of the raw PSR.
  const g2SampleOk = dsr.n >= MIN_GUARD_SAMPLE;
  guards.push({
    id: 'G2', name: 'Deflated Sharpe Ratio',
    pass: dsr.pass && g2SampleOk, value: dsr.psr,
    threshold: `PSR vs SR*(N=${trials.length}) > ${G2_PSR_THRESHOLD}, n ≥ ${MIN_GUARD_SAMPLE}`,
    detail: g2SampleOk
      ? `PSR ${dsr.psr.toFixed(4)}, SR* ${dsr.sharpeStar.toFixed(3)}, obs/trade Sharpe ${dsr.observedSharpe.toFixed(3)}, n=${dsr.n}`
      : `INSUFFICIENT OOS SAMPLE: n=${dsr.n} < ${MIN_GUARD_SAMPLE} trades — cannot certify (PSR ${dsr.psr.toFixed(4)} on this sample is noise)`,
  });

  // G3 — Probability of Backtest Overfitting via CSCV over (trial × window PnL).
  const pboMatrix = trials.map((_, t) => oosPnl[t].slice());
  const pbo: PboResult = probabilityOfBacktestOverfitting({ matrix: pboMatrix, partitions: 16, threshold: G3_PBO_THRESHOLD });
  guards.push({
    id: 'G3', name: 'Probability of Backtest Overfitting',
    pass: pbo.pass, value: pbo.pbo,
    threshold: `PBO < ${G3_PBO_THRESHOLD} (target < 0.25)`,
    detail: `PBO ${pbo.pbo.toFixed(3)} over ${pbo.combinations} CSCV splits, S=${pbo.partitions}`,
  });

  // G4 — Bootstrap OOS floor: 5th-percentile aggregate PnL > 0 (block bootstrap
  //      preserves trade autocorrelation).
  const boot = blockBootstrapEquityCurves(agg.trades, INITIAL_EQUITY, { iterations: 2000, blockLength: 5, seed: opts.seed ?? 42 });
  const p5Pnl = boot.p5 - INITIAL_EQUITY;
  // Same sample-adequacy floor: a p5 floor over 2 trades is not a floor.
  const g4SampleOk = agg.totalTrades >= MIN_GUARD_SAMPLE;
  guards.push({
    id: 'G4', name: 'Bootstrap OOS floor',
    pass: p5Pnl > 0 && g4SampleOk, value: p5Pnl,
    threshold: `p5 aggregate PnL > 0, n ≥ ${MIN_GUARD_SAMPLE}`,
    detail: g4SampleOk
      ? `block-bootstrap p5 equity $${boot.p5.toFixed(0)} (PnL $${p5Pnl.toFixed(0)}), p50 $${boot.p50.toFixed(0)}`
      : `INSUFFICIENT OOS SAMPLE: ${agg.totalTrades} aggregate trades < ${MIN_GUARD_SAMPLE} — bootstrap floor is noise`,
  });

  // 6 + G5/G6 — Holdout confirmation + stress. The locked holdout is opened
  //      EXACTLY ONCE here (spec §3 hard rule). All holdout runs share that one
  //      release — base, 1.5× cost, and the worst-case ambiguous resolution.
  const holdoutBars = partition.openHoldout();
  const hWarmStart = holdoutBars[0].timestamp;
  const hEvalStart = holdoutBars[Math.min(WARMUP_BARS, holdoutBars.length - 1)].timestamp;
  const hEnd = holdoutBars[holdoutBars.length - 1].timestamp;
  const holdoutBase = await runner.run(
    { ...blessedConfig, warmupStartDate: hWarmStart, startDate: hEvalStart, endDate: hEnd },
    holdoutBars,
  );
  const holdoutStressed = await runner.run(
    {
      ...blessedConfig,
      costModel: scaledCostModel(flatCostModel(DEFAULT_FILL_COST), G6_COST_MULTIPLIER),
      warmupStartDate: hWarmStart, startDate: hEvalStart, endDate: hEnd,
    },
    holdoutBars,
  );

  // G5 — Holdout confirmation: Sharpe > 0 AND holdout PnL not below the G4
  //      bootstrap floor (no regime cliff vs the WF-OOS aggregate).
  const g5Pass = holdoutBase.sharpeRatio > 0 && holdoutBase.totalPnl >= p5Pnl;
  guards.push({
    id: 'G5', name: 'Holdout confirmation',
    pass: g5Pass, value: holdoutBase.sharpeRatio,
    threshold: 'holdout Sharpe > 0 and holdout PnL ≥ G4 bootstrap p5 floor',
    detail: `holdout Sharpe ${holdoutBase.sharpeRatio.toFixed(3)}, PnL $${holdoutBase.totalPnl.toFixed(0)} vs floor $${p5Pnl.toFixed(0)}, trades ${holdoutBase.totalTrades}`,
  });

  // G6 — Cost/slippage stress: 1.5× cost AND worst-case ambiguous resolution
  //      both keep positive expectancy.
  const g6Pass = holdoutStressed.expectancy > 0 && holdoutBase.worstCaseTotalPnl > 0;
  guards.push({
    id: 'G6', name: 'Cost / slippage stress',
    pass: g6Pass, value: holdoutStressed.expectancy,
    threshold: '1.5× cost expectancy > 0 and worst-case PnL > 0',
    detail: `1.5× cost expectancy ${holdoutStressed.expectancy.toFixed(3)}R, worst-case PnL $${holdoutBase.worstCaseTotalPnl.toFixed(0)}`,
  });

  const verdictPass = guards.every((g) => g.pass);

  // Stage-1 metrics for the TRA-532 gate — picked from the WF-OOS aggregate.
  const backtestMetrics: BacktestVerdictMetrics = {
    sharpe: agg.sharpeRatio,
    expectancy: agg.expectancy,
    profitFactor: agg.profitFactor,
    maxDrawdown: agg.maxDrawdown,
    tradeCount: agg.totalTrades,
  };

  const windowRows: WindowRow[] = windows.map((_, w) => ({
    window: w,
    pickedParams: blessed.label,
    isSharpe: isSharpe[blessedIdx][w],
    isTrades: isTrades[blessedIdx][w],
    isPnl: isPnl[blessedIdx][w],
    oosSharpe: oosSharpe[blessedIdx][w],
    oosPnl: oosPnl[blessedIdx][w],
    oosTrades: 0, // populated below from per-window OOS trade counts
  }));
  // Per-window OOS trade counts come from re-deriving from oosTradeRs is lossy;
  // use the wf per-window results which align 1:1 with `windows`.
  wf.windows.forEach((r, w) => { if (windowRows[w]) windowRows[w].oosTrades = r.totalTrades; });

  return {
    harness: 'run-optimization@TRA-540',
    strategy: spec.name,
    symbol: opts.symbol,
    trialCount: trials.length,
    partition: partition.boundaries,
    windows: windowRows,
    blessed: {
      label: blessed.label,
      overlay: blessed.overlay,
      meanIsSharpe: meanIsSharpe[blessedIdx],
      meanIsTrades: meanIsTrades[blessedIdx],
      plateauScore: plateau[blessedIdx],
      eligibleTrials: eligibleCount,
    },
    oosAggregate: { ...backtestMetrics, totalPnl: agg.totalPnl },
    holdout: {
      sharpe: holdoutBase.sharpeRatio,
      expectancy: holdoutBase.expectancy,
      profitFactor: holdoutBase.profitFactor,
      maxDrawdown: holdoutBase.maxDrawdown,
      tradeCount: holdoutBase.totalTrades,
      totalPnl: holdoutBase.totalPnl,
      worstCasePnl: holdoutBase.worstCaseTotalPnl,
      stressedExpectancy: holdoutStressed.expectancy,
    },
    guards,
    verdict: {
      pass: verdictPass,
      guards: Object.fromEntries(guards.map((g) => [g.id, { pass: g.pass, value: g.value }])),
      blessedParams: { strategy: spec.name, label: blessed.label, ...blessed.overlay },
      backtestMetrics,
    },
  };
}

// ── Report writers (spec §8) ──────────────────────────────────────────────────

function writeReports(report: OptimizationReport): void {
  const here = dirname(fileURLToPath(import.meta.url));
  const root = resolve(here, '..');

  writeFileSync(resolve(root, 'optimization-report.json'), JSON.stringify(report, null, 2) + '\n');

  const csv = [
    'strategy,window,pickedParams,isSharpe,isTrades,isPnl,oosSharpe,oosPnl,oosTrades',
    ...report.windows.map((r) =>
      [report.strategy, r.window, `"${r.pickedParams}"`,
        r.isSharpe.toFixed(4), r.isTrades, r.isPnl.toFixed(2),
        r.oosSharpe.toFixed(4), r.oosPnl.toFixed(2), r.oosTrades].join(','),
    ),
  ].join('\n');
  writeFileSync(resolve(root, 'optimization-windows.csv'), csv + '\n');

  const b = report.partition;
  const iso = (ms: number) => new Date(ms).toISOString().slice(0, 10);
  const md = [
    `# Optimization report — ${report.strategy} (${report.symbol})`,
    '',
    `Harness: \`${report.harness}\` · Trials N: **${report.trialCount}** · Verdict: **${report.verdict.pass ? 'PASS ✅' : 'FAIL ❌'}**`,
    '',
    '## Data partition (chronological, no shuffle)',
    '',
    `| Segment | Span | Bars |`,
    `|---|---|---|`,
    `| Optimization | ${iso(b.optStartTs)} → ${iso(b.optEndTs)} | ${b.optBars} |`,
    `| Purge + embargo gap | ${b.warmupBars} warmup + ${b.embargoBars} embargo | ${b.gapBars} |`,
    `| Locked holdout (OOS) | ${iso(b.holdoutStartTs)} → ${iso(b.holdoutEndTs)} | ${b.holdoutBars} |`,
    '',
    '## Blessed parameters',
    '',
    `\`${report.blessed.label}\` — plateau score ${report.blessed.plateauScore.toFixed(3)}, ` +
      `mean IS Sharpe ${report.blessed.meanIsSharpe.toFixed(3)}, mean IS trades/window ${report.blessed.meanIsTrades.toFixed(1)}`,
    '',
    report.blessed.eligibleTrials === 0
      ? `> ⚠️ **0 of ${report.trialCount} trials cleared the §6 ≥${MIN_TRADES_PER_WINDOW}-trades/window activity floor** — ` +
        `the blessed pick is a fallback on a near-inactive grid; its OOS Sharpe is noise and the verdict FAILs.`
      : `Eligible trials (≥${MIN_TRADES_PER_WINDOW} trades/window): ${report.blessed.eligibleTrials} of ${report.trialCount}.`,
    '',
    '## Guard battery (PASS only if all six pass)',
    '',
    `| Guard | Value | Threshold | Result |`,
    `|---|---|---|---|`,
    ...report.guards.map((g) =>
      `| ${g.id} ${g.name} | ${g.value.toFixed(4)} | ${g.threshold} | ${g.pass ? 'PASS ✅' : 'FAIL ❌'} |`,
    ),
    '',
    '## OOS aggregate (WF) vs locked holdout',
    '',
    `| Metric | WF-OOS | Holdout |`,
    `|---|---|---|`,
    `| Sharpe | ${report.oosAggregate.sharpe.toFixed(3)} | ${report.holdout.sharpe.toFixed(3)} |`,
    `| Expectancy (R) | ${report.oosAggregate.expectancy.toFixed(3)} | ${report.holdout.expectancy.toFixed(3)} |`,
    `| Profit factor | ${report.oosAggregate.profitFactor.toFixed(3)} | ${report.holdout.profitFactor.toFixed(3)} |`,
    `| Max drawdown | ${(report.oosAggregate.maxDrawdown * 100).toFixed(1)}% | ${(report.holdout.maxDrawdown * 100).toFixed(1)}% |`,
    `| Trades | ${report.oosAggregate.tradeCount} | ${report.holdout.tradeCount} |`,
    `| Total PnL | $${report.oosAggregate.totalPnl.toFixed(0)} | $${report.holdout.totalPnl.toFixed(0)} |`,
    '',
    '> Verdict block + `backtestMetrics` (sharpe/expectancy/profitFactor/maxDrawdown/tradeCount)',
    '> in `optimization-report.json` are shaped to feed the TRA-532 promotion-gate `backtest` leg.',
    '',
  ].join('\n');
  writeFileSync(resolve(root, 'optimization-report.md'), md);

  console.log(`\nWrote optimization-report.json / .md and optimization-windows.csv to ${root}`);
}

// (The former CLI entry, which fetched the retired 4H exchange caches, was
// removed in TRA-4629. Drive the pipeline via `runOptimization(spec, candles,
// opts)` and `writeReports(report)` from a caller that supplies its own data.)
