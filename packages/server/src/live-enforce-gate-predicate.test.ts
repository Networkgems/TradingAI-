// TRA-4745 — the REALISED predicate, graded against the REAL verdict functions.
//
// The load-bearing assertion in this file is the NEGATIVE one: three flat-form
// branches refuse WITHOUT comparing anything, and `band_deauthorized` is the
// trap — it reports a non-null `lowerCI95` (deliberately, so a reader can see the
// mandate and the tape agree) while having decided on the mandate alone. A
// predicate builder keyed on "is there a bound?" would publish that row as a bar
// comparison, which is the same class of false inference the whole ticket is
// about, one layer down.
//
// Nothing here uses a hand-built verdict object. Every case is produced by
// `tapeExpectancyVerdict` / `netEdgeBarVerdict` themselves, so a branch added to
// either one that this module does not classify shows up as a failure here
// rather than as a confidently wrong line on the health payload.

import { describe, expect, it } from 'vitest';
import {
  NET_EDGE_PRE_COMPARISON_REASON_CODES,
  TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES,
  netEdgeFormPredicate,
  tapeExpectancyFlatPredicate,
} from './live-enforce-gate-predicate.js';
import {
  buildTapeExpectancyTable,
  tapeExpectancyVerdict,
  type TapeExpectancyTable,
} from './option-tape-expectancy.js';
import { DEFAULT_COST_GATE_CONFIG } from './option-cost-gate.js';
import { DEFAULT_NET_EDGE_BAR_CONFIG, netEdgeBarVerdict } from './option-net-edge-bar.js';
import { OTM_SLEEVE_MANDATE_STRUCTURE } from './otm-sleeve-mandate.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const OTM = OTM_SLEEVE_MANDATE_STRUCTURE;
/** Inside the ratified band [0.495, 0.55), so the mandate never preempts the tape. */
const AUTHORIZED_DELTA = 0.52;

/** A synthetic closed row. `realizedR` is PREMIUM R; the gate's R is 4x. */
function row(entryDelta: number, realizedR: number): OptionTradeJournalRecord {
  return {
    structure: OTM,
    outcome: realizedR >= 0 ? 'WIN' : 'LOSS',
    entryDelta,
    realizedR,
    closeTs: 1_700_000_000_000,
  } as unknown as OptionTradeJournalRecord;
}

function tableOf(entryDelta: number, realizedR: number, n = 40): TapeExpectancyTable {
  return buildTapeExpectancyTable(
    Array.from({ length: n }, () => row(entryDelta, realizedR)),
    { config: DEFAULT_COST_GATE_CONFIG },
  );
}

const NET_EDGE = {
  k: DEFAULT_NET_EDGE_BAR_CONFIG.k,
  feesPerContractRoundTrip: DEFAULT_NET_EDGE_BAR_CONFIG.feesPerContractRoundTrip,
  absCostFracCeiling: DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling,
};

describe('TRA-4745 — the flat form publishes the comparison it actually ran', () => {
  it('names grossR vs barR as the two sides, and NEVER costR', () => {
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: AUTHORIZED_DELTA },
      tableOf(AUTHORIZED_DELTA, 5),
      DEFAULT_COST_GATE_CONFIG,
    );
    const p = tapeExpectancyFlatPredicate(verdict);
    expect(verdict.admit).toBe(true);
    expect(p.compared).toBe(true);
    expect(p.form).toBe('tape_expectancy_flat');
    expect(p.op).toBe('>=');
    // The LEFT side is the cell's lower CI bound — `tapeEdgeR`, the number the
    // gate admits on — and the RIGHT side is the bar off the verdict itself,
    // never re-resolved from the current env.
    expect(p.lhs).toBe(verdict.lowerCI95);
    expect(p.rhs).toBe(verdict.barR);
    expect(p.admit).toBe(true);
    expect(p.shortCircuit).toBeNull();
    // The whole point: neither side is a cost.
    expect(p.lhsLabel).toContain('grossR');
    expect(p.rhsLabel).toContain('barR');
    expect(`${p.lhsLabel} ${p.rhsLabel}`).not.toContain('costR');
  });

  it('a measured-but-short cell IS compared, and `rhs − lhs` is the byReason shortfall', () => {
    // Gate R = 4 × premium R, so 0.01 premium R is a 0.04 lower bound — well
    // under the 0.385 bar, and non-negative, so it buckets as `shortfall_*`
    // rather than `gross_negative`.
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: AUTHORIZED_DELTA },
      tableOf(AUTHORIZED_DELTA, 0.01),
      DEFAULT_COST_GATE_CONFIG,
    );
    expect(verdict.admit).toBe(false);
    expect(verdict.reasonCode).toMatch(/^shortfall_/);
    const p = tapeExpectancyFlatPredicate(verdict);
    expect(p.compared).toBe(true);
    expect(p.admit).toBe(false);
    // ⭐ The identity `byReason` never stated: the shortfall is barR − grossR.
    expect(p.rhs! - p.lhs!).toBeCloseTo(verdict.barR - verdict.lowerCI95!, 10);
  });

  it('`insufficient_evidence` is NOT a bar comparison — compared:false, both sides null', () => {
    // The unfolded-tape case, inside the ratified band so the mandate cannot
    // preempt it. This is the single largest live bucket on bqb1.
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: AUTHORIZED_DELTA },
      null,
      DEFAULT_COST_GATE_CONFIG,
    );
    expect(verdict.reasonCode).toBe('insufficient_evidence');
    const p = tapeExpectancyFlatPredicate(verdict);
    expect(p.compared).toBe(false);
    expect(p.lhs).toBeNull();
    expect(p.rhs).toBeNull();
    expect(p.shortCircuit).toBe('insufficient_evidence');
    expect(p.admit).toBe(false);
  });

  it('`band_deauthorized` is NOT a bar comparison EVEN THOUGH it carries a lowerCI95', () => {
    // ⛔ THE TRAP. The de-authorized band publishes the tape stats so a reader can
    // see the mandate and the tape agree — a builder keyed on "is there a bound?"
    // would report a comparison that never ran. Use a STRONGLY POSITIVE table in
    // the de-authorized band, i.e. the case where the bound would have ADMITTED.
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: 0.05 },
      tableOf(0.05, 5),
      DEFAULT_COST_GATE_CONFIG,
    );
    expect(verdict.reasonCode).toBe('band_deauthorized');
    expect(verdict.lowerCI95).not.toBeNull();
    expect(verdict.lowerCI95!).toBeGreaterThan(verdict.barR); // would have admitted
    const p = tapeExpectancyFlatPredicate(verdict);
    expect(p.compared).toBe(false);
    expect(p.lhs).toBeNull();
    expect(p.rhs).toBeNull();
    expect(p.shortCircuit).toBe('band_deauthorized');
  });

  it('`gross_unknown` (no usable delta) is NOT a bar comparison', () => {
    const verdict = tapeExpectancyVerdict(
      { structure: OTM, delta: Number.NaN },
      tableOf(AUTHORIZED_DELTA, 5),
      DEFAULT_COST_GATE_CONFIG,
    );
    expect(verdict.reasonCode).toBe('gross_unknown');
    const p = tapeExpectancyFlatPredicate(verdict);
    expect(p.compared).toBe(false);
    expect(p.shortCircuit).toBe('gross_unknown');
  });

  it('the pre-comparison list is exactly the branches that never reach `lower >= barR`', () => {
    // Pinned so a branch added to `tapeExpectancyVerdict` that this module does
    // not classify fails HERE rather than shipping as a confident wrong line.
    expect([...TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES].sort()).toEqual([
      'band_deauthorized',
      'gross_unknown',
      'insufficient_evidence',
    ]);
    // `gross_negative` and `shortfall_*` are DELIBERATELY absent: both are real
    // comparisons whose left side lost.
    expect(TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES).not.toContain('gross_negative');
  });
});

describe('TRA-4745 — the net-edge form publishes the comparison IT ran', () => {
  it('the k-ratio branch names costR <= k × grossR', () => {
    const verdict = netEdgeBarVerdict(
      { mark: 2, bid: 1.99, ask: 2.01, riskPerShare: 1, modeledGrossR: 1 },
      NET_EDGE,
    );
    const p = netEdgeFormPredicate(verdict, 1, NET_EDGE);
    expect(p.form).toBe('net_edge');
    expect(p.compared).toBe(true);
    expect(p.op).toBe('<=');
    expect(p.lhs).toBe(verdict.costR);
    expect(p.rhs).toBeCloseTo(NET_EDGE.k * 1, 10);
    expect(p.admit).toBe(verdict.admit);
  });

  it('an unusable quote reports NO comparison, not a comparison against NaN', () => {
    const verdict = netEdgeBarVerdict(
      { mark: 2, bid: undefined, ask: undefined, riskPerShare: 1, modeledGrossR: 1 },
      NET_EDGE,
    );
    expect(verdict.reasonCode).toBe('net_edge_quote_unusable');
    const p = netEdgeFormPredicate(verdict, 1, NET_EDGE);
    expect(p.compared).toBe(false);
    expect(p.lhs).toBeNull();
    expect(p.rhs).toBeNull();
    expect(NET_EDGE_PRE_COMPARISON_REASON_CODES).toContain(p.shortCircuit!);
  });

  it('an unknown edge reports NO comparison', () => {
    const verdict = netEdgeBarVerdict(
      { mark: 2, bid: 1.99, ask: 2.01, riskPerShare: 1, modeledGrossR: Number.NaN },
      NET_EDGE,
    );
    expect(verdict.reasonCode).toBe('net_edge_edge_unknown');
    const p = netEdgeFormPredicate(verdict, Number.NaN, NET_EDGE);
    expect(p.compared).toBe(false);
    expect(p.shortCircuit).toBe('net_edge_edge_unknown');
  });

  it('the absolute ceiling reports ITS OWN comparison, not the k-ratio it never ran', () => {
    // A quote whose cross alone is most of the premium: the k-independent
    // ceiling fires first. Publishing `costR <= k × grossR` here would name a
    // comparison the form skipped.
    const verdict = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.1, ask: 0.9, riskPerShare: 1, modeledGrossR: 5 },
      NET_EDGE,
    );
    expect(verdict.reasonCode).toBe('net_edge_abs_ceiling');
    const p = netEdgeFormPredicate(verdict, 5, NET_EDGE);
    expect(p.compared).toBe(true);
    expect(p.lhs).toBe(verdict.costFracOfPremium);
    expect(p.rhs).toBe(NET_EDGE.absCostFracCeiling);
    expect(p.lhsLabel).toContain('costFracOfPremium');
    expect(p.admit).toBe(false);
  });
});
