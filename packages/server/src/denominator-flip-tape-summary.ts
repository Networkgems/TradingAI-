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
 *
 * ## TRA-3494 — the bar UNIT is a market DAY, not a book-day
 *
 * As first shipped, `sessionsTowardBar` was `sessions.filter(countsTowardBar)`,
 * and `sessions` is one entry per BOOK per DAY. With 66 books in the fleet, the
 * very first clean night read **64 / 10** and cleared a ">= 10 RTH sessions" bar
 * permanently — on ONE calendar day of evidence, 61 of those 64 sessions demo.
 * That is not an over-strict reading of the bar, it is the opposite: a pooled
 * count measures FLEET WIDTH, and once past 10 it can never fall back even if
 * every subsequent session regresses to the original TRA-3116 failure.
 *
 * Ruled (CTO, 2026-08-13): the unit is a **distinct ET market day**, and the
 * deciding cohort for a day is the **live-money books only** (`mode === 'live'`,
 * i.e. Tradier `production`). `sandbox` and `demo` are excluded from the
 * decision — the promotion is about whether the LIVE tape survives restarts, and
 * 61 diluting demo sessions are exactly the signal-killer. The rejected
 * alternatives, and why:
 *
 *   - `>= 1 clean book that day` — one clean demo book banks a day on which the
 *     live tape failed outright. Published as `barDaysAnyBook`, never deciding.
 *   - `every book clean that day` — hostage to any idle demo book. It already
 *     FAILED on night one (64/66; two demo books stamped `observedMs: 0`), so it
 *     makes the bar unreachable by a veto from outside the measured cohort.
 *     Published as `barDaysAllBooks`, never deciding.
 *
 * Three consequences are load-bearing and must not be "simplified" away:
 *
 *   1. **A day with no live observation is `vacuous`, its own third state.** It
 *      is neither counted nor failed. Folding it into either direction is the
 *      bug: counted mints a free credit off an empty cohort (`every` is true on
 *      the empty set), failed makes the bar unreachable the first weekend the
 *      live book is idle. `vacuousReason` is always populated when it fires.
 *   2. **Only market days can bank a session.** A weekend/holiday tape file is
 *      after-hours residue; letting it count would fill a trading-session bar
 *      with non-trading days.
 *   3. **An absent live tape does not silently skip.** A live book with a tape
 *      directory and no file for a market day is published per-day as
 *      `liveAbsent` / `liveAbsentBooks`. It does not auto-fail the day (that
 *      would let a decommissioned book veto the bar forever), so the promotion
 *      decision — not this instrument — absorbs it: per the ruling, a 10-day
 *      window containing any `liveAbsent > 0` day is not promotable until that
 *      absence is separately explained.
 *
 * The old pooled number is NOT deleted — it is still published, as
 * `completeBookSessions` (and as `complete`). Only the name that gates the
 * promotion moved.
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

/**
 * The real-money cohort. `stockModeKey` yields `live` ONLY for
 * `mode: 'live' && liveTradierEnvOptions === 'production'`; a live account
 * pointed at Tradier's sandbox is stamped `sandbox` and is deliberately not in
 * here. Demo is paper.
 */
const LIVE_MODES = new Set(['live']);

/**
 * The vocabulary `stockModeKey` can emit. This exists ONLY so that a mode string
 * from some future writer cannot fall out of `LIVE_MODES` silently and turn every
 * day `vacuous` while the header still looks orderly — an unrecognised mode is
 * published as `unclassifiedModes` rather than being quietly graded as not-live.
 */
const KNOWN_MODES = new Set(['live', 'demo', 'sandbox']);

/**
 * TRI-STATE, and `vacuous` is NOT a soft `failed` nor a soft `counted`.
 * `vacuous` = the deciding cohort was empty that day, so the day says nothing
 * about the fix in either direction.
 */
export type TapeBarDayState = 'counted' | 'failed' | 'vacuous';

/** One ET market day, graded as the TRA-3494 ruling defines the bar's unit. */
export interface TapeBarDay {
  date: string;
  /** The DECIDING grade: the live-money cohort only. */
  live: TapeBarDayState;
  /** Always set when `live === 'vacuous'`; never set otherwise. */
  vacuousReason?: string;
  /** Live books whose tape shows the process actually observed something. */
  liveObserved: number;
  /** ...and how many of those cleared the per-session bar. */
  liveClean: number;
  /** Live tape files present but showing no observation at all (idle book). */
  liveIdle: number;
  /** Live books with a tape directory and NO file for this market day. */
  liveAbsent: number;
  liveFailingBooks: string[];
  liveAbsentBooks: string[];
  /** NON-DECIDING (rejected quorum B1), published so the ruling can be audited. */
  anyBookClean: boolean;
  /** NON-DECIDING (rejected quorum B2). False on an empty day, never vacuously true. */
  allBooksClean: boolean;
  /** Book-day sessions on this date, and how many were clean. */
  bookSessions: number;
  bookSessionsClean: number;
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
  /**
   * TRA-3494 — progress toward the >=10 bar, in the RULED unit: distinct ET
   * market days whose live-money cohort was non-empty and wholly clean.
   *
   * ⚠ This is NOT `complete`. It used to be, and that is the defect TRA-3494
   * ruled on: `complete` is a pooled BOOK-DAY count across a 66-book fleet, so
   * it read 64/10 on night one. The pooled number still ships, as
   * `completeBookSessions`.
   */
  sessionsTowardBar: number;
  barTarget: number;
  /** Names the unit in the payload so a reader cannot re-derive the wrong one. */
  barUnit: 'distinct-et-market-days:live-money-cohort';
  /** The pre-TRA-3494 number, retained and renamed rather than deleted. */
  completeBookSessions: number;
  /** The per-day ledger the bar is counted off. */
  barDays: TapeBarDay[];
  /** Days whose live cohort was empty. Never folded into counted or failed. */
  barDaysVacuous: number;
  /** Days on which an observed live book missed the per-session bar. */
  barDaysFailed: number;
  /** Days with >=1 live book absent. Published; gates promotion, not the count. */
  barDaysWithLiveAbsence: number;
  /** REJECTED quorum B1, published alongside so the ruling stays auditable. */
  barDaysAnyBook: number;
  /** REJECTED quorum B2, likewise. */
  barDaysAllBooks: number;
  /** Mode strings this grader does not recognise. Non-empty is a BUG, not a state. */
  unclassifiedModes: string[];
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
 * Did this live book's process actually observe anything that day?
 *
 * The point of the question is to separate an IDLE book (nothing to say about
 * the fix — the day goes `vacuous`) from a book that ran and produced a bad tape
 * (a real FAIL). Three signals answer it, OR'd, because a regression of the
 * TRA-3116 fix attacks them one at a time: `observedMs` comes from the coverage
 * stamp, `rows` survives independently of it, and `segmentCount` is non-zero for
 * any process that flushed at all.
 *
 * An UNREADABLE tape returns true on purpose. It is evidence of a problem, so it
 * must be able to fail a day; treating it as "no observation" would let a corrupt
 * write buy a free pass by looking like an idle book.
 */
function liveSessionObserved(s: TapeSessionSummary): boolean {
  if (s.unreadable !== undefined) return true;
  return (s.observedMs ?? 0) > 0 || s.rows > 0 || (s.segmentCount ?? 0) > 0;
}

/**
 * The TRA-3494 unit: fold book-day sessions into one row per ET MARKET day and
 * grade each day on the live-money cohort. See the ruling in this file's header
 * for why the cohort is live-only and why `vacuous` is a first-class state.
 */
export function computeBarDays(
  sessions: readonly TapeSessionSummary[],
  absentSessions: readonly string[] = [],
): TapeBarDay[] {
  const byDate = new Map<string, TapeSessionSummary[]>();
  for (const s of sessions) {
    // Consequence 2: only a trading day can bank a trading session. A weekend or
    // holiday file is after-hours residue.
    if (!isMarketDayIso(s.date)) continue;
    const list = byDate.get(s.date);
    if (list) list.push(s);
    else byDate.set(s.date, [s]);
  }

  // Consequence 3: a live book that is absent for a market day is PUBLISHED, not
  // skipped into silence.
  const absentByDate = new Map<string, string[]>();
  for (const entry of absentSessions) {
    const at = entry.lastIndexOf('@');
    if (at < 0) continue;
    const key = entry.slice(0, at);
    const date = entry.slice(at + 1);
    if (!isMarketDayIso(date)) continue;
    if (!LIVE_MODES.has(key.slice(key.lastIndexOf('/') + 1))) continue;
    const list = absentByDate.get(date);
    if (list) list.push(key);
    else absentByDate.set(date, [key]);
  }

  const dates = [...new Set([...byDate.keys(), ...absentByDate.keys()])].sort();
  return dates.map(date => {
    const daySessions = byDate.get(date) ?? [];
    const liveSessions = daySessions.filter(s => LIVE_MODES.has(s.mode));
    const observed = liveSessions.filter(liveSessionObserved);
    const clean = observed.filter(s => s.countsTowardBar);
    const liveAbsentBooks = absentByDate.get(date) ?? [];

    let live: TapeBarDayState;
    let vacuousReason: string | undefined;
    if (observed.length === 0) {
      // Consequence 1. NOT counted (an empty cohort must never mint a credit)
      // and NOT failed (an idle live book must never veto the bar).
      live = 'vacuous';
      vacuousReason =
        liveSessions.length > 0
          ? 'every live-money tape for this market day shows no observation at all (idle book)'
          : liveAbsentBooks.length > 0
            ? 'no live-money tape file was written for this market day'
            : 'no live-money book was present in the fleet for this market day';
    } else {
      live = clean.length === observed.length ? 'counted' : 'failed';
    }

    return {
      date,
      live,
      ...(vacuousReason ? { vacuousReason } : {}),
      liveObserved: observed.length,
      liveClean: clean.length,
      liveIdle: liveSessions.length - observed.length,
      liveAbsent: liveAbsentBooks.length,
      liveFailingBooks: observed
        .filter(s => !s.countsTowardBar)
        .map(s => `${s.username}/${s.mode}`),
      liveAbsentBooks,
      anyBookClean: daySessions.some(s => s.countsTowardBar),
      // `every` is TRUE on the empty array, which would report a day with no
      // sessions at all as "all books clean". The length guard is the point.
      allBooksClean: daySessions.length > 0 && daySessions.every(s => s.countsTowardBar),
      bookSessions: daySessions.length,
      bookSessionsClean: daySessions.filter(s => s.countsTowardBar).length,
    };
  });
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

  // TRA-3494 — the bar is counted off DAYS, not book-days. `complete` above is
  // the pooled book-day number that read 64/10 on night one; it stays in the
  // payload as `completeBookSessions`, it just no longer gates anything.
  const barDays = computeBarDays(sessions, absentSessions);
  const unclassifiedModes = [...new Set(books.map(b => b.mode).filter(m => !KNOWN_MODES.has(m)))].sort();

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
    sessionsTowardBar: barDays.filter(d => d.live === 'counted').length,
    barTarget,
    barUnit: 'distinct-et-market-days:live-money-cohort',
    completeBookSessions: complete,
    barDays,
    barDaysVacuous: barDays.filter(d => d.live === 'vacuous').length,
    barDaysFailed: barDays.filter(d => d.live === 'failed').length,
    barDaysWithLiveAbsence: barDays.filter(d => d.liveAbsent > 0).length,
    barDaysAnyBook: barDays.filter(d => d.anyBookClean).length,
    barDaysAllBooks: barDays.filter(d => d.allBooksClean).length,
    unclassifiedModes,
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
