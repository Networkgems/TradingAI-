import { describe, it, expect } from 'vitest';
import { atr, atrPct } from './atr.js';
import type { Candle } from '@trading-app/shared';

function bar(high: number, low: number, close: number, open = close): Candle {
  return { symbol: 'TEST', timestamp: 0, open, high, low, close, volume: 1_000 };
}

describe('atr', () => {
  it('returns null when there are not enough candles', () => {
    const candles = Array.from({ length: 10 }, () => bar(101, 99, 100));
    expect(atr(candles, 14)).toBeNull();
  });

  it('returns null when candle count equals period (need period+1 for TR series)', () => {
    const candles = Array.from({ length: 14 }, () => bar(101, 99, 100));
    expect(atr(candles, 14)).toBeNull();
  });

  it('returns the constant true range for flat-volatility series', () => {
    // Each bar has high-low = 2, prev close = 100, so TR = 2 every bar.
    const candles = Array.from({ length: 30 }, () => bar(101, 99, 100));
    const value = atr(candles, 14);
    expect(value).not.toBeNull();
    expect(value!).toBeCloseTo(2, 6);
  });

  it('grows when realized volatility increases', () => {
    const calmBars: Candle[] = Array.from({ length: 30 }, () => bar(100.5, 99.5, 100));
    const volatileBars: Candle[] = Array.from({ length: 30 }, () => bar(105, 95, 100));

    const calm = atr(calmBars, 14)!;
    const volatile = atr(volatileBars, 14)!;
    expect(volatile).toBeGreaterThan(calm);
  });

  it('captures gaps via |high - prevClose| and |low - prevClose|', () => {
    // 14 quiet bars at 100, then a gap-up bar that opens way above prev close.
    const calm: Candle[] = Array.from({ length: 14 }, () => bar(100.1, 99.9, 100));
    const gap: Candle = bar(120, 119, 119.5, 119);
    const value = atr([...calm, gap], 14)!;

    // TR for the gap bar = max(1, |120 - 100|, |119 - 100|) = 20.
    // After one Wilder step seeded with the calm TR (~0.2):
    //   atr = (0.2 * 13 + 20) / 14 ≈ 1.614
    expect(value).toBeGreaterThan(1.5);
    expect(value).toBeLessThan(1.8);
  });
});

describe('atrPct', () => {
  it('returns null when atr is unavailable', () => {
    expect(atrPct([bar(101, 99, 100)], 14)).toBeNull();
  });

  it('returns the ratio of ATR to the latest close', () => {
    const candles = Array.from({ length: 30 }, () => bar(101, 99, 100));
    const value = atrPct(candles, 14);
    expect(value).not.toBeNull();
    expect(value!).toBeCloseTo(0.02, 6); // 2 / 100
  });
});
