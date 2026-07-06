// TRA-1322 — tests for the guarded covered-call recovery branch.
//
// Two things are proven here:
//   1. PARITY. The ported state machine, run in BARE mode (guards off), matches
//      QuantTrader's TRA-1146 reference results (`wheel-backtest.mjs` → the
//      committed `tra1146-wheel-{full,quality}.reference.json`) bit-for-bit,
//      over a frozen OHLC fixture captured from the same Yahoo window. This is
//      the parity contract required before the port advances.
//   2. GUARDS. The three board-required guards each fire on constructed price
//      paths, and switching them on removes the bare wheel's unbounded left tail
//      on the full universe (the whole point of the build).

import { describe, it, expect } from 'vitest';
import {
  runWheel, metrics, pickStrike, restrictUniverse,
  WHEEL_FULL_UNIVERSE, WHEEL_QUALITY_UNIVERSE,
  type PriceSeries, type WheelGuards,
} from './wheel-recovery.js';
import ohlcFixture from '../fixtures/tra1146-wheel-ohlc.json' with { type: 'json' };
import fullReference from '../fixtures/tra1146-wheel-full.reference.json' with { type: 'json' };
import qualityReference from '../fixtures/tra1146-wheel-quality.reference.json' with { type: 'json' };

const OHLC = ohlcFixture as unknown as Record<string, PriceSeries>;

/** Metrics + population counts, shaped like the reference `byVrpFactor` entries. */
function runFactor(data: Record<string, PriceSeries>, ivFactor: number, guards?: WheelGuards) {
  const r = runWheel(data, { ivFactor, guards });
  const m = metrics(r.cycles);
  return {
    ...m,
    assignedCount: r.assignedCount,
    calledAwayCount: r.calledAwayCount,
    ccSold: r.ccSold,
    cyclesWithCC: r.cyclesWithCC,
    assignRate: r.cyclesWithCC / (m.n || 1),
    _run: r,
  };
}

describe('wheel-recovery — parity with the TRA-1146 reference (bare mode)', () => {
  const FACTORS = [1.0, 1.1, 1.2];

  it('reproduces the full 25-name reference to floating-point tolerance', () => {
    const ref = fullReference.byVrpFactor as Record<string, Record<string, number>>;
    for (const f of FACTORS) {
      const got = runFactor(OHLC, f); // full universe = every fixture symbol
      const exp = ref[String(f)]!;
      // exact population counts
      expect(got.n).toBe(exp.n);
      expect(got.assignedCount).toBe(exp.assignedCount);
      expect(got.calledAwayCount).toBe(exp.calledAwayCount);
      expect(got.ccSold).toBe(exp.ccSold);
      // real-valued metrics reproduce to ~1e-9
      expect(got.sharpe!).toBeCloseTo(exp.sharpe!, 9);
      expect(got.maxDD!).toBeCloseTo(exp.maxDD!, 9);
      expect(got.annRetColl!).toBeCloseTo(exp.annRetColl!, 9);
      expect(got.pf!).toBeCloseTo(exp.pf!, 9);
      expect(got.winRate!).toBeCloseTo(exp.winRate!, 9);
      expect(got.worst!).toBeCloseTo(exp.worst!, 9);
    }
  });

  it('reproduces the TRA-592 quality sub-universe reference', () => {
    const data = restrictUniverse(OHLC, WHEEL_QUALITY_UNIVERSE);
    const ref = qualityReference.byVrpFactor as Record<string, Record<string, number>>;
    for (const f of FACTORS) {
      const got = runFactor(data, f);
      const exp = ref[String(f)]!;
      expect(got.n).toBe(exp.n);
      expect(got.assignedCount).toBe(exp.assignedCount);
      expect(got.sharpe!).toBeCloseTo(exp.sharpe!, 9);
      expect(got.maxDD!).toBeCloseTo(exp.maxDD!, 9);
    }
  });

  it('the two universe constants match the reference params', () => {
    expect([...WHEEL_FULL_UNIVERSE]).toEqual(fullReference.params.universe);
    expect([...WHEEL_QUALITY_UNIVERSE]).toEqual(qualityReference.params.universe);
  });
});

// ── Synthetic price-path helper for deterministic guard unit tests. ──

/**
 * Build a deterministic series that drives the state machine into the
 * post-assignment stock phase, so the guards can be exercised in isolation:
 *   1. a slow rising ramp (establishes SMA50 ≥ SMA200 for the §B filter),
 *   2. a shallow dip + small recovery (pulls RSI into the [35,58] entry band so
 *      exactly one CSP is sold near the top),
 *   3. a glide down to `targetFrac × top` over ~one DTE (the open put finishes
 *      ITM → assignment; cost basis ≈ target), then
 *   4. a 200-bar `tail(i, target)` for the stock phase.
 * Only bar ordering matters for dates, so they are stamped sequentially.
 */
function buildWheelPath(targetFrac: number, tail: (i: number, target: number) => number): PriceSeries {
  const close: number[] = [];
  const WARM = 215;
  for (let i = 0; i < WARM; i++) close.push(80 + (30 * i) / (WARM - 1));
  for (let i = 0; i < 12; i++) close.push(close[close.length - 1]! * (1 - 0.006)); // dip
  for (let i = 0; i < 6; i++) close.push(close[close.length - 1]! * 1.002);         // small recover → entry
  const top = close[close.length - 1]!;
  const target = top * targetFrac;
  const CB = 22; // glide down over ~one DTE → the open put is assigned
  for (let i = 1; i <= CB; i++) close.push(top + (target - top) * (i / CB));
  for (let i = 0; i < 200; i++) close.push(tail(i, target)); // post-assignment stock phase
  const date: string[] = [];
  for (let i = 0; i < close.length; i++) {
    date.push(new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10));
  }
  return { sym: 'TEST', date, close };
}

describe('wheel-recovery — guard #1: covered call floored at cost basis', () => {
  it('pickStrike never returns a strike below the floor', () => {
    // basis 100; at any spot the chosen call strike must be >= basis
    for (const spot of [80, 95, 100, 120]) {
      const K = pickStrike(spot, 30 / 365, 0.4, 'call', 0.3, 100);
      if (K != null) expect(K).toBeGreaterThanOrEqual(100);
    }
  });

  it('below-basis spot still cannot produce a loss-locking call strike', () => {
    // stock underwater (spot 70, basis 100): a naive 0.3Δ call would be ~72,
    // which would lock a loss if called away. The floor forbids it.
    const K = pickStrike(70, 30 / 365, 0.5, 'call', 0.3, 100);
    if (K != null) expect(K).toBeGreaterThanOrEqual(100);
  });
});

describe('wheel-recovery — guard #2: hard stock-side stop', () => {
  it('fires and bounds the loss when assigned stock keeps falling', () => {
    // assigned near the top, then the stock grinds relentlessly lower — the
    // classic bag-hold. Crash to 90% of top, then keep falling ~0.6%/bar.
    const data = { TEST: buildWheelPath(0.90, (i, t) => t * (1 - 0.006 * i)) };

    const bare = runWheel(data, { ivFactor: 1.1 });
    const guarded = runWheel(data, { ivFactor: 1.1, guards: { stockStopPct: 0.15, maxCcCycles: 3 } });

    // both assign; only the guarded run stops out
    expect(bare.assignedCount).toBeGreaterThan(0);
    expect(guarded.stoppedCount).toBeGreaterThan(0);
    expect(bare.stoppedCount).toBe(0);

    // the guard bounds the realized loss: the guarded cycle's return-on-collateral
    // is far less negative than the bare cycle's bag-held tail.
    const bareWorst = Math.min(...bare.cycles.map((c) => c.retColl));
    const guardedWorst = Math.min(...guarded.cycles.map((c) => c.retColl));
    expect(guardedWorst).toBeGreaterThan(bareWorst);
  });
});

describe('wheel-recovery — guard #3: max recovery window', () => {
  it('liquidates after N covered-call cycles instead of holding forever', () => {
    // assigned just ITM (basis ≈ target), then the stock chops sideways ~2% below
    // basis: covered calls floored at basis stay OTM and re-sell each cycle, never
    // called away, never stopped — the bare wheel would write calls indefinitely.
    const data = { TEST: buildWheelPath(0.97, (i, t) => t * (1 + 0.012 * Math.sin(i / 3))) };

    const unbounded = runWheel(data, { ivFactor: 1.1, guards: { stockStopPct: 0.6 } }); // stop too deep to fire
    const windowed = runWheel(data, { ivFactor: 1.1, guards: { stockStopPct: 0.6, maxCcCycles: 3 } });

    expect(windowed.windowLiquidatedCount).toBeGreaterThan(0);
    // the windowed cycle wrote at most maxCcCycles covered calls before liquidating
    const windowedCycle = windowed.cycles.find((c) => c.reason === 'max_window_liquidation');
    expect(windowedCycle).toBeDefined();
    expect(windowedCycle!.ccCycles).toBeLessThanOrEqual(3);
    // and it wrote strictly fewer covered calls than the unbounded run
    expect(windowed.ccSold).toBeLessThan(unbounded.ccSold);
  });
});

describe('wheel-recovery — guards remove the unbounded left tail (full universe)', () => {
  it('guarded maxDD and worst-cycle beat the bare wheel on the full 25-name set', () => {
    const bare = runFactor(OHLC, 1.1);
    const guarded = runFactor(OHLC, 1.1, { stockStopPct: 0.15, maxCcCycles: 3 });

    // the bare wheel's whole problem is the tail; the guards must shrink it
    expect(guarded.maxDD!).toBeLessThan(bare.maxDD!);
    expect(guarded.worst!).toBeGreaterThan(bare.worst!);
    // and the stop must actually engage on the secular-downtrend names
    expect(guarded._run.stoppedCount).toBeGreaterThan(0);
  });
});
