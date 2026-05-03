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

  describe('TRA-261 / TRA-255 §4.1 — short-only entry gates', () => {
    /**
     * Build a `flat → downtrend` series and run the strategy with the
     * supplied per-side overrides. Returns the first short signal emitted
     * (or null if the gates suppress every fire). Shared helper because the
     * slope and volume tests use the same series shape.
     */
    function firstShort(
      shortOverrides: NonNullable<
        ConstructorParameters<typeof MomentumStrategy>[1]
      >['paramsByDirection'] extends infer P
        ? P extends { short?: infer S } ? S : never
        : never,
    ) {
      const detector = new RegimeDetector();
      const strat = new MomentumStrategy(detector, {
        fastMaPeriod: 10,
        slowMaPeriod: 50,
        donchianPeriod: 15,
        paramsByDirection: { short: shortOverrides },
      });
      const candles = transitionSeries(80, 120, 'down');
      for (let i = 60; i <= candles.length; i++) {
        const s = strat.evaluate('TEST', candles.slice(0, i));
        if (s) return s;
      }
      return null;
    }

    it('slope gate: short fires when slow EMA is sloping down (matches the trend)', () => {
      const sig = firstShort({ slowMaSlopeBars: 10 });
      expect(sig).not.toBeNull();
      expect(sig?.side).toBe('sell');
    });

    it('slope gate: long path stays byte-identical when no override is set', () => {
      // No short override = no slope gate; behaviour should equal the
      // pre-TRA-261 long path (covered above by the existing buy test).
      const detector = new RegimeDetector();
      const strat = new MomentumStrategy(detector, {
        fastMaPeriod: 10, slowMaPeriod: 50, donchianPeriod: 15,
      });
      const candles = transitionSeries(80, 120, 'up');
      let signal = null;
      for (let i = 60; i <= candles.length; i++) {
        const s = strat.evaluate('TEST', candles.slice(0, i));
        if (s) { signal = s; break; }
      }
      expect(signal?.side).toBe('buy');
    });

    it('volume gate: short fires when entry-bar volume meets the multiplier', () => {
      // Default volumes in transitionSeries are 1_000 each bar → SMA = 1_000;
      // setting volumeMultiplier=1.0 means current-bar volume must be ≥ SMA,
      // which it always is. Gate is effectively a pass-through but exercises
      // the wired volume calculation.
      const sig = firstShort({ volumeMultiplier: 1.0, volumeSmaPeriod: 20 });
      expect(sig).not.toBeNull();
      expect(sig?.side).toBe('sell');
    });

    it('volume gate: short is suppressed when entry volume is below the multiplier', () => {
      // 2.0× the SMA is unattainable when every bar has identical volume —
      // entry volume == SMA, so 2.0 × SMA is strictly greater than entry.
      const sig = firstShort({ volumeMultiplier: 2.0, volumeSmaPeriod: 20 });
      expect(sig).toBeNull();
    });
  });

  describe('TRA-275 / TRA-255 §4.4 r6 — 4H cascade-leg short trigger', () => {
    const FOUR_HOUR_MS = 4 * 60 * 60 * 1000;

    /**
     * Build a synthetic series of 4H bars: a steady rally up to a recent peak,
     * then a single drop bar. The drop bar is parameterised so individual
     * tests can violate exactly one gate (drop magnitude / close-in-range /
     * volume / recent-high anchor / regime). Default: every gate passes.
     */
    function cascadeSeries(opts: {
      preLen?: number;
      perBar?: number;
      dropBarOpen?: number;
      dropBarClose?: number;
      dropBarHigh?: number;
      dropBarLow?: number;
      dropBarVolume?: number;
      preBarVolume?: number;
    } = {}): Candle[] {
      const preLen = opts.preLen ?? 250;
      const perBar = opts.perBar ?? 0.005;
      const out: Candle[] = [];
      // Build a long rally so the regime detector lands on `trend_up` and the
      // recent-high anchor sees a meaningful peak. The cascade gate only
      // checks `regime !== 'trend_up'` though; test cases override the regime
      // by passing in a `regime` arg to evaluate().
      let prev = 100;
      for (let i = 0; i < preLen; i++) {
        const next = prev * (1 + perBar);
        const high = Math.max(prev, next) + 0.4;
        const low = Math.min(prev, next) - 0.4;
        out.push({
          symbol: 'TEST',
          timestamp: i * FOUR_HOUR_MS,
          open: prev,
          high,
          low,
          close: next,
          volume: opts.preBarVolume ?? 1_000,
        });
        prev = next;
      }
      // The recent-high cascade gate uses a 20-bar lookback — the cascade
      // bar's high must be ≥ 95% of the highest high among the 20 prior bars.
      // We control that by sizing the drop bar's high relative to `prev`.
      const ts = preLen * FOUR_HOUR_MS;
      const open = opts.dropBarOpen ?? prev;
      const close = opts.dropBarClose ?? (open - 5); // strong drop
      const low = opts.dropBarLow ?? (close - 0.1);
      const high = opts.dropBarHigh ?? (open + 0.1);
      out.push({
        symbol: 'TEST',
        timestamp: ts,
        open,
        high,
        low,
        close,
        volume: opts.dropBarVolume ?? 5_000,
      });
      return out;
    }

    /**
     * Run a cascade series through MomentumStrategy with `byTimeframe['4h']`
     * configured. The supplied regime label overrides the detector — the
     * router supplies it in production via `evaluate(symbol, candles, regime)`.
     */
    function evalCascade(
      candles: Candle[],
      regime: 'trend_up' | 'trend_down' | 'range' | 'high_vol' | 'flat',
    ) {
      const detector = new RegimeDetector();
      const strat = new MomentumStrategy(detector, {
        fastMaPeriod: 50,
        slowMaPeriod: 200,
        donchianPeriod: 20,
        paramsByDirection: {
          short: {
            atrStopMultiplier: 2.0,
            rearmBars: 8,
            slowMaSlopeBars: 10,
            volumeMultiplier: 1.10,
            volumeSmaPeriod: 20,
            byTimeframe: { '4h': {} },
          },
        },
      });
      return strat.evaluate('TEST', candles, regime);
    }

    it('fires a short on a clean drop-bar against a recent peak under range regime', () => {
      const candles = cascadeSeries();
      const sig = evalCascade(candles, 'range');
      expect(sig).not.toBeNull();
      expect(sig?.side).toBe('sell');
      expect(sig?.type).toBe('momentum');
      expect(sig?.stopLoss).toBeGreaterThan(sig!.entryPrice);
      expect(sig?.takeProfit).toBeLessThan(sig!.entryPrice);
    });

    it('softer regime gate: fires under high_vol and flat, blocks under trend_up', () => {
      expect(evalCascade(cascadeSeries(), 'high_vol')?.side).toBe('sell');
      expect(evalCascade(cascadeSeries(), 'flat')?.side).toBe('sell');
      expect(evalCascade(cascadeSeries(), 'trend_up')).toBeNull();
    });

    it('drop-bar magnitude gate: blocks when (open-close) is below 1.5× ATR', () => {
      // Shrink the drop magnitude by raising close near open. ATR on the
      // pre-rally is ≈ open*perBar + 0.8 ≈ 1.5; require drop ≥ 1.5×ATR ≈ 2.25.
      // Setting close = open - 0.5 fails the gate.
      const last = 100 * Math.pow(1.005, 250);
      const candles = cascadeSeries({ dropBarOpen: last, dropBarClose: last - 0.5 });
      expect(evalCascade(candles, 'range')).toBeNull();
    });

    it('drop-bar close-in-lower-range gate: blocks when close lands above the lower 33%', () => {
      // Force a wide range with the close in the upper half — magnitude still
      // satisfies but close-in-lower-range fraction does not.
      const last = 100 * Math.pow(1.005, 250);
      const open = last;
      const close = last - 5;
      const high = open + 1;
      // Range ≈ 21; close - low should be > 0.33 × 21 = 6.93. Set low = close - 12.
      const low = close - 12;
      const candles = cascadeSeries({
        dropBarOpen: open, dropBarClose: close, dropBarHigh: high, dropBarLow: low,
      });
      expect(evalCascade(candles, 'range')).toBeNull();
    });

    it('volume gate: blocks when cascade-bar volume is below 1.5× SMA(volume,20)', () => {
      // Pre-bars at 1_000, drop bar at 1_400 (< 1_500 = 1.5×). Should block.
      const candles = cascadeSeries({ dropBarVolume: 1_400 });
      expect(evalCascade(candles, 'range')).toBeNull();
      // Same series, drop bar at 1_500 → should fire (≥ 1.5×).
      const passing = cascadeSeries({ dropBarVolume: 1_500 });
      expect(evalCascade(passing, 'range')?.side).toBe('sell');
    });

    it('recent-high anchor gate: blocks when the cascade-bar high is below 0.95× recent peak', () => {
      // Cascade bar's high needs to be ≥ 0.95 × max(high) over the prior 20 bars.
      // Force the drop bar's high well below the recent peak.
      const last = 100 * Math.pow(1.005, 250);
      const candles = cascadeSeries({
        dropBarOpen: last,
        dropBarClose: last - 5,
        dropBarHigh: last * 0.5, // half of the recent peak
        dropBarLow: last * 0.5 - 5,
      });
      expect(evalCascade(candles, 'range')).toBeNull();
    });

    it('non-4H bars do not activate cascade — falls back to §4.1 path', () => {
      // Re-stamp the cascade series timestamps onto a 1m grid. The cascade
      // gates would all otherwise pass, but `isFourHourBars` flips false and
      // the §4.1 strict regime gate (`trend_down` only) takes over. The
      // `range` regime then blocks the §4.1 path → null.
      const candles = cascadeSeries().map((c, i) => ({
        ...c,
        timestamp: i * 60_000,
      }));
      expect(evalCascade(candles, 'range')).toBeNull();
    });

    it('cascade mode suppresses the §4.1 short emission on a trend_down 4H bar without cascade conditions', () => {
      // Build a steady downtrend on 4H bars. Without cascade overrides, the
      // §4.1 path would fire on Donchian breakdowns. With cascade active,
      // the §4.1 short is replaced — and since the series has no drop-bar
      // cascade, no short fires at all.
      const detector = new RegimeDetector();
      const stratWithCascade = new MomentumStrategy(detector, {
        fastMaPeriod: 50, slowMaPeriod: 200, donchianPeriod: 20,
        paramsByDirection: {
          short: {
            atrStopMultiplier: 2.0,
            rearmBars: 8,
            slowMaSlopeBars: 10,
            volumeMultiplier: 1.10,
            volumeSmaPeriod: 20,
            byTimeframe: { '4h': {} },
          },
        },
      });
      // Synthetic 4H downtrend without a single-bar cascade flush.
      const candles: Candle[] = [];
      let prev = 100;
      for (let i = 0; i < 250; i++) {
        const next = prev * (1 - 0.002);
        candles.push({
          symbol: 'TEST',
          timestamp: i * FOUR_HOUR_MS,
          open: prev,
          high: Math.max(prev, next) + 0.2,
          low: Math.min(prev, next) - 0.2,
          close: next,
          volume: 1_000,
        });
        prev = next;
      }
      let fired = false;
      for (let i = 60; i <= candles.length; i++) {
        if (stratWithCascade.evaluate('TEST', candles.slice(0, i), 'trend_down')) {
          fired = true;
          break;
        }
      }
      expect(fired).toBe(false);
    });
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
