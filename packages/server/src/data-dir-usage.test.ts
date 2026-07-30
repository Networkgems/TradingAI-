/**
 * TRA-2420 — per-subdirectory attribution for `DATA_DIR`.
 *
 * The properties here are the ones whose failure produces a CONFIDENT WRONG
 * ANSWER rather than an error:
 *
 *  1. An in-place rewriter (per-user trade snapshots, rewritten every session)
 *     contributes its whole size to the mtime histogram every day while adding
 *     nothing to the volume. If the report cannot separate that from a genuinely
 *     new file, it will name the wrong writer for the ~3.6 MB/day residual — and
 *     name it with a large, plausible number.
 *  2. When birthtime is unusable the created histogram must be `null`, never
 *     zeros. Zeros read as "this directory grew by nothing", which is the same
 *     bytes as "this filesystem declined to answer".
 *  3. A capped walk must say so. A floor that looks like a total is worse than
 *     no number at all.
 *  4. The report must not publish usernames — the route carrying it is open.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  measureDataDirUsage,
  dataDirUsageCached,
  resetDataDirUsageCache,
  filePattern,
  allocationUsable,
} from './data-dir-usage.js';

const DAY = 86_400_000;

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tra2420-'));
  resetDataDirUsageCache();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  resetDataDirUsageCache();
});

function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

describe('measureDataDirUsage', () => {
  it('sums bytes recursively but groups one level deep, heaviest first', async () => {
    await mkdir(join(root, 'option-chains', '2026-07-24'), { recursive: true });
    await writeFile(join(root, 'option-chains', '2026-07-24', 'AAPL.json'), 'x'.repeat(5000));
    await writeFile(join(root, 'option-chains', '2026-07-24', 'MSFT.json'), 'x'.repeat(3000));
    await mkdir(join(root, 'sentiment-snapshots'), { recursive: true });
    await writeFile(join(root, 'sentiment-snapshots', 'snap.json'), 'x'.repeat(100));
    await writeFile(join(root, 'users.json'), 'x'.repeat(700));

    const usage = await measureDataDirUsage(root);

    expect(usage.entries.map((e) => e.name)).toEqual([
      'option-chains',
      'users.json',
      'sentiment-snapshots',
    ]);
    const chains = usage.entries[0]!;
    expect(chains.kind).toBe('dir');
    expect(chains.bytes).toBe(8000);
    expect(chains.files).toBe(2);
    expect(chains.dirs).toBe(1);
    // A loose root file is its own named entry — `users.json` being the grower
    // is a live hypothesis and has to be nameable, not folded into a total.
    expect(usage.entries[1]!.kind).toBe('file');
    expect(usage.entries[1]!.bytes).toBe(700);
    expect(usage.totalBytes).toBe(8800);
    expect(usage.totalFiles).toBe(4);
    expect(usage.truncated).toBe(false);
    expect(usage.errors).toEqual([]);
  });

  it('separates an in-place rewriter from a genuinely new file', async () => {
    // `fresh/` gets a file that is new AND newly written — the positive mark.
    // `rewritten/` gets a file created at the same moment but whose mtime is
    // pushed three days forward, which is exactly the shape of a per-session
    // snapshot rewritten in place: big in the mtime histogram, zero growth.
    await mkdir(join(root, 'fresh'), { recursive: true });
    await mkdir(join(root, 'rewritten'), { recursive: true });
    await writeFile(join(root, 'fresh', 'new.json'), 'x'.repeat(1000));
    const rewritten = join(root, 'rewritten', 'trades-stocks.json');
    await writeFile(rewritten, 'x'.repeat(4000));

    const birthDay = utcDay(Date.now());
    const laterMs = Date.now() + 3 * DAY;
    await utimes(rewritten, new Date(laterMs), new Date(laterMs));

    // Scan "from" three days in the future so both days sit inside the window.
    const usage = await measureDataDirUsage(root, { now: laterMs, historyDays: 7 });
    const rewrittenDay = utcDay(laterMs);
    const byName = new Map(usage.entries.map((e) => [e.name, e]));

    // The mtime histogram — read alone — points straight at the rewriter with a
    // 4x bigger number than the file that actually consumed new bytes.
    expect(byName.get('rewritten')!.modifiedBytesByDay[rewrittenDay]).toBe(4000);
    expect(byName.get('fresh')!.modifiedBytesByDay[rewrittenDay]).toBe(0);

    expect(usage.birthtime.sampledFiles).toBe(2);
    if (usage.birthtime.usable) {
      // Positive mark FIRST: the created histogram is demonstrably capable of
      // reporting bytes on this filesystem, so the zero below means something.
      const created = byName.get('fresh')!.createdBytesByDay!;
      expect(created[birthDay]).toBe(1000);
      // ...and the rewriter's bytes are attributed to the day it was CREATED,
      // not the day it was touched. That is the residual attribution.
      expect(byName.get('rewritten')!.createdBytesByDay![rewrittenDay]).toBe(0);
      expect(byName.get('rewritten')!.createdBytesByDay![birthDay]).toBe(4000);
    } else {
      // Filesystem without statx birth support: the contract is a null, so a
      // consumer cannot mistake "cannot say" for "grew by nothing".
      expect(byName.get('fresh')!.createdBytesByDay).toBeNull();
      expect(byName.get('rewritten')!.createdBytesByDay).toBeNull();
    }
  });

  it('emits null, not zeros, when birthtime is unusable', async () => {
    await mkdir(join(root, 'chains'), { recursive: true });
    await writeFile(join(root, 'chains', 'AAPL.json'), 'x'.repeat(1000));

    const usage = await measureDataDirUsage(root, { trustBirthtime: false });

    expect(usage.entries[0]!.createdBytesByDay).toBeNull();
    expect(usage.entries[0]!.byFile[0]!.createdBytesInWindow).toBeNull();
    // The mtime side stays populated — the report degrades to one histogram, it
    // does not go blank.
    expect(Object.values(usage.entries[0]!.modifiedBytesByDay).reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('flags a truncated walk instead of publishing a short total as a total', async () => {
    await mkdir(join(root, 'many'), { recursive: true });
    for (let i = 0; i < 20; i += 1) {
      await writeFile(join(root, 'many', `f${i}.json`), 'x'.repeat(10));
    }

    const capped = await measureDataDirUsage(root, { maxFiles: 5 });
    expect(capped.truncated).toBe(true);
    expect(capped.totalFiles).toBeLessThan(20);

    const full = await measureDataDirUsage(root, { maxFiles: 1000 });
    expect(full.truncated).toBe(false);
    expect(full.totalFiles).toBe(20);
    expect(full.totalBytes).toBe(200);
  });

  it('names the writer by basename pattern and never the user', async () => {
    await mkdir(join(root, 'users', 'alice'), { recursive: true });
    await mkdir(join(root, 'users', 'bob'), { recursive: true });
    await writeFile(join(root, 'users', 'alice', 'eod-report-2026-07-24.json'), 'x'.repeat(900));
    await writeFile(join(root, 'users', 'bob', 'eod-report-2026-07-25.json'), 'x'.repeat(1100));
    await writeFile(join(root, 'users', 'bob', 'account-settings.json'), 'x'.repeat(50));

    const usage = await measureDataDirUsage(root);
    const users = usage.entries.find((e) => e.name === 'users')!;

    // Both users' daily reports collapse into ONE named writer with the summed
    // bytes — which is the number the residual hunt needs.
    const eod = users.byFile.find((p) => p.pattern === 'eod-report-<date>.json')!;
    expect(eod.files).toBe(2);
    expect(eod.bytes).toBe(2000);

    const serialised = JSON.stringify(usage);
    expect(serialised).not.toContain('alice');
    expect(serialised).not.toContain('bob');
  });

  it('records an unreadable root instead of reporting an empty disk', async () => {
    const usage = await measureDataDirUsage(join(root, 'does-not-exist'));
    expect(usage.entries).toEqual([]);
    expect(usage.totalBytes).toBe(0);
    // A missing DATA_DIR and an empty one are both `totalBytes: 0`; only the
    // error list tells them apart.
    expect(usage.errors).toHaveLength(1);
    expect(usage.birthtime.usable).toBe(false);
    // TRA-2420 — an unmeasurable volume must not read as "nothing is allocated".
    expect(usage.allocation.usable).toBe(false);
    expect(usage.totalAllocatedBytes).toBeNull();
  });

  // ── TRA-2420: allocated vs apparent ──────────────────────────────────────
  // `/api/health/storage` publishes a residual of `df`-used minus what the walk
  // measured. That subtraction was unit-mismatched: the walk summed `st_size`
  // (apparent) while `df` counts allocated blocks plus the root reserve. On bqb1
  // — ~48k files averaging ~5 KiB — block rounding alone is worth ~100 MB, which
  // pinned the residual at 35% and made `tra2420:attribute` exit UNATTRIBUTED for
  // every possible state of the disk. These tests pin the unit, not the number.
  it('reports allocated bytes above apparent bytes for many small files', async () => {
    // 40 files of 5000 bytes: 195 KB apparent, but each rounds up to two 4 KiB
    // blocks. 5000 is deliberate — it matches the real `backups/` mean of ~5.57 KiB
    // AND clears NTFS's ~900-byte resident-file threshold, so the rounding this
    // asserts is present on the CI/dev filesystem as well as on bqb1's ext4.
    await mkdir(join(root, 'backups'), { recursive: true });
    for (let i = 0; i < 40; i += 1) {
      await writeFile(join(root, 'backups', `snap-${i}.json`), 'x'.repeat(5000));
    }

    const usage = await measureDataDirUsage(root);
    expect(usage.allocation.usable).toBe(true);
    expect(usage.allocation.answeredPaths).toBeGreaterThan(0);
    expect(usage.totalBytes).toBe(200_000);

    // The assertion that matters: allocated STRICTLY exceeds apparent here. If the
    // walk ever goes back to summing `st_size` into this field, these collapse to
    // equal and the residual silently becomes a phantom writer again.
    expect(usage.totalAllocatedBytes).not.toBeNull();
    expect(usage.totalAllocatedBytes!).toBeGreaterThan(usage.totalBytes);

    // Directory inodes are counted too — `backups/` holds 37k files across
    // hundreds of directories on the real volume, and leaving them out puts their
    // blocks in the residual.
    const backups = usage.entries.find((e) => e.name === 'backups');
    expect(backups?.allocatedBytes).not.toBeNull();
    expect(backups!.allocatedBytes!).toBeGreaterThan(backups!.bytes);
    // Sampled paths exceed the file count precisely because the directory was stat'd.
    expect(usage.allocation.sampledPaths).toBeGreaterThan(usage.totalFiles);
  });

  it('does not call a filesystem unmeasurable just because small files are resident', async () => {
    // NTFS keeps files under ~900 bytes INSIDE the MFT record, so `st_blocks` is
    // legitimately 0 for them; sparse files on ext4 do the same. An earlier cut of
    // this fix judged "size > 0 with blocks === 0" a decline PER FILE, which made
    // every Windows tree — and every dev/CI run — report allocation as unusable.
    await writeFile(join(root, 'tiny.json'), 'x'.repeat(50));
    await writeFile(join(root, 'empty.json'), '');
    await writeFile(join(root, 'real.json'), 'x'.repeat(5000));

    const usage = await measureDataDirUsage(root);
    expect(usage.allocation.usable).toBe(true);
    expect(usage.totalAllocatedBytes).not.toBeNull();
    expect(usage.totalAllocatedBytes!).toBeGreaterThan(0);
  });
});

describe('allocationUsable', () => {
  // The wholesale-decline branch cannot be produced by writing to a real
  // filesystem, so without these it has no failing state — and an instrument
  // whose guard never fires is indistinguishable from one with no guard.
  it('is false when every path reported zero blocks but non-empty files exist', () => {
    expect(allocationUsable({ blocksSampled: 500, blocksPositive: 0, nonEmptySampled: 500 })).toBe(false);
  });

  it('is false when nothing was sampled — an empty scan proves nothing either way', () => {
    expect(allocationUsable({ blocksSampled: 0, blocksPositive: 0, nonEmptySampled: 0 })).toBe(false);
  });

  it('is true for a tree of only empty files, whose zero allocation is real', () => {
    expect(allocationUsable({ blocksSampled: 12, blocksPositive: 0, nonEmptySampled: 0 })).toBe(true);
  });

  it('is true once any path answers, even if most are resident zeros', () => {
    expect(allocationUsable({ blocksSampled: 500, blocksPositive: 1, nonEmptySampled: 500 })).toBe(true);
  });
});

describe('filePattern', () => {
  it('collapses dates before digit runs so a date is not shredded', () => {
    expect(filePattern('eod-report-2026-07-24.json')).toBe('eod-report-<date>.json');
    expect(filePattern('chain-20260724.json.gz')).toBe('chain-<date>.json.gz');
    expect(filePattern('backup-17.json')).toBe('backup-<n>.json');
    expect(filePattern('users.json')).toBe('users.json');
  });
});

describe('dataDirUsageCached', () => {
  it('reuses a scan inside the TTL and rescans after it', async () => {
    await mkdir(join(root, 'a'), { recursive: true });
    await writeFile(join(root, 'a', 'f.json'), 'x'.repeat(100));

    const t0 = Date.now();
    const first = await dataDirUsageCached(root, { now: t0 });
    expect(first.totalBytes).toBe(100);

    await writeFile(join(root, 'a', 'g.json'), 'x'.repeat(500));
    const cachedHit = await dataDirUsageCached(root, { now: t0 + 1000 });
    expect(cachedHit.totalBytes).toBe(100);

    const rescan = await dataDirUsageCached(root, { now: t0 + 120_000 });
    expect(rescan.totalBytes).toBe(600);
  });
});
