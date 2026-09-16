// TRA-4502 (parent TRA-4284) — controls for the hidden-book wire fold.
//
// The measured defect is the FIRST test: a live-armed operator viewing the demo
// book, with three breached real-money rows in the book that is not on screen.
// Every other test exists to stop the fix over-matching — a banner that fires on
// a quiet book is a banner nobody reads on the day it means something.
import { describe, it, expect } from 'vitest';
import { hiddenBookNeedsBanner } from '@trading-app/shared';
import {
  foldHiddenBookExposure,
  foldHiddenBookStopExposure,
  type HiddenBookStopRead,
} from './hidden-book-exposure.js';

/** A census with nothing wrong — every field at its healthy reading. */
const CLEAN: HiddenBookStopRead = {
  breached: 0,
  actionable: 0,
  inFlight: 0,
  inert: 0,
  unacted: 0,
  indefinite: 0,
  byReason: {},
  releasesAt: null,
  exitPass: { reaches: true, blockedBy: null },
};

describe('foldHiddenBookExposure — the measured defect (bqb1 admin, 2026-09-01)', () => {
  it('publishes the hidden LIVE book\'s breached+inert rows while the DEMO book is on screen', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'live',
      shownBook: 'demo',
      premium: { usd: 358.004, rows: 3, unpricedRows: 0 },
      stops: {
        ...CLEAN,
        breached: 3,
        inert: 3,
        unacted: 3,
        indefinite: 3,
        byReason: { close_reject_breaker: 3 },
      },
    });

    expect(exposure.book).toBe('live');
    expect(exposure.shownBook).toBe('demo');
    expect(exposure.openOptionRows).toBe(3);
    expect(exposure.openPremiumUsd).toBe(358);
    expect(exposure.stops?.breached).toBe(3);
    expect(exposure.stops?.inert).toBe(3);
    expect(exposure.stops?.inertReasons).toEqual([{ reason: 'close_reject_breaker', count: 3 }]);
    expect(exposure.stopsUnavailableReason).toBeNull();
    // Acceptance 2: this is a banner, not a chip.
    expect(hiddenBookNeedsBanner(exposure)).toBe(true);
  });

  it('counts unpriced rows into the open-row total but not into the dollars', () => {
    // A row whose premium is unusable contributes $0. Dropping it from the row
    // count too would make an understated exposure read as a smaller book.
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'live',
      shownBook: 'demo',
      premium: { usd: 108, rows: 1, unpricedRows: 2 },
      stops: CLEAN,
    });
    expect(exposure.openOptionRows).toBe(3);
    expect(exposure.openPremiumUsd).toBe(108);
    expect(exposure.unpricedRows).toBe(2);
  });
});

describe('foldHiddenBookExposure — the other direction (no over-matching)', () => {
  it('does NOT banner a hidden live book whose census reports nothing wrong', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'live',
      shownBook: 'demo',
      premium: { usd: 691, rows: 2, unpricedRows: 0 },
      stops: CLEAN,
    });
    // The dollars ARE hidden, and that is the chip's job. Escalating a quiet
    // book would make the banner permanent for this operator.
    expect(exposure.stops?.breached).toBe(0);
    expect(hiddenBookNeedsBanner(exposure)).toBe(false);
  });

  it('never banners when the hidden book is the DEMO one', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'demo',
      shownBook: 'live',
      premium: { usd: 4200, rows: 5, unpricedRows: 0 },
      absence: { kind: 'hidden_book_is_demo' },
    });
    expect(exposure.stops).toBeNull();
    expect(exposure.stopsUnavailableReason).toBe('hidden_book_is_demo');
    expect(hiddenBookNeedsBanner(exposure)).toBe(false);
  });
});

describe('foldHiddenBookExposure — an absent census is not a clean one', () => {
  it('names a demo hidden book rather than publishing a zeroed census', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'demo',
      shownBook: 'live',
      premium: { usd: 0, rows: 0, unpricedRows: 0 },
      absence: { kind: 'hidden_book_is_demo' },
    });
    // `stops: { breached: 0, ... }` here would read as "we looked at the money
    // book and it is fine". There is no money book to look at.
    expect(exposure.stops).toBeNull();
    expect(exposure.stopsUnavailableReason).toBe('hidden_book_is_demo');
  });

  it('BANNERS a live hidden book holding rows whose census threw', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'live',
      shownBook: 'demo',
      premium: { usd: 358, rows: 3, unpricedRows: 0 },
      absence: { kind: 'blind', reason: 'boom' },
    });
    expect(exposure.stops).toBeNull();
    expect(exposure.stopsUnavailableReason).toBe('census_failed: boom');
    // "We do not know whether real money is past its stop" is a banner.
    expect(hiddenBookNeedsBanner(exposure)).toBe(true);
  });

  it('does not banner a blind census over a FLAT hidden live book', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'live',
      shownBook: 'demo',
      premium: { usd: 0, rows: 0, unpricedRows: 0 },
      absence: { kind: 'blind', reason: 'boom' },
    });
    // Nothing to be blind about — the exposure fold is a separate instrument
    // and it answered.
    expect(hiddenBookNeedsBanner(exposure)).toBe(false);
  });

  it('marks an unexplained absence rather than passing it off as a reason', () => {
    const exposure = foldHiddenBookExposure({
      hiddenBook: 'live',
      shownBook: 'demo',
      premium: { usd: 0, rows: 0, unpricedRows: 0 },
    });
    expect(exposure.stopsUnavailableReason).toBe('unspecified');
  });
});

describe('foldHiddenBookStopExposure', () => {
  it('orders inert reasons count-descending then label-ascending, dropping zeros', () => {
    const stops = foldHiddenBookStopExposure({
      ...CLEAN,
      breached: 5,
      inert: 4,
      unacted: 4,
      byReason: {
        pdt_hold_today: 1,
        close_reject_breaker: 2,
        // A zero-valued key is a gate that refused nothing; publishing it would
        // invite an operator to go clear a gate that is not holding anything.
        swing_hold_today: 0,
        daily_close_hold: 1,
      },
    });
    expect(stops.inertReasons).toEqual([
      { reason: 'close_reject_breaker', count: 2 },
      { reason: 'daily_close_hold', count: 1 },
      { reason: 'pdt_hold_today', count: 1 },
    ]);
  });

  it('reports the cadence blocker when no exit pass reaches the book', () => {
    const stops = foldHiddenBookStopExposure({
      ...CLEAN,
      breached: 1,
      actionable: 1,
      unacted: 1,
      exitPass: { reaches: false, blockedBy: 'market_closed' },
    });
    expect(stops.exitPassBlockedBy).toBe('market_closed');
    // TRA-3839: `inert: 0` with `actionable: 1` is NOT an all-clear when no pass
    // runs. `unacted` is what the banner reads.
    expect(stops.inert).toBe(0);
  });

  it('refuses to publish "a pass reaches these rows" off a null blocker alone', () => {
    const stops = foldHiddenBookStopExposure({
      ...CLEAN,
      exitPass: { reaches: false, blockedBy: null },
    });
    expect(stops.exitPassBlockedBy).toBe('unknown');
  });

  it('publishes null for the blocker only when a pass actually reaches', () => {
    expect(foldHiddenBookStopExposure(CLEAN).exitPassBlockedBy).toBeNull();
  });
});
