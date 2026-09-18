/**
 * TRA-4625 — Mock data test for swing signal scanners
 *
 * Validates scanner logic with synthetic market data.
 * Runs without requiring Tradier API token.
 *
 * Usage:
 *   node scripts/swing-scanner-mock-test.mjs [--verbose]
 */

import { scanPanicReversal } from '../packages/server/dist/panic-reversal-scanner.js';
import { scanMomentumBreakoutIvLag } from '../packages/server/dist/momentum-breakout-iv-lag-scanner.js';
import { scanPostEarningsIvCrush } from '../packages/server/dist/post-earnings-iv-crush-scanner.js';
import { scanAndRankSwingSignals } from '../packages/server/dist/swing-signal-fusion.js';

const verbose = process.argv.includes('--verbose');

console.log(`\n🧪 TRA-4625 — Swing Scanner Mock Data Test\n`);

// Generate mock candle data
function generateCandles(count, basePrice, trend = 0, volatility = 0.02) {
  const candles = [];
  let price = basePrice;
  const now = Date.now();
  const dayMs = 24 * 60 * 60 * 1000;

  for (let i = 0; i < count; i++) {
    const trendMove = trend * (i / count);
    const randomMove = (Math.random() - 0.5) * volatility * price;
    price = price * (1 + trendMove) + randomMove;

    const high = price * (1 + Math.random() * volatility);
    const low = price * (1 - Math.random() * volatility);
    const open = low + Math.random() * (high - low);
    const close = low + Math.random() * (high - low);

    candles.push({
      timestamp: now - (count - i) * dayMs,
      open,
      high,
      low,
      close,
      volume: 1000000 + Math.random() * 5000000,
    });
  }

  return candles;
}

// Generate mock option chain
function generateOptionChain(symbol, spot, expDays = 45) {
  const chain = [];
  const expDate = new Date();
  expDate.setDate(expDate.getDate() + expDays);
  const expStr = expDate.toISOString().split('T')[0];

  // Generate strikes around spot (80% to 120%)
  for (let pct = 0.80; pct <= 1.20; pct += 0.05) {
    const strike = Math.round(spot * pct);
    const isOtmCall = strike > spot;
    const isOtmPut = strike < spot;

    // Calls
    const callIv = 0.30 + (strike < spot ? 0.05 : -0.05); // ATM higher IV
    const callBid = Math.max(0.10, (spot - strike) * 0.5 + Math.random() * 2);
    const callAsk = callBid * 1.1;

    chain.push({
      symbol: `${symbol}_${expStr}_C_${strike}`,
      optionSymbol: `${symbol}${expDate.getFullYear().toString().slice(-2)}${String(expDate.getMonth() + 1).padStart(2, '0')}${String(expDate.getDate()).padStart(2, '0')}C${String(strike * 1000).padStart(8, '0')}`,
      optionType: 'call',
      strike,
      expiration: expStr,
      bid: isOtmCall ? callBid : callBid + (spot - strike),
      ask: isOtmCall ? callAsk : callAsk + (spot - strike),
      last: isOtmCall ? (callBid + callAsk) / 2 : (callBid + callAsk) / 2 + (spot - strike),
      volume: Math.floor(Math.random() * 1000),
      openInterest: Math.floor(Math.random() * 5000),
      midIv: callIv,
      delta: isOtmCall ? 0.20 + Math.random() * 0.20 : 0.50 + Math.random() * 0.30,
    });

    // Puts
    const putIv = 0.35 + (strike > spot ? 0.05 : -0.05); // OTM puts have higher IV (skew)
    const putBid = Math.max(0.10, (strike - spot) * 0.5 + Math.random() * 2);
    const putAsk = putBid * 1.1;

    chain.push({
      symbol: `${symbol}_${expStr}_P_${strike}`,
      optionSymbol: `${symbol}${expDate.getFullYear().toString().slice(-2)}${String(expDate.getMonth() + 1).padStart(2, '0')}${String(expDate.getDate()).padStart(2, '0')}P${String(strike * 1000).padStart(8, '0')}`,
      optionType: 'put',
      strike,
      expiration: expStr,
      bid: isOtmPut ? putBid : putBid + (strike - spot),
      ask: isOtmPut ? putAsk : putAsk + (strike - spot),
      last: isOtmPut ? (putBid + putAsk) / 2 : (putBid + putAsk) / 2 + (strike - spot),
      volume: Math.floor(Math.random() * 1000),
      openInterest: Math.floor(Math.random() * 5000),
      midIv: putIv,
      delta: isOtmPut ? -(0.20 + Math.random() * 0.20) : -(0.50 + Math.random() * 0.30),
    });
  }

  return chain;
}

// Test 1: Panic Reversal Scanner
console.log('='.repeat(60));
console.log('Test 1: Panic Reversal Scanner');
console.log('='.repeat(60));

const panicCandles = generateCandles(150, 100, 0, 0.03);
// Create a recent decline by dropping last 5 candles
for (let i = panicCandles.length - 5; i < panicCandles.length; i++) {
  const dropPct = 0.02 * (i - (panicCandles.length - 6));
  panicCandles[i].close *= (1 - dropPct);
  panicCandles[i].high *= (1 - dropPct);
  panicCandles[i].low *= (1 - dropPct);
  panicCandles[i].open *= (1 - dropPct);
}

const panicSpot = panicCandles[panicCandles.length - 1].close;
const panicChain = generateOptionChain('PANIC', panicSpot);

const panicSignal = scanPanicReversal({
  symbol: 'PANIC',
  candles: panicCandles,
  optionChain: panicChain,
  ivRank: 75, // Elevated IV
  currentPrice: panicSpot,
  supportLevel: panicSpot * 0.95,
  atr: panicSpot * 0.02,
});

if (panicSignal) {
  console.log('✅ Panic Reversal Signal Generated');
  console.log(`   Symbol: ${panicSignal.symbol}`);
  console.log(`   Option: ${panicSignal.optionType} $${panicSignal.strike} exp ${panicSignal.expiration}`);
  console.log(`   Entry: $${panicSignal.mark.toFixed(2)} | Delta: ${panicSignal.delta.toFixed(3)}`);
  console.log(`   Recent Decline: ${panicSignal.recentDeclinePct.toFixed(1)}%`);
  console.log(`   IV Rank: ${panicSignal.ivRank}`);
  console.log(`   Reversal Score: ${panicSignal.reversalScore.toFixed(0)}/100`);
  console.log(`   Put/Call Skew: ${panicSignal.putCallSkew.toFixed(2)}`);
  console.log(`   R:R: ${panicSignal.riskRewardRatio.toFixed(2)}`);

  // Validate
  const issues = [];
  if (panicSignal.delta < 0.25 || panicSignal.delta > 0.40) {
    issues.push(`Delta ${panicSignal.delta.toFixed(3)} out of range [0.25, 0.40]`);
  }
  if (panicSignal.optionType !== 'call') {
    issues.push(`Expected call option, got ${panicSignal.optionType}`);
  }
  if (panicSignal.strike <= panicSpot) {
    issues.push(`Expected OTM call, but strike ${panicSignal.strike} <= spot ${panicSpot.toFixed(2)}`);
  }

  if (issues.length > 0) {
    console.log('\n❌ Validation Issues:');
    issues.forEach(issue => console.log(`   - ${issue}`));
  } else {
    console.log('\n✅ Signal passes validation');
  }
} else {
  console.log('❌ No signal generated (expected signal for panic reversal setup)');
}

// Test 2: Momentum Breakout Scanner
console.log('\n' + '='.repeat(60));
console.log('Test 2: Momentum Breakout Scanner');
console.log('='.repeat(60));

const momentumCandles = generateCandles(150, 100, 0, 0.02);
// Create breakout: recent bars break above prior high
const priorHigh = Math.max(...momentumCandles.slice(0, -10).map(c => c.high));
for (let i = momentumCandles.length - 3; i < momentumCandles.length; i++) {
  momentumCandles[i].close = priorHigh * 1.03;
  momentumCandles[i].high = priorHigh * 1.04;
  momentumCandles[i].low = priorHigh * 1.01;
  momentumCandles[i].open = priorHigh * 1.02;
  momentumCandles[i].volume *= 2.0; // Volume confirmation
}

const momentumSpot = momentumCandles[momentumCandles.length - 1].close;
const avgVolume = momentumCandles.slice(0, -10).reduce((sum, c) => sum + c.volume, 0) / (momentumCandles.length - 10);
const momentumChain = generateOptionChain('MOMENTUM', momentumSpot);

const momentumSignal = scanMomentumBreakoutIvLag({
  symbol: 'MOMENTUM',
  candles: momentumCandles,
  optionChain: momentumChain,
  ivPercentile: 40, // Low IV (hasn't caught up)
  currentPrice: momentumSpot,
  avgVolume,
  relativeStrength: 85,
});

if (momentumSignal) {
  console.log('✅ Momentum Breakout Signal Generated');
  console.log(`   Symbol: ${momentumSignal.symbol}`);
  console.log(`   Option: ${momentumSignal.optionType} $${momentumSignal.strike} exp ${momentumSignal.expiration}`);
  console.log(`   Entry: $${momentumSignal.mark.toFixed(2)} | Delta: ${momentumSignal.delta.toFixed(3)}`);
  console.log(`   Breakout Level: $${momentumSignal.breakoutLevel.toFixed(2)}`);
  console.log(`   Volume Ratio: ${momentumSignal.volumeRatio.toFixed(2)}x`);
  console.log(`   Momentum Score: ${momentumSignal.momentumScore.toFixed(0)}/100`);
  console.log(`   IV Percentile: ${momentumSignal.ivPercentile}`);
  console.log(`   R:R: ${momentumSignal.riskRewardRatio.toFixed(2)}`);

  // Validate
  const issues = [];
  if (momentumSignal.delta < 0.25 || momentumSignal.delta > 0.40) {
    issues.push(`Delta ${momentumSignal.delta.toFixed(3)} out of range [0.25, 0.40]`);
  }
  if (momentumSignal.optionType !== 'call') {
    issues.push(`Expected call option for bullish breakout, got ${momentumSignal.optionType}`);
  }
  if (momentumSignal.strike <= momentumSpot) {
    issues.push(`Expected OTM call, but strike ${momentumSignal.strike} <= spot ${momentumSpot.toFixed(2)}`);
  }
  if (momentumSignal.volumeRatio < 1.5) {
    issues.push(`Volume ratio ${momentumSignal.volumeRatio.toFixed(2)} below 1.5x threshold`);
  }

  if (issues.length > 0) {
    console.log('\n❌ Validation Issues:');
    issues.forEach(issue => console.log(`   - ${issue}`));
  } else {
    console.log('\n✅ Signal passes validation');
  }
} else {
  console.log('❌ No signal generated (expected signal for momentum breakout setup)');
}

// Test 3: Post-Earnings IV Crush Scanner
console.log('\n' + '='.repeat(60));
console.log('Test 3: Post-Earnings IV Crush Scanner');
console.log('='.repeat(60));

const earningsCandles = generateCandles(150, 100, 0, 0.02);
// Create earnings gap
const gapDay = earningsCandles.length - 3;
earningsCandles[gapDay].open *= 1.08; // 8% gap up
earningsCandles[gapDay].high *= 1.09;
earningsCandles[gapDay].low *= 1.07;
earningsCandles[gapDay].close *= 1.08;
// Subsequent bars hold the gap
for (let i = gapDay + 1; i < earningsCandles.length; i++) {
  earningsCandles[i].open *= 1.08;
  earningsCandles[i].high *= 1.08;
  earningsCandles[i].low *= 1.08;
  earningsCandles[i].close *= 1.08;
}

const earningsSpot = earningsCandles[earningsCandles.length - 1].close;
const earningsChain = generateOptionChain('EARNINGS', earningsSpot, 35); // Shorter DTE for earnings play
const earningsDate = new Date(earningsCandles[gapDay].timestamp);

const earningsSignal = scanPostEarningsIvCrush({
  symbol: 'EARNINGS',
  candles: earningsCandles,
  optionChain: earningsChain,
  ivPercentile: 25, // Low IV (post-crush)
  ivPercentilePriorToEarnings: 75, // Was high pre-earnings
  earningsDate,
  currentPrice: earningsSpot,
  openingPriceOnEarningsDay: earningsCandles[gapDay].open,
  relativeStrength: 80,
  resistanceLevel: earningsSpot * 1.05,
  supportLevel: earningsCandles[gapDay - 1].close,
});

if (earningsSignal) {
  console.log('✅ Post-Earnings IV Crush Signal Generated');
  console.log(`   Symbol: ${earningsSignal.symbol}`);
  console.log(`   Option: ${earningsSignal.optionType} $${earningsSignal.strike} exp ${earningsSignal.expiration}`);
  console.log(`   Entry: $${earningsSignal.mark.toFixed(2)} | Delta: ${earningsSignal.delta.toFixed(3)}`);
  console.log(`   Days Since Earnings: ${earningsSignal.daysSinceEarnings.toFixed(1)}`);
  console.log(`   Gap: ${earningsSignal.gapPercent.toFixed(1)}%`);
  console.log(`   IV Percentile: ${earningsSignal.ivPercentile}`);
  console.log(`   Trend: ${earningsSignal.trendDirection}`);
  console.log(`   R:R: ${earningsSignal.riskRewardRatio.toFixed(2)}`);

  // Validate
  const issues = [];
  if (earningsSignal.delta < 0.25 || earningsSignal.delta > 0.40) {
    issues.push(`Delta ${earningsSignal.delta.toFixed(3)} out of range [0.25, 0.40]`);
  }
  if (Math.abs(earningsSignal.gapPercent) < 5.0) {
    issues.push(`Gap ${earningsSignal.gapPercent.toFixed(1)}% below 5% threshold`);
  }
  if (earningsSignal.daysSinceEarnings > 5) {
    issues.push(`Days since earnings ${earningsSignal.daysSinceEarnings.toFixed(1)} exceeds 5-day window`);
  }

  if (issues.length > 0) {
    console.log('\n❌ Validation Issues:');
    issues.forEach(issue => console.log(`   - ${issue}`));
  } else {
    console.log('\n✅ Signal passes validation');
  }
} else {
  console.log('❌ No signal generated (expected signal for post-earnings setup)');
}

// Test 4: Signal Fusion Engine
console.log('\n' + '='.repeat(60));
console.log('Test 4: Signal Fusion Engine');
console.log('='.repeat(60));

// Use panic setup for fusion test
const fusionCandidates = scanAndRankSwingSignals({
  symbol: 'FUSION',
  candles: panicCandles,
  optionChain: panicChain,
  ivPercentile: 45,
  ivRank: 75,
  currentPrice: panicSpot,
  avgVolume: panicCandles.slice(-20).reduce((sum, c) => sum + c.volume, 0) / 20,
  relativeStrength: 65,
  supportLevel: panicSpot * 0.95,
  resistanceLevel: panicSpot * 1.05,
  atr: panicSpot * 0.02,
  realizedVol: 0.25,
});

if (fusionCandidates.length > 0) {
  console.log(`✅ Fusion Engine Generated ${fusionCandidates.length} Signal(s)`);

  for (const candidate of fusionCandidates) {
    const { signal, score, breakdown } = candidate;
    console.log(`\n   Signal: ${signal.type} — Composite Score: ${score.toFixed(0)}/100`);
    console.log(`     Option: ${signal.optionType} $${signal.strike}`);
    console.log(`     Entry: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(3)}`);
    console.log(`     R:R: ${signal.riskRewardRatio.toFixed(2)}`);

    if (verbose) {
      console.log(`     Score Breakdown:`);
      console.log(`       Technical: ${breakdown.technical.toFixed(0)}`);
      console.log(`       Momentum: ${breakdown.momentum.toFixed(0)}`);
      console.log(`       Mean Reversion: ${breakdown.meanReversion.toFixed(0)}`);
      console.log(`       Relative Strength: ${breakdown.relativeStrength.toFixed(0)}`);
      console.log(`       IV/RV: ${breakdown.ivRv.toFixed(0)}`);
      console.log(`       IV Skew: ${breakdown.ivSkew.toFixed(0)}`);
      console.log(`       OTM Mispricing: ${breakdown.otmMispricing.toFixed(0)}`);
      console.log(`       Liquidity: ${breakdown.liquidity.toFixed(0)}`);
    }

    // Validate
    const issues = [];
    if (score < 0 || score > 100) {
      issues.push(`Composite score ${score.toFixed(0)} out of range [0, 100]`);
    }
    Object.entries(breakdown).forEach(([dim, val]) => {
      if (val < 0 || val > 100) {
        issues.push(`${dim} score ${val.toFixed(0)} out of range [0, 100]`);
      }
    });

    if (issues.length > 0) {
      console.log('\n   ❌ Validation Issues:');
      issues.forEach(issue => console.log(`     - ${issue}`));
    } else {
      console.log('\n   ✅ Signal passes validation');
    }
  }
} else {
  console.log('⚠️  No fusion signals generated (may be expected for mock data)');
}

// Summary
console.log('\n' + '='.repeat(60));
console.log('TEST SUMMARY');
console.log('='.repeat(60));
console.log(`Panic Reversal Scanner: ${panicSignal ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Momentum Breakout Scanner: ${momentumSignal ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Post-Earnings Scanner: ${earningsSignal ? '✅ PASS' : '❌ FAIL'}`);
console.log(`Fusion Engine: ${fusionCandidates.length > 0 ? '✅ PASS' : '⚠️  NO SIGNALS'}`);

const passCount = [panicSignal, momentumSignal, earningsSignal].filter(Boolean).length;
console.log(`\nOverall: ${passCount}/3 core scanners passed`);
console.log(`\n${passCount === 3 ? '✅' : '❌'} Mock data test ${passCount === 3 ? 'PASSED' : 'FAILED'}\n`);

process.exit(passCount === 3 ? 0 : 1);
