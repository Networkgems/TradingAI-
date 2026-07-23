import { describe, it, expect, afterEach } from 'vitest';
import {
  timeSyncPhase,
  withPhase,
  getCurrentPhase,
  recordPhaseDuration,
  getPhaseAttribution,
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
