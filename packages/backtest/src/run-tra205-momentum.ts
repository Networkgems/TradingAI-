/**
 * TRA-205 acceptance harness — runs MomentumStrategy on a known trending
 * window of synthetic BTC-USD / ETH-USD hourly bars and reports trade count
 * + expectancy.
 *
 * "Done when" criteria from the TRA-205 ticket:
 *   - Non-degenerate trade count (i.e. > 0 — momentum should fire when its
 *     regime fires).
 *   - Positive expectancy on at least one of BTC-USD / ETH-USD over a known
 *     trending window.
 *
 * The script uses the deterministic `trendingCandles` generator (seeded
 * Mulberry32) so the published metrics are reproducible across CI runs.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra205-momentum.ts
 */

import { BacktestRunner } from './runner.js';
import { trendingCandles } from './synthetic.js';
import type { BacktestConfig, BacktestResult } from './types.js';

const BAR_INTERVAL_MIN = 60;
const TREND_BARS = 30 * 24; // 30 days of hourly bars per asset
const INITIAL_EQUITY = 25_000;

interface RunRow {
  symbol: string;
  trades: number;
  expectancy: number;
  winRate: number;
  totalPnl: number;
  sharpe: number;
  maxDD: number;
  profitFactor: number;
}

function summarize(result: BacktestResult): RunRow {
  return {
    symbol: result.config.symbol,
    trades: result.totalTrades,
    expectancy: result.expectancy,
    winRate: result.winRate,
    totalPnl: result.totalPnl,
    sharpe: result.sharpeRatio,
    maxDD: result.maxDrawdown,
    profitFactor: result.profitFactor,
  };
}

async function runOne(symbol: string, startPrice: number, seed: number): Promise<RunRow> {
  const candles = trendingCandles(TREND_BARS, symbol, 'up', startPrice, seed);
  // Re-stamp timestamps onto a real hourly grid — `trendingCandles` defaults
  // to 1-minute spacing which fights the runner's bar-interval inference.
  const HOUR_MS = BAR_INTERVAL_MIN * 60_000;
  for (let i = 0; i < candles.length; i++) {
    candles[i].timestamp = candles[0].timestamp + i * HOUR_MS;
  }

  const runner = new BacktestRunner();
  const config: BacktestConfig = {
    symbol,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    strategyType: 'momentum',
    momentumOpts: {
      // Crypto trends well on shorter MAs at hourly granularity; the spec
      // 50/200 default is tuned to daily bars.
      fastMaPeriod: 20,
      slowMaPeriod: 50,
      donchianPeriod: 20,
      atrStopMultiplier: 2,
      atrTpMultiplier: 4,
    },
    // Coinbase Advanced Trade taker fees are ~40 bps on retail tier.
    feeBps: { maker: 25, taker: 40 },
    slippageBps: 5,
    executionMode: 'market',
    fractionalQuantity: true,
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
  };

  const result = await runner.run(config, candles);
  return summarize(result);
}

async function main() {
  const rows = await Promise.all([
    runOne('BTC-USD', 30_000, 31),
    runOne('ETH-USD', 2_000, 53),
  ]);

  console.log('TRA-205 momentum acceptance run');
  console.log(`  bars/asset = ${TREND_BARS}, interval = ${BAR_INTERVAL_MIN}m, equity = $${INITIAL_EQUITY}`);
  console.log('');
  console.log('symbol  | trades | winRate | expectancy(R) | sharpe(ann) | maxDD%  | profitFactor | totalPnl');
  console.log('--------+--------+---------+---------------+-------------+---------+--------------+---------');
  for (const r of rows) {
    console.log(
      `${r.symbol.padEnd(7)} | ${String(r.trades).padStart(6)} | ` +
        `${(r.winRate * 100).toFixed(1).padStart(6)}% | ` +
        `${r.expectancy.toFixed(3).padStart(13)} | ` +
        `${r.sharpe.toFixed(3).padStart(11)} | ` +
        `${(r.maxDD * 100).toFixed(2).padStart(6)}% | ` +
        `${Number.isFinite(r.profitFactor) ? r.profitFactor.toFixed(3).padStart(12) : '         inf'} | ` +
        `$${r.totalPnl.toFixed(2)}`,
    );
  }

  console.log('');
  const anyNonDegenerate = rows.some((r) => r.trades > 0);
  const anyPositiveExpectancy = rows.some((r) => r.trades > 0 && r.expectancy > 0);
  console.log(`non-degenerate trade count on ≥1 asset: ${anyNonDegenerate}`);
  console.log(`positive expectancy on ≥1 asset:        ${anyPositiveExpectancy}`);

  if (!anyNonDegenerate) {
    console.error('FAIL: no asset produced trades.');
    process.exit(1);
  }
  if (!anyPositiveExpectancy) {
    console.error('FAIL: no asset produced positive expectancy.');
    process.exit(1);
  }
  console.log('PASS');
}

const invoked = process.argv[1] && /run-tra205-momentum\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch((err) => { console.error(err); process.exit(1); });
