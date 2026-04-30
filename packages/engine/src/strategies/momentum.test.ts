import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { MomentumStrategy } from './momentum.js';
import { RegimeDetector } from '../regime.js';

/**
 * Sideways base with comparable bar-range to the subsequent trend phase.
 * Matching the per-bar range across phases stops the regime detector from
 * misclassifying the trend's first bars as `high_vol` (an ATR-spike vs. a
 * too-quiet base would otherwise dominate the regime label).
 */
function basingPhase(length: number, mid = 100, range = 0.6): Candle[] {
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < length; i++) {
    // Sinusoidal flicker keeps closes within ±range/2 of mid so the Donchian
    // channel collapses to a narrow band, but the per-bar TR matches the
    // trend-phase TR so ATR median across a stitched series stays stable.
    const next = mid + Math.sin(i * 0.7) * (range / 4);
    out.push({
      symbol: 'TEST',
      timestamp: i * 60_000,
      open: prev,
      high: Math.max(prev, next) + range / 2,
      low: Math.min(prev, next) - range / 2,
      close: next,
      volume: 1_000,
    });
    prev = next;
  }
  return out;
}

function trendPhase(
  length: number,
  start: number,
  perBar: number,
  range = 0.6,
  startTs = 0,
): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  for (let i = 0; i < length; i++) {
    const next = prev * (1 + perBar);
    out.push({
      symbol: 'TEST',
      timestamp: startTs + i * 60_000,
      open: prev,
      high: Math.max(prev, next) + range / 2,
      low: Math.min(prev, next) - range / 2,
      close: next,
      volume: 1_000,
    });
    prev = next;
  }
  return out;
}

/**
 * Build a `flat → trend` transition long enough to seed both the slow EMA
 * and the regime detector's hysteresis. The base bars contribute a tight
 * Donchian channel; the trend bars produce the regime flip and the fresh
 * breakout. Default knobs match the slow `slowMaPeriod = 200` so the test
 * exercises the production configuration.
 */
function transitionSeries(
  baseBars: number,
  trendBars: number,
  trend: 'up' | 'down',
  mid = 100,
): Candle[] {
  const base = basingPhase(baseBars, mid);
  const lastBaseTs = base[base.length - 1].timestamp;
  const startPx = base[base.length - 1].close;
  const perBar = trend === 'up' ? 0.005 : -0.005;
  const trendCandles = trendPhase(trendBars, startPx, perBar, 0.4, lastBaseTs + 60_000);
  return [...base, ...trendCandles];
}

describe('MomentumStrategy', () => {
  it('returns null when there are too few bars for the slow MA', () => {
    const detector = new RegimeDetector();
    const strat = new MomentumStrategy(detector);
    const candles = basingPhase(50);
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('emits a momentum buy on a flat → uptrend transition', () => {
    const detector = new RegimeDetector();
    const strat = new MomentumStrategy(detector, {
      // Use shorter MA / Donchian periods so the test runs in <300 bars.
      fastMaPeriod: 10,
      slowMaPeriod: 50,
      donchianPeriod: 15,
    });
    const candles = transitionSeries(80, 120, 'up');

    let signal = null;
    let firedAt = -1;
    for (let i = 60; i <= candles.length; i++) {
      const s = strat.evaluate('TEST', candles.slice(0, i));
      if (s && !signal) {
        signal = s;
        firedAt = i;
      }
    }
    expect(signal).not.toBeNull();
    if (signal) {
      expect(signal.type).toBe('momentum');
      expect(signal.side).toBe('buy');
      expect(signal.entryPrice).toBeGreaterThan(0);
      expect(signal.stopLoss).toBeLessThan(signal.entryPrice);
      expect(signal.takeProfit).toBeGreaterThan(signal.entryPrice);
      // Default 2× ATR stop and 4× ATR target → 2:1 R:R.
      expect(signal.riskRewardRatio).toBeCloseTo(2, 1);
      // Should fire after the trend phase has begun (i.e. past the base).
      expect(firedAt).toBeGreaterThan(80);
    }
  });

  it('emits a momentum sell on a flat → downtrend transition', () => {
    const detector = new RegimeDetector();
    const strat = new MomentumStrategy(detector, {
      fastMaPeriod: 10,
      slowMaPeriod: 50,
      donchianPeriod: 15,
    });
    const candles = transitionSeries(80, 120, 'down');

    let signal = null;
    for (let i = 60; i <= candles.length; i++) {
      const s = strat.evaluate('TEST', candles.slice(0, i));
      if (s) {
        signal = s;
        break;
      }
    }
    expect(signal).not.toBeNull();
    if (signal) {
      expect(signal.type).toBe('momentum');
      expect(signal.side).toBe('sell');
      expect(signal.stopLoss).toBeGreaterThan(signal.entryPrice);
      expect(signal.takeProfit).toBeLessThan(signal.entryPrice);
    }
  });

  it('does not fire on a flat tape (regime gate blocks)', () => {
    const detector = new RegimeDetector();
    const strat = new MomentumStrategy(detector, {
      fastMaPeriod: 10,
      slowMaPeriod: 50,
      donchianPeriod: 15,
    });
    const candles = basingPhase(220);

    let fired = false;
    for (let i = 60; i <= candles.length; i++) {
      if (strat.evaluate('TEST', candles.slice(0, i))) {
        fired = true;
        break;
      }
    }
    expect(fired).toBe(false);
  });

  it('cooldown spaces re-fires roughly one Donchian window apart', () => {
    // A sustained trend prints fresh Donchian highs on every bar, so without
    // the `rearmBars` cooldown the strategy would emit one signal per bar.
    // With cooldown = donchianPeriod (15 bars here), 200 trend bars should
    // yield a small number of fires, each separated by ≥ donchianPeriod bars.
    const detector = new RegimeDetector();
    const donchianPeriod = 15;
    const strat = new MomentumStrategy(detector, {
      fastMaPeriod: 10,
      slowMaPeriod: 50,
      donchianPeriod,
    });
    const trendBars = 200;
    const candles = transitionSeries(80, trendBars, 'up');

    const fireBars: number[] = [];
    for (let i = 60; i <= candles.length; i++) {
      const s = strat.evaluate('TEST', candles.slice(0, i));
      if (s) fireBars.push(i);
    }
    expect(fireBars.length).toBeGreaterThan(0);
    // Hard cap: the cooldown guarantees fires are sparse — comfortably below
    // the one-per-bar avalanche we're guarding against.
    expect(fireBars.length).toBeLessThan(trendBars / 5);
    // Spacing: every consecutive pair of fires is at least `donchianPeriod`
    // bars apart. This is the load-bearing assertion — the count alone
    // could be satisfied by accident on a noisy series.
    for (let k = 1; k < fireBars.length; k++) {
      expect(fireBars[k] - fireBars[k - 1]).toBeGreaterThanOrEqual(donchianPeriod);
    }
  });
});
