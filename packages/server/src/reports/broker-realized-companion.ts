/**
 * TRA-4201 — the SECOND measure on a calendar row.
 *
 * A stored EOD row holds exactly one `combinedPnl` and one `pnlSource`, so a day
 * can render exactly one measure. On the live book almost every day is owned by
 * a `tradier-balance` snapshot — the change in account value, which INCLUDES
 * unrealized mark-to-market — and the realized broker-fill figure has nowhere to
 * live. The TRA-244 backfill already reconstructs it (FIFO-matching each close to
 * its open) and then throws it away, because `decideCalendarRowWrite` correctly
 * returns `skip / protected_snapshot` for those days.
 *
 * The guard is right and stays. Overwriting a settled equity snapshot with an
 * options-heavy realized figure is the downgrade TRA-1192 wrote it to prevent.
 * What was missing is a place to put the second number, which is all this file
 * is: a NON-AUTHORITATIVE companion block written BESIDE the authoritative
 * fields, never instead of them.
 *
 * Measured cost of having only one measure (TRA-4199, account ***0154, Aug 2026):
 * a single round trip renders as TWO loss days (the opening mark on 08-17, that
 * mark reversing into the realized loss on 08-18) and six fee-only residue days
 * (−$0.42, −$0.13, …) count into a 6% "win rate". Neither figure is a strategy
 * statistic; the realized series is.
 *
 * Nothing here decides whether a row may be WRITTEN — that is
 * `calendar-write-decision.ts`, and this module is deliberately downstream of a
 * `skip` from it.
 */

/**
 * The reconstructed realized figure for a day, carried on the row alongside
 * whatever measure actually owns `combinedPnl`.
 *
 * `closeCount` is the load-bearing field and the reason this is not just a
 * number. TRA-3101's lesson is that **absence must not read as zero**: a day
 * with no broker closes did not trade, and rendering it `$0.00` under a realized
 * view puts a day nobody traded into the win-rate denominator. `closeCount === 0`
 * means "did not trade" and renders `--`; it does NOT mean "traded flat".
 */
export type BrokerRealizedCompanion = {
  /** `optionsPnl + equityPnl`, rounded to the cent. The R-view cell figure. */
  combinedPnl: number;
  /** Realized P&L on OPTION positions closed this day (broker fills, FIFO). */
  optionsPnl: number;
  /**
   * Realized P&L on STOCK positions closed this day. TRA-2876 keeps the sleeves
   * split because the calendar detail view renders them as separate tiles;
   * folding equity into options would tie the cell out while misattributing
   * which sleeve earned it.
   */
  equityPnl: number;
  /**
   * Broker closes FIFO-matched to this date. The EVIDENCE COUNT, and the only
   * thing that separates "did not trade" from "traded flat".
   */
  closeCount: number;
  /**
   * TRA-2876 — false when the corporate-action feed could not be read (or a
   * split invalidated the lot book), in which case `equityPnl` is 0 by
   * ABSTENTION and `combinedPnl` is options-only. A reader that does not branch
   * on this will present an options-only figure as an all-instrument one.
   */
  equityIncluded: boolean;
  /** ISO timestamp of the pass that reconstructed these figures. */
  reconstructedAt: string;
};

/** The parts of a stored row this module reads or replaces. */
export type CompanionCarrier = {
  brokerRealized?: BrokerRealizedCompanion;
};

const cents = (n: number): number => Number((Number.isFinite(n) ? n : 0).toFixed(2));

/**
 * Build the companion for one day from the backfill pass's own reconstruction.
 *
 * `combinedPnl` is derived here rather than passed in, so the companion cannot
 * ship a total that disagrees with its own two sleeves.
 */
export function buildBrokerRealizedCompanion(input: {
  optionsPnl: number;
  equityPnl: number;
  closeCount: number;
  equityIncluded: boolean;
  /** ISO timestamp; injected so tests are not clock-dependent. */
  reconstructedAt: string;
}): BrokerRealizedCompanion {
  const optionsPnl = cents(input.optionsPnl);
  const equityPnl = cents(input.equityPnl);
  return {
    combinedPnl: cents(optionsPnl + equityPnl),
    optionsPnl,
    equityPnl,
    closeCount: Math.max(0, Math.trunc(input.closeCount) || 0),
    equityIncluded: input.equityIncluded,
    reconstructedAt: input.reconstructedAt,
  };
}

/**
 * Whether two companions carry the same FIGURES, ignoring `reconstructedAt`.
 *
 * This is the idempotency test. The backfill runs at startup and on a schedule,
 * so comparing whole objects (timestamp included) would rewrite every protected
 * row on every pass — churning `mtime`, and making "the file changed" useless as
 * a signal that a number changed. AC3 wants a re-run to leave protected rows
 * byte-identical, and the only way to get that is to not write at all when
 * nothing moved.
 */
export function companionFiguresEqual(
  a: BrokerRealizedCompanion | undefined,
  b: BrokerRealizedCompanion | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.combinedPnl === b.combinedPnl &&
    a.optionsPnl === b.optionsPnl &&
    a.equityPnl === b.equityPnl &&
    a.closeCount === b.closeCount &&
    a.equityIncluded === b.equityIncluded
  );
}

export type CompanionApplication<T> = {
  /**
   * False when the stored companion already carries these figures. The caller
   * MUST skip the write in that case — see {@link companionFiguresEqual}.
   */
  changed: boolean;
  /** The row to persist. Identity-equal to the input when `changed` is false. */
  row: T;
};

/**
 * Attach the companion to a row, touching NOTHING else.
 *
 * The row is rebuilt by spread, so every authoritative field (`combinedPnl`,
 * `pnlSource`, `realizedPnl`, `optionsPnl`, `markdown`, …) keeps both its value
 * and its key order — `JSON.stringify` output is byte-identical apart from the
 * `brokerRealized` block itself. That is a property this function must preserve
 * and a test asserts directly: the whole point of writing a companion onto a
 * PROTECTED row is that the protection still holds.
 */
export function applyBrokerRealizedCompanion<T extends CompanionCarrier>(
  row: T,
  companion: BrokerRealizedCompanion,
): CompanionApplication<T> {
  if (companionFiguresEqual(row.brokerRealized, companion)) {
    return { changed: false, row };
  }
  return { changed: true, row: { ...row, brokerRealized: companion } };
}
