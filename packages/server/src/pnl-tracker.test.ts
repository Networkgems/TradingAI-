import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PnlTracker, ANCHOR_BASIS_VERIFIED, type DailySnapshot } from './pnl-tracker.js';

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

    // TRA-3421 — the window basis is now every booked row in the window (today's
    // INCLUDED) plus today's running delta, so the filter is `>= yearStart` with
    // no upper bound rather than `< today`. The old `d < today` predicate made
    // this expectation silently wrong on Jan 2–3, the only days these fixture
    // dates are not "past"; the guard comment above claimed both sides collapsed
    // to 0 there, which stopped being true once today counts.
    const inYear = [d1, d2].filter(d => d >= `${year}-01-01`);
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

    // TRA-3421 — the row counts whether or not it is "past"; `saveSnapshot`
    // rebased `openingEquity` to its 25,100 close, so today's running delta is 0
    // and the window is the booked row alone.
    expect(t.getCumulativeStats(25_100).yearlyPnl).toBeCloseTo(100, 6); // stock-only 100, not the 1,000 combined
  });
});

// TRA-3239 — allTimePnl EXCLUDED the booked options leg the windows include.
//
// Post-TRA-2323 every option close credits equity, so `openingEquity`
// telescopes over closes that CONTAIN options P&L — but the booked sum fed to
// all-time was stock `dailyPnl` only. Live repro (demo book `qa3120t0806a`,
// bqb1, 2026-08-11): two option closes ever (+80 booked 08-10, +26 realized
// 08-11), equity 25,106 on a 25,000 start. One /api/state read served
// weekly/monthly/yearly 80 and allTimePnl 26 — an all-time strictly SMALLER
// than the weekly window inside it — and after the day roll allTimePnl read
// ~1e-13. The true +106 never appeared on any read.
describe('TRA-3239 — allTimePnl includes the booked options leg (same basis as the windows)', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-3239-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const optSnap = (date: string, openingEquity: number, closingEquity: number, optionsDailyPnl: number): DailySnapshot => ({
    date,
    openingEquity,
    closingEquity,
    // Post-TRA-2323 EOD derivation: stockDaily = equity delta − options credit.
    dailyPnl: (closingEquity - openingEquity) - optionsDailyPnl,
    optionsPnl: optionsDailyPnl,
    optionsDailyPnl,
    combinedPnl: closingEquity - openingEquity,
    trades: 0,
  });

  it('the qa3120t0806a book: all-time equals the equity mark AND the window basis', () => {
    const t = new PnlTracker(dir, 25_000);
    // 08-10: +80 option close, credited into equity (TRA-2323).
    t.saveEquity(25_080, 80);
    t.saveSnapshot(optSnap('2020-01-06', 25_000, 25_080, 80));
    // 08-11: +26 option close.
    t.saveEquity(25_106, 106);
    t.saveSnapshot(optSnap('2020-01-07', 25_080, 25_106, 26));

    // openingEquity telescoped to 25,106; no running delta today.
    const stats = t.getCumulativeStats(25_106);
    // Before the fix this read 0 (booked stock 0 + running 0): the book's +106
    // was invisible to all-time while any window covering the rows read 106.
    expect(stats.allTimePnl).toBeCloseTo(106, 6);
    expect(stats.allTimePnl).toBeCloseTo(25_106 - 25_000, 6);
  });

  it("mid-session: today's running option credit is counted once, not twice", () => {
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_080, 80);
    t.saveSnapshot(optSnap('2020-01-06', 25_000, 25_080, 80));
    // Today's +26 close has credited equity but the 21:00 ET row is not booked
    // yet — the QADesigner's exact 08-11 18:0x read.
    const stats = t.getCumulativeStats(25_106);
    // Booked (0 + 80) + running (25,106 − 25,080) = 106. Before the fix: 26.
    expect(stats.allTimePnl).toBeCloseTo(106, 6);
  });

  it('all-time is never smaller than a window it super-sets (the filed defect)', () => {
    const year = new Date().getFullYear();
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_080, 80);
    t.saveSnapshot(optSnap(`${year}-01-02`, 25_000, 25_080, 80));
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const stats = t.getCumulativeStats(25_080);
    if (`${year}-01-02` < today) {
      expect(stats.yearlyPnl).toBeCloseTo(80, 6);
    }
    expect(stats.allTimePnl).toBeGreaterThanOrEqual(stats.yearlyPnl - 1e-6);
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

// TRA-3043 — PUBLISH THE ANCHOR'S PROVENANCE, DO NOT MAKE THE READER INFER IT.
//
// The CTO grades the TRA-2664 forward test by asking one question of each 21:00
// ET row: was this session's `openingEquity` the prior session's recorded close,
// or something the day roll invented? Before this ticket the only way to answer
// was to invert the writer's own formula off three other published fields
// (`openingEquity = closingEquity - stockDaily - optionsCreditedInWindow`) and
// compare the result against the previous row. That is an INFERENCE, and it is
// unavailable wherever an operand is a TRA-2829 null.
//
// The trap these tests exist to stop: a pre-TRA-3039 build CLOBBERS
// `openingEquity` on its day roll while leaving `openingEquityBasis` reading
// `prior-session-close` from the previous session's `saveSnapshot`. If the fixed
// roll had simply left that string in place on its preserve branch, the healthy
// row and the clobbered row would publish the SAME declaration — a field that is
// green by construction in exactly the case it exists to discriminate (the
// TRA-2641 self-confirming trap, third occurrence). So the preserve branch
// stamps `verified-prior-session-close`, a value NO earlier build can write.
describe('TRA-3043 — openingEquityBasis is a POSITIVE marker, not a restated default', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-3043-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  // `advanceDayIfNeeded` stamps `openingDate = todayKey()`, and `saveSnapshot`
  // only attributes provenance to a row it governs (`snapshot.date ===
  // openingDate`). So the row under test must carry the REAL current ET date —
  // the same expression the tracker uses, not a frozen literal.
  const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const PRIOR = '2020-01-06';

  const basisOf = (t: PnlTracker, date: string) =>
    t.getSnapshots().find(s => s.date === date)?.openingEquityBasis;

  it('the preserve branch stamps the marker, and it reaches the row it governed', () => {
    // Session PRIOR closed at 25,073.05 and set the anchor. The next boot into a
    // new ET day is the fixed roll: it finds the anchor already equal to that
    // recorded close and preserves it.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(25_000, 0);
    t1.saveSnapshot(snap(PRIOR, 25_000, 25_073.05));

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBeCloseTo(25_073.05, 6);
    // The 21:00 ET write for the session the roll just opened.
    t2.saveSnapshot(snap(TODAY, 25_073.05, 25_090));

    expect(basisOf(t2, TODAY)).toBe('verified-prior-session-close');
    // And it is DURABLE — the reader pulls this off a file, not off memory.
    expect(basisOf(new PnlTracker(dir, 25_000), TODAY)).toBe('verified-prior-session-close');
  });

  it('CONTROL — a PRE-FIX clobber cannot forge the marker', () => {
    // THE DISCRIMINATOR. This reproduces the on-disk residue a pre-TRA-3039
    // build leaves after it has already rolled into today: `openingDate` is
    // TODAY, `openingEquity` has been overwritten from the stale trade-path
    // cache (25,000 instead of the recorded 25,073.05 close), and the basis
    // string still reads `prior-session-close` because that build never wrote
    // the field at all — the previous session's `saveSnapshot` did.
    //
    // The fixed build boots into this and REPAIRS NOTHING: `advanceDayIfNeeded`
    // is constructor-only and returns immediately once `openingDate === today`.
    // That is the prevent-only property the deploy ruling turns on, and it is
    // asserted here rather than described.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(25_000, 0);
    t1.saveSnapshot(snap(PRIOR, 25_000, 25_073.05));

    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    raw['openingDate'] = TODAY;
    raw['openingEquity'] = 25_000;                     // the clobber
    raw['openingEquityBasis'] = 'prior-session-close'; // the stale, honest-looking string
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');

    const t2 = new PnlTracker(dir, 25_000);
    // Prevent-only: the broken anchor survives the fixed build's boot.
    expect(t2.getOpeningEquity()).toBeCloseTo(25_000, 6);
    t2.saveSnapshot(snap(TODAY, 25_000, 25_090));

    // The row does NOT claim the fixed roll governed it. This is the whole
    // point: absence of the marker is the evidence, and a stale
    // `prior-session-close` must never be read as a pass.
    expect(basisOf(t2, TODAY)).toBe('prior-session-close');
    expect(basisOf(t2, TODAY)).not.toBe('verified-prior-session-close');
  });

  // A book that was RUNNING on a past session and never booked a close for it:
  // equity moved through the trade path, `openingDate` is that past session, and
  // the snapshot ledger has no row to anchor on. `loadState` defaults
  // `openingDate` to TODAY on a fresh directory, which would skip the roll
  // entirely, so the past date is written onto the state file rather than
  // assumed — the same technique the TRA-3039 controls above use.
  const openSessionThatNeverClosed = (equity: number) => {
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(equity, 0);
    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    raw['openingDate'] = '2020-01-05';
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');
    return stateFile;
  };

  it('the lossy roll declares itself on the row', () => {
    // A session that never closed: no snapshot to anchor on, so the roll from
    // `state.equity` (TRA-241) is correct AND lossy, and says so on disk.
    openSessionThatNeverClosed(26_000);

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getOpeningEquity()).toBeCloseTo(26_000, 6);
    t2.saveSnapshot(snap(TODAY, 26_000, 26_100));
    expect(basisOf(t2, TODAY)).toBe('day-roll-state-equity');
  });

  it('a rebase declares itself on the row', () => {
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(PRIOR, 25_000, 25_073.05));
    const t2 = new PnlTracker(dir, 25_000);
    t2.syncOpeningEquity(30_000, 0); // starting-balance edit (TRA-138)
    t2.saveSnapshot(snap(TODAY, 30_000, 30_050));
    expect(basisOf(t2, TODAY)).toBe('rebase');
  });

  it('CONTROL — a BACK-FILL row is left NOT MEASURED, never back-attributed', () => {
    // The current in-memory anchor says nothing about what governed a session
    // three weeks ago. Stamping it onto a back-filled row would fabricate an
    // audit trail, which is worse than having none — so a row whose date is not
    // `openingDate` is left with the field ABSENT.
    openSessionThatNeverClosed(26_000);
    const t2 = new PnlTracker(dir, 25_000);
    expect(basisOf(t2, TODAY)).toBeUndefined();

    // The row the anchor DOES govern is stamped, so the refusal below is a
    // scoped decision and not a blanket failure to write. Asserted FIRST: a
    // past-dated `saveSnapshot` rewinds `openingDate` to its own date (that is
    // how the anchor telescopes), so writing the back-fill row first would leave
    // the live row unstamped for that reason instead of the one under test.
    t2.saveSnapshot(snap(TODAY, 26_000, 26_100));
    expect(basisOf(t2, TODAY)).toBe('day-roll-state-equity');

    t2.saveSnapshot({
      date: '2019-11-04', openingEquity: 24_000, closingEquity: 24_100,
      dailyPnl: 100, optionsPnl: 0, combinedPnl: 100, trades: 0,
    });
    expect(basisOf(t2, '2019-11-04')).toBeUndefined();
  });

  it('CONTROL — a caller that knows a row provenance keeps it', () => {
    // The EOD back-fill writer can legitimately know what anchored a historical
    // row. Its value wins; the stamper does not overwrite it. Set up so the
    // stamper WOULD otherwise have written (`day-roll-state-equity` on a row it
    // governs) — deferring to the caller from a state that had nothing to say
    // would not distinguish precedence from a no-op.
    openSessionThatNeverClosed(26_000);
    const t2 = new PnlTracker(dir, 25_000);
    t2.saveSnapshot({ ...snap(TODAY, 26_000, 26_100), openingEquityBasis: 'backfill-TRA-2827' });
    expect(basisOf(t2, TODAY)).toBe('backfill-TRA-2827');
  });

  it('CONTROL — a pre-TRA-3039 state file stamps nothing at all', () => {
    // Every state file written before TRA-3039 has no basis field. Absent must
    // stay absent: a `?? 'prior-session-close'` default anywhere on this path
    // would manufacture the exact declaration the field exists to withhold.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(26_000, 0);
    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    delete raw['openingEquityBasis'];
    raw['openingDate'] = TODAY;
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');

    const t2 = new PnlTracker(dir, 25_000);
    t2.saveSnapshot(snap(TODAY, 26_000, 26_100));
    expect(basisOf(t2, TODAY)).toBeUndefined();
  });
});

// TRA-3043 — THE ATTESTATION, and the live incident that forced it.
//
// `advanceDayIfNeeded` is constructor-only, so exactly ONE process per ET day
// performs that day's roll. On 2026-08-06 that process was a PRE-fix build:
// `00a8cbb4` (which does not contain 7c373dc) held bqb1 from 03:54:36Z across
// the 04:00Z ET-day boundary, and the fixed build `1773877` only took over at
// 04:33:22Z — by which time `openingDate` was already stamped 2026-08-06 and the
// fixed build's constructor returned without touching, or saying, anything.
//
// A marker meaning "the fixed roll ran" would therefore have been SILENT on the
// exact session it was built to grade, and would have stayed silent for the
// whole class of days where an old build happens to hold the box across
// midnight ET. The marker instead asserts the INVARIANT — `openingEquity`
// equals the newest recorded session's `closingEquity` — which any boot can
// check against durable state regardless of which build rolled the day.
describe('TRA-3043 — a boot that INHERITS an anchor can still vouch for it', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-3043b-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const PRIOR = '2020-01-06';

  // The on-disk residue of an EARLIER process having already rolled into today.
  // `openingEquity` is supplied by the caller so both outcomes of that roll —
  // sound and clobbered — can be set up from the same helper.
  const earlierProcessAlreadyRolled = (openingEquity: number) => {
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(25_000, 0);
    t1.saveSnapshot(snap(PRIOR, 25_000, 25_073.05)); // the recorded close
    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    raw['openingDate'] = TODAY;
    raw['openingEquity'] = openingEquity;
    raw['openingEquityBasis'] = 'prior-session-close'; // what a pre-fix build leaves
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');
  };

  it('a SOUND inherited anchor is attested, and the attestation reaches the row', () => {
    // The 2026-08-06 good case: the pre-fix build rolled, but this book was not
    // one the defect moved, so the anchor still equals the recorded close.
    earlierProcessAlreadyRolled(25_073.05);

    const t = new PnlTracker(dir, 25_000);
    expect(t.getAnchorState().openingEquityBasis).toBe(ANCHOR_BASIS_VERIFIED);
    expect(t.getAnchorState().openingEquity).toBeCloseTo(25_073.05, 6);
    // Readable on the row too, once the 21:00 ET write lands.
    t.saveSnapshot(snap(TODAY, 25_073.05, 25_090));
    expect(t.getSnapshots().find(s => s.date === TODAY)?.openingEquityBasis)
      .toBe(ANCHOR_BASIS_VERIFIED);
  });

  it('CONTROL — a CLOBBERED inherited anchor is NOT attested', () => {
    // The 2026-08-06 bad case, and the one the whole field exists for: the
    // pre-fix roll overwrote the recorded 25,073.05 close with the stale
    // trade-path cache. The invariant fails, so nothing is written and the stale
    // `prior-session-close` stands — which must never be read as a pass.
    earlierProcessAlreadyRolled(25_000);

    const t = new PnlTracker(dir, 25_000);
    expect(t.getAnchorState().openingEquityBasis).toBe('prior-session-close');
    expect(t.getAnchorState().openingEquityBasis).not.toBe(ANCHOR_BASIS_VERIFIED);
    // Prevent-only is unchanged: attesting never REPAIRS. The broken anchor
    // survives, and the row it produces is still wrong — it just says so.
    expect(t.getAnchorState().openingEquity).toBeCloseTo(25_000, 6);
  });

  it('attestation is idempotent — a re-boot rewrites nothing', () => {
    earlierProcessAlreadyRolled(25_073.05);
    const stateFile = join(dir, 'equity-state.json');
    new PnlTracker(dir, 25_000);
    const afterFirst = readFileSync(stateFile, 'utf-8');
    new PnlTracker(dir, 25_000);
    expect(readFileSync(stateFile, 'utf-8')).toBe(afterFirst);
  });

  it('CONTROL — an UNMEASURED close cannot be attested against', () => {
    // TRA-2829: a back-filled row with `closingEquity: null` is not a close the
    // invariant can be checked against. Silence, not a match.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveEquity(25_000, 0);
    t1.saveSnapshot({
      date: PRIOR, openingEquity: null, closingEquity: null,
      dailyPnl: 0, optionsPnl: 0, combinedPnl: 0, trades: 0,
    });
    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    raw['openingDate'] = TODAY;
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');

    const t = new PnlTracker(dir, 25_000);
    expect(t.getAnchorState().openingEquityBasis).not.toBe(ANCHOR_BASIS_VERIFIED);
  });

  it('CONTROL — a close booked FOR the open day is not a PRIOR session', () => {
    // `latest.date < openingDate` is what makes this a statement about a
    // COMPLETED prior session. When `saveSnapshot` has just booked today's close
    // the two are equal, the day has not rolled, and `prior-session-close`
    // already describes the anchor exactly — re-badging it as attested would
    // claim a telescope across a session that has not ended.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(TODAY, 25_000, 25_073.05));
    expect(t1.getAnchorState().openingDate).toBe(TODAY);

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getAnchorState().openingEquityBasis).toBe('prior-session-close');
  });

  it('a REBASE is not attested away', () => {
    // TRA-138. A starting-balance edit deliberately moves the anchor off the
    // prior close, so the invariant fails and `rebase` survives the next boot —
    // the declaration stays the one that is true.
    const t1 = new PnlTracker(dir, 25_000);
    t1.saveSnapshot(snap(PRIOR, 25_000, 25_073.05));
    t1.syncOpeningEquity(30_000, 0);
    const stateFile = join(dir, 'equity-state.json');
    const raw = JSON.parse(readFileSync(stateFile, 'utf-8')) as Record<string, unknown>;
    raw['openingDate'] = TODAY;
    writeFileSync(stateFile, JSON.stringify(raw), 'utf-8');

    const t2 = new PnlTracker(dir, 25_000);
    expect(t2.getAnchorState().openingEquityBasis).toBe('rebase');
  });

  it('getAnchorState reports an absent basis as null, never an empty string', () => {
    const t = new PnlTracker(dir, 25_000);
    expect(t.getAnchorState().openingEquityBasis).toBeNull();
    expect(t.getAnchorState().openingDate).toBe(TODAY);
  });
});

// TRA-3421 — THE ROLLING WINDOWS WERE BLIND TO THE CURRENT ET DAY.
//
// `weeklyPnl`/`monthlyPnl`/`yearlyPnl` summed `snapshots.filter(date < today)`,
// so today contributed NOTHING to a window that plainly contains it — neither
// the booked row (excluded by the strict `<` from the 21:00 ET close until the
// next day roll) nor, before that, the un-booked running delta.
//
// Live repro, bqb1 `4780dc9edc43` pid 73, 2026-08-12 (a Wednesday): book
// `qa581t0811a`, whose entire realized history is one EQUITY close (NBIS,
// +$13.12, 16:41:36Z that day), served `dailyPnl 13.12` / `allTimePnl 13.12`
// against `weekly = monthly = yearly = 0`. A weekly strictly below the daily it
// super-sets is a one-read impossibility under every boundary convention.
//
// The hypothesis on the ticket — "the windows count OPTION P&L and miss EQUITY
// P&L" — is FALSIFIED by these tests: the reducer sums `dailyPnl +
// optionsDailyPnl` and cannot tell the asset classes apart. The control book
// `qa3120t0806a` populated its windows only because its rows are dated 08-10 /
// 08-11, i.e. PAST. The discriminator is the row's DATE, not what it traded.
describe('TRA-3421 — the rolling windows include the current ET day', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-3421-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  const ET_TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

  /** A day row in the post-TRA-2323 EOD shape: stock leg = equity delta − options credit. */
  const dayRow = (
    date: string, openingEquity: number, closingEquity: number, optionsDailyPnl: number,
  ): DailySnapshot => ({
    date,
    openingEquity,
    closingEquity,
    dailyPnl: (closingEquity - openingEquity) - optionsDailyPnl,
    optionsPnl: optionsDailyPnl,
    optionsDailyPnl,
    combinedPnl: closingEquity - openingEquity,
    trades: 1,
  });

  it("the qa581t0811a shape: today's BOOKED equity row is in every window, not 0", () => {
    // The exact filed book: one equity close, +13.125, on the current ET day,
    // already booked by the 21:00 ET report — which is the state bqb1 served at
    // 02:5xZ, `dailyPnl` reset to 0 while `allTimePnl` still read 13.12.
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_013.125, 0);
    t.saveSnapshot(dayRow(ET_TODAY, 25_000, 25_013.125, 0));

    const stats = t.getCumulativeStats(25_013.125);
    // Before the fix all three read exactly 0 — the filed impossibility.
    expect(stats.weeklyPnl).toBeCloseTo(13.125, 6);
    expect(stats.monthlyPnl).toBeCloseTo(13.125, 6);
    expect(stats.yearlyPnl).toBeCloseTo(13.125, 6);
    expect(stats.allTimePnl).toBeCloseTo(13.125, 6);
  });

  it('mid-session, before the row is booked: the running delta is in every window', () => {
    // The 20:2xZ read the QADesigner filed from: the close has credited equity
    // but no snapshot exists yet, so the ONLY carrier of today's P&L is
    // `currentEquity − openingEquity`, which the old `sum` never consulted.
    const t = new PnlTracker(dir, 25_000);
    const stats = t.getCumulativeStats(25_013.125);
    expect(stats.weeklyPnl).toBeCloseTo(13.125, 6);
    expect(stats.monthlyPnl).toBeCloseTo(13.125, 6);
    expect(stats.yearlyPnl).toBeCloseTo(13.125, 6);
  });

  it('weekly is never below the daily P&L it contains (the filed invariant)', () => {
    const t = new PnlTracker(dir, 25_000);
    const dailyPnl = 13.125;
    const stats = t.getCumulativeStats(25_000 + dailyPnl);
    expect(stats.weeklyPnl).toBeGreaterThanOrEqual(dailyPnl - 1e-9);
    expect(stats.monthlyPnl).toBeGreaterThanOrEqual(stats.weeklyPnl - 1e-9);
    expect(stats.yearlyPnl).toBeGreaterThanOrEqual(stats.monthlyPnl - 1e-9);
    expect(stats.allTimePnl).toBeGreaterThanOrEqual(stats.yearlyPnl - 1e-9);
  });

  it('books the same-day row ONCE — booking it does not double it against the running delta', () => {
    // The property that makes "booked rows in the window + todayRunning" safe:
    // `saveSnapshot` rebases `openingEquity` to the row's own close, so the
    // running delta collapses to 0 exactly when the row starts counting.
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_013.125, 0);
    const before = t.getCumulativeStats(25_013.125).weeklyPnl;
    t.saveSnapshot(dayRow(ET_TODAY, 25_000, 25_013.125, 0));
    const after = t.getCumulativeStats(25_013.125).weeklyPnl;
    expect(before).toBeCloseTo(13.125, 6);
    expect(after).toBeCloseTo(13.125, 6); // not 26.25
  });

  it('an OPTIONS-only same-day book is treated identically (kills the equity-vs-options hypothesis)', () => {
    // Same book, same day, same magnitude — the P&L now arrives entirely through
    // `optionsDailyPnl`. If the windows discriminated by asset class as filed,
    // this case and the equity case above could not agree. They do.
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_013.125, 13.125);
    t.saveSnapshot(dayRow(ET_TODAY, 25_000, 25_013.125, 13.125));
    const stats = t.getCumulativeStats(25_013.125);
    expect(stats.weeklyPnl).toBeCloseTo(13.125, 6);
    expect(stats.yearlyPnl).toBeCloseTo(13.125, 6);
  });

  it('all-time minus yearly is EXACTLY the booked rows before Jan 1 (the windows telescope)', () => {
    // The structural property, not just the instance: every window now shares
    // all-time's basis, so their difference is a pure set difference of booked
    // rows. That is what rules out the whole "a window exceeds the window
    // containing it" class that TRA-3239 and this ticket are both instances of.
    const year = Number(ET_TODAY.slice(0, 4));
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_040, 0);
    t.saveSnapshot(dayRow(`${year - 1}-11-04`, 25_000, 25_040, 15));   // last year: +40
    t.saveEquity(25_090, 0);
    t.saveSnapshot(dayRow(`${year}-01-02`, 25_040, 25_090, 10));       // this year, past: +50
    t.saveEquity(25_103.125, 0);
    t.saveSnapshot(dayRow(ET_TODAY, 25_090, 25_103.125, 0));           // today: +13.125

    const stats = t.getCumulativeStats(25_103.125);
    expect(stats.yearlyPnl).toBeCloseTo(63.125, 6);
    expect(stats.allTimePnl).toBeCloseTo(103.125, 6);
    expect(stats.allTimePnl - stats.yearlyPnl).toBeCloseTo(40, 6);
  });

});

// TRA-3421 (secondary) — THE WINDOW BOUNDARIES WERE CUT FROM THE PROCESS CLOCK.
//
// `startOfWeek` took `new Date().getDay()` and `getCumulativeStats` took
// `getFullYear()/getMonth()` — all three read the PROCESS timezone — then
// compared the result against snapshot `date` keys, which are ET calendar dates.
// bqb1 runs UTC, and from 00:00Z to 04:00Z the UTC date is already TOMORROW in
// ET terms, so every boundary landed a day late.
//
// THIS BLOCK MUST PIN THE CLOCK AND THE ZONE. Run under an ET-local process on a
// Wednesday, the buggy and the fixed code return the SAME answer — the first
// draft of this test passed against the unfixed source, which makes it evidence
// of nothing. The condition being detected has to be inside the test.
describe('TRA-3421 (secondary) — window boundaries come from the ET date, not the host clock', () => {
  let dir: string;
  let priorTz: string | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-3421tz-'));
    priorTz = process.env.TZ;
    process.env.TZ = 'UTC';                 // bqb1's zone; Node re-reads this per Date
    vi.useFakeTimers();
    // 02:00Z on Thursday 2026-08-13 === 22:00 ET on WEDNESDAY 2026-08-12.
    vi.setSystemTime(new Date('2026-08-13T02:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    if (priorTz === undefined) delete process.env.TZ; else process.env.TZ = priorTz;
    rmSync(dir, { recursive: true, force: true });
  });

  const plainRow = (date: string, openingEquity: number, closingEquity: number): DailySnapshot => ({
    date,
    openingEquity,
    closingEquity,
    dailyPnl: closingEquity - openingEquity,
    optionsPnl: 0,
    optionsDailyPnl: 0,
    combinedPnl: closingEquity - openingEquity,
    trades: 1,
  });

  it("the week starts Monday 08-10, not the Sunday the host clock's day-of-week produced", () => {
    // Old code: `getDay()` under UTC saw THURSDAY 08-13, subtracted 3, formatted
    // 08-10T02:00Z in ET → "2026-08-09", a SUNDAY. So a Sunday row counted as
    // "this week". No stock row lands on a Sunday — but `CryptoEngine` feeds
    // this same tracker a 7-day tape.
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_500, 0);
    t.saveSnapshot(plainRow('2026-08-09', 25_000, 25_500));   // +500, Sunday
    const stats = t.getCumulativeStats(25_500);
    expect(stats.weeklyPnl).toBeCloseTo(0, 6);       // pre-fix: 500
    expect(stats.allTimePnl).toBeCloseTo(500, 6);    // still real money, just last week
  });

  it('a Monday 08-10 row IS inside the week (the boundary is not merely pushed out)', () => {
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_500, 0);
    t.saveSnapshot(plainRow('2026-08-10', 25_000, 25_500));
    expect(t.getCumulativeStats(25_500).weeklyPnl).toBeCloseTo(500, 6);
  });

  it('the month boundary does not skip into next month at 02:00Z on the 1st', () => {
    // 2026-09-01T02:00Z is still 2026-08-31 in ET. The old code cut monthStart at
    // "2026-09-01" — strictly AFTER today — and the monthly window silently
    // dropped the whole of August plus the live session.
    vi.setSystemTime(new Date('2026-09-01T02:00:00.000Z'));
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_500, 0);
    t.saveSnapshot(plainRow('2026-08-20', 25_000, 25_500));
    const stats = t.getCumulativeStats(25_500);
    expect(stats.monthlyPnl).toBeCloseTo(500, 6);    // pre-fix: 0
    expect(stats.yearlyPnl).toBeCloseTo(500, 6);
  });

  it('the year boundary does not skip into next year at 02:00Z on Dec 31', () => {
    // 2027-01-01T02:00Z is still 2026-12-31 in ET; the old yearStart read
    // "2027-01-01" and blanked the yearly window for those four hours.
    vi.setSystemTime(new Date('2027-01-01T02:00:00.000Z'));
    const t = new PnlTracker(dir, 25_000);
    t.saveEquity(25_500, 0);
    t.saveSnapshot(plainRow('2026-06-15', 25_000, 25_500));
    expect(t.getCumulativeStats(25_500).yearlyPnl).toBeCloseTo(500, 6);  // pre-fix: 0
  });
});

// TRA-4003 — THE SECOND ROLL ACROSS A WEEKEND CLOBBERED THE ANCHOR TRA-3039
// HAD JUST PRESERVED.
//
// `anchorIsPriorSessionClose()` tested `latest.date === openingDate`, and the
// preserve branch stamps `openingDate = today`. On a weekday the day rolled
// into closes and `saveSnapshot` re-establishes the pair; on a weekend nothing
// closes, so after a Saturday boot the pair reads (Fri, Sat), the next boot —
// Sunday or Monday — fails the equality and takes the `state.equity` roll.
//
// Live bqb1, session 2026-08-24, deploys Sat 08-22 / Sun 08-23T20:45Z / Mon
// 08-24T20:12Z+20:43Z: 41 of 64 demo books wrote an 08-24 row with basis
// `day-roll-state-equity` and `openingEquity !== closingEquity(08-21)` (0 of 64
// on every weekday session 08-18 → 08-25). Six of them had `state.equity` last
// written by the trade path BEFORE Friday's option credit landed, so the stale
// anchor was short by exactly `optionsDaily(08-21)` and the row reproduced the
// TRA-2630 Defect B signature — `stockDaily(t) === optionsDaily(t-1)` — with an
// intact credit counter. `qa_tra2251_7b0483ee` below is that book, to the cent.
describe('TRA-4003 — the anchor survives a weekend with more than one boot', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'pnl-tracker-4003-'));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    rmSync(dir, { recursive: true, force: true });
  });

  // NYSE calendar the way `scheduler.isMarketDayIso` expresses it: weekends
  // plus the one holiday these cases need. Kept local so the test names its
  // own sessions instead of depending on the production holiday table.
  const HOLIDAYS = new Set(['2026-09-07']); // Labor Day
  const isMarketDay = (iso: string): boolean => {
    if (HOLIDAYS.has(iso)) return false;
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y as number, (m as number) - 1, d as number)).getUTCDay();
    return dow !== 0 && dow !== 6;
  };
  // 15:00Z = 11:00 ET on every date used here, safely inside the ET day.
  const bootOn = (iso: string): void => {
    vi.setSystemTime(new Date(iso + 'T15:00:00.000Z'));
  };
  const nextStockDaily = (t: PnlTracker, equity: number, creditWindow: number): number =>
    Math.round(((equity - t.getOpeningEquity()) - creditWindow) * 100) / 100;

  // qa_tra2251_7b0483ee, live figures. 08-21: stock +23.49, option credit +54.
  const CLOSE_0820 = 25_198.83;
  const CLOSE_0821 = 25_276.32;
  const TRADE_PATH_CACHE = 25_222.32; // = CLOSE_0820 + 23.49: last `saveEquity`, pre-credit
  const CREDIT_0821 = 54;

  const closeFriday = (): void => {
    bootOn('2026-08-21');
    const t = new PnlTracker(dir, 25_000, { isMarketDay });
    t.saveEquity(TRADE_PATH_CACHE, 0);
    t.saveSnapshot(snap('2026-08-21', CLOSE_0820, CLOSE_0821));
    expect(t.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
  };

  it('qa_tra2251_7b0483ee — Sat, Sun and Mon boots all keep the Friday close', () => {
    closeFriday();

    bootOn('2026-08-22'); // Saturday — the one roll the old rule survived
    const sat = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(sat.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
    expect(sat.getAnchorState().openingEquityBasis).toBe(ANCHOR_BASIS_VERIFIED);

    bootOn('2026-08-23'); // Sunday — pre-fix: `latest.date (Fri) !== openingDate (Sat)` → lossy
    const sun = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(sun.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
    expect(sun.getOpeningEquity()).not.toBeCloseTo(TRADE_PATH_CACHE, 3);
    expect(sun.getAnchorState().openingEquityBasis).toBe(ANCHOR_BASIS_VERIFIED);

    bootOn('2026-08-24'); // Monday — the process that wrote the 08-24 row
    const mon = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(mon.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
    expect(mon.getAnchorState().openingEquityBasis).toBe(ANCHOR_BASIS_VERIFIED);
    // An idle Monday books nothing. Live, pre-fix, this row read stockDaily
    // 54.00 === optionsDaily(08-21) — the Defect B triple, from the anchor.
    expect(nextStockDaily(mon, CLOSE_0821, 0)).toBeCloseTo(0, 6);
    expect(nextStockDaily(mon, CLOSE_0821, 0)).not.toBeCloseTo(CREDIT_0821, 3);
  });

  it('a Saturday boot followed directly by the Monday boot keeps the close too', () => {
    // One weekend boot is enough to arm the old defect: (Fri, Sat) then Monday.
    closeFriday();
    bootOn('2026-08-22');
    new PnlTracker(dir, 25_000, { isMarketDay });
    bootOn('2026-08-24');
    const mon = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(mon.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
    expect(mon.getAnchorState().openingEquityBasis).toBe(ANCHOR_BASIS_VERIFIED);
  });

  it('a weekend plus a Monday holiday (Labor Day) is still one non-session span', () => {
    bootOn('2026-09-04');
    const fri = new PnlTracker(dir, 25_000, { isMarketDay });
    fri.saveEquity(TRADE_PATH_CACHE, 0);
    fri.saveSnapshot(snap('2026-09-04', CLOSE_0820, CLOSE_0821));
    for (const day of ['2026-09-05', '2026-09-06', '2026-09-07', '2026-09-08']) {
      bootOn(day);
      const t = new PnlTracker(dir, 25_000, { isMarketDay });
      expect(t.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
      expect(t.getAnchorState().openingEquityBasis).toBe(ANCHOR_BASIS_VERIFIED);
    }
  });

  // ── Controls: the branches that must KEEP rolling ────────────────────────

  it('CONTROL — a SESSION that never closed still rolls from state.equity (TRA-3039)', () => {
    // Fri close, Monday boot (preserved), no Monday 21:00 ET row, Tuesday boot.
    // Monday is a session with no close: the span test finds it and the lossy
    // roll TRA-3039 kept for exactly this case still runs.
    closeFriday();
    bootOn('2026-08-24');
    const mon = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(mon.getOpeningEquity()).toBeCloseTo(CLOSE_0821, 6);
    mon.saveEquity(26_000, 0); // Monday traded; nothing archived it

    bootOn('2026-08-25');
    const tue = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(tue.getOpeningEquity()).toBeCloseTo(26_000, 6);
    expect(tue.getAnchorState().openingEquityBasis).toBe('day-roll-state-equity');
  });

  it('CONTROL — a rebase across the weekend still re-anchors (TRA-138)', () => {
    closeFriday();
    bootOn('2026-08-22');
    const sat = new PnlTracker(dir, 25_000, { isMarketDay });
    sat.saveEquity(50_000, 0);
    sat.syncOpeningEquity(50_000, 0);
    bootOn('2026-08-24');
    const mon = new PnlTracker(dir, 25_000, { isMarketDay });
    expect(mon.getOpeningEquity()).toBeCloseTo(50_000, 6);
    expect(nextStockDaily(mon, 50_000, 0)).toBeCloseTo(0, 6);
  });

  it('CONTROL — without a calendar the strict equality is unchanged (the pre-fix branch)', () => {
    // A caller that cannot name the sessions (the crypto tracker) gets the old
    // rule byte-for-byte: the Sunday boot rolls from `state.equity`. This pins
    // the injection as the thing that changes behaviour, and reproduces the
    // live 08-24 row as the negative control.
    bootOn('2026-08-21');
    const fri = new PnlTracker(dir, 25_000);
    fri.saveEquity(TRADE_PATH_CACHE, 0);
    fri.saveSnapshot(snap('2026-08-21', CLOSE_0820, CLOSE_0821));
    bootOn('2026-08-22');
    new PnlTracker(dir, 25_000);
    bootOn('2026-08-23');
    const sun = new PnlTracker(dir, 25_000);
    expect(sun.getOpeningEquity()).toBeCloseTo(TRADE_PATH_CACHE, 6);
    expect(sun.getAnchorState().openingEquityBasis).toBe('day-roll-state-equity');
    expect(nextStockDaily(sun, CLOSE_0821, 0)).toBeCloseTo(CREDIT_0821, 6); // the live row
  });

  it('CONTROL — a span longer than the walk bound is not vouched for', () => {
    // Twelve non-session days cannot occur on the NYSE calendar; a state that
    // claims one is malformed and must fall to the lossy branch, not be trusted.
    // The span is measured to TODAY, not to `openingDate` (still 08-22 here
    // from the Saturday roll) — measuring to `openingDate` would have vouched
    // for this anchor on the strength of a single Saturday.
    const everyDayClosed = (): boolean => false;
    bootOn('2026-08-21');
    const t1 = new PnlTracker(dir, 25_000, { isMarketDay: everyDayClosed });
    t1.saveEquity(TRADE_PATH_CACHE, 0);
    t1.saveSnapshot(snap('2026-08-21', CLOSE_0820, CLOSE_0821));
    bootOn('2026-08-22');
    new PnlTracker(dir, 25_000, { isMarketDay: everyDayClosed });
    bootOn('2026-09-03'); // 13 days after the close
    const t2 = new PnlTracker(dir, 25_000, { isMarketDay: everyDayClosed });
    expect(t2.getAnchorState().openingEquityBasis).toBe('day-roll-state-equity');
    expect(t2.getOpeningEquity()).toBeCloseTo(TRADE_PATH_CACHE, 6);
  });
});
