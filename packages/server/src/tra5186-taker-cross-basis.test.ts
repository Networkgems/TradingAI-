// TRA-5186 — taker-cross basis-error canary on the real-fill shadow ledger.
//
// Demo-only instrumentation off the CTO sign-off on TRA-5184: per decision row
// (admit or reject), the $-per-contract error between the booked pre-trade NBBO
// mid and an IMMEDIATE taker cross off the row's own decision-time quote stamp.
// These tests pin the quote-stamp arithmetic to a hand-computable fixture, the
// nearest-rank percentiles, the exclude-and-count discipline for unusable
// quotes, and the measured-vs-modeled grade of `makerAdjustedSpreadCrossR`.

import { describe, it, expect, beforeEach } from 'vitest';
import {
  beginRestingOrder,
  finalizeRestingOrder,
  buildTaxonomy,
  carryEntryTaxonomyToExit,
  takerCrossBasisErrorUsdPerContract,
  summarizeTakerCrossBasis,
  recordTakerCrossUnusableQuote,
  resetTakerCrossUnusableForTests,
  TAKER_CROSS_BASIS_SCHEMA,
  TAKER_CROSS_PREREGISTERED_READ,
  DEFAULT_REAL_FILL_CONFIG,
  type RealFillShadowRow,
  type RealFillAdmission,
} from './option-real-fill-shadow.js';

const T0 = 1_750_000_000_000;

/**
 * Build a terminal ledger row through the REAL constructors — the same path the
 * engine takes — so the test exercises the shipped quote-stamp plumbing rather
 * than a hand-rolled literal that could drift from it.
 */
function makeRow(over: {
  structure: string;
  bid: number;
  ask: number;
  admission: RealFillAdmission;
  optionSymbol?: string;
  asExit?: boolean;
}): RealFillShadowRow {
  const state = beginRestingOrder(
    {
      side: 'buy',
      optionSymbol: over.optionSymbol ?? 'TEST260116C00100000',
      limitUsd: (over.bid + over.ask) / 2,
      contracts: 1,
      bid: over.bid,
      ask: over.ask,
    },
    T0,
    DEFAULT_REAL_FILL_CONFIG,
  );
  if (!state) throw new Error('fixture quote must be two-sided');
  let taxonomy = buildTaxonomy({
    structure: over.structure,
    delta: 0.52,
    dte: 30,
    bid: over.bid,
    ask: over.ask,
    openInterest: 500,
    entryType: 'maker_mid',
    hasExit: false,
  });
  if (over.asExit) taxonomy = carryEntryTaxonomyToExit(taxonomy, 'stop_loss');
  return finalizeRestingOrder(
    state,
    {
      mode: 'demo',
      structure: over.structure,
      underlying: 'TEST',
      taxonomy,
      admission: over.admission,
      refusedAtGate: over.admission === 'refused' ? 'cost_bar' : null,
      refusalReasonCode: over.admission === 'refused' ? 'shortfall_gte_0.50' : null,
    },
    T0 + 60_000,
  );
}

beforeEach(() => {
  resetTakerCrossUnusableForTests();
});

describe('takerCrossBasisErrorUsdPerContract', () => {
  it('prices the immediate cross as the half-spread, in dollars per contract', () => {
    // Fixture quote: bid 1.00 / ask 1.30 ⇒ mid 1.15, spread 0.30.
    // A buy crossing immediately pays the ask: 1.30 − 1.15 = 0.15/share = $15/contract.
    const row = makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.3, admission: 'refused' });
    expect(takerCrossBasisErrorUsdPerContract(row)).toBeCloseTo(15, 10);
  });

  it('returns null — never zero — when the stamp carries no usable spread', () => {
    const row = makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.3, admission: 'refused' });
    const broken: RealFillShadowRow = {
      ...row,
      taxonomy: { ...row.taxonomy, spreadUsd: null, spreadPct: null },
    };
    expect(takerCrossBasisErrorUsdPerContract(broken)).toBeNull();
  });
});

describe('summarizeTakerCrossBasis', () => {
  it('folds per structure with mean / nearest-rank median / p90 over the union population', () => {
    // Five OTM decision rows with half-spread errors $5, $10, $15, $20, $25.
    const rows = [0.1, 0.2, 0.3, 0.4, 0.5].map((spread, i) =>
      makeRow({
        structure: 'single_leg_otm',
        bid: 1.0,
        ask: 1.0 + spread,
        admission: i === 0 ? 'admitted' : 'refused',
        optionSymbol: `TEST260116C0010${i}000`,
      }),
    );
    const summary = summarizeTakerCrossBasis(rows, { modeledRoundTripCrossR: 0.235, generatedAt: T0 });

    expect(summary.schema).toBe(TAKER_CROSS_BASIS_SCHEMA);
    expect(summary.preRegisteredRead).toBe(TAKER_CROSS_PREREGISTERED_READ);
    expect(summary.entryRows).toBe(5);
    expect(summary.byStructure).toHaveLength(1);

    const otm = summary.byStructure[0];
    expect(otm.structure).toBe('single_leg_otm');
    expect(otm.n).toBe(5);
    expect(otm.nAdmitted).toBe(1);
    expect(otm.nRefused).toBe(4);
    expect(otm.meanBasisErrorUsdPerContract).toBeCloseTo(15, 10);
    // Nearest-rank over [5,10,15,20,25]: median rank ceil(0.5·5)=3 ⇒ 15; p90 rank ceil(0.9·5)=5 ⇒ 25.
    expect(otm.medianBasisErrorUsdPerContract).toBeCloseTo(15, 10);
    expect(otm.p90BasisErrorUsdPerContract).toBeCloseTo(25, 10);
    expect(otm.rowsUnusableQuote).toBe(0);
    expect(otm.shareUnusableQuote).toBe(0);
  });

  it('grades measured-vs-modeled in the gate\'s stop-R unit (entry cross = 2·spreadPct)', () => {
    // bid 1.00 / ask 1.30: spreadPct = 0.30/1.15; entry one-way cross in R = 2·spreadPct.
    const row = makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.3, admission: 'refused' });
    const summary = summarizeTakerCrossBasis([row], { modeledRoundTripCrossR: 0.235 });
    const otm = summary.byStructure[0];
    const expectedCrossR = 2 * (0.3 / 1.15);
    expect(otm.measuredMeanEntryCrossR).toBeCloseTo(expectedCrossR, 10);
    expect(otm.modeledEntryCrossR).toBeCloseTo(0.1175, 10);
    expect(otm.measuredOverModeledRatio).toBeCloseTo(expectedCrossR / 0.1175, 10);
    expect(summary.modeledRoundTripCrossR).toBeCloseTo(0.235, 10);
  });

  it('excludes close rows from the decision population and counts them', () => {
    const open = makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.2, admission: 'admitted' });
    const close = makeRow({
      structure: 'single_leg_otm',
      bid: 0.8,
      ask: 1.0,
      admission: 'admitted',
      asExit: true,
    });
    const summary = summarizeTakerCrossBasis([open, close]);
    expect(summary.entryRows).toBe(1);
    expect(summary.closeRowsExcluded).toBe(1);
    expect(summary.byStructure[0].n).toBe(1);
  });

  it('excludes-and-counts a ledger row with an unusable stamp, never imputing it', () => {
    const good = makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.3, admission: 'refused' });
    const bad = makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.3, admission: 'refused' });
    const broken: RealFillShadowRow = {
      ...bad,
      taxonomy: { ...bad.taxonomy, spreadUsd: null, spreadPct: null },
    };
    const summary = summarizeTakerCrossBasis([good, broken]);
    const otm = summary.byStructure[0];
    expect(otm.n).toBe(1);
    expect(otm.rowsUnusableQuote).toBe(1);
    expect(otm.shareUnusableQuote).toBeCloseTo(0.5, 10);
    // The mean is over the ONE usable row — the broken one contributed nothing.
    expect(otm.meanBasisErrorUsdPerContract).toBeCloseTo(15, 10);
  });

  it('splits structures and sorts them by key', () => {
    const rows = [
      makeRow({ structure: 'single_leg_otm', bid: 1.0, ask: 1.3, admission: 'refused' }),
      makeRow({ structure: 'single_leg_directional', bid: 2.0, ask: 2.1, admission: 'refused' }),
    ];
    const summary = summarizeTakerCrossBasis(rows);
    expect(summary.byStructure.map((s) => s.structure)).toEqual([
      'single_leg_directional',
      'single_leg_otm',
    ]);
    // directional: spread 0.10 ⇒ $5/contract.
    expect(summary.byStructure[0].meanBasisErrorUsdPerContract).toBeCloseTo(5, 10);
  });

  it('is empty-safe: zero rows yield no structures and no NaN', () => {
    const summary = summarizeTakerCrossBasis([]);
    expect(summary.entryRows).toBe(0);
    expect(summary.closeRowsExcluded).toBe(0);
    expect(summary.byStructure).toEqual([]);
  });

  it('publishes the since-boot decision-point unusable counter the engine stamps at drop sites', () => {
    recordTakerCrossUnusableQuote('single_leg_otm', 'refused');
    recordTakerCrossUnusableQuote('single_leg_otm', 'refused');
    recordTakerCrossUnusableQuote('single_leg_otm', 'admitted');
    const summary = summarizeTakerCrossBasis([]);
    expect(summary.decisionPointUnusableSinceBoot.samplingWindow).toBe('since_boot');
    expect(summary.decisionPointUnusableSinceBoot.byStructure).toEqual([
      { structure: 'single_leg_otm', admitted: 1, refused: 2, total: 3 },
    ]);
  });
});
