import { describe, it, expect } from 'vitest';
import { isExitRiskRulesEnabled, isLiveEquityStopModifyEnabled, isTakeProfitEarlyEnabled, isCorrelatedExposureCapEnabled, isOtmDeltaFloorEnabled, resolveOtmDeltaFloor, OTM_DELTA_FLOOR_DEFAULT, isRvExitRetuneEnabled, resolveRvExitConfirmBars, RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT, isBookGiveBackArmFloorEnabled } from './exit-risk-rules-flag.js';

// TRA-1250 / TRA-1269 / TRA-1294 / TRA-1295 — master switch + the isolated sub-flags.

describe('isExitRiskRulesEnabled', () => {
  it('is off by default and accepts 1/true/yes/on (case/space-insensitive)', () => {
    expect(isExitRiskRulesEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ', 'True']) {
      expect(isExitRiskRulesEnabled({ EXIT_RISK_RULES_ENABLED: v })).toBe(true);
    }
    expect(isExitRiskRulesEnabled({ EXIT_RISK_RULES_ENABLED: 'off' })).toBe(false);
  });
});

describe('isLiveEquityStopModifyEnabled (TRA-1269)', () => {
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on.
    expect(isLiveEquityStopModifyEnabled({ LIVE_EQUITY_STOP_MODIFY_ENABLED: 'true' })).toBe(false);
    // Master alone does not enable the live stop-modify path.
    expect(isLiveEquityStopModifyEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled.
    expect(
      isLiveEquityStopModifyEnabled({ EXIT_RISK_RULES_ENABLED: 'true', LIVE_EQUITY_STOP_MODIFY_ENABLED: '1' }),
    ).toBe(true);
    // Master off wins even if the sub-flag is on.
    expect(
      isLiveEquityStopModifyEnabled({ EXIT_RISK_RULES_ENABLED: 'off', LIVE_EQUITY_STOP_MODIFY_ENABLED: 'yes' }),
    ).toBe(false);
  });
});

describe('isTakeProfitEarlyEnabled (TRA-1294)', () => {
  it('is STANDALONE — not gated under the exit-risk master (demo-only rollout)', () => {
    // Off by default; accepts the usual truthy spellings on its own.
    expect(isTakeProfitEarlyEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isTakeProfitEarlyEnabled({ TAKE_PROFIT_EARLY_ENABLED: v })).toBe(true);
    }
    // Deliberately decoupled from the master: the master alone does NOT enable it,
    // and it does NOT require the master (so arming it on demo never turns on the
    // loss-side rules on the live options path).
    expect(isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'off', TAKE_PROFIT_EARLY_ENABLED: '1' }),
    ).toBe(true);
  });
});

describe('isCorrelatedExposureCapEnabled (TRA-1295)', () => {
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on.
    expect(isCorrelatedExposureCapEnabled({ CORRELATED_EXPOSURE_CAP_ENABLED: 'true' })).toBe(false);
    // Master alone does not arm the correlated-exposure admission gate.
    expect(isCorrelatedExposureCapEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled.
    expect(
      isCorrelatedExposureCapEnabled({ EXIT_RISK_RULES_ENABLED: 'true', CORRELATED_EXPOSURE_CAP_ENABLED: '1' }),
    ).toBe(true);
    // Master off wins even if the sub-flag is on.
    expect(
      isCorrelatedExposureCapEnabled({ EXIT_RISK_RULES_ENABLED: 'off', CORRELATED_EXPOSURE_CAP_ENABLED: 'yes' }),
    ).toBe(false);
  });
});

describe('isOtmDeltaFloorEnabled / resolveOtmDeltaFloor (TRA-1407)', () => {
  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isOtmDeltaFloorEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isOtmDeltaFloorEnabled({ OTM_DELTA_FLOOR_ENABLED: v })).toBe(true);
    }
    // Decoupled from the exit-risk master (demo-scoped by the caller instead).
    expect(isOtmDeltaFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isOtmDeltaFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'off', OTM_DELTA_FLOOR_ENABLED: '1' }),
    ).toBe(true);
  });

  it('resolves the floor to the default when unset or malformed, and honours a valid override', () => {
    expect(resolveOtmDeltaFloor({})).toBe(OTM_DELTA_FLOOR_DEFAULT);
    expect(resolveOtmDeltaFloor({ OTM_DELTA_FLOOR: '0.35' })).toBe(0.35);
    // Out-of-range / malformed → fall back to the default (never silently disable).
    for (const bad of ['', 'abc', '0', '-0.2', '1', '1.5']) {
      expect(resolveOtmDeltaFloor({ OTM_DELTA_FLOOR: bad })).toBe(OTM_DELTA_FLOOR_DEFAULT);
    }
  });
});

describe('isRvExitRetuneEnabled / resolveRvExitConfirmBars (TRA-1409)', () => {
  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isRvExitRetuneEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(isRvExitRetuneEnabled({ RV_EXIT_RETUNE_ENABLED: v })).toBe(true);
    }
    // Decoupled from the exit-risk master (demo-scoped by the caller instead).
    expect(isRvExitRetuneEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isRvExitRetuneEnabled({ EXIT_RISK_RULES_ENABLED: 'off', RV_EXIT_RETUNE_ENABLED: '1' }),
    ).toBe(true);
  });

  it('resolves confirm-bars to the default (2) when unset or malformed, honours a valid override', () => {
    expect(resolveRvExitConfirmBars({})).toBe(RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT);
    expect(RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT).toBe(2);
    expect(resolveRvExitConfirmBars({ RV_EXIT_RETUNE_CONFIRM_BARS: '3' })).toBe(3);
    expect(resolveRvExitConfirmBars({ RV_EXIT_RETUNE_CONFIRM_BARS: '1' })).toBe(1);
    // Malformed / out-of-range / non-integer → fall back to the default.
    for (const bad of ['', 'abc', '0', '-1', '2.5', '11']) {
      expect(resolveRvExitConfirmBars({ RV_EXIT_RETUNE_CONFIRM_BARS: bad })).toBe(
        RV_EXIT_RETUNE_CONFIRM_BARS_DEFAULT,
      );
    }
  });
});

describe('isBookGiveBackArmFloorEnabled (TRA-1435)', () => {
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on (the give-back cap
    // itself only runs when EXIT_RISK_RULES_ENABLED is on).
    expect(isBookGiveBackArmFloorEnabled({ BOOK_GIVEBACK_ARM_FLOOR_ENABLED: 'true' })).toBe(false);
    // Master alone does not arm the give-back floor (legacy arm-at-any-peak stays).
    expect(isBookGiveBackArmFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled; accepts the usual truthy spellings.
    for (const v of ['1', 'true', 'YES', ' on ']) {
      expect(
        isBookGiveBackArmFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'true', BOOK_GIVEBACK_ARM_FLOOR_ENABLED: v }),
      ).toBe(true);
    }
    // Master off wins even if the sub-flag is on.
    expect(
      isBookGiveBackArmFloorEnabled({ EXIT_RISK_RULES_ENABLED: 'off', BOOK_GIVEBACK_ARM_FLOOR_ENABLED: '1' }),
    ).toBe(false);
  });
});
