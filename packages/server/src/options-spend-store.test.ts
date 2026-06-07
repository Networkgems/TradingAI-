import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  monthlyCapUsd,
  monthKey,
  optionsSpendStatus,
  isOverMonthlyCap,
  recordOptionsSpend,
  resetOptionsSpendForTests,
  DEFAULT_MONTHLY_CAP_USD,
  CAP_ENV_VAR,
} from './options-spend-store.js';

const JUN = Date.parse('2026-06-15T12:00:00Z');
const JUL = Date.parse('2026-07-01T00:00:00Z');

describe('options-spend-store (TRA-658 CFO guardrail)', () => {
  beforeEach(() => {
    resetOptionsSpendForTests();
    delete process.env[CAP_ENV_VAR];
  });
  afterEach(() => {
    resetOptionsSpendForTests();
    delete process.env[CAP_ENV_VAR];
  });

  it('defaults to the board-approved $50 cap', () => {
    expect(monthlyCapUsd()).toBe(DEFAULT_MONTHLY_CAP_USD);
    expect(DEFAULT_MONTHLY_CAP_USD).toBe(50);
  });

  it('reads the cap from env, falling back on empty/invalid', () => {
    process.env[CAP_ENV_VAR] = '120';
    expect(monthlyCapUsd()).toBe(120);
    process.env[CAP_ENV_VAR] = '   ';
    expect(monthlyCapUsd()).toBe(50);
    process.env[CAP_ENV_VAR] = 'not-a-number';
    expect(monthlyCapUsd()).toBe(50);
    process.env[CAP_ENV_VAR] = '0';
    expect(monthlyCapUsd()).toBe(0);
  });

  it('buckets spend by UTC calendar month', () => {
    expect(monthKey(JUN)).toBe('2026-06');
    expect(monthKey(JUL)).toBe('2026-07');
  });

  it('accumulates spend and reports status', () => {
    recordOptionsSpend(10, JUN);
    recordOptionsSpend(5.5, JUN);
    const s = optionsSpendStatus(JUN);
    expect(s.month).toBe('2026-06');
    expect(s.spentUsd).toBe(15.5);
    expect(s.capUsd).toBe(50);
    expect(s.overCap).toBe(false);
    expect(s.ratio).toBeCloseTo(0.31, 2);
  });

  it('ignores non-positive / non-finite costs', () => {
    recordOptionsSpend(0, JUN);
    recordOptionsSpend(-3, JUN);
    recordOptionsSpend(Number.NaN, JUN);
    expect(optionsSpendStatus(JUN).spentUsd).toBe(0);
  });

  it('does not trip until the cap is reached, then trips hard', () => {
    recordOptionsSpend(49.99, JUN);
    expect(isOverMonthlyCap(JUN)).toBe(false);
    recordOptionsSpend(0.01, JUN);
    expect(isOverMonthlyCap(JUN)).toBe(true);
    expect(optionsSpendStatus(JUN).overCap).toBe(true);
  });

  it('resets automatically when the calendar month rolls', () => {
    recordOptionsSpend(50, JUN);
    expect(isOverMonthlyCap(JUN)).toBe(true);
    // New month → fresh budget.
    expect(isOverMonthlyCap(JUL)).toBe(false);
    expect(optionsSpendStatus(JUL).spentUsd).toBe(0);
  });

  it('honors an env-raised cap for the tripwire', () => {
    process.env[CAP_ENV_VAR] = '100';
    recordOptionsSpend(60, JUN);
    expect(isOverMonthlyCap(JUN)).toBe(false);
    recordOptionsSpend(45, JUN);
    expect(isOverMonthlyCap(JUN)).toBe(true);
  });

  it('treats a zero cap as always over (kill switch)', () => {
    process.env[CAP_ENV_VAR] = '0';
    expect(isOverMonthlyCap(JUN)).toBe(true);
    expect(optionsSpendStatus(JUN).overCap).toBe(true);
  });
});
