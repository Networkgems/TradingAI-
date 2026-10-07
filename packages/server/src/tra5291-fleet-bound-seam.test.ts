// TRA-5291 (board ruling a+, card `d243464d`, parent TRA-5282) — the fleet
// aggregate authorization `A` binds ALL live option entries at the shared
// `mirrorLiveOptionOpen` buy_to_open seam, not just OTM admissions.
//
// Two layers, mirroring hard-controls-wiring.test.ts' rationale: the pure
// predicate proves every verdict branch (including the AC2 dark-read refusals,
// with the non-finite input PINNED — `x != null` admits NaN, the TRA-3440
// shape), and the seam tests prove the gate BINDS — a refused order never
// reaches the broker stub, an admitted one does.

import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import { gradeFleetReachableBoundAtSeam } from './option-exec-flag.js';
import type { LiveOtmFleetCapitalRow } from './option-exec-flag.js';
import { setLiveOtmFleetCapitalProvider } from './live-otm-fleet-capital.js';
import { __resetHardControlsForTest } from './hard-controls.js';

// The smart-open walk retries on its own timers; under fake timers a real call
// would hang the test. The sentinel throw is caught by the seam's own
// try/catch (which voids the open) — reaching the mock IS the assertion.
vi.mock('./tradier-smart-open.js', () => ({
  submitSmartBuyToOpen: vi.fn(async () => {
    throw new Error('SENTINEL-REACHED-BROKER');
  }),
}));
import { submitSmartBuyToOpen } from './tradier-smart-open.js';

const NOW = Date.parse('2026-10-07T18:00:00.000Z');

const A = 500;

function row(overrides: Partial<LiveOtmFleetCapitalRow> = {}): LiveOtmFleetCapitalRow {
  return {
    book: 'admin',
    liveEntryGateOpen: true,
    availableCashUsd: 500,
    openPremiumAtRiskUsd: 0,
    openLiveOptionRows: 0,
    openEquityPositions: 0,
    ...overrides,
  } as LiveOtmFleetCapitalRow;
}

describe('TRA-5291 — gradeFleetReachableBoundAtSeam (pure predicate)', () => {
  const SELF = { book: 'v0nni', openPremiumAtRiskUsd: 100 };

  it('admits when Σ_j atRisk_j + notional fits A, with the terms attached', () => {
    const v = gradeFleetReachableBoundAtSeam(
      A,
      [row({ book: 'admin', openPremiumAtRiskUsd: 219 })],
      SELF,
      150,
      true,
    );
    expect(v.allowed).toBe(true);
    expect(v.reasonCode).toBeUndefined();
    expect(v.basis).toBe('fleet');
    expect(v.fleetAtRiskUsd).toBeCloseTo(319, 2);
    expect(v.fleetAtRiskBooks).toBe(2);
    expect(v.fleetHeadroomSignedUsd).toBeCloseTo(181, 2);
  });

  it('the boundary is INCLUSIVE and cent-compared (the fitsLiveOtmReachableBound convention)', () => {
    const exactly = gradeFleetReachableBoundAtSeam(
      A, [row({ openPremiumAtRiskUsd: 219 })], SELF, 181, true,
    );
    expect(exactly.allowed).toBe(true);
    const oneCentOver = gradeFleetReachableBoundAtSeam(
      A, [row({ openPremiumAtRiskUsd: 219 })], SELF, 181.01, true,
    );
    expect(oneCentOver.allowed).toBe(false);
    expect(oneCentOver.reasonCode).toBe('over_fleet_reachable_bound');
  });

  it('refuses over the bound and the reason names every term and the ruling', () => {
    const v = gradeFleetReachableBoundAtSeam(
      A, [row({ openPremiumAtRiskUsd: 219 })], SELF, 300, true,
    );
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('over_fleet_reachable_bound');
    expect(v.reason).toContain('$319.00');
    expect(v.reason).toContain('$500.00');
    expect(v.reason).toContain('d243464d');
    expect(v.reason).toContain('TRA-5291');
  });

  it('TRA-3872 — the self fleet row is SUBSTITUTED by the caller\'s own (excluding) figure', () => {
    // The self book's fleet row carries the just-opened paper position
    // ($100 at-risk + this $150 order = $250); the caller passes $100. A naive
    // fold reads Σ = 250 + 219 = 469 and refuses a $150 entry at A=500 for
    // double-counting; the substituted fold reads 319 and admits.
    const v = gradeFleetReachableBoundAtSeam(
      A,
      [
        row({ book: 'admin', openPremiumAtRiskUsd: 219 }),
        row({ book: 'v0nni', openPremiumAtRiskUsd: 250 }), // self, inflated by the row being mirrored
      ],
      SELF,
      150,
      true,
    );
    expect(v.allowed).toBe(true);
    expect(v.fleetAtRiskUsd).toBeCloseTo(319, 2);
  });

  it('gate-CLOSED books are excluded from the fold (the TRA-3445 phantom-book rule)', () => {
    const v = gradeFleetReachableBoundAtSeam(
      A,
      [
        row({ book: 'admin', openPremiumAtRiskUsd: 219 }),
        row({ book: 'richard', liveEntryGateOpen: false, openPremiumAtRiskUsd: 10_000 }),
      ],
      SELF,
      150,
      true,
    );
    expect(v.allowed).toBe(true);
    expect(v.fleetAtRiskBooks).toBe(2);
  });

  it('AC2 — a NaN at-risk on a gate-open row lands in the REFUSING branch under a named code', () => {
    const v = gradeFleetReachableBoundAtSeam(
      A,
      [row({ book: 'admin', openPremiumAtRiskUsd: Number.NaN })],
      SELF,
      1, // a $1 order: nothing but the dark read can refuse this
      true,
    );
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('fleet_at_risk_unreadable');
    expect(v.fleetAtRiskUsd).toBeNull();
  });

  it('AC2 — Infinity and a negative at-risk refuse the same way (non-finite, not just null)', () => {
    for (const bad of [Number.POSITIVE_INFINITY, -1]) {
      const v = gradeFleetReachableBoundAtSeam(
        A, [row({ openPremiumAtRiskUsd: bad })], SELF, 1, true,
      );
      expect(v.allowed).toBe(false);
      expect(v.reasonCode).toBe('fleet_at_risk_unreadable');
    }
  });

  it('AC2 — a WIRED provider returning no rows is a dark read and REFUSES', () => {
    const v = gradeFleetReachableBoundAtSeam(A, null, SELF, 1, true);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('fleet_at_risk_unreadable');
  });

  it('AC2 — a NaN notional refuses; it never reaches the comparison', () => {
    const v = gradeFleetReachableBoundAtSeam(A, [row()], SELF, Number.NaN, true);
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('entry_notional_unreadable');
  });

  it('AC2 — an unreadable self at-risk refuses (Σ cannot be proven)', () => {
    const v = gradeFleetReachableBoundAtSeam(
      A, [row()], { book: 'v0nni', openPremiumAtRiskUsd: Number.NaN }, 1, true,
    );
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('fleet_at_risk_unreadable');
  });

  it('UNWIRED (single-engine tests) degrades to the self-only fold — bounded, never permissive', () => {
    const ok = gradeFleetReachableBoundAtSeam(A, null, SELF, 150, false);
    expect(ok.allowed).toBe(true);
    expect(ok.basis).toBe('self_only_unwired');
    expect(ok.fleetAtRiskBooks).toBe(1);
    // Still a bound: the caller's own at-risk alone can exhaust A.
    const over = gradeFleetReachableBoundAtSeam(
      A, null, { book: 'v0nni', openPremiumAtRiskUsd: 450 }, 100, false,
    );
    expect(over.allowed).toBe(false);
    expect(over.reasonCode).toBe('over_fleet_reachable_bound');
  });

  it('a null-book self cannot be matched and is counted AS WELL — the error lands on the refusing side', () => {
    const v = gradeFleetReachableBoundAtSeam(
      A,
      [row({ book: null, openPremiumAtRiskUsd: 250 })], // actually the caller, unmatchable
      { book: null, openPremiumAtRiskUsd: 100 },
      151, // fits the true Σ (319) but not the overcounted one (450 ⇒ headroom 50)
      true,
    );
    expect(v.allowed).toBe(false);
    expect(v.reasonCode).toBe('over_fleet_reachable_bound');
  });
});

// ── the seam BINDS — refused orders never reach the broker ──────────────────

type EnginePrivates = {
  mode: string;
  tradierLiveClient: unknown;
  mirrorLiveOptionOpen: (
    opened: unknown,
    surfaceLiveSkip: (reason: string) => void,
    opts?: unknown,
  ) => Promise<boolean>;
};
const priv = (e: SignalEngine) => e as unknown as EnginePrivates;

let seq = 0;
function fakeOpened(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: `opt-5291-${++seq}`,
    optionSymbol: 'AAPL270115C00100000',
    contracts: 1,
    premiumPaid: 0.5, // notional $50 — inside the $100 canary ceiling on purpose
    openedAt: NOW,
    mode: 'live',
    ...overrides,
  };
}

// `single_leg_otm` is deliberately NOT on the stood-down roster, so the
// stand-down gate above the new one admits and the fleet verdict is isolated
// (the TRA-3897 rule: a control that fails for a STRONGER reason is vacuous).
const SLEEVE = { sleeve: 'single_leg_otm' as const };

describe('TRA-5291 — the fleet authorization binds at the live buy_to_open seam', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    __resetHardControlsForTest({ dataDir: mkdtempSync(join(tmpdir(), 'tra5291-')), nowMs: NOW });
    vi.mocked(submitSmartBuyToOpen).mockClear();
  });

  afterEach(() => {
    setLiveOtmFleetCapitalProvider(null);
    vi.useRealTimers();
  });

  function seamEngine(): { engine: SignalEngine; skips: string[] } {
    const engine = new SignalEngine(undefined, undefined, undefined);
    priv(engine).mode = 'live';
    priv(engine).tradierLiveClient = {};
    return { engine, skips: [] };
  }

  it('a fleet at its authorization REFUSES the open before the broker is touched, and the skip names the ruling', async () => {
    const { engine, skips } = seamEngine();
    // Sibling book alone fills A=750 (env unset ⇒ compiled default) to $749:
    // headroom $1 < the $50 order.
    setLiveOtmFleetCapitalProvider(() => [
      row({ book: 'admin', openPremiumAtRiskUsd: 749 }),
    ]);
    const ok = await priv(engine).mirrorLiveOptionOpen(fakeOpened(), (r) => skips.push(r), SLEEVE);
    expect(ok).toBe(false);
    expect(submitSmartBuyToOpen).not.toHaveBeenCalled();
    expect(skips.some((s) => s.includes('d243464d') && s.includes('TRA-5291'))).toBe(true);
  });

  it('AC2 — a NaN fleet row refuses AT THE SEAM, never the permissive branch', async () => {
    const { engine, skips } = seamEngine();
    setLiveOtmFleetCapitalProvider(() => [
      row({ book: 'admin', openPremiumAtRiskUsd: Number.NaN }),
    ]);
    const ok = await priv(engine).mirrorLiveOptionOpen(fakeOpened(), (r) => skips.push(r), SLEEVE);
    expect(ok).toBe(false);
    expect(submitSmartBuyToOpen).not.toHaveBeenCalled();
    expect(skips.some((s) => s.includes('unreadable') || s.includes('DARK'))).toBe(true);
  });

  it('a fleet with headroom ADMITS — the order reaches the broker stub', async () => {
    const { engine, skips } = seamEngine();
    setLiveOtmFleetCapitalProvider(() => [
      row({ book: 'admin', openPremiumAtRiskUsd: 219 }),
    ]);
    const ok = await priv(engine).mirrorLiveOptionOpen(fakeOpened(), (r) => skips.push(r), SLEEVE);
    // The sentinel mock throws, so the seam voids the open — but the broker
    // WAS reached, which is what separates this admit from the refusals above.
    expect(ok).toBe(false);
    expect(submitSmartBuyToOpen).toHaveBeenCalledTimes(1);
  });
});
