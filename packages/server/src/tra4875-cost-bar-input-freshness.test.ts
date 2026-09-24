// TRA-4875 — THE STALENESS FLAG NOTHING CONSUMED, MADE CONSUMABLE.
//
// TRA-4783 computed that the cost_bar edge estimator's own inputs had gone
// stale and published `inputStale: true` on `arm.costBar.edge.freshness`. For
// roughly five weeks nothing read it: the gate went on refusing 11,855 of
// 11,855 live entry-site candidates off a tape frozen in early August, with
// `ok: true` on the same route and no annotation on any decision.
//
// This file pins the three properties that make the new signal worth having,
// and one that makes it safe:
//
//   §1 PER CELL, AT THE DECISION. The age is `decidedAt − tapeToTs` off the
//      row's own stamp, so it cannot be satisfied by re-reading today's
//      estimator, and two cells in one fold can disagree.
//   §2 THREE-VALUED, on the TRA-4783 contract. `false` is a CLEAN pass and
//      nothing else; unknown never renders as fresh.
//   §3 THE GLOBAL FLAG IS NOT A SUBSTITUTE. The measured 2026-09-24 shape —
//      global `true` driven by a cell the armed selector cannot nominate, while
//      the decision-relevant cells are stale for their own, different reason —
//      is reproduced as a fixture, and the per-cell fold separates them.
//   §4 AC3's GUARD, as a property: this is a fold over already-recorded rows.
//      It cannot move a decision, so `blocked`/`evaluated` are byte-identical
//      whatever the freshness verdict says.

import { describe, expect, it, beforeEach } from 'vitest';
import {
  foldGrossRProvenance,
  resetGrossRProvenanceMemoForTests,
  tapeExpectancyGrossProvenance,
  type GrossRProvenance,
} from './live-enforce-gate-gross-provenance.js';
import {
  TAPE_INPUT_STALE_THRESHOLD_DAYS,
  buildTapeExpectancyTable,
  summarizeTapeInputStaleness,
  tapeExpectancyVerdict,
  type TapeExpectancyTable,
} from './option-tape-expectancy.js';
import { DEFAULT_COST_GATE_CONFIG } from './option-cost-gate.js';
import { OTM_SLEEVE_MANDATE_STRUCTURE } from './otm-sleeve-mandate.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const OTM = OTM_SLEEVE_MANDATE_STRUCTURE;
const DAY = 86_400_000;

/** The instant the description's numbers were read live. */
const DECIDED_AT = Date.UTC(2026, 8, 24, 20, 31, 6);
/** `single_leg_otm::0.20-0.30`'s live tape end — 52.3 d before the read. */
const TAPE_END_020 = Date.UTC(2026, 7, 3, 13, 33, 47);
/** `single_leg_otm::0.30-0.40`'s live tape end — 51.1 d before the read. */
const TAPE_END_030 = Date.UTC(2026, 7, 4, 17, 0, 0);

function journalRow(
  entryDelta: number,
  realizedR: number,
  closeTs: number,
): OptionTradeJournalRecord {
  return {
    structure: OTM,
    outcome: realizedR >= 0 ? 'WIN' : 'LOSS',
    entryDelta,
    realizedR,
    mode: 'demo',
    closeTs,
  } as unknown as OptionTradeJournalRecord;
}

/** A table whose single measured cell ends its tape at `closeTs`. */
function tableEndingAt(closeTs: number, delta: number, computedAt: number): TapeExpectancyTable {
  const rows = Array.from({ length: 124 }, (_, i) =>
    // Spread the closes backwards so `toTs` is exactly `closeTs`, and keep the
    // realized R negative so the cell's bound sits under the bar and the gate
    // refuses — which is the state under test.
    journalRow(delta, -0.05, closeTs - i * 60_000),
  );
  return buildTapeExpectancyTable(rows, {
    config: DEFAULT_COST_GATE_CONFIG,
    nowMs: computedAt,
  });
}

function stampFor(closeTs: number, delta: number, computedAt: number): GrossRProvenance {
  const table = tableEndingAt(closeTs, delta, computedAt);
  return tapeExpectancyGrossProvenance(
    table,
    tapeExpectancyVerdict({ structure: OTM, delta }, table, DEFAULT_COST_GATE_CONFIG),
  );
}

function foldRow(provenance: GrossRProvenance | null, decidedAt: number, etDay = '2026-09-24') {
  return { provenance, decidedAt, etDay, grossR: provenance?.grossR ?? null };
}

beforeEach(() => {
  resetGrossRProvenanceMemoForTests();
});

// ── §1 — per cell, at the decision ───────────────────────────────────────────

describe('TRA-4875 §1 — the staleness verdict is per cell and measured at the decision', () => {
  it('publishes the age of the constant AS APPLIED, not of the recompute', () => {
    const stamp = stampFor(TAPE_END_030, 0.35, DECIDED_AT);
    const fold = foldGrossRProvenance(
      Array.from({ length: 1799 }, (_, i) => foldRow(stamp, DECIDED_AT + i)),
    )!;

    // ⭐ AC1: stale yes/no + that cell's tape age in days, on the decision row.
    expect(fold.inputFreshness.stale).toBe(true);
    expect(fold.inputFreshness.tapeAgeDaysAtDecisionMax).toBeCloseTo(51.1, 1);
    expect(fold.inputFreshness.tapeToIsoNewest).toBe(new Date(TAPE_END_030).toISOString());
    expect(fold.inputFreshness.thresholdDays).toBe(TAPE_INPUT_STALE_THRESHOLD_DAYS);
    expect(fold.inputFreshness.rowsStamped).toBe(1799);
    expect(fold.inputFreshness.rowsUnstamped).toBe(0);

    // The refusal count is ONE verdict replayed. Both facts, side by side, are
    // the whole point: 1799 refusals against one frozen number is not 1799
    // measurements of the market.
    expect(fold.constantAcrossRows).toBe(true);

    // ⛔ The statement must not read as a licence to relax the gate.
    expect(fold.inputFreshness.statement).toContain('MUST NOT BE RELAXED');
  });

  it('a FRESH tape on the same code path reads false — the detector is not stuck on', () => {
    const freshEnd = DECIDED_AT - 2 * DAY;
    const fold = foldGrossRProvenance([
      foldRow(stampFor(freshEnd, 0.35, DECIDED_AT), DECIDED_AT),
    ])!;
    expect(fold.inputFreshness.stale).toBe(false);
    expect(fold.inputFreshness.tapeAgeDaysAtDecisionMax).toBeCloseTo(2, 1);
    expect(fold.inputFreshness.statement).toContain('inputs fresh');
  });

  it('the bar is compared on the RAW age — rounding cannot un-trip the flag', () => {
    const justOver = DECIDED_AT - (TAPE_INPUT_STALE_THRESHOLD_DAYS * DAY + 3_600_000);
    const justUnder = DECIDED_AT - (TAPE_INPUT_STALE_THRESHOLD_DAYS * DAY - 3_600_000);
    // ⚠️ DISTINCT `computedAt`. The stamp memo keys on
    // `(kind, cellKey, estimatorGeneration, grossR)` and these two fixtures
    // agree on all four when they share a fold instant — the realized R is
    // identical, so the bound is too, and only the tape WINDOW differs. A real
    // process cannot refold twice at the same millisecond, but a test can, and
    // interning the first stamp for the second table would silently compare
    // `justOver` against itself.
    const over = foldGrossRProvenance([
      foldRow(stampFor(justOver, 0.35, DECIDED_AT - 1), DECIDED_AT),
    ])!;
    const under = foldGrossRProvenance([
      foldRow(stampFor(justUnder, 0.35, DECIDED_AT), DECIDED_AT),
    ])!;
    // Both round to 10.0 days; only the verdict separates them.
    expect(over.inputFreshness.tapeAgeDaysAtDecisionMax).toBe(10);
    expect(under.inputFreshness.tapeAgeDaysAtDecisionMax).toBe(10);
    expect(over.inputFreshness.stale).toBe(true);
    expect(under.inputFreshness.stale).toBe(false);
  });

  it('a REFOLD that does not advance the tape still reads stale — freshness ≠ recompute', () => {
    // Two generations, computed 19 hours apart, over a population whose newest
    // close never moved. `freshness.ageMs` would read seconds on both.
    const g1 = stampFor(TAPE_END_030, 0.35, DECIDED_AT - 19 * 3_600_000);
    const g2 = stampFor(TAPE_END_030, 0.35, DECIDED_AT);
    const fold = foldGrossRProvenance([
      foldRow(g1, DECIDED_AT - 19 * 3_600_000),
      foldRow(g2, DECIDED_AT),
    ])!;
    expect(fold.distinctGenerations).toBe(2);
    expect(fold.inputFreshness.stale).toBe(true);
    // The "as applied right now" reading quotes the MOST RECENT decision, which
    // is not necessarily the one with the oldest tape.
    expect(fold.inputFreshness.tapeAgeDaysAtLastDecision).toBeCloseTo(51.1, 1);
  });
});

// ── §2 — three-valued, on the TRA-4783 contract ──────────────────────────────

describe('TRA-4875 §2 — unknown never renders as fresh', () => {
  it('nothing stamped ⇒ null, and the statement says COVERAGE', () => {
    const fold = foldGrossRProvenance([
      foldRow(null, DECIDED_AT),
      foldRow(null, DECIDED_AT + 1),
    ])!;
    expect(fold.rowsStamped).toBe(0);
    expect(fold.inputFreshness.stale).toBeNull();
    expect(fold.inputFreshness.rowsUnstamped).toBe(2);
    expect(fold.inputFreshness.statement).toContain('COVERAGE');
  });

  it('fresh stamped rows BESIDE unstamped ones ⇒ null, never false', () => {
    // The trap: a handful of post-deploy rows read fresh while thousands of
    // pre-deploy rows carry no tape age at all. Attesting `false` there coerces
    // unknown → healthy, which is exactly the bug one layer up.
    const fresh = stampFor(DECIDED_AT - DAY, 0.35, DECIDED_AT);
    const fold = foldGrossRProvenance([
      foldRow(fresh, DECIDED_AT),
      foldRow(null, DECIDED_AT),
    ])!;
    expect(fold.inputFreshness.stale).toBeNull();
    expect(fold.inputFreshness.statement).toContain('Unknown is NOT fresh');
  });

  it('STALE stamped rows beside unstamped ones stay TRUE — unknown never downgrades an alarm', () => {
    const stale = stampFor(TAPE_END_020, 0.25, DECIDED_AT);
    const fold = foldGrossRProvenance([
      foldRow(stale, DECIDED_AT),
      foldRow(null, DECIDED_AT),
    ])!;
    expect(fold.inputFreshness.stale).toBe(true);
  });
});

// ── §3 — the global flag is not a substitute ─────────────────────────────────

describe('TRA-4875 §3 — the global max is true for the WRONG REASON', () => {
  it('reproduces the 2026-09-24 shape: global driven by a cell nobody nominates', () => {
    // The live fold's worst cell was `0.40-0.45` at 78.1 d. The armed selector's
    // band is [0.25, 0.40), so it can never nominate that cell and no decision
    // depends on it. Build a table holding BOTH a 78-day cell and a 51-day one.
    const nominable = Array.from({ length: 124 }, (_, i) =>
      journalRow(0.35, -0.05, TAPE_END_030 - i * 60_000),
    );
    const notNominable = Array.from({ length: 40 }, (_, i) =>
      journalRow(0.42, -0.05, DECIDED_AT - 78.1 * DAY - i * 60_000),
    );
    const table = buildTapeExpectancyTable([...nominable, ...notNominable], {
      config: DEFAULT_COST_GATE_CONFIG,
      nowMs: DECIDED_AT,
    });

    // The global fold — what TRA-4783 published and nobody consumed.
    const global = summarizeTapeInputStaleness(
      table.cells.filter((c) => c.structure === OTM),
      DECIDED_AT,
    );
    expect(global.inputStale).toBe(true);
    // ⚠️ Driven by the cell no candidate can select.
    expect(global.inputTapeAgeDaysMax).toBeGreaterThan(70);

    // The per-cell verdict on the cell that ACTUALLY refused the entry site is
    // a DIFFERENT number, from a different cell, and it has to be read on its
    // own terms — which is what AC4 asks for.
    const stamp = tapeExpectancyGrossProvenance(
      table,
      tapeExpectancyVerdict({ structure: OTM, delta: 0.35 }, table, DEFAULT_COST_GATE_CONFIG),
    );
    const fold = foldGrossRProvenance([foldRow(stamp, DECIDED_AT)])!;
    expect(fold.inputFreshness.stale).toBe(true);
    expect(fold.inputFreshness.tapeAgeDaysAtDecisionMax).toBeCloseTo(51.1, 1);
    // ⭐ The two disagree on the NUMBER while agreeing on the verdict. Quoting
    // the global age against a decision made in the 0.30-0.40 cell overstates
    // that cell's staleness by 27 days.
    expect(fold.inputFreshness.tapeAgeDaysAtDecisionMax).not.toBe(global.inputTapeAgeDaysMax);
  });

  it('a stale global does NOT force a decision-relevant cell stale', () => {
    // The inverse, and the reason a single global boolean is the wrong control:
    // one abandoned cell can be arbitrarily old while the nominated cell is
    // current. A route keyed on the global would page for nothing.
    const fresh = stampFor(DECIDED_AT - DAY, 0.35, DECIDED_AT);
    const fold = foldGrossRProvenance([foldRow(fresh, DECIDED_AT)])!;
    expect(fold.inputFreshness.stale).toBe(false);
  });
});

// ── §4 — AC3's guard, as a property ──────────────────────────────────────────

describe('TRA-4875 §4 — the verdict cannot move a decision', () => {
  it('is a pure fold over recorded rows: same rows in, same counts out', () => {
    const stale = stampFor(TAPE_END_030, 0.35, DECIDED_AT);
    const rows = Array.from({ length: 200 }, (_, i) => foldRow(stale, DECIDED_AT + i));
    const a = foldGrossRProvenance(rows)!;
    // A caller that raised the bar to a value nothing could trip must see the
    // SAME row counts and the SAME numbers — only the verdict moves. If the
    // freshness fold could reach anything else, this is where it would show.
    const b = foldGrossRProvenance(rows, 10_000)!;
    expect(a.inputFreshness.stale).toBe(true);
    expect(b.inputFreshness.stale).toBe(false);
    expect(b.rowsStamped).toBe(a.rowsStamped);
    expect(b.distinctGrossRValues).toBe(a.distinctGrossRValues);
    expect(b.constantAcrossRows).toBe(a.constantAcrossRows);
    expect(b.generations.map((g) => g.rows)).toEqual(a.generations.map((g) => g.rows));
    expect(b.tapeAgeMsMaxAtDecision).toBe(a.tapeAgeMsMaxAtDecision);
    expect(b.inputFreshness.tapeAgeDaysAtDecisionMax).toBe(
      a.inputFreshness.tapeAgeDaysAtDecisionMax,
    );
  });
});
