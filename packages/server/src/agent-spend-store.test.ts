// TRA-747 (TRA-529 P2 §6.5) — the per-user/day spend cap + aggregate readout.
// Proves acceptance #1 (hard-stop at $2.00/user/day) at the ledger level and
// acceptance #4 (daily aggregate across all users).
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_DAILY_USER_CAP_USD,
  agentSpendAggregate,
  agentUserSpendStatus,
  dailyUserCapUsd,
  isOverUserDailyCap,
  recordAgentSpend,
  resetAgentSpendForTests,
} from './agent-spend-store.js';

// Two arbitrary days (epoch ms) that fall in different UTC calendar dates.
const DAY1 = Date.parse('2026-06-09T15:00:00Z');
const DAY2 = Date.parse('2026-06-10T15:00:00Z');

beforeEach(() => resetAgentSpendForTests());

describe('per-user/day cap (acceptance #1)', () => {
  it('defaults to a $2.00 cap', () => {
    expect(DEFAULT_DAILY_USER_CAP_USD).toBe(2);
    expect(dailyUserCapUsd()).toBe(2);
  });

  it('is not over the cap below $2 and is over at/above it', () => {
    recordAgentSpend('alice', 1.5, DAY1);
    expect(isOverUserDailyCap('alice', DAY1)).toBe(false);
    expect(agentUserSpendStatus('alice', DAY1).remainingUsd).toBeCloseTo(0.5, 4);

    recordAgentSpend('alice', 0.6, DAY1); // → $2.10, over the cap
    expect(isOverUserDailyCap('alice', DAY1)).toBe(true);
    expect(agentUserSpendStatus('alice', DAY1).overCap).toBe(true);
    expect(agentUserSpendStatus('alice', DAY1).remainingUsd).toBe(0);
  });

  it('isolates users — one user over the cap does not flip another', () => {
    recordAgentSpend('alice', 2.5, DAY1);
    expect(isOverUserDailyCap('alice', DAY1)).toBe(true);
    expect(isOverUserDailyCap('bob', DAY1)).toBe(false);
  });

  it('resets when the calendar day rolls', () => {
    recordAgentSpend('alice', 2.5, DAY1);
    expect(isOverUserDailyCap('alice', DAY1)).toBe(true);
    expect(isOverUserDailyCap('alice', DAY2)).toBe(false);
    expect(agentUserSpendStatus('alice', DAY2).spentUsd).toBe(0);
  });

  it('ignores non-positive / non-finite costs', () => {
    recordAgentSpend('alice', 0, DAY1);
    recordAgentSpend('alice', -1, DAY1);
    recordAgentSpend('alice', Number.NaN, DAY1);
    expect(agentUserSpendStatus('alice', DAY1).spentUsd).toBe(0);
  });
});

describe('daily aggregate readout (acceptance #4)', () => {
  it('sums spend across all users with a per-user breakdown', () => {
    recordAgentSpend('alice', 1.2, DAY1);
    recordAgentSpend('bob', 0.8, DAY1);
    recordAgentSpend('alice', 0.3, DAY1);
    const agg = agentSpendAggregate(DAY1);
    expect(agg.day).toBe('2026-06-09');
    expect(agg.totalUsd).toBeCloseTo(2.3, 2);
    expect(agg.userCount).toBe(2);
    // Sorted high→low: alice ($1.5) then bob ($0.8).
    expect(agg.perUser[0]!.user).toBe('alice');
    expect(agg.perUser[0]!.spentUsd).toBeCloseTo(1.5, 4);
    expect(agg.perUser[1]!.user).toBe('bob');
    expect(agg.userCapUsd).toBe(2);
  });

  it('starts empty and is day-scoped', () => {
    recordAgentSpend('alice', 1, DAY1);
    expect(agentSpendAggregate(DAY2).totalUsd).toBe(0);
    expect(agentSpendAggregate(DAY2).userCount).toBe(0);
  });
});
