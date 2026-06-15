import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  loadRoutineStore,
  listRoutines,
  listRoutinesSync,
  usersWithRoutinesSync,
  addRoutine,
  removeRoutine,
  setRoutineEnabled,
  MAX_ROUTINES_PER_USER,
  __resetRoutineStoreForTests,
} from './routine-store.js';
import type { ParsedRoutine } from './routine-spec.js';

let dir: string;
let file: string;

const brief: ParsedRoutine = { action: 'brief', timeEt: '08:30', marketDaysOnly: true };
const scanSemis: ParsedRoutine = {
  action: 'scan',
  timeEt: '09:30',
  marketDaysOnly: true,
  filter: { sector: 'semis' },
};

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'routine-store-'));
  file = join(dir, 'routines.json');
  __resetRoutineStoreForTests(file);
  await loadRoutineStore();
});

afterEach(async () => {
  __resetRoutineStoreForTests(null);
  await rm(dir, { recursive: true, force: true });
});

describe('TRA-851 routine store', () => {
  it('adds a routine with a monotonic id and persists it', async () => {
    const res = await addRoutine('alice', brief, 'brief me at 8:30', '2026-06-14T00:00:00Z');
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.routine.id).toBe('r1');
    expect(res.routine.enabled).toBe(true);
    expect(res.routine.raw).toBe('brief me at 8:30');

    const second = await addRoutine('alice', scanSemis, 'scan semis daily');
    expect(second.ok && second.routine.id).toBe('r2');

    // Survives a cache drop + reload (persisted to disk).
    __resetRoutineStoreForTests(file);
    await loadRoutineStore();
    const list = await listRoutines('alice');
    expect(list.map((r) => r.id)).toEqual(['r1', 'r2']);
    expect(list[1]!.filter).toEqual({ sector: 'semis' });

    const raw = JSON.parse(await readFile(file, 'utf-8'));
    expect(raw.users.alice.nextSeq).toBe(3);
  });

  it('ids are never reused after a removal', async () => {
    await addRoutine('bob', brief, 'a');
    await addRoutine('bob', brief, 'b');
    expect(await removeRoutine('bob', 'r1')).toBe(true);
    const res = await addRoutine('bob', brief, 'c');
    expect(res.ok && res.routine.id).toBe('r3'); // not r1
  });

  it('isolates routines per user', async () => {
    await addRoutine('alice', brief, 'a');
    await addRoutine('bob', scanSemis, 'b');
    expect(listRoutinesSync('alice')).toHaveLength(1);
    expect(listRoutinesSync('bob')).toHaveLength(1);
    expect(usersWithRoutinesSync().sort()).toEqual(['alice', 'bob']);
  });

  it('toggles enabled without deleting', async () => {
    await addRoutine('alice', brief, 'a');
    const off = await setRoutineEnabled('alice', 'r1', false);
    expect(off?.enabled).toBe(false);
    expect(listRoutinesSync('alice')[0]!.enabled).toBe(false);
    const on = await setRoutineEnabled('alice', 'r1', true);
    expect(on?.enabled).toBe(true);
  });

  it('reports false / null for an unknown id', async () => {
    expect(await removeRoutine('alice', 'r9')).toBe(false);
    expect(await setRoutineEnabled('alice', 'r9', false)).toBeNull();
  });

  it('enforces the per-user cap', async () => {
    for (let i = 0; i < MAX_ROUTINES_PER_USER; i++) {
      const r = await addRoutine('alice', brief, `r${i}`);
      expect(r.ok).toBe(true);
    }
    const over = await addRoutine('alice', brief, 'one too many');
    expect(over.ok).toBe(false);
  });

  it('empty / unknown users have no routines', () => {
    expect(listRoutinesSync(undefined)).toEqual([]);
    expect(usersWithRoutinesSync()).toEqual([]);
  });
});
