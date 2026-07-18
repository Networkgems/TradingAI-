import { describe, it, expect } from 'vitest';
import {
  buildShadowExpectancyGuardConfig,
  isShadowExpectancyGuardEnabled,
  isShadowExpectancyGuardEnforcing,
  shadowExpectancyGuardFromLedger,
  shadowLedgerToExpectancySample,
} from './shadow-expectancy-guard-config.js';
import type { ShadowSignalRecord } from './shadow-signal-ledger.js';

// A resolved shadow row on a given ET-day timestamp with a given realized R.
function row(id: string, ts: number, realizedR: number): ShadowSignalRecord {
  return {
    id,
    ts,
    symbol: 'AAPL',
    side: 'buy',
    entryRef: 100,
    supertrendValue: null,
    supertrendFlip: false,
    maStack: null,
    macd: null,
    rsi: null,
    emitted: true,
    stopLoss: 99,
    takeProfit: 102,
    outcome: 'TIMEOUT',
    realizedR,
    barsToResolution: 5,
    resolvedAt: ts + 1000,
  };
}

// 2026-07-01 ~14:30 UTC and 2026-07-02 ~14:30 UTC — two distinct ET days.
const DAY1 = Date.UTC(2026, 6, 1, 14, 30);
const DAY2 = Date.UTC(2026, 6, 2, 14, 30);

describe('shadow-expectancy-guard flags', () => {
  it('both flags default OFF (guard not wired in, not enforcing)', () => {
    expect(isShadowExpectancyGuardEnabled({})).toBe(false);
    expect(isShadowExpectancyGuardEnforcing({})).toBe(false);
    expect(buildShadowExpectancyGuardConfig({}).enforce).toBe(false);
  });

  it('master ON alone is observe-only (enabled, not enforcing)', () => {
    const env = { ENABLE_SHADOW_EXPECTANCY_GUARD: '1' };
    expect(isShadowExpectancyGuardEnabled(env)).toBe(true);
    expect(isShadowExpectancyGuardEnforcing(env)).toBe(false);
    expect(buildShadowExpectancyGuardConfig(env).enforce).toBe(false);
  });

  it('enforce flag only bites when the master flag is also on', () => {
    // Enforce set but master off → still not enforcing (guard isn't wired in).
    expect(isShadowExpectancyGuardEnforcing({ ENABLE_SHADOW_EXPECTANCY_GUARD_ENFORCE: '1' })).toBe(false);
    // Both on → enforcing.
    const env = { ENABLE_SHADOW_EXPECTANCY_GUARD: 'on', ENABLE_SHADOW_EXPECTANCY_GUARD_ENFORCE: 'true' };
    expect(isShadowExpectancyGuardEnforcing(env)).toBe(true);
    expect(buildShadowExpectancyGuardConfig(env).enforce).toBe(true);
  });
});

describe('shadowLedgerToExpectancySample', () => {
  it('keeps only resolved rows with finite realizedR and clusters by ET day', () => {
    const rows: ShadowSignalRecord[] = [
      row('a', DAY1, -0.1),
      row('b', DAY1, -0.2),
      { ...row('c', DAY1, 0), outcome: 'OPEN', realizedR: undefined }, // OPEN → dropped
      row('d', DAY2, 0.3),
    ];
    const sample = shadowLedgerToExpectancySample(rows);
    expect(sample).toHaveLength(3);
    const keys = new Set(sample.map((s) => s.clusterKey));
    expect(keys.size).toBe(2); // two distinct ET days
  });
});

describe('shadowExpectancyGuardFromLedger', () => {
  it('flags the frozen negative-expectancy ledger as would-block, observe-only by default', () => {
    // 40 resolved signals across two ET days, mean net R negative.
    const rows: ShadowSignalRecord[] = Array.from({ length: 40 }, (_, i) =>
      row(`r${i}`, i % 2 === 0 ? DAY1 : DAY2, -0.05),
    );
    const verdict = shadowExpectancyGuardFromLedger(rows, {});
    expect(verdict.rawN).toBe(40);
    expect(verdict.expectancyR).toBeLessThan(0);
    expect(verdict.wouldBlock).toBe(true);
    expect(verdict.blocks).toBe(false); // observe-only default → no real block
  });
});
