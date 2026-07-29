import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { MarketScheduler, isMarketDay, isMarketDayIso, missedTradingDays, etDayOfWeekIso } from './scheduler.js';

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
    // TRA-414 — scheduler now routes the callback error through the structured
    // logger; an `error` record is written to stderr as a JSON line.
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    scheduler.start({ onDaily });

    vi.advanceTimersByTime(60_000);
    // Let the rejected promise settle.
    await vi.advanceTimersByTimeAsync(0);

    expect(onDaily).toHaveBeenCalledTimes(1);
    const dailyErr = errSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('scheduled callback error'));
    expect(dailyErr).toContain('"label":"daily EOD"');
    expect(dailyErr).toContain('"reason":"boom"');

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

  /**
   * TRA-2498 — the archive must NOT fire in the 00:00–00:59 ET hour.
   *
   * On Node 20 (the prod runtime) a bare `hour12: false` renders midnight as
   * `24:00`, so `hour >= 21` passed at 00:00 ET; that fire then stamped
   * `lastArchiveDate` with the already-new ET date and dedup-suppressed the
   * genuine 21:00 fire that evening. Net: one archive per day, at midnight,
   * forever.
   *
   * HONEST SCOPE: CI runs Node 22 (h23), where this test also passes WITHOUT
   * the fix — it only moves on Node 20. The version-independent lock for the
   * midnight contract is `et-clock.test.ts`'s literal `'24:00'` parse arm. This
   * pair pins the scheduler-level behaviour on the prod runtime.
   */
  it('does not fire onArchive during the 00:xx ET hour (TRA-2498 midnight hour-24)', () => {
    // 00:00 ET on 2026-07-27 (EDT, UTC-4) = 04:00 UTC; back off 60 s so the
    // first poll tick lands exactly on 00:00 ET.
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 3, 59, 0)));
    const onArchive = vi.fn();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000); // → 00:00 ET
    expect(onArchive).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59 * 60_000); // → 00:59 ET, still inside the h24 window
    expect(onArchive).not.toHaveBeenCalled();
  });

  it('still fires onArchive that same ET evening at 21:00 (TRA-2498 dedup not poisoned)', () => {
    // The other half of the defect: the midnight fire consumed the ET day's
    // dedup key, so the real 21:00 fire was suppressed. Run the midnight window
    // and the 21:00 boundary against ONE scheduler and assert the evening fire
    // still lands.
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 27, 3, 59, 0)));
    const onArchive = vi.fn();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000); // 00:00 ET — must not consume the day's key
    expect(onArchive).not.toHaveBeenCalled();

    // 21:00 ET the same ET day (2026-07-27) = 2026-07-28T01:00:00Z.
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 28, 0, 59, 0)));
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
    // TRA-414 — callback error now goes through the structured logger (stderr).
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    scheduler.start({ onHourly });

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(onHourly).toHaveBeenCalledTimes(1);
    const hourlyErr = errSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('scheduled callback error'));
    expect(hourlyErr).toContain('"label":"hourly"');
    expect(hourlyErr).toContain('"reason":"boom"');

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

describe('MarketScheduler — TRA-368 onPremarket 9 AM ET hook', () => {
  let scheduler: MarketScheduler;

  // 9:00 AM ET (EDT, UTC-4) → 13:00 UTC; back off 60 s for the first tick.
  const at0900EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 12, 59, 0));

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new MarketScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('fires onPremarket exactly once at 9:00 AM ET on a normal weekday', () => {
    // 2026-04-30 = Thursday, 9:00 EDT
    vi.setSystemTime(at0900EDT(2026, 4, 30));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(1);
  });

  it('does not fire onPremarket on a weekend', () => {
    // 2026-05-02 = Saturday
    vi.setSystemTime(at0900EDT(2026, 5, 2));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).not.toHaveBeenCalled();
  });

  it('does not fire onPremarket on a US market holiday', () => {
    // Memorial Day 2026 = Monday, May 25
    vi.setSystemTime(at0900EDT(2026, 5, 25));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).not.toHaveBeenCalled();
  });

  it('does not double-fire onPremarket within the same ET day (idempotency)', () => {
    vi.setSystemTime(at0900EDT(2026, 4, 30));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(1);

    // Time wedges at 9:00 — next polling tick is still inside the same
    // ET minute. Must NOT re-fire.
    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(1);
  });

  // TRA-2064 — the pre-bell catch-up window. The old gate was `minute === 0`:
  // one 60s sample per day. A restart or an event-loop stall across that single
  // minute dropped the whole trading day silently, starving the only caller of
  // the news-catalyst writer (TRA-1630 accrued 0 rows in 5 armed sessions).
  it('catches up when the process misses the exact 9:00 minute', () => {
    // Boot at 9:07 ET — the 9:00 sample never happened.
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 13, 6, 0)));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(1);
  });

  it('still fires only once per ET day across the catch-up window', () => {
    vi.setSystemTime(at0900EDT(2026, 4, 30));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(1);

    // Walk forward through the rest of the window (9:01 … 9:29).
    for (let m = 1; m < 30; m += 1) {
      vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 13, m, 0)));
      vi.advanceTimersByTime(60_000);
    }
    expect(onPremarket).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire at or after the 9:30 bell — pre-market semantics stop there', () => {
    // 9:30 ET. The callback stamps a regime review labelled `premarket` and
    // builds a pre-market watchlist; firing intraday would mislabel the day.
    vi.setSystemTime(new Date(Date.UTC(2026, 3, 30, 13, 29, 0)));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).not.toHaveBeenCalled();
  });

  it('fires onPremarket again on the next trading day', () => {
    vi.setSystemTime(at0900EDT(2026, 4, 30));
    const onPremarket = vi.fn();
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(1);

    // Jump to 9:00 ET the following day.
    vi.setSystemTime(at0900EDT(2026, 5, 1));
    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(2);
  });

  it('catches async errors thrown by onPremarket and keeps subsequent days firing', async () => {
    vi.setSystemTime(at0900EDT(2026, 4, 30));
    const onPremarket = vi
      .fn()
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValue(undefined);
    // TRA-414 — callback error now goes through the structured logger (stderr).
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    scheduler.start({ onPremarket });

    vi.advanceTimersByTime(60_000);
    await vi.advanceTimersByTimeAsync(0);

    expect(onPremarket).toHaveBeenCalledTimes(1);
    const premarketErr = errSpy.mock.calls
      .map((c) => String(c[0]))
      .find((l) => l.includes('scheduled callback error'));
    expect(premarketErr).toContain('"label":"pre-market"');
    expect(premarketErr).toContain('"reason":"boom"');

    // Next ET day should still fire — error did not poison the schedule.
    vi.setSystemTime(at0900EDT(2026, 5, 1));
    vi.advanceTimersByTime(60_000);
    expect(onPremarket).toHaveBeenCalledTimes(2);

    errSpy.mockRestore();
  });
});

describe('MarketScheduler — TRA-849 onMorningBrief 8:30 AM ET hook', () => {
  let scheduler: MarketScheduler;

  // 8:30 AM ET (EDT, UTC-4) → 12:30 UTC; back off 60 s for the first tick.
  const at0830EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 12, 29, 0));
  // 9:00 AM ET catch-up boundary → 13:00 UTC; back off 60 s.
  const at0900EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 12, 59, 0));
  // 8:00 AM ET (before the window opens) → 12:00 UTC; back off 60 s.
  const at0800EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 11, 59, 0));

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new MarketScheduler();
  });

  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('fires onMorningBrief once at 8:30 AM ET on a normal weekday', () => {
    vi.setSystemTime(at0830EDT(2026, 4, 30)); // Thursday
    const onMorningBrief = vi.fn();
    scheduler.start({ onMorningBrief });

    vi.advanceTimersByTime(60_000);
    expect(onMorningBrief).toHaveBeenCalledTimes(1);
  });

  it('does not fire onMorningBrief before 8:30 ET', () => {
    vi.setSystemTime(at0800EDT(2026, 4, 30));
    const onMorningBrief = vi.fn();
    scheduler.start({ onMorningBrief });

    vi.advanceTimersByTime(60_000);
    expect(onMorningBrief).not.toHaveBeenCalled();
  });

  it('does not fire onMorningBrief on a weekend or holiday', () => {
    vi.setSystemTime(at0830EDT(2026, 5, 2)); // Saturday
    const sat = vi.fn();
    scheduler.start({ onMorningBrief: sat });
    vi.advanceTimersByTime(60_000);
    expect(sat).not.toHaveBeenCalled();
    scheduler.stop();

    const holiday = vi.fn();
    const sched2 = new MarketScheduler();
    vi.setSystemTime(at0830EDT(2026, 5, 25)); // Memorial Day
    sched2.start({ onMorningBrief: holiday });
    vi.advanceTimersByTime(60_000);
    expect(holiday).not.toHaveBeenCalled();
    sched2.stop();
  });

  it('fires once across the 8:30 → 9:00 window (catch-up does not double-fire)', () => {
    vi.setSystemTime(at0830EDT(2026, 4, 30));
    const onMorningBrief = vi.fn();
    scheduler.start({ onMorningBrief });

    // Tick every minute from 8:30 through past 9:00 — dedup keeps it to one.
    for (let i = 0; i < 40; i++) vi.advanceTimersByTime(60_000);
    expect(onMorningBrief).toHaveBeenCalledTimes(1);
  });

  it('catches up at the 9:00 boundary when the server missed 8:30', () => {
    // Server first ticks at 9:00 ET (was redeploying across 8:30).
    vi.setSystemTime(at0900EDT(2026, 4, 30));
    const onMorningBrief = vi.fn();
    scheduler.start({ onMorningBrief });

    vi.advanceTimersByTime(60_000);
    expect(onMorningBrief).toHaveBeenCalledTimes(1);
  });

  it('fires again on the next trading day', () => {
    vi.setSystemTime(at0830EDT(2026, 4, 30));
    const onMorningBrief = vi.fn();
    scheduler.start({ onMorningBrief });

    vi.advanceTimersByTime(60_000);
    expect(onMorningBrief).toHaveBeenCalledTimes(1);

    vi.setSystemTime(at0830EDT(2026, 5, 1)); // Friday
    vi.advanceTimersByTime(60_000);
    expect(onMorningBrief).toHaveBeenCalledTimes(2);
  });
});

// ── TRA-388: archive fires at OR AFTER 21:00 ET ──────────────────────────────

describe('MarketScheduler — TRA-388 archive window', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('fires onArchive when the server first ticks at 22:30 ET (after the 21:00 boundary)', () => {
    // 22:30 EDT = next-day 02:30 UTC; back off 60 s for the first poll tick.
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 2, 29, 0)));
    const onArchive = vi.fn();
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000);
    expect(onArchive).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('still fires onArchive exactly once when the server is up across 21:00 → 23:00 ET', () => {
    vi.setSystemTime(at2100EDT(2026, 5, 1));
    const onArchive = vi.fn();
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive });

    // Many ticks across the evening — dedup keeps it to one fire per ET day.
    for (let i = 0; i < 120; i++) vi.advanceTimersByTime(60_000);
    expect(onArchive).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });

  it('does not fire onArchive before 21:00 ET', () => {
    // 20:30 EDT = next-day 00:30 UTC; back off 60 s.
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 16, 0, 29, 0)));
    const onArchive = vi.fn();
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000);
    expect(onArchive).not.toHaveBeenCalled();
    scheduler.stop();
  });
});

// ── TRA-1404: persisted archive dedup key survives a post-21:00 restart ───────

describe('MarketScheduler — TRA-1404 persisted archive dedup key', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /** In-memory ArchiveDateStore standing in for the on-disk file across restarts. */
  const makeStore = (initial = '') => {
    let value = initial;
    return {
      load: vi.fn(() => value),
      save: vi.fn((d: string) => { value = d; }),
      /** Peek at what a "next boot" would restore. */
      current: () => value,
    };
  };

  // NB: UTC(2026,4,15,2,29) is 22:29 EDT on 2026-05-14 (ET = UTC-4), so the ET
  // day the archive keys off is 2026-05-14 (matching the TRA-388 window tests).
  it('persists the ET date to the store when the archive fires', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 2, 29, 0)));
    const onArchive = vi.fn();
    const store = makeStore();
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive }, { archiveDateStore: store });

    vi.advanceTimersByTime(60_000);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(store.save).toHaveBeenCalledWith('2026-05-14');
    expect(store.current()).toBe('2026-05-14');
    scheduler.stop();
  });

  it('does NOT re-fire onArchive on a post-21:00 restart of an already-archived day', () => {
    // Simulate a process that already archived 2026-05-14 (store carries the key),
    // then redeploys and reboots at 22:29 ET the SAME day — the in-memory guard is
    // fresh (''), but the restored key must suppress the re-fire.
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 2, 29, 0)));
    const onArchive = vi.fn();
    const store = makeStore('2026-05-14');
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive }, { archiveDateStore: store });

    // Run many ticks across the rest of the evening — none should fire.
    for (let i = 0; i < 60; i++) vi.advanceTimersByTime(60_000);
    expect(store.load).toHaveBeenCalled();
    expect(onArchive).not.toHaveBeenCalled();
    scheduler.stop();
  });

  it('still archives normally when the restored key is a PRIOR day', () => {
    // Restart at 22:29 ET on 2026-05-14 carrying yesterday's (2026-05-13) key —
    // today is not yet archived, so the archive must still fire exactly once.
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 2, 29, 0)));
    const onArchive = vi.fn();
    const store = makeStore('2026-05-13');
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive }, { archiveDateStore: store });

    vi.advanceTimersByTime(60_000);
    expect(onArchive).toHaveBeenCalledTimes(1);
    expect(store.current()).toBe('2026-05-14');
    scheduler.stop();
  });

  it('is a no-op path when no store is provided (legacy in-memory behavior)', () => {
    vi.setSystemTime(new Date(Date.UTC(2026, 4, 15, 2, 29, 0)));
    const onArchive = vi.fn();
    const scheduler = new MarketScheduler();
    scheduler.start({ onArchive });

    vi.advanceTimersByTime(60_000);
    expect(onArchive).toHaveBeenCalledTimes(1);
    scheduler.stop();
  });
});

// ── TRA-388: missed-day catch-up ─────────────────────────────────────────────

describe('isMarketDayIso', () => {
  it('returns true for ordinary weekdays', () => {
    expect(isMarketDayIso('2026-05-14')).toBe(true); // Thursday
    expect(isMarketDayIso('2026-05-15')).toBe(true); // Friday
  });

  it('returns false for weekends', () => {
    expect(isMarketDayIso('2026-05-16')).toBe(false); // Saturday
    expect(isMarketDayIso('2026-05-17')).toBe(false); // Sunday
  });

  it('returns false for NYSE holidays', () => {
    expect(isMarketDayIso('2026-05-25')).toBe(false); // Memorial Day
    expect(isMarketDayIso('2026-01-01')).toBe(false); // New Year's Day
  });

  it('returns false for malformed input', () => {
    expect(isMarketDayIso('not-a-date')).toBe(false);
    expect(isMarketDayIso('2026-5-1')).toBe(false);
  });
});

describe('missedTradingDays', () => {
  it('finds the TRA-388 gap: Thu 5/14 + Fri 5/15 missing, last report 5/13', () => {
    // Mirrors the reported calendar: reports through 5/13, today is 5/17.
    const existing = ['2026-05-05', '2026-05-11', '2026-05-12', '2026-05-13'];
    expect(missedTradingDays(existing, '2026-05-17')).toEqual([
      '2026-05-14',
      '2026-05-15',
    ]);
  });

  it('skips weekends inside the gap', () => {
    // Last report Fri 5/8; today Wed 5/13 → only weekdays 5/11, 5/12 backfilled.
    expect(missedTradingDays(['2026-05-08'], '2026-05-13')).toEqual([
      '2026-05-11',
      '2026-05-12',
    ]);
  });

  it('skips NYSE holidays inside the gap', () => {
    // Memorial Day 2026 = Mon 5/25. Gap from Fri 5/22 to Wed 5/27.
    expect(missedTradingDays(['2026-05-22'], '2026-05-27')).toEqual([
      '2026-05-26',
    ]);
  });

  it('returns nothing when reports are already current', () => {
    expect(missedTradingDays(['2026-05-14', '2026-05-15'], '2026-05-16')).toEqual([]);
  });

  it('returns nothing when there is no anchor report', () => {
    expect(missedTradingDays([], '2026-05-17')).toEqual([]);
  });

  it('does not backfill older gaps before the most recent report', () => {
    // 5/6, 5/8 are blank but predate the 5/11 report — not reconstructable.
    const existing = ['2026-05-05', '2026-05-11'];
    expect(missedTradingDays(existing, '2026-05-14')).toEqual([
      '2026-05-12',
      '2026-05-13',
    ]);
  });

  it('never includes today or future dates', () => {
    const out = missedTradingDays(['2026-05-11'], '2026-05-13');
    expect(out).not.toContain('2026-05-13');
    expect(out.every(d => d < '2026-05-13')).toBe(true);
  });

  it('caps the backfill window to maxLookbackDays', () => {
    // Anchor far in the past; with a 3-day window only 5/12–5/14 are eligible
    // (today 5/15 itself is always excluded), and 5/11 falls outside the cap.
    const out = missedTradingDays(['2026-04-01'], '2026-05-15', 3);
    expect(out).toEqual(['2026-05-12', '2026-05-13', '2026-05-14']);
  });
});

// ── TRA-1971 — weekly options roll-up hook ───────────────────────────────────

describe('etDayOfWeekIso', () => {
  it('returns the day-of-week (0=Sun … 6=Sat) for a YYYY-MM-DD, TZ-independent', () => {
    expect(etDayOfWeekIso('2026-07-12')).toBe(0); // Sunday
    expect(etDayOfWeekIso('2026-07-13')).toBe(1); // Monday
    expect(etDayOfWeekIso('2026-07-14')).toBe(2); // Tuesday
    expect(etDayOfWeekIso('2026-07-17')).toBe(5); // Friday
  });

  it('returns -1 for a malformed date', () => {
    expect(etDayOfWeekIso('not-a-date')).toBe(-1);
  });
});

describe('MarketScheduler — TRA-1971 onWeeklyRollup hook', () => {
  // 07:00 EDT (July, UTC-4) → 11:00 UTC → back off 60 s → 10:59 UTC.
  const at0700EDT = (yyyy: number, mm: number, dd: number) =>
    new Date(Date.UTC(yyyy, mm - 1, dd, 10, 59, 0));

  let scheduler: MarketScheduler;
  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new MarketScheduler();
  });
  afterEach(() => {
    scheduler.stop();
    vi.useRealTimers();
  });

  it('fires once on Monday 07:00 ET', () => {
    vi.setSystemTime(at0700EDT(2026, 7, 13)); // 2026-07-13 = Monday
    const onWeeklyRollup = vi.fn();
    scheduler.start({ onWeeklyRollup });
    vi.advanceTimersByTime(60_000);
    expect(onWeeklyRollup).toHaveBeenCalledTimes(1);
  });

  it('does NOT fire on a Tuesday', () => {
    vi.setSystemTime(at0700EDT(2026, 7, 14)); // Tuesday
    const onWeeklyRollup = vi.fn();
    scheduler.start({ onWeeklyRollup });
    vi.advanceTimersByTime(60_000);
    expect(onWeeklyRollup).not.toHaveBeenCalled();
  });

  it('dedupes to a single fire per Monday across multiple ticks', () => {
    vi.setSystemTime(at0700EDT(2026, 7, 13)); // Monday
    const onWeeklyRollup = vi.fn();
    scheduler.start({ onWeeklyRollup });
    vi.advanceTimersByTime(60_000); // 07:00 ET
    vi.advanceTimersByTime(60_000); // 07:01 ET — still Monday-morning window
    expect(onWeeklyRollup).toHaveBeenCalledTimes(1);
  });

  it('still fires later in the Monday morning window (07:00–11:59 ET catch-up)', () => {
    // Server was asleep at 07:00; comes up at 09:30 ET (13:30 UTC → back off 60s).
    vi.setSystemTime(new Date(Date.UTC(2026, 6, 13, 13, 29, 0)));
    const onWeeklyRollup = vi.fn();
    scheduler.start({ onWeeklyRollup });
    vi.advanceTimersByTime(60_000); // 09:30 ET Monday
    expect(onWeeklyRollup).toHaveBeenCalledTimes(1);
  });
});
