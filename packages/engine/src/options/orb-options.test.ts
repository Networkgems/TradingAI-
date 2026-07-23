import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  evaluateOrbOptions,
  openingRangeForSession,
  optionTypeForBreakout,
  DEFAULT_ORB_OPTIONS_PARAMS,
  type OrbOptionsParams,
} from './orb-options.js';

// January → America/New_York is EST (UTC-5), so 09:30 ET = 14:30 UTC. Building
// timestamps as `Date.UTC(2026, 0, day, hhET + 5, mmET)` keeps the fixtures in
// plain ET wall-clock terms. 2026-01-06 is a Tuesday (ET weekday 2).
const EST_OFFSET_H = 5;
const DEFAULT_DAY = 6;

/** A bar at the given ET hour:minute on `day` (Jan 2026). */
function bar(
  hhEt: number,
  mmEt: number,
  o: number,
  h: number,
  l: number,
  c: number,
  day = DEFAULT_DAY,
): Candle {
  return {
    symbol: 'SPY',
    timestamp: Date.UTC(2026, 0, day, hhEt + EST_OFFSET_H, mmEt),
    open: o,
    high: h,
    low: l,
    close: c,
    volume: 1_000,
  };
}

/**
 * Opening range 09:30–09:45 ET: high 501, low 499, open 500 → width 0.4%
 * (inside the default [0.2%, 0.8%] band). Three 5-minute bars stay inside.
 */
function openingRangeBars(day = DEFAULT_DAY): Candle[] {
  return [
    bar(9, 30, 500, 501, 499, 500.5, day),
    bar(9, 35, 500.5, 501, 499.5, 500, day),
    bar(9, 40, 500, 500.8, 499, 500.2, day),
  ];
}

describe('optionTypeForBreakout', () => {
  it('maps up → call and down → put', () => {
    expect(optionTypeForBreakout('up')).toBe('call');
    expect(optionTypeForBreakout('down')).toBe('put');
  });
});

describe('openingRangeForSession', () => {
  it('draws the box from the first rangeMinutes of the ET session', () => {
    const box = openingRangeForSession(openingRangeBars())!;
    expect(box).not.toBeNull();
    expect(box.high).toBe(501);
    expect(box.low).toBe(499);
    expect(box.openPrice).toBe(500);
    expect(box.widthPct).toBeCloseTo(0.004, 6);
  });

  it('excludes the cutoff bar (half-open window) from the range', () => {
    const candles = [...openingRangeBars(), bar(9, 45, 500.2, 999, 1, 500.2)];
    const box = openingRangeForSession(candles)!;
    // The 09:45 bar (huge H/L) is the first breakout bar, not part of the range.
    expect(box.high).toBe(501);
    expect(box.low).toBe(499);
  });

  it('returns null when the session-open bar is absent', () => {
    // Only pre-open bars (09:00 ET) — never at/after the 09:30 open.
    const box = openingRangeForSession([bar(9, 0, 500, 501, 499, 500), bar(9, 5, 500, 501, 499, 500)]);
    expect(box).toBeNull();
  });
});

describe('evaluateOrbOptions — breakouts', () => {
  it('emits call_breakout on an upside close-through', () => {
    const candles = [...openingRangeBars(), bar(9, 45, 500.5, 502.5, 500.3, 502)];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('call_breakout');
    expect(sig.optionType).toBe('call');
    expect(sig.breakoutDirection).toBe('up');
    expect(sig.breakLevel).toBe(501);
    expect(sig.underlyingEntry).toBe(502);
  });

  it('emits put_breakout on a downside close-through', () => {
    const candles = [...openingRangeBars(), bar(9, 45, 499.2, 499.4, 497.5, 498)];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('put_breakout');
    expect(sig.optionType).toBe('put');
    expect(sig.breakoutDirection).toBe('down');
    expect(sig.breakLevel).toBe(499);
    expect(sig.underlyingEntry).toBe(498);
  });
});

describe('evaluateOrbOptions — requireClose', () => {
  it('does NOT trigger when the bar only wicks through the edge (requireClose=true)', () => {
    // High pierces 501 but the close (500.5) is back inside.
    const candles = [...openingRangeBars(), bar(9, 45, 500.5, 502, 500.3, 500.5)];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('none');
    expect(sig.reason).toBe('no_breakout');
  });

  it('triggers on an intrabar wick when requireClose=false', () => {
    const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, requireClose: false };
    const candles = [...openingRangeBars(), bar(9, 45, 500.5, 502, 500.3, 500.5)];
    const sig = evaluateOrbOptions(candles, params);
    expect(sig.type).toBe('call_breakout');
    expect(sig.breakoutDirection).toBe('up');
  });
});

describe('evaluateOrbOptions — one trade a day', () => {
  it('fires only on the first breakout bar; a later bar is already_triggered', () => {
    const candles = [
      ...openingRangeBars(),
      bar(9, 45, 500.5, 502.5, 500.3, 502), // first break (up)
      bar(9, 50, 502, 503, 501, 502.5), // later bar, same day
    ];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('none');
    expect(sig.reason).toBe('already_triggered_today');
  });

  it('ignores a later opposite-edge break once the day has triggered', () => {
    const candles = [
      ...openingRangeBars(),
      bar(9, 45, 500.5, 502.5, 500.3, 502), // first break UP
      bar(9, 50, 500, 500.2, 497, 498), // breaks DOWN later — must be ignored
    ];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('none');
    expect(sig.reason).toBe('already_triggered_today');
  });
});

describe('evaluateOrbOptions — range-width gates', () => {
  it('skips a too-narrow range', () => {
    const candles = [
      bar(9, 30, 500, 500.4, 500.0, 500.2),
      bar(9, 35, 500.2, 500.4, 500.1, 500.3),
      bar(9, 40, 500.3, 500.4, 500.0, 500.2),
      bar(9, 45, 500.2, 502, 500, 501.5), // would break, but range < 0.2%
    ];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('none');
    expect(sig.reason).toMatch(/^range_too_narrow/);
  });

  it('skips a too-wide range', () => {
    const candles = [
      bar(9, 30, 500, 505, 499, 502), // range 6.0 pts = 1.2% > 0.8%
      bar(9, 35, 502, 505, 499.5, 501),
      bar(9, 40, 501, 504, 499, 500),
      bar(9, 45, 500, 506, 500, 505.5),
    ];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('none');
    expect(sig.reason).toMatch(/^range_too_wide/);
  });

  it('honours maxRangePct=0 (cap disabled) so a wide range can still trigger', () => {
    const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, maxRangePct: 0 };
    const candles = [
      bar(9, 30, 500, 505, 499, 502),
      bar(9, 35, 502, 505, 499.5, 501),
      bar(9, 40, 501, 504, 499, 500),
      bar(9, 45, 500, 506, 500, 505.5), // closes above range high 505
    ];
    const sig = evaluateOrbOptions(candles, params);
    expect(sig.type).toBe('call_breakout');
  });
});

describe('evaluateOrbOptions — entry cutoff', () => {
  it('skips a breakout after the ET cutoff', () => {
    const candles = [
      ...openingRangeBars(),
      bar(10, 0, 500.2, 500.9, 499.5, 500.4), // inside range, before noon
      bar(12, 5, 500.4, 502.5, 500.3, 502), // breaks at 12:05 ET (> 12:00 cutoff)
    ];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('none');
    expect(sig.reason).toMatch(/^after_cutoff/);
  });

  it('allows a breakout exactly at the cutoff minute', () => {
    const candles = [
      ...openingRangeBars(),
      bar(10, 0, 500.2, 500.9, 499.5, 500.4),
      bar(12, 0, 500.4, 502.5, 500.3, 502), // 12:00 ET == cutoff, not after
    ];
    const sig = evaluateOrbOptions(candles);
    expect(sig.type).toBe('call_breakout');
  });
});

describe('evaluateOrbOptions — direction filter', () => {
  it('up_only filters out a downside break', () => {
    const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, allowedBreakouts: 'up_only' };
    const candles = [...openingRangeBars(), bar(9, 45, 499.2, 499.4, 497.5, 498)];
    const sig = evaluateOrbOptions(candles, params);
    expect(sig.type).toBe('none');
    expect(sig.reason).toMatch(/^down_break_filtered/);
  });

  it('down_only filters out an upside break', () => {
    const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, allowedBreakouts: 'down_only' };
    const candles = [...openingRangeBars(), bar(9, 45, 500.5, 502.5, 500.3, 502)];
    const sig = evaluateOrbOptions(candles, params);
    expect(sig.type).toBe('none');
    expect(sig.reason).toMatch(/^up_break_filtered/);
  });

  it('up_only still takes the upside break (calls only)', () => {
    const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, allowedBreakouts: 'up_only' };
    const candles = [...openingRangeBars(), bar(9, 45, 500.5, 502.5, 500.3, 502)];
    const sig = evaluateOrbOptions(candles, params);
    expect(sig.type).toBe('call_breakout');
  });
});

describe('evaluateOrbOptions — weekday exclusion', () => {
  it('skips an excluded ET weekday', () => {
    // Default session day is Tuesday (ET weekday 2). Exclude it.
    const params: OrbOptionsParams = { ...DEFAULT_ORB_OPTIONS_PARAMS, excludedEtWeekdays: [2] };
    const candles = [...openingRangeBars(), bar(9, 45, 500.5, 502.5, 500.3, 502)];
    const sig = evaluateOrbOptions(candles, params);
    expect(sig.type).toBe('none');
    expect(sig.reason).toBe('excluded_weekday');
  });
});

describe('evaluateOrbOptions — misc', () => {
  it('returns none on insufficient bars', () => {
    expect(evaluateOrbOptions([bar(9, 30, 500, 501, 499, 500)]).reason).toBe('insufficient_bars');
  });

  it('is safe on a multi-session series (anchors to the latest ET day)', () => {
    // Prior-day (Monday, Jan 5) session that already triggered, then today's fresh break.
    const priorDay = [...openingRangeBars(5), bar(9, 45, 500.5, 502.5, 500.3, 502, 5)];
    const today = [...openingRangeBars(6), bar(9, 45, 499.2, 499.4, 497.5, 498, 6)];
    const sig = evaluateOrbOptions([...priorDay, ...today]);
    expect(sig.type).toBe('put_breakout');
    expect(sig.underlyingEntry).toBe(498);
  });
});
