import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  maPullbackScalp,
  retracementWinRate,
  SCALP_TIERS,
  SCALP_DEFAULTS,
} from './ma-pullback-scalp.js';

/** Deterministic OHLC builder; timestamps are +1m per bar from a fixed origin. */
const ORIGIN = Date.UTC(2026, 0, 1, 13, 30);
const MIN = 60_000;
function bar(i: number, open: number, high: number, low: number, close: number): Candle {
  return { symbol: 'TEST', timestamp: ORIGIN + i * MIN, open, high, low, close, volume: 1_000 };
}

/** A flat run of `n` candles at a constant price (for MA warm-up / slope priming). */
function flat(price: number, n: number, fromIndex = 0): Candle[] {
  return Array.from({ length: n }, (_, k) => bar(fromIndex + k, price, price, price, price));
}

describe('retracementWinRate', () => {
  it('returns the video ladder probabilities at the exact tiers', () => {
    expect(retracementWinRate(0.25)).toBeCloseTo(0.9, 6);
    expect(retracementWinRate(0.5)).toBeCloseTo(0.6, 6);
    expect(retracementWinRate(0.75)).toBeCloseTo(0.2, 6);
    expect(retracementWinRate(1.0)).toBeCloseTo(0.1, 6);
  });

  it('is flat below 25% and above 100%', () => {
    expect(retracementWinRate(0.1)).toBeCloseTo(0.9, 6);
    expect(retracementWinRate(1.5)).toBeCloseTo(0.1, 6);
  });

  it('interpolates linearly between tiers', () => {
    // Midway between 25% (0.90) and 50% (0.60) → 0.75.
    expect(retracementWinRate(0.375)).toBeCloseTo(0.75, 6);
  });
});

describe('maPullbackScalp — guards', () => {
  it('returns none without enough bars to read the MA slope', () => {
    const sig = maPullbackScalp(flat(100, 10), { maPeriod: 20 });
    expect(sig.setup).toBe('none');
    expect(sig.ma).toBeNull();
  });

  it('returns none with a flat MA (no trend)', () => {
    const sig = maPullbackScalp(flat(100, 40));
    expect(sig.setup).toBe('none');
    expect(sig.trend).toBe('flat');
    expect(sig.ma).toBeCloseTo(100, 6);
  });
});

// A valid OHLC bar around an open/close pair (wicks 1pt either side).
function tail(i: number, open: number, close: number): Candle {
  return bar(i, open, Math.max(open, close) + 1, Math.min(open, close) - 1, close);
}
// Isolate the sharp impulse from the trend ramp with a short swing window.
const SHORT: { swingLookback: number } = { swingLookback: 3 };

describe('maPullbackScalp — downtrend scalp long', () => {
  // Build a clean downtrend: MA slopes down, then a sharp drop stretched below
  // the MA, then a bounce off the low whose close is `closePrice`.
  function downtrendBounce(closePrice: number): Candle[] {
    const out: Candle[] = [];
    // 25 bars stepping down from 200 → ~104 so the 20-MA slopes firmly down.
    for (let i = 0; i < 25; i++) {
      const p = 200 - i * 4;
      out.push(bar(i, p, p + 0.5, p - 0.5, p));
    }
    // Sharp drop impulse: high 110 → low 90 (impulse 20), far below the MA.
    out.push(bar(25, 110, 110, 90, 95));
    // Latest bar: a bounce up off 95 that closes at `closePrice`.
    out.push(tail(26, 95, closePrice));
    return out;
  }

  it('flags scalp_long with the 25% target and ~90% win probability', () => {
    // Close 92 → 10% retracement: below the 25% level (95), target still ahead.
    const sig = maPullbackScalp(downtrendBounce(92), SHORT);
    expect(sig.setup).toBe('scalp_long');
    expect(sig.trend).toBe('down');
    expect(sig.impulseLow).toBe(90);
    expect(sig.impulseHigh).toBe(110);
    // 25% of the 90→110 impulse = 95.
    expect(sig.target).toBeCloseTo(95, 6);
    expect(sig.stop).toBe(90);
    expect(sig.winProbability).toBeCloseTo(0.9, 6);
    expect(sig.riskReward).toBeGreaterThan(0);
  });

  it('prices the full retracement ladder against the impulse', () => {
    const sig = maPullbackScalp(downtrendBounce(92), SHORT);
    expect(sig.tiers).toHaveLength(4);
    expect(sig.tiers[0]).toMatchObject({ retracement: 0.25, probability: 0.9, price: 95 });
    expect(sig.tiers[1].price).toBeCloseTo(100, 6); // 50%
    expect(sig.tiers[2].price).toBeCloseTo(105, 6); // 75%
    expect(sig.tiers[3].price).toBeCloseTo(110, 6); // 100%
  });

  it('switches to reversal_long once the bounce runs past 75%', () => {
    // Close 107 → retracement (107−90)/20 = 85% > 75%.
    const sig = maPullbackScalp(downtrendBounce(107), SHORT);
    expect(sig.setup).toBe('reversal_long');
    expect(sig.stop).toBe(90); // structure low becomes the swing stop
    expect(sig.riskReward).toBeCloseTo(SCALP_DEFAULTS.swingRiskReward, 6);
    // target = entry + 3R = 107 + 3*(107−90) = 158.
    expect(sig.target).toBeCloseTo(158, 6);
    expect(sig.winProbability).toBeNull();
  });

  it('offers no fresh scalp in the dead zone between 25% and the reversal line', () => {
    // Close 100 → 50% retracement: past the 25% target, below the 75% reversal.
    const sig = maPullbackScalp(downtrendBounce(100), SHORT);
    expect(sig.setup).toBe('none');
    expect(sig.retracement).toBeCloseTo(0.5, 6);
    expect(sig.impulseLow).toBe(90); // structural read still populated
  });
});

describe('maPullbackScalp — uptrend scalp short', () => {
  function uptrendFade(closePrice: number): Candle[] {
    const out: Candle[] = [];
    // 25 bars stepping up from 100 → ~196 so the 20-MA slopes firmly up.
    for (let i = 0; i < 25; i++) {
      const p = 100 + i * 4;
      out.push(bar(i, p, p + 0.5, p - 0.5, p));
    }
    // Sharp rise impulse: low 190 → high 210 (impulse 20), far above the MA.
    out.push(bar(25, 190, 210, 190, 205));
    // Latest bar: a fade down off 205 that closes at `closePrice`.
    out.push(tail(26, 205, closePrice));
    return out;
  }

  it('flags scalp_short with the 25% target and ~90% win probability', () => {
    // Close 208 → 10% retracement: below the 25% level (205), target still ahead.
    const sig = maPullbackScalp(uptrendFade(208), SHORT);
    expect(sig.setup).toBe('scalp_short');
    expect(sig.trend).toBe('up');
    expect(sig.impulseHigh).toBe(210);
    expect(sig.impulseLow).toBe(190);
    // 25% fade of the 190→210 impulse = 205.
    expect(sig.target).toBeCloseTo(205, 6);
    expect(sig.stop).toBe(210);
    expect(sig.winProbability).toBeCloseTo(0.9, 6);
  });

  it('switches to reversal_short once the fade runs past 75%', () => {
    // Close 193 → retracement (210−193)/20 = 85% > 75%.
    const sig = maPullbackScalp(uptrendFade(193), SHORT);
    expect(sig.setup).toBe('reversal_short');
    expect(sig.stop).toBe(210);
    // target = entry − 3R = 193 − 3*(210−193) = 142.
    expect(sig.target).toBeCloseTo(142, 6);
  });
});

describe('maPullbackScalp — deviation gate', () => {
  it('returns none when the impulse is not stretched far from the MA', () => {
    const sig = maPullbackScalp(flat(100, 26).concat(bar(26, 100, 100.2, 99.9, 100)), {
      minDeviationPct: 0.05, // demand a 5% stretch that this quiet tape never makes
    });
    expect(sig.setup).toBe('none');
  });
});

describe('SCALP_TIERS', () => {
  it('matches the video back-test ladder', () => {
    expect(SCALP_TIERS.map((t) => [t.retracement, t.probability])).toEqual([
      [0.25, 0.9],
      [0.5, 0.6],
      [0.75, 0.2],
      [1.0, 0.1],
    ]);
  });
});
