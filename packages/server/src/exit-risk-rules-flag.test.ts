import { describe, it, expect } from 'vitest';
import { isExitRiskRulesEnabled, isLiveEquityStopModifyEnabled, isTakeProfitEarlyEnabled, isCorrelatedExposureCapEnabled } from './exit-risk-rules-flag.js';

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
  it('requires BOTH the master switch AND the sub-flag', () => {
    // Sub-flag alone does nothing — the master must also be on.
    expect(isTakeProfitEarlyEnabled({ TAKE_PROFIT_EARLY_ENABLED: 'true' })).toBe(false);
    // Master alone does not auto-bank wins.
    expect(isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    // Both on → enabled.
    expect(
      isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'true', TAKE_PROFIT_EARLY_ENABLED: '1' }),
    ).toBe(true);
    // Master off wins even if the sub-flag is on.
    expect(
      isTakeProfitEarlyEnabled({ EXIT_RISK_RULES_ENABLED: 'off', TAKE_PROFIT_EARLY_ENABLED: 'yes' }),
    ).toBe(false);
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
