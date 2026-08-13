// TRA-3444 — guard the uncensored exit-work meter AND the bracket it is wired
// into.
//
// Two different things are asserted here, and the second is the one that
// actually protects TRA-2268's decision:
//
//   * the METER's arithmetic and its null discipline (a counter not yet taken
//     reports `null`, never 0 — TRA-1707);
//   * the BRACKET, derived from `signal-engine.ts` SOURCE. The meter can be
//     perfectly correct and still answer the wrong question if the bracket grows
//     to cover the reconciles that sit between the two exit passes. That failure
//     is silent, it is one careless edit away, and it fails in the EXPENSIVE
//     direction: a wider bracket UNDERSTATES prefix, which makes narrowing a
//     money-book interlock look cheaper than it is.
//
// The bracket assertions are written against the source rather than against
// behaviour because `doTick` cannot be driven in a unit test without a broker, a
// quote feed and 568 symbols — and a behavioural test that could be stood up
// would prove the bracket covers AT LEAST the two passes, never that it covers
// NOTHING ELSE. "Nothing else" is the load-bearing half.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TickExitWorkMeter } from './tick-exit-work.js';
import type { TickExitRegionBin } from './tick-exit-region.js';

/** TRA-3464 — this module's own source, for the "no second RTH test lives here" assertion. */
const METER_SRC = readFileSync(fileURLToPath(new URL('./tick-exit-work.ts', import.meta.url)), 'utf8');

/** A controllable clock, so a "duration" in these tests is an exact number and not a flake. */
function fakeClock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

describe('TRA-3444: the meter', () => {
  it('reports NULL before the first region commits — never a zero-filled object', () => {
    const meter = new TickExitWorkMeter(() => 0);
    expect(meter.snapshot()).toBeNull();

    // Still null with a region OPEN and work already measured: nothing has been
    // booked yet, and a partial region is not a sample.
    const c = fakeClock();
    const m2 = new TickExitWorkMeter(c.now);
    m2.beginRegion();
    m2.measure(() => { c.advance(400); });
    expect(m2.snapshot()).toBeNull();

    m2.commitRegion('rth');
    expect(m2.snapshot()).toEqual({ samples: 1, sumMs: 400, maxMs: 400 });
  });

  it('sums BOTH passes into one region sample and keeps the running max', () => {
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);

    meter.beginRegion();
    meter.measure(() => { c.advance(120); });          // equity pass
    c.advance(9_000);                                   // reconciles — PREFIX, not measured
    meter.measure(() => { c.advance(880); });          // options pass
    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 1_000, maxMs: 1_000 });

    // A quieter second region must not pull the max down.
    meter.beginRegion();
    meter.measure(() => { c.advance(50); });
    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 2, sumMs: 1_050, maxMs: 1_000 });
  });

  it('stamps through a THROW in a synchronous pass, and rethrows', () => {
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);
    meter.beginRegion();

    expect(() => meter.measure(() => {
      c.advance(700);
      throw new Error('checkExits blew up');
    })).toThrow('checkExits blew up');

    meter.commitRegion('rth');
    // Un-attributed, that 700ms would have silently become PREFIX.
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 700, maxMs: 700 });
  });

  it('stamps through a REJECTION in an async pass, and rethrows', async () => {
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);
    meter.beginRegion();

    await expect(meter.measureAsync(async () => {
      c.advance(2_500);
      throw new Error('submitStagedOptionExits blew up');
    })).rejects.toThrow('submitStagedOptionExits blew up');

    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 2_500, maxMs: 2_500 });
  });

  it('returns each pass\'s own value through the wrapper', async () => {
    const meter = new TickExitWorkMeter(() => 0);
    meter.beginRegion();
    expect(meter.measure(() => 'sync')).toBe('sync');
    await expect(meter.measureAsync(async () => 'async')).resolves.toBe('async');
  });

  it('books a 0ms sample for a region that threw before reaching either pass', () => {
    // That region really did spend ALL its time on prefix. Booking no sample at
    // all would drop it from the denominator and quietly flatter the exit-work
    // share; `samples` must stay 1:1 with `tickExitRegionMs.samples`.
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);
    meter.beginRegion();
    c.advance(31_000);
    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 0, maxMs: 0 });
  });

  it('is IDEMPOTENT on a second commit — doTick releases, then runTickGuarded releases again', () => {
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);
    meter.beginRegion();
    meter.measure(() => { c.advance(300); });
    meter.commitRegion('rth');
    meter.commitRegion('rth');
    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 300, maxMs: 300 });
  });

  it('DROPS work measured outside a region instead of carrying it into the next one', () => {
    // The decoupled `refreshExitsOnly` pass runs the same two containers OUTSIDE
    // the interlock. If that ever reached this meter, `sumMs` could exceed the
    // region time that contains it — overstating exit-critical work, which is
    // the direction that makes narrowing look cheap.
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);
    meter.measure(() => { c.advance(5_000); });
    meter.beginRegion();
    meter.measure(() => { c.advance(100); });
    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 100, maxMs: 100 });
  });

  it('never lets a backwards clock SUBTRACT exit-critical work', () => {
    let t = 0;
    const meter = new TickExitWorkMeter(() => t);
    meter.beginRegion();
    meter.measure(() => { t = -4_000; });   // NTP step / container migration
    meter.measure(() => { t += 600; });
    meter.commitRegion('rth');
    expect(meter.snapshot()).toEqual({ samples: 1, sumMs: 600, maxMs: 600 });
  });

  it('CONTAINMENT: sumMs never exceeds the region time that contains it', () => {
    // The invariant TRA-2268 reads the split against. Driven over a mixed run of
    // regions — some with both passes, some with one, some with none, one that
    // throws — with region time accumulated the way `releaseTickExitRegion`
    // accumulates it.
    const c = fakeClock();
    const meter = new TickExitWorkMeter(c.now);
    let regionSumMs = 0;
    const plan = [
      { prefix: 8_000, equity: 40, mid: 1_200, options: 3_000, throws: false },
      { prefix: 500, equity: 0, mid: 0, options: 0, throws: false },
      { prefix: 2_000, equity: 90, mid: 400, options: 12_000, throws: true },
      { prefix: 15_000, equity: 5, mid: 30, options: 60, throws: false },
    ];
    for (const p of plan) {
      const openedAt = c.now();
      meter.beginRegion();
      c.advance(p.prefix);
      if (p.equity > 0) meter.measure(() => { c.advance(p.equity); });
      c.advance(p.mid);
      if (p.options > 0) {
        try {
          meter.measure(() => {
            c.advance(p.options);
            if (p.throws) throw new Error('boom');
          });
        } catch { /* runTickGuarded swallows it; the region still closes */ }
      }
      regionSumMs += c.now() - openedAt;
      meter.commitRegion('rth');
    }

    const snap = meter.snapshot()!;
    expect(snap.samples).toBe(plan.length);
    expect(snap.sumMs).toBeLessThanOrEqual(regionSumMs);
    // And not vacuously: the meter measured real work, and PREFIX is the majority
    // here, which is the shape the 2026-08-12 tape could not confirm or deny.
    expect(snap.sumMs).toBe(40 + 3_000 + 90 + 12_000 + 5 + 60);
    expect(regionSumMs - snap.sumMs).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The bracket, derived from source.
// ---------------------------------------------------------------------------

const ENGINE_SRC = readFileSync(
  fileURLToPath(new URL('./signal-engine.ts', import.meta.url)),
  'utf8',
);

/** Body of a method, by brace matching from its signature. Throws rather than returning '' — an empty body would pass every assertion below. */
function methodBody(signature: string): string {
  const at = ENGINE_SRC.indexOf(signature);
  if (at < 0) throw new Error(`signal-engine.ts no longer contains \`${signature}\``);
  const open = ENGINE_SRC.indexOf('{', at + signature.length - 1);
  let depth = 0;
  for (let i = open; i < ENGINE_SRC.length; i += 1) {
    if (ENGINE_SRC[i] === '{') depth += 1;
    else if (ENGINE_SRC[i] === '}') {
      depth -= 1;
      if (depth === 0) return ENGINE_SRC.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces parsing \`${signature}\``);
}

/** The argument text of every `this.tickExitWork.measure(...)` / `.measureAsync(...)` in `src`, by paren matching. */
function bracketArgs(src: string): string[] {
  const out: string[] = [];
  for (const call of ['this.tickExitWork.measure(', 'this.tickExitWork.measureAsync(']) {
    let from = 0;
    for (;;) {
      const at = src.indexOf(call, from);
      if (at < 0) break;
      const open = at + call.length - 1;
      let depth = 0;
      let end = -1;
      for (let i = open; i < src.length; i += 1) {
        if (src[i] === '(') depth += 1;
        else if (src[i] === ')') {
          depth -= 1;
          if (depth === 0) { end = i; break; }
        }
      }
      if (end < 0) throw new Error(`unbalanced parens after ${call}`);
      out.push(src.slice(open + 1, end).trim());
      from = end;
    }
  }
  return out;
}

const DO_TICK = methodBody('private async doTick(): Promise<void>');
const REFRESH_EXITS_ONLY = methodBody('private async refreshExitsOnly(): Promise<void>');

const countOf = (hay: string, needle: string) => hay.split(needle).length - 1;

describe('TRA-3444: the bracket covers the two exit passes and NOTHING else', () => {
  it('parsed a real doTick (the positive control for this whole block)', () => {
    // Every assertion below is of the form "X is not inside a bracket". On an
    // empty or truncated parse they all pass for free. These floors are what
    // stops that.
    expect(DO_TICK.length).toBeGreaterThan(20_000);
    expect(DO_TICK).toContain('this.openTickExitRegion()');
    expect(DO_TICK).toContain('this.releaseTickExitRegion()');
    expect(REFRESH_EXITS_ONLY.length).toBeGreaterThan(200);
  });

  it('brackets EXACTLY runEquityExitPass and runOptionsExitPass', () => {
    expect(bracketArgs(DO_TICK)).toEqual([
      '() => this.runEquityExitPass(prices)',
      '() => this.runOptionsExitPass(prices, tickPacer)',
    ]);
  });

  it('leaves every OTHER in-region container outside the bracket', () => {
    // These are the phases `scripts/tra3443-exit-region-taxonomy.mjs` classes as
    // PREFIX. They sit between the two exit passes, so a bracket that spanned
    // from the equity pass to the options pass would swallow all of them — the
    // single most likely wrong way to write this, and it would report a region
    // that is almost entirely "exit-critical".
    const prefixInsideRegion = [
      'signal.doTick.reconcile-pending-closes',
      'signal.doTick.broker-position-drift',
      'signal.doTick.reconcile-live-portfolio',
      'signal.doTick.reconcile-live-equity',
      'signal.doTick.shadow-chases',
    ];
    for (const phase of prefixInsideRegion) {
      // Present in the region at all — otherwise the negative check is vacuous.
      expect(DO_TICK, `${phase} vanished from doTick`).toContain(phase);
      for (const arg of bracketArgs(DO_TICK)) {
        expect(arg, `${phase} is inside an exit-work bracket`).not.toContain(phase);
      }
    }
    // The tick-pacer yields are prefix too, and are the other easy way to widen
    // a bracket by accident.
    for (const arg of bracketArgs(DO_TICK)) {
      expect(arg).not.toContain('yieldToEventLoop');
      expect(arg).not.toContain('withPhase');
      expect(arg).not.toContain('await');
    }
  });

  it('wraps EVERY call to the two passes that doTick makes', () => {
    // One call each, and both accounted for by the bracket args above. A second,
    // unwrapped call would understate exit-critical work.
    expect(countOf(DO_TICK, 'this.runEquityExitPass(')).toBe(1);
    expect(countOf(DO_TICK, 'this.runOptionsExitPass(')).toBe(1);
    expect(countOf(DO_TICK, 'this.tickExitWork.measure(')).toBe(1);
    expect(countOf(DO_TICK, 'this.tickExitWork.measureAsync(')).toBe(1);
  });

  it('brackets sit INSIDE the interlock region', () => {
    const open = DO_TICK.indexOf('this.openTickExitRegion()');
    const release = DO_TICK.indexOf('this.releaseTickExitRegion()');
    const equity = DO_TICK.indexOf('this.tickExitWork.measure(');
    const options = DO_TICK.indexOf('this.tickExitWork.measureAsync(');
    expect(open).toBeGreaterThanOrEqual(0);
    expect(equity).toBeGreaterThan(open);
    expect(options).toBeGreaterThan(equity);
    expect(release).toBeGreaterThan(options);
  });

  it('does NOT measure the decoupled pass — that work is outside the interlock', () => {
    // `refreshExitsOnly` runs the same two containers off-tick. Accumulating it
    // would break containment (`exitWorkMs.sumMs <= tickExitRegionMs.sumMs`) and
    // overstate the exit-critical share.
    expect(REFRESH_EXITS_ONLY).toContain('this.runEquityExitPass(');
    expect(REFRESH_EXITS_ONLY).toContain('this.runOptionsExitPass(');
    expect(REFRESH_EXITS_ONLY).not.toContain('tickExitWork');
  });

  it('uses the meter in exactly six places, all of them named', () => {
    // Pins the whole surface: arm, two brackets, commit, and TWO reads (TRA-3464
    // added the RTH-scoped one). Anything else touching this meter is a change
    // to what the published number MEANS.
    expect(countOf(ENGINE_SRC, 'this.tickExitWork.')).toBe(6);
    expect(countOf(ENGINE_SRC, 'this.tickExitWork.beginRegion()')).toBe(1);
    expect(countOf(ENGINE_SRC, 'this.tickExitWork.commitRegion(bin)')).toBe(1);
    expect(countOf(ENGINE_SRC, 'this.tickExitWork.snapshot()')).toBe(1);
    expect(countOf(ENGINE_SRC, 'this.tickExitWork.rthSnapshot()')).toBe(1);
    // Armed and committed in lockstep with the flag+clock they split.
    expect(methodBody('private openTickExitRegion(): void')).toContain('this.tickExitWork.beginRegion()');
    expect(methodBody('private releaseTickExitRegion(): void')).toContain('this.tickExitWork.commitRegion(bin)');
  });

  it('commits the region sample and the exit-work sample under the SAME idempotency guard', () => {
    // `releaseTickExitRegion` returns early on a second release. If the commit
    // sat above that guard, `exitWorkMs.samples` would drift away from
    // `tickExitRegionMs.samples` and the two would stop describing one population.
    //
    // TRA-3464 — the guard MOVED into `TickExitRegionMeter.release()`, which
    // returns null on the second release. Same guard, one indirection out: the
    // engine now books nothing anywhere unless it got a bin back.
    const body = methodBody('private releaseTickExitRegion(): void');
    const release = body.indexOf('this.tickExitRegion.release()');
    const guard = body.indexOf('if (bin == null) return;');
    const commit = body.indexOf('this.tickExitWork.commitRegion(bin)');
    expect(release).toBeGreaterThanOrEqual(0);
    expect(guard).toBeGreaterThan(release);
    expect(commit).toBeGreaterThan(guard);
  });

  // TRA-3464 — TRA-2698 ordered that this accumulator inherit the region's RTH
  // predicate rather than carry its own. Two measurements of ONE region that
  // disagree about which regions count surface downstream as a phase split whose
  // parts do not reconcile with their own denominator (TRA-3443).
  //
  // These are the controls in BOTH directions: the RTH scope must be able to
  // publish a real split, to EXCLUDE what the region meter excluded, and to
  // refuse with `null` rather than a zero that reads like a measurement.
  describe('TRA-3464 — the RTH predicate is inherited, not re-derived', () => {
    const meterWith = (bins: readonly TickExitRegionBin[], msPerRegion: number) => {
      const c = fakeClock();
      const m = new TickExitWorkMeter(c.now);
      for (const bin of bins) {
        m.beginRegion();
        m.measure(() => { c.advance(msPerRegion); });
        m.commitRegion(bin);
      }
      return m;
    };

    it('books EVERY bin into lifetime and only `rth` into the RTH scope', () => {
      const m = meterWith(['boot', 'closed', 'rth', 'boundary', 'rth'], 100);
      // Lifetime counts all five — it is the denominator the region partition is
      // checked against, so it must not be shrunk by the bins that drop samples.
      expect(m.snapshot()).toEqual({ samples: 5, sumMs: 500, maxMs: 100 });
      expect(m.rthSnapshot()).toEqual({ samples: 2, sumMs: 200, maxMs: 100 });
    });

    it('REFUSES with null when no RTH region has committed, while lifetime answers', () => {
      // The post-close boot: the process measured real work, none of it in the
      // window. `{samples: 0, sumMs: 0}` here would be the TRA-2698 defect
      // rebuilt one field down — a book that measured nothing in the window
      // publishing numbers that read like a measurement.
      const m = meterWith(['boot', 'closed', 'closed'], 250);
      expect(m.snapshot()).toEqual({ samples: 3, sumMs: 750, maxMs: 250 });
      expect(m.rthSnapshot()).toBeNull();
    });

    it('keeps a SEPARATE max per scope, so a fat closed-market region cannot inflate the RTH max', () => {
      // The direction that matters: an overnight region is exactly the sample
      // that would set an unscoped max, and TRA-2268 reads the max.
      const c = fakeClock();
      const m = new TickExitWorkMeter(c.now);
      m.beginRegion(); m.measure(() => { c.advance(30_000); }); m.commitRegion('closed');
      m.beginRegion(); m.measure(() => { c.advance(700); }); m.commitRegion('rth');
      expect(m.snapshot()?.maxMs).toBe(30_000);
      expect(m.rthSnapshot()?.maxMs).toBe(700);
    });

    it('does not re-derive the bin — the ONLY RTH test reachable from here is the caller\'s argument', () => {
      // The structural half of "inherit the identical predicate". If this module
      // ever grows its own market-hours read, the two accumulators can disagree
      // about one region, which is the failure TRA-2698 ordered against.
      //
      // Asserted against CALL syntax, not the bare names: a doc comment that
      // explains WHY the predicate is inherited necessarily names it, and a
      // grader that fails on the explanation of its own rule is a grader that
      // gets deleted.
      expect(METER_SRC).not.toMatch(/isStockMarketOpen\s*\(/);
      expect(METER_SRC).not.toMatch(/classifyExitInterval\s*\(/);
      // And the engine hands over the SAME value it classified with, not a
      // recomputation: one `release()`, one `bin`, both consumers downstream.
      const body = methodBody('private releaseTickExitRegion(): void');
      expect(body).toContain('const bin = this.tickExitRegion.release();');
      expect(body).toContain('this.tickExitWork.commitRegion(bin);');
    });
  });
});
