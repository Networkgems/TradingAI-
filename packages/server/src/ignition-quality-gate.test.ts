import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import {
  isDirectionalQualityGateEnabled,
  resolveDirectionalQualityThresholds,
  averageDollarVolume,
  directionalQualityVerdict,
  OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_DEFAULT,
  OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_DEFAULT,
  OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_DEFAULT,
} from './ignition-quality-gate.js';

// TRA-1476 (parent TRA-1471) — liquidity/quality + per-name churn cap for the
// demo directional ("ignition") entry path that stacked AMPG 28× for −$432.50.

function bar(close: number, volume: number, synthetic = false): Candle {
  return { symbol: 'X', timestamp: 0, open: close, high: close, low: close, close, volume, synthetic };
}

describe('isDirectionalQualityGateEnabled (TRA-1476)', () => {
  it('is OFF unless BOTH the directional flag and the sub-flag are on', () => {
    expect(isDirectionalQualityGateEnabled({})).toBe(false);
    // sub-flag alone is inert — layered on top of the ignition flag
    expect(
      isDirectionalQualityGateEnabled({ ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '1' }),
    ).toBe(false);
    // directional alone does not arm the gate
    expect(isDirectionalQualityGateEnabled({ ENABLE_OPTION_DEMO_DIRECTIONAL: '1' })).toBe(false);
    // both on ⇒ armed
    expect(
      isDirectionalQualityGateEnabled({
        ENABLE_OPTION_DEMO_DIRECTIONAL: 'true',
        ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: 'yes',
      }),
    ).toBe(true);
    // turning the ignition flag off kills the gate even if the sub-flag stays on
    expect(
      isDirectionalQualityGateEnabled({
        ENABLE_OPTION_DEMO_DIRECTIONAL: 'off',
        ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE: '1',
      }),
    ).toBe(false);
  });
});

describe('resolveDirectionalQualityThresholds (TRA-1476)', () => {
  it('uses provisional defaults when unset', () => {
    const t = resolveDirectionalQualityThresholds({});
    expect(t.minUnderlyingPrice).toBe(OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_DEFAULT);
    expect(t.minAvgDollarVolume).toBe(OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_DEFAULT);
    expect(t.maxOpensPerName).toBe(OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_DEFAULT);
    expect(OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_DEFAULT).toBe(5);
    expect(OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_DEFAULT).toBe(3);
  });

  it('honours valid overrides and floors a fractional cap', () => {
    const t = resolveDirectionalQualityThresholds({
      OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: '10',
      OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: '2000000',
      OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: '2.9',
    });
    expect(t.minUnderlyingPrice).toBe(10);
    expect(t.minAvgDollarVolume).toBe(2_000_000);
    expect(t.maxOpensPerName).toBe(2);
  });

  it('never silently disables a floor on a malformed / non-positive env', () => {
    for (const bad of ['', 'abc', '0', '-5']) {
      const t = resolveDirectionalQualityThresholds({
        OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE: bad,
        OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME: bad,
        OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME: bad,
      });
      expect(t.minUnderlyingPrice).toBe(OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_DEFAULT);
      expect(t.minAvgDollarVolume).toBe(OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_DEFAULT);
      expect(t.maxOpensPerName).toBe(OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_DEFAULT);
    }
  });
});

describe('averageDollarVolume (TRA-1476)', () => {
  it('averages close×volume over real bars', () => {
    // (100*10 + 100*30) / 2 = 2000
    expect(averageDollarVolume([bar(100, 10), bar(100, 30)])).toBe(2000);
  });

  it('excludes synthetic gap-fill bars (a data gap must not dilute the estimate)', () => {
    // only the one real bar counts: 100*40 = 4000
    expect(averageDollarVolume([bar(100, 40), bar(100, 0, true)])).toBe(4000);
  });

  it('returns 0 for an empty / all-synthetic series (unknown liquidity ⇒ rejected by the floor)', () => {
    expect(averageDollarVolume([])).toBe(0);
    expect(averageDollarVolume([bar(100, 0, true), bar(100, 0, true)])).toBe(0);
  });
});

describe('directionalQualityVerdict (TRA-1476)', () => {
  const thresholds = { minUnderlyingPrice: 5, minAvgDollarVolume: 250_000, maxOpensPerName: 3 };

  it('admits a liquid name under the per-name cap', () => {
    const v = directionalQualityVerdict(
      { spot: 90, avgDollarVolume: 9_000_000, opensToday: 0 },
      thresholds,
    );
    expect(v.admitted).toBe(true);
    expect(v.code).toBe('ok');
  });

  it('rejects a sub-price micro-cap (the AMPG pathology)', () => {
    const v = directionalQualityVerdict(
      { spot: 2.1, avgDollarVolume: 9_000_000, opensToday: 0 },
      thresholds,
    );
    expect(v.admitted).toBe(false);
    expect(v.code).toBe('min_price');
  });

  it('rejects a thin name below the $-volume floor even above the price floor', () => {
    const v = directionalQualityVerdict(
      { spot: 12, avgDollarVolume: 10_000, opensToday: 0 },
      thresholds,
    );
    expect(v.admitted).toBe(false);
    expect(v.code).toBe('min_dollar_volume');
  });

  it('rejects a further open once the per-name cap is hit (defense-in-depth vs stacking)', () => {
    const v = directionalQualityVerdict(
      { spot: 90, avgDollarVolume: 9_000_000, opensToday: 3 },
      thresholds,
    );
    expect(v.admitted).toBe(false);
    expect(v.code).toBe('per_name_cap');
  });

  it('checks price before volume before the cap (most-fundamental first)', () => {
    // fails all three — price is reported first
    const v = directionalQualityVerdict(
      { spot: 1, avgDollarVolume: 1, opensToday: 99 },
      thresholds,
    );
    expect(v.code).toBe('min_price');
  });
});
