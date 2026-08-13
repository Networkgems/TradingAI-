// TRA-3387 (child of TRA-3243) — durability for the SESSION-SCOPED moveSuspect verdict.
//
// TRA-3243 gave `symbolState` a session-scoped condemnation
// (`moveSuspectSession` / `moveSuspectSessionDay` / `moveSuspectPrevClose`) so a row the feed
// condemns mid-session stays out of the EOD movers table even when its ratio falls back under
// the bar by the close. Nothing persisted it. The EOD report runs at 01:00Z and TRA-2693
// measured bqb1 rebooting at 20:31Z — 31 minutes after the close — so an ordinary restart in
// that ~5 h window reverted the fix AND published an EMPTY
// `top-movers EXCLUDED rows condemned earlier in the session` census, which reads exactly like
// "there was nothing to exclude": a false green on the one surface built to make the fix
// measurable.
//
// This module is the DURABLE half. The LOUD half lives in `reports/eod-report.ts`, which grades
// {@link MoveSuspectSessionProvenance} and refuses to publish a clean-looking empty census when
// this store did not cover the session. Neither half is sufficient alone:
//
//   - persistence alone cannot cover a container replace that takes an ephemeral DATA_DIR with
//     it, so there is always a residual hole;
//   - the loud half alone never preserves anything — it converts a silent false green into a
//     stated unknown, which is strictly better and still a loss of the exclusion.
//
// ⭐ AND THE LOUD HALF IS THE CONTROL FOR THIS ONE. A persistence bug here — wrong directory, a
// parse throw swallowed, a write that never lands — reproduces the ORIGINAL defect exactly: an
// empty census that reads as clean. The only thing that can catch that is a verdict computed
// from the restore OUTCOME, which is why `loadMoveSuspectSessionSnapshot` reports how it failed
// rather than just returning no rows.
//
// ⛔ SESSION-DAY SCOPED ON READ, AND THE SCOPING IS AT THE READ ON PURPOSE. A fact reloaded from
// a PREVIOUS ET session would condemn a clean row today — an inversion strictly worse than the
// bug this closes, because it fabricates an exclusion rather than losing one.
// `selectRestorableRows` returns ZERO rows when the snapshot's `sessionDay` is not byte-equal to
// the current one; it does not hand them to `advanceMoveSuspectSession` and rely on that
// function's `rolled_over` branch to drop them. The rows never enter `symbolState`, so no later
// path can resurrect them, and the drop is reported as its own outcome so a reader cannot
// confuse "I discarded a stale fact" with "I recovered today's".

import { readFile, writeFile, rename, mkdir } from 'fs/promises';
import { join } from 'path';
import { logger } from './observability/index.js';
import { isEphemeralDataDir } from './data-dir.js';

const log = logger.child({ module: 'move-suspect-session-store' });

/** File name inside the owning user's data directory. */
export const MOVE_SUSPECT_SESSION_FILE = 'move-suspect-session.json';

/**
 * Hard cap on persisted rows. A condemnation is rare (the 08-11 tape flagged 3 of 663 symbols),
 * so this is a runaway guard, not a working limit — but a store with no ceiling is one bad feed
 * day away from being the thing that fills the disk the trade book lives on.
 *
 * Overflow is REPORTED, never silent: `truncated` rides on the write log line and on the
 * snapshot itself, because a store that quietly drops rows is a store whose empty census is
 * once again unreadable.
 */
export const MOVE_SUSPECT_SESSION_MAX_ROWS = 2000;

/**
 * TRA-3480 — how stale the snapshot may get while the engine is demonstrably alive.
 *
 * The v1 store wrote only on a session-fact CHANGE, which is complete but leaves `updatedAt`
 * meaning "the last time something happened" — indistinguishable from "the last time this store
 * was known to be working". On a QUIET session nothing is ever written, so a boot mid-session
 * reads `absent` (or a previous day's file) and the whole session grades BLIND even though
 * nothing was lost. bqb1 booted NINE times in six hours on 2026-08-12/13, so that is not a
 * corner: it is the modal outcome, and it starves TRA-3243's acceptance criterion indefinitely.
 *
 * The heartbeat rewrites the same rows with a fresh `updatedAt` at most this often, and ONLY
 * from inside `applyQuotes` — i.e. only when a quote batch actually landed. That coupling is the
 * point: the timestamp then asserts "the engine was alive AND observing the feed as of T, and
 * held exactly these rows". A bare `setInterval` would keep stamping a confident T through a
 * dead feed, which is a liveness claim the file has no right to make.
 */
export const MOVE_SUSPECT_SESSION_HEARTBEAT_MS = 5 * 60_000;

/** One condemned symbol, exactly the three fields `SymbolState` carries. */
export interface MoveSuspectSessionRow {
  symbol: string;
  /** ET session date key (`YYYY-MM-DD`) the fact belongs to. Redundant with the file's own
   * `sessionDay` and kept anyway: a row that travels out of this file (a log line, a probe)
   * must carry its own scope or it becomes undatable. */
  moveSuspectSessionDay: string;
  /** The condemned `impliedPrevClose`. Absent when the verdict had no recoverable denominator. */
  moveSuspectPrevClose?: number;
}

/**
 * Snapshot format version.
 *
 * `1` — TRA-3387: written ONLY when a session fact changed. `updatedAt` is therefore a
 *       change stamp, and there is no carried-gap field.
 * `2` — TRA-3480: written also at boot (the anchor) and on a liveness heartbeat, so
 *       `updatedAt` means "the store was live and held exactly `rows` as of T" — and the file
 *       carries {@link MoveSuspectSessionFile.uncoveredMsCarried} so a CHAIN of restarts
 *       accumulates its holes instead of each boot resetting the bound to its own last gap.
 */
export const MOVE_SUSPECT_SESSION_VERSION = 2;

/** The serialized shape of `<userDataDir>/move-suspect-session.json`. */
export interface MoveSuspectSessionFile {
  issue: 'TRA-3387';
  version: number;
  /** The ET session day EVERY row in `rows` belongs to. The scoping key, checked on read. */
  sessionDay: string;
  /** ms epoch of this write. */
  updatedAt: number;
  /**
   * Process start of the writer. The SEAM (the TRA-3116 idiom): a snapshot whose
   * `processStartedAt` differs from the reader's own is one this process did not write, i.e.
   * there was a restart between the two, which is the whole event this file exists to survive.
   */
  processStartedAt: number;
  /** True when `rows` was cut to {@link MOVE_SUSPECT_SESSION_MAX_ROWS}. */
  truncated: boolean;
  /**
   * TRA-3480 — ms of `sessionDay` that were already unobserved BEFORE this writer's process
   * started, i.e. everything its predecessors lost, summed down the restart chain.
   *
   * ⭐ THIS FIELD IS WHAT KEEPS THE ANCHOR HONEST. Without it, every boot rewrites `updatedAt`
   * to its own start, so the next boot's gap is measured from THAT — and a host that restarts
   * nine times in six hours reports nine small gaps for a session that was blind for hours. The
   * bound would shrink precisely as the evidence got worse, which is the one direction a
   * coverage instrument may never move.
   *
   * `null` ⇔ some stretch of `sessionDay` was observed by NOBODY in this chain (a mid-session
   * boot that found no usable snapshot). Blindness is INHERITED: a later boot that restores this
   * file restores the unknown with it, and its verdict stays `blind`. It does not decay into a
   * number just because the most recent hop happens to be measurable.
   */
  uncoveredMsCarried: number | null;
  rows: MoveSuspectSessionRow[];
}

/**
 * How the boot read went. NOT a boolean, because "no file" / "yesterday's file" / "a corrupt
 * file" all produce zero restored rows and mean completely different things about whether this
 * session is covered.
 */
export type MoveSuspectSessionRestoreOutcome =
  /** A snapshot for the CURRENT ET session day was read and applied. */
  | 'restored'
  /** A snapshot existed but belongs to a DIFFERENT ET session day. Dropped, deliberately. */
  | 'rolled_over'
  /** No snapshot file. First boot on this data dir, or the dir did not survive. */
  | 'absent'
  /** A snapshot file exists and could not be read or parsed. NEVER read this as clean. */
  | 'unreadable';

export interface MoveSuspectSessionRestore {
  outcome: MoveSuspectSessionRestoreOutcome;
  /** Absolute path read (or the path that was absent). */
  path: string;
  /** The snapshot's own session day, when it had a legible one. */
  fileSessionDay: string | null;
  /** The snapshot's `updatedAt`, when legible. The upper bound of what the writer had seen. */
  fileUpdatedAt: number | null;
  /** The snapshot's writer process start, when legible. The seam. */
  fileProcessStartedAt: number | null;
  /** Rows applied. EMPTY unless `outcome === 'restored'`. */
  rows: MoveSuspectSessionRow[];
  /** Rows present in the file that were NOT applied (the rollover drop). */
  droppedRows: number;
  /**
   * TRA-3480 — the snapshot's own {@link MoveSuspectSessionFile.uncoveredMsCarried}, i.e. what
   * the WRITER had already lost. Meaningful only on `'restored'`; every other outcome means this
   * process inherited nothing it can bound.
   *
   * A version-1 file (pre-TRA-3480) carries no such field and reads as **`0`**, NOT as `null`.
   * That is deliberate and it is not a fail-open: v1 wrote only on a session-fact CHANGE, so its
   * `updatedAt` IS a change stamp and `processStartedAt - updatedAt` was already the complete
   * bound under the old rule. Reading the absence as `null` would instead turn every
   * mixed-build boot — exactly what a rolling deploy produces — into a manufactured BLIND, and
   * a verdict that cries wolf on its own upgrade is the one nobody reads on the day it is right.
   * A version-2 file that omits the field is a different animal: it claims the new contract and
   * fails it, so it reads `null`.
   */
  uncoveredMsCarried: number | null;
  /** Present only on `'unreadable'`. */
  reason?: string;
}

/**
 * What the EOD census needs to decide whether an empty exclusion list is EVIDENCE or a BLIND.
 *
 * ⚠️ This is deliberately a record of what HAPPENED (a restore outcome, a flush timestamp), not
 * a prediction of what WOULD happen (`isEphemeralDataDir`). The prediction is wrong in both
 * directions: the in-bundle fallback dir is erased by a redeploy yet SURVIVES the memory
 * watchdog's pm2 self-restart, which is exactly the restart class that writes no deploy record
 * (TRA-2203 / TRA-2261) and is therefore the one most likely to go unnoticed. Grading the
 * prediction would emit BLIND over a session that was fully covered, and a verdict that cries
 * wolf is the one nobody reads on the day it is right. `ephemeralStore` is carried as CONTEXT
 * for a human, and no verdict is derived from it.
 */
export interface MoveSuspectSessionProvenance {
  /** ms epoch this process started. */
  processStartedAt: number;
  /** The ET session day this process started in. */
  processStartedSessionDay: string;
  /** `null` ⇔ the engine never hydrated a store: the fact is memory-only, as before TRA-3387. */
  restore: MoveSuspectSessionRestore | null;
  /** ms epoch of the last successful snapshot write by this process, or `null`. */
  lastFlushAt: number | null;
  /** Non-null ⇔ a write has FAILED and the store is not durable right now. */
  lastFlushError: string | null;
  /** The directory the store resolved to, or `null` when not wired. */
  storeDir: string | null;
  /** Context only — see the note above. `null` when not wired. */
  ephemeralStore: boolean | null;
}

/**
 * The rollover gate, extracted so it is gradeable without a filesystem.
 *
 * Returns the rows that may be applied and the count that was dropped. `sessionDay` mismatch
 * ⇒ EVERY row is dropped; there is no partial acceptance, because the file's `sessionDay` is
 * the scope of the whole snapshot and a per-row override would be a second source of truth.
 *
 * Rows are also validated individually: a row without a usable `symbol`, or whose own
 * `moveSuspectSessionDay` disagrees with the file's, is dropped. That second check is not
 * redundant paranoia — it is the only thing standing between a hand-edited or half-merged file
 * and a fabricated exclusion, which is the failure direction this ticket calls worse than the
 * bug.
 */
export function selectRestorableRows(
  parsed: Partial<MoveSuspectSessionFile> | null | undefined,
  currentSessionDay: string,
): { rows: MoveSuspectSessionRow[]; droppedRows: number; sameSession: boolean } {
  const all = Array.isArray(parsed?.rows) ? parsed!.rows! : [];
  const fileDay = typeof parsed?.sessionDay === 'string' ? parsed.sessionDay : null;
  const sameSession = fileDay !== null && fileDay === currentSessionDay;
  if (!sameSession) return { rows: [], droppedRows: all.length, sameSession: false };

  const rows: MoveSuspectSessionRow[] = [];
  let dropped = 0;
  for (const r of all) {
    const symbol = typeof r?.symbol === 'string' ? r.symbol.trim() : '';
    if (symbol.length === 0 || r?.moveSuspectSessionDay !== currentSessionDay) {
      dropped++;
      continue;
    }
    const prev = r.moveSuspectPrevClose;
    rows.push({
      symbol,
      moveSuspectSessionDay: currentSessionDay,
      ...(typeof prev === 'number' && Number.isFinite(prev) ? { moveSuspectPrevClose: prev } : {}),
    });
  }
  return { rows, droppedRows: dropped, sameSession: true };
}

export function moveSuspectSessionPath(dir: string): string {
  return join(dir, MOVE_SUSPECT_SESSION_FILE);
}

/**
 * TRA-3480 — read the carried-gap field, resolving the two ways it can be missing.
 *
 * See {@link MoveSuspectSessionRestore.uncoveredMsCarried} for why a v1 absence is `0` and a v2
 * absence is `null`. Exported so the asymmetry is gradeable on its own rather than only through
 * a filesystem round trip.
 */
export function readCarriedUncoveredMs(
  parsed: Partial<MoveSuspectSessionFile> | null | undefined,
): number | null {
  const raw = parsed?.uncoveredMsCarried;
  if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) return Math.round(raw);
  if (raw === null) return null;
  const version = parsed?.version;
  // Absent field. Only a file that predates the contract gets the legacy reading.
  return typeof version === 'number' && version < MOVE_SUSPECT_SESSION_VERSION ? 0 : null;
}

/**
 * Read the snapshot for `currentSessionDay`.
 *
 * NEVER throws: every failure resolves to an outcome a caller can grade. A store that throws on
 * boot would take the engine down over a data-quality nicety, and a store that swallows the
 * failure into `absent` would hand the census a clean-looking zero — the defect this ticket is
 * about. `'unreadable'` exists so the third case has a name.
 */
export async function loadMoveSuspectSessionSnapshot(
  dir: string,
  currentSessionDay: string,
): Promise<MoveSuspectSessionRestore> {
  const path = moveSuspectSessionPath(dir);
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    const code = (err as { code?: string } | null)?.code;
    if (code === 'ENOENT') {
      return { outcome: 'absent', path, fileSessionDay: null, fileUpdatedAt: null, fileProcessStartedAt: null, rows: [], droppedRows: 0, uncoveredMsCarried: null };
    }
    return {
      outcome: 'unreadable',
      path,
      fileSessionDay: null,
      fileUpdatedAt: null,
      fileProcessStartedAt: null,
      rows: [],
      droppedRows: 0,
      uncoveredMsCarried: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  let parsed: Partial<MoveSuspectSessionFile>;
  try {
    parsed = JSON.parse(raw) as Partial<MoveSuspectSessionFile>;
  } catch (err: unknown) {
    return {
      outcome: 'unreadable',
      path,
      fileSessionDay: null,
      fileUpdatedAt: null,
      fileProcessStartedAt: null,
      rows: [],
      droppedRows: 0,
      uncoveredMsCarried: null,
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const fileSessionDay = typeof parsed?.sessionDay === 'string' ? parsed.sessionDay : null;
  const fileUpdatedAt = typeof parsed?.updatedAt === 'number' && Number.isFinite(parsed.updatedAt)
    ? parsed.updatedAt : null;
  const fileProcessStartedAt = typeof parsed?.processStartedAt === 'number' && Number.isFinite(parsed.processStartedAt)
    ? parsed.processStartedAt : null;

  // A file with no legible session day cannot be scoped, and an unscoped fact is the exact
  // input that would condemn a clean row. Unreadable, not absent.
  if (fileSessionDay === null) {
    return {
      outcome: 'unreadable',
      path,
      fileSessionDay: null,
      fileUpdatedAt,
      fileProcessStartedAt,
      rows: [],
      droppedRows: Array.isArray(parsed?.rows) ? parsed.rows.length : 0,
      uncoveredMsCarried: null,
      reason: 'snapshot carries no sessionDay',
    };
  }

  const { rows, droppedRows, sameSession } = selectRestorableRows(parsed, currentSessionDay);
  return {
    outcome: sameSession ? 'restored' : 'rolled_over',
    path,
    fileSessionDay,
    fileUpdatedAt,
    fileProcessStartedAt,
    rows,
    droppedRows,
    // Scoped to the SAME session, like the rows. A carry read off a previous session's file
    // would be a bound on a window that is not the one being graded.
    uncoveredMsCarried: sameSession ? readCarriedUncoveredMs(parsed) : null,
  };
}

/**
 * Write the snapshot atomically (tmp + rename), creating `dir` if needed.
 *
 * Atomic because the reader of this file is a BOOT, and a boot is exactly when the previous
 * process may have died mid-write. A torn file would land as `'unreadable'` — honest, but it
 * would throw away a session's evidence for a reason that costs one `rename` to avoid.
 *
 * Throws on failure. The caller owns the decision about what a failed write means; here it must
 * not be silent, because a store that cannot write is a store whose next boot restores nothing
 * and whose census then reads clean.
 */
export async function saveMoveSuspectSessionSnapshot(
  dir: string,
  input: {
    sessionDay: string;
    processStartedAt: number;
    rows: readonly MoveSuspectSessionRow[];
    /** TRA-3480 — what this writer inherited for `sessionDay`. `null` ⇔ inherited an unknown. */
    uncoveredMsCarried?: number | null;
    now?: number;
  },
): Promise<MoveSuspectSessionFile> {
  const all = input.rows;
  const truncated = all.length > MOVE_SUSPECT_SESSION_MAX_ROWS;
  const file: MoveSuspectSessionFile = {
    issue: 'TRA-3387',
    version: MOVE_SUSPECT_SESSION_VERSION,
    sessionDay: input.sessionDay,
    updatedAt: input.now ?? Date.now(),
    processStartedAt: input.processStartedAt,
    truncated,
    // `undefined` would be DROPPED by `JSON.stringify` and then read back as "absent", which for
    // a v2 file means `null` anyway — but relying on that would make the file's meaning depend
    // on a serializer quirk. Normalized here so what is written is what is meant.
    uncoveredMsCarried: input.uncoveredMsCarried ?? null,
    rows: truncated ? all.slice(0, MOVE_SUSPECT_SESSION_MAX_ROWS) : [...all],
  };
  await mkdir(dir, { recursive: true });
  const path = moveSuspectSessionPath(dir);
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(file), 'utf-8');
  await rename(tmp, path);
  if (truncated) {
    log.warn('move-suspect session snapshot TRUNCATED — the restored census will be a SUBSET', {
      issue: 'TRA-3387',
      sessionDay: file.sessionDay,
      admitted: all.length,
      persisted: file.rows.length,
      cap: MOVE_SUSPECT_SESSION_MAX_ROWS,
    });
  }
  return file;
}

/**
 * ms epoch this process started.
 *
 * Derived from `process.uptime()` rather than captured in a module-level `Date.now()` at import
 * time, and the difference matters: a module const is "when this module was first imported",
 * which for a lazily-constructed per-user engine can be minutes after boot. The seam this feeds
 * is a claim about the PROCESS, so it has to be read from the process.
 */
export function processStartedAtMs(now: number = Date.now()): number {
  return Math.round(now - process.uptime() * 1000);
}

/** Context-only durability read. See the warning on {@link MoveSuspectSessionProvenance}. */
export function describeStoreDurability(dir: string | null): boolean | null {
  return dir === null ? null : isEphemeralDataDir(dir);
}

/**
 * TRA-3480 — how much of `sessionDay` this process inherits as ALREADY LOST, given the boot read
 * it just did. The value it will stamp on every snapshot it writes for that day.
 *
 * PURE, and deliberately the same arithmetic the coverage verdict applies — the writer's claim
 * and the reader's grade must be the same function or the chain accumulates two different
 * numbers. `gradeMoveSuspectSessionCoverage` is the reader; this is the writer.
 *
 * ⛔ THE SESSION-DAY COMPARISON IS NOT AN OPTIMISATION. A process that started on an EARLIER ET
 * day observed `sessionDay` from its very first instant, so it inherits ZERO no matter what its
 * boot read said — including a boot read that was itself blind about the PREVIOUS day. Without
 * this branch a process that booted blind at 15:00 on 08-13 would keep stamping `null` through
 * 08-14 and every day after, and the store would be permanently, wrongly blind from one bad boot.
 */
export function deriveInheritedUncoveredMs(
  restore: MoveSuspectSessionRestore | null | undefined,
  processStartedAt: number,
  processStartedSessionDay: string,
  sessionDay: string,
): number | null {
  if (processStartedSessionDay < sessionDay) return 0;
  if (processStartedSessionDay > sessionDay) return null;
  if (!restore || restore.outcome !== 'restored') return null;
  if (typeof restore.fileUpdatedAt !== 'number') return null;
  if (restore.uncoveredMsCarried === null) return null;
  return restore.uncoveredMsCarried + Math.max(0, processStartedAt - restore.fileUpdatedAt);
}

// ── THE LOUD HALF'S PREDICATE ────────────────────────────────────────────────

/**
 * Can the session-condemnation census be read as EVIDENCE about the graded session?
 *
 * Three-valued on purpose, and `'blind'` is not `'intact'`: an empty exclusion list under a
 * blind verdict says the instrument could not see, and a caller that collapses the two has
 * rebuilt the defect (a gate satisfied by the absence of the thing it grades).
 */
export type MoveSuspectSessionCoverage = 'intact' | 'restored' | 'blind';

export type MoveSuspectSessionCoverageReason =
  /** The process predates the graded ET session day: memory was continuous throughout. */
  | 'process_older_than_session'
  /** The process started inside the graded day and a same-day snapshot was applied. */
  | 'restored_from_snapshot'
  /** Started inside the graded day; no snapshot existed. */
  | 'restart_in_session_no_snapshot'
  /** Started inside the graded day; the snapshot belonged to another session. */
  | 'restart_in_session_snapshot_rolled_over'
  /** Started inside the graded day; the snapshot could not be read. */
  | 'restart_in_session_snapshot_unreadable'
  /** Started inside the graded day and no store is wired at all (pre-TRA-3387 behaviour). */
  | 'restart_in_session_store_not_wired'
  /**
   * TRA-3480 — a same-day snapshot WAS applied, but it carries an unknown: somewhere earlier in
   * this restart chain a process booted mid-session with nothing to restore. The rows came back;
   * the guarantee did not. Blindness is inherited, so this is `blind`, not `restored`.
   */
  | 'restored_but_session_start_unobserved'
  /**
   * TRA-3480 — a same-day snapshot was applied but has no legible `updatedAt`, so this hop's own
   * gap has no upper bound. Restored rows with an unbounded hole is still an unbounded hole.
   */
  | 'restored_but_gap_unbounded'
  /** The engine state is from a LATER session than the one being graded (a backfill). */
  | 'state_from_a_later_session'
  /** No provenance supplied — the caller cannot say. Never clean. */
  | 'provenance_absent';

export interface MoveSuspectSessionCoverageVerdict {
  coverage: MoveSuspectSessionCoverage;
  reason: MoveSuspectSessionCoverageReason;
  /**
   * ms of the graded session that NOBODY observed, when it is computable — the interval
   * between the last durable write and this process's start.
   *
   * ⚠️ TRI-STATE, the TRA-3116 discipline: `0` ONLY when there is provably no gap, and `null`
   * whenever a gap exists but its size is unknown. It is never a reassuring number standing in
   * for an unknown one.
   */
  uncoveredMs: number | null;
}

/**
 * Grade coverage. PURE — the report owns the census, this owns the rule.
 *
 * The comparison is on ET SESSION DAY KEYS, lexicographically, which for zero-padded
 * `YYYY-MM-DD` is chronological. Deliberately not on a wall-clock instant: the fact being
 * graded is itself scoped by `etDateKey` inside `advanceMoveSuspectSession`, so any other
 * boundary would grade a window the state machine does not use. A process that started on an
 * EARLIER key cannot have missed a fact belonging to this key, whatever the clock says.
 *
 * ⛔ A restart at 00:30 ET, before a single quote flowed, still grades `blind` when nothing was
 * restored. That is the fail-CLOSED direction and it is deliberate: this function cannot know
 * whether the feed was running, and TRA-2379's cost asymmetry applies unchanged — a spurious
 * BLIND costs a reader one line of context, while a spurious clean republishes a fabricated
 * headline in the document a human reads as the session summary. Once the store is working the
 * case does not arise, because a same-day snapshot restores and the verdict is `'restored'`.
 */
export function gradeMoveSuspectSessionCoverage(
  provenance: MoveSuspectSessionProvenance | null | undefined,
  gradedSessionDay: string,
): MoveSuspectSessionCoverageVerdict {
  if (!provenance || typeof provenance.processStartedSessionDay !== 'string') {
    return { coverage: 'blind', reason: 'provenance_absent', uncoveredMs: null };
  }
  const started = provenance.processStartedSessionDay;
  if (started < gradedSessionDay) {
    return { coverage: 'intact', reason: 'process_older_than_session', uncoveredMs: 0 };
  }
  if (started > gradedSessionDay) {
    return { coverage: 'blind', reason: 'state_from_a_later_session', uncoveredMs: null };
  }

  const restore = provenance.restore;
  if (restore === null || restore === undefined) {
    return { coverage: 'blind', reason: 'restart_in_session_store_not_wired', uncoveredMs: null };
  }
  if (restore.outcome === 'restored') {
    // The one gap that survives a successful restore: whatever the dead process condemned
    // between its last durable write and its death.
    const gap = typeof restore.fileUpdatedAt === 'number'
      ? Math.max(0, provenance.processStartedAt - restore.fileUpdatedAt)
      : null;
    if (gap === null) {
      return { coverage: 'blind', reason: 'restored_but_gap_unbounded', uncoveredMs: null };
    }
    // TRA-3480 — ADD what the writer had already lost. The anchor + heartbeat write means
    // `updatedAt` now advances on liveness rather than only on a change, which is what makes
    // `gap` small and therefore what would make it MISLEADING on its own: nine restarts would
    // report nine small numbers and no memory of the eight holes between them.
    //
    // ⛔ TESTED FOR FINITENESS, NOT FOR `=== null`. A caller that hand-builds a restore and omits
    // the field hands us `undefined`; `undefined + gap` is `NaN`, and `JSON.stringify(NaN)` is
    // `null` — so the ONE arm that must be loud would have serialised into the tape as the exact
    // token this file uses for "unknowable", from a restore that was actually fine. Caught by
    // `eod-report.test.ts`, which grades the emitted LINE rather than the returned object.
    const carried = restore.uncoveredMsCarried;
    if (typeof carried !== 'number' || !Number.isFinite(carried)) {
      return { coverage: 'blind', reason: 'restored_but_session_start_unobserved', uncoveredMs: null };
    }
    return { coverage: 'restored', reason: 'restored_from_snapshot', uncoveredMs: carried + gap };
  }
  const reason: MoveSuspectSessionCoverageReason =
    restore.outcome === 'rolled_over' ? 'restart_in_session_snapshot_rolled_over'
    : restore.outcome === 'unreadable' ? 'restart_in_session_snapshot_unreadable'
    : 'restart_in_session_no_snapshot';
  return { coverage: 'blind', reason, uncoveredMs: null };
}
