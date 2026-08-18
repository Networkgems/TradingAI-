/**
 * TRA-2689 (leg 2 of TRA-2654) — the once-per-session flush for the
 * denominator-flip candidate tape.
 *
 * ## Why this writer exists at all
 *
 * The CTO's sequencing on TRA-2689 is deliberate and is NOT a blocker edge:
 * *"Leg 1 lands first if it is ready and you reuse its bounded writer … If leg 1
 * is not merged when this is ready, ship this with its own bounded flush."*
 * At implementation time TRA-2688 (leg 1) was still `todo`, so this is that own
 * bounded flush. It is deliberately shaped like leg 1's ledger writer — sibling
 * directory under the same `targetDir`, oldest-first prune, warn on truncation,
 * never throws into report generation — so that when leg 1 lands the two can be
 * folded onto one writer without moving any file.
 *
 * ## Budget (hard, from the ruling)
 *
 * - `tape/<date>.json`, **<=1 MB**.
 * - retention **<=30 sessions**, counting against leg 1's 64 MB aggregate.
 *   30 x 1 MB is 30 MB worst case; the expected footprint is far smaller
 *   (a saturated 2,000-row tape serializes to ~600 KB, and a typical session is
 *   expected to produce orders of magnitude fewer rows).
 * - The feed NEVER writes.
 *
 * ## TRA-3116 — the trigger widened, the boundary did NOT
 *
 * The original ruling's flush point was "once per session by the EOD archive
 * path". TRA-3116 measured what that actually produced: the EOD drain runs at
 * ~01:00Z, five hours after the close, and seven process restarts landed inside
 * that gap on 2026-08-05 alone. The ring is in-process and unbacked, so each
 * restart zeroed it — 364 rows held at 19:59Z became 1 row on disk, and **zero
 * RTH sessions had ever reached disk** when this was written.
 *
 * The CTO's restated constraint, which is the one that travels:
 *
 * > The feed never writes to disk. Nothing in the trading path ever reads the
 * > tape. The drain may be triggered by the EOD archive path **or by process
 * > exit**; both run outside the feed's tick. The writer may read the tape file
 * > it is about to replace, at drain time only, and that read feeds no decision
 * > other than its own merge.
 *
 * So this writer now MERGES. Multiple drains land on one `tape/<date>.json` per
 * ET calendar date, each stamped as a segment.
 *
 * ## Failure posture
 *
 * This can never throw into report generation, and it can never delay or fail
 * process exit. The EOD report is a human-read money artifact; a tape is worth
 * exactly zero of that, and zero seconds of a redeploy. Every path returns a
 * status object and logs; nothing propagates.
 *
 * ## No silent caps — now THREE named loss sources plus coverage
 *
 * Every way a row can fail to reach `rows` has its own name in the file, because
 * a counter that folds two mechanisms together cannot be acted on:
 *
 * - `droppedCandidates` / `saturated` — the in-process ring wrapped (see
 *   `denominator-flip-tape.ts`). Summed across segments; each segment's count is
 *   segment-local because `drain()` resets `dropped`.
 * - `truncatedForSize` — this writer dropped rows to fit 1 MB on a segment's own
 *   first (unmerged) write. Summed across segments.
 * - `droppedOnMerge` — rows destroyed by re-applying the ring cap and the 1 MB
 *   ceiling ACROSS concatenated segments. These are rows **no segment's own
 *   counters ever saw**: each segment's `droppedCandidates` and
 *   `truncatedForSize` were finalized before the merge existed. Folding this
 *   into either of the other two would re-create, inside the fix, exactly the
 *   silent cap the write-only boundary exists to prevent.
 *
 * `admitted` is the SUM of segment `admitted` and must NOT be re-derived as
 * `rows.length + droppedCandidates` — that identity stops holding the moment
 * there are three loss sources.
 *
 * ## Coverage, and why there is no `lostToRestart` counter
 *
 * TRA-3116 proposed a fourth counter, `lostToRestart`. Rejected as named, and
 * the reasoning is the load-bearing part of this module: the rows died with the
 * process, so nothing counted them and nothing can. A field reporting `0`
 * because its counter died with the rows is the SAME fail-open as the
 * `droppedCandidates: 0` on the 08-05 file — a number that is true and useless.
 * **An unmeasurable loss is published as `null`, never as `0`.**
 *
 * What IS measurable is coverage, because it derives from process identity
 * rather than from rows. Each segment stamps its `processStartedAt`, and
 * `coverage.observedMs` is the union of each segment's live interval clipped to
 * RTH. Deriving it from process START TIMES rather than from drain success is
 * what makes it robust to the case this fix cannot help: a SIGKILL or an OOM
 * writes no segment at all, so the dead process's whole lifetime shows up as an
 * uncovered interval between the surrounding segments. A coverage field computed
 * from successful drains would score that clean. This one cannot.
 *
 * `coverageComplete` sits at the root next to `saturated` — both are
 * "do not read this file as complete coverage" flags, and per the promotion bar
 * on TRA-3116 a session counts only with `coverageComplete === true`,
 * `saturated === false`, `truncatedForSize === 0` and `droppedOnMerge === 0`.
 * A zero-row file under `coverageComplete === true` COUNTS: a proven-full-
 * coverage session with no candidates is a real observation of the quantity
 * being measured, and coverage is what makes that absence meaningful.
 *
 * ## TRA-3844 — the writer now owns the market-day predicate too
 *
 * Every window in this file was pure ET WALL-CLOCK: `RTH_OPEN_ET` /
 * `RTH_CLOSE_ET` applied to whatever date key the caller handed down, with no
 * calendar predicate anywhere. `isMarketDayIso` lived only in the READER
 * (`denominator-flip-tape-summary.ts`), so the reader dropped weekend and
 * holiday files out of `barDays[]` while the writer kept minting them.
 *
 * That is not a cosmetic split. On Sunday 2026-08-16 a redeploy's shutdown
 * drain minted **67 ledger-bearing session files**, one per book, each carrying
 * a real segment ledger over a notional Sunday RTH window — `observedMs`
 * 4,440,769 ms (13:30:00Z to the 14:44Z drain) against an `uncoveredMs` that
 * summed with it to exactly the 6.5 h session. The bar was not corrupted,
 * because the reader's independent filter held; but the tape's own artifact
 * asserted a session that never existed, and the only thing standing between
 * that and a bar defect was a filter in a different module that nothing binds
 * to this one. Same defect class as TRA-3267, where the two halves of a
 * predicate disagreed about what day it was.
 *
 * So the gate is here, at the seam, keyed on the SAME `isMarketDayIso` the
 * reader uses — not a second hand-rolled copy that can drift from it. The
 * consequence is that `tape/<date>.json` existing is now itself the claim "this
 * date was an NYSE session", which is what a reader was always entitled to
 * assume from a file named after a trading day.
 *
 * ### Why a skipped drain DISCARDS its rows rather than re-admitting them
 *
 * The re-admission contract (2d) exists for a write that FAILED while the
 * process is still alive to retry — the rows are real session rows and the ring
 * is the only place they survive. A non-market date is the opposite case: the
 * rows are weekend/holiday noise, and re-admitting them leaves them in the ring
 * to be merged into the NEXT drain, which is a real trading session. That would
 * take a bounded disk-residue defect and turn it into contamination of a
 * bar-eligible file — strictly worse than what this fixes.
 *
 * They are therefore dropped, and dropped LOUDLY: `skipped` + `skipReason` on
 * the result and a warn carrying the row count, because "no silent caps" binds
 * this exit as much as the other three. A discarded row that nothing names is
 * the same fail-open as the `droppedCandidates: 0` this module was built to
 * kill.
 */

import { writeFile, readFile, rename, mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import { etWallClockToUtcMs } from './et-clock.js';
import { isMarketDayIso } from './scheduler.js';
import type { DenominatorFlipTapeDump, DenominatorFlipCandidate } from './denominator-flip-tape.js';

/** Sub-directory of the report bucket the tape lives in. */
export const DENOM_FLIP_TAPE_DIR = 'tape';
/** Hard per-file ceiling from the ruling. */
export const DENOM_FLIP_TAPE_MAX_BYTES = 1024 * 1024;
/** Hard retention from the ruling. */
export const DENOM_FLIP_TAPE_MAX_FILES = 30;

/** RTH in ET wall-clock, the window `coverage` is measured against. */
export const RTH_OPEN_ET = { hour: 9, minute: 30 } as const;
export const RTH_CLOSE_ET = { hour: 16, minute: 0 } as const;

/** What triggered a drain. Both run outside the feed's tick. */
export type DenominatorFlipTapeTrigger = 'eod' | 'shutdown';

/**
 * TRA-3116 — one drain's contribution to a merged tape file, in flush order.
 *
 * `processStartedAt` is the seam. Two segments carrying the SAME
 * `processStartedAt` are two drains by one process (an EOD flush followed by
 * that process's own shutdown); two segments carrying DIFFERENT ones are
 * separated by a restart, and everything between the earlier segment's
 * `flushedAt` and the later one's `processStartedAt` is time nobody observed.
 */
export interface DenominatorFlipTapeSegment {
  /** Process start of the process that produced this segment. The seam field. */
  processStartedAt: string;
  flushedAt: string;
  trigger: DenominatorFlipTapeTrigger;
  /** Rows this segment CONTRIBUTED, before any merge-time eviction. */
  rows: number;
  /** Segment-local: `drain()` resets the ring's counter, so these SUM. */
  droppedCandidates: number;
  /** Size truncation applied on this segment's own unmerged write. */
  truncatedForSize: number;
  /** This segment's own `rows + droppedCandidates`, as the ring reported it. */
  admitted: number;
}

/**
 * How much of RTH the segments actually observed.
 *
 * `rowsLostToRestart` is the field TRA-3116 asked for as `lostToRestart` and it
 * is deliberately tri-state: `0` ONLY when `uncoveredMs === 0` (nothing was
 * missed, so nothing was lost), and `null` whenever there is an uncovered
 * interval — because the rows in that interval died with their process and no
 * honest number exists for them. It is never a positive integer, and a reader
 * who sees `null` must read it as "unknown and unknowable", not as "none".
 */
export interface DenominatorFlipTapeCoverage {
  /** `null` when the date key could not be resolved to a session window. */
  rthOpenUtc: string | null;
  rthCloseUtc: string | null;
  /** Union of the segments' live intervals, clipped to RTH. */
  observedMs: number | null;
  uncoveredMs: number | null;
  rowsLostToRestart: number | null;
}

/** The serialized shape of `tape/<date>.json`. */
export interface DenominatorFlipTapeFile {
  issue: 'TRA-2689';
  date: string;
  generatedAt: string;
  /**
   * The admission rule this file's rows were selected by, carried IN the file.
   * A tape is only reinterpretable later if its own admission rule travels with
   * it — a reader a month from now must not have to guess which constants were
   * live when these rows were written.
   */
  admissionRule: {
    priceEquality: 'exact';
    changePctDeltaPp: number;
    capacity: number;
  };
  /** True when the in-process ring wrapped: `rows` is a SUFFIX of the session. */
  saturated: boolean;
  /** Candidates admitted but lost to the ring wrapping. Sum over segments. */
  droppedCandidates: number;
  /**
   * Candidates dropped by THIS writer to fit the 1 MB ceiling on a segment's own
   * unmerged write. Sum over segments. Merge-time eviction is NOT folded in
   * here — see `droppedOnMerge`.
   */
  truncatedForSize: number;
  /**
   * TRA-3116 (2b) — rows destroyed by re-applying the ring cap / 1 MB ceiling
   * across CONCATENATED segments. Cumulative across merges. No segment's own
   * counters can ever see these, which is precisely why it needs its own name.
   */
  droppedOnMerge: number;
  /**
   * Total candidates admitted, as the SUM of segment `admitted`. Deliberately
   * NOT `rows.length + droppedCandidates`: that identity dies once there are
   * three independent loss sources.
   */
  admitted: number;
  /** Every drain that landed on this date, in flush order. */
  segments: DenominatorFlipTapeSegment[];
  segmentCount: number;
  /** Adjacent segment pairs with differing `processStartedAt`. */
  restartBoundaries: number;
  coverage: DenominatorFlipTapeCoverage;
  /** `coverage.uncoveredMs === 0`. Sits beside `saturated` on purpose. */
  coverageComplete: boolean;
  /**
   * TRA-3116 (2c) — set when the prior file for this date existed but could not
   * be read or parsed. It was RENAMED to `orphanedPriorFile`, never overwritten:
   * a read failure fires precisely when the prior file may be a partial write,
   * i.e. when we have the least idea what we would be destroying, and falling
   * back to "write only the new rows" there is last-write-wins wearing a
   * merge's clothes.
   */
  mergeDegraded?: boolean;
  orphanedPriorFile?: string;
  rows: DenominatorFlipTapeDump['rows'];
}

export interface FlushResult {
  written: boolean;
  path?: string;
  rows: number;
  droppedCandidates: number;
  truncatedForSize: number;
  droppedOnMerge: number;
  saturated: boolean;
  merged: boolean;
  segmentCount: number;
  restartBoundaries: number;
  coverageComplete: boolean;
  coverage?: DenominatorFlipTapeCoverage;
  mergeDegraded?: boolean;
  orphanedPriorFile?: string;
  bytes?: number;
  prunedFiles: number;
  /** Set when the flush failed; the caller logs it and RE-ADMITS the rows. */
  error?: string;
  /**
   * TRA-3844 — the drain was REFUSED on a calendar predicate, not attempted and
   * failed. Distinct from `error` because the two demand opposite caller
   * behaviour: `error` means retry-worthy session rows are sitting in the
   * caller's hand and must go back on the ring; `skipped` means the rows are
   * off-session noise and must NOT, or they contaminate the next real session's
   * merge. A caller that keys re-admission on `!written` alone gets the wrong
   * one of those.
   */
  skipped?: boolean;
  skipReason?: string;
  /** Rows discarded by a skip. Named, never folded into another counter. */
  discardedRows?: number;
}

/** UTF-8 byte length — the ceiling is bytes on disk, not JS string length. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

/**
 * `YYYY-MM-DD.json` and `YYYY-MM-DD.orphanN.json` — never prune a file we did
 * not write, but DO count orphans against the 30-file budget so a repeatedly
 * unreadable file cannot grow retention without bound (TRA-3116, 2c). Both
 * forms lead with the ISO date, so lexical order is still date order.
 */
const TAPE_FILE_RE = /^\d{4}-\d{2}-\d{2}(?:\.orphan\d+)?\.json$/;

/** The most rows we will hold in one merged file — the ring's own cap. */
function capRowsOldestFirst(
  rows: DenominatorFlipCandidate[],
  capacity: number,
): { rows: DenominatorFlipCandidate[]; evicted: number } {
  if (!(capacity > 0)) return { rows: [], evicted: rows.length };
  if (rows.length <= capacity) return { rows, evicted: 0 };
  const evicted = rows.length - capacity;
  // Oldest-first, matching the ring's own overflow direction: what survives is
  // always a contiguous SUFFIX, never an arbitrary sample.
  return { rows: rows.slice(evicted), evicted };
}

/**
 * Serialize within the byte ceiling, dropping OLDEST rows first.
 *
 * Oldest-first matches the ring's own overflow direction, so the truncation
 * mechanisms compose into one coherent statement — the retained rows are always
 * a contiguous SUFFIX of the session's candidates, never an arbitrary sample.
 * Exported for the size test.
 *
 * TRA-3116 — `evictionField` decides WHICH named counter absorbs the loss. On a
 * segment's own unmerged write that is `truncatedForSize`, as before. On a merge
 * it is `droppedOnMerge`, because the evicted rows were finalized into an
 * earlier segment's counters before this merge existed and re-charging them to
 * `truncatedForSize` would silently inflate a counter that is supposed to mean
 * "this segment's own write did not fit".
 */
export function serializeTapeWithinBudget(
  file: DenominatorFlipTapeFile,
  maxBytes: number = DENOM_FLIP_TAPE_MAX_BYTES,
  evictionField: 'truncatedForSize' | 'droppedOnMerge' = 'truncatedForSize',
): { json: string; file: DenominatorFlipTapeFile } {
  let rows = file.rows;
  let evicted = 0;
  const withRows = (): DenominatorFlipTapeFile => ({
    ...file,
    rows,
    [evictionField]: file[evictionField] + evicted,
  });
  // Compact JSON: this is a machine-read artifact and pretty-printing it would
  // spend a third of the ceiling on whitespace.
  let json = JSON.stringify(withRows());
  while (byteLen(json) > maxBytes && rows.length > 0) {
    // Drop a proportional chunk rather than one row at a time: at 2,000 rows a
    // per-row loop would re-serialize the whole file thousands of times on the
    // EOD path.
    const over = byteLen(json) - maxBytes;
    const perRow = Math.max(1, Math.floor(byteLen(json) / Math.max(1, rows.length)));
    const drop = Math.max(1, Math.min(rows.length, Math.ceil(over / perRow) + 1));
    rows = rows.slice(drop);
    evicted += drop;
    json = JSON.stringify(withRows());
  }
  return { json, file: withRows() };
}

/**
 * TRA-3116 (part 3) — how much of RTH the segments actually observed.
 *
 * Derived from segment PROCESS START TIMES, not from drain success. That is the
 * whole point: a SIGKILL or an OOM writes no segment at all, so the dead
 * process's lifetime shows up here as an uncovered interval between the
 * surrounding segments. A coverage number computed from successful drains would
 * score exactly that case clean.
 *
 * Each segment observes `[max(processStartedAt, open), min(flushedAt, close)]`.
 * Intervals are unioned (not summed) so an EOD drain followed by that same
 * process's shutdown drain — two segments over one overlapping lifetime —
 * cannot double-count its way past 100%.
 */
export function computeTapeCoverage(
  date: string,
  segments: readonly DenominatorFlipTapeSegment[],
): DenominatorFlipTapeCoverage {
  const openMs = etWallClockToUtcMs(date, RTH_OPEN_ET.hour, RTH_OPEN_ET.minute);
  const closeMs = etWallClockToUtcMs(date, RTH_CLOSE_ET.hour, RTH_CLOSE_ET.minute);
  if (openMs == null || closeMs == null || !(closeMs > openMs)) {
    // Unknown window. Publish the ignorance rather than a plausible zero: a
    // `0` here would be indistinguishable from "nothing was observed".
    return {
      rthOpenUtc: null,
      rthCloseUtc: null,
      observedMs: null,
      uncoveredMs: null,
      rowsLostToRestart: null,
    };
  }
  const spans: Array<[number, number]> = [];
  for (const seg of segments) {
    const from = Date.parse(seg.processStartedAt);
    const to = Date.parse(seg.flushedAt);
    if (!Number.isFinite(from) || !Number.isFinite(to)) continue;
    const lo = Math.max(from, openMs);
    const hi = Math.min(to, closeMs);
    if (hi > lo) spans.push([lo, hi]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let observedMs = 0;
  let cursor = openMs;
  for (const [lo, hi] of spans) {
    const start = Math.max(lo, cursor);
    if (hi > start) {
      observedMs += hi - start;
      cursor = hi;
    }
  }
  const uncoveredMs = Math.max(0, closeMs - openMs - observedMs);
  return {
    rthOpenUtc: new Date(openMs).toISOString(),
    rthCloseUtc: new Date(closeMs).toISOString(),
    observedMs,
    uncoveredMs,
    // `0` ONLY under proven full coverage. Any uncovered interval and the rows
    // that would have been in it died with their process uncounted — `null`,
    // never a number, is the only honest value. See the module header.
    rowsLostToRestart: uncoveredMs === 0 ? 0 : null,
  };
}

/** Adjacent segment pairs produced by DIFFERENT processes. */
export function countRestartBoundaries(
  segments: readonly DenominatorFlipTapeSegment[],
): number {
  let n = 0;
  for (let i = 1; i < segments.length; i += 1) {
    if (segments[i].processStartedAt !== segments[i - 1].processStartedAt) n += 1;
  }
  return n;
}

/**
 * Structural check on a prior file before we merge onto it. Anything that fails
 * here is treated as UNREADABLE and orphaned, never silently overwritten.
 */
function isMergeableTapeFile(v: unknown): v is DenominatorFlipTapeFile {
  if (typeof v !== 'object' || v === null) return false;
  const f = v as Partial<DenominatorFlipTapeFile>;
  return Array.isArray(f.rows) && typeof f.date === 'string';
}

/** Read the prior file for this date. Distinguishes ABSENT from UNREADABLE. */
async function readPriorTapeFile(
  path: string,
): Promise<
  | { state: 'absent' }
  | { state: 'ok'; file: DenominatorFlipTapeFile }
  | { state: 'unreadable'; reason: string }
> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (err: unknown) {
    // ENOENT is the ordinary first-drain-of-the-day case and is NOT degradation.
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!isMergeableTapeFile(parsed)) {
      return { state: 'unreadable', reason: 'prior tape file failed its shape check' };
    }
    return { state: 'ok', file: parsed };
  } catch (err: unknown) {
    return { state: 'unreadable', reason: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Move an unreadable prior file aside to `<date>.orphanN.json`. Returns the new
 * name, or `null` if it could not be moved — in which case the caller must
 * REFUSE to write, because overwriting is the one outcome that is not allowed.
 */
async function orphanPriorTapeFile(dir: string, date: string): Promise<string | null> {
  for (let n = 1; n <= 20; n += 1) {
    const name = `${date}.orphan${n}.json`;
    try {
      // `rename` clobbers an existing destination, so probe first. The window
      // between probe and rename is not a concern: one process, one drain path.
      await readFile(join(dir, name), 'utf-8');
      continue;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException)?.code !== 'ENOENT') continue;
    }
    try {
      await rename(join(dir, `${date}.json`), join(dir, name));
      return name;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Merge one drain into `tape/<date>.json` and prune to the retention budget.
 *
 * NEVER THROWS. `log` is injected so the caller supplies its own structured
 * logger without this module reaching into the engine's.
 *
 * On `written: false` the caller MUST re-admit `dump.rows` to the ring
 * (TRA-3116, 2d) — `drain()` has already reset it, so a failed write otherwise
 * destroys the session even though the process is still alive.
 */
export async function flushDenominatorFlipTape(args: {
  targetDir: string;
  date: string;
  dump: DenominatorFlipTapeDump;
  admissionRule: { changePctDeltaPp: number; capacity: number };
  /** TRA-3116 — which drain trigger produced this segment. */
  trigger?: DenominatorFlipTapeTrigger;
  /** TRA-3116 — process start of THIS process; the coverage seam field. */
  processStartedAt?: string;
  now?: number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<FlushResult> {
  const { targetDir, date, dump, admissionRule } = args;
  const nowMs = args.now ?? Date.now();
  const trigger: DenominatorFlipTapeTrigger = args.trigger ?? 'eod';
  const flushedAt = new Date(nowMs).toISOString();
  const processStartedAt = args.processStartedAt ?? flushedAt;
  const base: FlushResult = {
    written: false,
    rows: 0,
    droppedCandidates: dump.droppedCandidates,
    truncatedForSize: 0,
    droppedOnMerge: 0,
    saturated: dump.saturated,
    merged: false,
    segmentCount: 0,
    restartBoundaries: 0,
    coverageComplete: false,
    prunedFiles: 0,
  };

  // TRA-3844 — the calendar predicate, ahead of every path that touches disk
  // (including `mkdir`, so a weekend drain does not even create the bucket).
  // Same `isMarketDayIso` the reader filters `barDays[]` with: one predicate,
  // one calendar, no second copy to drift. A malformed date key fails this test
  // too, which is correct — there is no session window to measure against.
  if (!isMarketDayIso(date)) {
    args.log?.warn(
      'TRA-3844 denominator-flip tape drain on a NON-MARKET ET date — refusing to mint a session file; rows DISCARDED (not re-admitted: they would merge into the next real session)',
      { date, trigger, rows: dump.rows.length, droppedCandidates: dump.droppedCandidates },
    );
    return {
      ...base,
      skipped: true,
      skipReason: 'non-market-day',
      discardedRows: dump.rows.length,
    };
  }

  try {
    const dir = join(targetDir, DENOM_FLIP_TAPE_DIR);
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${date}.json`);

    // This segment's own numbers, finalized BEFORE any merge. `dump.admitted`
    // is carried through as the ring reported it and is never re-derived.
    const segment: DenominatorFlipTapeSegment = {
      processStartedAt,
      flushedAt,
      trigger,
      rows: dump.rows.length,
      droppedCandidates: dump.droppedCandidates,
      truncatedForSize: 0,
      admitted: dump.admitted,
    };

    const prior = await readPriorTapeFile(path);
    let mergeDegraded = false;
    let orphanedPriorFile: string | undefined;
    let priorFile: DenominatorFlipTapeFile | null = null;

    if (prior.state === 'ok') {
      priorFile = prior.file;
    } else if (prior.state === 'unreadable') {
      // TRA-3116 (2c). Overwriting here is the one outcome that is not allowed:
      // it fires exactly when the prior file may be a partial write, i.e. when
      // we have the least idea what we are destroying.
      const moved = await orphanPriorTapeFile(dir, date);
      if (moved == null) {
        args.log?.warn(
          'TRA-3116 tape prior file unreadable AND could not be orphaned — REFUSING to write (rows are re-admitted)',
          { path, reason: prior.reason },
        );
        return { ...base, error: `prior tape file unreadable and unmovable: ${prior.reason}` };
      }
      mergeDegraded = true;
      orphanedPriorFile = moved;
      args.log?.warn('TRA-3116 tape prior file unreadable — orphaned, not overwritten', {
        path,
        orphanedPriorFile: moved,
        reason: prior.reason,
      });
    }

    const isMerge = priorFile != null;
    const priorRows = priorFile?.rows ?? [];
    const priorSegments = Array.isArray(priorFile?.segments) ? priorFile.segments : [];
    const segments = [...priorSegments, segment];

    // Re-apply the ring cap across the concatenation. Rows lost here were
    // finalized into an earlier segment's counters before this merge existed,
    // so they get the third name — never folded into the other two (2b).
    const capped = capRowsOldestFirst([...priorRows, ...dump.rows], admissionRule.capacity);

    const coverage = computeTapeCoverage(date, segments);
    const built: DenominatorFlipTapeFile = {
      issue: 'TRA-2689',
      date,
      generatedAt: flushedAt,
      admissionRule: {
        priceEquality: 'exact',
        changePctDeltaPp: admissionRule.changePctDeltaPp,
        capacity: admissionRule.capacity,
      },
      // Every root counter is a SUM over segments; none is re-derived from
      // `rows`, which is a suffix once anything has been evicted.
      saturated: segments.some(s => s.droppedCandidates > 0),
      droppedCandidates: segments.reduce((n, s) => n + s.droppedCandidates, 0),
      truncatedForSize: segments.reduce((n, s) => n + s.truncatedForSize, 0),
      droppedOnMerge: (priorFile?.droppedOnMerge ?? 0) + capped.evicted,
      admitted: segments.reduce((n, s) => n + s.admitted, 0),
      segments,
      segmentCount: segments.length,
      restartBoundaries: countRestartBoundaries(segments),
      coverage,
      coverageComplete: coverage.uncoveredMs === 0,
      ...(mergeDegraded ? { mergeDegraded: true, orphanedPriorFile } : {}),
      rows: capped.rows,
    };
    // On a merge, size eviction is merge-time loss too — same reasoning as the
    // ring cap above. On a first write it is this segment's own truncation.
    const { json, file } = serializeTapeWithinBudget(
      built,
      DENOM_FLIP_TAPE_MAX_BYTES,
      isMerge ? 'droppedOnMerge' : 'truncatedForSize',
    );
    // A first write that had to truncate for size belongs to THIS segment's own
    // counters, so mirror the root value back onto the segment before it goes to
    // disk — otherwise `root.truncatedForSize === sum(segments)` breaks on the
    // very next merge, which reads the segments back off this file.
    //
    // Rebuilt rather than mutated in place: `serializeTapeWithinBudget` spreads
    // shallowly, so `file.segments` aliases the array above and an in-place
    // write would be an invisible action at a distance. The few bytes this adds
    // can push the file marginally past the ceiling, which is why it is confined
    // to the unmerged branch: one drain is ring-capped at `capacity` rows
    // (2,000 => ~600 KB serialized), so a single unmerged dump cannot reach the
    // 1 MB ceiling in the first place and this branch is defensive only. Merge
    // writes, which genuinely can, route their eviction to `droppedOnMerge` and
    // never come through here.
    const finalFile: DenominatorFlipTapeFile =
      !isMerge && file.truncatedForSize > 0
        ? {
            ...file,
            segments: file.segments.map((s, i) =>
              i === file.segments.length - 1
                ? { ...s, truncatedForSize: file.truncatedForSize }
                : s,
            ),
          }
        : file;
    const finalJson = finalFile === file ? json : JSON.stringify(finalFile);
    await writeFile(path, finalJson, 'utf-8');

    // Prune oldest-first. Filenames lead with an ISO date, so lexical order IS
    // date order — no `stat` round-trip per file. Orphans count against the
    // budget (2c) so an unreadable file cannot grow retention without bound.
    let prunedFiles = 0;
    try {
      const names = (await readdir(dir)).filter((n) => TAPE_FILE_RE.test(n)).sort();
      const excess = names.length - DENOM_FLIP_TAPE_MAX_FILES;
      for (let i = 0; i < excess; i += 1) {
        await unlink(join(dir, names[i]));
        prunedFiles += 1;
      }
    } catch (err: unknown) {
      args.log?.warn('TRA-2689 tape prune failed', {
        dir,
        reason: err instanceof Error ? err.message : String(err),
      });
    }

    const result: FlushResult = {
      written: true,
      path,
      rows: file.rows.length,
      droppedCandidates: file.droppedCandidates,
      truncatedForSize: file.truncatedForSize,
      droppedOnMerge: file.droppedOnMerge,
      saturated: file.saturated,
      merged: isMerge,
      segmentCount: file.segmentCount,
      restartBoundaries: file.restartBoundaries,
      coverageComplete: file.coverageComplete,
      coverage: file.coverage,
      ...(mergeDegraded ? { mergeDegraded: true, orphanedPriorFile } : {}),
      bytes: byteLen(finalJson),
      prunedFiles,
    };
    // No silent caps: a tape that is truncated OR that only partially observed
    // its session must not read like a complete one, in the log as well as in
    // the file. `coverageComplete` is part of that test now — an untruncated
    // tape over five observed minutes of a 6.5 hour session is the exact shape
    // TRA-3116 was raised on.
    if (
      file.saturated ||
      file.truncatedForSize > 0 ||
      file.droppedOnMerge > 0 ||
      !file.coverageComplete ||
      mergeDegraded
    ) {
      args.log?.warn(
        'TRA-2689 denominator-flip tape is INCOMPLETE — do not read it as full-session coverage',
        { ...result },
      );
    } else {
      args.log?.info('TRA-2689 denominator-flip tape flushed', { ...result });
    }
    return result;
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err);
    args.log?.warn('TRA-2689 denominator-flip tape flush failed', { date, reason });
    return { ...base, error: reason };
  }
}
