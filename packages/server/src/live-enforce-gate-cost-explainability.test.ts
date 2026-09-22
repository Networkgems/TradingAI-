// TRA-4745 — the published bar must explain its own block rate.
//
// The witness (TRA-4741, comment `47a32c11`, live bqb1 pin `f511ede21c43`): the
// payload published a bar (`arm.costBar.bar.barR` = 0.385R) and a `costR`
// distribution per cell, which together make a falsifiable prediction — the share
// blocked should be the share of the distribution above the bar. It held to
// −1.7pp on `single_leg_otm::0.50-0.55` and missed by **+39.1**, **+56.1** and
// **+98.0pp** on the other three live cells. `single_leg_rv::0.55-1.00` refused
// **633 of 633** at a median `costR` of 0.1645 — 57% BELOW the bar.
//
// The prediction is wrong because `costR` is a TRA-3483 RECORDER and the DEPLOYED
// flat form never reads it: the comparison is `grossR >= barR`, where `grossR` is
// the candidate cell's lower 95% CI bound. The payload published the bar and the
// one quantity the bar is never compared to.
//
// These tests reproduce the witness's two live shapes and assert that the new
// fields resolve each one — while the OLD pair still reads exactly as
// misleadingly as it did. That second half is deliberate: a fix that erases the
// symptom from the suite leaves nothing to keep the fix honest.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveEnforceDecision,
  hydrateLiveEnforceGateFromDisk,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  liveEnforceGateLogPath,
} from './live-enforce-gate-ledger.js';

const DAY = '2026-07-18';
const DAY2 = '2026-07-19';
const BAR = 0.385;
const RV_CELL = 'single_leg_rv::0.55-1.00';
const OTM_CELL = 'single_leg_otm::0.30-0.40';

const LHS_LABEL = "grossR — the cell's LOWER 95% CI bound of realized R_gate (tapeEdgeR)";
const RHS_LABEL = 'barR — admissionBarR(structure)';

/** A row the gate COMPARED: `grossR >= barR` ran, and one side lost. */
function comparedRow(opts: {
  day?: string;
  cell: string;
  structure: string;
  symbol?: string | null;
  grossR: number;
  costR: number;
  ts: number;
}) {
  const blocked = opts.grossR < BAR;
  recordLiveEnforceDecision(
    'cost_bar',
    opts.structure,
    blocked,
    opts.day ?? DAY,
    blocked ? 'under bar' : undefined,
    opts.ts,
    {
      reasonCode: blocked ? 'shortfall_gte_0.50' : undefined,
      cell: opts.cell,
      symbol: opts.symbol === undefined ? 'RIG' : opts.symbol,
      grossR: opts.grossR,
      cost: {
        costR: opts.costR,
        spreadR: opts.costR * 0.82,
        feeR: opts.costR * 0.18,
        costFracOfPremium: 0.1,
      },
      predicate: {
        form: 'tape_expectancy_flat',
        compared: true,
        lhsLabel: LHS_LABEL,
        lhs: opts.grossR,
        op: '>=',
        rhsLabel: RHS_LABEL,
        rhs: BAR,
        admit: !blocked,
        shortCircuit: null,
      },
    },
  );
}

/**
 * ⭐ READING (A), synthesised: the row is REFUSED and stamped `cost_bar`, but the
 * comparison it publishes HOLDS (`grossR >= barR`). Something other than the
 * displayed predicate decided it.
 *
 * This shape cannot be produced by `comparedRow`, which derives `blocked` from
 * the same inequality it publishes and so is consistent by construction — which
 * is exactly why the consistency axis needs its own fixture rather than being
 * asserted against rows that can never violate it.
 */
function misattributedRow(opts: {
  day?: string;
  cell: string;
  structure: string;
  grossR: number;
  costR: number;
  ts: number;
}) {
  recordLiveEnforceDecision(
    'cost_bar',
    opts.structure,
    true,
    opts.day ?? DAY,
    'refused for a reason the published predicate does not state',
    opts.ts,
    {
      reasonCode: 'shortfall_gte_0.50',
      cell: opts.cell,
      symbol: 'RIG',
      grossR: opts.grossR,
      cost: {
        costR: opts.costR,
        spreadR: opts.costR * 0.82,
        feeR: opts.costR * 0.18,
        costFracOfPremium: 0.1,
      },
      predicate: {
        form: 'tape_expectancy_flat',
        compared: true,
        lhsLabel: LHS_LABEL,
        lhs: opts.grossR,
        op: '>=',
        rhsLabel: RHS_LABEL,
        rhs: BAR,
        // The verdict says ADMIT and the ledger recorded a BLOCK.
        admit: true,
        shortCircuit: null,
      },
    },
  );
}

/** A row the gate SHORT-CIRCUITED: the cell was never measured, so no inequality ran. */
function shortCircuitRow(opts: {
  day?: string;
  cell: string;
  structure: string;
  symbol?: string | null;
  costR: number;
  ts: number;
}) {
  recordLiveEnforceDecision(
    'cost_bar',
    opts.structure,
    true,
    opts.day ?? DAY,
    'unmeasured cell',
    opts.ts,
    {
      reasonCode: 'insufficient_evidence',
      cell: opts.cell,
      symbol: opts.symbol === undefined ? 'MSFT' : opts.symbol,
      // `grossR` is DELIBERATELY absent — an unmeasured cell has no bound.
      cost: {
        costR: opts.costR,
        spreadR: opts.costR * 0.82,
        feeR: opts.costR * 0.18,
        costFracOfPremium: 0.1,
      },
      predicate: {
        form: 'tape_expectancy_flat',
        compared: false,
        lhsLabel: LHS_LABEL,
        lhs: null,
        op: '>=',
        rhsLabel: RHS_LABEL,
        rhs: null,
        admit: false,
        shortCircuit: 'insufficient_evidence',
      },
    },
  );
}

function costBar() {
  return summarizeLiveEnforceGate(DAY).retained.byGate.find((g) => g.gate === 'cost_bar')!;
}

describe('TRA-4745 — cost_bar explains its own block rate', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-enforce-4745-'));
    clearLiveEnforceGateLedger();
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
  });

  afterEach(() => {
    clearLiveEnforceGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('READING B — the edge collapsed: grossR explains a 100% cell that costR contradicts', () => {
    // The witness's `rv` shape: cheap candidates (median costR well under the
    // 0.385 bar) refused 100%, because the CELL's bound is 0.05.
    for (let i = 0; i < 10; i += 1) {
      comparedRow({
        cell: RV_CELL, structure: 'single_leg_rv', grossR: 0.05, costR: 0.16 + i * 0.001, ts: 1_001 + i,
      });
    }
    const cell = costBar().byCell.find((c) => c.cell === RV_CELL)!;

    // ── The OLD surface, unchanged, still making the wrong prediction ──
    expect(cell.blockRate).toBe(1);
    expect(cell.costRQuantiles!.p50!).toBeLessThan(BAR);
    // i.e. "median cost is far below the bar and yet 100% is blocked" — the
    // contradiction the witness filed. It MUST stay readable here.

    // ── The NEW surface resolves it ──
    const gross = cell.grossRQuantiles!;
    expect(gross.n).toBe(10);
    // Every row in a cell shares the cell's bound, so the block is DEGENERATE.
    expect(gross.min).toBe(0.05);
    expect(gross.max).toBe(0.05);
    expect(gross.p50!).toBeLessThan(BAR);
    // The right side, recorded PER ROW rather than read off current config.
    expect(gross.barR!.p50).toBe(BAR);
    // ⭐ "shortfall of WHAT against WHAT" — answered: `barR − grossR`.
    expect(gross.shortfallR!.p50!).toBeCloseTo(BAR - 0.05, 10);
    // Every row reached the inequality, so this IS an edge/bar decision.
    expect(cell.rowsCompared).toBe(10);
    expect(cell.rowsShortCircuited).toBe(0);
  });

  it('THE THIRD ANSWER — a 100% cell where NO inequality ran at all (compared:false)', () => {
    for (let i = 0; i < 8; i += 1) {
      shortCircuitRow({ cell: OTM_CELL, structure: 'single_leg_otm', costR: 0.2, ts: 1_001 + i });
    }
    const cell = costBar().byCell.find((c) => c.cell === OTM_CELL)!;
    expect(cell.blockRate).toBe(1);
    // NEITHER reading (A) nor (B): the rows never reached a comparison, so no
    // bar move and no `k` can reach them. This is the pair to grade.
    expect(cell.rowsCompared).toBe(0);
    expect(cell.rowsShortCircuited).toBe(8);
    // The edge was UNKNOWN on every row — counted, never published as a zero.
    expect(cell.grossRQuantiles!.n).toBe(0);
    expect(cell.grossRQuantiles!.rowsMissingGrossR).toBe(8);
    expect(cell.grossRQuantiles!.shortfallR).toBeNull();
    expect(cell.grossRQuantiles!.barR).toBeNull();
    // And the sampled row says so in one line.
    expect(cell.predicateSamples).toHaveLength(1);
    expect(cell.predicateSamples[0]!.compared).toBe(false);
    expect(cell.predicateSamples[0]!.shortCircuit).toBe('insufficient_evidence');
    expect(cell.predicateSamples[0]!.lhs).toBeNull();
    expect(cell.predicateSamples[0]!.statement).toContain('NO COMPARISON');
    // The recorder is published BESIDE the comparison, visibly outside it.
    expect(cell.predicateSamples[0]!.costR).toBe(0.2);
  });

  it('publishes ONE sampled BLOCKED row per cell per ET day, deterministically', () => {
    // An admit first — it must never be the row that represents the day.
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', grossR: 0.9, costR: 0.1, ts: 1_001 });
    for (let i = 0; i < 3; i += 1) {
      comparedRow({
        cell: RV_CELL, structure: 'single_leg_rv', grossR: 0.05, costR: 0.16 + i * 0.01, ts: 1_010 + i,
      });
    }
    for (let i = 0; i < 3; i += 1) {
      comparedRow({
        day: DAY2, cell: RV_CELL, structure: 'single_leg_rv', grossR: 0.07, costR: 0.30 + i * 0.01, ts: 1_100 + i,
      });
    }
    const cell = costBar().byCell.find((c) => c.cell === RV_CELL)!;
    expect(cell.predicateSamples.map((p) => p.etDay)).toEqual([DAY, DAY2]);
    // The FIRST blocked row of each day — not the admit, not the last block.
    expect(cell.predicateSamples[0]!.costR).toBe(0.16);
    expect(cell.predicateSamples[0]!.lhs).toBe(0.05);
    expect(cell.predicateSamples[1]!.lhs).toBe(0.07);
    expect(cell.predicateSamples.every((p) => p.compared)).toBe(true);
    expect(cell.predicateSamples[0]!.shortfallR!).toBeCloseTo(BAR - 0.05, 10);
    expect(cell.predicateSamples[0]!.statement).toContain('BLOCK');
    // Re-reading the same fold returns the same rows (no clock, no ordering drift).
    expect(costBar().byCell.find((c) => c.cell === RV_CELL)!.predicateSamples)
      .toEqual(cell.predicateSamples);
  });

  it('joins cost outcomes to SYMBOLS, and publishes the coverage hole as a number', () => {
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', symbol: 'MSFT', grossR: 0.05, costR: 0.16, ts: 1_001 });
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', symbol: 'MSFT', grossR: 0.05, costR: 0.18, ts: 1_002 });
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', symbol: 'NVDA', grossR: 0.9, costR: 0.10, ts: 1_003 });
    // A pre-TRA-4745 row: no symbol at all. It must COUNT, not vanish.
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', symbol: null, grossR: 0.05, costR: 0.20, ts: 1_004 });

    const cb = costBar();
    // ⛔ `bySymbol` is the TRA-4269 ratified counterfactual and stays null here.
    expect(cb.bySymbol).toBeNull();
    const rows = cb.costBySymbol!;
    expect(rows.map((r) => r.symbol)).toEqual(['MSFT', 'NVDA']);
    expect(rows[0]).toMatchObject({ symbol: 'MSFT', evaluated: 2, blocked: 2, blockRate: 1 });
    expect(rows[0]!.grossR!.p50).toBe(0.05);
    // Nearest-rank (not interpolated), so `p50` of [0.16, 0.18] is 0.16 — a
    // value that actually occurred, matching `costRQuantiles`' own convention.
    expect(rows[0]!.costR!.p50).toBe(0.16);
    expect(rows[0]!.costR!.max).toBe(0.18);
    expect(rows[0]!.rowsCompared).toBe(2);
    // The admitted name is on the SAME axis as the blocked ones.
    expect(rows[1]).toMatchObject({ symbol: 'NVDA', evaluated: 1, blocked: 0, blockRate: 0 });
    // ⭐ The hole, published. Without it a short axis reads as a quiet universe.
    expect(cb.costRowsMissingSymbol).toBe(1);
    // The axis never invents a key for the unstamped row.
    expect(rows.reduce((a, r) => a + r.evaluated, 0)).toBe(3);
    expect(cb.evaluated).toBe(4);
  });

  it('the two stamps SURVIVE a redeploy, and a pre-field row hydrates as a counted MISS', () => {
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', symbol: 'RIG', grossR: 0.05, costR: 0.16, ts: 1_001 });
    shortCircuitRow({ cell: OTM_CELL, structure: 'single_leg_otm', symbol: null, costR: 0.2, ts: 1_002 });
    const before = costBar();

    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, 1_100);
    expect(h.records).toBe(2);
    const after = costBar();
    expect(after.costBySymbol).toEqual(before.costBySymbol);
    expect(after.costRowsMissingSymbol).toBe(1);
    expect(after.rowsCompared).toBe(1);
    expect(after.rowsShortCircuited).toBe(1);
    expect(after.predicateUnstamped).toBe(0);
    expect(after.byCell.find((c) => c.cell === RV_CELL)!.predicateSamples)
      .toEqual(before.byCell.find((c) => c.cell === RV_CELL)!.predicateSamples);
  });

  it('a HALF-POPULATED predicate is refused on the write path AND counted', () => {
    recordLiveEnforceDecision(
      'cost_bar', 'single_leg_rv', true, DAY, 'under bar', 1_001,
      {
        reasonCode: 'shortfall_gte_0.50',
        cell: RV_CELL,
        symbol: 'RIG',
        grossR: 0.05,
        cost: { costR: 0.16, spreadR: 0.13, feeR: 0.03, costFracOfPremium: 0.1 },
        // `compared: true` with NO right side — a reader would infer a
        // comparison from a number that decided nothing. Refused.
        predicate: {
          form: 'tape_expectancy_flat',
          compared: true,
          lhsLabel: LHS_LABEL,
          lhs: 0.05,
          op: '>=',
          rhsLabel: RHS_LABEL,
          rhs: null,
          admit: false,
          shortCircuit: null,
        } as never,
      },
    );
    const cb = costBar();
    expect(cb.evaluated).toBe(1);
    // The ROW is recorded; only its malformed predicate is dropped, and the drop
    // is COUNTED rather than silent.
    expect(cb.predicateUnstamped).toBe(1);
    expect(cb.rowsCompared).toBe(0);
    expect(cb.byCell.find((c) => c.cell === RV_CELL)!.predicateSamples).toEqual([]);
    // The line on disk carries no predicate either — a shape the fold refuses to
    // read must be a shape it refuses to write.
    const raw = readFileSync(liveEnforceGateLogPath(dir), 'utf8').trim();
    expect(JSON.parse(raw)).not.toHaveProperty('predicate');
    // …and the `grossR` it DID carry is still published: the stamps are
    // independent, so one bad block must not take the other down with it.
    expect(cb.grossRQuantiles!.n).toBe(1);
  });

  it('is null on every gate that records no cost, and an object at n:0 on cost_bar', () => {
    recordLiveEnforceDecision('universe', 'KVYO', true, DAY, 'not in universe', 1_001, {
      reasonCode: 'not_in_universe',
    });
    const s = summarizeLiveEnforceGate(DAY);
    const cb = s.byGate.find((g) => g.gate === 'cost_bar')!;
    // "Not deployed" and "deployed, no rows yet" must stay distinguishable.
    expect(cb.grossRQuantiles).not.toBeNull();
    expect(cb.grossRQuantiles!.n).toBe(0);
    expect(cb.costBySymbol).toEqual([]);
    expect(cb.costRowsMissingSymbol).toBe(0);
    expect(cb.rowsCompared).toBe(0);
    expect(cb.rowsPredicateInconsistent).toBe(0);
    for (const g of s.byGate.filter((x) => x.gate !== 'cost_bar')) {
      expect(g.grossRQuantiles).toBeNull();
      expect(g.costBySymbol).toBeNull();
      expect(g.costRowsMissingSymbol).toBeNull();
      expect(g.rowsCompared).toBeNull();
      expect(g.rowsPredicateInconsistent).toBeNull();
    }
  });

  // ── The statement says whether the comparison HELD, and (A) is counted ─────
  //
  // The live route rendered `grossR -0.2154 >= barR 0.3850 ⇒ BLOCK`: an
  // inequality, then a refusal, with nothing saying the inequality was FALSE.
  // Scanned quickly that reads as reading (A) — the exact mis-read this ticket
  // exists to kill, reproduced inside its own fix.

  it('a blocked row renders its comparison as FALSE, not as a bare assertion', () => {
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', grossR: 0.05, costR: 0.16, ts: 1_001 });
    const sample = costBar().byCell.find((c) => c.cell === RV_CELL)!.predicateSamples[0]!;
    expect(sample.holds).toBe(false);
    expect(sample.outcomeConsistent).toBe(true);
    expect(sample.statement).toContain('→ FALSE ⇒ BLOCK');
    // …and it must NOT be flagged: a false predicate on a blocked row is the
    // gate working exactly as published.
    expect(sample.statement).not.toContain('INCONSISTENT');
  });

  it('an admitted row renders TRUE — the truth value tracks the NUMBERS', () => {
    comparedRow({ cell: RV_CELL, structure: 'single_leg_rv', grossR: BAR + 0.1, costR: 0.16, ts: 1_001 });
    // Admits produce no `predicateSamples` (blocked rows only, by design), so
    // the assertion is on the census pair instead.
    const cell = costBar().byCell.find((c) => c.cell === RV_CELL)!;
    expect(cell.blocked).toBe(0);
    expect(cell.rowsCompared).toBe(1);
    expect(cell.rowsPredicateInconsistent).toBe(0);
  });

  it('⭐ READING A — a HOLDING predicate on a BLOCKED row is counted AND flagged', () => {
    misattributedRow({ cell: RV_CELL, structure: 'single_leg_rv', grossR: BAR + 0.2, costR: 0.16, ts: 1_001 });
    const cb = costBar();
    const cell = cb.byCell.find((c) => c.cell === RV_CELL)!;

    // The row IS a block, and it IS a comparison — so neither existing axis
    // would have noticed anything.
    expect(cell.blockRate).toBe(1);
    expect(cell.rowsCompared).toBe(1);
    expect(cell.rowsShortCircuited).toBe(0);

    // ⭐ …and this is the axis that does.
    expect(cell.rowsPredicateInconsistent).toBe(1);
    expect(cb.rowsPredicateInconsistent).toBe(1);
    const sample = cell.predicateSamples[0]!;
    expect(sample.holds).toBe(true);
    expect(sample.outcomeConsistent).toBe(false);
    expect(sample.statement).toContain('→ TRUE ⇒ BLOCK');
    expect(sample.statement).toContain('INCONSISTENT');
  });

  it('the inconsistency count is a CENSUS, not a sample — it sees rows no sample shows', () => {
    // Ten misattributed rows on ONE day. `predicateSamples` shows exactly one of
    // them (one blocked row per cell per day), so a reader grading off the
    // sample alone could never bound the defect. The counter can.
    for (let i = 0; i < 10; i += 1) {
      misattributedRow({
        cell: RV_CELL, structure: 'single_leg_rv', grossR: BAR + 0.2, costR: 0.16, ts: 1_001 + i,
      });
    }
    // …plus two rows that are entirely in order, so the count is not just
    // "every compared row".
    comparedRow({ cell: OTM_CELL, structure: 'single_leg_otm', grossR: 0.05, costR: 0.2, ts: 2_001 });
    comparedRow({ cell: OTM_CELL, structure: 'single_leg_otm', grossR: 0.05, costR: 0.2, ts: 2_002 });

    const cb = costBar();
    expect(cb.rowsCompared).toBe(12);
    expect(cb.rowsPredicateInconsistent).toBe(10);
    expect(cb.byCell.find((c) => c.cell === RV_CELL)!.rowsPredicateInconsistent).toBe(10);
    // The clean cell stays clean — the axis localises the defect.
    expect(cb.byCell.find((c) => c.cell === OTM_CELL)!.rowsPredicateInconsistent).toBe(0);
    // And the sample surface really does only show one of the ten.
    expect(cb.byCell.find((c) => c.cell === RV_CELL)!.predicateSamples).toHaveLength(1);
  });

  it('a SHORT-CIRCUITED row is neither consistent nor inconsistent — it is not counted', () => {
    // The largest live bucket. Scoring it either way would manufacture a verdict
    // about precisely the rows that ran no comparison at all.
    for (let i = 0; i < 5; i += 1) {
      shortCircuitRow({ cell: RV_CELL, structure: 'single_leg_rv', costR: 0.2, ts: 1_001 + i });
    }
    const cb = costBar();
    expect(cb.rowsShortCircuited).toBe(5);
    expect(cb.rowsCompared).toBe(0);
    // ⛔ Zero here is SILENCE, not an all-clear — read it against `rowsCompared`.
    expect(cb.rowsPredicateInconsistent).toBe(0);
    const sample = cb.byCell.find((c) => c.cell === RV_CELL)!.predicateSamples[0]!;
    expect(sample.holds).toBeNull();
    expect(sample.outcomeConsistent).toBeNull();
    expect(sample.statement).toContain('NO COMPARISON');
  });
});
