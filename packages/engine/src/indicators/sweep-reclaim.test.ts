import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { detectSweepReclaim, detectSweepReclaimSeries } from './sweep-reclaim.js';

const DAY = 86_400_000;

function bar(i: number, o: number, h: number, l: number, c: number): Candle {
  return { symbol: 'T', timestamp: i * DAY, open: o, high: h, low: l, close: c, volume: 1e6 };
}

/**
 * A range market with support at ~100 (two clean swing lows) and resistance at
 * ~110 (two swing highs), then a final bar that wicks under 100 and closes back
 * above it in the upper half of its range.
 */
function rangeWithSweep(final?: Candle): Candle[] {
  const path = [
    105, 106, 107, 108, 109, 110, 109, 108, 107, 106, // swing high ~110 (i=5)
    105, 104, 103, 102, 101, 100, 101, 102, 103, 104, // swing low ~100 (i=15)
    105, 106, 107, 108, 109, 110.2, 109, 108, 107, 106, // swing high ~110.2 (i=25)
    105, 104, 103, 102, 101, 100.3, 101, 102, 103, 104, // swing low ~100.3 (i=35)
    105, 104, 103, 102, 101.5, // drift back toward support
  ];
  const cs = path.map((p, i) => bar(i, p, p + 0.5, p - 0.5, p));
  cs.push(final ?? bar(cs.length, 101.2, 101.6, 98.9, 101.3));
  return cs;
}

describe('detectSweepReclaim', () => {
  it('fires LONG on a wick below confirmed support that closes back above it', () => {
    const s = detectSweepReclaim(rangeWithSweep());
    expect(s).not.toBeNull();
    expect(s!.side).toBe('long');
    expect(s!.zone.touches).toBeGreaterThanOrEqual(2);
    expect(s!.stop).toBeLessThan(98.9);
    expect(s!.targetSource).toBe('zone');
    expect(s!.target).toBeGreaterThan(109);
    expect(s!.riskReward).toBeGreaterThan(1);
  });

  it('does NOT fire when the bar closes below the zone (a breakdown, not a reclaim)', () => {
    const cs = rangeWithSweep();
    const last = cs.length - 1;
    cs[last] = bar(last, 101.2, 101.4, 98.9, 99.0);
    expect(detectSweepReclaim(cs)).toBeNull();
  });

  it('does NOT fire when the wick never pierces the zone', () => {
    const cs = rangeWithSweep();
    const last = cs.length - 1;
    cs[last] = bar(last, 101.2, 101.8, 100.9, 101.6);
    expect(detectSweepReclaim(cs)).toBeNull();
  });

  it('does NOT fire on a sweep deeper than maxSweepAtr', () => {
    const cs = rangeWithSweep();
    const last = cs.length - 1;
    cs[last] = bar(last, 101.2, 101.6, 90, 101.3);
    expect(detectSweepReclaim(cs)).toBeNull();
  });

  it('respects the close-location filter', () => {
    const cs = rangeWithSweep();
    const last = cs.length - 1;
    cs[last] = bar(last, 101.2, 104, 98.9, 100.6); // closes back above, but low in range
    expect(detectSweepReclaim(cs, { minCloseLocation: 0.5 })).toBeNull();
    expect(detectSweepReclaim(cs, { minCloseLocation: 0.3 })).not.toBeNull();
  });

  it('fires SHORT on the mirror at resistance', () => {
    const cs = rangeWithSweep(undefined).slice(0, 45);
    // climb back to resistance, then wick above ~110.2 and close back under 110
    const climb = [103, 105, 107, 108.8];
    for (const p of climb) cs.push(bar(cs.length, p, p + 0.5, p - 0.5, p));
    cs.push(bar(cs.length, 109, 111.3, 108.6, 108.9));
    const s = detectSweepReclaim(cs);
    expect(s).not.toBeNull();
    expect(s!.side).toBe('short');
    expect(s!.stop).toBeGreaterThan(111.3);
  });

  it('sides:"short" suppresses the long', () => {
    expect(detectSweepReclaim(rangeWithSweep(), { sides: 'short' })).toBeNull();
  });

  it('sma200 filter refuses when there is not enough history', () => {
    expect(detectSweepReclaim(rangeWithSweep(), { trendFilter: 'sma200' })).toBeNull();
  });
});

describe('lookahead discipline', () => {
  it('the series form equals the prefix form on every bar (no future pivots leak in)', () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    const cs: Candle[] = [];
    let p = 100;
    for (let i = 0; i < 400; i++) {
      const o = p;
      p = Math.max(5, p * (1 + (rnd() - 0.5) * 0.04));
      const h = Math.max(o, p) * (1 + rnd() * 0.015);
      const l = Math.min(o, p) * (1 - rnd() * 0.015);
      cs.push(bar(i, o, h, l, p));
    }
    const series = detectSweepReclaimSeries(cs);
    const prefix: number[] = [];
    for (let t = 1; t < cs.length; t++) {
      const s = detectSweepReclaim(cs.slice(0, t + 1));
      if (s) prefix.push(s.index);
    }
    expect(series.length).toBeGreaterThan(5);
    expect(series.map((s) => s.index)).toEqual(prefix);
  });
});
