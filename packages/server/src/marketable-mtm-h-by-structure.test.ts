import { describe, it, expect } from 'vitest';
import {
  MARKETABLE_MTM_DEFAULT_H,
  MARKETABLE_MTM_H_BY_STRUCTURE,
  MODELED_H_CALIBRATION,
  marketableMtmUncalibratedStructures,
  marketableMtmVerdictWithUncalibrated,
  resolveMarketableMtmH,
  type MarketableMtmVerdict,
} from './marketable-mtm-forward-validation.js';
import {
  foldMarketableMtmDemoJournalBasis,
  type MarketableMtmDemoJournalRow,
} from './marketable-mtm-demo-journal-basis.js';

// TRA-3697 — `h` is a per-structure lookup, and an UNCALIBRATED structure REFUSES.
//
// The load-bearing half of this ticket is the refusal, not the lookup. A silent fallback to
// `MARKETABLE_MTM_DEFAULT_H` would hand `single_leg_directional` (forward desk mean 0.036)
// `single_leg_rv`'s 0.1428 — a 3.7× over-charge that reads IDENTICALLY to a real calibration
// at every call site. So the suite below carries a mutation control: it reconstructs the
// fallback variant and asserts the refusal assertions FAIL against it. A refusal test that
// passes against a fallback is the exact failure mode here.

const CAL_TO = Date.parse(MODELED_H_CALIBRATION.windowUtc.to);
const DAY = 86_400_000;

function row(over: Partial<MarketableMtmDemoJournalRow> = {}): MarketableMtmDemoJournalRow {
  return {
    structure: 'single_leg_rv',
    account: 'trader1',
    openTs: CAL_TO + DAY,
    entryBid: 1.25,
    entryAsk: 1.40,
    entryMarkUsd: 1.325,
    ...over,
  };
}

const isTestAccount = (u: string) => /^(qa|ctoverify)/i.test(u);

describe('TRA-3697 AC1 — a calibrated structure gets its OWN h, sourced from the calibration', () => {
  it('resolves rv → 0.1428 and otm → 0.0752 — asserted AGAINST MODELED_H_CALIBRATION, not a copy', () => {
    // The whole point of asserting against the calibration record rather than a literal: a
    // future recalibration that moves `byStructure[s].hMean` cannot leave this table behind.
    for (const [structure, fit] of Object.entries(MODELED_H_CALIBRATION.byStructure)) {
      const res = resolveMarketableMtmH(structure);
      expect(res.ok).toBe(true);
      expect(res.h).toBe(fit.hMean);
      expect(res.n).toBe(fit.n);
      expect(res.refusal).toBeNull();
      expect(MARKETABLE_MTM_H_BY_STRUCTURE[structure]).toBe(fit.hMean);
    }
    // …and the published numbers really are the ones the ticket names.
    expect(resolveMarketableMtmH('single_leg_rv').h).toBeCloseTo(0.1428, 6);
    expect(resolveMarketableMtmH('single_leg_otm').h).toBeCloseTo(0.0752, 6);
  });

  it('the per-structure fits RECONSTRUCT the pooled 0.134 — so the two cannot silently desync', () => {
    // (0.1428·124 + 0.0752·16) / 140 = 0.135074, vs the published pooled mean 0.1351. If a
    // recalibration moves a per-structure hMean without moving `h.mean`, this fires.
    const entries = Object.values(MODELED_H_CALIBRATION.byStructure);
    const n = entries.reduce((a, f) => a + f.n, 0);
    const weighted = entries.reduce((a, f) => a + f.hMean * f.n, 0) / n;
    expect(n).toBe(MODELED_H_CALIBRATION.n);
    expect(weighted).toBeCloseTo(MODELED_H_CALIBRATION.h.mean, 3);
    // And that pooled mean IS what the shipped scalar rounds to — i.e. 0.134 is rv's number.
    expect(MARKETABLE_MTM_DEFAULT_H).toBeCloseTo(MODELED_H_CALIBRATION.h.mean, 2);
    // …and the pooled scalar is `single_leg_rv`'s number, not the fleet's: it sits 6.7× nearer
    // rv's fit than otm's. That asymmetry IS the defect — 88.6% of the calibration is rv.
    const rvGap = Math.abs(MARKETABLE_MTM_DEFAULT_H - (resolveMarketableMtmH('single_leg_rv').h as number));
    const otmGap = Math.abs(MARKETABLE_MTM_DEFAULT_H - (resolveMarketableMtmH('single_leg_otm').h as number));
    expect(rvGap).toBeLessThan(otmGap / 5);
    expect(MODELED_H_CALIBRATION.byStructure.single_leg_rv.n / MODELED_H_CALIBRATION.n)
      .toBeGreaterThan(0.88);
  });

  it('the table is DERIVED from the calibration, not a second literal beside it', () => {
    expect(Object.keys(MARKETABLE_MTM_H_BY_STRUCTURE).sort())
      .toEqual(Object.keys(MODELED_H_CALIBRATION.byStructure).sort());
  });
});

describe('TRA-3697 AC2 — an UNCALIBRATED structure refuses, and does NOT get 0.134', () => {
  it('single_leg_directional REFUSES — h is null, never the pooled default', () => {
    const res = resolveMarketableMtmH('single_leg_directional');
    expect(res.ok).toBe(false);
    expect(res.h).toBeNull();
    // The assertion that matters. `not.toBe(0.134)` alone would pass on `undefined`.
    expect(res.h).not.toBe(MARKETABLE_MTM_DEFAULT_H);
    expect(res.n).toBe(0);
    expect(res.refusal?.code).toBe('UNCALIBRATED_STRUCTURE');
    expect(res.refusal?.reason).toContain('single_leg_directional');
    // `byStructure` carries ZERO directional rows — that is WHY it refuses, and the refusal
    // must not outlive the fact.
    expect(MODELED_H_CALIBRATION.byStructure)
      .not.toHaveProperty('single_leg_directional');
  });

  it('MUTATION CONTROL — reintroducing the fallback makes the refusal assertions GO RED', () => {
    // The mutant: the exact defect this ticket removes — resolve, else fall back to the
    // fleet-wide scalar. Every call site would read this as a calibrated structure.
    const mutantResolve = (structure: string): { h: number } => {
      const real = resolveMarketableMtmH(structure);
      return { h: real.ok ? real.h : MARKETABLE_MTM_DEFAULT_H };
    };

    // The predicate the real test above asserts, factored so it can be aimed at either.
    const refusesDirectional = (resolve: (s: string) => { h: number | null }): boolean =>
      resolve('single_leg_directional').h === null;

    expect(refusesDirectional(resolveMarketableMtmH)).toBe(true);
    // …and it DISCRIMINATES: the fallback variant fails it.
    expect(refusesDirectional(mutantResolve)).toBe(false);
    // The over-charge the fallback would apply, named so the cost is not abstract: rv's
    // 0.1428 against directional's forward desk mean of 0.036 is ~3.7×.
    expect(mutantResolve('single_leg_directional').h / 0.036).toBeGreaterThan(3.5);
  });

  it('an unknown structure refuses too — the rule is "has a fit", not a directional special case', () => {
    for (const s of ['single_leg', 'iron_condor', 'put_write', '']) {
      expect(resolveMarketableMtmH(s).ok).toBe(false);
      expect(resolveMarketableMtmH(s).h).toBeNull();
    }
  });

  it('marketableMtmUncalibratedStructures NAMES them, deduped and sorted', () => {
    expect(marketableMtmUncalibratedStructures([
      'single_leg_rv', 'single_leg_directional', 'single_leg_otm', 'single_leg_directional', 'zzz',
    ])).toEqual(['single_leg_directional', 'zzz']);
    // A fully calibrated population reports EMPTY — the field has a passing state.
    expect(marketableMtmUncalibratedStructures(['single_leg_rv', 'single_leg_otm'])).toEqual([]);
  });
});

describe('TRA-3697 AC3 — the refusal is NAMED on the payload and costs the verdict its OK', () => {
  it('the demo-journal fold names uncalibrated structures it actually saw', () => {
    const out = foldMarketableMtmDemoJournalBasis(
      [
        row({ structure: 'single_leg_rv' }),
        row({ structure: 'single_leg_otm' }),
        row({ structure: 'single_leg_directional' }),
      ],
      { isTestAccount },
    );
    expect(out.refusal).toBeNull();
    expect(out.structuresUncalibratedH).toEqual(['single_leg_directional']);
    expect(out.hByStructure).toEqual(MARKETABLE_MTM_H_BY_STRUCTURE);
  });

  it('a wholly calibrated book reports an EMPTY list — not a vacuous one', () => {
    const out = foldMarketableMtmDemoJournalBasis(
      [row({ structure: 'single_leg_rv' }), row({ structure: 'single_leg_otm' })],
      { isTestAccount },
    );
    expect(out.structuresUncalibratedH).toEqual([]);
  });

  it('per-cell: a calibrated cell carries its own h; an uncalibrated one carries a REFUSAL', () => {
    const out = foldMarketableMtmDemoJournalBasis(
      [row({ structure: 'single_leg_rv' }), row({ structure: 'single_leg_directional' })],
      { isTestAccount },
    );
    const rv = out.cells.find((c) => c.structure === 'single_leg_rv' && c.accountClass === '*');
    const dir = out.cells.find((c) => c.structure === 'single_leg_directional' && c.accountClass === '*');
    expect(rv?.calibratedH).toBe(MODELED_H_CALIBRATION.byStructure.single_leg_rv.hMean);
    expect(rv?.hRefusal).toBeNull();
    expect(dir?.calibratedH).toBeNull();
    expect(dir?.calibratedH).not.toBe(MARKETABLE_MTM_DEFAULT_H);
    expect(dir?.hRefusal?.code).toBe('UNCALIBRATED_STRUCTURE');
  });

  it('the `*` MARGINAL is POOLED_MARGINAL, not uncalibrated — a marginal has no structure', () => {
    const out = foldMarketableMtmDemoJournalBasis([row({ structure: 'single_leg_rv' })], { isTestAccount });
    expect(out.pooled?.calibratedH).toBeNull();
    expect(out.pooled?.hRefusal?.code).toBe('POOLED_MARGINAL');
    // …and it must never leak into the census, or a perfectly calibrated book reads dirty.
    expect(out.structuresUncalibratedH).toEqual([]);
    expect(out.structuresUncalibratedH).not.toContain('*');
  });

  it('a PASS is REVOKED to REVIEW while any structure is uncalibrated, and the reason NAMES it', () => {
    const pass: MarketableMtmVerdict = { code: 'PASS', basis: 'quotedH', reason: 'within tolerance' };
    const out = marketableMtmVerdictWithUncalibrated(pass, ['single_leg_directional']);
    expect(out.code).toBe('REVIEW');
    expect(out.basis).toBe('quotedH');
    expect(out.reason).toContain('single_leg_directional');
    expect(out.reason).toContain('UNCALIBRATED');
  });

  it('an empty census is a strict NO-OP — the same verdict object passes straight through', () => {
    const pass: MarketableMtmVerdict = { code: 'PASS', basis: 'quotedH', reason: 'within tolerance' };
    expect(marketableMtmVerdictWithUncalibrated(pass, [])).toBe(pass);
  });

  it('NOT_GRADEABLE KEEPS its code — a terminal does not become a waiting state', () => {
    const term: MarketableMtmVerdict = { code: 'NOT_GRADEABLE', basis: 'quotedH', reason: 'population unfit' };
    const out = marketableMtmVerdictWithUncalibrated(term, ['single_leg_directional']);
    expect(out.code).toBe('NOT_GRADEABLE');
    expect(out.reason).toContain('population unfit');
    expect(out.reason).toContain('single_leg_directional');
  });

  it('a REVIEW keeps its OWN reason and GAINS the detail — no reason is dropped', () => {
    const rev: MarketableMtmVerdict = { code: 'REVIEW', basis: 'actualH', reason: 'insufficient n (4 < 30)' };
    const out = marketableMtmVerdictWithUncalibrated(rev, ['single_leg_directional']);
    expect(out.code).toBe('REVIEW');
    expect(out.reason).toContain('insufficient n (4 < 30)');
    expect(out.reason).toContain('single_leg_directional');
  });
});

describe('TRA-3697 AC4 — a spec change to h’s SHAPE, not to any measured value', () => {
  const rows = [
    row({ structure: 'single_leg_rv' }),
    row({ structure: 'single_leg_otm', entryBid: 1.20, entryAsk: 1.45, entryMarkUsd: 1.325 }),
    row({ structure: 'single_leg_directional', entryBid: 1.30, entryAsk: 1.35, entryMarkUsd: 1.325 }),
  ];

  it('MEASURED moments are untouched by h — quotedH / n / mid / spread read the same', () => {
    const out = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount });
    // The same fold at a DIFFERENT h. Every measured field must be byte-identical: these come
    // off the quoted book, and `h` is the model being graded against them, never an input.
    const other = foldMarketableMtmDemoJournalBasis(rows, { isTestAccount, h: 0.3 });
    for (const c of out.cells) {
      const o = other.cells.find((x) => x.structure === c.structure && x.accountClass === c.accountClass);
      expect(o).toBeDefined();
      expect(o?.n).toBe(c.n);
      expect(o?.quotedH).toEqual(c.quotedH);
      expect(o?.quotedCrossUsd).toEqual(c.quotedCrossUsd);
      expect(o?.midUsd).toEqual(c.midUsd);
      expect(o?.fullSpreadUsd).toEqual(c.fullSpreadUsd);
      // …and the calibrated lookup is a property of the STRUCTURE, not of the caller's h.
      expect(o?.calibratedH).toBe(c.calibratedH);
    }
    expect(other.structuresUncalibratedH).toEqual(out.structuresUncalibratedH);
  });

  it('the pooled scalar is STILL exported and STILL 0.134 — callers with no structure keep it', () => {
    expect(MARKETABLE_MTM_DEFAULT_H).toBe(0.134);
    // …and the fold still defaults to it, so today's published cells do not move.
    expect(foldMarketableMtmDemoJournalBasis(rows, { isTestAccount }).modeledH)
      .toBe(MARKETABLE_MTM_DEFAULT_H);
  });
});
