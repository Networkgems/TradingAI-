// TRA-2864 — THE COMPOSITE GRADE.
//
// TRA-2864 was fixed by four commits across three follow-up issues, and each one
// shipped with its own test file against its own fixture:
//
//   bad63c4 / 697b6eb  TRA-2864  the shared FIFO matcher + the 45-day window
//   94618a8            TRA-2874  write window 1 -> 24 months back
//   94618a8            TRA-2875  cash-flow summed over the anchor SPAN
//   2aeb0a3            TRA-2876  equity realized reaches the cell, split-guarded
//
// Every one of those suites is green, and NONE of them grades the composite: the
// numbers a user actually reads come out of `realizedPnlByCloseDate` scoped by
// the corporate-action feed, bounded by `liveBackfillWriteWindow`, and then
// filtered by the write-decision in `backfillLiveRealizedCalendar`. Four fixes
// that each pass alone can still disagree at the seams — the ORIGINAL defect on
// this issue was exactly that (two implementations of one FIFO rule, each with
// passing tests, disagreeing by $746.75 on the real tape).
//
// So this file grades the whole path, once, against the broker's own arithmetic:
// Tradier's `gainloss.csv` for the account (options-only, 19 closed lots) and its
// all-instrument equivalents for the three days where equity moves the cell.
//
// The fixture is the board's verbatim LIVE PRODUCTION export. Do not replace
// these expectations with our own output.

import { describe, expect, it } from 'vitest';
import {
  equitySymbolsInvalidatedByCorporateActions,
  liveBackfillWriteWindow,
  realizedPnlByCloseDate,
} from './tradier-reconcile.js';
import {
  LIVE_TRADIER_TAPE,
  TRADIER_GAINLOSS_BY_CLOSE_DATE,
} from './tra2864-live-tradier-tape.fixture.js';

/**
 * The reverse split that is actually on this account's corporate-action feed
 * (2026-06-15, TDIC, −7 shares, booked as an `adjustment` carrying no cash). It
 * is the reason equity cannot simply be switched on: a share count that moves
 * with no trade row is invisible to a lot book built from fills.
 */
const LIVE_CORPORATE_ACTIONS = [
  { date: '2026-06-15', type: 'adjustment', description: 'REVERSE SPLIT - TDIC', quantity: -7 },
];

/**
 * Tradier gain/loss including the STOCK legs, for the three days where equity is
 * not zero. `TRADIER_GAINLOSS_BY_CLOSE_DATE` is the options-only report; these
 * are the same source with the equity rows kept, which is what the calendar cell
 * has claimed to be since TRA-2876.
 */
const TRADIER_ALL_INSTRUMENT_BY_CLOSE_DATE: Record<string, number> = {
  '2026-06-08': -0.3, // options 0.00 + RDW −0.16 + LASE −0.14 — no option close at all this day
  '2026-06-09': 1.48, // options +11.85 + equity cluster −10.37
  '2026-06-16': -162.35, // options −163.15 + MIR +0.80
};

/** The day the calendar is graded as-of. Fixed so the window assertions are stable. */
const AS_OF = '2026-08-06';

/** Shipped values of the two window constants (index.ts). */
const MONTHS_BACK = 24;
const FETCH_LOOKBACK_DAYS = 45;

function gradeTape() {
  const scope = equitySymbolsInvalidatedByCorporateActions(
    LIVE_CORPORATE_ACTIONS,
    LIVE_TRADIER_TAPE,
  );
  return {
    scope,
    ...realizedPnlByCloseDate(LIVE_TRADIER_TAPE, {
      includeEquity: !scope.withholdAllEquity,
      excludeSymbols: scope.excludeSymbols,
    }),
  };
}

describe('TRA-2864 composite — the four fixes agree on the real tape', () => {
  it('reproduces every broker-truth OPTIONS day to the cent', () => {
    const { optionsRealizedByDate } = gradeTape();
    // Non-vacuity first: an empty map matched every one of these days as "0 vs 0"
    // before the matcher fix, which is how the original bug passed its own tests.
    expect(optionsRealizedByDate.size).toBeGreaterThan(0);
    for (const [date, truth] of Object.entries(TRADIER_GAINLOSS_BY_CLOSE_DATE)) {
      expect(optionsRealizedByDate.get(date), `options ${date}`).toBeCloseTo(truth, 2);
    }
  });

  it('reproduces every broker-truth ALL-INSTRUMENT day to the cent', () => {
    const { realizedByDate } = gradeTape();
    expect(realizedByDate.size).toBeGreaterThan(0);
    for (const [date, truth] of Object.entries(TRADIER_ALL_INSTRUMENT_BY_CLOSE_DATE)) {
      expect(realizedByDate.get(date), `all-instrument ${date}`).toBeCloseTo(truth, 2);
    }
  });

  it('keeps the two tiles additive — options + stocks is the rendered total', () => {
    // `combinedPnl` (the number the calendar grid prints) is written as
    // options + equity, while the detail view renders the two separately. If the
    // slices stop summing to the total, the cell and its own breakdown disagree.
    const { realizedByDate, optionsRealizedByDate, equityRealizedByDate } = gradeTape();
    expect(realizedByDate.size).toBeGreaterThan(0);
    for (const [date, total] of realizedByDate) {
      const options = optionsRealizedByDate.get(date) ?? 0;
      const equity = equityRealizedByDate.get(date) ?? 0;
      expect(options + equity, `slices sum on ${date}`).toBeCloseTo(total, 2);
    }
  });

  it('scopes the TDIC reverse split without taking the tie-out down with it', () => {
    const { scope, realizedByDate } = gradeTape();
    // Ticker-scoped, not window-wide: a blanket withhold would have made
    // 2026-06-16 read −163.15 (options only) and lost the all-instrument grade.
    expect(scope.withholdAllEquity).toBe(false);
    expect([...scope.excludeSymbols]).toEqual(['TDIC']);
    expect(realizedByDate.get('2026-06-16')).toBeCloseTo(-162.35, 2);
  });

  it('never books an unmatched close at gross proceeds', () => {
    // The two May days are closes whose opens predate the export. The old
    // gross-proceeds fallback invented +165.75 and +16.35 out of them; that is
    // the mechanism behind the original phantom-green June calendar.
    const { realizedByDate } = gradeTape();
    expect(realizedByDate.size).toBeGreaterThan(0); // guard: absent != empty map
    expect(realizedByDate.has('2026-05-27')).toBe(false);
    expect(realizedByDate.has('2026-05-20')).toBe(false);
  });

  it('books an EQUITY-ONLY day rather than leaving the cell flat', () => {
    // 2026-06-08 has NO option close, so the options-only path had no key for it
    // and the calendar rendered a flat cell on a day the account lost money.
    // This is the seam between TRA-2876 and the write-decision: the day is only
    // written because `realizedByDate` is non-zero, NOT because a close counted.
    const { realizedByDate, optionsRealizedByDate, closeCountByDate } = gradeTape();
    expect(optionsRealizedByDate.get('2026-06-08') ?? 0).toBeCloseTo(0, 2);
    expect(realizedByDate.get('2026-06-08')).toBeCloseTo(-0.3, 2);

    // Reproduce the write gate from `backfillLiveRealizedCalendar`: a day with no
    // existing artifact is skipped only when BOTH the realized total and the
    // close count are zero.
    const dayRealized = Number((realizedByDate.get('2026-06-08') ?? 0).toFixed(2));
    const closes = closeCountByDate.get('2026-06-08') ?? 0;
    expect(dayRealized === 0 && closes === 0).toBe(false);
  });

  it('reaches every broker-truth day at 24 months back — and none of June at 1', () => {
    const wide = liveBackfillWriteWindow(AS_OF, MONTHS_BACK, FETCH_LOOKBACK_DAYS);
    const narrow = liveBackfillWriteWindow(AS_OF, 1, FETCH_LOOKBACK_DAYS);
    const graded = [
      ...Object.keys(TRADIER_GAINLOSS_BY_CLOSE_DATE),
      ...Object.keys(TRADIER_ALL_INSTRUMENT_BY_CLOSE_DATE),
    ];
    const inWindow = (w: { writeStart: string }, d: string) => d >= w.writeStart && d < AS_OF;

    for (const d of graded) {
      expect(inWindow(wide, d), `${d} must be writable at ${MONTHS_BACK} months`).toBe(true);
    }
    // The contrast is the point: at the old constant the June days are not merely
    // wrong, they are unreachable, and a passing matcher cannot help them.
    const juneGraded = graded.filter(d => d.startsWith('2026-06'));
    expect(juneGraded.length).toBeGreaterThan(0);
    for (const d of juneGraded) {
      expect(inWindow(narrow, d), `${d} was unreachable at 1 month`).toBe(false);
    }
  });

  it('leads the fetch window far enough to pair every open on this tape', () => {
    // With the gross-proceeds fallback gone, a close whose open is outside the
    // FETCH window is dropped. Max hold on this tape is 9 calendar days
    // (PSKY 06-16..06-25); the lookback must clear it with room.
    const { writeStart, fetchStart } = liveBackfillWriteWindow(
      AS_OF,
      MONTHS_BACK,
      FETCH_LOOKBACK_DAYS,
    );
    expect(fetchStart < writeStart).toBe(true);
    const leadDays = Math.round(
      (Date.parse(`${writeStart}T00:00:00Z`) - Date.parse(`${fetchStart}T00:00:00Z`)) / 86_400_000,
    );
    expect(leadDays).toBe(FETCH_LOOKBACK_DAYS);
    expect(leadDays).toBeGreaterThan(9);
  });
});
