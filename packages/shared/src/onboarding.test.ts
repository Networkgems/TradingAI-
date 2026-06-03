// TRA-565 — first-run detection contract for the onboarding wizard.
import { describe, expect, it } from 'vitest';
import {
  CURRENT_ONBOARDING_VERSION,
  DEFAULT_ACCOUNT_SETTINGS,
  isOnboardingComplete,
} from './index.js';

describe('isOnboardingComplete (TRA-565)', () => {
  it('treats a brand-new user (defaults) as NOT complete → wizard shows', () => {
    expect(isOnboardingComplete(DEFAULT_ACCOUNT_SETTINGS)).toBe(false);
  });

  it('is false when completion timestamp is absent', () => {
    expect(isOnboardingComplete({ onboardingVersion: CURRENT_ONBOARDING_VERSION })).toBe(false);
  });

  it('is false for null / undefined settings', () => {
    expect(isOnboardingComplete(null)).toBe(false);
    expect(isOnboardingComplete(undefined)).toBe(false);
  });

  it('is true once completed at the current version', () => {
    expect(
      isOnboardingComplete({
        onboardingCompletedAt: '2026-06-03T00:00:00.000Z',
        onboardingVersion: CURRENT_ONBOARDING_VERSION,
      }),
    ).toBe(true);
  });

  it('treats a completion against an OLDER wizard version as not complete (re-trigger)', () => {
    expect(
      isOnboardingComplete({
        onboardingCompletedAt: '2026-06-03T00:00:00.000Z',
        onboardingVersion: CURRENT_ONBOARDING_VERSION - 1,
      }),
    ).toBe(false);
  });

  it('treats a completion with no version recorded as version 0 → not complete when current > 0', () => {
    // Guards the "saved before onboardingVersion existed" edge: version defaults
    // to 0, which is below CURRENT_ONBOARDING_VERSION (1).
    expect(isOnboardingComplete({ onboardingCompletedAt: '2026-06-03T00:00:00.000Z' })).toBe(false);
  });
});
