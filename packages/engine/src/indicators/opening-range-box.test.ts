import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { openingRangeBox, openingRangeBoxSignal, ORB_DEFAULTS } from './opening-range-box.js';

/** Deterministic OHLC builder with an explicit timestamp. */
function bar(open: number, high: number, low: number, close: number, ts: number): Candle {
  return { symbol: 'TEST', timestamp: ts, open, high, low, close, volume: 1_000 };
}

// The US-open candle lands at the default 13:30 UTC; following bars are +1h each
// (14:30, 15:30, …) so only the first bar is recognised as the opening candle.
const OPEN_TS = Date.UTC(2026, 0, 1, ORB_DEFAULTS.openHourUtc, ORB_DEFAULTS.openMinuteUtc);
const HOUR = 3_600_000;
const ts = (i: number) => OPEN_TS + i * HOUR;

/** Opening candle with box top=110, bottom=90 (height 20, mid 100). */
function openingCandle(i = 0): Candle {
  return bar(100, 110, 90, 100, ts(i));
}

describe('openingRangeBox', () => {
  it('returns null when there is no US-open candle in the series', () => {
    // Bar at 15:30 UTC — never the configured 13:30 open.
    const c = bar(100, 110, 90, 100, Date.UTC(2026, 0, 1, 15, 30));
    expect(openingRangeBox([c])).toBeNull();
  });

  it('draws the box from the opening candle high/low with a 50% midline', () => {
    const box = openingRangeBox([openingCandle(0), bar(101, 102, 100, 101, ts(1))]);
    expect(box).not.toBeNull();
    expect(box!.high).toBe(110);
    expect(box!.low).toBe(90);
    expect(box!.mid).toBe(100);
    expect(box!.height).toBe(20);
    expect(box!.openTimestamp).toBe(OPEN_TS);
  });

  it('uses the most recent opening candle when several are present', () => {
    const candles = [
      bar(100, 120, 80, 100, ts(0)), // older session, wider box
      bar(101, 102, 100, 101, ts(1)),
      bar(50, 60, 40, 50, OPEN_TS + 24 * HOUR), // next day's 13:30 open
      bar(51, 52, 50, 51, OPEN_TS + 25 * HOUR),
    ];
    const box = openingRangeBox(candles)!;
    expect(box.high).toBe(60);
    expect(box.low).toBe(40);
  });
});

describe('openingRangeBoxSignal', () => {
  it('returns none on the opening candle itself (no post-open bar yet)', () => {
    expect(openingRangeBoxSignal([openingCandle(0)]).type).toBe('none');
  });

  it('flags range_short when an intact box top is tapped and rejected', () => {
    const candles = [
      openingCandle(0),
      bar(100, 111, 99, 100, ts(1)), // pokes the top, closes back at mid with an upper wick
    ];
    const sig = openingRangeBoxSignal(candles);
    expect(sig.type).toBe('range_short');
    expect(sig.entry).toBe(100);
    expect(sig.stop).toBe(111);
    expect(sig.target).toBe(90); // opposite edge
    expect(sig.riskReward).toBeGreaterThan(0);
  });

  it('flags range_long when an intact box bottom is tapped and rejected', () => {
    const candles = [
      openingCandle(0),
      bar(100, 101, 89, 100, ts(1)), // pokes the bottom, closes back at mid with a lower wick
    ];
    const sig = openingRangeBoxSignal(candles);
    expect(sig.type).toBe('range_long');
    expect(sig.entry).toBe(100);
    expect(sig.stop).toBe(89);
    expect(sig.target).toBe(110);
  });

  it('flags breakout_long on a pullback that retests the box top after a clean break', () => {
    const candles = [
      openingCandle(0),
      bar(110, 122, 110, 120, ts(1)), // clean close above the box top
      bar(113, 114, 110, 113, ts(2)), // pulls back to the top, holds above with a lower wick
    ];
    const sig = openingRangeBoxSignal(candles);
    expect(sig.type).toBe('breakout_long');
    expect(sig.entry).toBe(113);
    expect(sig.stop).toBe(90); // far side of the box, per the video's stop rule
    expect(sig.target).toBe(133); // entry + 1 box height
    expect(sig.riskReward).toBeGreaterThan(0);
  });

  it('flags breakout_short on a pullback that retests the box bottom after a clean break', () => {
    const candles = [
      openingCandle(0),
      bar(90, 90, 78, 80, ts(1)), // clean close below the box bottom
      bar(87, 90, 86, 87, ts(2)), // pulls back to the bottom, holds below with an upper wick
    ];
    const sig = openingRangeBoxSignal(candles);
    expect(sig.type).toBe('breakout_short');
    expect(sig.entry).toBe(87);
    expect(sig.stop).toBe(110); // far (top) side of the box
    expect(sig.target).toBe(67); // entry − 1 box height
  });

  it('prefers the breakout retest over a fade once the top has been broken', () => {
    // Same top tap as range_short, but a prior bar already closed above the box —
    // so the pullback is a breakout retest (long), not a fade (short).
    const candles = [
      openingCandle(0),
      bar(110, 125, 110, 120, ts(1)), // clean break above
      bar(113, 114, 110, 113, ts(2)), // retest hold
    ];
    expect(openingRangeBoxSignal(candles).type).toBe('breakout_long');
  });

  it('returns none on a quiet bar that touches neither edge', () => {
    const candles = [openingCandle(0), bar(100, 101, 99, 100, ts(1))];
    expect(openingRangeBoxSignal(candles).type).toBe('none');
  });

  it('respects a custom UTC open time', () => {
    const open = bar(100, 110, 90, 100, Date.UTC(2026, 0, 1, 14, 30));
    const next = bar(100, 111, 99, 100, Date.UTC(2026, 0, 1, 15, 30));
    const sig = openingRangeBoxSignal([open, next], { openHourUtc: 14, openMinuteUtc: 30 });
    expect(sig.type).toBe('range_short');
  });

  it('scales the breakout target with targetBoxMultiple', () => {
    const candles = [
      openingCandle(0),
      bar(110, 122, 110, 120, ts(1)),
      bar(113, 114, 110, 113, ts(2)),
    ];
    const sig = openingRangeBoxSignal(candles, { targetBoxMultiple: 3 });
    expect(sig.target).toBe(113 + 3 * 20); // entry + 3 box heights
  });
});
