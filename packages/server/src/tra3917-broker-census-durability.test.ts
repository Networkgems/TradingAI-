import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  PERMISSION_BREAKER_THRESHOLD,
  __resetBrokerSubmitCensusForTest,
  hydrateCensusFromDir,
  persistCensusDaySync,
  recordBrokerFill,
  recordBrokerReject,
  recordBrokerSubmit,
  summarizeBrokerSubmitCensus,
} from './broker-submit-census.js';

/**
 * TRA-3917 — durability of the TRA-3905 broker-outcome census.
 *
 * ## What went wrong, twice
 *
 * The census is a process-lifetime, per-ET-day fold. The 16:10 ET reader routine
 * lives inside 20:00–20:15Z, which is also when every deploy held back by the
 * RTH freeze (13:30–20:00Z Mon–Fri) lands. The reader therefore races, by
 * policy, the exact queue that policy creates:
 *
 *   • 2026-08-20 — NO-RUN. The build booted 03:03:30Z, seven hours after the
 *     close, so `etDay 2026-08-20` was structurally zero.
 *   • 2026-08-21 — FORFEIT. bqb1 booted 20:12:29Z (deploy `4e10132`), 2m29s
 *     after the routine fired. Zero minutes of the session were in the fold.
 *
 * `6eac1bd` (TRA-3937) answered this with a snapshot written from ONE call site:
 * the `/api/health/options-live` handler. That commit shipped with **no test of
 * either direction** — nothing in the suite imported `persistCensusDaySync` or
 * `hydrateCensusFromDir` — and, measured against the 08-21 timeline, it would
 * not have saved that session either: the agent's GET landed at 21:17:30Z, 65
 * minutes after the process holding the fold was already gone. The snapshot code
 * was deployed and never executed.
 *
 * ## The bar these tests hold
 *
 * ⛔ An all-zero census is byte-identical to a fold wired to nothing, and a
 * snapshot file that is never written is byte-identical to one whose writer is
 * dead. So every test below is PAIRED: an arm that must produce bytes, and a
 * control that must produce none for a named reason. A test that only asserts
 * "the file exists after I called the writer directly" grades the writer against
 * itself and would have passed on `6eac1bd` unchanged.
 */

const DAY = '2026-08-24';
const OTHER_DAY = '2026-08-25';

let dir: string;

beforeEach(() => {
  __resetBrokerSubmitCensusForTest();
  dir = mkdtempSync(join(tmpdir(), 'tra3917-census-'));
});

afterEach(() => {
  __resetBrokerSubmitCensusForTest();
  rmSync(dir, { recursive: true, force: true });
});

function snapFiles(d: string): string[] {
  try {
    return readdirSync(join(d, 'broker-census')).sort();
  } catch {
    return [];
  }
}

// TRA-4440 — the census snapshot is read straight off disk and indexed by seat
// (`['v0nni'].submitted`), so `unknown` would need a cast at every call site here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function snapFor(d: string, etDay: string): Record<string, any> {
  return JSON.parse(readFileSync(join(d, 'broker-census', `${etDay}.json`), 'utf-8'));
}

describe('TRA-3917 — write-through: a broker event persists without any reader', () => {
  it('a submit alone puts the fold on disk — no health-route call anywhere', () => {
    hydrateCensusFromDir(dir); // this is what the server does at boot, and all it does
    recordBrokerSubmit('v0nni', DAY);

    // THE test. On `6eac1bd` this array is empty: nothing but the health route
    // wrote, and this test never calls it. That is the 08-21 forfeit, reproduced.
    expect(snapFiles(dir)).toEqual([`${DAY}.json`]);
    expect(snapFor(dir, DAY)['v0nni'].submitted).toBe(1);
  });

  it('CONTROL — unarmed (nothing hydrated) writes nothing and does not throw', () => {
    // No hydrateCensusFromDir call: a unit test or CLI importer must never have
    // the module touch a filesystem it did not nominate.
    expect(() => recordBrokerSubmit('v0nni', DAY)).not.toThrow();
    expect(snapFiles(dir)).toEqual([]);
  });

  it('fills and rejects write through too, not just submits', () => {
    hydrateCensusFromDir(dir);
    recordBrokerSubmit('admin', DAY);
    recordBrokerFill('admin', DAY);
    expect(snapFor(dir, DAY)['admin']).toMatchObject({ submitted: 1, filled: 1 });

    recordBrokerReject('v0nni', DAY, 'no_quote', 'no quote');
    expect(snapFor(dir, DAY)['v0nni']).toMatchObject({ brokerRejects: 1 });
  });

  it('the breaker trip itself is on disk — the cell the 08-20 census did not have', () => {
    hydrateCensusFromDir(dir);
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i++) {
      recordBrokerSubmit('v0nni', DAY);
      recordBrokerReject('v0nni', DAY, 'permission', 'Account is restricted for option trading.', 1000 + i);
    }
    const cell = snapFor(dir, DAY)['v0nni'];
    expect(cell.consecutivePermission).toBe(PERMISSION_BREAKER_THRESHOLD);
    expect(cell.blockedSince).not.toBeNull();
    expect(cell.blockedReason).toContain('restricted');
  });

  it('arms on the FIRST boot, when the snapshot directory does not exist yet', () => {
    // hydrate throws internally on the missing dir and returns {days:0}. If the
    // arming sat below that catch, the box would be durable only from its SECOND
    // boot — undurable on the day the feature ships.
    expect(snapFiles(dir)).toEqual([]);
    expect(hydrateCensusFromDir(dir)).toEqual({ days: 0 });
    recordBrokerSubmit('admin', DAY);
    expect(snapFiles(dir)).toEqual([`${DAY}.json`]);
  });

  it('a mutation that does not change the bytes does not re-write the file', () => {
    hydrateCensusFromDir(dir);
    recordBrokerSubmit('admin', DAY);
    const path = join(dir, 'broker-census', `${DAY}.json`);
    const first = readFileSync(path, 'utf-8');

    // Corrupt the file behind the writer's back, then replay a mutation whose
    // resulting bytes are identical to the last write: the dedupe must hold, so
    // the corruption survives. This is the only observable that distinguishes
    // "skipped the write" from "wrote the same thing again".
    writeFileSync(path, 'SENTINEL');
    persistCensusDaySync(DAY, dir);
    expect(readFileSync(path, 'utf-8')).toBe('SENTINEL');

    // …and a mutation that DOES change the bytes repairs it.
    recordBrokerSubmit('admin', DAY);
    expect(readFileSync(path, 'utf-8')).not.toBe('SENTINEL');
    expect(JSON.parse(readFileSync(path, 'utf-8'))['admin'].submitted).toBe(2);
    expect(first).not.toBe('SENTINEL');
  });
});

describe('TRA-3917 — hydrate: the fold survives the boot that used to forfeit it', () => {
  it('round-trips a full session across a simulated restart', () => {
    // ── session 1: the process that saw the orders ──
    hydrateCensusFromDir(dir);
    recordBrokerSubmit('admin', DAY);
    recordBrokerFill('admin', DAY);
    for (let i = 0; i < PERMISSION_BREAKER_THRESHOLD; i++) {
      recordBrokerSubmit('v0nni', DAY);
      recordBrokerReject('v0nni', DAY, 'permission', 'Account is restricted for option trading.', 1000 + i);
    }
    recordBrokerReject('v0nni', DAY, 'permission_blocked', null, 2000);

    const before = summarizeBrokerSubmitCensus(DAY, ['admin', 'v0nni']);
    expect(before.fromSnapshot).toBe(false);

    // ── the 20:12:29Z deploy: process dies, disk survives ──
    __resetBrokerSubmitCensusForTest();
    expect(summarizeBrokerSubmitCensus(DAY, ['admin', 'v0nni']).books.every(b => !b.observed)).toBe(true);

    // ── session 2: the boot that used to read FORFEIT ──
    expect(hydrateCensusFromDir(dir)).toEqual({ days: 1 });
    const after = summarizeBrokerSubmitCensus(DAY, ['admin', 'v0nni']);

    expect(after.fromSnapshot).toBe(true);
    const admin = after.books.find(b => b.book === 'admin')!;
    const v0nni = after.books.find(b => b.book === 'v0nni')!;
    expect(admin).toMatchObject({ submitted: 1, filled: 1, verdict: 'green' });
    expect(v0nni.verdict).toBe('red');
    expect(v0nni.brokerPermissionBlocked).toBe(true);
    expect(v0nni.brokerPermissionBlockedSince).not.toBeNull();
    expect(v0nni.permissionRejects).toBe(PERMISSION_BREAKER_THRESHOLD);
    expect(v0nni.submissionsRefusedByBreaker).toBe(1);
    // The pin: submitted stopped climbing at the trip count.
    expect(v0nni.submitted).toBe(PERMISSION_BREAKER_THRESHOLD);
  });

  it('`fromSnapshot` is the FORFEIT discriminator, and it is per-day', () => {
    hydrateCensusFromDir(dir);
    recordBrokerSubmit('admin', DAY);
    __resetBrokerSubmitCensusForTest();
    hydrateCensusFromDir(dir);

    // hydrated day → durable read
    expect(summarizeBrokerSubmitCensus(DAY, ['admin']).fromSnapshot).toBe(true);
    // a day this process accumulated live → NOT from snapshot, even though the
    // same store holds both. A blanket flag would call a mid-session restart
    // durable and wave through a partial fold.
    recordBrokerSubmit('admin', OTHER_DAY);
    expect(summarizeBrokerSubmitCensus(OTHER_DAY, ['admin']).fromSnapshot).toBe(false);
  });

  it('live-process data wins over a snapshot for the same day', () => {
    hydrateCensusFromDir(dir);
    recordBrokerSubmit('admin', DAY);
    recordBrokerSubmit('admin', DAY);

    // A second hydrate must not clobber the 2 already counted with the 2 on disk,
    // nor double them to 4.
    hydrateCensusFromDir(dir);
    const r = summarizeBrokerSubmitCensus(DAY, ['admin']);
    expect(r.books.find(b => b.book === 'admin')!.submitted).toBe(2);
    expect(r.fromSnapshot).toBe(false);
  });

  it('CONTROL — a corrupt snapshot is skipped, not hydrated, and never throws', () => {
    mkdirSync(join(dir, 'broker-census'), { recursive: true });
    writeFileSync(join(dir, 'broker-census', `${DAY}.json`), '{not json');
    expect(hydrateCensusFromDir(dir)).toEqual({ days: 0 });
    expect(summarizeBrokerSubmitCensus(DAY, ['admin']).fromSnapshot).toBe(false);
  });

  it('CONTROL — a stray non-date file in the directory is ignored', () => {
    mkdirSync(join(dir, 'broker-census'), { recursive: true });
    writeFileSync(join(dir, 'broker-census', 'notes.txt'), 'hello');
    writeFileSync(join(dir, 'broker-census', '2026-08-24.json.bak'), '{}');
    expect(hydrateCensusFromDir(dir)).toEqual({ days: 0 });
  });

  it('CONTROL — an empty day writes no file, so a quiet session cannot forge a snapshot', () => {
    // A zero-cell write would put an all-idle file on disk that hydrates on the
    // next boot and reads as a durable NO-RUN rather than an absent one.
    hydrateCensusFromDir(dir);
    persistCensusDaySync(DAY, dir);
    expect(snapFiles(dir)).toEqual([]);
  });
});
