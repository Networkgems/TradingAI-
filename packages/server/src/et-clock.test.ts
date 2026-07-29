import { describe, it, expect } from 'vitest';
import { formatEtClock, parseEtClockParts, etClockParts, etHour } from './et-clock.js';

/**
 * TRA-2498 — regression lock for the midnight hour-24 defect that made the
 * 21:00 ET archive fire at 00:00 ET on prod (Node 20) every day.
 *
 * ## Read this before "simplifying" the literal-string tests
 *
 * The defect only reproduces on Node 20's ICU (`hour12: false` → h24), and CI
 * runs Node 22 (h23). So a test shaped like
 *
 *     expect(etHour(new Date('2026-07-27T04:00:33Z'))).toBe(0)   // ← NOT a lock
 *
 * passes on CI *whether or not the fix is present* — it is green in the fixed
 * world and green in the broken world, so it is not evidence. `parseEtClockParts`
 * takes a string precisely so the midnight contract can be pinned independently
 * of the runtime's hour cycle: the `'24:00'` cases below FAIL on the unfixed
 * parser on every Node version. Those are the real regression lock.
 *
 * Each block is a pair: one arm proves the fix is present, the other proves it
 * did not over-correct (a parser that simply returned 0 would satisfy the
 * midnight arm alone).
 */

describe('parseEtClockParts — TRA-2498 midnight normalisation', () => {
  // ARM A — the defect. Fails on the unfixed parser on ANY Node version.
  it('folds an h24 midnight hour (24:MM) onto hour 0', () => {
    expect(parseEtClockParts('07/27/2026, 24:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseEtClockParts('07/27/2026, 24:59')).toEqual({ hour: 0, minute: 59 });
  });

  // ARM B — over-correction guard. Fails if the parser hard-codes hour 0.
  it('leaves every non-midnight hour untouched', () => {
    expect(parseEtClockParts('07/27/2026, 21:00')).toEqual({ hour: 21, minute: 0 });
    expect(parseEtClockParts('07/27/2026, 00:00')).toEqual({ hour: 0, minute: 0 });
    expect(parseEtClockParts('07/27/2026, 16:05')).toEqual({ hour: 16, minute: 5 });
    expect(parseEtClockParts('07/27/2026, 09:30')).toEqual({ hour: 9, minute: 30 });
    expect(parseEtClockParts('07/27/2026, 23:59')).toEqual({ hour: 23, minute: 59 });
  });

  it('returns null when the rendering does not parse', () => {
    expect(parseEtClockParts('')).toBeNull();
    expect(parseEtClockParts('not a timestamp')).toBeNull();
  });
});

describe('formatEtClock — hourCycle pin', () => {
  /**
   * Guards the `hourCycle: 'h23'` option (and that no `hour12` crept back in to
   * override it). On Node 22 this passes either way; on Node 20 it is the arm
   * that actually moves. Kept for the prod runtime, not for CI.
   */
  it('renders ET midnight as 00, never 24', () => {
    // 2026-07-27T04:00:33Z = 00:00:33 ET (EDT, UTC-4) — the exact prod sample
    // from the TRA-2498 tape.
    expect(formatEtClock(new Date('2026-07-27T04:00:33Z'))).toBe('07/27/2026, 00:00');
    expect(formatEtClock(new Date('2026-07-27T04:59:59Z'))).toBe('07/27/2026, 00:59');
  });

  it('renders the 21:00 ET archive boundary and honours DST', () => {
    // 21:00 EDT = next-day 01:00 UTC.
    expect(formatEtClock(new Date('2026-07-27T01:00:00Z'))).toBe('07/26/2026, 21:00');
    // 21:00 EST (January, UTC-5) = next-day 02:00 UTC.
    expect(formatEtClock(new Date('2026-01-16T02:00:00Z'))).toBe('01/15/2026, 21:00');
  });
});

describe('etClockParts / etHour — end-to-end', () => {
  it('reports ET midnight as hour 0 and the archive boundary as 21', () => {
    expect(etClockParts(new Date('2026-07-27T04:00:33Z'))).toEqual({ hour: 0, minute: 0 });
    expect(etHour(new Date('2026-07-27T04:00:33Z'))).toBe(0);
    expect(etHour(new Date('2026-07-27T01:00:00Z'))).toBe(21);
    expect(etHour(new Date('2026-07-27T19:30:00Z'))).toBe(15);
  });
});
