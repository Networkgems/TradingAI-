// TRA-850 — file-backed PERSISTENT per-user trading memory for the advisory
// layer. Holds, per user, the advisory PREFERENCES the agent graph reads into its
// context (risk tolerance, preferred/avoided strategies, a de-risk sizing default,
// per-symbol watchlist rationale, free-form notes) so recommendations are
// personalized and consistent across sessions instead of stateless per tick.
//
// Two ways the memory fills:
//   • EXPLICIT — the user states a preference (`setUserMemory`, e.g. from the
//     settings UI / an HTTP PUT).
//   • LEARNED — every approve/reject interaction is tallied per strategy
//     (`recordInteractionOutcome`); a strategy the user repeatedly approves is
//     folded into `preferredStrategies`, one repeatedly rejected into
//     `avoidedStrategies`. Counts (not just the latest tap) gate the derivation
//     so a single click never rewrites a preference.
//
// STRICTLY PREFERENCES — nothing here is a self-modifying strategy. It never
// touches a strategy's parameters and never bypasses the promotion/calibration
// gate; the agent layer still only de-risks. Mirrors the promotion-store.ts
// file/cache/atomic-write pattern, but keyed by user.
import { readFile, writeFile, mkdir, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { UserTradingMemory } from '@trading-app/agents';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'user-trading-memory' });

const __dirname = dirname(fileURLToPath(import.meta.url));

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, 'user-trading-memory.json');
}

let storeFileOverride: string | null = null;
function storeFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/** Min approvals/rejections before an interaction tally derives a preference. */
const LEARN_THRESHOLD = 2;

/** Per-strategy approve/reject tally that drives the learned preferences. */
export interface StrategyInteractionStat {
  approved: number;
  rejected: number;
}

interface UserMemoryRecord {
  user: string;
  /** The read model the agent graph consumes (explicit + learned preferences). */
  memory: UserTradingMemory;
  /** Raw per-strategy interaction counts the learned preferences are derived from. */
  interactionStats: Record<string, StrategyInteractionStat>;
  updatedAt: string;
}

interface StoreFile {
  version: 1;
  users: Record<string, UserMemoryRecord>;
}

let cache: StoreFile | null = null;

/** Normalise a user key so an unset owner still has a stable bucket. */
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
    log.error('failed to read user-memory store, starting empty', {
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
  // Atomic write so a mid-write kill never leaves a truncated store.
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(cache, null, 2), 'utf-8');
  await rename(tmp, path);
}

function blankRecord(user: string, now: string): UserMemoryRecord {
  return { user, memory: { updatedAt: now }, interactionStats: {}, updatedAt: now };
}

/**
 * Eagerly load the store into the in-memory cache (call once at engine boot) so
 * the synchronous {@link getUserMemorySync} read on the hot advisory tick never
 * hits the disk. Safe to call repeatedly — a no-op once loaded.
 */
export async function loadUserMemoryStore(): Promise<void> {
  await ensureLoaded();
}

/**
 * Synchronous read of one user's persisted preferences for the live advisory
 * tick. Returns the cached memory (or an empty object when the user has none /
 * the store has not been loaded yet — additive: an empty memory leaves the graph
 * unchanged). Never throws, never touches disk.
 */
export function getUserMemorySync(user: string | undefined): UserTradingMemory {
  const rec = cache?.users[userKey(user)];
  return rec ? { ...rec.memory } : {};
}

/** Async read of one user's persisted preferences (loads the store if needed). */
export async function getUserMemory(user: string | undefined): Promise<UserTradingMemory> {
  const store = await ensureLoaded();
  const rec = store.users[userKey(user)];
  return rec ? { ...rec.memory } : {};
}

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** Validate + normalise an explicit preference patch (drops unknown/invalid fields). */
function sanitizePatch(patch: Partial<UserTradingMemory>): Partial<UserTradingMemory> {
  const out: Partial<UserTradingMemory> = {};
  if (patch.riskTolerance === 'conservative' || patch.riskTolerance === 'moderate' || patch.riskTolerance === 'aggressive') {
    out.riskTolerance = patch.riskTolerance;
  }
  if (Array.isArray(patch.preferredStrategies)) {
    out.preferredStrategies = dedupeStrategies(patch.preferredStrategies);
  }
  if (Array.isArray(patch.avoidedStrategies)) {
    out.avoidedStrategies = dedupeStrategies(patch.avoidedStrategies);
  }
  if (typeof patch.sizingMultiplier === 'number' && Number.isFinite(patch.sizingMultiplier)) {
    out.sizingMultiplier = clamp01(patch.sizingMultiplier);
  }
  if (patch.watchlistRationale && typeof patch.watchlistRationale === 'object') {
    const r: Record<string, string> = {};
    for (const [sym, why] of Object.entries(patch.watchlistRationale)) {
      if (typeof why === 'string' && why.trim() !== '') r[sym.toUpperCase()] = why.trim();
    }
    out.watchlistRationale = r;
  }
  if (typeof patch.notes === 'string') out.notes = patch.notes.trim();
  return out;
}

function dedupeStrategies(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const s of list) {
    const v = String(s).trim().toLowerCase();
    if (v && !seen.has(v)) { seen.add(v); out.push(v); }
  }
  return out;
}

/**
 * Merge an explicit preference patch into a user's memory and persist. Scalar
 * fields and arrays REPLACE; `watchlistRationale` MERGES by symbol (a per-symbol
 * entry set to an empty string clears that symbol). Invalid/unknown fields are
 * dropped by {@link sanitizePatch}. Returns the updated memory.
 */
export async function setUserMemory(
  user: string | undefined,
  patch: Partial<UserTradingMemory>,
  now: string = new Date().toISOString(),
): Promise<UserTradingMemory> {
  const store = await ensureLoaded();
  const key = userKey(user);
  const rec = store.users[key] ?? blankRecord(key, now);
  const clean = sanitizePatch(patch);

  const merged: UserTradingMemory = { ...rec.memory };
  if (clean.riskTolerance !== undefined) merged.riskTolerance = clean.riskTolerance;
  if (clean.preferredStrategies !== undefined) merged.preferredStrategies = clean.preferredStrategies;
  if (clean.avoidedStrategies !== undefined) merged.avoidedStrategies = clean.avoidedStrategies;
  if (clean.sizingMultiplier !== undefined) merged.sizingMultiplier = clean.sizingMultiplier;
  if (clean.notes !== undefined) merged.notes = clean.notes;
  if (clean.watchlistRationale !== undefined) {
    const next = { ...(merged.watchlistRationale ?? {}) };
    // The patch already uppercased + trimmed; honour explicit clears.
    for (const [sym, why] of Object.entries(patch.watchlistRationale ?? {})) {
      const SYM = sym.toUpperCase();
      if (typeof why === 'string' && why.trim() === '') delete next[SYM];
      else if (clean.watchlistRationale[SYM]) next[SYM] = clean.watchlistRationale[SYM]!;
    }
    merged.watchlistRationale = next;
  }
  merged.updatedAt = now;

  rec.memory = merged;
  rec.updatedAt = now;
  store.users[key] = rec;
  await persist();
  log.info('updated user trading memory (explicit)', { user: key, fields: Object.keys(clean) });
  return { ...merged };
}

/**
 * LEARNED preferences: record one approve/reject interaction for a strategy type
 * and re-derive the user's preferred/avoided lists from the running tally. A
 * strategy the user has approved at least {@link LEARN_THRESHOLD} times (and more
 * than rejected) is preferred; one rejected at least that many times (and more
 * than approved) is avoided. Counts gate the derivation so a single tap never
 * rewrites a preference — and a later reversal moves the strategy back out.
 * No-ops (but still tallies) when `strategyType` is blank. Returns the updated
 * memory.
 */
export async function recordInteractionOutcome(
  user: string | undefined,
  args: { strategyType: string | undefined; accepted: boolean },
  now: string = new Date().toISOString(),
): Promise<UserTradingMemory> {
  const strat = (args.strategyType ?? '').trim().toLowerCase();
  if (!strat) return getUserMemory(user);

  const store = await ensureLoaded();
  const key = userKey(user);
  const rec = store.users[key] ?? blankRecord(key, now);

  const stat = rec.interactionStats[strat] ?? { approved: 0, rejected: 0 };
  if (args.accepted) stat.approved += 1;
  else stat.rejected += 1;
  rec.interactionStats[strat] = stat;

  // Re-derive preferred/avoided from the full tally (idempotent + reversible).
  const preferred: string[] = [];
  const avoided: string[] = [];
  for (const [s, st] of Object.entries(rec.interactionStats)) {
    if (st.approved >= LEARN_THRESHOLD && st.approved > st.rejected) preferred.push(s);
    else if (st.rejected >= LEARN_THRESHOLD && st.rejected > st.approved) avoided.push(s);
  }
  rec.memory = {
    ...rec.memory,
    preferredStrategies: preferred.sort(),
    avoidedStrategies: avoided.sort(),
    updatedAt: now,
  };
  rec.updatedAt = now;
  store.users[key] = rec;
  await persist();
  log.info('recorded advisory interaction outcome', {
    user: key, strategyType: strat, accepted: args.accepted,
    approved: stat.approved, rejected: stat.rejected,
  });
  return { ...rec.memory };
}

/** Read one user's raw interaction tally (for diagnostics / the settings UI). */
export async function getInteractionStats(
  user: string | undefined,
): Promise<Record<string, StrategyInteractionStat>> {
  const store = await ensureLoaded();
  const rec = store.users[userKey(user)];
  return rec ? { ...rec.interactionStats } : {};
}

/** Test-only helper: reset the in-memory cache and (optionally) override the on-disk path. */
export function __resetUserMemoryStoreForTests(overridePath?: string | null): void {
  cache = null;
  storeFileOverride = overridePath ?? null;
}
