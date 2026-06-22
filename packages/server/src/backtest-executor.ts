// ── Concrete production backtest executor for the TRA-994 pipeline (TRA-997) ──
//
// Parent: TRA-994. The keystone pipeline (hypothesis-pipeline.ts) takes an
// INJECTED `BacktestExecutor` so the queued→backtested→graded→ratified flow is
// deterministic + unit-testable. This module wires the REAL production executor:
// given an `AppliedConfig` + `BacktestWindow`, it loads the on-disk crypto-majors
// 4H candle cache, maps the `ConfigSnapshot` leaves onto a per-symbol
// `BacktestConfig`, runs `@trading-app/backtest` `BacktestRunner.run`, and pools
// the per-symbol results into one `BacktestGateMetrics` row that feeds G0 grading.
//
// Invariants this module preserves:
//   • PURE w.r.t. its inputs — same (config, window) ⇒ same metrics. Candles are
//     read straight from the on-disk cache (no network, no clock), and the
//     runner's only nondeterminism (signal-id randomUUID) never touches the
//     metrics. This is what keeps G0 grading reproducible across ticks.
//   • NO live path. This is a backtest harness only; it opens no orders and
//     touches no live/demo capital. The pipeline's ratification step is the sole
//     (board-gated, demo-only) terminus.
//
// Sleeve mapping is table-driven (see `SLEEVE_SPECS`): the first concrete sleeve
// is the RV / crypto-majors mean-reversion book (TRA-523's surviving candidate).
// Adding another sleeve is a new `SleeveSpec` entry — no orchestration changes.

import { existsSync, readFileSync } from 'fs';
import type { BacktestGateMetrics, Candle } from '@trading-app/shared';
import {
  BacktestRunner,
  cachePathFor4h,
  DEFAULT_4H_SYMBOLS,
  type BacktestConfig,
  type BacktestResult,
  type CacheEntry,
} from '@trading-app/backtest';
import {
  type AppliedConfig,
  type BacktestExecutor,
  type BacktestWindow,
  type ConfigSnapshot,
} from './hypothesis-pipeline.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'backtest-executor' });

// ── ConfigSnapshot leaf access ───────────────────────────────────────────────

/** Read a dotted-path leaf out of a config snapshot; `undefined` if absent. */
function leafAt(cfg: ConfigSnapshot, path: string): unknown {
  let node: unknown = cfg;
  for (const seg of path.split('.')) {
    if (node == null || typeof node !== 'object') return undefined;
    node = (node as Record<string, unknown>)[seg];
  }
  return node;
}

// ── Sleeve spec (table-driven snapshot→BacktestConfig mapping) ────────────────

/** One `ConfigSnapshot` leaf → `BacktestConfig` field binding. */
interface LeafMapping {
  /** Dotted path into the `ConfigSnapshot`, e.g. `RV_CRYPTO_MAJORS.bbPeriod`. */
  path: string;
  /** Apply the resolved finite numeric leaf onto a per-symbol `BacktestConfig`. */
  apply: (cfg: BacktestConfig, value: number) => void;
}

/**
 * A backtestable sleeve: which symbols it trades, the per-symbol config template
 * its strategy needs, and how `ConfigSnapshot` tunables (selector params / signal
 * weights / gates) map onto that config. `namespace` is the snapshot key whose
 * presence selects this sleeve for a given hypothesis.
 */
export interface SleeveSpec {
  key: string;
  /** Snapshot namespace that, when present, routes a hypothesis to this sleeve. */
  namespace: string;
  universe: readonly string[];
  /** Base per-symbol config (strategy + costs + sizing) before leaf overrides. */
  template: (symbol: string, window: BacktestWindow) => BacktestConfig;
  mappings: LeafMapping[];
}

const RV_MAJORS_INITIAL_EQUITY = 25_000;

/**
 * The production base ConfigSnapshot for the RV / crypto-majors sleeve. A
 * hand-authored hypothesis is applied as a single-leaf delta against a clone of
 * this (see `applyHypothesis`), so every tunable below is an addressable target.
 * Values mirror the TRA-206/TRA-523 mean-reversion spec defaults.
 */
export const RV_CRYPTO_MAJORS_BASE_CONFIG: ConfigSnapshot = {
  RV_CRYPTO_MAJORS: {
    /** Per-trade account-risk budget (fraction). TRA-211 mean-reversion default. */
    riskPerTradePct: 0.0075,
    /** Per-fill taker fee in bps (Coinbase-ish). */
    feeBps: 60,
    /** Per-fill adverse slippage in bps. */
    slippageBps: 3,
    /** Bollinger period / multiplier (entry band). */
    bbPeriod: 20,
    bbMultiplier: 2,
    /** RSI entry gates. */
    rsiOversold: 25,
    rsiOverbought: 75,
    /** Hard-stop distance = atrStopMultiplier × ATR(14). */
    atrStopMultiplier: 1.5,
  },
};

const RV_CRYPTO_MAJORS_SLEEVE: SleeveSpec = {
  key: 'rv_crypto_majors',
  namespace: 'RV_CRYPTO_MAJORS',
  universe: DEFAULT_4H_SYMBOLS,
  template: (symbol, window) => ({
    symbol,
    startDate: window.startMs,
    endDate: window.endMs,
    initialEquity: RV_MAJORS_INITIAL_EQUITY,
    strategyType: 'mean_reversion',
    meanReversionOpts: {},
    meanReversionRiskPct: 0.0075,
    feeBps: 60,
    slippageBps: 3,
    fractionalQuantity: true,
  }),
  mappings: [
    { path: 'RV_CRYPTO_MAJORS.riskPerTradePct', apply: (c, v) => { c.meanReversionRiskPct = v; } },
    { path: 'RV_CRYPTO_MAJORS.feeBps', apply: (c, v) => { c.feeBps = v; } },
    { path: 'RV_CRYPTO_MAJORS.slippageBps', apply: (c, v) => { c.slippageBps = v; } },
    { path: 'RV_CRYPTO_MAJORS.bbPeriod', apply: (c, v) => { (c.meanReversionOpts ??= {}).bbPeriod = v; } },
    { path: 'RV_CRYPTO_MAJORS.bbMultiplier', apply: (c, v) => { (c.meanReversionOpts ??= {}).bbMultiplier = v; } },
    { path: 'RV_CRYPTO_MAJORS.rsiOversold', apply: (c, v) => { (c.meanReversionOpts ??= {}).rsiOversold = v; } },
    { path: 'RV_CRYPTO_MAJORS.rsiOverbought', apply: (c, v) => { (c.meanReversionOpts ??= {}).rsiOverbought = v; } },
    { path: 'RV_CRYPTO_MAJORS.atrStopMultiplier', apply: (c, v) => { (c.meanReversionOpts ??= {}).atrStopMultiplier = v; } },
  ],
};

/** Registered sleeves, table-driven. First entry is the default fallback. */
export const SLEEVE_SPECS: readonly SleeveSpec[] = [RV_CRYPTO_MAJORS_SLEEVE];

/** Pick the sleeve whose namespace is present in the snapshot; else the default. */
function selectSleeve(config: ConfigSnapshot, sleeves: readonly SleeveSpec[]): SleeveSpec {
  return sleeves.find(s => leafAt(config, s.namespace) != null) ?? sleeves[0];
}

/** Build one symbol's `BacktestConfig` from the sleeve template + mapped leaves. */
export function buildBacktestConfig(
  sleeve: SleeveSpec,
  config: ConfigSnapshot,
  symbol: string,
  window: BacktestWindow,
): BacktestConfig {
  const cfg = sleeve.template(symbol, window);
  for (const m of sleeve.mappings) {
    const v = leafAt(config, m.path);
    if (typeof v === 'number' && Number.isFinite(v)) m.apply(cfg, v);
  }
  return cfg;
}

// ── BacktestResult pooling → BacktestGateMetrics ──────────────────────────────

const PROFIT_FACTOR_CAP = 100;
const POOL_RISK_PER_TRADE = 0.01; // risk fraction for the pooled equity curve / DD
const MS_PER_YEAR = 365.25 * 24 * 60 * 60 * 1000;

function round(n: number, dp = 4): number {
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

/**
 * Pool per-symbol backtest results into a single `BacktestGateMetrics` row, on
 * the same units the G0 gate expects:
 *   • expectancy — mean NET-of-cost R per trade across the pooled book
 *     (`tradeRsNet`, TRA-818), matching the gate's "average R per trade".
 *   • sharpe — per-trade information ratio annualised by the book's realised
 *     trades-per-year, the same annualisation `BacktestResult.sharpeRatio` uses,
 *     so the 1.0 threshold is like-for-like.
 *   • profitFactor — pooled gross win ÷ gross loss (R-denominated), capped.
 *   • maxDrawdown — fractional peak-to-trough of a compounding equity curve over
 *     the pooled trade sequence at a fixed risk fraction.
 *   • tradeCount — total trades across the universe.
 * Deterministic given the same results (the pooling reads no clock/IO).
 */
export function poolGateMetrics(
  results: readonly BacktestResult[],
  window: BacktestWindow,
): BacktestGateMetrics {
  // Pool per-trade NET R across symbols in a fixed order (deterministic).
  const rs: number[] = [];
  for (const r of results) rs.push(...r.tradeRsNet);
  const tradeCount = rs.length;

  if (tradeCount === 0) {
    return { sharpe: 0, expectancy: 0, profitFactor: 0, maxDrawdown: 0, tradeCount: 0 };
  }

  const mean = rs.reduce((a, b) => a + b, 0) / tradeCount;

  let grossWin = 0;
  let grossLoss = 0;
  for (const r of rs) {
    if (r >= 0) grossWin += r;
    else grossLoss += -r;
  }
  const profitFactor =
    grossLoss > 0 ? Math.min(grossWin / grossLoss, PROFIT_FACTOR_CAP) : grossWin > 0 ? PROFIT_FACTOR_CAP : 0;

  // Per-trade IR → annualised Sharpe via the book's realised trades/year.
  let ir = 0;
  if (tradeCount >= 2) {
    const variance = rs.reduce((a, b) => a + (b - mean) ** 2, 0) / (tradeCount - 1);
    const sd = Math.sqrt(variance);
    ir = sd > 0 ? mean / sd : 0;
  }
  const years = Math.max(0, window.endMs - window.startMs) / MS_PER_YEAR;
  const tradesPerYear = years > 0 ? tradeCount / years : 0;
  const sharpe = ir * Math.sqrt(tradesPerYear);

  // Pooled compounding equity curve → fractional max drawdown.
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  for (const r of rs) {
    equity *= 1 + POOL_RISK_PER_TRADE * r;
    if (equity > peak) peak = equity;
    if (peak > 0) {
      const dd = (peak - equity) / peak;
      if (dd > maxDd) maxDd = dd;
    }
  }

  return {
    sharpe: round(sharpe),
    expectancy: round(mean),
    profitFactor: round(profitFactor),
    maxDrawdown: round(maxDd),
    tradeCount,
  };
}

// ── Candle loading (on-disk 4H cache, deterministic) ──────────────────────────

/** Load a symbol's 4H bars straight from the on-disk cache, clipped to window. */
export function loadCachedCandles(symbol: string, window: BacktestWindow): Candle[] {
  const path = cachePathFor4h(symbol);
  if (!existsSync(path)) {
    throw new Error(
      `backtest-executor: no on-disk 4H cache for ${symbol} (${path}). `
        + `Build it with the @trading-app/backtest fetch first.`,
    );
  }
  const entry = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  return entry.candles.filter(c => c.timestamp >= window.startMs && c.timestamp <= window.endMs);
}

// ── Executor factory ─────────────────────────────────────────────────────────

export interface MakeBacktestExecutorOpts {
  /** Override the registered sleeves (tests/extension). Defaults to `SLEEVE_SPECS`. */
  sleeves?: readonly SleeveSpec[];
  /** Override candle loading (tests inject deterministic synthetic series). */
  candleLoader?: (symbol: string, window: BacktestWindow) => Candle[] | Promise<Candle[]>;
  /** Inject a runner (tests can spy on the configs it receives). */
  runner?: Pick<BacktestRunner, 'run'>;
}

/**
 * Build the production `BacktestExecutor` the TRA-994 pipeline injects. Given an
 * applied config + window it selects the matching sleeve, loads that sleeve's
 * crypto-majors 4H candles, runs each symbol through `BacktestRunner`, and pools
 * the results into one `BacktestGateMetrics` row. Symbols with no bars in-window
 * are skipped (they contribute no trades) rather than aborting the whole run.
 */
export function makeBacktestExecutor(opts: MakeBacktestExecutorOpts = {}): BacktestExecutor {
  const sleeves = opts.sleeves ?? SLEEVE_SPECS;
  const loadCandles = opts.candleLoader ?? loadCachedCandles;
  const runner = opts.runner ?? new BacktestRunner();

  return async (applied: AppliedConfig, window: BacktestWindow): Promise<BacktestGateMetrics> => {
    const sleeve = selectSleeve(applied.config, sleeves);
    const results: BacktestResult[] = [];
    for (const symbol of sleeve.universe) {
      const candles = await loadCandles(symbol, window);
      if (candles.length === 0) {
        log.warn('no in-window candles, skipping symbol', { sleeve: sleeve.key, symbol });
        continue;
      }
      const cfg = buildBacktestConfig(sleeve, applied.config, symbol, window);
      results.push(await runner.run(cfg, candles));
    }
    const metrics = poolGateMetrics(results, window);
    log.info('backtest executor produced gate metrics', {
      sleeve: sleeve.key,
      symbols: sleeve.universe.length,
      ran: results.length,
      ...metrics,
    });
    return metrics;
  };
}
