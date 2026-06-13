import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { BreakoutVolStrategy } from './breakout-vol.js';

function bar(close: number, ts: number, opts: Partial<Candle> = {}): Candle {
  return {
    symbol: 'TEST',
    timestamp: ts,
    open: opts.open ?? close,
    high: opts.high ?? close,
    low: opts.low ?? close,
    close,
    volume: opts.volume ?? 1000,
  };
}

/**
 * Build a `consolidation → breakout` synthetic series tuned to fire
 * `BreakoutVolStrategy`:
 *
 *   - 60 bars of pre-consolidation "warmup" so `classifyRegime` (which uses a
 *     50-bar EMA) has data to work with. We only ever pass an explicit regime
 *     in tests, but the strategy still requires `candles.length >= 50` so we
 *     exit the cold-start guard.
 *   - 20 bars of tight consolidation in [99.5, 100.5] on baseline volume —
 *     this becomes the channel reference (consolidationBars = 20 default).
 *   - 1 breakout bar that closes above the consolidation high with
 *     `breakoutVolume` × baseline volume.
 *
 * The consolidation is engineered to be wider than ATR(14) of the warmup so
 * the breakout bar's TR doesn't dominate ATR — we want a stable ATR estimate
 * so stop/target distances are sensible.
 */
function buildBreakoutSeries(opts: {
  side: 'long' | 'short';
  breakoutVolume: number;
  baselineVolume?: number;
  consolidationHigh?: number;
  consolidationLow?: number;
} = { side: 'long', breakoutVolume: 3000 }): Candle[] {
  const baselineVolume = opts.baselineVolume ?? 1000;
  const consolidationHigh = opts.consolidationHigh ?? 100.5;
  const consolidationLow = opts.consolidationLow ?? 99.5;

  const candles: Candle[] = [];
  // 60 warmup bars near 100, modest TR so ATR stays small relative to consolidation.
  for (let i = 0; i < 60; i++) {
    const px = 100 + Math.sin(i * 0.5) * 0.3;
    candles.push(bar(px, i * 60_000, {
      high: px + 0.2,
      low: px - 0.2,
      volume: baselineVolume,
    }));
  }
  // 20 bars of explicit consolidation oscillating between the two bounds.
  for (let i = 0; i < 20; i++) {
    const t = (60 + i) * 60_000;
    const isHigh = i % 2 === 0;
    const px = isHigh ? consolidationHigh : consolidationLow;
    candles.push(bar(px, t, {
      high: consolidationHigh,
      low: consolidationLow,
      volume: baselineVolume,
    }));
  }
  // Breakout bar: closes well outside the channel with elevated volume.
  const breakoutClose = opts.side === 'long' ? consolidationHigh + 1.5 : consolidationLow - 1.5;
  candles.push(bar(breakoutClose, 80 * 60_000, {
    open: opts.side === 'long' ? consolidationHigh : consolidationLow,
    high: opts.side === 'long' ? breakoutClose : consolidationHigh,
    low: opts.side === 'long' ? consolidationLow : breakoutClose,
    volume: opts.breakoutVolume,
  }));
  return candles;
}

describe('BreakoutVolStrategy', () => {
  it('returns null with insufficient bars', () => {
    const strat = new BreakoutVolStrategy();
    const candles = Array.from({ length: 30 }, (_, i) => bar(100, i * 60_000));
    expect(strat.evaluate('TEST', candles, 'high_vol')).toBeNull();
  });

  it('emits long breakout_vol signal on consolidation → upside breakout with volume', () => {
    const strat = new BreakoutVolStrategy();
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 3000 });
    const sig = strat.evaluate('TEST', candles, 'high_vol');
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(sig.type).toBe('breakout_vol');
    expect(sig.side).toBe('buy');
    expect(sig.entryPrice).toBeGreaterThan(100.5);
    expect(sig.stopLoss).toBeLessThan(sig.entryPrice);
    expect(sig.takeProfit).toBeGreaterThan(sig.entryPrice);
    // 2× ATR stop, 4× ATR target → 2:1 R:R.
    expect(sig.riskRewardRatio).toBeCloseTo(2, 5);
  });

  it('emits short breakout_vol signal on consolidation → downside breakout with volume', () => {
    const strat = new BreakoutVolStrategy();
    const candles = buildBreakoutSeries({ side: 'short', breakoutVolume: 3000 });
    const sig = strat.evaluate('TEST', candles, 'high_vol');
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(sig.type).toBe('breakout_vol');
    expect(sig.side).toBe('sell');
    expect(sig.entryPrice).toBeLessThan(99.5);
    expect(sig.stopLoss).toBeGreaterThan(sig.entryPrice);
    expect(sig.takeProfit).toBeLessThan(sig.entryPrice);
  });

  it('skips quiet breakouts where volume does NOT confirm', () => {
    const strat = new BreakoutVolStrategy();
    // Breakout bar has identical volume to baseline → fails 2× SMA gate.
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 1000 });
    expect(strat.evaluate('TEST', candles, 'high_vol')).toBeNull();
  });

  it('skips when price has NOT broken outside the consolidation channel', () => {
    const strat = new BreakoutVolStrategy();
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 3000 });
    // Replace the breakout bar with a high-volume bar that closes inside the channel.
    candles[candles.length - 1] = bar(100, 80 * 60_000, {
      high: 100.5,
      low: 99.5,
      volume: 5000,
    });
    expect(strat.evaluate('TEST', candles, 'high_vol')).toBeNull();
  });

  it('skips when consolidation range exceeds the maxRangeFraction gate', () => {
    const strat = new BreakoutVolStrategy({ maxRangeFraction: 0.005 });
    // Default consolidation [99.5, 100.5] / close ≈ 100 → 1% range, above the
    // 0.5% gate set above. Breakout would otherwise fire — gate must block.
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 3000 });
    expect(strat.evaluate('TEST', candles, 'high_vol')).toBeNull();
  });

  it('regime gate blocks entries in trend / range regimes', () => {
    const strat = new BreakoutVolStrategy();
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 3000 });
    expect(strat.evaluate('TEST', candles, 'trend_up')).toBeNull();
    expect(strat.evaluate('TEST', candles, 'trend_down')).toBeNull();
    expect(strat.evaluate('TEST', candles, 'range')).toBeNull();
  });

  it('allows the flat → high_vol transition bar (spec §4)', () => {
    // Spec §4: flat is allowed so the strategy can fire on the transition bar
    // before the regime detector's hysteresis confirms high_vol.
    const strat = new BreakoutVolStrategy();
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 3000 });
    const sig = strat.evaluate('TEST', candles, 'flat');
    expect(sig).not.toBeNull();
    expect(sig?.side).toBe('buy');
  });

  it('hard stop sits 2× ATR from entry by default; multiplier knob is honored', () => {
    const candles = buildBreakoutSeries({ side: 'long', breakoutVolume: 3000 });
    const sigDefault = new BreakoutVolStrategy().evaluate('TEST', candles, 'high_vol');
    const sigHalf = new BreakoutVolStrategy({ atrStopMultiplier: 1.0 })
      .evaluate('TEST', candles, 'high_vol');
    expect(sigDefault).not.toBeNull();
    expect(sigHalf).not.toBeNull();
    if (!sigDefault || !sigHalf) return;

    const distDefault = sigDefault.entryPrice - sigDefault.stopLoss;
    const distHalf = sigHalf.entryPrice - sigHalf.stopLoss;
    // Halving the multiplier halves the stop distance — proves the knob is
    // wired through to ATR-based sizing rather than a hardcoded value.
    expect(distHalf).toBeCloseTo(distDefault / 2, 5);
  });

  it('skips noise: random walk with no consolidation → no breakout signal', () => {
    const strat = new BreakoutVolStrategy();
    // Pure mean-zero random walk with stable volume — no coil, no breakout.
    let px = 100;
    let seed = 42;
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 2 ** 32;
      return (seed / 2 ** 32) - 0.5;
    };
    const candles: Candle[] = [];
    for (let i = 0; i < 100; i++) {
      px += rand() * 2;
      candles.push(bar(px, i * 60_000, {
        high: px + 0.5,
        low: px - 0.5,
        volume: 1000 + rand() * 200,
      }));
    }
    expect(strat.evaluate('TEST', candles, 'high_vol')).toBeNull();
  });
});
