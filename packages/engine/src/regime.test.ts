import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { RegimeDetector, classifyRegime } from './regime.js';

/**
 * Synthetic candle helpers. We deliberately keep these primitive (deterministic
 * `seededRandom`, no fancy Brownian motion) so that test failures can be debugged
 * by inspecting the input series, and so that thresholds in `regime.ts` can be
 * tuned without surprising regressions from a stochastic generator.
 */

function seededRandom(seed: number): () => number {
  let s = seed | 0;
  return () => {
    s = (s * 1664525 + 1013904223) | 0;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

function makeCandle(close: number, range: number, prevClose: number): Candle {
  const high = Math.max(close, prevClose) + range / 2;
  const low = Math.min(close, prevClose) - range / 2;
  return {
    symbol: 'TEST',
    timestamp: 0,
    open: prevClose,
    high,
    low,
    close,
    volume: 1_000,
  };
}

function trendUpSeries(length: number, start = 100, perBar = 0.005, range = 0.5): Candle[] {
  const out: Candle[] = [];
  let prev = start;
  for (let i = 0; i < length; i++) {
    const next = prev * (1 + perBar);
    out.push(makeCandle(next, range, prev));
    prev = next;
  }
  return out;
}

function trendDownSeries(length: number, start = 100, perBar = 0.005, range = 0.5): Candle[] {
  return trendUpSeries(length, start, -perBar, range);
}

function rangeSeries(length: number, mid = 100, amplitude = 1.5, period = 12): Candle[] {
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < length; i++) {
    const next = mid + amplitude * Math.sin((i / period) * Math.PI * 2);
    out.push(makeCandle(next, 0.4, prev));
    prev = next;
  }
  return out;
}

function flatSeries(length: number, mid = 100): Candle[] {
  const out: Candle[] = [];
  let prev = mid;
  for (let i = 0; i < length; i++) {
    // Almost-zero range: ATR/close stays well below the 0.5% volatility floor.
    const next = mid + (i % 2 === 0 ? 0.001 : -0.001);
    out.push(makeCandle(next, 0.005, prev));
    prev = next;
  }
  return out;
}

function highVolSeries(quietBars: number, spikeBars: number, mid = 100): Candle[] {
  const rng = seededRandom(42);
  const out: Candle[] = [];
  let prev = mid;
  // Quiet build-up: small symmetric noise so ADX stays low and ATR is tiny.
  for (let i = 0; i < quietBars; i++) {
    const next = mid + (rng() - 0.5) * 0.6;
    out.push(makeCandle(next, 0.4, prev));
    prev = next;
  }
  // Volatility expansion: large alternating moves around the same mean so the
  // bar ranges (and TRs) blow up while ADX stays in the dead zone.
  for (let i = 0; i < spikeBars; i++) {
    const sign = i % 2 === 0 ? 1 : -1;
    const next = mid + sign * 8;
    out.push(makeCandle(next, 6, prev));
    prev = next;
  }
  return out;
}

describe('classifyRegime', () => {
  it('returns flat when there is not enough data to compute ADX/ATR', () => {
    const tiny = trendUpSeries(10);
    expect(classifyRegime(tiny)).toBe('flat');
  });

  it('labels a strong steady uptrend as trend_up', () => {
    const candles = trendUpSeries(200, 100, 0.01, 0.4);
    expect(classifyRegime(candles)).toBe('trend_up');
  });

  it('labels a strong steady downtrend as trend_down', () => {
    const candles = trendDownSeries(200, 100, 0.01, 0.4);
    expect(classifyRegime(candles)).toBe('trend_down');
  });

  it('labels a sustained sine-wave oscillation around a mean as range', () => {
    const candles = rangeSeries(200, 100, 1.5, 12);
    expect(classifyRegime(candles)).toBe('range');
  });

  it('labels a near-zero-range tape as flat (volatility floor)', () => {
    const candles = flatSeries(200);
    expect(classifyRegime(candles)).toBe('flat');
  });

  it('labels a quiet-then-explosive series as high_vol', () => {
    const candles = highVolSeries(120, 12);
    expect(classifyRegime(candles)).toBe('high_vol');
  });
});

describe('RegimeDetector hysteresis', () => {
  it('does not flip on a single bar of disagreement', () => {
    // Build a clean uptrend and confirm trend_up takes hold first.
    const upBase = trendUpSeries(200, 100, 0.01, 0.4);
    const detector = new RegimeDetector();

    let last: string = 'flat';
    for (let i = 60; i <= upBase.length; i++) {
      last = detector.update(upBase.slice(0, i));
    }
    expect(last).toBe('trend_up');

    // One brief contrarian bar: the candidate may temporarily disagree, but the
    // active regime should not flip without `flipBars` consecutive agreement.
    const oneBarReversal: Candle[] = [
      ...upBase,
      makeCandle(upBase[upBase.length - 1].close * 0.92, 5, upBase[upBase.length - 1].close),
    ];
    const stillTrend = detector.update(oneBarReversal);
    expect(stillTrend).toBe('trend_up');
  });

  it('flips trend_up → trend_down only after sustained reversal', () => {
    const detector = new RegimeDetector();

    const upBase = trendUpSeries(200, 100, 0.01, 0.4);
    // Warm up to trend_up.
    for (let i = 60; i <= upBase.length; i++) detector.update(upBase.slice(0, i));
    expect(detector.current()).toBe('trend_up');

    // Append a sustained downtrend continuation. Hysteresis (3 bars) plus the
    // 2-bar cooldown means the flip can take a handful of bars to register —
    // we just assert that it eventually flips, not the exact bar.
    const reversed: Candle[] = [...upBase];
    let prevClose = reversed[reversed.length - 1].close;
    let flipped = false;
    for (let i = 0; i < 80; i++) {
      const next = prevClose * 0.99;
      reversed.push(makeCandle(next, 0.6, prevClose));
      prevClose = next;
      const label = detector.update(reversed);
      if (label === 'trend_down') {
        flipped = true;
        break;
      }
    }
    expect(flipped).toBe(true);
  });

  it('leaves flat faster than it flips between live regimes', () => {
    // Two detectors on the same data: one default (`flatExitBars = 2`,
    // `flipBars = 3`), one with `flatExitBars = flipBars = 3`. Coming out of
    // flat, the default should reach the new label no later than the strict
    // detector — this is the "re-engage faster" guarantee from the spec.
    const flat = flatSeries(120);
    const continuation = trendUpSeries(40, flat[flat.length - 1].close, 0.01, 0.4);
    const tape: Candle[] = [...flat, ...continuation];

    const fast = new RegimeDetector();
    const strict = new RegimeDetector({ flatExitBars: 3 });

    let fastLeft = -1;
    let strictLeft = -1;
    for (let i = 60; i <= tape.length; i++) {
      const slice = tape.slice(0, i);
      if (fast.update(slice) !== 'flat' && fastLeft === -1) fastLeft = i;
      if (strict.update(slice) !== 'flat' && strictLeft === -1) strictLeft = i;
    }

    expect(fastLeft).toBeGreaterThan(0);
    expect(strictLeft).toBeGreaterThan(0);
    expect(fastLeft).toBeLessThanOrEqual(strictLeft);
  });

  it('starts in flat and exposes current() without consuming a bar', () => {
    const detector = new RegimeDetector();
    expect(detector.current()).toBe('flat');
    detector.update(trendUpSeries(60));
    expect(detector.current()).toBe(detector.current());
  });

  it('reset() clears active state and streak', () => {
    const detector = new RegimeDetector();
    const candles = trendUpSeries(200, 100, 0.01, 0.4);
    for (let i = 60; i <= candles.length; i++) detector.update(candles.slice(0, i));
    expect(detector.current()).not.toBe('flat');
    detector.reset();
    expect(detector.current()).toBe('flat');
  });
});
