// TRA-4890 — the VERDICT-COUNT control for the `commissionR` 0.05 → 0.0036 retune.
//
// ── What this file has to be able to fail ────────────────────────────────────
//
// The board called this retune "housekeeping only; it will not create trades".
// Measured on bqb1, that is true of the live `cost_bar` gate and FALSE of the
// pooled promotion arm: the retune drops the live bar 0.385 → 0.3386, and
// `single_leg_otm::0.50-0.55` publishes `lowerCI95 0.36168`, which clears 0.3386
// and does NOT clear 0.385. That cell's real desk rows returned −0.835 R_gate /
// −$497, so promoting it is the expensive direction.
//
// The issue's own instruction is that the retune must be verdict-count
// controlled on BOTH consumers, because they are different predicates:
//
//   1. the `cost_bar` live-enforce gate  (`tapeExpectancyVerdict`)
//   2. the `option-expectancy-table` promotion table (`buildTapeExpectancyTable`)
//
// "Publishing 'blocked count unchanged' off the gate alone is the error this
// issue exists to prevent." The symmetric error is equally available now that
// TRA-4894 has landed — checking only the table's `admittedCells` and declaring
// the gate safe by analogy. So both are counted here, at BOTH bars, and the
// controls are MUTATED: each one is re-run with the real-fill arm's floor
// lowered so that the guard STOPS guarding, and the same assertion then has to
// go the other way. Without that, "0 admitted" is indistinguishable from "this
// fixture could never admit anything".
//
// ⚠ The safety here is NOT that the retune is too small to matter — it is
// 0.0464R, and the cell it flips misses the live bar by only 0.0233R. The safety
// is that TRA-4894's real-fill arm refuses the cell independently, on a
// different population (`nRealFill 5 < 40`). That is a load-bearing dependency,
// which is why this file fails loudly if that arm is ever removed.

import { describe, expect, it } from 'vitest';
import {
  buildTapeExpectancyTable,
  tapeExpectancyCellKey,
  tapeExpectancyVerdict,
  TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
} from './option-tape-expectancy.js';
import { GATE_R_PER_PREMIUM_R, type OptionTradeJournalRecord } from './option-trade-journal.js';
import { admissionBarR, DEFAULT_COST_GATE_CONFIG, type CostGateConfig } from './option-cost-gate.js';

const OTM = 'single_leg_otm';
const T0 = 1_700_000_000_000;
const KEY = tapeExpectancyCellKey(OTM, '0.50-0.55');
const DELTA = 0.52;

/**
 * bqb1's live config: the host sets `OPTION_COST_GATE_SAFETY_MARGIN_R=0.10` and
 * no other cost knob (measured against its env list 2026-09-25), so the
 * `commissionR` DEFAULT is what this retune actually moves on the host.
 */
const liveConfig = (commissionR: number): CostGateConfig => ({
  ...DEFAULT_COST_GATE_CONFIG,
  optionsCost: { ...DEFAULT_COST_GATE_CONFIG.optionsCost, commissionR },
  safetyMarginR: 0.1,
});

/** Live bar before this ticket: 0.05 + 0.235 + 0.10. */
const BAR_BEFORE = liveConfig(0.05);
/** Live bar after this ticket: 0.0036 + 0.235 + 0.10. */
const BAR_AFTER = liveConfig(DEFAULT_COST_GATE_CONFIG.optionsCost.commissionR);

// The live cell, re-derived from the endpoint's own published moments.
const LIVE_N = 110;
const LIVE_MEAN_GATE = 1.12911;
const LIVE_SD_GATE = 4.106600511465177;
/** `nRealFill` the live cell actually carries — well under the arm's floor of 40. */
const LIVE_N_REAL_FILL = 5;

function twoPoint(count: number, mean: number, sd: number): number[] {
  const half = Math.floor(count / 2);
  const odd = count % 2 === 1;
  const d = odd ? sd : sd * Math.sqrt((count - 1) / count);
  const out = [
    ...Array.from({ length: half }, () => mean + d),
    ...Array.from({ length: half }, () => mean - d),
  ];
  if (odd) out.push(mean);
  return out;
}

/** A closed row; `brokerFill` decides whether it counts toward `nRealFill`. */
function row(gateR: number, brokerFill: boolean): OptionTradeJournalRecord {
  const entryFillPremium = 1.0;
  const exitFillPremium = 0.8;
  const netPnlUsd = (gateR * entryFillPremium * 100) / GATE_R_PER_PREMIUM_R;
  return {
    structure: OTM,
    outcome: 'WIN',
    entryDelta: DELTA,
    realizedR: gateR / GATE_R_PER_PREMIUM_R,
    closeTs: T0,
    mode: 'demo',
    contracts: 1,
    ...(brokerFill
      ? { pnlBasis: 'broker-fill', feesUsd: 0.65, entryFillPremium, exitFillPremium, realizedPnlUsd: netPnlUsd }
      : {}),
    markProvenance: {
      markSource: 'quote',
      staleMarkTicks: 0,
      at: T0,
      quoteAtFire: { bid: exitFillPremium, ask: exitFillPremium + 0.05 },
    },
  } as unknown as OptionTradeJournalRecord;
}

/** The live cell: 110 rows, of which only `nRealFill` are broker truth. */
function liveCellRows(nRealFill = LIVE_N_REAL_FILL): OptionTradeJournalRecord[] {
  return twoPoint(LIVE_N, LIVE_MEAN_GATE, LIVE_SD_GATE).map((gateR, i) => row(gateR, i < nRealFill));
}

/**
 * The MUTATION fixture: a cell that lands in the SAME flip window as the live
 * one (`lowerCI95 0.35066`, above 0.3386 and below 0.385) but whose real-fill
 * population is tight and entirely broker truth, so the TRA-4894 arm is
 * satisfied. Its only job is to make the guard stop guarding, so that "0
 * admitted" elsewhere in this file is shown to be a fact about the GUARD rather
 * than a fact about the fixture.
 */
function tightCellRows(): OptionTradeJournalRecord[] {
  return twoPoint(LIVE_N, 0.36, 0.05).map((gateR) => row(gateR, true));
}

function tableOf(rows: OptionTradeJournalRecord[], config: CostGateConfig, minCellRealFillN?: number) {
  return buildTapeExpectancyTable(rows, {
    windowDays: null,
    nowMs: T0,
    config,
    ...(minCellRealFillN === undefined ? {} : { minCellRealFillN }),
  });
}

describe('TRA-4890 §1 — the retune is real, and it does move the bar past this cell', () => {
  it('drops the live bqb1 bar 0.385 → 0.3386, a 0.0464R move', () => {
    expect(admissionBarR(OTM, BAR_BEFORE)).toBeCloseTo(0.385, 10);
    expect(admissionBarR(OTM, BAR_AFTER)).toBeCloseTo(0.3386, 10);
    expect(admissionBarR(OTM, BAR_BEFORE) - admissionBarR(OTM, BAR_AFTER)).toBeCloseTo(0.0464, 10);
  });

  it('the 0.30 floor does NOT pin the retuned bar, so the move is not inert', () => {
    // The trap DEFAULT_COST_GATE_CONFIG's docstring warns about: a floor at or
    // above the model bar makes the cost inputs dead and the gate reads
    // "retuned" while behaving identically. 0.3386 > 0.30, so it reaches.
    expect(admissionBarR(OTM, BAR_AFTER)).toBeGreaterThan(BAR_AFTER.optionsMinGrossR);
  });

  it('the POOLED arm genuinely flips on this cell — the hazard is real, not hypothetical', () => {
    const cell = tableOf(liveCellRows(), BAR_AFTER).cells.find((c) => c.cellKey === KEY)!;
    expect(cell.n).toBe(LIVE_N);
    expect(cell.lowerCI95!).toBeCloseTo(0.36168, 4);
    // Short of the OLD bar, clear of the NEW one. This is the whole ticket.
    expect(cell.lowerCI95!).toBeLessThan(admissionBarR(OTM, BAR_BEFORE));
    expect(cell.lowerCI95!).toBeGreaterThan(admissionBarR(OTM, BAR_AFTER));
  });
});

describe('TRA-4890 §2 — CONSUMER 1: the cost_bar live-enforce gate', () => {
  it('BLOCKS at both bars, and the verdict count is unchanged by the retune', () => {
    const rows = liveCellRows();
    const before = tapeExpectancyVerdict({ structure: OTM, delta: DELTA }, tableOf(rows, BAR_BEFORE), BAR_BEFORE);
    const after = tapeExpectancyVerdict({ structure: OTM, delta: DELTA }, tableOf(rows, BAR_AFTER), BAR_AFTER);

    expect(before.admit).toBe(false);
    expect(after.admit).toBe(false);
    // The count the board asked about: admitted 0 → 0, blocked 1 → 1.
    expect([before.admit, after.admit].filter(Boolean)).toHaveLength(0);
  });

  it('the REASON moves — pre-retune it is the bar, post-retune it is the real-fill arm', () => {
    // This is the observable the ledger's `byReason` fold will show, and the
    // reason the blocked count can stay flat while the bar moves underneath it.
    const rows = liveCellRows();
    const after = tapeExpectancyVerdict({ structure: OTM, delta: DELTA }, tableOf(rows, BAR_AFTER), BAR_AFTER);
    expect(after.reasonCode).toBe('insufficient_real_fill_evidence');
    expect(after.nRealFill).toBe(LIVE_N_REAL_FILL);
    expect(after.nRealFill).toBeLessThan(TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N);
  });

  it('MUTATED — with the real-fill arm satisfied, the retune DOES admit. The guard is load-bearing.', () => {
    // The discriminator. If this admitted under both bars, or under neither,
    // the "0 admitted" above would be a property of the fixture rather than of
    // the guard, and this whole file would be decorative. Same bars, same flip
    // window; the only change is that the real-fill population is sound.
    const rows = tightCellRows();
    const before = tapeExpectancyVerdict({ structure: OTM, delta: DELTA }, tableOf(rows, BAR_BEFORE), BAR_BEFORE);
    const after = tapeExpectancyVerdict({ structure: OTM, delta: DELTA }, tableOf(rows, BAR_AFTER), BAR_AFTER);
    expect(before.admit).toBe(false); // still short of 0.385
    expect(after.admit).toBe(true); // clears 0.3386 — the retune's real effect
  });

  it('the live cell stays refused even if EVERY one of its 110 rows became broker truth', () => {
    // Stronger than `nRealFill 5 < 40`, and the answer to "so we just need to
    // wait for 40 real fills": the live cell's real-fill bound is 0.35307
    // against a required `barR + boundNoiseR` of 0.39116, so accruing evidence
    // does not promote it — its dispersion is the problem, not its sample size.
    const after = tapeExpectancyVerdict(
      { structure: OTM, delta: DELTA },
      tableOf(liveCellRows(LIVE_N), BAR_AFTER, 1),
      BAR_AFTER,
    );
    expect(after.admit).toBe(false);
    expect(after.nRealFill).toBe(LIVE_N);
    expect(after.loRealFillNet!).toBeLessThan(after.barR + after.boundNoiseR!);
  });
});

describe('TRA-4890 §3 — CONSUMER 2: the option-expectancy-table promotion table', () => {
  it('admits NOTHING at either bar, and holds the flipped cell for the real-fill arm', () => {
    const rows = liveCellRows();
    const before = tableOf(rows, BAR_BEFORE);
    const after = tableOf(rows, BAR_AFTER);

    const admitted = (t: ReturnType<typeof tableOf>) => t.cells.filter((c) => c.admits).map((c) => c.cellKey);
    expect(admitted(before)).toEqual([]);
    expect(admitted(after)).toEqual([]);

    // …but the cell's POOLED arm has flipped underneath that unchanged count,
    // which is exactly the fact a gate-only control would have missed.
    expect(after.cells.find((c) => c.cellKey === KEY)!.admitsPooled).toBe(true);
    expect(before.cells.find((c) => c.cellKey === KEY)!.admitsPooled).toBe(false);
  });

  it('MUTATED — a sound real-fill population and the table DOES promote the cell', () => {
    const after = tableOf(tightCellRows(), BAR_AFTER);
    expect(after.cells.filter((c) => c.admits).map((c) => c.cellKey)).toEqual([KEY]);
    // …and it is the RETUNE that promoted it: the same rows at the old bar don't.
    expect(tableOf(tightCellRows(), BAR_BEFORE).cells.filter((c) => c.admits)).toEqual([]);
  });
});
