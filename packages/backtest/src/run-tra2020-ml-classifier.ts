/**
 * TRA-2024 (impl of TRA-2022) — ML-classifier feasibility harness.
 *
 * Builds EXACTLY the frozen pre-registration ([TRA-2022] `pre-registration`
 * document): 16 lagged technical features → a 3-class (down/range/up) label →
 * an L2 multinomial logistic regression AND a shallow GBM → walk-forward OOS →
 * a purged, one-shot LOCKED HOLDOUT → net-of-fee expectancy vs the incumbent-
 * rules baseline B1, with PBO + deflated Sharpe. It answers ONE question with
 * evidence: *can the simplest honest fitted model beat our incumbent rules
 * baseline out-of-sample, net of fee, on a purged locked holdout?* — not "build
 * a bot". A KILL is a first-class, fully acceptable outcome (like ICC / TSMOM).
 *
 * This harness computes the five pre-registered pass-bar booleans MECHANICALLY
 * so QuantTrader can grade in one pass — it does NOT pronounce the official
 * REAL/KILL verdict. That is QuantTrader's call (issue hand-off).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPEND / NETWORK SAFETY — mirrors `run-tra1968-earnings-gate.ts` exactly; this
 * script does NOTHING by default.
 *   • `… run-tra2020-ml-classifier.ts`           → PLAN mode: prints config +
 *     the 16-feature list + data reachability, runs NOTHING. Safe.
 *   • `… run-tra2020-ml-classifier.ts --smoke`   → free DETERMINISTIC run on
 *     seeded synthetic bars, zero network. Report tagged `mode:
 *     "smoke-deterministic"`. Uses a REDUCED walk-forward/GBM profile (wiring
 *     check only — the frozen §4 grid is the `--execute` path).
 *   • `… run-tra2020-ml-classifier.ts --execute` → the REAL run: free Yahoo
 *     daily bars (no key). Aborts with a clear blocker if Yahoo is unreachable.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra2020-ml-classifier.ts [--smoke|--execute]
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import YahooFinance from 'yahoo-finance2';
import type { Candle } from '@trading-app/shared';
import { buildWindows } from './walk-forward.js';
import { partitionData } from './data-partition.js';
import {
  probabilityOfBacktestOverfitting,
  deflatedSharpeRatio,
  type DeflatedSharpeResult,
} from './overfitting-stats.js';
import {
  computeFeatureBundle,
  labelAt,
  translateToR,
  LABEL_HORIZON,
  FEATURE_NAMES,
  FEATURE_COUNT,
  CLASS_RANGE,
  CLASS_UP,
  type FeatureBundle,
} from './tra2020-ml-features.js';
import {
  Standardizer,
  MultinomialLogReg,
  ShallowGBM,
  type Classifier,
} from './tra2020-ml-models.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');
const DAY_MS = 24 * 60 * 60 * 1000;

// ── FROZEN config (pre-reg §1, §5–§8) ────────────────────────────────────────
const UNIVERSE = ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'META', 'GOOGL', 'AMD', 'NFLX'];
const WINDOW_START_MS = Date.UTC(2023, 0, 1); // 2023-01-01
const WINDOW_END_MS = Date.UTC(2026, 0, 1); // 2026-01-01
const WARMUP_BARS = 250; // trailing history pulled before the first evaluated bar

const SLIPPAGE_BPS = 5; // per side; 10 bps round trip (equities, commission-free)
const HORIZON = LABEL_HORIZON; // H = 5

// Locked-holdout partition (pre-reg §7.3). embargoBars = 10 ≥ H is the label-
// horizon purge that stops the H-bar-forward label from leaking across the
// opt→holdout boundary — the single highest-risk leak in the spike.
const HOLDOUT_OPT_FRACTION = 0.7;
const HOLDOUT_EMBARGO_BARS = 10;

// Sample-sufficiency floor (pre-reg §8 bar 4).
const MIN_HOLDOUT_TRADES = 30;
// Below this many valid train rows a walk-forward window is skipped (too thin to fit).
const MIN_TRAIN_ROWS = 40;

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: false },
});

// ── trials (pre-reg §4): 3 logreg C + 2 GBM n_estimators = 5 trials ──────────
interface Trial {
  key: string;
  family: 'logreg' | 'gbm';
  /** Fit a classifier on ALREADY-STANDARDIZED train features + integer labels. */
  fit: (X: number[][], y: number[]) => Classifier;
}

interface RunProfile {
  mode: 'smoke-deterministic' | 'live';
  trials: Trial[];
  trainBars: number;
  testBars: number;
  /** Cap on walk-forward windows processed (smoke keeps CI fast). 0 = all. */
  maxWindows: number;
  /** Synthetic bars per symbol (smoke only). */
  syntheticBars: number;
}

const LIVE_TRIALS: Trial[] = [
  { key: 'logreg_C0.1', family: 'logreg', fit: (X, y) => MultinomialLogReg.fit(X, y, { C: 0.1 }) },
  { key: 'logreg_C1.0', family: 'logreg', fit: (X, y) => MultinomialLogReg.fit(X, y, { C: 1.0 }) },
  { key: 'logreg_C10', family: 'logreg', fit: (X, y) => MultinomialLogReg.fit(X, y, { C: 10.0 }) },
  { key: 'gbm_n100', family: 'gbm', fit: (X, y) => ShallowGBM.fit(X, y, { nEstimators: 100 }) },
  { key: 'gbm_n200', family: 'gbm', fit: (X, y) => ShallowGBM.fit(X, y, { nEstimators: 200 }) },
];

// Smoke keeps the SAME 5-trial shape (3 logreg + 2 GBM) so the whole PBO /
// deflated-Sharpe / holdout wiring runs, but with far fewer GBM rounds + capped
// windows so CI stays fast. This is a WIRING check — the frozen §4 grid is the
// `--execute` path. Tagged `smoke-deterministic` + called out in `notes[]`.
const SMOKE_TRIALS: Trial[] = [
  { key: 'logreg_C0.1', family: 'logreg', fit: (X, y) => MultinomialLogReg.fit(X, y, { C: 0.1, epochs: 100 }) },
  { key: 'logreg_C1.0', family: 'logreg', fit: (X, y) => MultinomialLogReg.fit(X, y, { C: 1.0, epochs: 100 }) },
  { key: 'logreg_C10', family: 'logreg', fit: (X, y) => MultinomialLogReg.fit(X, y, { C: 10.0, epochs: 100 }) },
  { key: 'gbm_n100', family: 'gbm', fit: (X, y) => ShallowGBM.fit(X, y, { nEstimators: 20 }) },
  { key: 'gbm_n200', family: 'gbm', fit: (X, y) => ShallowGBM.fit(X, y, { nEstimators: 40 }) },
];

function profileFor(mode: 'smoke-deterministic' | 'live'): RunProfile {
  if (mode === 'live') {
    return { mode, trials: LIVE_TRIALS, trainBars: 252, testBars: 63, maxWindows: 0, syntheticBars: 0 };
  }
  return { mode, trials: SMOKE_TRIALS, trainBars: 170, testBars: 50, maxWindows: 2, syntheticBars: 940 };
}

// ── per-symbol point-in-time sample set ──────────────────────────────────────
/** One valid (features-warm, label-defined) bar. `x`/`y` train the model; the
 *  bundle + `t` translate a prediction into net-of-fee R. */
interface Sample {
  t: number;
  x: number[];
  y: number;
}

interface SymbolData {
  symbol: string;
  candles: Candle[];
  bundle: FeatureBundle;
  /** Valid samples indexed by bar `t` (features non-null AND label defined). */
  samples: Sample[];
}

function buildSymbolData(symbol: string, candles: Candle[]): SymbolData {
  const bundle = computeFeatureBundle(candles);
  const samples: Sample[] = [];
  for (let t = 0; t < candles.length; t++) {
    const x = bundle.features[t];
    if (!x) continue;
    const lab = labelAt(bundle, t, HORIZON);
    if (!lab) continue;
    samples.push({ t, x, y: lab.cls });
  }
  return { symbol, candles, bundle, samples };
}

/**
 * Act on a model's prediction at bar `t`: `up → long (+1)`, `down → short (−1)`,
 * `range → no trade (null)`. Returns the net-of-fee R (pre-reg §6) or null.
 */
function actedR(model: Classifier, sym: SymbolData, sampleX: number[], t: number): number | null {
  const cls = model.predictClass(sampleX);
  if (cls === CLASS_RANGE) return null;
  const dir: 1 | -1 = cls === CLASS_UP ? 1 : -1;
  return translateToR(sym.bundle, t, dir, SLIPPAGE_BPS, HORIZON);
}

// ── walk-forward (per symbol) with the H-bar label purge ─────────────────────
/** Per (trial, window) OOS net-R lists, pooled across symbols. */
interface WalkForwardOut {
  /** windowNetR[trial.key][windowIndex] = pooled net-R array for that cell. */
  cells: Map<string, number[][]>;
  windowCount: number;
}

function runWalkForward(profile: RunProfile, data: SymbolData[]): WalkForwardOut {
  // Global window count = min across symbols (rectangular PBO matrix), capped.
  let windowCount = Infinity;
  const symWindows = data.map((sym) => {
    const w = buildWindows(sym.candles.length, profile.trainBars, profile.testBars);
    windowCount = Math.min(windowCount, w.length);
    return w;
  });
  if (!Number.isFinite(windowCount)) windowCount = 0;
  if (profile.maxWindows > 0) windowCount = Math.min(windowCount, profile.maxWindows);

  const cells = new Map<string, number[][]>();
  for (const trial of profile.trials) {
    cells.set(trial.key, Array.from({ length: windowCount }, () => []));
  }

  for (let s = 0; s < data.length; s++) {
    const sym = data[s];
    const windows = symWindows[s];
    for (let w = 0; w < windowCount; w++) {
      const win = windows[w];
      // Train rows: samples inside the train span, PURGED of the final H bars
      // (their forward label overlaps the test region — pre-reg §2 purge).
      const trainCut = win.trainEnd - 1 - HORIZON;
      const train = sym.samples.filter((sm) => sm.t >= win.trainStart && sm.t <= trainCut);
      const test = sym.samples.filter((sm) => sm.t >= win.testStart && sm.t < win.testEnd);
      if (train.length < MIN_TRAIN_ROWS || test.length === 0) continue;

      const scaler = Standardizer.fit(train.map((sm) => sm.x));
      const trainX = scaler.transform(train.map((sm) => sm.x));
      const trainY = train.map((sm) => sm.y);

      for (const trial of profile.trials) {
        const model = trial.fit(trainX, trainY);
        const bucket = cells.get(trial.key)![w];
        for (const sm of test) {
          const r = actedR(model, sym, scaler.transformRow(sm.x), sm.t);
          if (r !== null) bucket.push(r);
        }
      }
    }
  }

  return { cells, windowCount };
}

// ── locked holdout (per symbol) — one-shot, purged ───────────────────────────
interface HoldoutModelResult {
  key: string;
  family: string;
  n: number;
  hitRate: number;
  netExpectancyR: number;
  sharpe: number;
  /** The full net-R series (blessed model needs it for the deflated Sharpe). */
  rs: number[];
}

function summarizeRs(key: string, family: string, rs: number[]): HoldoutModelResult {
  const n = rs.length;
  const mean = n > 0 ? rs.reduce((a, b) => a + b, 0) / n : 0;
  const wins = rs.filter((r) => r > 0).length;
  let sd = 0;
  if (n > 1) {
    const v = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
    sd = Math.sqrt(v);
  }
  return {
    key,
    family,
    n,
    hitRate: n > 0 ? round(wins / n) : 0,
    netExpectancyR: round(mean),
    sharpe: sd > 0 ? round(mean / sd) : 0,
    rs,
  };
}

/**
 * Fit the given trials on each symbol's OPTIMIZATION segment (purged of the
 * final H bars) and evaluate on its LOCKED HOLDOUT, opened EXACTLY ONCE. Pools
 * net-R across symbols per trial. Also returns the incumbent-rules baseline B1
 * and buy-and-hold B2 on the same holdout, and proves `holdoutAccessCount === 1`.
 */
interface HoldoutOut {
  models: Map<string, number[]>; // trial.key → pooled holdout net-R
  b1: number[]; // incumbent-rules pooled holdout net-R
  b2ReturnPct: number; // equal-weight buy-and-hold return over holdout span
  holdoutBars: number;
  optBars: number;
  gapBars: number;
  accessCountsOk: boolean;
}

function runHoldout(profile: RunProfile, data: SymbolData[]): HoldoutOut {
  const models = new Map<string, number[]>();
  for (const trial of profile.trials) models.set(trial.key, []);
  const b1: number[] = [];
  const b2Returns: number[] = [];
  let holdoutBars = 0;
  let optBars = 0;
  let gapBars = 0;
  let accessCountsOk = true;

  for (const sym of data) {
    const partition = partitionData(sym.candles, {
      optimizationFraction: HOLDOUT_OPT_FRACTION,
      warmupBars: WARMUP_BARS,
      embargoBars: HOLDOUT_EMBARGO_BARS,
    });
    optBars += partition.boundaries.optBars;
    gapBars += partition.boundaries.gapBars;
    const optEndTs = partition.boundaries.optEndTs;
    const holdoutStartTs = partition.boundaries.holdoutStartTs;

    // Optimization samples: label-horizon purged (drop the final H bars so the
    // forward label cannot reach into the embargo gap / holdout).
    const optCutTs = optEndTs - HORIZON * DAY_MS; // conservative time-based purge
    const optSamples = sym.samples.filter((sm) => sym.bundle.timestamps[sm.t] <= optCutTs);
    if (optSamples.length < MIN_TRAIN_ROWS) {
      accessCountsOk = false; // too thin to bless anything on this symbol
      continue;
    }

    // Open the locked holdout EXACTLY once (pre-reg §7.3).
    const holdoutCandles = partition.openHoldout();
    if (partition.holdoutAccessCount !== 1) accessCountsOk = false;
    holdoutBars += holdoutCandles.length;
    const holdoutStartIdx = sym.candles.findIndex((c) => c.timestamp >= holdoutStartTs);
    const holdoutSamples = sym.samples.filter((sm) => sym.bundle.timestamps[sm.t] >= holdoutStartTs);

    // Fit scaler + every trial on the optimization segment ONLY.
    const scaler = Standardizer.fit(optSamples.map((sm) => sm.x));
    const optX = scaler.transform(optSamples.map((sm) => sm.x));
    const optY = optSamples.map((sm) => sm.y);
    for (const trial of profile.trials) {
      const model = trial.fit(optX, optY);
      const bucket = models.get(trial.key)!;
      for (const sm of holdoutSamples) {
        const r = actedR(model, sym, scaler.transformRow(sm.x), sm.t);
        if (r !== null) bucket.push(r);
      }
    }

    // B1 — incumbent directional rule stack (reversal-RSI + MACD + Supertrend),
    // a majority vote translated on the IDENTICAL §6 basis so `E_ml − E_B1` is a
    // same-unit margin (see `notes[]`).
    for (const sm of holdoutSamples) {
      const dir = incumbentRuleDir(sym.bundle, sm.t);
      if (dir === 0) continue;
      const r = translateToR(sym.bundle, sm.t, dir, SLIPPAGE_BPS, HORIZON);
      if (r !== null) b1.push(r);
    }

    // B2 — equal-weight buy-and-hold over the holdout span (context only).
    if (holdoutStartIdx >= 0) {
      const first = sym.candles[holdoutStartIdx].close;
      const last = sym.candles[sym.candles.length - 1].close;
      if (first > 0) b2Returns.push(last / first - 1);
    }
  }

  const b2ReturnPct = b2Returns.length ? (b2Returns.reduce((a, b) => a + b, 0) / b2Returns.length) * 100 : 0;
  return { models, b1, b2ReturnPct, holdoutBars, optBars, gapBars, accessCountsOk };
}

/**
 * Incumbent-rules direction at bar T from the FROZEN feature vector: a majority
 * vote of the three directional families the pre-reg names for B1 —
 * reversal (RSI extremes), MACD histogram sign, and Supertrend direction.
 * Returns +1 (long), −1 (short) or 0 (no trade / tie).
 */
function incumbentRuleDir(bundle: FeatureBundle, t: number): 1 | -1 | 0 {
  const x = bundle.features[t];
  if (!x) return 0;
  const rsi = x[0];
  const macdHist = x[3];
  const stDir = x[8]; // +1 / −1
  let vote = 0;
  if (rsi < 30) vote += 1;
  else if (rsi > 70) vote -= 1;
  vote += macdHist > 0 ? 1 : macdHist < 0 ? -1 : 0;
  vote += stDir > 0 ? 1 : -1;
  return vote > 0 ? 1 : vote < 0 ? -1 : 0;
}

// ── verdict assembly ─────────────────────────────────────────────────────────
interface TrialWalkSummary {
  key: string;
  family: string;
  windows: number;
  trades: number;
  meanNetR: number;
  sharpe: number;
  pctWindowsPositive: number;
}

interface Verdict {
  mode: RunProfile['mode'];
  generatedNote: string;
  window: { start: string; end: string };
  config: Record<string, unknown>;
  features: readonly string[];
  walkForward: {
    windowCount: number;
    byTrial: TrialWalkSummary[];
    blessedKey: string;
    blessedPctWindowsPositive: number;
    blessedPerWindowNetExpectancy: number[];
  };
  pbo: { pbo: number; threshold: number; pass: boolean; partitions: number; combinations: number; trials: number };
  holdout: {
    optBars: number;
    gapBars: number;
    holdoutBars: number;
    accessCountsOk: boolean;
    b0NetExpectancyR: number;
    b1: HoldoutModelResult;
    b2BuyHoldReturnPct: number;
    models: HoldoutModelResult[];
    blessed: HoldoutModelResult;
    marginVsB1: number;
    psr: { psr: number; sharpeStar: number; pass: boolean };
  };
  passBar: {
    b1Margin: boolean;
    pbo: boolean;
    psr: boolean;
    sampleN: boolean;
    stability: boolean;
    mechanicalAll: boolean;
  };
  notes: string[];
}

function meanOf(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
}
function sharpeOf(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = meanOf(xs);
  const v = xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1);
  const sd = Math.sqrt(v);
  return sd > 0 ? m / sd : 0;
}

function assembleVerdict(profile: RunProfile, wf: WalkForwardOut, ho: HoldoutOut): Verdict {
  // Per-trial walk-forward summaries (pooled across windows/symbols).
  const byTrial: TrialWalkSummary[] = profile.trials.map((trial) => {
    const perWindow = wf.cells.get(trial.key)!;
    const pooled = perWindow.flat();
    const positiveWindows = perWindow.filter((w) => w.length > 0 && meanOf(w) > 0).length;
    const nonEmptyWindows = perWindow.filter((w) => w.length > 0).length;
    return {
      key: trial.key,
      family: trial.family,
      windows: nonEmptyWindows,
      trades: pooled.length,
      meanNetR: round(meanOf(pooled)),
      sharpe: round(sharpeOf(pooled)),
      pctWindowsPositive: nonEmptyWindows > 0 ? round(positiveWindows / nonEmptyWindows) : 0,
    };
  });

  // Blessed = best walk-forward pooled mean net-R (chosen WITHOUT the holdout).
  let blessed = byTrial[0];
  for (const t of byTrial) if (t.meanNetR > blessed.meanNetR) blessed = t;
  const blessedPerWindow = wf.cells.get(blessed.key)!.map((w) => round(meanOf(w)));

  // PBO matrix: rows = trials, cols = windows; cell = per-window mean net-R.
  const matrix = profile.trials.map((trial) => wf.cells.get(trial.key)!.map((w) => meanOf(w)));
  const pboRes = probabilityOfBacktestOverfitting({ matrix, threshold: 0.25 });

  // Holdout summaries.
  const b1 = summarizeRs('B1_incumbent_rules', 'baseline', ho.b1);
  const models: HoldoutModelResult[] = profile.trials.map((t) =>
    summarizeRs(t.key, t.family, ho.models.get(t.key)!),
  );
  const blessedHoldout = models.find((m) => m.key === blessed.key)!;

  // Deflated / probabilistic Sharpe on the blessed holdout per-trade R series.
  const trialSharpes = byTrial.map((t) => t.sharpe);
  const psr: DeflatedSharpeResult = deflatedSharpeRatio({
    returns: blessedHoldout.rs,
    trialSharpes,
    trialCount: profile.trials.length,
    threshold: 0.95,
  });

  const marginVsB1 = round(blessedHoldout.netExpectancyR - b1.netExpectancyR);

  // FROZEN pass-bar booleans (pre-reg §8) — computed MECHANICALLY on the LOCKED
  // HOLDOUT. `mechanicalAll` is the AND; it is NOT the official verdict.
  const b1Margin = marginVsB1 >= 0.05 && blessedHoldout.netExpectancyR > 0;
  const pboPass = pboRes.pbo < 0.25;
  const psrPass = psr.pass;
  const sampleN = blessedHoldout.n >= MIN_HOLDOUT_TRADES;
  const stability = blessed.pctWindowsPositive >= 0.6;
  const mechanicalAll = b1Margin && pboPass && psrPass && sampleN && stability;

  const notes: string[] = [
    'MECHANICAL bar only — this harness computes the five pre-registered §8 booleans ' +
      'but does NOT pronounce the official REAL/KILL verdict. QuantTrader grades the frozen ' +
      'bar and writes the verdict (issue hand-off).',
    'No-lookahead is STRUCTURAL: featureVectorAt(candles, T) computes bar T from candles' +
      '.slice(0, T+1) only, and the unit test asserts mutating bars > T leaves T byte-identical. ' +
      'Labels read candles[T+1..T+H] and enter TRAINING TARGETS only.',
    `Label-horizon purge active on BOTH boundaries: the final H=${HORIZON} bars of every train ` +
      `window are dropped before fitting, and the locked holdout uses embargoBars=${HOLDOUT_EMBARGO_BARS} ` +
      '(≥ H) so the forward label cannot leak across opt→holdout (pre-reg §2 — the highest-risk leak).',
    'B1 (incumbent rules) is a majority vote of reversal-RSI + MACD-histogram + Supertrend ' +
      'direction, translated on the IDENTICAL §6 R basis (1×ATR risk unit, H-bar horizon, ' +
      '5bps/side) so E_ml − E_B1 is a same-unit margin rather than a cross-basis subtraction. ' +
      'Flagged for QuantTrader to confirm this operationalization of the frozen B1.',
    'Anchored (session-less) VWAP: daily bars have no intraday session, so feature 13 is the ' +
      'distance from a VWAP anchored at the start of each point-in-time prefix — slow-moving but ' +
      'strictly causal.',
    'Per-symbol OOS ledgers are POOLED into one evidence set (earnings-gate pooling pattern); ' +
      'the PBO matrix uses the min window count across symbols so the trial×window matrix is ' +
      'rectangular.',
  ];
  if (profile.mode === 'smoke-deterministic') {
    notes.unshift(
      'SMOKE (mode: smoke-deterministic) — synthetic seeded bars, zero network, REDUCED GBM ' +
        'rounds + capped walk-forward windows for CI speed. This proves the wiring end-to-end; ' +
        'the FROZEN §4 grid (GBM n∈{100,200}, train 252 / test 63, all windows) is the --execute path. ' +
        'Numbers here are NOT evidence for grading.',
    );
  }
  if (!ho.accessCountsOk) {
    notes.push(
      'COVERAGE CAVEAT: at least one symbol was too thin for the locked-holdout partition (or the ' +
        'one-shot access assertion did not hold) — its holdout was skipped. Extend the window before ' +
        'trusting the holdout N.',
    );
  }

  return {
    mode: profile.mode,
    generatedNote: 'Stamp timestamps after the run; the harness is deterministic and clock-free.',
    window: {
      start: new Date(WINDOW_START_MS).toISOString().slice(0, 10),
      end: new Date(WINDOW_END_MS).toISOString().slice(0, 10),
    },
    config: {
      universe: [...UNIVERSE],
      horizonH: HORIZON,
      featureCount: FEATURE_COUNT,
      trainBars: profile.trainBars,
      testBars: profile.testBars,
      warmupBars: WARMUP_BARS,
      slippageBps: SLIPPAGE_BPS,
      holdoutOptFraction: HOLDOUT_OPT_FRACTION,
      holdoutEmbargoBars: HOLDOUT_EMBARGO_BARS,
      minHoldoutTrades: MIN_HOLDOUT_TRADES,
      trials: profile.trials.map((t) => t.key),
    },
    features: FEATURE_NAMES,
    walkForward: {
      windowCount: wf.windowCount,
      byTrial,
      blessedKey: blessed.key,
      blessedPctWindowsPositive: blessed.pctWindowsPositive,
      blessedPerWindowNetExpectancy: blessedPerWindow,
    },
    pbo: {
      pbo: round(pboRes.pbo),
      threshold: 0.25,
      pass: pboRes.pbo < 0.25,
      partitions: pboRes.partitions,
      combinations: pboRes.combinations,
      trials: profile.trials.length,
    },
    holdout: {
      optBars: ho.optBars,
      gapBars: ho.gapBars,
      holdoutBars: ho.holdoutBars,
      accessCountsOk: ho.accessCountsOk,
      b0NetExpectancyR: 0,
      b1,
      b2BuyHoldReturnPct: round(ho.b2ReturnPct, 2),
      models,
      blessed: blessedHoldout,
      marginVsB1,
      psr: { psr: round(psr.psr), sharpeStar: round(psr.sharpeStar), pass: psr.pass },
    },
    passBar: { b1Margin, pbo: pboPass, psr: psrPass, sampleN, stability, mechanicalAll },
    notes,
  };
}

// ── data sources ─────────────────────────────────────────────────────────────
async function fetchYahooDaily(symbol: string): Promise<Candle[]> {
  const result = await yf.chart(symbol, {
    period1: new Date(WINDOW_START_MS - WARMUP_BARS * DAY_MS * 1.6),
    period2: new Date(WINDOW_END_MS),
    interval: '1d',
  });
  const quotes = result?.quotes ?? [];
  return quotes
    .filter((q) => q.open != null && q.high != null && q.low != null && q.close != null)
    .map((q) => ({
      symbol,
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume ?? 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
}

// ── deterministic PRNG (seeded synthetic smoke) ──────────────────────────────
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function symbolSeed(symbol: string): number {
  return symbol.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
}

/**
 * Deterministic synthetic daily bars with a mild predictable component so the
 * classifier has SOMETHING to fit in the wiring smoke (a faint autocorrelated
 * drift + pullback cycle + bounded noise). Not a market model — its only job is
 * to exercise the full pipeline end-to-end.
 */
function syntheticDaily(symbol: string, bars: number): Candle[] {
  const rand = mulberry32(symbolSeed(symbol));
  const out: Candle[] = [];
  let price = 100 + rand() * 60;
  let momentum = 0;
  for (let i = 0; i < bars; i++) {
    const cycle = Math.sin((i / 26) * Math.PI * 2) * 0.010;
    const noise = (rand() - 0.5) * 0.02;
    momentum = momentum * 0.6 + noise * 0.4; // faint autocorrelation to learn
    const ret = 0.0004 + cycle + momentum;
    const prevClose = price;
    price = Math.max(1, price * (1 + ret));
    const high = Math.max(prevClose, price) * (1 + rand() * 0.006);
    const low = Math.min(prevClose, price) * (1 - rand() * 0.006);
    out.push({
      symbol,
      timestamp: WINDOW_START_MS - WARMUP_BARS * DAY_MS + i * DAY_MS,
      open: prevClose,
      high,
      low,
      close: price,
      volume: 1_000_000 + Math.floor(rand() * 500_000),
    });
  }
  return out;
}

// ── markdown report (drop straight into the issue comment) ───────────────────
function pct(x: number, dp = 1): string {
  return `${(x * 100).toFixed(dp)}%`;
}

export function renderReport(v: Verdict): string {
  const yn = (b: boolean) => (b ? '✅' : '❌');
  const h = v.holdout;
  const lines: string[] = [
    `**TRA-2020 ML-classifier feasibility — evidence report (${v.mode}, ${v.window.start}→${v.window.end})**`,
    '',
    '> MECHANICAL bar only — the five §8 booleans are computed here so QuantTrader can grade in one ' +
      'pass. **This harness does not pronounce the official REAL/KILL verdict.**',
    '',
    `**Config:** H=${v.config.horizonH}, ${v.config.featureCount} features, train ${v.config.trainBars}` +
      ` / test ${v.config.testBars} / warmup ${v.config.warmupBars}, slippage ${v.config.slippageBps}bps/side, ` +
      `holdout opt ${HOLDOUT_OPT_FRACTION}/embargo ${HOLDOUT_EMBARGO_BARS} (≥H). Trials: ${(v.config.trials as string[]).join(', ')}.`,
    '',
    '#### Locked holdout (the graded surface)',
    '',
    `Holdout bars pooled: ${h.holdoutBars} · opt bars ${h.optBars} · gap ${h.gapBars} · one-shot access OK: ${yn(h.accessCountsOk)}`,
    '',
    '| Model | N | Hit-rate | Net exp (R) | Per-trade Sharpe |',
    '| --- | ---: | ---: | ---: | ---: |',
    `| B0 (always-range) | 0 | — | ${h.b0NetExpectancyR.toFixed(3)} | — |`,
    `| **B1 (incumbent rules)** | ${h.b1.n} | ${pct(h.b1.hitRate)} | ${h.b1.netExpectancyR.toFixed(3)} | ${h.b1.sharpe.toFixed(3)} |`,
    ...h.models.map(
      (m) =>
        `| ${m.key === h.blessed.key ? `**${m.key}** *(blessed)*` : m.key} | ${m.n} | ${pct(m.hitRate)} | ` +
        `${m.netExpectancyR.toFixed(3)} | ${m.sharpe.toFixed(3)} |`,
    ),
    `| _B2 buy&hold (context)_ | — | — | ${h.b2BuyHoldReturnPct.toFixed(2)}% total | — |`,
    '',
    `**Blessed model:** \`${v.walkForward.blessedKey}\` · margin \`E_ml − E_B1 = ${h.marginVsB1.toFixed(3)} R\` · ` +
      `PSR(SR*) ${h.psr.psr.toFixed(3)} (SR* ${h.psr.sharpeStar.toFixed(3)}) → ${yn(h.psr.pass)}`,
    '',
    '#### Walk-forward (per trial, pooled OOS)',
    '',
    '| Trial | Windows | Trades | Mean net R | Sharpe | % windows > 0 |',
    '| --- | ---: | ---: | ---: | ---: | ---: |',
    ...v.walkForward.byTrial.map(
      (t) =>
        `| ${t.key === v.walkForward.blessedKey ? `**${t.key}**` : t.key} | ${t.windows} | ${t.trades} | ` +
        `${t.meanNetR.toFixed(3)} | ${t.sharpe.toFixed(3)} | ${pct(t.pctWindowsPositive)} |`,
    ),
    '',
    `Blessed per-window net expectancy: [${v.walkForward.blessedPerWindowNetExpectancy.map((x) => x.toFixed(3)).join(', ')}]`,
    `PBO = ${v.pbo.pbo.toFixed(3)} (${v.pbo.combinations} CSCV combos, ${v.pbo.partitions} blocks, ${v.pbo.trials} trials) → ${yn(v.pbo.pass)}`,
    '',
    '#### PRE-REGISTERED PASS/KILL BAR (§8) — mechanical read (LOCKED HOLDOUT)',
    '',
    `1. Net-of-fee margin \`E_ml − E_B1 ≥ +0.05R\` **and** \`E_ml > 0\`: ${yn(v.passBar.b1Margin)} ` +
      `(margin ${h.marginVsB1.toFixed(3)}R, E_ml ${h.blessed.netExpectancyR.toFixed(3)}R)`,
    `2. PBO < 0.25: ${yn(v.passBar.pbo)} (${v.pbo.pbo.toFixed(3)})`,
    `3. Deflated/probabilistic Sharpe PSR > 0.95: ${yn(v.passBar.psr)} (${h.psr.psr.toFixed(3)})`,
    `4. N ≥ ${MIN_HOLDOUT_TRADES} acted holdout trades: ${yn(v.passBar.sampleN)} (N=${h.blessed.n})`,
    `5. Stability — net exp > 0 in ≥60% of walk-forward windows: ${yn(v.passBar.stability)} ` +
      `(${pct(v.walkForward.blessedPctWindowsPositive)})`,
    '',
    `**Mechanical AND of §8 bars: ${v.passBar.mechanicalAll ? 'ALL PASS' : 'AT LEAST ONE MISS'}** — ` +
      'any miss ⇒ KILL. QuantTrader confirms and writes the official verdict.',
    '',
    '**Notes:**',
    ...v.notes.map((n) => `- ${n}`),
  ];
  return lines.join('\n');
}

// ── full run ─────────────────────────────────────────────────────────────────
export async function runAll(profile: RunProfile): Promise<Verdict> {
  const data: SymbolData[] = [];
  for (const symbol of UNIVERSE) {
    let candles: Candle[];
    if (profile.mode === 'smoke-deterministic') {
      candles = syntheticDaily(symbol, profile.syntheticBars);
    } else {
      console.log(`[tra2024] ${symbol} — fetching Yahoo daily …`);
      candles = await fetchYahooDaily(symbol);
    }
    const need = WARMUP_BARS + profile.trainBars + profile.testBars;
    if (candles.length < need) {
      console.log(`[tra2024] ${symbol} — SKIP: only ${candles.length} bars (< ${need} needed).`);
      continue;
    }
    data.push(buildSymbolData(symbol, candles));
    console.log(`[tra2024] ${symbol}: ${candles.length} bars → ${data[data.length - 1].samples.length} valid samples`);
  }

  if (data.length === 0) throw new Error('No symbol had enough bars — cannot run.');

  const wf = runWalkForward(profile, data);
  const ho = runHoldout(profile, data);
  return assembleVerdict(profile, wf, ho);
}

// ── main / plan mode ─────────────────────────────────────────────────────────
function printPlan(): void {
  console.log('\n[tra2024] PLAN mode — nothing run (no spend, no network).');
  console.log(
    `[tra2024] window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ` +
      `${new Date(WINDOW_END_MS).toISOString().slice(0, 10)} · H=${HORIZON} · ${FEATURE_COUNT} features · ` +
      `warmup ${WARMUP_BARS} · slippage ${SLIPPAGE_BPS}bps/side · universe ${UNIVERSE.join(',')}`,
  );
  console.log('[tra2024] trials (frozen §4): 3× logreg C{0.1,1,10} + 2× shallow GBM n{100,200} = 5 trials');
  console.log('[tra2024] holdout: partitionData optFraction 0.7, warmup 250, embargo 10 (≥H) — one-shot openHoldout()');
  console.log('[tra2024] feature list (frozen §3):');
  FEATURE_NAMES.forEach((f, i) => console.log(`         ${String(i + 1).padStart(2)}. ${f}`));
  console.log(
    '[tra2024] data reachability: Yahoo daily bars are FREE (no key). Reachability is confirmed at ' +
      'fetch time; --execute aborts with a blocker if Yahoo is unreachable.',
  );
  console.log('[tra2024] Pass --smoke for the free deterministic wiring check, or --execute for the real run.');
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const smoke = argv.includes('--smoke');
  const execute = argv.includes('--execute');

  if (!smoke && !execute) {
    printPlan();
    return;
  }

  const mode: RunProfile['mode'] = execute ? 'live' : 'smoke-deterministic';
  const profile = profileFor(mode);
  if (mode === 'smoke-deterministic') {
    console.log('[tra2024] --smoke: synthetic bars, zero network, reduced wiring profile.');
  }

  let verdict: Verdict;
  try {
    verdict = await runAll(profile);
  } catch (err) {
    if (execute) {
      console.error(
        '[tra2024] --execute failed. If this is a network error, the free Yahoo feed is unreachable ' +
          'right now — this is a real blocker; retry when the feed is back. Error:',
        err,
      );
      process.exit(2);
    }
    throw err;
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const stem = resolve(REPORT_DIR, 'tra2020-ml-classifier');
  writeFileSync(`${stem}.json`, JSON.stringify(verdict, null, 2));
  const md = renderReport(verdict);
  writeFileSync(`${stem}.md`, md);
  console.log(`\n[tra2024] wrote ${stem}.json and ${stem}.md\n`);
  console.log(md);
}

const invoked = process.argv[1] && /[\\/]run-tra2020-ml-classifier\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

export { runHoldout, runWalkForward, buildSymbolData, incumbentRuleDir, profileFor, type Verdict, type RunProfile };
