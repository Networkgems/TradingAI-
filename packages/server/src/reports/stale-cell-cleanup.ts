import { readdir, readFile, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { logger } from '../observability/index.js';

// TRA-1475 (Part 2) — one-shot scrub of pre-TRA-594 corrupted calendar cells.
//
// Before TRA-594 (fixed ~2026-06-09), the demo EOD report booked the mode's
// ALL-TIME cumulative options P&L (`state.options.optionsPnl`) into every single
// calendar cell instead of the day's *realized* options P&L. The fingerprint on
// disk is unmistakable: the SAME non-zero `optionsPnl` value repeated across a
// run of consecutive report cells (e.g. `158.28` on 06-03/06-04/06-05, `-44.00`
// on 05-22/05-24/05-26) — the running total frozen into each day until the next
// option closed and bumped it. TRA-594 fixed this going forward but never
// scrubbed the historical cells already written to disk.
//
// This module is a PURE detector (`detectLeakedOptionsPnlCells`) plus a thin
// fs wrapper (`scrubStaleOptionsPnlCells`) that deletes the affected cell files.
// The board's wording was "remove the old corrupted cells", so deletion of the
// affected pre-cutoff historical cells is the accepted action. NOTHING here
// touches a post-cutoff (post-fix) cell: the detector only ever considers cells
// strictly BEFORE the cutoff, so a coincidental value match on a clean post-fix
// day can never be swept in.

const log = logger.child({ module: 'stale-cell-cleanup' });

/**
 * The TRA-594 fix boundary (ET calendar day). Cells dated on/after this are
 * post-fix (correct per-day realized options P&L) and are NEVER touched. The
 * fix landed ~2026-06-09; using the day itself as the exclusive upper bound
 * keeps any 06-09 cell (already written by the fixed code path) safe.
 */
export const TRA594_STALE_CELL_CUTOFF = '2026-06-09';

/** Minimal shape the detector needs from a report cell. */
export interface StaleCellInput {
  /** `YYYY-MM-DD` (lexicographically sortable, ET calendar day). */
  date: string;
  /** The cell's booked options P&L (the field the leak corrupted). */
  optionsPnl: number;
}

/**
 * Return the dates of the leaked cells to remove — pre-cutoff cells whose
 * non-zero `optionsPnl` is repeated across a run of ≥2 consecutive (in
 * date-sorted order) pre-cutoff cells. That repeated-run signature is the
 * frozen cumulative total; an isolated single value (a genuine one-day close,
 * or the day the cumulative last changed) is left untouched, so no clean cell is
 * removed. Cells on/after `cutoff` are excluded from the sequence entirely, so
 * post-fix cells are guaranteed safe. Pure — no I/O.
 */
export function detectLeakedOptionsPnlCells(
  cells: readonly StaleCellInput[],
  cutoff: string = TRA594_STALE_CELL_CUTOFF,
): string[] {
  const pre = cells
    .filter((c) => c.date < cutoff && Number.isFinite(c.optionsPnl))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  const leaked: string[] = [];
  let i = 0;
  while (i < pre.length) {
    const value = pre[i]!.optionsPnl;
    // Extend the maximal run of identical consecutive optionsPnl.
    let j = i + 1;
    while (j < pre.length && pre[j]!.optionsPnl === value) j += 1;
    const runLen = j - i;
    // A run of ≥2 identical NON-ZERO cells is the frozen cumulative leak. Zero
    // is a legitimately flat (no-options) day and never a leak.
    if (runLen >= 2 && value !== 0) {
      for (let k = i; k < j; k += 1) leaked.push(pre[k]!.date);
    }
    i = j;
  }
  return leaked;
}

const CELL_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.json$/;

/**
 * Delete the pre-TRA-594 leaked cell files under one user's `reports/demo`
 * directory (the `<date>.json` plus a sibling `<date>.md` if present). Returns
 * the removed dates. No-op (returns `[]`) when the directory is absent. Reads
 * only `YYYY-MM-DD.json` cells (skips `latest.json` and any non-cell file).
 */
export async function scrubStaleOptionsPnlCells(
  demoReportsDir: string,
  cutoff: string = TRA594_STALE_CELL_CUTOFF,
): Promise<string[]> {
  if (!existsSync(demoReportsDir)) return [];
  let entries: string[];
  try {
    entries = await readdir(demoReportsDir);
  } catch {
    return [];
  }

  const cells: StaleCellInput[] = [];
  for (const name of entries) {
    const m = CELL_FILE_RE.exec(name);
    if (!m) continue;
    const date = m[1]!;
    if (date >= cutoff) continue; // never read/consider post-fix cells
    try {
      const raw = await readFile(join(demoReportsDir, name), 'utf-8');
      const parsed = JSON.parse(raw) as { optionsPnl?: unknown };
      const optionsPnl = typeof parsed.optionsPnl === 'number' ? parsed.optionsPnl : 0;
      cells.push({ date, optionsPnl });
    } catch {
      // Unreadable/corrupt cell — leave it; a scrub shouldn't destroy what it
      // can't classify.
    }
  }

  const leaked = detectLeakedOptionsPnlCells(cells, cutoff);
  const removed: string[] = [];
  for (const date of leaked) {
    let gone = false;
    for (const ext of ['json', 'md']) {
      const path = join(demoReportsDir, `${date}.${ext}`);
      if (!existsSync(path)) continue;
      try {
        await unlink(path);
        gone = true;
      } catch {
        // file vanished mid-iteration; ignore
      }
    }
    if (gone) removed.push(date);
  }
  if (removed.length > 0) {
    log.info('scrubbed pre-TRA-594 leaked options-pnl cells', {
      dir: demoReportsDir,
      count: removed.length,
      dates: removed,
    });
  }
  return removed;
}
