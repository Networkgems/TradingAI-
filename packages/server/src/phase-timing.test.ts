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
    for (let i = 0; i < 20; i += 1) recordPhaseDuration(`phase-${i}`, 2_000, i);
    const { recentSlowPhases, lastSlowPhase } = getPhaseAttribution();
    expect(recentSlowPhases).toHaveLength(16);
    expect(recentSlowPhases[recentSlowPhases.length - 1]?.name).toBe('phase-19');
    expect(lastSlowPhase?.name).toBe('phase-19');
  });
});
