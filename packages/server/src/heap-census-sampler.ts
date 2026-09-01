/**
 * TRA-4158 — drive {@link HeapCensusTape} on a timer and publish the series.
 *
 * The census itself ({@link ./heap-retainer-census.js}) is pure. This is the
 * only stateful half: one process-wide tape, one interval, one read-only
 * getter for `GET /api/health/heap-census`.
 *
 * ## Why a resident tape and not an external poller
 *
 * The claim under test is "the heap climbs through RTH and does NOT come back
 * down overnight", so the evidence is a SERIES spanning ~24h. An external
 * poller can produce one, but only for as long as something outside stays
 * awake to poll — and the box restarts (watchdog trips, deploys) are exactly
 * the events that would silently truncate it. A resident ring means ONE
 * post-close read returns the whole session, and its `atMs` values make any
 * gap self-evident instead of invisible.
 *
 * It is scoped to this investigation and is meant to be removed or turned down
 * once the retainer is named and bounded — hence the env switches rather than
 * a permanent unconditional cost.
 */

import {
  HeapCensusTape,
  type CensusOptions,
  type CensusSubject,
  type HeapCensusSample,
  type RetainerRow,
  type RetainerTrend,
  foldCensus,
} from './heap-retainer-census.js';

/**
 * 300 s. Chosen against the shape being measured, not for resolution: the
 * 2026-08-26 Render RSS series moved 500 MB -> 2545 MB over six hours, so
 * five-minute bins resolve the climb with ~72 points across a session while
 * keeping 24 h inside a 288-slot ring.
 */
const DEFAULT_INTERVAL_MS = 300_000;

/** 288 x 300 s = 24 h — one session plus the overnight flat that proves retention. */
const DEFAULT_CAPACITY = 288;

export interface HeapCensusSamplerOptions {
  /**
   * Enumerates the objects to census. Called fresh on every sample on purpose:
   * user contexts are created lazily (`ensureUserContext`), so a list captured
   * once at boot would under-count every context materialised later — and
   * under-counting reads as a healthy fleet.
   */
  subjects: () => CensusSubject[];
  intervalMs?: number;
  capacity?: number;
  now?: () => number;
}

export interface HeapCensusSamplerHandle {
  stop(): void;
  /** Take a sample immediately, outside the cadence. Used by tests. */
  sampleNow(): HeapCensusSample;
}

export interface HeapCensusStatus {
  enabled: boolean;
  intervalMs: number;
  capacity: number;
  /** How many samples the ring currently holds. */
  samples: number;
  /** Span of the tape in seconds — 0 with fewer than two samples. */
  spanSec: number;
  /**
   * A census taken right now, or `null` when there is none. Read it WITH
   * {@link liveError}: `null` + `liveError: null` is "the sampler was never
   * started"; `null` + a message is "enumerating the subjects threw". Those are
   * a config state and an incident, and a bare `null` for both would let the
   * incident read as the config state.
   */
  live: RetainerRow[] | null;
  /** Why {@link live} is null, when the reason is a failure. */
  liveError: string | null;
  /** Whether {@link live} carries deep (nested) sums. */
  deep: boolean;
  /** Chronological ring contents. */
  tape: HeapCensusSample[];
  /** Retainers ranked by growth across the tape, biggest riser first. */
  trends: RetainerTrend[];
}

let tape: HeapCensusTape | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let subjectsFn: (() => CensusSubject[]) | null = null;
let nowFn: () => number = () => Date.now();
let configuredIntervalMs = DEFAULT_INTERVAL_MS;
let configuredCapacity = DEFAULT_CAPACITY;

function readBool(raw: string | undefined, fallback: boolean): boolean {
  if (raw === undefined || raw === '') return fallback;
  return raw !== 'false' && raw !== '0';
}

function readPositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

/**
 * Start the sampler. Idempotent: a second call with the sampler already running
 * is a no-op that returns a handle onto the existing one, so a double-install
 * cannot double the cadence.
 *
 * `HEAP_CENSUS_ENABLED=false` turns it off; `HEAP_CENSUS_INTERVAL_MS` and
 * `HEAP_CENSUS_CAPACITY` override the defaults.
 */
export function startHeapCensusSampler(
  opts: HeapCensusSamplerOptions,
): HeapCensusSamplerHandle | null {
  if (!readBool(process.env.HEAP_CENSUS_ENABLED, true)) return null;
  configuredIntervalMs = opts.intervalMs ?? readPositiveInt(process.env.HEAP_CENSUS_INTERVAL_MS, DEFAULT_INTERVAL_MS);
  configuredCapacity = opts.capacity ?? readPositiveInt(process.env.HEAP_CENSUS_CAPACITY, DEFAULT_CAPACITY);
  subjectsFn = opts.subjects;
  nowFn = opts.now ?? (() => Date.now());
  if (!tape) tape = new HeapCensusTape(configuredCapacity);

  const sampleNow = (): HeapCensusSample => {
    const t = tape;
    const s = subjectsFn;
    if (!t || !s) throw new Error('heap census sampler is not started');
    return t.record(s(), nowFn());
  };

  if (timer) return { stop: stopHeapCensusSampler, sampleNow };

  // The first sample is taken immediately so a box that restarts mid-session
  // still publishes a boot-time baseline the next read can be differenced
  // against, rather than an empty tape for the first five minutes.
  try {
    sampleNow();
  } catch {
    // A census must never be able to take the process down. An empty tape is a
    // visible failure on the route; a throw here would not be.
  }

  timer = setInterval(() => {
    try {
      sampleNow();
    } catch {
      /* see above */
    }
  }, configuredIntervalMs);
  timer.unref?.();

  return { stop: stopHeapCensusSampler, sampleNow };
}

export function stopHeapCensusSampler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** Test-only: drop the tape and the interval so each case starts clean. */
export function __resetHeapCensusForTest(): void {
  stopHeapCensusSampler();
  tape = null;
  subjectsFn = null;
  nowFn = () => Date.now();
  configuredIntervalMs = DEFAULT_INTERVAL_MS;
  configuredCapacity = DEFAULT_CAPACITY;
}

/**
 * The read backing `GET /api/health/heap-census`.
 *
 * `deep` is opt-in per REQUEST, never on the sampled path: it is O(entries) and
 * the sampled path has to stay cheap enough to run during RTH on a live host.
 */
export function getHeapCensusStatus(opts: CensusOptions = {}): HeapCensusStatus {
  const samples = tape ? tape.snapshot() : [];
  const spanSec =
    samples.length >= 2
      ? Math.round((samples[samples.length - 1].atMs - samples[0].atMs) / 1000)
      : 0;
  // A health route must not be able to 500 because the thing it observes is
  // broken — that turns one subsystem's failure into "the probe is down", which
  // is the reading that gets a real incident dismissed as a flaky endpoint.
  let live: RetainerRow[] | null = null;
  let liveError: string | null = null;
  if (subjectsFn) {
    try {
      live = foldCensus(subjectsFn(), opts);
    } catch (err: unknown) {
      liveError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    enabled: timer !== null,
    intervalMs: configuredIntervalMs,
    capacity: configuredCapacity,
    samples: samples.length,
    spanSec,
    live,
    liveError,
    deep: opts.deep === true,
    tape: samples,
    trends: tape ? tape.trends() : [],
  };
}
