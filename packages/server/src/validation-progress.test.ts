import { describe, it, expect } from 'vitest';
import { computeValidationProgress, DEFAULT_MIN_DETECTABLE_EFFECT } from './validation-progress.js';
import { pairFillsIntoRoundTrips, computeCohortStats } from './paper-accrual-validation.js';
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

/**
 * TRA-4730 — the live OTM ledger as served by bqb1 `c94a5deb` on 2026-09-19
 * (`/api/health/live-options-fee-slippage` `records[]`, every graded-sleeve row,
 * mids rounded to 4dp). Served then: n=6, totalNetPnl −113.13, expectancy
 * −18.86, 0 winners — the spread charged twice, and BULL/ETHA/NVTS13 lost to a
 * `book: null` open vs a stamped close.
 */
function L(
  iso: string,
  book: string | null,
  optionSymbol: string,
  side: 'O' | 'C',
  filledPrice: number,
  midAtSubmit: number | null,
  fees: number,
  feeSource: 'history_commission' | 'gainloss_derived',
): LiveOptionFillRecord {
  return fill({
    ts: Date.parse(iso),
    etDay: iso.slice(0, 10),
    book,
    optionSymbol,
    side: side === 'O' ? 'buy_to_open' : 'sell_to_close',
    filledPrice,
    midAtSubmit,
    fees,
    feeSource,
  });
}

const LIVE_OTM_LEDGER_20260919: LiveOptionFillRecord[] = [
  L('2026-08-21T14:24:10.277Z', null, 'SOFI260925C00019000', 'O', 1.23, 1.205, 0.11, 'gainloss_derived'),
  L('2026-08-21T18:04:24.983Z', null, 'RIG260925C00006000', 'O', 0.33, 0.33, 0.11, 'gainloss_derived'),
  L('2026-08-24T14:25:07.953Z', null, 'NVTS261002C00012500', 'O', 1.54, 1.41, 0.35, 'history_commission'),
  L('2026-08-24T14:44:34.991Z', null, 'NVTS261002C00012500', 'O', 1.51, 1.395, 0.28, 'gainloss_derived'),
  L('2026-08-24T15:15:55.328Z', null, 'RIG260925C00006000', 'C', 0.18, 0.16, 0.13, 'gainloss_derived'),
  L('2026-08-24T17:00:00.000Z', null, 'SOFI260925C00019000', 'C', 0.9, null, 0.13, 'gainloss_derived'),
  L('2026-08-25T13:45:23.481Z', null, 'NVTS261002C00012500', 'C', 1.52, 1.605, 0.35, 'history_commission'),
  L('2026-08-25T13:45:36.092Z', null, 'NVTS261002C00012500', 'C', 1.49, 1.665, 0.31, 'gainloss_derived'),
  L('2026-08-25T14:50:09.854Z', null, 'XLF260930C00058000', 'O', 1.16, 1.115, 0.35, 'history_commission'),
  L('2026-08-25T14:50:19.198Z', null, 'BULL261002C00009000', 'O', 0.71, 0.66, 0.35, 'history_commission'),
  L('2026-08-25T15:26:07.998Z', null, 'NVTS261002C00013000', 'O', 1.45, 1.42, 0.11, 'gainloss_derived'),
  L('2026-08-25T19:04:03.282Z', null, 'ETHA261002C00019000', 'O', 1.28, 1.23, 0.11, 'gainloss_derived'),
  L('2026-08-26T13:45:30.781Z', null, 'XLF260930C00058000', 'C', 1.17, 1.23, 0.35, 'history_commission'),
  L('2026-08-27T15:03:02.117Z', 'v0nni', 'BULL261002C00009000', 'C', 0.75, 0.775, 0.35, 'history_commission'),
  L('2026-08-27T15:12:30.971Z', 'admin', 'ETHA261002C00019000', 'C', 1.27, 1.34, 0.13, 'gainloss_derived'),
  L('2026-08-28T14:15:52.617Z', 'admin', 'NVTS261002C00013000', 'C', 0.89, 0.94, 0.13, 'gainloss_derived'),
  L('2026-08-28T14:35:56.288Z', 'admin', 'KO261002C00090000', 'O', 1.83, 1.79, 0.11, 'gainloss_derived'),
  L('2026-08-28T14:36:02.948Z', 'admin', 'NOK261002C00010500', 'O', 0.73, 0.71, 0.11, 'gainloss_derived'),
  L('2026-09-01T14:46:16.180Z', 'v0nni', 'TTD261009C00014000', 'O', 0.96, 0.92, 0.35, 'history_commission'),
  L('2026-09-01T19:08:15.032Z', 'v0nni', 'SOUN261009C00007000', 'O', 0.54, 0.515, 0.35, 'history_commission'),
  L('2026-09-02T14:13:23.363Z', 'v0nni', 'TTD261009C00014000', 'C', 1, 1.05, 0.35, 'history_commission'),
  L('2026-09-02T17:35:36.498Z', 'admin', 'KO261002C00090000', 'C', 1.15, null, 0.13, 'gainloss_derived'),
  L('2026-09-02T19:50:34.362Z', 'v0nni', 'SOUN261009C00007000', 'C', 0.38, 0.43, 0.35, 'history_commission'),
];

describe('TRA-4730 — the live OTM ledger, priced once', () => {
  const report = computeValidationProgress(LIVE_OTM_LEDGER_20260919);
  const otm = report.sleeves.find((s) => s.sleeve === 'single_leg_otm')!.verdict;
  const pair = () =>
    pairFillsIntoRoundTrips(LIVE_OTM_LEDGER_20260919.map((r) => ({ ...r, source: 'live' as const })));
  const legsOf = (openTs: number, closeTs: number) => ({
    open: LIVE_OTM_LEDGER_20260919.find((r) => r.side === 'buy_to_open' && r.ts === openTs)!,
    close: LIVE_OTM_LEDGER_20260919.find((r) => r.side === 'sell_to_close' && r.ts === closeTs)!,
  });

  it('the 6 strictly-keyed round-trips net −33.63 cash, 2 winners (XLF +0.30, TTD +3.30)', () => {
    const strict = pair().roundTrips.filter((t) => !t.openBookInferred);
    expect(strict).toHaveLength(6);
    const s = computeCohortStats(strict);
    expect(s.totalNetPnl).toBeCloseTo(-33.63, 6);
    expect(s.expectancy).toBeCloseTo(-5.605, 6);
    expect(s.winRate).toBeCloseTo(2 / 6, 9);
    expect(s.totalFees).toBeCloseTo(3.63, 6);
    expect(strict.filter((t) => t.netPnl > 0).map((t) => [t.optionSymbol, +t.netPnl.toFixed(2)])).toEqual([
      ['XLF260930C00058000', 0.3],
      ['TTD261009C00014000', 3.3],
    ]);

    // Fixture fidelity — the NEGATIVE CONTROL. Re-deducting |fill − mid| per leg
    // on these same trips reproduces the figure bqb1 served, to the cent. If the
    // fixture drifted from the served ledger this would move off −113.13.
    const doubleCharged = strict.reduce((sum, t) => {
      const { open, close } = legsOf(t.openTs, t.closeTs);
      const abs =
        (Math.abs(open.filledPrice! - open.midAtSubmit!) + Math.abs(close.filledPrice! - close.midAtSubmit!)) * 100;
      return sum + t.netPnl - abs;
    }, 0);
    expect(doubleCharged).toBeCloseTo(-113.13, 6);
  });

  it('every trip satisfies mid-to-mid − signed crossing − fees = net', () => {
    const { roundTrips } = pair();
    expect(roundTrips.length).toBeGreaterThan(0);
    for (const t of roundTrips) {
      const { open, close } = legsOf(t.openTs, t.closeTs);
      expect((close.midAtSubmit! - open.midAtSubmit!) * 100 - t.slippageCost - t.fees).toBeCloseTo(t.netPnl, 9);
    }
  });

  it('recovers BULL, ETHA and NVTS13 across the 08-27 book stamp: n 6 → 9, counted', () => {
    expect(report.roundTrips).toBe(9);
    expect(report.roundTripsWithInferredOpenBook).toBe(3);
    expect(report.excluded.noMatchingOpen).toBe(0);
    // NOK never closed; the SOFI and KO closes have no mid, so their opens sit
    // queued behind them as still_open.
    expect(report.excluded.unmeasuredMid).toBe(2);
    expect(report.excluded.stillOpen).toBe(3);
    expect(otm.observedN).toBe(9);
    expect(otm.stats.totalNetPnl).toBeCloseTo(-87.81, 6);
    expect(otm.stats.winRate).toBeCloseTo(3 / 9, 9);
    // Before TRA-4730 this cohort served n=6, σ 0.1930, requiredN 30, PF 0.
    expect(otm.stats.stdDevNetReturnPct).toBeCloseTo(0.2013, 4);
    expect(otm.power.requiredN).toBe(32);
    expect(otm.stats.profitFactor).toBeCloseTo(0.0729, 4);
  });
});
