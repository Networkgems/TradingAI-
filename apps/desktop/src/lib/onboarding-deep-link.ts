// TRA-565 (TRA-410 C1) — shared keys for the onboarding "Connect a broker"
// deep-link. The wizard renders at the App shell (possibly before a dashboard
// is mounted), but Brokers live inside a dashboard's Settings modal, so the
// hand-off uses a localStorage breadcrumb + a window event:
//   - App writes ONBOARDING_DEEP_LINK_KEY='brokers' and either mounts the
//     stocks dashboard or fires OPEN_BROKER_SETTINGS_EVENT.
//   - Dashboard consumes the breadcrumb on mount and listens for the event,
//     opening Settings (with the first missing live-cred field focused) and
//     clearing the breadcrumb so it fires exactly once.

/** localStorage key holding a pending deep-link target ('brokers'). */
export const ONBOARDING_DEEP_LINK_KEY = 'onboardingDeepLink';

/** Window event fired when a dashboard is already mounted and should open Settings. */
export const OPEN_BROKER_SETTINGS_EVENT = 'tradingai:open-broker-settings';

/**
 * Read + clear the pending deep-link breadcrumb. Returns true when a 'brokers'
 * deep-link was pending (and clears it so it never re-fires).
 */
export function consumeBrokerDeepLink(): boolean {
  try {
    if (localStorage.getItem(ONBOARDING_DEEP_LINK_KEY) === 'brokers') {
      localStorage.removeItem(ONBOARDING_DEEP_LINK_KEY);
      return true;
    }
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts — treat as
    // "no deep-link pending".
  }
  return false;
}
