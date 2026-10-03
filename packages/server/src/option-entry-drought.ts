// TRA-5035 — an entry drought must ALARM, not be discoverable.
//
// TRA-5014: the desk paper option book produced ZERO entries for 7 consecutive
// ET sessions (2026-09-23..2026-10-01) and nothing on any surface said so. The
// census fix (`liveArmCensus.booksScannedButNotPublished[]`, TRA-5014 §1) names
// a scanned-and-dropped book, but it is a POINTER — a reader still has to go
// look, on a surface they have no reason to visit, on a day they have no reason
// to suspect. This block is the detector QuantTrader asked for: per-sleeve,
// per-account-class `lastEntryEtDay` + `consecutiveSessionsWithoutEntry`, on the
// journal's own health route, where the data already lives.
//
// Placement: the journal route already holds every row in memory. Computing this
// in `summarizeLiveArmCensus` would need either a new journal dependency from
// the live-arm path or a duplicated fold — so it lives here, a one-pass
// derivation over rows the route already serves. ADVISORY ONLY: it gates
// nothing, blocks nothing, and changes no entry decision.

import { etDateKey } from './et-clock.js';
import { isMarketDayIso } from './scheduler.js';
import {
  classifySpreadCeilingAccount,
  SPREAD_CEILING_ACCOUNT_CLASSES,
  type SpreadCeilingAccountClass,
} from './option-spread-cost.js';
import { OPTION_SLEEVE_AXIS_FLOOR } from './option-journal-sleeve-cells.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

/** The counting rule, on the wire, so a reader never re-derives it wrong. */
export const ENTRY_DROUGHT_SESSIONS_COUNTED =
  'market days strictly between lastEntryEtDay and asOfEtDay, inclusive of asOfEtDay';

/** One `accountClass × structure` drought cell. */
export interface OptionEntryDroughtCell {
  accountClass: SpreadCeilingAccountClass;
  structure: string;
  /** Stable display key `accountClass|structure`. Derived, never parsed back. */
  cell: string;
  /**
   * ET session day of the cell's most recent ENTRY (`openTs`, entry axis — not
   * `closeEtDay`). `null` iff the cell has never entered.
   */
  lastEntryEtDay: string | null;
  /**
   * Market sessions (NYSE calendar, `isMarketDayIso`) strictly after
   * `lastEntryEtDay` up to and INCLUDING `asOfEtDay`. 0 means the cell entered
   * on `asOfEtDay` itself (or later). `null` iff `everEntered` is false — a
   * never-entered cell has no drought LENGTH, and publishing `0` there is the
   * absent-reads-clean shape this whole block exists to kill (TRA-5035 req 2).
   */
  consecutiveSessionsWithoutEntry: number | null;
  /** The counting rule verbatim — {@link ENTRY_DROUGHT_SESSIONS_COUNTED}. */
  sessionsCounted: string;
  everEntered: boolean;
  /** Lifetime entries observed in the cell (open + closed rows). */
  entriesTotal: number;
}

/** The `entryDrought` block on `GET /api/health/option-journal`. */
export interface OptionEntryDroughtBlock {
  /** ET session day the droughts are measured AS OF (derived from `now`). */
  asOfEtDay: string;
  /** Whether `asOfEtDay` is itself a market session. A weekend read is valid; it simply adds no session. */
  asOfIsMarketDay: boolean;
  cells: OptionEntryDroughtCell[];
  /**
   * Rows whose `openTs` could not be dated (absent / non-finite). Published,
   * never silently dropped: such a row still counts toward nothing, and a
   * non-zero here says the drought may OVERSTATE itself for some cell.
   */
  undatedRows: number;
  calendar: 'isMarketDayIso';
  note: string;
}

/** Iterate ISO days starting the day AFTER `fromIso`. Bounded. */
function* isoDaysAfter(fromIso: string, maxDays: number): Generator<string> {
  const [y, m, d] = fromIso.split('-').map(Number);
  let t = Date.UTC(y!, m! - 1, d!);
  for (let i = 0; i < maxDays; i++) {
    t += 86_400_000;
    yield new Date(t).toISOString().slice(0, 10);
  }
}

/**
 * Market sessions strictly after `lastEntryEtDay`, up to and including
 * `asOfEtDay` — {@link ENTRY_DROUGHT_SESSIONS_COUNTED}, as code.
 *
 * TRA-5035 req 1: SESSIONS, not calendar days, on the same `isMarketDayIso`
 * predicate the close ledger and the exploration box already grade with. A
 * weekend-inclusive count would have read 9 on the day the real answer was 7.
 */
export function entryDroughtSessions(lastEntryEtDay: string, asOfEtDay: string): number {
  if (asOfEtDay <= lastEntryEtDay) return 0;
  let n = 0;
  for (const day of isoDaysAfter(lastEntryEtDay, 4000)) {
    if (day > asOfEtDay) break;
    if (isMarketDayIso(day)) n += 1;
  }
  return n;
}

/**
 * TRA-5035 — fold journal rows into per-`accountClass × structure` entry-drought
 * cells. Pure, and a function of (rows, now) ONLY:
 *
 *  - NO `sinceBoot` input anywhere (req 4). The journal is durable and survives
 *    a restart; a boot-after-close process publishes the same drought the
 *    pre-restart one would have.
 *  - The caller must pass the FULL journal, never a cohort-windowed subset — a
 *    `?sinceEtDay` window must not manufacture a drought, and an entry-axis
 *    window must not hide one.
 *  - The cell roster is the UNION of what the rows contain and the canonical
 *    axis floor (req 3): a sleeve that stops entering for long enough to fall
 *    out of the retained rows must still appear, or the detector deletes
 *    exactly the cell it exists to watch. Floor structures are emitted for ALL
 *    account classes, so `fixture` QA rows can never stand in for a dark `desk`
 *    cell (req 5 — the TRA-5014 window carried fixture `bull_put` rows that,
 *    pooled, would have made the desk sleeve look recovered).
 */
export function foldOptionEntryDrought(
  rows: readonly OptionTradeJournalRecord[],
  now: number,
): OptionEntryDroughtBlock {
  const asOfEtDay = etDateKey(now);

  const cellKey = (klass: string, structure: string) => `${klass}|${structure}`;
  const roster = new Map<string, { accountClass: SpreadCeilingAccountClass; structure: string }>();
  // Floor first (stable order): every class × every floor structure.
  const floorStructures = [...new Set(OPTION_SLEEVE_AXIS_FLOOR.map((p) => p.structure))];
  for (const klass of SPREAD_CEILING_ACCOUNT_CLASSES) {
    for (const structure of floorStructures) {
      roster.set(cellKey(klass, structure), { accountClass: klass, structure });
    }
  }

  // One pass: roster union + per-cell last entry day and entry count.
  const lastEntry = new Map<string, string>();
  const entries = new Map<string, number>();
  let undatedRows = 0;
  for (const r of rows) {
    const klass = classifySpreadCeilingAccount(r.account);
    const key = cellKey(klass, r.structure);
    if (!roster.has(key)) roster.set(key, { accountClass: klass, structure: r.structure });
    if (typeof r.openTs !== 'number' || !Number.isFinite(r.openTs)) {
      undatedRows += 1;
      continue;
    }
    const day = etDateKey(r.openTs);
    entries.set(key, (entries.get(key) ?? 0) + 1);
    const prior = lastEntry.get(key);
    if (prior === undefined || day > prior) lastEntry.set(key, day);
  }

  const cells: OptionEntryDroughtCell[] = [...roster.entries()].map(([key, { accountClass, structure }]) => {
    const last = lastEntry.get(key) ?? null;
    return {
      accountClass,
      structure,
      cell: key,
      lastEntryEtDay: last,
      consecutiveSessionsWithoutEntry: last === null ? null : entryDroughtSessions(last, asOfEtDay),
      sessionsCounted: ENTRY_DROUGHT_SESSIONS_COUNTED,
      everEntered: last !== null,
      entriesTotal: entries.get(key) ?? 0,
    };
  });
  // Longest drought first inside each class, so the alarm reads top-down; a
  // never-entered cell (null) sorts after every measured drought — it is a
  // different question ("was this sleeve ever armed here"), not a longer one.
  cells.sort(
    (a, b) =>
      SPREAD_CEILING_ACCOUNT_CLASSES.indexOf(a.accountClass)
        - SPREAD_CEILING_ACCOUNT_CLASSES.indexOf(b.accountClass)
      || (b.consecutiveSessionsWithoutEntry ?? -1) - (a.consecutiveSessionsWithoutEntry ?? -1)
      || a.cell.localeCompare(b.cell),
  );

  return {
    asOfEtDay,
    asOfIsMarketDay: isMarketDayIso(asOfEtDay),
    cells,
    undatedRows,
    calendar: 'isMarketDayIso',
    note:
      'TRA-5035 (off TRA-5014). Per accountClass x structure ENTRY drought, folded from the FULL '
      + 'journal regardless of any cohort window on this request — a window must not manufacture '
      + 'or hide a drought. Entry day is the ET session day of openTs (entry axis, not closeEtDay). '
      + 'consecutiveSessionsWithoutEntry counts MARKET SESSIONS (isMarketDayIso: weekends + the '
      + 'NYSE holiday table), strictly after lastEntryEtDay through asOfEtDay inclusive — the '
      + 'TRA-5014 drought reads 7, not the calendar 9. A never-entered cell publishes null/null, '
      + 'NEVER 0: a zero there is the absent-reads-clean shape this block exists to kill. Cells '
      + 'are the union of observed rows and the canonical sleeve-axis floor, emitted for all '
      + 'three account classes, so a sleeve that falls out of the retained rows still appears '
      + 'and fixture QA entries can never shorten a desk drought. ADVISORY ONLY: read-only '
      + 'derivation; gates nothing, blocks nothing, changes no entry decision.',
  };
}
