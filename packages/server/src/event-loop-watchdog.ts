// TRA-1080 — event-loop / heap starvation watchdog with clean self-restart.
//
// Root cause of the recurring bqb1 502 (TRA-937 / TRA-1079 lineage): after ~1h
// of RTH trading the Node process is ALIVE and trading (worker timers keep
// firing) but the HTTP listener is dead — Render health checks 504/502 and the
// process hangs in "502 limbo" until a manual redeploy. The mechanism is
// progressive per-tick CPU/memory growth that starves the libuv event loop
// (GC thrash near the heap ceiling + synchronous tick work), so `http.accept`
// never gets a turn even though the process is not crashed.
//
// A redeploy only buys ~1h; it is not a fix. The durable mitigation here is a
// supervisor that DETECTS the starved state from inside the process and exits
// cleanly with a non-zero code so Render restarts it — converting an
// indefinite 502 hang into a ~30s restart blip. It complements (does not
// replace) the growth-reduction work in TRA-942/943/1053 and any future move of
// the engine onto a worker thread.
//
// Two independent trip conditions, each requiring SUSTAINED breach (N
// consecutive samples) so a single GC pause or one slow tick never restarts a
// healthy process:
//
//   1. Event-loop lag — the direct symptom. `monitorEventLoopDelay` measures how
//      late timers fire; sustained multi-second lag IS the HTTP listener being
//      starved. This is the signal a heap watermark alone would miss when the
//      starvation is CPU-bound rather than GC-bound.
//   2. Heap watermark — `heapUsed / heap_size_limit`. Sustained near-ceiling
//      heap means the next allocations trigger back-to-back full GCs (the GC
//      thrash that starves the loop). Restarting before the hard OOM gives a
//      clean exit + flushed logs instead of an abrupt SIGKILL.
//
// TRA-1374 adds a third, ACUTE condition (single sample, no consecutive
// requirement) for the failure the two above are blind to:
//
//   3. RSS ceiling — `process.memoryUsage().rss` vs an absolute container
//      limit. The recurring bqb1 kill is `nonZeroExit: 137` (cgroup OOM-killer)
//      driven by a sub-minute native/external-memory burst that lives OUTSIDE
//      the V8 heap, so the heap watermark never sees it and the sustained trips
//      can't react in time. One sample over the ceiling restarts cleanly NOW,
//      beating the platform's hard kill.
//
// Monitoring is always cheap and always on; the RESTART action defaults ON
// because the whole point of the ticket is "self-restarts cleanly … no hanging
// 502 limbo" and the prod box has no operator-in-the-loop to flip a flag mid-
// incident. It only ever fires on genuine pathology (≥10s of >2s lag, or ≥10s
// above 92% heap), so a false-positive restart of a healthy box is implausible.
// Set WATCHDOG_RESTART_ENABLED=false to observe-only, or WATCHDOG_ENABLED=false
// to disable entirely. All thresholds are env-tunable (see resolveConfig).

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { logger, flushLogs } from './observability/index.js';
import { getPhaseAttribution, type PhaseAttribution, type SlowPhase } from './phase-timing.js';

const log = logger.child({ module: 'event-loop-watchdog' });

// TRA-1463 — durable trip-reason breadcrumb. The trip reason (heap / lag /
// block / rss) is logged to Render's stdout and held in the in-memory
// `lastStatus`, but BOTH are wiped by the restart the trip causes — so after
// the ~85-min bqb1 self-restart there is no queryable record of WHY it died,
// which is exactly why scope item 1 ("OOM/SIGKILL 137 vs event-loop-starvation")
// has stayed unresolved without Render-log access. We persist the trip record
// to a tiny JSON file on the DATA_DIR persistent disk immediately before exit
// and re-read it on the next boot, surfacing it on `/api/health/watchdog` as
// `lastTrip`. This turns the very next self-restart into hard root-cause
// evidence (reason + uptime-at-trip + heap/rss/lag at the moment of death) with
// zero polling and no platform log access. Observability only — no behaviour,
// rate, or capital change. Env-disableable via WATCHDOG_TRIP_PERSIST=false.
export const WATCHDOG_TRIP_PERSIST_VAR = 'WATCHDOG_TRIP_PERSIST';
export const WATCHDOG_TRIP_LOG_PATH_VAR = 'WATCHDOG_TRIP_LOG_PATH';

/** A durable record of the most recent watchdog self-restart. */
export interface PersistedTrip {
  reason: 'heap' | 'lag' | 'block' | 'rss';
  detail: string;
  /** Wall-clock (ms) when the trip fired. */
  atMs: number;
  /** Process uptime (s) at the moment of trip — the ~85-min cap lands here. */
  uptimeSecAtTrip: number;
  heapUsedMB: number;
  heapLimitMB: number;
  rssMB: number;
  /**
   * TRA-1463 — off-heap attribution at the moment of an `rss` trip. `external` is
   * Buffers/ArrayBuffers + other C++ objects bound to JS (this is where undici's
   * unconsumed HTTP response bodies from the crypto fan-out land); `arrayBuffers`
   * is the ArrayBuffer/SharedArrayBuffer slice of that. A `rss` trip with `external`
   * near the RSS ceiling ⇒ retained response-body Buffers (fix: abort/cancel the
   * body on ALL providers, not just Coinbase). A `rss` trip with a small `external`
   * but a huge `rss` ⇒ native/malloc-arena fragmentation (fix: allocator tuning,
   * e.g. MALLOC_ARENA_MAX). Optional so pre-existing trip files stay readable.
   */
  externalMB?: number;
  arrayBuffersMB?: number;
  lagMeanMs: number;
  lagMaxMs: number;
  /**
   * TRA-1463 — synchronous-phase attribution at the moment of the trip. For a
   * `block` trip (the residual bqb1 ~71s single-window stall) this names the
   * instrumented synchronous phase whose wall time just crossed the slow
   * threshold — i.e. the code that blocked the loop — turning the very next
   * self-restart's breadcrumb into a NAMED culprit instead of a bare lag number.
   * Optional so pre-existing trip files stay readable and non-`block` trips omit it.
   */
  slowPhase?: SlowPhase | null;
  /**
   * TRA-1463 — the async tick/driver phase IN FLIGHT at the moment of the trip.
   * For a `block` occurring inside an async tick this names the SUBSYSTEM whose
   * synchronous section starved the loop (e.g. `crypto.doTick`), even when the
   * block was the last op before the fn returned (which clears `slowPhase`'s
   * pointer). `elapsedMs` is how long that phase had been running at trip time.
   */
  activePhase?: { name: string; elapsedMs: number } | null;
}

// TRA-1463 — periodic LIVENESS breadcrumb. `lastTrip` above only records a
// death the watchdog itself caused (a clean self-exit through `persistTripRecord`
// on line ~669). But the residual ~85-min bqb1 kill is `nonZeroExit: 137` — a
// cgroup SIGKILL from a sub-minute RSS burst that overshoots the acute `rssMaxBytes`
// ceiling INSIDE a single sample, so the platform kills the process before the
// watchdog's exit path runs. That death persists NOTHING, so the next boot reads
// `lastTrip: null` and the "OOM/SIGKILL 137 vs event-loop-starvation" question
// (scope item 1) is structurally unanswerable from `lastTrip` alone — exactly the
// blind spot that has kept this issue open. Fix: every process writes a tiny
// last-known-alive snapshot to the DATA_DIR disk on a throttled cadence. After
// ANY death — graceful trip, external SIGKILL 137, or health-check-timeout SIGTERM
// — the next boot re-reads this file as `priorLiveness`: the uptime / RSS / off-heap
// / lag at the last heartbeat before the box went dark. A `priorLiveness` with
// uptime ≈ 85 min and RSS climbing toward the ceiling ⇒ the 137 burst still fires
// (MALLOC_ARENA_MAX floor insufficient); a flat RSS with spiking lag ⇒ event-loop
// starvation instead. Observability only — no behaviour/rate/capital change.
// Env-disableable via WATCHDOG_LIVENESS_PERSIST=false.
export const WATCHDOG_LIVENESS_PERSIST_VAR = 'WATCHDOG_LIVENESS_PERSIST';
export const WATCHDOG_LIVENESS_INTERVAL_MS_VAR = 'WATCHDOG_LIVENESS_INTERVAL_MS';
export const WATCHDOG_LIVENESS_LOG_PATH_VAR = 'WATCHDOG_LIVENESS_LOG_PATH';

/**
 * The last-known-alive snapshot, rewritten on a throttled cadence by the running
 * process and re-read once by the NEXT boot. Unlike {@link PersistedTrip} this is
 * written on a timer, not at death, so it survives a kill that bypasses the
 * watchdog exit path (external SIGKILL 137 / health-check-timeout SIGTERM).
 */
export interface PersistedLiveness {
  /** Wall-clock (ms) of this heartbeat write. */
  atMs: number;
  /** Process uptime (s) at the heartbeat — the last value before the box died. */
  uptimeSec: number;
  rssMB: number;
  heapUsedMB: number;
  heapLimitMB: number;
  /** heapUsed / heap_size_limit at the heartbeat. */
  heapPct: number;
  externalMB?: number;
  arrayBuffersMB?: number;
  lagMeanMs: number;
  lagMaxMs: number;
  /**
   * TRA-1463 — the most-recent slow synchronous phase recorded at the moment of
   * this liveness heartbeat. On a death that bypasses the watchdog exit path
   * (external SIGKILL 137 / health-check SIGTERM), the NEXT boot reads this as
   * `priorLiveness.slowPhase` — the last synchronous phase that held the loop
   * before the box went dark. Optional so older breadcrumbs stay readable.
   */
  slowPhase?: SlowPhase | null;
  /**
   * TRA-1463 — the async tick/driver phase in flight at this heartbeat. On an
   * external kill (SIGKILL 137 / health-check SIGTERM) mid-block, the next boot's
   * `priorLiveness.activePhase` names the subsystem that was executing when the
   * box went dark. Optional so older breadcrumbs stay readable.
   */
  activePhase?: { name: string; elapsedMs: number } | null;
}

/**
 * Resolve the trip-breadcrumb path to `<DATA_DIR>/watchdog-last-trip.json` (the
 * Render persistent disk, so it survives the restart), or an explicit
 * WATCHDOG_TRIP_LOG_PATH override. Returns null when NEITHER is configured —
 * i.e. local dev / unit tests with no durable disk — so persistence is inert
 * there and never writes stray files into the working tree.
 */
export function resolveTripLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[WATCHDOG_TRIP_LOG_PATH_VAR];
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const dataDir = env.DATA_DIR;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    return join(dataDir.trim(), 'watchdog-last-trip.json');
  }
  return null;
}

/** Best-effort synchronous read of the last persisted trip (null if none/unreadable). */
export function readLastTrip(env: NodeJS.ProcessEnv = process.env): PersistedTrip | null {
  try {
    const path = resolveTripLogPath(env);
    if (!path || !existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as PersistedTrip;
    if (!parsed || typeof parsed.reason !== 'string') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Best-effort SYNCHRONOUS write of the trip record just before exit. Sync (not
 * async) on purpose: the process is exiting immediately, so an async write could
 * be dropped; a small synchronous fs.writeFileSync completes before exit(1).
 * Fully guarded — a write failure must never block the clean restart.
 */
function persistTripRecord(record: PersistedTrip, env: NodeJS.ProcessEnv = process.env): void {
  if (!envBool(env[WATCHDOG_TRIP_PERSIST_VAR], true)) return;
  try {
    const path = resolveTripLogPath(env);
    if (!path) return; // no durable disk configured (local/dev) — nothing to write
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(record), 'utf8');
  } catch (err) {
    log.warn('failed to persist watchdog trip breadcrumb', { err: String(err) });
  }
}

/**
 * Resolve the liveness-breadcrumb path to `<DATA_DIR>/watchdog-liveness.json`, or
 * an explicit WATCHDOG_LIVENESS_LOG_PATH override. Null when neither is set (local
 * dev / tests) so the heartbeat is inert and never litters the working tree —
 * mirrors {@link resolveTripLogPath}.
 */
export function resolveLivenessLogPath(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env[WATCHDOG_LIVENESS_LOG_PATH_VAR];
  if (typeof explicit === 'string' && explicit.trim() !== '') return explicit.trim();
  const dataDir = env.DATA_DIR;
  if (typeof dataDir === 'string' && dataDir.trim() !== '') {
    return join(dataDir.trim(), 'watchdog-liveness.json');
  }
  return null;
}

/** Best-effort synchronous read of the prior process's last liveness heartbeat (null if none/unreadable). */
export function readLastLiveness(env: NodeJS.ProcessEnv = process.env): PersistedLiveness | null {
  try {
    const path = resolveLivenessLogPath(env);
    if (!path || !existsSync(path)) return null;
    const raw = readFileSync(path, 'utf8');
    const parsed = JSON.parse(raw) as PersistedLiveness;
    if (!parsed || typeof parsed.uptimeSec !== 'number' || typeof parsed.rssMB !== 'number') return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Best-effort synchronous write of the liveness heartbeat. Synchronous like the
 * trip write, but this runs on a throttled cadence during normal operation, so it
 * is guarded by the caller's interval gate (see the `publish` heartbeat) to keep
 * the added blocking to a ~200-byte write every WATCHDOG_LIVENESS_INTERVAL_MS
 * (default 15s) — sub-millisecond, negligible against the ~0.3 vCPU load. Fully
 * guarded — a write failure must never disturb the running box.
 */
function persistLivenessHeartbeat(record: PersistedLiveness, env: NodeJS.ProcessEnv = process.env): void {
  if (!envBool(env[WATCHDOG_LIVENESS_PERSIST_VAR], true)) return;
  try {
    const path = resolveLivenessLogPath(env);
    if (!path) return; // no durable disk configured (local/dev) — nothing to write
    const dir = dirname(path);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    writeFileSync(path, JSON.stringify(record), 'utf8');
  } catch (err) {
    log.warn('failed to persist watchdog liveness breadcrumb', { err: String(err) });
  }
}

export const WATCHDOG_ENABLED_VAR = 'WATCHDOG_ENABLED';
export const WATCHDOG_RESTART_ENABLED_VAR = 'WATCHDOG_RESTART_ENABLED';
export const WATCHDOG_SAMPLE_MS_VAR = 'WATCHDOG_SAMPLE_MS';
export const WATCHDOG_HEAP_PCT_VAR = 'WATCHDOG_HEAP_PCT';
export const WATCHDOG_LAG_MS_VAR = 'WATCHDOG_LAG_MS';
export const WATCHDOG_BREACH_SAMPLES_VAR = 'WATCHDOG_BREACH_SAMPLES';
export const WATCHDOG_BLOCK_MS_VAR = 'WATCHDOG_BLOCK_MS';
export const WATCHDOG_BOOT_GRACE_MS_VAR = 'WATCHDOG_BOOT_GRACE_MS';
export const WATCHDOG_RSS_MAX_MB_VAR = 'WATCHDOG_RSS_MAX_MB';

export interface WatchdogConfig {
  /** Master switch. When false, the watchdog never starts (zero overhead). */
  enabled: boolean;
  /** When false, the watchdog measures + surfaces metrics but never exits. */
  restartEnabled: boolean;
  /** Sample/evaluate cadence in ms. */
  sampleMs: number;
  /** Heap trip ratio in (0, 1]: heapUsed / heap_size_limit. */
  heapPct: number;
  /** Event-loop mean-lag trip threshold in ms (per sample window). */
  lagMs: number;
  /** Consecutive breached samples required before a restart trips. */
  breachSamples: number;
  /**
   * TRA-1082 — acute single-block trip. A single sample whose *max* event-loop
   * lag exceeds this trips a clean self-restart IMMEDIATELY (no consecutive
   * requirement), because one block this large means the HTTP listener already
   * missed Render's 5s health-check window. Set below Render's 5s timeout so the
   * watchdog's clean exit beats Render's hard restart. The sustained mean-lag
   * trip above stays the slow-burn backstop; this catches the acute stall the
   * loose sustained threshold (10s of >2s mean lag) was a no-op against.
   */
  lagMaxMs: number;
  /**
   * TRA-1374 — acute RSS ceiling trip, in bytes (0 disables). The heap trip
   * (`heapPct`) only sees the V8 heap; the recurring bqb1 kill is `nonZeroExit:
   * 137` (cgroup SIGKILL) driven by a sub-minute RSS burst — native/external
   * memory (HTTP response buffers from the full-universe crypto fan-out) that
   * lives OUTSIDE the V8 heap and so never moves `heapUsed`. Steady RSS is only
   * ~0.3-0.75 GB, then one heavy tick spikes RSS past the container ceiling
   * faster than the sustained heap/lag trips (which need `breachSamples`
   * consecutive windows) can react, so the platform hard-kills first — no clean
   * exit, no flushed logs, no graceful state persist. This is an ACUTE
   * single-sample trip (like `lagMaxMs`): one sample whose `process.memoryUsage()
   * .rss` clears this ceiling restarts cleanly NOW, beating the cgroup kill. Set
   * below the container's memory limit with headroom for the exit drain.
   */
  rssMaxBytes: number;
  /**
   * TRA-1687 — the container's ACTUAL memory limit, read from the cgroup at
   * boot; null when there is no readable cgroup (dev boxes: Windows, macOS).
   *
   * This is the number `rssMaxBytes` must sit below, and until TRA-1687 NOTHING
   * in this system had ever read it. The watchdog took its ceiling from an env
   * var, and the checker that graded that ceiling mapped Render's PLAN NAME
   * through a lookup table (`pro -> 4096MB`). Both are claims ABOUT the box.
   * This is a measurement OF it.
   */
  cgroupLimitBytes: number | null;
  /** How `rssMaxBytes` was arrived at. Surfaced so a gate can grade the SOURCE, not just the value. */
  rssMaxSource: RssCeilingSource;
  /** Set when the resolved ceiling is suspect (see {@link resolveRssCeiling}); surfaced on /api/health/watchdog. */
  rssMaxWarning: string | null;
  /**
   * TRA-1084 — boot/warmup grace. The watchdog measures from process start, but
   * RESTART trips are suppressed until the process has been up this long. During
   * warmup the per-book engines synchronously load candle history for the full
   * watchlist; that legitimately blocks the loop past the acute `lagMaxMs`
   * threshold for a few seconds. Without a grace the acute trip fires DURING
   * warmup and self-restarts the box, which re-enters the same warmup — an
   * infinite restart loop that never reaches steady state (observed bqb1 502:
   * server_available -> nonZeroExit:1 every ~20s). The grace lets warmup finish;
   * the steady-state protection (the whole point of TRA-1080) is unaffected
   * because the real serving-layer death happens ~1h in, far past any grace.
   * Suppressed trips still log + publish for observability. Set to 0 to disable.
   */
  bootGraceMs: number;
}

/** Defaults chosen so a restart only fires on unambiguous pathology. */
export const DEFAULT_WATCHDOG: WatchdogConfig = {
  enabled: true,
  restartEnabled: true,
  sampleMs: 1_000,
  heapPct: 0.92,
  lagMs: 2_000,
  breachSamples: 10,
  // 4s: a single loop block this long has already blown Render's 5s health
  // check budget, so trip a clean restart now rather than wait for the
  // platform's hard kill. A 4s+ stall on a healthy box is itself pathology
  // (a full GC near the 1.5GB ceiling is ~1-2s), so a false trip is implausible.
  lagMaxMs: 4_000,
  // TRA-1687 — THERE IS NO LONGER A DEFAULT RSS CEILING IN THIS FILE, and that is
  // the entire point. The old default (1900 MB) is deleted, not retuned.
  //
  // History, because it is the whole argument: TRA-1374 wrote 1900 MB against
  // `plan: standard` (2 GB cgroup) — trip ~100 MB below the kill line so an abrupt
  // `nonZeroExit: 137` becomes a graceful exit with flushed logs. Correct, for a
  // 2 GB box. The box was then moved to `plan: pro` (4 GB) in the Render DASHBOARD
  // and nothing re-derived the constant. On 4 GB, 1900 MB is 47% of capacity —
  // INSIDE the normal RTH working set (measured 2.0-2.2 GB). The guard INVERTED:
  // instead of pre-empting an OOM it executed a perfectly healthy engine ~38-40
  // times per RTH session (TRA-1683). A guard's constant encodes a PREMISE ABOUT
  // ITS ENVIRONMENT; move the environment and the guard silently turns on its host.
  //
  // Retuning the constant to 3400 would have fixed bqb1 and RE-ARMED THE SAME BOMB
  // for the next resize. Note that 1900 was not "unsafe because it was low" — a low
  // ceiling self-restarts a healthy engine and a high one cannot pre-empt the kill.
  // A hardcoded ceiling is wrong in BOTH directions, so there is no safe constant to
  // pick and no safe direction to err in. The only correct ceiling is one DERIVED
  // FROM THE BOX AT BOOT.
  //
  // So: `resolveRssCeiling` reads the real cgroup limit (`/sys/fs/cgroup/memory.max`)
  // and derives the ceiling from it. This field is the LAST-RESORT value used only
  // when there is no cgroup to read AND no operator override — and it is 0
  // (DISABLED), not a guess. Rationale: the RSS trip exists solely to pre-empt a
  // cgroup OOM kill. Where no cgroup limit is readable there is no such kill to
  // pre-empt, so a ceiling is pure downside — it can only fire on healthy load.
  // An unresolved ceiling is surfaced as `rssMaxSource: 'unresolved-disabled'` with
  // a warning, so it fails VISIBLY rather than silently guessing.
  rssMaxBytes: 0,
  cgroupLimitBytes: null,
  rssMaxSource: 'unresolved-disabled',
  rssMaxWarning: 'no cgroup limit readable and no WATCHDOG_RSS_MAX_MB set — RSS trip disabled',
  // 120s: warmup's synchronous candle-load across N per-book engines blocks the
  // loop past lagMaxMs for a few seconds and was self-restarting the box mid-
  // warmup in an infinite loop. Trips are suppressed (but still logged) for the
  // first 2 min so warmup completes; the real serving-layer death this watchdog
  // exists to catch happens ~1h in, far past this window.
  bootGraceMs: 120_000,
};

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = typeof raw === 'string' ? Number(raw.trim()) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}

export function resolveConfig(
  env: NodeJS.ProcessEnv = process.env,
  cgroupLimitBytes: number | null = readCgroupMemoryLimitBytes(),
): WatchdogConfig {
  const rss = resolveRssCeiling(env[WATCHDOG_RSS_MAX_MB_VAR], cgroupLimitBytes);
  return {
    enabled: envBool(env[WATCHDOG_ENABLED_VAR], DEFAULT_WATCHDOG.enabled),
    restartEnabled: envBool(env[WATCHDOG_RESTART_ENABLED_VAR], DEFAULT_WATCHDOG.restartEnabled),
    sampleMs: envNum(env[WATCHDOG_SAMPLE_MS_VAR], DEFAULT_WATCHDOG.sampleMs, 100, 60_000),
    heapPct: envNum(env[WATCHDOG_HEAP_PCT_VAR], DEFAULT_WATCHDOG.heapPct, 0.5, 0.99),
    lagMs: envNum(env[WATCHDOG_LAG_MS_VAR], DEFAULT_WATCHDOG.lagMs, 100, 600_000),
    breachSamples: Math.floor(envNum(env[WATCHDOG_BREACH_SAMPLES_VAR], DEFAULT_WATCHDOG.breachSamples, 1, 600)),
    lagMaxMs: envNum(env[WATCHDOG_BLOCK_MS_VAR], DEFAULT_WATCHDOG.lagMaxMs, 500, 600_000),
    bootGraceMs: envNum(env[WATCHDOG_BOOT_GRACE_MS_VAR], DEFAULT_WATCHDOG.bootGraceMs, 0, 1_800_000),
    rssMaxBytes: rss.rssMaxBytes,
    cgroupLimitBytes: rss.cgroupLimitBytes,
    rssMaxSource: rss.rssMaxSource,
    rssMaxWarning: rss.rssMaxWarning,
  };
}

/** Where the effective RSS ceiling came from. A gate should grade this, not only the number. */
export type RssCeilingSource =
  | 'cgroup-derived'      // no override; derived from the box's real memory limit. The healthy path.
  | 'env'                 // operator override, and it brackets the box correctly.
  | 'env-clamped'         // operator override sat too close to the kill line; clamped DOWN so it can still pre-empt.
  | 'env-suspect'         // operator override is far below the box's capacity — the TRA-1683 shape. Honoured, but flagged.
  | 'disabled'            // operator explicitly asked for no RSS trip (0).
  | 'unresolved-disabled';// no cgroup, no override. Nothing to pre-empt; guard off, loudly.

export interface RssCeilingResolution {
  rssMaxBytes: number;
  cgroupLimitBytes: number | null;
  rssMaxSource: RssCeilingSource;
  rssMaxWarning: string | null;
}

/**
 * TRA-1687 — the container's real memory limit, read from the cgroup.
 *
 * cgroup v2 exposes `/sys/fs/cgroup/memory.max`; v1 exposes
 * `/sys/fs/cgroup/memory/memory.limit_in_bytes`. Both spell "unlimited"
 * differently and BOTH SPELLINGS ARE TRAPS:
 *   - v2 writes the literal string `max`  -> `Number('max')` is NaN.
 *   - v1 writes a page-aligned ~2^63 sentinel (9223372036854771712) -> a perfectly
 *     finite number that would derive a ~9 exabyte ceiling, i.e. a silently
 *     DISABLED guard wearing the costume of a configured one.
 * Treat both as "no limit" and return null, so the caller falls through to the
 * explicit unresolved path rather than trusting a sentinel.
 */
export function readCgroupMemoryLimitBytes(
  readFile: (path: string) => string = (path) => readFileSync(path, 'utf-8'),
  paths: readonly string[] = CGROUP_LIMIT_PATHS,
): number | null {
  for (const path of paths) {
    let raw: string;
    try {
      raw = readFile(path);
    } catch {
      continue; // not this cgroup version, or not a container at all
    }
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed === 'max') continue; // v2 "unlimited"
    const n = Number(trimmed);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (n >= UNLIMITED_SENTINEL_FLOOR_BYTES) continue; // v1 "unlimited" sentinel
    return n;
  }
  return null;
}

export const CGROUP_LIMIT_PATHS = [
  '/sys/fs/cgroup/memory.max', // cgroup v2 (Render runs this)
  '/sys/fs/cgroup/memory/memory.limit_in_bytes', // cgroup v1
] as const;

/** At/above this, a cgroup "limit" is an unlimited sentinel, not a container size. */
const UNLIMITED_SENTINEL_FLOOR_BYTES = 1024 ** 4; // 1 TiB

/**
 * Reserve below the cgroup limit for the exit drain. The trip must leave enough
 * room to flush logs and persist state BEFORE the kernel's SIGKILL lands, and RSS
 * can still climb during the drain. 700MB on a 4GB box puts the derived ceiling at
 * ~3.4GB — comfortably above the measured 2.0-2.2GB RTH working set.
 */
export const CGROUP_EXIT_RESERVE_BYTES = 700 * 1e6;

/**
 * A ceiling within this distance of the kill line cannot do its job: the kernel
 * gets there first and we take the abrupt `nonZeroExit: 137` the trip exists to
 * prevent. Mirrors MIN_GAP_BELOW_CGROUP_MB in `_default/tra1648_watchdog_ceiling_check.mjs`.
 */
export const MIN_GAP_BELOW_CGROUP_BYTES = 300 * 1e6;

/**
 * Below this fraction of the box's capacity, a ceiling is inside plausible healthy
 * working-set territory and is more likely to EXECUTE a healthy engine than to save
 * it. That is precisely what 1900MB became when bqb1 moved to a 4GB plan (TRA-1683).
 */
const SUSPECT_CEILING_FRACTION = 0.5;

/**
 * TRA-1687 — resolve the acute RSS ceiling from the BOX, with the operator able to
 * override but not able to silently break it.
 *
 * Precedence, and the reasoning for each branch:
 *   1. Explicit disable (`0` / negative) -> off. The operator said so; obey.
 *   2. An override that CANNOT PRE-EMPT THE KILL (>= limit - MIN_GAP) is clamped DOWN.
 *      Clamping down is the one direction that is monotonically safe: it can only make
 *      the guard fire earlier and more gracefully, never later than the kernel. A guard
 *      that trips after the SIGKILL is not a guard.
 *   3. An override far BELOW the box's capacity is HONOURED but flagged `env-suspect`.
 *      We do NOT silently raise it: unlike clamping down, raising a ceiling the operator
 *      chose is a permissive override and could mask a real leak. Make it VISIBLE and let
 *      the gate (C9) grade it — the TRA-1683 failure was not that nobody could have known,
 *      it was that nothing ever re-checked and nothing ever said so out loud.
 *   4. No override -> derive from the cgroup. The healthy path, and it tracks the box
 *      automatically: resize the plan and the ceiling follows, forever.
 *   5. No override AND no cgroup -> DISABLED, loudly (see DEFAULT_WATCHDOG).
 *
 * Note (4) means an UNSET env var is no longer "a vote for the code default", which is
 * what made the TRA-1683 default so dangerous — the code default WAS the bug.
 *
 * Garbage (`'abc'`) is treated as UNSET, not as a disable. A typo in an env var must not
 * silently remove an OOM guard; it falls through to the derived ceiling and is flagged.
 */
export function resolveRssCeiling(
  raw: string | undefined,
  cgroupLimitBytes: number | null,
): RssCeilingResolution {
  const derived = cgroupLimitBytes === null
    ? null
    : Math.max(cgroupLimitBytes - CGROUP_EXIT_RESERVE_BYTES, 256 * 1e6);

  const unresolved = (warning: string | null): RssCeilingResolution =>
    derived === null
      ? {
          rssMaxBytes: 0,
          cgroupLimitBytes,
          rssMaxSource: 'unresolved-disabled',
          rssMaxWarning: warning ?? DEFAULT_WATCHDOG.rssMaxWarning,
        }
      : { rssMaxBytes: derived, cgroupLimitBytes, rssMaxSource: 'cgroup-derived', rssMaxWarning: warning };

  const trimmed = typeof raw === 'string' ? raw.trim() : '';
  if (trimmed === '') return unresolved(null);

  const n = Number(trimmed);
  if (!Number.isFinite(n)) {
    return unresolved(
      `WATCHDOG_RSS_MAX_MB=${JSON.stringify(trimmed)} is not a number — ignored, ceiling derived from the cgroup instead`,
    );
  }
  if (n <= 0) {
    return { rssMaxBytes: 0, cgroupLimitBytes, rssMaxSource: 'disabled', rssMaxWarning: null };
  }

  const envBytes = Math.min(Math.max(n, 256), 32_768) * 1e6;

  if (cgroupLimitBytes === null) {
    // No box to bracket against. Honour the override — it is the only information we have.
    return { rssMaxBytes: envBytes, cgroupLimitBytes, rssMaxSource: 'env', rssMaxWarning: null };
  }

  const mb = (b: number) => Math.round(b / 1e6);

  if (envBytes >= cgroupLimitBytes - MIN_GAP_BELOW_CGROUP_BYTES) {
    const clamped = Math.max(cgroupLimitBytes - CGROUP_EXIT_RESERVE_BYTES, 256 * 1e6);
    return {
      rssMaxBytes: clamped,
      cgroupLimitBytes,
      rssMaxSource: 'env-clamped',
      rssMaxWarning:
        `WATCHDOG_RSS_MAX_MB=${mb(envBytes)}MB leaves no room below the ${mb(cgroupLimitBytes)}MB cgroup limit ` +
        `to exit gracefully — the kernel would SIGKILL first. Clamped down to ${mb(clamped)}MB.`,
    };
  }

  if (envBytes < cgroupLimitBytes * SUSPECT_CEILING_FRACTION) {
    return {
      rssMaxBytes: envBytes,
      cgroupLimitBytes,
      rssMaxSource: 'env-suspect',
      rssMaxWarning:
        `WATCHDOG_RSS_MAX_MB=${mb(envBytes)}MB is only ` +
        `${Math.round((envBytes / cgroupLimitBytes) * 100)}% of the ${mb(cgroupLimitBytes)}MB cgroup limit. ` +
        `A ceiling this far below capacity may sit INSIDE the healthy working set and restart a healthy ` +
        `engine (TRA-1683). Honoured, not overridden — but verify it is deliberate.`,
    };
  }

  return { rssMaxBytes: envBytes, cgroupLimitBytes, rssMaxSource: 'env', rssMaxWarning: null };
}

/** A single resource reading evaluated against the trip thresholds. */
export interface WatchdogSample {
  /** Bytes currently used by the V8 heap. */
  heapUsedBytes: number;
  /** V8 heap_size_limit (reflects --max-old-space-size). */
  heapLimitBytes: number;
  /** heapUsedBytes / heapLimitBytes, in [0, 1]. */
  heapPct: number;
  /** Mean event-loop lag over the sample window, ms. */
  lagMeanMs: number;
  /** Max event-loop lag over the sample window, ms. */
  lagMaxMs: number;
  /** TRA-1374 — resident set size (bytes) from `process.memoryUsage().rss`. */
  rssBytes: number;
  /**
   * TRA-1463 — off-heap breakdown from `process.memoryUsage()`. `externalBytes`
   * is native memory bound to JS (Buffers/ArrayBuffers — where undici's
   * unconsumed HTTP response bodies live); `arrayBuffersBytes` is the
   * ArrayBuffer/SharedArrayBuffer slice of it. Used to attribute an `rss` trip
   * to retained response buffers vs native fragmentation. Optional so custom
   * `readHeap` test seams that don't provide them still typecheck (default 0).
   */
  externalBytes?: number;
  arrayBuffersBytes?: number;
}

/** Mutable breach counters carried between samples. */
export interface WatchdogState {
  consecutiveHeapBreaches: number;
  consecutiveLagBreaches: number;
}

export interface TripDecision {
  trip: boolean;
  reason?: 'heap' | 'lag' | 'block' | 'rss';
  detail?: string;
}

/**
 * Pure trip evaluator — given a sample, the running breach counters and config,
 * mutate the counters and decide whether to trip. Factored out so the restart
 * policy is unit-testable without timers or a live process.
 */
export function evaluateSample(
  sample: WatchdogSample,
  state: WatchdogState,
  cfg: WatchdogConfig,
): TripDecision {
  state.consecutiveHeapBreaches = sample.heapPct >= cfg.heapPct ? state.consecutiveHeapBreaches + 1 : 0;
  state.consecutiveLagBreaches = sample.lagMeanMs >= cfg.lagMs ? state.consecutiveLagBreaches + 1 : 0;

  // TRA-1374 — acute RSS trip. Checked FIRST because it is the most time-
  // critical failure mode: RSS this high means the cgroup OOM-killer (SIGKILL,
  // `nonZeroExit: 137`) is about to fire. Unlike the heap/lag trips this needs
  // no consecutive-sample confirmation — a single sample over the ceiling
  // restarts cleanly NOW so the graceful exit beats the platform's hard kill.
  // The native-memory burst that drives 137 lives outside the V8 heap, so the
  // `heapPct` trip below is blind to it; this is the only trip that sees it.
  if (cfg.rssMaxBytes > 0 && sample.rssBytes >= cfg.rssMaxBytes) {
    // TRA-1463 — inline off-heap attribution so the breadcrumb `detail` alone
    // separates the two rss failure modes: a large `ext` (external ≈ retained
    // undici response-body Buffers from the crypto fan-out) points the fix at
    // aborting/cancelling bodies on ALL providers; a small `ext` under a large
    // rss points at native/malloc-arena fragmentation instead.
    const extStr =
      sample.externalBytes != null
        ? `, ext ${(sample.externalBytes / 1e6).toFixed(0)}MB` +
          (sample.arrayBuffersBytes != null ? ` (arrayBuffers ${(sample.arrayBuffersBytes / 1e6).toFixed(0)}MB)` : '')
        : '';
    return {
      trip: true,
      reason: 'rss',
      detail:
        `RSS ${(sample.rssBytes / 1e6).toFixed(0)}MB >= ${(cfg.rssMaxBytes / 1e6).toFixed(0)}MB ceiling ` +
        `(heap ${(sample.heapUsedBytes / 1e6).toFixed(0)}MB / ${(sample.heapLimitBytes / 1e6).toFixed(0)}MB${extStr}) — ` +
        `native/external memory burst approaching the container limit, self-restarting before the cgroup OOM-137`,
    };
  }
  if (state.consecutiveHeapBreaches >= cfg.breachSamples) {
    return {
      trip: true,
      reason: 'heap',
      detail:
        `heap ${(sample.heapPct * 100).toFixed(1)}% >= ${(cfg.heapPct * 100).toFixed(0)}% ` +
        `for ${state.consecutiveHeapBreaches} samples ` +
        `(${(sample.heapUsedBytes / 1e6).toFixed(0)}MB / ${(sample.heapLimitBytes / 1e6).toFixed(0)}MB)`,
    };
  }
  // TRA-1082 — acute single-block trip. One sample window with a max lag this
  // large means a single synchronous tick blocked the loop past Render's 5s
  // health-check budget; restart cleanly NOW rather than wait breachSamples
  // windows (the sustained trip below) for a stall the platform already kills.
  if (sample.lagMaxMs >= cfg.lagMaxMs) {
    return {
      trip: true,
      reason: 'block',
      detail:
        `single event-loop block: max lag ${sample.lagMaxMs.toFixed(0)}ms >= ${cfg.lagMaxMs}ms ` +
        `in one ${cfg.sampleMs}ms window (mean ${sample.lagMeanMs.toFixed(0)}ms) — ` +
        `exceeds Render's 5s health-check budget, self-restarting before the platform hard-kill`,
    };
  }
  if (state.consecutiveLagBreaches >= cfg.breachSamples) {
    return {
      trip: true,
      reason: 'lag',
      detail:
        `event-loop mean lag ${sample.lagMeanMs.toFixed(0)}ms >= ${cfg.lagMs}ms ` +
        `for ${state.consecutiveLagBreaches} samples (max ${sample.lagMaxMs.toFixed(0)}ms)`,
    };
  }
  return { trip: false };
}

/** Read-only snapshot surfaced by `/api/health/watchdog`. */
export interface WatchdogStatus {
  enabled: boolean;
  restartEnabled: boolean;
  config: {
    sampleMs: number;
    heapPct: number;
    lagMs: number;
    breachSamples: number;
    lagMaxMs: number;
    bootGraceMs: number;
    rssMaxBytes: number;
    /**
     * TRA-1687 — the box's REAL memory limit, measured at boot. Published so a gate
     * can stop inferring it: `_default/tra1648_watchdog_ceiling_check.mjs` (C9) used to
     * bracket the ceiling against a PLAN-NAME lookup table (`pro -> 4096MB`), which is a
     * claim about Render's pricing tiers, not a reading of this container. One side of
     * that bracket was measured and the other was asserted, and it printed as one word:
     * BRACKETED. This field is what makes the upper side a measurement too.
     */
    cgroupLimitBytes: number | null;
    rssMaxSource: RssCeilingSource;
    rssMaxWarning: string | null;
  };
  /** Most recent sample, or null before the first evaluation. */
  lastSample: (WatchdogSample & { atMs: number }) | null;
  /**
   * TRA-1089 — steady-state high-water mark of `lagMaxMs` across all post-
   * boot-grace sample windows since this process started. The pathological
   * tick blocks are 1-window spikes (every 1-2 min), so a single `lastSample`
   * read almost never catches one; this running peak makes the steady-state
   * worst case observable from a single poll, which is what the < 4s done
   * criterion is actually measured against. Null until the first steady-state
   * sample (warmup samples are excluded so they never pollute the peak).
   */
  peakSinceBoot: { lagMaxMs: number; lagMeanMs: number; atMs: number } | null;
  /**
   * TRA-1463 — steady-state RSS/off-heap high-water mark since boot. A single
   * `lastSample` poll only shows the instantaneous RSS, so it cannot tell a slow
   * off-heap leak apart from a healthy sawtooth (RSS that rises then GCs back).
   * This running peak makes the session's worst RSS — and its `external` /
   * `arrayBuffers` attribution — observable from ONE poll, so the ~85-min cycle
   * can be classified as slow-leak (peak climbs monotonically toward the ceiling
   * across the session) vs acute-burst (peak stays low until a single heavy tick)
   * BEFORE the trip, without Render logs. Null until the first steady-state
   * sample. Warmup samples excluded so the boot ramp never sets the peak.
   */
  peakRssSinceBoot: { rssBytes: number; externalBytes?: number; arrayBuffersBytes?: number; atMs: number } | null;
  /**
   * Ring of the most recent steady-state samples whose `lagMaxMs` cleared the
   * high-lag record threshold, newest last. Gives the distribution of heavy
   * ticks over a session without needing Render logs (which only record trips).
   */
  recentHighLag: Array<{ lagMaxMs: number; lagMeanMs: number; atMs: number }>;
  consecutiveHeapBreaches: number;
  consecutiveLagBreaches: number;
  /** True while still inside the boot/warmup grace window (restart trips suppressed). */
  inBootGrace: boolean;
  /** True once a trip has fired (process is exiting). */
  tripped: boolean;
  trippedReason: 'heap' | 'lag' | 'block' | 'rss' | null;
  /**
   * TRA-1463 — the LAST self-restart's trip record, re-read from the DATA_DIR
   * breadcrumb on boot. Null on a truly-fresh box (no prior trip on disk). This
   * is the field the soak/monitoring reads AFTER a restart to learn why the box
   * died (heap-leak vs native/RSS burst vs CPU starvation) without Render logs.
   */
  lastTrip: PersistedTrip | null;
  /**
   * TRA-1463 — the PRIOR process's last liveness heartbeat, re-read from the
   * DATA_DIR breadcrumb on boot. Unlike {@link lastTrip} this is written on a
   * timer (not at death), so it captures the last-known RSS/lag/uptime even when
   * the death bypassed the watchdog exit path — an external SIGKILL 137 (cgroup
   * OOM burst) or a health-check-timeout SIGTERM. This is the field that finally
   * distinguishes the residual ~85-min kill's cause: uptime ≈ 85 min + climbing
   * RSS ⇒ RSS burst / 137; flat RSS + spiking lag ⇒ event-loop starvation. Null
   * on a truly-fresh disk (no prior heartbeat).
   */
  priorLiveness: PersistedLiveness | null;
  /**
   * TRA-1463 — live synchronous-phase attribution: the most-recent slow phase and
   * a short ring of prior ones. A single `/api/health/watchdog` poll after a block
   * names which instrumented synchronous phase held the loop, WITHOUT waiting for a
   * self-restart. Absent until the first slow phase is recorded.
   */
  phaseAttribution?: PhaseAttribution;
}

export interface WatchdogHandle {
  stop(): void;
  /** Force one evaluation immediately (test seam). */
  sampleNow(): TripDecision;
  status(): WatchdogStatus;
}

export interface StartWatchdogOptions {
  env?: NodeJS.ProcessEnv;
  /**
   * What to do when a trip fires. Defaults to a clean async drain → process
   * exit(1). Injectable so tests can assert without killing the runner.
   */
  onTrip?: (decision: TripDecision, sample: WatchdogSample) => void;
  /** Heap reader seam (defaults to V8 + process.memoryUsage). */
  readHeap?: () => { usedBytes: number; limitBytes: number; rssBytes: number; externalBytes?: number; arrayBuffersBytes?: number };
  /** Clock seam for the boot-grace window (defaults to Date.now). */
  now?: () => number;
  /**
   * TRA-1463 — synchronous-phase attribution reader (defaults to the phase-timing
   * module getter). Injectable so tests can assert breadcrumb attribution without
   * the global phase-timing state.
   */
  readPhaseAttribution?: () => PhaseAttribution;
}

let lastStatus: WatchdogStatus | null = null;

/** Snapshot for the health probe; null until the watchdog has started. */
export function getWatchdogStatus(): WatchdogStatus | null {
  return lastStatus;
}

function defaultReadHeap(): { usedBytes: number; limitBytes: number; rssBytes: number; externalBytes: number; arrayBuffersBytes: number } {
  const heap = getHeapStatistics();
  // TRA-1374 — RSS is the number the cgroup OOM-killer watches; read it here so
  // the acute RSS trip sees the native/external memory the V8 heap stats miss.
  // TRA-1463 — same single memoryUsage() call also yields the off-heap breakdown
  // (external / arrayBuffers) used to attribute an rss trip to retained response
  // buffers vs native fragmentation.
  const mem = process.memoryUsage();
  return {
    usedBytes: heap.used_heap_size,
    limitBytes: heap.heap_size_limit,
    rssBytes: mem.rss,
    externalBytes: mem.external,
    arrayBuffersBytes: mem.arrayBuffers,
  };
}

/**
 * Default trip action: log fatal, flush logs/audit, then exit(1) so Render
 * restarts the process cleanly instead of leaving it in 502 limbo. Guarded so a
 * trip can only fire once.
 */
let tripFired = false;
function defaultOnTrip(decision: TripDecision, sample: WatchdogSample): void {
  if (tripFired) return;
  tripFired = true;
  log.error('WATCHDOG TRIP — self-restarting to clear starved event loop', {
    reason: decision.reason,
    detail: decision.detail,
    heapUsedMB: Math.round(sample.heapUsedBytes / 1e6),
    heapLimitMB: Math.round(sample.heapLimitBytes / 1e6),
    rssMB: Math.round(sample.rssBytes / 1e6),
    lagMeanMs: Math.round(sample.lagMeanMs),
    lagMaxMs: Math.round(sample.lagMaxMs),
  });
  // Best-effort flush; never block exit longer than ~2s on a wedged sink.
  const exit = (): never => process.exit(1);
  const timer = setTimeout(exit, 2_000);
  timer.unref?.();
  void flushLogs().then(exit, exit);
}

/**
 * Start the watchdog. Returns null (no-op) when disabled via env so the caller
 * can `?.stop()` on shutdown unconditionally. The internal timer is `unref`'d so
 * it never by itself keeps the process alive.
 */
export function startEventLoopWatchdog(opts: StartWatchdogOptions = {}): WatchdogHandle | null {
  const cfg = resolveConfig(opts.env);
  if (!cfg.enabled) {
    log.info('event-loop watchdog disabled via env', { var: WATCHDOG_ENABLED_VAR });
    return null;
  }

  const readHeap = opts.readHeap ?? defaultReadHeap;
  const onTrip = opts.onTrip ?? defaultOnTrip;
  const readPhaseAttribution = opts.readPhaseAttribution ?? getPhaseAttribution;
  const now = opts.now ?? Date.now;
  const startedAtMs = now();
  const state: WatchdogState = { consecutiveHeapBreaches: 0, consecutiveLagBreaches: 0 };

  // TRA-1463 — surface the PRIOR self-restart's cause (persisted to the DATA_DIR
  // breadcrumb before the last exit). Read once at boot; immutable thereafter.
  const lastTrip = readLastTrip(opts.env);
  if (lastTrip) {
    log.warn('prior watchdog self-restart detected on boot', {
      reason: lastTrip.reason,
      uptimeSecAtTrip: lastTrip.uptimeSecAtTrip,
      rssMB: lastTrip.rssMB,
      heapUsedMB: lastTrip.heapUsedMB,
      lagMaxMs: lastTrip.lagMaxMs,
      detail: lastTrip.detail,
    });
  }

  // TRA-1463 — the prior process's last liveness heartbeat, capturing the death
  // the watchdog exit path could NOT (external SIGKILL 137 / health-check SIGTERM).
  // Read once at boot; immutable thereafter (the running box overwrites the file,
  // so only this boot-time snapshot reflects the DEAD instance's final state).
  const priorLiveness = readLastLiveness(opts.env);
  if (priorLiveness) {
    const gapFromTrip = lastTrip ? Math.abs(priorLiveness.atMs - lastTrip.atMs) : null;
    // Only shout about it when there is NO matching graceful trip — that is the
    // external-kill case this breadcrumb exists to catch. (A graceful self-restart
    // writes both files within the same second; suppress the redundant line then.)
    if (!lastTrip || (gapFromTrip != null && gapFromTrip > 5_000)) {
      log.warn('prior process died WITHOUT a watchdog trip — external kill (SIGKILL 137 / health-check SIGTERM) suspected', {
        lastAliveUptimeSec: priorLiveness.uptimeSec,
        lastAliveRssMB: priorLiveness.rssMB,
        lastAliveExternalMB: priorLiveness.externalMB,
        lastAliveHeapPct: Number(priorLiveness.heapPct.toFixed(3)),
        lastAliveLagMaxMs: priorLiveness.lagMaxMs,
      });
    }
  }
  const livenessIntervalMs = envNum(opts.env?.[WATCHDOG_LIVENESS_INTERVAL_MS_VAR] ?? process.env[WATCHDOG_LIVENESS_INTERVAL_MS_VAR], 15_000, 1_000, 300_000);
  let lastLivenessWriteMs = 0;

  // ns-resolution event-loop delay histogram. Reset each window so lag reflects
  // only the most recent sampleMs, not a since-boot cumulative average.
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  let tripped = false;
  let trippedReason: 'heap' | 'lag' | 'block' | 'rss' | null = null;

  // TRA-1089 — steady-state lag observability. Peak excludes warmup so a boot
  // spike never masquerades as a steady-state regression; the ring keeps the
  // last HIGH_LAG_RING_MAX heavy windows for distribution evidence over a
  // session. Both are plain in-loop accounting — no extra timers or async, and
  // the health probe only reads the already-published snapshot.
  const HIGH_LAG_RECORD_MS = 1_000;
  const HIGH_LAG_RING_MAX = 32;
  let peakSinceBoot: { lagMaxMs: number; lagMeanMs: number; atMs: number } | null = null;
  let peakRssSinceBoot: { rssBytes: number; externalBytes?: number; arrayBuffersBytes?: number; atMs: number } | null = null;
  const recentHighLag: Array<{ lagMaxMs: number; lagMeanMs: number; atMs: number }> = [];

  function publish(sample: WatchdogSample): void {
    const atMs = Date.now();
    // TRA-1463 — read the slow-phase attribution once per publish so the liveness
    // heartbeat, the trip breadcrumb, and the live status all reflect the same
    // most-recent blocking phase.
    const phaseAttribution = readPhaseAttribution();
    // Only fold steady-state (post-grace) samples into the peak/ring so warmup's
    // legitimate synchronous candle-load blocks don't pollute the evidence.
    if (now() - startedAtMs >= cfg.bootGraceMs) {
      if (!peakSinceBoot || sample.lagMaxMs > peakSinceBoot.lagMaxMs) {
        peakSinceBoot = { lagMaxMs: sample.lagMaxMs, lagMeanMs: sample.lagMeanMs, atMs };
      }
      // TRA-1463 — RSS high-water mark (with off-heap attribution) so one poll
      // reveals whether RSS is trending toward the ceiling across the session.
      if (!peakRssSinceBoot || sample.rssBytes > peakRssSinceBoot.rssBytes) {
        peakRssSinceBoot = {
          rssBytes: sample.rssBytes,
          externalBytes: sample.externalBytes,
          arrayBuffersBytes: sample.arrayBuffersBytes,
          atMs,
        };
      }
      if (sample.lagMaxMs >= HIGH_LAG_RECORD_MS) {
        recentHighLag.push({ lagMaxMs: sample.lagMaxMs, lagMeanMs: sample.lagMeanMs, atMs });
        if (recentHighLag.length > HIGH_LAG_RING_MAX) recentHighLag.shift();
      }
    }
    // TRA-1463 — throttled last-known-alive heartbeat to the DATA_DIR disk. Written
    // every livenessIntervalMs (default 15s) INCLUDING during boot grace, so a box
    // that dies mid-warmup still leaves a trail. This is what the NEXT boot reads as
    // `priorLiveness` to attribute a death the watchdog exit path never saw.
    if (atMs - lastLivenessWriteMs >= livenessIntervalMs) {
      lastLivenessWriteMs = atMs;
      persistLivenessHeartbeat(
        {
          atMs,
          uptimeSec: Math.round((now() - startedAtMs) / 1000),
          rssMB: Math.round(sample.rssBytes / 1e6),
          heapUsedMB: Math.round(sample.heapUsedBytes / 1e6),
          heapLimitMB: Math.round(sample.heapLimitBytes / 1e6),
          heapPct: sample.heapPct,
          externalMB: sample.externalBytes != null ? Math.round(sample.externalBytes / 1e6) : undefined,
          arrayBuffersMB: sample.arrayBuffersBytes != null ? Math.round(sample.arrayBuffersBytes / 1e6) : undefined,
          lagMeanMs: Math.round(sample.lagMeanMs),
          lagMaxMs: Math.round(sample.lagMaxMs),
          slowPhase: phaseAttribution.lastSlowPhase,
          activePhase: phaseAttribution.activePhase,
        },
        opts.env,
      );
    }
    lastStatus = {
      enabled: cfg.enabled,
      restartEnabled: cfg.restartEnabled,
      config: { sampleMs: cfg.sampleMs, heapPct: cfg.heapPct, lagMs: cfg.lagMs, breachSamples: cfg.breachSamples, lagMaxMs: cfg.lagMaxMs, bootGraceMs: cfg.bootGraceMs, rssMaxBytes: cfg.rssMaxBytes, cgroupLimitBytes: cfg.cgroupLimitBytes, rssMaxSource: cfg.rssMaxSource, rssMaxWarning: cfg.rssMaxWarning },
      lastSample: { ...sample, atMs },
      peakSinceBoot,
      peakRssSinceBoot,
      recentHighLag: recentHighLag.slice(),
      consecutiveHeapBreaches: state.consecutiveHeapBreaches,
      consecutiveLagBreaches: state.consecutiveLagBreaches,
      inBootGrace: now() - startedAtMs < cfg.bootGraceMs,
      tripped,
      trippedReason,
      lastTrip,
      priorLiveness,
      phaseAttribution,
    };
  }

  function evaluate(): TripDecision {
    const heap = readHeap();
    // Histogram is in ns; convert to ms. Reset for the next window.
    const lagMeanMs = histogram.mean / 1e6;
    const lagMaxMs = histogram.max / 1e6;
    histogram.reset();

    const sample: WatchdogSample = {
      heapUsedBytes: heap.usedBytes,
      heapLimitBytes: heap.limitBytes,
      heapPct: heap.limitBytes > 0 ? heap.usedBytes / heap.limitBytes : 0,
      lagMeanMs: Number.isFinite(lagMeanMs) ? lagMeanMs : 0,
      lagMaxMs: Number.isFinite(lagMaxMs) ? lagMaxMs : 0,
      rssBytes: heap.rssBytes,
      externalBytes: heap.externalBytes,
      arrayBuffersBytes: heap.arrayBuffersBytes,
    };

    const decision = evaluateSample(sample, state, cfg);

    // Warn one sample before the trip threshold so the Render logs show the
    // ramp, not just the final restart line.
    if (!decision.trip && (state.consecutiveHeapBreaches > 0 || state.consecutiveLagBreaches > 0)) {
      log.warn('watchdog breach accumulating', {
        heapBreaches: state.consecutiveHeapBreaches,
        lagBreaches: state.consecutiveLagBreaches,
        heapPct: Number(sample.heapPct.toFixed(3)),
        lagMeanMs: Math.round(sample.lagMeanMs),
        threshold: cfg.breachSamples,
      });
    }

    publish(sample);

    if (decision.trip) {
      // TRA-1084 — suppress (but still surface) trips during the boot/warmup
      // grace window. Warmup's synchronous candle-load legitimately blocks the
      // loop past lagMaxMs; restarting there only re-enters warmup -> infinite
      // restart loop. Reset the sustained counters so a warmup breach never
      // carries straight into a post-grace trip on the first steady-state sample.
      if (now() - startedAtMs < cfg.bootGraceMs) {
        log.warn('watchdog trip suppressed during boot grace — warmup loop block, not steady-state pathology', {
          reason: decision.reason,
          detail: decision.detail,
          graceMsRemaining: Math.max(0, cfg.bootGraceMs - (now() - startedAtMs)),
          var: WATCHDOG_BOOT_GRACE_MS_VAR,
        });
        state.consecutiveHeapBreaches = 0;
        state.consecutiveLagBreaches = 0;
        publish(sample);
        return decision;
      }
      tripped = true;
      trippedReason = decision.reason ?? null;
      publish(sample);
      // TRA-1463 — write the durable breadcrumb BEFORE the restart action so the
      // next boot can report exactly why this box died. Done even when
      // restartEnabled is false (observe-only) so a dry-run box still records the
      // would-be trip. Synchronous + guarded; never blocks the exit.
      if (decision.reason) {
        // TRA-1463 — read the phase attribution ONCE at trip time so slowPhase +
        // activePhase reflect the same instant the loop was starved.
        const tripAttribution = readPhaseAttribution();
        persistTripRecord(
          {
            reason: decision.reason,
            detail: decision.detail ?? '',
            atMs: Date.now(),
            uptimeSecAtTrip: Math.round((now() - startedAtMs) / 1000),
            heapUsedMB: Math.round(sample.heapUsedBytes / 1e6),
            heapLimitMB: Math.round(sample.heapLimitBytes / 1e6),
            rssMB: Math.round(sample.rssBytes / 1e6),
            externalMB: sample.externalBytes != null ? Math.round(sample.externalBytes / 1e6) : undefined,
            arrayBuffersMB: sample.arrayBuffersBytes != null ? Math.round(sample.arrayBuffersBytes / 1e6) : undefined,
            lagMeanMs: Math.round(sample.lagMeanMs),
            lagMaxMs: Math.round(sample.lagMaxMs),
            slowPhase: tripAttribution.lastSlowPhase,
            activePhase: tripAttribution.activePhase,
          },
          opts.env,
        );
      }
      if (cfg.restartEnabled) {
        onTrip(decision, sample);
      } else {
        log.error('watchdog tripped but restart disabled — observe-only', {
          reason: decision.reason,
          detail: decision.detail,
          var: WATCHDOG_RESTART_ENABLED_VAR,
        });
      }
    }
    return decision;
  }

  const timer = setInterval(evaluate, cfg.sampleMs);
  timer.unref?.();

  log.info('event-loop watchdog started', {
    sampleMs: cfg.sampleMs,
    heapPct: cfg.heapPct,
    lagMs: cfg.lagMs,
    lagMaxMs: cfg.lagMaxMs,
    breachSamples: cfg.breachSamples,
    bootGraceMs: cfg.bootGraceMs,
    restartEnabled: cfg.restartEnabled,
  });

  return {
    stop(): void {
      clearInterval(timer);
      histogram.disable();
    },
    sampleNow: evaluate,
    status(): WatchdogStatus {
      return (
        lastStatus ?? {
          enabled: cfg.enabled,
          restartEnabled: cfg.restartEnabled,
          config: { sampleMs: cfg.sampleMs, heapPct: cfg.heapPct, lagMs: cfg.lagMs, breachSamples: cfg.breachSamples, lagMaxMs: cfg.lagMaxMs, bootGraceMs: cfg.bootGraceMs, rssMaxBytes: cfg.rssMaxBytes, cgroupLimitBytes: cfg.cgroupLimitBytes, rssMaxSource: cfg.rssMaxSource, rssMaxWarning: cfg.rssMaxWarning },
          lastSample: null,
          peakSinceBoot: null,
          peakRssSinceBoot: null,
          recentHighLag: [],
          consecutiveHeapBreaches: 0,
          consecutiveLagBreaches: 0,
          inBootGrace: now() - startedAtMs < cfg.bootGraceMs,
          tripped: false,
          trippedReason: null,
          lastTrip,
          priorLiveness,
        }
      );
    },
  };
}

/** Test seam — reset the module-global trip latch between tests. */
export function _resetWatchdogForTests(): void {
  lastStatus = null;
  tripFired = false;
}
