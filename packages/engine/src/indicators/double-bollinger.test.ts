import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { doubleBollinger, doubleBollingerSignal, DBB_DEFAULTS } from './double-bollinger.js';

/**
 * Deterministic OHLCV builder. Each entry supplies the four prices explicitly so
 * the band-tag / wick / breakout geometry is exact and golden. volume is fixed.
 */
function bar(open: number, high: number, low: number, close: number, i = 0): Candle {
  return { symbol: 'TEST', timestamp: i * 60_000, open, high, low, close, volume: 1_000 };
}

/**
 * Base series of `n` bars oscillating ±2 around `price`. The oscillation gives
 * both bands real (non-zero) width — a flat tape collapses the bands to a point,
 * which would make every "close back inside" reversal test degenerate.
 */
function flatBase(n: number, price = 100): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const osc = i % 2 === 0 ? 2 : -2;
    const open = price + osc;
    const close = price - osc;
    return bar(open, Math.max(open, close) + 0.5, Math.min(open, close) - 0.5, close, i);
  });
}

describe('doubleBollinger', () => {
  it('returns null below the standard-band warm-up', () => {
    expect(doubleBollinger(flatBase(DBB_DEFAULTS.slowPeriod - 1))).toBeNull();
  });

  it('returns both bands once warmed up, fast wider than slow on flat tape', () => {
    const bands = doubleBollinger(flatBase(40));
    expect(bands).not.toBeNull();
    // On a flat base both bands collapse toward price; structure is still valid.
    expect(bands!.slow.upper).toBeGreaterThanOrEqual(bands!.slow.lower);
    expect(bands!.fast.upper).toBeGreaterThanOrEqual(bands!.fast.lower);
  });

  it('fast band uses open, slow band uses close (sources differ)', () => {
    // Build tape where open and close diverge so the two sources separate.
    const candles = Array.from({ length: 40 }, (_, i) =>
      bar(100 + (i % 2), 102, 98, 100 - (i % 2), i),
    );
    const bands = doubleBollinger(candles)!;
    // Different sources + periods → different middles (not coincidentally equal).
    expect(bands.fast.middle).not.toBe(bands.slow.middle);
  });
});

describe('doubleBollingerSignal', () => {
  it('returns none with insufficient candles', () => {
    expect(doubleBollingerSignal(flatBase(5)).type).toBe('none');
  });

  it('flags reversal_short on a failed new high (tag + close back inside + upper wick)', () => {
    const candles = flatBase(40);
    // Latest bar spikes well above both bands but closes back near base with a
    // large upper wick — the classic failed new high.
    candles.push(bar(100, 130, 99.8, 100.2, 40));
    const sig = doubleBollingerSignal(candles);
    expect(sig.type).toBe('reversal_short');
    expect(sig.entry).toBe(100.2);
    expect(sig.stop).toBe(130);
    expect(sig.riskReward).toBeGreaterThan(0);
  });

  it('flags reversal_long on a failed new low (tag + close back inside + lower wick)', () => {
    const candles = flatBase(40);
    candles.push(bar(100, 100.2, 70, 99.8, 40));
    const sig = doubleBollingerSignal(candles);
    expect(sig.type).toBe('reversal_long');
    expect(sig.entry).toBe(99.8);
    expect(sig.stop).toBe(70);
    expect(sig.riskReward).toBeGreaterThan(0);
  });

  it('flags breakout_long when close clears both bands AND the prior swing high on expansion', () => {
    const candles = flatBase(40);
    // Big bullish expansion candle closing above everything; high == close so
    // there is no rejection wick (so it is a breakout, not a reversal).
    candles.push(bar(100, 140, 100, 140, 40));
    const sig = doubleBollingerSignal(candles);
    expect(sig.type).toBe('breakout_long');
    expect(sig.entry).toBe(140);
    // Video's structural ≥3:1 projection.
    expect(sig.riskReward).toBeCloseTo(3, 5);
  });

  it('does NOT flag breakout when the candle closes back inside (rejection wins)', () => {
    const candles = flatBase(40);
    // Pokes above both bands intrabar but closes back at base with a huge wick.
    candles.push(bar(100, 140, 99.9, 100.1, 40));
    const sig = doubleBollingerSignal(candles);
    expect(sig.type).toBe('reversal_short');
  });

  it('returns none on a quiet bar that tags nothing', () => {
    const candles = flatBase(41);
    expect(doubleBollingerSignal(candles).type).toBe('none');
  });

  it('breakout requires clearing the prior swing high, not just the band', () => {
    // Build an uptrend so the prior swing high is already elevated; a modest new
    // bar can clear the band but not the established swing high.
    const candles = Array.from({ length: 40 }, (_, i) =>
      bar(100 + i, 100 + i + 5, 100 + i - 1, 100 + i, i),
    );
    // Latest closes only marginally above the band but well below prior highs.
    const last = candles[candles.length - 1];
    candles.push(bar(last.close, last.close + 0.3, last.close - 0.3, last.close + 0.2, 40));
    const sig = doubleBollingerSignal(candles);
    expect(sig.type).not.toBe('breakout_long');
  });
});
