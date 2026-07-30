// TRA-851 — file-backed per-user routine store.
//
// Persists the recurring jobs a user has defined (see routine-spec.ts) so they
// survive a restart/redeploy, keyed by user. Mirrors the
// user-trading-memory-store.ts file/cache/atomic-write pattern: a single JSON
// file, an in-memory cache for the synchronous hot read the scheduler tick does,
// and a tmp+rename atomic write so a mid-write kill never truncates the store.
//
// Ids are a per-user monotonic sequence (`r1`, `r2`, …) derived from the stored
// `nextSeq` — no clock / randomness, so a resume is deterministic.

import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { logger } from '../observability/index.js';
import type { ParsedRoutine, RoutineAction, RoutineFilter } from './routine-spec.js';
import { resolveDataDir } from '../data-dir.js';

const log = logger.child({ module: 'routine-store' });

// TRA-2604 — this is the ONE file in the 38-copy migration whose UNSET-DATA_DIR
// branch actually moves, and it moves because the old copy was wrong. The literal
// anchored `join(__dirname, '..', 'data')` to THIS file's directory, and this file
// lives one level down in `routines/` — so it resolved to `<bundle>/routines/../data`
// = `<bundle>/data`, while `index.ts` and every sibling store resolved to
// `<pkg>/data`. Two roots, one of which nobody intended. `resolveDataDir()` anchors
// to the canonical one, which is the whole point of the one-predicate rule (TRA-1681).
// Both of those paths are in-bundle and evaporate on redeploy, so nothing durable
// moves; when DATA_DIR is set (the bqb1 config) the old and new roots are identical.
function defaultStoreFile(): string {
  const root = resolveDataDir();
  return join(root, 'user-routines.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** A persisted routine: a {@link ParsedRoutine} plus store-assigned identity. */
export interface StoredRoutine extends ParsedRoutine {
  id: string;
  /** Verbatim phrase the user typed, kept for display / audit. */
  raw: string;
  enabled: boolean;
  createdAt: string;
}

interface UserRoutineRecord {
  routines: StoredRoutine[];
  /** Next id sequence for this user (monotonic, never reused). */
  nextSeq: number;
}

interface StoreFile {
  version: 1;
  users: Record<string, UserRoutineRecord>;
}

let cache: StoreFile | null = null;

/** Per-user cap so a runaway add loop can't unbound the file or the fire loop. */
export const MAX_ROUTINES_PER_USER = 25;

function userKey(user: string | undefined): string {
  const u = (user ?? '').trim();
  return u === '' ? 'anonymous' : u;
}

async function ensureLoaded(): Promise<StoreFile> {
  if (cache) return cache;
  const path = storeFile();
  if (!existsSync(path)) {
    cache = { version: 1, users: {} };
    return cache;
  }
  try {
    const raw = await readFile(path, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    cache = { version: 1, users: parsed.users ?? {} };
  } catch (err) {
    log.error('failed to read routine store, starting empty', {
      reason: err instanceof Error ? err.message : String(err),
    });
    cache = { version: 1, users: {} };
  }
  return cache;
}

async function persist(): Promise<void> {
  if (!cache) return;
  const path = storeFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  await rename(tmp, path);
}

function record(store: StoreFile, key: string): UserRoutineRecord {
  let rec = store.users[key];
  if (!rec) {
    rec = { routines: [], nextSeq: 1 };
    store.users[key] = rec;
  }
  return rec;
}

/**
 * Eagerly load the store into the in-memory cache (call once at boot) so the
 * synchronous {@link listRoutinesSync} read on the scheduler tick never hits the
 * disk. Safe to call repeatedly.
 */
export async function loadRoutineStore(): Promise<void> {
  await ensureLoaded();
}

/** Synchronous read of a user's routines for the live scheduler tick. Never throws. */
export function listRoutinesSync(user: string | undefined): StoredRoutine[] {
  const rec = cache?.users[userKey(user)];
  return rec ? rec.routines.map((r) => ({ ...r })) : [];
}

/** Async read of a user's routines (loads the store if needed). */
export async function listRoutines(user: string | undefined): Promise<StoredRoutine[]> {
  const store = await ensureLoaded();
  const rec = store.users[userKey(user)];
  return rec ? rec.routines.map((r) => ({ ...r })) : [];
}

/** Every user key that currently has at least one routine (for the runner). */
export function usersWithRoutinesSync(): string[] {
  if (!cache) return [];
  return Object.entries(cache.users)
    .filter(([, rec]) => rec.routines.length > 0)
    .map(([key]) => key);
}

export type AddRoutineResult =
  | { ok: true; routine: StoredRoutine }
  | { ok: false; error: string };

/**
 * Add a parsed routine for a user and persist. Assigns a monotonic id, defaults
 * `enabled` true. Rejects once the per-user cap is hit. Returns the stored
 * routine (with its assigned id) on success.
 */
export async function addRoutine(
  user: string | undefined,
  parsed: ParsedRoutine,
  raw: string,
  now: string = new Date().toISOString(),
): Promise<AddRoutineResult> {
  const store = await ensureLoaded();
  const key = userKey(user);
  const rec = record(store, key);
  if (rec.routines.length >= MAX_ROUTINES_PER_USER) {
    return { ok: false, error: `Routine limit reached (${MAX_ROUTINES_PER_USER}). Remove one first.` };
  }
  const id = `r${rec.nextSeq}`;
  rec.nextSeq += 1;
  const routine: StoredRoutine = {
    id,
    raw: raw.trim(),
    action: parsed.action,
    timeEt: parsed.timeEt,
    marketDaysOnly: parsed.marketDaysOnly,
    enabled: true,
    createdAt: now,
    ...(parsed.filter ? { filter: parsed.filter } : {}),
  };
  rec.routines.push(routine);
  await persist();
  log.info('added routine', { user: key, id, action: routine.action, timeEt: routine.timeEt });
  return { ok: true, routine: { ...routine } };
}

/** Remove a routine by id. Returns true when one was removed. */
export async function removeRoutine(user: string | undefined, id: string): Promise<boolean> {
  const store = await ensureLoaded();
  const rec = store.users[userKey(user)];
  if (!rec) return false;
  const before = rec.routines.length;
  rec.routines = rec.routines.filter((r) => r.id !== id);
  if (rec.routines.length === before) return false;
  await persist();
  log.info('removed routine', { user: userKey(user), id });
  return true;
}

/** Enable / disable a routine by id without deleting it. Returns the updated routine or null. */
export async function setRoutineEnabled(
  user: string | undefined,
  id: string,
  enabled: boolean,
): Promise<StoredRoutine | null> {
  const store = await ensureLoaded();
  const rec = store.users[userKey(user)];
  if (!rec) return null;
  const routine = rec.routines.find((r) => r.id === id);
  if (!routine) return null;
  routine.enabled = enabled;
  await persist();
  log.info('toggled routine', { user: userKey(user), id, enabled });
  return { ...routine };
}

/** Re-export for callers wiring the store to the chat/HTTP layer. */
export type { ParsedRoutine, RoutineAction, RoutineFilter };

/** Test-only: reset the in-memory cache and optionally override the on-disk path. */
export function __resetRoutineStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
