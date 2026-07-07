import { describe, it, expect } from 'vitest';
import { isMultiLegOpenPaused, MULTILEG_OPEN_PAUSE_FLAG } from './multileg-open-pause-flag.js';
import { DEMO_FLAG_ALLOWLIST } from './demo-flags.js';

// TRA-1410 (parent TRA-1406) — the multi-leg (IC / verticals) demo-open PAUSE guard.

describe('isMultiLegOpenPaused (TRA-1410)', () => {
  it('is STANDALONE — off by default, accepts truthy spellings, not gated by the master', () => {
    expect(isMultiLegOpenPaused({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ', 'True']) {
      expect(isMultiLegOpenPaused({ ENABLE_OPTION_MULTILEG_PAUSE: v })).toBe(true);
    }
    expect(isMultiLegOpenPaused({ ENABLE_OPTION_MULTILEG_PAUSE: 'off' })).toBe(false);
    // Decoupled from the exit-risk master (demo-scoped by the caller instead).
    expect(isMultiLegOpenPaused({ EXIT_RISK_RULES_ENABLED: 'true' })).toBe(false);
    expect(
      isMultiLegOpenPaused({ EXIT_RISK_RULES_ENABLED: 'off', ENABLE_OPTION_MULTILEG_PAUSE: '1' }),
    ).toBe(true);
  });

  it('is on the demo-flags allowlist so the board can arm it daemon-free', () => {
    expect(DEMO_FLAG_ALLOWLIST).toContain(MULTILEG_OPEN_PAUSE_FLAG);
    expect(MULTILEG_OPEN_PAUSE_FLAG).toBe('ENABLE_OPTION_MULTILEG_PAUSE');
  });
});
