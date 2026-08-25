import type { EntryQuoteReason, EntryQuoteSource, EntryQuoteStamp } from '@trading-app/shared';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// TRA-3990 (parent TRA-3945) — the health surface for the entry-quote stamp.
//
// AC4: "absent quote data fails to null, never to a default ... a reason code
// stamped (`no_quote_snapshot`), COUNTED on the health surface. Grade: the
// count is readable and is 0 or explained." Two halves, for the usual reason:
//
//   • SINCE-BOOT (this module's counters) — liveness of the writer in the
//     CURRENT process. Zeroed by a redeploy; `0` reads identically for "clean"
//     and "never exercised", so it is a cross-check, never an alarm basis.
//   • DURABLE (`summarizeEntryQuoteStamp` over the option-trade journal) — the
//     count that survives the 21:00 ET archive and a restart, and the one a
//     grader should read. `unstamped` is the pre-TRA-3990 population and is
//     reported as its own number so it can never be mistaken for a refusal.

export const ENTRY_QUOTE_REASONS: readonly EntryQuoteReason[] = ['no_quote_snapshot', 'one_sided_quote'];
export const ENTRY_QUOTE_SOURCES: readonly EntryQuoteSource[] = ['scanner', 'broker_submit'];

export interface EntryQuoteStampCounts {
  /** Stamps produced (measured + unmeasured). */
  stamped: number;
  /** Stamps carrying a finite `entrySpreadPct`. */
  measured: number;
  /** Stamps carrying nulls, by reason. `stamped === measured + Σ byReason`. */
  byReason: Record<EntryQuoteReason, number>;
  /** Stamps by which snapshot they came from. */
  bySource: Record<EntryQuoteSource, number>;
}

function emptyCounts(): EntryQuoteStampCounts {
  return {
    stamped: 0,
    measured: 0,
    byReason: { no_quote_snapshot: 0, one_sided_quote: 0 },
    bySource: { scanner: 0, broker_submit: 0 },
  };
}

function fold(acc: EntryQuoteStampCounts, stamp: Pick<EntryQuoteStamp, 'entrySpreadPct' | 'entryQuoteSource' | 'entryQuoteReason'>): void {
  acc.stamped += 1;
  acc.bySource[stamp.entryQuoteSource] = (acc.bySource[stamp.entryQuoteSource] ?? 0) + 1;
  if (typeof stamp.entrySpreadPct === 'number' && Number.isFinite(stamp.entrySpreadPct)) {
    acc.measured += 1;
    return;
  }
  const reason = stamp.entryQuoteReason ?? 'no_quote_snapshot';
  acc.byReason[reason] = (acc.byReason[reason] ?? 0) + 1;
}

// ── Since-boot ────────────────────────────────────────────────────────────────

let sinceBoot: EntryQuoteStampCounts = emptyCounts();
let lastStampedAt: number | null = null;

/** Count one stamp on the since-boot surface. Called by every writer of a stamp. */
export function recordEntryQuoteStampOutcome(stamp: EntryQuoteStamp, now: number = Date.now()): void {
  fold(sinceBoot, stamp);
  lastStampedAt = now;
}

export function entryQuoteStampSinceBoot(): EntryQuoteStampCounts & { lastStampedAt: number | null } {
  return {
    ...sinceBoot,
    byReason: { ...sinceBoot.byReason },
    bySource: { ...sinceBoot.bySource },
    lastStampedAt,
  };
}

/** Test seam. */
export function resetEntryQuoteStampForTests(): void {
  sinceBoot = emptyCounts();
  lastStampedAt = null;
}

// ── Durable ───────────────────────────────────────────────────────────────────

export interface EntryQuoteStampDurable extends EntryQuoteStampCounts {
  /** Rows traversed. */
  rowsTraversed: number;
  /**
   * Rows carrying NO stamp — written before TRA-3990, or by an open path that
   * has no single-contract quote (multi-leg spreads, covered writes). These are
   * the rows the export renders `entry_spread_pct` as null WITHOUT a reason;
   * they are not refusals and must not be folded into `byReason`.
   */
  unstamped: number;
  /** Same fold, restricted to `mode: 'live'` rows. */
  live: EntryQuoteStampCounts & { rowsTraversed: number; unstamped: number };
}

/**
 * Pure fold over journal rows. A row is "stamped" iff it carries
 * `entryQuoteSource` — the one key every stamp writes and no pre-TRA-3990 row
 * has. Anything else is `unstamped`, including a row that somehow carries a
 * spread without a source (never written by this build; counted as unstamped
 * rather than trusted).
 */
export function summarizeEntryQuoteStamp(rows: ReadonlyArray<OptionTradeJournalRecord>): EntryQuoteStampDurable {
  const all = emptyCounts();
  const live = emptyCounts();
  let unstamped = 0;
  let liveRows = 0;
  let liveUnstamped = 0;
  for (const r of rows) {
    const isLive = r.mode === 'live';
    if (isLive) liveRows += 1;
    const source = r.entryQuoteSource;
    if (source !== 'scanner' && source !== 'broker_submit') {
      unstamped += 1;
      if (isLive) liveUnstamped += 1;
      continue;
    }
    const stamp = {
      entrySpreadPct: r.entrySpreadPct ?? null,
      entryQuoteSource: source,
      entryQuoteReason: r.entryQuoteReason ?? null,
    };
    fold(all, stamp);
    if (isLive) fold(live, stamp);
  }
  return {
    ...all,
    rowsTraversed: rows.length,
    unstamped,
    live: { ...live, rowsTraversed: liveRows, unstamped: liveUnstamped },
  };
}
