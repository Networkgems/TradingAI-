/**
 * TRA-821 (TRA-817 workstream C) — `tsmom_majors` capital-gate validation run.
 *
 * Cloned from `run-tra523-fee-aware.ts` and parameterised for the frozen
 * `tsmom_majors` candidate (BTC/ETH/SOL, **daily** bars, long-or-flat, band
 * exit; sizing via the VolKellySizer fed `volTargetAnnualPct`). QuantTrader-owned
 * RESEARCH harness — it only consumes the exported BacktestRunner /
 * loadOrFetchDailyBars APIs and produces a committed report for the PASS/FAIL
 * verdict. It does NOT promote, edit the manifest, or flip any preset.
 *
 * Methodology (per the TRA-817 plan):
 *   • Universe: BTC-USD, ETH-USD, SOL-USD only. Source: Yahoo daily.
 *   • IS  2023-05-01 .. 2024-12-31  — params PICKED here.
 *     OOS 2025-01-01 .. now         — single frozen config GRADED here.
 *     A warmup tail back to 2022-01-01 fills the L-day lookback so the first IS
 *     bar can fire (no cold-start trade loss).
 *   • Cost arms: `maker_entry` ({maker:25,taker:60} + limit entry) AND `taker_80`
 *     (flat 80 bps). Both reported. Slippage 3 bps/side across arms.
 *   • Pooled OOS metrics: moving-block bootstrap p5 final-equity multiple AND
 *     pooled net expectancy (`expectancyNet`, TRA-818). Keeper = p5 > 1.0 AND
 *     pooled expectancyNet > 0.
 *   • Walk-forward >=2 folds across distinct regimes (2022 bear → 2023 recovery
 *     → 2024 bull → 2025 chop), the SAME IS-picked frozen config, no per-fold
 *     re-fit.
 *   • Neighboring-config stability table around the picked config (overfit
 *     guardrail).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra817-tsmom-majors.ts
 *   (TRA817_OOS_END=YYYY-MM-DD pins the OOS end for a deterministic re-run.)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import type { TsmomMajorsParams } from '@trading-app/engine';
import { BacktestRunner } from './runner.js';
import { loadOrFetchDailyBars } from './fetch-tra266-data.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2022, 0, 1); // 2022-01-01 — warmup + 2022-bear fold
const IS_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_END_MS = Date.UTC(2025, 0, 1) - 1; // 2024-12-31 23:59:59.999
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01
const OOS_END_OVERRIDE = process.env['TRA817_OOS_END'];
const OOS_END_MS = OOS_END_OVERRIDE ? Date.parse(OOS_END_OVERRIDE) : Date.now();

const INITIAL_EQUITY = 25_000;
const SLIPPAGE_BPS = 3;
const RISK_PER_TRADE = 0.01; // 1% account-risk per pooled trade for the equity-curve / bootstrap

// Frozen universe — BTC/ETH/SOL only (do NOT alter per the spec).
const UNIVERSE = ['BTC-USD', 'ETH-USD', 'SOL-USD'] as const;

interface CostArm {
  name: string;
  feeBps: number | { maker: number; taker: number };
  executionMode: 'market' | 'limit';
}

// Per the spec: report the realistic maker-entry arm AND a conservative high-taker arm.
const COST_ARMS: CostArm[] = [
  { name: 'maker_entry', feeBps: { maker: 25, taker: 60 }, executionMode: 'limit' },
  { name: 'taker_80', feeBps: 80, executionMode: 'market' },
];

// ── Param grid for IS selection (over the EXISTING 4 frozen params only). The
// vol target governs sizing risk, not edge, so it is held at the spec default
// 60 for selection and only flexed in the neighbour table. lookback + bands are
// picked on IS, then the single winner is graded OOS / walk-forward.
const GRID_LOOKBACK = [50, 75, 100, 150, 200];
const GRID_ENTRY_BAND = [0, 3, 5];
const GRID_EXIT_BAND = [0, 3, 5];
const SELECTION_VOL_TARGET = 60;

interface SegMetrics {
  trades: number;
  winRatePct: number;
  expectancyR: number; // NET-of-fees expectancy (TRA-818)
  profitFactor: number;
  sharpe: number;
  maxDdPct: number;
  totalPnlUsd: number;
  returnPct: number;
}

function metricsOf(r: BacktestResult): SegMetrics {
  return {
    trades: r.totalTrades,
    winRatePct: r.winRate * 100,
    expectancyR: r.expectancyNet,
    profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : -1,
    sharpe: r.sharpeRatio,
    maxDdPct: r.maxDrawdown * 100,
    totalPnlUsd: r.totalPnl,
    returnPct: (r.totalPnl / INITIAL_EQUITY) * 100,
  };
}

/** Moving-block bootstrap over a pooled per-trade NET R sequence (see TRA-523). */
function blockBootstrapR(rs: number[], blockLen = 5, iterations = 5000, seed = 817) {
  if (rs.length < 12) return null;
  let s = seed >>> 0;
  const rand = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const n = rs.length;
  const finals: number[] = [];
  let worstDd = 0;
  for (let it = 0; it < iterations; it++) {
    let equity = 1;
    let peak = 1;
    let dd = 0;
    let drawn = 0;
    while (drawn < n) {
      const start = Math.floor(rand() * n);
      for (let k = 0; k < blockLen && drawn < n; k++, drawn++) {
        equity *= 1 + RISK_PER_TRADE * rs[(start + k) % n];
        peak = Math.max(peak, equity);
        if (peak > 0) dd = Math.max(dd, (peak - equity) / peak);
      }
    }
    finals.push(equity);
    worstDd = Math.max(worstDd, dd);
  }
  finals.sort((a, b) => a - b);
  const pct = (p: number) => finals[Math.min(finals.length - 1, Math.floor((p / 100) * finals.length))];
  return { n, p5: pct(5), p50: pct(50), p95: pct(95), worstDdPct: worstDd * 100, blockLen, iterations };
}

function expectancyOf(rs: number[]): number {
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
}
function pfOf(rs: number[]): number {
  let g = 0, l = 0;
  for (const r of rs) { if (r > 0) g += r; else l += Math.abs(r); }
  return l > 0 ? g / l : g > 0 ? Infinity : 0;
}

function cfg(
  symbol: string,
  params: TsmomMajorsParams,
  arm: CostArm,
  start: number,
  end: number,
): BacktestConfig {
  return {
    symbol,
    warmupStartDate: DATA_START_MS, // warm the L-day lookback + 30-bar vol window
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'tsmom_majors',
    tsmomOpts: params,
    feeBps: arm.feeBps,
    executionMode: arm.executionMode,
    slippageBps: SLIPPAGE_BPS,
    fractionalQuantity: true,
  };
}

/**
 * Pool per-trade NET R across the universe for one (params, arm, window) and
 * return the pooled OOS-style stats + the keeper verdict.
 */
async function pooledRun(
  runner: BacktestRunner,
  barsBySymbol: Record<string, Candle[]>,
  params: TsmomMajorsParams,
  arm: CostArm,
  start: number,
  end: number,
) {
  const perSymbol: Array<{ symbol: string; seg: SegMetrics; rs: number[] }> = [];
  for (const symbol of UNIVERSE) {
    const res = await runner.run(cfg(symbol, params, arm, start, end), barsBySymbol[symbol]);
    perSymbol.push({ symbol, seg: metricsOf(res), rs: res.tradeRsNet });
  }
  const pooledRs = perSymbol.flatMap((p) => p.rs);
  const bs = blockBootstrapR(pooledRs);
  const exp = expectancyOf(pooledRs);
  const keeper = bs !== null && bs.p5 > 1.0 && exp > 0;
  return {
    trades: pooledRs.length,
    symbolsContributing: perSymbol.filter((p) => p.rs.length > 0).length,
    expectancyNet: exp,
    profitFactor: pfOf(pooledRs),
    bootstrap: bs,
    keeper,
    perSymbol: perSymbol.map((p) => ({ symbol: p.symbol, ...p.seg })),
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();
  console.log(`[tra817] tsmom_majors capital-gate validation — ${UNIVERSE.length} symbols (daily), 2 cost arms`);
  console.log(`[tra817] IS ${new Date(IS_START_MS).toISOString().slice(0, 10)}..${new Date(IS_END_MS).toISOString().slice(0, 10)}  |  OOS ${new Date(OOS_START_MS).toISOString().slice(0, 10)}..${new Date(OOS_END_MS).toISOString().slice(0, 10)}`);

  // ── Load daily bars once (2022-01-01 .. OOS end) ───────────────────────────
  const barsBySymbol: Record<string, Candle[]> = {};
  for (const symbol of UNIVERSE) {
    process.stdout.write(`\n[${symbol}] loading daily… `);
    const candles = await loadOrFetchDailyBars(symbol, DATA_START_MS, OOS_END_MS);
    barsBySymbol[symbol] = candles;
    const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5);
    process.stdout.write(`${candles.length} bars (${years.toFixed(2)}y)`);
  }
  console.log('');

  // ── IS param selection (maker_entry arm) ───────────────────────────────────
  // Pick the lookback + bands that maximise the pooled IS bootstrap p5 (the same
  // statistic the keeper gate scores), tie-broken by pooled IS net expectancy.
  // Vol target held at the spec default for selection.
  const makerArm = COST_ARMS.find((a) => a.name === 'maker_entry')!;
  interface GridRow {
    params: Required<TsmomMajorsParams>;
    isTrades: number;
    isP5: number | null;
    isExpectancyNet: number;
  }
  const grid: GridRow[] = [];
  for (const L of GRID_LOOKBACK) {
    for (const eb of GRID_ENTRY_BAND) {
      for (const xb of GRID_EXIT_BAND) {
        const params = { lookbackDays: L, entryBandPct: eb, exitBandPct: xb, volTargetAnnualPct: SELECTION_VOL_TARGET };
        const r = await pooledRun(runner, barsBySymbol, params, makerArm, IS_START_MS, IS_END_MS);
        grid.push({ params, isTrades: r.trades, isP5: r.bootstrap?.p5 ?? null, isExpectancyNet: r.expectancyNet });
      }
    }
  }
  // Rank: prefer a usable bootstrap (>=12 trades) with the highest p5; configs
  // without a bootstrap fall back to expectancy so selection still terminates.
  const ranked = [...grid].sort((a, b) => {
    const ap = a.isP5 ?? -Infinity;
    const bp = b.isP5 ?? -Infinity;
    if (bp !== ap) return bp - ap;
    return b.isExpectancyNet - a.isExpectancyNet;
  });
  const picked = ranked[0].params;
  console.log(`\n[tra817] IS-picked frozen config: L=${picked.lookbackDays} entryBand=${picked.entryBandPct}% exitBand=${picked.exitBandPct}% volTarget=${picked.volTargetAnnualPct}%  (IS p5=${ranked[0].isP5?.toFixed(3) ?? 'n/a'}, expN=${ranked[0].isExpectancyNet.toFixed(3)}, n=${ranked[0].isTrades})`);

  // ── OOS grade (both arms), single frozen config ────────────────────────────
  const oosByArm: Record<string, Awaited<ReturnType<typeof pooledRun>>> = {};
  for (const arm of COST_ARMS) {
    oosByArm[arm.name] = await pooledRun(runner, barsBySymbol, picked, arm, OOS_START_MS, OOS_END_MS);
  }

  // ── Walk-forward across regime folds (maker_entry arm), no re-fit ───────────
  const FOLDS = [
    { name: '2022_bear', start: Date.UTC(2022, 0, 1), end: Date.UTC(2023, 0, 1) - 1 },
    { name: '2023_recovery', start: Date.UTC(2023, 0, 1), end: Date.UTC(2024, 0, 1) - 1 },
    { name: '2024_bull', start: Date.UTC(2024, 0, 1), end: Date.UTC(2025, 0, 1) - 1 },
    { name: '2025_chop', start: OOS_START_MS, end: OOS_END_MS },
  ];
  const walkForward: Array<{ fold: string; window: { start: string; end: string }; arm: string; trades: number; expectancyNet: number; profitFactor: number; p5: number | null; p50: number | null; keeper: boolean }> = [];
  for (const fold of FOLDS) {
    for (const arm of COST_ARMS) {
      const r = await pooledRun(runner, barsBySymbol, picked, arm, fold.start, fold.end);
      walkForward.push({
        fold: fold.name,
        window: { start: new Date(fold.start).toISOString(), end: new Date(fold.end).toISOString() },
        arm: arm.name,
        trades: r.trades,
        expectancyNet: r.expectancyNet,
        profitFactor: r.profitFactor,
        p5: r.bootstrap?.p5 ?? null,
        p50: r.bootstrap?.p50 ?? null,
        keeper: r.keeper,
      });
    }
  }

  // ── Neighbouring-config stability (overfit guardrail), OOS maker_entry ──────
  // Flex each param one grid step around the pick (incl. vol target) and grade OOS.
  const neighborConfigs: Array<Required<TsmomMajorsParams>> = [];
  const stepIdx = <T>(arr: T[], v: T) => arr.indexOf(v);
  const flex = (arr: number[], v: number): number[] => {
    const i = stepIdx(arr, v);
    const out: number[] = [];
    if (i > 0) out.push(arr[i - 1]);
    if (i >= 0 && i < arr.length - 1) out.push(arr[i + 1]);
    return out;
  };
  for (const L of flex(GRID_LOOKBACK, picked.lookbackDays)) neighborConfigs.push({ ...picked, lookbackDays: L });
  for (const eb of flex(GRID_ENTRY_BAND, picked.entryBandPct)) neighborConfigs.push({ ...picked, entryBandPct: eb });
  for (const xb of flex(GRID_EXIT_BAND, picked.exitBandPct)) neighborConfigs.push({ ...picked, exitBandPct: xb });
  for (const vt of [40, 80]) neighborConfigs.push({ ...picked, volTargetAnnualPct: vt });

  const neighborTable: Array<{ params: Required<TsmomMajorsParams>; arm: string; trades: number; expectancyNet: number; p5: number | null; keeper: boolean }> = [];
  for (const params of neighborConfigs) {
    for (const arm of COST_ARMS) {
      const r = await pooledRun(runner, barsBySymbol, params, arm, OOS_START_MS, OOS_END_MS);
      neighborTable.push({ params, arm: arm.name, trades: r.trades, expectancyNet: r.expectancyNet, p5: r.bootstrap?.p5 ?? null, keeper: r.keeper });
    }
  }

  // ── Persist report ─────────────────────────────────────────────────────────
  const payload = {
    issue: 'TRA-821',
    workstream: 'TRA-817 workstream C',
    strategy: 'tsmom_majors',
    generatedAt: new Date().toISOString(),
    universe: UNIVERSE,
    barTimeframe: '1d',
    dataSource: 'yahoo-daily',
    initialEquity: INITIAL_EQUITY,
    slippageBps: SLIPPAGE_BPS,
    riskPerTrade: RISK_PER_TRADE,
    sizing: 'VolKellySizer (vol-only; Kelly cap inactive in-backtest — feeding OOS expectancy into OOS sizing would be look-ahead. Live supplies validated OOS net expectancy per spec).',
    windows: {
      is: { start: new Date(IS_START_MS).toISOString(), end: new Date(IS_END_MS).toISOString() },
      oos: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
      warmupStart: new Date(DATA_START_MS).toISOString(),
    },
    costArms: COST_ARMS,
    keeperGate: 'pooled OOS block-bootstrap p5 final-equity multiple > 1.0 AND pooled OOS net expectancy > 0',
    paramGrid: { lookbackDays: GRID_LOOKBACK, entryBandPct: GRID_ENTRY_BAND, exitBandPct: GRID_EXIT_BAND, selectionVolTargetPct: SELECTION_VOL_TARGET },
    pickedConfig: picked,
    isSelectionTable: ranked.slice(0, 12),
    oos: COST_ARMS.map((a) => ({ arm: a.name, ...oosByArm[a.name] })),
    walkForward,
    neighborStability: neighborTable,
  };
  const jsonPath = resolve(REPORT_DIR, 'tra817-tsmom-majors.json');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  // ── Console summary ─────────────────────────────────────────────────────────
  console.log('\n=== Pooled OOS by cost arm (frozen IS-picked config) ===');
  console.log('arm           n     expN     PF      p5x     p50x    keeper');
  for (const a of COST_ARMS) {
    const r = oosByArm[a.name];
    const bs = r.bootstrap;
    console.log(
      `${a.name.padEnd(13)} ${String(r.trades).padStart(4)}  ${r.expectancyNet.toFixed(3).padStart(7)} ` +
      `${r.profitFactor.toFixed(2).padStart(5)}  ${bs ? bs.p5.toFixed(3) : '  -  '}  ${bs ? bs.p50.toFixed(3) : '  -  '}  ${r.keeper ? 'YES ✅' : 'no'}`,
    );
  }
  console.log('\n=== Walk-forward (maker_entry) ===');
  for (const w of walkForward.filter((w) => w.arm === 'maker_entry')) {
    console.log(`  ${w.fold.padEnd(14)} n=${String(w.trades).padStart(3)} expN=${w.expectancyNet.toFixed(3)} PF=${w.profitFactor.toFixed(2)} p5=${w.p5 != null ? w.p5.toFixed(3) : 'n/a'} keeper=${w.keeper ? 'YES' : 'no'}`);
  }
  console.log(`\n[tra817] report written: ${jsonPath}`);
}

const invoked = process.argv[1] && /run-tra817-tsmom-majors\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
