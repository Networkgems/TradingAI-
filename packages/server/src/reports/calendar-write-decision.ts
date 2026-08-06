/**
 * TRA-3100 — the Live-calendar backfill's WRITE DECISION, extracted so it can be
 * graded directly.
 *
 * Why this file exists at all. TRA-2864 landed four arithmetic fixes that each
 * reproduce the broker's own realized P&L to the cent, and the live calendar
 * stayed wrong: only 6 of 49 cells changed. The maths was never the problem —
 * `backfillLiveRealizedCalendar` was structurally not allowed to write the
 * broken days, because every day from 2026-06-10 on already carried a row and
 * the clobber guard preserves any row it did not write itself.
 *
 * A clobber guard written to protect *authoritative* snapshots protects the
 * *corrupt* ones exactly as hard. So the question a test has to be able to ask
 * is not "is the number right" but **"which rows is this allowed to overwrite,
 * and are the broken ones in that set?"** Until now that decision lived inline
 * in a loop inside a 12k-line server entry point and could only be *mirrored* in
 * tests (see the comment at `tra2864-composite-calendar-grade.test.ts:140`, which
 * reproduces the gate rather than calling it). A mirrored gate agrees with itself
 * by construction and cannot catch the gate drifting.
 *
 * Nothing here decides *values*. It decides only whether a cell may be written.
 */

/** The `pnlSource` values a stored calendar row can carry. */
export type CalendarPnlSource =
  | 'engine'
  | 'tradier-balance'
  | 'realized-backfill'
  | 'live-intraday';

/** The parts of a stored EOD row the write decision actually reads. */
export type ExistingCalendarRow = {
  pnlSource?: CalendarPnlSource;
  markdown?: string;
  combinedPnl?: number;
};

export type CalendarWriteDecision =
  /** Write the reconstructed row. `superseded` is non-null only on a forced overwrite. */
  | {
      action: 'write';
      forced: boolean;
      superseded: { pnlSource: CalendarPnlSource | 'unlabelled'; combinedPnl: number } | null;
    }
  /** Leave the cell alone. */
  | { action: 'skip'; reason: 'protected_snapshot' | 'no_activity_no_row' }
  /**
   * A force was requested for this date and REFUSED. Distinct from `skip`: the
   * operator asked for something and did not get it, and must be told. A refusal
   * that degrades to a silent skip is the whole failure mode this issue is about.
   */
  | { action: 'refuse_force'; reason: string };

/**
 * A day already owned by a *real* snapshot — a broker-balance override or an
 * engine EOD row — is authoritative and is never downgraded to options-only
 * realized by an ordinary pass. Only days with no report file, or a prior
 * realized-backfill row, are (re)written from broker fills.
 *
 * The markdown probe is the back-compat arm: rows written before `pnlSource`
 * existed carry the TRA-244 header and nothing else.
 */
export function isBackfillRow(row: ExistingCalendarRow): boolean {
  return (
    row.pnlSource === 'realized-backfill' ||
    /Live calendar backfill \(TRA-244\)/.test(row.markdown ?? '')
  );
}

/**
 * Decide whether the backfill may write `date`.
 *
 * `forced` means an operator named this exact date. It is the ONLY way past the
 * clobber guard, and it is still not unconditional: a forced date with no broker
 * closes is refused, because overwriting a real snapshot with $0.00 on the
 * strength of an empty tape replaces one wrong number with a worse one.
 */
export function decideCalendarRowWrite(input: {
  existing: ExistingCalendarRow | null;
  /** Combined realized P&L reconstructed from broker fills for this date. */
  dayRealized: number;
  /** How many broker closes were FIFO-matched to this date. The evidence count. */
  dayCloseCount: number;
  /** Whether an operator explicitly named this date in a force list. */
  forced: boolean;
}): CalendarWriteDecision {
  const { existing, dayRealized, dayCloseCount, forced } = input;

  if (existing && !isBackfillRow(existing)) {
    if (!forced) return { action: 'skip', reason: 'protected_snapshot' };
    if (dayCloseCount === 0) {
      return {
        action: 'refuse_force',
        reason: 'no_broker_closes_on_this_date (refusing to overwrite a real snapshot with $0.00)',
      };
    }
    return {
      action: 'write',
      forced: true,
      superseded: {
        pnlSource: existing.pnlSource ?? 'unlabelled',
        combinedPnl: Number((existing.combinedPnl ?? 0).toFixed(2)),
      },
    };
  }

  // No artifact and no activity: leave the day ABSENT so the calendar renders
  // "--". Writing a phantom $0.00 row would assert "this day was flat", which is
  // a different claim from "nothing is recorded for this day".
  if (!existing && dayRealized === 0 && dayCloseCount === 0) {
    return { action: 'skip', reason: 'no_activity_no_row' };
  }

  return { action: 'write', forced: false, superseded: null };
}

export type ForceListTriage = {
  /** Dates cleared to attempt a forced overwrite. */
  accepted: Set<string>;
  /** Dates rejected up front, each with a reason. Never silently dropped. */
  refused: Array<{ date: string; reason: string }>;
};

/**
 * Validate an operator-supplied force list BEFORE any writing starts.
 *
 * Every rejection is named and returned. A force request that quietly evaporates
 * is worse than having no force path: the caller reads `ok: true` and believes
 * the day was corrected.
 */
export function triageForceDates(
  requested: readonly string[],
  ctx: {
    /** Inclusive lower bound of the writable window. */
    writeStart: string;
    /** Exclusive upper bound — today is owned by the intraday cell + the 9 PM snapshot. */
    todayExclusive: string;
    /**
     * Whether equity realized is included in this pass. When the corporate-action
     * feed could not be read (or a split invalidated the lot book) the figure is
     * options-only, and forcing it over a protected all-instrument row would swap
     * one wrong number for another. Fail closed and retry when it is readable.
     */
    includeEquity: boolean;
  },
): ForceListTriage {
  const accepted = new Set<string>();
  const refused: Array<{ date: string; reason: string }> = [];

  for (const raw of requested) {
    const date = String(raw).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      refused.push({ date, reason: 'malformed_date (expected YYYY-MM-DD)' });
      continue;
    }
    if (date < ctx.writeStart || date >= ctx.todayExclusive) {
      refused.push({
        date,
        reason: `outside_write_window (writable range is ${ctx.writeStart} .. ${ctx.todayExclusive} exclusive)`,
      });
      continue;
    }
    if (!ctx.includeEquity) {
      refused.push({
        date,
        reason:
          'equity_withheld_this_pass (corporate-action scope unreadable or invalidated; the reconstruction is options-only)',
      });
      continue;
    }
    accepted.add(date);
  }

  return { accepted, refused };
}
