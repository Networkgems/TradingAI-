// TRA-3848 — the market-day gate for the stock EOD report writer.
//
// ── Why this is a module and not four lines inside `generateAndSaveReport` ────
//
// `index.ts` is not importable by a test (nothing in 345 server test files does
// it; the boot side effects make it impractical), so a predicate that lives
// inline there can only ever be graded by reading its source text. This gate
// decides whether three money-adjacent artifacts get written — an archive cell,
// an OVERWRITE of `latest.json`, and the daily equity snapshot that is also the
// TRA-2817 ledger row — and "the source says it calls isMarketDayIso" is not
// evidence about the SAturday/Friday pair, the Labor-Day-is-a-Monday case, or
// the ET-midnight straddle below. Extracting the decision makes those arms real.
//
// ── The decision is BOTH halves, and that is the point ───────────────────────
//
// The defect this closes is not only "no calendar check". It is that the date
// being checked and the date being WRITTEN were two independent readings of the
// ET clock:
//
//   the gate        `opts.asOfDate ?? etDateString()`                    (index.ts)
//   the write   `asOfDate ?? new Date().toLocaleDateString('en-CA', …)`  (eod-report.ts:1244)
//
// Identical expressions, evaluated ~400 lines and one `await`-heavy Tradier
// reconcile apart. Across an ET midnight they return different days, and the
// direction that matters is Friday→Saturday: the gate grades Friday, passes, and
// the writer stamps Saturday. That is the TRA-2498 hour-24 shape at the one seam
// where it would defeat the gate silently. So this function RESOLVES the date and
// the caller must write the date it returns — one derivation, no second read.
//
// ── Not `if (!backfill)` ─────────────────────────────────────────────────────
//
// The backfill (`catchUpMissedEodReports`) legitimately names a past date, and
// its dates come from `missedTradingDays`, which already filters `isMarketDayIso`
// — so this gate is a no-op on that path by construction, and `eod-write-gate.test.ts`
// pins that with the real function rather than asserting it. Exempting backfills
// anyway would be wrong in the one case that matters: if the two calendars ever
// drifted, the exemption is precisely what would let the drift write phantom
// cells unobserved. There is no date for which minting a non-session cell is
// correct, so there is no caller that gets to skip the check.

import { isMarketDayIso, etDateString } from '../scheduler.js';

export type EodWriteDecision =
  /** Write, and stamp the report with exactly this date. */
  | { write: true; date: string; backfill: boolean }
  /**
   * Do not write anything — not the archive cell, not `latest.json`, not the
   * snapshot/ledger row. `skipReason` is deliberately its own field rather than
   * an `error`: TRA-3844's rule, a refused Saturday and an ENOSPC on a Tuesday
   * must not read alike at any consumer.
   */
  | { write: false; date: string; backfill: boolean; skipReason: 'non_market_day' };

/**
 * Resolve the EOD report's date and decide whether it may be written.
 *
 * `now` exists for the arms only; production always takes the default. Callers
 * MUST use the returned `date` as the report's date — re-deriving it defeats the
 * single-derivation property this function exists to provide.
 *
 * A malformed `asOfDate` is REFUSED, not written: `isMarketDayIso` returns false
 * for anything that is not `YYYY-MM-DD`, and a cell filed under a name no reader
 * can resolve is worse than no cell (the same posture TRA-3847 took for
 * `closes/`).
 */
export function decideEodReportWrite(
  opts: { asOfDate?: string } = {},
  now: Date = new Date(),
): EodWriteDecision {
  const backfill = opts.asOfDate != null;
  const date = opts.asOfDate ?? etDateString(now);
  if (!isMarketDayIso(date)) {
    return { write: false, date, backfill, skipReason: 'non_market_day' };
  }
  return { write: true, date, backfill };
}
