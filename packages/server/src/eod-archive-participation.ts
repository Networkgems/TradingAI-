// TRA-2930 (from the TRA-2928 ruling, D1) — DURABLE per-book EOD archive-participation
// record.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// TRA-2903 established that the `enock` book has ZERO EOD ledger rows for 28
// consecutive NYSE sessions (2026-06-15..07-24), that the rows were never captured,
// and that the archive fired and wrote fine for every OTHER book on every one of
// those nights. A per-book skip. The cause is UNMEASURED, because two candidates
// produce a byte-identical signature and both are swallowed:
//
//   (a) a per-user `initUserContext` throw caught in `initAllUserContexts`, logged
//       only as `log.warn('failed to init user context')`. The book is then missing
//       from `getAllUserContexts()` for the LIFE OF THE PROCESS, so the 21:00 ET
//       archive loop never iterates it at all — it self-repairs silently on the next
//       authenticated request via `ensureUserContext`;
//   (b) `generateAndSaveReport` throwing per-book INSIDE the archive loop, logged as
//       `log.error('EOD report failed')`, loop continues.
//
// Neither leaves a durable artifact, and Render log retention does not reach
// 2026-06-15. Six weeks later the only evidence is an absence, and an absence cannot
// tell (a) from (b).
//
// `enock` is `mode: demo`, so no live capital was touched. But NOTHING in either
// candidate is book-specific. On a live book the same silence applies, and TRA-2903
// only surfaced at all because the TRA-2888 interior detector existed — and even that
// showed 10 of the 28.
//
// ── WHAT DISCRIMINATES (a) FROM (b) ──────────────────────────────────────────
// The roster is enumerated from `getAllUsers()` (users.json), which is INDEPENDENT of
// the context map. That independence is the whole mechanism:
//
//   • roster ∩ context map, report returned      -> `participated`
//   • roster ∩ context map, report threw         -> `report_threw`   (candidate b)
//   • roster MINUS context map                   -> `absent_from_context_map` (candidate a)
//
// A ledger seeded from `getAllUserContexts()` would be structurally incapable of
// seeing candidate (a) — the absent book is not in the collection being iterated, so
// it writes no row and reads as "nothing happened," which is exactly the ambiguity
// this module exists to remove. Do not "simplify" the roster source to the context
// map. (Same class of defect as a fallback seeded from a co-failed ledger.)
//
// ── THE THIRD READING: DID THE RUN HAPPEN AT ALL ─────────────────────────────
// Per-book rows alone still confuse "the archive hook never fired" with "the hook
// fired and this book was absent" — both are zero rows for the book. So each archive
// pass ALSO writes one `kind:'run'` row (roster size, context-map size, market-day
// flag) BEFORE the per-book loop. No run row for a session => the hook itself did not
// fire, which is a different defect with a different owner.
//
// ── ORDERING (why absent rows are written up front) ──────────────────────────
// `openEodArchiveParticipationRun` writes the run row AND every
// `absent_from_context_map` row immediately, before the caller's loop starts. The
// absent set is fully known at that point (roster minus context map), and writing it
// first means a process death mid-loop still leaves candidate (a) on disk. Only the
// in-context outcomes have to wait for the loop.
//
// ── DURABILITY (TRA-1681 / TRA-1719 / TRA-2817) ──────────────────────────────
// Constraint 1 of the ruling: it must survive process restart and deploy. An
// in-memory counter is not a record — deploys eat those, and that lesson is already
// paid for. So: JSONL APPENDED under DATA_DIR, hydrated on boot.
//
// Two deliberate choices in that sentence:
//   • APPEND to ONE stable file, never a file-per-day. The 2026-07-30..08-04 outage
//     was INODE exhaustion with free bytes (TRA-2817): appends survived while file
//     CREATES failed. A per-day partition scheme would have failed silently during
//     the exact incident this record is meant to witness.
//   • `durability.ephemeral` is published and MUST be read first. "A persisted file
//     survives a reboot" is only true if DATA_DIR points at a mounted disk; with
//     DATA_DIR unset the fallback path lives inside the build bundle and evaporates
//     on redeploy with NO error to catch.
//
// ── THE DENOMINATOR MUST NOT COME FROM THE THING BEING MEASURED (TRA-3284) ───
// TRA-3267 broke `isMarketDay()` (UTC weekday at the 21:00 ET archive): Friday
// 2026-08-07 was recorded `marketDay:false` (a full session lost fleet-wide) and
// Sunday 2026-08-09 `marketDay:true` (a phantom session, 63/63 "participated"). This
// record graded that incident CLEAN, because it took the archive's own self-reported
// `marketDay` as its denominator: the lost Friday was EXCLUDED as
// `skipped_not_market_day` and the phantom Sunday was INCLUDED and passed. A wrong
// `marketDay` can only ever make this monitor greener, never redder — the
// self-confirming health-gate class (TRA-2671).
//
// So `summarizeEodArchiveParticipation` re-derives every run day's session status from
// `isMarketDayIso(etDay)` AT READ TIME — a second opinion independent of what the
// archive recorded. A disagreement is an ANOMALY, never an exclusion:
//   calendar says session, run recorded `marketDay:false` -> LOST SESSION
//   calendar says no session, run recorded `marketDay:true` -> PHANTOM SESSION
// Either forces `verdict` away from `'clean'`. Because the check runs at read time
// over the retained rows, the verdict is automatically backfilled over the whole
// window (the GRADE is corrected, never the rows — ENABLE_EOD_ROW_BACKFILL stays
// false, per the TRA-2888/TRA-2886 refusals). `calendarSessionRuns` is published next
// to `marketDayRuns` so the two denominators are visible side by side.
//
// ── SCOPE / INVARIANT ────────────────────────────────────────────────────────
// Pure observation. This module NEVER places an order, mutates an account, retries a
// report, or changes what the archive does. Every write is best-effort and swallowed:
// an IO failure here must not be able to break the archive it is watching (it is
// COUNTED in `durability.appendErrors` instead, so a silently-failing recorder cannot
// itself read as "clean"). No balances, no PII — username, ET day, outcome, and the
// error message the archive already logged.

import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { isEphemeralDataDir } from './data-dir.js';
import { logger } from './observability/index.js';
import { isMarketDayIso } from './scheduler.js'; // TRA-3284: the independent second opinion

const log = logger.child({ module: 'eod-archive-participation' });

export const EOD_ARCHIVE_PARTICIPATION_FILENAME = 'eod-archive-participation.jsonl';

/**
 * Retain this many ms of records on disk (compacted on boot). The gap this module
 * was built for ran 28 NYSE sessions / ~6 weeks before anyone could see it, and it
 * was only visible in hindsight; 120 days keeps a full multi-week pattern readable
 * well after the fact while bounding the file at roughly (books + 1) lines per day.
 */
const RETAIN_MS = 120 * 24 * 60 * 60 * 1000;

/**
 * Per-book outcome of one 21:00 ET archive pass.
 *
 * - `participated` — the book was in the context map AND `generateAndSaveReport`
 *   returned without throwing. The EOD row was written.
 * - `absent_from_context_map` — the book is in the roster (users.json) but was NOT in
 *   `getAllUserContexts()`, so the archive loop never reached it. **Candidate (a).**
 *   Almost always a boot-time `initUserContext` throw earlier in the process's life.
 * - `report_threw` — in the context map, `generateAndSaveReport` threw.
 *   **Candidate (b).** `reason` carries the message.
 * - `archive_threw` — the per-book archive body threw BEFORE the report outcome was
 *   determined (e.g. resolving the context's trackers). Distinct from `report_threw`
 *   because the report was never reached. A throw AFTER a successful report leaves
 *   the row as `participated` — the EOD row did get written, and the downstream
 *   failure is a different axis, already logged by the archive itself.
 * - `skipped_not_market_day` — the archive hook fires every calendar day (crypto is
 *   24/7) but the stock EOD report is only generated on NYSE trading days. A weekend
 *   or holiday pass is NOT a miss, and folding it into the denominator would bury a
 *   real miss under ~30% expected absence.
 */
export type EodParticipationOutcome =
  | 'participated'
  | 'absent_from_context_map'
  | 'report_threw'
  | 'archive_threw'
  | 'skipped_not_market_day';

export const EOD_PARTICIPATION_OUTCOMES: EodParticipationOutcome[] = [
  'participated',
  'absent_from_context_map',
  'report_threw',
  'archive_threw',
  'skipped_not_market_day',
];

/** Outcomes that mean "this book did NOT get its EOD row, and it should have". */
const MISS_OUTCOMES: EodParticipationOutcome[] = [
  'absent_from_context_map',
  'report_threw',
  'archive_threw',
];

/** One durable per-book outcome row. */
export interface EodParticipationBookRecord {
  kind: 'book';
  /** Record time, ms epoch. */
  ts: number;
  /** ET calendar day of the archive pass (America/New_York, YYYY-MM-DD). */
  etDay: string;
  /** Ties this row to its `kind:'run'` row. */
  runId: string;
  username: string;
  outcome: EodParticipationOutcome;
  /** Error message, present for `report_threw` / `archive_threw`. */
  reason?: string;
}

/**
 * One durable row per archive PASS. Written before any per-book row, so "the hook
 * never fired" (no run row) is readable apart from "the hook fired and this book was
 * absent" (run row + an `absent_from_context_map` book row).
 */
export interface EodParticipationRunRecord {
  kind: 'run';
  ts: number;
  etDay: string;
  runId: string;
  /** TRUE ⇒ NYSE trading day, so a stock EOD row was expected from every book. */
  marketDay: boolean;
  /** `getAllUsers().length` — the roster, INDEPENDENT of the context map. */
  rosterSize: number;
  /** `getAllUserContexts().length` — what the archive loop could actually iterate. */
  contextMapSize: number;
}

export type EodParticipationRecord = EodParticipationBookRecord | EodParticipationRunRecord;

// ── In-memory store (backs the health view; disk is the record) ──────────────

let dataDir: string | null = null;
const runRows: EodParticipationRunRecord[] = [];
const bookRows: EodParticipationBookRecord[] = [];
let hydratedRecords = 0;
let hydratedDays = 0;
let appendErrors = 0;
let lastAppendError: string | null = null;

export function eodArchiveParticipationLogPath(dir: string): string {
  return join(dir, EOD_ARCHIVE_PARTICIPATION_FILENAME);
}

/** Test seam — drop every row and the configured dir. */
export function clearEodArchiveParticipation(): void {
  dataDir = null;
  runRows.length = 0;
  bookRows.length = 0;
  hydratedRecords = 0;
  hydratedDays = 0;
  appendErrors = 0;
  lastAppendError = null;
}

/**
 * Point the recorder at a directory WITHOUT hydrating. Only for callers that have no
 * boot sequence (CLI / tests); production goes through
 * {@link hydrateEodArchiveParticipationFromDisk}.
 */
export function setEodArchiveParticipationDir(dir: string | null): void {
  dataDir = dir;
}

function applyAndAppend(rec: EodParticipationRecord): void {
  // In-memory FIRST and unconditionally, then a best-effort disk write — so this
  // accounting can never break the archive pass it observes. That also means the
  // in-memory view is NOT proof anything reached disk: `durability` below is the
  // field that separates a memory-only / failed-append recorder from a durable one.
  apply(rec);
  if (dataDir == null) return;
  const path = eodArchiveParticipationLogPath(dataDir);
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch {
    // exists / unwritable — the append below surfaces the error
  }
  try {
    appendFileSync(path, JSON.stringify(rec) + '\n', 'utf8');
  } catch (err) {
    appendErrors += 1;
    lastAppendError = err instanceof Error ? err.message : String(err);
    log.warn('eod-archive-participation append failed', { reason: lastAppendError });
  }
}

function apply(rec: EodParticipationRecord): void {
  if (rec.kind === 'run') runRows.push(rec);
  else bookRows.push(rec);
}

/** Handle returned by {@link openEodArchiveParticipationRun}, threaded through the loop. */
export interface EodParticipationRun {
  runId: string;
  etDay: string;
  marketDay: boolean;
  /** Roster usernames that were NOT in the context map — already recorded as candidate (a). */
  absentFromContextMap: string[];
}

export interface OpenEodParticipationRunInput {
  /** ET calendar day of this archive pass. */
  etDay: string;
  /** TRUE ⇒ NYSE trading day (a stock EOD row is expected). */
  marketDay: boolean;
  /** Every username in `users.json`. MUST come from the roster, not the context map. */
  roster: string[];
  /** Every username the archive loop will actually iterate (`getAllUserContexts()`). */
  contextUsernames: string[];
  now?: number;
}

/**
 * Open one archive pass: write the run row, then IMMEDIATELY write one
 * `absent_from_context_map` row for every roster book missing from the context map.
 *
 * Both writes happen before the caller's loop begins, so a process death partway
 * through the loop still leaves candidate (a) durably on disk — the case that is
 * otherwise invisible precisely because the absent book is never iterated.
 */
export function openEodArchiveParticipationRun(
  input: OpenEodParticipationRunInput,
): EodParticipationRun {
  const now = input.now ?? Date.now();
  const runId = `${input.etDay}#${now}`;
  const inContext = new Set(input.contextUsernames);
  const absent = input.roster.filter((u) => !inContext.has(u));

  applyAndAppend({
    kind: 'run',
    ts: now,
    etDay: input.etDay,
    runId,
    marketDay: input.marketDay,
    rosterSize: input.roster.length,
    contextMapSize: input.contextUsernames.length,
  });

  for (const username of absent) {
    applyAndAppend({
      kind: 'book',
      ts: now,
      etDay: input.etDay,
      runId,
      username,
      outcome: 'absent_from_context_map',
    });
  }

  if (absent.length > 0) {
    // Loud, at the moment it happens — the whole point of TRA-2930. The boot-time
    // `initUserContext` warn that caused this is six weeks and one log-retention
    // window in the past by the time anyone looks.
    log.error('EOD archive: books MISSING from the context map (TRA-2930 candidate a)', {
      etDay: input.etDay,
      absent,
      rosterSize: input.roster.length,
      contextMapSize: input.contextUsernames.length,
    });
  }

  return { runId, etDay: input.etDay, marketDay: input.marketDay, absentFromContextMap: absent };
}

/**
 * Record one in-context book's outcome. Call exactly once per book per pass, from a
 * `finally` so a throw anywhere in the per-book body still lands a row.
 */
export function recordEodParticipation(
  run: EodParticipationRun,
  username: string,
  outcome: EodParticipationOutcome,
  reason?: string,
  now: number = Date.now(),
): void {
  applyAndAppend({
    kind: 'book',
    ts: now,
    etDay: run.etDay,
    runId: run.runId,
    username,
    outcome,
    ...(reason != null && reason !== '' ? { reason } : {}),
  });
}

// ── Boot hydrate ─────────────────────────────────────────────────────────────

export interface EodParticipationHydration {
  days: number;
  records: number;
}

function validRecord(raw: unknown): EodParticipationRecord | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r['ts'] !== 'number' || !Number.isFinite(r['ts'])) return null;
  if (typeof r['etDay'] !== 'string' || r['etDay'] === '') return null;
  if (typeof r['runId'] !== 'string' || r['runId'] === '') return null;
  if (r['kind'] === 'run') {
    if (typeof r['marketDay'] !== 'boolean') return null;
    if (typeof r['rosterSize'] !== 'number' || typeof r['contextMapSize'] !== 'number') return null;
    return {
      kind: 'run',
      ts: r['ts'],
      etDay: r['etDay'],
      runId: r['runId'],
      marketDay: r['marketDay'],
      rosterSize: r['rosterSize'],
      contextMapSize: r['contextMapSize'],
    };
  }
  if (r['kind'] === 'book') {
    if (typeof r['username'] !== 'string' || r['username'] === '') return null;
    const outcome = r['outcome'];
    if (typeof outcome !== 'string') return null;
    if (!EOD_PARTICIPATION_OUTCOMES.includes(outcome as EodParticipationOutcome)) return null;
    return {
      kind: 'book',
      ts: r['ts'],
      etDay: r['etDay'],
      runId: r['runId'],
      username: r['username'],
      outcome: outcome as EodParticipationOutcome,
      ...(typeof r['reason'] === 'string' && r['reason'] !== '' ? { reason: r['reason'] } : {}),
    };
  }
  return null;
}

/**
 * Rebuild the in-memory view from disk and remember `dir` for subsequent appends.
 * Idempotent (CLEARS first). Only records within {@link RETAIN_MS} of `now` are kept,
 * and the file is COMPACTED to exactly those lines. Best-effort: a missing/corrupt
 * file yields an empty hydration and a torn trailing line is skipped rather than
 * aborting the hydrate — a half-written line from a hard kill must not cost the whole
 * record.
 */
export function hydrateEodArchiveParticipationFromDisk(
  dir: string,
  now: number = Date.now(),
): EodParticipationHydration {
  clearEodArchiveParticipation();
  dataDir = dir;

  let raw = '';
  try {
    raw = readFileSync(eodArchiveParticipationLogPath(dir), 'utf8');
  } catch {
    raw = '';
  }

  const cutoff = now - RETAIN_MS;
  const kept: string[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const rec = validRecord(parsed);
    if (rec === null) continue;
    if (rec.ts < cutoff) continue;
    apply(rec);
    kept.push(JSON.stringify(rec));
  }

  const nonEmptyLines = raw.split('\n').filter((l) => l.trim() !== '').length;
  if (kept.length < nonEmptyLines) {
    const path = eodArchiveParticipationLogPath(dir);
    try {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, kept.length > 0 ? kept.join('\n') + '\n' : '', 'utf8');
    } catch (err) {
      log.warn('eod-archive-participation compaction failed', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const days = new Set(kept.length > 0 ? [...runRows, ...bookRows].map((r) => r.etDay) : []);
  hydratedRecords = kept.length;
  hydratedDays = days.size;
  return { days: days.size, records: kept.length };
}

// ── Health summary ───────────────────────────────────────────────────────────

export interface EodParticipationDaySummary {
  etDay: string;
  /** What the archive RECORDED from `isMarketDay()` at run time. Not ground truth (TRA-3267). */
  marketDay: boolean;
  /** What the independent calendar (`isMarketDayIso`) says AT READ TIME. TRA-3284. */
  calendarMarketDay: boolean;
  /** Non-null ⇔ `marketDay` and `calendarMarketDay` disagree for this pass. */
  sessionAnomaly: 'lost_session' | 'phantom_session' | null;
  rosterSize: number;
  contextMapSize: number;
  participated: number;
  absentFromContextMap: number;
  reportThrew: number;
  archiveThrew: number;
  skippedNotMarketDay: number;
  /** Roster books with NO row at all for this run — a recorder bug, not a book fault. */
  unrecorded: number;
}

export interface EodParticipationBookSummary {
  username: string;
  /** Archive passes where this book produced a row. */
  runsObserved: number;
  participated: number;
  absentFromContextMap: number;
  reportThrew: number;
  archiveThrew: number;
  skippedNotMarketDay: number;
  /**
   * `participated / (runsObserved - skippedNotMarketDay)`.
   * **`null` when the book was never observed on a market day** — NOT 0, and not 1.
   * An empty cohort has no rate, and a book with zero observed market-day passes must
   * never read the same as one that participated in all of them.
   */
  participationRate: number | null;
  lastOutcome: EodParticipationOutcome | null;
  lastOutcomeDay: string | null;
  /** Most recent day this book actually got its EOD row. `null` ⇒ never, in the window. */
  lastParticipatedDay: string | null;
  /** Consecutive most-recent MARKET-DAY passes this book missed. 0 = clean, and it is the TRA-2903 shape (28). */
  consecutiveMisses: number;
  /** Message from the most recent `report_threw` / `archive_threw`. */
  lastReason: string | null;
}

export interface EodParticipationDurability {
  /** Resolved append target. `null` = memory-only: NOTHING here is durable. */
  dataDir: string | null;
  /** TRUE ⇒ every row dies on the next redeploy (fix = DATA_DIR=/data, TRA-1719). */
  ephemeral: boolean;
  /** Rows recovered FROM DISK at boot — separates a real floor from this-uptime-only. */
  hydratedRecords: number;
  hydratedDays: number;
  /** Appends that threw and were SWALLOWED. > 0 ⇒ the view overstates what is on disk. */
  appendErrors: number;
  lastAppendError: string | null;
}

/**
 * TRA-3284 — one ET day where the archive's recorded `marketDay` disagrees with the
 * independent calendar, evaluated at read time. Surfaced as an ANOMALY, never folded
 * into an exclusion: a wrong `marketDay` used to be able to only make this record
 * GREENER (a lost session left the denominator; a phantom one joined it and passed).
 */
export interface EodParticipationSessionAnomaly {
  /** `'lost_session'` — calendar session recorded as no-session (the day left the denominator). */
  kind: 'lost_session' | 'phantom_session';
  etDay: string;
  /** What the archive recorded from `isMarketDay()` at run time (any pass that day). */
  recordedMarketDay: boolean;
  /** What `isMarketDayIso(etDay)` says at read time. */
  calendarMarketDay: boolean;
  /** Book rows written under the wrong flag — `participated` on a phantom day is NOT evidence of health. */
  participated: number;
  skippedNotMarketDay: number;
  runIds: string[];
  note: string;
}

export type EodParticipationAnomaly =
  | ({ kind: 'book' } & EodParticipationBookSummary)
  | EodParticipationSessionAnomaly;

export interface EodParticipationSummary {
  /** Archive passes on record (all days, market and not). */
  runs: number;
  /**
   * Passes whose run row RECORDED `marketDay:true`. This is what the archive believed,
   * not ground truth — read it next to `calendarSessionRuns` (TRA-3284).
   */
  marketDayRuns: number;
  /**
   * Passes whose `etDay` is a session by the INDEPENDENT calendar (`isMarketDayIso`
   * at read time). Published beside `marketDayRuns` because a published denominator is
   * what separates "clean" from "never observed" — and TWO published denominators are
   * what let a reader see the archive disagreeing with the calendar at all. Equal
   * COUNTS do not imply agreement (08-05..08-10 read 4 vs 4 with different members);
   * `anomalies` carries the per-day disagreements.
   */
  calendarSessionRuns: number;
  firstDay: string | null;
  lastDay: string | null;
  /**
   * Tri-state-plus, deliberately NOT a boolean:
   *  - `'clean'`             — market-day passes observed, calendar agrees on every day,
   *                            every roster book participated in all of them;
   *  - `'misses'`            — at least one book missed at least one market-day pass;
   *  - `'session_anomalies'` — the recorded `marketDay` disagrees with the independent
   *                            calendar on ≥1 day (lost/phantom session, TRA-3284). This
   *                            DOMINATES `'misses'`: the denominator itself is untrusted,
   *                            so any per-book grade over it is suspect. `'clean'` is
   *                            unreachable while a disagreement is in the window.
   *  - `null`                — **BLIND**: no session on record by EITHER denominator.
   *                            A never-fired recorder and a perfect record are the same
   *                            reading on a count, so they are given different values
   *                            here. Read `blindReason`.
   */
  verdict: 'clean' | 'misses' | 'session_anomalies' | null;
  blindReason: string | null;
  /** Per-book rollup, worst first (most misses, then fewest participations). */
  byBook: EodParticipationBookSummary[];
  /**
   * Everything wrong in the window, worst class first: session-calendar disagreements
   * (TRA-3284), then books with at least one miss.
   */
  anomalies: EodParticipationAnomaly[];
  /** Per-day rollup, most recent first, capped by `dayLimit`. */
  byDay: EodParticipationDaySummary[];
  durability: EodParticipationDurability;
}

function emptyBook(username: string): EodParticipationBookSummary {
  return {
    username,
    runsObserved: 0,
    participated: 0,
    absentFromContextMap: 0,
    reportThrew: 0,
    archiveThrew: 0,
    skippedNotMarketDay: 0,
    participationRate: null,
    lastOutcome: null,
    lastOutcomeDay: null,
    lastParticipatedDay: null,
    consecutiveMisses: 0,
    lastReason: null,
  };
}

/**
 * Fold the retained rows into the health view.
 *
 * `dayLimit` bounds only `byDay`; `byBook` / `verdict` always span the whole retained
 * window, so trimming the day view can never quietly shrink the cohort a verdict is
 * computed over.
 */
export function summarizeEodArchiveParticipation(dayLimit = 45): EodParticipationSummary {
  const runsById = new Map<string, EodParticipationRunRecord>();
  for (const r of runRows) runsById.set(r.runId, r);

  // ── per-book fold ──────────────────────────────────────────────────────────
  const books = new Map<string, EodParticipationBookSummary>();
  const sortedBookRows = [...bookRows].sort((a, b) => a.ts - b.ts);
  for (const row of sortedBookRows) {
    let b = books.get(row.username);
    if (!b) {
      b = emptyBook(row.username);
      books.set(row.username, b);
    }
    b.runsObserved += 1;
    if (row.outcome === 'participated') {
      b.participated += 1;
      b.lastParticipatedDay = row.etDay;
    } else if (row.outcome === 'absent_from_context_map') b.absentFromContextMap += 1;
    else if (row.outcome === 'report_threw') b.reportThrew += 1;
    else if (row.outcome === 'archive_threw') b.archiveThrew += 1;
    else b.skippedNotMarketDay += 1;
    b.lastOutcome = row.outcome;
    b.lastOutcomeDay = row.etDay;
    if (row.reason != null) b.lastReason = row.reason;
  }

  for (const b of books.values()) {
    const expected = b.runsObserved - b.skippedNotMarketDay;
    // Empty cohort => NO rate. `every`-style folds are TRUE on nothing; a count-based
    // rate is 0/0. Both would let a book that was never observed read as a verdict.
    b.participationRate = expected > 0 ? b.participated / expected : null;
  }

  // Consecutive most-recent MARKET-DAY misses per book (the TRA-2903 shape).
  // A run counts toward the streak only when the recorded flag AND the independent
  // calendar agree it was a session (TRA-3284): a `participated` row on a phantom
  // Sunday must not clear a live 28-session streak — a fabricated session is not
  // evidence of health.
  const marketDayRunIds = new Set(
    [...runsById.values()].filter((r) => r.marketDay && isMarketDayIso(r.etDay)).map((r) => r.runId),
  );
  const byBookRowsDesc = new Map<string, EodParticipationBookRecord[]>();
  for (const row of [...sortedBookRows].reverse()) {
    const list = byBookRowsDesc.get(row.username) ?? [];
    list.push(row);
    byBookRowsDesc.set(row.username, list);
  }
  for (const [username, rows] of byBookRowsDesc) {
    const b = books.get(username);
    if (!b) continue;
    let streak = 0;
    for (const row of rows) {
      // Only market-day passes can be a miss. A weekend row is neither a miss nor a
      // reset — skip it so a Sunday does not clear a live 28-session streak.
      if (row.outcome === 'skipped_not_market_day') continue;
      if (!marketDayRunIds.has(row.runId) && runsById.has(row.runId)) continue;
      if (MISS_OUTCOMES.includes(row.outcome)) streak += 1;
      else break;
    }
    b.consecutiveMisses = streak;
  }

  // ── per-day fold ───────────────────────────────────────────────────────────
  const dayRows = new Map<string, EodParticipationBookRecord[]>();
  for (const row of sortedBookRows) {
    const list = dayRows.get(row.runId) ?? [];
    list.push(row);
    dayRows.set(row.runId, list);
  }
  const byDay: EodParticipationDaySummary[] = [...runsById.values()]
    .sort((a, b) => b.ts - a.ts)
    .map((run) => {
      const rows = dayRows.get(run.runId) ?? [];
      const count = (o: EodParticipationOutcome): number =>
        rows.filter((r) => r.outcome === o).length;
      const recorded = new Set(rows.map((r) => r.username)).size;
      const calendarMarketDay = isMarketDayIso(run.etDay);
      return {
        etDay: run.etDay,
        marketDay: run.marketDay,
        calendarMarketDay,
        sessionAnomaly:
          run.marketDay === calendarMarketDay
            ? null
            : calendarMarketDay
              ? ('lost_session' as const)
              : ('phantom_session' as const),
        rosterSize: run.rosterSize,
        contextMapSize: run.contextMapSize,
        participated: count('participated'),
        absentFromContextMap: count('absent_from_context_map'),
        reportThrew: count('report_threw'),
        archiveThrew: count('archive_threw'),
        skippedNotMarketDay: count('skipped_not_market_day'),
        unrecorded: Math.max(0, run.rosterSize - recorded),
      };
    });

  const marketDayRuns = [...runsById.values()].filter((r) => r.marketDay).length;
  const calendarSessionRuns = [...runsById.values()].filter((r) => isMarketDayIso(r.etDay)).length;
  const allDays = [...runsById.values()].map((r) => r.etDay).sort();
  const byBook = [...books.values()].sort((a, b) => {
    const missA = a.absentFromContextMap + a.reportThrew + a.archiveThrew;
    const missB = b.absentFromContextMap + b.reportThrew + b.archiveThrew;
    if (missA !== missB) return missB - missA;
    return a.participated - b.participated;
  });
  const bookAnomalies = byBook.filter(
    (b) => b.absentFromContextMap + b.reportThrew + b.archiveThrew > 0,
  );

  // ── TRA-3284: cross-check every run day against the INDEPENDENT calendar ───
  // The recorded `marketDay` came from the very predicate TRA-3267 proved wrong, so it
  // cannot be this record's own denominator unchallenged. Disagreement is an ANOMALY,
  // never an exclusion. Folded per etDay (a restart can double-fire a pass): a day is
  // recorded-as-session if ANY of its runs said so.
  const runsByEtDay = new Map<string, EodParticipationRunRecord[]>();
  for (const r of runsById.values()) {
    const list = runsByEtDay.get(r.etDay) ?? [];
    list.push(r);
    runsByEtDay.set(r.etDay, list);
  }
  const sessionAnomalies: EodParticipationSessionAnomaly[] = [];
  for (const [etDay, runs] of [...runsByEtDay.entries()].sort((a, b) => (a[0] < b[0] ? 1 : -1))) {
    const recordedMarketDay = runs.some((r) => r.marketDay);
    const calendarMarketDay = isMarketDayIso(etDay);
    if (recordedMarketDay === calendarMarketDay) continue;
    const rows = runs.flatMap((r) => dayRows.get(r.runId) ?? []);
    const participated = rows.filter((r) => r.outcome === 'participated').length;
    const skippedNotMarketDay = rows.filter((r) => r.outcome === 'skipped_not_market_day').length;
    sessionAnomalies.push({
      kind: calendarMarketDay ? 'lost_session' : 'phantom_session',
      etDay,
      recordedMarketDay,
      calendarMarketDay,
      participated,
      skippedNotMarketDay,
      runIds: runs.map((r) => r.runId),
      note: calendarMarketDay
        ? `LOST SESSION: ${etDay} is a NYSE session by the independent calendar, but the archive pass recorded marketDay:false and skipped ${skippedNotMarketDay} book(s). The session's EOD rows were never owed by the archive's own accounting — that reclassification is the defect, not a valid exclusion (TRA-3267/TRA-3284).`
        : `PHANTOM SESSION: ${etDay} is NOT a NYSE session by the independent calendar, but the archive pass recorded marketDay:true and wrote ${participated} participated row(s). A fabricated session must not count as evidence of health (TRA-3267/TRA-3284).`,
    });
  }

  const anomalies: EodParticipationAnomaly[] = [
    ...sessionAnomalies,
    ...bookAnomalies.map((b) => ({ kind: 'book' as const, ...b })),
  ];

  // `'clean'` is unreachable while a session-calendar disagreement is in the window:
  // the first branch wins on ANY disagreement, and the blind branch requires BOTH
  // denominators to be zero (which a disagreement makes impossible — a lost session
  // puts the day in `calendarSessionRuns`, a phantom one in `marketDayRuns`).
  const verdict: 'clean' | 'misses' | 'session_anomalies' | null =
    sessionAnomalies.length > 0
      ? 'session_anomalies'
      : marketDayRuns === 0 && calendarSessionRuns === 0
        ? null
        : bookAnomalies.length > 0
          ? 'misses'
          : 'clean';

  return {
    runs: runsById.size,
    marketDayRuns,
    calendarSessionRuns,
    firstDay: allDays[0] ?? null,
    lastDay: allDays[allDays.length - 1] ?? null,
    verdict,
    blindReason:
      verdict !== null
        ? null
        : runsById.size === 0
          ? 'BLIND: no archive pass on record. This reads identical to a perfect record on any count-based metric, which is why it is null and not "clean". Either the recorder has not run since it was deployed, or the 21:00 ET archive hook is not firing — check durability.ephemeral first, then the scheduler.'
          : 'BLIND: archive passes on record, but none on a NYSE trading day by either the recorded flag or the independent calendar. No stock EOD row was expected yet, so nothing can be graded.',
    byBook,
    anomalies,
    byDay: byDay.slice(0, dayLimit),
    durability: {
      dataDir,
      ephemeral: dataDir == null ? true : isEphemeralDataDir(dataDir),
      hydratedRecords,
      hydratedDays,
      appendErrors,
      lastAppendError,
    },
  };
}
