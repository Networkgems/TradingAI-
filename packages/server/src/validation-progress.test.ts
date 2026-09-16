import { describe, it, expect } from 'vitest';
import { computeValidationProgress, DEFAULT_MIN_DETECTABLE_EFFECT } from './validation-progress.js';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';

/**
 * TRA-4607 — the join between the live ledger and the TRA-4604 harness.
 *
 * The load-bearing arms are the ones that keep the SAMPLE honest. Every cheap
 * way to "make progress" toward the 727 bar is a way of counting rows that are
 * not evidence, and each one below is paired with the control that proves the
 * exclusion is selective rather than the module simply refusing everything.
 */

let t = 0;
function fill(over: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
  t += 86_400_000;
  return {
    mode: 'live',
    ts: t,
    etDay: '2026-09-15',
    sleeve: 'single_leg_otm',
    book: 'admin',
    optionSymbol: 'ATEC260918C00011000',
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: 1.0,
    askAtSubmit: 1.02,
    midAtSubmit: 1.0,
    filledPrice: 1.0,
    fees: 0.19,
    feeSource: 'history_commission',
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: 1,
    origin: 'fill',
    ...over,
  } as LiveOptionFillRecord;
}

/**
 * One priced round-trip: open at 1.00, close at `closePrice`.
 *
 * ⚠️ Callers building a COHORT must vary `closePrice`. A set of identical
 * round-trips has σ = 0, which drives requiredN to 0 and makes every power
 * assertion vacuously true — the fixture would be asserting nothing.
 */
function roundTrip(
  over: Partial<LiveOptionFillRecord> = {},
  closePrice = 1.5,
): LiveOptionFillRecord[] {
  return [
    fill({ side: 'buy_to_open', filledPrice: 1.0, midAtSubmit: 1.0, ...over }),
    fill({ side: 'sell_to_close', filledPrice: closePrice, midAtSubmit: closePrice, ...over }),
  ];
}

/** A cohort with REAL dispersion: alternating winners and losers. */
function cohort(n: number, over: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord[] {
  const closes = [1.6, 0.8, 1.4, 0.9, 1.7, 0.7];
  return Array.from({ length: n }, (_, i) =>
    roundTrip({ optionSymbol: `SYM${i}`, ...over }, closes[i % closes.length]),
  ).flat();
}

describe('computeValidationProgress — sample integrity', () => {
  it('EXCLUDES unattributed rows rather than crediting them to a sleeve', () => {
    // ⛔ The fastest possible way to fake progress toward 727: TRA-2959 rows are
    // fills recovered from broker history with NO sleeve provenance. Counting
    // them toward single_leg_otm would inflate the sample with trades the sleeve
    // may never have made.
    const recs = [
      ...roundTrip({ sleeve: 'unattributed' }),
      ...roundTrip({ sleeve: 'unattributed' }),
    ];
    const r = computeValidationProgress(recs);
    expect(r.excluded.unattributed).toBe(4);
    expect(r.roundTrips).toBe(0);
    expect(r.unmeasured).toBe(true);
  });

  it('COUNTS the identical rows once they carry a graded sleeve (the control)', () => {
    // Differs by ONE field. If this went red, the exclusion above would be
    // proving nothing — the module would just be refusing everything.
    const r = computeValidationProgress(roundTrip({ sleeve: 'single_leg_otm' }));
    expect(r.excluded.unattributed).toBe(0);
    expect(r.roundTrips).toBe(1);
    expect(r.unmeasured).toBe(false);
  });

  it('EXCLUDES a live sleeve that is not a graded production sleeve', () => {
    const r = computeValidationProgress(roundTrip({ sleeve: 'directional' }));
    expect(r.excluded.otherSleeve).toBe(2);
    expect(r.roundTrips).toBe(0);
  });

  it('reports an unreported fee as an exclusion, never as zero cost', () => {
    // `null` fees are UNMEASURED (TRA-1707). Pricing them at zero would bias
    // every downstream statistic in the flattering direction.
    const recs = roundTrip();
    recs[0]!.fees = null;
    const r = computeValidationProgress(recs);
    expect(r.excluded.unreportedFees).toBe(1);
    expect(r.roundTrips).toBe(0);
  });

  it('reports an open position as still_open, not as a discard', () => {
    const r = computeValidationProgress([fill({ side: 'buy_to_open' })]);
    expect(r.excluded.stillOpen).toBe(1);
    expect(r.roundTrips).toBe(0);
  });

  it('splits fee provenance so a derived-fee cohort is visible as such', () => {
    // Production Tradier history reports 0 commission on every row, so most
    // fees are INFERRED from cost/proceeds. Sound in aggregate, still an
    // inference — it must not present as measured.
    const recs = [
      ...roundTrip(),
      ...roundTrip({ feeSource: 'gainloss_derived' }),
    ];
    const otm = computeValidationProgress(recs).sleeves.find((s) => s.sleeve === 'single_leg_otm')!;
    expect(otm.feeQuality.reported).toBe(2);
    expect(otm.feeQuality.derived).toBe(2);
  });
});

describe('computeValidationProgress — the verdict', () => {
  it('an empty ledger is UNMEASURED, not a failure', () => {
    const r = computeValidationProgress([]);
    expect(r.unmeasured).toBe(true);
    expect(r.note).toMatch(/NOT "the sleeves are failing"/);
    for (const s of r.sleeves) {
      expect(s.verdict.observedN).toBe(0);
      expect(s.note).toMatch(/UNMEASURED/);
    }
  });

  it('grades BOTH production sleeves, always', () => {
    const r = computeValidationProgress([]);
    expect(r.sleeves.map((s) => s.sleeve).sort()).toEqual(['single_leg_otm', 'single_leg_rv']);
  });

  it('a small live cohort is UNDERPOWERED and reports the shortfall', () => {
    // The shape of the real ledger today: a handful of round-trips against a
    // requirement in the hundreds.
    const otm = computeValidationProgress(cohort(6)).sleeves.find((s) => s.sleeve === 'single_leg_otm')!;
    expect(otm.verdict.passes).toBe(false);
    expect(otm.verdict.observedN).toBe(6);
    expect(otm.verdict.shortfall).toBeGreaterThan(0);
    expect(otm.verdict.progress).toBeLessThan(1);
  });

  it('⛔ inflating the detectable effect shrinks requiredN WITHOUT new evidence', () => {
    // This arm exists to make the lever visible rather than convenient. Same
    // data, larger assumed edge, smaller requirement — which is why moving it
    // must be a recorded act.
    const recs = cohort(8);
    const strict = computeValidationProgress(recs, { minDetectableEffectPct: 0.02 });
    const lax = computeValidationProgress(recs, { minDetectableEffectPct: 0.5 });
    const nStrict = strict.sleeves.find((s) => s.sleeve === 'single_leg_otm')!.verdict.power.requiredN;
    const nLax = lax.sleeves.find((s) => s.sleeve === 'single_leg_otm')!.verdict.power.requiredN;
    expect(nLax).toBeLessThan(nStrict);
    // ...and the observed count did NOT change.
    expect(strict.roundTrips).toBe(lax.roundTrips);
  });

  it('the default detectable effect is the documented 0.10', () => {
    expect(DEFAULT_MIN_DETECTABLE_EFFECT).toBe(0.1);
  });
});
