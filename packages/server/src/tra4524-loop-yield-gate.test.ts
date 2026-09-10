// TRA-4524 (TRA-3660 trip #14) — per-engine pacer budgets SUM across
// co-resumed engines; the process-wide yield gate bounds the loop.
//
// Trip #14 (2026-09-10T16:43:42Z, lagMax 6694ms): ~11 per-book engines were
// released by one shared await, each ran its own ~550ms budget, and every
// `setImmediate` they queued fired only after the last one finished — one 6.1s
// block. This file is the AC1 fixture. It drives the REAL TickPacer through
// the REAL gate at test-sized budgets. The CONTROL is the same classes with the
// gate switched off (`LOOP_YIELD_GATE=0`), i.e. today's per-engine primitive. A
// fix whose control does not reproduce the linear-in-N lag is vacuous, so the
// control is asserted to FAIL the bound before the gate is asserted to pass it.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LoopYieldGate,
  TickPacer,
  EvalYielder,
  type LoopYieldGateSnapshot,
} from './cooperative-yield.js';
import { SyncSliceMeter, getPhaseAttribution, _resetPhaseTimingForTests } from './phase-timing.js';

/** Hold the loop synchronously for ~ms (a real block, not a timer). */
function busyBlock(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* burn */ }
}

// Harness scale. Production is BUDGET 500 / ~60ms regions; the test keeps the
// same shape at 1/5 of the budget with fine-grained chunks, so the gate's
// residual (one chunk per co-resumed engine) stays well inside the bound.
const BUDGET_MS = 100;
const CHUNK_MS = 2;
const WORK_PER_ENGINE_MS = 2 * BUDGET_MS;
// AC1: "~1.5x budget". The gate's worst case here is one budget plus one chunk
// per co-resumed engine (~114ms at N=8); the control is N x budget (~816ms).
const BOUND_MS = 1.5 * BUDGET_MS;

interface HarnessRun {
  maxLagMs: number;
  /** Engine id appended at the start of every resumed segment of work. */
  order: number[];
  gate: LoopYieldGateSnapshot;
}

async function runHarness(n: number, gateOn: boolean): Promise<HarnessRun> {
  const gate = new LoopYieldGate({ budgetMs: BUDGET_MS, enabled: () => gateOn });

  // Loop-lag probe: a 1ms timer chain. A timer can only fire in the timers
  // phase, so its lateness is the longest stretch the loop could not turn.
  let maxLagMs = 0;
  let stop = false;
  const probe = (): void => {
    const armedAt = Date.now();
    setTimeout(() => {
      const lag = Date.now() - armedAt - 1;
      if (lag > maxLagMs) maxLagMs = lag;
      if (!stop) probe();
    }, 1);
  };
  probe();

  let release!: () => void;
  const released = new Promise<void>(r => { release = r; });
  const order: number[] = [];
  const engines = Array.from({ length: n }, (_, id) => (async () => {
    const pacer = new TickPacer(undefined, { budgetMs: BUDGET_MS, gate });
    await released; // the shared await every engine is co-resumed from
    order.push(id);
    let done = 0;
    while (done < WORK_PER_ENGINE_MS) {
      busyBlock(CHUNK_MS);
      done += CHUNK_MS;
      if (pacer.shouldYield('chunk')) {
        await pacer.yieldNow('chunk');
        order.push(id);
      }
    }
  })());

  await new Promise(r => setTimeout(r, 5));
  release();
  await Promise.all(engines);
  stop = true;
  await new Promise(r => setTimeout(r, 5)); // let the probe chain retire
  return { maxLagMs, order, gate: gate.snapshot() };
}

beforeEach(() => {
  _resetPhaseTimingForTests();
});

describe('AC1 — the harness reproduces the linear-in-N sum, and the gate bounds it', () => {
  it('CONTROL (per-engine budgets, gate off) FAILS the bound at N=8 and grows with N', async () => {
    const one = await runHarness(1, false);
    const eight = await runHarness(8, false);
    // The control must reproduce, or the fix below proves nothing.
    expect(eight.maxLagMs).toBeGreaterThan(BOUND_MS);
    // Linear, not a constant offset: N=8 sits well above several single-engine blocks.
    expect(eight.maxLagMs).toBeGreaterThan(4 * one.maxLagMs);
    expect(eight.gate.deferrals).toBe(0);
  }, 30_000);

  it('GATE ON passes the bound at N=8 and N=12 (flat in N)', async () => {
    const eight = await runHarness(8, true);
    const twelve = await runHarness(12, true);
    expect(eight.maxLagMs).toBeLessThan(BOUND_MS);
    expect(twelve.maxLagMs).toBeLessThan(BOUND_MS);
    // The mechanism actually engaged (not a lucky schedule).
    expect(eight.gate.deferrals).toBeGreaterThan(0);
    expect(eight.gate.forcedYields).toBeGreaterThan(0);
  }, 30_000);

  it('single engine: never held behind anyone, and never worse than the control', async () => {
    const control = await runHarness(1, false);
    const gated = await runHarness(1, true);
    // A lone engine is never queued behind a sibling.
    expect(gated.gate.maxHeldTurns).toBe(0);
    // It can be deferred at most ONCE: the release runs in the timers phase, and
    // today that run chains straight into the check phase (2x budget, the N=1
    // row of the trip-#14 harness: 1070ms on a 500ms budget). The gate makes it
    // wait one loop turn instead. Every later yield resumes into a fresh run.
    expect(gated.gate.deferrals).toBeLessThanOrEqual(1);
    expect(gated.maxLagMs).toBeLessThan(BOUND_MS);
    expect(gated.maxLagMs).toBeLessThanOrEqual(control.maxLagMs + 30);
  }, 30_000);
});

describe('AC3 — no starvation: the gate is round-robin', () => {
  it('every engine progresses each round; no engine waits behind more than N-1 siblings', async () => {
    const n = 6;
    const run = await runHarness(n, true);
    const segments = new Map<number, number>();
    for (const id of run.order) segments.set(id, (segments.get(id) ?? 0) + 1);
    // All engines ran and finished (runHarness awaited every one).
    expect(segments.size).toBe(n);
    // Between two consecutive segments of the same engine, count the others.
    const last = new Map<number, number>();
    let worstGap = 0;
    run.order.forEach((id, i) => {
      const prev = last.get(id);
      if (prev !== undefined) worstGap = Math.max(worstGap, i - prev - 1);
      last.set(id, i);
    });
    expect(worstGap).toBeLessThanOrEqual(n - 1);
    expect(run.gate.maxHeldTurns).toBeLessThanOrEqual(n - 1);
  }, 30_000);
});

describe('AC2 — the gate primitive', () => {
  it('a resume into a spent run re-yields to the NEXT loop iteration: timers run in between', async () => {
    const run = async (gateOn: boolean): Promise<string[]> => {
      const gate = new LoopYieldGate({ budgetMs: 30, enabled: () => gateOn });
      const events: string[] = [];
      const a = gate.yieldTurn().then(() => {
        events.push('A');
        setTimeout(() => events.push('timer'), 0);
        busyBlock(40); // spends the run
      });
      const b = gate.yieldTurn().then(() => { events.push('B'); });
      await Promise.all([a, b]);
      await new Promise(r => setTimeout(r, 10));
      return events;
    };
    // Control: both immediates run in ONE check phase; the timer waits for both.
    expect(await run(false)).toEqual(['A', 'B', 'timer']);
    // Gate: B's resume is deferred, so the timers phase runs before it.
    expect(await run(true)).toEqual(['A', 'timer', 'B']);
  });

  it('shouldYield is process-aware: a fresh pacer co-resumed into a spent run yields at its first boundary', () => {
    const gate = new LoopYieldGate({ budgetMs: 30, enabled: () => true });
    const a = new TickPacer(undefined, { budgetMs: 30, gate });
    const b = new EvalYielder(undefined, { budgetMs: 30, gate, countFloor: false });
    expect(a.shouldYield('x')).toBe(false); // opens the run
    busyBlock(40);
    // b was constructed at the run's start, but its own clock is what legacy
    // code consulted; the run is what the loop actually saw.
    const fresh = new TickPacer(undefined, { budgetMs: 30, gate });
    expect(fresh.shouldYield('y')).toBe(true);
    expect(b.shouldYield(1, 'z')).toBe(true);
    expect(gate.snapshot().forcedYields).toBe(1); // fresh (b's own clock was also over)
  });

  it('kill switch: LOOP_YIELD_GATE off restores the per-yielder behaviour exactly', () => {
    const gate = new LoopYieldGate({ budgetMs: 30, enabled: () => false });
    expect(gate.observe(Date.now())).toBe(0);
    busyBlock(40);
    const fresh = new TickPacer(undefined, { budgetMs: 30, gate });
    expect(fresh.shouldYield('y')).toBe(false);
    expect(gate.snapshot().enabled).toBe(false);
  });

  it('the default gate reads LOOP_YIELD_GATE on every call', () => {
    const prev = process.env.LOOP_YIELD_GATE;
    try {
      const gate = new LoopYieldGate({ budgetMs: 30 });
      process.env.LOOP_YIELD_GATE = '0';
      expect(gate.enabled()).toBe(false);
      delete process.env.LOOP_YIELD_GATE;
      expect(gate.enabled()).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.LOOP_YIELD_GATE;
      else process.env.LOOP_YIELD_GATE = prev;
    }
  });
});

describe('meter — a gate-held wait is not a block verdict', () => {
  const ENV = { PHASE_TIMING_SLOW_MS: '30' } as NodeJS.ProcessEnv;

  it('a held resume records yield-wait@<phase> as async; an unheld one still records yield-preempt sync', () => {
    const meter = new SyncSliceMeter('p', ENV);
    meter.onYieldResumed(Date.now() - 200, 'TSLA', 3);
    let a = getPhaseAttribution();
    expect(a.lastSlowSyncPhase).toBeNull();
    expect(a.recentSlowPhases.at(-1)!.name).toBe('yield-wait@p');
    expect(a.recentSlowPhases.at(-1)!.kind).toBe('async');
    meter.onYieldResumed(Date.now() - 200, 'TSLA', 0);
    a = getPhaseAttribution();
    expect(a.lastSlowSyncPhase!.name).toBe('yield-preempt@p');
    expect(a.lastSlowSyncPhase!.kind).toBe('sync');
  });
});

describe('wiring — signal-engine yields through the shared gate (source-level)', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'signal-engine.ts'),
    'utf8',
  );

  it('the yielders are the shared module’s, not local copies', () => {
    expect(src).toContain("import { EvalYielder, TickPacer } from './cooperative-yield.js';");
    expect(src).not.toMatch(/class (TickPacer|EvalYielder)\b/);
    // A bare setImmediate yield bypasses the gate.
    expect(src).not.toContain('yieldToEventLoop()');
  });

  it('the trip-#14 co-resume site (demo-directional) carries a yielder', () => {
    expect(src).toContain("new EvalYielder('signal.doTick.demo-directional', { countFloor: false })");
  });
});
