import { describe, it, expect } from 'vitest';
import type { Candle, Position } from '@trading-app/shared';
import {
  initLifecycleState,
  advanceExtreme,
  momentumTrailStop,
  breakoutTrailStop,
  meanReversionRsiAltExitTriggered,
  timeStopBarsFor,
  TIME_STOP_BARS,
} from './lifecycle.js';

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

function mkPosition(over: Partial<Position> = {}): Position {
  return {
    id: 'pos-1',
    symbol: 'TEST',
    side: 'buy',
    signalType: 'momentum',
    entryPrice: 100,
    quantity: 1,
    stopLoss: 95,
    takeProfit: 110,
    openedAt: 0,
    ...over,
  };
}

describe('TIME_STOP_BARS / timeStopBarsFor', () => {
  it('encodes the spec §3 / §4 caps re-keyed by (signalType, side)', () => {
    // TRA-255 §3 — mean reversion: 10 bars both sides.
    expect(TIME_STOP_BARS.mean_reversion).toEqual({ buy: 10, sell: 10 });
    // TRA-255 §4.2 — breakout: 15 bars long, 10 bars short.
    expect(TIME_STOP_BARS.breakout_vol).toEqual({ buy: 15, sell: 10 });
    // TRA-255 §4.1 — momentum: no long cap (trend ride), 20 bars short.
    expect(TIME_STOP_BARS.momentum).toEqual({ sell: 20 });
  });

  it('returns null for strategies with no time stop on the supplied side', () => {
    // Momentum-long has no time stop (trend rides to a structural exit).
    expect(timeStopBarsFor('momentum', 'buy')).toBeNull();
    // Unknown signal types return null both with and without a side.
    expect(timeStopBarsFor('orb_breakout')).toBeNull();
    expect(timeStopBarsFor('orb_breakout', 'buy')).toBeNull();
  });

  it('returns the per-side cap when side is supplied', () => {
    expect(timeStopBarsFor('mean_reversion', 'buy')).toBe(10);
    expect(timeStopBarsFor('mean_reversion', 'sell')).toBe(10);
    expect(timeStopBarsFor('breakout_vol', 'buy')).toBe(15);
    expect(timeStopBarsFor('breakout_vol', 'sell')).toBe(10);
    expect(timeStopBarsFor('momentum', 'sell')).toBe(20);
  });

  it('returns the tightest cap when side is omitted (legacy callers)', () => {
    // mean_reversion: same on both sides → 10.
    expect(timeStopBarsFor('mean_reversion')).toBe(10);
    // breakout_vol: 15 long vs 10 short → tightest is 10.
    expect(timeStopBarsFor('breakout_vol')).toBe(10);
    // momentum: only sell populated → that's the cap that applies.
    expect(timeStopBarsFor('momentum')).toBe(20);
  });
});

describe('momentumTrailStop — Donchian-low trail (longs) / Donchian-high (shorts)', () => {
  it('returns the prior-N-bar Donchian low when it is above the current stop (longs)', () => {
    const candles: Candle[] = [];
    // 20 bars of monotonic up-drift so Donchian_low(20) climbs every bar.
    for (let i = 0; i < 25; i++) {
      candles.push(bar(100 + i, i * 60_000, { high: 100.5 + i, low: 99.5 + i }));
    }
    const position = mkPosition({ stopLoss: 90 });
    const newStop = momentumTrailStop(position, candles, 20);
    expect(newStop).not.toBeNull();
    expect(newStop!).toBeGreaterThan(90);
  });

  it('returns null and never widens the stop on a one-bar pullback (longs)', () => {
    const candles: Candle[] = [];
    // 20 bars of up-drift followed by a single deep dip — Donchian_low resets
    // to the dip's low. The trail must NOT loosen the existing stop.
    for (let i = 0; i < 20; i++) {
      candles.push(bar(100 + i, i * 60_000, { high: 100.5 + i, low: 99.5 + i }));
    }
    const position = mkPosition({ stopLoss: 115 });
    candles.push(bar(95, 20 * 60_000, { high: 96, low: 94 }));
    const newStop = momentumTrailStop(position, candles, 20);
    expect(newStop).toBeNull(); // would have widened — refused.
  });

  it('returns null when fewer than period bars exist', () => {
    const candles: Candle[] = [bar(100, 0), bar(101, 60_000)];
    expect(momentumTrailStop(mkPosition(), candles, 20)).toBeNull();
  });

  it('uses Donchian-high for shorts (mirror image)', () => {
    const candles: Candle[] = [];
    // 20 bars of monotonic downtrend so Donchian_high(20) tightens each bar.
    for (let i = 0; i < 25; i++) {
      candles.push(bar(100 - i, i * 60_000, { high: 100.5 - i, low: 99.5 - i }));
    }
    const position = mkPosition({ side: 'sell', stopLoss: 110 });
    const newStop = momentumTrailStop(position, candles, 20);
    expect(newStop).not.toBeNull();
    expect(newStop!).toBeLessThan(110);
  });
});

describe('breakoutTrailStop — BE after +2·ATR then 2·ATR trail', () => {
  it('does not engage before favourable move reaches the BE trigger (longs)', () => {
    // Flat warm-up so the running extreme stays at entry, ensuring the
    // favourable-move check fails before the BE trigger threshold is hit.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(bar(100, i * 60_000, { high: 100.3, low: 99.7 }));
    }
    const position = mkPosition({ entryPrice: 100, stopLoss: 99 });
    const state = initLifecycleState(position, candles);
    expect(state.entryAtr).toBeDefined();
    // Add one bar that drifts up but stays well under entry + 2·entryAtr.
    const undershoot = 100 + 0.5 * (state.entryAtr ?? 0);
    candles.push(bar(undershoot, 21 * 60_000, { high: undershoot, low: undershoot - 0.05 }));
    advanceExtreme(state, position, candles[candles.length - 1]);
    const newStop = breakoutTrailStop(position, candles, state);
    expect(newStop).toBeNull();
  });

  it('ratchets stop to break-even once price moves +2·entryAtr in favour (longs)', () => {
    // Calm warm-up: 20 small bars so entry-ATR is well-defined and small.
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(bar(100, i * 60_000, { high: 100.5, low: 99.5 }));
    }
    const position = mkPosition({ entryPrice: 100, stopLoss: 98 });
    const state = initLifecycleState(position, candles);
    expect(state.entryAtr).toBeDefined();
    const triggerPx = 100 + 2 * state.entryAtr! + 0.001;
    // One bar that pushes the high past the BE trigger threshold.
    candles.push(bar(triggerPx, 21 * 60_000, { high: triggerPx + 0.05, low: triggerPx - 0.05 }));
    advanceExtreme(state, position, candles[candles.length - 1]);
    const newStop = breakoutTrailStop(position, candles, state);
    expect(newStop).not.toBeNull();
    // BE candidate is max(entryPrice, extreme - 2*ATR). When 2*ATR > 2*entryAtr
    // (i.e. live ATR has expanded), candidate = entryPrice. When live ATR is
    // smaller / equal, the trail-from-extreme can also exceed entry. Either
    // way the new stop must be ≥ entryPrice (BE floor) and a tightening of
    // the previous 98 stop.
    expect(newStop!).toBeGreaterThanOrEqual(position.entryPrice);
    expect(newStop!).toBeGreaterThan(position.stopLoss);
  });

  it('never widens an already-tightened stop (returns null when candidate ≤ current stop)', () => {
    const candles: Candle[] = [];
    for (let i = 0; i < 20; i++) {
      candles.push(bar(100, i * 60_000, { high: 100.5, low: 99.5 }));
    }
    const position = mkPosition({ entryPrice: 100, stopLoss: 105 });
    const state = initLifecycleState(position, candles);
    const triggerPx = 100 + 2 * (state.entryAtr ?? 0.5) + 0.01;
    candles.push(bar(triggerPx, 21 * 60_000, { high: triggerPx, low: triggerPx }));
    advanceExtreme(state, position, candles[candles.length - 1]);
    // Existing stop already at 105 — well above any plausible BE candidate
    // for a 100 entry, so the trail must NOT loosen it.
    const newStop = breakoutTrailStop(position, candles, state);
    expect(newStop).toBeNull();
  });
});

describe('meanReversionRsiAltExitTriggered', () => {
  it('fires for a long when RSI re-crosses up through 50 from oversold entry', () => {
    // 30 bars of declining closes to drive RSI well below 50.
    const downSeries: Candle[] = [];
    for (let i = 0; i < 30; i++) {
      downSeries.push(bar(100 - i * 1.5, i * 60_000));
    }
    const position = mkPosition({ signalType: 'mean_reversion', side: 'buy' });
    const state = initLifecycleState(position, downSeries);
    expect(state.entryRsi).toBeDefined();
    expect(state.entryRsi!).toBeLessThan(50);

    // Now follow with rising closes to push RSI back above 50.
    const seriesAfter = [...downSeries];
    for (let i = 0; i < 25; i++) {
      seriesAfter.push(bar(60 + i * 2.0, (30 + i) * 60_000));
    }
    expect(meanReversionRsiAltExitTriggered(position, seriesAfter, 14, state)).toBe(true);
  });

  it('does not fire while RSI remains below 50 for a long', () => {
    const series: Candle[] = [];
    for (let i = 0; i < 30; i++) series.push(bar(100 - i * 1.5, i * 60_000));
    const position = mkPosition({ signalType: 'mean_reversion', side: 'buy' });
    const state = initLifecycleState(position, series);
    // Add a couple more declining bars — RSI stays oversold.
    for (let i = 0; i < 3; i++) series.push(bar(50 - i, (30 + i) * 60_000));
    expect(meanReversionRsiAltExitTriggered(position, series, 14, state)).toBe(false);
  });

  it('fires for a short when RSI re-crosses down through 50 from overbought entry', () => {
    // 30 bars of rising closes to drive RSI well above 50.
    const upSeries: Candle[] = [];
    for (let i = 0; i < 30; i++) upSeries.push(bar(100 + i * 1.5, i * 60_000));
    const position = mkPosition({ signalType: 'mean_reversion', side: 'sell' });
    const state = initLifecycleState(position, upSeries);
    expect(state.entryRsi).toBeDefined();
    expect(state.entryRsi!).toBeGreaterThan(50);

    const seriesAfter = [...upSeries];
    for (let i = 0; i < 25; i++) seriesAfter.push(bar(140 - i * 2.0, (30 + i) * 60_000));
    expect(meanReversionRsiAltExitTriggered(position, seriesAfter, 14, state)).toBe(true);
  });

  it('returns false when entry RSI is missing (insufficient warm-up)', () => {
    const tinySeries: Candle[] = [bar(100, 0), bar(101, 60_000)];
    const position = mkPosition({ signalType: 'mean_reversion', side: 'buy' });
    const state = initLifecycleState(position, tinySeries);
    expect(state.entryRsi).toBeUndefined();
    expect(meanReversionRsiAltExitTriggered(position, tinySeries, 14, state)).toBe(false);
  });
});
