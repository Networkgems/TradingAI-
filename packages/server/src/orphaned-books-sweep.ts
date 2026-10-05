// TRA-5134 — execute the TRA-5132 board ruling (card 10dfc4b1): bulk-retire every
// orphaned book tree under `users/` through the proven TRA-2410 machinery.
//
// MOVE-ONLY. This module deletes nothing, and neither does anything it calls on
// the move path: `retireOrphanedBook` tombstones, MOVES the tree to
// `orphaned-books/<name>@<stamp>/`, archives the `account_settings` row with
// credentials blanked, and sweeps identity rows. What this module adds is the
// POPULATION (every on-disk book dir with no registry row, where TRA-2410's
// adoption path is single-name) and the WITNESSES the ruling requires:
//
//  • Per-tree zero-deletion witness: file count + byte size walked immediately
//    before the move and re-walked at the landed path after it. The landed walk
//    excludes `account-settings-row.json`, which the retirement itself writes
//    INTO the quarantined tree — everything else must match exactly.
//  • Freshness: the orphan residue is static (last writes 2026-10-01 EOD, pre-
//    dereg). Any tree whose newest mtime is at or after sweep start is SKIPPED
//    and reported, never moved.
//  • The registered books are inventoried before and after and must be
//    byte-identical and mtime-identical.
//
// ── Fail-closed guards, because the registry decides who lives ────────────────
//
// Orphan = dir name with NO row in the credential registry AT SWEEP START. The
// registry read is therefore the single most dangerous input: `loadUsers` parses
// `users.json` with a `catch { users = [] }`, so a corrupt registry file reads as
// an EMPTY roster — under which every book on disk, the four live ones included,
// classifies as an orphan. Two refusals close that:
//
//  1. An empty registry refuses the sweep outright.
//  2. A registry that intersects the on-disk dirs in ZERO names refuses too —
//     if not one registered account has a book, this process is looking at the
//     wrong disk or the wrong registry, and the honest answer is "refused", not
//     "251 orphans".
//
// Registered-name matching is case-INsensitive on purpose: it can only shrink
// the move set, and a case-variant dir of a live name is exactly the tree a
// case-sensitive sweep would retire out from under a case-insensitive login.
//
// NOT hooked to boot, by design (TRA-5132 ruling text). The only caller is the
// admin-gated route in `index.ts`; the only sanctioned driver is
// `scripts/tra5134-retire-orphans.mjs`, dry-run first.

import { readdir, stat } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { resolveDataDir } from './data-dir.js';
import {
  retireOrphanedBook,
  ORPHANED_BOOKS_DIRNAME,
  RETIRED_SETTINGS_FILENAME,
} from './orphaned-books.js';
import { isPathSafeUsername } from './username-grammar.js';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'orphaned-books-sweep' });

/** files + bytes + newest mtime across a tree. The zero-deletion witness unit. */
export interface TreeWitness {
  files: number;
  bytes: number;
  /** Newest mtime (ms) across files AND directories; null for an empty tree. */
  newestMtimeMs: number | null;
}

export interface OrphanSweepRow {
  name: string;
  before: TreeWitness;
  /**
   * Walk of the landed tree, EXCLUDING the top-level `account-settings-row.json`
   * the retirement archives into it. Null when the tree was not moved.
   */
  after: TreeWitness | null;
  /** before/after file count and byte size match exactly. */
  byteComplete: boolean;
  moved: boolean;
  /** Why this row was not moved: `write_after_sweep_start` | `unsafe_name` | `dry_run`. */
  skipped: string | null;
  quarantinedTo: string | null;
  /** `retireOrphanedBook`'s own verdict (tombstone armed, key clear, rows swept). */
  receiptOk: boolean | null;
  settingsRowFound: boolean | null;
  settingsRowRetired: boolean | null;
  settingsCredentialFieldsCleared: number | null;
  identityRowsDeleted: number | null;
  /** Operator-only strings from the receipt; may name absolute paths. */
  errors: string[];
  /** moved && byteComplete && receiptOk — the row-level verdict. */
  ok: boolean;
}

export interface RegisteredBookWitness {
  name: string;
  dirExists: boolean;
  before: TreeWitness | null;
  after: TreeWitness | null;
  untouched: boolean;
}

export interface OrphanSweepResult {
  sweepStartedAt: number;
  apply: boolean;
  /** Non-null ⇒ nothing was examined past the guard that fired, nothing moved. */
  refused: 'empty_registry' | 'registry_disk_disjoint' | null;
  registeredUsers: number;
  bookDirsOnDisk: number;
  /** Entries under users/ that are not directories — reported, never touched. */
  nonDirectoryEntries: string[];
  orphanCount: number;
  rows: OrphanSweepRow[];
  /** Orphans beyond `limit`, present on disk but not processed this call. */
  remainingBeyondLimit: number;
  moved: number;
  skippedCount: number;
  failures: number;
  totals: {
    bytesBefore: number;
    filesBefore: number;
    bytesAfter: number;
    filesAfter: number;
  };
  /** All moved rows byte-complete AND zero failures — the ruling's witness #4. */
  zeroDeletionWitness: boolean;
  registeredBooks: RegisteredBookWitness[];
  registeredUntouched: boolean;
  /** Dir count under users/ after the sweep; equals bookDirsOnDisk on dry run. */
  bookDirsOnDiskAfter: number;
}

async function walkTree(root: string): Promise<TreeWitness> {
  let files = 0;
  let bytes = 0;
  let newest: number | null = null;
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue; // vanished mid-walk — the before/after comparison will catch it
    }
    const dirStat = await stat(dir).catch(() => null);
    if (dirStat && (newest === null || dirStat.mtimeMs > newest)) newest = dirStat.mtimeMs;
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        stack.push(p);
      } else {
        const s = await stat(p).catch(() => null);
        if (s) {
          files += 1;
          bytes += s.size;
          if (newest === null || s.mtimeMs > newest) newest = s.mtimeMs;
        }
      }
    }
  }
  return { files, bytes, newestMtimeMs: newest };
}

/** Walk the landed tree, skipping the settings-row archive the retirement adds. */
async function walkLandedTree(root: string): Promise<TreeWitness> {
  const full = await walkTree(root);
  const archive = join(root, RETIRED_SETTINGS_FILENAME);
  if (existsSync(archive)) {
    const s = await stat(archive).catch(() => null);
    if (s) {
      full.files -= 1;
      full.bytes -= s.size;
    }
  }
  return full;
}

async function listBookDirs(usersRoot: string): Promise<{ dirs: string[]; nonDirs: string[] }> {
  if (!existsSync(usersRoot)) return { dirs: [], nonDirs: [] };
  const entries = await readdir(usersRoot, { withFileTypes: true });
  const dirs: string[] = [];
  const nonDirs: string[] = [];
  for (const e of entries) (e.isDirectory() ? dirs : nonDirs).push(e.name);
  return { dirs, nonDirs };
}

/**
 * Enumerate, classify, witness, and (when `apply`) retire every orphaned book
 * tree. Dry run (`apply: false`) performs the identical enumeration and walks
 * and moves NOTHING — the move plan it prints is the plan `apply` executes.
 */
export async function sweepOrphanedBooks(opts: {
  /** Raw usernames out of the credential store, read by the caller AT SWEEP START. */
  registeredUsernames: string[];
  apply: boolean;
  /** Max orphans to process this call; the rest are counted, untouched. */
  limit?: number;
  dataDir?: string;
  now?: number;
}): Promise<OrphanSweepResult> {
  const dataDir = opts.dataDir ?? resolveDataDir();
  const sweepStartedAt = opts.now ?? Date.now();
  const usersRoot = join(dataDir, 'users');
  const registered = opts.registeredUsernames;
  const registeredLower = new Set(registered.map((n) => n.toLowerCase()));

  const { dirs, nonDirs } = await listBookDirs(usersRoot);

  const base: OrphanSweepResult = {
    sweepStartedAt,
    apply: opts.apply,
    refused: null,
    registeredUsers: registered.length,
    bookDirsOnDisk: dirs.length,
    nonDirectoryEntries: nonDirs,
    orphanCount: 0,
    rows: [],
    remainingBeyondLimit: 0,
    moved: 0,
    skippedCount: 0,
    failures: 0,
    totals: { bytesBefore: 0, filesBefore: 0, bytesAfter: 0, filesAfter: 0 },
    zeroDeletionWitness: false,
    registeredBooks: [],
    registeredUntouched: false,
    bookDirsOnDiskAfter: dirs.length,
  };

  if (registered.length === 0) {
    base.refused = 'empty_registry';
    log.error('orphan sweep REFUSED: registry is empty — a corrupt users.json reads as []', {});
    return base;
  }
  const overlap = dirs.filter((d) => registeredLower.has(d.toLowerCase()));
  if (dirs.length > 0 && overlap.length === 0) {
    base.refused = 'registry_disk_disjoint';
    log.error('orphan sweep REFUSED: no registered account has a book dir on this disk', {
      registeredUsers: registered.length,
      bookDirsOnDisk: dirs.length,
    });
    return base;
  }

  // Registered-book inventory, BEFORE anything moves (ruling acceptance #5).
  for (const name of registered) {
    const dir = join(usersRoot, name);
    const dirExists = existsSync(dir);
    base.registeredBooks.push({
      name,
      dirExists,
      before: dirExists ? await walkTree(dir) : null,
      after: null,
      untouched: false,
    });
  }

  const orphans = dirs.filter((d) => !registeredLower.has(d.toLowerCase())).sort();
  base.orphanCount = orphans.length;
  const limit = opts.limit ?? orphans.length;
  const slice = orphans.slice(0, Math.max(0, limit));
  base.remainingBeyondLimit = orphans.length - slice.length;

  for (const name of slice) {
    const before = await walkTree(join(usersRoot, name));
    const row: OrphanSweepRow = {
      name,
      before,
      after: null,
      byteComplete: false,
      moved: false,
      skipped: null,
      quarantinedTo: null,
      receiptOk: null,
      settingsRowFound: null,
      settingsRowRetired: null,
      settingsCredentialFieldsCleared: null,
      identityRowsDeleted: null,
      errors: [],
      ok: false,
    };
    base.rows.push(row);
    base.totals.bytesBefore += before.bytes;
    base.totals.filesBefore += before.files;

    // The residue is static; a tree that gained a write since sweep start is a
    // live book by behaviour whatever the registry says. Skip and report.
    if (before.newestMtimeMs !== null && before.newestMtimeMs >= sweepStartedAt) {
      row.skipped = 'write_after_sweep_start';
      continue;
    }
    // `retireOrphanedBook` fail-closes on these anyway (TRA-4475); classifying
    // here keeps a weird legacy dir name a reported SKIP, not a sweep failure.
    if (!isPathSafeUsername(name)) {
      row.skipped = 'unsafe_name';
      continue;
    }
    if (!opts.apply) {
      row.skipped = 'dry_run';
      continue;
    }

    const receipt = await retireOrphanedBook(name, { dataDir, now: opts.now });
    row.receiptOk = receipt.ok;
    row.quarantinedTo = receipt.quarantinedTo;
    row.settingsRowFound = receipt.settingsRowFound;
    row.settingsRowRetired = receipt.settingsRowRetired;
    row.settingsCredentialFieldsCleared = receipt.settingsCredentialFieldsCleared;
    row.identityRowsDeleted = receipt.identityRowsDeleted;
    row.errors = receipt.errors;
    row.moved = receipt.quarantinedTo !== null;

    if (row.moved && receipt.quarantinedTo) {
      row.after = await walkLandedTree(join(dataDir, receipt.quarantinedTo));
      row.byteComplete =
        row.after.files === before.files && row.after.bytes === before.bytes;
      base.totals.bytesAfter += row.after.bytes;
      base.totals.filesAfter += row.after.files;
    }
    row.ok = row.moved && row.byteComplete && receipt.ok;
    log[row.ok ? 'info' : 'error']('orphan sweep: tree retired', {
      ticket: 'TRA-5134',
      name,
      files: before.files,
      bytes: before.bytes,
      landedFiles: row.after?.files ?? null,
      landedBytes: row.after?.bytes ?? null,
      byteComplete: row.byteComplete,
      receiptOk: receipt.ok,
      quarantinedTo: receipt.quarantinedTo,
      errors: receipt.errors,
    });
  }

  base.moved = base.rows.filter((r) => r.moved).length;
  base.skippedCount = base.rows.filter((r) => r.skipped !== null && r.skipped !== 'dry_run').length;
  base.failures = base.rows.filter(
    (r) => r.skipped === null && !r.ok,
  ).length;
  base.zeroDeletionWitness =
    base.failures === 0 && base.rows.filter((r) => r.moved).every((r) => r.byteComplete);

  // Registered-book inventory AFTER (identical on a dry run, and asserted so).
  let registeredUntouched = true;
  for (const rb of base.registeredBooks) {
    const dir = join(usersRoot, rb.name);
    rb.after = existsSync(dir) ? await walkTree(dir) : null;
    rb.untouched =
      rb.dirExists === (rb.after !== null) &&
      (!rb.before || !rb.after ||
        (rb.before.files === rb.after.files &&
          rb.before.bytes === rb.after.bytes &&
          rb.before.newestMtimeMs === rb.after.newestMtimeMs));
    if (!rb.untouched) registeredUntouched = false;
  }
  base.registeredUntouched = registeredUntouched;
  base.bookDirsOnDiskAfter = (await listBookDirs(usersRoot)).dirs.length;

  log.info('orphan sweep complete', {
    ticket: 'TRA-5134',
    apply: opts.apply,
    registeredUsers: base.registeredUsers,
    bookDirsOnDisk: base.bookDirsOnDisk,
    bookDirsOnDiskAfter: base.bookDirsOnDiskAfter,
    orphanCount: base.orphanCount,
    moved: base.moved,
    skipped: base.skippedCount,
    failures: base.failures,
    zeroDeletionWitness: base.zeroDeletionWitness,
    registeredUntouched: base.registeredUntouched,
    totals: base.totals,
  });
  return base;
}
