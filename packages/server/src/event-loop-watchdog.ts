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
// Monitoring is always cheap and always on; the RESTART action defaults ON
// because the whole point of the ticket is "self-restarts cleanly … no hanging
// 502 limbo" and the prod box has no operator-in-the-loop to flip a flag mid-
// incident. It only ever fires on genuine pathology (≥10s of >2s lag, or ≥10s
// above 92% heap), so a false-positive restart of a healthy box is implausible.
// Set WATCHDOG_RESTART_ENABLED=false to observe-only, or WATCHDOG_ENABLED=false
// to disable entirely. All thresholds are env-tunable (see resolveConfig).

import { monitorEventLoopDelay, type IntervalHistogram } from 'node:perf_hooks';
import { getHeapStatistics } from 'node:v8';
import { logger, flushLogs } from './observability/index.js';

const log = logger.child({ module: 'event-loop-watchdog' });

export const WATCHDOG_ENABLED_VAR = 'WATCHDOG_ENABLED';
export const WATCHDOG_RESTART_ENABLED_VAR = 'WATCHDOG_RESTART_ENABLED';
export const WATCHDOG_SAMPLE_MS_VAR = 'WATCHDOG_SAMPLE_MS';
export const WATCHDOG_HEAP_PCT_VAR = 'WATCHDOG_HEAP_PCT';
export const WATCHDOG_LAG_MS_VAR = 'WATCHDOG_LAG_MS';
export const WATCHDOG_BREACH_SAMPLES_VAR = 'WATCHDOG_BREACH_SAMPLES';
export const WATCHDOG_BLOCK_MS_VAR = 'WATCHDOG_BLOCK_MS';
export const WATCHDOG_BOOT_GRACE_MS_VAR = 'WATCHDOG_BOOT_GRACE_MS';

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

export function resolveConfig(env: NodeJS.ProcessEnv = process.env): WatchdogConfig {
  return {
    enabled: envBool(env[WATCHDOG_ENABLED_VAR], DEFAULT_WATCHDOG.enabled),
    restartEnabled: envBool(env[WATCHDOG_RESTART_ENABLED_VAR], DEFAULT_WATCHDOG.restartEnabled),
    sampleMs: envNum(env[WATCHDOG_SAMPLE_MS_VAR], DEFAULT_WATCHDOG.sampleMs, 100, 60_000),
    heapPct: envNum(env[WATCHDOG_HEAP_PCT_VAR], DEFAULT_WATCHDOG.heapPct, 0.5, 0.99),
    lagMs: envNum(env[WATCHDOG_LAG_MS_VAR], DEFAULT_WATCHDOG.lagMs, 100, 600_000),
    breachSamples: Math.floor(envNum(env[WATCHDOG_BREACH_SAMPLES_VAR], DEFAULT_WATCHDOG.breachSamples, 1, 600)),
    lagMaxMs: envNum(env[WATCHDOG_BLOCK_MS_VAR], DEFAULT_WATCHDOG.lagMaxMs, 500, 600_000),
    bootGraceMs: envNum(env[WATCHDOG_BOOT_GRACE_MS_VAR], DEFAULT_WATCHDOG.bootGraceMs, 0, 1_800_000),
  };
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
}

/** Mutable breach counters carried between samples. */
export interface WatchdogState {
  consecutiveHeapBreaches: number;
  consecutiveLagBreaches: number;
}

export interface TripDecision {
  trip: boolean;
  reason?: 'heap' | 'lag' | 'block';
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
  config: { sampleMs: number; heapPct: number; lagMs: number; breachSamples: number; lagMaxMs: number; bootGraceMs: number };
  /** Most recent sample, or null before the first evaluation. */
  lastSample: (WatchdogSample & { atMs: number }) | null;
  consecutiveHeapBreaches: number;
  consecutiveLagBreaches: number;
  /** True while still inside the boot/warmup grace window (restart trips suppressed). */
  inBootGrace: boolean;
  /** True once a trip has fired (process is exiting). */
  tripped: boolean;
  trippedReason: 'heap' | 'lag' | 'block' | null;
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
  readHeap?: () => { usedBytes: number; limitBytes: number };
  /** Clock seam for the boot-grace window (defaults to Date.now). */
  now?: () => number;
}

let lastStatus: WatchdogStatus | null = null;

/** Snapshot for the health probe; null until the watchdog has started. */
export function getWatchdogStatus(): WatchdogStatus | null {
  return lastStatus;
}

function defaultReadHeap(): { usedBytes: number; limitBytes: number } {
  const heap = getHeapStatistics();
  return { usedBytes: heap.used_heap_size, limitBytes: heap.heap_size_limit };
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
  const now = opts.now ?? Date.now;
  const startedAtMs = now();
  const state: WatchdogState = { consecutiveHeapBreaches: 0, consecutiveLagBreaches: 0 };

  // ns-resolution event-loop delay histogram. Reset each window so lag reflects
  // only the most recent sampleMs, not a since-boot cumulative average.
  const histogram: IntervalHistogram = monitorEventLoopDelay({ resolution: 20 });
  histogram.enable();

  let tripped = false;
  let trippedReason: 'heap' | 'lag' | 'block' | null = null;

  function publish(sample: WatchdogSample): void {
    lastStatus = {
      enabled: cfg.enabled,
      restartEnabled: cfg.restartEnabled,
      config: { sampleMs: cfg.sampleMs, heapPct: cfg.heapPct, lagMs: cfg.lagMs, breachSamples: cfg.breachSamples, lagMaxMs: cfg.lagMaxMs, bootGraceMs: cfg.bootGraceMs },
      lastSample: { ...sample, atMs: Date.now() },
      consecutiveHeapBreaches: state.consecutiveHeapBreaches,
      consecutiveLagBreaches: state.consecutiveLagBreaches,
      inBootGrace: now() - startedAtMs < cfg.bootGraceMs,
      tripped,
      trippedReason,
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
          config: { sampleMs: cfg.sampleMs, heapPct: cfg.heapPct, lagMs: cfg.lagMs, breachSamples: cfg.breachSamples, lagMaxMs: cfg.lagMaxMs, bootGraceMs: cfg.bootGraceMs },
          lastSample: null,
          consecutiveHeapBreaches: 0,
          consecutiveLagBreaches: 0,
          inBootGrace: now() - startedAtMs < cfg.bootGraceMs,
          tripped: false,
          trippedReason: null,
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
