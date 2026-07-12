import { describe, it, expect } from 'vitest';
import {
  measureSpreadCross,
  summarizeSpreadCost,
  commissionR,
  SLEEVE_SPREAD_CEILINGS,
  STOP_DISTANCE_FRACTION_OF_MARK,
} from './option-spread-cost.js';
import { DEFAULT_COST_GATE_CONFIG } from './option-cost-gate.js';

// TRA-1656 (TRA-1602B) — the cost-aware bar rests on an unmeasured spread cross.
// These tests pin the measurement identity, the drop-out (never zero-fill)
// behaviour, and the selection-independent ceiling that falsifies the gate input.

describe('measureSpreadCross', () => {
  it('measures the round-trip cross in the GATE R unit (R = 0.25 · mark)', () => {
    // $2.00 mark, $0.10 spread. spreadPct = 5%. R = $0.50/share.
    // Round trip crosses the full spread: 0.10 / 0.50 = 0.20R.
    const m = measureSpreadCross({ bid: 1.95, ask: 2.05, mark: 2.0 });
    expect(m).not.toBeNull();
    expect(m!.spreadCrossUsdPerShare).toBeCloseTo(0.1, 10);
    expect(m!.spreadPct).toBeCloseTo(0.05, 10);
    expect(m!.spreadCrossR).toBeCloseTo(0.2, 10);
  });

  it('holds the identity spreadCrossR = 4 · spreadPct', () => {
    for (const [bid, ask, mark] of [
      [0.9, 1.1, 1.0],
      [4.5, 5.5, 5.0],
      [0.18, 0.22, 0.2],
    ] as const) {
      const m = measureSpreadCross({ bid, ask, mark })!;
      expect(m.spreadCrossR).toBeCloseTo(4 * m.spreadPct, 10);
      expect(m.spreadCrossR).toBeCloseTo(m.spreadPct / STOP_DISTANCE_FRACTION_OF_MARK, 10);
    }
  });

  it('reports the journal premium basis as exactly 1/4 of the gate basis', () => {
    const m = measureSpreadCross({ bid: 1.8, ask: 2.2, mark: 2.0 })!;
    expect(m.spreadCrossR).toBeCloseTo(4 * m.spreadCrossRPremiumBasis, 10);
  });

  it('returns null on an unusable quote so it DROPS OUT rather than counting as zero-cost', () => {
    expect(measureSpreadCross({ bid: 2.1, ask: 1.9, mark: 2.0 })).toBeNull(); // crossed book
    expect(measureSpreadCross({ bid: 1.9, ask: 2.1, mark: 0 })).toBeNull(); // no mark
    expect(measureSpreadCross({ bid: Number.NaN, ask: 2.1, mark: 2 })).toBeNull();
    expect(measureSpreadCross({ bid: 1.9, ask: 2.1, mark: -1 })).toBeNull();
  });

  it('measures a zero-width (locked) book as a genuine 0R cross, not a drop-out', () => {
    const m = measureSpreadCross({ bid: 2.0, ask: 2.0, mark: 2.0 });
    expect(m).not.toBeNull();
    expect(m!.spreadCrossR).toBe(0);
  });
});

describe('commissionR', () => {
  it('checks the gate 0.05R commission input against Tradier $0.35/contract/side', () => {
    // $2.00 mark, 1 contract. Round trip = 2 × $0.35 = $0.70.
    // R = 0.25 × $2.00 × 100 = $50. => 0.014R.
    const c = commissionR(2.0, 1, 0.35)!;
    expect(c).toBeCloseTo(0.014, 6);
    // The gate's 0.05R input is conservative here — it OVERstates true commission.
    expect(c).toBeLessThan(DEFAULT_COST_GATE_CONFIG.optionsCost.commissionR);
  });

  it('is invariant to contract count (both terms scale linearly)', () => {
    expect(commissionR(2.0, 10, 0.35)).toBeCloseTo(commissionR(2.0, 1, 0.35)!, 10);
  });
});

describe('SLEEVE_SPREAD_CEILINGS — the selection-independent bound', () => {
  it('derives each ceiling from the scanner maxSpreadPct via crossR = 4 · spreadPct', () => {
    for (const sleeve of Object.values(SLEEVE_SPREAD_CEILINGS)) {
      expect(sleeve.maxSpreadCrossR).toBeCloseTo(4 * sleeve.maxSpreadPct, 10);
    }
  });

  it('shows the gate 1.00R spread input EXCEEDS every sleeve ceiling (it is infeasible)', () => {
    // This is the core TRA-1656 finding: the gate charges a cost strictly higher
    // than the worst contract the scanner is even allowed to select. No fills
    // required to establish it.
    const gateInput = DEFAULT_COST_GATE_CONFIG.optionsCost.makerAdjustedSpreadCrossR;
    for (const [name, sleeve] of Object.entries(SLEEVE_SPREAD_CEILINGS)) {
      expect(
        gateInput,
        `${name}: gate charges ${gateInput}R but no admissible contract can cross more than ${sleeve.maxSpreadCrossR}R`,
      ).toBeGreaterThan(sleeve.maxSpreadCrossR);
    }
  });
});

describe('summarizeSpreadCost', () => {
  const q = (bid: number, ask: number, mark: number) => ({ bid, ask, mark });

  it('rolls up per structure with mean / median / p90 in the gate R unit', () => {
    const samples = [
      // single_leg_rv: spreadPct 4%, 6%, 8% => crossR 0.16, 0.24, 0.32
      { structure: 'single_leg_rv', quote: q(1.96, 2.04, 2.0), contracts: 1 },
      { structure: 'single_leg_rv', quote: q(1.94, 2.06, 2.0), contracts: 1 },
      { structure: 'single_leg_rv', quote: q(1.92, 2.08, 2.0), contracts: 1 },
    ];
    const [rv] = summarizeSpreadCost(samples);
    expect(rv!.structure).toBe('single_leg_rv');
    expect(rv!.n).toBe(3);
    expect(rv!.avgSpreadCrossR).toBeCloseTo(0.24, 10);
    expect(rv!.medianSpreadCrossR).toBeCloseTo(0.24, 10);
    expect(rv!.avgSpreadCrossUsd).toBeCloseTo(0.12, 10);
    expect(rv!.avgEntryMarkUsd).toBeCloseTo(2.0, 10);
    expect(rv!.maxSpreadCrossR).toBe(0.4);
  });

  it('re-derives the implied bar from the MEASURED cross, well below the shipped 1.25R', () => {
    // A 6%-spread RV fill: crossR = 0.24. commission on a $2 mark ≈ 0.014R.
    // impliedBar = 0.014 + 0.24 + 0.20 ≈ 0.454R  vs  the shipped 1.25R bar.
    const [rv] = summarizeSpreadCost(
      [{ structure: 'single_leg_rv', quote: q(1.94, 2.06, 2.0), contracts: 1 }],
      { safetyMarginR: 0.2 },
    );
    expect(rv!.impliedBarR).toBeCloseTo(0.014 + 0.24 + 0.2, 3);
    expect(rv!.impliedBarR).toBeLessThan(0.6);
    // The shipped bar the demo book is armed on.
    const shippedBar = 1.25;
    expect(rv!.impliedBarR).toBeLessThan(shippedBar);
  });

  it('drops unmeasurable rows instead of folding them in as zero-cost fills', () => {
    const [rv] = summarizeSpreadCost([
      { structure: 'single_leg_rv', quote: q(1.94, 2.06, 2.0) }, // 0.24R
      { structure: 'single_leg_rv', quote: q(2.1, 1.9, 2.0) }, // crossed -> dropped
      { structure: 'single_leg_rv', quote: q(1.9, 2.1, 0) }, // no mark -> dropped
    ]);
    expect(rv!.n).toBe(1);
    // Had the two bad rows been zero-filled the mean would be 0.08, not 0.24 —
    // i.e. the cost would read 3× cheaper than reality.
    expect(rv!.avgSpreadCrossR).toBeCloseTo(0.24, 10);
  });

  it('separates structures and sorts them stably', () => {
    const out = summarizeSpreadCost([
      { structure: 'single_leg_rv', quote: q(1.94, 2.06, 2.0) },
      { structure: 'single_leg_otm', quote: q(0.9, 1.1, 1.0) },
      { structure: 'directional', quote: q(4.9, 5.1, 5.0) },
    ]);
    expect(out.map((s) => s.structure)).toEqual(['directional', 'single_leg_otm', 'single_leg_rv']);
    expect(out.every((s) => s.n === 1)).toBe(true);
    // `directional` has no scanner ceiling defined — reported as null, not faked.
    expect(out.find((s) => s.structure === 'directional')!.maxSpreadCrossR).toBeNull();
  });

  it('returns an empty rollup (not a zeroed one) when nothing is measurable', () => {
    expect(summarizeSpreadCost([])).toEqual([]);
    expect(summarizeSpreadCost([{ structure: 'single_leg_rv', quote: q(2.1, 1.9, 2.0) }])).toEqual([]);
  });

  it('omits avgCommissionR when no row carries a contract count', () => {
    const [rv] = summarizeSpreadCost([{ structure: 'single_leg_rv', quote: q(1.94, 2.06, 2.0) }]);
    expect(rv!.avgCommissionR).toBeNull();
  });
});
