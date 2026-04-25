/**
 * Crypto backtesting script — run all 4 strategies on BTC-USD, ETH-USD, SOL-USD.
 *
 * Usage:
 *   node --import tsx/esm packages/server/src/backtest-crypto.ts
 *
 * Data: uses Yahoo Finance 1h candles for 90 days (Yahoo Finance limits 1m data to ~7 days;
 * hourly data provides a statistically richer sample with 2,160 bars per asset).
 *
 * ORB crypto adaptation: uses midnight UTC as the session open reference. rangeMinutes=60 so
 * the first 1h candle of each UTC day forms the opening range.
 */

import YahooFinance from 'yahoo-finance2';
import type { Candle } from '@trading-app/shared';
import { BacktestRunner } from '@trading-app/backtest';
import type { BacktestConfig } from '@trading-app/backtest';

const yf = new YahooFinance({ validation: { logErrors: false } });

const SYMBOLS = ['BTC-USD', 'ETH-USD', 'SOL-USD'];
const INITIAL_EQUITY = 100_000;
const DAYS = 90;

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
}

async function runBacktest(
  symbol: string,
  candles: Candle[],
  strategyType: BacktestConfig['strategyType'],
  label: string,
  opts: Partial<BacktestConfig> = {},
): Promise<StrategyResult> {
  if (candles.length === 0) {
    return { symbol, strategy: label, trades: 0, winRate: 0, avgRR: 0, totalPnl: 0, returnPct: 0 };
  }

  const runner = new BacktestRunner();
  const config: BacktestConfig = {
    symbol,
    startDate: candles[0].timestamp,
    endDate: candles[candles.length - 1].timestamp,
    initialEquity: INITIAL_EQUITY,
    strategyType,
    ...opts,
  };

  const result = await runner.run(config, candles);
  return {
    symbol,
    strategy: label,
    trades: result.trades.length,
    winRate: result.winRate,
    avgRR: result.avgRiskReward,
    totalPnl: result.totalPnl,
    returnPct: (result.totalPnl / INITIAL_EQUITY) * 100,
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

    // 1. ORB — adapted for crypto: rangeMinutes=60 (first 1h candle), minVolume=1 (crypto volumes differ)
    results.push(await runBacktest(sym, candles, 'orb', 'ORB (crypto 1h)'));

    // 2. Reversal — stock defaults (RSI 70/30), then crypto-tuned (RSI 60/40)
    results.push(await runBacktest(sym, candles, 'reversal', 'Reversal (stock params)'));
    results.push(await runBacktest(sym, candles, 'reversal', 'Reversal (crypto 60/40)', {
      reversalOpts: { rsiOverbought: 60, rsiOversold: 40 },
    }));

    // 3. MACD-Bollinger — stock defaults, then crypto-tuned (smaller BB period for faster crypto)
    results.push(await runBacktest(sym, candles, 'macd_bollinger', 'MACD-BB (stock params)'));
    results.push(await runBacktest(sym, candles, 'macd_bollinger', 'MACD-BB (crypto tuned)', {
      macdBollingerOpts: { bbPeriod: 14, bbMultiplier: 2.5, volumeMultiplier: 1.2 },
    }));

    // 4. Ichimoku — no configurable params; test as-is
    results.push(await runBacktest(sym, candles, 'ichimoku', 'Ichimoku'));
  }

  printTable(results);

  // Summary by strategy (average across all symbols)
  const strategies = [...new Set(results.map(r => r.strategy))];
  console.log('\nAGGREGATE BY STRATEGY (avg across BTC/ETH/SOL)');
  console.log('-'.repeat(80));
  for (const strat of strategies) {
    const group = results.filter(r => r.strategy === strat);
    const avgWin = group.reduce((s, r) => s + r.winRate, 0) / group.length;
    const avgRet = group.reduce((s, r) => s + r.returnPct, 0) / group.length;
    const totalTrades = group.reduce((s, r) => s + r.trades, 0);
    const avgRR = group.reduce((s, r) => s + r.avgRR, 0) / group.length;
    console.log(
      `  ${strat.padEnd(25)}  trades=${totalTrades}  winRate=${(avgWin * 100).toFixed(1)}%  avgRR=${avgRR.toFixed(2)}  return=${avgRet.toFixed(2)}%`
    );
  }
  console.log();

  // Output JSON-serializable results for further use
  const output = { timestamp: new Date().toISOString(), results };
  console.log('\nJSON_RESULTS_START');
  console.log(JSON.stringify(output));
  console.log('JSON_RESULTS_END');
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});
