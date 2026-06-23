import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  emaPullbackTrigger,
  volumeConfirmedBreakout,
} from './swing-entries.js';

function candle(partial: Partial<Candle> & { close: number }): Candle {
  const c = partial.close;
  return {
    symbol: partial.symbol ?? 'TEST',
    timestamp: partial.timestamp ?? 0,
    open: partial.open ?? c,
    high: partial.high ?? Math.max(partial.open ?? c, c),
    low: partial.low ?? Math.min(partial.open ?? c, c),
    close: c,
    volume: partial.volume ?? 1000,
  };
}

/** Rising series of `n` bars from `start`, stepping `step` each bar. */
function uptrend(n: number, start = 100, step = 1): Candle[] {
  const out: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const c = start + i * step;
    out.push(candle({ close: c, open: c - step * 0.5, high: c + step * 0.2, low: c - step * 0.6, timestamp: i }));
  }
  return out;
}

describe('emaPullbackTrigger (TRA-1028)', () => {
  it('returns insufficient-bars below the 21 EMA window', () => {
    const r = emaPullbackTrigger(uptrend(10), 'call');
    expect(r.fired).toBe(false);
    expect(r.reason).toMatch(/insufficient/);
  });

  it('fires a call: uptrend, pullback to the 9 EMA, bullish reversal candle', () => {
    // 30 rising bars establish an uptrend with the 9 EMA above the 21 EMA…
    const bars = uptrend(30, 100, 1);
    // …then a pullback bar that dips to the fast EMA, then a bullish-engulfing
    // reversal candle that closes back up.
    const fastArea = bars[bars.length - 1].close; // ~129
    bars.push(candle({ close: fastArea - 2, open: fastArea, high: fastArea, low: fastArea - 4, timestamp: 30 }));
    const prev = bars[bars.length - 1];
    // Bullish engulfing: opens below prior close, closes above prior open.
    bars.push(candle({ open: prev.close - 0.5, close: prev.open + 1, high: prev.open + 1.5, low: prev.close - 1, timestamp: 31 }));
    const r = emaPullbackTrigger(bars, 'call');
    expect(r.trendOk).toBe(true);
    expect(r.pulledBack).toBe(true);
    expect(r.reversalCandle).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('does not fire a call in a downtrend (wrong side)', () => {
    const down = uptrend(30, 130, -1); // descending
    const r = emaPullbackTrigger(down, 'call');
    expect(r.fired).toBe(false);
    expect(r.trendOk).toBe(false);
  });

  it('does not fire without a confirming reversal candle', () => {
    const bars = uptrend(30, 100, 1);
    const fastArea = bars[bars.length - 1].close;
    // Pullback bar present, but the latest bar is a bearish down-close (no reversal).
    bars.push(candle({ close: fastArea - 2, open: fastArea, high: fastArea, low: fastArea - 4, timestamp: 30 }));
    const prev = bars[bars.length - 1];
    bars.push(candle({ open: prev.close, close: prev.close - 2, high: prev.close + 0.2, low: prev.close - 2.5, timestamp: 31 }));
    const r = emaPullbackTrigger(bars, 'call');
    expect(r.trendOk).toBe(true);
    expect(r.fired).toBe(false);
    expect(r.reason).toMatch(/reversal/);
  });
});

describe('volumeConfirmedBreakout (TRA-1028)', () => {
  function flat(n: number, level = 100, vol = 1000): Candle[] {
    const out: Candle[] = [];
    for (let i = 0; i < n; i++) {
      out.push(candle({ close: level, open: level, high: level + 0.5, low: level - 0.5, volume: vol, timestamp: i }));
    }
    return out;
  }

  it('fires when the close clears the channel high on above-average volume', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 105, open: 100.5, high: 105.2, low: 100, volume: 3000, timestamp: 25 }));
    const r = volumeConfirmedBreakout(bars, 'call');
    expect(r.breakout).toBe(true);
    expect(r.volumeConfirmed).toBe(true);
    expect(r.fired).toBe(true);
  });

  it('does NOT fire a breakout on below-average volume', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 105, open: 100.5, high: 105.2, low: 100, volume: 1000, timestamp: 25 }));
    const r = volumeConfirmedBreakout(bars, 'call');
    expect(r.breakout).toBe(true);
    expect(r.volumeConfirmed).toBe(false);
    expect(r.fired).toBe(false);
    expect(r.reason).toMatch(/below-average volume/);
  });

  it('does NOT fire when the close stays inside the channel', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 100.2, open: 100, high: 100.4, low: 99.8, volume: 5000, timestamp: 25 }));
    const r = volumeConfirmedBreakout(bars, 'call');
    expect(r.breakout).toBe(false);
    expect(r.fired).toBe(false);
  });

  it('fires a put on a volume-confirmed breakdown', () => {
    const bars = flat(25, 100, 1000);
    bars.push(candle({ close: 95, open: 99.5, high: 100, low: 94.8, volume: 3000, timestamp: 25 }));
    const r = volumeConfirmedBreakout(bars, 'put');
    expect(r.fired).toBe(true);
  });
});
