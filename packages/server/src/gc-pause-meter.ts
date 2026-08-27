// TRA-3660 (fourth instance, 2026-08-27T13:26:17Z) — name a loop block that is
// inside V8 itself: a garbage-collection pause.
//
// ── The reading that forced this ──────────────────────────────────────────────
// bqb1 tripped at 13:26:17Z with `lagMaxMs 4547` and — for the first time in this
// family — `lagMeanMs 4545`: the loop was gone for the ENTIRE 1000ms evaluation
// window, one clean block, not the many-chunk bleed of 08-18. Every instrument
// this ticket already shipped reported in, and every one of them said "not me":
//
//   * `slowSyncPhase: null`            — no instrumented sync section.
//   * `stdio.slowWrites 0, maxWrite 58ms` — not a write(2) into a full pipe.
//   * `attribution.sampler`            — `signal.doTick.news-refresh`, share 1.0,
//                                        1 straddle sample: the phase was IN FLIGHT
//                                        across the block, but it is an `async`
//                                        fan-out that awaits HTTP; it does not
//                                        itself hold the loop for 4.5s.
//
// What was different about this trip is the line the 2026-08-13 filing used to
// rule memory OUT: `heapUsedMB 1605 / heapLimitMB 1812` — 88.6% of the old-space
// cap after 88,217s (24.5h) of uptime, against a documented RTH heap peak of
// ~475MB. Render's RSS series for the same box climbs 500MB → 2545MB across the
// 08-26 RTH session and never comes back down overnight. A V8 mark-compact on a
// 1.6GB old space that is 88% full is a multi-second stop-the-world pause, and
// `news-refresh` (whole-universe JSON fan-out) is exactly the allocator that
// would force one. That is a hypothesis, and this module is the instrument that
// can confirm or refute it at the NEXT trip — it cannot be tested after the fact,
// for the same reason the 08-13 stall could not: the process that paused is gone.
//
// ── Why no existing instrument could see it ────────────────────────────────────
// A GC pause is a block with no JS frame at all — not a syscall of ours, not a
// phase, and not a write. `phase-timing` sees only code wrapped in `withPhase`;
// the stdio meter sees only writes; a stack sample cannot fire during the pause.
// The sampler's straddle read correctly names the phase that was running, but
// naming the phase that was ALLOCATING is not naming the collector that STOPPED
// the world — and a fix aimed at `news-refresh` would be a fix aimed at the
// wrong subsystem if the pause was the collector catching up on a day of growth.
//
// ── The instrument ─────────────────────────────────────────────────────────────
// `perf_hooks` publishes one `gc` performance entry per collection, AFTER it
// completes, with `duration` and `detail.kind` (major / minor / incremental /
// weak-callback). The entry is enqueued and delivered on a later loop turn, so:
//
//   * the meter keeps a bounded ring of pauses ≥ GC_PAUSE_RECORD_MS plus running
//     totals per kind, readable live on `/api/health/watchdog` as `gc` — a box
//     paying 1-3s major pauses under the acute threshold is visible without a trip;
//   * the watchdog reads the ring at trip time and, because the pause's own entry
//     may not have been delivered yet when the watchdog's timer fires (both are
//     queued behind the same block; the timer runs first), it ALSO subscribes for
//     one late delivery and amends the persisted trip record before the process
//     exits. Nothing about the restart waits on this.
//   * any pause ≥ GC_PAUSE_LOUD_MS is logged, so the Render tape carries the
//     answer even if the breadcrumb file is lost.
//
// Overhead: one observer callback per collection with a handful of arithmetic ops.
// Off switch: GC_PAUSE_METER=false.

import { PerformanceObserver, performance, constants as perfConstants } from 'node:perf_hooks';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'gc-pause-meter' });

export const GC_PAUSE_METER_VAR = 'GC_PAUSE_METER';
/** Pauses at least this long (ms) enter the ring; shorter ones only count. */
export const GC_PAUSE_RECORD_MS_VAR = 'GC_PAUSE_RECORD_MS';
/** Pauses at least this long (ms) are logged at warn level. */
export const GC_PAUSE_LOUD_MS_VAR = 'GC_PAUSE_LOUD_MS';

const DEFAULT_RECORD_MS = 100;
/**
 * 1000ms: a quarter of the acute trip, far above any healthy collection on
 * this heap (scavenges are single-digit ms; a healthy major on a few hundred MB
 * is tens of ms), and low enough that the Render tape names a bleeding
 * collector well before it reaches the trip.
 */
const DEFAULT_LOUD_MS = 1_000;
/** Bounded ring of recorded pauses, newest last. */
export const GC_PAUSE_RING_MAX = 32;

export type GcKind = 'major' | 'minor' | 'incremental' | 'weakcb' | 'unknown';

export interface GcPause {
  /** Wall-clock (ms) when the pause STARTED. */
  atMs: number;
  durationMs: number;
  kind: GcKind;
  /** Raw V8 flags bitfield from `detail.flags`; 0 when unavailable. */
  flags: number;
  /** `process.memoryUsage().heapUsed` at delivery (MB); approximates post-GC heap. */
  heapUsedMB?: number;
}

export interface GcKindTotals {
  count: number;
  totalMs: number;
  maxMs: number;
}

export interface GcPauseSnapshot {
  enabled: boolean;
  /** All collections seen since boot, recorded or not. */
  count: number;
  totalMs: number;
  byKind: Record<GcKind, GcKindTotals>;
  /** Longest single pause since boot, or null. */
  maxPause: GcPause | null;
  /** Ring of pauses ≥ `recordMs`, newest last. */
  recent: GcPause[];
  recordMs: number;
  loudMs: number;
}

export function gcKindLabel(kind: number | undefined): GcKind {
  switch (kind) {
    case perfConstants.NODE_PERFORMANCE_GC_MAJOR:
      return 'major';
    case perfConstants.NODE_PERFORMANCE_GC_MINOR:
      return 'minor';
    case perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL:
      return 'incremental';
    case perfConstants.NODE_PERFORMANCE_GC_WEAKCB:
      return 'weakcb';
    default:
      return 'unknown';
  }
}

function envBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw == null || raw === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

function envNum(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function emptyTotals(): Record<GcKind, GcKindTotals> {
  return {
    major: { count: 0, totalMs: 0, maxMs: 0 },
    minor: { count: 0, totalMs: 0, maxMs: 0 },
    incremental: { count: 0, totalMs: 0, maxMs: 0 },
    weakcb: { count: 0, totalMs: 0, maxMs: 0 },
    unknown: { count: 0, totalMs: 0, maxMs: 0 },
  };
}

let installed = false;
let enabled = false;
let recordMs = DEFAULT_RECORD_MS;
let loudMs = DEFAULT_LOUD_MS;
let count = 0;
let totalMs = 0;
let byKind = emptyTotals();
let maxPause: GcPause | null = null;
const recent: GcPause[] = [];
const listeners = new Set<(pause: GcPause) => void>();

/**
 * Fold one pause into the meter. Exported (rather than private to the observer)
 * so the trip-time path and the tests can drive it without a real collection —
 * you cannot schedule a 4.5s major GC on demand inside a unit test.
 */
export function recordGcPause(pause: GcPause): void {
  count += 1;
  const d = Number.isFinite(pause.durationMs) ? Math.max(0, pause.durationMs) : 0;
  totalMs += d;
  const totals = byKind[pause.kind] ?? byKind.unknown;
  totals.count += 1;
  totals.totalMs += d;
  if (d > totals.maxMs) totals.maxMs = d;
  if (!maxPause || d > maxPause.durationMs) maxPause = { ...pause, durationMs: d };
  if (d >= recordMs) {
    recent.push({ ...pause, durationMs: d });
    if (recent.length > GC_PAUSE_RING_MAX) recent.shift();
  }
  if (d >= loudMs) {
    // The one line a future reader needs on the Render tape: a stop-the-world
    // pause of this length is a loop block by definition, and this names it.
    log.warn('GC PAUSE — event loop held by garbage collection', {
      kind: pause.kind,
      durationMs: Math.round(d),
      flags: pause.flags,
      heapUsedMB: pause.heapUsedMB ?? null,
      atMs: pause.atMs,
    });
  }
  for (const fn of listeners) {
    try {
      fn(pause);
    } catch {
      // An observer must never be able to break the meter.
    }
  }
}

/** Live snapshot for `/api/health/watchdog` and the trip breadcrumb. */
export function getGcPauseSnapshot(): GcPauseSnapshot {
  return {
    enabled,
    count,
    totalMs,
    byKind: {
      major: { ...byKind.major },
      minor: { ...byKind.minor },
      incremental: { ...byKind.incremental },
      weakcb: { ...byKind.weakcb },
      unknown: { ...byKind.unknown },
    },
    maxPause: maxPause ? { ...maxPause } : null,
    recent: recent.map((p) => ({ ...p })),
    recordMs,
    loudMs,
  };
}

/**
 * Subscribe to every pause as it is delivered. Returns an unsubscribe. This is
 * how the watchdog catches the pause whose entry lands AFTER its trip evaluated.
 */
export function onGcPause(listener: (pause: GcPause) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Install the `gc` performance observer. Idempotent; returns an uninstall for
 * tests and shutdown. A no-op when GC_PAUSE_METER=false.
 */
export function installGcPauseMeter(env: NodeJS.ProcessEnv = process.env): () => void {
  if (installed) return () => undefined;
  if (!envBool(env[GC_PAUSE_METER_VAR], true)) {
    enabled = false;
    return () => undefined;
  }
  recordMs = envNum(env[GC_PAUSE_RECORD_MS_VAR], DEFAULT_RECORD_MS, 1, 60_000);
  loudMs = envNum(env[GC_PAUSE_LOUD_MS_VAR], DEFAULT_LOUD_MS, 10, 600_000);
  const observer = new PerformanceObserver((list) => {
    const heapUsedMB = Math.round(process.memoryUsage().heapUsed / 1e6);
    for (const entry of list.getEntries()) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `detail` is untyped on PerformanceEntry
      const detail = (entry as any).detail as { kind?: number; flags?: number } | undefined;
      recordGcPause({
        // `startTime` is relative to `performance.timeOrigin`; convert to wall-clock
        // so the watchdog can place the pause against its own `Date.now()` trip time.
        atMs: performance.timeOrigin + entry.startTime,
        durationMs: entry.duration,
        kind: gcKindLabel(detail?.kind),
        flags: detail?.flags ?? 0,
        heapUsedMB,
      });
    }
  });
  observer.observe({ entryTypes: ['gc'] });
  installed = true;
  enabled = true;
  log.info('gc pause meter installed', { recordMs, loudMs });
  return () => {
    observer.disconnect();
    installed = false;
    enabled = false;
  };
}

/** Test seam — drop all accumulated state. */
export function _resetGcPauseMeterForTests(): void {
  installed = false;
  enabled = false;
  recordMs = DEFAULT_RECORD_MS;
  loudMs = DEFAULT_LOUD_MS;
  count = 0;
  totalMs = 0;
  byKind = emptyTotals();
  maxPause = null;
  recent.length = 0;
  listeners.clear();
}
