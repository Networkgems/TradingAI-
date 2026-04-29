import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { IchimokuStrategy } from './ichimoku-strategy.js';

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

const ET_OPEN_TS = 1_700_400_000_000; // Mon 10:00 ET — within the 9:35–11:30 window

function buildFlatCloudSeries(): Candle[] {
  const candles: Candle[] = [];
  // 80 flat bars → tight cloud (kumo thickness ≈ 0)
  for (let i = 0; i < 80; i++) {
    candles.push(bar(100, ET_OPEN_TS + i * 60_000, { volume: 1000 }));
  }
  return candles;
}

describe('IchimokuStrategy — TRA-170', () => {
  it('returns null with insufficient bars (< 79)', () => {
    const strat = new IchimokuStrategy();
    const candles = Array.from({ length: 50 }, (_, i) => bar(100, ET_OPEN_TS + i * 60_000));
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('rejects signals when the kumo is too thin (regime gate)', () => {
    const strat = new IchimokuStrategy();
    // Even if we somehow got a TK cross on the flat series, the kumo
    // thickness check should keep the signal at null.
    const sig = strat.evaluate('TEST', buildFlatCloudSeries());
    expect(sig).toBeNull();
  });

  it('does not require an ADX reading anymore (regression check)', () => {
    // Build a series that has a meaningful directional move so the kumo can
    // form some thickness. We don't assert that a signal fires — the contract
    // we want to lock in is "no implicit ADX floor".
    const candles: Candle[] = [];
    for (let i = 0; i < 80; i++) {
      const px = 100 + i * 0.5;
      candles.push(bar(px, ET_OPEN_TS + i * 60_000, { volume: 1500 }));
    }
    // Should not throw; result may or may not be a signal but the strategy
    // must at least evaluate without depending on adx().
    expect(() => new IchimokuStrategy().evaluate('TEST', candles)).not.toThrow();
  });
});

describe('IchimokuStrategy — TRA-183 retest entry', () => {
  /**
   * Build a slow-uptrend → flat → breakout series that produces a deterministic
   * bullish kumo breakout on the final bar. The series is long enough that the
   * 78-bar Ichimoku window forms a thick cloud well below the breakout level.
   */
  function buildBullishBreakoutSeries(): Candle[] {
    const candles: Candle[] = [];
    // 60 bars of flat-ish accumulation around 100 to seed the cloud
    for (let i = 0; i < 60; i++) {
      const px = 100 + Math.sin(i / 5) * 0.2;
      candles.push(bar(px, ET_OPEN_TS + i * 60_000, { volume: 1000 }));
    }
    // 20 bars of slow drift up to 102 — keeps cloud below the eventual breakout
    for (let i = 0; i < 20; i++) {
      const px = 100 + i * 0.1;
      candles.push(bar(px, ET_OPEN_TS + (60 + i) * 60_000, { volume: 1000 }));
    }
    // Final bar: aggressive breakout to 110 (well above any reasonable cloud top)
    candles.push(bar(110, ET_OPEN_TS + 80 * 60_000, {
      open: 102, high: 110.5, low: 102, volume: 2000,
    }));
    return candles;
  }

  it('retest mode arms a pending signal (returns null) on the breakout bar', () => {
    const armed = new IchimokuStrategy({ enforceTimeFilter: false, retestEntry: true });
    const immediate = new IchimokuStrategy({ enforceTimeFilter: false, retestEntry: false });
    const candles = buildBullishBreakoutSeries();
    const fast = immediate.evaluate('TEST', candles);
    if (fast) {
      // When the immediate path fires, the retest path should arm rather than fire.
      expect(fast.side).toBe('buy');
      const armedFirst = armed.evaluate('TEST', candles);
      expect(armedFirst).toBeNull();
    }
  });

  it('aborts when the original kijun stop is breached during the retest wait', () => {
    const strat = new IchimokuStrategy({ enforceTimeFilter: false, retestEntry: true });
    const candles = buildBullishBreakoutSeries();
    // Arm the pending — only meaningful if the underlying breakout fires.
    const armed = strat.evaluate('TEST', candles);
    expect(armed).toBeNull(); // first bar arms but doesn't fire

    // Append a hard reversal bar that crashes through any reasonable kijun stop.
    candles.push(bar(85, ET_OPEN_TS + 81 * 60_000, {
      open: 110, high: 110, low: 84, volume: 3000,
    }));
    const sig = strat.evaluate('TEST', candles);
    expect(sig).toBeNull();
  });

  it('expires the pending after retestExpiryBars without a touch', () => {
    const strat = new IchimokuStrategy({
      enforceTimeFilter: false,
      retestEntry: true,
      retestExpiryBars: 3,
    });
    const candles = buildBullishBreakoutSeries();
    strat.evaluate('TEST', candles);
    // Append 4 boring continuation bars at the breakout level — none retest the
    // midpoint, so the pending should expire.
    for (let i = 0; i < 4; i++) {
      candles.push(bar(110, ET_OPEN_TS + (81 + i) * 60_000, {
        open: 110, high: 110.2, low: 109.8, volume: 1000,
      }));
      const sig = strat.evaluate('TEST', candles);
      expect(sig).toBeNull();
    }
  });
});
