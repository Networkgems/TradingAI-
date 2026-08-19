import { describe, it, expect } from 'vitest';
import type { DailySnapshot } from './pnl-tracker.js';
import type { EodTailCalendar } from './pnl-reconciliation.js';
import { reconcilePnl, PNL_RECONCILIATION_CAVEATS } from './pnl-reconciliation.js';
import {
  summarizeNonSessionLedgerRows,
  NON_SESSION_LEDGER_ROW_CAVEAT,
} from './eod-nonsession-row.js';

/**
 * TRA-3849 — the non-session ledger row axis.
 *
 * The finding, off the complete `days[]` census on live `b70404f`: 83 rows over
 * 918 sit on dates that were never NYSE sessions, across 63 books and 11 date
 * keys, 82 of them Sundays. No detector anywhere named them — every EOD presence
 * axis grades a SESSION for a missing row, which is the opposite direction, so a
 * phantom date key entered `days[]` unchallenged and was then treated as an
 * ordinary row by everything downstream.
 *
 * ── THE PAIRED ARMS ─────────────────────────────────────────────────────────
 * A detector that flags everything is not a detector, and this repo has shipped
 * two flags that were true in the passing state (TRA-2301, TRA-2642). So each
 * positive arm below is paired with a negative on the SAME payload:
 *
 *   ARM A  a Sunday row IS flagged
 *   ARM B  the Monday row in the same series is NOT flagged
 *
 * ── THE NEGATIVE CONTROL ────────────────────────────────────────────────────
 * The detector's whole verdict rests on ONE input — the calendar. So the
 * control is not a mutation of the data, it is a mutation of the calendar: feed
 * it the exact TRA-3267 defect (a calendar that answers `true` for Sunday,
 * i.e. a gate reading a host-local weekday) and the 83 go to 0 with no row
 * changing. That is what makes the calendar-provenance control in
 * `scripts/check-nonsession-rows.mjs` load-bearing rather than ceremonial: a
 * stale holiday table pushes this count DOWN, silently, and a count that can be
 * pushed down by anything other than a ruled retraction is not a tripwire.
 */

const NYSE_2026_08: EodTailCalendar = {
  lastSettledSession: '2026-08-14',
  // The real weekday rule, evaluated on the DATE STRING rather than on a `Date`
  // in the host zone — which is precisely the bug that minted the population.
  isMarketDay: (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return dow !== 0 && dow !== 6;
  },
};

/** The TRA-3267 defect, reproduced exactly: Sunday reads as a session. */
const HOST_LOCAL_WEEKDAY_CALENDAR: EodTailCalendar = {
  lastSettledSession: '2026-08-14',
  isMarketDay: (iso: string) => {
    const [y, m, d] = iso.split('-').map(Number);
    const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
    return dow !== 6; // Sunday slips through — "Monday for Sunday evening"
  },
};

function snap(date: string, over: Partial<DailySnapshot> = {}): DailySnapshot {
  return {
    date,
    openingEquity: 1000,
    closingEquity: 1000,
    dailyPnl: 0,
    optionsPnl: 0,
    combinedPnl: 0,
    ...over,
  } as DailySnapshot;
}

/** The live 2026-08-09 shape: a Sunday row carrying an `eodCombined` figure. */
const LIVE_SHAPED_SERIES = [
  snap('2026-08-06'),
  snap('2026-08-07'),
  snap('2026-08-09'), // Sunday — the 63-book sweep
  snap('2026-08-10'),
];

describe('TRA-3849 — per-row calendar axis on reconcilePnl', () => {
  it('ARM A: flags a row whose date was never a session; ARM B: leaves the real sessions alone', () => {
    const r = reconcilePnl(
      LIVE_SHAPED_SERIES,
      new Map([['2026-08-09', -63.54]]),
      null,
      null,
      null,
      null,
      NYSE_2026_08,
    );

    const byDate = new Map(r.days.map(d => [d.date, d]));
    // ARM A — the Sunday.
    expect(byDate.get('2026-08-09')!.nonSessionRow).toBe(true);
    // ARM B — every real session in the SAME payload. Asserted on all three,
    // not just one: a detector that flags 3 of 4 rows and a detector that flags
    // the right 1 of 4 are indistinguishable from a single positive assertion.
    expect(byDate.get('2026-08-06')!.nonSessionRow).toBe(false);
    expect(byDate.get('2026-08-07')!.nonSessionRow).toBe(false);
    expect(byDate.get('2026-08-10')!.nonSessionRow).toBe(false);

    expect(r.nonSessionRowDates).toEqual(['2026-08-09']);
    // The denominator travels with the finding — 1 of 4, not a bare 1.
    expect(r.nonSessionRowGradeableCount).toBe(4);
    expect(r.nonSessionRowsOk).toBe(false);
  });

  it('NEGATIVE CONTROL: the same rows read CLEAN under the TRA-3267 host-local calendar', () => {
    const r = reconcilePnl(
      LIVE_SHAPED_SERIES,
      new Map([['2026-08-09', -63.54]]),
      null,
      null,
      null,
      null,
      HOST_LOCAL_WEEKDAY_CALENDAR,
    );

    // Not one byte of the ledger changed. The detector went green because its
    // ONE input was wrong — which is the failure mode the census script's
    // src-vs-dist calendar control exists to catch, and the reason a SHRINKING
    // count is never read as a repair.
    expect(r.nonSessionRowDates).toEqual([]);
    expect(r.nonSessionRowsOk).toBe(true);
    // …and it is still a MEASUREMENT, not a not-measured. Same denominator.
    expect(r.nonSessionRowGradeableCount).toBe(4);
  });

  it('NOT MEASURED without a calendar — `null`, never a green', () => {
    const r = reconcilePnl(LIVE_SHAPED_SERIES, new Map());
    expect(r.nonSessionRowsOk).toBeNull();
    expect(r.nonSessionRowGradeableCount).toBe(0);
    expect(r.nonSessionRowDates).toEqual([]);
    for (const d of r.days) {
      expect(d.nonSessionRow).toBeNull();
      expect(d.nonSessionRowMoneyBearing).toBeNull();
    }
  });

  it('splits money-bearing from inert, on the tolerance the rest of the file uses', () => {
    const r = reconcilePnl(
      [
        snap('2026-08-09'), // inert Sunday: no report cell, both legs flat
        snap('2026-08-16', { dailyPnl: 0.004 }), // Sunday, sub-tolerance → inert
        snap('2026-08-02', { optionsPnl: 12.5, optionsDailyPnl: 12.5 }), // Sunday, options leg
      ],
      new Map([['2026-08-09', 0]]),
      null,
      null,
      null,
      null,
      NYSE_2026_08,
    );
    expect(r.nonSessionRowDates).toEqual(['2026-08-02', '2026-08-09', '2026-08-16']);
    // Only the one carrying real money. A 0.004 row is not a money-bearing row,
    // and an `eodCombined: 0` cell is a banked ZERO, not a banked figure.
    expect(r.nonSessionRowMoneyBearingDates).toEqual(['2026-08-02']);
  });

  it('is NOT baseline-gated — a pre-baseline phantom still counts', () => {
    // 9 of the 11 live date keys are May/June, i.e. before most books' baseline.
    // Gating this axis the way `drift` is gated would drop most of the
    // population and then publish the remainder as the total.
    const r = reconcilePnl(
      [snap('2026-05-03'), snap('2026-08-06'), snap('2026-08-09')],
      new Map(),
      '2026-08-01', // baselineDate
      null,
      null,
      null,
      NYSE_2026_08,
    );
    expect(r.belowBaselineCount).toBeGreaterThan(0);
    expect(r.nonSessionRowDates).toEqual(['2026-05-03', '2026-08-09']);
    expect(r.nonSessionRowGradeableCount).toBe(3);
  });

  it('publishes the caveat, so a red cannot be read as an outage to clear', () => {
    expect(PNL_RECONCILIATION_CAVEATS).toContain(NON_SESSION_LEDGER_ROW_CAVEAT);
    expect(NON_SESSION_LEDGER_ROW_CAVEAT).toContain('EXPECTED STEADY STATE');
    expect(NON_SESSION_LEDGER_ROW_CAVEAT).toContain('83');
  });
});

describe('TRA-3849 — the fleet fold', () => {
  const book = (
    username: string,
    mode: string,
    dates: string[],
    money: string[] = [],
    graded = 20,
  ) => ({
    username,
    mode,
    nonSessionRowDates: dates,
    nonSessionRowMoneyBearingDates: money,
    nonSessionRowGradeableCount: graded,
  });

  it('names the population by book AND by date, with both denominators', () => {
    const s = summarizeNonSessionLedgerRows([
      book('admin', 'live', ['2026-05-03', '2026-08-09'], ['2026-08-09']),
      book('v0nni', 'sandbox', ['2026-08-09']),
      book('clean', 'demo', [], [], 14),
    ]);

    expect(s.nonSessionLedgerRowCount).toBe(3);
    expect(s.nonSessionLedgerBookCount).toBe(2);
    expect(s.nonSessionLedgerMoneyBearingRowCount).toBe(1);
    expect(s.nonSessionLedgerDateKeys).toEqual(['2026-05-03', '2026-08-09']);
    // The denominators. A `3` with no `54` beside it is not a finding.
    expect(s.nonSessionRowGradedBookCount).toBe(3);
    expect(s.nonSessionRowGradedRowCount).toBe(54);
    expect(s.nonSessionLedgerRowsOk).toBe(false);

    // The by-date fold is what makes an attribution legible: a date carrying
    // many books in one pass is a sweep, a date carrying one is a per-caller
    // write. That distinction is the whole of TRA-3849's attribution section.
    const aug09 = s.nonSessionLedgerByDate.find(d => d.date === '2026-08-09')!;
    expect(aug09.bookCount).toBe(2);
    expect(aug09.moneyBearingBookCount).toBe(1);
    expect(aug09.modes).toEqual(['live', 'sandbox']);
  });

  it('does not collapse two modes of the same username into one book', () => {
    // `engines[]` carries one row per (username, mode). Keying the by-date fold
    // on the username alone would have undercounted the 2026-08-09 sweep.
    const s = summarizeNonSessionLedgerRows([
      book('admin', 'live', ['2026-08-09']),
      book('admin', 'demo', ['2026-08-09']),
    ]);
    expect(s.nonSessionLedgerRowCount).toBe(2);
    expect(s.nonSessionLedgerByDate[0]!.bookCount).toBe(2);
  });

  it('folds to NOT MEASURED, never green, when nothing was graded', () => {
    const s = summarizeNonSessionLedgerRows([book('admin', 'live', [], [], 0)]);
    expect(s.nonSessionLedgerRowsOk).toBeNull();
    expect(s.nonSessionRowGradedBookCount).toBe(0);
    expect(s.nonSessionRowGradedRowCount).toBe(0);
  });

  it('an EMPTY fleet is NOT MEASURED — the every-on-the-empty-set trap', () => {
    const s = summarizeNonSessionLedgerRows([]);
    expect(s.nonSessionLedgerRowsOk).toBeNull();
    expect(s.nonSessionLedgerRowCount).toBe(0);
  });

  it('a genuinely clean graded fleet CAN reach green — the axis has a passing state', () => {
    const s = summarizeNonSessionLedgerRows([book('admin', 'live', [], [], 20)]);
    expect(s.nonSessionLedgerRowsOk).toBe(true);
    expect(s.nonSessionRowGradedRowCount).toBe(20);
  });
});
