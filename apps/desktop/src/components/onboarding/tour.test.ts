// TRA-569 — tour start plumbing: replay event + first-run autostart breadcrumb.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  TOUR_STOPS,
  START_TOUR_EVENT,
  TOUR_AUTOSTART_KEY,
  startTour,
  requestTourAutostart,
  consumeTourAutostart,
} from './tour';

describe('tour stops', () => {
  it('defines the five design §3.3 stops in order', () => {
    expect(TOUR_STOPS.map(s => s.id)).toEqual([
      'account-mode',
      'positions',
      'signals',
      'auto-trading',
      'calendar',
    ]);
    for (const stop of TOUR_STOPS) {
      expect(stop.title).toBeTruthy();
      expect(stop.body).toBeTruthy();
    }
  });
});

describe('tour start plumbing', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('startTour() dispatches the start event without touching the breadcrumb', () => {
    const handler = vi.fn();
    window.addEventListener(START_TOUR_EVENT, handler);
    startTour();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(TOUR_AUTOSTART_KEY)).toBeNull();
    window.removeEventListener(START_TOUR_EVENT, handler);
  });

  it('requestTourAutostart() sets the breadcrumb and dispatches the event', () => {
    const handler = vi.fn();
    window.addEventListener(START_TOUR_EVENT, handler);
    requestTourAutostart();
    expect(handler).toHaveBeenCalledTimes(1);
    expect(localStorage.getItem(TOUR_AUTOSTART_KEY)).toBe('1');
    window.removeEventListener(START_TOUR_EVENT, handler);
  });

  it('consumeTourAutostart() returns true once then clears the breadcrumb', () => {
    requestTourAutostart();
    expect(consumeTourAutostart()).toBe(true);
    expect(consumeTourAutostart()).toBe(false);
    expect(localStorage.getItem(TOUR_AUTOSTART_KEY)).toBeNull();
  });
});
