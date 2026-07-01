/**
 * TRA-1211 — Crypto/futures strategy research: regime-split backtest.
 *
 * QuantTrader-owned RESEARCH harness (not application code) — same status as
 * run-tra523-fee-aware.ts. It only consumes the already-exported
 * BacktestRunner / loadOrFetch4hBars APIs; it does not touch any live/demo path.
 *
 * Goal: score the directional strategy families the harness can already run,
 * split by BULL vs BEAR regime, fee+slippage aware, on BTC/ETH + liquid majors.
 * Funding-carry / basis-arb / on-chain families are NOT here — no funding/basis
 * history in the harness; they are ranked from literature in the memo instead.
 *
 * Regimes (BTC cycle, bounded by 4H cache coverage 2023-05 .. 2026-06-03):
 *   BULL 2023-05-01 .. 2025-10-06   (BTC ~$28k → $126k ATH 2025-10-06)
 *   BEAR 2025-10-06 .. 2026-06-03   (ATH → ~50% drawdown)
 *
 * Per (strategy × regime) we POOL per-trade NET-of-cost R across the universe
 * (majors fire ~10 trades/yr each — too thin per symbol), then report:
 *   trades, expectancyNet (R), profitFactor, pooled Sharpe & Sortino
 *   (per-trade IR annualized by realised trades/yr), turnover (trades/yr),
 *   and a REAL merged-equity maxDD (per-trade closes sorted by exit time,
 *   1% account risk compounded across the universe).
 *
 * Run (network-free against the on-disk cache):
 *   TRA1211_CACHED_ONLY=1 TRA1211_END=2026-06-03T00:00:00Z \
 *     pnpm --filter @trading-app/backtest exec tsx src/run-tra1211-regime.ts
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
const BULL_START_MS = Date.UTC(2023, 4, 1);
const BULL_END_MS = Date.UTC(2025, 9, 6); // 2025-10-06 ATH
const BEAR_START_MS = Date.UTC(2025, 9, 6);
const END_OVERRIDE = process.env['TRA1211_END'];
const BEAR_END_MS = END_OVERRIDE ? Date.parse(END_OVERRIDE) : Date.now();

const INITIAL_EQUITY = 25_000;
const SLIPPAGE_BPS = 3;
const FEE_BPS = 60; // Coinbase taker, market in & out (status-quo live path)
const RISK_PER_TRADE = 0.01; // 1% account risk per trade for the equity curve
const YEAR_MS = 365.25 * 864e5;

// BTC/ETH + liquid majors (all Coinbase-cached).
const UNIVERSE = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'DOGE-USD',
  'AVAX-USD', 'LINK-USD', 'DOT-USD', 'LTC-USD', 'BCH-USD', 'ATOM-USD',
] as const;

type StrategyType = BacktestConfig['strategyType'];

interface StrategySpec {
  name: string;
  type: StrategyType;
  regimeTarget: string;
  extra: Partial<BacktestConfig>;
}

const STRATEGIES: StrategySpec[] = [
  { name: 'tsmom_majors', type: 'tsmom_majors', regimeTarget: 'bull/trend', extra: { tsmomOpts: {} } },
  { name: 'momentum', type: 'momentum', regimeTarget: 'bull/trend', extra: {} },
  { name: 'breakout_vol', type: 'breakout_vol', regimeTarget: 'bull/trend', extra: {} },
  { name: 'mean_reversion', type: 'mean_reversion', regimeTarget: 'chop/range', extra: { meanReversionOpts: {}, meanReversionRiskPct: RISK_PER_TRADE } },
  { name: 'bb_fade', type: 'bb_fade', regimeTarget: 'chop/range', extra: { macdBollingerOpts: { enforceTimeFilter: false } } },
];

interface Regime { name: string; start: number; end: number; }
const REGIMES: Regime[] = [
  { name: 'bull', start: BULL_START_MS, end: BULL_END_MS },
  { name: 'bear', start: BEAR_START_MS, end: BEAR_END_MS },
];

function cfg(symbol: string, spec: StrategySpec, start: number, end: number): BacktestConfig {
  return {
    symbol,
    warmupStartDate: DATA_START_MS, // warm 100d-lookback / EMA indicators before the window
    startDate: start,
    endDate: end,
    initialEquity: INITIAL_EQUITY,
    strategyType: spec.type,
    feeBps: FEE_BPS,
    executionMode: 'market',
    slippageBps: SLIPPAGE_BPS,
    fractionalQuantity: true,
    ...spec.extra,
  };
}

interface TradeR { closedAt: number; rNet: number; }

/** Merge per-trade (exit-time, netR) across the universe, sort by exit time,
 *  compound 1% account risk, return maxDD% and final-equity multiple. */
function mergedEquity(trades: TradeR[]) {
  const sorted = [...trades].sort((a, b) => a.closedAt - b.closedAt);
  let eq = 1, peak = 1, maxDd = 0;
  for (const t of sorted) {
    eq *= 1 + RISK_PER_TRADE * t.rNet;
    peak = Math.max(peak, eq);
    if (peak > 0) maxDd = Math.max(maxDd, (peak - eq) / peak);
  }
  return { finalMult: eq, maxDdPct: maxDd * 100 };
}

function mean(xs: number[]): number { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / (xs.length - 1));
}
function downsideDev(xs: number[]): number {
  // Root-mean-square of negative R only (target = 0R). Sortino denominator.
  const neg = xs.filter((x) => x < 0);
  if (neg.length === 0) return 0;
  return Math.sqrt(neg.reduce((a, b) => a + b * b, 0) / neg.length);
}
function profitFactor(xs: number[]): number {
  let g = 0, l = 0;
  for (const r of xs) { if (r > 0) g += r; else l += Math.abs(r); }
  return l > 0 ? g / l : g > 0 ? Infinity : 0;
}

interface Cell {
  strategy: string;
  regime: string;
  regimeTarget: string;
  symbolsContributing: number;
  trades: number;
  turnoverPerYr: number;
  expectancyNetR: number;
  profitFactor: number;
  sharpe: number;
  sortino: number;
  maxDdPct: number;
  finalEquityMult: number;
  returnPct: number;
}

async function main() {
  mkdirSync(REPORT_DIR, { recursive: true });
  const runner = new BacktestRunner();
  const cachedOnly = process.env['TRA1211_CACHED_ONLY'] === '1';
  console.log(`[tra1211] regime-split — ${UNIVERSE.length} symbols × ${STRATEGIES.length} strategies × ${REGIMES.length} regimes  (feeBps ${FEE_BPS}, slip ${SLIPPAGE_BPS})`);
  for (const r of REGIMES) {
    console.log(`[tra1211] ${r.name.toUpperCase()} ${new Date(r.start).toISOString().slice(0, 10)}..${new Date(r.end).toISOString().slice(0, 10)}`);
  }

  // Load candles once per symbol.
  const candlesBySym = new Map<string, Candle[]>();
  const loaded: string[] = [];
  const failed: { symbol: string; error: string }[] = [];
  for (const symbol of UNIVERSE) {
    if (cachedOnly && !existsSync(cachePathFor4h(symbol))) {
      failed.push({ symbol, error: 'not cached' });
      continue;
    }
    try {
      const c = await loadOrFetch4hBars(symbol, DATA_START_MS, BEAR_END_MS);
      candlesBySym.set(symbol, c);
      loaded.push(symbol);
      process.stdout.write(`\n[${symbol}] ${c.length} bars`);
    } catch (err) {
      failed.push({ symbol, error: err instanceof Error ? err.message : String(err) });
    }
  }
  console.log(`\n[tra1211] loaded ${loaded.length}/${UNIVERSE.length}`);

  const cells: Cell[] = [];
  for (const spec of STRATEGIES) {
    for (const reg of REGIMES) {
      process.stdout.write(`\n[run] ${spec.name}/${reg.name} `);
      const windowYears = (reg.end - reg.start) / YEAR_MS;
      const pooledRs: number[] = [];
      const pooledTrades: TradeR[] = [];
      let contributing = 0;
      for (const symbol of loaded) {
        const candles = candlesBySym.get(symbol)!;
        let res: BacktestResult;
        try {
          const t0 = Date.now();
          res = await runner.run(cfg(symbol, spec, reg.start, reg.end), candles);
          process.stdout.write(`${symbol.replace('-USD', '')}(${res.tradeRsNet.length}t/${Date.now() - t0}ms) `);
        } catch (err) {
          process.stdout.write(`\n[${spec.name}/${reg.name}/${symbol}] ERR ${err instanceof Error ? err.message : String(err)}`);
          continue;
        }
        if (res.tradeRsNet.length > 0) contributing++;
        pooledRs.push(...res.tradeRsNet);
        for (let i = 0; i < res.trades.length; i++) {
          const t = res.trades[i];
          const rNet = res.tradeRsNet[i];
          if (typeof t.closedAt === 'number' && typeof rNet === 'number') {
            pooledTrades.push({ closedAt: t.closedAt, rNet });
          }
        }
      }
      const n = pooledRs.length;
      const m = mean(pooledRs);
      const sd = stdev(pooledRs);
      const dd = downsideDev(pooledRs);
      const tradesPerYr = windowYears > 0 ? n / windowYears : 0;
      const annFactor = Math.sqrt(Math.max(tradesPerYr, 0));
      const eq = mergedEquity(pooledTrades);
      cells.push({
        strategy: spec.name,
        regime: reg.name,
        regimeTarget: spec.regimeTarget,
        symbolsContributing: contributing,
        trades: n,
        turnoverPerYr: Number(tradesPerYr.toFixed(1)),
        expectancyNetR: Number(m.toFixed(4)),
        profitFactor: Number((Number.isFinite(profitFactor(pooledRs)) ? profitFactor(pooledRs) : -1).toFixed(3)),
        sharpe: Number((sd > 0 ? (m / sd) * annFactor : 0).toFixed(3)),
        sortino: Number((dd > 0 ? (m / dd) * annFactor : 0).toFixed(3)),
        maxDdPct: Number(eq.maxDdPct.toFixed(2)),
        finalEquityMult: Number(eq.finalMult.toFixed(4)),
        returnPct: Number(((eq.finalMult - 1) * 100).toFixed(2)),
      });
    }
  }

  const payload = {
    issue: 'TRA-1211',
    generatedAt: new Date().toISOString(),
    parent: 'TRA-1210',
    regimes: REGIMES.map((r) => ({ name: r.name, start: new Date(r.start).toISOString(), end: new Date(r.end).toISOString() })),
    initialEquity: INITIAL_EQUITY,
    feeBps: FEE_BPS,
    slippageBps: SLIPPAGE_BPS,
    riskPerTrade: RISK_PER_TRADE,
    barTimeframe: '4h',
    dataSource: 'coinbase-exchange',
    universe: UNIVERSE,
    loaded,
    failed,
    notes: [
      'tsmom_majors, momentum, breakout_vol are LONG-OR-FLAT (no short leg) — bear regime = mostly cash, not short alpha.',
      'Sharpe/Sortino are pooled per-trade IR annualized by realised trades/yr (not a daily-return series).',
      'maxDD is a REAL merged-equity curve: per-trade closes sorted by exit time, 1% risk compounded across the universe.',
      'Funding-carry / basis-arb / on-chain families NOT tested here — no funding/basis/on-chain history in the harness.',
    ],
    cells,
  };
  const jsonPath = resolve(REPORT_DIR, 'tra1211-regime.json');
  writeFileSync(jsonPath, JSON.stringify(payload, null, 2));

  console.log('\n\n=== TRA-1211 regime-split (feeBps 60, slip 3, 1% risk) ===');
  console.log('strategy        regime  target       n    t/yr   exp(R)   PF     Sharpe  Sortino  maxDD%   ret%');
  for (const c of cells) {
    console.log(
      `${c.strategy.padEnd(15)} ${c.regime.padEnd(6)} ${c.regimeTarget.padEnd(11)} ${String(c.trades).padStart(4)}  ` +
      `${String(c.turnoverPerYr).padStart(5)}  ${c.expectancyNetR.toFixed(3).padStart(7)} ${String(c.profitFactor).padStart(6)}  ` +
      `${String(c.sharpe).padStart(6)}  ${String(c.sortino).padStart(7)}  ${String(c.maxDdPct).padStart(6)}  ${String(c.returnPct).padStart(7)}`,
    );
  }
  console.log(`\n[tra1211] report written: ${jsonPath}`);
}

const invoked = process.argv[1] && /run-tra1211-regime\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
