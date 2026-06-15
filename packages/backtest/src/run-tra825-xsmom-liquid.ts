/**
 * TRA-827 (TRA-825 spec) — `xsmom_liquid` cross-sectional momentum validation.
 *
 * Grades the frozen `xsmom_liquid` candidate through the IDENTICAL fixed
 * fee-aware keeper gate used by `run-tra523-fee-aware.ts` /
 * `run-tra817-tsmom-majors.ts`. The gate / bootstrap / cost-arm code is reused
 * VERBATIM (same `blockBootstrapR`, seed 523, blockLen 5, 5000 iters, 1% risk
 * compounding; keeper = pooled OOS p5 final-equity > 1.0 AND pooled OOS net
 * expectancy > 0) so the gate stays unchanged across cycle-2.
 *
 * The one real engine gap — a cross-sectional portfolio runner that advances
 * all symbols on a shared clock and rotates an equal-weight top-K book each
 * weekly rebalance — lives in `xsmom-portfolio-runner.ts`. This harness only
 * orchestrates IS selection, the OOS grade, walk-forward and the neighbour
 * table, then writes the report. QuantTrader-owned RESEARCH harness: it does
 * NOT promote, edit the manifest, or flip any preset.
 *
 * Run (offline / deterministic):
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra825-xsmom-liquid.ts
 *   (TRA825_OOS_END=YYYY-MM-DD pins the OOS end for a network-free re-run.)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { loadOrFetch4hBars } from './fetch-tra266-data.js';
import {
  runXsmomPortfolio,
  type XsmomParams,
  type XsmomCostArm,
} from './xsmom-portfolio-runner.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01 (4h cache start)
const IS_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_END_MS = Date.UTC(2025, 0, 1) - 1; // 2024-12-31 23:59:59.999
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01
// TRA-825 §5: pin the OOS end for a deterministic, cache-only re-run. Default to
// 2026-06-03 (the spec's worked example, inside every cached symbol's coverage).
const OOS_END_OVERRIDE = process.env['TRA825_OOS_END'];
const OOS_END_MS = OOS_END_OVERRIDE ? Date.parse(OOS_END_OVERRIDE) : Date.UTC(2026, 5, 3);

const INITIAL_EQUITY = 25_000;
const SLIPPAGE_BPS = 3;
const RISK_PER_TRADE = 0.01; // 1% account-risk per pooled trade for the bootstrap

// Frozen universe — 10 liquid Coinbase names, all 4h-cached (spec §1).
const UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'AVAX-USD',
  'LINK-USD', 'DOT-USD', 'LTC-USD', 'XRP-USD', 'DOGE-USD',
] as const;

// Both arms must PASS (spec §5).
const COST_ARMS: XsmomCostArm[] = [
  { name: 'maker_entry', feeBps: { maker: 25, taker: 60 }, executionMode: 'limit' },
  { name: 'taker_80', feeBps: 80, executionMode: 'market' },
];

// Pre-registered IS grid (3×2×2 = 12 configs); rebalance + volTarget fixed (§4).
const GRID_LOOKBACK_DAYS = [60, 90, 120];
const GRID_TOP_K = [3, 4];
const GRID_ABS_FLOOR_PCT = [0, 5];
const FIXED_REBALANCE_BARS = 42; // weekly = 7d × 6
const FIXED_VOL_TARGET_PCT = 60;
const MIN_RETAINED = 8; // §1 cross-section floor

// IS selection runs on the realistic maker-entry arm (mirrors TRA-817).
const SELECTION_ARM = COST_ARMS.find((a) => a.name === 'maker_entry')!;

// ── Gate code reused VERBATIM from run-tra523-fee-aware.ts (seed 523). ────────
function blockBootstrapR(rs: number[], blockLen = 5, iterations = 5000, seed = 523) {
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

function paramsOf(lookbackDays: number, topK: number, absFloorPct: number): XsmomParams {
  return {
    lookbackDays,
    topK,
    absFloorPct,
    rebalanceBars: FIXED_REBALANCE_BARS,
    volTargetAnnualPct: FIXED_VOL_TARGET_PCT,
  };
}

/** Pool one (params, arm, window) into the keeper-style stats + verdict. */
function pooledRun(
  candlesBySymbol: Record<string, Candle[]>,
  params: XsmomParams,
  arm: XsmomCostArm,
  evalStart: number,
  evalEnd: number,
) {
  const res = runXsmomPortfolio({
    candlesBySymbol,
    symbols: [...UNIVERSE],
    params,
    arm,
    warmupStart: DATA_START_MS,
    evalStart,
    evalEnd,
    initialEquity: INITIAL_EQUITY,
    slippageBps: SLIPPAGE_BPS,
    minRetained: MIN_RETAINED,
  });
  const pooledRs = res.tradeRsNet;
  const bs = blockBootstrapR(pooledRs);
  const exp = expectancyOf(pooledRs);
  const keeper = bs !== null && bs.p5 > 1.0 && exp > 0;
  return {
    trades: pooledRs.length,
    symbolsContributing: res.symbolsContributing,
    expectancyNet: exp,
    profitFactor: pfOf(pooledRs),
    bootstrap: bs,
    keeper,
    rebalancesEvaluated: res.rebalancesEvaluated,
    minRetainedNames: res.minRetainedNames,
    droppedForHistory: res.droppedForHistory,
    perSymbol: Object.entries(res.perSymbolRs).map(([symbol, rs]) => ({
      symbol,
      roundTrips: rs.length,
      expectancyNet: expectancyOf(rs),
      profitFactor: pfOf(rs),
    })),
  };
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  console.log(`[tra825] xsmom_liquid cross-sectional gate — ${UNIVERSE.length} symbols (4h), 2 cost arms`);
  console.log(`[tra825] IS ${new Date(IS_START_MS).toISOString().slice(0, 10)}..${new Date(IS_END_MS).toISOString().slice(0, 10)}  |  OOS ${new Date(OOS_START_MS).toISOString().slice(0, 10)}..${new Date(OOS_END_MS).toISOString().slice(0, 10)}`);

  // ── Load 4h bars once (offline / cache-only). ──────────────────────────────
  const candlesBySymbol: Record<string, Candle[]> = {};
  const droppedNoHistory: string[] = [];
  for (const symbol of UNIVERSE) {
    process.stdout.write(`\n[${symbol}] loading 4h… `);
    const candles = await loadOrFetch4hBars(symbol, DATA_START_MS, OOS_END_MS);
    candlesBySymbol[symbol] = candles;
    const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5);
    process.stdout.write(`${candles.length} bars (${years.toFixed(2)}y, from ${new Date(candles[0].timestamp).toISOString().slice(0, 10)})`);
    if (candles.length < GRID_LOOKBACK_DAYS[0] * 6 + 2) droppedNoHistory.push(symbol);
  }
  console.log('');

  // ── IS param selection (maker-entry arm) per spec §4. ──────────────────────
  interface GridRow {
    params: XsmomParams;
    isRoundTrips: number;
    isP5: number | null;
    isExpectancyNet: number;
    isProfitFactor: number;
    qualifies: boolean;
  }
  const grid: GridRow[] = [];
  for (const L of GRID_LOOKBACK_DAYS) {
    for (const K of GRID_TOP_K) {
      for (const floor of GRID_ABS_FLOOR_PCT) {
        const params = paramsOf(L, K, floor);
        const r = pooledRun(candlesBySymbol, params, SELECTION_ARM, IS_START_MS, IS_END_MS);
        const p5 = r.bootstrap?.p5 ?? null;
        // §4 selection eligibility: IS net expectancy > 0 AND IS round-trips ≥ 30
        // AND IS bootstrap p5 computable (≥ 12 IS round-trips).
        const qualifies = r.expectancyNet > 0 && r.trades >= 30 && p5 !== null;
        grid.push({
          params,
          isRoundTrips: r.trades,
          isP5: p5,
          isExpectancyNet: r.expectancyNet,
          isProfitFactor: r.profitFactor,
          qualifies,
        });
        console.log(
          `  L=${String(L).padStart(3)} K=${K} floor=${floor}%  ` +
          `n=${String(r.trades).padStart(3)} expN=${r.expectancyNet.toFixed(3)} ` +
          `p5=${p5 != null ? p5.toFixed(3) : ' n/a '} ${qualifies ? '✓qualifies' : ''}`,
        );
      }
    }
  }

  // §4 pick: highest IS p5 among qualifying configs; tie-break higher round-trips.
  const qualifying = grid.filter((g) => g.qualifies);
  const rankedQualifying = [...qualifying].sort((a, b) => {
    const ap = a.isP5 ?? -Infinity;
    const bp = b.isP5 ?? -Infinity;
    if (bp !== ap) return bp - ap;
    return b.isRoundTrips - a.isRoundTrips;
  });
  const pickedRow = rankedQualifying[0] ?? null;
  const isFailNoEdge = pickedRow === null;

  // Full IS table sorted for the report (qualifiers first, then by p5/expectancy).
  const isSelectionTable = [...grid].sort((a, b) => {
    if (a.qualifies !== b.qualifies) return a.qualifies ? -1 : 1;
    const ap = a.isP5 ?? -Infinity;
    const bp = b.isP5 ?? -Infinity;
    if (bp !== ap) return bp - ap;
    return b.isExpectancyNet - a.isExpectancyNet;
  });

  let oos: ReturnType<typeof pooledRun> | null = null;
  const oosByArm: Record<string, ReturnType<typeof pooledRun>> = {};
  const walkForward: Array<Record<string, unknown>> = [];
  const neighborStability: Array<Record<string, unknown>> = [];
  let thinness = { pooledOosRoundTrips: 0, ge12: false };

  if (!isFailNoEdge) {
    const picked = pickedRow!.params;
    console.log(`\n[tra825] IS-picked frozen config: L=${picked.lookbackDays} K=${picked.topK} floor=${picked.absFloorPct}% (IS p5=${pickedRow!.isP5?.toFixed(3)}, expN=${pickedRow!.isExpectancyNet.toFixed(3)}, n=${pickedRow!.isRoundTrips})`);

    // ── OOS grade, both arms, single frozen config. ──────────────────────────
    for (const arm of COST_ARMS) {
      oosByArm[arm.name] = pooledRun(candlesBySymbol, picked, arm, OOS_START_MS, OOS_END_MS);
    }
    oos = oosByArm[SELECTION_ARM.name];
    const oosRoundTrips = oos.trades; // arm-invariant count (same fills, different fees)
    thinness = { pooledOosRoundTrips: oosRoundTrips, ge12: oosRoundTrips >= 12 };

    // ── Walk-forward across regime folds (both arms), no re-fit. ──────────────
    const FOLDS = [
      { name: '2023_recovery', start: DATA_START_MS, end: Date.UTC(2024, 0, 1) - 1 },
      { name: '2024_bull', start: Date.UTC(2024, 0, 1), end: Date.UTC(2025, 0, 1) - 1 },
      { name: '2025_chop', start: OOS_START_MS, end: OOS_END_MS },
    ];
    for (const fold of FOLDS) {
      for (const arm of COST_ARMS) {
        const r = pooledRun(candlesBySymbol, picked, arm, fold.start, fold.end);
        walkForward.push({
          fold: fold.name,
          window: { start: new Date(fold.start).toISOString(), end: new Date(fold.end).toISOString() },
          arm: arm.name,
          roundTrips: r.trades,
          expectancyNet: r.expectancyNet,
          profitFactor: r.profitFactor,
          p5: r.bootstrap?.p5 ?? null,
          p50: r.bootstrap?.p50 ?? null,
          keeper: r.keeper,
        });
      }
    }

    // ── Neighbour stability (±1 grid step on L / K / floor), OOS, both arms. ──
    const flex = (arr: number[], v: number): number[] => {
      const i = arr.indexOf(v);
      const out: number[] = [];
      if (i > 0) out.push(arr[i - 1]);
      if (i >= 0 && i < arr.length - 1) out.push(arr[i + 1]);
      return out;
    };
    const neighborConfigs: XsmomParams[] = [];
    for (const L of flex(GRID_LOOKBACK_DAYS, picked.lookbackDays)) neighborConfigs.push({ ...picked, lookbackDays: L });
    for (const K of flex(GRID_TOP_K, picked.topK)) neighborConfigs.push({ ...picked, topK: K });
    for (const floor of flex(GRID_ABS_FLOOR_PCT, picked.absFloorPct)) neighborConfigs.push({ ...picked, absFloorPct: floor });
    for (const params of neighborConfigs) {
      for (const arm of COST_ARMS) {
        const r = pooledRun(candlesBySymbol, params, arm, OOS_START_MS, OOS_END_MS);
        neighborStability.push({
          params,
          arm: arm.name,
          roundTrips: r.trades,
          expectancyNet: r.expectancyNet,
          p5: r.bootstrap?.p5 ?? null,
          keeper: r.keeper,
        });
      }
    }
  } else {
    console.log('\n[tra825] FAIL — no IS config qualifies (no IS edge to carry to OOS). Spec §4 stop.');
  }

  // ── Persist report (mirrors tra817-tsmom-majors.json schema). ──────────────
  const bothArmsPass = !isFailNoEdge
    && COST_ARMS.every((a) => oosByArm[a.name]?.keeper)
    && thinness.ge12;
  const payload = {
    issue: 'TRA-827',
    parent: 'TRA-825',
    strategy: 'xsmom_liquid',
    generatedAt: new Date().toISOString(),
    universe: UNIVERSE,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    initialEquity: INITIAL_EQUITY,
    slippageBps: SLIPPAGE_BPS,
    riskPerTrade: RISK_PER_TRADE,
    sizing: 'VolKellySizer (vol-only; Kelly cap inactive in-backtest — OOS expectancy → OOS sizing is look-ahead. Live supplies validated OOS net expectancy per spec). Equal-weight top-K, each slot vol-targeted; risk clamped [0.5%, 1.75%].',
    roundTripDefinition: 'A round-trip opens when a name enters the equal-weight top-K book (fill at next 4h bar open) and closes when a weekly rebalance drops it from the book (fill at next 4h bar open). Net-of-fee R = netPnl / (stopDistance × qty), stopDistance = one daily vol-target σ (sizing-only 1R).',
    windows: {
      is: { start: new Date(IS_START_MS).toISOString(), end: new Date(IS_END_MS).toISOString() },
      oos: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
      warmupStart: new Date(DATA_START_MS).toISOString(),
      oosEndPinned: OOS_END_OVERRIDE ?? '2026-06-03 (default)',
    },
    costArms: COST_ARMS,
    keeperGate: 'pooled OOS block-bootstrap p5 final-equity multiple > 1.0 AND pooled OOS net expectancy > 0, on BOTH cost arms; ≥ 12 pooled OOS round-trips',
    paramGrid: {
      lookbackDays: GRID_LOOKBACK_DAYS,
      topK: GRID_TOP_K,
      absFloorPct: GRID_ABS_FLOOR_PCT,
      rebalanceBars: FIXED_REBALANCE_BARS,
      volTargetAnnualPct: FIXED_VOL_TARGET_PCT,
    },
    selectionArm: SELECTION_ARM.name,
    selectionRule: 'Among IS configs with net expectancy > 0 AND ≥ 30 IS round-trips AND computable bootstrap p5 (≥ 12 IS round-trips), pick highest IS p5; tie-break higher round-trips. None qualify → FAIL.',
    isFailNoEdge,
    pickedConfig: pickedRow?.params ?? null,
    isSelectionTable,
    droppedForNoHistory: droppedNoHistory,
    oos: isFailNoEdge ? null : COST_ARMS.map((a) => ({ arm: a.name, ...oosByArm[a.name] })),
    walkForward,
    neighborStability,
    thinnessCheck: thinness,
    verdict: isFailNoEdge ? 'FAIL_NO_IS_EDGE' : bothArmsPass ? 'PASS_BOTH_ARMS' : 'FAIL_GATE',
  };
  const jsonPath = resolve(REPORT_DIR, 'tra825-xsmom-liquid.json');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  // ── Console summary. ───────────────────────────────────────────────────────
  if (!isFailNoEdge) {
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
    console.log(`\nthinness: pooledOosRoundTrips=${thinness.pooledOosRoundTrips} ge12=${thinness.ge12}`);
    console.log(`verdict: ${payload.verdict}`);
  }
  console.log(`\n[tra825] report written: ${jsonPath}`);
}

const invoked = process.argv[1] && /run-tra825-xsmom-liquid\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
