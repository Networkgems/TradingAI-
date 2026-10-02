// TRA-4978 (parent TRA-4931) — the remedy half of TRA-4875.
//
// ── WHAT THESE TESTS PIN, AND WHY A TEST IS THE REMEDY ───────────────────────
// TRA-4875's detector publishes `decisionsBlocked: 20678` and calls those cells
// "ENFORCING live refusals off an expectancy constant". Measured on live
// `faae9388` 2026-10-01T18:13Z, that is no longer true of a single one of them:
// `byGate[cost_bar]` reads `rowsCompared: 0, rowsShortCircuited: 1024` with
// `byReason` 100% `insufficient_real_fill_evidence` on each of 2026-09-25, 09-28,
// 09-29, 09-30 and 10-01. The constant is not being read. The number counts
// refusals made WHILE the input was stale; nothing said which were CAUSED by it.
//
// Fixtures below are the LIVE shapes, by cell, so a regression that re-merges the
// two populations fails against the measurement rather than against a guess.
import { describe, expect, it } from 'vitest';
import {
  describeCostBarCellStandDown,
  foldStaleCostBarCells,
  summarizeCostBarSleeveStandDown,
  type CostBarCellLedgerRow,
} from './cost-bar-stale-attribution.js';
import {
  TAPE_EXPECTANCY_MIN_CELL_N,
  TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';

const OTM_030 = 'single_leg_otm::0.30-0.40';
const OTM_020 = 'single_leg_otm::0.20-0.30';

function ledgerRow(over: Partial<CostBarCellLedgerRow> & { cell: string }): CostBarCellLedgerRow {
  return {
    evaluated: 0,
    blocked: 0,
    rowsCompared: 0,
    rowsShortCircuited: 0,
    predicateUnstamped: 0,
    predicateSamples: [],
    inputFreshness: {
      stale: true,
      tapeAgeDaysAtDecisionMax: 57.9,
      tapeToIsoNewest: '2026-08-04T17:00:00.000Z',
    },
    ...over,
  };
}

/** The live since-boot row for `0.30-0.40`: 600/600 blocked, NOTHING compared. */
const SINCE_BOOT_030 = ledgerRow({
  cell: OTM_030,
  evaluated: 600,
  blocked: 600,
  rowsCompared: 0,
  rowsShortCircuited: 600,
  predicateSamples: [{ shortCircuit: 'insufficient_real_fill_evidence' }],
});

/** The live retained row for `0.30-0.40`: a MIX — 4226 compared, 4248 not. */
const RETAINED_030 = ledgerRow({
  cell: OTM_030,
  evaluated: 11728,
  blocked: 11617,
  rowsCompared: 4226,
  rowsShortCircuited: 4248,
  predicateUnstamped: 2627,
  predicateSamples: [
    { shortCircuit: 'insufficient_real_fill_evidence' },
    { shortCircuit: null },
  ],
  inputFreshness: {
    stale: true,
    tapeAgeDaysAtDecisionMax: 57.1,
    tapeToIsoNewest: '2026-08-04T17:00:00.000Z',
  },
});

function tapeCell(over: Partial<TapeExpectancyCell> & { cellKey: string }): TapeExpectancyCell {
  return {
    structure: 'single_leg_otm',
    bucket: '0.30-0.40',
    deltaFrom: 0.3,
    deltaTo: 0.4,
    n: 124,
    droppedUnpricedCloses: 0,
    meanR_gate: -0.1,
    sdR_gate: 0.6,
    seR_gate: 0.05,
    lowerCI95: -0.2154,
    barR: 0.3386,
    admits: false,
    admitsPooled: false,
    admitsRealFill: false,
    nRealFill: 0,
    meanR_gate_realFillNet: null,
    sdR_gate_realFill: null,
    loRealFillNet: null,
    boundNoiseR: null,
    realFillUnavailableReason:
      'nRealFill=0 of n=124 carries broker truth on BOTH legs (< 40 required)',
    provenance: {} as TapeExpectancyCell['provenance'],
    meanR_gate_netOfModelledCross: null,
    lowerCI95_netOfModelledCross: null,
    netOfModelledCross: {} as TapeExpectancyCell['netOfModelledCross'],
    ...over,
  };
}

/** The live `0.20-0.30` cell: the POINT estimate is positive and still refuses. */
const CELL_020 = tapeCell({
  cellKey: OTM_020,
  bucket: '0.20-0.30',
  deltaFrom: 0.2,
  deltaTo: 0.3,
  n: 66,
  meanR_gate: 0.1252,
  lowerCI95: -0.0631,
  realFillUnavailableReason:
    'nRealFill=0 of n=66 carries broker truth on BOTH legs (< 40 required)',
});
const CELL_030 = tapeCell({ cellKey: OTM_030 });

// ── §1 — the attribution split ───────────────────────────────────────────────

describe('TRA-4978 §1 — a refusal made upstream of the constant is not a staleness refusal', () => {
  it('reproduces the live since-boot shape: 600 blocked, 0 governed by the stale input', () => {
    const [cell] = foldStaleCostBarCells([SINCE_BOOT_030]);

    // The TRA-4875 number is UNCHANGED — the split is published beside it, so a
    // reader holding the old value can reconcile rather than re-derive.
    expect(cell!.decisionsBlocked).toBe(600);

    // ⭐ AC2: the constant decided NOTHING. Refreshing the tape moves no decision.
    expect(cell!.decisionsDecidedByStaleInput).toBe(0);
    expect(cell!.decisionsShortCircuitedUpstream).toBe(600);
    expect(cell!.staleInputGovernsDecisions).toBe(false);
    expect(cell!.shortCircuitReasonsSampled).toEqual(['insufficient_real_fill_evidence']);
  });

  it('a cell that DID compare reports the comparison count, so the fix is not "always zero"', () => {
    const [cell] = foldStaleCostBarCells([RETAINED_030]);
    expect(cell!.decisionsDecidedByStaleInput).toBe(4226);
    expect(cell!.decisionsShortCircuitedUpstream).toBe(4248);
    expect(cell!.staleInputGovernsDecisions).toBe(true);
    // Unstamped rows are published, never folded into either side: their tape age
    // is unknown and unknown is not fresh (the TRA-4875 three-valued contract).
    expect(cell!.decisionsUnstamped).toBe(2627);
  });

  it('two folds of one cell keep the OLDEST tape and the LARGEST counts', () => {
    // The inline version this replaced skipped the count merge whenever the newer
    // row read a lower age, so the since-boot refusals vanished. Order-invariant
    // both ways, because the route's argument order must not be load-bearing.
    for (const folds of [
      [[RETAINED_030], [SINCE_BOOT_030]],
      [[SINCE_BOOT_030], [RETAINED_030]],
    ]) {
      const [cell] = foldStaleCostBarCells(...folds);
      expect(cell!.tapeAgeDaysAtDecisionMax).toBe(57.9); // the WORSE reading
      expect(cell!.decisionsBlocked).toBe(11617);
      expect(cell!.decisionsDecidedByStaleInput).toBe(4226);
      expect(cell!.decisionsShortCircuitedUpstream).toBe(4248);
      // Sampled codes UNION across folds — a sample can witness, never bound.
      expect(cell!.shortCircuitReasonsSampled).toEqual(['insufficient_real_fill_evidence']);
    }
  });

  it('`stale: null` and `stale: false` never enter the fold — unknown is not a staleness finding', () => {
    expect(
      foldStaleCostBarCells([
        ledgerRow({ cell: OTM_020, blocked: 9, inputFreshness: { stale: null, tapeAgeDaysAtDecisionMax: null, tapeToIsoNewest: null } }),
        ledgerRow({ cell: OTM_030, blocked: 9, inputFreshness: { stale: false, tapeAgeDaysAtDecisionMax: 1, tapeToIsoNewest: null } }),
        ledgerRow({ cell: 'single_leg_otm::0.40-0.45', blocked: 9, inputFreshness: null }),
      ]),
    ).toEqual([]);
  });
});

// ── §2 — the stand-down verdict (item 2, design (a)) ─────────────────────────

describe('TRA-4978 §2 — the cell-level NOT TRADEABLE verdict', () => {
  it('names BOTH arms and says a tape refresh alone cannot move it', () => {
    const sd = describeCostBarCellStandDown(OTM_020, CELL_020);
    expect(sd.tradeable).toBe(false);
    expect(sd.reasonCodes).toEqual([
      'pooled_bound_below_bar',
      'insufficient_real_fill_evidence',
    ]);
    // ⭐ AC3 — the surviving binding constraint WITH its measured number.
    expect(sd.nRealFill).toBe(0);
    expect(sd.minRealFillN).toBe(TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N);
    // AC2's "legitimate and important answer": the pooled bound is 0.4017 R under
    // the bar, so this cell refuses 100% on ANY vintage of the tape.
    expect(sd.pooledShortfallR).toBeCloseTo(0.4017, 4);
    // ⭐ A DEDUCTION, not a forecast: the real-fill arm counts broker-truth rows,
    // which a recency refresh does not produce.
    expect(sd.recencyAloneCanAdmit).toBe(false);
    expect(sd.statement).toContain('STOOD DOWN');
    expect(sd.statement).toContain('A TAPE REFRESH ALONE CANNOT CHANGE THIS');
  });

  it('above the real-fill floor it declines to guess rather than asserting false', () => {
    const sd = describeCostBarCellStandDown(
      OTM_020,
      tapeCell({ ...CELL_020, nRealFill: TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N, cellKey: OTM_020 }),
    );
    expect(sd.recencyAloneCanAdmit).toBeNull();
    expect(sd.reasonCodes).toContain('real_fill_bound_below_bar');
    expect(sd.reasonCodes).not.toContain('insufficient_real_fill_evidence');
  });

  it('an admitting cell reads TRADEABLE — the verdict is not hard-wired to refuse', () => {
    const sd = describeCostBarCellStandDown(
      OTM_020,
      tapeCell({
        cellKey: OTM_020,
        n: TAPE_EXPECTANCY_MIN_CELL_N + 1,
        lowerCI95: 0.5,
        admits: true,
        admitsPooled: true,
        admitsRealFill: true,
        nRealFill: TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
        realFillUnavailableReason: null,
      }),
    );
    expect(sd.tradeable).toBe(true);
    expect(sd.reasonCodes).toEqual([]);
    expect(sd.statement).toContain('TRADEABLE');
    expect(sd.statement).not.toContain('STOOD DOWN');
  });

  it('a cell the estimator does not hold reads NULL, never tradeable and never false', () => {
    const sd = describeCostBarCellStandDown('single_leg_rv::0.55-1.00', null);
    expect(sd.tradeable).toBeNull();
    expect(sd.recencyAloneCanAdmit).toBeNull();
    expect(sd.reasonCodes).toEqual(['cell_absent_from_estimator']);
    expect(sd.statement).toContain('Unknown is NOT tradeable');
  });
});

// ── §3 — the sleeve roll-up (AC1) ────────────────────────────────────────────

describe('TRA-4978 §3 — the sleeve verdict is scoped to what the selector can nominate', () => {
  const FAR = tapeCell({
    cellKey: 'single_leg_otm::0.40-0.45',
    bucket: '0.40-0.45',
    deltaFrom: 0.4,
    deltaTo: 0.45,
    admits: true,
    admitsPooled: true,
    admitsRealFill: true,
    nRealFill: 99,
    lowerCI95: 0.9,
  });

  it('NOT_TRADEABLE over the armed band, naming the binding constraint', () => {
    const v = summarizeCostBarSleeveStandDown({
      structureCells: [CELL_020, CELL_030, FAR],
      sleeve: 'single_leg_otm',
      armedBand: { min: 0.25, max: 0.4 },
      decidedByStaleInput: 0,
      shortCircuitedUpstream: 1024,
    });
    // ⚠️ OVERLAP, not containment: `[0.25, 0.40)` must reach `0.20-0.30`, the cell
    // refusing 99.2% of the live flow. A containment test drops it.
    expect(v.cellsConsidered).toEqual([OTM_020, OTM_030]);
    expect(v.verdict).toBe('NOT_TRADEABLE');
    expect(v.cellsTradeable).toEqual([]);
    expect(v.bindingConstraint).toBe('insufficient_real_fill_evidence');
    expect(v.statement).toContain('EXPECTED STEADY STATE');
    expect(v.statement).toContain('currently deciding NOTHING');
  });

  it('an admitting cell OUTSIDE the band cannot wash the verdict out', () => {
    // The TRA-4875 lesson in reverse: a roll-up over cells no decision depends on
    // is wrong in BOTH directions, and this is the permissive one.
    const unarmed = summarizeCostBarSleeveStandDown({
      structureCells: [CELL_020, CELL_030, FAR],
      sleeve: 'single_leg_otm',
      armedBand: null,
      decidedByStaleInput: 0,
      shortCircuitedUpstream: 1024,
    });
    expect(unarmed.verdict).toBe('TRADEABLE_CELL_PRESENT');
    expect(unarmed.scope).toContain('selector NOT armed');

    const armed = summarizeCostBarSleeveStandDown({
      structureCells: [CELL_020, CELL_030, FAR],
      sleeve: 'single_leg_otm',
      armedBand: { min: 0.25, max: 0.4 },
      decidedByStaleInput: 0,
      shortCircuitedUpstream: 1024,
    });
    expect(armed.verdict).toBe('NOT_TRADEABLE');
  });

  it('no nominable cell reads NOT_MEASURED, which is not a pass', () => {
    const v = summarizeCostBarSleeveStandDown({
      structureCells: [FAR],
      sleeve: 'single_leg_otm',
      armedBand: { min: 0.25, max: 0.4 },
      decidedByStaleInput: 0,
      shortCircuitedUpstream: 0,
    });
    expect(v.verdict).toBe('NOT_MEASURED');
    expect(v.bindingConstraint).toBeNull();
    expect(v.statement).toContain('Unknown is NOT tradeable');
  });

  it('the pooled arm can be the binding constraint when the real-fill arm is satisfied', () => {
    const v = summarizeCostBarSleeveStandDown({
      structureCells: [
        tapeCell({ ...CELL_020, cellKey: OTM_020, nRealFill: 50, admitsRealFill: true }),
        tapeCell({ ...CELL_030, cellKey: OTM_030, nRealFill: 50, admitsRealFill: true }),
      ],
      sleeve: 'single_leg_otm',
      armedBand: { min: 0.25, max: 0.4 },
      decidedByStaleInput: 4226,
      shortCircuitedUpstream: 4248,
    });
    expect(v.verdict).toBe('NOT_TRADEABLE');
    expect(v.bindingConstraint).toBe('pooled_bound_below_bar');
    expect(v.statement).toContain('Mixed causes');
  });
});

// ── §4 — read-only (the whole module) ────────────────────────────────────────

describe('TRA-4978 §4 — nothing here can admit anything', () => {
  it('is a pure fold: the same rows in give the same verdict out, and the inputs are not mutated', () => {
    const rows = [RETAINED_030, SINCE_BOOT_030];
    const before = JSON.stringify(rows);
    const a = foldStaleCostBarCells(rows);
    const b = foldStaleCostBarCells(rows);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    expect(JSON.stringify(rows)).toBe(before);
  });

  it('a stand-down verdict reports the estimator\'s OWN `admits` — it never overrides it', () => {
    // The refusal is the estimator's; this module only publishes it. If these two
    // could disagree, the route would be a second opinion on a live-money
    // admission, which is exactly what it must not be.
    for (const cell of [CELL_020, CELL_030]) {
      expect(describeCostBarCellStandDown(cell.cellKey, cell).tradeable).toBe(cell.admits);
      expect(describeCostBarCellStandDown(cell.cellKey, cell).admits).toBe(cell.admits);
    }
  });

  // Requested on-thread by QuantTrader 2026-10-01T22:18Z, after reading n=293 /
  // n=368 against OTM cells on one build and against RV cells on another and
  // being unable to tell a mis-keyed join from a re-folded population.
  //
  // The join cannot be positional: `describeCostBarCellStandDown` takes the cell
  // KEY, and the route looks the estimator cell up by that exact string. The
  // discriminator a reader can use without the source is that every statement
  // NAMES ITS OWN CELL — verified 4/4 against live `0d81630c` 2026-10-02T01:11Z,
  // where the n=293 / n=368 populations belong to the two RV cells and the armed
  // OTM cells hold n=66 / n=124.
  it('a stand-down names ITS OWN cell, so a mis-keyed or positional join is visible', () => {
    const pairs = [
      [CELL_020, CELL_030],
      [CELL_030, CELL_020],
    ] as const;
    for (const [a, b] of pairs) {
      const sd = describeCostBarCellStandDown(a.cellKey, a);
      expect(sd.statement).toContain(a.cellKey);
      expect(sd.statement).not.toContain(b.cellKey);
      // And the population published beside the key is that key's own.
      expect(sd.n).toBe(a.n);
    }
    // The failing shape, spelled out: a join that handed cell A's key cell B's
    // population would publish B's `n` under A's name, and nothing else in the
    // payload would contradict it.
    const miskeyed = describeCostBarCellStandDown(CELL_020.cellKey, CELL_030);
    expect(miskeyed.n).toBe(CELL_030.n);
    expect(miskeyed.n).not.toBe(CELL_020.n);
  });
});
