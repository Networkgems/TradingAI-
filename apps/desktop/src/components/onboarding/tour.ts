// TRA-569 (TRA-410 C2) — dashboard coach-mark tour definition + start plumbing.
//
// The tour is data-driven: each stop names a `data-tour="<id>"` attribute on an
// existing dashboard element (no new DOM is added just to anchor a spotlight).
// Stops follow design §3.3:
//   account-mode switch → Positions → Signals/watchlist → Auto-trading toggle →
//   Reports/calendar.
//
// Start paths (both land on the same `DashboardTour`, design §3.3 / §3.4):
//   - Replay  — "Replay product tour" in the profile menu fires `startTour()`,
//     which dispatches START_TOUR_EVENT to the already-mounted dashboard. It does
//     NOT touch the onboarding completion flag (design §3.4: replay without reset).
//   - Hand-off — the first-run wizard's step 3 calls `requestTourAutostart()`,
//     which both dispatches the event (if a dashboard is already mounted under
//     the wizard) AND drops a localStorage breadcrumb so a dashboard mounted
//     *after* the wizard closes still auto-starts the tour exactly once.

export interface TourStop {
  /** Matches the `data-tour="<id>"` attribute on the anchored element. */
  id: string;
  /** Tooltip heading. */
  title: string;
  /** Tooltip body copy. */
  body: string;
}

/** Ordered coach-mark stops (design §3.3). */
export const TOUR_STOPS: readonly TourStop[] = [
  {
    id: 'account-mode',
    title: 'Demo vs Live',
    body: 'Switch between paper (Demo) and real-money (Live) trading here. You start in Demo — nothing risks real funds.',
  },
  {
    id: 'positions',
    title: 'Positions',
    body: 'Open positions live here. Demo fills are simulated; Live fills come from your connected broker.',
  },
  {
    id: 'signals',
    title: 'Signals & watchlist',
    body: 'The engine’s latest entry signals and the symbols it tracks. Switch tabs to explore each.',
  },
  {
    id: 'auto-trading',
    title: 'Auto-trading',
    body: 'Start or stop the automated trader. While stopped, the engine places no new orders.',
  },
  {
    id: 'calendar',
    title: 'Reports & calendar',
    body: 'Your daily P&L, closed-trade history, and exportable reports live under the More ▾ menu → Calendar.',
  },
] as const;

/** Window event a mounted `DashboardTour` listens for to (re)start the tour. */
export const START_TOUR_EVENT = 'tradingai:start-tour';

/** localStorage breadcrumb so a not-yet-mounted dashboard auto-starts the tour. */
export const TOUR_AUTOSTART_KEY = 'onboardingStartTour';

/**
 * Replay entry point — start the tour on the currently mounted dashboard without
 * touching the onboarding completion flag (design §3.4). No-op if no dashboard
 * is listening.
 */
export function startTour(): void {
  try {
    window.dispatchEvent(new CustomEvent(START_TOUR_EVENT));
  } catch {
    // SSR / no-DOM contexts — nothing to start.
  }
}

/**
 * First-run hand-off — request the tour to start as soon as a dashboard is
 * available. Dispatches the live event (covers a dashboard already mounted
 * beneath the wizard) and sets a one-shot breadcrumb (covers the user picking a
 * dashboard *after* finishing the wizard from the home selector).
 */
export function requestTourAutostart(): void {
  try {
    localStorage.setItem(TOUR_AUTOSTART_KEY, '1');
  } catch {
    // localStorage can throw in private-mode / sandboxed contexts.
  }
  startTour();
}

/**
 * Read + clear the autostart breadcrumb. Returns true exactly once after a
 * `requestTourAutostart()`, so the tour never re-fires on later dashboard mounts.
 */
export function consumeTourAutostart(): boolean {
  try {
    if (localStorage.getItem(TOUR_AUTOSTART_KEY) === '1') {
      localStorage.removeItem(TOUR_AUTOSTART_KEY);
      return true;
    }
  } catch {
    // treat unreadable storage as "no autostart pending".
  }
  return false;
}
