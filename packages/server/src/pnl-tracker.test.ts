import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
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
    // 26,000 WITHOUT a booked snapshot for the elapsed day and re-anchor,
    // orphaning the +1,300 delta from the ledger.
    //
    // TRA-3039 — the re-anchor is now driven by `syncOpeningEquity`, the REBASE
    // path (starting-balance edit / mode switch / forced reset). That is the
    // other re-anchor source TRA-1557's own root-cause note names, and it is the
    // one that still leaks. The DAY-ROLL leak is gone: `advanceDayIfNeeded` was
    // overwriting a correct `closingEquity(N-1)` anchor with the trade-path
    // `state.equity` cache on every boot into a new ET day, and it now preserves
    // it. Without the rebase line below the reload would (correctly) keep the
    // 24,700 close, leaving no orphaned delta for `allTimePnl` to reconcile away
    // — i.e. the scenario would have no failing state left to pin.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(24_500, 0);
    t1.saveSnapshot(snap('2020-01-02', 25_000, 24_500));
    t1.saveEquity(24_700, 0);
    t1.saveSnapshot(snap('2020-01-03', 24_500, 24_700));
    // Un-booked drift: equity moves but no snapshot is written for that day.
    t1.saveEquity(26_000, 0);
    t1.syncOpeningEquity(26_000, 0);

    // Reload (a new day): openingEquity sits at the re-anchored 26,000, so the
    // +1,300 is un-booked.
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

// TRA-3039 — THE DAY ROLL RE-ANCHORED OVER A SESSION THAT ACTUALLY CLOSED.
//
// `saveSnapshot` writes `openingEquity = closingEquity` / `openingDate =
// snapshot.date` as a pair meaning "this anchor is the close of `openingDate`".
// `advanceDayIfNeeded` read the same pair as "this anchor OPENS `openingDate`",
// so on every boot into a new ET day it overwrote that correct anchor with
// `state.equity` — a cache only the TRADE path (`saveEquity`) ever writes. The
// 21:00 ET writer then booked
//
//     stockDaily = (equity - openingEquity) - creditWindow
//
// over a window starting BEFORE the prior close, re-booking a slice of the
// previous session into this one.
//
// Live bqb1 2026-08-05: 31 of 47 gradeable books wrote an 08-05 row whose
// derived `openingEquity` was byte-identical to the 08-04 row's `openingEquity`
// and different from the 08-04 row's `closingEquity`. 5 of them additionally
// tripped the TRA-2658 frozen-counter arm and were reported as a credit
// regression; they are not one. Both cases below are real books, to the cent.
describe('TRA-3039 — the day roll preserves an anchor a real close established', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-3039-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // The row the 21:00 ET writer would produce next, by the production formula
  // at `index.ts` (`stockOnlyDailyPnl`). This is what the defect corrupts, so
  // the assertions are on the booked number rather than only on the anchor.
  const nextStockDaily = (t: PnlTracker, equity: number, creditWindow: number) =>
    Math.round(((equity - t.getOpeningEquity()) - creditWindow) * 100) / 100;

  // `advanceDayIfNeeded` only runs when `openingDate !== todayKey()`, so every
  // session date here is fixed FAR in the past. Using the real 2026-08-04 /
  // 2026-08-05 dates made these clock-dependent: on 2026-08-05 itself the
  // second date IS today, the roll never fires, and a test can pass without
  // reaching the branch it names. The DOLLAR figures are the live ones; the
  // dates are not what makes the reproduction faithful.
  const D1 = '2020-01-06';
  const D2 = '2020-01-07';

  it('ctoverify_tra2333 — equity absorbed +73.05 the trade path never saw', () => {
    // The durable account file restored equity 25,073.05 at boot; `saveEquity`
    // is never called on that path, so `state.equity` stayed at 25,000. Before
    // the fix the roll anchored the new session on that stale 25,000 and the
    // next row booked the whole 73.05 as stock P&L a second time.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(25_000, 0);
    t1.saveSnapshot(snap(D1, 25_000, 25_073.05));
    expect(t1.getOpeningEquity()).toBeCloseTo(25_073.05, 6);

    const t2 = new PnlTracker(dir, 25_000);
    // The anchor is the recorded close, NOT the stale trade-path cache.
    expect(t2.getOpeningEquity()).toBeCloseTo(25_073.05, 6);
    expect(t2.getOpeningEquity()).not.toBeCloseTo(25_000, 3);
    // An idle session books nothing. Before the fix this was +73.05.
    expect(nextStockDaily(t2, 25_073.05, 0)).toBeCloseTo(0, 6);
  });

  it('qa_tra2511_114524 — a credit landed in state.equity AFTER the close', () => {
    // The mirror image: `state.equity` ran AHEAD of the recorded close (the
    // option-credit sink moved equity post-close and did call `saveEquity`),
    // then the durable account restored to the pre-credit 31,403. Anchoring on
    // `state.equity` booked -54.94 of phantom stock loss. Both directions occur
    // live (22 books anchored below the prior close, 14 above), which is why no
    // "pick the fresher of the two files" rule can fix this — only the recorded
    // close is correct.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(31_403, 0);
    t1.saveSnapshot(snap(D1, 31_523.94, 31_403));
    t1.saveEquity(31_457.94, 0); // post-close credit reaches the tracker cache

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBeCloseTo(31_403, 6);
    expect(t2.getOpeningEquity()).not.toBeCloseTo(31_457.94, 3);
    expect(nextStockDaily(t2, 31_403, 0)).toBeCloseTo(0, 6);
  });

  it('the anchor telescopes across two consecutive closes', () => {
    // The invariant the whole reconciliation identity rests on:
    // openingEquity(N) === closingEquity(N-1), so the daily rows chain.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(D1, 25_000, 25_073.05));
    const t2 = new PnlTracker(dir, 25_000);
    t2.saveSnapshot(snap(D2, t2.getOpeningEquity(), 25_100));
    const t3 = new PnlTracker(dir, 25_000);
    expect(t3.getOpeningEquity()).toBeCloseTo(25_100, 6);
  });

  // ── Controls: the branches that must KEEP rolling ────────────────────────

  it('CONTROL — a rebase still re-anchors, so it does not read as daily P&L', () => {
    // TRA-138. `syncOpeningEquity` deliberately moves the anchor off the prior
    // close, which breaks the equality the preserve branch tests for, so the
    // roll still runs and the +25,000 starting-balance edit stays invisible to
    // daily P&L rather than being booked as a one-session gain.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(D1, 25_000, 25_073.05));
    t1.saveEquity(50_000, 0);
    t1.syncOpeningEquity(50_000, 0);

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBeCloseTo(50_000, 6);
    expect(nextStockDaily(t2, 50_000, 0)).toBeCloseTo(0, 6);
  });

  it('CONTROL — a session that never CLOSED still rolls from state.equity', () => {
    // The case `advanceDayIfNeeded` was written for (TRA-241): the process
    // crossed a day boundary with no 21:00 ET archive, so `openingDate` is a
    // day the snapshot ledger has no row for. Nothing recorded a close to
    // anchor on, and the roll keeps the dashboard from opening at a phantom.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(D1, 25_000, 25_073.05));
    t1.saveEquity(26_000, 0);
    // Hand-advance `openingDate` past the last booked row, exactly as a boot on
    // a no-close day leaves it.
    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    raw.openingDate = D2;
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBeCloseTo(26_000, 6);
  });

  it('CONTROL — an unmeasured close (TRA-2829 null) falls back to the roll', () => {
    // A back-filled row whose equity anchor could not be measured writes
    // `closingEquity: null`. `saveSnapshot` leaves `openingEquity` alone there,
    // so there is no recorded close to preserve and the roll must still run
    // rather than treating `null` as a match.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(D1, 25_000, 25_073.05));
    t1.saveEquity(26_000, 0);
    t1.saveSnapshot({
      date: D2, openingEquity: null, closingEquity: null,
      dailyPnl: 0, optionsPnl: 0, combinedPnl: 0, trades: 0,
    });
    // openingDate is still D1 (the null row did not stamp it), but the
    // LATEST row is the null D2 one, so no anchor can be vouched for.
    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBeCloseTo(26_000, 6);
  });
});
