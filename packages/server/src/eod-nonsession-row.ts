// TRA-3849 — THE NON-SESSION LEDGER ROW AXIS.
//
// Every EOD presence axis this codebase publishes asks the same question in the
// same direction: *is a session missing a row?* `eodRowMissing` walks `days[]`
// and grades a session that has no `eodCombined`. `eodInterior` (TRA-2888,
// `eod-ledger-gap.ts`) enumerates sessions FROM the exchange calendar and grades
// the ones with no row at all. `eodTailStaleSessions` (TRA-2817) counts settled
// sessions past the newest row.
//
// None of them can see the OPPOSITE defect: **a row on a date that was never a
// session.** `days[]` is built from the persisted snapshots, so a phantom date
// key enters it unchallenged, and every axis above then treats it as just
// another row — including the ones that pair `days[i]` with `days[i-1]`.
//
// Measured on live `b70404f`, 2026-08-18, over the complete series:
//
//     denominator : 918 rows · 67 books · 78 distinct date keys · 05-03 .. 08-17
//     NON-SESSION ROWS : 83  across 63 books, on 11 distinct date keys
//     82 of 83 are SUNDAYS; the 08-09 cohort alone is 63 books in one pass
//
// That shape is the mechanism `isMarketDay`'s own doc names — the 21:00 ET
// archive sweep booking a phantom Sunday session while its gate read a
// host-local weekday (TRA-3267). TRA-3267 fixed the WRITE PATH on 2026-08-13,
// forward only, and its fence was re-verified over the ARCHIVE directory on its
// own predicate. These rows are in the DURABLE LEDGER SERIES and survived it: a
// green TRA-3267 is not coverage here.
//
// ── WHAT THIS AXIS IS FOR, AND WHAT IT MUST NOT BE READ AS ───────────────────
// It NAMES a population. It does not retract one. `ENABLE_EOD_ROW_BACKFILL`
// stays false and the TRA-2886/TRA-2888 ruling against restating banked rows
// stands; whether these 83 should ever be retracted is a BOARD question, and it
// cannot be asked coherently until the population is named and stable. So the
// expected steady state of this axis is RED, and a red here is NOT an incident
// to be cleared — it is the standing population awaiting a ruling.
//
// The incident is MOVEMENT:
//
//   - the count GROWS  → some writer is minting phantoms again, i.e. a TRA-3267
//     class regression on a path nobody gated. This is the pageable direction.
//   - the count SHRINKS → either a ruled retraction (fine, and it will be
//     documented) or something pushed it down that has no right to: a book
//     falling out of `getAllUserContexts()`, a stale holiday table re-grading a
//     phantom as a session, an endpoint truncating its own census.
//
// A bare count cannot tell those apart, which is why every field below travels
// with its DENOMINATOR and the population is published as NAMED ROWS
// (book · mode · date), never as a scalar. `scripts/check-nonsession-rows.mjs`
// diffs those names against a committed manifest and refuses to call a shrink
// clean. A number that can be pushed down by anything other than a ruled
// retraction is not a tripwire, and this module is written to make the push
// visible rather than to prevent it.
//
// ── TRI-STATE, AND WHY `null` IS NOT GREEN ───────────────────────────────────
// The axis is graded ONLY where a calendar was supplied. `reconcilePnl` takes
// its `tailCalendar` optionally (every pre-TRA-2817 caller passes nothing), so a
// caller with no calendar gets `nonSessionRowsOk: null` and
// `nonSessionRowGradeableCount: 0` — NOT MEASURED. `0 / 0` reading as a pass is
// the `every`-on-the-empty-set trap this endpoint has been bitten by on four
// separate axes; quote the gradeable count beside any verdict.

/** The per-book shape this fold needs. A subset of `PnlReconcileResult`. */
export interface NonSessionRowBook {
  username: string;
  mode: string;
  /** Dates in `days[]` that the supplied calendar says are not NYSE sessions. */
  nonSessionRowDates: string[];
  /**
   * The subset of `nonSessionRowDates` carrying a materially non-zero figure on
   * `eodCombined`, `stockDaily` or `optionsDaily`. See
   * {@link NON_SESSION_MONEY_PREDICATE}.
   */
  nonSessionRowMoneyBearingDates: string[];
  /**
   * How many rows the axis actually graded for this book — i.e. `days.length`
   * when a calendar was supplied, `0` when none was. The DENOMINATOR. A book
   * with `nonSessionRowDates: []` and `nonSessionRowGradeableCount: 0` has not
   * been found clean; it has not been looked at.
   */
  nonSessionRowGradeableCount: number;
}

/**
 * The money predicate, stated once and exported so a reader does not have to
 * re-derive it from a count.
 *
 * A row is MONEY-BEARING when `|eodCombined|`, `|stockDaily|` or `|optionsDaily|`
 * exceeds `PNL_RECONCILE_TOLERANCE_USD` (0.01). This matters for leg 3 of
 * TRA-3849: retracting an inert row and retracting one that carries a P&L figure
 * every weekly/monthly/yearly window already summed are not the same question,
 * and the board needs the split rather than the total.
 *
 * ⚠️ This SUPERSEDES the ad-hoc "non-zero rows" column in the TRA-3849 filing,
 * which was computed by hand and read 17 on 2026-08-09 / 18 fleet-wide. On this
 * predicate the live figures are **18 on 2026-08-09 and 26 fleet-wide**. The
 * filing's column was never defined in code; this one is. Where they disagree,
 * this is the number, and the reason to prefer it is that it is reproducible.
 *
 * Note what the live split actually shows: nearly every money-bearing phantom
 * carries its figure on `eodCombined` (the EOD REPORT's number) with
 * `stockDaily` and `optionsDaily` both flat. The phantom rows are not recording
 * phantom trading — they are banking a report cell against a date that was not
 * a session.
 */
export const NON_SESSION_MONEY_PREDICATE =
  'TRA-3849: a non-session ledger row is MONEY-BEARING when |eodCombined|, |stockDaily| or |optionsDaily| > PNL_RECONCILE_TOLERANCE_USD (0.01). Live 2026-08-18 on build b70404f: 26 of 83 fleet-wide, 18 of 63 on 2026-08-09. This supersedes the hand-computed "non-zero rows" column in the TRA-3849 filing (17/18), which was never defined in code. Almost all of them carry the figure on `eodCombined` with both legs flat — a report cell banked against a non-session, not phantom trading.';

/**
 * The caveat that travels on the payload beside the numbers, in the same shape
 * as `PNL_RECONCILIATION_CAVEATS`. A reader who finds this axis red must not
 * read it as an outage to clear.
 */
export const NON_SESSION_LEDGER_ROW_CAVEAT =
  'TRA-3849: `nonSessionLedgerRowCount` names ledger rows whose DATE was never an NYSE session — the opposite direction from every other EOD presence axis here, all of which grade a session for a missing row. Live on build b70404f 2026-08-18: 83 rows / 918 (67 books, 78 date keys, 2026-05-03..2026-08-17), 63 books affected, 11 date keys, 82 of them Sundays, and the 2026-08-09 cohort alone is 63 books in one pass — the TRA-3267 host-local-weekday archive sweep, which was fixed FORWARD ONLY on 2026-08-13 and never touched these rows. ⛔ A RED HERE IS THE EXPECTED STEADY STATE, NOT AN INCIDENT: the population is deliberately LEFT IN PLACE (`ENABLE_EOD_ROW_BACKFILL` false, TRA-2886/TRA-2888 ruling against restating banked rows stands), and whether it should ever be retracted is a board question. What is actionable is MOVEMENT. A GROWING count means a writer is minting phantoms again on a path nobody gated. A SHRINKING count is NOT automatically a repair — a book leaving `getAllUserContexts()`, a stale holiday table, or a truncated census all push it down without anything being retracted, which is why the population is published as NAMED rows (book/mode/date) and diffed against a committed manifest by `pnpm check:nonsession-rows`. Read `nonSessionRowGradedRowCount` as the denominator: `nonSessionLedgerRowsOk: null` means NO CALENDAR WAS SUPPLIED and NOTHING was graded, never that the series is clean.';

export interface NonSessionRowSummary {
  /** Books whose rows were actually graded (calendar supplied). Denominator. */
  nonSessionRowGradedBookCount: number;
  /** Rows actually graded, fleet-wide. THE denominator — 918 on live today. */
  nonSessionRowGradedRowCount: number;
  /** Non-session rows found. 83 on live today. */
  nonSessionLedgerRowCount: number;
  /** Books holding at least one. 63 on live today. */
  nonSessionLedgerBookCount: number;
  /** Distinct non-session date keys, sorted. 11 on live today. */
  nonSessionLedgerDateKeys: string[];
  /** The money-bearing subset. See {@link NON_SESSION_MONEY_PREDICATE}. */
  nonSessionLedgerMoneyBearingRowCount: number;
  /**
   * THE POPULATION, named. Not a count — a count cannot be diffed, and the
   * whole forward-safety argument rests on being able to tell "row retracted"
   * from "book left the census".
   */
  nonSessionLedgerBooks: Array<{
    username: string;
    mode: string;
    dates: string[];
    moneyBearingDates: string[];
  }>;
  /**
   * The same population folded the other way — by date. This is the axis that
   * makes an attribution legible: one date carrying 63 books in one pass is a
   * fleet sweep, one date carrying a single demo book is a per-caller write.
   */
  nonSessionLedgerByDate: Array<{
    date: string;
    bookCount: number;
    moneyBearingBookCount: number;
    modes: string[];
  }>;
  /**
   * TRI-STATE. `false` = at least one non-session row exists. `true` = rows were
   * graded and none is a non-session. `null` = NOT MEASURED (nothing graded) —
   * never a pass.
   */
  nonSessionLedgerRowsOk: boolean | null;
  nonSessionLedgerRowCaveat: string;
}

/**
 * TRA-3849 — fold the per-book non-session row axis over the whole fleet.
 *
 * Deliberately NOT scoped to `mode: live`. The 83 rows span live, sandbox AND
 * demo, and the durable series every weekly/monthly/yearly window sums does not
 * discriminate by mode. Scoping to live here would report 20-ish rows and hide
 * the 63-book sweep that is the actual finding.
 *
 * Deliberately NOT baseline-gated either. Every other verdict in
 * `pnl-reconciliation.ts` grades the `evaluated` (post-`baselineDate`) cohort,
 * because a drift figure computed over pre-baseline data is not trustworthy.
 * That reasoning does not transfer: a phantom row is a phantom row whatever the
 * baseline says about its numbers, and 9 of the 11 date keys here are from May
 * and June — the baseline gate would silently drop most of the population.
 */
export function summarizeNonSessionLedgerRows(
  books: ReadonlyArray<NonSessionRowBook>,
): NonSessionRowSummary {
  const graded = books.filter(b => b.nonSessionRowGradeableCount > 0);
  const offenders = books.filter(b => b.nonSessionRowDates.length > 0);

  const byDate = new Map<string, { books: Set<string>; money: Set<string>; modes: Set<string> }>();
  for (const b of offenders) {
    const money = new Set(b.nonSessionRowMoneyBearingDates);
    for (const d of b.nonSessionRowDates) {
      let cell = byDate.get(d);
      if (!cell) {
        cell = { books: new Set(), money: new Set(), modes: new Set() };
        byDate.set(d, cell);
      }
      // Keyed on username|mode: the same username can appear once per mode in
      // `engines[]`, and collapsing them would undercount the sweep.
      cell.books.add(`${b.username}|${b.mode}`);
      if (money.has(d)) cell.money.add(`${b.username}|${b.mode}`);
      cell.modes.add(b.mode);
    }
  }

  const rowCount = offenders.reduce((a, b) => a + b.nonSessionRowDates.length, 0);
  return {
    nonSessionRowGradedBookCount: graded.length,
    nonSessionRowGradedRowCount: graded.reduce((a, b) => a + b.nonSessionRowGradeableCount, 0),
    nonSessionLedgerRowCount: rowCount,
    nonSessionLedgerBookCount: offenders.length,
    nonSessionLedgerDateKeys: [...byDate.keys()].sort(),
    nonSessionLedgerMoneyBearingRowCount: offenders.reduce(
      (a, b) => a + b.nonSessionRowMoneyBearingDates.length,
      0,
    ),
    nonSessionLedgerBooks: offenders
      .map(b => ({
        username: b.username,
        mode: b.mode,
        dates: [...b.nonSessionRowDates].sort(),
        moneyBearingDates: [...b.nonSessionRowMoneyBearingDates].sort(),
      }))
      .sort((x, y) => `${x.username}|${x.mode}`.localeCompare(`${y.username}|${y.mode}`)),
    nonSessionLedgerByDate: [...byDate.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([date, cell]) => ({
        date,
        bookCount: cell.books.size,
        moneyBearingBookCount: cell.money.size,
        modes: [...cell.modes].sort(),
      })),
    // `null` on a wholly ungraded fleet. NOT `true` — see the module header.
    nonSessionLedgerRowsOk: graded.length === 0 ? null : rowCount === 0,
    nonSessionLedgerRowCaveat: NON_SESSION_LEDGER_ROW_CAVEAT,
  };
}
