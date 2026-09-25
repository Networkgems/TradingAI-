// TRA-4920 (AC3) — the gate's margin to the 5s health-check budget is LINEAR IN
// N, N has grown, and nothing alarmed on it.
//
// TRA-4524 modelled N~11 co-resuming per-book engines at ~550ms each (harness:
// N=1 1070ms / N=4 2151 / N=8 4310 / N=12 6470 — linear). Measured
// `loopYieldGate.maxQueueDepth` on bqb1:
//
//   2026-09-25T02:31Z  (10 min into boot, off-RTH)  ->  3
//   2026-09-25T19:48Z  (RTH peak, 15.6h boot)       ->  19
//
// 19 is 73% past the modelled N. Unguarded, 19 x ~550ms ~ 10.5s — over TWICE
// the health-check budget. The gate is now load-bearing rather than
// defence-in-depth, and every alarm we had fires only AFTER a block ends
// (`lagMaxMs` is sampled by a timer that cannot run during the block; a watchdog
// trip is post-hoc by construction).
//
// So this file grades a PRE-block tripwire, and the property that actually
// matters is that it can read BOTH ways: an `ok` that cannot become a `page` is
// the same manufactured green this whole chain keeps hitting. Every level here
// is driven from the same real harness run with only the budget moved.
//
// The per-resume constant is MEASURED, not inherited from TRA-4524's harness —
// book count and per-book work have both moved. It is sampled at the run-end
// sentinel (a `node:timers` 0ms timeout fires only in the timers phase, so its
// elapsed IS the contiguous run the loop experienced) and divided by the waiters
// resumed inside that run.

import { describe, it, expect } from 'vitest';
import { LoopYieldGate, TickPacer, type GateHeadroom } from './cooperative-yield.js';

/** Hold the loop synchronously for ~ms (a real block, not a timer). */
function busyBlock(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* burn */ }
}

const BUDGET_MS = 60;
const CHUNK_MS = 2;
const WORK_PER_ENGINE_MS = 2 * BUDGET_MS;

interface HarnessOpts {
  n: number;
  blockBudgetMs: number;
  gateOn?: boolean;
}

/**
 * N per-book engines co-resumed off ONE shared await — the trip-#14 shape — all
 * pacing through the REAL process-wide gate primitive.
 */
async function runHarness(opts: HarnessOpts): Promise<{ gate: LoopYieldGate; escalations: GateHeadroom[] }> {
  const escalations: GateHeadroom[] = [];
  const gate = new LoopYieldGate({
    budgetMs: BUDGET_MS,
    blockBudgetMs: opts.blockBudgetMs,
    enabled: () => opts.gateOn ?? true,
    onHeadroomEscalation: (h) => { escalations.push(h); },
  });

  let release!: () => void;
  const released = new Promise<void>((r) => { release = r; });
  const engines = Array.from({ length: opts.n }, () => (async () => {
    const pacer = new TickPacer(undefined, { budgetMs: BUDGET_MS, gate });
    await released; // the shared settled await every engine is co-resumed from
    let done = 0;
    while (done < WORK_PER_ENGINE_MS) {
      busyBlock(CHUNK_MS);
      done += CHUNK_MS;
      if (pacer.shouldYield('chunk')) await pacer.yieldNow('chunk');
    }
  })());

  release();
  await Promise.all(engines);
  // Let the last run's sentinel fire so its measurement lands before we read.
  await new Promise<void>((r) => setTimeout(r, 5));
  return { gate, escalations };
}

describe('TRA-4920 — loop-yield-gate headroom (AC3)', () => {
  it('reads `unmeasured`, NOT `ok`, before any run has resumed a waiter', () => {
    // The whole point. A fresh gate has no per-resume constant, so it cannot
    // project anything — and "could not measure" must never share a reading
    // with "measured and fine". `ok` here would be a green that means nothing.
    const h = new LoopYieldGate({ blockBudgetMs: 5_000 }).headroom();
    expect(h.level).toBe('unmeasured');
    expect(h.perResumeMs).toBeNull();
    expect(h.perResumeSamples).toBe(0);
    expect(h.projectedBlockMs).toBeNull();
    expect(h.utilization).toBeNull();
    expect(h.reason).toContain('UNMEASURED');
  });

  it('a DISABLED gate reads `unmeasured` with its own reason — never `ok`', async () => {
    // LOOP_YIELD_GATE=0 restores the pre-TRA-4524 world: N x per-book runs
    // contiguous with nothing bounding them. That is the worst state the box can
    // be in, so it is the one reading that must not look clean.
    const { gate } = await runHarness({ n: 4, blockBudgetMs: 5_000, gateOn: false });
    const h = gate.headroom();
    expect(h.level).toBe('unmeasured');
    expect(h.reason).toContain('LOOP_YIELD_GATE=0');
    expect(h.reason).not.toContain('UNMEASURED'); // a DIFFERENT reason, distinguishable
  });

  it('measures the per-resume cost in-band, from the run-end sentinel', async () => {
    const { gate } = await runHarness({ n: 8, blockBudgetMs: 5_000 });
    const s = gate.snapshot();

    // The measurement exists and is self-consistent.
    expect(s.headroom.perResumeSamples).toBeGreaterThan(0);
    expect(s.headroom.perResumeMs).toBeGreaterThan(0);
    expect(s.resumesTotal).toBeGreaterThan(0);
    expect(s.runsCompleted).toBeGreaterThan(0);
    expect(s.maxResumesInRun).toBeGreaterThanOrEqual(1);

    // `maxRunCompletedMs` is a RUN LENGTH (sentinel, timers phase).
    // `maxRunObservedMs` is an observation range — it is stamped only inside
    // `slot()`, so it needs a waiter to have been queued already. They are
    // different quantities and the snapshot publishes both rather than
    // conflating them.
    expect(s.maxRunCompletedMs).toBeGreaterThan(0);
    expect(s.headroom.observedMaxRunMs).toBe(Math.round(s.maxRunCompletedMs));

    // A per-resume cost cannot exceed the longest run it was divided out of.
    expect(s.headroom.perResumeMs!).toBeLessThanOrEqual(s.maxRunCompletedMs + 1);

    // The projection is exactly maxQueueDepth x the measured constant — the
    // TRA-4524 linear-in-N mechanism, with the constant re-measured here rather
    // than inherited.
    expect(s.headroom.queueDepth).toBe(s.maxQueueDepth);
    expect(s.headroom.projectedBlockMs).toBe(Math.round(s.maxQueueDepth * s.headroom.perResumeMs!));
  });

  it('reads `ok` when the projection is a small fraction of the budget, and fires nothing', async () => {
    // The CONTROL for the two below: same harness, same code path, budget large
    // enough that the margin is real.
    const { gate, escalations } = await runHarness({ n: 8, blockBudgetMs: 10_000_000 });
    const h = gate.headroom();
    expect(h.level).toBe('ok');
    expect(h.utilization!).toBeLessThan(0.5);
    expect(escalations).toHaveLength(0);
  });

  it('escalates to `page` and fires the hook when the projection crosses 75% of the budget', async () => {
    // Same harness, same run, budget moved so a real co-resume burst projects
    // past the page line. If the `ok` control above and this one did not differ,
    // the tripwire would be unfalsifiable.
    const { gate, escalations } = await runHarness({ n: 8, blockBudgetMs: 10 });
    const h = gate.headroom();
    expect(h.level).toBe('page');
    expect(h.utilization!).toBeGreaterThanOrEqual(0.75);
    expect(escalations.length).toBeGreaterThan(0);
    expect(escalations[escalations.length - 1]!.level).toBe('page');
    // The reason carries the arithmetic, so a log line alone is actionable.
    expect(h.reason).toContain('health-check budget');
    expect(h.reason).toContain('maxQueueDepth');
  });

  it('fires once per UPWARD transition, not once per run', async () => {
    // A tripwire that logs every run is a tripwire nobody reads. This run
    // completes dozens of gate runs, every one of them over the page line, and
    // must still produce at most one `warn` and one `page`.
    const { gate, escalations } = await runHarness({ n: 8, blockBudgetMs: 10 });
    const levels = escalations.map((e) => e.level);
    expect(levels.length).toBeGreaterThan(0);
    expect(new Set(levels).size).toBe(levels.length); // no level reported twice
    const rank = { unmeasured: 0, ok: 1, warn: 2, page: 3 } as const;
    for (let i = 1; i < levels.length; i += 1) {
      expect(rank[levels[i]!]).toBeGreaterThan(rank[levels[i - 1]!]); // strictly up
    }
    // The non-vacuous half: many runs, few lines. Without the latch this would
    // be one escalation per completed run.
    expect(gate.snapshot().runsCompleted).toBeGreaterThan(levels.length * 3);
  });

  it('an ALREADY-OBSERVED long run cannot read `ok` just because the projection is low', async () => {
    // `utilization` is max(projected, observed). A box that has actually held
    // the loop for most of the health-check budget is not healthy on the grounds
    // that its queue happened to be shallow at the time — that reasoning is how
    // a post-hoc instrument talks itself into a green.
    const { gate } = await runHarness({ n: 1, blockBudgetMs: 5_000 });
    const s = gate.snapshot();
    const observed = s.headroom.observedUtilization;
    const projected = s.headroom.projectedUtilization!;
    expect(s.headroom.utilization).toBeCloseTo(Math.max(observed, projected), 3);
    expect(s.headroom.utilization!).toBeGreaterThanOrEqual(observed);
  });

  it('the snapshot still carries every TRA-4524 field (no reader is broken)', async () => {
    const { gate } = await runHarness({ n: 4, blockBudgetMs: 5_000 });
    expect(gate.snapshot()).toMatchObject({
      enabled: true,
      budgetMs: BUDGET_MS,
      runsStarted: expect.any(Number),
      deferrals: expect.any(Number),
      forcedYields: expect.any(Number),
      queueDepth: expect.any(Number),
      maxQueueDepth: expect.any(Number),
      maxHeldTurns: expect.any(Number),
      maxRunObservedMs: expect.any(Number),
    });
  });
});
