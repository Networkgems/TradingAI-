/**
 * TRA-3116 — the READ side of the denominator-flip tape.
 *
 * ## Why this exists, when the ruling only asked for parts 1-3
 *
 * The CTO's part 5 binds the >=10-RTH-session promotion bar to fields that live
 * ONLY inside `tape/<date>.json`: a session counts iff `coverageComplete` and
 * `!saturated` and `truncatedForSize === 0` and `droppedOnMerge === 0`, and each
 * session must be BANKED as a comment when it lands, because 30-file retention
 * will otherwise prune the evidence out from under a bar that takes longer than
 * 30 files to fill.
 *
 * There was no way to read any of that. The box exposes 43 `/api/health/*`
 * routes and not one of them touches the tape directory, and there is no generic
 * file read. So parts 1-3 as ruled would have produced a correct artifact that
 * nobody could grade — which is the SAME defect class TRA-3116 was raised on
 * ("as built the bar can never be reached"), just moved one step downstream.
 * Shipping the fix without this would have re-created the ticket.
 *
 * ## This does not widen the boundary
 *
 * > The feed never writes to disk. Nothing in the trading path ever reads the
 * > tape.
 *
 * Both hold. This is an observability read on the health surface, exactly like
 * `/api/health/eod-archive-participation`: no engine, signal, order or archive
 * path calls it, and its output feeds no decision inside the process. Reading it
 * changes nothing.
 *
 * ## The triple is published, never a bare count
 *
 * Per part 5, partial sessions are RETAINED AND ANNOTATED, never deleted and
 * never excluded, and every report publishes **complete / partial / absent**.
 * A bar reporting "8 of 10 clean" over a silently shrunken denominator is the
 * exact failure this ticket exists to close, so `countsTowardBar` is reported
 * beside the reason it is false, and absent market days are counted against a
 * real NYSE calendar rather than being left out of the denominator.
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { isMarketDayIso } from './scheduler.js';
import { DENOM_FLIP_TAPE_DIR } from './denominator-flip-tape-writer.js';
import type { DenominatorFlipTapeFile } from './denominator-flip-tape-writer.js';

/** Same form the writer prunes on: the plain tape plus its orphans. */
const TAPE_FILE_RE = /^(\d{4}-\d{2}-\d{2})(\.orphan\d+)?\.json$/;

/** One session's grade against the pre-registered bar. */
export interface TapeSessionSummary {
  username: string;
  mode: string;
  date: string;
  generatedAt: string | null;
  rows: number;
  admitted: number | null;
  droppedCandidates: number | null;
  truncatedForSize: number | null;
  droppedOnMerge: number | null;
  saturated: boolean | null;
  segmentCount: number | null;
  restartBoundaries: number | null;
  coverageComplete: boolean | null;
  observedMs: number | null;
  uncoveredMs: number | null;
  /** Tri-state, never a positive integer. `null` means unknown-and-unknowable. */
  rowsLostToRestart: number | null;
  mergeDegraded: boolean;
  /** The part-5 rule, evaluated. */
  countsTowardBar: boolean;
  /** Why not, when it does not. Empty when it does. */
  disqualifiers: string[];
  /** Set when the file is present but could not be read as a tape. */
  unreadable?: string;
}

export interface TapeBookInput {
  username: string;
  mode: string;
  targetDir: string;
}

export interface TapeSummary {
  /**
   * TRI-STATE, and `null` is BLIND rather than clean. A fleet with no tape file
   * anywhere and a fleet whose every session is complete must not read the same,
   * which is the whole lesson of the `droppedCandidates: 0` on the 08-05 file.
   */
  verdict: 'complete' | 'partial' | null;
  blindReason?: string;
  /** The part-5 triple. Never report `complete` without these two beside it. */
  complete: number;
  partial: number;
  /** Market days in range with no tape file for that book at all. */
  absent: number;
  /** Complete sessions, i.e. progress toward the >=10 bar. */
  sessionsTowardBar: number;
  barTarget: number;
  firstDate: string | null;
  lastDate: string | null;
  books: number;
  sessions: TapeSessionSummary[];
  /** Market days with no file, as `<username>/<mode>@<date>`. */
  absentSessions: string[];
}

/** The pre-registered bar from the CTO's part 5, evaluated on one file. */
export function gradeTapeSession(file: Partial<DenominatorFlipTapeFile>): {
  countsTowardBar: boolean;
  disqualifiers: string[];
} {
  const bad: string[] = [];
  // Tri-state discipline: an ABSENT field is not a passing one. A file written
  // by the pre-TRA-3116 writer carries none of these, and must not be graded
  // clean by virtue of the fields being missing.
  if (file.coverageComplete !== true) {
    bad.push(file.coverageComplete === undefined ? 'coverageComplete:absent' : 'coverageComplete:false');
  }
  if (file.saturated !== false) bad.push('saturated');
  if (file.truncatedForSize !== 0) bad.push('truncatedForSize');
  if (file.droppedOnMerge !== 0) {
    bad.push(file.droppedOnMerge === undefined ? 'droppedOnMerge:absent' : 'droppedOnMerge');
  }
  if (file.mergeDegraded === true) bad.push('mergeDegraded');
  return { countsTowardBar: bad.length === 0, disqualifiers: bad };
}

/**
 * Read every book's tape directory and grade what is there.
 *
 * NEVER THROWS. An unreadable book yields no sessions rather than an error, and
 * an unreadable FILE is reported as a session with `unreadable` set — an
 * unparseable tape is evidence of a problem, not an absence of one, so it must
 * not silently drop out of the denominator.
 */
export async function summarizeDenominatorFlipTape(
  books: readonly TapeBookInput[],
  opts: { todayEt: string; barTarget?: number } = { todayEt: '' },
): Promise<TapeSummary> {
  const barTarget = opts.barTarget ?? 10;
  const sessions: TapeSessionSummary[] = [];
  const seen = new Map<string, Set<string>>();

  for (const book of books) {
    const dir = join(book.targetDir, DENOM_FLIP_TAPE_DIR);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      // No tape directory yet: nothing observed, and nothing claimed.
      continue;
    }
    const key = `${book.username}/${book.mode}`;
    const dates = seen.get(key) ?? new Set<string>();
    seen.set(key, dates);
    for (const name of names.sort()) {
      const m = TAPE_FILE_RE.exec(name);
      if (!m) continue;
      // Orphans are retained evidence of a degraded merge, but they are not a
      // session — the session is the file that replaced them.
      if (m[2]) continue;
      const date = m[1];
      dates.add(date);
      let parsed: Partial<DenominatorFlipTapeFile>;
      try {
        parsed = JSON.parse(await readFile(join(dir, name), 'utf-8')) as Partial<DenominatorFlipTapeFile>;
      } catch (err: unknown) {
        sessions.push({
          username: book.username, mode: book.mode, date,
          generatedAt: null, rows: 0, admitted: null, droppedCandidates: null,
          truncatedForSize: null, droppedOnMerge: null, saturated: null,
          segmentCount: null, restartBoundaries: null, coverageComplete: null,
          observedMs: null, uncoveredMs: null, rowsLostToRestart: null,
          mergeDegraded: false, countsTowardBar: false,
          disqualifiers: ['unreadable'],
          unreadable: err instanceof Error ? err.message : String(err),
        });
        continue;
      }
      const graded = gradeTapeSession(parsed);
      const cov = parsed.coverage;
      sessions.push({
        username: book.username,
        mode: book.mode,
        date,
        generatedAt: parsed.generatedAt ?? null,
        rows: Array.isArray(parsed.rows) ? parsed.rows.length : 0,
        admitted: parsed.admitted ?? null,
        droppedCandidates: parsed.droppedCandidates ?? null,
        truncatedForSize: parsed.truncatedForSize ?? null,
        droppedOnMerge: parsed.droppedOnMerge ?? null,
        saturated: parsed.saturated ?? null,
        segmentCount: parsed.segmentCount ?? null,
        restartBoundaries: parsed.restartBoundaries ?? null,
        coverageComplete: parsed.coverageComplete ?? null,
        observedMs: cov?.observedMs ?? null,
        uncoveredMs: cov?.uncoveredMs ?? null,
        rowsLostToRestart: cov?.rowsLostToRestart ?? null,
        mergeDegraded: parsed.mergeDegraded === true,
        ...graded,
      });
    }
  }

  sessions.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  const dated = sessions.map(s => s.date);
  const firstDate = dated.length > 0 ? dated[0] : null;
  const lastDate = dated.length > 0 ? dated[dated.length - 1] : null;

  // Absent = a MARKET day inside the observed range for which a book that has a
  // tape directory produced no file. Counted against a real NYSE calendar, not
  // weekdays, so holidays do not inflate the gap and make the record look worse
  // than it is — an inflated absence is still a false reading.
  const absentSessions: string[] = [];
  if (firstDate) {
    const end = opts.todayEt && opts.todayEt > (lastDate ?? '') ? opts.todayEt : (lastDate ?? firstDate);
    for (const [key, dates] of seen) {
      for (const day of marketDaysBetween(firstDate, end)) {
        if (!dates.has(day)) absentSessions.push(`${key}@${day}`);
      }
    }
  }

  const complete = sessions.filter(s => s.countsTowardBar).length;
  const partial = sessions.length - complete;
  return {
    // `null` when nothing has been observed at all. A blind read is not a clean
    // one; the caller must not be able to mistake "no tape yet" for "all good".
    verdict: sessions.length === 0 ? null : partial === 0 && absentSessions.length === 0 ? 'complete' : 'partial',
    ...(sessions.length === 0
      ? { blindReason: 'no tape file has been written yet — this is NOT a clean bill of health' }
      : {}),
    complete,
    partial,
    absent: absentSessions.length,
    sessionsTowardBar: complete,
    barTarget,
    firstDate,
    lastDate,
    books: seen.size,
    sessions,
    absentSessions,
  };
}

/** Inclusive NYSE session dates between two `YYYY-MM-DD` keys. */
function marketDaysBetween(fromIso: string, toIso: string): string[] {
  const out: string[] = [];
  const from = Date.parse(`${fromIso}T00:00:00Z`);
  const to = Date.parse(`${toIso}T00:00:00Z`);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return out;
  // Bounded so a corrupt date key cannot spin: 400 days is well past the
  // 30-file retention this can ever legitimately span.
  for (let t = from, guard = 0; t <= to && guard < 400; t += 86_400_000, guard += 1) {
    const day = new Date(t).toISOString().slice(0, 10);
    if (isMarketDayIso(day)) out.push(day);
  }
  return out;
}
