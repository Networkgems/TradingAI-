import { describe, it, expect } from 'vitest';
import {
  fitSkewCurves,
  findTermStructureDislocations,
} from './relative-value.js';
import type { OptionChainRow } from './otm-mispricing.js';
import { blackScholesPrice, daysToExpiration } from './black-scholes.js';

const NOW = Date.parse('2024-01-15T15:00:00Z');
const R = 0.045;
const SPOT = 100;

/** Expiration date string `days` calendar days out from NOW. */
function expDate(days: number): string {
  return new Date(NOW + days * 86_400_000).toISOString().slice(0, 10);
}

/** Years to expiry exactly as the module computes it (dte / 365). */
function yearsTo(expiration: string): number {
  return daysToExpiration(expiration, NOW) / 365;
}

interface TermRowSpec {
  expDays: number;
  strike: number;
  optionType?: 'call' | 'put';
  /** σ the row carries (what `resolveIv` will use). */
  midIv: number;
  /**
   * σ the MARK is priced at (defaults to `midIv`). Letting these disagree
   * mirrors the vendor-IV-vs-tape independence measured on TRA-2662, and lets
   * a test plant a term-IV outlier without also planting a calendar arb.
   */
  markIv?: number;
  rowOverrides?: Partial<OptionChainRow>;
}

function buildTermChain(specs: TermRowSpec[]): OptionChainRow[] {
  return specs.map((s) => {
    const optionType = s.optionType ?? 'call';
    const expiration = expDate(s.expDays);
    const fair = blackScholesPrice({
      spot: SPOT,
      strike: s.strike,
      timeToExpiryYears: yearsTo(expiration),
      riskFreeRate: R,
      volatility: s.markIv ?? s.midIv,
      optionType,
    });
    const mark = Math.max(0.05, fair);
    const half = mark * 0.02;
    return {
      optionSymbol: `TEST${s.expDays}D${s.strike}${optionType.toUpperCase()}`,
      underlying: 'TEST',
      optionType,
      strike: s.strike,
      expiration,
      bid: Math.max(0.01, mark - half),
      ask: mark + half,
      last: mark,
      volume: 500,
      openInterest: 1000,
      midIv: s.midIv,
      ...(s.rowOverrides ?? {}),
    };
  });
}

const SCAN_OPTS = { now: NOW, minMark: 0.05 } as const;

/** Baseline term curve: mild contango, exactly linear in √T. */
function baselineIv(expDays: number): number {
  return 0.28 + 0.05 * Math.sqrt(yearsTo(expDate(expDays)));
}

const BASELINE_DAYS = [30, 40, 50, 60, 75, 90, 105, 120];

function baselineSpecs(): TermRowSpec[] {
  return BASELINE_DAYS.map((d) => ({ expDays: d, strike: 100, midIv: baselineIv(d) }));
}

describe('fitSkewCurves (TRA-4413 skew-coefficient export)', () => {
  it('recovers a planted quadratic IV(x) per (expiration, type) group', () => {
    const strikes = [80, 90, 95, 100, 105, 110, 120];
    const exp = expDate(45);
    const chain: OptionChainRow[] = strikes.map((strike) => {
      const x = Math.log(strike / SPOT);
      const iv = 0.3 + 0.1 * x + 0.5 * x * x;
      const fair = blackScholesPrice({
        spot: SPOT,
        strike,
        timeToExpiryYears: yearsTo(exp),
        riskFreeRate: R,
        volatility: iv,
        optionType: 'call',
      });
      const mark = Math.max(0.05, fair);
      const half = mark * 0.02;
      return {
        optionSymbol: `SKEW${strike}C`,
        underlying: 'TEST',
        optionType: 'call' as const,
        strike,
        expiration: exp,
        bid: Math.max(0.01, mark - half),
        ask: mark + half,
        last: mark,
        volume: 500,
        openInterest: 1000,
        midIv: iv,
      };
    });

    const fits = fitSkewCurves(chain, SPOT, SCAN_OPTS);
    expect(fits).toHaveLength(1);
    const fit = fits[0];
    expect(fit.expiration).toBe(exp);
    expect(fit.optionType).toBe('call');
    expect(fit.sampleSize).toBe(strikes.length);
    expect(fit.a).toBeCloseTo(0.3, 3);
    expect(fit.b).toBeCloseTo(0.1, 3);
    expect(fit.c).toBeCloseTo(0.5, 2);
    // The planted surface is exactly quadratic — retained disagreement is ~0.
    expect(fit.rmse).toBeLessThan(1e-6);
  });

  it('omits groups below minGroupSize instead of fitting garbage', () => {
    const chain = buildTermChain([
      { expDays: 45, strike: 100, midIv: 0.3 },
      { expDays: 45, strike: 105, midIv: 0.3 },
    ]);
    expect(fitSkewCurves(chain, SPOT, SCAN_OPTS)).toHaveLength(0);
  });
});

describe('findTermStructureDislocations (TRA-4413 item 4)', () => {
  it('flags a contract priced cheap against its delta bucket term curve', () => {
    // 8 baseline expirations exactly on α + β·√T, one 65d row 8 vol points
    // under the curve. Its MARK is priced at the curve so the calendar-arb
    // negative control stays clean and the term arm is graded in isolation.
    const specs = [...baselineSpecs(), {
      expDays: 65,
      strike: 100,
      midIv: baselineIv(65) - 0.08,
      markIv: baselineIv(65),
    }];
    const report = findTermStructureDislocations(buildTermChain(specs), SPOT, SCAN_OPTS);

    expect(report.rowsIn).toBe(9);
    expect(report.rowsPrepared).toBe(9);
    expect(report.markCalendarViolations).toHaveLength(0);
    expect(report.calendarPairsTested).toBeGreaterThan(0);
    expect(report.bucketsFitted).toBeGreaterThanOrEqual(1);

    expect(report.dislocations).toHaveLength(1);
    const d = report.dislocations[0];
    expect(d.optionSymbol).toBe('TEST65D100CALL');
    expect(d.classification).toBe('term_cheap');
    expect(d.zScoreTerm).toBeLessThanOrEqual(-2);
    expect(d.ivResidualTerm).toBeLessThan(0);
    // The bucket fit is published so over-smoothing is auditable.
    const fit = report.bucketFits.find((f) => f.bucketKey === d.bucketKey);
    expect(fit).toBeDefined();
    expect(fit!.distinctExpirations).toBe(9);
  });

  it('flags the symmetric rich outlier as term_rich', () => {
    const specs = [...baselineSpecs(), {
      expDays: 65,
      strike: 100,
      midIv: baselineIv(65) + 0.08,
      markIv: baselineIv(65),
    }];
    const report = findTermStructureDislocations(buildTermChain(specs), SPOT, SCAN_OPTS);
    expect(report.dislocations).toHaveLength(1);
    expect(report.dislocations[0].optionSymbol).toBe('TEST65D100CALL');
    expect(report.dislocations[0].classification).toBe('term_rich');
    expect(report.dislocations[0].zScoreTerm).toBeGreaterThanOrEqual(2);
  });

  it('reports a clean pass (no dislocations) on an exactly-on-curve chain', () => {
    const report = findTermStructureDislocations(buildTermChain(baselineSpecs()), SPOT, SCAN_OPTS);
    expect(report.dislocations).toHaveLength(0);
    expect(report.rowsEvaluated).toBe(BASELINE_DAYS.length);
    expect(report.markCalendarViolations).toHaveLength(0);
  });

  it('refuses a bucket with too few distinct expirations, with a countable reason', () => {
    const chain = buildTermChain([
      { expDays: 30, strike: 100, midIv: 0.3 },
      { expDays: 60, strike: 100, midIv: 0.3 },
    ]);
    const report = findTermStructureDislocations(chain, SPOT, SCAN_OPTS);
    expect(report.dislocations).toHaveLength(0);
    expect(report.bucketsFitted).toBe(0);
    expect(report.bucketsSkipped.length).toBeGreaterThanOrEqual(1);
    for (const skip of report.bucketsSkipped) {
      expect(skip.reason).toBe('insufficient_expirations');
      expect(skip.distinctExpirations).toBeLessThan(3);
    }
    expect(report.rowsEvaluated).toBe(0);
  });

  it('negative control: a mark surface violating calendar no-arb is reported and countable', () => {
    // Corrupt the tape: hammer the 120d mark far below the 105d mark at the
    // same strike. The control must flag it — a detector that cannot see a
    // planted violation proves nothing by reading 0 on the live tape.
    const specs = baselineSpecs().map((s) =>
      s.expDays === 120
        ? { ...s, rowOverrides: { bid: 0.98, ask: 1.02, last: 1.0 } }
        : s,
    );
    const report = findTermStructureDislocations(buildTermChain(specs), SPOT, SCAN_OPTS);
    expect(report.markCalendarViolations.length).toBeGreaterThanOrEqual(1);
    const v = report.markCalendarViolations[0];
    expect(v.strike).toBe(100);
    expect(v.longExpiration).toBe(expDate(120));
    expect(v.longMark).toBeLessThan(v.shortMark);
  });

  it('grades the same population as the strike pass: filtered rows never reach a fit', () => {
    const specs = [...baselineSpecs(), {
      // Fails the OI floor — must be excluded from rowsPrepared entirely.
      expDays: 65,
      strike: 100,
      midIv: baselineIv(65) - 0.08,
      markIv: baselineIv(65),
      rowOverrides: { openInterest: 10 },
    }];
    const report = findTermStructureDislocations(buildTermChain(specs), SPOT, SCAN_OPTS);
    expect(report.rowsIn).toBe(9);
    expect(report.rowsPrepared).toBe(8);
    expect(report.dislocations).toHaveLength(0);
  });

  it('returns an empty report with denominators intact on a bad spot', () => {
    const report = findTermStructureDislocations(buildTermChain(baselineSpecs()), 0, SCAN_OPTS);
    expect(report.rowsIn).toBe(BASELINE_DAYS.length);
    expect(report.rowsPrepared).toBe(0);
    expect(report.dislocations).toHaveLength(0);
  });
});
