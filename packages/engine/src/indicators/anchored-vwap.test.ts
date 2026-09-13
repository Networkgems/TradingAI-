import { describe, it, expect, beforeEach } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  anchoredVwap,
  anchorIndexAtRecentGap,
  anchorIndexAtExtreme,
  avwapReclaim,
} from './anchored-vwap.js';

/**
 * TRA-4605 — anchored VWAP.
 *
 * The refusals are the load-bearing arms: every one of them is a case where the
 * obvious "helpful" implementation returns a plausible number instead, and a
 * plausible number from an unweighted or empty window is indistinguishable from
 * a real level at the call site.
 */

let t = 0;
function bar(over: Partial<Candle> = {}): Candle {
  t += 86_400_000;
  const close = over.close ?? 100;
  return {
    symbol: 'TEST',
    timestamp: t,
    open: over.open ?? close,
    high: over.high ?? Math.max(over.open ?? close, close),
    low: over.low ?? Math.min(over.open ?? close, close),
    close,
    volume: over.volume ?? 1_000_000,
    ...(over.synthetic ? { synthetic: true } : {}),
  };
}

beforeEach(() => {
  t = 0;
});

describe('anchoredVwap', () => {
  it('volume-weights rather than price-averages', () => {
    // Two bars at 100 and 110. A plain mean says 105. Weighted 9:1 toward the
    // 100 print, the honest answer is 101.
    const series = [
      bar({ open: 100, close: 100, high: 100, low: 100, volume: 900_000 }),
      bar({ open: 110, close: 110, high: 110, low: 110, volume: 100_000 }),
    ];
    const s = anchoredVwap(series, 0)!;
    expect(s.vwap).toBeCloseTo(101, 6);
    expect(s.vwap).not.toBeCloseTo(105, 1);
  });

  it('anchors where told — a later anchor sees only later bars', () => {
    const series = [
      bar({ open: 100, close: 100, high: 100, low: 100, volume: 1_000_000 }),
      bar({ open: 200, close: 200, high: 200, low: 200, volume: 1_000_000 }),
    ];
    expect(anchoredVwap(series, 0)!.vwap).toBeCloseTo(150, 6);
    expect(anchoredVwap(series, 1)!.vwap).toBeCloseTo(200, 6);
  });

  it('REFUSES a window with no traded volume rather than returning a price', () => {
    // The important refusal. With zero volume there is no volume-weighted
    // anything; returning the mean price here would be a moving average
    // impersonating a VWAP, and nothing downstream could tell.
    const series = [bar({ volume: 0 }), bar({ volume: 0 })];
    expect(anchoredVwap(series, 0)).toBeNull();
  });

  it('PROCEEDS on the same window once one bar has volume (the control)', () => {
    const series = [bar({ volume: 0 }), bar({ close: 100, volume: 5 })];
    expect(anchoredVwap(series, 0)).not.toBeNull();
  });

  it('excludes synthetic gap-filler bars (TRA-427)', () => {
    const series = [
      bar({ open: 100, close: 100, high: 100, low: 100, volume: 1_000_000 }),
      bar({ open: 500, close: 500, high: 500, low: 500, volume: 1_000_000, synthetic: true }),
    ];
    const s = anchoredVwap(series, 0)!;
    expect(s.vwap).toBeCloseTo(100, 6);
    expect(s.bars).toBe(1);
  });

  it('REFUSES an out-of-range or non-integer anchor', () => {
    const series = [bar(), bar()];
    expect(anchoredVwap(series, -1)).toBeNull();
    expect(anchoredVwap(series, 2)).toBeNull();
    expect(anchoredVwap(series, 1.5)).toBeNull();
  });

  it('bands widen with dispersion and collapse without it', () => {
    const flat = [bar({ close: 100 }), bar({ close: 100 })];
    expect(anchoredVwap(flat, 0)!.stdDev).toBeCloseTo(0, 6);
    const spread = [
      bar({ open: 90, close: 90, high: 90, low: 90 }),
      bar({ open: 110, close: 110, high: 110, low: 110 }),
    ];
    expect(anchoredVwap(spread, 0)!.stdDev).toBeGreaterThan(5);
  });
});

describe('anchor selection', () => {
  it('finds the most recent event gap', () => {
    const series = [
      bar({ open: 100, close: 100 }),
      bar({ open: 108, close: 109 }), // +8% gap
      bar({ open: 109, close: 110 }),
    ];
    expect(anchorIndexAtRecentGap(series)).toBe(1);
  });

  it('returns null when nothing gapped', () => {
    const series = [bar({ close: 100 }), bar({ close: 100.5 }), bar({ close: 101 })];
    expect(anchorIndexAtRecentGap(series)).toBeNull();
  });

  it('finds the extreme high and low', () => {
    const series = [
      bar({ open: 100, close: 100, high: 101, low: 99 }),
      bar({ open: 100, close: 100, high: 120, low: 99 }),
      bar({ open: 100, close: 100, high: 101, low: 80 }),
    ];
    expect(anchorIndexAtExtreme(series, 'high')).toBe(1);
    expect(anchorIndexAtExtreme(series, 'low')).toBe(2);
  });
});

describe('avwapReclaim', () => {
  /** Anchored at a selloff; price trades below AVWAP, then reclaims it. */
  function belowThenReclaim(lastClose: number, lastVolume: number): Candle[] {
    return [
      bar({ open: 100, close: 100, high: 100, low: 100, volume: 1_000_000 }), // anchor
      bar({ open: 96, close: 96, high: 96, low: 96, volume: 1_000_000 }),
      bar({ open: 95, close: 95, high: 95, low: 95, volume: 1_000_000 }),
      bar({ open: 95, close: lastClose, high: lastClose, low: 95, volume: lastVolume }),
    ];
  }

  it('CONFIRMS a call on a close-to-close reclaim with volume expansion', () => {
    const r = avwapReclaim(belowThenReclaim(105, 2_000_000), 0);
    expect(r).not.toBeNull();
    expect(r!.side).toBe('call');
    expect(r!.volumeExpanded).toBe(true);
  });

  it('REFUSES the same reclaim without volume expansion — the one-variable pair', () => {
    expect(avwapReclaim(belowThenReclaim(105, 500_000), 0)).toBeNull();
  });

  it('REFUSES while price is still below — a cross is not a reclaim', () => {
    expect(avwapReclaim(belowThenReclaim(96, 2_000_000), 0)).toBeNull();
  });

  it('CONFIRMS a put on a loss of the level', () => {
    const series = [
      bar({ open: 100, close: 100, high: 100, low: 100, volume: 1_000_000 }),
      bar({ open: 104, close: 104, high: 104, low: 104, volume: 1_000_000 }),
      bar({ open: 105, close: 105, high: 105, low: 105, volume: 1_000_000 }),
      bar({ open: 105, close: 98, high: 105, low: 98, volume: 2_000_000 }),
    ];
    const r = avwapReclaim(series, 0);
    expect(r).not.toBeNull();
    expect(r!.side).toBe('put');
  });

  it('REFUSES when the anchor does not precede the transition pair', () => {
    // The anchor must sit before both bars, or the level and the crossing are
    // computed from the same data.
    const series = belowThenReclaim(105, 2_000_000);
    expect(avwapReclaim(series, series.length - 1)).toBeNull();
  });

  it('REFUSES a series too short to have a transition', () => {
    expect(avwapReclaim([bar()], 0)).toBeNull();
  });
});
