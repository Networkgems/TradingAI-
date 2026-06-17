import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { detectMultiBarPattern, isBullishPattern, isBearishPattern } from './patterns.js';

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 1, 9, 30);

function bar(open: number, high: number, low: number, close: number, i: number): Candle {
  return { symbol: 'TEST', timestamp: BASE + i * HOUR, open, high, low, close, volume: 1_000 };
}
function flat(p: number, i: number): Candle {
  return bar(p, p + 0.01, p - 0.01, p, i);
}

/** Build a minimal swing descriptor (kind: 'high' or 'low'). */
function swing(price: number, kind: 'high' | 'low', index: number) {
  return { price, kind, index };
}

describe('detectMultiBarPattern — swing_failure', () => {
  it('returns swing_failure (long) when current bar undercuts a prior low but closes above it', () => {
    const candles = [
      flat(100, 0),
      flat(100, 1),
      bar(101, 102, 95, 101, 2), // current: low dips to 95, closes at 101
    ];
    const swings = [swing(97, 'low', 1)]; // prior low at 97
    const result = detectMultiBarPattern(candles, swings, 'long');
    expect(result).toBe('swing_failure');
  });

  it('returns swing_failure (short) when current bar exceeds a prior high but closes below it', () => {
    const candles = [
      flat(100, 0),
      flat(100, 1),
      bar(99, 108, 98, 99, 2), // current: high pokes to 108, closes at 99
    ];
    const swings = [swing(105, 'high', 1)]; // prior high at 105
    const result = detectMultiBarPattern(candles, swings, 'short');
    expect(result).toBe('swing_failure');
  });

  it('does NOT trigger if bar closes above the swing high on a short side', () => {
    // current close > swing high → not a rejection
    const candles = [flat(100, 0), flat(100, 1), bar(99, 108, 98, 107, 2)];
    const swings = [swing(105, 'high', 1)];
    expect(detectMultiBarPattern(candles, swings, 'short')).not.toBe('swing_failure');
  });
});

describe('detectMultiBarPattern — inverse_head_and_shoulders', () => {
  it('detects inverse H&S: three lows where middle is lowest and shoulders are even', () => {
    const candles = [flat(100, 0), flat(100, 1), flat(100, 2)];
    const swings = [
      swing(96, 'low', 0),  // left shoulder
      swing(90, 'low', 1),  // head — lowest
      swing(96, 'low', 2),  // right shoulder (roughly symmetric)
    ];
    expect(detectMultiBarPattern(candles, swings, 'long')).toBe('inverse_head_and_shoulders');
  });

  it('does NOT detect inv H&S when the middle low is not the deepest', () => {
    const candles = [flat(100, 0), flat(100, 1), flat(100, 2)];
    const swings = [
      swing(90, 'low', 0),  // deepest at left, not middle
      swing(96, 'low', 1),
      swing(95, 'low', 2),
    ];
    expect(detectMultiBarPattern(candles, swings, 'long')).not.toBe('inverse_head_and_shoulders');
  });
});

describe('detectMultiBarPattern — head_and_shoulders', () => {
  it('detects H&S: three highs where middle is highest and shoulders are even', () => {
    const candles = [flat(100, 0), flat(100, 1), flat(100, 2)];
    const swings = [
      swing(104, 'high', 0), // left shoulder
      swing(110, 'high', 1), // head — tallest
      swing(104, 'high', 2), // right shoulder
    ];
    expect(detectMultiBarPattern(candles, swings, 'short')).toBe('head_and_shoulders');
  });
});

describe('detectMultiBarPattern — double_bottom / double_top', () => {
  it('detects double_bottom when two lows are within cluster tolerance', () => {
    const ref = 100;
    const tol = ref * 0.006; // default 0.6%
    const candles = [flat(ref, 0), flat(ref, 1), flat(ref, 2)];
    const swings = [
      swing(95.0, 'low', 0),
      swing(95.0 + tol * 0.5, 'low', 1), // within tolerance
    ];
    expect(detectMultiBarPattern(candles, swings, 'long')).toBe('double_bottom');
  });

  it('does NOT detect double_bottom when lows are too far apart', () => {
    const ref = 100;
    const tol = ref * 0.006;
    const candles = [flat(ref, 0), flat(ref, 1), flat(ref, 2)];
    const swings = [
      swing(95.0, 'low', 0),
      swing(95.0 + tol * 3, 'low', 1), // outside tolerance
    ];
    expect(detectMultiBarPattern(candles, swings, 'long')).not.toBe('double_bottom');
  });

  it('detects double_top when two highs are within cluster tolerance', () => {
    const ref = 100;
    const tol = ref * 0.006;
    const candles = [flat(ref, 0), flat(ref, 1), flat(ref, 2)];
    const swings = [
      swing(105.0, 'high', 0),
      swing(105.0 + tol * 0.5, 'high', 1),
    ];
    expect(detectMultiBarPattern(candles, swings, 'short')).toBe('double_top');
  });
});

describe('detectMultiBarPattern — lookback window', () => {
  it('ignores swings outside the lookbackBars window', () => {
    // Current bar is index 50; lookbackBars=10 so only indices >= 40 matter.
    const candles = Array.from({ length: 51 }, (_, i) => flat(100, i));
    const swings = [swing(97, 'low', 5)]; // index 5 is outside the window
    expect(detectMultiBarPattern(candles, swings, 'long', { lookbackBars: 10 })).toBeNull();
  });
});

describe('detectMultiBarPattern — returns null when nothing qualifies', () => {
  it('returns null when no swings are provided', () => {
    const candles = [flat(100, 0), flat(100, 1)];
    expect(detectMultiBarPattern(candles, [], 'long')).toBeNull();
  });
});

describe('isBullishPattern / isBearishPattern updated for multi-bar types', () => {
  it('classifies inverse_head_and_shoulders and double_bottom as bullish', () => {
    expect(isBullishPattern('inverse_head_and_shoulders')).toBe(true);
    expect(isBullishPattern('double_bottom')).toBe(true);
    expect(isBullishPattern('swing_failure')).toBe(true);
  });

  it('classifies head_and_shoulders and double_top as bearish', () => {
    expect(isBearishPattern('head_and_shoulders')).toBe(true);
    expect(isBearishPattern('double_top')).toBe(true);
    expect(isBearishPattern('swing_failure')).toBe(true);
  });
});
