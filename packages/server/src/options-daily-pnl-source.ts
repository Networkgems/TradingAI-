import type { DailySnapshot } from './pnl-tracker.js';
import type { JournalDayCloses } from './pnl-reconciliation.js';

// TRA-2314 (parent TRA-2297, split from TRA-2302) — SOURCE the day-only realized
// options P&L from the DURABLE option-trade journal instead of the engine's
// volatile in-memory `closedOptions` bucket.
//
// TRA-2302 settled the verdict: `DailySnapshot.optionsDailyPnl` read 0.00 on all
// 95 desk book-days while the append-only journal held 110 closed desk round
// trips worth +$844.99 over the same window. It proved by mutation test that the
// WRITE path is correct — a demo option closed today lands in the snapshot and
// reconciles clean. The defect is the SOURCE:
//
//   index.ts  ->  optionsDailyPnl: finalReport.optionsPnl
//   eod-report.ts:779  ->  Σ ReportInput.closedOptions closed today
//   signal-engine.ts   ->  PaperOptionsAccount.closedOptions   (IN-MEMORY)
//
// That bucket is emptied every night by `archiveClosedOptions()`, is not
// guaranteed across the restarts bqb1 takes several times an hour, and is
// `optional` on `ReportInput` — so an absent list silently means zero. A day
// whose closes are not in the bucket at 21:00 ET books exactly `0.00`, which is
// bit-identical to a day that genuinely traded no options. No failing state.
//
// The journal is append-only, per-trade and dated, so it CAN tell those two
// states apart. This module is the one place that decides which source a day
// cell is booked from, and it always records the answer on the row — because a
// repaired cell and a never-broken cell would otherwise read identically
// (the TRA-2301 lesson).

/**
 * Where a day cell's `optionsDailyPnl` actually came from. Persisted on the
 * snapshot so a reader can always tell a journal-sourced figure from a
 * bucket-sourced one, and a REPAIRED row from one that was never broken.
 */
export type OptionsDailyPnlSource =
  /** Booked live off the durable journal census at 21:00 ET. The new normal. */
  | 'journal'
  /** Rewritten from the journal by the historical repair (was a false zero). */
  | 'journal-repair'
  /**
   * No census was available (journal disabled, or the read failed), so the
   * legacy volatile-bucket figure was booked unchanged. NOT a silent fallback —
   * this value is what makes the degraded mode visible.
   */
  | 'bucket-no-census'
  /**
   * The census names NO closes for the day but the bucket carried a non-zero
   * figure. The journal is behind, not the bucket; the bucket figure is KEPT
   * rather than destroyed, and the disagreement is named. This is the inverse of
   * the false zero and needs its own failing state.
   */
  | 'bucket-journal-silent';

export interface OptionsDailyPnlDecision {
  /** The figure to BOOK into `DailySnapshot.optionsDailyPnl` / the report. */
  value: number;
  source: OptionsDailyPnlSource;
  /**
   * The volatile in-memory bucket figure that WOULD have been booked before this
   * ticket. Always recorded, even when it is the value chosen, so the before/after
   * of this change is readable per row forever rather than only in a changelog.
   */
  bucketPnl: number;
  /** Σ realized options P&L the journal recorded for this ET day; null = no census. */
  journalPnl: number | null;
  /** Option closes the journal recorded for this ET day; null = no census. */
  journalCloses: number | null;
  /** True when the journal moved the number off the bucket figure. */
  changed: boolean;
}

/**
 * Scope journal rows to ONE book. The single shared predicate — the writer
 * (index.ts, 21:00 ET) and the checker (`/api/health/pnl-reconciliation`) MUST
 * use the same one, or the guard will grade a population the writer never saw
 * and `falseZeroDates` will never empty.
 *
 * Rows written before TRA-1475 carry no `account`. They are UNATTRIBUTABLE, so
 * they are left out rather than credited to whichever book is being written —
 * pooling them would re-commit the TRA-2193 trap (2,192 such rows exist).
 *
 * ── TRA-2421 — `identityEpochMs`, and why a username alone is not a book ──────
 *
 * `account` holds a raw username, and usernames are RECYCLABLE: they are the only
 * primary key in this app, so deleting an account frees the string for the next
 * signup (TRA-2406/TRA-2410, confirmed by hand 2026-07-26). The journal is shared,
 * append-only and lives OUTSIDE `users/<username>/`, so no account wipe can reach
 * it — which means that without this parameter a recycled name inherits its
 * predecessor's rows through this exact function. Today that is masked by the
 * unscoped demo-calendar fill; the moment TRA-2407 scopes the fold by book, it
 * surfaces looking like a regression OF the TRA-2407 fix.
 *
 * The rows are deliberately NOT purged or anonymised (see `account-deletion.ts`
 * for why both corrupt board-graded numbers). They are scoped out of the RECYCLED
 * book instead.
 *
 * `identityEpochMs` is the ms-epoch the current holder of the name acquired it —
 * i.e. `accountDeletedAt(username)`, which is `null` for every name nobody has
 * ever deleted. `null`/`undefined` means NO time scoping at all, so every existing
 * book's fold is byte-for-byte unchanged by this parameter; pass the tombstone,
 * never `Date.now()` and never a `?? 0`.
 *
 * When an epoch IS given, a row with no usable `openTs` is DROPPED. It is
 * unattributable in time exactly as an `account`-less row is unattributable by
 * book, and the two get the same treatment for the same reason.
 */
export function journalRowsForBook<T extends { account?: string; openTs?: number }>(
  rows: ReadonlyArray<T>,
  username: string,
  identityEpochMs?: number | null,
): T[] {
  const scoped = rows.filter(r => r.account === username);
  if (identityEpochMs === undefined || identityEpochMs === null) return scoped;
  return scoped.filter(r => typeof r.openTs === 'number'
    && Number.isFinite(r.openTs)
    && r.openTs >= identityEpochMs);
}

/**
 * Decide which source books this ET day's realized options P&L.
 *
 * `census` is this book's journal fold for the day (null = the day is absent
 * from the census, i.e. zero closes). `censusAvailable` distinguishes "the
 * journal says this day had no closes" from "there is no journal to ask" — the
 * two are NOT the same and collapsing them is how the original `?? 0` hid this
 * bug for 95 days.
 */
export function resolveDailyOptionsPnl(args: {
  bucketPnl: number;
  census: JournalDayCloses | null;
  censusAvailable: boolean;
}): OptionsDailyPnlDecision {
  const bucketPnl = round2(args.bucketPnl);

  // No journal to ask. Book exactly what the old code booked and SAY SO, so a
  // deploy that loses the journal degrades visibly instead of silently reverting
  // to the defect this ticket fixes.
  if (!args.censusAvailable) {
    return {
      value: bucketPnl,
      source: 'bucket-no-census',
      bucketPnl,
      journalPnl: null,
      journalCloses: null,
      changed: false,
    };
  }

  const journalCloses = args.census?.closes ?? 0;
  const journalPnl = round2(args.census?.realizedPnlUsd ?? 0);

  // The journal named closes on this day: it is the durable record of what
  // actually happened, so it books the cell. This is the fix.
  if (journalCloses > 0) {
    return {
      value: journalPnl,
      source: 'journal',
      bucketPnl,
      journalPnl,
      journalCloses,
      changed: journalPnl !== bucketPnl,
    };
  }

  // The journal named no closes but the bucket carries a number. Do NOT zero a
  // real figure on the strength of a ledger that is behind — keep the bucket and
  // give the disagreement a name of its own.
  if (bucketPnl !== 0) {
    return {
      value: bucketPnl,
      source: 'bucket-journal-silent',
      bucketPnl,
      journalPnl,
      journalCloses,
      changed: false,
    };
  }

  // Both agree the day had no option activity. This is now a PROVEN zero rather
  // than an unfalsifiable one — the distinction the whole ticket is about.
  return {
    value: 0,
    source: 'journal',
    bucketPnl,
    journalPnl,
    journalCloses,
    changed: false,
  };
}

/** One historical day the repair would rewrite, with its before/after. */
export interface OptionsDailyPnlRepairDelta {
  date: string;
  /** `optionsDailyPnl` as persisted before the repair (the false zero). */
  before: number;
  /** The journal figure the repair books. */
  after: number;
  /** after − before. */
  delta: number;
  /** Option closes the journal recorded on this day for this book. */
  journalCloses: number;
}

export interface OptionsDailyPnlRepairPlan {
  deltas: OptionsDailyPnlRepairDelta[];
  /** Σ delta over every repaired day, USD — the total the day-only ledger lost. */
  totalDeltaUsd: number;
  /** Snapshot rows considered. */
  examined: number;
  /**
   * Days the census names closes on that the repair deliberately did NOT move —
   * either the snapshot already carries a non-zero figure, or (TRA-2642) the
   * census nets exactly the figure already booked, so there is nothing to move.
   * See {@link planOptionsDailyPnlRepair}.
   */
  leftAloneDates: string[];
}

/**
 * Plan the historical repair for one book. Pure — the caller persists.
 *
 * Repairs ONLY the proven defect: a day the journal names closes on whose
 * `optionsDailyPnl` is exactly 0 AND whose census P&L is something other than 0
 * (TRA-2642 — a zero-net day is already booked correctly, and "repairing" it to
 * the same value on every boot is what broke idempotence). A day that already
 * booked a NON-ZERO options
 * figure is left alone even when it disagrees with the journal, because that
 * number may be right and silently rewriting it is precisely the unannounced
 * correction the ticket forbids (TRA-2079). Those days are still NAMED, in
 * `leftAloneDates`, so the residual disagreement is not hidden either — the day
 * rows carry both `optionsDaily` and `journalOptionsPnl` for anyone subtracting.
 */
export function planOptionsDailyPnlRepair(
  snapshots: ReadonlyArray<DailySnapshot>,
  censusByDate: ReadonlyMap<string, JournalDayCloses>,
): OptionsDailyPnlRepairPlan {
  const deltas: OptionsDailyPnlRepairDelta[] = [];
  const leftAloneDates: string[] = [];
  for (const s of snapshots) {
    const census = censusByDate.get(s.date);
    if (!census || census.closes <= 0) continue;
    const before = round2(s.optionsDailyPnl ?? 0);
    if (before !== 0) {
      leftAloneDates.push(s.date);
      continue;
    }
    const after = round2(census.realizedPnlUsd);
    // TRA-2642 (found grading TRA-2625) — nothing to move. A day whose closes net
    // exactly $0.00 already books the right figure, so emitting a zero delta made
    // this function NON-IDEMPOTENT against its own docstring: the next boot found
    // the same row still at 0, "repaired" it again, rewrote `snapshots.json` and
    // logged a board-facing "a ledger moved" warn that moved nothing. Live tape:
    // `ctoverify_tra2227` / `ctoverify_tra2329` each logged
    // `dates:["2026-07-27:0.00->0.00"], totalDeltaUsd:0` on 34 consecutive boots.
    // Named in `leftAloneDates` rather than dropped, so a zero-net day stays
    // readable instead of silently vanishing from the plan.
    if (after === before) {
      leftAloneDates.push(s.date);
      continue;
    }
    deltas.push({ date: s.date, before, after, delta: round2(after - before), journalCloses: census.closes });
  }
  deltas.sort((a, b) => a.date.localeCompare(b.date));
  return {
    deltas,
    totalDeltaUsd: round2(deltas.reduce((sum, d) => sum + d.delta, 0)),
    examined: snapshots.length,
    leftAloneDates,
  };
}

/**
 * The exact sign/precision formatter `buildMarkdown` uses for the P&L table.
 * Shared so a patched report row is byte-identical to a generated one — if this
 * drifts from the generator the repaired markdown silently stops matching, so
 * the regression test asserts a patched report equals a generated one.
 */
export function pnlSign(n: number): string {
  return (n >= 0 ? '+' : '') + n.toFixed(2);
}

/**
 * Minimal shape of a persisted EOD report this module rewrites. Kept structural
 * rather than importing `EodReport` so the historical repair can read an old
 * on-disk file whose other fields have since changed shape.
 */
export interface PatchableEodReport {
  optionsPnl?: number;
  realizedPnl?: number;
  combinedPnl?: number;
  markdown?: string;
}

/**
 * Re-book a report's options leg from `value`, keeping the rendered markdown in
 * step with the JSON.
 *
 * This is used by BOTH paths — the 21:00 ET write and the historical repair — so
 * the file and the snapshot can never be sourced differently. That coupling is
 * the point: TRA-2302 found 2026-07-15 and 2026-07-21 where the report FILE
 * carried a combined figure equal to the journal total while the snapshot,
 * written 18 lines later in the same function, carried 0.00. Two writers, two
 * sources, one silent disagreement. Repairing only the snapshot would have been
 * worse than doing nothing: on the 6 admin days where the file ALSO booked 0,
 * moving the snapshot alone manufactures up to $217.50 of drift on a guard that
 * currently reads clean.
 *
 * `combinedPnl` is recomputed as `realizedPnl + optionsPnl`, exactly as
 * `generateEodReport` computes it (eod-report.ts:788).
 */
export function patchEodReportOptionsPnl<T extends PatchableEodReport>(
  report: T,
  value: number,
): T {
  const nextOptions = round2(value);
  const prevOptions = round2(report.optionsPnl ?? 0);
  if (nextOptions === prevOptions) return report;
  const realizedPnl = report.realizedPnl ?? 0;
  const nextCombined = round2(realizedPnl + nextOptions);
  const prevCombined = round2(report.combinedPnl ?? 0);

  let markdown = report.markdown;
  if (typeof markdown === 'string') {
    markdown = markdown.replace(
      `| Options P&L | ${pnlSign(prevOptions)} |`,
      `| Options P&L | ${pnlSign(nextOptions)} |`,
    );
    markdown = markdown.replace(
      `| **Combined P&L** | **${pnlSign(prevCombined)}** |`,
      `| **Combined P&L** | **${pnlSign(nextCombined)}** |`,
    );
  }

  return { ...report, optionsPnl: nextOptions, combinedPnl: nextCombined, ...(markdown != null ? { markdown } : {}) };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
