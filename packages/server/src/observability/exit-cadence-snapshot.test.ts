/**
 * TRA-2840 — the exit-cadence measurement must survive a restart.
 *
 * Each acceptance item from the ticket has a test below, named for it. The
 * point of the whole exercise is that the number stops depending on an agent
 * winning a race against a deploy, so the tests are about DURABILITY and
 * HONEST PARTIALS, not about the cadence arithmetic itself.
 */
import { describe, it, expect } from 'vitest';
import {
  EXIT_CADENCE_SNAPSHOT_MARKER,
  EXIT_CADENCE_NOT_DIFFERENCEABLE,
  RTH_OPEN_UTC_MIN,
  RTH_CLOSE_UTC_MIN,
  buildExitCadenceSnapshotLine,
  dueExitCadenceMark,
  recordExitCadenceMark,
  etSessionDate,
  type ExitCadenceEmitState,
} from './exit-cadence-snapshot.js';
import type { ExitCadenceRollup } from './health-routes.js';

const FRESH: ExitCadenceEmitState = { lastT0Session: null, lastT1Session: null };

/** A minimal rollup shaped like the real one; only the fields under test matter. */
const rollup = (samples: number, atOrAbove30s: number, maxMs = 41_000): ExitCadenceRollup =>
  ({
    partitionedBy: 'mode',
    engineCount: 3,
    liveEngineCount: 1,
    demoEngineCount: 2,
    unknownModeEngineCount: 0,
    liveArmedEngineCount: 1,
    decoupledSkips: 0,
    tickExitRegionMs: { samples, atOrAbove20s: atOrAbove30s * 2, atOrAbove30s, maxMs },
    books: {
      live: {
        blind: false, blindReason: null, verdict: 'pass', gradeable: true,
        notGradeableReason: null,
        tickExitRegionMs: { samples, atOrAbove20s: atOrAbove30s * 2, atOrAbove30s, maxMs },
      },
      demo: {
        blind: false, blindReason: null, verdict: 'pass', gradeable: true,
        notGradeableReason: null,
        tickExitRegionMs: { samples: 0, atOrAbove20s: 0, atOrAbove30s: 0, maxMs: 0 },
      },
    },
  }) as unknown as ExitCadenceRollup;

const at = (iso: string) => Date.parse(iso);

describe('TRA-2840 — scheduling: a line is emitted even when conditions are not ideal', () => {
  it('emits T0 at the open and T1 at the close, once each per session', () => {
    let s = FRESH;
    expect(dueExitCadenceMark(at('2026-08-05T13:29:00Z'), s)).toBeNull();

    expect(dueExitCadenceMark(at('2026-08-05T13:30:00Z'), s)).toBe('T0-open');
    s = recordExitCadenceMark(s, 'T0-open', '2026-08-05');
    expect(dueExitCadenceMark(at('2026-08-05T13:31:00Z'), s)).toBeNull();
    expect(dueExitCadenceMark(at('2026-08-05T19:59:00Z'), s)).toBeNull();

    expect(dueExitCadenceMark(at('2026-08-05T20:00:00Z'), s)).toBe('T1-close');
    s = recordExitCadenceMark(s, 'T1-close', '2026-08-05');
    expect(dueExitCadenceMark(at('2026-08-05T20:01:00Z'), s)).toBeNull();
    expect(dueExitCadenceMark(at('2026-08-05T23:00:00Z'), s)).toBeNull();
  });

  it('the NEXT session re-arms both marks', () => {
    let s = recordExitCadenceMark(FRESH, 'T0-open', '2026-08-05');
    s = recordExitCadenceMark(s, 'T1-close', '2026-08-05');
    expect(dueExitCadenceMark(at('2026-08-06T13:30:00Z'), s)).toBe('T0-open');
  });

  it('AC4 — a process that boots mid-morning still emits T0 immediately', () => {
    // The old arrangement lost the whole session here. A poll re-derives what is
    // due from the wall clock, so a 15:00Z boot emits T0 on its first tick.
    expect(dueExitCadenceMark(at('2026-08-05T15:00:00Z'), FRESH)).toBe('T0-open');
  });

  it('a process that boots AFTER the close emits T1, not a misleading T0', () => {
    expect(dueExitCadenceMark(at('2026-08-05T20:37:49Z'), FRESH)).toBe('T1-close');
  });

  it('a missed T0 does not suppress T1 — the marks are independent', () => {
    // The 2026-08-04 shape: nothing read the open, and the close still matters.
    const s = { lastT0Session: null, lastT1Session: null };
    expect(dueExitCadenceMark(at('2026-08-05T20:00:00Z'), s)).toBe('T1-close');
  });

  it('pins the RTH boundaries in UTC', () => {
    expect(RTH_OPEN_UTC_MIN).toBe(13 * 60 + 30);
    expect(RTH_CLOSE_UTC_MIN).toBe(20 * 60);
  });
});

describe('TRA-2840 — the line itself', () => {
  const build = {
    commit: '58c47967f1bff6ae952ff763adc046158be3c5b7',
    startedAt: '2026-08-05T08:49:23.848Z',
    pid: 76,
  };

  it('AC2 — carries startedAt AND pid, so a consumer can refuse to difference across a restart', () => {
    const t0 = buildExitCadenceSnapshotLine({
      mark: 'T0-open', nowMs: at('2026-08-05T13:30:00Z'),
      bootedAtMs: at('2026-08-05T08:49:23.848Z'), build, rollup: rollup(100, 2),
    });
    const t1 = buildExitCadenceSnapshotLine({
      mark: 'T1-close', nowMs: at('2026-08-05T20:00:00Z'),
      bootedAtMs: at('2026-08-05T08:49:23.848Z'), build, rollup: rollup(940, 31),
    });

    for (const l of [t0, t1]) {
      expect(l.process.startedAt).toBe('2026-08-05T08:49:23.848Z');
      expect(l.process.pid).toBe(76);
      expect(l.process.commit).toBe(build.commit);
    }

    // Same process -> the pair is differenceable, and AC1's number falls out.
    expect(t1.process.startedAt).toBe(t0.process.startedAt);
    expect(t1.process.pid).toBe(t0.process.pid);
    expect(t1.rollup.books.live.tickExitRegionMs!.atOrAbove30s
      - t0.rollup.books.live.tickExitRegionMs!.atOrAbove30s).toBe(29);
    expect(t1.rollup.books.live.tickExitRegionMs!.samples
      - t0.rollup.books.live.tickExitRegionMs!.samples).toBe(840);
  });

  it('AC2 — a restart between the marks is detectable FROM THE LINES ALONE', () => {
    // T0 is late in a long-lived process, so its counters are already high.
    const t0 = buildExitCadenceSnapshotLine({
      mark: 'T0-open', nowMs: at('2026-08-05T13:30:00Z'),
      bootedAtMs: at('2026-08-05T08:49:23.848Z'), build, rollup: rollup(820, 31),
    });
    // Then the process is replaced mid-session and its counters restart from
    // near zero. 14 deploys landed after the close on 2026-08-04; this is that
    // world, and it is why a naive difference must not be trusted.
    const t1 = buildExitCadenceSnapshotLine({
      mark: 'T1-close', nowMs: at('2026-08-05T20:00:00Z'),
      bootedAtMs: at('2026-08-05T16:20:00.000Z'),
      build: { ...build, startedAt: '2026-08-05T16:20:00.000Z', pid: 81 },
      rollup: rollup(310, 4),
    });

    const sameProcess =
      t1.process.startedAt === t0.process.startedAt && t1.process.pid === t0.process.pid;
    expect(sameProcess).toBe(false);
    // The naive difference reads -27, which is impossible for a monotonic
    // counter -- but a consumer that only checked "did it go up" would have
    // read a plausible-looking small number on a smaller restart. The
    // startedAt/pid disagreement is what makes it unambiguous. The
    // consumer must call this BLIND, and it has what it needs to.
    expect(t1.rollup.books.live.tickExitRegionMs!.atOrAbove30s
      - t0.rollup.books.live.tickExitRegionMs!.atOrAbove30s).toBeLessThan(0);
  });

  it('AC4 — a T0 from a process that booted after the open is flagged PARTIAL', () => {
    const line = buildExitCadenceSnapshotLine({
      mark: 'T0-open', nowMs: at('2026-08-05T15:00:00Z'),
      bootedAtMs: at('2026-08-05T14:30:00Z'), build, rollup: rollup(40, 1),
    });
    expect(line.partialWindow).toBe(true);
    expect(line.missedOpenMinutes).toBe(60); // 13:30Z -> 14:30Z
  });

  it('AC4 — a process that predates the open is NOT partial', () => {
    const line = buildExitCadenceSnapshotLine({
      mark: 'T0-open', nowMs: at('2026-08-05T13:30:00Z'),
      bootedAtMs: at('2026-08-05T08:49:23.848Z'), build, rollup: rollup(0, 0),
    });
    expect(line.partialWindow).toBe(false);
    expect(line.missedOpenMinutes).toBe(0);
  });

  it('AC3 — maxMs is stamped on both lines and declared not-differenceable ON the line', () => {
    const line = buildExitCadenceSnapshotLine({
      mark: 'T1-close', nowMs: at('2026-08-05T20:00:00Z'),
      bootedAtMs: at('2026-08-05T08:49:23.848Z'), build, rollup: rollup(940, 31, 52_310),
    });
    expect(line.rollup.books.live.tickExitRegionMs!.maxMs).toBe(52_310);
    expect(line.notDifferenceable).toContain('books.live.tickExitRegionMs.maxMs');
    expect(line.notDifferenceable).toContain('tickExitRegionMs.maxMs');
    expect(EXIT_CADENCE_NOT_DIFFERENCEABLE).toContain('books.demo.tickExitRegionMs.maxMs');
  });

  it('carries a marker Render text= can match, and an ET session date', () => {
    const line = buildExitCadenceSnapshotLine({
      mark: 'T1-close', nowMs: at('2026-08-05T20:00:00Z'),
      bootedAtMs: at('2026-08-05T08:49:23.848Z'), build, rollup: rollup(1, 0),
    });
    expect(line.marker).toBe(EXIT_CADENCE_SNAPSHOT_MARKER);
    // Built from substrings MEASURED to match on this service.
    expect(EXIT_CADENCE_SNAPSHOT_MARKER).toContain('cadence');
    expect(EXIT_CADENCE_SNAPSHOT_MARKER).toContain('exit-cadence');
    expect(line.ticket).toBe('TRA-2840');
    // 20:00Z is 16:00 ET — still the same session date, not the next day.
    expect(line.session).toBe('2026-08-05');
  });

  it('handles a missing build identity without throwing (BLIND, not a fake pass)', () => {
    const line = buildExitCadenceSnapshotLine({
      mark: 'T0-open', nowMs: at('2026-08-05T13:30:00Z'),
      bootedAtMs: null, build: { commit: null }, rollup: rollup(0, 0),
    });
    expect(line.process).toEqual({ startedAt: null, pid: null, commit: null });
    expect(line.partialWindow).toBe(false);
  });

  it('etSessionDate resolves ET, not UTC, across the evening boundary', () => {
    // 2026-08-06T01:00Z is 21:00 ET on 08-05 — the 21:00 ET archive instant.
    expect(etSessionDate(at('2026-08-06T01:00:00Z'))).toBe('2026-08-05');
    expect(etSessionDate(at('2026-08-05T20:00:00Z'))).toBe('2026-08-05');
  });
});
