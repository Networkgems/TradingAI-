import { describe, it, expect, afterEach } from 'vitest';
import {
  timeSyncPhase,
  withPhase,
  getCurrentPhase,
  recordPhaseDuration,
  getPhaseAttribution,
  getSyncBlockCensus,
  SyncSliceMeter,
  _resetPhaseTimingForTests,
} from './phase-timing.js';

afterEach(() => {
  _resetPhaseTimingForTests();
});

describe('phase-timing', () => {
  it('records a synchronous phase that crosses the slow threshold', () => {
    // Directly record a 71s block (the bqb1 signature) — no need to actually
    // burn the wall clock in the test. Default kind is `sync` (a real block).
    recordPhaseDuration('crypto.doTick', 71_538, 1_000);
    const { lastSlowPhase, lastSlowSyncPhase, recentSlowPhases } = getPhaseAttribution();
    expect(lastSlowPhase).toEqual({ name: 'crypto.doTick', durationMs: 71_538, atMs: 1_000, kind: 'sync' });
    expect(lastSlowSyncPhase).toEqual({ name: 'crypto.doTick', durationMs: 71_538, atMs: 1_000, kind: 'sync' });
    expect(recentSlowPhases).toHaveLength(1);
  });

  it('TRA-2111: a slow ASYNC tick is tagged and never overwrites the sync-block culprit', () => {
    // A real synchronous block is recorded...
    recordPhaseDuration('signal.doTick', 4_800, 1_000, process.env, 'sync');
    // ...then a slower I/O-bound async tick lands (13s wall, loop NOT starved —
    // the both-feeds-down stampede fetchQuotes fan-out). It must be tagged async
    // and must NOT become the block attribution.
    recordPhaseDuration('signal.doTick', 13_134, 2_000, process.env, 'async');
    const { lastSlowPhase, lastSlowSyncPhase, recentSlowPhases } = getPhaseAttribution();
    // lastSlowPhase is the newest of either kind (the async tick), correctly tagged.
    expect(lastSlowPhase).toEqual({ name: 'signal.doTick', durationMs: 13_134, atMs: 2_000, kind: 'async' });
    // lastSlowSyncPhase still names the ACTUAL block — the async tick did not poison it.
    expect(lastSlowSyncPhase).toEqual({ name: 'signal.doTick', durationMs: 4_800, atMs: 1_000, kind: 'sync' });
    // The ring carries both, each tagged, so a consumer can filter to blocks.
    expect(recentSlowPhases.map((p) => p.kind)).toEqual(['sync', 'async']);
  });

  it('TRA-2111: timeSyncPhase tags its recorded phase `sync` end-to-end', () => {
    // A tightened threshold + a body that burns a couple ms forces a real
    // timeSyncPhase record, proving the wrapper (not just recordPhaseDuration)
    // tags `sync`.
    const prev = process.env['PHASE_TIMING_SLOW_MS'];
    process.env['PHASE_TIMING_SLOW_MS'] = '1';
    try {
      timeSyncPhase('sync.section', () => {
        const until = Date.now() + 3;
        while (Date.now() < until) { /* burn ~3ms so the phase crosses 1ms */ }
        return 1;
      });
    } finally {
      if (prev === undefined) delete process.env['PHASE_TIMING_SLOW_MS'];
      else process.env['PHASE_TIMING_SLOW_MS'] = prev;
    }
    const attr = getPhaseAttribution();
    expect(attr.lastSlowPhase?.name).toBe('sync.section');
    expect(attr.lastSlowPhase?.kind).toBe('sync');
    expect(attr.lastSlowSyncPhase?.name).toBe('sync.section');
  });

  it('ignores a phase below the slow threshold (default 1s)', () => {
    recordPhaseDuration('cheap.tick', 250, 1_000);
    expect(getPhaseAttribution().lastSlowPhase).toBeNull();
    expect(getPhaseAttribution().recentSlowPhases).toHaveLength(0);
  });

  it('honours PHASE_TIMING_SLOW_MS to tighten the threshold', () => {
    recordPhaseDuration('mid.tick', 300, 1_000, { PHASE_TIMING_SLOW_MS: '200' } as NodeJS.ProcessEnv);
    expect(getPhaseAttribution().lastSlowPhase?.name).toBe('mid.tick');
  });

  it('timeSyncPhase returns the callback result and still attributes an exception', () => {
    // Force a recorded duration by using a threshold of 0 for this call path via
    // a long-enough synthetic phase: record directly is covered above, so here we
    // only assert the wrapper is transparent to value + throw.
    expect(timeSyncPhase('ok.phase', () => 42)).toBe(42);
    expect(() => timeSyncPhase('throwing.phase', () => {
      throw new Error('boom');
    })).toThrow('boom');
  });

  it('withPhase holds the in-flight pointer during the phase and clears it after', async () => {
    expect(getCurrentPhase()).toBeNull();
    let seenInside: string | null = null;
    const result = await withPhase('signal.doTick', async () => {
      seenInside = getCurrentPhase()?.name ?? null;
      // the live attribution names the in-flight subsystem — the block signal
      expect(getPhaseAttribution().activePhase?.name).toBe('signal.doTick');
      return 7;
    });
    expect(result).toBe(7);
    expect(seenInside).toBe('signal.doTick');
    // pointer restored (to null) once the phase resolves
    expect(getCurrentPhase()).toBeNull();
    expect(getPhaseAttribution().activePhase).toBeNull();
  });

  it('withPhase restores the prior pointer on nested phases and on throw', async () => {
    await withPhase('outer', async () => {
      await withPhase('inner', async () => {
        expect(getCurrentPhase()?.name).toBe('inner');
      });
      // inner unwound back to outer
      expect(getCurrentPhase()?.name).toBe('outer');
      await expect(
        withPhase('boom', async () => {
          throw new Error('nope');
        }),
      ).rejects.toThrow('nope');
      // a throwing phase still restores the parent pointer
      expect(getCurrentPhase()?.name).toBe('outer');
    });
    expect(getCurrentPhase()).toBeNull();
  });

  it('keeps only the most recent RING_MAX slow phases, newest last', () => {
    // TRA-2200 raised the default cap 16 -> 512, so 20 records now all fit.
    for (let i = 0; i < 20; i += 1) recordPhaseDuration(`phase-${i}`, 2_000, i);
    const { recentSlowPhases, lastSlowPhase } = getPhaseAttribution();
    expect(recentSlowPhases).toHaveLength(20);
    expect(recentSlowPhases[recentSlowPhases.length - 1]?.name).toBe('phase-19');
    expect(lastSlowPhase?.name).toBe('phase-19');
  });

  it('TRA-2200: the ring retains a full RTH session, not the ~10 minutes 16 slots held', () => {
    // The 2026-07-23 tape carried 2,537 slow-phase records across 6.4h and 3
    // engines (~400/h). At 16 slots a post-close read of /api/health/watchdog
    // spanned 10.1 MINUTES and reported "16/16 signal.doTick, zero sub-labels" —
    // read as an instrumentation bug when both sub-labels had in fact been
    // emitting all session. That is a confident falsehood, not a gap.
    for (let i = 0; i < 400; i += 1) recordPhaseDuration(`phase-${i}`, 2_000, i);
    const { recentSlowPhases } = getPhaseAttribution();
    expect(recentSlowPhases).toHaveLength(400);
    // The OLDEST record survives — this is the property the 16-slot ring lacked.
    expect(recentSlowPhases[0]?.name).toBe('phase-0');
  });

  it('TRA-2200: PHASE_TIMING_RING_MAX overrides the default without a redeploy', () => {
    const env = { PHASE_TIMING_RING_MAX: '3' } as NodeJS.ProcessEnv;
    for (let i = 0; i < 10; i += 1) recordPhaseDuration(`phase-${i}`, 2_000, i, env);
    const { recentSlowPhases } = getPhaseAttribution();
    expect(recentSlowPhases.map((p) => p.name)).toEqual(['phase-7', 'phase-8', 'phase-9']);
  });

  it('TRA-2200: a SHRUNK cap drains the ring instead of leaving it over the new cap', () => {
    // The cap is re-read per record (not captured once), and the drain is a
    // `while`, not a single `shift()`. With a single shift a ring holding 400
    // entries would take 398 further records to reach a newly-set cap of 2 —
    // i.e. the override would appear not to work for the rest of the session.
    for (let i = 0; i < 50; i += 1) recordPhaseDuration(`phase-${i}`, 2_000, i);
    expect(getPhaseAttribution().recentSlowPhases).toHaveLength(50);
    recordPhaseDuration('after-shrink', 2_000, 99, { PHASE_TIMING_RING_MAX: '2' } as NodeJS.ProcessEnv);
    const { recentSlowPhases } = getPhaseAttribution();
    expect(recentSlowPhases).toHaveLength(2);
    expect(recentSlowPhases[recentSlowPhases.length - 1]?.name).toBe('after-shrink');
  });

  it('TRA-2200: a junk or non-positive PHASE_TIMING_RING_MAX falls back to the default', () => {
    for (const raw of ['', '   ', 'abc', '0', '-5']) {
      _resetPhaseTimingForTests();
      const env = { PHASE_TIMING_RING_MAX: raw } as NodeJS.ProcessEnv;
      for (let i = 0; i < 20; i += 1) recordPhaseDuration(`phase-${i}`, 2_000, i, env);
      // Default 512 -> all 20 retained. A cap of 0 would silently blind the
      // instrument entirely, which is the failure this guards.
      expect(getPhaseAttribution().recentSlowPhases).toHaveLength(20);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-4920 — the since-boot sync census.
//
// Live on bqb1 2026-09-25T19:48Z, one payload, one instant:
//   .watchdog.phaseAttribution.lastSlowSyncPhase =
//        yield-preempt@signal.doTick.equity-entry-sweep, 1436ms, kind "sync", 19:01:20Z
//   .watchdog.phaseAttribution.recentSlowPhases  = n=512, histogram {async: 512}
// From that we could state that ONE 1436ms block happened. Not how many, not
// the distribution, not whether it is trending. Every grade of the residual was
// therefore an anecdote, and a residual you cannot measure decays back toward
// the 5s health budget silently.
// ─────────────────────────────────────────────────────────────────────────────

/** Hold the loop synchronously for ~ms (a real block, not a timer). */
function busyBlock(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* burn */ }
}

describe('TRA-4920 — sync-block census', () => {
  it('AC2: a REAL >=1s synchronous yield-preempt increments the census, through the live wrapper', () => {
    // The fixture: drive the shipped SyncSliceMeter, with a genuine >=1s
    // synchronous burn standing in for the foreign uninstrumented work that
    // starves the loop during a yield. No injected duration, no stubbed clock —
    // the same call the live box makes, at the live default thresholds.
    const meter = new SyncSliceMeter('signal.doTick.equity-entry-sweep');
    const scheduledAt = Date.now();
    busyBlock(1_050);
    meter.onYieldResumed(scheduledAt, 'TSLA');

    const c = getSyncBlockCensus();
    expect(c.count).toBe(1);
    expect(c.countAtOrOver1s).toBe(1);
    expect(c.buckets['1000-1999']).toBe(1);
    expect(c.maxMs).toBeGreaterThanOrEqual(1_000);
    // AC1 — the phase name survives. The witness is never the culprit, but it
    // says the block was FOREIGN work seen from this phase's yield, which is
    // the opposite verdict from a `#slice`.
    expect(c.maxName).toBe('yield-preempt@signal.doTick.equity-entry-sweep');
    expect(c.byName['yield-preempt@signal.doTick.equity-entry-sweep']).toMatchObject({ count: 1 });
  }, 10_000);

  it('AC2 (the mutation): the SAME >=1s delay reads 0 when the tagger mislabels it', () => {
    // The discriminator has to be a LIVE mis-tag path, not a synthetic mutant.
    // This is one: `onYieldResumed` re-tags the identical delay as
    // `yield-wait@<phase>` kind `async` whenever heldTurns > 0. Same method,
    // same duration, one flag moved.
    const meter = new SyncSliceMeter('signal.doTick.equity-entry-sweep');
    const scheduledAt = Date.now();
    busyBlock(1_050);
    meter.onYieldResumed(scheduledAt, 'TSLA', /* heldTurns */ 1);

    const c = getSyncBlockCensus();
    // A >=1s event provably happened — the ring caught it, tagged async.
    expect(getPhaseAttribution().recentSlowPhases).toHaveLength(1);
    expect(getPhaseAttribution().recentSlowPhases[0]!.kind).toBe('async');
    // ...and the census reads ZERO. This is the reading a broken tagger
    // produces, and it is indistinguishable from a quiet box — which is why
    // this control ships WITH the counter and not as a follow-up.
    expect(c.count).toBe(0);
    expect(c.countAtOrOver1s).toBe(0);
    expect(c.maxName).toBeNull();
  }, 10_000);

  it('AC1: the census keeps counting past RING_MAX — the ring EVICTS, the census does not', () => {
    // THE MECHANISM, stated precisely: `recentSlowPhases` does not EXCLUDE sync
    // records (recordPhaseDuration pushes both kinds). It EVICTS them. The ring
    // horizon is set by the `async` arrival rate, which on bqb1 is orders of
    // magnitude above the `sync` rate — so the live 512/512-async read is a
    // FIFO artefact, not proof that no sync record was ever written.
    const env = { PHASE_TIMING_RING_MAX: '8' } as NodeJS.ProcessEnv;
    recordPhaseDuration('yield-preempt@signal.doTick.equity-entry-sweep', 1_436, 1_000, env, 'sync');
    // The sync record IS in the ring at first — exclusion would show up here.
    expect(getPhaseAttribution().recentSlowPhases.map((p) => p.kind)).toEqual(['sync']);
    // ...then the async flood arrives and shifts it straight back out.
    for (let i = 0; i < 40; i += 1) recordPhaseDuration('signal.doTick', 13_000, 2_000 + i, env, 'async');

    const ring = getPhaseAttribution().recentSlowPhases;
    expect(ring).toHaveLength(8);
    expect(ring.filter((p) => p.kind === 'sync')).toHaveLength(0); // the live 512/512 reading, reproduced

    // The census is untouched by the flood: it still knows the block happened,
    // how big it was, and what it was called.
    const c = getSyncBlockCensus(env);
    expect(c.count).toBe(1);
    expect(c.maxMs).toBe(1_436);
    expect(c.maxName).toBe('yield-preempt@signal.doTick.equity-entry-sweep');
  });

  it('AC1: buckets make the approach to 1000ms visible BEFORE a 1000ms block exists', () => {
    // The ring threshold is 1000ms, so a residual climbing 300 -> 600 -> 900 is
    // completely invisible to every existing surface until it is already a
    // block. The census floor is 250ms for exactly this reason.
    for (const ms of [260, 300, 499, 500, 900, 1_100, 2_500, 6_000]) {
      recordPhaseDuration('yield-preempt@p', ms, 1_000, process.env, 'sync');
    }
    const c = getSyncBlockCensus();
    expect(c.thresholdMs).toBe(250);
    expect(c.buckets).toEqual({ '250-499': 3, '500-999': 2, '1000-1999': 1, '2000-4999': 1, '5000+': 1 });
    expect(c.count).toBe(8);
    expect(c.countAtOrOver1s).toBe(3);
    // Only the three >=1000ms records reached the ring — the census widened the
    // intake without changing what the ring or the latch mean.
    expect(getPhaseAttribution().recentSlowPhases).toHaveLength(3);
  });

  it('a sub-threshold sync record and an async record both stay out of the census', () => {
    recordPhaseDuration('cheap.sync', 249, 1_000, process.env, 'sync');
    recordPhaseDuration('signal.doTick', 13_134, 1_000, process.env, 'async');
    const c = getSyncBlockCensus();
    expect(c.count).toBe(0);
    expect(c.firstAtMs).toBeNull();
    // An `async` wall time includes awaited I/O — folding one in would make the
    // count unreadable as a BLOCK count, which is the only thing it is for.
    expect(c.byName).toEqual({});
  });

  it('SYNC_BLOCK_CENSUS_MIN_MS tightens the intake floor without a redeploy', () => {
    const env = { SYNC_BLOCK_CENSUS_MIN_MS: '600' } as NodeJS.ProcessEnv;
    recordPhaseDuration('yield-preempt@p', 400, 1_000, env, 'sync');
    recordPhaseDuration('yield-preempt@p', 700, 1_001, env, 'sync');
    const c = getSyncBlockCensus(env);
    expect(c.thresholdMs).toBe(600);
    expect(c.count).toBe(1);
    // The floor is published beside the buckets, so a reader can tell a raised
    // floor from an empty bucket.
    expect(c.buckets['250-499']).toBe(0);
    expect(c.buckets['500-999']).toBe(1);
  });

  it('a junk SYNC_BLOCK_CENSUS_MIN_MS falls back to 250 rather than blinding the census', () => {
    for (const raw of ['', '  ', 'abc', '0', '-5']) {
      _resetPhaseTimingForTests();
      const env = { SYNC_BLOCK_CENSUS_MIN_MS: raw } as NodeJS.ProcessEnv;
      recordPhaseDuration('yield-preempt@p', 300, 1_000, env, 'sync');
      expect(getSyncBlockCensus(env)).toMatchObject({ thresholdMs: 250, count: 1 });
    }
  });

  it('per-symbol slice labels collapse in byName so cardinality cannot explode', () => {
    // `<phase>#slice[AAPL..NVDA]` is unbounded in the symbol universe. The count
    // must stay whole while the KEY stays bounded.
    for (const [from, to] of [['AAPL', 'NVDA'], ['MSFT', 'AMD'], ['TSLA', 'INTC']]) {
      recordPhaseDuration(`signal.doTick.sweep#slice[${from}..${to}]`, 1_200, 1_000, process.env, 'sync');
    }
    recordPhaseDuration('signal.doTick.pacer#span[a..b]', 1_200, 1_000, process.env, 'sync');
    const c = getSyncBlockCensus();
    expect(c.count).toBe(4);
    expect(Object.keys(c.byName).sort()).toEqual([
      'signal.doTick.pacer#span[…]',
      'signal.doTick.sweep#slice[…]',
    ]);
    expect(c.byName['signal.doTick.sweep#slice[…]']).toMatchObject({ count: 3, maxMs: 1_200 });
    // The full name still survives on the max record — the range that blocked
    // is diagnostically useful even though the key is folded.
    expect(c.maxName).toContain('#slice[');
  });

  it('byName is capped and says so rather than silently dropping new names', () => {
    for (let i = 0; i < 80; i += 1) {
      recordPhaseDuration(`yield-preempt@phase-${i}`, 1_200, 1_000 + i, process.env, 'sync');
    }
    const c = getSyncBlockCensus();
    // The total is never lost, whatever happens to the per-name breakdown.
    expect(c.count).toBe(80);
    expect(Object.keys(c.byName).length).toBeLessThanOrEqual(64);
    expect(c.namesTruncated).toBeGreaterThan(0);
    expect(c.byName['__other__']!.count).toBe(c.namesTruncated);
  });

  it('the census is monotonic — a second read can only be >= the first (the trend property)', () => {
    recordPhaseDuration('yield-preempt@p', 1_400, 1_000, process.env, 'sync');
    const first = getSyncBlockCensus();
    recordPhaseDuration('yield-preempt@p', 300, 2_000, process.env, 'sync');
    const second = getSyncBlockCensus();
    expect(second.count).toBeGreaterThan(first.count);
    expect(second.maxMs).toBeGreaterThanOrEqual(first.maxMs); // the 300ms record must not lower it
    expect(second.firstAtMs).toBe(first.firstAtMs);
    expect(second.lastAtMs).toBe(2_000);
  });

  it('getPhaseAttribution carries the census, so /api/health/watchdog exposes it (AC1)', () => {
    recordPhaseDuration('yield-preempt@signal.doTick.equity-entry-sweep', 1_436, 1_000, process.env, 'sync');
    // Live JSON path: .watchdog.phaseAttribution.syncBlockCensus
    const attr = getPhaseAttribution();
    expect(attr.syncBlockCensus.count).toBe(1);
    expect(attr.syncBlockCensus.maxName).toBe('yield-preempt@signal.doTick.equity-entry-sweep');
  });
});
