import { describe, it, expect } from 'vitest';
import { choppinessIndex } from './choppiness.js';
import type { Candle } from '@trading-app/shared';

function bar(high: number, low: number, close: number, open = close): Candle {
  return { symbol: 'TEST', timestamp: 0, open, high, low, close, volume: 1_000 };
}

describe('choppinessIndex', () => {
  it('returns null when there are fewer than period+1 candles', () => {
    const candles = Array.from({ length: 14 }, () => bar(101, 99, 100));
    expect(choppinessIndex(candles, 14)).toBeNull();
  });

  it('returns null for a degenerate (flat) range where maxHigh == minLow', () => {
    // Every bar identical H==L==C ⇒ envelope 0 AND sumTr 0 ⇒ div-by-zero guard.
    const candles = Array.from({ length: 20 }, () => bar(100, 100, 100));
    expect(choppinessIndex(candles, 14)).toBeNull();
  });

  it('is HIGH (near 100) for an oscillating, range-bound series', () => {
    // Price ping-pongs inside a tight [99,101] band: lots of path, small envelope.
    const candles: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const up = i % 2 === 0;
      candles.push(up ? bar(101, 99, 101) : bar(101, 99, 99));
    }
    const chop = choppinessIndex(candles, 14);
    expect(chop).not.toBeNull();
    expect(chop!).toBeGreaterThan(80);
  });

  it('is LOW (near 0) for a clean one-directional trend', () => {
    // Steady march up: envelope ≈ total path ⇒ ratio ≈ 1 ⇒ CHOP ≈ 0.
    const candles: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 40; i++) {
      const close = price + 2;
      candles.push(bar(close, price, close, price));
      price = close;
    }
    const chop = choppinessIndex(candles, 14);
    expect(chop).not.toBeNull();
    expect(chop!).toBeLessThan(40);
  });

  it('ranks a range-bound series above a trending one', () => {
    const range: Candle[] = [];
    for (let i = 0; i < 40; i++) range.push(i % 2 === 0 ? bar(101, 99, 101) : bar(101, 99, 99));
    const trend: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 40; i++) {
      const c = p + 2;
      trend.push(bar(c, p, c, p));
      p = c;
    }
    expect(choppinessIndex(range, 14)!).toBeGreaterThan(choppinessIndex(trend, 14)!);
  });

  it('returns null for a non-integer or non-positive period', () => {
    const candles = Array.from({ length: 40 }, () => bar(101, 99, 100));
    expect(choppinessIndex(candles, 0)).toBeNull();
    expect(choppinessIndex(candles, 2.5)).toBeNull();
  });
});
