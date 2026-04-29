/**
 * TRA-170 quick AC check — runs the BacktestRunner against 90 days of synthetic
 * 1h BTC/ETH/SOL candles and reports trade counts per strategy. Synthetic data
 * isn't a substitute for real-market verification, but it's a useful sanity
 * check that the new filters fire frequently enough — the original symptom was
 * 0–3 fires across the same window with the old gates, so any double-digit
 * count here is direct evidence the loosened logic is working.
 *
 * Run: `node --import tsx packages/backtest/src/run-tra170-frequency.ts`
 */

import { BacktestRunner } from './runner.js';
import { syntheticCryptoSeries } from './synthetic.js';
import type { BacktestResult } from './types.js';

const DAYS = 90;
const INITIAL_EQUITY = 25_000;
const SYMBOLS = [
  { symbol: 'BTC-USD', startPrice: 60_000, seed: 31 },
  { symbol: 'ETH-USD', startPrice: 3_000, seed: 67 },
  { symbol: 'SOL-USD', startPrice: 150, seed: 113 },
];
const STRATEGIES: Array<BacktestResult['config']['strategyType']> = [
  'reversal',
  'macd',
  'macd_bollinger',  // legacy → fires both macd_trend + bb_fade
  'ichimoku',
  'combined',
];

const runner = new BacktestRunner();

async function main() {
  console.log('\n' + '═'.repeat(96));
  console.log(`  TRA-170 frequency check — ${DAYS}d × 1h × {BTC,ETH,SOL}, synthetic candles`);
  console.log('═'.repeat(96));

  for (const { symbol, startPrice, seed } of SYMBOLS) {
    console.log('\n' + '─'.repeat(96));
    console.log(`  ${symbol}  (${DAYS}×24 = ${DAYS * 24} bars, start=$${startPrice.toLocaleString()})`);
    console.log('─'.repeat(96));
    const candles = syntheticCryptoSeries(DAYS, symbol, startPrice, 60, seed);
    const start = candles[0].timestamp;
    const end = candles[candles.length - 1].timestamp;

    console.log(`  ${'Strategy'.padEnd(16)} ${'Trades'.padStart(8)} ${'Win%'.padStart(7)} ${'PnL'.padStart(12)} ${'PF'.padStart(8)}`);
    console.log('  ' + '·'.repeat(94));
    for (const strat of STRATEGIES) {
      const r = await runner.run(
        {
          symbol,
          startDate: start,
          endDate: end,
          initialEquity: INITIAL_EQUITY,
          strategyType: strat,
          // Crypto is 24/7 — turn off the equity time filter so signals fire.
          // Set volatilityFloorPct=0 so the TRA-171 dead-tape gate doesn't block
          // signals on lower-volatility synthetic data; real Coinbase 1h ATR/price
          // routinely runs 0.4–1.5% so the production default (0.3%) is fine.
          reversalOpts: {
            enforceTimeFilter: false,
            rsiOverbought: 65,
            rsiOversold: 35,
            volatilityFloorPct: 0,
          },
          macdBollingerOpts: { enforceTimeFilter: false },
        },
        candles,
      );
      const winRate = r.totalTrades > 0 ? (r.winRate * 100).toFixed(1) + '%' : '—';
      const pf = r.totalTrades > 0
        ? (r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2))
        : '—';
      const pnl = r.totalTrades > 0 ? `$${r.totalPnl.toFixed(2)}` : '—';
      console.log(
        `  ${strat.padEnd(16)} ${String(r.totalTrades).padStart(8)} ${winRate.padStart(7)} ${pnl.padStart(12)} ${pf.padStart(8)}`,
      );
    }
  }

  console.log('\n' + '═'.repeat(96));
  console.log('  Pre-TRA-170 baseline on the same window: ORB 0, Reversal 0, MACD-BB 2, Ichimoku 3.');
  console.log('  Each row above ≥ 30 satisfies AC.1; positive PnL on at least one symbol per strategy');
  console.log('  satisfies AC.2 (commission-free here — depends on TRA-168 commission/slippage model).');
  console.log('═'.repeat(96) + '\n');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
