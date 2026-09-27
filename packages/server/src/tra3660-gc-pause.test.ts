// TRA-3660 (fourth instance, 2026-08-27T13:26:17Z) — the GC pause meter.
//
// The live reading that every test here is shaped by, off bqb1's `lastTrip`:
//
//   lagMaxMs 4547   lagMeanMs 4545   (one clean block filling the whole window)
//   heapUsedMB 1605 / heapLimitMB 1812  (88.6% of the old-space cap, 24.5h uptime)
//   slowSyncPhase null · stdio.slowWrites 0 · attribution.verdict unattributed-none
//   attribution.sampler.top  signal.doTick.news-refresh  share 1  straddleSamples 1
//
// Every instrument shipped so far reported in and said "not me". The one thing
// none of them can see is a stop-the-world collection — a block with no JS frame
// at all — and the heap figure is the tell that one is plausible. This module is
// the instrument that names it at the NEXT trip; these tests are the proof that
// it would have named this one.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { constants as perfConstants } from 'node:perf_hooks';
import {
  classifyBlockAttribution,
  ATTRIBUTION_EXPLAINED_MIN,
  startEventLoopWatchdog,
  getWatchdogStatus,
  _resetWatchdogForTests,
  type PersistedTrip,
} from './event-loop-watchdog.js';
import { getSyncBlockCensus } from './phase-timing.js';
import {
  recordGcPause,
  getGcPauseSnapshot,
  onGcPause,
  gcKindLabel,
  installGcPauseMeter,
  _resetGcPauseMeterForTests,
  GC_PAUSE_RING_MAX,
  GC_PAUSE_METER_VAR,
  type GcPause,
  type GcPauseSnapshot,
} from './gc-pause-meter.js';

const major = (over: Partial<GcPause>): GcPause => ({
  atMs: 0,
  durationMs: 0,
  kind: 'major',
  flags: 0,
  ...over,
});

describe('classifyBlockAttribution reads the collector (TRA-3660 fourth instance)', () => {
  // The exact 2026-08-27 shape: a block trip, 4547ms of lag, no sync phase.
  const live = { reason: 'block' as const, tripAtMs: 1_787_837_177_389, lagMaxMs: 4547, sampleMs: 1000, slowSyncPhase: null };

  it('names a major GC pause that ended inside the window as the culprit', () => {
    // A 4.4s mark-compact that finished 40ms before the watchdog evaluated is
    // exactly what a 1.6GB heap at 88% would produce, and exactly what the
    // sampler's `news-refresh` read cannot distinguish from an allocator.
    const pause = major({ atMs: live.tripAtMs - 40 - 4400, durationMs: 4400, heapUsedMB: 1605 });
    const r = classifyBlockAttribution({ ...live, gcPauses: [pause] });
    expect(r.verdict).toBe('gc-attributed');
    expect(r.gc).toEqual(pause);
    expect(r.explainedFraction).toBeCloseTo(4400 / 4547, 3);
    expect(r.explainedFraction!).toBeGreaterThanOrEqual(ATTRIBUTION_EXPLAINED_MIN);
  });

  it('keeps "nobody looked" distinct from "looked and found nothing"', () => {
    // Absent input ⇒ `gc` absent from the output: a reader must not score a
    // pre-meter record as a clean negative. Empty input ⇒ `gc: null`: the meter
    // was consulted and no pause fell in the window. Both stay unattributed.
    const nobodyLooked = classifyBlockAttribution({ ...live });
    expect(nobodyLooked.verdict).toBe('unattributed-none');
    expect('gc' in nobodyLooked).toBe(false);
    const looked = classifyBlockAttribution({ ...live, gcPauses: [] });
    expect(looked.verdict).toBe('unattributed-none');
    expect(looked.gc).toBeNull();
  });

  it('reports a short pause as present-but-not-the-culprit', () => {
    // A 300ms scavenge inside the window is a real reading — the collector was
    // running — but it does not explain 4.5s, and saying it did is how a root
    // cause gets closed on the wrong subsystem.
    const pause = major({ atMs: live.tripAtMs - 500, durationMs: 300, kind: 'minor' });
    const r = classifyBlockAttribution({ ...live, gcPauses: [pause] });
    expect(r.verdict).toBe('unattributed-none');
    expect(r.gc).toEqual(pause);
    expect(r.explainedFraction).toBeNull();
  });

  it('does not let a FOSSIL pause pose as the culprit', () => {
    // The ring holds ~32 recorded pauses, which on a quiet box can reach back
    // hours. A 4.4s pause from a minute ago is not this block's.
    const fossil = major({ atMs: live.tripAtMs - 60_000 - 4400, durationMs: 4400 });
    const r = classifyBlockAttribution({ ...live, gcPauses: [fossil] });
    expect(r.verdict).toBe('unattributed-none');
    expect(r.gc).toBeNull();
  });

  it('ignores a pause that ended after the trip — that is the NEXT block, or the restart', () => {
    const later = major({ atMs: live.tripAtMs + 2_000, durationMs: 4400 });
    const r = classifyBlockAttribution({ ...live, gcPauses: [later] });
    expect(r.verdict).toBe('unattributed-none');
    expect(r.gc).toBeNull();
  });

  it('places a pause by its END, so one that started before the window but ended inside it counts', () => {
    // windowMs = 4547 + 1000 + 1000 = 6547. A pause starting 8s before the trip
    // and lasting 4.4s ends 3.6s before the trip — inside the window.
    const straddler = major({ atMs: live.tripAtMs - 8_000, durationMs: 4400 });
    const r = classifyBlockAttribution({ ...live, gcPauses: [straddler] });
    expect(r.verdict).toBe('gc-attributed');
  });

  it('picks the LONGEST in-window pause, not the latest', () => {
    const big = major({ atMs: live.tripAtMs - 5_000, durationMs: 4300 });
    const small = major({ atMs: live.tripAtMs - 100, durationMs: 50, kind: 'minor' });
    const r = classifyBlockAttribution({ ...live, gcPauses: [small, big] });
    expect(r.verdict).toBe('gc-attributed');
    expect(r.gc).toEqual(big);
  });

  it('prefers the collector over a fresh sync phase — the pause is the more precise block', () => {
    // A sync phase that itself contained the collection would have been
    // attributed to the phase; the pause is the thing that actually stopped
    // the world, and the fix for a GC pause is not a fix for the phase.
    const pause = major({ atMs: live.tripAtMs - 4500, durationMs: 4400 });
    const r = classifyBlockAttribution({
      ...live,
      slowSyncPhase: { name: 'signal.doTick.news-refresh', durationMs: 4500, atMs: live.tripAtMs - 20, kind: 'sync' },
      gcPauses: [pause],
    });
    expect(r.verdict).toBe('gc-attributed');
  });

  it('still attributes to a sync phase when the only pause is short, and carries the pause alongside', () => {
    const pause = major({ atMs: live.tripAtMs - 300, durationMs: 120, kind: 'minor' });
    const r = classifyBlockAttribution({
      ...live,
      slowSyncPhase: { name: 'stdio.write', durationMs: 4100, atMs: live.tripAtMs - 20, kind: 'sync' },
      gcPauses: [pause],
    });
    expect(r.verdict).toBe('attributed');
    expect(r.gc).toEqual(pause);
  });

  it('stays silent on heap/rss trips — loop attribution is not their question', () => {
    const pause = major({ atMs: live.tripAtMs - 4500, durationMs: 4400 });
    const r = classifyBlockAttribution({ ...live, reason: 'heap', gcPauses: [pause] });
    expect(r.verdict).toBe('not-a-block-trip');
  });

  it('never publishes Infinity off a zero lag denominator', () => {
    const pause = major({ atMs: live.tripAtMs - 100, durationMs: 4400 });
    const r = classifyBlockAttribution({ ...live, lagMaxMs: 0, gcPauses: [pause] });
    expect(r.verdict).not.toBe('gc-attributed');
    expect(Number.isFinite(r.explainedFraction ?? 0)).toBe(true);
  });
});

describe('gc pause meter accounting', () => {
  beforeEach(() => _resetGcPauseMeterForTests());
  afterEach(() => _resetGcPauseMeterForTests());

  it('counts every pause but rings only the recordable ones', () => {
    recordGcPause(major({ atMs: 1_000, durationMs: 3, kind: 'minor' }));
    recordGcPause(major({ atMs: 2_000, durationMs: 250 }));
    recordGcPause(major({ atMs: 3_000, durationMs: 40, kind: 'incremental' }));
    const s = getGcPauseSnapshot();
    expect(s.count).toBe(3);
    expect(s.totalMs).toBe(293);
    expect(s.byKind.minor).toEqual({ count: 1, totalMs: 3, maxMs: 3 });
    expect(s.byKind.major).toEqual({ count: 1, totalMs: 250, maxMs: 250 });
    expect(s.byKind.incremental).toEqual({ count: 1, totalMs: 40, maxMs: 40 });
    expect(s.maxPause?.durationMs).toBe(250);
    expect(s.recent.map((p) => p.durationMs)).toEqual([250]);
  });

  it('bounds the ring so the instrument cannot leak with uptime', () => {
    for (let i = 0; i < GC_PAUSE_RING_MAX + 10; i += 1) {
      recordGcPause(major({ atMs: i * 1_000, durationMs: 100 + i }));
    }
    const s = getGcPauseSnapshot();
    expect(s.recent).toHaveLength(GC_PAUSE_RING_MAX);
    expect(s.recent[0]!.durationMs).toBe(110); // the 10 oldest were evicted
    expect(s.count).toBe(GC_PAUSE_RING_MAX + 10);
  });

  it('delivers to subscribers and survives one that throws', () => {
    const seen: number[] = [];
    const off = onGcPause(() => {
      throw new Error('a bad listener must not break the meter');
    });
    const off2 = onGcPause((p) => seen.push(p.durationMs));
    recordGcPause(major({ atMs: 1, durationMs: 500 }));
    off();
    off2();
    recordGcPause(major({ atMs: 2, durationMs: 600 }));
    expect(seen).toEqual([500]);
    expect(getGcPauseSnapshot().count).toBe(2);
  });

  it('labels V8 kinds by the perf_hooks constants, not by guessed integers', () => {
    expect(gcKindLabel(perfConstants.NODE_PERFORMANCE_GC_MAJOR)).toBe('major');
    expect(gcKindLabel(perfConstants.NODE_PERFORMANCE_GC_MINOR)).toBe('minor');
    expect(gcKindLabel(perfConstants.NODE_PERFORMANCE_GC_INCREMENTAL)).toBe('incremental');
    expect(gcKindLabel(perfConstants.NODE_PERFORMANCE_GC_WEAKCB)).toBe('weakcb');
    expect(gcKindLabel(undefined)).toBe('unknown');
  });

  it('is a no-op when switched off, and reports itself as such', () => {
    const off = installGcPauseMeter({ [GC_PAUSE_METER_VAR]: 'false' });
    expect(getGcPauseSnapshot().enabled).toBe(false);
    off();
  });

  it('observes REAL collections once installed — the observer is wired, not just declared', async () => {
    // Allocate well past the semi-space so V8 must scavenge at least once, then
    // yield so the `gc` entries can be delivered. Without this the whole module
    // could be a correct-looking meter attached to nothing.
    const off = installGcPauseMeter({});
    expect(getGcPauseSnapshot().enabled).toBe(true);
    let sink: unknown[] = [];
    for (let i = 0; i < 40; i += 1) {
      sink = new Array(200_000).fill(0).map((_, j) => ({ j, s: `x${j}` }));
    }
    expect(sink.length).toBe(200_000);
    for (let tries = 0; tries < 20 && getGcPauseSnapshot().count === 0; tries += 1) {
      await new Promise((r) => setTimeout(r, 25));
    }
    const s = getGcPauseSnapshot();
    off();
    expect(s.count).toBeGreaterThan(0);
    expect(s.maxPause).not.toBeNull();
    expect(s.maxPause!.atMs).toBeGreaterThan(Date.now() - 60_000); // wall-clock, not timeOrigin-relative
  });
});

describe('the GC meter is WIRED into the watchdog (TRA-3660 fourth instance)', () => {
  let dir: string;
  beforeEach(() => {
    _resetWatchdogForTests();
    _resetGcPauseMeterForTests();
    dir = mkdtempSync(join(tmpdir(), 'tra3660-gc-'));
  });
  afterEach(() => {
    _resetWatchdogForTests();
    _resetGcPauseMeterForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const snapshotWith = (recent: GcPause[], enabled = true): GcPauseSnapshot => ({
    enabled,
    count: recent.length,
    totalMs: recent.reduce((a, p) => a + p.durationMs, 0),
    byKind: {
      major: { count: recent.length, totalMs: 0, maxMs: Math.max(0, ...recent.map((p) => p.durationMs)) },
      minor: { count: 0, totalMs: 0, maxMs: 0 },
      incremental: { count: 0, totalMs: 0, maxMs: 0 },
      weakcb: { count: 0, totalMs: 0, maxMs: 0 },
      unknown: { count: 0, totalMs: 0, maxMs: 0 },
    },
    maxPause: recent[0] ?? null,
    recent,
    recordMs: 100,
    loudMs: 1000,
  });
  // TRA-4920 — `syncBlockCensus` is a required member of PhaseAttribution, and
  // deliberately so: an absent census must not be readable as an empty one.
  // A reset module's real census IS empty, so read it rather than hand-rolling
  // a literal that would drift from the shape.
  const quietPhases = () => ({
    lastSlowPhase: null,
    lastSlowSyncPhase: null,
    recentSlowPhases: [],
    activePhase: null,
    syncBlockCensus: getSyncBlockCensus(),
  });
  const heap = () => ({ usedBytes: 100e6, limitBytes: 1536e6, rssBytes: 400e6 });

  it('publishes the live meter on the status, and omits it when the meter is off', () => {
    const on = startEventLoopWatchdog({
      env: { WATCHDOG_BOOT_GRACE_MS: '0', WATCHDOG_LIVENESS_PERSIST: 'false' },
      readHeap: heap,
      readPhaseAttribution: quietPhases,
      readGcPauses: () => snapshotWith([major({ atMs: 1, durationMs: 1500 })]),
      onTrip: () => {},
    });
    on!.sampleNow();
    expect(getWatchdogStatus()?.gc?.byKind.major.maxMs).toBe(1500);
    on!.stop();
    _resetWatchdogForTests();
    const off = startEventLoopWatchdog({
      env: { WATCHDOG_BOOT_GRACE_MS: '0', WATCHDOG_LIVENESS_PERSIST: 'false' },
      readHeap: heap,
      readPhaseAttribution: quietPhases,
      readGcPauses: () => snapshotWith([], false),
      onTrip: () => {},
    });
    off!.sampleNow();
    expect(getWatchdogStatus()?.gc).toBeUndefined();
    off!.stop();
  });

  it('amends the persisted trip when the culprit pause is delivered AFTER the trip evaluated', async () => {
    // The ordering this test encodes is the whole reason the subscription
    // exists: the watchdog's timer and V8's `gc` entry are both queued behind
    // the same block, and the timer runs first. So at trip time the ring does
    // not yet hold the pause — the record must be amendable before exit.
    const tripPath = join(dir, 'trip.json');
    let listener: ((p: GcPause) => void) | null = null;
    let unsubscribed = false;
    const handle = startEventLoopWatchdog({
      env: {
        WATCHDOG_BOOT_GRACE_MS: '0',
        WATCHDOG_BLOCK_MS: '1000',
        WATCHDOG_LIVENESS_PERSIST: 'false',
        WATCHDOG_TRIP_LOG_PATH: tripPath,
      },
      readHeap: heap,
      readPhaseAttribution: quietPhases,
      readGcPauses: () => snapshotWith([]),
      subscribeGcPause: (fn) => {
        listener = fn;
        return () => {
          unsubscribed = true;
        };
      },
      onTrip: () => {},
    });
    // Let the delay histogram take its priming sample first: Node's ELD
    // histogram records nothing on its FIRST callback (it only sets `prev_`), so
    // a block that begins before that callback is invisible to it. Then hold the
    // loop synchronously past the (lowered) block threshold and yield so the
    // histogram can register the stall before anything evaluates.
    await new Promise((r) => setTimeout(r, 100));
    const blockedMs = 1_300;
    const gate = new Int32Array(new SharedArrayBuffer(4));
    const blockStart = Date.now();
    Atomics.wait(gate, 0, 0, blockedMs);
    await new Promise((r) => setTimeout(r, 60));
    // The watchdog's own 1000ms interval is overdue after a 1.3s block and runs
    // before this line — it consumes the histogram and fires the trip itself.
    // Grade the trip off the status, not off a second evaluation's return.
    if (!getWatchdogStatus()?.tripped) handle!.sampleNow();
    expect(getWatchdogStatus()?.tripped).toBe(true);
    expect(getWatchdogStatus()?.trippedReason).toBe('block');
    expect(existsSync(tripPath)).toBe(true);
    const first = JSON.parse(readFileSync(tripPath, 'utf8')) as PersistedTrip;
    expect(first.attribution?.verdict).toBe('unattributed-none');
    expect(first.attribution?.gc).toBeNull(); // the meter looked; the ring was empty
    expect(first.gc?.enabled).toBe(true);
    expect(listener).not.toBeNull();

    // V8 now delivers the pause that caused it: a major GC spanning the block.
    listener!(major({ atMs: blockStart, durationMs: blockedMs - 50, heapUsedMB: 1605 }));
    const amended = JSON.parse(readFileSync(tripPath, 'utf8')) as PersistedTrip;
    expect(amended.attribution?.verdict).toBe('gc-attributed');
    expect(amended.attribution?.gc?.durationMs).toBe(blockedMs - 50);
    expect(amended.attribution?.explainedFraction).toBeGreaterThanOrEqual(ATTRIBUTION_EXPLAINED_MIN);
    expect(amended.atMs).toBe(first.atMs); // same trip, amended in place
    expect(unsubscribed).toBe(true);
    handle!.stop();
  });

  it('does NOT amend on a late pause that cannot explain the block', async () => {
    const tripPath = join(dir, 'trip.json');
    let listener: ((p: GcPause) => void) | null = null;
    let unsubscribed = false;
    const handle = startEventLoopWatchdog({
      env: {
        WATCHDOG_BOOT_GRACE_MS: '0',
        WATCHDOG_BLOCK_MS: '1000',
        WATCHDOG_LIVENESS_PERSIST: 'false',
        WATCHDOG_TRIP_LOG_PATH: tripPath,
      },
      readHeap: heap,
      readPhaseAttribution: quietPhases,
      readGcPauses: () => snapshotWith([]),
      subscribeGcPause: (fn) => {
        listener = fn;
        return () => {
          unsubscribed = true;
        };
      },
      onTrip: () => {},
    });
    await new Promise((r) => setTimeout(r, 100)); // prime the histogram (see above)
    const gate = new Int32Array(new SharedArrayBuffer(4));
    Atomics.wait(gate, 0, 0, 1_300);
    await new Promise((r) => setTimeout(r, 60));
    if (!getWatchdogStatus()?.tripped) handle!.sampleNow();
    expect(getWatchdogStatus()?.tripped).toBe(true);
    expect(getWatchdogStatus()?.trippedReason).toBe('block');
    listener!(major({ atMs: Date.now() - 200, durationMs: 120, kind: 'minor' }));
    const after = JSON.parse(readFileSync(tripPath, 'utf8')) as PersistedTrip;
    expect(after.attribution?.verdict).toBe('unattributed-none');
    expect(unsubscribed).toBe(false); // still listening for the real culprit
    handle!.stop();
  });
});
