/**
 * TRA-829 (TRA-828 spec) — `managed_xsmom` trend-regime-filtered cross-sectional
 * momentum validation (cycle-3).
 *
 * Small, additive extension of `run-tra825-xsmom-liquid.ts` (cycle-2): the gate /
 * bootstrap / cost-arm / selection code is reused VERBATIM (same `blockBootstrapR`,
 * seed 523, blockLen 5, 5000 iters, 1% risk compounding; keeper = pooled OOS p5
 * final-equity > 1.0 AND pooled OOS net expectancy > 0 on BOTH arms; ≥ 12 pooled
 * OOS round-trips). The ONLY new mechanic is the rebalance-time aggregate-market
 * trend regime gate (TRA-828 §3.1), which lives in `xsmom-portfolio-runner.ts`
 * behind an optional `regimeMA`. This harness:
 *   • crosses the cycle-2 12-config grid with `regimeMA ∈ {30,60,90}` → 36 configs,
 *   • threads `regimeMA` through the UNCHANGED §4/§5 selection rule,
 *   • emits the §7 report (regimeFilter, pctTimeInCash, oosBarsRiskOff,
 *     rebalancesRiskOff, neighbour stability incl. regimeMA, regimeIndexVariant),
 *   • applies the §6.1 THINNESS GUARD (≥ 12 pooled OOS round-trips WITH the filter
 *     active, else verdict FAIL_THINNESS — not relaxed, not re-tuned post-hoc).
 *
 * QuantTrader-owned RESEARCH harness: it does NOT promote, edit the manifest, or
 * flip any preset. No engine, preset, or live-path changes.
 *
 * Run (offline / deterministic):
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra828-managed-xsmom.ts
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
// TRA-828 §6: pin the OOS end for a deterministic, cache-only re-run. Default to
// 2026-06-03 (the spec's worked example, inside every cached symbol's coverage).
// Same env pin as TRA-827 so cycle-2 / cycle-3 re-run on identical windows.
const OOS_END_OVERRIDE = process.env['TRA825_OOS_END'];
const OOS_END_MS = OOS_END_OVERRIDE ? Date.parse(OOS_END_OVERRIDE) : Date.UTC(2026, 5, 3);

const INITIAL_EQUITY = 25_000;
const SLIPPAGE_BPS = 3;
const RISK_PER_TRADE = 0.01; // 1% account-risk per pooled trade for the bootstrap

// Frozen universe — 10 liquid Coinbase names, all 4h-cached (spec §2, verbatim).
const UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'AVAX-USD',
  'LINK-USD', 'DOT-USD', 'LTC-USD', 'XRP-USD', 'DOGE-USD',
] as const;

// Both arms must PASS (spec §6).
const COST_ARMS: XsmomCostArm[] = [
  { name: 'maker_entry', feeBps: { maker: 25, taker: 60 }, executionMode: 'limit' },
  { name: 'taker_80', feeBps: 80, executionMode: 'market' },
];

// Pre-registered IS grid (3×2×2×3 = 36 configs); rebalance + volTarget fixed (§5).
const GRID_LOOKBACK_DAYS = [60, 90, 120];
const GRID_TOP_K = [3, 4];
const GRID_ABS_FLOOR_PCT = [0, 5];
const GRID_REGIME_MA = [30, 60, 90]; // NEW (spec §3.2/§5) — aggregate-trend SMA bars
const FIXED_REBALANCE_BARS = 42; // weekly = 7d × 6
const FIXED_VOL_TARGET_PCT = 60;
const MIN_RETAINED = 8; // §2 cross-section floor

// Proxy symbol for the §7 regimeIndexVariant robustness diagnostic (NOT graded).
const REGIME_PROXY_SYMBOL = 'BTC-USD';

// IS selection runs on the realistic maker-entry arm (mirrors TRA-825/TRA-827).
const SELECTION_ARM = COST_ARMS.find((a) => a.name === 'maker_entry')!;

// ── Gate code reused VERBATIM from run-tra523-fee-aware.ts / TRA-825 (seed 523). ─
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

function paramsOf(lookbackDays: number, topK: number, absFloorPct: number, regimeMA: number): XsmomParams {
  return {
    lookbackDays,
    topK,
    absFloorPct,
    rebalanceBars: FIXED_REBALANCE_BARS,
    volTargetAnnualPct: FIXED_VOL_TARGET_PCT,
    regimeMA,
  };
}

/** Pool one (params, arm, window) into the keeper-style stats + verdict. */
function pooledRun(
  candlesBySymbol: Record<string, Candle[]>,
  params: XsmomParams,
  arm: XsmomCostArm,
  evalStart: number,
  evalEnd: number,
  regimeIndexMode: 'equal_weight_universe' | 'btc_proxy' = 'equal_weight_universe',
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
    regimeIndexMode,
    regimeProxySymbol: REGIME_PROXY_SYMBOL,
  });
  const pooledRs = res.tradeRsNet;
  const bs = blockBootstrapR(pooledRs);
  const exp = expectancyOf(pooledRs);
  const keeper = bs !== null && bs.p5 > 1.0 && exp > 0;
  const pctTimeInCash = res.rebalancesEvaluated > 0
    ? res.rebalancesRiskOff / res.rebalancesEvaluated
    : 0;
  return {
    trades: pooledRs.length,
    symbolsContributing: res.symbolsContributing,
    expectancyNet: exp,
    profitFactor: pfOf(pooledRs),
    bootstrap: bs,
    keeper,
    rebalancesEvaluated: res.rebalancesEvaluated,
    rebalancesRiskOff: res.rebalancesRiskOff,
    // §7 risk-off audit fields. oosBarsRiskOff = risk-off rebalances × cadence
    // (each risk-off rebalance sits the book out for the full weekly window).
    oosBarsRiskOff: res.rebalancesRiskOff * params.rebalanceBars,
    pctTimeInCash,
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
  console.log(`[tra828] managed_xsmom regime-filtered cross-sectional gate — ${UNIVERSE.length} symbols (4h), 2 cost arms, 36 configs`);
  console.log(`[tra828] IS ${new Date(IS_START_MS).toISOString().slice(0, 10)}..${new Date(IS_END_MS).toISOString().slice(0, 10)}  |  OOS ${new Date(OOS_START_MS).toISOString().slice(0, 10)}..${new Date(OOS_END_MS).toISOString().slice(0, 10)}`);

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

  // ── IS param selection (maker-entry arm) per spec §5 (UNCHANGED rule). ─────
  interface GridRow {
    params: XsmomParams;
    isRoundTrips: number;
    isP5: number | null;
    isExpectancyNet: number;
    isProfitFactor: number;
    isPctTimeInCash: number;
    qualifies: boolean;
  }
  const grid: GridRow[] = [];
  for (const L of GRID_LOOKBACK_DAYS) {
    for (const K of GRID_TOP_K) {
      for (const floor of GRID_ABS_FLOOR_PCT) {
        for (const ma of GRID_REGIME_MA) {
          const params = paramsOf(L, K, floor, ma);
          const r = pooledRun(candlesBySymbol, params, SELECTION_ARM, IS_START_MS, IS_END_MS);
          const p5 = r.bootstrap?.p5 ?? null;
          // §5 selection eligibility (IDENTICAL to TRA-825 §4): IS net expectancy
          // > 0 AND IS round-trips ≥ 30 AND IS bootstrap p5 computable (≥ 12).
          const qualifies = r.expectancyNet > 0 && r.trades >= 30 && p5 !== null;
          grid.push({
            params,
            isRoundTrips: r.trades,
            isP5: p5,
            isExpectancyNet: r.expectancyNet,
            isProfitFactor: r.profitFactor,
            isPctTimeInCash: r.pctTimeInCash,
            qualifies,
          });
          console.log(
            `  L=${String(L).padStart(3)} K=${K} floor=${floor}% rMA=${String(ma).padStart(2)}  ` +
            `n=${String(r.trades).padStart(3)} expN=${r.expectancyNet.toFixed(3)} ` +
            `p5=${p5 != null ? p5.toFixed(3) : ' n/a '} cash=${(r.pctTimeInCash * 100).toFixed(0)}% ${qualifies ? '✓qualifies' : ''}`,
          );
        }
      }
    }
  }

  // §5 pick: highest IS p5 among qualifying configs; tie-break higher round-trips.
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
  }).map((g) => ({
    lookbackDays: g.params.lookbackDays,
    topK: g.params.topK,
    absFloorPct: g.params.absFloorPct,
    regimeMA: g.params.regimeMA,
    isRoundTrips: g.isRoundTrips,
    isP5: g.isP5,
    isExpectancyNet: g.isExpectancyNet,
    isProfitFactor: g.isProfitFactor,
    isPctTimeInCash: g.isPctTimeInCash,
    qualifies: g.qualifies,
  }));

  let oosByArm: Record<string, ReturnType<typeof pooledRun>> = {};
  let walkForward: Array<Record<string, unknown>> = [];
  let neighborStability: Array<Record<string, unknown>> = [];
  let thinness = { pooledOosRoundTrips: 0, ge12: false };
  let regimeIndexVariant: Record<string, unknown> | null = null;

  if (!isFailNoEdge) {
    const picked = pickedRow!.params;
    console.log(`\n[tra828] IS-picked frozen config: L=${picked.lookbackDays} K=${picked.topK} floor=${picked.absFloorPct}% regimeMA=${picked.regimeMA} (IS p5=${pickedRow!.isP5?.toFixed(3)}, expN=${pickedRow!.isExpectancyNet.toFixed(3)}, n=${pickedRow!.isRoundTrips})`);

    // ── OOS grade, both arms, single frozen config. ──────────────────────────
    for (const arm of COST_ARMS) {
      oosByArm[arm.name] = pooledRun(candlesBySymbol, picked, arm, OOS_START_MS, OOS_END_MS);
    }
    const oosRoundTrips = oosByArm[SELECTION_ARM.name].trades; // arm-invariant count
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
          rebalancesEvaluated: r.rebalancesEvaluated,
          rebalancesRiskOff: r.rebalancesRiskOff,
          oosBarsRiskOff: r.oosBarsRiskOff,
          pctTimeInCash: r.pctTimeInCash,
        });
      }
    }

    // ── Neighbour stability (±1 grid step on L / K / floor / regimeMA), OOS. ──
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
    for (const ma of flex(GRID_REGIME_MA, picked.regimeMA!)) neighborConfigs.push({ ...picked, regimeMA: ma });
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
          pctTimeInCash: r.pctTimeInCash,
        });
      }
    }

    // ── §7 regimeIndexVariant — ONE diagnostic re-run of the picked config with
    // the BTC-close proxy index, selection (maker) arm, OOS only. NOT graded.
    const variant = pooledRun(candlesBySymbol, picked, SELECTION_ARM, OOS_START_MS, OOS_END_MS, 'btc_proxy');
    regimeIndexVariant = {
      regimeIndex: 'btc_close_proxy',
      proxySymbol: REGIME_PROXY_SYMBOL,
      arm: SELECTION_ARM.name,
      graded: false,
      roundTrips: variant.trades,
      expectancyNet: variant.expectancyNet,
      p5: variant.bootstrap?.p5 ?? null,
      pctTimeInCash: variant.pctTimeInCash,
    };
  } else {
    console.log('\n[tra828] FAIL — no IS config qualifies (gated signal has no IS edge to carry to OOS). Spec §5 stop.');
  }

  // ── Verdict (spec §6/§6.1). ────────────────────────────────────────────────
  const bothArmsKeeper = !isFailNoEdge && COST_ARMS.every((a) => oosByArm[a.name]?.keeper);
  let verdict: 'PASS' | 'FAIL_GATE' | 'FAIL_THINNESS' | 'FAIL_NO_IS_EDGE';
  if (isFailNoEdge) {
    verdict = 'FAIL_NO_IS_EDGE';
  } else if (!thinness.ge12) {
    // THINNESS GUARD binds first: < 12 pooled OOS round-trips WITH filter active.
    verdict = 'FAIL_THINNESS';
  } else if (bothArmsKeeper) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL_GATE';
  }

  // ── Persist report (mirrors tra825-xsmom-liquid.json schema + §7 additions). ─
  const payload = {
    issue: 'TRA-829',
    parent: 'TRA-828',
    program: 'TRA-814',
    strategy: 'managed_xsmom',
    generatedAt: new Date().toISOString(),
    universe: UNIVERSE,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    initialEquity: INITIAL_EQUITY,
    slippageBps: SLIPPAGE_BPS,
    riskPerTrade: RISK_PER_TRADE,
    sizing: 'VolKellySizer (vol-only; Kelly cap inactive in-backtest — OOS expectancy → OOS sizing is look-ahead. Live supplies validated OOS net expectancy per spec). Equal-weight top-K, each slot vol-targeted; risk clamped [0.5%, 1.75%].',
    roundTripDefinition: 'A round-trip opens when a name enters the equal-weight top-K book (fill at next 4h bar open) and closes when a weekly rebalance drops it from the book — by rank/floor crossing OR a regime flip to risk_off forcing the book to all-cash (fill at next 4h bar open). Net-of-fee R = netPnl / (stopDistance × qty), stopDistance = one daily vol-target σ (sizing-only 1R).',
    regimeFilter: {
      definition: 'At each weekly rebalance close, risk_on iff the equal-weight universe close index M_t = mean_i(close_{i,t}) (over names with full regimeMA history) exceeds its trailing SMA of length regimeMA (4h bars, current bar included); else risk_off → target book forced to ∅ (all cash), held names liquidated at next bar open via the unchanged exit path; re-entry rebuilds from fresh ranking on the next risk_on rebalance.',
      regimeIndex: 'equal_weight_universe',
      regimeMA: isFailNoEdge ? null : pickedRow!.params.regimeMA,
      riskOffAction: 'all_cash',
    },
    windows: {
      is: { start: new Date(IS_START_MS).toISOString(), end: new Date(IS_END_MS).toISOString() },
      oos: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
      warmupStart: new Date(DATA_START_MS).toISOString(),
      oosEndPinned: OOS_END_OVERRIDE ?? '2026-06-03 (default)',
    },
    costArms: COST_ARMS,
    keeperGate: 'pooled OOS block-bootstrap p5 final-equity multiple > 1.0 AND pooled OOS net expectancy > 0, on BOTH cost arms; ≥ 12 pooled OOS round-trips WITH the regime filter active',
    paramGrid: {
      lookbackDays: GRID_LOOKBACK_DAYS,
      topK: GRID_TOP_K,
      absFloorPct: GRID_ABS_FLOOR_PCT,
      regimeMA: GRID_REGIME_MA,
      rebalanceBars: FIXED_REBALANCE_BARS,
      volTargetAnnualPct: FIXED_VOL_TARGET_PCT,
    },
    selectionArm: SELECTION_ARM.name,
    selectionRule: 'Among IS configs with net expectancy > 0 AND ≥ 30 IS round-trips AND computable bootstrap p5 (≥ 12 IS round-trips), pick highest IS p5; tie-break higher round-trips. None qualify → FAIL_NO_IS_EDGE. (Identical to TRA-825 §4; regimeMA threaded through, rule unchanged.)',
    isFailNoEdge,
    pickedConfig: pickedRow?.params ?? null,
    isSelectionTable,
    droppedForNoHistory: droppedNoHistory,
    oos: isFailNoEdge ? null : COST_ARMS.map((a) => ({ arm: a.name, ...oosByArm[a.name] })),
    walkForward,
    neighborStability,
    regimeIndexVariant,
    thinnessCheck: thinness,
    verdict,
  };
  const jsonPath = resolve(REPORT_DIR, 'tra828-managed-xsmom.json');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  // ── Console summary. ───────────────────────────────────────────────────────
  if (!isFailNoEdge) {
    console.log('\n=== Pooled OOS by cost arm (frozen IS-picked config) ===');
    console.log('arm           n     expN     PF      p5x     p50x   cash%   keeper');
    for (const a of COST_ARMS) {
      const r = oosByArm[a.name];
      const bs = r.bootstrap;
      console.log(
        `${a.name.padEnd(13)} ${String(r.trades).padStart(4)}  ${r.expectancyNet.toFixed(3).padStart(7)} ` +
        `${r.profitFactor.toFixed(2).padStart(5)}  ${bs ? bs.p5.toFixed(3) : '  -  '}  ${bs ? bs.p50.toFixed(3) : '  -  '}  ${(r.pctTimeInCash * 100).toFixed(0).padStart(4)}%  ${r.keeper ? 'YES ✅' : 'no'}`,
      );
    }
    console.log(`\nthinness: pooledOosRoundTrips=${thinness.pooledOosRoundTrips} ge12=${thinness.ge12}`);
  }
  console.log(`verdict: ${verdict}`);
  console.log(`\n[tra828] report written: ${jsonPath}`);
}

const invoked = process.argv[1] && /run-tra828-managed-xsmom\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
