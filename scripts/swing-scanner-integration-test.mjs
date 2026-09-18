/**
 * TRA-4625 — Integration test for swing signal scanners with live Tradier data
 *
 * Tests all three scanners (post-earnings, momentum breakout, panic reversal)
 * and the signal fusion engine against real market data.
 *
 * Usage:
 *   TRADIER_API_TOKEN=... node scripts/swing-scanner-integration-test.mjs
 *
 * Options:
 *   --symbols=AAPL,NVDA,TSLA   Comma-separated symbols to test (default: test set)
 *   --scanner=panic|momentum|earnings|fusion  Run specific scanner only
 *   --verbose                   Print detailed output
 */

import { TradierOptionsClient, TradierStocksClient } from '../packages/engine/dist/index.js';
import { scanPanicReversal } from '../packages/server/dist/panic-reversal-scanner.js';
import { scanMomentumBreakoutIvLag } from '../packages/server/dist/momentum-breakout-iv-lag-scanner.js';
import { scanPostEarningsIvCrush } from '../packages/server/dist/post-earnings-iv-crush-scanner.js';
import { scanAndRankSwingSignals } from '../packages/server/dist/swing-signal-fusion.js';

// Test symbols with different market characteristics
const DEFAULT_TEST_SYMBOLS = [
  'AAPL', // Large cap, liquid options
  'NVDA', // High momentum
  'TSLA', // High volatility
  'SPY',  // Index ETF
  'QQQ',  // Tech ETF
];

// Symbols known to have recent earnings (update as needed)
const POST_EARNINGS_CANDIDATES = [
  'NVDA', // Often has big earnings moves
  'TSLA', // High volatility post-earnings
];

const args = process.argv.slice(2);
const symbols = args.find(a => a.startsWith('--symbols='))?.split('=')[1]?.split(',') ?? DEFAULT_TEST_SYMBOLS;
const scannerFilter = args.find(a => a.startsWith('--scanner='))?.split('=')[1];
const verbose = args.includes('--verbose');

const apiToken = process.env.TRADIER_API_TOKEN;
const accountId = process.env.TRADIER_ACCOUNT_ID;
if (!apiToken) {
  console.error('❌ TRADIER_API_TOKEN environment variable required');
  process.exit(1);
}
if (!accountId) {
  console.error('❌ TRADIER_ACCOUNT_ID environment variable required');
  process.exit(1);
}

const env = process.env.TRADIER_ENV === 'production' ? 'production' : 'sandbox';
const optionsClient = new TradierOptionsClient(apiToken, accountId, env);
const stocksClient = new TradierStocksClient(apiToken, env);

console.log(`\n🧪 TRA-4625 — Swing Scanner Integration Test`);
console.log(`Environment: ${env}`);
console.log(`Symbols: ${symbols.join(', ')}`);
console.log(`Scanner filter: ${scannerFilter ?? 'all'}\n`);

const results = {
  panic: { tested: 0, signals: 0, errors: 0 },
  momentum: { tested: 0, signals: 0, errors: 0 },
  earnings: { tested: 0, signals: 0, errors: 0 },
  fusion: { tested: 0, signals: 0, errors: 0 },
};

/**
 * Fetch market data for a symbol
 */
async function fetchMarketData(symbol) {
  try {
    // 1. Get stock quote
    const quotesMap = await stocksClient.getQuotes([symbol]);
    const quote = quotesMap.get(symbol);
    if (!quote) {
      throw new Error(`Failed to fetch quote for ${symbol}`);
    }
    const currentPrice = quote.price ?? 0;

    if (currentPrice === 0) {
      throw new Error(`No valid price for ${symbol}`);
    }

    // 2. Get historical candles (daily, ~120 trading days ≈ 6 months)
    const candles = await stocksClient.getDailyBars(symbol, 120);

    if (candles.length < 20) {
      throw new Error(`Insufficient candle data for ${symbol}: got ${candles.length} bars`);
    }

    // 3. Get option expirations
    const expirations = await optionsClient.getExpirations(symbol);
    if (expirations.length === 0) {
      throw new Error(`No option expirations for ${symbol}`);
    }

    // Target 25-60 DTE range
    const now = Date.now();
    const validExpirations = expirations.filter(exp => {
      const expMs = new Date(exp).getTime();
      const dte = (expMs - now) / (1000 * 60 * 60 * 24);
      return dte >= 20 && dte <= 70;
    });

    if (validExpirations.length === 0) {
      throw new Error(`No valid expirations in DTE range for ${symbol}`);
    }

    // Use first valid expiration
    const targetExpiration = validExpirations[0];

    // 4. Get option chain snapshot (with greeks and IV)
    const optionChain = await optionsClient.getChainSnapshot(symbol, targetExpiration);
    if (optionChain.length === 0) {
      throw new Error(`Empty option chain for ${symbol} exp ${targetExpiration}`);
    }

    // 5. Calculate derived metrics
    const avgVolume = candles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20;

    // Simple ATR calculation (last 14 bars)
    const atrPeriod = 14;
    const atr = candles.slice(-atrPeriod).reduce((sum, c, i, arr) => {
      if (i === 0) return 0;
      const tr = Math.max(
        c.high - c.low,
        Math.abs(c.high - arr[i - 1].close),
        Math.abs(c.low - arr[i - 1].close)
      );
      return sum + tr;
    }, 0) / atrPeriod;

    // Estimate IV percentile/rank (simplified - would need historical IV data for accuracy)
    const ivValues = optionChain.filter(o => o.midIv).map(o => o.midIv);
    const currentIv = ivValues.length > 0 ? ivValues.reduce((a, b) => a + b, 0) / ivValues.length : 0.30;
    const ivPercentile = 50; // Placeholder - would need historical IV
    const ivRank = 50; // Placeholder

    // Support/resistance (simple high/low from recent period)
    const lookback = candles.slice(-60);
    const resistanceLevel = Math.max(...lookback.map(c => c.high));
    const supportLevel = Math.min(...lookback.map(c => c.low));

    return {
      symbol,
      quote,
      currentPrice,
      candles,
      optionChain,
      avgVolume,
      atr,
      ivPercentile,
      ivRank,
      currentIv,
      resistanceLevel,
      supportLevel,
      targetExpiration,
    };
  } catch (err) {
    throw new Error(`Failed to fetch market data for ${symbol}: ${err.message}`);
  }
}

/**
 * Test Panic Reversal Scanner
 */
async function testPanicReversal(marketData) {
  const { symbol, candles, optionChain, ivRank, currentPrice, supportLevel, atr } = marketData;

  results.panic.tested++;

  try {
    const signal = scanPanicReversal({
      symbol,
      candles,
      optionChain,
      ivRank,
      currentPrice,
      supportLevel,
      atr,
    });

    if (signal) {
      results.panic.signals++;
      console.log(`\n✅ Panic Reversal Signal: ${symbol}`);
      if (verbose) {
        console.log(`   Option: ${signal.optionType} $${signal.strike} exp ${signal.expiration}`);
        console.log(`   Entry: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(3)}`);
        console.log(`   Decline: ${signal.recentDeclinePct.toFixed(1)}% | IV Rank: ${signal.ivRank}`);
        console.log(`   Reversal Score: ${signal.reversalScore.toFixed(0)}/100`);
        console.log(`   R:R: ${signal.riskRewardRatio.toFixed(2)}`);
      }
      return signal;
    } else {
      if (verbose) console.log(`   No panic reversal setup for ${symbol}`);
      return null;
    }
  } catch (err) {
    results.panic.errors++;
    console.error(`❌ Panic reversal error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Test Momentum Breakout Scanner
 */
async function testMomentumBreakout(marketData) {
  const { symbol, candles, optionChain, ivPercentile, currentPrice, avgVolume } = marketData;

  results.momentum.tested++;

  try {
    const signal = scanMomentumBreakoutIvLag({
      symbol,
      candles,
      optionChain,
      ivPercentile,
      currentPrice,
      avgVolume,
      relativeStrength: 80, // Placeholder
    });

    if (signal) {
      results.momentum.signals++;
      console.log(`\n✅ Momentum Breakout Signal: ${symbol}`);
      if (verbose) {
        console.log(`   Option: ${signal.optionType} $${signal.strike} exp ${signal.expiration}`);
        console.log(`   Entry: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(3)}`);
        console.log(`   Breakout Level: $${signal.breakoutLevel.toFixed(2)}`);
        console.log(`   Volume Ratio: ${signal.volumeRatio.toFixed(2)}x`);
        console.log(`   Momentum Score: ${signal.momentumScore.toFixed(0)}/100`);
        console.log(`   R:R: ${signal.riskRewardRatio.toFixed(2)}`);
      }
      return signal;
    } else {
      if (verbose) console.log(`   No momentum breakout setup for ${symbol}`);
      return null;
    }
  } catch (err) {
    results.momentum.errors++;
    console.error(`❌ Momentum breakout error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Test Post-Earnings IV Crush Scanner
 */
async function testPostEarnings(marketData) {
  const { symbol, candles, optionChain, ivPercentile, currentPrice, supportLevel, resistanceLevel } = marketData;

  // Only test on symbols likely to have recent earnings
  if (!POST_EARNINGS_CANDIDATES.includes(symbol)) {
    if (verbose) console.log(`   Skipping post-earnings test for ${symbol} (not in earnings candidates)`);
    return null;
  }

  results.earnings.tested++;

  try {
    // Estimate earnings date (would need real earnings calendar)
    const earningsDate = new Date();
    earningsDate.setDate(earningsDate.getDate() - 3); // Assume earnings 3 days ago

    const signal = scanPostEarningsIvCrush({
      symbol,
      candles,
      optionChain,
      ivPercentile,
      ivPercentilePriorToEarnings: 80, // Placeholder
      earningsDate,
      currentPrice,
      openingPriceOnEarningsDay: currentPrice * 1.05, // Placeholder gap
      relativeStrength: 75, // Placeholder
      resistanceLevel,
      supportLevel,
    });

    if (signal) {
      results.earnings.signals++;
      console.log(`\n✅ Post-Earnings IV Crush Signal: ${symbol}`);
      if (verbose) {
        console.log(`   Option: ${signal.optionType} $${signal.strike} exp ${signal.expiration}`);
        console.log(`   Entry: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(3)}`);
        console.log(`   Days Since Earnings: ${signal.daysSinceEarnings.toFixed(1)}`);
        console.log(`   Gap: ${signal.gapPercent.toFixed(1)}% | IV %ile: ${signal.ivPercentile}`);
        console.log(`   Trend: ${signal.trendDirection}`);
        console.log(`   R:R: ${signal.riskRewardRatio.toFixed(2)}`);
      }
      return signal;
    } else {
      if (verbose) console.log(`   No post-earnings setup for ${symbol}`);
      return null;
    }
  } catch (err) {
    results.earnings.errors++;
    console.error(`❌ Post-earnings error for ${symbol}:`, err.message);
    return null;
  }
}

/**
 * Test Signal Fusion Engine
 */
async function testFusion(marketData) {
  const {
    symbol,
    candles,
    optionChain,
    ivPercentile,
    ivRank,
    currentPrice,
    avgVolume,
    supportLevel,
    resistanceLevel,
    atr,
  } = marketData;

  results.fusion.tested++;

  try {
    // Estimate earnings date for fusion
    const earningsDate = POST_EARNINGS_CANDIDATES.includes(symbol)
      ? new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
      : undefined;

    const candidates = scanAndRankSwingSignals({
      symbol,
      candles,
      optionChain,
      ivPercentile,
      ivRank,
      currentPrice,
      avgVolume,
      relativeStrength: 75,
      supportLevel,
      resistanceLevel,
      atr,
      earningsDate,
      ivPercentilePriorToEarnings: earningsDate ? 80 : undefined,
      openingPriceOnEarningsDay: earningsDate ? currentPrice * 1.05 : undefined,
    });

    if (candidates.length > 0) {
      results.fusion.signals += candidates.length;
      console.log(`\n✅ Fusion Engine: ${symbol} — ${candidates.length} signal(s)`);

      for (const candidate of candidates) {
        const { signal, score, breakdown } = candidate;
        console.log(`\n   Signal ${signal.type} — Score: ${score.toFixed(0)}/100`);
        if (verbose) {
          console.log(`     Option: ${signal.optionType} $${signal.strike} exp ${signal.expiration}`);
          console.log(`     Entry: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(3)}`);
          console.log(`     R:R: ${signal.riskRewardRatio.toFixed(2)}`);
          console.log(`     Breakdown:`);
          console.log(`       Technical: ${breakdown.technical.toFixed(0)}`);
          console.log(`       Momentum: ${breakdown.momentum.toFixed(0)}`);
          console.log(`       Relative Strength: ${breakdown.relativeStrength.toFixed(0)}`);
          console.log(`       IV/RV: ${breakdown.ivRv.toFixed(0)}`);
          console.log(`       IV Skew: ${breakdown.ivSkew.toFixed(0)}`);
          console.log(`       OTM Mispricing: ${breakdown.otmMispricing.toFixed(0)}`);
          console.log(`       Liquidity: ${breakdown.liquidity.toFixed(0)}`);
        }
      }
      return candidates;
    } else {
      if (verbose) console.log(`   No fusion signals for ${symbol}`);
      return [];
    }
  } catch (err) {
    results.fusion.errors++;
    console.error(`❌ Fusion error for ${symbol}:`, err.message);
    return [];
  }
}

/**
 * Main test runner
 */
async function runTests() {
  for (const symbol of symbols) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing ${symbol}`);
    console.log('='.repeat(60));

    let marketData;
    try {
      marketData = await fetchMarketData(symbol);
      console.log(`✓ Fetched market data: ${marketData.candles.length} candles, ${marketData.optionChain.length} options`);
    } catch (err) {
      console.error(`❌ Failed to fetch data for ${symbol}:`, err.message);
      continue;
    }

    // Run scanners based on filter
    if (!scannerFilter || scannerFilter === 'panic') {
      await testPanicReversal(marketData);
    }

    if (!scannerFilter || scannerFilter === 'momentum') {
      await testMomentumBreakout(marketData);
    }

    if (!scannerFilter || scannerFilter === 'earnings') {
      await testPostEarnings(marketData);
    }

    if (!scannerFilter || scannerFilter === 'fusion') {
      await testFusion(marketData);
    }

    // Rate limit courtesy
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  // Print summary
  console.log(`\n${'='.repeat(60)}`);
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));

  console.log(`\nPanic Reversal Scanner:`);
  console.log(`  Tested: ${results.panic.tested}`);
  console.log(`  Signals: ${results.panic.signals}`);
  console.log(`  Errors: ${results.panic.errors}`);
  console.log(`  Success Rate: ${results.panic.tested > 0 ? ((results.panic.tested - results.panic.errors) / results.panic.tested * 100).toFixed(1) : 0}%`);

  console.log(`\nMomentum Breakout Scanner:`);
  console.log(`  Tested: ${results.momentum.tested}`);
  console.log(`  Signals: ${results.momentum.signals}`);
  console.log(`  Errors: ${results.momentum.errors}`);
  console.log(`  Success Rate: ${results.momentum.tested > 0 ? ((results.momentum.tested - results.momentum.errors) / results.momentum.tested * 100).toFixed(1) : 0}%`);

  console.log(`\nPost-Earnings IV Crush Scanner:`);
  console.log(`  Tested: ${results.earnings.tested}`);
  console.log(`  Signals: ${results.earnings.signals}`);
  console.log(`  Errors: ${results.earnings.errors}`);
  console.log(`  Success Rate: ${results.earnings.tested > 0 ? ((results.earnings.tested - results.earnings.errors) / results.earnings.tested * 100).toFixed(1) : 0}%`);

  console.log(`\nSignal Fusion Engine:`);
  console.log(`  Tested: ${results.fusion.tested}`);
  console.log(`  Signals: ${results.fusion.signals}`);
  console.log(`  Errors: ${results.fusion.errors}`);
  console.log(`  Success Rate: ${results.fusion.tested > 0 ? ((results.fusion.tested - results.fusion.errors) / results.fusion.tested * 100).toFixed(1) : 0}%`);

  const totalErrors = results.panic.errors + results.momentum.errors + results.earnings.errors + results.fusion.errors;
  const totalTested = results.panic.tested + results.momentum.tested + results.earnings.tested + results.fusion.tested;

  console.log(`\nOVERALL:`);
  console.log(`  Total Tests: ${totalTested}`);
  console.log(`  Total Errors: ${totalErrors}`);
  console.log(`  Overall Success Rate: ${totalTested > 0 ? ((totalTested - totalErrors) / totalTested * 100).toFixed(1) : 0}%`);

  const exitCode = totalErrors > 0 ? 1 : 0;
  console.log(`\n${exitCode === 0 ? '✅' : '❌'} Tests ${exitCode === 0 ? 'PASSED' : 'FAILED'}\n`);
  process.exit(exitCode);
}

runTests().catch(err => {
  console.error('\n❌ Fatal error:', err);
  process.exit(1);
});
