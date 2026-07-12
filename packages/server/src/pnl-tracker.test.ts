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

// TRA-1633 BUG 2 — the weekly/monthly/yearly windows summed each snapshot's
// `combinedPnl`, which was booked from the mode's ALL-TIME cumulative options
// P&L (`optionsAccount.optionsPnl`). So every window with option activity
// inflated vs the Calendar — the same phantom class TRA-1557 removed from
// all-time. The fix sums day-only `dailyPnl + optionsDailyPnl` instead.
describe('TRA-1633 — window sums use day-only options, not cumulative combinedPnl', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-b2-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // A snapshot whose combinedPnl is the (buggy) cumulative-options figure but
  // whose dailyPnl / optionsDailyPnl are the honest day-only realized values.
  const cumSnap = (
    date: string, dailyPnl: number, optionsDailyPnl: number, cumulativeOptions: number,
  ): DailySnapshot => ({
    date,
    openingEquity: 25_000,
    closingEquity: 25_000 + dailyPnl,
    dailyPnl,
    optionsPnl: cumulativeOptions,                    // all-time cumulative (the old bug source)
    optionsDailyPnl,                                  // day-only realized (the fix)
    combinedPnl: dailyPnl + cumulativeOptions,        // inflated — must NOT be summed
    trades: 1,
  });

  it('weekly/monthly/yearly sum day-only realized, ignoring cumulative-options carry', () => {
    // Two past days this year, each with growing cumulative options but small
    // day-only options. Dates fixed early-year so they fall in the yearly window.
    const now = new Date();
    const year = now.getFullYear();
    // Guard: on Jan 1–3 there is no meaningful "earlier this year" window; the
    // assertion below still holds (both sums 0) so no special-casing needed.
    const d1 = `${year}-01-02`;
    const d2 = `${year}-01-03`;

    const t = new PnlTracker(dir, 25_000);
    // Persist directly via saveSnapshot so the rows land on disk + in memory.
    t.saveSnapshot(cumSnap(d1, 100, 20, 500));   // day-only 120, cumulative carries 500
    t.saveSnapshot(cumSnap(d2, -30, 5, 800));    // day-only −25, cumulative carries 800

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const inYear = [d1, d2].filter(d => d < today && d >= `${year}-01-01`);
    const expectedDayOnly = inYear.reduce((acc, d) =>
      acc + (d === d1 ? 120 : -25), 0);

    const stats = t.getCumulativeStats(24_970);
    // Yearly window = Σ day-only (120 − 25 = 95 when both rows are past-today),
    // NEVER the cumulative-inflated combinedPnl (which would be 100+500 + −30+800
    // = 1370).
    expect(stats.yearlyPnl).toBeCloseTo(expectedDayOnly, 6);
    expect(stats.yearlyPnl).not.toBeCloseTo(1_370, 3);
  });

  it('treats a legacy snapshot with no optionsDailyPnl as stock-only (no phantom)', () => {
    const year = new Date().getFullYear();
    const d = `${year}-01-02`;
    // Legacy row: no optionsDailyPnl field, combinedPnl carries cumulative options.
    const legacy: DailySnapshot = {
      date: d, openingEquity: 25_000, closingEquity: 25_100,
      dailyPnl: 100, optionsPnl: 900, combinedPnl: 1_000, trades: 1,
    };
    const t = new PnlTracker(dir, 25_000);
    t.saveSnapshot(legacy);

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const expected = d < today ? 100 : 0; // stock-only 100, not the 1,000 combined
    expect(t.getCumulativeStats(25_100).yearlyPnl).toBeCloseTo(expected, 6);
  });
});
