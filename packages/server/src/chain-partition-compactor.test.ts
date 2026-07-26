/**
 * TRA-2417 — option-chain archive compaction.
 *
 * The properties worth protecting here are the ones whose failure is INVISIBLE:
 *
 *  1. A compacted partition must load through `loadChainDays` byte-identically
 *     to the plaintext one. If it doesn't, every replay/forward-test silently
 *     loses those days and reports a smaller sample — not an error.
 *  2. Plaintext is only unlinked after the `.gz` round-trips. A compactor that
 *     deletes on write-success turns one bad write into permanent data loss on
 *     the ONLY copy of the capture.
 *  3. The newest partition is left plain (the live capture writes into it).
 *  4. Retention reporting must not delete anything.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, readdir, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { gunzipSync } from 'zlib';
import { loadChainDays, readChainSnapshotFile } from '@trading-app/backtest';
import { compactChainPartitions, chainPartitionStorageReport } from './chain-partition-compactor.js';

function snapshot(symbol: string, date: string) {
  return {
    symbol,
    spot: 100.5,
    recordedAt: Date.parse(`${date}T20:00:00Z`),
    expirations: [`${date}`],
    ivRank: 42,
    // Repetitive on purpose — mirrors a real chain, which is what compresses.
    rows: Array.from({ length: 40 }, (_, i) => ({
      symbol: `${symbol}260717C${i}`,
      underlying: symbol,
      expiration: date,
      strike: 100 + i,
      optionType: i % 2 === 0 ? 'call' : 'put',
      bid: 1.2 + i / 100,
      ask: 1.4 + i / 100,
      delta: 0.25,
    })),
  };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tra2417-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seed(dates: string[], symbols = ['AAPL', 'MSFT']): Promise<void> {
  for (const date of dates) {
    const dir = join(root, date);
    await mkdir(dir, { recursive: true });
    for (const s of symbols) {
      await writeFile(join(dir, `${s}.json`), JSON.stringify(snapshot(s, date)), 'utf-8');
    }
    await writeFile(join(dir, '_meta.json'), JSON.stringify({ date, written: symbols.length }, null, 2), 'utf-8');
  }
}

describe('compactChainPartitions', () => {
  it('compacts aged partitions, keeps the newest plain, and shrinks the archive', async () => {
    await seed(['2026-07-20', '2026-07-21', '2026-07-22']);
    const before = (await chainPartitionStorageReport({ outDir: root })).totalBytes;

    const result = await compactChainPartitions({ outDir: root });

    expect(result.partitionsScanned).toBe(3);
    expect(result.partitionsCompacted).toBe(2);
    expect(result.filesCompacted).toBe(4);
    expect(result.failures).toEqual([]);
    expect(result.partitionsKeptPlain).toEqual(['2026-07-22']);
    expect(result.bytesReclaimed).toBeGreaterThan(0);
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore);

    // The aged partitions hold ONLY `.json.gz` per-symbol files now...
    const aged = await readdir(join(root, '2026-07-20'));
    expect(aged.sort()).toEqual(['AAPL.json.gz', 'MSFT.json.gz', '_meta.json']);
    // ...and the newest is untouched, because the live capture writes into it.
    const newest = await readdir(join(root, '2026-07-22'));
    expect(newest.sort()).toEqual(['AAPL.json', 'MSFT.json', '_meta.json']);

    const after = (await chainPartitionStorageReport({ outDir: root })).totalBytes;
    expect(after).toBeLessThan(before);
  });

  it('`_meta.json` is never compacted — metadata readers keep working unchanged', async () => {
    await seed(['2026-07-20', '2026-07-21']);
    await compactChainPartitions({ outDir: root });
    const meta = JSON.parse(await readFile(join(root, '2026-07-20', '_meta.json'), 'utf-8'));
    expect(meta.written).toBe(2);
  });

  it('a compacted partition loads through loadChainDays IDENTICALLY to plaintext', async () => {
    await seed(['2026-07-20', '2026-07-21', '2026-07-22']);
    const plain = await loadChainDays(root);

    await compactChainPartitions({ outDir: root });
    const compacted = await loadChainDays(root);

    expect(compacted.map((d) => d.date)).toEqual(plain.map((d) => d.date));
    // Deep equality across every symbol of every day — a lossy round-trip that
    // still parses (truncated rows, dropped ivRank) would pass a count check.
    for (let i = 0; i < plain.length; i += 1) {
      expect([...compacted[i].bySymbol.keys()].sort()).toEqual([...plain[i].bySymbol.keys()].sort());
      for (const [sym, snap] of plain[i].bySymbol) {
        expect(compacted[i].bySymbol.get(sym)).toEqual(snap);
      }
    }
  });

  it('is idempotent — a second run compacts nothing and reclaims nothing', async () => {
    await seed(['2026-07-20', '2026-07-21']);
    await compactChainPartitions({ outDir: root });
    const second = await compactChainPartitions({ outDir: root });

    expect(second.filesCompacted).toBe(0);
    expect(second.bytesReclaimed).toBe(0);
    expect(second.failures).toEqual([]);
    // Steady state is `filesCompacted: 0` WITH `failures: []` — the health
    // payload has to distinguish this from a compactor that never ran.
    expect(second.partitionsScanned).toBe(2);
  });

  it('keeps the plaintext when the gzip round-trip cannot be verified', async () => {
    await seed(['2026-07-20', '2026-07-21']);
    const target = join(root, '2026-07-20', 'AAPL.json');
    const original = await readFile(target);

    // Corrupt the verification by making the temp path unwritable-as-expected:
    // a directory at `<file>.gz.tmp` makes `writeFile` fail, standing in for any
    // torn/failed write. The plaintext must survive.
    await mkdir(`${target}.gz.tmp`, { recursive: true });

    const result = await compactChainPartitions({ outDir: root });

    expect(result.failures.map((f) => f.file)).toContain('2026-07-20/AAPL.json');
    expect(await readFile(target)).toEqual(original);
    // The sibling in the same partition still compacts — one bad file must not
    // strand the reclaim on a disk that is filling.
    expect(result.filesCompacted).toBe(1);
    const files = await readdir(join(root, '2026-07-20'));
    expect(files).toContain('MSFT.json.gz');
    expect(files).toContain('AAPL.json');
  });

  it('the written .gz decompresses to the exact original bytes', async () => {
    await seed(['2026-07-20', '2026-07-21']);
    const original = await readFile(join(root, '2026-07-20', 'AAPL.json'));
    await compactChainPartitions({ outDir: root });
    const packed = await readFile(join(root, '2026-07-20', 'AAPL.json.gz'));
    expect(gunzipSync(packed)).toEqual(original);
  });

  it('a reader holding a pre-compaction file name still gets the snapshot', async () => {
    // The race: `readdir` hands a caller `AAPL.json`, compaction renames it to
    // `AAPL.json.gz` before the caller reads. Every caller skips on error, so
    // without the ENOENT fallback this silently drops one symbol from the
    // partition — a 1-of-2 export that looks exactly like a normal one.
    await seed(['2026-07-20', '2026-07-21']);
    const staleName = join(root, '2026-07-20', 'AAPL.json');
    const expected = await readChainSnapshotFile(staleName);

    await compactChainPartitions({ outDir: root });

    const afterRename = await readChainSnapshotFile(staleName);
    expect(afterRename).toEqual(expected);
    // ...and the reverse direction, for a caller holding the compacted name
    // against a partition that was never compacted.
    expect(await readChainSnapshotFile(join(root, '2026-07-21', 'MSFT.json.gz'))).toEqual(
      await readChainSnapshotFile(join(root, '2026-07-21', 'MSFT.json')),
    );
  });

  it('an empty or missing outDir is a no-op, not a throw', async () => {
    const missing = await compactChainPartitions({ outDir: join(root, 'nope') });
    expect(missing.partitionsScanned).toBe(0);
    expect(missing.failures).toEqual([]);
  });
});

describe('chainPartitionStorageReport', () => {
  it('counts compacted vs plain partitions', async () => {
    await seed(['2026-07-20', '2026-07-21', '2026-07-22']);
    await compactChainPartitions({ outDir: root });

    const report = await chainPartitionStorageReport({ outDir: root });
    expect(report.partitions).toBe(3);
    expect(report.compactedPartitions).toBe(2);
    // Steady state: exactly ONE plain partition (the newest).
    expect(report.plainPartitions).toBe(1);
    expect(report.oldest).toBe('2026-07-20');
    expect(report.newest).toBe('2026-07-22');
    expect(report.totalBytes).toBeGreaterThan(0);
  });

  it('reports what a retention window WOULD drop, and drops nothing', async () => {
    await seed(['2026-07-20', '2026-07-21', '2026-07-22', '2026-07-23']);

    const report = await chainPartitionStorageReport({ outDir: root, retentionTradingDays: 2 });
    expect(report.retention.enforced).toBe(false);
    expect(report.retention.beyondWindow).toEqual(['2026-07-20', '2026-07-21']);
    expect(report.retention.beyondWindowBytes).toBeGreaterThan(0);

    // The partitions it named are STILL THERE. The capture is the only copy of
    // this data; a reporting call must never be the thing that deletes it.
    expect((await readdir(root)).sort()).toEqual([
      '2026-07-20',
      '2026-07-21',
      '2026-07-22',
      '2026-07-23',
    ]);
    expect((await loadChainDays(root)).length).toBe(4);
  });

  it('a window wider than the archive marks nothing beyond it', async () => {
    await seed(['2026-07-20', '2026-07-21']);
    const report = await chainPartitionStorageReport({ outDir: root, retentionTradingDays: 30 });
    expect(report.retention.beyondWindow).toEqual([]);
    expect(report.retention.beyondWindowBytes).toBe(0);
  });
});
