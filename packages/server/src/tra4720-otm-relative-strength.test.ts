/**
 * TRA-4720 (parent TRA-4413 item 5) — relative strength vs SPY / QQQ / sector
 * ETF: the pure function, its honest nulls, the flag, and the counter.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  OTM_RELATIVE_STRENGTH_SHADOW_FLAG,
  RS_BENCHMARK_SYMBOLS,
  computeRelativeStrength,
  isOtmRelativeStrengthShadowEnabled,
  otmRelativeStrengthHealth,
  recordOtmRelativeStrength,
  recordScannerRelativeStrength,
  resetOtmRelativeStrengthCountersForTest,
  scannerRelativeStrength,
  sectorEtfOf,
  withRelativeStrengthBenchmarks,
  type RsSeriesRead,
} from './otm-relative-strength.js';

const DAY = 86_400_000;
const LAST = Date.UTC(2026, 8, 17, 13, 30);

/** Daily bars from closes, the last one on 2026-09-17. */
function bars(closes: number[], lastTs = LAST): Candle[] {
  return closes.map((close, i) => ({
    symbol: 'X',
    timestamp: lastTs - (closes.length - 1 - i) * DAY,
    open: close, high: close, low: close, close, volume: 1,
  }));
}
const geometric = (n: number, r: number) => Array.from({ length: n }, (_, i) => 100 * (1 + r) ** i);
const flat = (n: number) => Array.from({ length: n }, () => 100);

function reader(map: Record<string, Candle[] | 'stale'>): (s: string) => RsSeriesRead {
  return (s) => {
    const v = map[s];
    if (v === undefined || v === 'stale') return { bars: [], readable: false };
    return { bars: v, readable: true };
  };
}

describe('computeRelativeStrength — raw spreads over the pre-registered lookbacks', () => {
  it('name +1%/session vs flat benchmarks: spread = the name\'s own trailing return', () => {
    const r = computeRelativeStrength('AAPL', reader({
      AAPL: bars(geometric(120, 0.01)), SPY: bars(flat(120)), QQQ: bars(flat(120)), XLK: bars(flat(120)),
    }));
    expect(r.sector).toBe('Technology');
    for (const leg of ['spy', 'qqq', 'sector'] as const) {
      expect(r.legs[leg].code).toBe('ok');
      expect(r.legs[leg].spreads.d21).toBeCloseTo(1.01 ** 21 - 1, 10);
      expect(r.legs[leg].spreads.d63).toBeCloseTo(1.01 ** 63 - 1, 10);
      expect(r.legs[leg].asOfDate).toBe('2026-09-17');
    }
    expect(r.legs.sector.benchmark).toBe('XLK');
  });

  it('spread is name MINUS benchmark: a lagging name reads negative', () => {
    const r = computeRelativeStrength('AAPL', reader({
      AAPL: bars(flat(120)), SPY: bars(geometric(120, 0.01)),
    }));
    expect(r.legs.spy.spreads.d21).toBeCloseTo(-(1.01 ** 21 - 1), 10);
  });

  it('aligns on common dates: a benchmark one session behind is scored on the common date', () => {
    const r = computeRelativeStrength('AAPL', reader({
      AAPL: bars(geometric(120, 0.01)),
      SPY: bars(flat(119), LAST - DAY),
    }));
    expect(r.legs.spy.asOfDate).toBe('2026-09-16');
    expect(r.legs.spy.alignedBars).toBe(119);
    expect(r.legs.spy.spreads.d21).toBeCloseTo(1.01 ** 21 - 1, 10);
  });
});

describe('honest nulls — never a placeholder 50', () => {
  it('unreadable name ⇒ no_name_bars on every leg, percentile null, scanner gets undefined', () => {
    const r = computeRelativeStrength('AAPL', reader({ AAPL: 'stale', SPY: bars(flat(120)) }));
    expect([r.legs.spy.code, r.legs.qqq.code, r.legs.sector.code])
      .toEqual(['no_name_bars', 'no_name_bars', 'no_name_bars']);
    expect(r.percentile).toBeNull();
    expect(r.percentileCode).toBe('no_name_bars');
    expect(scannerRelativeStrength(r)).toBeUndefined();
  });

  it('unreadable benchmark ⇒ no_benchmark_bars, distinct from a short overlap', () => {
    const r = computeRelativeStrength('AAPL', reader({ AAPL: bars(flat(120)), SPY: 'stale', QQQ: bars(flat(10)) }));
    expect(r.legs.spy.code).toBe('no_benchmark_bars');
    expect(r.legs.qqq.code).toBe('insufficient_overlap');
    expect(r.legs.qqq.spreads).toEqual({ d21: null, d63: null });
    expect(r.percentileCode).toBe('no_benchmark_bars');
  });

  it('unmapped sector ⇒ unmapped_sector; never imputed to SPY', () => {
    expect(sectorEtfOf('ZZZZ')).toBeNull();
    const r = computeRelativeStrength('ZZZZ', reader({ ZZZZ: bars(flat(120)), SPY: bars(flat(120)) }));
    expect(r.legs.sector).toMatchObject({ benchmark: null, code: 'unmapped_sector' });
  });

  it('a benchmark scored against itself ⇒ benchmark_is_self, not a trivial 0 spread', () => {
    const r = computeRelativeStrength('SPY', reader({ SPY: bars(flat(120)), QQQ: bars(flat(120)) }));
    expect(r.legs.spy.code).toBe('benchmark_is_self');
    expect(r.legs.spy.spreads.d21).toBeNull();
    expect(r.legs.qqq.code).toBe('ok');
  });

  it('21 scored but 63 not ⇒ ok with a null d63; percentile insufficient_history', () => {
    const r = computeRelativeStrength('AAPL', reader({ AAPL: bars(geometric(40, 0.01)), SPY: bars(flat(40)) }));
    expect(r.legs.spy.code).toBe('ok');
    expect(r.legs.spy.spreads.d63).toBeNull();
    expect(r.percentile).toBeNull();
    expect(r.percentileCode).toBe('insufficient_history');
  });
});

describe('percentile — rank of today\'s 63-session spread vs SPY in the name\'s own history', () => {
  it('an accelerating outperformer ranks at the top (100)', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(0.0002 * i * i));
    const r = computeRelativeStrength('AAPL', reader({ AAPL: bars(closes), SPY: bars(flat(120)) }));
    expect(r.percentileCode).toBe('ok');
    expect(r.percentile).toBe(100);
    expect(scannerRelativeStrength(r)).toBe(100);
  });

  it('a decelerating name ranks at the bottom (0)', () => {
    const closes = Array.from({ length: 120 }, (_, i) => 100 * Math.exp(-0.0002 * i * i));
    const r = computeRelativeStrength('AAPL', reader({ AAPL: bars(closes), SPY: bars(flat(120)) }));
    expect(r.percentile).toBe(0);
  });
});

describe('flag, refresh universe, counter', () => {
  beforeEach(() => resetOtmRelativeStrengthCountersForTest());

  it('default OFF; the refresh universe is the SAME array when off', () => {
    expect(isOtmRelativeStrengthShadowEnabled({})).toBe(false);
    const syms = ['AAPL', 'SPY'];
    expect(withRelativeStrengthBenchmarks(syms, {})).toBe(syms);
    const on = withRelativeStrengthBenchmarks(syms, { [OTM_RELATIVE_STRENGTH_SHADOW_FLAG]: '1' });
    expect(on).toEqual(['AAPL', 'SPY', ...RS_BENCHMARK_SYMBOLS.filter((s) => s !== 'SPY')]);
  });

  it('publishes dense per-leg reason codes and supplied/withheld on the health read', () => {
    const measured = computeRelativeStrength('AAPL', reader({
      AAPL: bars(geometric(120, 0.01)), SPY: bars(flat(120)), QQQ: bars(flat(120)), XLK: bars(flat(120)),
    }));
    const cold = computeRelativeStrength('AAPL', reader({}));
    recordOtmRelativeStrength('live', measured);
    recordOtmRelativeStrength('live', cold);
    recordScannerRelativeStrength(measured);
    recordScannerRelativeStrength(cold);
    const h = otmRelativeStrengthHealth({});
    expect(h.enabled).toBe(false);
    expect(h.nomination.live.evaluated).toBe(2);
    expect(h.nomination.demo.evaluated).toBe(0);
    const spy = Object.fromEntries(h.nomination.live.byLeg.spy.map((r) => [r.code, r.count]));
    expect(spy).toEqual({
      ok: 1, no_name_bars: 1, no_benchmark_bars: 0, insufficient_overlap: 0, unmapped_sector: 0, benchmark_is_self: 0,
    });
    expect(h.scanner).toMatchObject({ evaluated: 2, supplied: 1, withheld: 1 });
    expect(h.definition.lookbacksSessions).toEqual([21, 63]);
  });
});
