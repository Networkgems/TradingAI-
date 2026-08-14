// TRA-3660 (AC1) — close the attribution gap for a loop block that no phase can name.
//
// ── The gap ────────────────────────────────────────────────────────────────────
// On 2026-08-13T14:18:47.581Z bqb1 tripped the watchdog with `lagMaxMs 4060` and
// `lastTrip.slowSyncPhase: null`. Every attribution field we own is derived from
// `phase-timing.ts`, which can only name work wrapped in `withPhase` /
// `timeSyncPhase`. So a 4-second block OUTSIDE every instrumented phase produces
// exactly one reading: null — and the process that stalled is gone, so nobody can
// ever say what blocked. That is an *attribution gap*, not an absence of blocking.
//
// (Read `slowSyncPhase: null` carefully. It does NOT mean "no sync block". In
// TRA-2261 the large number was a PHASE DURATION while `peakSinceBoot.lagMaxMs`
// was 66.6ms — the loop never blocked and reading a block into it was the error.
// Here the large number IS the lag itself, off the delay sampler, which measures
// the loop directly and does not depend on phase instrumentation at all.)
//
// ── What actually blocks ───────────────────────────────────────────────────────
// Measured by `scripts/tra3660-log-storm-loop-lag.mjs` (TRA-3660 AC2), which is
// re-runnable and ships with its own null + negative controls:
//
//   * 1824 per-symbol `console.warn` lines with a DRAINING reader — 33.8ms lag.
//     The storm alone does NOT block. The stated hypothesis, tested, is FALSE.
//   * The same 1824 lines with the reader STALLED — lag tracks the stall almost
//     exactly (3684.7ms against a 4000ms stall) and the loop is dead for its
//     whole duration.
//   * Same N, same strings, formatted but NEVER WRITTEN — 32.2ms. The write is
//     the mechanism, not the formatting.
//
// Node's docs on `process.stdout`/`process.stderr`: writes are **synchronous**
// to a file, to a POSIX TTY, and to a **pipe on Linux and Windows**. Render
// collects container output through a pipe on Linux. A pipe has a fixed kernel
// buffer (64 KiB by default); while the collector keeps up, each write costs
// microseconds, and when it stalls the buffer fills and the next `write(2)`
// **blocks the entire process** — no timers, no I/O callbacks, no HTTP accept.
//
// So the block is inside a syscall, with no JS frame of ours on the stack, in a
// function nobody would think to wrap in a phase. A stack sample taken by the
// watchdog cannot see it either: the watchdog's own `setInterval` CANNOT fire
// during a synchronous block, so by the time it evaluates, the block is over.
// **The only place that can measure this block is the write call itself.**
//
// ── The instrument ─────────────────────────────────────────────────────────────
// Bracket `process.stdout.write` / `process.stderr.write` with a monotonic clock.
// Because those writes are synchronous, time-spent-inside-write IS event-loop
// block time by construction — which is precisely the `kind: 'sync'` contract of
// `phase-timing.ts`. So a slow write is reported through the SAME channel the
// diagnosis already reads, and `lastTrip.slowSyncPhase` stops being null for this
// entire failure class. TRA-2261's discriminator keeps working unchanged.
//
// Second, keep a rolling per-emitter line histogram. The storm is what fills the
// buffer, and its lines are written *during* the block — so unlike a stack sample
// this evidence survives the block. `topEmitters` on the trip breadcrumb names
// `[yahoo-feed]` with its count, which is what makes the next incident readable
// instead of unattributable.
//
// Overhead: one `hrtime.bigint()` pair and one short regex per written chunk.
// At the storm's own rate (~1000 lines/s) that is well under 0.1% of a core, and
// at ordinary rates it is unmeasurable. Off switch: STDIO_BLOCK_METER=false.

import { recordPhaseDuration } from './phase-timing.js';

export const STDIO_BLOCK_METER_VAR = 'STDIO_BLOCK_METER';
export const STDIO_BLOCK_SLOW_MS_VAR = 'STDIO_BLOCK_SLOW_MS';

/**
 * A single write slower than this is recorded as a `sync` phase (i.e. as a real
 * event-loop block) under the name `stdio.write`.
 *
 * 250ms, deliberately far below the watchdog's 4000ms acute trip: the point of
 * this instrument is to have already NAMED the culprit by the time the trip
 * fires, and to leave a live Render-log breadcrumb for stalls that never reach a
 * trip at all. A healthy pipe write is microseconds, so 250ms cannot fire on one.
 */
const DEFAULT_SLOW_WRITE_MS = 250;

/** Rolling window (seconds) retained for the per-emitter line histogram. */
const WINDOW_SECONDS = 15;

/** Most emitters reported in a snapshot, busiest first. */
const TOP_EMITTERS_MAX = 5;

/** A stdio write slow enough to be an event-loop block in its own right. */
export interface SlowWrite {
  /** Wall-clock (ms) when the write RETURNED. */
  atMs: number;
  /** How long the process was inside `write(2)`. This is block time. */
  durationMs: number;
  /** `stdout` or `stderr`. */
  stream: 'stdout' | 'stderr';
  /** Emitter tag of the blocking chunk (see {@link emitterTag}). */
  emitter: string;
  /** Bytes in the blocking chunk. */
  bytes: number;
}

/** What the meter knows, read at trip time / by the health route. */
export interface StdioBlockSnapshot {
  enabled: boolean;
  /** Total writes seen since boot. */
  writes: number;
  /** Total wall time spent INSIDE write since boot, ms. All of it is block time. */
  totalWriteMs: number;
  /** The single worst write since boot. */
  maxWrite: SlowWrite | null;
  /** How many writes crossed the slow threshold since boot. */
  slowWrites: number;
  /** Most recent slow write (null until one happens). */
  lastSlowWrite: SlowWrite | null;
  /**
   * Line counts by emitter over the last {@link WINDOW_SECONDS}, busiest first.
   * This is the storm evidence, and it is written DURING the block, so it
   * survives a block a stack sample could never reach.
   */
  topEmitters: Array<{ emitter: string; lines: number }>;
  /** Total lines in the window (the denominator `topEmitters` is a share of). */
  windowLines: number;
  windowSeconds: number;
}

/**
 * Emitter tag for a chunk: the leading `[tag]` our per-subsystem console lines
 * all carry (`[yahoo-feed]`, `[tradier]`, …), else the leading JSON `module`
 * field the structured logger writes, else `other`.
 *
 * Deliberately cheap and deliberately COARSE. The question this answers is
 * "which subsystem produced 1824 lines in 1.8 seconds", and any per-line detail
 * would make the histogram unbounded — the exact way an observability feature
 * turns into the memory leak it was added to diagnose.
 */
export function emitterTag(chunk: unknown): string {
  if (typeof chunk !== 'string') return 'binary';
  const head = chunk.slice(0, 80);
  const bracket = /^\[([\w.-]{1,32})\]/.exec(head);
  if (bracket) return bracket[1]!;
  const mod = /"module"\s*:\s*"([\w.-]{1,32})"/.exec(head);
  if (mod) return mod[1]!;
  return 'other';
}

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

// ── module state ───────────────────────────────────────────────────────────────

let installed = false;
let enabled = false;
let slowWriteMs = DEFAULT_SLOW_WRITE_MS;

let writes = 0;
let totalWriteNs = 0n;
let slowWrites = 0;
let maxWrite: SlowWrite | null = null;
let lastSlowWrite: SlowWrite | null = null;

/** Per-second buckets of `emitter -> lines`, keyed by epoch-second. */
const buckets = new Map<number, Map<string, number>>();

/**
 * Reentrancy latch. Recording a slow phase LOGS, and that log is itself a write —
 * which would be metered, could itself be slow, and would record again. Without
 * this latch a single stalled collector recurses until the stack blows, i.e. the
 * instrument becomes a worse outage than the one it measures.
 */
let inRecord = false;

function bumpEmitter(tag: string, nowMs: number): void {
  const sec = Math.floor(nowMs / 1000);
  let bucket = buckets.get(sec);
  if (!bucket) {
    bucket = new Map();
    buckets.set(sec, bucket);
    // Evict anything outside the window. Bounded by WINDOW_SECONDS entries, so
    // this Map cannot grow with uptime however long the box runs.
    for (const key of buckets.keys()) {
      if (key <= sec - WINDOW_SECONDS) buckets.delete(key);
    }
  }
  bucket.set(tag, (bucket.get(tag) ?? 0) + 1);
}

/** Merge the rolling buckets into a busiest-first emitter list. */
function summarizeWindow(nowMs: number): { top: Array<{ emitter: string; lines: number }>; total: number } {
  const floor = Math.floor(nowMs / 1000) - WINDOW_SECONDS;
  const merged = new Map<string, number>();
  let total = 0;
  for (const [sec, bucket] of buckets) {
    if (sec <= floor) continue;
    for (const [tag, n] of bucket) {
      merged.set(tag, (merged.get(tag) ?? 0) + n);
      total += n;
    }
  }
  const top = [...merged]
    .map(([emitter, lines]) => ({ emitter, lines }))
    .sort((a, b) => b.lines - a.lines)
    .slice(0, TOP_EMITTERS_MAX);
  return { top, total };
}

/** Read the meter. Safe to call before {@link installStdioBlockMeter}. */
export function getStdioBlockSnapshot(nowMs: number = Date.now()): StdioBlockSnapshot {
  const { top, total } = summarizeWindow(nowMs);
  return {
    enabled,
    writes,
    totalWriteMs: Math.round(Number(totalWriteNs) / 1e6),
    maxWrite,
    slowWrites,
    lastSlowWrite,
    topEmitters: top,
    windowLines: total,
    windowSeconds: WINDOW_SECONDS,
  };
}

/**
 * The shape we monkey-patch. Deliberately looser than `NodeJS.WriteStream`: the
 * test needs a stream it can stall on demand and `process.stdout` is not one of
 * those, so the seam has to accept a plain object with a `write`.
 */
export interface WritableLike {
  write: (...args: never[]) => boolean;
}

/**
 * Wrap one stream's `write` with the timing bracket. Exported for the test, which
 * needs a stream it can stall on demand — `process.stdout` is not one of those.
 */
export function meterStream(
  stream: WritableLike,
  name: 'stdout' | 'stderr',
  opts: { slowMs?: number; now?: () => number; hr?: () => bigint } = {},
): () => void {
  const original = stream.write.bind(stream);
  const nowMs = opts.now ?? Date.now;
  const hr = opts.hr ?? process.hrtime.bigint;
  const threshold = opts.slowMs ?? slowWriteMs;

  const wrapped = function metered(this: unknown, ...args: unknown[]): boolean {
    // A write issued from inside our own slow-write reporting is NOT metered:
    // see `inRecord`. It still goes out; it just does not feed the instrument.
    if (inRecord) return original(...(args as never[]));

    const chunk = args[0];
    const started = hr();
    let ok: boolean;
    try {
      ok = original(...(args as never[]));
    } finally {
      const elapsedNs = hr() - started;
      writes++;
      totalWriteNs += elapsedNs;
      const at = nowMs();
      bumpEmitter(emitterTag(chunk), at);

      const durationMs = Number(elapsedNs) / 1e6;
      if (!maxWrite || durationMs > maxWrite.durationMs) {
        maxWrite = {
          atMs: at,
          durationMs: Number(durationMs.toFixed(1)),
          stream: name,
          emitter: emitterTag(chunk),
          bytes: typeof chunk === 'string' ? chunk.length : 0,
        };
      }
      if (durationMs >= threshold) {
        slowWrites++;
        lastSlowWrite = {
          atMs: at,
          durationMs: Number(durationMs.toFixed(1)),
          stream: name,
          emitter: emitterTag(chunk),
          bytes: typeof chunk === 'string' ? chunk.length : 0,
        };
        inRecord = true;
        try {
          // A synchronous write IS loop-block time, so this is a `sync` phase in
          // the strict TRA-2111 sense — it belongs in `lastSlowSyncPhase` and it
          // is the whole point of this file. `phase-timing` applies its own slow
          // threshold on top, so a write below PHASE_TIMING_SLOW_MS is counted
          // here and stays out of the phase ring.
          recordPhaseDuration(`stdio.write.${name}`, durationMs, at, process.env, 'sync');
        } catch {
          // An instrument must never be able to break the write it measures.
        } finally {
          inRecord = false;
        }
      }
    }
    return ok;
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- narrow, deliberate monkey-patch of a Node global
  (stream as any).write = wrapped;
  return () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- restore the exact original
    (stream as any).write = original;
  };
}

/**
 * Install the meter on the real process streams. Idempotent; returns an uninstall
 * for tests and shutdown. A no-op when STDIO_BLOCK_METER=false.
 */
export function installStdioBlockMeter(env: NodeJS.ProcessEnv = process.env): () => void {
  if (installed) return () => undefined;
  if (!envBool(env[STDIO_BLOCK_METER_VAR], true)) {
    enabled = false;
    return () => undefined;
  }
  slowWriteMs = envNum(env[STDIO_BLOCK_SLOW_MS_VAR], DEFAULT_SLOW_WRITE_MS, 10, 60_000);
  const restoreOut = meterStream(process.stdout as never, 'stdout', { slowMs: slowWriteMs });
  const restoreErr = meterStream(process.stderr as never, 'stderr', { slowMs: slowWriteMs });
  installed = true;
  enabled = true;
  return () => {
    restoreOut();
    restoreErr();
    installed = false;
    enabled = false;
  };
}

/** Test seam — drop all accumulated state. */
export function _resetStdioBlockMeterForTests(): void {
  writes = 0;
  totalWriteNs = 0n;
  slowWrites = 0;
  maxWrite = null;
  lastSlowWrite = null;
  inRecord = false;
  buckets.clear();
  installed = false;
  enabled = false;
  slowWriteMs = DEFAULT_SLOW_WRITE_MS;
}
