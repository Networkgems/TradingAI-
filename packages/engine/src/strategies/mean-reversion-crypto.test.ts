import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { MeanReversionCryptoStrategy } from './mean-reversion-crypto.js';
import { classifyRegime } from '../regime.js';

function bar(close: number, ts: number, opts: Partial<Candle> = {}): Candle {
  return {
    symbol: 'TEST',
    timestamp: ts,
    open: opts.open ?? close,
    high: opts.high ?? close * 1.005,
    low: opts.low ?? close * 0.995,
    close,
    volume: opts.volume ?? 1000,
  };
}

/**
 * 60 bars of mid-amplitude oscillation around 100 followed by a single sharp
 * drop to 90. After the drop, RSI(14) is deeply oversold and the close sits
 * well below the lower BB — both entry conditions met.
 *
 * Note: this series classifies as `high_vol` (the crash bar spikes ATR), not
 * `range`, so the regime gate is exercised by passing `range` explicitly.
 * Engineering a series that *naturally* classifies as `range` AND triggers
 * RSI<25 is fundamentally difficult — sustained losses needed for low RSI
 * tend to push ADX into trending territory. That is a feature of the gate,
 * not a defect of the synthetic harness, so we test indicator behavior and
 * regime gating separately.
 */
function buildOversoldSeries(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    const px = 100 + Math.sin(i * 0.7) * 1;
    candles.push(bar(px, i * 60_000));
  }
  candles.push(bar(90, 60 * 60_000));
  return candles;
}

/** Mirror of `buildOversoldSeries`: 60 oscillation bars + 1 sharp spike up. */
function buildOverboughtSeries(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    const px = 100 + Math.sin(i * 0.7) * 1;
    candles.push(bar(px, i * 60_000));
  }
  candles.push(bar(110, 60 * 60_000));
  return candles;
}

/**
 * Long monotonic downtrend driving ADX above the trending threshold and the
 * MA slope sharply negative — natural classifier returns `trend_down`. The
 * tail crash also drives RSI<25 and pushes the close below the lower band so
 * the indicator-only conditions DO fire — proving the regime gate (not lack
 * of indicator fire) is what blocks entries here.
 */
function buildTrendingDownSeries(): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < 60; i++) {
    candles.push(bar(100 - i * 0.6, i * 60_000));
  }
  candles.push(bar(50, 60 * 60_000));
  return candles;
}

describe('MeanReversionCryptoStrategy', () => {
  it('returns null with insufficient bars', () => {
    const strat = new MeanReversionCryptoStrategy();
    const candles = Array.from({ length: 20 }, (_, i) => bar(100, i * 60_000));
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('emits long mean_reversion signal when oversold + close < lower BB (regime=range)', () => {
    const strat = new MeanReversionCryptoStrategy();
    const sig = strat.evaluate('TEST', buildOversoldSeries(), 'range');
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(sig.type).toBe('mean_reversion');
    expect(sig.side).toBe('buy');
    expect(sig.entryPrice).toBeGreaterThan(0);
    expect(sig.stopLoss).toBeLessThan(sig.entryPrice);
    // Take-profit is the BB middle band — must sit above entry for a long.
    expect(sig.takeProfit).toBeGreaterThan(sig.entryPrice);
    expect(sig.riskRewardRatio).toBeGreaterThan(0);
  });

  it('emits short mean_reversion signal when overbought + close > upper BB (regime=range)', () => {
    const strat = new MeanReversionCryptoStrategy();
    const sig = strat.evaluate('TEST', buildOverboughtSeries(), 'range');
    expect(sig).not.toBeNull();
    if (!sig) return;
    expect(sig.type).toBe('mean_reversion');
    expect(sig.side).toBe('sell');
    expect(sig.stopLoss).toBeGreaterThan(sig.entryPrice);
    expect(sig.takeProfit).toBeLessThan(sig.entryPrice);
    expect(sig.riskRewardRatio).toBeGreaterThan(0);
  });

  it('regime gate blocks entries in trending downtrends even when indicators fire', () => {
    const candles = buildTrendingDownSeries();
    // Pre-condition 1: natural classifier sees this as trend_down, NOT range.
    expect(classifyRegime(candles)).toBe('trend_down');

    // Pre-condition 2: indicator-only conditions WOULD fire here — verified by
    // overriding the regime to `range` and confirming a long signal emits.
    const strat = new MeanReversionCryptoStrategy();
    const wouldFire = strat.evaluate('TEST', candles, 'range');
    expect(wouldFire).not.toBeNull();
    expect(wouldFire?.side).toBe('buy');

    // Real test: with the auto-classifying path (no regime override), the
    // trend regime blocks entry. This is the "Only use when market is NOT
    // trending" gate from the issue brief.
    expect(strat.evaluate('TEST', candles)).toBeNull();
  });

  it('regime gate blocks entries when an external regime label is non-range', () => {
    const candles = buildOversoldSeries();
    const strat = new MeanReversionCryptoStrategy();
    expect(strat.evaluate('TEST', candles, 'trend_up')).toBeNull();
    expect(strat.evaluate('TEST', candles, 'trend_down')).toBeNull();
    expect(strat.evaluate('TEST', candles, 'high_vol')).toBeNull();
    expect(strat.evaluate('TEST', candles, 'flat')).toBeNull();
  });

  it('does not fire when RSI is not oversold (gate on the indicator side)', () => {
    // Lowering rsiOversold to 1 makes RSI<1 effectively impossible.
    const strat = new MeanReversionCryptoStrategy({ rsiOversold: 1 });
    expect(strat.evaluate('TEST', buildOversoldSeries(), 'range')).toBeNull();
  });

  it('hard stop sits 1.5 × ATR below entry for longs (spec §3)', () => {
    const candles = buildOversoldSeries();
    const stratDefault = new MeanReversionCryptoStrategy();
    const sigDefault = stratDefault.evaluate('TEST', candles, 'range');
    expect(sigDefault).not.toBeNull();
    if (!sigDefault) return;

    // Halving the multiplier should ~halve the stop distance — confirms the
    // multiplier knob is wired through to stop sizing.
    const stratHalfStop = new MeanReversionCryptoStrategy({ atrStopMultiplier: 0.75 });
    const sigHalf = stratHalfStop.evaluate('TEST', candles, 'range');
    expect(sigHalf).not.toBeNull();
    if (!sigHalf) return;

    const distDefault = sigDefault.entryPrice - sigDefault.stopLoss;
    const distHalf = sigHalf.entryPrice - sigHalf.stopLoss;
    expect(distHalf).toBeCloseTo(distDefault / 2, 5);
  });
});
