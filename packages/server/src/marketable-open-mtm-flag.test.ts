import { describe, it, expect } from 'vitest';
import {
  isMarketableOpenMtmEnabled,
  resolveMarketableOpenMtmConfig,
} from './marketable-open-mtm-flag.js';
import {
  DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
  MAX_MARKETABLE_HALF_SPREAD_FRAC,
} from './marketable-open-mtm.js';

describe('isMarketableOpenMtmEnabled', () => {
  it('is off by default (absent / falsey)', () => {
    expect(isMarketableOpenMtmEnabled({})).toBe(false);
    expect(isMarketableOpenMtmEnabled({ ENABLE_MARKETABLE_OPEN_MTM: '0' })).toBe(false);
    expect(isMarketableOpenMtmEnabled({ ENABLE_MARKETABLE_OPEN_MTM: 'false' })).toBe(false);
  });
  it('accepts 1/true/yes/on (case/space tolerant)', () => {
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isMarketableOpenMtmEnabled({ ENABLE_MARKETABLE_OPEN_MTM: v })).toBe(true);
    }
  });
});

describe('resolveMarketableOpenMtmConfig', () => {
  it('defaults to disabled + the measured mean fraction', () => {
    expect(resolveMarketableOpenMtmConfig({})).toEqual({
      enabled: false,
      halfSpreadFrac: DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
    });
  });
  it('reads the enable flag and a valid fraction override', () => {
    expect(
      resolveMarketableOpenMtmConfig({
        ENABLE_MARKETABLE_OPEN_MTM: 'true',
        MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC: '0.2',
      }),
    ).toEqual({ enabled: true, halfSpreadFrac: 0.2 });
  });
  it('clamps an out-of-range override', () => {
    expect(
      resolveMarketableOpenMtmConfig({ MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC: '0.9' }).halfSpreadFrac,
    ).toBe(MAX_MARKETABLE_HALF_SPREAD_FRAC);
  });
  it('falls back to the default on an unparseable fraction (never zeroes the haircut)', () => {
    expect(
      resolveMarketableOpenMtmConfig({ MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC: 'abc' }).halfSpreadFrac,
    ).toBe(DEFAULT_MARKETABLE_HALF_SPREAD_FRAC);
  });
});
