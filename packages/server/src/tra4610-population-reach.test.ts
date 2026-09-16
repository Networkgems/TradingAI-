// TRA-4610 (parent TRA-4376, filed by CFO) — `cadence.canAccrue` must be FALSE
// whenever the armed nominator band cannot reach the frozen `populationCell`,
// not only when the entry gate is shut.
//
// The measured incident, prod `f8f7b1855da0` 2026-09-16T21:15Z: the cell was
// frozen at [0.50, 0.55) on 2026-08-23; the armed selector band read
// [0.25, 0.40); of 640 candidates evaluated that etDay, ZERO landed in the
// cell. `entry_window` had re-opened (blockRate 1.00 -> 0.62), releasing the
// TRA-4345 clause, so the record served `canAccrue: true` with
// `projectedSessionsToTarget: 42` — a 42-session runway it cannot walk.
//
// The two clauses are independent, so each needs its own negative control: a
// test that only ever moves both together cannot tell a conjunction from
// either clause alone (TRA-3926 — two gates on one row must be graded
// separately, and a positive control that fails for a STRONGER reason is
// vacuous for the predicate under test).
import { describe, expect, it } from 'vitest';
import {
  assessOtmEntryAccrual,
  assessOtmPopulationReach,
  buildOtmEvaluationWindowRecord,
  emptyOtmEvaluationWindowState,
  evaluateOtmEvaluationLiveness,
  foldOtmEvaluationWindow,
  otmEvaluationCadence,
  type OtmEvaluationPopulationCell,
  type OtmEvaluationWindowState,
} from './otm-evaluation-window.js';
import { OTM_ENTRY_WINDOWS_VALUE, resolveOtmEntryWindows } from './otm-entry-window.js';

/** The entry gate as it read on 2026-09-16: RE-OPENED, so clause 1 is satisfied. */
const ENTRY_OPEN = assessOtmEntryAccrual(resolveOtmEntryWindows({} as NodeJS.ProcessEnv));
/** The TRA-4217 standdown, for the clause-1-only control. */
const ENTRY_SHUT = assessOtmEntryAccrual(
  resolveOtmEntryWindows({ [OTM_ENTRY_WINDOWS_VALUE]: '03:00-03:01' } as NodeJS.ProcessEnv),
);

/** The live frozen cell: `[0.50, 0.55)` +/- 0.005 tolerance. */
const CELL: OtmEvaluationPopulationCell = {
  deltaAbsMin: 0.5,
  deltaAbsMax: 0.55,
  tolerance: 0.005,
  floorBand: [0.495, 0.55],
  selectorBand: [0.5, 0.55],
  frozen: true,
  frozenAt: Date.UTC(2026, 7, 23, 1, 40, 43),
  pooledCellsForbidden: true,
};

/** The live armed band on the incident read. */
const ARMED_TODAY: [number, number] = [0.25, 0.4];
/** The band that was armed when the cell was cut. */
const ARMED_AT_STAMP: [number, number] = [0.5, 0.55];

const stamped = (cell: OtmEvaluationPopulationCell | null = CELL): OtmEvaluationWindowState => ({
  ...emptyOtmEvaluationWindowState(),
  startedAt: Date.UTC(2026, 7, 23, 1, 40, 43),
  populationCell: cell,
});

/** 2026-09-16T21:15Z — the instant of the filing's read. */
const NOW = Date.UTC(2026, 8, 16, 21, 15, 13);

const record = (
  band: readonly [number, number] | null | undefined,
  cell: OtmEvaluationPopulationCell | null = CELL,
) => {
  const st = stamped(cell);
  return buildOtmEvaluationWindowRecord(
    st, evaluateOtmEvaluationLiveness({}), true, foldOtmEvaluationWindow([], st, NOW),
    undefined, ENTRY_OPEN, null, band,
  );
};

describe('TRA-4610 — the reach predicate', () => {
  it('the measured incident: the frozen cell is DISJOINT from the armed band, by 0.095', () => {
    const reach = assessOtmPopulationReach(CELL, ARMED_TODAY);
    expect(reach.reachable).toBe(false);
    expect(reach.reason).toBe('population_cell_outside_armed_selector_band');
    // The tolerance-widened interval is the one the fold admits on.
    expect(reach.cellBand).toEqual([0.495, 0.555]);
    expect(reach.armedSelectorBand).toEqual([0.25, 0.4]);
  });

  it('the same cell WAS reachable by the band armed when it was cut — so the clause is not always-false', () => {
    const reach = assessOtmPopulationReach(CELL, ARMED_AT_STAMP);
    expect(reach.reachable).toBe(true);
    expect(reach.reason).toBeNull();
  });

  it('touching edges: the predicate is half-open on both sides, so [0.25,0.495) does NOT reach', () => {
    // cellBand is [0.495, 0.555). A selector ending exactly at 0.495 nominates
    // nothing in the cell; one ending a hair above does.
    expect(assessOtmPopulationReach(CELL, [0.25, 0.495]).reachable).toBe(false);
    expect(assessOtmPopulationReach(CELL, [0.25, 0.4951]).reachable).toBe(true);
    // ...and the upper edge: a selector starting at 0.555 is past the cell.
    expect(assessOtmPopulationReach(CELL, [0.555, 0.7]).reachable).toBe(false);
    expect(assessOtmPopulationReach(CELL, [0.5549, 0.7]).reachable).toBe(true);
  });

  it('an unreadable band is `null`, never `true` — it must not buy a runway it cannot demonstrate', () => {
    for (const bad of [null, undefined, [Number.NaN, 0.4] as const, [0.25, Number.NaN] as const]) {
      const reach = assessOtmPopulationReach(CELL, bad);
      expect(reach.reachable).toBeNull();
      expect(reach.reason).toBe('armed_selector_band_unreadable');
    }
  });

  it('before a cell is stamped the clause CANNOT bind — a fresh successor window still accrues', () => {
    const reach = assessOtmPopulationReach(null, ARMED_TODAY);
    expect(reach.reachable).toBe(true);
    expect(reach.reason).toBeNull();
    expect(reach.cellBand).toBeNull();
  });
});

describe('TRA-4610 — canAccrue is the CONJUNCTION, and each clause has its own control', () => {
  const cadence = (
    accrual: typeof ENTRY_OPEN | null,
    reach: ReturnType<typeof assessOtmPopulationReach> | null,
  ) => otmEvaluationCadence(stamped(), 9, NOW, accrual, reach);

  it('THE DEFECT: entry gate OPEN + cell unreachable => canAccrue FALSE and no ETA', () => {
    const c = cadence(ENTRY_OPEN, assessOtmPopulationReach(CELL, ARMED_TODAY));
    expect(c?.canAccrue).toBe(false);
    expect(c?.cannotAccrueReason).toBe('population_cell_outside_armed_selector_band');
    expect(c?.blockers).toEqual(['population_cell_outside_armed_selector_band']);
    // The 42-session runway is gone; the trailing average is still published.
    expect(c?.projectedSessionsToTarget).toBeNull();
    expect(c?.closesPerSession).toBeGreaterThan(0);
  });

  it('control — both clauses satisfied => canAccrue TRUE and the ETA returns (so the guard is not blanket)', () => {
    const c = cadence(ENTRY_OPEN, assessOtmPopulationReach(CELL, ARMED_AT_STAMP));
    expect(c?.canAccrue).toBe(true);
    expect(c?.cannotAccrueReason).toBeNull();
    expect(c?.blockers).toEqual([]);
    expect(c?.projectedSessionsToTarget).toBeGreaterThan(0);
  });

  it('control — clause 1 alone still bites, with TRA-4345\'s reason string unchanged', () => {
    const c = cadence(ENTRY_SHUT, assessOtmPopulationReach(CELL, ARMED_AT_STAMP));
    expect(c?.canAccrue).toBe(false);
    expect(c?.cannotAccrueReason).toBe('entry_window_never_intersects_rth');
    expect(c?.blockers).toEqual(['entry_window_never_intersects_rth']);
    expect(c?.projectedSessionsToTarget).toBeNull();
  });

  it('both shut => BOTH are listed, so fixing the named gate cannot read as fixing accrual', () => {
    const c = cadence(ENTRY_SHUT, assessOtmPopulationReach(CELL, ARMED_TODAY));
    expect(c?.blockers).toEqual([
      'entry_window_never_intersects_rth',
      'population_cell_outside_armed_selector_band',
    ]);
    // Precedence: the entry gate is reported first, so TRA-4345's consumers
    // keep reading the string they already key on.
    expect(c?.cannotAccrueReason).toBe('entry_window_never_intersects_rth');
  });

  it('an unreadable accrual OR an unreadable band both fail CLOSED', () => {
    expect(cadence(null, assessOtmPopulationReach(CELL, ARMED_AT_STAMP))?.cannotAccrueReason)
      .toBe('entry_window_state_unreadable');
    const c = cadence(ENTRY_OPEN, assessOtmPopulationReach(CELL, null));
    expect(c?.canAccrue).toBe(false);
    expect(c?.cannotAccrueReason).toBe('armed_selector_band_unreadable');
  });

  it('a caller predating TRA-4610 passes no reach at all — non-binding, not unreadable', () => {
    const c = otmEvaluationCadence(stamped(), 9, NOW, ENTRY_OPEN);
    expect(c?.canAccrue).toBe(true);
    expect(c?.blockers).toEqual([]);
  });
});

describe('TRA-4610 — the published record', () => {
  it('serves the incident as canAccrue FALSE with both bands beside it', () => {
    const r = record(ARMED_TODAY);
    expect(r.cadence?.canAccrue).toBe(false);
    expect(r.cadence?.projectedSessionsToTarget).toBeNull();
    expect(r.populationReach?.reachable).toBe(false);
    expect(r.populationReach?.cellBand).toEqual([0.495, 0.555]);
    expect(r.populationReach?.armedSelectorBand).toEqual([0.25, 0.4]);
  });

  it('the verdict writer is told which clause is starving the window NOW', () => {
    expect(record(ARMED_TODAY).insufficientPopulation.currentBlockers)
      .toEqual(['population_cell_outside_armed_selector_band']);
    expect(record(ARMED_AT_STAMP).insufficientPopulation.currentBlockers).toEqual([]);
  });

  it('`observedGateStillBlocking` stays scoped to the ACCUSED gate — the stale signal survives', () => {
    // The entry gate really has cleared. Widening this field to the new clause
    // would delete the record's own truthful "re-diagnose me" flag while
    // "fixing" the inconsistency beside it.
    const r = record(ARMED_TODAY);
    expect(r.insufficientPopulation.observedGate).toBe('entry_window');
    expect(r.insufficientPopulation.observedGateStillBlocking).toBe(false);
    expect(r.insufficientPopulation.stale).toBe(true);
  });

  it('`nominationBandIntersects` is UNCHANGED and now says which two bands it compares', () => {
    // It was never wrong: it is a LIVE-floor n LIVE-selector read. The defect
    // was that nothing on the record said so, next to a frozen cell.
    const r = record(ARMED_TODAY);
    expect(r.nominationBandIntersects).toBe(true);
    expect(r.nominationBandIntersectsMethod).toContain('NOT a statement about the frozen populationCell');
    expect(r.nominationBandIntersectsMethod).toContain('populationReach.reachable');
  });

  it('AC4 — additive only: the cell, n, the fold and the verdict do not move with the clause', () => {
    const shut = record(ARMED_TODAY);
    const open = record(ARMED_AT_STAMP);
    expect(shut.populationCell).toEqual(open.populationCell);
    expect(shut.n).toEqual(open.n);
    expect(shut.verdict).toEqual(open.verdict);
    expect(shut.targetCloses).toEqual(open.targetCloses);
    expect(shut.excludedCloses).toEqual(open.excludedCloses);
    expect(shut.status).toEqual(open.status);
  });

  it('an unstamped cell leaves the record accruing, with the clause published as non-binding', () => {
    const r = record(ARMED_TODAY, null);
    expect(r.populationReach?.reachable).toBe(true);
    expect(r.cadence?.canAccrue).toBe(true);
  });

  it('omitting the band leaves the clause unevaluated (`null`), never silently false', () => {
    const r = record(undefined);
    expect(r.populationReach).toBeNull();
    expect(r.cadence?.canAccrue).toBe(true);
  });
});
