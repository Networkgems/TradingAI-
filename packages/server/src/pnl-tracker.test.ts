import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PnlTracker, type DailySnapshot } from './pnl-tracker.js';

// TRA-1557 — the admin demo Calendar / footer showed a phantom all-time gain
// (+$1,067) that disagreed with the realized daily-snapshot ledger (−$1,144).
// Root cause: `getCumulativeStats().allTimePnl` was the raw equity mark
// (`currentEquity - initialEquity`), which absorbs "un-booked equity
// re-anchors" — an overnight/reboot day-roll that advances `openingEquity`
// without booking a snapshot for the elapsed day. The delta vanishes from the
// ledger but stays in equity, so the equity-mark all-time floats free of every
// other P&L window. The fix reconciles all-time to the booked ledger.

const snap = (date: string, openingEquity: number, closingEquity: number): DailySnapshot => ({
  date,
  openingEquity,
  closingEquity,
  dailyPnl: closingEquity - openingEquity,
  optionsPnl: 0,
  combinedPnl: closingEquity - openingEquity,
  trades: 1,
});

describe('TRA-1557 — allTimePnl reconciles with the booked daily-snapshot ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('on a continuously-booked book, all-time still equals the equity mark', () => {
    const t = new PnlTracker(dir, 25_000);
    // Two telescoping days: 25,000 → 24,500 (−500) → 24,700 (+200).
    t.saveEquity(24_500, 0);
    t.saveSnapshot(snap('2020-01-02', 25_000, 24_500));
    t.saveEquity(24_700, 0);
    t.saveSnapshot(snap('2020-01-03', 24_500, 24_700));

    // openingEquity telescoped to the last close (24,700); no drift today.
    const stats = t.getCumulativeStats(24_700);
    // Booked ledger sum (−500 + 200) + today-running (0) = −300 = 24,700 − 25,000.
    expect(stats.allTimePnl).toBeCloseTo(-300, 6);
    expect(stats.allTimePnl).toBeCloseTo(24_700 - 25_000, 6);
  });

  it("today's not-yet-booked running gain is still included in all-time", () => {
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(24_500, 0);
    t.saveSnapshot(snap('2020-01-02', 25_000, 24_500));
    // Today the book is up to 24,900 but nothing has been booked yet.
    const stats = t.getCumulativeStats(24_900);
    // Booked (−500) + today-running (24,900 − 24,500 = +400) = −100.
    expect(stats.allTimePnl).toBeCloseTo(-100, 6);
    expect(stats.allTimePnl).toBeCloseTo(24_900 - 25_000, 6);
  });

  it('drops the phantom gain from an un-booked equity re-anchor', () => {
    // Book two honest days ending at 24,700, then let the book drift up to
    // 26,000 overnight WITHOUT a booked snapshot (server down at the 21:00 ET
    // archive) and reload — `advanceDayIfNeeded` re-anchors openingEquity to
    // 26,000, orphaning the +1,300 delta from the ledger.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(24_500, 0);
    t1.saveSnapshot(snap('2020-01-02', 25_000, 24_500));
    t1.saveEquity(24_700, 0);
    t1.saveSnapshot(snap('2020-01-03', 24_500, 24_700));
    // Un-booked drift: equity moves but no snapshot is written for that day.
    t1.saveEquity(26_000, 0);

    // Reload (a new day): the constructor's advanceDayIfNeeded re-anchors
    // openingEquity to the current 26,000, so the +1,300 is now un-booked.
    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBe(26_000);

    const stats = t2.getCumulativeStats(26_000);
    // Equity mark (the old, phantom answer) would be 26,000 − 25,000 = +1,000.
    // Honest booked-ledger answer keeps only the two real days: −500 + 200 = −300.
    expect(stats.allTimePnl).toBeCloseTo(-300, 6);
    expect(stats.allTimePnl).not.toBeCloseTo(1_000, 3);
    // The realized ledger windows are unaffected by the reconciliation.
    expect(stats.yearlyPnl).toBeCloseTo(0, 6); // 2020 rows are before this year's start
  });
});
