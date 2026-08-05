import { describe, it, expect } from 'vitest';
import { liveBackfillWriteWindow } from './tradier-reconcile.js';

/**
 * TRA-2874 — `backfillLiveRealizedCalendar` is the only thing that can put a
 * P&L number on a live calendar day with no 21:00 EOD balance snapshot. Its
 * write window used to start on the first of LAST month (`monthsBack = 1`),
 * which made every earlier day structurally unreachable and — worse — made the
 * unreachability ROLLING: a day got one month of chances, then aged out
 * permanently.
 *
 * The acceptance criterion in the ticket is the June tape of the board's live
 * account, which must be inside the write window.
 */
const MONTHS_BACK = 24;
const FETCH_LOOKBACK_DAYS = 31;

/** The ticket's ground-truth table: FIFO-matched against Tradier's own gain/loss report. */
const JUNE_TAPE: Array<[string, number]> = [
  ['2026-06-04', -180.27],
  ['2026-06-09', 11.85],
  ['2026-06-11', -80.72],
  ['2026-06-12', -141.72],
  ['2026-06-15', 125.75],
  ['2026-06-16', -163.15],
  ['2026-06-25', -409.59],
];

describe('TRA-2874 — the live realized backfill can reach the account history', () => {
  it('covers every June 2026 day the old 1-month window excluded', () => {
    const { writeStart, end } = liveBackfillWriteWindow('2026-08-05', MONTHS_BACK, FETCH_LOOKBACK_DAYS);
    expect(writeStart).toBe('2024-08-01');

    for (const [date] of JUNE_TAPE) {
      expect(date >= writeStart && date < end, `${date} must be writable`).toBe(true);
    }
  });

  it('pins what the old window did — every June day was unreachable', () => {
    const { writeStart } = liveBackfillWriteWindow('2026-08-05', 1, FETCH_LOOKBACK_DAYS);
    expect(writeStart).toBe('2026-07-01');

    const unreachable = JUNE_TAPE.filter(([d]) => d < writeStart);
    expect(unreachable).toHaveLength(JUNE_TAPE.length);

    // −$837.85 of real realized P&L, structurally unwritable.
    const lost = unreachable.reduce((a, [, v]) => a + v, 0);
    expect(lost).toBeCloseTo(-837.85, 2);
  });

  it('does not roll June out of the window next month (the amnesia regression)', () => {
    // At monthsBack = 1 the boundary moved to 2026-08-01 on 2026-09-01 and
    // July fell out too. The whole point of the fix is that it does not.
    for (const today of ['2026-09-01', '2026-10-01', '2027-01-15', '2027-06-30']) {
      const { writeStart } = liveBackfillWriteWindow(today, MONTHS_BACK, FETCH_LOOKBACK_DAYS);
      for (const [date] of JUNE_TAPE) {
        expect(date >= writeStart, `${date} must still be writable on ${today}`).toBe(true);
      }
    }

    // Contrast: the old window loses them almost immediately.
    const old = liveBackfillWriteWindow('2026-09-01', 1, FETCH_LOOKBACK_DAYS);
    expect(JUNE_TAPE.every(([d]) => d < old.writeStart)).toBe(true);
  });

  it('reaches back past the live account inception (balance series starts 2026-05-18)', () => {
    const { writeStart } = liveBackfillWriteWindow('2026-08-05', MONTHS_BACK, FETCH_LOOKBACK_DAYS);
    expect(writeStart < '2026-05-18').toBe(true);
  });

  it('still excludes today — today is owned by the intraday cell and the 9 PM snapshot', () => {
    const { end } = liveBackfillWriteWindow('2026-08-05', MONTHS_BACK, FETCH_LOOKBACK_DAYS);
    expect(end).toBe('2026-08-05');
    // `inWindow` at the call site is `d >= writeStart && d < today`.
    expect('2026-08-05' < end).toBe(false);
  });

  it('keeps the fetch window ahead of the write window so opens still pair', () => {
    const { writeStart, fetchStart } = liveBackfillWriteWindow(
      '2026-08-05',
      MONTHS_BACK,
      FETCH_LOOKBACK_DAYS,
    );
    expect(fetchStart < writeStart).toBe(true);
    expect(fetchStart).toBe('2024-07-01');
  });

  it('normalises across a year boundary', () => {
    const { writeStart } = liveBackfillWriteWindow('2026-02-10', MONTHS_BACK, FETCH_LOOKBACK_DAYS);
    expect(writeStart).toBe('2024-02-01');
  });
});
