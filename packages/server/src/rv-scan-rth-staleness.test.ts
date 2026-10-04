// TRA-5087 — the in-RTH staleness discriminator.
//
// The acceptance is a SEPARATION: the same 20.7h-stale `lastScanAt` must read
// RED mid-RTH on a session day and GREEN on a weekend/holiday/overnight. Every
// case here pins one side of that line, and the first one is the incident's own
// instants verbatim: the 2026-10-03 read that got filed as an RTH outage was a
// SATURDAY, and the route gave the reader nothing to catch that with.
import { describe, it, expect } from 'vitest';
import {
  gradeRvScanRthStaleness,
  RV_SCAN_ARMING_GRACE_MS,
  RV_SCAN_STALE_IN_RTH_THRESHOLD_MS,
} from './rv-scan-rth-staleness.js';

/** The newest scan of the 2026-10-02 (Friday) session, from the live payload. */
const FRIDAY_CLOSE_SCAN = Date.parse('2026-10-02T19:59:59.326Z');

describe('TRA-5087 gradeRvScanRthStaleness — green outside the session', () => {
  it('CONTROL — the incident read itself: Saturday 2026-10-03 12:39 ET, lastScanAt at Friday close, is GREEN out_of_session', () => {
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-10-03T16:39:53Z'),
      lastScanAtMs: FRIDAY_CLOSE_SCAN,
      armed: true,
      bootedAtMs: Date.parse('2026-10-02T12:51:47.439Z'),
    });
    expect(g.state).toBe('out_of_session');
    expect(g.ok).toBe(true);
    expect(g.session).toBe('non_session');
    expect(g.inRth).toBe(false);
    // The reason must carry the calendar fact the 10-03 reader lacked.
    expect(g.reason).toMatch(/not an NYSE session/);
    expect(g.etDay).toBe('2026-10-03');
  });

  it('overnight pre-open on a session day is GREEN, not stale', () => {
    // Friday 07:00 ET: session day, but the open is hours away.
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-10-02T11:00:00Z'),
      lastScanAtMs: Date.parse('2026-10-01T19:59:00Z'),
      armed: true,
      bootedAtMs: null,
    });
    expect(g.state).toBe('out_of_session');
    expect(g.ok).toBe(true);
    expect(g.reason).toMatch(/pre-open/);
  });

  it('post-close on a session day is GREEN, not stale', () => {
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-10-02T21:00:00Z'),
      lastScanAtMs: FRIDAY_CLOSE_SCAN,
      armed: true,
      bootedAtMs: null,
    });
    expect(g.state).toBe('out_of_session');
    expect(g.ok).toBe(true);
    expect(g.reason).toMatch(/post-close/);
  });

  it('an NYSE closure is GREEN and NAMES the holiday — a stale weekday read must not page', () => {
    // Thanksgiving 2026 falls on Thursday 11-26.
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-11-26T17:00:00Z'),
      lastScanAtMs: Date.parse('2026-11-25T20:59:00Z'),
      armed: true,
      bootedAtMs: null,
    });
    expect(g.state).toBe('out_of_session');
    expect(g.ok).toBe(true);
    expect(g.reason).toMatch(/Thanksgiving/);
  });

  it('honours the 13:00 ET early close: 14:00 ET on 2026-11-27 is post-close, never stale', () => {
    // The day after Thanksgiving closes at 13:00 ET (18:00Z in EST). A grader
    // using the regular 16:00 ET close would call this mid-RTH and page.
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-11-27T19:00:00Z'),
      lastScanAtMs: Date.parse('2026-11-27T15:00:00Z'),
      armed: true,
      bootedAtMs: null,
    });
    expect(g.state).toBe('out_of_session');
    expect(g.ok).toBe(true);
    expect(g.sessionCloseUtc).toBe('2026-11-27T18:00:00.000Z');
  });

  it('resolves the session window in ET, not a hard-coded 13:30Z: 14:00Z in January is pre-open', () => {
    // 2026-01-15 (Thursday) is EST: the open is 14:30Z. The EDT constant
    // (13:30Z) would call 14:00Z in-RTH and manufacture a stale read.
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-01-15T14:00:00Z'),
      lastScanAtMs: Date.parse('2026-01-14T20:59:00Z'),
      armed: true,
      bootedAtMs: null,
    });
    expect(g.state).toBe('out_of_session');
    expect(g.reason).toMatch(/pre-open/);
    expect(g.sessionOpenUtc).toBe('2026-01-15T14:30:00.000Z');
  });
});

describe('TRA-5087 gradeRvScanRthStaleness — red inside the session', () => {
  // Friday 2026-10-02, 14:00 ET: mid-RTH on an ordinary session day, with the
  // process up since pre-open so no grace applies.
  const MID_RTH = Date.parse('2026-10-02T18:00:00Z');
  const BOOT_PRE_OPEN = Date.parse('2026-10-02T12:51:47Z');

  it('the incident one day earlier: a day-old lastScanAt mid-RTH is stale_in_rth and NOT ok', () => {
    const g = gradeRvScanRthStaleness({
      nowMs: MID_RTH,
      lastScanAtMs: Date.parse('2026-10-01T19:59:59Z'),
      armed: true,
      bootedAtMs: BOOT_PRE_OPEN,
    });
    expect(g.state).toBe('stale_in_rth');
    expect(g.ok).toBe(false);
    expect(g.inRth).toBe(true);
    expect(g.reason).toMatch(/dark-in-RTH/);
    // The reason names the last scan so the operator does not re-derive it.
    expect(g.reason).toContain('2026-10-01T19:59:59');
  });

  it('never-scanned past every grace is stale_in_rth, not a quiet variant of scanning', () => {
    const g = gradeRvScanRthStaleness({
      nowMs: MID_RTH,
      lastScanAtMs: null,
      armed: true,
      bootedAtMs: BOOT_PRE_OPEN,
    });
    expect(g.state).toBe('stale_in_rth');
    expect(g.ok).toBe(false);
    expect(g.ageMs).toBeNull();
    expect(g.reason).toMatch(/NO scan has completed since boot/);
  });

  it('a fresh scan mid-RTH is fresh_in_rth', () => {
    const g = gradeRvScanRthStaleness({
      nowMs: MID_RTH,
      lastScanAtMs: MID_RTH - 5 * 60_000,
      armed: true,
      bootedAtMs: BOOT_PRE_OPEN,
    });
    expect(g.state).toBe('fresh_in_rth');
    expect(g.ok).toBe(true);
    expect(g.ageMs).toBe(5 * 60_000);
  });

  it('the red line sits at the threshold, not at the session boundary', () => {
    const justUnder = gradeRvScanRthStaleness({
      nowMs: MID_RTH,
      lastScanAtMs: MID_RTH - (RV_SCAN_STALE_IN_RTH_THRESHOLD_MS - 1_000),
      armed: true,
      bootedAtMs: BOOT_PRE_OPEN,
    });
    const justOver = gradeRvScanRthStaleness({
      nowMs: MID_RTH,
      lastScanAtMs: MID_RTH - (RV_SCAN_STALE_IN_RTH_THRESHOLD_MS + 1_000),
      armed: true,
      bootedAtMs: BOOT_PRE_OPEN,
    });
    expect(justUnder.state).toBe('fresh_in_rth');
    expect(justOver.state).toBe('stale_in_rth');
  });
});

describe('TRA-5087 gradeRvScanRthStaleness — graces and the non-accusable states', () => {
  it('inside the post-open grace a stale lastScanAt from yesterday does not page', () => {
    // 09:40 ET on 2026-10-02: ten minutes after the open.
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-10-02T13:40:00Z'),
      lastScanAtMs: Date.parse('2026-10-01T19:59:59Z'),
      armed: true,
      bootedAtMs: Date.parse('2026-10-02T12:51:47Z'),
    });
    expect(g.state).toBe('arming_grace');
    expect(g.ok).toBe(true);
  });

  it('one minute past the post-open grace, still unscanned, IS the page', () => {
    const openMs = Date.parse('2026-10-02T13:30:00Z');
    const g = gradeRvScanRthStaleness({
      nowMs: openMs + RV_SCAN_ARMING_GRACE_MS + 60_000,
      lastScanAtMs: Date.parse('2026-10-01T19:59:59Z'),
      armed: true,
      bootedAtMs: Date.parse('2026-10-02T12:51:47Z'),
    });
    expect(g.state).toBe('stale_in_rth');
    expect(g.ok).toBe(false);
  });

  it('a watchdog restart mid-session gets the boot grace instead of an instant accusation', () => {
    const nowMs = Date.parse('2026-10-02T18:00:00Z');
    const g = gradeRvScanRthStaleness({
      nowMs,
      lastScanAtMs: null,
      armed: true,
      bootedAtMs: nowMs - 10 * 60_000,
    });
    expect(g.state).toBe('arming_grace');
    expect(g.ok).toBe(true);
    expect(g.reason).toMatch(/booted/);
  });

  it('a fully disarmed scanner mid-RTH reads disarmed, never stale — the remedies are opposite', () => {
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2026-10-02T18:00:00Z'),
      lastScanAtMs: null,
      armed: false,
      bootedAtMs: Date.parse('2026-10-02T12:51:47Z'),
    });
    expect(g.state).toBe('disarmed');
    expect(g.ok).toBe(true);
  });

  it('⛔ an uncovered calendar date fails CLOSED — "could not check" never reads green', () => {
    // 2036 is past the generated bundle (nyse-2015-2035).
    const g = gradeRvScanRthStaleness({
      nowMs: Date.parse('2036-06-02T18:00:00Z'),
      lastScanAtMs: Date.parse('2036-06-02T17:59:00Z'),
      armed: true,
      bootedAtMs: null,
    });
    expect(g.state).toBe('calendar_uncovered');
    expect(g.ok).toBe(false);
    expect(g.session).toBe('uncovered');
  });
});
