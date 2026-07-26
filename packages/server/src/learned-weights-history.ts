import { appendFile, readFile, mkdir, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { getEasternUtcOffset, WATCHLIST } from '@trading-app/shared';
import { logger } from './observability/index.js';
import { isLearnedShrinkageEnabled } from './learned-shrinkage-flag.js';
import {
  computeLearnedWeights,
  type LearnedStat,
  type LearnedWeights,
  type LearnedWeightsParams,
} from './learned-signal-weights.js';
import type { ReversalShadowRecord } from './reversal-shadow-ledger.js';

// TRA-2352 (parent TRA-927 → TRA-920 A2) — the daily learned-weights TRAIL.
//
// `GET /api/health/learned-weights` (TRA-925) folds the reversal shadow ledger
// into learned scoring multipliers LIVE on every call, so the weights can never
// drift from the source of truth. What it cannot show is the TRAJECTORY: how a
// given multiplier moved day-by-day as outcomes accrued. This module persists one
// snapshot of that fold per ET trading day so ops can read the trail.
//
// This is a WRITE-ONLY OBSERVER. Nothing consumes a snapshot to make a decision;
// `computeLearnedWeights` and `reversalSignalMultiplier` are untouched and the
// live endpoint keeps computing from the ledger, so no stale snapshot can ever
// reach the scoring path. No capital path — live promotion of learned multipliers
// stays gated behind TRA-382.
//
// ============================================================================
// THE LOAD-BEARING RULE: **NO BACK-FILL.** Do not "add catch-up like TRA-388".
// ============================================================================
// `catchUpMissedEodReports` (TRA-388) reconstructs a missed EOD report because a
// P&L report for a past day is a fact that can be recomputed exactly. A
// learned-weights snapshot is NOT. It is only meaningful stamped with the fold
// that EXISTED ON THAT DATE — and the only fold available to a catch-up pass is
// TODAY's. Reconstructing a missed day would therefore write TODAY's multipliers
// under YESTERDAY's date and silently fabricate the exact trajectory this trail
// exists to reveal: a flat, smooth, retroactively-consistent curve that never
// happened. A missed day is ABSENT, permanently. Readers MUST render gaps as gaps
// and MUST NOT interpolate across them.
//
// ---------------------------------------------------------------------------
// SIZING (mandatory amendment on the parent TRA-927 description, measured on
// prod `tradingai-bqb1` 2026-07-25): the live fold is `rows=106136`, and its full
// JSON payload is 161,544 bytes — buckets byScore 4 / byPattern 11 / **bySymbol
// 621**. bySymbol is ~97% of that payload (the shadow ledger records far beyond
// the traded universe), so persisting the FULL fold at 400-row retention would put
// ~64 MB on the Render disk. Therefore:
//   * byScore + byPattern persist in FULL (15 buckets — negligible).
//   * bySymbol persists WATCHLIST SYMBOLS ONLY, plus `bySymbolOmitted`, so a
//     reader can always see that the symbol dimension was trimmed and by how much.
// With the trim a row is ~10-15 KB and 400 rows bounds the file at ~4-6 MB.

const log = logger.child({ module: 'learned-weights-history' });

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Kill switch. The post-market tick is a hard no-op unless this is truthy, and
 * the flag is checked BEFORE the ledger is read so the tick is provably zero-IO
 * while off. Env-armed observer class (same as `ENABLE_REVERSAL_SHADOW` /
 * `ENABLE_ORB_OPTIONS_SHADOW`): deliberately NOT in `DEMO_FLAG_ALLOWLIST`, so it
 * cannot be flipped from the demo-flag UI — arming it is an operator env action.
 */
export const LEARNED_WEIGHTS_SNAPSHOT_FLAG = 'ENABLE_LEARNED_WEIGHTS_SNAPSHOT';

export function isLearnedWeightsSnapshotEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[LEARNED_WEIGHTS_SNAPSHOT_FLAG];
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** Newest-N rows kept on write — ~400 trading days ≈ 18 months of trail. */
export const MAX_SNAPSHOT_ROWS = 400;

export const LEARNED_WEIGHTS_HISTORY_FILENAME = 'learned-weights-history.jsonl';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** ET calendar-day string (YYYY-MM-DD) for a UTC ms instant (DST-aware). */
export function etDay(utcMs: number): string {
  const shifted = utcMs + getEasternUtcOffset(utcMs) * 3_600_000;
  return new Date(shifted).toISOString().slice(0, 10);
}

/**
 * One persisted dimension bucket. Deliberately NARROWER than {@link LearnedStat}:
 * the back-compat `multiplier` field is DROPPED because per
 * `learned-signal-weights.ts:63-70` it always equals `multiplierHardGate`.
 * Persisting both into a durable trail would invite a future reader to diff two
 * fields that can never differ. `shrinkageFlagEnabled` on the row says which of
 * the two multipliers was actually live that day.
 */
export interface SnapshotStat {
  key: string;
  total: number;
  resolved: number;
  tpHit: number;
  slHit: number;
  timeout: number;
  hitRate: number | null;
  avgR: number | null;
  multiplierHardGate: number;
  multiplierShrunk: number;
  confident: boolean;
}

/** One persisted day of the trail — a single JSONL line. */
export interface LearnedWeightsSnapshot {
  /** ET calendar day (YYYY-MM-DD). The row's identity — one row per date. */
  date: string;
  /** ms-epoch the snapshot was taken (the 21:00 ET archive tick). */
  generatedAt: number;
  /**
   * TRA-1056 A/B state at write time. Persisted PER ROW because the switch can
   * flip mid-trail, and without it a later reader cannot tell whether
   * `multiplierHardGate` or `multiplierShrunk` was the live multiplier that day.
   */
  shrinkageFlagEnabled: boolean;
  /** The fold's provenance — how much ledger it was taken over. */
  ledger: { rows: number; resolved: number; priorRate: number | null };
  params: LearnedWeightsParams;
  byScore: SnapshotStat[];
  byPattern: SnapshotStat[];
  /** WATCHLIST symbols only — see the SIZING note in the module header. */
  bySymbol: SnapshotStat[];
  /** Non-watchlist symbol buckets dropped from `bySymbol` by the sizing trim. */
  bySymbolOmitted: number;
}

function toSnapshotStat(s: LearnedStat): SnapshotStat {
  return {
    key: s.key,
    total: s.total,
    resolved: s.resolved,
    tpHit: s.tpHit,
    slHit: s.slHit,
    timeout: s.timeout,
    hitRate: s.hitRate,
    avgR: s.avgR,
    multiplierHardGate: s.multiplierHardGate,
    multiplierShrunk: s.multiplierShrunk,
    confident: s.confident,
  };
}

/**
 * Project a live fold into the bounded persisted row. Pure — no clock, no I/O,
 * no flag reads — so the shape is unit-testable against an injected fold.
 * `watchlist` is injectable purely so a test can prove the trim; production
 * always passes the real {@link WATCHLIST}.
 */
export function buildLearnedWeightsSnapshot(
  weights: LearnedWeights,
  opts: {
    date: string;
    generatedAt: number;
    shrinkageFlagEnabled: boolean;
    watchlist?: readonly string[];
  },
): LearnedWeightsSnapshot {
  const keep = new Set(opts.watchlist ?? WATCHLIST);
  const bySymbol = weights.bySymbol.filter((s) => keep.has(s.key));
  return {
    date: opts.date,
    generatedAt: opts.generatedAt,
    shrinkageFlagEnabled: opts.shrinkageFlagEnabled,
    ledger: { ...weights.generatedFrom },
    params: { ...weights.params },
    byScore: weights.byScore.map(toSnapshotStat),
    byPattern: weights.byPattern.map(toSnapshotStat),
    bySymbol: bySymbol.map(toSnapshotStat),
    bySymbolOmitted: weights.bySymbol.length - bySymbol.length,
  };
}

function defaultStoreFile(): string {
  const root = process.env['DATA_DIR'] ?? join(__dirname, '..', 'data');
  return join(root, LEARNED_WEIGHTS_HISTORY_FILENAME);
}

let storeFileOverride: string | null = null;
/** Test seam — point the trail at a temp file. Pass `null` to restore default. */
export function setLearnedWeightsHistoryFileForTests(path: string | null): void {
  storeFileOverride = path;
  cache = null;
}
export function learnedWeightsHistoryFile(): string {
  return storeFileOverride ?? defaultStoreFile();
}

/**
 * In-memory folded view: date -> row. The file is append-only, so a duplicate
 * date (only reachable if a trim/rewrite were interrupted) resolves LAST-line-wins
 * on load, matching the ORB/reversal ledger convention.
 */
let cache: Map<string, LearnedWeightsSnapshot> | null = null;

async function ensureLoaded(): Promise<Map<string, LearnedWeightsSnapshot>> {
  if (cache) return cache;
  const map = new Map<string, LearnedWeightsSnapshot>();
  const path = learnedWeightsHistoryFile();
  if (existsSync(path)) {
    try {
      const raw = await readFile(path, 'utf-8');
      for (const rawLine of raw.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed) continue;
        try {
          const rec = JSON.parse(trimmed) as LearnedWeightsSnapshot;
          // A truncated trailing line parses to garbage or throws; require a real
          // ISO date key before trusting it (mirrors `scheduler-state.ts:63`).
          if (rec && typeof rec.date === 'string' && ISO_DATE.test(rec.date)) {
            map.set(rec.date, rec);
          }
        } catch {
          // Skip a single corrupt/truncated line rather than losing the trail.
        }
      }
    } catch (err) {
      log.error('failed to read learned-weights history, starting empty', {
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }
  cache = map;
  return cache;
}

/** Eagerly load the trail so reads have data right after boot. */
export async function initLearnedWeightsHistory(): Promise<void> {
  await ensureLoaded();
}

function sortedRows(map: Map<string, LearnedWeightsSnapshot>): LearnedWeightsSnapshot[] {
  // `YYYY-MM-DD` sorts lexicographically == chronologically.
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * Retention. The normal path is a pure APPEND; the rewrite below only runs on the
 * rare tick that actually crosses the cap, and it goes through a temp file +
 * rename so an interrupted trim cannot truncate the accrued trail in place.
 */
async function trimIfNeeded(map: Map<string, LearnedWeightsSnapshot>, path: string): Promise<void> {
  if (map.size <= MAX_SNAPSHOT_ROWS) return;
  const rows = sortedRows(map);
  const kept = rows.slice(rows.length - MAX_SNAPSHOT_ROWS);
  const dropped = rows.length - kept.length;
  const tmp = `${path}.tmp`;
  await writeFile(tmp, kept.map((r) => `${JSON.stringify(r)}\n`).join(''), 'utf-8');
  await rename(tmp, path);
  map.clear();
  for (const r of kept) map.set(r.date, r);
  log.info('learned-weights history trimmed', {
    dropped, kept: kept.length, oldestKept: kept[0]?.date,
  });
}

/**
 * Append one snapshot row, deduped by ET date. Returns true iff a new row was
 * written. A same-date re-fire (the post-21:00 restart class TRA-1404 fixed for
 * the archive) is a NO-OP, not a second row.
 */
export async function appendLearnedWeightsSnapshot(row: LearnedWeightsSnapshot): Promise<boolean> {
  const map = await ensureLoaded();
  if (map.has(row.date)) return false;
  const path = learnedWeightsHistoryFile();
  const dir = dirname(path);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  await appendFile(path, `${JSON.stringify(row)}\n`, 'utf-8');
  map.set(row.date, row);
  await trimIfNeeded(map, path);
  log.info('learned-weights snapshot recorded', {
    date: row.date,
    rows: row.ledger.rows,
    resolved: row.ledger.resolved,
    bySymbolKept: row.bySymbol.length,
    bySymbolOmitted: row.bySymbolOmitted,
  });
  return true;
}

/** All persisted rows, ascending by date, optionally windowed inclusively. */
export async function listLearnedWeightsSnapshots(
  opts: { from?: string; to?: string } = {},
): Promise<LearnedWeightsSnapshot[]> {
  const map = await ensureLoaded();
  const { from, to } = opts;
  return sortedRows(map).filter(
    (r) => (from === undefined || r.date >= from) && (to === undefined || r.date <= to),
  );
}

export type SnapshotDimension = 'score' | 'pattern' | 'symbol';

/** One point on a single bucket's day-by-day trajectory. */
export interface TrajectoryPoint {
  date: string;
  resolved: number;
  hitRate: number | null;
  avgR: number | null;
  multiplierHardGate: number;
  multiplierShrunk: number;
  confident: boolean;
}

function dimensionOf(row: LearnedWeightsSnapshot, dimension: SnapshotDimension): SnapshotStat[] {
  if (dimension === 'score') return row.byScore;
  if (dimension === 'pattern') return row.byPattern;
  return row.bySymbol;
}

/**
 * The day-by-day trajectory of ONE bucket — the actual ops ask. A date where the
 * bucket does not exist yet is OMITTED, never zero-filled: a bucket that had not
 * been seen on that date is not the same as a bucket that scored zero, and
 * zero-filling would draw a downtrend that never happened. Missing DAYS are
 * likewise simply absent (see the no-back-fill rule) — callers must render gaps
 * as gaps.
 */
export function learnedWeightsTrajectory(
  rows: LearnedWeightsSnapshot[],
  dimension: SnapshotDimension,
  key: string,
): TrajectoryPoint[] {
  const out: TrajectoryPoint[] = [];
  for (const row of rows) {
    const stat = dimensionOf(row, dimension).find((s) => s.key === key);
    if (!stat) continue; // absent bucket -> omitted, not zero-filled
    out.push({
      date: row.date,
      resolved: stat.resolved,
      hitRate: stat.hitRate,
      avgR: stat.avgR,
      multiplierHardGate: stat.multiplierHardGate,
      multiplierShrunk: stat.multiplierShrunk,
      confident: stat.confident,
    });
  }
  return out;
}

export interface SnapshotTickResult {
  written: boolean;
  reason?: 'flag_off' | 'duplicate' | 'empty_ledger';
  date?: string;
}

/**
 * The post-market tick, hooked as the LAST statement of the 21:00 ET `onArchive`
 * block (after `runDailyCloseForAllUsers()`, so the day's resolutions are already
 * labelled into the ledger before the fold is taken).
 *
 * Order matters: the FLAG IS CHECKED FIRST, before `readLedger` is even called, so
 * while the flag is off this tick performs zero I/O (a test injects a throwing
 * reader to prove it). `readLedger` is injectable for that test; production passes
 * `listReversalShadowSignals`.
 */
export async function recordDailyLearnedWeightsSnapshot(opts: {
  readLedger: () => Promise<ReversalShadowRecord[]>;
  now?: number;
  env?: NodeJS.ProcessEnv;
  watchlist?: readonly string[];
}): Promise<SnapshotTickResult> {
  const env = opts.env ?? process.env;
  if (!isLearnedWeightsSnapshotEnabled(env)) return { written: false, reason: 'flag_off' };

  const now = opts.now ?? Date.now();
  const date = etDay(now);
  const rows = await opts.readLedger();
  const weights = computeLearnedWeights(rows);

  // An all-zero fold carries no information and would otherwise pad the trail
  // with an identical empty row every single day the shadow flag is off.
  if (weights.generatedFrom.rows === 0) return { written: false, reason: 'empty_ledger', date };

  const row = buildLearnedWeightsSnapshot(weights, {
    date,
    generatedAt: now,
    shrinkageFlagEnabled: isLearnedShrinkageEnabled(env),
    ...(opts.watchlist !== undefined ? { watchlist: opts.watchlist } : {}),
  });
  const written = await appendLearnedWeightsSnapshot(row);
  return written ? { written, date } : { written: false, reason: 'duplicate', date };
}
