// TRA-747 (TRA-529 P2 §6.5) — the per-user/day spend cap + aggregate readout, plus
// the TRA-915 company-wide ceiling. Proves acceptance #1 (per-user hard-stop, raised
// to $10/user/day by TRA-915), the company-wide ceiling hard-stop, and acceptance #4
// (daily aggregate across all users), all at the ledger level.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  DEFAULT_COMPANY_DAILY_CAP_USD,
  DEFAULT_DAILY_USER_CAP_USD,
  agentSpendAggregate,
  agentUserSpendStatus,
  companyDailyCapUsd,
  dailyUserCapUsd,
  isOverCompanyDailyCap,
  isOverUserDailyCap,
  recordAgentSpend,
  resetAgentSpendForTests,
} from './agent-spend-store.js';

// Two arbitrary days (epoch ms) that fall in different UTC calendar dates.
const DAY1 = Date.parse('2026-06-09T15:00:00Z');
const DAY2 = Date.parse('2026-06-10T15:00:00Z');

beforeEach(() => resetAgentSpendForTests());

describe('per-user/day cap (acceptance #1, TRA-915 $10)', () => {
  it('defaults to a $10.00 cap', () => {
    expect(DEFAULT_DAILY_USER_CAP_USD).toBe(10);
    expect(dailyUserCapUsd()).toBe(10);
  });

  it('is not over the cap below $10 and is over at/above it', () => {
    recordAgentSpend('alice', 8, DAY1);
    expect(isOverUserDailyCap('alice', DAY1)).toBe(false);
    expect(agentUserSpendStatus('alice', DAY1).remainingUsd).toBeCloseTo(2, 4);

    recordAgentSpend('alice', 2.5, DAY1); // → $10.50, over the cap
    expect(isOverUserDailyCap('alice', DAY1)).toBe(true);
    expect(agentUserSpendStatus('alice', DAY1).overCap).toBe(true);
    expect(agentUserSpendStatus('alice', DAY1).remainingUsd).toBe(0);
  });

  it('isolates users — one user over the cap does not flip another', () => {
    recordAgentSpend('alice', 10.5, DAY1);
    expect(isOverUserDailyCap('alice', DAY1)).toBe(true);
    expect(isOverUserDailyCap('bob', DAY1)).toBe(false);
  });

  it('resets when the calendar day rolls', () => {
    recordAgentSpend('alice', 10.5, DAY1);
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

describe('company-wide daily ceiling (TRA-915)', () => {
  it('defaults to a $100.00 ceiling', () => {
    expect(DEFAULT_COMPANY_DAILY_CAP_USD).toBe(100);
    expect(companyDailyCapUsd()).toBe(100);
  });

  it('hard-stops on aggregate spend even when each user is under their own cap', () => {
    // 12 users at $9 each = $108 aggregate; no single user is over the $10 cap…
    for (let i = 0; i < 12; i++) recordAgentSpend(`user${i}`, 9, DAY1);
    expect(isOverUserDailyCap('user0', DAY1)).toBe(false); // $9 < $10 per-user cap
    // …but the company-wide ceiling ($100) is breached, so the layer must stop.
    expect(isOverCompanyDailyCap(DAY1)).toBe(true);
    const agg = agentSpendAggregate(DAY1);
    expect(agg.totalUsd).toBeCloseTo(108, 2);
    expect(agg.companyCapUsd).toBe(100);
    expect(agg.overCompanyCap).toBe(true);
  });

  it('is not breached below the ceiling and resets when the day rolls', () => {
    recordAgentSpend('alice', 40, DAY1);
    recordAgentSpend('bob', 40, DAY1); // $80 aggregate < $100
    expect(isOverCompanyDailyCap(DAY1)).toBe(false);
    expect(agentSpendAggregate(DAY1).overCompanyCap).toBe(false);
    // New calendar day → aggregate resets, ceiling not breached.
    expect(isOverCompanyDailyCap(DAY2)).toBe(false);
    expect(agentSpendAggregate(DAY2).totalUsd).toBe(0);
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
    expect(agg.userCapUsd).toBe(10);
  });

  it('starts empty and is day-scoped', () => {
    recordAgentSpend('alice', 1, DAY1);
    expect(agentSpendAggregate(DAY2).totalUsd).toBe(0);
    expect(agentSpendAggregate(DAY2).userCount).toBe(0);
  });
});
