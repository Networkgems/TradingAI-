/**
 * Crypto backtesting script — exercises every BacktestRunner strategy on
 * BTC-USD, ETH-USD, SOL-USD using 90 days of Yahoo Finance 1h candles
 * (~2,160 bars/asset; 1m data is capped to ~7 days by Yahoo and would not
 * give a statistically meaningful sample).
 *
 * Usage:
 *   node --import tsx/esm packages/server/src/backtest-crypto.ts            # default: with costs
 *   node --import tsx/esm packages/server/src/backtest-crypto.ts --no-cost  # zero out commission/slippage for A/B sanity
 *
 * Cost model (TRA-169):
 *   - commissionBps = 40 → Coinbase Advanced Trade taker fees (~0.4% per fill, ~0.8% round-trip).
 *   - slippageBps   = 5  → conservative for top-tier coins on 1h bars.
 *   `--no-cost` disables both, mirroring the pre-TRA-169 behaviour for direct comparison.
 *
 * Crypto-aware ORB anchor (TRA-180):
 *   - timeFilter = isValidCryptoTradingWindow (24/7) — without this the equity-session
 *     defaults block every crypto bar and ORB returns 0 trades.
 *   - sessionAnchorTimestampOf = UTC-midnight bucket — the first 1h candle of each
 *     UTC day forms the opening range (rangeMinutes = 60).
 *
 * Output:
 *   - Per-symbol/per-strategy table with trade count, win rate, avg R:R, PnL, return %.
 *   - Aggregate summary including 1R signal-edge hit rate and the worst-case (pessimistic
 *     ambiguous-fill) return %, both surfaced from BacktestResult per TRA-169.
 *   - JSON tail bracketed by JSON_RESULTS_START / JSON_RESULTS_END for downstream tooling.
 */

import YahooFinance from 'yahoo-finance2';
import { isValidCryptoTradingWindow, type Candle } from '@trading-app/shared';
import { BacktestRunner } from '@trading-app/backtest';
import type { BacktestConfig } from '@trading-app/backtest';

const yf = new YahooFinance({ validation: { logErrors: false } });

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
export const INITIAL_EQUITY = 100_000;
const DAYS = 90;
// Coinbase Advanced Trade taker fees ≈ 40 bps per fill (round-trip ≈ 0.8 %).
// Slippage of 5 bps is conservative for top-tier coins on hourly bars.
export const COMMISSION_BPS = 40;
export const SLIPPAGE_BPS = 5;
// 24/7 ORB anchor: each UTC midnight starts a new "session" so the first 1h
// candle of every UTC day forms the opening range.
export const cryptoSessionAnchor = (latest: Candle): number => {
  const d = new Date(latest.timestamp);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

/** A single labelled strategy run that the comprehensive script exercises per symbol. */
export interface StrategyRun {
  strategyType: BacktestConfig['strategyType'];
  label: string;
  /** Strategy/runner overrides on top of the shared (symbol, costs, dates) base. */
  opts: Partial<BacktestConfig>;
}

/**
 * Strategy plan executed for every symbol. Symbol-independent so the smoke
 * test can introspect coverage without faking a Yahoo response.
 *
 * macd_bollinger triggers BOTH MacdTrendStrategy and BbFadeStrategy in the
 * runner (TRA-170 split), so the seven distinct backtestable classes — orb,
 * reversal, macd_trend, bb_fade, ichimoku, scalping, swing — are all covered.
 */
export const STRATEGY_PLAN: readonly StrategyRun[] = [
  {
    strategyType: 'orb',
    label: 'ORB (crypto 1h)',
    opts: {
      orbOpts: {
        timeFilter: isValidCryptoTradingWindow,
        sessionAnchorTimestampOf: cryptoSessionAnchor,
        rangeMinutes: 60,
        minVolume: 1,
      },
    },
  },
  {
    strategyType: 'reversal',
    label: 'Reversal (stock params)',
    opts: { reversalOpts: { enforceTimeFilter: false } },
  },
  {
    strategyType: 'reversal',
    label: 'Reversal (crypto 60/40)',
    opts: {
      reversalOpts: { rsiOverbought: 60, rsiOversold: 40, enforceTimeFilter: false },
    },
  },
  {
    strategyType: 'macd_bollinger',
    label: 'MACD-BB (stock params)',
    opts: { macdBollingerOpts: { enforceTimeFilter: false } },
  },
  {
    strategyType: 'macd_bollinger',
    label: 'MACD-BB (crypto tuned)',
    opts: {
      macdBollingerOpts: {
        bbPeriod: 14,
        bbMultiplier: 2.5,
        volumeMultiplier: 1.2,
        enforceTimeFilter: false,
      },
    },
  },
  { strategyType: 'ichimoku', label: 'Ichimoku', opts: {} },
  {
    strategyType: 'scalping',
    label: 'Scalping (crypto)',
    opts: { scalpingOpts: { enforceTimeFilter: false } },
  },
  { strategyType: 'swing', label: 'Swing', opts: {} },
] as const;

/** Bps applied per fill, before/after `--no-cost` adjustment. */
export interface CostMode {
  commissionBps: number;
  slippageBps: number;
}

export function effectiveCostBps(noCost: boolean): CostMode {
  return noCost
    ? { commissionBps: 0, slippageBps: 0 }
    : { commissionBps: COMMISSION_BPS, slippageBps: SLIPPAGE_BPS };
}

/**
 * Build the BacktestConfig the runner actually receives for one (symbol, run).
 * Exposed so the smoke test can assert costs round-trip into the config the
 * script feeds the runner.
 */
export function buildBacktestConfig(
  symbol: string,
  candles: Candle[],
  run: StrategyRun,
  cost: CostMode,
): BacktestConfig {
  return {
    symbol,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    strategyType: run.strategyType,
    commissionBps: cost.commissionBps,
    slippageBps: cost.slippageBps,
    ...run.opts,
  };
}

async function fetchHistoricalCandles(symbol: string, days: number): Promise<Candle[]> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

  try {
    // Use 1h interval — Yahoo Finance supports up to 730 days of hourly data.
    // 1m interval is limited to ~7 days by Yahoo Finance.
    const result = await yf.chart(symbol, {
      period1: from,
      period2: now,
      interval: '1h',
    });

    const quotes = result.quotes ?? [];
    return quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
      .map(q => ({
        symbol,
        timestamp: new Date(q.date).getTime(),
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume!,
      }));
  } catch (err) {
    console.error(`Failed to fetch ${symbol}:`, err);
    return [];
  }
}

interface StrategyResult {
  symbol: string;
  strategy: string;
  trades: number;
  winRate: number;
  avgRR: number;
  totalPnl: number;
  returnPct: number;
  signalCount: number;
  signalHitRatePct: number;
  ambiguousTrades: number;
  worstCaseReturnPct: number;
}

export async function runBacktest(
  symbol: string,
  candles: Candle[],
  run: StrategyRun,
  cost: CostMode,
): Promise<StrategyResult> {
  if (candles.length === 0) {
    return {
      symbol, strategy: run.label, trades: 0, winRate: 0, avgRR: 0,
      totalPnl: 0, returnPct: 0, signalCount: 0, signalHitRatePct: 0,
      ambiguousTrades: 0, worstCaseReturnPct: 0,
    };
  }

  const runner = new BacktestRunner();
  const config = buildBacktestConfig(symbol, candles, run, cost);
  const result = await runner.run(config, candles);
  return {
    symbol,
    strategy: run.label,
    trades: result.trades.length,
    winRate: result.winRate,
    avgRR: result.avgRiskReward,
    totalPnl: result.totalPnl,
    returnPct: (result.totalPnl / INITIAL_EQUITY) * 100,
    signalCount: result.signalEdge?.totalSignals ?? 0,
    signalHitRatePct: result.signalEdge?.hitRatePct ?? 0,
    ambiguousTrades: result.ambiguousTrades ?? 0,
    worstCaseReturnPct: ((result.worstCaseTotalPnl ?? result.totalPnl) / INITIAL_EQUITY) * 100,
  };
}

function printTable(results: StrategyResult[]) {
  console.log('\n' + '='.repeat(100));
  console.log('CRYPTO BACKTEST RESULTS — 90 Days, 1h Candles, $100k Initial Equity');
  console.log('='.repeat(100));
  console.log(
    'Symbol'.padEnd(12) +
    'Strategy'.padEnd(20) +
    'Trades'.padStart(8) +
    'Win Rate'.padStart(12) +
    'Avg R:R'.padStart(10) +
    'Total PnL'.padStart(14) +
    'Return %'.padStart(12)
  );
  console.log('-'.repeat(100));
  for (const r of results) {
    const winRatePct = (r.winRate * 100).toFixed(1) + '%';
    const pnlStr = '$' + r.totalPnl.toFixed(2);
    const retStr = r.returnPct.toFixed(2) + '%';
    const rrStr = r.avgRR.toFixed(2);
    console.log(
      r.symbol.padEnd(12) +
      r.strategy.padEnd(20) +
      r.trades.toString().padStart(8) +
      winRatePct.padStart(12) +
      rrStr.padStart(10) +
      pnlStr.padStart(14) +
      retStr.padStart(12)
    );
  }
  console.log('='.repeat(100));
}

async function main() {
  // Pass `--no-cost` to zero out commission/slippage for an A/B sanity check
  // against the pre-TRA-169 behaviour. Defaults to false (costs ON).
  const noCost = process.argv.includes('--no-cost');
  const cost = effectiveCostBps(noCost);

  console.log(`Fetching ${DAYS}-day 1h historical data for: ${SYMBOLS.join(', ')}...`);

  const candleMap = new Map<string, Candle[]>();
  for (const sym of SYMBOLS) {
    process.stdout.write(`  ${sym}... `);
    const candles = await fetchHistoricalCandles(sym, DAYS);
    candleMap.set(sym, candles);
    console.log(`${candles.length} bars`);
  }

  const results: StrategyResult[] = [];
  for (const sym of SYMBOLS) {
    const candles = candleMap.get(sym) ?? [];
    for (const run of STRATEGY_PLAN) {
      results.push(await runBacktest(sym, candles, run, cost));
    }
  }

  printTable(results);

  // Summary by strategy (average across all symbols)
  const strategies = [...new Set(results.map(r => r.strategy))];
  const costLabel = noCost
    ? 'cost-free baseline (--no-cost)'
    : `net of ${COMMISSION_BPS} bps commission + ${SLIPPAGE_BPS} bps slippage`;
  console.log(`\nAGGREGATE BY STRATEGY (avg across BTC/ETH/SOL — ${costLabel})`);
  console.log('-'.repeat(110));
  for (const strat of strategies) {
    const group = results.filter(r => r.strategy === strat);
    const avgWin = group.reduce((s, r) => s + r.winRate, 0) / group.length;
    const avgRet = group.reduce((s, r) => s + r.returnPct, 0) / group.length;
    const worstRet = group.reduce((s, r) => s + r.worstCaseReturnPct, 0) / group.length;
    const totalTrades = group.reduce((s, r) => s + r.trades, 0);
    const totalSignals = group.reduce((s, r) => s + r.signalCount, 0);
    const avgHitRate = totalSignals > 0
      ? group.reduce((s, r) => s + r.signalHitRatePct * r.signalCount, 0) / totalSignals
      : 0;
    const avgRR = group.reduce((s, r) => s + r.avgRR, 0) / group.length;
    const totalAmbig = group.reduce((s, r) => s + r.ambiguousTrades, 0);
    console.log(
      `  ${strat.padEnd(25)}  trades=${totalTrades}  signals=${totalSignals}  ` +
      `winRate=${(avgWin * 100).toFixed(1)}%  hit1R=${avgHitRate.toFixed(1)}%  ` +
      `avgRR=${avgRR.toFixed(2)}  return=${avgRet.toFixed(2)}%  ` +
      `worstCase=${worstRet.toFixed(2)}%  ambig=${totalAmbig}`
    );
  }
  console.log();

  // Output JSON-serializable results for further use
  const output = { timestamp: new Date().toISOString(), results };
  console.log('\nJSON_RESULTS_START');
  console.log(JSON.stringify(output));
  console.log('JSON_RESULTS_END');
}

// Only run when invoked as a script — keeps the smoke test (which imports
// STRATEGY_PLAN / buildBacktestConfig) from kicking off a Yahoo fetch.
const invokedAsScript = (() => {
  const entry = process.argv[1];
  if (!entry) return false;
  // tsx and node both expose argv[1] as a path with platform-native separators.
  return entry.replace(/\\/g, '/').endsWith('/backtest-crypto.ts')
      || entry.replace(/\\/g, '/').endsWith('/backtest-crypto.js');
})();
if (invokedAsScript) {
  main().catch(err => {
    console.error('Backtest failed:', err);
    process.exit(1);
  });
}
