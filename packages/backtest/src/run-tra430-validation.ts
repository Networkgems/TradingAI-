/**
 * TRA-430 — Volatility-/Kelly-scaled per-trade risk sizing §6 validation.
 *
 * QuantTrader-owned RESEARCH harness (not application code): re-runs the
 * backtest runner on the TRA-405 validated {BTC-USD, SOL-USD} `macd_bollinger`
 * book under three sizing arms and reports the TRA-428 spec §6 acceptance
 * checks so QuantTrader can sign off:
 *
 *   Arm A — flat 1% baseline           (sizer OFF — today's behaviour)
 *   Arm B — volatility-targeted only   (sizer ON, no Kelly expectancy table)
 *   Arm C — vol-targeted + ¼-Kelly cap (sizer ON, per-cell expectancy table)
 *
 * §6 acceptance: arm C must NOT degrade OOS return and must NOT worsen tail
 * drawdown vs arm A — max drawdown, worst single-trade loss, and the 95%
 * per-trade loss VaR all no worse than the flat-1% baseline within noise.
 *
 * The §3.4 Kelly expectancy table is derived from arm A's own OOS closed-trade
 * ledger — i.e. the validated flat-1% baseline ledger — at the symbol-level
 * `macd_bollinger` cell granularity. `W` = winners / trades, `R` = avg win /
 * avg loss (magnitudes).
 *
 * HARD DEPENDENCY (§6): runs on the clean deterministic Coinbase 4H cache
 * restored by TRA-427. Validating a profitability lever on a book that shows
 * negative OOS is meaningless — this harness reads the current clean
 * `.4h.json` cache directly (no network).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra430-validation.ts
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position } from '@trading-app/shared';
import type { CellExpectancy } from '@trading-app/engine';
import { cryptoTieredCostModel } from '@trading-app/engine';
import { BacktestRunner } from './runner.js';
import { cachePathFor4h } from './fetch-tra266-data.js';
import type { BacktestConfig, BacktestResult, VolKellySizerOpts } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01 — indicator warmup
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01 — genuinely unseen
const OOS_END_MS = Date.UTC(2026, 4, 17); // 2026-05-17 — spec §6 OOS window end

const SYMBOLS = ['BTC-USD', 'SOL-USD'] as const;
const INITIAL_EQUITY = 25_000;

/** §6 noise tolerance for the return check (pp), matching the TRA-427 ±1pp band. */
const RETURN_TOLERANCE_PP = 1.0;
/** §6 noise tolerance for the tail metrics — 10% relative degradation allowed. */
const TAIL_TOLERANCE_REL = 0.10;

/**
 * TRA-405 §4.1 validated GO baseline (flat 1%, cap OFF) — the §6 precondition
 * target. The §6 hard dependency requires this to reproduce on the post-TRA-427
 * cache before a GO/NO-GO is meaningful.
 */
const TRA405_BASELINE: Record<string, { returnPct: number }> = {
  'BTC-USD': { returnPct: 4.12 },
  'SOL-USD': { returnPct: 5.78 },
};

function cfg(
  symbol: string,
  volKellySizerOpts?: VolKellySizerOpts,
): BacktestConfig {
  // Identical to the TRA-405 §4.1 / TRA-423 §8 / TRA-427 harness: a cold start
  // at the OOS boundary (no `warmupStartDate`), so arm A reproduces the
  // validated flat-1% baseline exactly.
  return {
    symbol,
    startDate: OOS_START_MS,
    endDate: OOS_END_MS,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'macd_bollinger',
    macdBollingerOpts: { enforceTimeFilter: false },
    costModel: cryptoTieredCostModel(),
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
    volKellySizerOpts,
  };
}

/** §3.4 — derive a per-cell {W, R, trades} expectancy from a closed-trade ledger. */
function expectancyOf(trades: Position[]): CellExpectancy {
  const pnls = trades.map((t) => t.pnl ?? 0);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, p) => s + p, 0) / wins.length : 0;
  const avgLoss =
    losses.length > 0
      ? Math.abs(losses.reduce((s, p) => s + p, 0) / losses.length)
      : 0;
  return {
    winRate: pnls.length > 0 ? wins.length / pnls.length : 0,
    payoffRatio: avgLoss > 0 ? avgWin / avgLoss : 0,
    trades: pnls.length,
  };
}

/** p-th percentile of a numeric series (nearest-rank, ascending). */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx];
}

function metricsOf(r: BacktestResult) {
  const pnls = r.trades.map((t: Position) => t.pnl ?? 0);
  const sorted = [...pnls].sort((a, b) => a - b);
  // 95% per-trade loss VaR — the 5th-percentile P&L, reported as a loss
  // magnitude (0 when that percentile is itself a profit).
  const var95Pnl = percentile(sorted, 5);
  return {
    trades: r.totalTrades,
    winRatePct: r.winRate * 100,
    expectancyR: r.expectancy,
    sharpe: r.sharpeRatio,
    maxDdPct: r.maxDrawdown * 100,
    totalPnlUsd: r.totalPnl,
    returnPct: (r.totalPnl / INITIAL_EQUITY) * 100,
    worstTradeLossUsd: sorted.length > 0 ? Math.max(0, -sorted[0]) : 0,
    var95PerTradeLossUsd: Math.max(0, -var95Pnl),
    volKellySizer: r.volKellySizer ?? null,
  };
}

type Metrics = ReturnType<typeof metricsOf>;

/** §6 acceptance — arm C vs arm A (flat-1% baseline). */
function acceptance(armA: Metrics, armC: Metrics) {
  const returnDeltaPp = armC.returnPct - armA.returnPct;
  // "no worse within noise" — a degradation up to the tolerance still passes.
  const worse = (c: number, a: number, relTol: number): boolean =>
    c > a * (1 + relTol) + 1e-9;
  return {
    returnDeltaPp,
    returnNotDegraded: returnDeltaPp >= -RETURN_TOLERANCE_PP,
    maxDdNotWorsened: !worse(armC.maxDdPct, armA.maxDdPct, TAIL_TOLERANCE_REL),
    worstTradeLossNotWorsened: !worse(
      armC.worstTradeLossUsd,
      armA.worstTradeLossUsd,
      TAIL_TOLERANCE_REL,
    ),
    var95NotWorsened: !worse(
      armC.var95PerTradeLossUsd,
      armA.var95PerTradeLossUsd,
      TAIL_TOLERANCE_REL,
    ),
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();

  const bars: Record<string, Candle[]> = {};
  for (const symbol of SYMBOLS) {
    process.stdout.write(`[${symbol}] loading cached 4H bars… `);
    const cache = JSON.parse(
      readFileSync(cachePathFor4h(symbol), 'utf-8'),
    ) as { candles: Candle[] };
    const c = cache.candles.filter(
      (b) => b.timestamp >= DATA_START_MS && b.timestamp <= OOS_END_MS,
    );
    bars[symbol] = c;
    console.log(`${c.length} 4H bars`);
  }

  const cells: Array<Record<string, unknown>> = [];
  let allPass = true;
  let baselineReproduces = true;

  for (const symbol of SYMBOLS) {
    // Arm A — flat 1% baseline.
    const armA = await runner.run(cfg(symbol), bars[symbol]);
    // §3.4 — per-cell expectancy table from arm A's OOS ledger.
    const expectancy = expectancyOf(armA.trades);
    // Arm B — vol-targeted only (no expectancy table ⇒ Kelly cap inactive).
    const armB = await runner.run(
      cfg(symbol, { enabled: true }),
      bars[symbol],
    );
    // Arm C — vol-targeted + ¼-Kelly cap.
    const armC = await runner.run(
      cfg(symbol, {
        enabled: true,
        expectancyByCell: { [symbol]: expectancy },
      }),
      bars[symbol],
    );

    const mA = metricsOf(armA);
    const mB = metricsOf(armB);
    const mC = metricsOf(armC);
    const accept = acceptance(mA, mC);
    const cellPass =
      accept.returnNotDegraded &&
      accept.maxDdNotWorsened &&
      accept.worstTradeLossNotWorsened &&
      accept.var95NotWorsened;
    allPass = allPass && cellPass;

    // §6 hard-dependency precondition — arm A must reproduce the TRA-405 §4.1
    // validated GO. A negative-OOS book makes a profitability-lever GO/NO-GO
    // meaningless (see the spec §6 dependency note).
    const base = TRA405_BASELINE[symbol];
    const baselineReproducesCell =
      !!base && Math.abs(mA.returnPct - base.returnPct) <= RETURN_TOLERANCE_PP;
    baselineReproduces = baselineReproduces && baselineReproducesCell;

    cells.push({
      symbol,
      kellyExpectancy: expectancy,
      armA_flat1pct: mA,
      armB_volOnly: mB,
      armC_volKelly: mC,
      acceptanceVsArmA: { ...accept, cellPass },
      tra405Baseline: base ?? null,
      baselineReproduces: baselineReproducesCell,
    });

    console.log(
      `\n[${symbol}] OOS macd_bollinger — three-arm sizing comparison\n` +
        `  arm A flat 1%   : ${mA.trades} tr  ret=${mA.returnPct.toFixed(2)}%  ` +
        `ddMax=${mA.maxDdPct.toFixed(2)}%  worstLoss=$${mA.worstTradeLossUsd.toFixed(0)}  ` +
        `var95=$${mA.var95PerTradeLossUsd.toFixed(0)}\n` +
        `  arm B vol-only  : ${mB.trades} tr  ret=${mB.returnPct.toFixed(2)}%  ` +
        `ddMax=${mB.maxDdPct.toFixed(2)}%  worstLoss=$${mB.worstTradeLossUsd.toFixed(0)}  ` +
        `var95=$${mB.var95PerTradeLossUsd.toFixed(0)}  avgRisk=${((mB.volKellySizer?.avgEffRiskPct ?? 0) * 100).toFixed(3)}%\n` +
        `  arm C vol+Kelly : ${mC.trades} tr  ret=${mC.returnPct.toFixed(2)}%  ` +
        `ddMax=${mC.maxDdPct.toFixed(2)}%  worstLoss=$${mC.worstTradeLossUsd.toFixed(0)}  ` +
        `var95=$${mC.var95PerTradeLossUsd.toFixed(0)}  avgRisk=${((mC.volKellySizer?.avgEffRiskPct ?? 0) * 100).toFixed(3)}%\n` +
        `  Kelly W=${expectancy.winRate.toFixed(3)} R=${expectancy.payoffRatio.toFixed(2)} n=${expectancy.trades}\n` +
        `  §6 acceptance (C vs A): Δret=${accept.returnDeltaPp >= 0 ? '+' : ''}${accept.returnDeltaPp.toFixed(2)}pp  ` +
        `${cellPass ? 'PASS' : 'FAIL'}`,
    );
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    issue: 'TRA-430',
    spec: 'TRA-428 vol-kelly-sizing-spec §6',
    oosWindow: {
      start: new Date(OOS_START_MS).toISOString(),
      end: new Date(OOS_END_MS).toISOString(),
    },
    initialEquity: INITIAL_EQUITY,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange (post-TRA-427 clean cache)',
    arms: {
      A: 'flat 1% baseline (sizer OFF)',
      B: 'volatility-targeted only',
      C: 'volatility-targeted + ¼-Kelly cap',
    },
    sizerConfig: 'recommended defaults (TRA-428 §7)',
    tolerances: { returnPp: RETURN_TOLERANCE_PP, tailRelative: TAIL_TOLERANCE_REL },
    cells,
    // The per-cell acceptance flags are only meaningful once arm A reproduces
    // the validated baseline; on a negative-OOS book arm C trades nothing and
    // the flags pass vacuously.
    harnessAcceptanceAllCells: allPass,
    baselineReproduces,
    sixSignOffStatus: baselineReproduces
      ? 'ready_for_quanttrader'
      : 'blocked_baseline_unmet',
    note:
      'Harness produces the §6 numbers; the GO/NO-GO acceptance sign-off is ' +
      'QuantTrader-owned per the TRA-428 hand-back. Do not enable the flag on ' +
      'any live book before that sign-off. ' +
      (baselineReproduces
        ? ''
        : 'PRECONDITION UNMET: arm A does NOT reproduce the TRA-405 §4.1 ' +
          'validated GO (the macd_bollinger OOS book shows negative return ' +
          'even on the post-TRA-427 clean cache). Per the spec §6 hard ' +
          'dependency a profitability-lever GO/NO-GO is meaningless on a ' +
          'negative-OOS book — the §6 sign-off is blocked until the ' +
          'macd_bollinger edge regression is resolved, which is outside ' +
          'TRA-430 implementation scope.'),
  };
  const out = resolve(REPORT_DIR, 'tra430-validation.json');
  writeFileSync(out, JSON.stringify(payload, null, 2));
  console.log(
    `\nWrote ${out}\n` +
      `  §6 precondition — arm A reproduces TRA-405 §4.1 baseline: ` +
      `${baselineReproduces ? 'YES' : 'NO'}\n` +
      `  §6 sign-off status: ${baselineReproduces ? 'READY for QuantTrader' : 'BLOCKED — baseline unmet, GO/NO-GO not meaningful'}` +
      (baselineReproduces
        ? `\n  harness acceptance (all cells): ${allPass ? 'PASS' : 'FAIL'}`
        : ''),
  );
}

const invoked =
  process.argv[1] && /run-tra430-validation\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
