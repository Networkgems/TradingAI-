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
 * - The feed NEVER writes. This runs on the EOD archive path only.
 *
 * ## Failure posture
 *
 * This can never throw into report generation. The EOD report is a human-read
 * money artifact and this is go-live week; a tape is worth exactly zero of that.
 * Every path returns a status object and logs; nothing propagates.
 *
 * ## No silent caps
 *
 * Two independent truncation sources, and BOTH are stamped in the file:
 * `droppedCandidates`/`saturated` (the in-process ring wrapped — see
 * `denominator-flip-tape.ts`) and `truncatedForSize` (this writer dropped rows to
 * fit 1 MB). Nobody may compute a false-positive rate over a truncated tape and
 * report it as complete coverage, so a reader that ignores these fields is
 * misreading the artifact and the field names are chosen to make that obvious.
 */

import { writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { join } from 'path';
import type { DenominatorFlipTapeDump } from './denominator-flip-tape.js';

/** Sub-directory of the report bucket the tape lives in. */
export const DENOM_FLIP_TAPE_DIR = 'tape';
/** Hard per-file ceiling from the ruling. */
export const DENOM_FLIP_TAPE_MAX_BYTES = 1024 * 1024;
/** Hard retention from the ruling. */
export const DENOM_FLIP_TAPE_MAX_FILES = 30;

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
  /** Candidates admitted but lost to the ring wrapping. */
  droppedCandidates: number;
  /** Candidates admitted but dropped by THIS writer to fit the 1 MB ceiling. */
  truncatedForSize: number;
  /** Total candidates admitted this session. */
  admitted: number;
  rows: DenominatorFlipTapeDump['rows'];
}

export interface FlushResult {
  written: boolean;
  path?: string;
  rows: number;
  droppedCandidates: number;
  truncatedForSize: number;
  saturated: boolean;
  bytes?: number;
  prunedFiles: number;
  /** Set when the flush failed; the caller logs it and carries on. */
  error?: string;
}

/** UTF-8 byte length — the ceiling is bytes on disk, not JS string length. */
function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf-8');
}

/** `YYYY-MM-DD.json` only — never prune a file we did not write. */
const TAPE_FILE_RE = /^\d{4}-\d{2}-\d{2}\.json$/;

/**
 * Serialize within the byte ceiling, dropping OLDEST rows first.
 *
 * Oldest-first matches the ring's own overflow direction, so the two truncation
 * mechanisms compose into one coherent statement — the retained rows are always
 * a contiguous SUFFIX of the session's candidates, never an arbitrary sample.
 * Exported for the size test.
 */
export function serializeTapeWithinBudget(
  file: DenominatorFlipTapeFile,
  maxBytes: number = DENOM_FLIP_TAPE_MAX_BYTES,
): { json: string; file: DenominatorFlipTapeFile } {
  let rows = file.rows;
  let truncated = file.truncatedForSize;
  // Compact JSON: this is a machine-read artifact and pretty-printing it would
  // spend a third of the ceiling on whitespace.
  let json = JSON.stringify({ ...file, rows, truncatedForSize: truncated });
  while (byteLen(json) > maxBytes && rows.length > 0) {
    // Drop a proportional chunk rather than one row at a time: at 2,000 rows a
    // per-row loop would re-serialize the whole file thousands of times on the
    // EOD path.
    const over = byteLen(json) - maxBytes;
    const perRow = Math.max(1, Math.floor(byteLen(json) / Math.max(1, rows.length)));
    const drop = Math.max(1, Math.min(rows.length, Math.ceil(over / perRow) + 1));
    rows = rows.slice(drop);
    truncated += drop;
    json = JSON.stringify({ ...file, rows, truncatedForSize: truncated });
  }
  return { json, file: { ...file, rows, truncatedForSize: truncated } };
}

/**
 * Write one session's tape and prune to the retention budget.
 *
 * NEVER THROWS. `log` is injected so the caller supplies its own structured
 * logger without this module reaching into the engine's.
 */
export async function flushDenominatorFlipTape(args: {
  targetDir: string;
  date: string;
  dump: DenominatorFlipTapeDump;
  admissionRule: { changePctDeltaPp: number; capacity: number };
  now?: number;
  log?: {
    info: (msg: string, meta?: Record<string, unknown>) => void;
    warn: (msg: string, meta?: Record<string, unknown>) => void;
  };
}): Promise<FlushResult> {
  const { targetDir, date, dump, admissionRule } = args;
  const base: FlushResult = {
    written: false,
    rows: 0,
    droppedCandidates: dump.droppedCandidates,
    truncatedForSize: 0,
    saturated: dump.saturated,
    prunedFiles: 0,
  };
  try {
    const dir = join(targetDir, DENOM_FLIP_TAPE_DIR);
    await mkdir(dir, { recursive: true });

    const built: DenominatorFlipTapeFile = {
      issue: 'TRA-2689',
      date,
      generatedAt: new Date(args.now ?? Date.now()).toISOString(),
      admissionRule: {
        priceEquality: 'exact',
        changePctDeltaPp: admissionRule.changePctDeltaPp,
        capacity: admissionRule.capacity,
      },
      saturated: dump.saturated,
      droppedCandidates: dump.droppedCandidates,
      truncatedForSize: 0,
      admitted: dump.admitted,
      rows: dump.rows,
    };
    const { json, file } = serializeTapeWithinBudget(built);
    const path = join(dir, `${date}.json`);
    await writeFile(path, json, 'utf-8');

    // Prune oldest-first. Filenames are ISO dates, so lexical order IS date
    // order — no `stat` round-trip per file.
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

    const bytes = byteLen(json);
    const result: FlushResult = {
      written: true,
      path,
      rows: file.rows.length,
      droppedCandidates: file.droppedCandidates,
      truncatedForSize: file.truncatedForSize,
      saturated: file.saturated,
      bytes,
      prunedFiles,
    };
    // No silent caps: a truncated tape must not read like a complete one, in the
    // log as well as in the file.
    if (file.saturated || file.truncatedForSize > 0) {
      args.log?.warn('TRA-2689 denominator-flip tape is TRUNCATED — rows are a suffix of the session', { ...result });
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
