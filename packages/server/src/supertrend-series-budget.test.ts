// TRA-2477 (phase 2 of TRA-2171) — the `supertrend-series` wall-clock bound.
//
// On the boot-excluded 2026-07-28 tape this sink was n=168, share 2.3%, p90 25.8s
// and **max 381.1s** — the single worst record of the window, larger than
// cold-bar-scan's 215.4s. A 2.3% Σ share owning the worst stall is exactly the
// shape TRA-2262 wrote down: size the bound off max/p90, never off Σ.
//
// Two things have to hold for this bound to be a latency win rather than a
// coverage cut wearing one, and NEITHER of them fails loudly:
//
//   1. an unfinished rotation must re-enter on the NEXT TICK, not on the sink's
//      own 60s window — otherwise the universe is still "covered", just 13x
//      slower, and nothing anywhere logs that;
//   2. slicing must not multiply the CADENCE of anything downstream. The refresh
//      claim stamps the fleet window, and the shadow EVAL gate keys on that
//      stamp — so a naive "claim per slice" re-arms the full-universe
//      supertrend()/reversalChecklist() burst every 30s and re-commits TRA-1082
//      while reporting a latency fix, and a peer engine seeing the window age
//      past 60s BETWEEN slices claims a second rotation over the same universe:
//      a double-fetch, i.e. the TRA-1996 feed-quota hazard.
//
// These tests pin both, plus the fail-open property of the new latch: it is
// stamped rather than boolean precisely so an engine that stops ticking
// mid-rotation cannot leave the fleet's shadow pass dark forever.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./yahoo-feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./yahoo-feed.js')>();
  return {
    ...actual,
    // Each per-symbol deep pull burns a fixed slice of the (hand-driven) clock.
    // Bars come back EMPTY on purpose: the cache write is not what is under test
    // here, the wall clock the pull costs is.
    fetchMinuteBars: vi.fn(async () => {
      clock += MS_PER_SYMBOL;
      return [];
    }),
  };
});

import {
  SignalEngine,
  _resetSharedShadowForTests,
  _sharedShadowRefreshDue,
  _claimSharedShadowRefresh,
  _resumeSharedShadowRefresh,
  _endSharedShadowRefresh,
  _noteSharedShadowRotation,
  _sharedShadowRotationPending,
  _sharedShadowEvalDue,
  _claimSharedShadowEval,
} from './signal-engine.js';
import { resetSweepCursors, sweepCursorSnapshot, SWEEP_BUDGET_MS, type SweepPass } from './tick-sweep-budget.js';
import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';

/** 5 symbols per batch x 2.2s = an 11s batch, so three batches cross a 30s budget. */
const MS_PER_SYMBOL = 2_200;
const BATCH = 5;

let clock = 1_000_000;

const REFRESH_MS = 60_000;
/** {@link SHARED_SHADOW_ROTATION_MAX_MS} in signal-engine.ts — the latch's expiry. */
const ROTATION_MAX_MS = 10 * 60_000;

/**
 * The clock spy, restored one-by-one rather than through `vi.restoreAllMocks()`:
 * that would also reset the `fetchMinuteBars` module mock's implementation to
 * `undefined`, and the sweep tests below would then walk a universe whose pulls
 * cost nothing — a budget test that can never see the budget bite.
 */
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  clock = 1_000_000;
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  _resetSharedShadowForTests();
  resetSweepCursors();
});

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  _resetSharedShadowForTests();
  resetSweepCursors();
});

// ── The fleet coordinator, with a rotation that spans ticks ──────────────────

describe('TRA-2477 — the shared-shadow latch across a BUDGETED rotation', () => {
  /** One engine's slice: claim-or-resume, run, release, record whether more remains. */
  function slice(nowMs: number, opts: { resume: boolean; incomplete: boolean }): void {
    if (opts.resume) _resumeSharedShadowRefresh();
    else _claimSharedShadowRefresh(nowMs);
    _endSharedShadowRefresh();
    _noteSharedShadowRotation(nowMs, opts.incomplete);
  }

  it('a rotation parked mid-universe stops a PEER claiming a second window over the same symbols', () => {
    const t0 = clock;
    slice(t0, { resume: false, incomplete: true });

    // The owner is between slices: the in-flight latch is DOWN (it only ever
    // covered one await) and the window is now older than the 60s cadence. This
    // is the exact instant a peer engine would have started a duplicate
    // whole-universe pull — the TRA-1996 feed-rate hazard hiding in a latency fix.
    expect(_sharedShadowRefreshDue(t0 + REFRESH_MS + 1)).toBe(false);
    expect(_sharedShadowRotationPending(t0 + REFRESH_MS + 1)).toBe(true);

    // Rotation done → the fleet is free again on the next 60s boundary.
    slice(t0 + 30_000, { resume: true, incomplete: false });
    expect(_sharedShadowRotationPending(t0 + REFRESH_MS + 1)).toBe(false);
    expect(_sharedShadowRefreshDue(t0 + REFRESH_MS + 1)).toBe(true);
  });

  it('holds the EVAL until the universe is covered — no engine reads a half-rotated series', () => {
    const t0 = clock;
    slice(t0, { resume: false, incomplete: true });
    expect(_sharedShadowEvalDue(t0 + 30_000)).toBe(false);

    slice(t0 + 30_000, { resume: true, incomplete: false });
    expect(_sharedShadowEvalDue(t0 + 30_000)).toBe(true);
  });

  it('a RESUME does not advance the window ⇒ exactly ONE eval per rotation, not one per slice', () => {
    const t0 = clock;
    // A 3-slice rotation. Pre-fix, re-claiming per slice would advance the window
    // stamp each time and re-arm the eval on every one of them.
    slice(t0, { resume: false, incomplete: true });
    slice(t0 + 30_000, { resume: true, incomplete: true });
    slice(t0 + 60_000, { resume: true, incomplete: false });

    let evals = 0;
    for (const t of [t0 + 60_000, t0 + 90_000, t0 + 120_000]) {
      if (_sharedShadowEvalDue(t)) { _claimSharedShadowEval(); evals += 1; }
    }
    expect(evals).toBe(1);

    // And the NEXT rotation re-arms it exactly once more.
    const t1 = t0 + 180_000;
    slice(t1, { resume: false, incomplete: false });
    expect(_sharedShadowEvalDue(t1)).toBe(true);
  });

  it('FAILS OPEN — an engine that stops ticking mid-rotation cannot leave the fleet dark', () => {
    const t0 = clock;
    slice(t0, { resume: false, incomplete: true });
    // ...and then never ticks again (crash, watchdog restart, flag flip).
    expect(_sharedShadowRefreshDue(t0 + ROTATION_MAX_MS - 1)).toBe(false);
    expect(_sharedShadowRefreshDue(t0 + ROTATION_MAX_MS)).toBe(true);
    expect(_sharedShadowEvalDue(t0 + ROTATION_MAX_MS)).toBe(true);
  });

  it('an abandoned rotation releases the latch immediately, without waiting out the expiry', () => {
    const t0 = clock;
    slice(t0, { resume: false, incomplete: true });
    // What the engine does when the market closes (or both shadow flags go off)
    // with a sweep still parked.
    _noteSharedShadowRotation(t0 + 5_000, false);
    expect(_sharedShadowRotationPending(t0 + 5_000)).toBe(false);
  });
});

// ── The bound itself, through the real engine method ─────────────────────────

describe('TRA-2477 — refreshSupertrendShadowSeries is wall-clock bounded', () => {
  function engine(): { refresh: (syms: string[]) => Promise<SweepPass> } {
    const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode: 'demo' as const });
    // The method is `private` in TS only; the bound is what is under test and it
    // lives here, so drive the real thing rather than a re-implementation.
    const call = (e as unknown as {
      refreshSupertrendShadowSeries(symbols: string[]): Promise<SweepPass>;
    }).refreshSupertrendShadowSeries.bind(e);
    return { refresh: call };
  }

  it('stops at the budget and parks a cursor, instead of walking all 568', async () => {
    const { refresh } = engine();
    const universe = Array.from({ length: 40 }, (_, i) => `S${i}`);

    const pass = await refresh(universe);

    // 11s per 5-wide batch; the budget is checked AFTER a batch, so the third one
    // (33s) is the one that crosses 30s.
    const perBatchMs = MS_PER_SYMBOL * BATCH;
    const expectedBatches = Math.ceil(SWEEP_BUDGET_MS / perBatchMs);
    expect(pass.processed).toHaveLength(expectedBatches * BATCH);
    expect(pass.complete).toBe(false);
    expect(pass.budgetExhausted).toBe(true);
    expect(pass.resumeAt).toBe(`S${expectedBatches * BATCH}`);
    expect(pass.total).toBe(40);
    // Per-ENGINE cursor: demo and live sweep the same watchlist and must not
    // consume each other's position.
    expect(sweepCursorSnapshot()['demo:supertrend-series']).toBe(pass.resumeAt);
  });

  it('the next pass resumes where the last one stopped and finishes the universe', async () => {
    const { refresh } = engine();
    const universe = Array.from({ length: 40 }, (_, i) => `S${i}`);

    const first = await refresh(universe);
    const second = await refresh(universe);

    expect(second.startIndex).toBe(first.processed.length);
    const walked = [...first.processed, ...second.processed];
    // No symbol skipped and none re-walked: the two passes are a contiguous
    // prefix of the universe, which is the property the cursor exists to hold.
    expect(walked).toEqual(universe.slice(0, walked.length));

    // Drive it to the end — the cursor must clear, not park past the tail.
    let pass = second;
    while (!pass.complete) pass = await refresh(universe);
    expect(pass.resumeAt).toBeNull();
    expect(sweepCursorSnapshot()['demo:supertrend-series']).toBeUndefined();
  });

  it('an empty universe is a completed rotation, not a parked one', async () => {
    const { refresh } = engine();
    const pass = await refresh([]);
    expect(pass.complete).toBe(true);
    expect(pass.budgetExhausted).toBe(false);
  });
});
