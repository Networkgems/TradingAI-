import { describe, it, expect } from 'vitest';
import { isExitRiskRulesEnabled, isLiveEquityStopModifyEnabled } from './exit-risk-rules-flag.js';

// TRA-1250 / TRA-1269 — master switch + the isolated live-equity sub-flag.

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
