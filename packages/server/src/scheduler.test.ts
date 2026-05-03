import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarketScheduler, isMarketDay } from './scheduler.js';

/**
 * TRA-193 — coverage for the scheduler that drives both the per-market-day
 * stocks EOD callback and the every-calendar-day crypto EOD callback. Before
 * this file, `scheduler.ts` had no tests at all, and the original TRA-193 fix
 * (commit `8229e9b`) was verified only by manual smoke + the report-folder
 * tests. These exercises the time/holiday/idempotency edges that QA flagged
 * in the TRA-193 review thread.
 *
 * Approach: vitest fake timers + `vi.setSystemTime` to pin "now" at exact
 * 16:05 / 21:00 ET boundaries, then `vi.advanceTimersByTime(60_000)` to fire
 * exactly one polling tick. Because `scheduler.ts` derives ET via
 * `Intl.DateTimeFormat`-based `toLocaleString({timeZone: 'America/New_York'})`,
 * the timezone math is consistent across CI and local machines.
 */

// The scheduler polls every 60 s; the first interval tick fires 60 s AFTER
// `start()`, so each helper sets system time 60 s BEFORE the target wall-clock.
// `vi.advanceTimersByTime(60_000)` then lands the callback at the target ET
// minute (e.g. 16:05) instead of 16:06.
//
// 16:05 EDT (May, daylight time, UTC-4) → 20:05 UTC → set clock to 20:04 UTC.
// 16:05 EST (Nov–Mar, standard time, UTC-5) → 21:05 UTC → set clock to 21:04 UTC.
// 21:00 EDT → next-day 01:00 UTC → set clock to 00:59 UTC next day.
const at1605EDT = (yyyy: number, mm: number, dd: number) =>
  new Date(Date.UTC(yyyy, mm - 1, dd, 20, 4, 0));
const at1605EST = (yyyy: number, mm: number, dd: number) =>
  new Date(Date.UTC(yyyy, mm - 1, dd, 21, 4, 0));
const at2100EDT = (yyyy: number, mm: number, dd: number) =>
  // 21:00 ET = next-day 01:00 UTC under EDT; back off 60 s → 00:59 UTC.
  new Date(Date.UTC(yyyy, mm - 1, dd + 1, 0, 59, 0));

describe('isMarketDay', () => {
  it('returns false for weekends', () => {
    // 2026-05-02 is a Saturday, 2026-05-03 is a Sunday
    expect(isMarketDay(new Date(Date.UTC(2026, 4, 2, 17, 0, 0)))).toBe(false);
    expect(isMarketDay(new Date(Date.UTC(2026, 4, 3, 17, 0, 0)))).toBe(false);
  });

  it('returns false for US market holidays', () => {
    // Memorial Day 2026 = May 25 (Monday)
    expect(isMarketDay(new Date(Date.UTC(2026, 4, 25, 17, 0, 0)))).toBe(false);
    // Juneteenth 2026 = June 19 (Friday)
    expect(isMarketDay(new Date(Date.UTC(2026, 5, 19, 17, 0, 0)))).toBe(false);
  });

  it('returns true for normal weekdays', () => {
    // 2026-04-30 is a Thursday and not a holiday
    expect(isMarketDay(new Date(Date.UTC(2026, 3, 30, 17, 0, 0)))).toBe(true);
  });
});

describe('MarketScheduler — TRA-193 onDaily / onMarketClose / onArchive', () => {
  let scheduler: MarketScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new MarketScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('fires onDaily on a Saturday but does NOT fire onMarketClose (weekend)', () => {
    // 2026-05-02 = Saturday, 16:05 EDT
    vi.setSystemTime(at1605EDT(2026, 5, 2));
    const onMarketClose = vi.fn();
    const onDaily = vi.fn();
    scheduler.start({ onMarketClose, onDaily });

    vi.advanceTimersByTime(60_000);

    expect(onDaily).toHaveBeenCalledTimes(1);
    expect(onMarketClose).not.toHaveBeenCalled();
  });

  it('fires onDaily on a US market holiday but does NOT fire onMarketClose', () => {
    // Memorial Day 2026 = Monday, May 25, 16:05 EDT
    vi.setSystemTime(at1605EDT(2026, 5, 25));
    const onMarketClose = vi.fn();
    const onDaily = vi.fn();
    scheduler.start({ onMarketClose, onDaily });

    vi.advanceTimersByTime(60_000);

    expect(onDaily).toHaveBeenCalledTimes(1);
    expect(onMarketClose).not.toHaveBeenCalled();
  });

  it('fires both onDaily and onMarketClose exactly once on a normal weekday', () => {
    // 2026-04-30 = Thursday, 16:05 EDT
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const onMarketClose = vi.fn();
    const onDaily = vi.fn();
    scheduler.start({ onMarketClose, onDaily });

    vi.advanceTimersByTime(60_000);

    expect(onDaily).toHaveBeenCalledTimes(1);
    expect(onMarketClose).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire either callback on subsequent 16:05 ticks within the same ET day (idempotency)', () => {
    // 2026-04-30 = Thursday, 16:05 EDT
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const onMarketClose = vi.fn();
    const onDaily = vi.fn();
    scheduler.start({ onMarketClose, onDaily });

    // First tick fires both.
    vi.advanceTimersByTime(60_000);
    expect(onMarketClose).toHaveBeenCalledTimes(1);
    expect(onDaily).toHaveBeenCalledTimes(1);

    // Time wedges at 16:05 (e.g. clock-jitter); the next polling tick is still
    // inside the same ET minute → must NOT re-fire.
    vi.advanceTimersByTime(60_000);
    expect(onMarketClose).toHaveBeenCalledTimes(1);
    expect(onDaily).toHaveBeenCalledTimes(1);
  });

  it('fires again on the next ET day at 16:05', () => {
    // Day 1 = 2026-04-30 (Thu), Day 2 = 2026-05-01 (Fri)
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const onMarketClose = vi.fn();
    const onDaily = vi.fn();
    scheduler.start({ onMarketClose, onDaily });

    vi.advanceTimersByTime(60_000);
    expect(onMarketClose).toHaveBeenCalledTimes(1);
    expect(onDaily).toHaveBeenCalledTimes(1);

    // Jump to 16:05 ET the following day.
    vi.setSystemTime(at1605EDT(2026, 5, 1));
    vi.advanceTimersByTime(60_000);
    expect(onMarketClose).toHaveBeenCalledTimes(2);
    expect(onDaily).toHaveBeenCalledTimes(2);
  });

  it('legacy single-callback start(fn) form routes only to onMarketClose (regression)', () => {
    // 2026-04-30 = Thursday → both branches would fire if a config object
    // were passed. With the legacy form, only onMarketClose runs.
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const cb = vi.fn();
    scheduler.start(cb);

    vi.advanceTimersByTime(60_000);

    // The legacy form only registers onMarketClose. cb fires once for that
    // single callback path.
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('legacy single-callback start(fn) does NOT fire on a weekend', () => {
    // 2026-05-02 = Saturday — onMarketClose only path means no fire.
    vi.setSystemTime(at1605EDT(2026, 5, 2));
    const cb = vi.fn();
    scheduler.start(cb);

    vi.advanceTimersByTime(60_000);

    expect(cb).not.toHaveBeenCalled();
  });

  it('does not re-arm if start() is called twice', () => {
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const onDaily = vi.fn();
    scheduler.start({ onDaily });
    scheduler.start({ onDaily }); // second start is a no-op

    vi.advanceTimersByTime(60_000);
    expect(onDaily).toHaveBeenCalledTimes(1);
  });

  it('catches async errors thrown by onDaily and keeps the timer alive', async () => {
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const onDaily = vi.fn().mockRejectedValue(new Error('boom'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scheduler.start({ onDaily });

    vi.advanceTimersByTime(60_000);
    // Let the rejected promise settle.
    await vi.advanceTimersByTimeAsync(0);

    expect(onDaily).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith(
      '[scheduler] daily EOD callback error:',
      expect.any(Error),
    );

    // Next ET day should still fire — error did not poison the schedule.
    vi.setSystemTime(at1605EDT(2026, 5, 1));
    vi.advanceTimersByTime(60_000);
    expect(onDaily).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });

  it('fires onArchive at 21:00 ET (TRA-219 / TRA-241) every calendar day, including weekends', () => {
    // 2026-05-02 = Saturday, 21:00 EDT.
    vi.setSystemTime(at2100EDT(2026, 5, 2));
    const onArchive = vi.fn();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000);
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire onArchive within the same ET day', () => {
    vi.setSystemTime(at2100EDT(2026, 5, 2));
    const onArchive = vi.fn();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000);
    vi.advanceTimersByTime(60_000); // still 21:00 — same minute window
    expect(onArchive).toHaveBeenCalledTimes(1);
  });

  it('handles the spring-forward DST boundary (2026-03-08): 16:05 ET still fires once', () => {
    // 2026-03-08 = Sunday (spring-forward). After the jump, 16:05 ET is EDT.
    // Date math: 16:05 EDT on 2026-03-08 = 20:05 UTC.
    vi.setSystemTime(at1605EDT(2026, 3, 8));
    const onDaily = vi.fn();
    const onMarketClose = vi.fn();
    scheduler.start({ onDaily, onMarketClose });

    vi.advanceTimersByTime(60_000);
    // Sunday → onMarketClose blocked, onDaily fires.
    expect(onDaily).toHaveBeenCalledTimes(1);
    expect(onMarketClose).not.toHaveBeenCalled();
  });

  it('handles the fall-back DST boundary (2026-11-01): 16:05 ET still fires once', () => {
    // 2026-11-01 = Sunday (fall-back). After the jump, 16:05 ET is EST.
    // 16:05 EST = 21:05 UTC.
    vi.setSystemTime(at1605EST(2026, 11, 1));
    const onDaily = vi.fn();
    const onMarketClose = vi.fn();
    scheduler.start({ onDaily, onMarketClose });

    vi.advanceTimersByTime(60_000);
    expect(onDaily).toHaveBeenCalledTimes(1);
    expect(onMarketClose).not.toHaveBeenCalled();
  });

  it('stop() cleanly cancels the timer (no further callback fires)', () => {
    vi.setSystemTime(at1605EDT(2026, 4, 30));
    const onDaily = vi.fn();
    scheduler.start({ onDaily });
    scheduler.stop();

    vi.advanceTimersByTime(60_000);
    expect(onDaily).not.toHaveBeenCalled();
  });

  it('fireNow() runs the supplied callback immediately', async () => {
    const cb = vi.fn();
    await scheduler.fireNow(cb);
    expect(cb).toHaveBeenCalledTimes(1);
  });
});

describe('MarketScheduler — TRA-249-D onHourly funding hook', () => {
  let scheduler: MarketScheduler;

  // Top-of-hour 16:00 ET (EDT, UTC-4) → 20:00 UTC; back off 60 s for the
  // first interval tick.
  const at1600EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 19, 59, 0));
  // Next hour boundary: 17:00 EDT → 21:00 UTC.
  const at1700EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 20, 59, 0));

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new MarketScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('fires onHourly exactly once at minute=0 on a normal weekday', () => {
    vi.setSystemTime(at1600EDT(2026, 4, 30));
    const onHourly = vi.fn();
    scheduler.start({ onHourly });

    vi.advanceTimersByTime(60_000);
    expect(onHourly).toHaveBeenCalledTimes(1);
  });

  it('does not double-fire onHourly within the same ET hour (jitter / clock-wedge)', () => {
    vi.setSystemTime(at1600EDT(2026, 4, 30));
    const onHourly = vi.fn();
    scheduler.start({ onHourly });

    vi.advanceTimersByTime(60_000);
    expect(onHourly).toHaveBeenCalledTimes(1);

    // Wall clock parks at 16:00:30 — the next polling tick is still inside
    // the same ET hour-and-minute window. Must NOT re-fire.
    vi.advanceTimersByTime(30_000);
    expect(onHourly).toHaveBeenCalledTimes(1);
  });

  it('fires again at the top of the next ET hour', () => {
    vi.setSystemTime(at1600EDT(2026, 4, 30));
    const onHourly = vi.fn();
    scheduler.start({ onHourly });

    vi.advanceTimersByTime(60_000);
    expect(onHourly).toHaveBeenCalledTimes(1);

    // Jump to 17:00 ET — distinct hour bucket; must fire again.
    vi.setSystemTime(at1700EDT(2026, 4, 30));
    vi.advanceTimersByTime(60_000);
    expect(onHourly).toHaveBeenCalledTimes(2);
  });

  it('catches async errors thrown by onHourly and keeps subsequent hours firing', async () => {
    vi.setSystemTime(at1600EDT(2026, 4, 30));
    const onHourly = vi.fn().mockRejectedValueOnce(new Error('boom')).mockResolvedValue(undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    scheduler.start({ onHourly });

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(onHourly).toHaveBeenCalledTimes(1);
    expect(errSpy).toHaveBeenCalledWith('[scheduler] hourly callback error:', expect.any(Error));

    vi.setSystemTime(at1700EDT(2026, 4, 30));
    vi.advanceTimersByTime(60_000);
    expect(onHourly).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });

  it('does not affect onArchive / onDaily when only onHourly is registered', () => {
    vi.setSystemTime(at1600EDT(2026, 4, 30));
    const onHourly = vi.fn();
    const onArchive = vi.fn();
    const onDaily = vi.fn();
    scheduler.start({ onHourly });

    vi.advanceTimersByTime(60_000);
    expect(onHourly).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();
    expect(onDaily).not.toHaveBeenCalled();
  });
});
