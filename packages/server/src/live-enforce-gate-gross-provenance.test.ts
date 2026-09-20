// TRA-4753 — THE COST BAR'S NUMERATOR, STAMPED.
//
// The ticket asks four things; three of them are code questions and this file is
// where they are answered mechanically rather than in prose:
//
//   1. Does the `grossR` compared against `admissionBarR` resolve to a per-CELL
//      constant or to a per-candidate model? §1 answers it by driving the REAL
//      `tapeExpectancyVerdict` with two DIFFERENT candidates against ONE table
//      and asserting the compared value is byte-identical — and by the paired
//      negative control, which refolds the tape and shows the same candidate's
//      number MOVE. Dispersion in a pooled cell is a TIME axis, never a
//      candidate axis, and that is the whole explanation of why
//      `single_leg_otm::0.50-0.55` looked per-candidate while the other three
//      cells were pinned.
//   2. Is the stamp the value AS APPLIED, or a re-read of today's estimator?
//      §2 pins that the stamp carries the fold's own `computedAt`, `n`, tape
//      window and demo/live split, and that a LATER fold cannot rewrite it.
//   3. Is tape staleness separable from recompute freshness? §3 — `tapeAgeMs`
//      is measured from the cell's own `toTs` to the DECISION instant, so a
//      60s-TTL recompute over a seven-week-old population cannot read fresh.
//
// Nothing here hand-builds a verdict or a stamp where the real function can
// produce one: a branch added to `tapeExpectancyVerdict` that this module
// mis-classifies must fail HERE, not on the live payload.

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearLiveEnforceGateLedger,
  hydrateLiveEnforceGateFromDisk,
  recordLiveEnforceDecision,
  summarizeLiveEnforceGate,
} from './live-enforce-gate-ledger.js';
import {
  foldGrossRProvenance,
  resetGrossRProvenanceMemoForTests,
  tapeExpectancyGrossProvenance,
  type GrossRProvenance,
} from './live-enforce-gate-gross-provenance.js';
import {
  buildTapeExpectancyTable,
  tapeEdgeR,
  tapeExpectancyVerdict,
  type TapeExpectancyTable,
} from './option-tape-expectancy.js';
import { DEFAULT_COST_GATE_CONFIG } from './option-cost-gate.js';
import { OTM_SLEEVE_MANDATE_STRUCTURE } from './otm-sleeve-mandate.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const OTM = OTM_SLEEVE_MANDATE_STRUCTURE;
/** Two deltas INSIDE the same ratified-band bucket, so they select one cell. */
const DELTA_A = 0.505;
const DELTA_B = 0.545;
/** Seven weeks before the decisions below — the live 2026-08-03/04 shape. */
const TAPE_CLOSE_TS = Date.UTC(2026, 7, 4, 20, 0, 0);
const DECIDED_AT = Date.UTC(2026, 8, 20, 6, 22, 0);

function row(
  entryDelta: number,
  realizedR: number,
  mode: 'demo' | 'live',
  closeTs = TAPE_CLOSE_TS,
): OptionTradeJournalRecord {
  return {
    structure: OTM,
    outcome: realizedR >= 0 ? 'WIN' : 'LOSS',
    entryDelta,
    realizedR,
    closeTs,
    mode,
  } as unknown as OptionTradeJournalRecord;
}

/**
 * A fold with a deliberately LOSING cell, so the bound sits under the bar and
 * the gate refuses — the live shape this ticket was cut on. `demoN`/`liveN` set
 * the mode split the stamp must carry; `realizedR` is PREMIUM R (gate R is 4x).
 */
function tableOf(opts: {
  computedAt: number;
  realizedR?: number;
  demoN?: number;
  liveN?: number;
  closeTs?: number;
}): TapeExpectancyTable {
  const realizedR = opts.realizedR ?? -0.05;
  const demoN = opts.demoN ?? 123;
  const liveN = opts.liveN ?? 1;
  const rows: OptionTradeJournalRecord[] = [
    // Two deltas, so the cell is genuinely pooled across candidates — a cell
    // built from one delta could not distinguish "per cell" from "per delta".
    ...Array.from({ length: demoN }, (_, i) =>
      row(i % 2 === 0 ? DELTA_A : DELTA_B, realizedR + (i % 7) * 0.01, 'demo', opts.closeTs)),
    ...Array.from({ length: liveN }, () => row(DELTA_A, realizedR, 'live', opts.closeTs)),
  ];
  return buildTapeExpectancyTable(rows, {
    config: DEFAULT_COST_GATE_CONFIG,
    nowMs: opts.computedAt,
  });
}

beforeEach(() => {
  resetGrossRProvenanceMemoForTests();
});

// ── §1 — ASK 1: per-cell constant, or per-candidate model? ───────────────────

describe('TRA-4753 §1 — the compared grossR is a property of the CELL', () => {
  it('two different candidates in one cell are compared against the IDENTICAL number', () => {
    const table = tableOf({ computedAt: DECIDED_AT - 60_000 });
    const a = tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, table, DEFAULT_COST_GATE_CONFIG);
    const b = tapeExpectancyVerdict({ structure: OTM, delta: DELTA_B }, table, DEFAULT_COST_GATE_CONFIG);

    // The candidates differ; the compared value does not, to the last bit.
    expect(DELTA_A).not.toBe(DELTA_B);
    expect(a.cellKey).toBe(b.cellKey);
    expect(tapeEdgeR(a)).toBe(tapeEdgeR(b));
    // …and it IS the cell's lower CI bound, read straight out of the table.
    const cell = table.cells.find((c) => c.cellKey === a.cellKey)!;
    expect(tapeEdgeR(a)).toBe(cell.lowerCI95);

    const stampA = tapeExpectancyGrossProvenance(table, a);
    const stampB = tapeExpectancyGrossProvenance(table, b);
    expect(stampA.perCandidate).toBe(false);
    expect(stampA.kind).toBe('tape_cell_lower_ci95');
    expect(stampA.grossR).toBe(cell.lowerCI95);
    // Interned: same cell, same fold ⇒ literally the same object, which is what
    // keeps a 20k-decision day from allocating 20k stamps.
    expect(stampB).toBe(stampA);
  });

  it('NEGATIVE CONTROL — a REFOLD moves the same candidate\'s number, and the stamp says so', () => {
    const gen1 = tableOf({ computedAt: DECIDED_AT - 86_400_000, realizedR: -0.05 });
    const gen2 = tableOf({ computedAt: DECIDED_AT, realizedR: 0.22 });
    const v1 = tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, gen1, DEFAULT_COST_GATE_CONFIG);
    const v2 = tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, gen2, DEFAULT_COST_GATE_CONFIG);

    // ONE candidate, TWO folds, two different compared values. This is the ONLY
    // axis that can produce dispersion inside a pooled cell — so a cell with a
    // spread is a cell whose tape moved, never a cell that modelled per
    // candidate.
    expect(tapeEdgeR(v1)).not.toBe(tapeEdgeR(v2));
    const s1 = tapeExpectancyGrossProvenance(gen1, v1);
    const s2 = tapeExpectancyGrossProvenance(gen2, v2);
    expect(s1.estimatorGeneration).not.toBe(s2.estimatorGeneration);
    expect(s1.grossR).not.toBe(s2.grossR);
    expect(s1.perCandidate).toBe(false);
    expect(s2.perCandidate).toBe(false);
  });

  it('every stamp names a CONCRETE source — the ticket\'s acceptance field', () => {
    const table = tableOf({ computedAt: DECIDED_AT });
    const compared = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, table, DEFAULT_COST_GATE_CONFIG),
    );
    expect(compared.source).toContain('tapeEdgeR');
    expect(compared.source).toContain('lowerCI95');
    expect(compared.source).toContain(compared.cellKey!);

    // The three non-comparing branches still know where they looked, and they
    // carry NO `grossR` — publishing the bound there would assert a comparison
    // that never ran, which is the TRA-4745 defect on the numerator axis.
    const unmeasured = tapeExpectancyGrossProvenance(
      tableOf({ computedAt: DECIDED_AT, demoN: 3, liveN: 0 }),
      tapeExpectancyVerdict(
        { structure: OTM, delta: DELTA_A },
        tableOf({ computedAt: DECIDED_AT, demoN: 3, liveN: 0 }),
        DEFAULT_COST_GATE_CONFIG,
      ),
    );
    expect(unmeasured.kind).toBe('tape_cell_unmeasured');
    expect(unmeasured.grossR).toBeNull();
    expect(unmeasured.source).not.toBe('');

    const noCell = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: Number.NaN }, table, DEFAULT_COST_GATE_CONFIG),
    );
    expect(noCell.kind).toBe('no_cell');
    expect(noCell.grossR).toBeNull();
    expect(noCell.source).not.toBe('');

    const unfolded = tapeExpectancyGrossProvenance(
      null,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, null, DEFAULT_COST_GATE_CONFIG),
    );
    expect(unfolded.kind).toBe('unfolded_tape');
    expect(unfolded.source).not.toBe('');
  });
});

// ── §2 — ASK 2: the value AS APPLIED, not a re-read ──────────────────────────

describe('TRA-4753 §2 — the stamp is the estimator AS APPLIED', () => {
  it('carries the fold generation, n, tape window and demo/live split', () => {
    const table = tableOf({ computedAt: DECIDED_AT - 60_000, demoN: 123, liveN: 1 });
    const stamp = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, table, DEFAULT_COST_GATE_CONFIG),
    );
    expect(stamp.estimatorGeneration).toBe(table.computedAt);
    expect(stamp.n).toBe(124);
    expect(stamp.byMode).toEqual({ demo: 123, live: 1 });
    expect(stamp.tapeToTs).toBe(TAPE_CLOSE_TS);
    expect(stamp.tapeFromTs).toBe(TAPE_CLOSE_TS);
  });

  it('a LATER fold cannot rewrite a stamp already recorded', () => {
    const gen1 = tableOf({ computedAt: DECIDED_AT - 86_400_000, demoN: 123, liveN: 1 });
    const stamp = tapeExpectancyGrossProvenance(
      gen1,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, gen1, DEFAULT_COST_GATE_CONFIG),
    );
    const before = { ...stamp, byMode: { ...stamp.byMode } };
    // The gate refolds and the cell grows. The recorded stamp must be unmoved —
    // `byMode` is COPIED, not referenced, so a live table reference cannot
    // retroactively restate what a past decision was made against.
    tableOf({ computedAt: DECIDED_AT, demoN: 400, liveN: 9 });
    expect({ ...stamp, byMode: { ...stamp.byMode } }).toEqual(before);
  });

  it('a pooled fold publishes ONE generation per fold, and never multiplies byMode', () => {
    const table = tableOf({ computedAt: DECIDED_AT - 60_000, demoN: 123, liveN: 1 });
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: DELTA_A },
      table,
      DEFAULT_COST_GATE_CONFIG,
    );
    expect(verdict.admit).toBe(false); // a losing cell: the live shape
    const stamp = tapeExpectancyGrossProvenance(table, verdict);

    // 2627 refusals, as measured live on `single_leg_otm::0.30-0.40`.
    const fold = foldGrossRProvenance(
      Array.from({ length: 2627 }, (_, i) => ({ provenance: stamp, decidedAt: DECIDED_AT + i })),
    )!;
    expect(fold.rowsStamped).toBe(2627);
    expect(fold.rowsUnstamped).toBe(0);
    expect(fold.distinctGenerations).toBe(1);
    expect(fold.distinctGrossRValues).toBe(1);
    expect(fold.perCandidate).toBe(false);
    // ⭐ The published answer to the ticket: ONE cell-level verdict, replayed.
    expect(fold.constantAcrossRows).toBe(true);
    expect(fold.generations).toHaveLength(1);
    expect(fold.generations[0]!.rows).toBe(2627);
    // The cell held 124 rows. It did NOT hold 2627 × 124.
    expect(fold.generations[0]!.n).toBe(124);
    expect(fold.generations[0]!.byMode).toEqual({ demo: 123, live: 1 });
    expect(fold.sources).toHaveLength(1);
    expect(fold.sources[0]!.rows).toBe(2627);
    expect(fold.sources[0]!.source).toContain('lowerCI95');
  });

  it('two folds in one group read as TWO generations and are NOT constant', () => {
    const gen1 = tableOf({ computedAt: DECIDED_AT - 86_400_000, realizedR: -0.05 });
    const gen2 = tableOf({ computedAt: DECIDED_AT, realizedR: 0.02 });
    const s1 = tapeExpectancyGrossProvenance(
      gen1,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, gen1, DEFAULT_COST_GATE_CONFIG),
    );
    const s2 = tapeExpectancyGrossProvenance(
      gen2,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, gen2, DEFAULT_COST_GATE_CONFIG),
    );
    const fold = foldGrossRProvenance([
      ...Array.from({ length: 5 }, () => ({ provenance: s1, decidedAt: DECIDED_AT - 86_000_000 })),
      ...Array.from({ length: 3 }, () => ({ provenance: s2, decidedAt: DECIDED_AT })),
    ])!;
    expect(fold.distinctGenerations).toBe(2);
    expect(fold.distinctGrossRValues).toBe(2);
    expect(fold.constantAcrossRows).toBe(false);
    // Newest fold first — a reader scanning the head sees what is in force now.
    expect(fold.generations.map((g) => g.rows)).toEqual([3, 5]);
    expect(fold.generations[0]!.estimatorGeneration).toBe(gen2.computedAt);
  });

  it('UNSTAMPED rows are COUNTED, never dropped — the coverage denominator', () => {
    // Every row on disk today predates this deploy. A fold that quietly excluded
    // them would publish a clean one-generation answer over a handful of rows
    // and read as a census.
    const fold = foldGrossRProvenance(
      Array.from({ length: 9558 }, () => ({ provenance: null, decidedAt: DECIDED_AT })),
    )!;
    expect(fold.rowsStamped).toBe(0);
    expect(fold.rowsUnstamped).toBe(9558);
    expect(fold.generations).toEqual([]);
    expect(fold.perCandidate).toBeNull();
    expect(fold.constantAcrossRows).toBe(false);
  });
});

// ── §3 — ASK 3: tape staleness is not recompute freshness ────────────────────

describe('TRA-4753 §3 — tape age is measured from the TAPE, not the recompute', () => {
  it('a fold recomputed SECONDS ago over a seven-week-old tape reads SEVEN WEEKS old', () => {
    // This is the live 2026-09-20 shape exactly: `freshness` read `dirty:
    // false, ageMs 242366` while the population behind the number stopped
    // growing on 2026-08-04.
    const recomputedSecondsAgo = DECIDED_AT - 30_000;
    const table = tableOf({ computedAt: recomputedSecondsAgo });
    const stamp = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, table, DEFAULT_COST_GATE_CONFIG),
    );
    const fold = foldGrossRProvenance([{ provenance: stamp, decidedAt: DECIDED_AT }])!;
    const g = fold.generations[0]!;

    // The RECOMPUTE is 30s old…
    expect(DECIDED_AT - stamp.estimatorGeneration!).toBe(30_000);
    // …and the TAPE is seven weeks old. Two different numbers, two fields.
    expect(g.tapeAgeMsAtLastDecision).toBe(DECIDED_AT - TAPE_CLOSE_TS);
    expect(g.tapeAgeMsAtLastDecision!).toBeGreaterThan(40 * 86_400_000);
    expect(g.tapeToIso).toBe(new Date(TAPE_CLOSE_TS).toISOString());
    expect(fold.tapeAgeMsMaxAtDecision).toBe(DECIDED_AT - TAPE_CLOSE_TS);
  });

  it('the age is dated at the DECISION, so it cannot be back-filled by reading later', () => {
    const table = tableOf({ computedAt: DECIDED_AT });
    const stamp = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, table, DEFAULT_COST_GATE_CONFIG),
    );
    const fold = foldGrossRProvenance([
      { provenance: stamp, decidedAt: DECIDED_AT },
      { provenance: stamp, decidedAt: DECIDED_AT + 3 * 3_600_000 },
    ])!;
    const g = fold.generations[0]!;
    expect(g.rows).toBe(2);
    expect(g.tapeAgeMsAtFirstDecision).toBe(DECIDED_AT - TAPE_CLOSE_TS);
    expect(g.tapeAgeMsAtLastDecision).toBe(DECIDED_AT - TAPE_CLOSE_TS + 3 * 3_600_000);
    // The span is the SESSION, not the fold: one generation can decide all day.
    expect(g.tapeAgeMsAtLastDecision! - g.tapeAgeMsAtFirstDecision!).toBe(3 * 3_600_000);
  });

  it('a cell with no finite closeTs publishes NULL ages, never 0', () => {
    const stamp: GrossRProvenance = {
      source: 'test',
      kind: 'tape_cell_lower_ci95',
      perCandidate: false,
      cellKey: 'x::y',
      estimatorGeneration: DECIDED_AT,
      grossR: -0.2,
      n: 40,
      byMode: {},
      tapeFromTs: null,
      tapeToTs: null,
      windowDays: null,
    };
    const fold = foldGrossRProvenance([{ provenance: stamp, decidedAt: DECIDED_AT }])!;
    expect(fold.generations[0]!.tapeAgeMsAtLastDecision).toBeNull();
    expect(fold.tapeAgeMsMaxAtDecision).toBeNull();
    expect(fold.tapeToTsMax).toBeNull();
  });

  it('an empty row list folds to null, never to a zeroed shape', () => {
    expect(foldGrossRProvenance([])).toBeNull();
  });
});

// ── §4 — END TO END: the field the ticket's acceptance reads ─────────────────
//
// The two sections above grade pure functions. This one drives the REAL ledger
// write path and the REAL summary fold, because the acceptance is about a field
// on `/api/health/live-enforce-gates` and a pure-function suite cannot tell a
// working builder from one nothing calls.

describe('TRA-4753 §4 — the stamp survives record → summarize', () => {
  const DAY = '2026-09-20';
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4753-gross-provenance-'));
    clearLiveEnforceGateLedger();
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
  });
  afterEach(() => {
    clearLiveEnforceGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  function record(stamp: GrossRProvenance | null, ts: number): void {
    recordLiveEnforceDecision('cost_bar', OTM, true, DAY, 'blocked', ts, {
      reasonCode: 'gross_negative',
      cell: stamp?.cellKey ?? 'single_leg_otm::0.50-0.55',
      grossR: stamp?.grossR ?? undefined,
      cost: { costR: 0.3, spreadR: 0.29, feeR: 0.01, costFracOfPremium: 0.1 },
      grossRProvenance: stamp,
    });
  }

  function cellFold(cell: string) {
    const summary = summarizeLiveEnforceGate(DAY, { flatFormBarR: 0.385 });
    const gate = summary.retained.byGate.find((g) => g.gate === 'cost_bar')!;
    return {
      cell: gate.byCell.find((c) => c.cell === cell)!,
      gate,
    };
  }

  it('publishes a CONCRETE named source per cell, and the replay count beside it', () => {
    const table = tableOf({ computedAt: DECIDED_AT - 60_000, demoN: 123, liveN: 1 });
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: DELTA_A },
      table,
      DEFAULT_COST_GATE_CONFIG,
    );
    const stamp = tapeExpectancyGrossProvenance(table, verdict);
    for (let i = 0; i < 40; i += 1) record(stamp, DECIDED_AT + i * 1_000);

    const { cell, gate } = cellFold(stamp.cellKey!);
    const fold = cell.grossRProvenance!;
    // ⭐ The acceptance criterion, read off the published shape.
    expect(fold.sources[0]!.source).not.toBe('');
    expect(fold.sources[0]!.source).toContain('lowerCI95');
    expect(fold.sources[0]!.kind).toBe('tape_cell_lower_ci95');
    expect(fold.rowsStamped).toBe(40);
    expect(fold.rowsUnstamped).toBe(0);
    expect(fold.constantAcrossRows).toBe(true);
    expect(fold.generations[0]!.rows).toBe(40);
    expect(fold.generations[0]!.byMode).toEqual({ demo: 123, live: 1 });
    // …and the tape age behind those 40 refusals, which `freshness.ageMs` cannot
    // see: the fold was recomputed 60s before the first decision.
    expect(fold.generations[0]!.tapeAgeMsAtLastDecision!).toBeGreaterThan(40 * 86_400_000);
    // The gate-wide block carries the same answer in one field.
    expect(gate.grossRProvenance!.rowsStamped).toBe(40);
    expect(gate.grossRProvenance!.constantAcrossRows).toBe(true);
  });

  it('pre-deploy rows hydrate UNSTAMPED and are counted, not hidden', () => {
    const table = tableOf({ computedAt: DECIDED_AT - 60_000 });
    const stamp = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: DELTA_A }, table, DEFAULT_COST_GATE_CONFIG),
    );
    for (let i = 0; i < 5; i += 1) record(stamp, DECIDED_AT + i);
    for (let i = 0; i < 7; i += 1) record(null, DECIDED_AT + 100 + i);

    const fold = cellFold(stamp.cellKey!).cell.grossRProvenance!;
    expect(fold.rowsStamped).toBe(5);
    expect(fold.rowsUnstamped).toBe(7);
  });

  it('⛔ a stamp claiming a comparison with NO value is REFUSED at the write path', () => {
    // `kind: tape_cell_lower_ci95` MEANS "the comparison ran against this
    // number". Recording it with a null value would publish a comparison with
    // no left side — the TRA-4745 defect, re-opened on the numerator axis.
    record(
      {
        source: 'a source',
        kind: 'tape_cell_lower_ci95',
        perCandidate: false,
        cellKey: 'single_leg_otm::0.50-0.55',
        estimatorGeneration: DECIDED_AT,
        grossR: null,
        n: 40,
        byMode: { demo: 40 },
        tapeFromTs: TAPE_CLOSE_TS,
        tapeToTs: TAPE_CLOSE_TS,
        windowDays: null,
      },
      DECIDED_AT,
    );
    // …and so is a BLANK source, which is the exact thing the acceptance
    // forbids the payload from publishing.
    record(
      {
        source: '',
        kind: 'tape_cell_unmeasured',
        perCandidate: false,
        cellKey: 'single_leg_otm::0.50-0.55',
        estimatorGeneration: DECIDED_AT,
        grossR: null,
        n: 3,
        byMode: { demo: 3 },
        tapeFromTs: TAPE_CLOSE_TS,
        tapeToTs: TAPE_CLOSE_TS,
        windowDays: null,
      },
      DECIDED_AT + 1,
    );

    const fold = cellFold('single_leg_otm::0.50-0.55').cell.grossRProvenance!;
    expect(fold.rowsStamped).toBe(0);
    expect(fold.rowsUnstamped).toBe(2);
  });
});
