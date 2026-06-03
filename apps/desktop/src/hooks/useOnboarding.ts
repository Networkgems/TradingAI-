// TRA-565 (TRA-410 C1) — first-run detection + completion persistence for the
// onboarding wizard.
//
// On mount it reads the user's AccountSettings once and decides whether the
// first-run wizard should show (`isOnboardingComplete` is false). Completion is
// persisted by PUTting `onboardingCompletedAt` + `onboardingVersion` so the
// wizard never reappears once finished or skipped — the PUT handler merges a
// partial body against the saved snapshot (TRA-485), so sending just the two
// onboarding fields leaves every other setting untouched.
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CURRENT_ONBOARDING_VERSION,
  isOnboardingComplete,
  type AccountSettings,
} from '@trading-app/shared';
import { HTTP_URL } from '../server-url';

export type OnboardingStatus = 'loading' | 'show' | 'hidden';

export interface UseOnboarding {
  status: OnboardingStatus;
  /**
   * Persist the completion flag and hide the wizard immediately (optimistic).
   * Safe to call from both "Finish" and "Skip" — the wizard is one-and-done.
   */
  complete: () => void;
}

export function useOnboarding(token: string | null): UseOnboarding {
  const [status, setStatus] = useState<OnboardingStatus>('loading');
  // Guard against a double-PUT if complete() fires twice (Esc + button race).
  const completedRef = useRef(false);

  useEffect(() => {
    if (!token) {
      setStatus('hidden');
      return;
    }
    let cancelled = false;
    setStatus('loading');
    fetch(`${HTTP_URL}/api/account/settings`, {
      headers: { Authorization: `Bearer ${token}` },
    })
      .then(r => (r.ok ? (r.json() as Promise<AccountSettings>) : null))
      .then(settings => {
        if (cancelled) return;
        // Fail safe: if settings can't be read, do NOT block the app behind a
        // wizard — treat it as already onboarded (hidden).
        setStatus(settings && !isOnboardingComplete(settings) ? 'show' : 'hidden');
      })
      .catch(() => {
        if (!cancelled) setStatus('hidden');
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const complete = useCallback(() => {
    if (completedRef.current) return;
    completedRef.current = true;
    // Hide optimistically — the user is done regardless of whether the PUT
    // round-trips. A failed persist only means they'd see it once more next
    // login, which is acceptable and far better than blocking the UI.
    setStatus('hidden');
    if (!token) return;
    fetch(`${HTTP_URL}/api/account/settings`, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        onboardingCompletedAt: new Date().toISOString(),
        onboardingVersion: CURRENT_ONBOARDING_VERSION,
      }),
    }).catch(() => {
      // Best-effort; the optimistic hide already happened.
    });
  }, [token]);

  return { status, complete };
}
