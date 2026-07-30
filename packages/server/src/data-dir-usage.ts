/**
 * TRA-2420 — per-subdirectory byte attribution for `DATA_DIR`.
 *
 * ## Why this exists
 *
 * TRA-2417 measured `/data` on bqb1 growing **~11.6 MB per trading day, ~0 on
 * weekends**, and attributed it to the TRA-779 option-chain capture. That was
 * right about the majority and wrong about the whole: the real 2026-07-24
 * partition is **8.02 MB** and the sentiment snapshots are **0.008 MB**, which
 * leaves **~3.6 MB per trading day with no owner and no name**. A total minus
 * one measured component is not an attribution — it is a residual, and an
 * unnamed residual is the shape of thing that gets rediscovered as an incident.
 *
 * There is no shell on bqb1, so the number has to be published by a route. This
 * module is the measurement behind `GET /api/health/storage/detail` (admin-only
 * since TRA-2599; it was `GET /api/health/storage` when this was written).
 *
 * ## The part that is easy to get wrong
 *
 * A directory-size snapshot answers "how big is it", not "what is GROWING".
 * Those are different questions and the second one is the ask. Two snapshots a
 * day apart would answer it, but slowly, and the answer is confounded by the
 * TRA-2417 compactor moving hundreds of megabytes on any boot.
 *
 * So the walk buckets bytes by day **twice**, and the difference between the two
 * histograms is the whole point:
 *
 * - `modifiedBytesByDay` — bytes of files whose **mtime** lands on that day.
 *   A per-user `trades-stocks.json` that is rewritten in place every session
 *   contributes its ENTIRE size here every single day while adding nothing to
 *   the volume. Read alone, this histogram will confidently name the wrong
 *   writer.
 * - `createdBytesByDay` — bytes of files whose **birthtime** lands on that day.
 *   This is the one that corresponds to disk growth: a file that did not exist
 *   yesterday is bytes the volume did not hold yesterday. In-place rewriters
 *   drop out of it entirely.
 *
 * `birthtime` is not universally available — libuv reports epoch-0 on
 * filesystems without `statx` birth support. When that happens the created
 * histogram is emitted as **`null`, never as zeros**: a directory that created
 * nothing and a filesystem that cannot say are the same number otherwise, and
 * the zero reads like an exoneration. Same reason `truncated` exists — a capped
 * walk publishes a floor, and a floor that looks like a total is worse than no
 * number.
 *
 * ⚠️ Compaction and attribution: gzipping a partition creates `X.json.gz`
 * (today's birthtime) and unlinks `X.json`. On a boot that compacts,
 * `option-chains` will show a large `createdBytes` for that day against a large
 * NEGATIVE change in actual bytes held. The histogram covers several days
 * precisely so one such day can be recognised and stepped over rather than
 * mistaken for the daily slope.
 *
 * ## No PII in the breakdown — and do NOT relax this
 *
 * ⚠️ The original justification here has EXPIRED and is kept only so the next
 * reader does not re-derive it. It read: "`/api/health/storage` is open, like the
 * other health probes." That was true when written and is now false —
 * **TRA-2599** moved this block to `GET /api/health/storage/detail` behind
 * `requireAuth, requireAdmin`, because TRA-2414 found the route publishing
 * `dataDir`, the account count and `users.json`'s mtime to anonymous callers.
 *
 * The design below is retained anyway, and the gate is not a licence to widen it:
 *
 *  - Per-user files live at `DATA_DIR/users/<username>/…`, so a naive
 *    one-level-deeper breakdown would publish the user list. Instead each
 *    top-level entry reports its heaviest **basename patterns** (digits and dates
 *    normalised: `eod-2026-07-24.json` → `eod-<date>.json`), which names the
 *    WRITER — the thing being hunted — and never the user.
 *  - "It is admin-only now" is a weaker guarantee than it sounds: this same
 *    object is the input to `projectStorageLiveness`, an admin token is a 24h
 *    stateless HMAC, and the route is one middleware argument away from open.
 *    A breakdown that never holds a username cannot leak one through any of those.
 *
 * So: patterns, not paths, regardless of who can read the route.
 */

import { readdir, stat, lstat } from 'fs/promises';
import type { Dirent } from 'fs';
import { join } from 'path';

/** Days of history in the per-day histograms. */
export const DEFAULT_HISTOGRAM_DAYS = 7;

/**
 * Hard cap on files visited per scan. `/data` holds a few thousand; this is a
 * runaway guard, not a tuning knob. Hitting it sets `truncated`, which makes
 * every byte figure in the report a floor.
 */
export const DEFAULT_MAX_FILES = 200_000;

/** Basename patterns reported per top-level entry, heaviest first. */
export const DEFAULT_TOP_PATTERNS = 8;

export interface FilePatternUsage {
  /** Basename with dates and digit runs normalised. Never contains a username. */
  pattern: string;
  files: number;
  bytes: number;
  /**
   * Bytes of files in this pattern CREATED inside the histogram window.
   * `null` when birthtime is unusable — not `0`, which would read as "this
   * writer added nothing".
   */
  createdBytesInWindow: number | null;
}

export interface DataDirEntryUsage {
  /** Top-level name under `DATA_DIR`. */
  name: string;
  kind: 'dir' | 'file' | 'other';
  /** Apparent bytes, recursive. */
  bytes: number;
  /**
   * TRA-2420 — allocated bytes, recursive (`st_blocks * 512`, including this
   * entry's directory inodes). This is the unit `df` reports, so it is the only
   * one comparable against `disk.usedBytes`. `null` when the filesystem declined.
   */
  allocatedBytes: number | null;
  files: number;
  dirs: number;
  newestMtime: string | null;
  /** UTC date -> bytes of files last modified that day. Rewrites inflate this. */
  modifiedBytesByDay: Record<string, number>;
  /** UTC date -> bytes of files created that day. `null` if birthtime is unusable. */
  createdBytesByDay: Record<string, number> | null;
  /** Heaviest basename patterns inside this entry. */
  byFile: FilePatternUsage[];
}

export interface DataDirUsage {
  root: string;
  scannedAt: string;
  durationMs: number;
  /** Apparent bytes across every entry. A floor when `truncated`. */
  totalBytes: number;
  /**
   * TRA-2420 — allocated bytes across every entry, i.e. what `df` counts. Always
   * >= `totalBytes` on a non-sparse tree; the gap is block rounding, which on a
   * volume of ~48k small files is worth ~100 MB and used to land in the
   * `unaccounted` residual as a phantom writer. `null` when unmeasurable.
   */
  totalAllocatedBytes: number | null;
  totalFiles: number;
  /** Heaviest first. */
  entries: DataDirEntryUsage[];
  /** UTC dates the histograms cover, newest first. */
  days: string[];
  /**
   * Whether `createdBytesByDay` means anything on this filesystem, and the
   * evidence for that call. `usable: false` is the reason those histograms are
   * `null` rather than empty.
   */
  birthtime: {
    usable: boolean;
    sampledFiles: number;
    /** Files whose birthtime was epoch-0 — i.e. the filesystem declined to say. */
    missing: number;
    /** Files whose birthtime differs from their mtime; 0 across a big sample means birthtime is really ctime. */
    distinctFromMtime: number;
  };
  /**
   * TRA-2420 — whether `allocatedBytes` means anything on this filesystem.
   * `usable: false` is the reason those figures are `null` rather than 0.
   */
  allocation: {
    usable: boolean;
    /** Files, symlinks and directories we asked `st_blocks` of. */
    sampledPaths: number;
    /**
     * Paths that reported a POSITIVE block count. Zero of these alongside
     * `nonEmptyPaths > 0` is the wholesale decline that makes allocation
     * unusable. A per-path zero is normal — NTFS keeps sub-KiB files resident in
     * the MFT and a sparse file allocates less than its size.
     */
    answeredPaths: number;
    /** Paths with `size > 0`. A tree of only-empty files allocating 0 is not a decline. */
    nonEmptyPaths: number;
  };
  /** True if the walk hit `maxFiles`. Every byte figure is then a floor. */
  truncated: boolean;
  /** Directories that could not be read, with the reason. Never silently dropped. */
  errors: Array<{ path: string; reason: string }>;
}

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Basename with the varying parts collapsed, so a per-day/per-user family of
 * files reports as ONE writer. `2026-07-24` → `<date>` first, so a date is not
 * shredded into three `<n>`s.
 */
export function filePattern(basename: string): string {
  return basename
    .replace(/\d{4}-\d{2}-\d{2}/g, '<date>')
    .replace(/\d{4}\d{2}\d{2}/g, '<date>')
    .replace(/\d+/g, '<n>');
}

interface WalkAcc {
  bytes: number;
  files: number;
  dirs: number;
  newestMtimeMs: number | null;
  modified: Map<string, number>;
  created: Map<string, number>;
  patterns: Map<string, { files: number; bytes: number; createdBytes: number }>;
  /** TRA-2420 — allocated bytes (`st_blocks * 512`), the unit `df` counts in. */
  allocated: number;
}

function emptyAcc(): WalkAcc {
  return {
    bytes: 0,
    files: 0,
    dirs: 0,
    allocated: 0,
    newestMtimeMs: null,
    modified: new Map(),
    created: new Map(),
    patterns: new Map(),
  };
}

function bump(m: Map<string, number>, key: string, n: number): void {
  m.set(key, (m.get(key) ?? 0) + n);
}

interface ScanState {
  windowStartMs: number;
  daySet: Set<string>;
  maxFiles: number;
  filesVisited: number;
  truncated: boolean;
  birthSampled: number;
  birthMissing: number;
  birthDistinct: number;
  /** TRA-2420 — paths we asked `st_blocks` of, and how many answered positively. */
  blocksSampled: number;
  blocksPositive: number;
  /** Paths with `size > 0`; a tree of only-empty files allocating 0 is not a decline. */
  nonEmptySampled: number;
  errors: Array<{ path: string; reason: string }>;
}

/**
 * TRA-2420 — allocated bytes for one stat, or `null` if the filesystem declined
 * to say. A non-empty file reporting `blocks: 0` is a decline, not a real zero;
 * an EMPTY file reporting 0 is a true zero. Getting that backwards makes an
 * unmeasurable volume read as "nothing is allocated", which is the same
 * false-zero class as the birthtime handling above.
 */
function countAllocated(acc: WalkAcc, state: ScanState, s: { size: number; blocks?: number }): void {
  state.blocksSampled += 1;
  if (s.size > 0) state.nonEmptySampled += 1;
  if (typeof s.blocks !== 'number' || !Number.isFinite(s.blocks) || s.blocks <= 0) return;
  state.blocksPositive += 1;
  acc.allocated += s.blocks * 512;
}

/**
 * TRA-2420 — whether `st_blocks` means anything on this filesystem.
 *
 * The failure this guards is WHOLESALE: a platform or filesystem that reports 0
 * blocks for everything. `allocatedBytes` would then be 0 on a volume holding
 * real data — a false zero that reads as "nothing is allocated" and makes the
 * `/api/health/storage/detail` residual equal the entire disk.
 *
 * Exported for direct test: a declining filesystem cannot be produced by writing
 * files to a real one, so this branch would otherwise have no failing state.
 */
export function allocationUsable(s: {
  blocksSampled: number;
  blocksPositive: number;
  nonEmptySampled: number;
}): boolean {
  if (s.blocksSampled === 0) return false; // nothing was proven either way
  // Everything reported zero WHILE non-empty files exist ⇒ the filesystem declined.
  if (s.blocksPositive === 0 && s.nonEmptySampled > 0) return false;
  return true;
}

async function walk(dir: string, acc: WalkAcc, state: ScanState): Promise<void> {
  let items;
  try {
    items = await readdir(dir, { withFileTypes: true });
  } catch (err) {
    state.errors.push({ path: dir, reason: err instanceof Error ? err.message : String(err) });
    return;
  }
  for (const item of items) {
    if (state.filesVisited >= state.maxFiles) {
      state.truncated = true;
      return;
    }
    const full = join(dir, item.name);
    // Symlinks are NOT followed: a link into another tree would double-count its
    // bytes against a volume that only holds them once, and a cycle would hang
    // the walk. `lstat` on them, count the link itself, do not descend.
    if (item.isSymbolicLink()) {
      state.filesVisited += 1;
      try {
        const s = await lstat(full);
        acc.bytes += s.size;
        acc.files += 1;
        countAllocated(acc, state, s);
      } catch {
        /* raced away between readdir and lstat — nothing to count */
      }
      continue;
    }
    if (item.isDirectory()) {
      acc.dirs += 1;
      // A directory occupies blocks too, and `backups/` holds 37k files across
      // hundreds of them. Counting only files leaves that mass in the residual,
      // where it reads as an unattributed writer. Not counted as a file, and it
      // does not consume the `maxFiles` budget, so truncation semantics are unchanged.
      try {
        countAllocated(acc, state, await stat(full));
      } catch {
        /* unreadable dir is already recorded by the walk below */
      }
      await walk(full, acc, state);
      continue;
    }
    if (!item.isFile()) continue;
    state.filesVisited += 1;
    let s;
    try {
      s = await stat(full);
    } catch {
      // Raced away mid-walk (the compactor renames under us by design). A
      // missing file is not an error worth publishing; it is one file of bytes.
      continue;
    }
    acc.bytes += s.size;
    acc.files += 1;
    countAllocated(acc, state, s);
    if (acc.newestMtimeMs === null || s.mtimeMs > acc.newestMtimeMs) acc.newestMtimeMs = s.mtimeMs;

    const birthMs = s.birthtimeMs;
    state.birthSampled += 1;
    if (!birthMs || birthMs <= 0) state.birthMissing += 1;
    else if (Math.abs(birthMs - s.mtimeMs) > 1000) state.birthDistinct += 1;

    if (s.mtimeMs >= state.windowStartMs) {
      const d = utcDay(s.mtimeMs);
      if (state.daySet.has(d)) bump(acc.modified, d, s.size);
    }
    const createdInWindow = birthMs > 0 && birthMs >= state.windowStartMs;
    if (createdInWindow) {
      const d = utcDay(birthMs);
      if (state.daySet.has(d)) bump(acc.created, d, s.size);
    }

    const key = filePattern(item.name);
    const p = acc.patterns.get(key) ?? { files: 0, bytes: 0, createdBytes: 0 };
    p.files += 1;
    p.bytes += s.size;
    if (createdInWindow) p.createdBytes += s.size;
    acc.patterns.set(key, p);
  }
}

function histogram(m: Map<string, number>, days: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const d of days) out[d] = m.get(d) ?? 0;
  return out;
}

export interface DataDirUsageOptions {
  /** Days of history in the histograms. */
  historyDays?: number;
  maxFiles?: number;
  topPatterns?: number;
  /** Injectable for tests; defaults to `Date.now()`. */
  now?: number;
  /**
   * Force the birthtime verdict instead of auto-detecting it. `false` is how a
   * test exercises the "filesystem cannot say" shape on a filesystem that can,
   * and how an operator suppresses the created histogram if it is ever found to
   * lie on this volume.
   */
  trustBirthtime?: boolean;
}

/**
 * Walk `root` one level deep for grouping, recursively for bytes, and return the
 * attribution report. Never throws: an unreadable subtree lands in `errors` so a
 * partial scan is visibly partial instead of quietly smaller.
 */
export async function measureDataDirUsage(
  root: string,
  opts: DataDirUsageOptions = {},
): Promise<DataDirUsage> {
  const startedAt = Date.now();
  const now = opts.now ?? startedAt;
  const historyDays = opts.historyDays ?? DEFAULT_HISTOGRAM_DAYS;
  const topPatterns = opts.topPatterns ?? DEFAULT_TOP_PATTERNS;
  const days: string[] = [];
  for (let i = 0; i < historyDays; i += 1) days.push(utcDay(now - i * 86_400_000));
  // Start of the OLDEST day in the window, not `now - N*day`, so the day the
  // histogram labels and the day it counts are the same day.
  const windowStartMs = Date.parse(`${days[days.length - 1]}T00:00:00.000Z`);

  const state: ScanState = {
    windowStartMs,
    daySet: new Set(days),
    maxFiles: opts.maxFiles ?? DEFAULT_MAX_FILES,
    filesVisited: 0,
    truncated: false,
    birthSampled: 0,
    birthMissing: 0,
    birthDistinct: 0,
    blocksSampled: 0,
    blocksPositive: 0,
    nonEmptySampled: 0,
    errors: [],
  };

  let top: Dirent[] = [];
  try {
    top = await readdir(root, { withFileTypes: true });
  } catch (err) {
    state.errors.push({ path: root, reason: err instanceof Error ? err.message : String(err) });
    top = [];
  }

  const accs: Array<{ name: string; kind: DataDirEntryUsage['kind']; acc: WalkAcc }> = [];
  for (const item of top) {
    const acc = emptyAcc();
    const full = join(root, item.name);
    if (item.isDirectory() && !item.isSymbolicLink()) {
      // The top-level entry's OWN inode blocks. `walk` does this for every nested
      // directory it descends into, but the top level is a separate loop — missing
      // it here left each entry's own blocks in the unaccounted residual.
      try {
        countAllocated(acc, state, await stat(full));
      } catch {
        /* unreadable dir is recorded by the walk below */
      }
      await walk(full, acc, state);
      accs.push({ name: item.name, kind: 'dir', acc });
      continue;
    }
    // A loose file at the root (users.json, .tra-142-migrated) is its own entry:
    // `users.json` being the grower is a real possibility and must be nameable.
    state.filesVisited += 1;
    try {
      const s = await lstat(full);
      acc.bytes = s.size;
      acc.files = 1;
      countAllocated(acc, state, s);
      acc.newestMtimeMs = s.mtimeMs;
      state.birthSampled += 1;
      if (!s.birthtimeMs || s.birthtimeMs <= 0) state.birthMissing += 1;
      else if (Math.abs(s.birthtimeMs - s.mtimeMs) > 1000) state.birthDistinct += 1;
      if (s.mtimeMs >= windowStartMs && state.daySet.has(utcDay(s.mtimeMs))) {
        bump(acc.modified, utcDay(s.mtimeMs), s.size);
      }
      const created = s.birthtimeMs > 0 && s.birthtimeMs >= windowStartMs;
      if (created && state.daySet.has(utcDay(s.birthtimeMs))) {
        bump(acc.created, utcDay(s.birthtimeMs), s.size);
      }
      acc.patterns.set(filePattern(item.name), {
        files: 1,
        bytes: s.size,
        createdBytes: created ? s.size : 0,
      });
      accs.push({ name: item.name, kind: item.isFile() ? 'file' : 'other', acc });
    } catch (err) {
      state.errors.push({ path: full, reason: err instanceof Error ? err.message : String(err) });
    }
  }

  // Birthtime is trusted only if the filesystem answered for every file we
  // asked about. A single epoch-0 means the created histogram is missing bytes
  // it cannot account for, and a histogram with an unknown hole in it is not an
  // attribution. An empty scan is `usable: false` too — nothing was proven.
  const birthUsable = opts.trustBirthtime ?? (state.birthSampled > 0 && state.birthMissing === 0);
  const allocUsable = allocationUsable(state);

  const entries: DataDirEntryUsage[] = accs
    .map(({ name, kind, acc }) => ({
      name,
      kind,
      bytes: acc.bytes,
      allocatedBytes: allocUsable ? acc.allocated : null,
      files: acc.files,
      dirs: acc.dirs,
      newestMtime: acc.newestMtimeMs === null ? null : new Date(acc.newestMtimeMs).toISOString(),
      modifiedBytesByDay: histogram(acc.modified, days),
      createdBytesByDay: birthUsable ? histogram(acc.created, days) : null,
      byFile: [...acc.patterns.entries()]
        .map(([pattern, p]) => ({
          pattern,
          files: p.files,
          bytes: p.bytes,
          createdBytesInWindow: birthUsable ? p.createdBytes : null,
        }))
        .sort((a, b) => b.bytes - a.bytes)
        .slice(0, topPatterns),
    }))
    .sort((a, b) => b.bytes - a.bytes);

  return {
    root,
    scannedAt: new Date(startedAt).toISOString(),
    durationMs: Date.now() - startedAt,
    totalBytes: entries.reduce((n, e) => n + e.bytes, 0),
    totalAllocatedBytes: allocUsable ? accs.reduce((n, a) => n + a.acc.allocated, 0) : null,
    totalFiles: entries.reduce((n, e) => n + e.files, 0),
    entries,
    days,
    birthtime: {
      usable: birthUsable,
      sampledFiles: state.birthSampled,
      missing: state.birthMissing,
      distinctFromMtime: state.birthDistinct,
    },
    allocation: {
      usable: allocUsable,
      sampledPaths: state.blocksSampled,
      answeredPaths: state.blocksPositive,
      nonEmptyPaths: state.nonEmptySampled,
    },
    truncated: state.truncated,
    errors: state.errors,
  };
}

let cached: { at: number; root: string; value: DataDirUsage } | null = null;

/** How long a scan is reused. The route is unauthenticated; this bounds the IO. */
export const USAGE_CACHE_MS = 60_000;

/**
 * Cached wrapper for the health route. The walk is a few thousand `stat` calls
 * on bqb1 — cheap, but not cheap enough to hand to every anonymous request.
 */
export async function dataDirUsageCached(
  root: string,
  opts: DataDirUsageOptions & { ttlMs?: number } = {},
): Promise<DataDirUsage> {
  const ttl = opts.ttlMs ?? USAGE_CACHE_MS;
  const now = opts.now ?? Date.now();
  if (cached && cached.root === root && now - cached.at < ttl) return cached.value;
  const value = await measureDataDirUsage(root, opts);
  cached = { at: now, root, value };
  return value;
}

/** Test seam. */
export function resetDataDirUsageCache(): void {
  cached = null;
}
