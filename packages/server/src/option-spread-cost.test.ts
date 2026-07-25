import { describe, it, expect } from 'vitest';
import {
  measureSpreadCross,
  summarizeSpreadCost,
  commissionR,
  SLEEVE_SPREAD_CEILINGS,
  STOP_DISTANCE_FRACTION_OF_MARK,
  spreadGateVerdict,
  isSpreadCeilingEnforceEnabled,
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

  it('holds the gate spread input BELOW every sleeve ceiling (feasibility, TRA-1661)', () => {
    // The core TRA-1656 finding was that the then-shipped 1.00R input charged a
    // cost strictly HIGHER than the worst contract the scanner is even allowed to
    // select — infeasible, and refutable with no fills at all. TRA-1661 landed the
    // measured 0.235R in its place. This test is the standing guard on that class
    // of defect: any future cost input above a sleeve's ceiling is infeasible by
    // construction, whatever the data says.
    const gateInput = DEFAULT_COST_GATE_CONFIG.optionsCost.makerAdjustedSpreadCrossR;
    for (const [name, sleeve] of Object.entries(SLEEVE_SPREAD_CEILINGS)) {
      expect(
        gateInput,
        `${name}: gate charges ${gateInput}R but no admissible contract can cross more than ${sleeve.maxSpreadCrossR}R — infeasible by construction`,
      ).toBeLessThan(sleeve.maxSpreadCrossR);
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

// ── TRA-2295 (parent TRA-2291) ───────────────────────────────────────────────
//
// The ceiling above is a NUMBER; until TRA-2295 the directional sleeve had no code
// that applied it (its reject lived in the compile-time-OFF RV scanner), so 59 of 83
// live desk entries crossed it — worst 1.933, 19×. `spreadGateVerdict` is the
// predicate that closes that, evaluated on the same quote that prices the fill.

describe('spreadGateVerdict — the entry-path ceiling (TRA-2295)', () => {
  const q = (bid: number, ask: number) => ({ bid, ask, mark: (bid + ask) / 2 });

  it('admits a quote inside both thresholds and reports the measured spreadPct', () => {
    const v = spreadGateVerdict('single_leg_directional', q(1.96, 2.04));
    expect(v.admitted).toBe(true);
    expect(v.code).toBe('ok');
    expect(v.reason).toBeNull();
    expect(v.spreadPct).toBeCloseTo(0.04, 10);
  });

  it('refuses the worst contract the live journal actually admitted (SOXS, 19x)', () => {
    // SOXS260821C00042000 — bid 0.01 / ask 0.59, spreadPct 1.933 against a 0.10
    // ceiling. It filled. This assertion is the regression.
    const v = spreadGateVerdict('single_leg_directional', q(0.01, 0.59));
    expect(v.admitted).toBe(false);
    expect(v.spreadPct!).toBeGreaterThan(1.9);
    expect(v.thresholds!.maxSpreadPct).toBe(0.1);
  });

  it('is a `>` test, and resolves a quote within float noise of the ceiling CONSERVATIVELY', () => {
    // Strictly inside admits, strictly outside rejects.
    expect(spreadGateVerdict('single_leg_rv', { bid: 0.96, ask: 1.04, mark: 1.0 }).admitted).toBe(true);
    const over = spreadGateVerdict('single_leg_rv', { bid: 0.949, ask: 1.051, mark: 1.0 });
    expect(over.admitted).toBe(false);
    expect(over.code).toBe('max_spread_pct');

    // AT the ceiling, binary floating point decides: `1.05 - 0.95` is
    // 0.10000000000000009, so a nominally-exactly-0.10 quote lands one ULP OVER
    // and is refused. Pinned rather than papered over with an epsilon — the error
    // is ~1e-17 of a ceiling quoted to two decimals, and it errs TIGHT. A
    // tolerance here would be a real loosening of the gate to buy a cosmetic
    // boundary, which is the wrong trade on the ticket that exists because this
    // ceiling was not enforced at all.
    expect(spreadGateVerdict('single_leg_rv', { bid: 0.95, ask: 1.05, mark: 1.0 }).admitted).toBe(false);
  });

  it('applies each sleeve its OWN ceiling — 0.15 passes OTM and fails directional', () => {
    const quote = { bid: 0.925, ask: 1.075, mark: 1.0 }; // spreadPct 0.15
    expect(spreadGateVerdict('single_leg_otm', quote).admitted).toBe(true);
    expect(spreadGateVerdict('single_leg_directional', quote).admitted).toBe(false);
  });

  it('refuses a sub-floor BID that passes the ratio test (QTTB-shaped absent market)', () => {
    // spreadPct 0.0952 — inside 0.10 — on a nickel bid. A ratio test alone admits
    // this; requirement 2 of the ticket exists because it should not.
    const v = spreadGateVerdict('single_leg_directional', q(0.05, 0.055));
    expect(v.spreadPct!).toBeLessThan(0.1);
    expect(v.admitted).toBe(false);
    expect(v.code).toBe('min_bid');
  });

  it('FAILS CLOSED on an unmeasurable quote — never admits what it cannot bound', () => {
    // A crossed book. Admitting it would reintroduce, at the gate, exactly the
    // writer-side false zero `measureSpreadCross` refuses at the measurement: an
    // entry whose spread cannot be computed is not an entry whose spread is zero.
    for (const bad of [
      { bid: 2.1, ask: 1.9, mark: 2.0 },
      { bid: 1.0, ask: 2.0, mark: 0 },
      { bid: Number.NaN, ask: 2.0, mark: 1.5 },
    ]) {
      const v = spreadGateVerdict('single_leg_directional', bad);
      expect(v.admitted).toBe(false);
      expect(v.code).toBe('no_quote');
      expect(v.spreadPct).toBeNull();
    }
  });

  it('says NO_CEILING out loud for an unconfigured sleeve rather than passing silently', () => {
    // A caller that wires the wrong sleeve name must be legible. If this returned a
    // plain `ok`, a typo'd label would produce a gate that admits everything and
    // reads identically to one that is enforcing — the TRA-2295 failure, relocated.
    const v = spreadGateVerdict('single_leg_typo', q(0.01, 0.59));
    expect(v.admitted).toBe(true);
    expect(v.code).toBe('no_ceiling');
    expect(v.thresholds).toBeNull();
  });

  it('honours a minBid override and keeps crossR consistent with an overridden ceiling', () => {
    expect(spreadGateVerdict('single_leg_directional', q(0.05, 0.055), { minBidUsd: 0.01 }).admitted).toBe(true);
    const v = spreadGateVerdict('single_leg_directional', q(1.96, 2.04), { maxSpreadPct: 0.02 });
    expect(v.admitted).toBe(false);
    expect(v.thresholds!.maxSpreadCrossR).toBeCloseTo(0.08, 10); // 4 · 0.02, still the identity
  });
});

describe('isSpreadCeilingEnforceEnabled — default ON (TRA-2295)', () => {
  it('is ON when unset, and ON for anything that is not an explicit off value', () => {
    // Opposite polarity from the dark demo gates on purpose: this restores a bound
    // three call sites already documented as being in force, and an unset flag is
    // indistinguishable from a WIPED one (TRA-2136 erased twelve Render vars and
    // every dependent gate went silently inert).
    expect(isSpreadCeilingEnforceEnabled({})).toBe(true);
    expect(isSpreadCeilingEnforceEnabled({ OPTION_SPREAD_CEILING_ENFORCE: '' })).toBe(true);
    expect(isSpreadCeilingEnforceEnabled({ OPTION_SPREAD_CEILING_ENFORCE: 'ture' })).toBe(true);
    expect(isSpreadCeilingEnforceEnabled({ OPTION_SPREAD_CEILING_ENFORCE: '1' })).toBe(true);
  });

  it('disarms ONLY on an explicit off value', () => {
    for (const off of ['0', 'false', 'no', 'off', ' OFF ']) {
      expect(isSpreadCeilingEnforceEnabled({ OPTION_SPREAD_CEILING_ENFORCE: off })).toBe(false);
    }
  });
});
