/**
 * TRA-523 — Fee-aware Coinbase crypto strategy R&D.
 *
 * Goal: find 1–2 crypto strategies that survive Coinbase Advanced fees
 * out-of-sample on the trimmed 44-symbol Coinbase watchlist, with robustness
 * evidence (IS/OOS split + block-bootstrap lower-CI gate).
 *
 * QuantTrader-owned RESEARCH harness (not application code) — same status as
 * run-tra405-validation.ts / run-tra453-bbfade-majors.ts. It only consumes the
 * already-exported BacktestRunner / loadOrFetch4hBars APIs.
 *
 * ── Why this run exists ────────────────────────────────────────────────────
 * The live engine submits MARKET (taker) orders. Coinbase Advanced taker fees
 * are 0.40%–1.20%/side at our volume (0.8%–2.4% round trip). The TRA-405/432
 * validation used `cryptoTieredCostModel`, whose per-side commissions are only
 * 4–35 bps — an order of magnitude *below* real taker. So the honest fee test
 * has to model real taker vs maker explicitly. The runner already supports it:
 * `feeBps:{maker,taker}` + `executionMode:'limit'` posts the ENTRY as a maker
 * fill and keeps EXITS at taker (stop/target fire as market hits). That is the
 * realistic maker-entry model. We bracket the answer with four cost arms:
 *
 *   gross_0       feeBps 0           — zero-fee reference (raw signal edge)
 *   maker_both_10 feeBps 10  (flat)  — optimistic ceiling: every leg a maker
 *   maker_entry   {maker:25,taker:60}+limit — REALISTIC: maker entry, taker exit
 *   taker_60      feeBps 60 (flat)   — status quo: market in & out (0.60%/side)
 *   taker_80      feeBps 80 (flat)   — conservative high-taker (0.80%/side)
 *
 * Slippage is held at 3 bps/side across all arms so the only thing that moves
 * is the commission lever.
 *
 * ── Windows (mirror TRA-405) ───────────────────────────────────────────────
 *   IS  = 2023-05-01 .. 2024-12-31  (overlaps the era the constants were tuned)
 *   OOS = 2025-01-01 .. now         (genuinely unseen)
 *
 * ── Robustness gate (CTO lower-CI-bound) ───────────────────────────────────
 * Per (strategy, cost arm) we POOL the OOS per-trade R-multiples across the
 * whole universe (per-symbol samples are too thin to bootstrap alone — majors
 * fire ~10 trades/yr). We compound 1% account-risk per trade in trade order,
 * then moving-block bootstrap (blockLen 5, 5000 iters) the pooled sequence.
 * A keeper requires the 5th-percentile final-equity multiple > 1.0 (lower CI
 * bound still profitable net of fees) AND pooled OOS expectancy > 0.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra523-fee-aware.ts
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle } from '@trading-app/shared';
import { BacktestRunner } from './runner.js';
import { loadOrFetch4hBars, cachePathFor4h } from './fetch-tra266-data.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const DATA_START_MS = Date.UTC(2023, 4, 1); // 2023-05-01
const IS_START_MS = Date.UTC(2023, 4, 1);
const IS_END_MS = Date.UTC(2025, 0, 1) - 1; // 2024-12-31 23:59:59.999
const OOS_START_MS = Date.UTC(2025, 0, 1); // 2025-01-01
// TRA-815: the OOS window normally ends "now", but a moving end always exceeds
// the on-disk cache coverage and forces a full Coinbase re-fetch of all 44
// symbols on every run. `TRA523_OOS_END` (ISO date) pins the end for a
// deterministic, network-free re-run against the cache. Default stays `now`.
const OOS_END_OVERRIDE = process.env['TRA523_OOS_END'];
const OOS_END_MS = OOS_END_OVERRIDE ? Date.parse(OOS_END_OVERRIDE) : Date.now();

const INITIAL_EQUITY = 25_000;
const SLIPPAGE_BPS = 3;
const RISK_PER_TRADE = 0.01; // 1% account risk per trade for the equity-curve / bootstrap

// Trimmed Coinbase-only watchlist (44 symbols, CRYPTO_WATCHLIST after cf04bbc).
const UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'ADA-USD', 'DOT-USD',
  'AVAX-USD', 'LINK-USD', 'POL-USD', 'XRP-USD', 'LTC-USD',
  'BCH-USD', 'ATOM-USD', 'DOGE-USD', 'SHIB-USD', 'NEAR-USD',
  'S-USD', 'SAND-USD', 'MANA-USD', 'AXS-USD', 'UNI-USD',
  'AAVE-USD', 'MKR-USD', 'CRV-USD', 'ALGO-USD', 'XLM-USD',
  'ETC-USD', 'FIL-USD', 'HBAR-USD', 'ICP-USD', 'FLOW-USD',
  'GRT-USD', 'ARB-USD', 'OP-USD', 'APT-USD', 'SUI-USD',
  'INJ-USD', 'RENDER-USD', 'IMX-USD', 'LDO-USD', 'SNX-USD',
  'APE-USD', 'COMP-USD', 'CHZ-USD', 'ZEC-USD',
] as const;

type StrategyType = BacktestConfig['strategyType'];

interface StrategySpec {
  name: string;
  type: StrategyType;
  extra: Partial<BacktestConfig>;
}

const STRATEGIES: StrategySpec[] = [
  // The surviving mean-reversion edge (long-only BB fade, ranging regime).
  { name: 'bb_fade', type: 'bb_fade', extra: { macdBollingerOpts: { enforceTimeFilter: false } } },
  // Low-frequency mean-reversion candidate (regime-gated to range).
  { name: 'mean_reversion', type: 'mean_reversion', extra: { meanReversionOpts: {}, meanReversionRiskPct: RISK_PER_TRADE } },
];

interface CostArm {
  name: string;
  feeBps: number | { maker: number; taker: number };
  executionMode: 'market' | 'limit';
}

const COST_ARMS: CostArm[] = [
  { name: 'gross_0', feeBps: 0, executionMode: 'market' },
  { name: 'maker_both_10', feeBps: 10, executionMode: 'market' },
  { name: 'maker_entry', feeBps: { maker: 25, taker: 60 }, executionMode: 'limit' },
  { name: 'taker_60', feeBps: 60, executionMode: 'market' },
  { name: 'taker_80', feeBps: 80, executionMode: 'market' },
];

interface SegMetrics {
  trades: number;
  winRatePct: number;
  expectancyR: number;
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
    // TRA-815: use the NET-of-fees expectancy (TRA-818) so every arm differs.
    // Gross `r.expectancy` is fee-blind and was the bug being fixed here.
    expectancyR: r.expectancyNet,
    profitFactor: Number.isFinite(r.profitFactor) ? r.profitFactor : -1,
    sharpe: r.sharpeRatio,
    maxDdPct: r.maxDrawdown * 100,
    totalPnlUsd: r.totalPnl,
    returnPct: (r.totalPnl / INITIAL_EQUITY) * 100,
  };
}

/**
 * Moving-block bootstrap over a pooled per-trade R sequence. Compounds 1%
 * account-risk per trade in block-resampled order so within-block streaks
 * survive. Returns final-equity-multiple percentiles (1.0 = breakeven) and the
 * worst observed drawdown. `null` if too few trades to be meaningful.
 */
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
  return {
    n,
    p5: pct(5),
    p50: pct(50),
    p95: pct(95),
    worstDdPct: worstDd * 100,
    blockLen,
    iterations,
  };
}

function expectancyOf(rs: number[]): number {
  return rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0;
}
function pfOf(rs: number[]): number {
  let g = 0, l = 0;
  for (const r of rs) { if (r > 0) g += r; else l += Math.abs(r); }
  return l > 0 ? g / l : g > 0 ? Infinity : 0;
}

/**
 * Fetching 3y of 1H bars per symbol is ~90 paginated requests; the Coinbase
 * Exchange public host has a burst budget that one symbol's history nearly
 * exhausts, so back-to-back symbols 429 ("Public rate limit exceeded"). The
 * per-request path also has a 7s abort and no internal retry, and
 * `fetchCoinbase4hBars` only caches after EVERY window succeeds — so a single
 * 429/timeout drops the whole symbol. Wrap the loader in a rate-limit-aware
 * retry: on failure, sleep long enough for the IP bucket / 60s breaker cooldown
 * to refill, then retry the whole symbol. Cached symbols short-circuit to disk,
 * so progress compounds across attempts (and across re-runs).
 */
const RATE_LIMIT_BACKOFFS_MS = [45_000, 70_000, 70_000, 90_000, 120_000];
async function loadWithRetry(symbol: string, from: number, to: number): Promise<Candle[]> {
  let lastErr: unknown;
  for (let i = 0; i <= RATE_LIMIT_BACKOFFS_MS.length; i++) {
    try {
      return await loadOrFetch4hBars(symbol, from, to);
    } catch (err) {
      lastErr = err;
      if (i < RATE_LIMIT_BACKOFFS_MS.length) {
        const wait = RATE_LIMIT_BACKOFFS_MS[i];
        process.stdout.write(` [429/timeout — retry in ${wait / 1000}s]`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** Pause between symbols so the Coinbase public-host burst bucket refills. */
const INTER_SYMBOL_GAP_MS = 12_000;

function cfg(symbol: string, spec: StrategySpec, arm: CostArm, start: number, end: number): BacktestConfig {
  return {
    symbol,
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: spec.type,
    feeBps: arm.feeBps,
    executionMode: arm.executionMode,
    slippageBps: SLIPPAGE_BPS,
    fractionalQuantity: true,
    ...spec.extra,
  };
}

interface SymCell {
  symbol: string;
  strategy: string;
  arm: string;
  isExpectancyR: number;
  isTrades: number;
  oos: SegMetrics;
  oosRs: number[]; // per-trade NET-of-fees R (TRA-818 tradeRsNet), OOS only — pooled, stripped from final JSON
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();
  console.log(`[tra523] fee-aware crypto R&D — ${UNIVERSE.length} symbols × ${STRATEGIES.length} strategies × ${COST_ARMS.length} cost arms`);
  console.log(`[tra523] IS ${new Date(IS_START_MS).toISOString().slice(0, 10)}..${new Date(IS_END_MS).toISOString().slice(0, 10)}  |  OOS ${new Date(OOS_START_MS).toISOString().slice(0, 10)}..${new Date(OOS_END_MS).toISOString().slice(0, 10)}`);

  const cells: SymCell[] = [];
  const loaded: string[] = [];
  const failed: { symbol: string; error: string }[] = [];

  // TRA-523 performance: skip uncached symbols entirely when the env flag is set.
  // This allows a fast backtest run on already-cached symbols without any API calls
  // or inter-symbol rate-limit gaps (total runtime ~seconds instead of ~minutes).
  const cachedOnly = process.env['TRA523_CACHED_ONLY'] === '1';

  for (let si = 0; si < UNIVERSE.length; si++) {
    const symbol = UNIVERSE[si];
    const cached = existsSync(cachePathFor4h(symbol));

    if (cachedOnly && !cached) {
      process.stdout.write(`\n[${symbol}] SKIP (not cached, TRA523_CACHED_ONLY=1)`);
      failed.push({ symbol, error: 'not cached' });
      continue;
    }

    // Refill the public-host burst bucket between symbols (skip before the first,
    // and skip when the symbol is already cached — no API call will be made).
    if (si > 0 && !cached) {
      await new Promise((r) => setTimeout(r, INTER_SYMBOL_GAP_MS));
    }
    process.stdout.write(`\n[${symbol}] loading 4H… `);
    let candles: Candle[];
    try {
      candles = await loadWithRetry(symbol, DATA_START_MS, OOS_END_MS);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`SKIP — ${msg}`);
      failed.push({ symbol, error: msg });
      continue;
    }
    const years = (candles[candles.length - 1].timestamp - candles[0].timestamp) / (365.25 * 864e5);
    loaded.push(symbol);
    process.stdout.write(`${candles.length} bars (${years.toFixed(2)}y)`);

    for (const spec of STRATEGIES) {
      for (const arm of COST_ARMS) {
        const isRes = await runner.run(cfg(symbol, spec, arm, IS_START_MS, IS_END_MS), candles);
        const oosRes = await runner.run(cfg(symbol, spec, arm, OOS_START_MS, OOS_END_MS), candles);
        cells.push({
          symbol,
          strategy: spec.name,
          arm: arm.name,
          isExpectancyR: isRes.expectancyNet,
          isTrades: isRes.totalTrades,
          oos: metricsOf(oosRes),
          oosRs: oosRes.tradeRsNet,
        });
      }
    }
  }
  console.log(`\n\n[tra523] loaded ${loaded.length}/${UNIVERSE.length} symbols; ${failed.length} skipped.`);

  // ── Pool OOS R across the universe per (strategy, cost arm) ────────────────
  interface Pool {
    strategy: string;
    arm: string;
    symbolsContributing: number;
    trades: number;
    expectancyR: number;
    profitFactor: number;
    bootstrap: ReturnType<typeof blockBootstrapR>;
    keeper: boolean;
  }
  const pools: Pool[] = [];
  for (const spec of STRATEGIES) {
    for (const arm of COST_ARMS) {
      const matching = cells.filter((c) => c.strategy === spec.name && c.arm === arm.name);
      const pooledRs = matching.flatMap((c) => c.oosRs);
      const contributing = matching.filter((c) => c.oosRs.length > 0).length;
      const bs = blockBootstrapR(pooledRs);
      const exp = expectancyOf(pooledRs);
      const keeper = bs !== null && bs.p5 > 1.0 && exp > 0;
      pools.push({
        strategy: spec.name,
        arm: arm.name,
        symbolsContributing: contributing,
        trades: pooledRs.length,
        expectancyR: exp,
        profitFactor: pfOf(pooledRs),
        bootstrap: bs,
        keeper,
      });
    }
  }

  // ── Per-symbol OOS keeper screen (maker_entry arm — the realistic case) ────
  const perSymbolKeepers = cells
    .filter((c) => c.arm === 'maker_entry' && c.oos.trades >= 8 && c.oos.expectancyR > 0 && c.oos.profitFactor > 1.0)
    .map((c) => ({
      symbol: c.symbol,
      strategy: c.strategy,
      oosTrades: c.oos.trades,
      oosExpectancyR: c.oos.expectancyR,
      oosProfitFactor: c.oos.profitFactor,
      oosReturnPct: c.oos.returnPct,
      oosSharpe: c.oos.sharpe,
      isExpectancyR: c.isExpectancyR,
    }))
    .sort((a, b) => b.oosExpectancyR - a.oosExpectancyR);

  // Strip the heavy per-trade R arrays before persisting the per-symbol table.
  const symbolTable = cells.map(({ oosRs, ...rest }) => ({ ...rest, oosTradeCount: oosRs.length }));

  const payload = {
    issue: 'TRA-523',
    generatedAt: new Date().toISOString(),
    windows: {
      is: { start: new Date(IS_START_MS).toISOString(), end: new Date(IS_END_MS).toISOString() },
      oos: { start: new Date(OOS_START_MS).toISOString(), end: new Date(OOS_END_MS).toISOString() },
    },
    initialEquity: INITIAL_EQUITY,
    slippageBps: SLIPPAGE_BPS,
    riskPerTrade: RISK_PER_TRADE,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    universe: UNIVERSE,
    loaded,
    failed,
    costArms: COST_ARMS,
    keeperGate: 'pooled OOS block-bootstrap p5 final-equity multiple > 1.0 AND pooled OOS expectancy > 0',
    pools,
    perSymbolKeepers,
    symbolTable,
  };
  const jsonPath = resolve(REPORT_DIR, 'tra523-fee-aware.json');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  // ── Console summary ────────────────────────────────────────────────────────
  console.log('\n=== Pooled OOS by (strategy × cost arm) ===');
  console.log('strategy        arm            n    exp(R)   PF     p5x    p50x   p95x   keeper');
  for (const p of pools) {
    const bs = p.bootstrap;
    console.log(
      `${p.strategy.padEnd(15)} ${p.arm.padEnd(13)} ${String(p.trades).padStart(4)}  ` +
      `${p.expectancyR.toFixed(3).padStart(7)} ${p.profitFactor.toFixed(2).padStart(5)}  ` +
      `${bs ? bs.p5.toFixed(3) : '  -  '}  ${bs ? bs.p50.toFixed(3) : '  -  '}  ${bs ? bs.p95.toFixed(3) : '  -  '}  ` +
      `${p.keeper ? 'YES ✅' : 'no'}`,
    );
  }
  console.log('\n=== Per-symbol OOS keepers (maker_entry arm, ≥8 tr, exp>0, PF>1) ===');
  if (perSymbolKeepers.length === 0) console.log('  (none)');
  for (const k of perSymbolKeepers) {
    console.log(`  ${k.symbol.padEnd(11)} ${k.strategy.padEnd(15)} n=${String(k.oosTrades).padStart(3)} exp=${k.oosExpectancyR.toFixed(2)}R PF=${k.oosProfitFactor.toFixed(2)} ret=${k.oosReturnPct.toFixed(1)}%`);
  }
  console.log(`\n[tra523] report written: ${jsonPath}`);
}

const invoked = process.argv[1] && /run-tra523-fee-aware\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
