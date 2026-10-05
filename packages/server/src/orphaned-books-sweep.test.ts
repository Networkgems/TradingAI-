// TRA-5134 — the bulk orphan-retirement sweep over the TRA-2410 machinery.
//
// What this file is for, in order of importance:
//  1. The fail-closed registry guards. A corrupt `users.json` parses to an EMPTY
//     roster upstream, under which all 251 book trees — the 4 live ones included
//     — read as orphans. The sweep must refuse that world, not execute it.
//  2. Move-only, witnessed: every moved tree lands byte-complete, and the
//     registered books are untouched to the mtime.
//  3. Dry run moves nothing while planning everything.

import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

type Sweep = typeof import('./orphaned-books-sweep.js');
type Auth = typeof import('./auth.js');
type TwoFactor = typeof import('./two-factor.js');

let DATA_DIR: string;
let sweep: Sweep;

beforeAll(async () => {
  DATA_DIR = mkdtempSync(join(tmpdir(), 'tra5134-'));
  process.env['DATA_DIR'] = DATA_DIR;
  sweep = await import('./orphaned-books-sweep.js');
  const auth: Auth = await import('./auth.js');
  const twoFactor: TwoFactor = await import('./two-factor.js');
  auth.initResetTokenStore(DATA_DIR);
  twoFactor.initTwoFactorStore(DATA_DIR);
});

const userDir = (u: string) => join(DATA_DIR, 'users', u);
const orphanRoot = () => join(DATA_DIR, 'orphaned-books');

function plantBook(username: string, marker: string): void {
  const dir = userDir(username);
  mkdirSync(join(dir, 'reports', 'demo'), { recursive: true });
  writeFileSync(join(dir, 'trades-stocks.json'), JSON.stringify({ version: 1, marker }), 'utf-8');
  writeFileSync(join(dir, 'watchlist.json'), JSON.stringify({ symbols: ['AAPL'] }), 'utf-8');
  writeFileSync(join(dir, 'reports', 'demo', 'latest.json'), JSON.stringify({ marker }), 'utf-8');
}

/** A sweep "now" safely AFTER every write this test just made. */
const future = () => Date.now() + 60_000;

describe('TRA-5134 — bulk orphan sweep', () => {
  it('REFUSES an empty registry outright — the corrupt-users.json world', async () => {
    plantBook('t1-live', 'live');
    plantBook('t1-orphan', 'dead');
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: [],
      apply: true,
      dataDir: DATA_DIR,
      now: future(),
    });
    expect(r.refused).toBe('empty_registry');
    expect(r.rows).toHaveLength(0);
    expect(existsSync(userDir('t1-live'))).toBe(true);
    expect(existsSync(userDir('t1-orphan'))).toBe(true);
  });

  it('REFUSES a registry that intersects the disk in zero names', async () => {
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: ['nobody-here-1', 'nobody-here-2'],
      apply: true,
      dataDir: DATA_DIR,
      now: future(),
    });
    expect(r.refused).toBe('registry_disk_disjoint');
    expect(existsSync(userDir('t1-orphan'))).toBe(true);
  });

  it('dry run plans every orphan with witnesses and moves NOTHING', async () => {
    const before = readdirSync(join(DATA_DIR, 'users')).length;
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: ['t1-live'],
      apply: false,
      dataDir: DATA_DIR,
      now: future(),
    });
    expect(r.refused).toBeNull();
    expect(r.orphanCount).toBe(before - 1);
    expect(r.moved).toBe(0);
    expect(r.rows.every((row) => row.skipped === 'dry_run' && !row.moved)).toBe(true);
    expect(r.rows.every((row) => row.before.files > 0 && row.before.bytes > 0)).toBe(true);
    expect(r.bookDirsOnDiskAfter).toBe(before);
    expect(r.registeredUntouched).toBe(true);
  });

  it('apply retires orphans byte-complete and leaves registered books untouched to the mtime', async () => {
    plantBook('t4-orphan-a', 'a');
    plantBook('t4-orphan-b', 'b');
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: ['t1-live'],
      apply: true,
      dataDir: DATA_DIR,
      now: future(),
    });
    expect(r.refused).toBeNull();
    expect(r.failures).toBe(0);
    expect(r.moved).toBe(r.orphanCount);
    expect(r.zeroDeletionWitness).toBe(true);
    expect(r.registeredUntouched).toBe(true);
    // The live key is clear and the trees landed whole under orphaned-books/.
    expect(existsSync(userDir('t4-orphan-a'))).toBe(false);
    expect(existsSync(userDir('t4-orphan-b'))).toBe(false);
    expect(existsSync(userDir('t1-live'))).toBe(true);
    const landed = readdirSync(orphanRoot());
    expect(landed.some((n) => n.startsWith('t4-orphan-a@'))).toBe(true);
    expect(landed.some((n) => n.startsWith('t4-orphan-b@'))).toBe(true);
    for (const row of r.rows.filter((x) => x.moved)) {
      expect(row.byteComplete).toBe(true);
      expect(row.after!.files).toBe(row.before.files);
      expect(row.after!.bytes).toBe(row.before.bytes);
    }
    expect(r.totals.filesAfter).toBe(r.totals.filesBefore);
    expect(r.totals.bytesAfter).toBe(r.totals.bytesBefore);
    // Convergence: the TRA-3064 divergence closes — dirs on disk == registered.
    expect(r.bookDirsOnDiskAfter).toBe(1);
  });

  it('a tree that gained a write after sweep start is SKIPPED, never moved', async () => {
    plantBook('t5-hot', 'hot');
    // Sweep "started" a minute ago; the tree was just written ⇒ newer than start.
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: ['t1-live'],
      apply: true,
      dataDir: DATA_DIR,
      now: Date.now() - 60_000,
    });
    const hot = r.rows.find((x) => x.name === 't5-hot');
    expect(hot).toBeDefined();
    expect(hot!.skipped).toBe('write_after_sweep_start');
    expect(hot!.moved).toBe(false);
    expect(existsSync(userDir('t5-hot'))).toBe(true);
  });

  it('registered-name match is case-insensitive — a case-variant dir is protected, not retired', async () => {
    // (On a case-insensitive FS this dir may BE the registered dir; either way
    // it must not classify as an orphan.)
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: ['T5-HOT', 't1-live'],
      apply: false,
      dataDir: DATA_DIR,
      now: future(),
    });
    expect(r.rows.find((x) => x.name === 't5-hot')).toBeUndefined();
  });

  it('respects limit and reports the remainder', async () => {
    plantBook('t7-one', '1');
    plantBook('t7-two', '2');
    const r = await sweep.sweepOrphanedBooks({
      registeredUsernames: ['t1-live', 'T5-HOT'],
      apply: false,
      limit: 1,
      dataDir: DATA_DIR,
      now: future(),
    });
    expect(r.rows).toHaveLength(1);
    expect(r.remainingBeyondLimit).toBe(r.orphanCount - 1);
  });
});
