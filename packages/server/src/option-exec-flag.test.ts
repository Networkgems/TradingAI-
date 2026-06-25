import { describe, it, expect } from 'vitest';
import {
  isOptionExecEnabled,
  isOptionEmaPullbackEnabled,
  isOptionVolumeBreakoutEnabled,
  isOptionDemoDirectionalEnabled,
  resolveRvLongDteOverride,
  resolveRvMinDailyVolume,
  OPTION_EXEC_FLAG,
  OPTION_EMA_PULLBACK_FLAG,
  OPTION_VOLUME_BREAKOUT_FLAG,
  OPTION_DEMO_DIRECTIONAL_FLAG,
  OPTION_RV_LONG_DTE_MIN_VAR,
  OPTION_RV_LONG_DTE_MAX_VAR,
  OPTION_RV_MIN_DAILY_VOLUME_VAR,
} from './option-exec-flag.js';

const ON = '1';

describe('isOptionExecEnabled', () => {
  it('is off when unset and on for truthy values', () => {
    expect(isOptionExecEnabled({})).toBe(false);
    expect(isOptionExecEnabled({ [OPTION_EXEC_FLAG]: 'true' })).toBe(true);
    expect(isOptionExecEnabled({ [OPTION_EXEC_FLAG]: 'off' })).toBe(false);
  });
});

describe('isOptionDemoDirectionalEnabled (TRA-1114)', () => {
  it('is off when unset and on for truthy values', () => {
    expect(isOptionDemoDirectionalEnabled({})).toBe(false);
    expect(isOptionDemoDirectionalEnabled({ [OPTION_DEMO_DIRECTIONAL_FLAG]: 'true' })).toBe(true);
    expect(isOptionDemoDirectionalEnabled({ [OPTION_DEMO_DIRECTIONAL_FLAG]: 'on' })).toBe(true);
    expect(isOptionDemoDirectionalEnabled({ [OPTION_DEMO_DIRECTIONAL_FLAG]: 'off' })).toBe(false);
  });

  it('is independent of the exec-selector flag (own switch)', () => {
    expect(isOptionDemoDirectionalEnabled({ [OPTION_EXEC_FLAG]: ON })).toBe(false);
    expect(isOptionExecEnabled({ [OPTION_DEMO_DIRECTIONAL_FLAG]: ON })).toBe(false);
  });
});

describe('TRA-1028 sub-flags require the exec flag too', () => {
  it('EMA-pullback sub-flag is inert without the exec flag', () => {
    expect(isOptionEmaPullbackEnabled({ [OPTION_EMA_PULLBACK_FLAG]: ON })).toBe(false);
    expect(
      isOptionEmaPullbackEnabled({ [OPTION_EXEC_FLAG]: ON, [OPTION_EMA_PULLBACK_FLAG]: ON }),
    ).toBe(true);
    // exec on but sub-flag off -> off
    expect(isOptionEmaPullbackEnabled({ [OPTION_EXEC_FLAG]: ON })).toBe(false);
  });

  it('volume-breakout sub-flag is inert without the exec flag', () => {
    expect(isOptionVolumeBreakoutEnabled({ [OPTION_VOLUME_BREAKOUT_FLAG]: ON })).toBe(false);
    expect(
      isOptionVolumeBreakoutEnabled({ [OPTION_EXEC_FLAG]: ON, [OPTION_VOLUME_BREAKOUT_FLAG]: ON }),
    ).toBe(true);
  });
});

describe('resolveRvLongDteOverride (item 3)', () => {
  it('returns undefined bounds when unset (engine 30/45 default stands)', () => {
    expect(resolveRvLongDteOverride({})).toEqual({ min: undefined, max: undefined });
  });

  it('parses positive integer overrides', () => {
    expect(
      resolveRvLongDteOverride({
        [OPTION_RV_LONG_DTE_MIN_VAR]: '45',
        [OPTION_RV_LONG_DTE_MAX_VAR]: '90',
      }),
    ).toEqual({ min: 45, max: 90 });
  });

  it('ignores non-positive / non-finite values', () => {
    expect(
      resolveRvLongDteOverride({ [OPTION_RV_LONG_DTE_MIN_VAR]: '0', [OPTION_RV_LONG_DTE_MAX_VAR]: 'abc' }),
    ).toEqual({ min: undefined, max: undefined });
  });

  it('rejects an inverted pair as a unit (both fall back)', () => {
    expect(
      resolveRvLongDteOverride({
        [OPTION_RV_LONG_DTE_MIN_VAR]: '90',
        [OPTION_RV_LONG_DTE_MAX_VAR]: '45',
      }),
    ).toEqual({ min: undefined, max: undefined });
  });

  it('allows a one-sided override (min only)', () => {
    expect(resolveRvLongDteOverride({ [OPTION_RV_LONG_DTE_MIN_VAR]: '45' })).toEqual({
      min: 45,
      max: undefined,
    });
  });
});

describe('resolveRvMinDailyVolume (TRA-1057)', () => {
  it('defaults to 0 (off) when unset so the scanner volume gate is a no-op', () => {
    expect(resolveRvMinDailyVolume({})).toBe(0);
  });

  it('parses a positive floor (recommended 25 per the recorded-chain sweep)', () => {
    expect(resolveRvMinDailyVolume({ [OPTION_RV_MIN_DAILY_VOLUME_VAR]: '25' })).toBe(25);
  });

  it('falls back to 0 for non-positive / non-finite values', () => {
    expect(resolveRvMinDailyVolume({ [OPTION_RV_MIN_DAILY_VOLUME_VAR]: '0' })).toBe(0);
    expect(resolveRvMinDailyVolume({ [OPTION_RV_MIN_DAILY_VOLUME_VAR]: '-5' })).toBe(0);
    expect(resolveRvMinDailyVolume({ [OPTION_RV_MIN_DAILY_VOLUME_VAR]: 'abc' })).toBe(0);
  });
});
