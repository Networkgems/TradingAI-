/**
 * TRA-203 walk-forward demo. Runs the reversal strategy on 1y of synthetic
 * hourly BTC bars with realistic taker fees + slippage and prints per-window
 * Sharpe, max drawdown, and expectancy.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra203-walk-forward.ts
 */

import { walkForward } from './walk-forward.js';
import { syntheticCryptoSeries } from './synthetic.js';
import type { BacktestConfig } from './types.js';

const SYMBOL = 'BTC-USD';
const DAYS = 365;
const BAR_INTERVAL_MIN = 60;
const BARS_PER_DAY = Math.floor((24 * 60) / BAR_INTERVAL_MIN);
const INITIAL_EQUITY = 25_000;

async function main() {
  const candles = syntheticCryptoSeries(DAYS, SYMBOL, 30_000, BAR_INTERVAL_MIN, 31);
  console.log(
    `Generated ${candles.length} ${BAR_INTERVAL_MIN}-min candles for ${SYMBOL} ` +
      `(${DAYS} days).`,
  );

  const config: BacktestConfig = {
    symbol: SYMBOL,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    // macd_bollinger fires reliably on the synthetic regime stitch — gives a
    // visible trade count for the per-window metrics. Reversal alone would
    // print mostly zeros at this volume profile.
    strategyType: 'macd_bollinger',
    macdBollingerOpts: { bbPeriod: 20, volumeMultiplier: 1.5, enforceTimeFilter: false },
    // Coinbase Advanced Trade taker ≈ 40 bps; market entries pay it twice.
    feeBps: { maker: 25, taker: 40 },
    slippageBps: 5,
    executionMode: 'market',
    portfolioOpts: { maxOpenPositions: 3, maxSectorExposure: 3 },
  };

  const trainBars = 90 * BARS_PER_DAY;
  const testBars = 30 * BARS_PER_DAY;
  const stepBars = testBars;

  const report = await walkForward(config, candles, { trainBars, testBars, stepBars });
  console.log(
    `Walk-forward: train=${trainBars} bars (${trainBars / BARS_PER_DAY}d), ` +
      `test=${testBars} bars (${testBars / BARS_PER_DAY}d), ` +
      `windows=${report.windows.length}`,
  );
  console.log('');
  console.log(
    'window | trades | winRate | sharpe(ann) | maxDD%  | expectancy(R) | totalPnl'
      + '  | barIntervalMin',
  );
  console.log('-------+--------+---------+-------------+---------+---------------+----------+----------------');
  report.windows.forEach((r, i) => {
    const barMin = r.barIntervalMs ? r.barIntervalMs / 60_000 : null;
    console.log(
      `${String(i).padStart(6)} | ${String(r.totalTrades).padStart(6)} | ` +
        `${(r.winRate * 100).toFixed(1).padStart(6)}% | ` +
        `${r.sharpeRatio.toFixed(3).padStart(11)} | ` +
        `${(r.maxDrawdown * 100).toFixed(2).padStart(6)}% | ` +
        `${r.expectancy.toFixed(3).padStart(13)} | ` +
        `$${r.totalPnl.toFixed(2).padStart(8)} | ` +
        `${barMin ? barMin.toFixed(0).padStart(14) : '   (n/a)      '}`,
    );
  });
  console.log('');
  console.log('AGGREGATE (concatenated test slices):');
  const agg = report.aggregate;
  console.log(`  trades       = ${agg.totalTrades}`);
  console.log(`  winRate      = ${(agg.winRate * 100).toFixed(2)}%`);
  console.log(`  sharpe (ann) = ${agg.sharpeRatio.toFixed(4)}`);
  console.log(`  maxDrawdown  = ${(agg.maxDrawdown * 100).toFixed(2)}%`);
  console.log(`  expectancy   = ${agg.expectancy.toFixed(4)}R`);
  console.log(`  totalPnl     = $${agg.totalPnl.toFixed(2)}`);
  console.log(`  worstCasePnl = $${agg.worstCaseTotalPnl.toFixed(2)}`);
  console.log(`  profitFactor = ${agg.profitFactor.toFixed(3)}`);
}

const invoked = process.argv[1] && /run-tra203-walk-forward\.(ts|js)$/.test(process.argv[1]);
if (invoked) main().catch(err => { console.error(err); process.exit(1); });
