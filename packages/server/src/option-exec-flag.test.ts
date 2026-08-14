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
  isOptionCostGateLiveEnforceEnabled,
  isOptionLiquidityLiveEnforceEnabled,
  OPTION_COST_GATE_LIVE_ENFORCE_FLAG,
  OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG,
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
  LIVE_OPTION_TEST_NOTIONAL_CAP_USD,
  LIVE_OPTION_TEST_NOTIONAL_CEILING_USD,
  LIVE_OPTION_TEST_NOTIONAL_CAP_VAR,
  LIVE_OPTION_TEST_MAX_CONTRACTS_VAR,
  LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT,
  LIVE_OPTION_TEST_CONTRACTS_HARD_MAX,
  resolveLiveOptionTestNotionalCapUsd,
  resolveLiveOptionTestMaxContracts,
  resolveLiveOptionTestContracts,
  LIVE_OPTION_TEST_AGGREGATE_CAP_USD, // TRA-3445
  LIVE_OPTION_TEST_AGGREGATE_CEILING_USD,
  LIVE_OPTION_TEST_AGGREGATE_CAP_VAR,
  resolveLiveOptionTestAggregateCapUsd,
  fitsLiveOptionTestAggregateCap,
  liveOptionTestAggregateHeadroomUsd,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION, // TRA-3674
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR,
  resolveLiveOptionTestFleetRiskFraction,
  resolveLiveOptionTestBookAggregateCapUsd,
  isOptionOtmDeltaFloorLiveEnforceEnabled,
  resolveOptionOtmDeltaFloorLive,
  OPTION_OTM_DELTA_FLOOR_LIVE_FLAG,
  OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR,
  OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT,
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

describe('live enforcement flags (TRA-2048)', () => {
  const ON = '1';

  it('both live-enforce flags default OFF (shadow-only, byte-for-byte unchanged live path)', () => {
    expect(isOptionCostGateLiveEnforceEnabled({})).toBe(false);
    expect(isOptionLiquidityLiveEnforceEnabled({})).toBe(false);
  });

  it('arm on the usual truthy spellings, independently', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
      expect(isOptionCostGateLiveEnforceEnabled({ [OPTION_COST_GATE_LIVE_ENFORCE_FLAG]: v })).toBe(true);
      expect(isOptionLiquidityLiveEnforceEnabled({ [OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG]: v })).toBe(true);
    }
    // One flag does not arm the other — they are separate ops toggles.
    expect(isOptionLiquidityLiveEnforceEnabled({ [OPTION_COST_GATE_LIVE_ENFORCE_FLAG]: ON })).toBe(false);
    expect(isOptionCostGateLiveEnforceEnabled({ [OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG]: ON })).toBe(false);
  });

  it('treats a non-truthy value as off (fail-safe: a fat-finger env never arms)', () => {
    expect(isOptionCostGateLiveEnforceEnabled({ [OPTION_COST_GATE_LIVE_ENFORCE_FLAG]: '0' })).toBe(false);
    expect(isOptionLiquidityLiveEnforceEnabled({ [OPTION_LIQUIDITY_LIVE_ENFORCE_FLAG]: 'maybe' })).toBe(false);
  });
});

describe('live OTM entry delta floor flag (TRA-2763)', () => {
  const ON = '1';

  it('defaults OFF — merging changes nothing until an operator arms it', () => {
    expect(isOptionOtmDeltaFloorLiveEnforceEnabled({})).toBe(false);
    // Setting only the VALUE does not arm the gate.
    expect(
      isOptionOtmDeltaFloorLiveEnforceEnabled({ [OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR]: '0.30' }),
    ).toBe(false);
  });

  it('arms on the usual truthy spellings, independently of the other live-enforce flags', () => {
    for (const v of ['1', 'true', 'yes', 'on', 'ON', ' True ']) {
      expect(isOptionOtmDeltaFloorLiveEnforceEnabled({ [OPTION_OTM_DELTA_FLOOR_LIVE_FLAG]: v })).toBe(true);
    }
    expect(isOptionOtmDeltaFloorLiveEnforceEnabled({ [OPTION_COST_GATE_LIVE_ENFORCE_FLAG]: ON })).toBe(false);
    expect(isOptionCostGateLiveEnforceEnabled({ [OPTION_OTM_DELTA_FLOOR_LIVE_FLAG]: ON })).toBe(false);
    // The demo flag pair never arms the live one (separate env channels by design).
    expect(isOptionOtmDeltaFloorLiveEnforceEnabled({ OTM_DELTA_FLOOR_ENABLED: ON })).toBe(false);
  });

  it('resolves the floor from OPTION_OTM_DELTA_FLOOR_LIVE, (0,1) exclusive', () => {
    expect(resolveOptionOtmDeltaFloorLive({ [OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR]: '0.25' })).toBe(0.25);
    expect(resolveOptionOtmDeltaFloorLive({ [OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR]: '0.07' })).toBe(0.07);
  });

  it('falls back to the containment default on a missing/malformed/out-of-range value (never silently disarms)', () => {
    expect(resolveOptionOtmDeltaFloorLive({})).toBe(OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT);
    for (const bad of ['0', '1', '-0.2', '1.4', 'abc', ' ', 'NaN']) {
      expect(resolveOptionOtmDeltaFloorLive({ [OPTION_OTM_DELTA_FLOOR_LIVE_VALUE_VAR]: bad })).toBe(
        OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT,
      );
    }
    // The live resolver never reads the DEMO value var — the number is chosen
    // from the live tape, not inherited (the ticket's explicit instruction).
    expect(resolveOptionOtmDeltaFloorLive({ OTM_DELTA_FLOOR: '0.11' })).toBe(
      OPTION_OTM_DELTA_FLOOR_LIVE_DEFAULT,
    );
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

// TRA-2536 — the board's second bounded live window sized "2-4 contracts/trade"
// against a $468.58 account. Both size parameters are ops-settable but clamped in
// code; the tests that matter are the FAILING states (malformed / oversized /
// doesn't-fit), because a fail-OPEN default here spends real money.
describe('resolveLiveOptionTestNotionalCapUsd (TRA-2536)', () => {
  it('falls back to the COMPILED July default when unset or malformed — never the ceiling', () => {
    expect(resolveLiveOptionTestNotionalCapUsd({})).toBe(LIVE_OPTION_TEST_NOTIONAL_CAP_USD);
    for (const bad of ['', '   ', 'abc', '0', '-100', 'NaN', 'Infinity']) {
      expect(resolveLiveOptionTestNotionalCapUsd({ [LIVE_OPTION_TEST_NOTIONAL_CAP_VAR]: bad }))
        .toBe(LIVE_OPTION_TEST_NOTIONAL_CAP_USD);
    }
  });

  it('honours a value inside the ceiling and CLAMPS DOWN above it', () => {
    expect(resolveLiveOptionTestNotionalCapUsd({ [LIVE_OPTION_TEST_NOTIONAL_CAP_VAR]: '468.58' }))
      .toBe(468.58);
    expect(resolveLiveOptionTestNotionalCapUsd({ [LIVE_OPTION_TEST_NOTIONAL_CAP_VAR]: '150' }))
      .toBe(150);
    // a fat-finger cannot authorize more than the funded balance
    expect(resolveLiveOptionTestNotionalCapUsd({ [LIVE_OPTION_TEST_NOTIONAL_CAP_VAR]: '46858' }))
      .toBe(LIVE_OPTION_TEST_NOTIONAL_CEILING_USD);
  });
});

// TRA-3445 — the board's THIRD clause, "max $750 total". Every other guard in
// this file bounds ONE entry; with $1,035.94 of options cash and a $150 per-entry
// cap, six entries fit before cash blocks the seventh — $900, i.e. $150 over the
// authorization. These pin the resolver's fail-safe shape and the boundary rule.
describe('resolveLiveOptionTestAggregateCapUsd (TRA-3445)', () => {
  it('returns the board figure when UNSET — never unlimited', () => {
    expect(resolveLiveOptionTestAggregateCapUsd({})).toBe(750);
    expect(resolveLiveOptionTestAggregateCapUsd({})).toBe(LIVE_OPTION_TEST_AGGREGATE_CAP_USD);
  });

  it('falls back to the compiled default on garbage / zero / negative', () => {
    for (const bad of ['', '   ', 'abc', '0', '-1', '-750', 'NaN', 'Infinity']) {
      expect(resolveLiveOptionTestAggregateCapUsd({ [LIVE_OPTION_TEST_AGGREGATE_CAP_VAR]: bad }))
        .toBe(LIVE_OPTION_TEST_AGGREGATE_CAP_USD);
    }
  });

  it('CLAMPS DOWN above the ceiling — an env value cannot authorize more than the board did', () => {
    expect(resolveLiveOptionTestAggregateCapUsd({ [LIVE_OPTION_TEST_AGGREGATE_CAP_VAR]: '5000' }))
      .toBe(LIVE_OPTION_TEST_AGGREGATE_CEILING_USD);
    expect(resolveLiveOptionTestAggregateCapUsd({ [LIVE_OPTION_TEST_AGGREGATE_CAP_VAR]: '751' }))
      .toBe(750);
  });

  it('honours a value BELOW the ceiling — the knob can only tighten', () => {
    expect(resolveLiveOptionTestAggregateCapUsd({ [LIVE_OPTION_TEST_AGGREGATE_CAP_VAR]: '300' }))
      .toBe(300);
  });
});

describe('fitsLiveOptionTestAggregateCap (TRA-3445)', () => {
  it('admits an entry that lands EXACTLY on the cap — a maximum is attainable', () => {
    expect(fitsLiveOptionTestAggregateCap(600, 150, 750)).toBe(true);
    expect(fitsLiveOptionTestAggregateCap(0, 750, 750)).toBe(true);
    expect(fitsLiveOptionTestAggregateCap(750, 0.01, 750)).toBe(false);
  });

  it('blocks the entry that fits PER-ENTRY but breaches the aggregate — the whole point', () => {
    // The measured worst case: five $150 entries already open, a sixth offered.
    expect(fitsLiveOptionTestAggregateCap(750, 150, 750)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(700, 82, 750)).toBe(false);
  });

  it('is cent-exact at the boundary rather than ULP-sensitive', () => {
    // 0.1+0.2 arithmetic on premium×100 products: the sum is 468.58000000000004
    // in binary, and a plain `<=` would reject a boundary case that is equal to
    // the penny. This is the case that makes the boundary flap, not the maths.
    expect(fitsLiveOptionTestAggregateCap(268.58, 200, 468.58)).toBe(true);
    expect(fitsLiveOptionTestAggregateCap(0.1 + 0.2, 749.7, 750)).toBe(true);
  });

  it('FAILS SAFE — an unusable at-risk / notional / cap BLOCKS, it does not assume headroom', () => {
    expect(fitsLiveOptionTestAggregateCap(Number.NaN, 82, 750)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(Number.POSITIVE_INFINITY, 82, 750)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(-1, 82, 750)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(0, Number.NaN, 750)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(0, 0, 750)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(0, 82, 0)).toBe(false);
    expect(fitsLiveOptionTestAggregateCap(0, 82, Number.NaN)).toBe(false);
  });
});

// TRA-3674 — φ, the scalar that makes the fleet-absolute authorization
// enforceable from inside a per-book check. Same fail-safe table as
// `resolveLiveOptionTestAggregateCapUsd` above, deliberately: this is the
// fourth sibling and the shape is the contract.
describe('resolveLiveOptionTestFleetRiskFraction (TRA-3674)', () => {
  it('returns the compiled default when UNSET — never 1.0, never 0', () => {
    expect(resolveLiveOptionTestFleetRiskFraction({})).toBe(0.4858);
    expect(resolveLiveOptionTestFleetRiskFraction({}))
      .toBe(LIVE_OPTION_TEST_FLEET_RISK_FRACTION);
  });

  it('falls back to the compiled default on garbage / zero / negative', () => {
    for (const bad of ['', '   ', 'abc', '0', '-1', '-0.5', 'NaN', 'Infinity', '-Infinity']) {
      expect(resolveLiveOptionTestFleetRiskFraction({
        [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: bad,
      })).toBe(LIVE_OPTION_TEST_FLEET_RISK_FRACTION);
    }
  });

  it('CLAMPS DOWN at 1.0 — no env value may authorize more than the whole account', () => {
    // `5` is the acceptance-table entry: 500% of a book's own cash is exactly
    // the state this ticket exists to make unreachable.
    expect(resolveLiveOptionTestFleetRiskFraction({
      [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '5',
    })).toBe(LIVE_OPTION_TEST_FLEET_RISK_FRACTION_CEILING);
    expect(resolveLiveOptionTestFleetRiskFraction({
      [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '1.0001',
    })).toBe(1.0);
  });

  it('honours a value at or below the ceiling', () => {
    expect(resolveLiveOptionTestFleetRiskFraction({
      [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '0.4858',
    })).toBe(0.4858);
    expect(resolveLiveOptionTestFleetRiskFraction({
      [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '0.25',
    })).toBe(0.25);
    expect(resolveLiveOptionTestFleetRiskFraction({
      [LIVE_OPTION_TEST_FLEET_RISK_FRACTION_VAR]: '1',
    })).toBe(1);
  });
});

describe('resolveLiveOptionTestBookAggregateCapUsd (TRA-3674)', () => {
  const PHI = LIVE_OPTION_TEST_FLEET_RISK_FRACTION;

  it('is pro-rata on the book\'s own cash, floored to whole cents', () => {
    // The two live books, verified 2026-08-14T01:0xZ off `liveArmCensus`.
    expect(resolveLiveOptionTestBookAggregateCapUsd(1143.96, 750, PHI)).toBe(555.73);
    expect(resolveLiveOptionTestBookAggregateCapUsd(400, 750, PHI)).toBe(194.32);
  });

  it('keeps min(…, A) — no single book may hold the whole authorization at any φ', () => {
    // A book far larger than the fleet: pro-rata would hand it $4,858.
    expect(resolveLiveOptionTestBookAggregateCapUsd(10_000, 750, PHI)).toBe(750);
    // …and at the ceiling φ, still clamped.
    expect(resolveLiveOptionTestBookAggregateCapUsd(10_000, 750, 1.0)).toBe(750);
    // The env-tightened fleet cap (the TRA-3664 interim, 375) binds too.
    expect(resolveLiveOptionTestBookAggregateCapUsd(10_000, 375, PHI)).toBe(375);
  });

  it('TIGHTENING ONLY — B_i never exceeds the flat bound it replaces', () => {
    // The property the ticket makes a defect if violated. Swept across the
    // balance range that spans both live books and well beyond.
    for (const cash of [0, 1, 100, 400, 750, 1143.96, 1543.96, 5000, 100_000]) {
      for (const phi of [0.0001, 0.25, PHI, 0.9, 1.0]) {
        expect(resolveLiveOptionTestBookAggregateCapUsd(cash, 750, phi))
          .toBeLessThanOrEqual(750);
      }
    }
  });

  it('FAILS CLOSED to 0 — no balance snapshot means the book takes NOTHING', () => {
    // This is the `no_balance_snapshot` verdict re-derived; `null` is what
    // `liveAvailableCashUsd()` returns when the broker reported nothing usable.
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.01]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(bad, 750, PHI)).toBe(0);
    }
    // …and 0 is a BLOCK downstream, not an unbounded pass.
    expect(fitsLiveOptionTestAggregateCap(0, 0.01, 0)).toBe(false);
  });

  it('FAILS CLOSED to 0 on an unusable fleet cap or φ', () => {
    for (const badCap of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(1143.96, badCap, PHI)).toBe(0);
    }
    for (const badPhi of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(1143.96, 750, badPhi)).toBe(0);
    }
  });

  it('EQUALIZES concentration — every book lands on the same fraction of itself', () => {
    // The property that fixes v0nni: under the flat cap admin was bounded at
    // 65.6% of its account and v0nni at 100%. Under pro-rata both land on φ.
    const admin = resolveLiveOptionTestBookAggregateCapUsd(1143.96, 750, PHI) / 1143.96;
    const v0nni = resolveLiveOptionTestBookAggregateCapUsd(400, 750, PHI) / 400;
    expect(admin).toBeCloseTo(PHI, 4);
    expect(v0nni).toBeCloseTo(PHI, 4);
    expect(Math.abs(admin - v0nni)).toBeLessThan(0.0001);
    // The flat cap, for contrast — this is the disparity being removed.
    expect(Math.min(750, 1143.96) / 1143.96).toBeCloseTo(0.6556, 3);
    expect(Math.min(750, 400) / 400).toBe(1.0);
  });

  it('self-adjusts in the SAFE direction — a shrinking book gets a SMALLER budget', () => {
    // The flat cap does the reverse: as a book shrinks, $750 becomes an ever
    // larger fraction of it, which is precisely how v0nni reached 100%.
    const shrinking = [1143.96, 800, 400, 200, 100].map((e) =>
      resolveLiveOptionTestBookAggregateCapUsd(e, 750, PHI),
    );
    for (let i = 1; i < shrinking.length; i += 1) {
      expect(shrinking[i]).toBeLessThan(shrinking[i - 1]);
    }
    // Concentration under the FLAT cap goes the wrong way over the same path.
    const flatConcentration = [1143.96, 800, 400, 200, 100].map((e) => Math.min(750, e) / e);
    for (let i = 1; i < flatConcentration.length; i += 1) {
      expect(flatConcentration[i]).toBeGreaterThanOrEqual(flatConcentration[i - 1]);
    }
  });

  it('Σ B_i is bounded by the authorization WITHOUT a fleet accumulator', () => {
    // `Σ φ·E_i = φ·Σ E_i ≡ A` — the arithmetic that is the point of the ticket.
    // Each engine used only its OWN balance to compute its own row.
    const fleet = [1143.96, 400];
    const sum = fleet.reduce(
      (acc, e) => acc + resolveLiveOptionTestBookAggregateCapUsd(e, 750, PHI), 0,
    );
    // 555.73 + 194.32. Five cents over $750 because φ = 0.4858 is 750/1543.96
    // rounded UP at the 4th place — an artifact of φ's precision, disclosed at
    // the constant, NOT of the bound. Pinned so it cannot drift unnoticed.
    expect(sum).toBeCloseTo(750.05, 2);
    // The flat cap's worst case over the SAME fleet, for contrast — and note it
    // is NOT `750 × 2 = 1500`. Run the admit loop: admin binds on the CAP
    // ($750), v0nni binds on its OWN CASH ($400) ⇒ $1,150, $400 over the
    // authorization. Multiplying a cap by a book count assumes the cap binds.
    const flatSum = fleet.reduce((acc, e) => acc + Math.min(750, e), 0);
    expect(flatSum).toBe(1150);
    expect(sum).toBeLessThan(flatSum);
  });
});

describe('liveOptionTestAggregateHeadroomUsd (TRA-3445)', () => {
  it('separates "cap armed, headroom $600" from "cap armed, headroom $0"', () => {
    expect(liveOptionTestAggregateHeadroomUsd(150, 750)).toBe(600);
    expect(liveOptionTestAggregateHeadroomUsd(750, 750)).toBe(0);
  });

  it('floors at 0 rather than reporting negative headroom, and returns null when unreadable', () => {
    expect(liveOptionTestAggregateHeadroomUsd(900, 750)).toBe(0);
    expect(liveOptionTestAggregateHeadroomUsd(Number.NaN, 750)).toBeNull();
    expect(liveOptionTestAggregateHeadroomUsd(100, 0)).toBeNull();
  });
});

describe('resolveLiveOptionTestMaxContracts (TRA-2536)', () => {
  it('defaults to the conservative compiled 1 when unset or malformed', () => {
    expect(resolveLiveOptionTestMaxContracts({})).toBe(LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT);
    for (const bad of ['', 'abc', '0', '-3', '2.5', 'Infinity']) {
      expect(resolveLiveOptionTestMaxContracts({ [LIVE_OPTION_TEST_MAX_CONTRACTS_VAR]: bad }))
        .toBe(LIVE_OPTION_TEST_MAX_CONTRACTS_DEFAULT);
    }
  });

  it('accepts the board range and clamps above the hard max of 4', () => {
    expect(resolveLiveOptionTestMaxContracts({ [LIVE_OPTION_TEST_MAX_CONTRACTS_VAR]: '2' })).toBe(2);
    expect(resolveLiveOptionTestMaxContracts({ [LIVE_OPTION_TEST_MAX_CONTRACTS_VAR]: '4' })).toBe(4);
    expect(resolveLiveOptionTestMaxContracts({ [LIVE_OPTION_TEST_MAX_CONTRACTS_VAR]: '40' }))
      .toBe(LIVE_OPTION_TEST_CONTRACTS_HARD_MAX);
  });
});

describe('resolveLiveOptionTestContracts (TRA-2536)', () => {
  it('opens the board ceiling when the ask notional fits', () => {
    // $0.40 ask ⇒ $40/contract; 4 fit inside $468.58
    expect(resolveLiveOptionTestContracts(0.4, 468.58, 4)).toBe(4);
  });

  it('steps DOWN to what the cap affords rather than breaching it', () => {
    // $1.00 ask ⇒ $100/contract; $268.58 affords 2, not 4
    expect(resolveLiveOptionTestContracts(1.0, 268.58, 4)).toBe(2);
    // $1.50 ⇒ $150/contract; $468.58 affords 3
    expect(resolveLiveOptionTestContracts(1.5, 468.58, 4)).toBe(3);
  });

  it('returns 0 — SKIP, never round up — when even one contract breaches the cap', () => {
    expect(resolveLiveOptionTestContracts(5.0, 468.58, 4)).toBe(0);
    expect(resolveLiveOptionTestContracts(2.7, 268.58, 4)).toBe(0);
  });

  it('never exceeds the requested max even with unlimited headroom', () => {
    expect(resolveLiveOptionTestContracts(0.05, 468.58, 1)).toBe(1);
    expect(resolveLiveOptionTestContracts(0.05, 468.58, 2)).toBe(2);
  });

  it('fails closed on a non-positive or non-finite ask / cap', () => {
    expect(resolveLiveOptionTestContracts(0, 468.58, 4)).toBe(0);
    expect(resolveLiveOptionTestContracts(-1, 468.58, 4)).toBe(0);
    expect(resolveLiveOptionTestContracts(Number.NaN, 468.58, 4)).toBe(0);
    expect(resolveLiveOptionTestContracts(0.4, 0, 4)).toBe(0);
    expect(resolveLiveOptionTestContracts(0.4, Number.NaN, 4)).toBe(0);
  });
});
