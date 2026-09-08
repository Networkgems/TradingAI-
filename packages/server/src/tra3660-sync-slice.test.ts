// TRA-3660 — sync-slice attribution for cooperative per-symbol loops.
//
// Trips #7/#8/#9/#11 (2026-09-03..09-08) were single clean 6-9s blocks with
// `slowSyncPhase: null` while a ~22s ASYNC envelope (`equity-entry-sweep`,
// `news-refresh`, `quote-batch`) was in flight. Two shapes hide there and the
// existing instruments cannot separate them:
//   (a) one un-preemptible sync slice INSIDE the loop (one symbol's work) —
//       the pacers bound stretches only when control returns to them, so an
//       8s single operation was never measured by anything; and
//   (b) FOREIGN uninstrumented work running while the loop is yielded — which
//       the trip's straddle read then charges to the innocent yielded envelope.
// SyncSliceMeter records (a) as `<phase>#slice[from..to]` with the symbol
// range, and (b) as `yield-preempt@<phase>` — an observation naming the
// witness, not a culprit. Both land in `slowSyncPhase`, so the next trip of
// this family stops reading `unattributed-none`.

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  SyncSliceMeter,
  getPhaseAttribution,
  _resetPhaseTimingForTests,
} from './phase-timing.js';

/** Hold the loop synchronously for ~ms (a real block, not a timer). */
function busyBlock(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) { /* burn */ }
}

// Low threshold so the tests block for tens of ms, not seconds. Passed as the
// meter's injected env — the module default (1000ms) is untouched for
// everything else in the process.
const ENV = { PHASE_TIMING_SLOW_MS: '30' } as NodeJS.ProcessEnv;

beforeEach(() => {
  _resetPhaseTimingForTests();
});

describe('SyncSliceMeter — own-slice attribution (shape (a))', () => {
  it('records a slow slice as a sync phase carrying the symbol range', () => {
    const meter = new SyncSliceMeter('signal.doTick.equity-entry-sweep', ENV);
    meter.endSlice('AAPL'); // fast first slice — establishes the from-label
    busyBlock(45);
    meter.endSlice('NVDA');
    const a = getPhaseAttribution();
    expect(a.lastSlowSyncPhase).not.toBeNull();
    expect(a.lastSlowSyncPhase!.name).toBe('signal.doTick.equity-entry-sweep#slice[AAPL..NVDA]');
    expect(a.lastSlowSyncPhase!.kind).toBe('sync');
    expect(a.lastSlowSyncPhase!.durationMs).toBeGreaterThanOrEqual(40);
  });

  it('records nothing for a fast slice (the modal, healthy case)', () => {
    const meter = new SyncSliceMeter('signal.doTick.equity-entry-sweep', ENV);
    meter.endSlice('AAPL');
    meter.endSlice('MSFT');
    meter.endSlice('NVDA');
    expect(getPhaseAttribution().lastSlowSyncPhase).toBeNull();
    expect(getPhaseAttribution().recentSlowPhases).toHaveLength(0);
  });

  it('names the head slice <start> so a block before the first boundary is still ranged', () => {
    const meter = new SyncSliceMeter('p', ENV);
    busyBlock(45);
    meter.endSlice('AAPL');
    expect(getPhaseAttribution().lastSlowSyncPhase!.name).toBe('p#slice[<start>..AAPL]');
  });
});

describe('SyncSliceMeter — yield preemption (shape (b))', () => {
  it('records a slow scheduled→resumed delay as yield-preempt@<phase>, an observation not a culprit', () => {
    const meter = new SyncSliceMeter('signal.doTick.equity-entry-sweep', ENV);
    const scheduledAt = Date.now();
    busyBlock(45); // stands in for foreign work holding the loop during the yield
    meter.onYieldResumed(scheduledAt, 'TSLA');
    const rec = getPhaseAttribution().lastSlowSyncPhase;
    expect(rec).not.toBeNull();
    expect(rec!.name).toBe('yield-preempt@signal.doTick.equity-entry-sweep');
    expect(rec!.kind).toBe('sync');
  });

  it('starts the next slice at the RESUME — queue time is never charged to the loop', () => {
    const meter = new SyncSliceMeter('p', ENV);
    const scheduledAt = Date.now() - 500; // a long yield wait...
    meter.onYieldResumed(scheduledAt, 'TSLA'); // (records the preempt; also re-stamps)
    meter.endSlice('AMD'); // ...followed by a FAST own-slice
    // The last sync record must still be the preempt observation, NOT a
    // fabricated slow `p#slice[TSLA..AMD]` that inherited the queue time.
    expect(getPhaseAttribution().lastSlowSyncPhase!.name).toBe('yield-preempt@p');
    const sliceRecs = getPhaseAttribution().recentSlowPhases.filter(r => r.name.includes('#slice'));
    expect(sliceRecs).toHaveLength(0);
  });

  it('records nothing for a prompt resume', () => {
    const meter = new SyncSliceMeter('p', ENV);
    meter.onYieldResumed(Date.now(), 'TSLA');
    expect(getPhaseAttribution().lastSlowSyncPhase).toBeNull();
  });
});

describe('wiring — the doTick loops actually carry the meter (source-level, same idiom as dotick-phase-coverage)', () => {
  const src = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'signal-engine.ts'),
    'utf8',
  );

  it('every EvalYielder in signal-engine is constructed WITH a phase name', () => {
    // A nameless construction is silent (no meter) — the exact gap this ships to close.
    expect(src).not.toContain('new EvalYielder()');
    expect(src).toContain("new EvalYielder('signal.doTick.equity-entry-sweep')");
    expect(src).toContain("new EvalYielder('signal.doTick.equity-eval-loop')");
  });

  it('the TickPacer is constructed with a phase name and its yields route through yieldNow', () => {
    expect(src).toContain("new TickPacer('signal.doTick.pacer')");
    expect(src).not.toMatch(/tickPacer\.shouldYield\([^)]*\)\) await yieldToEventLoop\(\)/);
  });

  it('the two evidence-named loops route their yields through yieldNow (resume-delay measured)', () => {
    expect(src).toContain('await evalYielder.yieldNow(sym)');
    expect(src).toContain('evalYielder.finish()');
  });
});
