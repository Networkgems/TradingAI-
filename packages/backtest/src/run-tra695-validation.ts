/**
 * TRA-695 — Backtest & gate-validate the new crypto roster (DCA + swing).
 *
 * Parent TRA-693. The legacy crypto roster failed OOS cost validation
 * (TRA-405 / TRA-432) and live is pinned to `no_trade`. We are replacing it
 * with DCA (CryptoDcaStrategy, TRA-693 commit 96d2fdc) + disciplined swing
 * (SwingStrategy). This harness validates BOTH on real Coinbase 4H bars — the
 * same 3.05-year dataset used in TRA-405 — and produces a go/no-go per
 * strategy × symbol.
 *
 * Methodology (mirrors TRA-405 / TRA-432, augmented per the TRA-695 scope):
 *
 *   SWING — a per-trade timing strategy, so it gets the full treatment:
 *     (a) Shipped-default IS/OOS single-parameter run with the tiered cost
 *         model + moving-block bootstrap CI on the OOS trade-PnL sequence —
 *         the TRA-405 "are the shipped parameters profitable OOS?" question.
 *     (b) The TRA-532 promotion gate via the TRA-540 optimization harness
 *         (`runOptimization`) with a swing parameter grid → the authoritative
 *         `verdict.pass` (G1 walk-forward efficiency, G2 deflated Sharpe,
 *         G3 PBO, G4 bootstrap OOS floor, G5 holdout, G6 cost stress).
 *
 *   DCA — robust-by-construction; no per-trade timing edge required, so the
 *     usual per-trade cost-survival test understates it (TRA-695 scope §3).
 *     Evaluated as a periodic-contribution accumulation backtest:
 *     return-on-invested, money-weighted CAGR (XIRR), max drawdown of the
 *     value/invested ratio, MAR ratio, deployment ratio, and cadence
 *     sensitivity (weekly / biweekly / monthly), trend-gated vs unconditional,
 *     benchmarked against a lump-sum buy-and-hold. All fills carry the tiered
 *     cost model.
 *
 * RESEARCH harness (QuantTrader-owned): it only consumes exported engine /
 * backtest APIs and reads the on-disk 4H cache directly (the caches are >12h
 * old, so `loadOrFetch4hBars` would trigger a network refetch; reading the
 * cache keeps the run deterministic and pinned to the TRA-405 dataset).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra695-validation.ts
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { CryptoDcaStrategy, cryptoTieredCostModel, cryptoTierOf } from '@trading-app/engine';
import { BacktestRunner } from './runner.js';
import { runOptimization, type OptimizationReport } from './run-optimization.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = resolve(HERE, '..', 'data');
const REPORT_DIR = resolve(HERE, '..', 'reports');

const IS_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_END_MS = Date.UTC(2025, 0, 1) - 1; // 2024-12-31 23:59:59.999
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOGE-USD', 'LINK-USD'] as const;
const CORE_SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;
const INITIAL_EQUITY = 25_000;

const DAY_MS = 24 * 60 * 60 * 1000;
const YEAR_MS = 365.25 * DAY_MS;

// ── Cache loader (direct, deterministic — no network) ─────────────────────────

interface CacheEntry { symbol: string; start: number; end: number; candles: Candle[] }

function loadCachedCandles(symbol: string): Candle[] {
  const path = resolve(DATA_DIR, `${symbol.toLowerCase()}.4h.json`);
  if (!existsSync(path)) throw new Error(`No 4H cache for ${symbol} at ${path}`);
  const raw = JSON.parse(readFileSync(path, 'utf-8')) as CacheEntry;
  return raw.candles;
}

// ── Shared metric helpers ─────────────────────────────────────────────────────

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

/** Moving-block bootstrap over realised per-trade PnL (TRA-405 method). */
function blockBootstrap(pnls: number[], initialEquity: number, blockLen = 5, iterations = 3000, seed = 695) {
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
    let equity = initialEquity, peak = initialEquity, dd = 0, drawn = 0;
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

// ── SWING (a) — shipped-default IS/OOS single-parameter run ───────────────────

function swingCfg(symbol: string, start: number, end: number): BacktestConfig {
  return {
    symbol,
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'swing',
    swingOpts: {}, // shipped defaults (TRA-693 §2 "re-validate, not re-invent")
    costModel: cryptoTieredCostModel(),
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
  };
}

interface SwingCell {
  symbol: string;
  costTier: string;
  is: SegMetrics;
  oos: SegMetrics;
  oosBlockBootstrap: ReturnType<typeof blockBootstrap>;
}

// ── SWING (b) — TRA-540 promotion gate parameter grid ─────────────────────────
//
// Tunes the two axes most material to swing activity/edge at 4H: the pullback
// proximity band (entry frequency) and the reward:risk target. The shipped
// defaults (proximity 0.03, rrRatio 2) sit inside the grid so the gate is not
// rigged around them. Window sizes widened vs the macd_bollinger defaults
// because swing on 4H is a slower, lower-frequency strategy.
const SWING_GATE_SPEC = {
  name: 'swing',
  // TRA-697: `as const` narrows the literal to the `BacktestConfig['strategyType']`
  // union member instead of widening to `string` (pre-existing tsc -b break on
  // main; behaviour-neutral fix to keep the deploy gate green).
  strategyType: 'swing' as const,
  axes: [
    { name: 'ema50ProximityPct', values: [0.03, 0.05, 0.08] },
    { name: 'rrRatio', values: [1.5, 2.0, 3.0] },
  ],
  build: (v: Record<string, number>) => ({
    swingOpts: {
      ema50ProximityPct: v.ema50ProximityPct,
      rrRatio: v.rrRatio,
    },
  }),
  maxTrials: 64,
  window: { trainDays: 180, testDays: 60, stepDays: 45 },
};

// ── DCA — periodic-contribution accumulation simulator ────────────────────────

const CADENCES: Array<{ label: string; ms: number }> = [
  { label: 'weekly', ms: 7 * DAY_MS },
  { label: 'biweekly', ms: 14 * DAY_MS },
  { label: 'monthly', ms: 30 * DAY_MS },
];
const CONTRIBUTION_USD = 100; // fixed $ per cadence window (the "fixed amount")

interface DcaResult {
  buys: number;
  possibleWindows: number;
  deploymentRatioPct: number;
  invested: number;
  units: number;
  avgCost: number;
  finalPrice: number;
  finalValue: number;
  returnOnInvestedPct: number;
  xirrAnnualPct: number;
  maxDdRatioPct: number; // max drawdown of the value/invested ratio curve
  mar: number; // xirrAnnual / maxDdRatio
}

/**
 * Money-weighted annualised return (XIRR) by bisection. Cash flows are the
 * negative contributions at their timestamps plus the terminal +finalValue.
 */
function xirr(flows: Array<{ t: number; amount: number }>): number {
  if (flows.length < 2) return 0;
  const t0 = flows[0].t;
  const npv = (r: number) =>
    flows.reduce((s, f) => s + f.amount / Math.pow(1 + r, (f.t - t0) / YEAR_MS), 0);
  let lo = -0.9999, hi = 10;
  const fLo = npv(lo), fHi = npv(hi);
  if (fLo * fHi > 0) return NaN; // no sign change in range
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid);
    if (Math.abs(fMid) < 1e-6) return mid;
    if (fLo * fMid < 0) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

/**
 * Simulate trend-/cadence-gated DCA accumulation over [start,end]. Fills at the
 * next bar's open (TRA-420 §4 convention) with the tiered cost model applied
 * (taker commission on notional + adverse slippage). Returns null if no buys.
 */
function simulateDca(
  candles: Candle[],
  symbol: string,
  cadenceMs: number,
  requireUptrend: boolean,
  start: number,
  end: number,
): DcaResult | null {
  const dca = new CryptoDcaStrategy({ cadenceMs, requireUptrend });
  const fill = cryptoTieredCostModel().resolve(symbol);
  const comm = fill.commissionBps / 10_000;
  const slip = fill.slippageBps / 10_000;

  let invested = 0;
  let units = 0;
  let buys = 0;
  const flows: Array<{ t: number; amount: number }> = [];
  let maxRatio = 1;
  let maxDd = 0;
  let lastClose = 0;
  let lastTs = 0;

  for (let i = 1; i <= candles.length; i++) {
    const latest = candles[i - 1];
    if (latest.timestamp > end) break;
    const window = candles.slice(0, i);
    if (latest.timestamp < start) continue;

    lastClose = latest.close;
    lastTs = latest.timestamp;

    const sig = dca.evaluate(symbol, window);
    if (sig && i < candles.length) {
      const rawOpen = candles[i].open; // next-bar-open fill
      const fillPrice = rawOpen * (1 + slip);
      const notional = CONTRIBUTION_USD / (1 + comm); // contribution covers fee
      const u = notional / fillPrice;
      units += u;
      invested += CONTRIBUTION_USD;
      buys += 1;
      flows.push({ t: candles[i].timestamp, amount: -CONTRIBUTION_USD });
    }

    // Mark-to-market drawdown of the value/invested ratio (DCA-appropriate:
    // contributions move value and invested together, so the ratio is smooth).
    if (invested > 0 && units > 0) {
      const ratio = (units * latest.close) / invested;
      maxRatio = Math.max(maxRatio, ratio);
      if (maxRatio > 0) maxDd = Math.max(maxDd, (maxRatio - ratio) / maxRatio);
    }
  }

  if (buys === 0 || units === 0) return null;

  const finalValue = units * lastClose;
  flows.push({ t: lastTs, amount: finalValue });
  const span = end - start;
  const possibleWindows = Math.max(1, Math.floor(span / cadenceMs));
  const annual = xirr(flows);
  const maxDdPct = maxDd * 100;

  return {
    buys,
    possibleWindows,
    deploymentRatioPct: (buys / possibleWindows) * 100,
    invested,
    units,
    avgCost: invested / units,
    finalPrice: lastClose,
    finalValue,
    returnOnInvestedPct: (finalValue / invested - 1) * 100,
    xirrAnnualPct: Number.isNaN(annual) ? NaN : annual * 100,
    maxDdRatioPct: maxDdPct,
    mar: maxDdPct > 0 && !Number.isNaN(annual) ? (annual * 100) / maxDdPct : NaN,
  };
}

/** Lump-sum buy-and-hold benchmark: invest once at the first in-window bar. */
function lumpSum(candles: Candle[], symbol: string, start: number, end: number) {
  const fill = cryptoTieredCostModel().resolve(symbol);
  const comm = fill.commissionBps / 10_000;
  const slip = fill.slippageBps / 10_000;
  const inWin = candles.filter(c => c.timestamp >= start && c.timestamp <= end);
  if (inWin.length < 2) return null;
  const entry = inWin[0].close * (1 + slip);
  const units = (1 / (1 + comm)) / entry; // normalise to $1 invested
  let peak = 1, maxDd = 0;
  for (const c of inWin) {
    const val = units * c.close;
    peak = Math.max(peak, val);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - val) / peak);
  }
  const finalVal = units * inWin[inWin.length - 1].close;
  return { returnPct: (finalVal - 1) * 100, maxDdPct: maxDd * 100 };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();

  const swingCells: SwingCell[] = [];
  const swingGate: Array<{ symbol: string; report: OptimizationReport | null; error?: string }> = [];
  const dcaCells: Array<Record<string, unknown>> = [];

  for (const symbol of SYMBOLS) {
    const candles = loadCachedCandles(symbol);
    const tier = cryptoTierOf(symbol);
    const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / YEAR_MS;
    const oosEnd = candles[candles.length - 1].timestamp;
    console.log(`\n=== ${symbol} === ${candles.length} bars, ${years.toFixed(2)}y, tier=${tier}`);

    // ── SWING (a): shipped-default IS/OOS ──────────────────────────────────────
    const isRes = await runner.run(swingCfg(symbol, IS_START_MS, IS_END_MS), candles);
    const oosRes = await runner.run(swingCfg(symbol, OOS_START_MS, oosEnd), candles);
    const oosPnls = oosRes.trades.map(t => t.pnl ?? 0);
    const cell: SwingCell = {
      symbol,
      costTier: String(tier),
      is: metricsOf(isRes),
      oos: metricsOf(oosRes),
      oosBlockBootstrap: oosPnls.length >= 8 ? blockBootstrap(oosPnls, INITIAL_EQUITY) : null,
    };
    swingCells.push(cell);
    console.log(
      `  SWING shipped  IS[${String(cell.is.trades).padStart(3)}tr ret=${cell.is.returnPct.toFixed(1)}% shp=${cell.is.sharpe.toFixed(2)}] ` +
      `OOS[${String(cell.oos.trades).padStart(3)}tr exp=${cell.oos.expectancyR.toFixed(2)}R wr=${cell.oos.winRatePct.toFixed(0)}% ret=${cell.oos.returnPct.toFixed(1)}% shp=${cell.oos.sharpe.toFixed(2)} ddMax=${cell.oos.maxDdPct.toFixed(1)}%]`,
    );

    // ── SWING (b): TRA-540 promotion gate ──────────────────────────────────────
    try {
      const report = await runOptimization(SWING_GATE_SPEC, candles, { symbol, seed: 695 });
      swingGate.push({ symbol, report });
      const g = report.verdict.guards;
      console.log(
        `  SWING gate     verdict=${report.verdict.pass ? 'PASS' : 'FAIL'} ` +
        `[${Object.entries(g).map(([k, v]) => `${k}:${(v as { pass: boolean }).pass ? 'Y' : 'N'}`).join(' ')}] ` +
        `blessed=${report.blessed.label} OOSshp=${report.oosAggregate.sharpe.toFixed(2)} trades=${report.oosAggregate.tradeCount}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      swingGate.push({ symbol, report: null, error: msg });
      console.log(`  SWING gate     ERROR — ${msg}`);
    }

    // ── DCA: weekly trend-gated IS / OOS / full, + cadence + ungated + lump ─────
    const dcaWeeklyIs = simulateDca(candles, symbol, 7 * DAY_MS, true, IS_START_MS, IS_END_MS);
    const dcaWeeklyOos = simulateDca(candles, symbol, 7 * DAY_MS, true, OOS_START_MS, oosEnd);
    const dcaWeeklyFull = simulateDca(candles, symbol, 7 * DAY_MS, true, IS_START_MS, oosEnd);
    const dcaUngatedOos = simulateDca(candles, symbol, 7 * DAY_MS, false, OOS_START_MS, oosEnd);
    const lumpOos = lumpSum(candles, symbol, OOS_START_MS, oosEnd);
    const cadenceOos: Record<string, DcaResult | null> = {};
    for (const c of CADENCES) cadenceOos[c.label] = simulateDca(candles, symbol, c.ms, true, OOS_START_MS, oosEnd);

    dcaCells.push({
      symbol, costTier: String(tier),
      weeklyIs: dcaWeeklyIs, weeklyOos: dcaWeeklyOos, weeklyFull: dcaWeeklyFull,
      ungatedOos: dcaUngatedOos, lumpSumOos: lumpOos, cadenceOos,
    });
    const w = dcaWeeklyOos;
    if (w) {
      console.log(
        `  DCA wk OOS     buys=${w.buys}/${w.possibleWindows} (${w.deploymentRatioPct.toFixed(0)}%) ` +
        `ROI=${w.returnOnInvestedPct.toFixed(1)}% XIRR=${w.xirrAnnualPct.toFixed(1)}% maxDD=${w.maxDdRatioPct.toFixed(1)}% MAR=${Number.isNaN(w.mar) ? 'n/a' : w.mar.toFixed(2)} ` +
        `| ungated maxDD=${dcaUngatedOos ? dcaUngatedOos.maxDdRatioPct.toFixed(1) : 'n/a'}% | lump ROI=${lumpOos ? lumpOos.returnPct.toFixed(1) : 'n/a'}%`,
      );
    } else {
      console.log('  DCA wk OOS     no buys (trend gate never opened)');
    }
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    dataset: 'coinbase-exchange 4H, on-disk cache (TRA-405 3.05y window)',
    isWindow: { start: new Date(IS_START_MS).toISOString(), end: new Date(IS_END_MS).toISOString() },
    oosWindowStart: new Date(OOS_START_MS).toISOString(),
    initialEquity: INITIAL_EQUITY,
    contributionUsd: CONTRIBUTION_USD,
    costModel: 'cryptoTieredCostModel (TRA-185)',
    coreSymbols: CORE_SYMBOLS,
    swingShippedDefaults: swingCells,
    swingPromotionGate: swingGate.map(s => ({
      symbol: s.symbol,
      error: s.error,
      verdict: s.report?.verdict ?? null,
      blessed: s.report?.blessed ?? null,
      oosAggregate: s.report?.oosAggregate ?? null,
      holdout: s.report?.holdout ?? null,
      guards: s.report?.guards ?? null,
    })),
    dca: dcaCells,
  };
  writeFileSync(resolve(REPORT_DIR, 'tra695-validation.json'), JSON.stringify(payload, null, 2));
  console.log(`\nWrote reports/tra695-validation.json`);
}

const invoked = process.argv[1] && /run-tra695-validation\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
