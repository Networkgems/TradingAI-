/**
 * Per-bar gate diagnostics for TRA-170 strategies on real BTC/ETH/SOL data.
 *
 * For each symbol, reports how often each individual gate would pass — so we
 * can see exactly which gate is choking signal frequency. The intersection of
 * all gates is what determines actual trade count.
 */

import YahooFinance from 'yahoo-finance2';
import type { Candle } from '@trading-app/shared';
import { rsi, rsiDivergence, adx, ema, atr } from '@trading-app/engine';
import { detectPattern, isBullishPattern, isBearishPattern } from '@trading-app/engine';

const yf = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

async function fetchHourly(symbol: string, days: number): Promise<Candle[]> {
  const now = new Date();
  const from = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  const result = await yf.chart(symbol, { period1: from, period2: now, interval: '1h' });
  const quotes = result.quotes ?? [];
  return quotes
    .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
    .filter(q => (q.volume ?? 0) > 0)
    .map(q => ({
      symbol,
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume!,
    }));
}

function pct(part: number, whole: number): string {
  if (whole === 0) return '0%';
  return ((part / whole) * 100).toFixed(1) + '%';
}

async function diagnose(symbol: string, days: number) {
  const candles = await fetchHourly(symbol, days);
  console.log(`\n${symbol} — ${candles.length} bars over ${days}d`);
  console.log('─'.repeat(72));

  let nADX_lt20 = 0, nADX_25to30 = 0, nADX_gte25 = 0, nADXNull = 0;
  let nRSI_lt35 = 0, nRSI_gt65 = 0, nRSI_lt30 = 0;
  let nVolSpike13 = 0, nVolSpike15 = 0;
  let nBullPattern = 0, nBearPattern = 0, nDivBull = 0, nDivBear = 0;
  let nAtrPctLt003 = 0;
  let nAtTouchLowerBB = 0;

  // Sliding-window evaluation, mimicking the strategy's bar-by-bar scan.
  const lookback = 5;
  const bbPeriod = 20;
  const rsiPeriod = 14;
  for (let i = Math.max(35, bbPeriod, lookback + 1); i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const closes = window.map(c => c.close);
    const latest = window[window.length - 1];

    // ADX bucket
    const a = adx(window);
    if (a == null) nADXNull++;
    else if (a.adx < 20) nADX_lt20++;
    else if (a.adx >= 25) nADX_gte25++;
    else nADX_25to30++;

    // RSI buckets
    const r = rsi(closes, rsiPeriod);
    if (!isNaN(r)) {
      if (r < 35) nRSI_lt35++;
      if (r > 65) nRSI_gt65++;
      if (r < 30) nRSI_lt30++;
    }

    // Volume spikes
    const vw = window.slice(-lookback - 1, -1);
    const avgV = vw.reduce((s, c) => s + c.volume, 0) / vw.length;
    if (latest.volume > avgV * 1.3) nVolSpike13++;
    if (latest.volume > avgV * 1.5) nVolSpike15++;

    // Pattern + divergence
    const p = detectPattern(window.slice(-2));
    if (isBullishPattern(p)) nBullPattern++;
    if (isBearishPattern(p)) nBearPattern++;
    const div = rsiDivergence(closes, rsiPeriod, lookback);
    if (div === 'bullish') nDivBull++;
    if (div === 'bearish') nDivBear++;

    // ATR/price
    const at = atr(window, 14);
    if (at != null && latest.close > 0 && at / latest.close < 0.003) nAtrPctLt003++;

    // BB lower-band tag — quick proxy: count bars where close <= (sma - 2*sd) over bbPeriod
    if (closes.length >= bbPeriod) {
      const w = closes.slice(-bbPeriod);
      const m = w.reduce((s, x) => s + x, 0) / bbPeriod;
      const v = w.reduce((s, x) => s + (x - m) ** 2, 0) / bbPeriod;
      const sd = Math.sqrt(v);
      const lower = m - 2 * sd;
      if (latest.close <= lower) nAtTouchLowerBB++;
    }
  }

  const N = candles.length - Math.max(35, bbPeriod, lookback + 1);
  console.log(`  bars analyzed:      ${N}`);
  console.log(`  ADX < 20  (range):  ${nADX_lt20}  (${pct(nADX_lt20, N)})`);
  console.log(`  ADX ≥ 25  (trend):  ${nADX_gte25}  (${pct(nADX_gte25, N)})`);
  console.log(`  ADX null:           ${nADXNull}`);
  console.log(`  RSI < 35:           ${nRSI_lt35}  (${pct(nRSI_lt35, N)})`);
  console.log(`  RSI > 65:           ${nRSI_gt65}  (${pct(nRSI_gt65, N)})`);
  console.log(`  RSI < 30:           ${nRSI_lt30}  (${pct(nRSI_lt30, N)})`);
  console.log(`  vol > 1.3× avg:     ${nVolSpike13}  (${pct(nVolSpike13, N)})`);
  console.log(`  vol > 1.5× avg:     ${nVolSpike15}  (${pct(nVolSpike15, N)})`);
  console.log(`  bull pattern:       ${nBullPattern}  (${pct(nBullPattern, N)})`);
  console.log(`  bear pattern:       ${nBearPattern}  (${pct(nBearPattern, N)})`);
  console.log(`  bull divergence:    ${nDivBull}  (${pct(nDivBull, N)})`);
  console.log(`  bear divergence:    ${nDivBear}  (${pct(nDivBear, N)})`);
  console.log(`  ATR/price < 0.3%:   ${nAtrPctLt003}  (${pct(nAtrPctLt003, N)})  ← TRA-171 dead-tape gate`);
  console.log(`  close ≤ lower BB:   ${nAtTouchLowerBB}  (${pct(nAtTouchLowerBB, N)})  ← BbFade entry trigger`);
}

async function main() {
  for (const sym of ['BTC-USD', 'ETH-USD', 'SOL-USD']) {
    await diagnose(sym, 90);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
