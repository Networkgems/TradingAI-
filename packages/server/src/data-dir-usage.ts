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
 * module is the measurement behind `GET /api/health/storage`.
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
 * ## No new PII on an unauthenticated route
 *
 * `/api/health/storage` is open, like the other health probes. Per-user files
 * live at `DATA_DIR/users/<username>/…`, so a naive one-level-deeper breakdown
 * would publish the user list. Instead each top-level entry reports its heaviest
 * **basename patterns** (digits and dates normalised: `eod-2026-07-24.json` →
 * `eod-<date>.json`), which names the WRITER — the thing being hunted — and
 * never the user.
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
}

function emptyAcc(): WalkAcc {
  return {
    bytes: 0,
    files: 0,
    dirs: 0,
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
  errors: Array<{ path: string; reason: string }>;
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
      } catch {
        /* raced away between readdir and lstat — nothing to count */
      }
      continue;
    }
    if (item.isDirectory()) {
      acc.dirs += 1;
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

  const entries: DataDirEntryUsage[] = accs
    .map(({ name, kind, acc }) => ({
      name,
      kind,
      bytes: acc.bytes,
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
    totalFiles: entries.reduce((n, e) => n + e.files, 0),
    entries,
    days,
    birthtime: {
      usable: birthUsable,
      sampledFiles: state.birthSampled,
      missing: state.birthMissing,
      distinctFromMtime: state.birthDistinct,
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
