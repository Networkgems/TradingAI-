import { describe, it, expect } from 'vitest';
import {
  EXECUTION_ASSET_CLASSES,
  computeExecutionQualityKpi,
  type ExecutionSlippageFill,
} from './execution-quality.js';

function fill(
  assetClass: ExecutionSlippageFill['assetClass'],
  realizedUsd: number | null,
  modeledUsd: number | null,
): ExecutionSlippageFill {
  return { assetClass, symbol: 'X', realizedUsd, modeledUsd };
}

describe('computeExecutionQualityKpi (TRA-1981)', () => {
  it('an empty input yields all-null figures and zero counts for every class + overall', () => {
    const kpi = computeExecutionQualityKpi([]);
    for (const ac of EXECUTION_ASSET_CLASSES) {
      const c = kpi.byAssetClass[ac];
      expect(c.assetClass).toBe(ac);
      expect(c.fills).toBe(0);
      expect(c.measured).toBe(0);
      expect(c.realizedTotalUsd).toBeNull();
      expect(c.modeledTotalUsd).toBeNull();
      expect(c.meanRealizedUsd).toBeNull();
      expect(c.meanModeledUsd).toBeNull();
      expect(c.decayRatio).toBeNull();
    }
    expect(kpi.overall.fills).toBe(0);
    expect(kpi.overall.decayRatio).toBeNull();
  });

  it('decay ratio is Σ|realized| ÷ Σ|modeled| over measured fills', () => {
    // equity: realized 3 + 1 = 4 (abs), modeled 2 + 2 = 4 → decay 1.0
    const kpi = computeExecutionQualityKpi([
      fill('equity', 3, 2),
      fill('equity', 1, 2),
    ]);
    const eq = kpi.byAssetClass.equity;
    expect(eq.fills).toBe(2);
    expect(eq.measured).toBe(2);
    expect(eq.modeledTotalUsd).toBe(4);
    expect(eq.realizedTotalUsd).toBe(4);
    expect(eq.decayRatio).toBe(1);
  });

  it('a decay ratio > 1 surfaces execution running hotter than the model', () => {
    const kpi = computeExecutionQualityKpi([fill('crypto', 9, 3)]);
    expect(kpi.byAssetClass.crypto.decayRatio).toBe(3);
  });

  it('TRA-1707: a fill measured on only one leg is NOT counted in the ratio (null, never 0)', () => {
    const kpi = computeExecutionQualityKpi([
      fill('options', 5, null), // realized but no modeled — unmeasured pair
      fill('options', null, 4), // modeled but no realized — unmeasured pair
    ]);
    const o = kpi.byAssetClass.options;
    expect(o.fills).toBe(2); // both fills happened
    expect(o.measured).toBe(0); // neither is a measured PAIR
    expect(o.decayRatio).toBeNull();
    expect(o.meanRealizedUsd).toBeNull();
    expect(o.meanModeledUsd).toBeNull();
  });

  it('realized total is SIGNED (price improvement nets against paying up) while the ratio uses magnitudes', () => {
    // one fill paid up (+4), one got improvement (−2); modeled 2 each.
    const kpi = computeExecutionQualityKpi([
      fill('options', 4, 2),
      fill('options', -2, 2),
    ]);
    const o = kpi.byAssetClass.options;
    expect(o.realizedTotalUsd).toBe(2); // signed: 4 + (−2)
    expect(o.meanRealizedUsd).toBe(1);
    // ratio uses |realized|: (4 + 2) / (2 + 2) = 1.5
    expect(o.decayRatio).toBe(1.5);
  });

  it('a zero modeled denominator yields a null ratio, never a divide-by-zero', () => {
    const kpi = computeExecutionQualityKpi([fill('equity', 5, 0)]);
    const eq = kpi.byAssetClass.equity;
    expect(eq.measured).toBe(1); // 0 is a MEASURED modeled leg (finite), so it counts
    expect(eq.modeledTotalUsd).toBe(0);
    expect(eq.decayRatio).toBeNull(); // but Σ|modeled| = 0 → ratio undefined, reported null
  });

  it('folds each class independently and blends the overall', () => {
    const kpi = computeExecutionQualityKpi([
      fill('equity', 2, 2),
      fill('crypto', 6, 2),
      fill('options', 4, 4),
    ]);
    expect(kpi.byAssetClass.equity.decayRatio).toBe(1);
    expect(kpi.byAssetClass.crypto.decayRatio).toBe(3);
    expect(kpi.byAssetClass.options.decayRatio).toBe(1);
    // overall: Σ|realized| = 12, Σ|modeled| = 8 → 1.5
    expect(kpi.overall.fills).toBe(3);
    expect(kpi.overall.measured).toBe(3);
    expect(kpi.overall.decayRatio).toBe(1.5);
  });
});
