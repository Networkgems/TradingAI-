/**
 * Deterministic synthetic candle generator for backtesting.
 *
 * Uses a seeded pseudo-random number generator (Mulberry32) so every run
 * produces identical candle sequences — results are reproducible.
 *
 * The generated candles mimic realistic intraday OHLCV data:
 *   - Trending scenario: persistent directional bias (~0.3% drift per bar)
 *   - Ranging scenario:  mean-reverting sine-wave oscillation
 *
 * Timestamps start at 9:35 AM ET on a generic Monday and advance by 1 minute
 * per bar, keeping signals inside the valid ET trading window.
 */

import type { Candle } from '@trading-app/shared';

// ── Seeded PRNG (Mulberry32) ──────────────────────────────────────────────────
function mulberry32(seed: number) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Scenario builders ─────────────────────────────────────────────────────────

/**
 * Trending candles: strong directional drift + noise.
 * ADX will read >25 after ~40 bars, making ORB, MACD, Ichimoku fire.
 *
 * @param bars   Number of 1-min candles to generate
 * @param trend  'up' | 'down'
 * @param seed   PRNG seed for reproducibility
 */
export function trendingCandles(
  bars: number,
  symbol: string,
  trend: 'up' | 'down' = 'up',
  startPrice = 150,
  seed = 42,
): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];

  // 9:35 AM ET expressed as a UTC offset (ET = UTC-4)
  const baseTs = new Date('2026-04-21T13:35:00.000Z').getTime(); // 9:35 ET on a Mon
  let price = startPrice;
  const driftPer = trend === 'up' ? 0.003 : -0.003; // 0.3% per bar

  for (let i = 0; i < bars; i++) {
    const noise = (rand() - 0.5) * 0.008;
    const drift = driftPer * (0.7 + rand() * 0.6); // ±30% variation on drift
    const change = price * (drift + noise);

    const open = price;
    const close = price + change;
    const wick = price * 0.003 * rand();
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;

    // Volume: higher at open and close hours, spikes on strong moves
    const baseVol = 20_000 + rand() * 30_000;
    const volSpike = Math.abs(drift + noise) > 0.005 ? rand() * 40_000 : 0;

    candles.push({
      symbol,
      timestamp: baseTs + i * 60_000,
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +close.toFixed(4),
      volume: Math.floor(baseVol + volSpike),
    });

    price = close;
  }

  return candles;
}

/**
 * Ranging candles: high-noise, rapid oscillation that keeps ADX < 20.
 *
 * Uses a short-period sine wave (8-bar cycle) with small amplitude relative to
 * bar-level noise so successive bars frequently flip direction — DM+ and DM- cancel
 * each other, keeping ADX in the 10–18 band.
 *
 * @param bars       Number of 1-min candles
 * @param amplitude  Price range around midpoint (±amplitude). Keep small vs noise.
 * @param periodBars Bars per full sine cycle. Shorter = more direction flips = lower ADX.
 * @param seed       PRNG seed
 */
export function rangingCandles(
  bars: number,
  symbol: string,
  startPrice = 150,
  amplitude = 2,
  periodBars = 8,
  seed = 99,
): Candle[] {
  const rand = mulberry32(seed);
  const candles: Candle[] = [];

  const baseTs = new Date('2026-04-21T13:35:00.000Z').getTime();
  let price = startPrice;

  for (let i = 0; i < bars; i++) {
    // Strong mean-revert + large noise → frequent direction flips
    const target = startPrice + amplitude * Math.sin((i / periodBars) * 2 * Math.PI);
    const meanRevert = (target - price) * 0.5; // aggressive mean-reversion
    const noise = (rand() - 0.5) * price * 0.004; // ±0.4% bar noise dominates
    const change = meanRevert + noise;

    const open = price;
    const close = price + change;
    const wickFraction = 0.002 + rand() * 0.003;
    const wick = price * wickFraction;
    const high = Math.max(open, close) + wick;
    const low = Math.min(open, close) - wick;

    // Volume: elevated near RSI extremes for reversal signal validity
    const extremeness = Math.abs(Math.sin((i / periodBars) * 2 * Math.PI));
    const baseVol = 8_000 + rand() * 12_000;
    const extremeVol = extremeness > 0.8 ? rand() * 50_000 : 0;

    candles.push({
      symbol,
      timestamp: baseTs + i * 60_000,
      open: +open.toFixed(4),
      high: +high.toFixed(4),
      low: +low.toFixed(4),
      close: +close.toFixed(4),
      volume: Math.floor(baseVol + extremeVol),
    });

    price = close;
  }

  return candles;
}

/**
 * Mixed regime: first half trending, second half ranging.
 * Useful for testing combined strategies.
 */
export function mixedRegimeCandles(
  bars: number,
  symbol: string,
  startPrice = 150,
  seed = 7,
): Candle[] {
  const half = Math.floor(bars / 2);
  const trending = trendingCandles(half, symbol, 'up', startPrice, seed);
  const endPrice = trending[trending.length - 1].close;
  const ranging = rangingCandles(bars - half, symbol, endPrice, 2, 8, seed + 1); // low-ADX ranging

  // Shift ranging timestamps to follow trending
  const offset = trending[trending.length - 1].timestamp + 60_000 - ranging[0].timestamp;
  return [
    ...trending,
    ...ranging.map(c => ({ ...c, timestamp: c.timestamp + offset })),
  ];
}
