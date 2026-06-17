import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { findSwings, supportResistance, reversalChecklist } from './support-resistance.js';

const HOUR = 3_600_000;
const BASE = Date.UTC(2026, 0, 1, 14, 30);

/** Deterministic OHLC builder; ts defaults to a monotonic sequence by index. */
function bar(open: number, high: number, low: number, close: number, i: number): Candle {
  return { symbol: 'TEST', timestamp: BASE + i * HOUR, open, high, low, close, volume: 1_000 };
}

/** A flat "filler" bar at price p, used to pad windows. */
function flat(p: number, i: number): Candle {
  return bar(p, p + 0.05, p - 0.05, p, i);
}

describe('findSwings', () => {
  it('returns nothing without enough bars on both sides', () => {
    expect(findSwings([flat(100, 0), flat(100, 1)], 3)).toEqual([]);
  });

  it('flags a strict swing high that dominates its neighbours', () => {
    // A peak at index 3 surrounded by lower bars.
    const candles = [
      flat(100, 0),
      flat(101, 1),
      flat(102, 2),
      bar(103, 110, 103, 104, 3), // the peak
      flat(102, 4),
      flat(101, 5),
      flat(100, 6),
    ];
    const swings = findSwings(candles, 2);
    const highs = swings.filter((s) => s.kind === 'high');
    expect(highs).toHaveLength(1);
    expect(highs[0].index).toBe(3);
    expect(highs[0].price).toBe(110);
  });

  it('never flags the final lookback bars (unconfirmed)', () => {
    const candles = [flat(100, 0), flat(99, 1), flat(98, 2), bar(97, 97, 80, 81, 3)];
    // index 3 is a dramatic low but lies within the final `lookback` window.
    expect(findSwings(candles, 2).some((s) => s.index === 3)).toBe(false);
  });
});

describe('supportResistance', () => {
  it('returns empty levels for an empty series', () => {
    expect(supportResistance([])).toEqual({ zones: [], support: null, resistance: null });
  });

  it('clusters repeated touches of the same level into one zone with a touch count', () => {
    // Constant-price fillers (equal highs/lows can never be strict pivots), so
    // only the two intentional dips to ~90 register as swing lows.
    const candles = [
      flat(95, 0),
      flat(95, 1),
      bar(94, 95, 90, 94, 2), // swing low ~90 (neighbours 0,1,3,4)
      flat(95, 3),
      flat(95, 4),
      bar(94, 95, 90.2, 94, 5), // swing low ~90 again (neighbours 3,4,6,7)
      flat(95, 6),
      flat(95, 7),
      flat(95, 8), // reference close = 95
    ];
    const { support } = supportResistance(candles, { lookback: 2, clusterPct: 0.02 });
    expect(support).not.toBeNull();
    expect(support!.kind).toBe('support');
    expect(support!.touches).toBe(2);
    expect(support!.level).toBeCloseTo(90.1, 1);
  });

  it('classifies zones above the reference price as resistance', () => {
    const candles = [
      flat(100, 0),
      flat(100, 1),
      bar(101, 110, 100, 102, 2), // swing high 110 (neighbours 0,1,3,4)
      flat(100, 3),
      flat(100, 4),
      bar(96, 97, 90, 91, 5), // swing low 90 (neighbours 3,4,6,7)
      flat(100, 6),
      flat(100, 7),
      flat(100, 8), // reference 100, between the two zones
    ];
    const { support, resistance } = supportResistance(candles, { lookback: 2, clusterPct: 0.01 });
    expect(resistance!.level).toBeCloseTo(110, 5);
    expect(resistance!.kind).toBe('resistance');
    expect(support!.level).toBeCloseTo(90, 5);
    expect(support!.kind).toBe('support');
  });
});

describe('reversalChecklist', () => {
  it('returns no setup without enough bars', () => {
    expect(reversalChecklist([flat(100, 0), flat(100, 1)]).side).toBeNull();
  });

  it('fires a confirmed long off support after an unhealthy flush and bullish reclaim', () => {
    const candles: Candle[] = [];
    let i = 0;
    // Establish a support zone near 90 with two earlier swing lows, price ~100.
    candles.push(flat(100, i++));
    candles.push(bar(94, 95, 90, 94, i++)); // swing low ~90
    candles.push(flat(96, i++));
    candles.push(flat(99, i++));
    candles.push(bar(94, 95, 90.1, 95, i++)); // swing low ~90 again
    candles.push(flat(99, i++));
    candles.push(flat(101, i++));
    candles.push(flat(102, i++));
    // Unhealthy flush down into the 90 zone: fast, mostly red, ~12-point drop.
    candles.push(bar(102, 102, 99, 99, i++));
    candles.push(bar(99, 99, 96, 96, i++));
    candles.push(bar(96, 96, 93, 93, i++));
    candles.push(bar(93, 93, 90, 90.5, i++));
    // Bullish reclaim bar that engulfs the prior bar and closes above its high.
    candles.push(bar(89.5, 96, 89, 95.5, i++));

    const r = reversalChecklist(candles, {
      lookback: 2,
      clusterPct: 0.02,
      atrPeriod: 5,
      legBars: 4,
      proximityAtr: 3,
      unhealthyAtr: 1,
    });
    expect(r.side).toBe('long');
    expect(r.atKeyLevel).toBe(true);
    expect(r.unhealthyMove).toBe(true);
    expect(r.trendBreak).toBe(true);
    expect(r.pattern).toBe('bullish_engulfing');
    expect(r.confirmed).toBe(true);
    expect(r.score).toBe(4);
    // Bracket sanity: long entry above the reclaim, stop below the zone, positive R:R.
    expect(r.entry!).toBeGreaterThan(r.stop!);
    expect(r.target!).toBeGreaterThan(r.entry!);
    expect(r.riskReward!).toBeGreaterThan(0);
  });

  it('does not confirm when price is far from any key level', () => {
    const candles: Candle[] = [
      flat(90, 0),
      bar(91, 95, 90, 92, 1),
      flat(93, 2),
      flat(94, 3),
      bar(95, 99, 95, 96, 4),
      flat(120, 5), // gapped far away from the zones
      flat(121, 6),
      flat(122, 7),
    ];
    const r = reversalChecklist(candles, { lookback: 2, atrPeriod: 3, legBars: 3 });
    expect(r.confirmed).toBe(false);
    expect(r.atKeyLevel).toBe(false);
    expect(r.entry).toBeNull();
  });
});
