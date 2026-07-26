import { describe, it, expect } from 'vitest';
import {
  measureSpreadCross,
  summarizeSpreadCost,
  summarizeSpreadCeilingCompliance,
  commissionR,
  SLEEVE_SPREAD_CEILINGS,
  STOP_DISTANCE_FRACTION_OF_MARK,
  spreadGateVerdict,
  isSpreadCeilingEnforceEnabled,
  classifySpreadCeilingAccount,
  SPREAD_CEILING_ACCOUNT_CLASSES,
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

// ── TRA-2316 — the independent ceiling-compliance read ──────────────────────
//
// TRA-2306's read #2 could not be executed against any deployed route: the one
// with the `account` axis carried no quotes (so `(undefined − undefined) / undefined`
// is NaN, and `NaN > 0.10` is false — "0 rows above the ceiling" on EVERY input,
// including a completely broken gate), and the one with the quotes pooled fixture
// books and published only p90 (and `p90 <= ceiling` is consistent with 10% of rows
// above it).
//
// So the first thing these tests must establish is that the new fold HAS A FAILING
// STATE. A reject-counter-only assertion reproduces the original TRA-2295 bug — the
// gate that never ran and the gate that never rejected read identically — so the
// tests below assert the ADMITTED side too.

describe('summarizeSpreadCeilingCompliance (TRA-2316)', () => {
  const cellOf = (
    stats: ReturnType<typeof summarizeSpreadCeilingCompliance>,
    structure: string,
    accountClass: 'desk' | 'fixture' | 'unattributed' = 'desk',
  ) => stats.find((s) => s.structure === structure && s.accountClass === accountClass)!;

  it('FIRES: one desk row above the 0.10 directional ceiling is counted, and the max exceeds it', () => {
    // The shape of the real defect: bid 0.01 / ask 0.59 against a 0.30 mark is
    // spreadPct 1.933 — the worst contract TRA-2295 found admitted, 19x the
    // ceiling. If this row does not move `countAboveCeiling`, the read is the same
    // NaN-passes-everything instrument this ticket was filed about.
    const stats = summarizeSpreadCeilingCompliance([
      {
        structure: 'single_leg_directional',
        accountClass: 'desk', entryArchetype: 'directional',
        quote: { bid: 0.01, ask: 0.59, mark: 0.3 },
      },
    ]);
    const cell = cellOf(stats, 'single_leg_directional');
    expect(cell.n).toBe(1);
    expect(cell.countAboveCeiling).toBe(1);
    expect(cell.maxSpreadPct).toBeCloseTo(1.9333, 4);
    expect(cell.maxSpreadPct as number).toBeGreaterThan(
      SLEEVE_SPREAD_CEILINGS.single_leg_directional!.maxSpreadPct,
    );
    // ...and the ADMITTED side. bid 0.01 is under the 0.10 quotability floor: an
    // ABSENT market, not a wide one. A ratio test alone cannot see that.
    expect(cell.countBelowMinBid).toBe(1);
    expect(cell.minEntryBidUsd).toBe(0.01);
  });

  it('a clean desk book reads countAboveCeiling 0 WITH n > 0 — the PASS, distinct from no reading', () => {
    // 0.10 spread on a 2.00 mark = 5%, inside the ceiling; bid 1.90+ clears the
    // 0.10 floor. This is what a held ceiling looks like, and it must not be
    // representable the same way as an empty book.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 1.95, ask: 2.05, mark: 2.0 } },
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 1.9, ask: 2.0, mark: 2.0 } },
    ]);
    const cell = cellOf(stats, 'single_leg_directional');
    expect(cell.n).toBe(2);
    expect(cell.countAboveCeiling).toBe(0);
    expect(cell.countBelowMinBid).toBe(0);
    expect(cell.maxSpreadPct).toBeCloseTo(0.05, 10);
  });

  it('an EMPTY partition reads n:0 / null — NOT 0 — so it cannot be misread as a pass', () => {
    // The TRA-2295 + TRA-2311 failure shape in one assertion: "nothing to check"
    // and "checked, nothing over" must not be the same bytes.
    const empty = summarizeSpreadCeilingCompliance([]);
    const cell = cellOf(empty, 'single_leg_directional');
    // The cell EXISTS at n=0 — an absent cell reads exactly like a passing one.
    expect(cell).toBeDefined();
    expect(cell.n).toBe(0);
    expect(cell.maxSpreadPct).toBeNull();
    expect(cell.countAboveCeiling).toBeNull();
    expect(cell.minEntryBidUsd).toBeNull();
    expect(cell.countBelowMinBid).toBeNull();

    const populated = cellOf(
      summarizeSpreadCeilingCompliance([
        { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 1.95, ask: 2.05, mark: 2.0 } },
      ]),
      'single_leg_directional',
    );
    expect(populated.countAboveCeiling).toBe(0);
    expect(populated.countAboveCeiling).not.toBe(cell.countAboveCeiling);
  });

  it('EXCLUDES fixture rows from the desk partition (TRA-2100 mirror trap)', () => {
    // The mixed book: one clean desk fill, the same economic trade mirrored into
    // two fixture books at a ceiling-breaching spread, and one pre-attribution row.
    // Pooled, the desk cell would report 4 rows and a 1.933 max and falsely
    // falsify the gate.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 1.95, ask: 2.05, mark: 2.0 } },
      { structure: 'single_leg_directional', accountClass: 'fixture', entryArchetype: 'directional', quote: { bid: 0.01, ask: 0.59, mark: 0.3 } },
      { structure: 'single_leg_directional', accountClass: 'fixture', entryArchetype: 'directional', quote: { bid: 0.01, ask: 0.59, mark: 0.3 } },
      { structure: 'single_leg_directional', accountClass: 'unattributed', entryArchetype: 'directional', quote: { bid: 0.5, ask: 0.9, mark: 0.7 } },
    ]);
    const desk = cellOf(stats, 'single_leg_directional', 'desk');
    const fixture = cellOf(stats, 'single_leg_directional', 'fixture');
    const unattributed = cellOf(stats, 'single_leg_directional', 'unattributed');

    expect(desk.n).toBe(1);
    expect(desk.countAboveCeiling).toBe(0);
    expect(desk.maxSpreadPct).toBeCloseTo(0.05, 10);

    expect(fixture.n).toBe(2);
    expect(fixture.countAboveCeiling).toBe(2);

    // `unattributed` is pre-TRA-1475 rows with no `account`. It is NOT desk —
    // folding it in would re-commit the pooling bug for exactly the historical
    // rows a long-window grade leans on hardest.
    expect(unattributed.n).toBe(1);
    expect(unattributed.countAboveCeiling).toBe(1);
    expect(desk.n + fixture.n + unattributed.n).toBe(4);
  });

  it('DROPS unmeasurable quotes out of the denominator and COUNTS the drop — never a zero spread', () => {
    // The discipline `measureSpreadCross` and `cost-aware-gate-ledger.ts:481`
    // already keep: a row with no fill-time quote is not a row with a zero-width
    // spread. Zero-filling one would let a compaction publish a falsely-cheap max.
    // The drop is counted so `n: 0` after discarding rows cannot read as a quiet,
    // clean book.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: null },
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 0.5, ask: 0.4, mark: 1.0 } }, // crossed book
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 1.95, ask: 2.05, mark: 0 } }, // non-positive mark
    ]);
    const cell = cellOf(stats, 'single_leg_directional');
    expect(cell.n).toBe(0);
    expect(cell.rowsDroppedNoQuote).toBe(3);
    // NOT 0 — that is the whole point.
    expect(cell.maxSpreadPct).toBeNull();
    expect(cell.countAboveCeiling).toBeNull();
  });

  it('emits the full sleeve grid, and a structure with no configured ceiling reads null, not compliant', () => {
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'bull_put', accountClass: 'desk', entryArchetype: 'directional', quote: { bid: 0.2, ask: 1.8, mark: 1.0 } },
    ]);
    for (const sleeve of Object.keys(SLEEVE_SPREAD_CEILINGS)) {
      for (const klass of ['desk', 'fixture', 'unattributed'] as const) {
        expect(stats.find((s) => s.structure === sleeve && s.accountClass === klass)).toBeDefined();
      }
    }
    const bp = cellOf(stats, 'bull_put');
    expect(bp.n).toBe(1);
    expect(bp.ceiling).toBeNull();
    expect(bp.maxSpreadPct).toBeCloseTo(1.6, 10);
    // No ceiling configured means there is no bound to breach. `null`, not `0`:
    // reporting 0 would assert compliance with a threshold that does not exist.
    expect(bp.countAboveCeiling).toBeNull();
    expect(bp.countBelowMinBid).toBeNull();
  });

  it('uses the STRICT comparison the entry gate uses — exactly at the ceiling is admitted', () => {
    // `spreadGateVerdict` rejects on `spreadPct > maxSpreadPct`. This read must not
    // disagree with the gate at the boundary, or a clean book reads as a breach.
    //
    // ⚠ The quote is chosen so `ask − bid` and the quotient are EXACTLY
    // representable: `2.1 − 1.9` is 0.20000000000000018, which divided by 2.0 lands
    // a hair ABOVE 0.1 and is genuinely rejected by the gate. That is correct
    // behaviour on both sides, but it makes a naive "exactly at the ceiling"
    // fixture a test of float representation rather than of the comparison. 1.25 −
    // 1.00 = 0.25 exactly, and 0.25 / 2.5 rounds to the same double as the `0.1`
    // literal, so this pins the comparison itself.
    const atCeiling = { bid: 1.0, ask: 1.25, mark: 2.5 }; // spreadPct exactly 0.10
    expect(atCeiling.ask - atCeiling.bid).toBe(0.25);
    expect(spreadGateVerdict('single_leg_directional', atCeiling).admitted).toBe(true);
    const cell = cellOf(
      summarizeSpreadCeilingCompliance([
        { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: atCeiling },
      ]),
      'single_leg_directional',
    );
    expect(cell.countAboveCeiling).toBe(0);
    expect(cell.maxSpreadPct).toBeCloseTo(0.1, 10);
  });
});

// ── TRA-2350 — the structure key is NOT a sleeve ─────────────────────────────
//
// `single_leg_directional` is stamped by THREE call sites and only ONE of them
// evaluates the ceiling:
//
//   signal-engine.ts:8484  directional sleeve       entryArchetype 'directional'        GATED (:8315)
//   signal-engine.ts:9226  iv-rv mispricing         entryArchetype 'iv-rv-buy-premium'  ungated
//   signal-engine.ts:12180 AI-Options-Ideas single  (stamps NO archetype)               ungated
//
// `spreadCeilingRejectReason` has exactly one call site in the tree, `:8315`.
//
// Keyed on structure alone, a wide fill from either ungated sleeve lands in the
// cell that `/api/health/option-spread-cost` bills as "the independent TRA-2306
// read #2", and that block's own docstring told the grader `countAboveCeiling > 0`
// there is falsification of TRA-2295. That is a FALSE FAIL manufactured by the
// instrument, against a gate that was never on the breaching row's path — and the
// documented remedy for it is to re-open a correct ticket.
//
// The tests below are written as the NEGATIVE CONTROL for that: each puts a
// ceiling-breaching row from an UNGATED sleeve into the desk cell and demands the
// graded cohort stay clean. Remove the archetype axis and they fail.
describe('summarizeSpreadCeilingCompliance archetype partition (TRA-2350)', () => {
  const cellOf = (
    stats: ReturnType<typeof summarizeSpreadCeilingCompliance>,
    structure: string,
    accountClass: 'desk' | 'fixture' | 'unattributed' = 'desk',
  ) => stats.find((s) => s.structure === structure && s.accountClass === accountClass)!;

  // The worst contract TRA-2295 found admitted: bid 0.01 / ask 0.59 on a 0.30
  // mark = spreadPct 1.933, 19x the 0.10 ceiling.
  const BREACH = { bid: 0.01, ask: 0.59, mark: 0.3 };
  // 0.10 wide on a 2.00 mark = 5%, and bid 1.95 clears the 0.10 quotability floor.
  const CLEAN = { bid: 1.95, ask: 2.05, mark: 2.0 };

  it('an iv-rv breach under the directional structure key does NOT falsify the gated cohort', () => {
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: CLEAN },
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'iv-rv-buy-premium', quote: BREACH },
    ]);
    const cell = cellOf(stats, 'single_leg_directional');

    // The POOLED cell still sees both — that read stays honest about what the book
    // bought under this label, and it is deliberately NOT the verdict.
    expect(cell.n).toBe(2);
    expect(cell.countAboveCeiling).toBe(1);

    // The VERDICT cell. This is the assertion the old instrument could not make.
    expect(cell.gated.n).toBe(1);
    expect(cell.gated.countAboveCeiling).toBe(0);
    expect(cell.gated.maxSpreadPct).toBeCloseTo(0.05, 10);

    // ...and the breach is still REPORTED, just not as evidence about TRA-2295.
    // Suppressing it would trade a false FAIL for a false PASS.
    expect(cell.ungated.n).toBe(1);
    expect(cell.ungated.countAboveCeiling).toBe(1);
    expect(cell.ungated.maxSpreadPct).toBeCloseTo(1.9333, 4);
  });

  it('a row that stamps NO archetype is UNGATED — absent must not default into the graded cohort', () => {
    // `signal-engine.ts:12180` (AI-Options-Ideas) stamps no `entryArchetype`. The
    // fail-closed direction is that an unrecognised writer is excluded from the
    // gated cohort, not silently admitted to it.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: null, quote: BREACH },
    ]);
    const cell = cellOf(stats, 'single_leg_directional');
    expect(cell.ungated.countAboveCeiling).toBe(1);
    // n:0, not 0-breaches — "nothing to check" and "checked, nothing over" stay
    // distinct at the cohort level too.
    expect(cell.gated.n).toBe(0);
    expect(cell.gated.countAboveCeiling).toBeNull();
    expect(cell.byArchetype.find((a) => a.entryArchetype === 'unspecified')?.gated).toBe(false);
  });

  it('a REAL breach by the gated sleeve still falsifies — the partition must keep a failing state', () => {
    // The other half of the negative control. A partition that can only ever read
    // clean is worth nothing; this is the state that must still FAIL.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: BREACH },
    ]);
    const cell = cellOf(stats, 'single_leg_directional');
    expect(cell.gated.n).toBe(1);
    expect(cell.gated.countAboveCeiling).toBe(1);
    expect(cell.gated.maxSpreadPct).toBeCloseTo(1.9333, 4);
    // The min-bid axis is a SECOND, independent falsification — bid 0.01 is an
    // ABSENT market, which a ratio test alone cannot see.
    expect(cell.gated.countBelowMinBid).toBe(1);
  });

  it('emits a byArchetype row for a DECLARED gated archetype that did not trade — absent reads like clean', () => {
    const cell = cellOf(summarizeSpreadCeilingCompliance([]), 'single_leg_directional');
    const directional = cell.byArchetype.find((a) => a.entryArchetype === 'directional');
    expect(directional).toBeDefined();
    expect(directional?.gated).toBe(true);
    expect(directional?.n).toBe(0);
    expect(directional?.countAboveCeiling).toBeNull();
    expect(cell.gatedArchetypes).toEqual(['directional']);
  });

  it('single_leg_rv admits NOTHING to the gated cohort — its scanner filter is compile-time dead', () => {
    // `relative-value.ts:396` sits inside the RV scanner and `RV_ENGINE_ENABLED` has
    // been a compile-time false since TRA-1207. Nothing under this key was gated by
    // anything, so no archetype may be graded as enforcement evidence — including
    // the 87 pre-fix directional rows, which all carry `structure: 'single_leg_rv'`.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_rv', accountClass: 'desk', entryArchetype: 'directional', quote: BREACH },
    ]);
    const cell = cellOf(stats, 'single_leg_rv');
    expect(cell.gatedArchetypes).toBe('none');
    expect(cell.gated.n).toBe(0);
    expect(cell.gated.countAboveCeiling).toBeNull();
    expect(cell.ungated.countAboveCeiling).toBe(1);
  });

  it('single_leg_otm gates EVERY archetype — the filter is above archetype, in the chain scan', () => {
    // `otm-mispricing.ts:185` runs on every chain row before a candidate exists, so
    // the whole key is gated regardless of what stamped it. Grading OTM on `gated`
    // must therefore agree with grading it pooled — the positive control that the
    // partition did not quietly narrow a cohort that was already correct.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_otm', accountClass: 'desk', entryArchetype: 'otm-mispricing', quote: { bid: 0.5, ask: 0.55, mark: 0.5 } },
      { structure: 'single_leg_otm', accountClass: 'desk', entryArchetype: null, quote: { bid: 0.5, ask: 0.55, mark: 0.5 } },
    ]);
    const cell = cellOf(stats, 'single_leg_otm');
    expect(cell.gatedArchetypes).toBe('all');
    expect(cell.gated.n).toBe(2);
    expect(cell.gated.n).toBe(cell.n);
    expect(cell.ungated.n).toBe(0);
    expect(cell.gated.countAboveCeiling).toBe(0);
  });

  it('gated.n + ungated.n === n, and dropped rows partition the same way', () => {
    // The identity a consumer can assert to catch a partition that lost rows.
    const stats = summarizeSpreadCeilingCompliance([
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: CLEAN },
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'directional', quote: null },
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: 'iv-rv-buy-premium', quote: BREACH },
      { structure: 'single_leg_directional', accountClass: 'desk', entryArchetype: null, quote: null },
    ]);
    const cell = cellOf(stats, 'single_leg_directional');
    expect(cell.n).toBe(2);
    expect(cell.gated.n + cell.ungated.n).toBe(cell.n);
    expect(cell.rowsDroppedNoQuote).toBe(2);
    expect(cell.gated.rowsDroppedNoQuote + cell.ungated.rowsDroppedNoQuote).toBe(
      cell.rowsDroppedNoQuote,
    );
    // An unmeasurable row is never a zero-spread fill in EITHER cohort.
    expect(cell.gated.n).toBe(1);
    expect(cell.gated.countAboveCeiling).toBe(0);
  });
});

// ── TRA-2355 — the shared partition rule ───────────────────────────────────
//
// This predicate exists so the two independent readouts of the SAME ceiling
// cannot drift: the journal-derived fold above (which classifies a row's stored
// `account`) and the gate ledger's own counters (which classify the owning book
// at DECISION time, because the ledger was account-blind and pooled ~51 QA
// fixture books into the desk's numbers). They are published as cross-checks of
// each other — so a second copy of this three-line rule would make a
// disagreement between them indistinguishable from a real enforcement failure.
describe('classifySpreadCeilingAccount (TRA-2355)', () => {
  it('classifies the desk books', () => {
    expect(classifySpreadCeilingAccount('admin')).toBe('desk');
    expect(classifySpreadCeilingAccount('Richard')).toBe('desk');
    // Anchored, not substring: a real book merely CONTAINING a pattern stays desk.
    expect(classifySpreadCeilingAccount('aqua')).toBe('desk');
    expect(classifySpreadCeilingAccount('monitorly')).toBe('desk');
  });

  it('classifies the live QA fixture fleet — the population that did the pooling', () => {
    for (const name of ['qa_reg_881', 'qa_tra1475_x', 'QA_MIRROR_2', 'ctoverify', 'ctoverify_2', 'monitor_qa']) {
      expect(classifySpreadCeilingAccount(name)).toBe('fixture');
    }
  });

  it('ABSENT/BLANK is `unattributed`, NEVER `desk` — the laundering branch', () => {
    // Load-bearing: the gate ledger hydrates pre-TRA-2355 JSONL lines that carry no
    // class at all. Defaulting those to `desk` would manufacture desk evidence out of
    // records whose owner is genuinely unknown — this ticket's pooling bug, moved into
    // the hydrate. `unattributed` is a third answer, not a softer `desk`.
    expect(classifySpreadCeilingAccount(undefined)).toBe('unattributed');
    expect(classifySpreadCeilingAccount(null)).toBe('unattributed');
    expect(classifySpreadCeilingAccount('')).toBe('unattributed');
    expect(classifySpreadCeilingAccount('   ')).toBe('unattributed');
  });

  it('honours TEST_ACCOUNT_PREFIXES, which is WHY the class is frozen at decision time', () => {
    // The env is readable at any moment, so classifying at READ time would let an env
    // edit retroactively reclassify a week of history. The gate ledger stamps the class
    // when the decision is made, precisely so this env is not a time machine.
    const env = { TEST_ACCOUNT_PREFIXES: 'loadtest' } as unknown as NodeJS.ProcessEnv;
    expect(classifySpreadCeilingAccount('loadtest_7', env)).toBe('fixture');
    expect(classifySpreadCeilingAccount('loadtest_7')).toBe('desk'); // same name, default env
  });

  it('every answer is a member of the published class list', () => {
    for (const name of ['admin', 'qa_1', '', 'monitor_qa']) {
      expect(SPREAD_CEILING_ACCOUNT_CLASSES).toContain(classifySpreadCeilingAccount(name));
    }
  });
});
