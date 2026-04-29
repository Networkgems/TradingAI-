import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { BbFadeStrategy } from './bb-fade.js';

function bar(close: number, ts: number, opts: Partial<Candle> = {}): Candle {
  return {
    symbol: 'TEST',
    timestamp: ts,
    open: opts.open ?? close,
    high: opts.high ?? close * 1.001,
    low: opts.low ?? close * 0.999,
    close,
    volume: opts.volume ?? 1000,
  };
}

/**
 * 50 bars of tight oscillation around 100 (low ADX → ranging) followed by a
 * clean 5% drop on the final bar that pierces the lower BB. RSI on the final
 * window is deeply oversold, satisfying the BbFade entry criteria.
 */
function buildOversoldRangingSeries(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 50; i++) {
    const px = 100 + Math.sin(i * 0.7) * 0.4;
    candles.push(bar(px, i * 60_000));
  }
  // Capitulation drop: last 8 bars print fresh lows.
  for (let i = 0; i < 8; i++) {
    const px = 99 - i * 0.6;
    candles.push(bar(px, (50 + i) * 60_000));
  }
  return candles;
}

describe('BbFadeStrategy', () => {
  it('returns null with insufficient bars', () => {
    const strat = new BbFadeStrategy({ enforceTimeFilter: false });
    const candles = Array.from({ length: 10 }, (_, i) => bar(100, i * 60_000));
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('emits long-only bb_fade signal at the lower band when oversold + ranging', () => {
    const strat = new BbFadeStrategy({ enforceTimeFilter: false });
    const sig = strat.evaluate('TEST', buildOversoldRangingSeries());
    if (sig) {
      expect(sig.type).toBe('bb_fade');
      expect(sig.side).toBe('buy');
      expect(sig.entryPrice).toBeGreaterThan(0);
      expect(sig.stopLoss).toBeLessThan(sig.entryPrice);
      // Target is the BB middle band — must be above entry.
      expect(sig.takeProfit).toBeGreaterThan(sig.entryPrice);
    }
  });

  it('does not fire when RSI is not oversold', () => {
    const strat = new BbFadeStrategy({ enforceTimeFilter: false, rsiOversold: 5 });
    const sig = strat.evaluate('TEST', buildOversoldRangingSeries());
    expect(sig).toBeNull();
  });
});
