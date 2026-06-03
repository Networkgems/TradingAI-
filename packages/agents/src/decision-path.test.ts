import { describe, it, expect } from 'vitest';
import { DEFAULT_ACCOUNT_SETTINGS, type AccountSettings } from '@trading-app/shared';
import { selectDecisionPath, isAgentsPathActive, isDeterministicPathActive } from './decision-path.js';

const base: AccountSettings = { ...DEFAULT_ACCOUNT_SETTINGS };

describe('selectDecisionPath (TRA-544 §2B toggle seam)', () => {
  it('defaults to the deterministic path when the flag is absent', () => {
    const s: AccountSettings = { ...base };
    delete s.tradingAgentsEnabled;
    expect(selectDecisionPath(s)).toBe('deterministic');
    expect(isDeterministicPathActive(s)).toBe(true);
    expect(isAgentsPathActive(s)).toBe(false);
  });

  it('defaults to deterministic out of DEFAULT_ACCOUNT_SETTINGS', () => {
    expect(selectDecisionPath(base)).toBe('deterministic');
  });

  it('switches to the agents path when the flag is ON', () => {
    const s: AccountSettings = { ...base, tradingAgentsEnabled: true };
    expect(selectDecisionPath(s)).toBe('agents');
    expect(isAgentsPathActive(s)).toBe(true);
    // The two paths are mutually exclusive — never both deciding at once.
    expect(isDeterministicPathActive(s)).toBe(false);
  });

  it('treats a non-true value as off (only strict true enables)', () => {
    const s = { ...base, tradingAgentsEnabled: undefined } as AccountSettings;
    expect(selectDecisionPath(s)).toBe('deterministic');
  });
});
