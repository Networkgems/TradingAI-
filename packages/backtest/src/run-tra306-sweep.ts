/**
 * TRA-307 / TRA-306 — strategy-ranking sweep harness.
 *
 * Runs every strategy × symbol cell defined in TRA-307 §1.3 once, on a single
 * 12-month window (2025-05-01 → 2026-04-30 UTC), and emits two machine-
 * readable JSON files for QuantTrader to write the markdown report from:
 *
 *   - reports/tra306-strategy-ranking.json — per (strategy, symbol, side) row
 *     with metrics (totalTrades, winRate, expectancy, profitFactor,
 *     sharpeRatio, maxDrawdownR/Pct, totalPnlUsd, barsInMarket / -Total /
 *     timeInMarketPct, ambiguousTrades).
 *   - reports/tra306-trades.json — `{ [strategyType_symbol]: Position[] }`
 *     raw closed-trade dumps for spot-checking.
 *
 * Single full-period run per cell — no walk-forward, no sensitivity sweep.
 * The 6 router/legacy 4H strategies trade 4H Coinbase bars; swing trades 1D
 * Yahoo bars; scalping trades 1m Coinbase bars on a 30-day override window
 * (2026-04-01 → 2026-04-30) flagged as `windowOverride` in the JSON output
 * so QuantTrader can apply the right caveat in the report.
 *
 * 4H is the apples-to-apples-with-caveat boundary: the live engine ticks
 * the 6 router/legacy strategies at 1m bars, but a 12-month 1m sweep is
 * infeasible (525,600 bars × O(N²) runner). 4H matches the timeframe at
 * which their indicator parameters were calibrated for crypto (per code
 * comments in `reversal.ts`, `mean-reversion-crypto.ts`, etc.) and we
 * already have validated tooling for it (TRA-261 / TRA-267 / TRA-297).
 *
 * Run config matches the live demo account (initialEquity $25k, shared
 * TRA-185 tiered per-symbol cost model, fractionalQuantity true, default
 * portfolio caps). The live `applyShortGates` / BTC-regime / funding overlay
 * is intentionally NOT applied — this sweep evaluates per-strategy raw edge
 * per side, not the live filtering stack.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra306-sweep.ts
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position } from '@trading-app/shared';
import { cryptoTieredCostModel, cryptoTierOf } from '@trading-app/engine';
import { BacktestRunner } from './runner.js';
import type { BacktestConfig, BacktestResult } from './types.js';
import {
  loadOrFetch1mBars,
  loadOrFetch4hBars,
  loadOrFetchDailyBars,
} from './fetch-tra266-data.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const WINDOW_START_MS = Date.UTC(2025, 4, 1);                    // 2025-05-01 00:00 UTC
const WINDOW_END_MS = Date.UTC(2026, 4, 1) - 1;                  // 2026-04-30 23:59:59.999 UTC
const SYMBOLS = ['SOL-USD', 'DOGE-USD'] as const;

const INITIAL_EQUITY_USD = 25_000;

/**
 * TRA-2033 — cost comes from the shared TRA-185 tiered model
 * (`cryptoTieredCostModel` in `@trading-app/engine`), the single source of
 * truth the live/demo crypto account and every other backtest validation
 * harness now consume. No local flat 40+5 bps copy to drift: BTC/ETH majors
 * pay 6 bps/fill, SOL (high-liq) 18 bps/fill, small-caps like DOGE 50 bps/fill.
 * One instance, reused for every cell (the model is pure per-symbol data).
 */
const COST_MODEL = cryptoTieredCostModel();

/**
 * Scalping override — 12 months of 1m bars is infeasible for an O(N²) runner
 * (525,600² ≈ 2.7e11 ops). Run a single representative 30-day window and tag
 * the result so the report can apply the right caveat.
 */
const SCALPING_WINDOW_START_MS = Date.UTC(2026, 3, 1);           // 2026-04-01 00:00 UTC
const SCALPING_WINDOW_END_MS = Date.UTC(2026, 4, 1) - 1;         // 2026-04-30 23:59:59.999 UTC
const SCALPING_WINDOW_TAG = '2026-04-01_to_2026-04-30';

type StrategyType = BacktestConfig['strategyType'];
type Side = 'all' | 'long' | 'short';
type Timeframe = '1m' | '4h' | '1d';

interface Cell {
  strategyType: StrategyType;
  timeframe: Timeframe;
  source: 'coinbase-1m' | 'coinbase-4h' | 'yahoo-1d';
  windowStartMs: number;
  windowEndMs: number;
  windowOverride: string | null;
  configFor(symbol: string): Pick<
    BacktestConfig,
    | 'momentumOpts'
    | 'breakoutVolOpts'
    | 'meanReversionOpts'
    | 'reversalOpts'
    | 'macdBollingerOpts'
    | 'swingOpts'
    | 'scalpingOpts'
  >;
}

/**
 * §1.3 strategy × timeframe matrix. Constructor configs come straight from
 * the spec; `momentumOpts: {}` etc. picks up the strategy's router-default
 * parameters — that's the apples-to-apples handle the spec asks for.
 *
 * Notes:
 *  - `mean_reversion` here is the *generic* RSI/BB router-default; it is
 *    NOT the §4.4 BB-reentry override variant explored in TRA-295 / TRA-296.
 *  - `reversal` and `macd_trend`/`bb_fade` disable the equity-session time
 *    filter (`enforceTimeFilter: false`) so 24/7 crypto bars actually fire
 *    signals. Without it the strategies silently produce zero trades.
 *  - `breakout_vol` and `mean_reversion` self-classify regime via their
 *    `regimeOptions` block (see runner.ts:193-205); leaving `regimeOpts`
 *    unset on the BacktestConfig falls through to those strategy defaults
 *    — exactly what §1.4 specifies.
 */
const CELLS: Cell[] = [
  {
    strategyType: 'momentum',
    timeframe: '4h',
    source: 'coinbase-4h',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({ momentumOpts: {} }),
  },
  {
    strategyType: 'breakout_vol',
    timeframe: '4h',
    source: 'coinbase-4h',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({ breakoutVolOpts: {} }),
  },
  {
    strategyType: 'mean_reversion',
    timeframe: '4h',
    source: 'coinbase-4h',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({ meanReversionOpts: {} }),
  },
  {
    strategyType: 'reversal',
    timeframe: '4h',
    source: 'coinbase-4h',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({
      reversalOpts: {
        enforceTimeFilter: false,
        rsiOverbought: 65,
        rsiOversold: 35,
      },
    }),
  },
  {
    strategyType: 'macd_trend',
    timeframe: '4h',
    source: 'coinbase-4h',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({ macdBollingerOpts: { enforceTimeFilter: false } }),
  },
  {
    strategyType: 'bb_fade',
    timeframe: '4h',
    source: 'coinbase-4h',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({ macdBollingerOpts: { enforceTimeFilter: false } }),
  },
  {
    strategyType: 'swing',
    timeframe: '1d',
    source: 'yahoo-1d',
    windowStartMs: WINDOW_START_MS,
    windowEndMs: WINDOW_END_MS,
    windowOverride: null,
    configFor: () => ({ swingOpts: {} }),
  },
  {
    strategyType: 'scalping',
    timeframe: '1m',
    source: 'coinbase-1m',
    windowStartMs: SCALPING_WINDOW_START_MS,
    windowEndMs: SCALPING_WINDOW_END_MS,
    windowOverride: SCALPING_WINDOW_TAG,
    configFor: () => ({ scalpingOpts: { enforceTimeFilter: false } }),
  },
];

interface CellMetrics {
  totalTrades: number;
  winners: number;
  losers: number;
  winRate: number;
  expectancy: number;
  profitFactor: number;
  sharpeRatio: number;
  maxDrawdownR: number;
  maxDrawdownPct: number;
  totalPnlUsd: number;
  barsInMarket: number;
  barsTotal: number;
  timeInMarketPct: number;
  ambiguousTrades: number;
}

interface RankingRow extends CellMetrics {
  strategyType: StrategyType;
  timeframe: Timeframe;
  symbol: string;
  side: Side;
  windowOverride: string | null;
}

/**
 * Maximum peak-to-trough drop on the running cumulative-R series, expressed
 * as a non-positive number (no drawdown → 0). Mirrors the standard equity-
 * curve drawdown definition but in R-space so the value is dimensionless and
 * comparable across cells with different symbol prices / equity curves.
 */
function maxDrawdownR(tradeRs: ReadonlyArray<number>): number {
  if (tradeRs.length === 0) return 0;
  let cum = 0;
  let peak = 0;
  let worst = 0;
  for (const r of tradeRs) {
    cum += r;
    if (cum > peak) peak = cum;
    const dd = cum - peak;
    if (dd < worst) worst = dd;
  }
  return worst;
}

function profitFactorFromTrades(trades: ReadonlyArray<Position>): number {
  let gross = 0;
  let loss = 0;
  for (const t of trades) {
    const pnl = t.pnl ?? 0;
    if (pnl > 0) gross += pnl;
    else loss += Math.abs(pnl);
  }
  if (loss > 0) return gross / loss;
  return gross > 0 ? Infinity : 0;
}

/**
 * Per-trade-R Sharpe (annualized via per-trade approximation). The runner
 * normally annualizes from the per-bar mark-to-market series; for side-
 * filtered subsets we don't have a per-side mtm series, so we fall through
 * to the runner's documented per-trade-R fallback path (`runner.ts:584-589`).
 */
function perTradeRSharpe(tradeRs: ReadonlyArray<number>): number {
  if (tradeRs.length < 2) return 0;
  const mean = tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length;
  const variance = tradeRs.reduce((s, r) => s + (r - mean) ** 2, 0) / (tradeRs.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}

/**
 * Computes the per-bar mark-to-market max drawdown for the side-filtered
 * subset by replaying the trades against the candle series. Mirrors the
 * runner's mtm-drawdown loop (`runner.ts:539-554`) but only counts the
 * subset's PnL, so the long/short rows surface a per-side drawdown rather
 * than the side-mixed runner output.
 */
function maxDrawdownPctFromTrades(
  trades: ReadonlyArray<Position>,
  candles: ReadonlyArray<Candle>,
  initialEquity: number,
): number {
  if (trades.length === 0) return 0;
  // Index trades by entry / exit timestamp for O(N) replay.
  const sorted = [...trades].sort((a, b) => a.openedAt - b.openedAt);
  let tradeIdx = 0;
  const open: Position[] = [];
  let runningEquity = initialEquity;
  let peakEquity = initialEquity;
  let maxDd = 0;

  for (const c of candles) {
    // Open new positions whose openedAt has now passed.
    while (tradeIdx < sorted.length && sorted[tradeIdx].openedAt <= c.timestamp) {
      open.push(sorted[tradeIdx]);
      tradeIdx += 1;
    }
    // Close positions whose closedAt is now at or before this bar's timestamp;
    // realize their PnL into runningEquity.
    for (let i = open.length - 1; i >= 0; i--) {
      const p = open[i];
      if (p.closedAt !== undefined && p.closedAt <= c.timestamp) {
        runningEquity += p.pnl ?? 0;
        open.splice(i, 1);
      }
    }
    // Mark-to-market remaining open positions at this bar's close.
    let unrealized = 0;
    for (const p of open) {
      const dir = p.side === 'buy' ? 1 : -1;
      unrealized += (c.close - p.entryPrice) * p.quantity * dir;
    }
    const mtmEquity = runningEquity + unrealized;
    if (mtmEquity > peakEquity) peakEquity = mtmEquity;
    if (peakEquity > 0) {
      const dd = (peakEquity - mtmEquity) / peakEquity;
      if (dd > maxDd) maxDd = dd;
    }
  }
  return maxDd;
}

function metricsForSubset(
  subset: ReadonlyArray<Position>,
  candles: ReadonlyArray<Candle>,
  barsTotal: number,
  ambiguousTrades: number,
): CellMetrics {
  const totalTrades = subset.length;
  const winners = subset.filter((t) => (t.pnl ?? 0) > 0).length;
  const losers = totalTrades - winners;
  const winRate = totalTrades > 0 ? winners / totalTrades : 0;
  const totalPnlUsd = subset.reduce((s, t) => s + (t.pnl ?? 0), 0);

  // Per-trade R reconstructed from the position's own (entry, stop, exit)
  // fills. The runner's `tradeRs` array already used the entry-bar stop
  // (`runner.ts:513`) and the slippage-adjusted exit fill — those are now
  // stamped onto `pos.entryPrice` / `pos.exitPrice`, so reading them off the
  // closed Position reproduces the same R series.
  const tradeRs = subset.map((t) => {
    const stopDistance = Math.abs(t.entryPrice - t.stopLoss);
    if (stopDistance === 0) return 0;
    const dir = t.side === 'buy' ? 1 : -1;
    return ((t.exitPrice ?? t.entryPrice) - t.entryPrice) * dir / stopDistance;
  });

  const expectancy = tradeRs.length > 0
    ? tradeRs.reduce((s, r) => s + r, 0) / tradeRs.length
    : 0;
  const barsInMarket = subset.reduce((s, t) => s + (t.barsHeld ?? 0), 0);
  const timeInMarketPct = barsTotal > 0 ? barsInMarket / barsTotal : 0;

  return {
    totalTrades,
    winners,
    losers,
    winRate,
    expectancy,
    profitFactor: profitFactorFromTrades(subset),
    sharpeRatio: perTradeRSharpe(tradeRs),
    maxDrawdownR: maxDrawdownR(tradeRs),
    maxDrawdownPct: maxDrawdownPctFromTrades(subset, candles, INITIAL_EQUITY_USD),
    totalPnlUsd,
    barsInMarket,
    barsTotal,
    timeInMarketPct,
    ambiguousTrades,
  };
}

/**
 * `'all'` row uses the runner's own outputs verbatim where they exist
 * (totalPnl / sharpeRatio / maxDrawdown — all annualized / mtm-bar based).
 * Side rows (`'long'` / `'short'`) recompute on the trade subset using the
 * formulas documented above — see `perTradeRSharpe` and
 * `maxDrawdownPctFromTrades` for the side-subset definitions.
 */
function rowsForCell(
  cell: Cell,
  symbol: string,
  result: BacktestResult,
  candles: ReadonlyArray<Candle>,
): RankingRow[] {
  const trades = result.trades;
  const barsTotal = candles.filter(
    (c) => c.timestamp >= cell.windowStartMs && c.timestamp <= cell.windowEndMs,
  ).length;
  const longs = trades.filter((t) => t.side === 'buy');
  const shorts = trades.filter((t) => t.side === 'sell');

  // 'all' row — direct from runner output, with the cumulative-R drawdown
  // computed from the runner's tradeRs so all three rows share the same
  // R-space drawdown definition.
  const allRow: RankingRow = {
    strategyType: cell.strategyType,
    timeframe: cell.timeframe,
    symbol,
    side: 'all',
    windowOverride: cell.windowOverride,
    totalTrades: result.totalTrades,
    winners: result.winners,
    losers: result.losers,
    winRate: result.winRate,
    expectancy: result.expectancy,
    profitFactor: Number.isFinite(result.profitFactor) ? result.profitFactor : 0,
    sharpeRatio: result.sharpeRatio,
    maxDrawdownR: maxDrawdownR(result.tradeRs),
    maxDrawdownPct: result.maxDrawdown,
    totalPnlUsd: result.totalPnl,
    barsInMarket: trades.reduce((s, t) => s + (t.barsHeld ?? 0), 0),
    barsTotal,
    timeInMarketPct: barsTotal > 0
      ? trades.reduce((s, t) => s + (t.barsHeld ?? 0), 0) / barsTotal
      : 0,
    ambiguousTrades: result.ambiguousTrades,
  };

  const longRow: RankingRow = {
    strategyType: cell.strategyType,
    timeframe: cell.timeframe,
    symbol,
    side: 'long',
    windowOverride: cell.windowOverride,
    ...metricsForSubset(longs, candles, barsTotal, 0),
  };
  // Side-filtered subsets don't carry the runner's ambiguousTrades count
  // (which is global across both sides). Set to 0 — the 'all' row is the
  // canonical place to read it.
  longRow.profitFactor = Number.isFinite(longRow.profitFactor) ? longRow.profitFactor : 0;

  const shortRow: RankingRow = {
    strategyType: cell.strategyType,
    timeframe: cell.timeframe,
    symbol,
    side: 'short',
    windowOverride: cell.windowOverride,
    ...metricsForSubset(shorts, candles, barsTotal, 0),
  };
  shortRow.profitFactor = Number.isFinite(shortRow.profitFactor) ? shortRow.profitFactor : 0;

  return [allRow, longRow, shortRow];
}

async function loadCandles(cell: Cell, symbol: string): Promise<Candle[]> {
  switch (cell.source) {
    case 'coinbase-4h':
      return loadOrFetch4hBars(symbol, cell.windowStartMs, cell.windowEndMs);
    case 'yahoo-1d':
      return loadOrFetchDailyBars(symbol, cell.windowStartMs, cell.windowEndMs);
    case 'coinbase-1m':
      return loadOrFetch1mBars(symbol, cell.windowStartMs, cell.windowEndMs);
  }
}

async function main() {
  const startedAt = Date.now();
  console.log(`[tra306] sweep starting — window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ${new Date(WINDOW_END_MS).toISOString().slice(0, 10)}, symbols=${SYMBOLS.join(',')}`);
  console.log(`[tra306] cells: ${CELLS.length} strategies × ${SYMBOLS.length} symbols = ${CELLS.length * SYMBOLS.length} cells`);
  console.log(`[tra306] caveat: 6 router/legacy strategies tick at 1m live but are evaluated at 4H here (12-month 1m sweep is infeasible). Scalping uses a 30-day 1m window override (${SCALPING_WINDOW_TAG}).`);

  mkdirSync(REPORT_DIR, { recursive: true });

  const runner = new BacktestRunner();
  const ranking: RankingRow[] = [];
  const tradesByKey: Record<string, Position[]> = {};

  for (const cell of CELLS) {
    for (const symbol of SYMBOLS) {
      const cellStart = Date.now();
      const candles = await loadCandles(cell, symbol);
      const opts = cell.configFor(symbol);
      const config: BacktestConfig = {
        symbol,
        startDate: cell.windowStartMs,
        endDate: cell.windowEndMs,
        initialEquity: INITIAL_EQUITY_USD,
        strategyType: cell.strategyType,
        costModel: COST_MODEL,
        fractionalQuantity: true,
        ...opts,
      };
      const result = await runner.run(config, candles);
      const rows = rowsForCell(cell, symbol, result, candles);
      ranking.push(...rows);
      tradesByKey[`${cell.strategyType}_${symbol}`] = result.trades;

      const elapsedSec = (Date.now() - cellStart) / 1000;
      const allRow = rows[0];
      const dd = allRow.maxDrawdownR;
      const ddPct = allRow.maxDrawdownPct;
      const pf = allRow.profitFactor;
      const exp = allRow.expectancy;
      const sh = allRow.sharpeRatio;
      console.log(
        `[tra306] ${cell.strategyType} ${cell.timeframe} ${symbol}: ` +
        `${allRow.totalTrades} trades, ` +
        `expectancy=${(exp >= 0 ? '+' : '') + exp.toFixed(2)}R, ` +
        `PF=${pf.toFixed(2)}, ` +
        `Sharpe=${sh.toFixed(2)}, ` +
        `DD=${dd.toFixed(1)}R / ${(ddPct * 100).toFixed(1)}% ` +
        `(${elapsedSec.toFixed(1)}s)`,
      );
    }
  }

  const rankingPath = resolve(REPORT_DIR, 'tra306-strategy-ranking.json');
  writeFileSync(rankingPath, JSON.stringify({
    generatedAt: new Date().toISOString(),
    windowStart: new Date(WINDOW_START_MS).toISOString().slice(0, 10),
    windowEnd: new Date(WINDOW_END_MS).toISOString().slice(0, 10),
    initialEquityUsd: INITIAL_EQUITY_USD,
    // TRA-2033 — per-symbol tiered cost (round-trip bps by liquidity tier)
    // from the shared TRA-185 model, replacing the old flat 40+5 bps copy.
    costModel: 'cryptoTieredCostModel (TRA-185)',
    costBySymbol: Object.fromEntries(
      SYMBOLS.map((symbol) => {
        const fill = COST_MODEL.resolve(symbol);
        return [symbol, {
          tier: cryptoTierOf(symbol),
          commissionBps: fill.commissionBps,
          slippageBps: fill.slippageBps,
          roundTripBps: 2 * (fill.commissionBps + fill.slippageBps),
        }];
      }),
    ),
    caveats: {
      timeframeBoundary:
        '6 router/legacy strategies (momentum/breakout_vol/mean_reversion/reversal/macd_trend/bb_fade) ' +
        'tick at 1m bars in the live engine but are evaluated at 4H here. 4H matches the timeframe at ' +
        'which their indicator parameters were calibrated for crypto and we already have validated ' +
        'tooling for it (TRA-261 / TRA-267 / TRA-297). 12-month 1m sweep is infeasible (525,600 bars × ' +
        'O(N²) runner).',
      scalpingWindow:
        `Scalping evaluated on a single 30-day window (${SCALPING_WINDOW_TAG}) at 1m bars instead of ` +
        'the full 12 months — flagged via `windowOverride` on the per-row output.',
      shortGatesNotApplied:
        'Live applyShortGates / BTC-regime / funding overlay (crypto-engine.ts) is intentionally not ' +
        'applied — this sweep evaluates per-strategy raw edge per side, not the live filtering stack.',
    },
    results: ranking,
  }, null, 2));
  console.log(`\n[tra306] ranking JSON written: ${rankingPath} (${ranking.length} rows)`);

  const tradesPath = resolve(REPORT_DIR, 'tra306-trades.json');
  writeFileSync(tradesPath, JSON.stringify(tradesByKey, null, 2));
  const totalTrades = Object.values(tradesByKey).reduce((s, t) => s + t.length, 0);
  console.log(`[tra306] trades JSON written: ${tradesPath} (${totalTrades} trades across ${Object.keys(tradesByKey).length} strategy_symbol keys)`);

  const totalSec = (Date.now() - startedAt) / 1000;
  console.log(`[tra306] done in ${totalSec.toFixed(1)}s`);

  // Surface zero-trade cells for the issue follow-up comment.
  const zeroCells = ranking
    .filter((r) => r.side === 'all' && r.totalTrades === 0)
    .map((r) => `${r.strategyType}/${r.symbol}`);
  if (zeroCells.length > 0) {
    console.log(`[tra306] zero-trade cells (${zeroCells.length}): ${zeroCells.join(', ')}`);
  } else {
    console.log('[tra306] every cell produced ≥ 1 trade');
  }
}

const invoked = process.argv[1] && /[\\/]run-tra306-sweep\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
