import { describe, expect, it } from 'vitest';

import {
  buildQualificationMatrix,
  QUALIFICATION_LADDER,
  type QualificationMatrixInputs,
} from './qualification-matrix.js';
import { tapeExpectancyCellKey, type TapeExpectancyCell } from './option-tape-expectancy.js';

const OTM = 'single_leg_otm';
// Every structure the live fold carries, each with its OWN composition — the
// shape `arm.costBar.barsByStructure` publishes (TRA-4749).
const BARS = ['single_leg_otm', 'single_leg_rv', 'single_leg_directional'].map((structure) => ({
  structure,
  barR: 0.385,
  costModelR: 0.285,
  safetyMarginR: 0.1,
  minGrossR: 0.3,
}));

function cell(over: Partial<TapeExpectancyCell> & { bucket: string }): TapeExpectancyCell {
  const structure = over.structure ?? OTM;
  return {
    structure,
    cellKey: tapeExpectancyCellKey(structure, over.bucket),
    deltaFrom: 0,
    deltaTo: 1,
    n: 120,
    droppedUnpricedCloses: 0,
    meanR_gate: 0,
    sdR_gate: 1,
    seR_gate: 0.1,
    lowerCI95: 0,
    barR: 0.385,
    admits: false,
    admitsPooled: false,
    admitsRealFill: false,
    nRealFill: 0,
    meanR_gate_realFillNet: null,
    sdR_gate_realFill: null,
    loRealFillNet: null,
    boundNoiseR: null,
    realFillUnavailableReason: null,
    provenance: { byMode: { demo: 120 }, byAccountClass: { desk: 0, unattributed: 0 }, fromTs: null, toTs: null },
    meanR_gate_netOfModelledCross: null,
    lowerCI95_netOfModelledCross: null,
    netOfModelledCross: {} as TapeExpectancyCell['netOfModelledCross'],
    ...over,
  } as TapeExpectancyCell;
}

function inputs(over: Partial<QualificationMatrixInputs> = {}): QualificationMatrixInputs {
  return {
    etDay: '2026-09-24',
    cells: [],
    minCellN: 30,
    minCellRealFillN: 40,
    gateCells: [],
    gateCellDays: [],
    gateWindowEtDays: ['2026-09-24'],
    gateEvaluated: 0,
    gateBlocked: 0,
    netEdgeShadow: null,
    bars: BARS,
    netEdgeFormEnabled: false,
    ...over,
  };
}

const row = (m: ReturnType<typeof buildQualificationMatrix>, key: string) =>
  m.rows.find((r) => r.cellKey === key)!;

describe('qualification-matrix — the ladder', () => {
  it('resolves DATA first when the pooled sample is underpowered, however bad the bound looks', () => {
    // n=4 with lowerCI95 −0.65 is NOT a measured loser. Reporting the edge here
    // would quote noise as a finding (TRA-3388 Ruling 2.5).
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.40-0.45', n: 4, lowerCI95: -0.654, seR_gate: 0.4 })] }),
    );
    const r = row(m, `${OTM}::0.40-0.45`);
    expect(r.resolvedReason).toBe('insufficient_evidence');
    expect(r.edge.underpowered).toBe(true);
    // …but the edge verdict is still LISTED, so it is not lost.
    expect(r.blockingReasons).toContain('no_bar_setting_admits');
  });

  it('a NON-POSITIVE bound resolves to no_bar_setting_admits and fails at bar OFF', () => {
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.30-0.40', n: 124, lowerCI95: -0.2154 })] }),
    );
    const r = row(m, `${OTM}::0.30-0.40`);
    expect(r.resolvedReason).toBe('no_bar_setting_admits');
    expect(r.cost.admitsAtBarOff).toBe(false);
    expect(r.cost.maxAdmittingBarR).toBe(-0.2154);
    // EVERY named bar setting, including `off`, must refuse it.
    expect(r.cost.barSettings.every((s) => s.admits === false)).toBe(true);
  });

  it('a POSITIVE bound under the bar resolves to edge_below_cost_bar and names the lever', () => {
    // The live `single_leg_otm::0.50-0.55` shape: 0.3617 vs a 0.385 bar. The
    // 0.023 gap is smaller than the 0.10 ratified safety margin, so dropping the
    // margin alone would admit — that is the operator-actionable fact.
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617, nRealFill: 5 })] }),
    );
    const r = row(m, `${OTM}::0.50-0.55`);
    expect(r.resolvedReason).toBe('edge_below_cost_bar');
    expect(r.cost.admitsAtBarOff).toBe(true);
    expect(r.cost.passesAtLiveBar).toBe(false);
    const setting = (s: string) => r.cost.barSettings.find((x) => x.setting === s)!;
    expect(setting('live').admits).toBe(false);
    expect(setting('without_safety_margin').admits).toBe(true);
    expect(setting('min_gross_floor').admits).toBe(true);
    // …and the NEXT constraint is published, so clearing the bar is not sold as a fix.
    expect(r.nextBindingReason).toBe('insufficient_real_fill_evidence');
  });

  it('nextBindingReason is what a short-circuiting ladder would have hidden', () => {
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617, nRealFill: 5 })] }),
    );
    expect(row(m, `${OTM}::0.50-0.55`).blockingReasons).toEqual([
      'edge_below_cost_bar',
      'insufficient_real_fill_evidence',
    ]);
  });

  it('cost_bar_live_block is reachable — the ladder is not a green that cannot go red', () => {
    // MUTATE THE CASE: a cell that clears cost, edge and data and is STILL blocked
    // live is the only state in which cost is genuinely binding. If this test
    // cannot be made to produce it, the code path is dead.
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.9, nRealFill: 50, admitsPooled: true, admitsRealFill: true })],
        gateCells: [{ cell: `${OTM}::0.50-0.55`, evaluated: 20, blocked: 20, blockRate: 1 }],
        gateCellDays: [{ etDay: '2026-09-24', cell: `${OTM}::0.50-0.55`, evaluated: 20, blocked: 20 }],
        gateEvaluated: 20,
        gateBlocked: 20,
      }),
    );
    expect(row(m, `${OTM}::0.50-0.55`).resolvedReason).toBe('cost_bar_live_block');
  });

  it('a cell that clears everything and IS admitted live qualifies', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.9, nRealFill: 50, admitsPooled: true, admitsRealFill: true })],
        gateCells: [{ cell: `${OTM}::0.50-0.55`, evaluated: 20, blocked: 5, blockRate: 0.25 }],
        gateCellDays: [{ etDay: '2026-09-24', cell: `${OTM}::0.50-0.55`, evaluated: 20, blocked: 5 }],
        gateEvaluated: 20,
        gateBlocked: 5,
      }),
    );
    const r = row(m, `${OTM}::0.50-0.55`);
    expect(r.resolvedReason).toBeNull();
    expect(r.blockingReasons).toEqual([]);
    expect(m.overall).toBe('some_qualify');
    expect(r.data.canAccrue).toBe(true);
  });

  it('every ladder reason is reachable, and each carries a column and a test', () => {
    // A ladder entry nothing can produce is documentation, not an instrument.
    expect(QUALIFICATION_LADDER.map((l) => l.reason)).toEqual([
      'insufficient_evidence',
      'edge_unmeasurable',
      'no_bar_setting_admits',
      'edge_below_cost_bar',
      'insufficient_real_fill_evidence',
      'cost_bar_live_block',
    ]);
    for (const l of QUALIFICATION_LADDER) {
      expect(l.test.length).toBeGreaterThan(0);
      expect(['cost', 'edge', 'data']).toContain(l.column);
    }
  });

  it('edge_unmeasurable is distinct from a bound that exists and is bad', () => {
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.00-0.10', n: 40, lowerCI95: null, seR_gate: null })] }),
    );
    const r = row(m, `${OTM}::0.00-0.10`);
    expect(r.resolvedReason).toBe('edge_unmeasurable');
    expect(r.cost.admitsAtBarOff).toBeNull();
    expect(r.cost.maxAdmittingBarR).toBeNull();
    expect(r.blockingReasons).not.toContain('no_bar_setting_admits');
  });
});

describe('qualification-matrix — canAccrue is a RATE, not a level', () => {
  it('a 100%-blocked cell reads FROZEN (GATE SIDE), not "accruing"', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.30-0.40', n: 124, lowerCI95: -0.2154 })],
        gateCells: [{ cell: `${OTM}::0.30-0.40`, evaluated: 1799, blocked: 1799, blockRate: 1 }],
        gateCellDays: [{ etDay: '2026-09-24', cell: `${OTM}::0.30-0.40`, evaluated: 1799, blocked: 1799 }],
        gateEvaluated: 1799,
        gateBlocked: 1799,
      }),
    );
    const r = row(m, `${OTM}::0.30-0.40`);
    expect(r.data.canAccrue).toBe(false);
    expect(r.data.canAccrueReason).toMatch(/FROZEN \(GATE SIDE\)/);
    expect(r.data.lastAdmitEtDay).toBeNull();
    expect(m.accrual.realFillFrozen).toBe(true);
    expect(m.accrual.reason).toMatch(/DEADLOCK/);
  });

  it('⭐ a cell whose ONLY admits are historical reads STALLED, not accruing', () => {
    // THE DEFECT THIS FIELD EXISTS FOR, taken straight off the live fold:
    // `single_leg_otm::0.50-0.55` holds 428 pooled admits over the retained
    // window and has not been nominated since 2026-09-01. A pooled read calls
    // that "admitting, evidence accruing". It is a dead cell.
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617, nRealFill: 5 })],
        gateCells: [{ cell: `${OTM}::0.50-0.55`, evaluated: 2055, blocked: 1627, blockRate: 0.7917 }],
        gateCellDays: [
          { etDay: '2026-08-28', cell: `${OTM}::0.50-0.55`, evaluated: 387, blocked: 168 },
          { etDay: '2026-08-31', cell: `${OTM}::0.50-0.55`, evaluated: 100, blocked: 0 },
          { etDay: '2026-09-01', cell: `${OTM}::0.50-0.55`, evaluated: 109, blocked: 0 },
          { etDay: '2026-09-02', cell: `${OTM}::0.50-0.55`, evaluated: 700, blocked: 700 },
          { etDay: '2026-09-03', cell: `${OTM}::0.50-0.55`, evaluated: 759, blocked: 759 },
        ],
        gateEvaluated: 2055,
        gateBlocked: 1627,
      }),
    );
    const r = row(m, `${OTM}::0.50-0.55`);
    // The POOLED numbers alone would say "428 admits" — which is true, and useless.
    expect(r.data.liveEvaluated - r.data.liveBlocked).toBe(428);
    expect(r.data.canAccrue).toBe(false);
    expect(r.data.canAccrueReason).toMatch(/STALLED \(GATE SIDE\)/);
    expect(r.data.lastAdmitEtDay).toBe('2026-09-01');
    expect(r.data.lastNominatedEtDay).toBe('2026-09-03');
    expect(r.data.etDaysWithAdmits).toBe(3);
    expect(r.data.etDaysNominated).toBe(5);
    // 5 real fills off 428 admits — the admits are being eaten DOWNSTREAM of the
    // cost bar, which is not a cost-bar finding.
    expect(r.data.realFillPerAdmit).toBeCloseTo(5 / 428, 6);
    // …and the fold-level verdict must agree, not be rescued by the pooled count.
    expect(m.accrual.realFillFrozen).toBe(true);
    expect(m.accrual.lastAdmitEtDay).toBe('2026-09-01');
  });

  it('⭐ a cell admitted on EVERY day it appears, but not offered since, reads DORMANT', () => {
    // THE LIVE SHAPE, and the one a cell-relative anchor gets wrong.
    // `single_leg_otm::0.50-0.55` was admitted on 08-28 / 08-31 / 09-01 and has
    // not been nominated ONCE since. "Admitted on its most recent nomination
    // day" is therefore TRUE — and the cell is dead. The anchor has to be the
    // FOLD's most recent active day, not the cell's.
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617, nRealFill: 5 })],
        gateCells: [{ cell: `${OTM}::0.50-0.55`, evaluated: 596, blocked: 168, blockRate: 0.2819 }],
        gateCellDays: [
          { etDay: '2026-08-28', cell: `${OTM}::0.50-0.55`, evaluated: 387, blocked: 168 },
          { etDay: '2026-08-31', cell: `${OTM}::0.50-0.55`, evaluated: 100, blocked: 0 },
          { etDay: '2026-09-01', cell: `${OTM}::0.50-0.55`, evaluated: 109, blocked: 0 },
          // The gate kept running — on OTHER cells. This cell simply stopped
          // being offered to it.
          { etDay: '2026-09-23', cell: `${OTM}::0.30-0.40`, evaluated: 933, blocked: 933 },
          { etDay: '2026-09-24', cell: `${OTM}::0.30-0.40`, evaluated: 1799, blocked: 1799 },
        ],
        gateEvaluated: 3328,
        gateBlocked: 2900,
      }),
    );
    const r = row(m, `${OTM}::0.50-0.55`);
    // Admitted on every single day it appears — a cell-relative anchor says "fine".
    expect(r.data.lastAdmitEtDay).toBe('2026-09-01');
    expect(r.data.lastNominatedEtDay).toBe('2026-09-01');
    expect(r.data.etDaysNominated).toBe(3);
    expect(r.data.etDaysWithAdmits).toBe(3);
    // …and it is dead.
    expect(r.data.canAccrue).toBe(false);
    expect(r.data.canAccrueReason).toMatch(/DORMANT \(SELECTION SIDE\)/);
    expect(r.data.gateActiveEtDaysSinceLastNomination).toBe(2);
    // The fold verdict must not be rescued by the non-zero pooled admit rate.
    expect(m.accrual.liveAdmitRate).toBeGreaterThan(0);
    expect(m.accrual.realFillFrozen).toBe(true);
  });

  it('canAccrue is TRUE only when the cell was admitted on the fold\'s LATEST active day', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617, nRealFill: 5 })],
        gateCells: [{ cell: `${OTM}::0.50-0.55`, evaluated: 200, blocked: 100, blockRate: 0.5 }],
        gateCellDays: [
          { etDay: '2026-09-23', cell: `${OTM}::0.50-0.55`, evaluated: 100, blocked: 100 },
          { etDay: '2026-09-24', cell: `${OTM}::0.50-0.55`, evaluated: 100, blocked: 0 },
        ],
        gateEvaluated: 200,
        gateBlocked: 100,
      }),
    );
    const r = row(m, `${OTM}::0.50-0.55`);
    expect(r.data.canAccrue).toBe(true);
    // …and it must NOT be sold as a forecast: the cost bar is necessary only.
    expect(r.data.canAccrueReason).toMatch(/NECESSARY, not sufficient/);
    expect(m.accrual.realFillFrozen).toBe(false);
  });

  it('a never-nominated cell is FROZEN too, and is reported as a selection gap', () => {
    // The gate fold is READABLE and simply holds no row for this cell — which is
    // a measurement ("never nominated"), unlike an absent fold (UNREAD).
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617, nRealFill: 5 })],
        gateCells: [{ cell: `${OTM}::0.30-0.40`, evaluated: 10, blocked: 10, blockRate: 1 }],
        gateCellDays: [{ etDay: '2026-09-24', cell: `${OTM}::0.30-0.40`, evaluated: 10, blocked: 10 }],
        gateEvaluated: 10,
        gateBlocked: 10,
      }),
    );
    const r = row(m, `${OTM}::0.50-0.55`);
    expect(r.liveNominated).toBe(false);
    expect(r.data.canAccrue).toBe(false);
    expect(r.data.canAccrueReason).toMatch(/FROZEN \(SELECTION SIDE\)/);
    expect(m.join.cellsOnlyInTable).toEqual([`${OTM}::0.50-0.55`]);
  });

  it('realFillFrozen is NULL, never false, on a gate row that evaluated ZERO rows', () => {
    // Found by the route wiring test, not by this one: the retained fold carries
    // a `cost_bar` row from boot with `evaluated: 0`, so an `!== null` guard let
    // an EMPTY ledger report "not frozen" — i.e. "evidence is accruing" — off no
    // data. A gate that never ran is not a gate that admitted.
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.30-0.40' })], gateEvaluated: 0, gateBlocked: 0 }),
    );
    expect(m.accrual.realFillFrozen).toBeNull();
    expect(m.accrual.reason).toMatch(/UNREAD/);
  });

  it('realFillFrozen is NULL, never false, when no gate fold was supplied', () => {
    // Absent is not zero. A `false` here would read as "evidence is accruing".
    const m = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.30-0.40' })], gateEvaluated: null, gateBlocked: null }),
    );
    expect(m.accrual.realFillFrozen).toBeNull();
    expect(m.accrual.reason).toMatch(/UNREAD/);
  });

  it('an admitting cell flips realFillFrozen off — the frozen verdict can go green', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.30-0.40', lowerCI95: -0.2 })],
        gateCells: [{ cell: `${OTM}::0.30-0.40`, evaluated: 10, blocked: 9, blockRate: 0.9 }],
        gateCellDays: [{ etDay: '2026-09-24', cell: `${OTM}::0.30-0.40`, evaluated: 10, blocked: 9 }],
        gateEvaluated: 10,
        gateBlocked: 9,
      }),
    );
    expect(m.accrual.realFillFrozen).toBe(false);
    expect(row(m, `${OTM}::0.30-0.40`).data.canAccrue).toBe(true);
  });
});

describe('qualification-matrix — the bar is PER STRUCTURE (TRA-4749)', () => {
  it('a structure with no published composition falls back to its OWN cell bar, never to OTM', () => {
    // The TRA-4749 defect, re-imported, would grade `single_leg_rv` against the
    // OTM composition and report `without_safety_margin: admits` off a number
    // that sleeve never faced.
    const m = buildQualificationMatrix(
      inputs({
        bars: BARS.filter((b) => b.structure === OTM),
        cells: [cell({ structure: 'single_leg_rv', bucket: '0.45-0.50', n: 118, lowerCI95: 0.195, barR: 0.5 })],
      }),
    );
    const r = row(m, 'single_leg_rv::0.45-0.50');
    expect(r.cost.barCompositionPublished).toBe(false);
    expect(r.cost.barR).toBe(0.5); // the cell's OWN bar, not 0.385
    expect(r.cost.costModelR).toBeNull();
    expect(r.cost.barSettings.find((s) => s.setting === 'without_safety_margin')!.admits).toBeNull();
    expect(r.resolvedReason).toBe('edge_below_cost_bar');
  });

  it('a gate-side structure alias on the BAR list joins to the canonical cell', () => {
    const m = buildQualificationMatrix(
      inputs({
        bars: [{ structure: 'directional', barR: 0.385, costModelR: 0.285, safetyMarginR: 0.1, minGrossR: 0.3 }],
        cells: [cell({ structure: 'single_leg_directional', bucket: '0.45-0.50', n: 50, lowerCI95: 0.3 })],
      }),
    );
    const r = row(m, 'single_leg_directional::0.45-0.50');
    expect(r.cost.barCompositionPublished).toBe(true);
    expect(m.bars.map((b) => b.structure)).toEqual(['single_leg_directional']);
  });
});

describe('qualification-matrix — the join', () => {
  it('canonicalises a gate-side structure alias onto the table key, and RECORDS it', () => {
    // `directional` on the gate side is `single_leg_directional` on the table
    // side. An un-canonicalised join reads as `liveNominated: false`, which is
    // byte-identical to a genuinely never-nominated cell.
    const key = tapeExpectancyCellKey('single_leg_directional', '0.45-0.50');
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ structure: 'single_leg_directional', bucket: '0.45-0.50', n: 9, lowerCI95: -0.19 })],
        gateCells: [{ cell: 'directional::0.45-0.50', evaluated: 12, blocked: 12, blockRate: 1 }],
        gateCellDays: [{ etDay: '2026-09-24', cell: 'directional::0.45-0.50', evaluated: 12, blocked: 12 }],
        gateEvaluated: 12,
        gateBlocked: 12,
      }),
    );
    expect(row(m, key).liveNominated).toBe(true);
    expect(m.join.cellsCanonicalised).toEqual([{ from: 'directional::0.45-0.50', to: key }]);
    expect(m.join.cellsOnlyInGate).toEqual([]);
  });

  it('a gate cell with no table row is published, never dropped', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [],
        gateCells: [{ cell: `${OTM}::0.90-1.00`, evaluated: 3, blocked: 3, blockRate: 1 }],
        gateEvaluated: 3,
        gateBlocked: 3,
      }),
    );
    expect(m.join.cellsOnlyInGate).toEqual([`${OTM}::0.90-1.00`]);
  });
});

describe('qualification-matrix — the netEdgeShadow citation', () => {
  const sweep = [0.4, 0.45, 0.5, 0.5876, 0.65, 0.75, 1, 1.25].map((k) => ({ k, admits: 0, admitRate: 0 }));

  it('calls the flat-zero sweep VACUOUS on a non-positive bound, not a cost finding', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.30-0.40', n: 124, lowerCI95: -0.2154 })],
        netEdgeShadow: { rowsEvaluated: 3039, flatFormAdmits: 0, sweep },
      }),
    );
    const cite = row(m, `${OTM}::0.30-0.40`).cost.netEdgeShadowCitation!;
    expect(cite.interpretation).toMatch(/VACUOUS FOR THIS CELL/);
    expect(cite.admitsAtEveryK).toBe(false);
    expect(cite.kRange).toEqual([0.4, 1.25]);
    expect(cite.netEdgeFormEnabled).toBe(false);
  });

  it('does NOT attribute the fold zero to a cell whose own bound is positive', () => {
    const m = buildQualificationMatrix(
      inputs({
        cells: [cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3617 })],
        netEdgeShadow: { rowsEvaluated: 3039, flatFormAdmits: 0, sweep },
      }),
    );
    const cite = row(m, `${OTM}::0.50-0.55`).cost.netEdgeShadowCitation!;
    expect(cite.interpretation).toMatch(/NOT attributable to it/);
    expect(cite.interpretation).not.toMatch(/VACUOUS/);
  });

  it('reports the deployed FORM, so a recorder is never read as the gate', () => {
    const flat = buildQualificationMatrix(inputs({ cells: [cell({ bucket: '0.30-0.40' })] }));
    expect(row(flat, `${OTM}::0.30-0.40`).cost.form).toBe('flat');
    const net = buildQualificationMatrix(
      inputs({ cells: [cell({ bucket: '0.30-0.40' })], netEdgeFormEnabled: true }),
    );
    expect(row(net, `${OTM}::0.30-0.40`).cost.form).toBe('net_edge');
  });
});

describe('qualification-matrix — BLIND is not a clean bill', () => {
  it('a null table reads blind, not none_qualify', () => {
    const m = buildQualificationMatrix(inputs({ cells: null }));
    expect(m.overall).toBe('blind');
    expect(m.note).toMatch(/BLIND/);
    expect(m.note).toMatch(/NOT a clean bill/);
    expect(m.rows).toEqual([]);
  });

  it('an empty-but-folded table reads none_qualify — the two are distinguishable', () => {
    const m = buildQualificationMatrix(inputs({ cells: [] }));
    expect(m.overall).toBe('none_qualify');
  });
});

describe('qualification-matrix — the live 2026-09-24 shape', () => {
  // The whole live table shape, reduced to its discriminating cells. This is the
  // regression that proves the view answers TRA-4885's question.
  const live = buildQualificationMatrix(
    inputs({
      cells: [
        cell({ bucket: '0.30-0.40', n: 124, lowerCI95: -0.21537527374778787 }),
        cell({ bucket: '0.20-0.30', n: 66, lowerCI95: -0.06310332016754869 }),
        cell({ bucket: '0.50-0.55', n: 110, lowerCI95: 0.3616776161237637, nRealFill: 5 }),
        cell({ structure: 'single_leg_rv', bucket: '0.45-0.50', n: 118, lowerCI95: 0.19517218482330645 }),
        cell({ structure: 'single_leg_directional', bucket: '0.40-0.45', n: 4, lowerCI95: -0.6543517484629646 }),
      ],
      // The RETAINED 30-day fold as bqb1 `a158c516` served it on 2026-09-24 —
      // deliberately NOT the single ET day, because the pooled window is where
      // the level-for-rate trap lives: it holds 428 admits on
      // `single_leg_otm::0.50-0.55`, all of them ≥23 days stale.
      gateCells: [
        { cell: `${OTM}::0.30-0.40`, evaluated: 6853, blocked: 6853, blockRate: 1 },
        { cell: `${OTM}::0.20-0.30`, evaluated: 5002, blocked: 5002, blockRate: 1 },
        { cell: `${OTM}::0.50-0.55`, evaluated: 2055, blocked: 1627, blockRate: 0.7917 },
        { cell: 'single_leg_rv::0.55-1.00', evaluated: 718, blocked: 718, blockRate: 1 },
        { cell: 'single_leg_rv::0.50-0.55', evaluated: 5, blocked: 5, blockRate: 1 },
      ],
      gateCellDays: [
        // 0.50-0.55: admitted on its first three days, then nominated twice more
        // and blocked, then never nominated again.
        { etDay: '2026-08-28', cell: `${OTM}::0.50-0.55`, evaluated: 387, blocked: 168 },
        { etDay: '2026-08-31', cell: `${OTM}::0.50-0.55`, evaluated: 100, blocked: 0 },
        { etDay: '2026-09-01', cell: `${OTM}::0.50-0.55`, evaluated: 109, blocked: 0 },
        { etDay: '2026-09-02', cell: `${OTM}::0.50-0.55`, evaluated: 1459, blocked: 1459 },
        { etDay: '2026-09-22', cell: 'single_leg_rv::0.50-0.55', evaluated: 5, blocked: 5 },
        { etDay: '2026-09-24', cell: `${OTM}::0.30-0.40`, evaluated: 1799, blocked: 1799 },
        { etDay: '2026-09-24', cell: `${OTM}::0.20-0.30`, evaluated: 1211, blocked: 1211 },
        { etDay: '2026-09-24', cell: 'single_leg_rv::0.55-1.00', evaluated: 29, blocked: 29 },
      ],
      gateEvaluated: 14633,
      gateBlocked: 14205,
      netEdgeShadow: {
        rowsEvaluated: 14633,
        flatFormAdmits: 428,
        sweep: [
          [0.4, 554], [0.45, 639], [0.5, 706], [0.5876, 847],
          [0.65, 933], [0.75, 1129], [1, 1473], [1.25, 1718],
        ].map(([k, admits]) => ({ k: k!, admits: admits!, admitRate: admits! / 14633 })),
      },
    }),
  );

  it('nothing qualifies, and the reason is NOT uniformly cost', () => {
    expect(live.overall).toBe('none_qualify');
    const reasons = Object.fromEntries(live.byResolvedReason.map((b) => [b.reason, b.cells]));
    expect(reasons).toEqual({
      no_bar_setting_admits: 2,
      edge_below_cost_bar: 2,
      insufficient_evidence: 1,
    });
  });

  it('the two cells carrying 11855 of the window\'s blocks fail at bar OFF', () => {
    // i.e. the gate named `cost_bar`, blocking 100% of them, is reporting an
    // EDGE failure. No bar setting — including OFF — moves either one.
    for (const key of [`${OTM}::0.30-0.40`, `${OTM}::0.20-0.30`]) {
      expect(row(live, key).cost.admitsAtBarOff).toBe(false);
      expect(row(live, key).resolvedReason).toBe('no_bar_setting_admits');
      expect(row(live, key).data.lastAdmitEtDay).toBeNull();
    }
  });

  it('the bar-movable cells are the ones that STOPPED being nominated', () => {
    const movable = live.rows.filter((r) => r.resolvedReason === 'edge_below_cost_bar');
    expect(movable.map((r) => r.cellKey).sort()).toEqual([
      `${OTM}::0.50-0.55`,
      'single_leg_rv::0.45-0.50',
    ]);
    // `0.50-0.55` is the only cell the gate EVER admitted, and it has not been
    // nominated since 2026-09-02 while the gate kept running — dormant, not
    // accruing.
    const otm = row(live, `${OTM}::0.50-0.55`);
    expect(otm.data.lastAdmitEtDay).toBe('2026-09-01');
    expect(otm.data.canAccrue).toBe(false);
    expect(otm.nextBindingReason).toBe('insufficient_real_fill_evidence');
    // rv 0.45-0.50 was never nominated at all.
    expect(row(live, 'single_leg_rv::0.45-0.50').liveNominated).toBe(false);
  });

  it('⭐ the deadlock survives a POOLED window holding 428 admits', () => {
    // This is the assertion the pooled-only fold would have failed. The window
    // admit rate is NON-ZERO (428/14633) and the verdict is still DEADLOCK,
    // because every one of those admits is ≥23 ET days stale.
    expect(live.accrual.liveAdmitRate).toBeGreaterThan(0);
    expect(live.accrual.lastAdmitEtDay).toBe('2026-09-01');
    expect(live.accrual.realFillFrozen).toBe(true);
    expect(live.rows.every((r) => r.data.canAccrue === false)).toBe(true);
  });

  it('⭐ the k-sweep admits 1718 at its loosest and STILL nothing qualifies', () => {
    // The pooled sweep is non-zero over this window, so "0 admits at every k" is
    // an ET-DAY fact, not a window fact. The cost column must not be read off
    // the fold sweep — each cell's own bound is what decides it.
    const cite = row(live, `${OTM}::0.30-0.40`).cost.netEdgeShadowCitation!;
    expect(cite.admitsAtEveryK).toBe(true);
    // …and that cell is STILL unreachable at every k, because its bound is < 0.
    expect(cite.interpretation).toMatch(/VACUOUS FOR THIS CELL/);
    expect(live.overall).toBe('none_qualify');
  });

  it('the gate decided cells the expectancy fold did not list, and says so', () => {
    expect(live.join.cellsOnlyInGate).toEqual([
      'single_leg_rv::0.50-0.55',
      'single_leg_rv::0.55-1.00',
    ]);
  });
});
