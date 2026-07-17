import { describe, it, expect } from 'vitest';
import {
  isOptionExecEnabled,
  isOptionEmaPullbackEnabled,
  isOptionVolumeBreakoutEnabled,
  isOptionDemoDirectionalEnabled,
  resolveRvLongDteOverride,
  resolveRvMinDailyVolume,
  isOptionIvRvScannerEnabled,
  isOptionIvRvRoutingEnabled,
  isOptionShortPremiumScannerEnabled,
  isOptionWheelRoutingEnabled,
  OPTION_SHORT_PREMIUM_SCANNER_FLAG,
  OPTION_WHEEL_ROUTING_FLAG,
  resolveIvRvRoutingOverride,
  isOptionLiveRvLongEnabled,
  isOptionLiveOtmEnabled,
  isOptionLiveTestWindowOpen,
  isOptionLiveOtmArmed,
  isOptionLiveRvLongArmed,
  parseOptionLiveTestUntil,
  OPTION_LIVE_RV_LONG_FLAG,
  OPTION_LIVE_OTM_FLAG,
  OPTION_LIVE_TEST_UNTIL_VAR,
  OPTION_EXEC_FLAG,
  OPTION_EMA_PULLBACK_FLAG,
  OPTION_VOLUME_BREAKOUT_FLAG,
  OPTION_DEMO_DIRECTIONAL_FLAG,
  OPTION_RV_LONG_DTE_MIN_VAR,
  OPTION_RV_LONG_DTE_MAX_VAR,
  OPTION_RV_MIN_DAILY_VOLUME_VAR,
  OPTION_IV_RV_SCANNER_FLAG,
  OPTION_IV_RV_ROUTING_FLAG,
  OPTION_IV_RV_BUY_RATIO_VAR,
  OPTION_IV_RV_MISPRICING_PCT_VAR,
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

describe('isOptionLiveRvLongEnabled (TRA-1491 dark live-capital gate)', () => {
  it('is OFF by default (unset) so the shipped state places no live RV order', () => {
    expect(isOptionLiveRvLongEnabled({})).toBe(false);
  });

  it('is armed only for explicit truthy values', () => {
    expect(isOptionLiveRvLongEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: '1' })).toBe(true);
    expect(isOptionLiveRvLongEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: 'true' })).toBe(true);
    expect(isOptionLiveRvLongEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: 'on' })).toBe(true);
    expect(isOptionLiveRvLongEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: '0' })).toBe(false);
    expect(isOptionLiveRvLongEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: 'off' })).toBe(false);
    expect(isOptionLiveRvLongEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: 'false' })).toBe(false);
  });

  it('is a STANDALONE live toggle — the demo/exec flags neither arm nor block it', () => {
    // exec-selector on does not arm the live path
    expect(isOptionLiveRvLongEnabled({ [OPTION_EXEC_FLAG]: ON })).toBe(false);
    // and arming the live path does not turn on the exec-selector
    expect(isOptionExecEnabled({ [OPTION_LIVE_RV_LONG_FLAG]: ON })).toBe(false);
  });
});

describe('TRA-1929 — live OTM flag + self-expiring bounded-test window', () => {
  const FUTURE = String(4102444800000); // 2100-01-01
  const PAST = String(1);

  it('isOptionLiveOtmEnabled is OFF by default and armed only for truthy values', () => {
    expect(isOptionLiveOtmEnabled({})).toBe(false);
    expect(isOptionLiveOtmEnabled({ [OPTION_LIVE_OTM_FLAG]: '1' })).toBe(true);
    expect(isOptionLiveOtmEnabled({ [OPTION_LIVE_OTM_FLAG]: 'true' })).toBe(true);
    expect(isOptionLiveOtmEnabled({ [OPTION_LIVE_OTM_FLAG]: 'on' })).toBe(true);
    expect(isOptionLiveOtmEnabled({ [OPTION_LIVE_OTM_FLAG]: 'off' })).toBe(false);
  });

  it('parseOptionLiveTestUntil returns the epoch, or null for unset/malformed/non-positive', () => {
    expect(parseOptionLiveTestUntil({})).toBeNull();
    expect(parseOptionLiveTestUntil({ [OPTION_LIVE_TEST_UNTIL_VAR]: 'nope' })).toBeNull();
    expect(parseOptionLiveTestUntil({ [OPTION_LIVE_TEST_UNTIL_VAR]: '0' })).toBeNull();
    expect(parseOptionLiveTestUntil({ [OPTION_LIVE_TEST_UNTIL_VAR]: '-5' })).toBeNull();
    expect(parseOptionLiveTestUntil({ [OPTION_LIVE_TEST_UNTIL_VAR]: FUTURE })).toBe(Number(FUTURE));
  });

  it('isOptionLiveTestWindowOpen is FAIL-CLOSED: unset/malformed/expired ⇒ closed', () => {
    expect(isOptionLiveTestWindowOpen({}, 1000)).toBe(false); // unset
    expect(isOptionLiveTestWindowOpen({ [OPTION_LIVE_TEST_UNTIL_VAR]: 'nope' }, 1000)).toBe(false);
    expect(isOptionLiveTestWindowOpen({ [OPTION_LIVE_TEST_UNTIL_VAR]: PAST }, 1000)).toBe(false); // expired
    expect(isOptionLiveTestWindowOpen({ [OPTION_LIVE_TEST_UNTIL_VAR]: FUTURE }, 1000)).toBe(true); // open
  });

  it('OTM arm requires BOTH the flag AND an open window (2-day auto-disable)', () => {
    // flag on but window closed ⇒ NOT armed
    expect(isOptionLiveOtmArmed({ [OPTION_LIVE_OTM_FLAG]: '1' }, 1000)).toBe(false);
    // flag on but window expired ⇒ NOT armed
    expect(isOptionLiveOtmArmed({ [OPTION_LIVE_OTM_FLAG]: '1', [OPTION_LIVE_TEST_UNTIL_VAR]: PAST }, 1000)).toBe(false);
    // window open but flag off ⇒ NOT armed
    expect(isOptionLiveOtmArmed({ [OPTION_LIVE_TEST_UNTIL_VAR]: FUTURE }, 1000)).toBe(false);
    // both ⇒ armed
    expect(isOptionLiveOtmArmed({ [OPTION_LIVE_OTM_FLAG]: '1', [OPTION_LIVE_TEST_UNTIL_VAR]: FUTURE }, 1000)).toBe(true);
  });

  it('RV arm is ALSO window-gated so the window closing disarms real money on both sleeves', () => {
    // RV flag on but window closed ⇒ NOT armed (the missed-manual-disable safety)
    expect(isOptionLiveRvLongArmed({ [OPTION_LIVE_RV_LONG_FLAG]: '1' }, 1000)).toBe(false);
    expect(isOptionLiveRvLongArmed({ [OPTION_LIVE_RV_LONG_FLAG]: '1', [OPTION_LIVE_TEST_UNTIL_VAR]: PAST }, 1000)).toBe(false);
    expect(isOptionLiveRvLongArmed({ [OPTION_LIVE_RV_LONG_FLAG]: '1', [OPTION_LIVE_TEST_UNTIL_VAR]: FUTURE }, 1000)).toBe(true);
  });

  it('OTM live flag is a STANDALONE toggle — exec-selector neither arms nor blocks it', () => {
    expect(isOptionLiveOtmEnabled({ [OPTION_EXEC_FLAG]: ON })).toBe(false);
    expect(isOptionExecEnabled({ [OPTION_LIVE_OTM_FLAG]: ON })).toBe(false);
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

describe('isOptionIvRvRoutingEnabled (TRA-1203)', () => {
  it('requires the IV-RV scanner flag too — inert on its own', () => {
    // routing sub-flag alone does nothing without the scanner flag
    expect(isOptionIvRvRoutingEnabled({ [OPTION_IV_RV_ROUTING_FLAG]: ON })).toBe(false);
    // scanner on but routing off -> still observe-only
    expect(isOptionIvRvRoutingEnabled({ [OPTION_IV_RV_SCANNER_FLAG]: ON })).toBe(false);
    // both on -> routing live
    expect(
      isOptionIvRvRoutingEnabled({ [OPTION_IV_RV_SCANNER_FLAG]: ON, [OPTION_IV_RV_ROUTING_FLAG]: ON }),
    ).toBe(true);
  });

  it('does not flip the observe-only scanner flag', () => {
    expect(isOptionIvRvScannerEnabled({ [OPTION_IV_RV_ROUTING_FLAG]: ON })).toBe(false);
  });
});

describe('isOptionWheelRoutingEnabled (TRA-1977)', () => {
  it('requires the short-premium scanner flag too — inert on its own', () => {
    // wheel sub-flag alone does nothing without the scanner flag
    expect(isOptionWheelRoutingEnabled({ [OPTION_WHEEL_ROUTING_FLAG]: ON })).toBe(false);
    // scanner on but wheel off -> still observe-only
    expect(isOptionWheelRoutingEnabled({ [OPTION_SHORT_PREMIUM_SCANNER_FLAG]: ON })).toBe(false);
    // both on -> wheel paper routing live
    expect(
      isOptionWheelRoutingEnabled({ [OPTION_SHORT_PREMIUM_SCANNER_FLAG]: ON, [OPTION_WHEEL_ROUTING_FLAG]: ON }),
    ).toBe(true);
  });

  it('does not flip the observe-only short-premium scanner flag', () => {
    expect(isOptionShortPremiumScannerEnabled({ [OPTION_WHEEL_ROUTING_FLAG]: ON })).toBe(false);
  });
});

describe('resolveIvRvRoutingOverride (TRA-1203)', () => {
  it('defaults to undefined bounds so the engine 0.70/0.25 defaults stand', () => {
    expect(resolveIvRvRoutingOverride({})).toEqual({
      buyIvRvRatio: undefined,
      mispricingThresholdPct: undefined,
    });
  });

  it('parses positive float overrides', () => {
    expect(
      resolveIvRvRoutingOverride({
        [OPTION_IV_RV_BUY_RATIO_VAR]: '0.85',
        [OPTION_IV_RV_MISPRICING_PCT_VAR]: '0.15',
      }),
    ).toEqual({ buyIvRvRatio: 0.85, mispricingThresholdPct: 0.15 });
  });

  it('rejects a buy ratio >= 1 (would fire on rich premium) and non-positive/non-finite values', () => {
    expect(resolveIvRvRoutingOverride({ [OPTION_IV_RV_BUY_RATIO_VAR]: '1' }).buyIvRvRatio).toBeUndefined();
    expect(resolveIvRvRoutingOverride({ [OPTION_IV_RV_BUY_RATIO_VAR]: '1.4' }).buyIvRvRatio).toBeUndefined();
    expect(resolveIvRvRoutingOverride({ [OPTION_IV_RV_MISPRICING_PCT_VAR]: '0' }).mispricingThresholdPct).toBeUndefined();
    expect(resolveIvRvRoutingOverride({ [OPTION_IV_RV_MISPRICING_PCT_VAR]: 'abc' }).mispricingThresholdPct).toBeUndefined();
  });
});
