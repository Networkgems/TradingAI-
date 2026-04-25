import { describe, it, expect } from 'vitest';
import { rsi, rsiDivergence } from '../indicators/rsi.js';
import { detectPattern, isBullishPattern, isBearishPattern } from '../indicators/patterns.js';
import { VwapTracker } from '../indicators/vwap.js';
import type { Candle } from '@trading-app/shared';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeCandle(close: number, opts?: Partial<Candle>): Candle {
  return {
    symbol: 'TEST',
    timestamp: Date.now(),
    open: opts?.open ?? close,
    high: opts?.high ?? close * 1.005,
    low: opts?.low ?? close * 0.995,
    close,
    volume: opts?.volume ?? 1_000,
  };
}

// ─── RSI ──────────────────────────────────────────────────────────────────────

describe('rsi', () => {
  it('returns NaN when insufficient data', () => {
    expect(rsi([1, 2, 3], 14)).toBeNaN();
  });

  it('returns 100 when there are no losses', () => {
    const closes = Array.from({ length: 16 }, (_, i) => i + 1);
    expect(rsi(closes)).toBe(100);
  });

  it('returns 0 when there are no gains', () => {
    const closes = Array.from({ length: 16 }, (_, i) => 16 - i);
    expect(rsi(closes)).toBe(0);
  });

  it('returns ~50 for alternating up/down', () => {
    const closes = Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? 100 : 101));
    const val = rsi(closes);
    expect(val).toBeGreaterThan(40);
    expect(val).toBeLessThan(60);
  });

  it('returns overbought value (>70) for sustained rally', () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113, 114, 115];
    expect(rsi(closes, 14)).toBeGreaterThan(70);
  });

  it('returns oversold value (<30) for sustained decline', () => {
    const closes = [115, 114, 113, 112, 111, 110, 109, 108, 107, 106, 105, 104, 103, 102, 101, 100];
    expect(rsi(closes, 14)).toBeLessThan(30);
  });
});

describe('rsiDivergence', () => {
  it('returns null when data is insufficient', () => {
    expect(rsiDivergence([1, 2], 14, 5)).toBeNull();
  });
});

// ─── Candlestick patterns ──────────────────────────────────────────────────────

describe('detectPattern', () => {
  it('returns null with fewer than 2 candles', () => {
    expect(detectPattern([makeCandle(100)])).toBeNull();
  });

  it('detects doji (body < 10% of range)', () => {
    const candle = makeCandle(100, { open: 100.05, high: 102, low: 98, close: 99.95 });
    const prev = makeCandle(100);
    expect(detectPattern([prev, candle])).toBe('doji');
  });

  it('detects hammer (bullish candle, long lower wick)', () => {
    // body=2, range=8.1, body/range≈0.25 → not doji; lowerWick=6 > body*2=4 → hammer
    const candle: Candle = {
      symbol: 'TEST', timestamp: 0,
      open: 100, high: 102.1, low: 94, close: 102, volume: 1000,
    };
    const prev = makeCandle(101);
    const p = detectPattern([prev, candle]);
    expect(p).toBe('hammer');
    expect(isBullishPattern(p)).toBe(true);
  });

  it('detects shooting_star (bearish candle, long upper wick)', () => {
    const candle: Candle = {
      symbol: 'TEST', timestamp: 0,
      open: 101, high: 107, low: 100.5, close: 100, volume: 1000,
    };
    const prev = makeCandle(100);
    const p = detectPattern([prev, candle]);
    expect(p).toBe('shooting_star');
    expect(isBearishPattern(p)).toBe(true);
  });

  it('detects bullish_engulfing', () => {
    const prev: Candle = { symbol: 'T', timestamp: 0, open: 105, high: 106, low: 99, close: 100, volume: 1000 };
    const current: Candle = { symbol: 'T', timestamp: 1, open: 99, high: 107, low: 98, close: 106, volume: 1000 };
    const p = detectPattern([prev, current]);
    expect(p).toBe('bullish_engulfing');
    expect(isBullishPattern(p)).toBe(true);
  });

  it('detects bearish_engulfing', () => {
    const prev: Candle = { symbol: 'T', timestamp: 0, open: 100, high: 107, low: 99, close: 106, volume: 1000 };
    const current: Candle = { symbol: 'T', timestamp: 1, open: 107, high: 108, low: 98, close: 99, volume: 1000 };
    const p = detectPattern([prev, current]);
    expect(p).toBe('bearish_engulfing');
    expect(isBearishPattern(p)).toBe(true);
  });
});

// ─── VWAP ─────────────────────────────────────────────────────────────────────

describe('VwapTracker', () => {
  it('computes VWAP correctly for a single candle', () => {
    const tracker = new VwapTracker();
    const candle: Candle = { symbol: 'T', timestamp: 0, open: 99, high: 101, low: 99, close: 100, volume: 1000 };
    const state = tracker.update(candle);
    // typical price = (101 + 99 + 100) / 3 = 100
    expect(state.vwap).toBeCloseTo(100);
    expect(state.stdDev).toBe(0);
  });

  it('detects price extended above VWAP band', () => {
    const tracker = new VwapTracker();
    const candles = [
      { symbol: 'T', timestamp: 0, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
      { symbol: 'T', timestamp: 1, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
      { symbol: 'T', timestamp: 2, open: 100, high: 101, low: 99, close: 100, volume: 5000 },
    ] satisfies Candle[];

    let state = tracker.update(candles[0]);
    state = tracker.update(candles[1]);
    state = tracker.update(candles[2]);

    // Force a clearly extended price
    expect(tracker.isExtended(state.upperBand + 10, state)).toBe('above');
    expect(tracker.isExtended(state.lowerBand - 10, state)).toBe('below');
    expect(tracker.isExtended(state.vwap, state)).toBeNull();
  });

  it('resets properly', () => {
    const tracker = new VwapTracker();
    const c: Candle = { symbol: 'T', timestamp: 0, open: 100, high: 102, low: 98, close: 100, volume: 1000 };
    tracker.update(c);
    tracker.reset();
    const state = tracker.update(c);
    expect(state.stdDev).toBe(0);
  });
});
