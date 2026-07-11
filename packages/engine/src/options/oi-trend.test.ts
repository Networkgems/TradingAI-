import { describe, it, expect } from 'vitest';
import {
  computeOiTotals,
  classifyOiQuadrant,
  oiQuadrantToConviction,
} from './oi-trend.js';
import type { OptionChainRow } from './otm-mispricing.js';

function row(
  optionType: 'call' | 'put',
  strike: number,
  openInterest: number | undefined,
  expiration = '2026-08-21',
): OptionChainRow {
  return {
    optionSymbol: `X${optionType[0]}${strike}`,
    underlying: 'SPY',
    optionType,
    strike,
    expiration,
    openInterest,
  };
}

describe('computeOiTotals', () => {
  it('sums OI across calls and puts', () => {
    const t = computeOiTotals([
      row('call', 100, 300),
      row('call', 105, 200),
      row('put', 95, 400),
    ]);
    expect(t.oiTotal).toBe(900);
    expect(t.callOpenInterest).toBe(500);
    expect(t.putOpenInterest).toBe(400);
    expect(t.contractsWithOi).toBe(3);
    expect(t.expiriesUsed).toEqual(['2026-08-21']);
    expect(t.insufficientData).toBe(false);
    expect(t.reason).toBeNull();
  });

  it('ignores rows with missing / zero / negative OI and does not count them', () => {
    const t = computeOiTotals([
      row('call', 100, 300),
      row('call', 105, undefined),
      row('put', 95, 0),
      row('put', 90, -50),
    ]);
    expect(t.oiTotal).toBe(300);
    expect(t.contractsWithOi).toBe(1);
  });

  it('nulls the total when no usable OI is present', () => {
    const t = computeOiTotals([row('call', 100, 0), row('put', 95, undefined)]);
    expect(t.oiTotal).toBeNull();
    expect(t.insufficientData).toBe(true);
    expect(t.reason).toBe('no_open_interest');
    expect(t.contractsWithOi).toBe(0);
  });

  it('honors the contracts floor', () => {
    const t = computeOiTotals([row('call', 100, 300)], { minContractsWithOi: 2 });
    expect(t.oiTotal).toBeNull();
    expect(t.insufficientData).toBe(true);
    expect(t.reason).toMatch(/insufficient_oi/);
  });

  it('restricts aggregation to the requested expiries', () => {
    const t = computeOiTotals(
      [
        row('call', 100, 300, '2026-08-21'),
        row('call', 105, 500, '2026-09-18'),
        row('put', 95, 200, '2026-08-21'),
      ],
      { expiries: ['2026-08-21'] },
    );
    expect(t.oiTotal).toBe(500);
    expect(t.expiriesUsed).toEqual(['2026-08-21']);
  });
});

describe('classifyOiQuadrant', () => {
  it('price up / OI up -> strong / confirm', () => {
    const q = classifyOiQuadrant(1.5, 1000);
    expect(q.quadrant).toBe('strong');
    expect(q.conviction).toBe('confirm');
    expect(q.priceDirection).toBe('up');
    expect(q.oiDirection).toBe('up');
    expect(q.reason).toBeNull();
  });

  it('price up / OI down -> weakening / caution', () => {
    const q = classifyOiQuadrant(1.5, -1000);
    expect(q.quadrant).toBe('weakening');
    expect(q.conviction).toBe('caution');
  });

  it('price down / OI up -> weak / veto-candidate (fresh shorts)', () => {
    const q = classifyOiQuadrant(-1.5, 1000);
    expect(q.quadrant).toBe('weak');
    expect(q.conviction).toBe('veto-candidate');
  });

  it('price down / OI down -> weakening / caution (unwinding)', () => {
    const q = classifyOiQuadrant(-1.5, -1000);
    expect(q.quadrant).toBe('weakening');
    expect(q.conviction).toBe('caution');
  });

  it('nulls the quadrant with no prior snapshot', () => {
    const q = classifyOiQuadrant(null, null);
    expect(q.quadrant).toBeNull();
    expect(q.conviction).toBeNull();
    expect(q.reason).toBe('no_prior_snapshot');
    expect(q.priceDirection).toBeNull();
    expect(q.oiDirection).toBeNull();
  });

  it('nulls the quadrant on a flat price leg', () => {
    const q = classifyOiQuadrant(0, 1000);
    expect(q.quadrant).toBeNull();
    expect(q.conviction).toBeNull();
    expect(q.reason).toBe('flat_price');
    expect(q.priceDirection).toBe('flat');
  });

  it('nulls the quadrant on a flat OI leg', () => {
    const q = classifyOiQuadrant(1.5, 0);
    expect(q.quadrant).toBeNull();
    expect(q.reason).toBe('flat_oi');
    expect(q.oiDirection).toBe('flat');
  });

  it('honors the deadband epsilons', () => {
    // A tiny move inside the band reads flat.
    expect(classifyOiQuadrant(0.4, 1000, { priceFlatEps: 0.5 }).reason).toBe('flat_price');
    expect(classifyOiQuadrant(1.5, 40, { oiFlatEps: 50 }).reason).toBe('flat_oi');
    // Just outside the band reads directional.
    expect(classifyOiQuadrant(0.6, 1000, { priceFlatEps: 0.5 }).quadrant).toBe('strong');
  });
});

describe('oiQuadrantToConviction', () => {
  it('maps each quadrant to its bucket', () => {
    expect(oiQuadrantToConviction('strong')).toBe('confirm');
    expect(oiQuadrantToConviction('weak')).toBe('veto-candidate');
    expect(oiQuadrantToConviction('weakening')).toBe('caution');
  });
});
