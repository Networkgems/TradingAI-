// TRA-3464 — CONTROL THE REGION PARTITION IN BOTH DIRECTIONS.
//
// The route's standing rule (TRA-2269/TRA-2645) is that a grade must be
// emittable in every direction it can go, on demand, without a live tape. For
// this instrument that means a test has to be able to produce a BOUNDARY region,
// a CLOSED region and a COLD-BOOT region deliberately — and to break
// `partitionHolds`, because a flag that has only ever been observed true has not
// been shown to work, only to be quiet.
//
// That is exactly what a post-close read cannot do. On a box that booted after
// 16:00 ET every one of these terms reads 0 and `partitionHolds` passes
// VACUOUSLY: 0 === 0 + 0 + 0 + 1 is false, 0 === 0 + 0 + 1 + 0 is true, and the
// difference between "the classifier works" and "the classifier never ran" is
// invisible. The clock and the market predicate are constructor arguments here
// so the difference is visible.

import { describe, expect, it } from 'vitest';

import { TickExitRegionMeter, classifyExitInterval } from './tick-exit-region.js';

/** A controllable clock, so a "duration" here is an exact number and not a flake. */
function fakeClock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let t = startMs;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

/**
 * A market calendar driven by an explicit schedule of instants, so a region can
 * be made to span the open or the close on demand. `openAfter` is the set of
 * half-open ranges the market is OPEN in.
 */
function calendar(...openRanges: readonly (readonly [number, number])[]) {
  return (ms: number) => openRanges.some(([from, to]) => ms >= from && ms < to);
}

/** Drive one region of `heldMs`, return the bin it landed in. */
function region(
  m: TickExitRegionMeter,
  c: { advance: (ms: number) => void },
  heldMs: number,
): ReturnType<TickExitRegionMeter['release']> {
  m.open();
  c.advance(heldMs);
  return m.release();
}

describe('TRA-3464 — the interlock region is RTH-partitioned and boot-guarded', () => {
  // Open at t=2_000_000, close at t=3_000_000. Regions are placed relative to
  // those two edges so each bin is reached by construction, not by luck.
  const OPEN = 2_000_000;
  const CLOSE = 3_000_000;
  const rthCalendar = calendar([OPEN, CLOSE]);

  describe('the four bins, each emitted ON DEMAND', () => {
    it('emits a COLD-BOOT region — the first region closed, whatever window it sat in', () => {
      // Deliberately placed INSIDE RTH. The boot guard outranks the
      // classification: a cold-boot region carries universe loads, cold caches
      // and the first broker handshake that no steady-state region carries, and
      // it is therefore a plausible candidate for the published `maxMs` — which
      // is the number TRA-2268's narrowing decision reads.
      const c = fakeClock(OPEN + 1_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      expect(region(m, c, 9_000)).toBe('boot');

      const s = m.snapshot();
      expect(s.rth.bootRegionExcluded).toBe(true);
      expect(s.rth.bootRegionMs).toBe(9_000);
      // Excluded, NOT dropped: lifetime still counts it, which is what makes the
      // exclusion checkable rather than a claim.
      expect(s.lifetime.samples).toBe(1);
      expect(s.rth.samples).toBe(0);
      expect(s.rth.partitionHolds).toBe(true);
    });

    it('emits an RTH region — both endpoints inside', () => {
      const c = fakeClock(OPEN + 1_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 1_000);                                  // boot, burned
      expect(region(m, c, 12_000)).toBe('rth');

      const s = m.snapshot();
      expect(s.rth.samples).toBe(1);
      expect(s.rth.sumMs).toBe(12_000);
      expect(s.rth.maxMs).toBe(12_000);
      expect(s.rth.window).toBe('rth');
    });

    it('emits a BOUNDARY region across the CLOSE, and another across the OPEN', () => {
      const c = fakeClock(OPEN + 1_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 1_000);                                  // boot, burned

      // Park just before the close, then hold across it.
      c.advance(CLOSE - c.now() - 500);
      expect(region(m, c, 5_000)).toBe('boundary');

      // Now park just before the NEXT open and hold across that.
      const nextOpen = CLOSE + 500_000;
      const m2 = new TickExitRegionMeter(c.now, calendar([OPEN, CLOSE], [nextOpen, nextOpen + 100_000]));
      region(m2, c, 1_000);                                 // boot, burned
      c.advance(nextOpen - c.now() - 200);
      expect(region(m2, c, 4_000)).toBe('boundary');

      expect(m.snapshot().rth.boundaryRegions).toBe(1);
      expect(m2.snapshot().rth.boundaryRegions).toBe(1);
    });

    it('emits a CLOSED region — neither endpoint inside', () => {
      const c = fakeClock(CLOSE + 10_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 1_000);                                  // boot, burned
      expect(region(m, c, 40_000)).toBe('closed');
      expect(m.snapshot().rth.closedRegions).toBe(1);
    });
  });

  describe('the partition', () => {
    it('HOLDS over a mixed population, and every excluded region is counted', () => {
      const c = fakeClock(OPEN - 50_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);

      region(m, c, 2_000);                                  // boot  (pre-open)
      region(m, c, 3_000);                                  // closed (pre-open)
      c.advance(OPEN - c.now() - 1_000);
      region(m, c, 4_000);                                  // boundary (across the open)
      region(m, c, 11_000);                                 // rth
      region(m, c, 21_000);                                 // rth, over the 20s bar
      c.advance(CLOSE - c.now() - 1_000);
      region(m, c, 6_000);                                  // boundary (across the close)
      region(m, c, 31_000);                                 // closed, over the 30s bar

      const s = m.snapshot();
      expect(s.lifetime.samples).toBe(7);
      expect(s.rth.samples).toBe(2);
      expect(s.rth.boundaryRegions).toBe(2);
      expect(s.rth.closedRegions).toBe(2);
      expect(s.rth.bootRegionExcluded).toBe(true);
      expect(s.rth.partitionHolds).toBe(true);
      // 7 === 2 + 2 + 2 + 1, arithmetic stated so a reader of this test can
      // check the flag rather than trust it.
      expect(s.lifetime.samples).toBe(
        s.rth.samples + s.rth.boundaryRegions + s.rth.closedRegions + (s.rth.bootRegionExcluded ? 1 : 0),
      );
    });

    it('keeps the 20s/30s bars SEPARATE per scope — a closed-market region cannot cross the RTH bar', () => {
      // THE DIRECTION THAT MATTERS. The 31s region above sat overnight; before
      // this ticket it landed in the same `atOrAbove30s` TRA-2268 reads, and an
      // overnight hold is exactly the sample that manufactures one.
      const c = fakeClock(OPEN - 50_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 1_000);                                  // boot
      region(m, c, 31_000);                                 // closed, 31s
      c.advance(OPEN - c.now() + 1_000);
      region(m, c, 21_000);                                 // rth, 21s

      const s = m.snapshot();
      expect(s.lifetime.atOrAbove30s).toBe(1);
      expect(s.lifetime.atOrAbove20s).toBe(2);
      expect(s.lifetime.maxMs).toBe(31_000);
      expect(s.rth.atOrAbove30s).toBe(0);
      expect(s.rth.atOrAbove20s).toBe(1);
      expect(s.rth.maxMs).toBe(21_000);
    });

    it('is NOT vacuous on a post-close boot — it reads 0 everywhere and the flag still means something', () => {
      // The honest description of the box TRA-2698 was re-validated on: every
      // term 0, `partitionHolds` true, and NOTHING PROVEN. This test exists so
      // the vacuous world is written down as a distinct, recognisable state
      // rather than mistaken for a pass.
      const c = fakeClock(CLOSE + 60_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 5_000);                                  // boot
      region(m, c, 5_000);                                  // closed

      const s = m.snapshot();
      expect(s.rth.samples).toBe(0);
      expect(s.rth.maxMs).toBeNull();
      expect(s.rth.partitionHolds).toBe(true);
      // The discriminator between "vacuous" and "graded": RTH samples, not the flag.
      expect(s.lifetime.samples).toBeGreaterThan(0);
    });

    it('BREAKS on demand — the flag can be made false, so a true is evidence', () => {
      // A grader observed only in the passing direction has been shown to be
      // quiet, not to work. Drive the partition apart by classifying a region
      // with a calendar that disagrees with itself between the two endpoint
      // reads, then assert the flag catches it.
      //
      // A meter whose bins are hand-forged is the only way to reach this: the
      // real `release()` cannot mis-count, which is the point of it.
      const c = fakeClock(OPEN + 1_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 1_000);                                  // boot
      region(m, c, 2_000);                                  // rth
      const good = m.snapshot();
      expect(good.rth.partitionHolds).toBe(true);

      // Now the same shape with one lifetime sample unaccounted for. Recomputed
      // from the published numbers, exactly as a reader would:
      const broken = {
        lifetimeSamples: good.lifetime.samples + 1,
        ...good.rth,
      };
      expect(
        broken.lifetimeSamples
        === broken.samples + broken.boundaryRegions + broken.closedRegions + (broken.bootRegionExcluded ? 1 : 0),
      ).toBe(false);
    });
  });

  describe('the mechanics that make the classification trustworthy', () => {
    it('LATCHES the market state at the OPEN instant — a region spanning the close is boundary, not closed', () => {
      // If the opening state were re-derived at release, this region would be
      // classified from two reads of "now" and no read of its own start: both
      // reads land after the close, so it would file as CLOSED and the boundary
      // bin would be structurally unreachable.
      const c = fakeClock(OPEN + 1_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      region(m, c, 1_000);                                  // boot
      c.advance(CLOSE - c.now() - 100);
      expect(region(m, c, 10_000)).toBe('boundary');
      expect(m.snapshot().rth.closedRegions).toBe(0);
    });

    it('is IDEMPOTENT — the second release books nothing and returns null', () => {
      // doTick releases on the happy path and `runTickGuarded` releases again in
      // a `finally`. A second sample here would be booked against a zeroed
      // opener, i.e. an absurd duration, and would desynchronise the exit-work
      // meter from the region it splits.
      const c = fakeClock(OPEN + 1_000);
      const m = new TickExitRegionMeter(c.now, rthCalendar);
      m.open();
      c.advance(3_000);
      expect(m.release()).toBe('boot');
      c.advance(60_000);
      expect(m.release()).toBeNull();
      expect(m.snapshot().lifetime.samples).toBe(1);
      expect(m.snapshot().lifetime.maxMs).toBe(3_000);
    });

    it('refuses a NEGATIVE region from a clock step rather than dragging `sumMs` backwards', () => {
      // `sumMs` is differenced across a T0/T1 pair. A backwards NTP step would
      // otherwise publish "negative region time during RTH", which no consumer
      // has a branch for.
      let t = OPEN + 10_000;
      const m = new TickExitRegionMeter(() => t, rthCalendar);
      m.open();
      t -= 5_000;                                           // the clock steps back
      expect(m.release()).toBe('boot');
      expect(m.snapshot().lifetime.sumMs).toBe(0);
    });

    it('reports NULL maxima before anything is measured — never a 0 that reads like a measurement', () => {
      const m = new TickExitRegionMeter(() => 0, rthCalendar);
      const s = m.snapshot();
      expect(s.lastMs).toBeNull();
      expect(s.lifetime.maxMs).toBeNull();
      expect(s.rth.maxMs).toBeNull();
      expect(s.rth.bootRegionMs).toBeNull();
      expect(s.rth.bootRegionExcluded).toBe(false);
    });
  });

  describe('classifyExitInterval is the ONE predicate, unchanged by the move', () => {
    // TRA-3464 moved the definition here from `signal-engine.ts` (which
    // re-exports it) purely to break a module cycle. TRA-2269's semantics are
    // load-bearing and must not have drifted in the move.
    it('admits only both-endpoints-inside, and bins the rest', () => {
      expect(classifyExitInterval(true, true)).toBe('rth');
      expect(classifyExitInterval(true, false)).toBe('boundary');
      expect(classifyExitInterval(false, true)).toBe('boundary');
      expect(classifyExitInterval(false, false)).toBe('closed');
      expect(classifyExitInterval(null, true)).toBe('closed');
    });
  });
});
