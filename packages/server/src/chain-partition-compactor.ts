/**
 * TRA-2417 — gzip compaction + storage accounting for the option-chain capture.
 *
 * The problem this exists for: `/data` on bqb1 is a **1 GB** volume, and the
 * TRA-779 capture was adding ~8.4 MB of per-symbol JSON every trading day with
 * nothing ever reclaiming it. At 2026-07-26 that was 48 partitions since
 * 2026-05-15 (~403 MB, the majority of the 850 MB used) against 153.7 MB free —
 * ~4 trading days from the 10% `disk-near-full` floor and ~13 from a full disk,
 * where the box can no longer write `users.json`, trade snapshots, or backups.
 *
 * Why compaction rather than the retention prune TRA-2417 asked for first:
 * measured on the real 2026-07-24 partition, gzip -6 takes the per-symbol JSON
 * to **11.8%** of its bytes. Compacting all 48 partitions reclaims ~355 MB —
 * *more* than pruning 48→30 partitions would (~209 MB) — and it does it
 * **without deleting anything**. A deleted partition is not recoverable; the
 * capture is the only copy. Compaction also flattens the slope, not just the
 * level: the ongoing cost of a trading day drops from ~8.4 MB to ~1.0 MB, which
 * a fixed-window prune does not do. Retention on top remains the owner's call
 * (see `chainPartitionStorageReport`, which reports what a policy *would* drop
 * without dropping it).
 *
 * ## The safety property that matters
 *
 * Compaction is only allowed to delete the plaintext after it has **read the
 * `.gz` back and byte-compared it to the original**. Not "the write returned",
 * not "the gzip call resolved" — a full round-trip against the bytes we are
 * about to destroy. Anything less makes a silently-corrupt archive
 * indistinguishable from a healthy one until the day someone needs to replay it,
 * which is the failure mode this repo keeps re-learning.
 *
 * Compaction runs **oldest-first** so the reclaimed space lands early: on a disk
 * that is already near full, the first partitions free the headroom the later
 * ones need for their temp files.
 */

import { readdir, readFile, writeFile, rename, unlink, stat } from 'fs/promises';
import { join } from 'path';
import { gzip, gunzip } from 'zlib';
import { promisify } from 'util';
import { CHAIN_META_FILE, isChainSnapshotFile } from '@trading-app/backtest';

const gzipAsync = promisify(gzip);
const gunzipAsync = promisify(gunzip);

const DATE_PARTITION = /^\d{4}-\d{2}-\d{2}$/;

/** gzip level. 6 is the measured 11.8%; 9 buys <0.5% for ~3x the CPU. */
const GZIP_LEVEL = 6;

/**
 * Newest partitions left uncompacted. The live capture writes into today's
 * partition and `enrichChainPartition` rewrites it minutes later, so leaving the
 * newest one plain keeps the hot path free of any compaction interaction.
 */
export const DEFAULT_KEEP_PLAIN_NEWEST = 1;

export interface CompactionResult {
  /** Date partitions that existed. */
  partitionsScanned: number;
  /** Partitions with at least one file compacted this run. */
  partitionsCompacted: number;
  /** Per-symbol files rewritten as `.json.gz`. */
  filesCompacted: number;
  /** Plaintext bytes removed. */
  bytesBefore: number;
  /** Bytes the replacements occupy. */
  bytesAfter: number;
  /** `bytesBefore - bytesAfter` — what the volume got back. */
  bytesReclaimed: number;
  /** Newest partitions deliberately left plain. */
  partitionsKeptPlain: string[];
  /**
   * Files that could NOT be compacted, with the reason. A non-empty list is the
   * signal to look — it never silently becomes a success.
   */
  failures: Array<{ file: string; reason: string }>;
  /** ms the run took. */
  durationMs: number;
}

/** Bytes of a file, or 0 if it vanished. */
async function sizeOf(path: string): Promise<number> {
  try {
    return (await stat(path)).size;
  } catch {
    return 0;
  }
}

/**
 * Compact one plaintext snapshot file to `<name>.gz`, verifying the round-trip
 * against the in-memory original before unlinking it.
 *
 * Failure at any step leaves the ORIGINAL in place — the plaintext is only
 * unlinked on the success path, after the `.gz` is durably renamed. A leftover
 * `.gz.tmp` from a crashed run is overwritten by the next attempt and is invisible
 * to every reader (it matches neither `.json` nor `.json.gz`).
 */
async function compactFile(path: string): Promise<{ before: number; after: number }> {
  const original = await readFile(path);
  const packed = await gzipAsync(original, { level: GZIP_LEVEL });

  const tmp = `${path}.gz.tmp`;
  await writeFile(tmp, packed);

  // Verify from DISK, not from the buffer we just held: this proves the bytes
  // that survived the write decompress to exactly the bytes we are about to
  // delete. A truncated or torn write fails here, with the original intact.
  const readBack = await readFile(tmp);
  const restored = await gunzipAsync(readBack);
  if (!restored.equals(original)) {
    await unlink(tmp).catch(() => {});
    throw new Error('gzip round-trip mismatch — plaintext kept');
  }

  await rename(tmp, `${path}.gz`);
  await unlink(path);
  return { before: original.length, after: packed.length };
}

/**
 * Compact every date partition under `outDir` except the newest
 * `keepPlainNewest`. Idempotent: an already-compacted partition has no `.json`
 * per-symbol files left to do, so a second run is a cheap directory walk.
 *
 * Never throws — a per-file failure is recorded in `failures` and the walk
 * continues, because one unreadable symbol must not strand the reclaim on a
 * disk that is filling.
 */
export async function compactChainPartitions(opts: {
  outDir: string;
  keepPlainNewest?: number;
  now?: () => number;
}): Promise<CompactionResult> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const keepPlain = Math.max(0, opts.keepPlainNewest ?? DEFAULT_KEEP_PLAIN_NEWEST);

  let dates: string[] = [];
  try {
    dates = (await readdir(opts.outDir)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }

  const keptPlain = keepPlain > 0 ? dates.slice(-keepPlain) : [];
  const targets = keepPlain > 0 ? dates.slice(0, Math.max(0, dates.length - keepPlain)) : dates;

  const result: CompactionResult = {
    partitionsScanned: dates.length,
    partitionsCompacted: 0,
    filesCompacted: 0,
    bytesBefore: 0,
    bytesAfter: 0,
    bytesReclaimed: 0,
    partitionsKeptPlain: keptPlain,
    failures: [],
    durationMs: 0,
  };

  // Oldest-first: reclaim early so a near-full disk gains headroom as we go.
  for (const date of targets) {
    const dir = join(opts.outDir, date);
    let files: string[];
    try {
      files = (await readdir(dir)).sort();
    } catch {
      continue;
    }
    // `_meta.json` stays plaintext by design — every metadata reader keeps
    // working, at a cost of ~3 KB per partition.
    const plain = files.filter((f) => f.endsWith('.json') && isChainSnapshotFile(f));
    if (plain.length === 0) continue;

    let compactedHere = 0;
    for (const f of plain) {
      try {
        const { before, after } = await compactFile(join(dir, f));
        result.filesCompacted += 1;
        result.bytesBefore += before;
        result.bytesAfter += after;
        compactedHere += 1;
      } catch (err) {
        result.failures.push({
          file: `${date}/${f}`,
          reason: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (compactedHere > 0) result.partitionsCompacted += 1;
  }

  result.bytesReclaimed = result.bytesBefore - result.bytesAfter;
  result.durationMs = now() - startedAt;
  return result;
}

export interface PartitionStorage {
  date: string;
  /** Per-symbol files, either form. */
  files: number;
  /** Of `files`, how many are `.json.gz`. */
  compacted: number;
  bytes: number;
}

export interface ChainStorageReport {
  partitions: number;
  /** Partitions with every per-symbol file compacted. */
  compactedPartitions: number;
  /** Partitions with at least one plaintext per-symbol file left. */
  plainPartitions: number;
  totalBytes: number;
  /** Bytes held by partitions outside a `retentionTradingDays` window. */
  retention: {
    /**
     * Trading-day window under consideration. This is a REPORTING policy — this
     * module never deletes a partition. TRA-779's own gate is `>= 30` captured
     * days, so nothing is out of policy at 48; whether to prune the surplus is
     * the capture owner's call, and it is not needed for capacity once the
     * archive is compacted.
     */
    tradingDays: number;
    /** Partitions older than the window (oldest-first). */
    beyondWindow: string[];
    /** What dropping them would reclaim, at their CURRENT (compacted) size. */
    beyondWindowBytes: number;
    /** Nothing here deletes. Stated so a reader never infers otherwise. */
    enforced: false;
  };
  oldest: string | null;
  newest: string | null;
  perPartition: PartitionStorage[];
}

/**
 * Size the archive from the filesystem so "retention ran" is gradeable off
 * `/api/health/chain-capture` instead of being re-derived from Render's disk
 * metrics — the same hole TRA-2357 closed for free space.
 *
 * `stat`s every per-symbol file (~1200 on bqb1) and reads none of them.
 */
export async function chainPartitionStorageReport(opts: {
  outDir: string;
  retentionTradingDays?: number;
}): Promise<ChainStorageReport> {
  const retentionTradingDays = opts.retentionTradingDays ?? 30;
  let dates: string[] = [];
  try {
    dates = (await readdir(opts.outDir)).filter((d) => DATE_PARTITION.test(d)).sort();
  } catch {
    dates = [];
  }

  const perPartition: PartitionStorage[] = [];
  for (const date of dates) {
    const dir = join(opts.outDir, date);
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      continue;
    }
    const snapshots = files.filter(isChainSnapshotFile);
    let bytes = 0;
    for (const f of [...snapshots, CHAIN_META_FILE]) {
      bytes += await sizeOf(join(dir, f));
    }
    perPartition.push({
      date,
      files: snapshots.length,
      compacted: snapshots.filter((f) => f.endsWith('.json.gz')).length,
      bytes,
    });
  }

  const beyond = perPartition.slice(0, Math.max(0, perPartition.length - retentionTradingDays));

  return {
    partitions: perPartition.length,
    compactedPartitions: perPartition.filter((p) => p.files > 0 && p.compacted === p.files).length,
    plainPartitions: perPartition.filter((p) => p.files > 0 && p.compacted < p.files).length,
    totalBytes: perPartition.reduce((a, p) => a + p.bytes, 0),
    retention: {
      tradingDays: retentionTradingDays,
      beyondWindow: beyond.map((p) => p.date),
      beyondWindowBytes: beyond.reduce((a, p) => a + p.bytes, 0),
      enforced: false,
    },
    oldest: perPartition[0]?.date ?? null,
    newest: perPartition[perPartition.length - 1]?.date ?? null,
    perPartition,
  };
}
