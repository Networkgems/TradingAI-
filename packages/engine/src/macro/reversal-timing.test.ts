import { describe, it, expect } from 'vitest';
import type { MacroEvent } from './macro-client.js';
import {
  getReversalTimingWindows,
  isInReversalWindow,
  isInNewsWindow,
  dailyNewsSummary,
} from './reversal-timing.js';

// US equities open: 9:30 ET = 13:30 UTC (EDT, UTC-4)
const OPEN_MS = Date.UTC(2026, 5, 17, 13, 30); // 2026-06-17 13:30 UTC

describe('getReversalTimingWindows', () => {
  it('returns two windows at +15m and +30m by default', () => {
    const wins = getReversalTimingWindows(OPEN_MS);
    expect(wins).toHaveLength(2);
    expect(wins[0].label).toBe('+15m');
    expect(wins[1].label).toBe('+30m');
  });

  it('+15m window is centered 15 min after open with ±5 min half-width', () => {
    const [w15] = getReversalTimingWindows(OPEN_MS);
    const center = OPEN_MS + 15 * 60_000;
    expect(w15.startMs).toBe(center - 5 * 60_000);
    expect(w15.endMs).toBe(center + 5 * 60_000);
  });

  it('respects custom windowMinutes and halfWidthMinutes', () => {
    const wins = getReversalTimingWindows(OPEN_MS, { windowMinutes: [20], halfWidthMinutes: 3 });
    expect(wins).toHaveLength(1);
    const center = OPEN_MS + 20 * 60_000;
    expect(wins[0].startMs).toBe(center - 3 * 60_000);
    expect(wins[0].endMs).toBe(center + 3 * 60_000);
  });
});

describe('isInReversalWindow', () => {
  it('returns true at the +15m center', () => {
    const t = OPEN_MS + 15 * 60_000;
    expect(isInReversalWindow(t, OPEN_MS)).toBe(true);
  });

  it('returns true at +30m center', () => {
    const t = OPEN_MS + 30 * 60_000;
    expect(isInReversalWindow(t, OPEN_MS)).toBe(true);
  });

  it('returns true at the edge of the +15m window (startMs inclusive)', () => {
    const edge = OPEN_MS + 15 * 60_000 - 5 * 60_000;
    expect(isInReversalWindow(edge, OPEN_MS)).toBe(true);
  });

  it('returns false at endMs (exclusive)', () => {
    const after = OPEN_MS + 15 * 60_000 + 5 * 60_000; // exactly at endMs
    expect(isInReversalWindow(after, OPEN_MS)).toBe(false);
  });

  it('returns false when well outside both windows', () => {
    const t = OPEN_MS + 60 * 60_000; // +1h, nowhere near +15m or +30m
    expect(isInReversalWindow(t, OPEN_MS)).toBe(false);
  });

  it('returns false at market open itself (before the first window)', () => {
    expect(isInReversalWindow(OPEN_MS, OPEN_MS)).toBe(false);
  });
});

describe('isInNewsWindow', () => {
  const CPI_DAY = '2026-06-17';

  // CPI drops at 08:30 ET = 12:30 UTC under EDT (UTC-4)
  const CPI_RELEASE_UTC = Date.UTC(2026, 5, 17, 12, 30);

  const cpiEvent: MacroEvent = {
    type: 'CPI',
    date: CPI_DAY,
    importance: 'high',
    title: 'CPI',
    source: 'fred',
  };

  it('flags a time exactly at the CPI release (within ±30m)', () => {
    expect(isInNewsWindow(CPI_RELEASE_UTC, [cpiEvent])).toBe(true);
  });

  it('flags a time 29 minutes before the CPI release', () => {
    expect(isInNewsWindow(CPI_RELEASE_UTC - 29 * 60_000, [cpiEvent])).toBe(true);
  });

  it('clears a time 31 minutes after the CPI release', () => {
    expect(isInNewsWindow(CPI_RELEASE_UTC + 31 * 60_000, [cpiEvent])).toBe(false);
  });

  it('ignores low-importance events by default', () => {
    const lowEvent: MacroEvent = { ...cpiEvent, importance: 'low' };
    expect(isInNewsWindow(CPI_RELEASE_UTC, [lowEvent])).toBe(false);
  });

  it('includes medium events when minImportance is medium', () => {
    const medEvent: MacroEvent = { ...cpiEvent, importance: 'medium' };
    expect(isInNewsWindow(CPI_RELEASE_UTC, [medEvent], { minImportance: 'medium' })).toBe(true);
  });

  it('returns false when events list is empty', () => {
    expect(isInNewsWindow(CPI_RELEASE_UTC, [])).toBe(false);
  });

  it('ignores events on a different day', () => {
    const yesterday = { ...cpiEvent, date: '2026-06-16' };
    expect(isInNewsWindow(CPI_RELEASE_UTC, [yesterday])).toBe(false);
  });

  it('uses FOMC time (14:00 ET = 18:00 UTC EDT) for FOMC events', () => {
    const fomcEvent: MacroEvent = {
      type: 'FOMC',
      date: CPI_DAY,
      importance: 'high',
      title: 'FOMC rate decision',
      source: 'curated',
    };
    const fomcUtc = Date.UTC(2026, 5, 17, 18, 0); // 14:00 ET = 18:00 UTC
    expect(isInNewsWindow(fomcUtc, [fomcEvent])).toBe(true);
    expect(isInNewsWindow(CPI_RELEASE_UTC, [fomcEvent])).toBe(false);
  });
});

describe('dailyNewsSummary', () => {
  const cpi: MacroEvent = {
    type: 'CPI',
    date: '2026-06-17',
    importance: 'high',
    title: 'CPI',
    source: 'fred',
  };
  const low: MacroEvent = {
    type: 'NFP',
    date: '2026-06-17',
    importance: 'low',
    title: 'minor NFP',
    source: 'fred',
  };

  it('returns today high events and excludes low-importance ones', () => {
    const s = dailyNewsSummary([cpi, low], OPEN_MS);
    expect(s.hasHighImpact).toBe(true);
    expect(s.events).toHaveLength(1);
    expect(s.events[0].type).toBe('CPI');
  });

  it('sets hasMediumImpact only when medium events exist', () => {
    const med: MacroEvent = { ...cpi, importance: 'medium' };
    const s = dailyNewsSummary([med], OPEN_MS);
    expect(s.hasHighImpact).toBe(false);
    expect(s.hasMediumImpact).toBe(true);
  });

  it('returns the two default reversal timing windows', () => {
    const s = dailyNewsSummary([], OPEN_MS);
    expect(s.reversalWindows).toHaveLength(2);
    expect(s.reversalWindows[0].label).toBe('+15m');
  });
});
