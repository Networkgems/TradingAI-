import { describe, it, expect } from 'vitest';
import {
  isChurnLossBrakeEnabled,
  resolveSameSessionOpenCap,
  CHURN_SAME_SESSION_OPEN_CAP_DEFAULT,
} from './churn-loss-brake-flag.js';

// TRA-1408 (parent TRA-1406) — the per-name churn + same-day-loss brake flag.

describe('isChurnLossBrakeEnabled (TRA-1408)', () => {
  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isChurnLossBrakeEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ', 'True']) {
      expect(isChurnLossBrakeEnabled({ ENABLE_CHURN_LOSS_BRAKE: v })).toBe(true);
    }
    expect(isChurnLossBrakeEnabled({ ENABLE_CHURN_LOSS_BRAKE: 'off' })).toBe(false);
    // Decoupled from the exit-risk master (demo-scoped by the caller instead).
    expect(isChurnLossBrakeEnabled({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isChurnLossBrakeEnabled({ EXIT_RISK_RULES_ENABLED: 'off', ENABLE_CHURN_LOSS_BRAKE: '1' }),
    ).toBe(true);
  });
});

describe('resolveSameSessionOpenCap (TRA-1408)', () => {
  it('defaults to 3 when unset', () => {
    expect(resolveSameSessionOpenCap({})).toBe(CHURN_SAME_SESSION_OPEN_CAP_DEFAULT);
    expect(CHURN_SAME_SESSION_OPEN_CAP_DEFAULT).toBe(3);
  });

  it('honours a valid integer override and floors a fractional one', () => {
    expect(resolveSameSessionOpenCap({ CHURN_SAME_SESSION_OPEN_CAP: '5' })).toBe(5);
    expect(resolveSameSessionOpenCap({ CHURN_SAME_SESSION_OPEN_CAP: '1' })).toBe(1);
    // Fractional caps are meaningless for a count → floor.
    expect(resolveSameSessionOpenCap({ CHURN_SAME_SESSION_OPEN_CAP: '3.9' })).toBe(3);
  });

  it('falls back to the default on malformed / sub-1 values (never silently disables)', () => {
    for (const bad of ['', 'abc', '0', '-2', '0.5']) {
      expect(resolveSameSessionOpenCap({ CHURN_SAME_SESSION_OPEN_CAP: bad })).toBe(
        CHURN_SAME_SESSION_OPEN_CAP_DEFAULT,
      );
    }
  });
});
