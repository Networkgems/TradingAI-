// TRA-4894 (spec TRA-4887 comment `1bf19ac7`) — the REAL-FILL promotion gate.
//
// ── What these controls have to be able to fail ──────────────────────────────
//
// The defect is that `single_leg_otm::0.50-0.55` publishes n=110, mean +1.12911,
// lowerCI95 +0.36168 — and 93 of those 110 rows are DEMO rows booked at the
// pre-trade NBBO mid, while the 23 real desk rows the band produced returned
// −0.835 R_gate / −$497. At the live 0.385 bar the cell refuses by 0.02332.
// TRA-4890's `commissionR` 0.05 → 0.0036 retune moves the bar by 0.0464 and
// FLIPS IT TO `admits: true`, with real money behind it. A mid-booked cell and a
// fill-measured cell read IDENTICALLY in every column that existed before this
// ticket — that is the instrument defect, and it is what §7's six controls are
// each built to catch, every one of them MUTATED.
//
// ⚠ The numbers in this file are not decoration. Controls 1 and 2 reproduce the
// LIVE cell's own mean/sd/lowerCI95 (re-derived from the endpoint's published
// `sdR_gate 4.106600511465177`), so a change that silently moves the pooled
// arithmetic fails here before it reaches a bar debate.

import { describe, expect, it } from 'vitest';
import {
  buildTapeExpectancyTable,
  tapeExpectancyCellKey,
  tapeExpectancyVerdict,
  TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';
import { priceRealFillRow } from './option-real-fill-r.js';
import {
  NORMAL_QUANTILE_975,
  T_QUANTILE_975_EXACT_MAX_DF,
  tQuantile975,
} from './student-t-quantile.js';
import { GATE_R_PER_PREMIUM_R, type OptionTradeJournalRecord } from './option-trade-journal.js';
import { type CostGateConfig } from './option-cost-gate.js';

const OTM = 'single_leg_otm';
const T0 = 1_700_000_000_000;
const KEY = tapeExpectancyCellKey(OTM, '0.50-0.55');

/** The LIVE bar, measured on bqb1 2026-09-24: 0.05 + 0.135 + 0.20 = 0.385R. */
const BAR_LIVE: CostGateConfig = {
  optionsCost: { commissionR: 0.05, makerAdjustedSpreadCrossR: 0.135 },
  equityCost: { commissionR: 0, makerAdjustedSpreadCrossR: 0.02 },
  safetyMarginR: 0.2,
  optionsMinGrossR: 0.3,
};

/**
 * The TRA-4890 retune, as the single knob it actually is: `commissionR`
 * 0.05 → 0.0036, a bar move of 0.0464R. This is the config that flips the live
 * cell under the PRE-TRA-4894 predicate, which is why it appears in two controls.
 */
const BAR_RETUNED: CostGateConfig = {
  ...BAR_LIVE,
  optionsCost: { commissionR: 0.0036, makerAdjustedSpreadCrossR: 0.135 },
};

/**
 * A synthetic CLOSED row.
 *
 * `realizedR` is PREMIUM R (the pooled column is 4× it). `rFillNet` is the GATE
 * R the real-fill arm should see, and the fixture is rigged so it is EXACTLY
 * that: `contracts: 1`, `entryFillPremium: 1.00` ⇒ denominator `1·1·100 = 100`,
 * so `Rfill_net = 4·netPnlUsd/100 = netPnlUsd/25`. With `bidAtFire` defaulting
 * to `exitFillPremium` the exit cross is exactly $0, which keeps the arithmetic
 * legible — and `chargesTheExitLeg` below is the control that proves a NON-zero
 * cross still binds, so the default is not hiding a dead charge.
 */
function row(opts: {
  delta: number;
  realizedR: number;
  rFillNet?: number;
  mode?: 'demo' | 'live';
  brokerFill?: boolean;
  entryFillPremium?: number;
  exitFillPremium?: number;
  bidAtFire?: number | null;
  contracts?: number;
  structure?: string;
  /**
   * When true, `rFillNet` is the row's GROSS gate R and the exit cross is left
   * to bite on top of it. The default (false) compensates, so `rFillNet` is
   * exactly what the arm should publish — which is what makes every other
   * fixture's arithmetic legible, and which is exactly why this escape hatch
   * has to exist: without it no control could tell a live cross from a dead one.
   */
  interpretRAsGross?: boolean;
}): OptionTradeJournalRecord {
  const exitFillPremium = opts.exitFillPremium ?? 0.8;
  const bid = opts.bidAtFire === undefined ? exitFillPremium : opts.bidAtFire;
  const contracts = opts.contracts ?? 1;
  const entryFillPremium = opts.entryFillPremium ?? 1.0;
  const targetPnlUsd = (opts.rFillNet ?? 0) * (entryFillPremium * contracts * 100) / GATE_R_PER_PREMIUM_R;
  const exitCrossUsd = bid === null ? 0 : (exitFillPremium - bid) * 100 * contracts;
  const netPnlUsd = opts.interpretRAsGross ? targetPnlUsd - exitCrossUsd : targetPnlUsd;
  return {
    structure: opts.structure ?? OTM,
    outcome: 'WIN',
    entryDelta: opts.delta,
    realizedR: opts.realizedR,
    closeTs: T0,
    mode: opts.mode ?? 'demo',
    contracts,
    ...(opts.brokerFill
      ? {
          pnlBasis: 'broker-fill',
          feesUsd: 0.65,
          entryFillPremium,
          exitFillPremium,
          realizedPnlUsd: netPnlUsd + exitCrossUsd,
        }
      : {}),
    ...(bid === null ? {} : { markProvenance: { markSource: 'quote', staleMarkTicks: 0, at: T0, quoteAtFire: { bid, ask: bid + 0.05 } } }),
  } as unknown as OptionTradeJournalRecord;
}

/**
 * `count` rows whose GATE-R values have EXACTLY `mean` and sample SD `sd`, via a
 * balanced two-point split: `n/2` at `mean+d`, `n/2` at `mean−d`, plus a single
 * centre row when `n` is odd. `d = sd·√((n−1)/n)` for the even case and `d = sd`
 * for the odd one — derived, not fitted, so the control's own inputs are checked
 * by the `toBeCloseTo` on mean/sd rather than assumed.
 */
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

function cellOf(
  rows: OptionTradeJournalRecord[],
  config: CostGateConfig,
  minCellRealFillN?: number,
): TapeExpectancyCell {
  const t = buildTapeExpectancyTable(rows, {
    windowDays: null,
    nowMs: T0,
    config,
    ...(minCellRealFillN === undefined ? {} : { minCellRealFillN }),
  });
  const found = t.cells.find((c) => c.cellKey === KEY);
  if (!found) throw new Error(`no ${KEY} in [${t.cells.map((c) => c.cellKey).join(', ')}]`);
  return found;
}

// ── The live cell, as measured on bqb1 2026-09-24T23:30Z ─────────────────────
const LIVE_N = 110;
const LIVE_MEAN_GATE = 1.12911;
const LIVE_SD_GATE = 4.106600511465177;

/** The live cell's 110 rows, mid-booked: NO `broker-fill` stamp anywhere. */
function liveCellRowsMidBooked(): OptionTradeJournalRecord[] {
  return twoPoint(LIVE_N, LIVE_MEAN_GATE, LIVE_SD_GATE).map((gateR) =>
    row({ delta: 0.52, realizedR: gateR / GATE_R_PER_PREMIUM_R }));
}

/** The same 110 rows with every one of them GRANTED a real fill at the same R. */
function liveCellRowsAllRealFill(): OptionTradeJournalRecord[] {
  return twoPoint(LIVE_N, LIVE_MEAN_GATE, LIVE_SD_GATE).map((gateR) =>
    row({
      delta: 0.52,
      realizedR: gateR / GATE_R_PER_PREMIUM_R,
      rFillNet: gateR,
      mode: 'live',
      brokerFill: true,
    }));
}

describe('TRA-4894 §E control 1 — REFUSE-shape: the live cell, nRealFill 0, at BOTH bars', () => {
  const rows = liveCellRowsMidBooked();

  it('reproduces the live cell arithmetic, so the fixture is the cell and not a lookalike', () => {
    const c = cellOf(rows, BAR_LIVE);
    expect(c.n).toBe(110);
    expect(c.meanR_gate).toBeCloseTo(LIVE_MEAN_GATE, 9);
    expect(c.sdR_gate!).toBeCloseTo(LIVE_SD_GATE, 9);
    // The live reading. 4 dp, not 5: the endpoint publishes `meanR_gate` to 5 dp
    // (1.12911) and this fixture is seeded from that rounded value, so the bound
    // it reproduces is short of the live +0.36168 by ~6e-6 of SEED precision.
    // Asserting 5 dp here would be asserting the rounding, not the arithmetic.
    expect(c.lowerCI95!).toBeCloseTo(0.36168, 4);
    expect(c.barR).toBeCloseTo(0.385, 9);
    // …and it refuses by the measured 0.02332.
    expect(c.barR - c.lowerCI95!).toBeCloseTo(0.02332, 4);
    expect(c.barR - c.lowerCI95!).toBeGreaterThan(0);
  });

  it('holds nRealFill 0 with a NAMED reason — never a silent zero', () => {
    const c = cellOf(rows, BAR_LIVE);
    expect(c.nRealFill).toBe(0);
    expect(c.meanR_gate_realFillNet).toBeNull();
    expect(c.sdR_gate_realFill).toBeNull();
    expect(c.loRealFillNet).toBeNull();
    expect(c.boundNoiseR).toBeNull();
    // NEGATIVE CONTROL: the literal an implementation wired to nothing emits.
    expect(c.realFillUnavailableReason).not.toBeNull();
    expect(c.realFillUnavailableReason).toContain('nRealFill=0');
    expect(c.realFillUnavailableReason).toContain('not_broker_fill=110');
  });

  it('REFUSES at the live 0.385 bar under `insufficient_real_fill_evidence`', () => {
    const table = buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0, config: BAR_LIVE });
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, table, BAR_LIVE);
    expect(v.admit).toBe(false);
    // ASSERT THE REASON CODE, not the boolean: at this bar the pooled arm also
    // refuses, so a boolean-only assertion passes for the wrong reason.
    expect(v.reasonCode).toBe('insufficient_real_fill_evidence');
    expect(v.nRealFill).toBe(0);
  });

  it('REFUSES at the TRA-4890 retuned 0.3386 bar — the flip this ticket exists to stop', () => {
    const table = buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0, config: BAR_RETUNED });
    const c = table.cells.find((x) => x.cellKey === KEY)!;
    expect(c.barR).toBeCloseTo(0.3386, 9);

    // THE MUTATION THAT MATTERS: under the PRE-TRA-4894 predicate this cell
    // promotes to capital at the retuned bar. `admitsPooled` is that predicate,
    // published, and it reads TRUE here — so the refusal below is the new arm
    // doing work, not a fixture that could never have admitted.
    expect(c.admitsPooled).toBe(true);
    expect(c.lowerCI95!).toBeGreaterThanOrEqual(c.barR);

    expect(c.admitsRealFill).toBe(false);
    expect(c.admits).toBe(false);
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, table, BAR_RETUNED);
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('insufficient_real_fill_evidence');
    // …and it is NOT reported as a near-miss on the bar, which would send a
    // reader back to the bar. `shortfall_*` is the code that means that.
    expect(v.reasonCode).not.toMatch(/^shortfall_/);
  });
});

describe('TRA-4894 §E control 2 — the REFUSAL SURVIVES the floor: boundNoiseR is the fix', () => {
  it('grants all 110 rows as real fills at bar 0.3386 and STILL refuses', () => {
    const c = cellOf(liveCellRowsAllRealFill(), BAR_RETUNED);
    expect(c.nRealFill).toBe(110);
    expect(c.nRealFill).toBeGreaterThanOrEqual(TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N);
    expect(c.meanR_gate_realFillNet!).toBeCloseTo(LIVE_MEAN_GATE, 9);
    expect(c.sdR_gate_realFill!).toBeCloseTo(LIVE_SD_GATE, 9);

    // The spec's arithmetic, to the 4 dp it published.
    expect(c.loRealFillNet!).toBeCloseTo(0.3531, 4);
    expect(c.barR + c.boundNoiseR!).toBeCloseTo(0.3912, 4);

    // The floor is MET and the cell still refuses — so the fix does not depend
    // on `minCellRealFillN`. That is the whole claim of this control.
    expect(c.admitsRealFill).toBe(false);
    expect(c.admits).toBe(false);
    // And the counterfactual: WITHOUT boundNoiseR the bound clears the bar.
    expect(c.loRealFillNet!).toBeGreaterThan(c.barR);
  });

  it('reproduces spec §4: the z-for-t error at n=30 EXCEEDS the whole bar move', () => {
    // This is the measurement that rejects `z` — and it is a property of the
    // FLOOR region, not of n=110: at the dispersion this cell carries, the
    // normal approximation is worth 0.0639 R at n=30, against the 0.0464 R the
    // TRA-4890 retune moves the bar by. A gate whose own approximation error is
    // larger than the decision it is asked to resolve cannot resolve it.
    const zForTErrorAt = (n: number): number =>
      ((tQuantile975(n - 1)! - NORMAL_QUANTILE_975) * LIVE_SD_GATE) / Math.sqrt(n);
    const BAR_MOVE = 0.05 - 0.0036;
    expect(BAR_MOVE).toBeCloseTo(0.0464, 9);
    expect(zForTErrorAt(30)).toBeCloseTo(0.0639, 4);
    expect(zForTErrorAt(30)).toBeGreaterThan(BAR_MOVE);
    // …and it is still the same order at the floor the gate actually ships with.
    expect(zForTErrorAt(40)).toBeCloseTo(0.0407, 4);

    const c = cellOf(liveCellRowsAllRealFill(), BAR_LIVE);
    expect(c.admitsRealFill).toBe(false);
  });
});

/** 45 real-fill rows at mean +1.0 / sd 1.0 — §E control 3's ADMIT fixture. */
function admitRows(count: number, mean: number, sd: number): OptionTradeJournalRecord[] {
  return twoPoint(count, mean, sd).map((gateR) =>
    row({
      delta: 0.52,
      // The POOLED column is held clear of its own bar in every ADMIT fixture so
      // that the real-fill arm is the only thing that can move the verdict.
      realizedR: 2.0,
      rFillNet: gateR,
      mode: 'live',
      brokerFill: true,
    }));
}

describe('TRA-4894 §E control 3 — the guard GOES GREEN', () => {
  it('45 real-fill rows, mean +1.0, sd 1.0, bar 0.385 ⇒ admits', () => {
    const c = cellOf(admitRows(45, 1.0, 1.0), BAR_LIVE);
    expect(c.n).toBe(45);
    expect(c.nRealFill).toBe(45);
    expect(c.meanR_gate_realFillNet!).toBeCloseTo(1.0, 12);
    expect(c.sdR_gate_realFill!).toBeCloseTo(1.0, 12);

    // t₄₄ = 2.0154 (spec §7.3), NOT z = 1.96.
    expect(tQuantile975(44)!).toBeCloseTo(2.0154, 4);
    expect(c.loRealFillNet!).toBeCloseTo(0.6996, 4);
    expect(c.boundNoiseR!).toBeCloseTo(0.0320, 4);
    expect(c.barR + c.boundNoiseR!).toBeCloseTo(0.4170, 4);

    expect(c.admitsRealFill).toBe(true);
    expect(c.admitsPooled).toBe(true);
    expect(c.admits).toBe(true);
    expect(c.realFillUnavailableReason).toBeNull();

    const table = buildTapeExpectancyTable(admitRows(45, 1.0, 1.0), {
      windowDays: null, nowMs: T0, config: BAR_LIVE,
    });
    const v = tapeExpectancyVerdict({ structure: OTM, delta: 0.52 }, table, BAR_LIVE);
    expect(v.admit).toBe(true);
    expect(v.reasonCode).toBeNull();
    expect(v.nRealFill).toBe(45);
  });
});

describe('TRA-4894 §E control 4 — the green GOES RED on three SINGLE-KNOB mutations', () => {
  it('KNOB 1: n 45 → 39 — the floor, and ONLY the floor', () => {
    const c = cellOf(admitRows(39, 1.0, 1.0), BAR_LIVE);
    expect(c.nRealFill).toBe(39);
    // The BOUND still clears: this mutation isolates the floor, so a floor that
    // was wired to nothing would leave this green.
    expect(c.loRealFillNet!).toBeGreaterThan(c.barR + c.boundNoiseR!);
    expect(c.admitsRealFill).toBe(false);
    expect(c.admits).toBe(false);
    expect(c.realFillUnavailableReason).toContain('nRealFill=39');

    // …and 39 admits the moment the floor itself moves — the floor is the knob.
    expect(cellOf(admitRows(39, 1.0, 1.0), BAR_LIVE, 39).admits).toBe(true);
  });

  it('KNOB 2: sd 1.0 → 2.0 ⇒ lo 0.3991 < need 0.4491', () => {
    const c = cellOf(admitRows(45, 1.0, 2.0), BAR_LIVE);
    expect(c.nRealFill).toBe(45);
    expect(c.sdR_gate_realFill!).toBeCloseTo(2.0, 12);
    expect(c.loRealFillNet!).toBeCloseTo(0.3991, 4);
    expect(c.barR + c.boundNoiseR!).toBeCloseTo(0.4491, 4);
    expect(c.admits).toBe(false);
  });

  it('KNOB 3: mean 1.0 → 0.6 ⇒ lo 0.2996 < need 0.4170', () => {
    const c = cellOf(admitRows(45, 0.6, 1.0), BAR_LIVE);
    expect(c.nRealFill).toBe(45);
    expect(c.meanR_gate_realFillNet!).toBeCloseTo(0.6, 12);
    expect(c.loRealFillNet!).toBeCloseTo(0.2996, 4);
    expect(c.barR + c.boundNoiseR!).toBeCloseTo(0.4170, 4);
    expect(c.admits).toBe(false);
  });
});

describe('TRA-4894 §E control 5 — CAPABILITY: the suite can produce BOTH poles', () => {
  it('nRealFill is not identically 0 and admits is not identically false', () => {
    // If either of these collapses, every REFUSE control above passes against a
    // field wired to nothing and the whole file is vacuous. This is the assert
    // TRA-4578 shipped as `wouldAdmit DID move`, one level up.
    const seenRealFill = [
      cellOf(liveCellRowsMidBooked(), BAR_LIVE).nRealFill,
      cellOf(liveCellRowsAllRealFill(), BAR_RETUNED).nRealFill,
      cellOf(admitRows(45, 1.0, 1.0), BAR_LIVE).nRealFill,
    ];
    expect(seenRealFill).toEqual([0, 110, 45]);
    expect(seenRealFill.some((v) => v > 0)).toBe(true);

    const seenAdmits = [
      cellOf(liveCellRowsMidBooked(), BAR_RETUNED).admits,
      cellOf(liveCellRowsAllRealFill(), BAR_RETUNED).admits,
      cellOf(admitRows(45, 1.0, 1.0), BAR_LIVE).admits,
    ];
    expect(seenAdmits).toEqual([false, false, true]);
    expect(seenAdmits.some((v) => v)).toBe(true);
  });
});

describe('TRA-4894 §E control 6 — ADDITIVE: the pooled columns are byte-identical', () => {
  it('n / meanR_gate / sdR_gate / lowerCI95 / barR do not move, and no cell admits', () => {
    const rows = liveCellRowsMidBooked();
    const before = cellOf(rows, BAR_LIVE);
    // The real-fill arm cannot reach the pooled arithmetic: grant every row a
    // real fill at a WILDLY different R and the pooled columns must not budge.
    const granted = cellOf(
      twoPoint(LIVE_N, LIVE_MEAN_GATE, LIVE_SD_GATE).map((gateR) =>
        row({ delta: 0.52, realizedR: gateR / GATE_R_PER_PREMIUM_R, rFillNet: -99, mode: 'live', brokerFill: true })),
      BAR_LIVE,
    );
    expect(granted.n).toBe(before.n);
    expect(granted.meanR_gate).toBe(before.meanR_gate);
    expect(granted.sdR_gate).toBe(before.sdR_gate);
    expect(granted.lowerCI95).toBe(before.lowerCI95);
    expect(granted.barR).toBe(before.barR);
    expect(granted.admitsPooled).toBe(before.admitsPooled);
    // …and the new column DID move, so the equality above is a real attestation.
    expect(granted.nRealFill).toBe(110);
    expect(granted.meanR_gate_realFillNet!).toBeCloseTo(-99, 9);

    // `admittedCells` — the live regression column — stays empty on this table.
    const table = buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0, config: BAR_RETUNED });
    expect(table.cells.filter((c) => c.admits).map((c) => c.cellKey)).toEqual([]);
    expect(table.minCellRealFillN).toBe(TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N);
    // …and the cell's own mode census stays readable beside the new field.
    expect(table.cells.find((c) => c.cellKey === KEY)!.provenance.byMode).toEqual({ demo: 110 });
  });
});

describe('TRA-4894 §A/§C — the row-level discriminator FAILS NULL, never zero', () => {
  const base = {
    structure: OTM,
    contracts: 2,
    realizedPnlUsd: 100,
    pnlBasis: 'broker-fill' as const,
    entryFillPremium: 1.5,
    exitFillPremium: 2.0,
    markProvenance: { quoteAtFire: { bid: 1.9, ask: 2.1 } },
  };

  it('charges the EXIT LEG ONLY — never the TRA-4674 round trip', () => {
    const p = priceRealFillRow(base);
    // (2.00 − 1.90) × 100 × 2 = $20 charged back off the exit, and NOTHING off
    // the entry: the entry is already the broker fill in the denominator.
    expect(p.exitCrossUsd).toBeCloseTo(20, 9);
    expect(p.netPnlUsd).toBeCloseTo(80, 9);
    // 4 × 80 / (1.5 × 2 × 100) = 1.0666…  ⛔ NOT 4 × 100 / 300 = 1.3333.
    expect(p.rFillNet!).toBeCloseTo((4 * 80) / 300, 12);
    expect(p.rFillNet!).not.toBeCloseTo((4 * 100) / 300, 6);
  });

  it('mirrors the sign on SHORT premium structures', () => {
    const p = priceRealFillRow({ ...base, structure: 'covered_call' });
    // Short buys back the ASK: (2.10 − 2.00) × 100 × 2 = $20, same magnitude,
    // opposite side of the book. A copy-paste of the long branch reads −$20.
    expect(p.exitCrossUsd).toBeCloseTo(20, 9);
  });

  it('names every ignorance case and NEVER charges an absent cross as 0', () => {
    // `Record<string, unknown>`, not `Partial<typeof base>`: several of these
    // patches are the WRONG TYPE on purpose — `quoteAtFire: null` is a real
    // shape the journal writes, and a patch type that forbids it would forbid
    // the control that proves it is handled.
    const cases: [Record<string, unknown>, string][] = [
      [{ pnlBasis: undefined }, 'not_broker_fill'],
      [{ entryFillPremium: 0 }, 'entry_fill_missing'],
      [{ exitFillPremium: Number.NaN }, 'exit_fill_missing'],
      [{ realizedPnlUsd: undefined }, 'realized_pnl_missing'],
      [{ structure: 'vertical_spread' }, 'structure_not_crossable'],
      [{ contracts: undefined }, 'contracts_unknown'],
      [{ markProvenance: undefined }, 'exit_quote_missing'],
      [{ markProvenance: { quoteAtFire: null } }, 'exit_quote_missing'],
      [{ markProvenance: { quoteAtFire: { bid: 0, ask: 2.1 } } }, 'exit_quote_unusable'],
    ];
    for (const [patch, reason] of cases) {
      const p = priceRealFillRow({ ...base, ...patch } as typeof base);
      expect(p.unpriced, reason).toBe(reason);
      // ⛔ The defect reproduced would be `rFillNet` holding the gross number
      // with a 0 cross. Every one of these is NULL on all three money fields.
      expect(p.rFillNet, reason).toBeNull();
      expect(p.netPnlUsd, reason).toBeNull();
      expect(p.exitCrossUsd, reason).toBeNull();
    }
  });

  it('a row whose exit quote is unreadable LEAVES nRealFill and is NAMED', () => {
    // 45 rows that would otherwise admit; strip the exit quote off 10 of them.
    const rows = admitRows(45, 1.0, 1.0);
    for (let i = 0; i < 10; i += 1) {
      delete (rows[i] as unknown as Record<string, unknown>).markProvenance;
    }
    const c = cellOf(rows, BAR_LIVE);
    expect(c.n).toBe(45);
    expect(c.nRealFill).toBe(35);
    expect(c.admits).toBe(false);
    expect(c.realFillUnavailableReason).toContain('exit_quote_missing=10');
  });

  it('a NON-zero exit cross moves the verdict — the charge is not inert', () => {
    // Same 45 rows at mean +1.0 / sd 1.0 on the GROSS basis, but every exit
    // fill beat its bid by $0.20 ⇒ $20/row charged back ⇒ 0.8 gate R off the
    // mean. lo drops from 0.6995 to ~−0.1005 and the green goes red.
    const rows = twoPoint(45, 1.0, 1.0).map((gateR) =>
      row({
        delta: 0.52,
        realizedR: 2.0,
        rFillNet: gateR,
        mode: 'live',
        brokerFill: true,
        exitFillPremium: 0.8,
        bidAtFire: 0.6,
        interpretRAsGross: true,
      }));
    const c = cellOf(rows, BAR_LIVE);
    expect(c.nRealFill).toBe(45);
    expect(c.meanR_gate_realFillNet!).toBeCloseTo(1.0 - 0.8, 9);
    expect(c.admits).toBe(false);
    // NEGATIVE CONTROL: with the charge wired to 0 this cell reads 1.0 and admits.
    expect(c.meanR_gate_realFillNet!).not.toBeCloseTo(1.0, 3);
  });
});

describe('TRA-4894 — the t quantile, and its FALLBACK BOUNDARY', () => {
  it('matches published two-sided 97.5% values on both sides of the seam', () => {
    // Exact-table side.
    expect(tQuantile975(1)!).toBeCloseTo(12.706205, 6);
    expect(tQuantile975(2)!).toBeCloseTo(4.302653, 6);
    expect(tQuantile975(10)!).toBeCloseTo(2.228139, 6);
    expect(tQuantile975(T_QUANTILE_975_EXACT_MAX_DF)!).toBeCloseTo(2.042272, 6);
    // Series side — the published values, to 1e-4.
    expect(tQuantile975(31)!).toBeCloseTo(2.039513, 4);
    expect(tQuantile975(40)!).toBeCloseTo(2.021075, 4);
    expect(tQuantile975(44)!).toBeCloseTo(2.015368, 4);
    expect(tQuantile975(60)!).toBeCloseTo(2.000298, 4);
    expect(tQuantile975(120)!).toBeCloseTo(1.979930, 4);
    expect(tQuantile975(200)!).toBeCloseTo(1.971896, 4);
  });

  it('is CONTINUOUS and STRICTLY DECREASING across the seam — the boundary assert', () => {
    // An unasserted seam reads identically to a correct one. Evaluate the SERIES
    // at the last exact df and require it to agree with the table there.
    const seriesAt30 = 1.959963984540054
      + (7.529123 + 1.959964) / (4 * 30)
      + (5 * 28.9228 + 16 * 7.529123 + 3 * 1.959964) / (96 * 900)
      + (3 * 111.1052 + 19 * 28.9228 + 17 * 7.529123 - 15 * 1.959964) / (384 * 27000);
    expect(seriesAt30).toBeCloseTo(tQuantile975(30)!, 4);

    for (let df = 1; df < 400; df += 1) {
      expect(tQuantile975(df)!, `df ${df}`).toBeGreaterThan(tQuantile975(df + 1)!);
      expect(tQuantile975(df)!, `df ${df}`).toBeGreaterThan(NORMAL_QUANTILE_975);
    }
    // …and it converges to z FROM ABOVE rather than crossing it. Convergence is
    // O(1/df) — the leading term is `(z³+z)/(4·df)` — so the residual at df=1e5
    // is ~2.4e-5, not zero. Asserting a tighter bound there would be asserting a
    // rate the expansion does not have.
    expect(tQuantile975(100_000)! - NORMAL_QUANTILE_975).toBeGreaterThan(0);
    expect(tQuantile975(100_000)! - NORMAL_QUANTILE_975).toBeLessThan(3e-5);
    expect(tQuantile975(1e9)!).toBeCloseTo(NORMAL_QUANTILE_975, 8);
  });

  it('returns NULL below df 1 — never a silently substituted z', () => {
    expect(tQuantile975(0)).toBeNull();
    expect(tQuantile975(-1)).toBeNull();
    expect(tQuantile975(Number.NaN)).toBeNull();
  });
});
