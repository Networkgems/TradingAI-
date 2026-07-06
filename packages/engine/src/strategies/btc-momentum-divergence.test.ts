import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  tryBtcMomentumDivergenceShort,
  resolveBtcMomentumDivergence,
  BTC_MOMENTUM_DIVERGENCE_DEFAULTS,
} from './btc-momentum-divergence.js';
import { MomentumStrategy } from './archived/momentum.js';
import { RegimeDetector } from '../regime.js';

/**
 * TRA-1325 / TRA-255 §4.4 v3 — BTC bearish momentum-divergence trigger.
 * Spec source of truth: TRA-288 `v3-spec` document (board-signed-off).
 */

const FOUR_H = 4 * 60 * 60 * 1000;

/** Build 4H candles from a closes array (high = close, so fractal-on-high == fractal-on-close). */
function mk(closes: number[]): Candle[] {
  return closes.map((c, idx) => ({
    timestamp: 1_700_000_000_000 + idx * FOUR_H,
    open: c,
    high: c,
    low: c - 2,
    close: c,
    volume: 1000,
  }));
}

/**
 * Series with two swing highs: a SHARP first peak at index 25 (=126, high RSI /
 * MACD) and a HIGHER but gently-approached second peak at index 40 (=127.1,
 * lower momentum). Bar t = 43 (three trailing down bars confirm the swing at
 * i = 40). This is a textbook bearish divergence: price higher high, momentum
 * lower high.
 */
function divergenceCloses(): number[] {
  const closes: number[] = [];
  for (let k = 0; k <= 20; k++) closes.push(100 + k * 0.3); // gentle warmup 100..106
  closes.push(108, 111, 115, 120, 126);                     // sharp rally → peak at 25
  closes.push(122, 119, 117, 118, 119);                     // pullback
  for (let k = 0; k < 10; k++) closes.push(119 + k * 0.9);  // gentle rally → higher peak at 40 (127.1)
  closes.push(126, 125, 124);                               // 3 trailing down bars confirm swing at 40
  return closes;
}

function divergenceSeries(): Candle[] {
  return mk(divergenceCloses());
}

/**
 * Same divergence tail, but prepended with a long gentle rise so the series
 * clears `MomentumStrategy`'s 200-bar slow-EMA `minBars` gate — real 4H feeds
 * carry thousands of bars, so the end-to-end routing tests need a realistic
 * length. The prepended bars are far from the tail and monotonic, so they add
 * no interfering swing highs and preserve the tail divergence structure.
 */
function divergenceSeriesLong(): Candle[] {
  const warmup: number[] = [];
  for (let k = 0; k < 190; k++) warmup.push(70 + k * (30 / 190)); // 70 → ~99.8
  return mk([...warmup, ...divergenceCloses()]);
}

describe('TRA-1325 §4.4 v3 momentum-divergence trigger', () => {
  it('resolveBtcMomentumDivergence fills spec defaults', () => {
    expect(resolveBtcMomentumDivergence(undefined)).toEqual(BTC_MOMENTUM_DIVERGENCE_DEFAULTS);
    expect(BTC_MOMENTUM_DIVERGENCE_DEFAULTS).toEqual({
      swingLookback: 3,
      pairWindowMinBars: 6,
      pairWindowMaxBars: 30,
      rsiPeriod: 14,
      macdFastPeriod: 12,
      macdSlowPeriod: 26,
    });
    // Partial override folds onto defaults.
    expect(resolveBtcMomentumDivergence({ pairWindowMaxBars: 40 }).pairWindowMaxBars).toBe(40);
    expect(resolveBtcMomentumDivergence({ pairWindowMaxBars: 40 }).swingLookback).toBe(3);
  });

  it('fires a short with §4.1 r7 risk knobs when price higher-highs but momentum diverges', () => {
    const candles = divergenceSeries();
    const sig = tryBtcMomentumDivergenceShort({
      symbol: 'BTC-USD',
      candles,
      divergence: BTC_MOMENTUM_DIVERGENCE_DEFAULTS,
      atrPeriod: 14,
      atrStopMultiplier: 2.0,
      atrTpMultiplier: 4.0,
      rearmBars: 8,
      lastFireTs: null,
    });
    expect(sig).not.toBeNull();
    expect(sig!.side).toBe('sell');
    expect(sig!.type).toBe('momentum');
    expect(sig!.trigger).toBe('momentum-divergence');
    // Disjunction is the v3 baseline; this series diverges on both RSI and MACD.
    expect(sig!.divergenceFamily).toBe('both');
    // Entry = fire-bar (t) close; stop/TP are 2×/4× ATR(14)[t] on the SHORT side.
    const entry = candles[candles.length - 1].close;
    expect(sig!.entryPrice).toBe(entry);
    expect(sig!.stopLoss).toBeGreaterThan(entry);   // short stop is above entry
    expect(sig!.takeProfit).toBeLessThan(entry);    // short TP is below entry
    expect(sig!.riskRewardRatio).toBeCloseTo(2, 6); // 4×ATR / 2×ATR
  });

  it('does not fire when the second peak is not a higher high (rule 3)', () => {
    // Lower the second peak below the first (126) so `high[i] > high[s]` fails.
    const closes: number[] = [];
    for (let k = 0; k <= 20; k++) closes.push(100 + k * 0.3);
    closes.push(108, 111, 115, 120, 126);         // first peak 126 at index 25
    closes.push(122, 119, 117, 118, 119);
    for (let k = 0; k < 10; k++) closes.push(115 + k * 0.5); // second peak ~119.5 < 126
    closes.push(118, 117, 116);
    const sig = tryBtcMomentumDivergenceShort({
      symbol: 'BTC-USD',
      candles: mk(closes),
      divergence: BTC_MOMENTUM_DIVERGENCE_DEFAULTS,
      atrPeriod: 14,
      atrStopMultiplier: 2.0,
      atrTpMultiplier: 4.0,
      rearmBars: 8,
      lastFireTs: null,
    });
    expect(sig).toBeNull();
  });

  it('does not fire on a clean monotonic uptrend (no confirmed swing high at i)', () => {
    const closes = Array.from({ length: 60 }, (_, k) => 100 + k); // strictly increasing
    const sig = tryBtcMomentumDivergenceShort({
      symbol: 'BTC-USD',
      candles: mk(closes),
      divergence: BTC_MOMENTUM_DIVERGENCE_DEFAULTS,
      atrPeriod: 14,
      atrStopMultiplier: 2.0,
      atrTpMultiplier: 4.0,
      rearmBars: 8,
      lastFireTs: null,
    });
    // The latest bar is the top of the trend; i = t-3 is not a swing high
    // (its trailing bars printed HIGHER highs), so rule 1 fails.
    expect(sig).toBeNull();
  });

  it('respects the rearm cooldown (no re-fire inside rearmBars × barInterval)', () => {
    const candles = divergenceSeries();
    const lastFireTs = candles[candles.length - 1].timestamp - 2 * FOUR_H; // 2 bars ago < 8-bar rearm
    const sig = tryBtcMomentumDivergenceShort({
      symbol: 'BTC-USD',
      candles,
      divergence: BTC_MOMENTUM_DIVERGENCE_DEFAULTS,
      atrPeriod: 14,
      atrStopMultiplier: 2.0,
      atrTpMultiplier: 4.0,
      rearmBars: 8,
      lastFireTs,
    });
    expect(sig).toBeNull();
  });
});

describe('TRA-1325 §4.4 v3 routing predicate on MomentumStrategy', () => {
  function stratWith(short: Record<string, unknown>): MomentumStrategy {
    return new MomentumStrategy(new RegimeDetector(), {
      paramsByDirection: {
        short: { byTimeframe: { '4h': {} }, ...short },
      },
    });
  }

  it('routes a momentumDivergenceSymbols member to the v3 trigger on 4H', () => {
    const strat = stratWith({ momentumDivergenceSymbols: ['BTC-USD'] });
    const sig = strat.evaluate('BTC-USD', divergenceSeriesLong());
    expect(sig).not.toBeNull();
    expect(sig!.trigger).toBe('momentum-divergence');
  });

  it('does NOT route a non-member symbol to the v3 trigger', () => {
    const strat = stratWith({ momentumDivergenceSymbols: ['BTC-USD'] });
    // SOL is not in the divergence list → cascade-leg r7 evaluates instead;
    // the divergence series has no cascade drop-bar so no short fires, and
    // crucially the emission is never tagged momentum-divergence.
    const sig = strat.evaluate('SOL-USD', divergenceSeriesLong());
    expect(sig?.trigger).not.toBe('momentum-divergence');
  });

  it('throws at construction when v3 and v2 routing lists overlap', () => {
    expect(() =>
      new MomentumStrategy(new RegimeDetector(), {
        paramsByDirection: {
          short: {
            byTimeframe: { '4h': {} },
            momentumDivergenceSymbols: ['BTC-USD'],
            lowCascadeDensitySymbols: ['BTC-USD'],
          },
        },
      }),
    ).toThrow(/disjoint/);
  });
});
