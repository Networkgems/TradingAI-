// TRA-528 — live-health summarizer tests.

import { describe, it, expect } from 'vitest';
import {
  summarizeFeed,
  summarizeLiveHealth,
  type LiveHealthInput,
  type LiveStopExitHealth,
} from './live-health.js';

const NOW = 1_000_000_000;
const FRESH = NOW - 60_000; // 1 min old → fresh
const STALE = NOW - 10 * 60_000; // 10 min old → stale (>5min)

describe('summarizeFeed', () => {
  it('buckets symbols into fresh / stale / never-quoted', () => {
    const feed = summarizeFeed(
      [{ lastUpdated: FRESH }, { lastUpdated: STALE }, { lastUpdated: 0 }, {}],
      NOW,
    );
    expect(feed.trackedSymbols).toBe(4);
    expect(feed.freshSymbols).toBe(1);
    expect(feed.staleSymbols).toBe(1);
    expect(feed.neverQuoted).toBe(2);
    expect(feed.stale).toBe(false); // at least one fresh quote
  });

  it('flags the feed stale when no symbol is fresh', () => {
    const feed = summarizeFeed([{ lastUpdated: STALE }, { lastUpdated: 0 }], NOW);
    expect(feed.freshSymbols).toBe(0);
    expect(feed.stale).toBe(true);
  });

  it('flags the feed stale when the engine tick itself has stalled', () => {
    // Every symbol fresh, but lastTick is ancient → tick stalled.
    const feed = summarizeFeed([{ lastUpdated: FRESH }], NOW, undefined, NOW - 10 * 60_000);
    expect(feed.freshSymbols).toBe(1);
    expect(feed.stale).toBe(true);
    expect(feed.lastTickAgeSec).toBe(600);
  });

  it('is not stale with zero tracked symbols', () => {
    const feed = summarizeFeed([], NOW);
    expect(feed.trackedSymbols).toBe(0);
    expect(feed.stale).toBe(false);
    expect(feed.lastTickAgeSec).toBeNull();
  });
});

function input(overrides: Partial<LiveHealthInput> = {}): LiveHealthInput {
  return {
    mode: 'live',
    tradierEnv: 'production',
    missingCredentials: [],
    autoTradingEnabled: true,
    tradingHalted: false,
    haltReason: null,
    marketOpen: true,
    symbols: [{ lastUpdated: FRESH }],
    lastTick: FRESH,
    now: NOW,
    ...overrides,
  };
}

describe('summarizeLiveHealth', () => {
  it('is GREEN when live, authed, feed fresh, trading enabled', () => {
    const s = summarizeLiveHealth(input());
    expect(s.status).toBe('green');
    expect(s.issues).toEqual([]);
    expect(s.broker.authOk).toBe(true);
  });

  it('is RED when live mode is missing broker credentials', () => {
    const s = summarizeLiveHealth(input({ missingCredentials: ['liveApiKeyCrypto'] }));
    expect(s.status).toBe('red');
    expect(s.broker.authOk).toBe(false);
    expect(s.issues[0]).toMatch(/credentials missing/);
  });

  it('does NOT flag missing creds in demo mode', () => {
    const s = summarizeLiveHealth(
      input({ mode: 'demo', missingCredentials: ['liveApiKeyCrypto'] }),
    );
    // demo + missing-live-creds is not an incident
    expect(s.status).toBe('green');
  });

  it('is RED when market open but data feed is stale', () => {
    const s = summarizeLiveHealth(input({ symbols: [{ lastUpdated: STALE }], lastTick: STALE }));
    expect(s.status).toBe('red');
    expect(s.issues.some((i) => /feed is stale/.test(i))).toBe(true);
  });

  it('does NOT flag a stale feed when the market is closed', () => {
    const s = summarizeLiveHealth(
      input({ marketOpen: false, symbols: [{ lastUpdated: STALE }], lastTick: STALE }),
    );
    expect(s.status).toBe('green');
  });

  it('is YELLOW when trading is halted (risk breaker / kill switch)', () => {
    const s = summarizeLiveHealth(
      input({ tradingHalted: true, haltReason: 'kill switch engaged' }),
    );
    expect(s.status).toBe('yellow');
    expect(s.issues[0]).toMatch(/kill switch engaged/);
  });

  it('is YELLOW when live but auto-trading is disabled', () => {
    const s = summarizeLiveHealth(input({ autoTradingEnabled: false }));
    expect(s.status).toBe('yellow');
    expect(s.issues.some((i) => /auto-trading is disabled/.test(i))).toBe(true);
  });

  it('is YELLOW when some-but-not-all symbols are stale', () => {
    const s = summarizeLiveHealth(
      input({ symbols: [{ lastUpdated: FRESH }, { lastUpdated: STALE }] }),
    );
    expect(s.status).toBe('yellow');
    expect(s.feed.staleSymbols).toBe(1);
  });

  it('RED outranks YELLOW when multiple problems coexist', () => {
    const s = summarizeLiveHealth(
      input({ missingCredentials: ['liveApiKeyCrypto'], tradingHalted: true }),
    );
    expect(s.status).toBe('red');
    // both issues are reported
    expect(s.issues.length).toBeGreaterThanOrEqual(2);
  });
});

// TRA-4281 — the exit dimension. Before it, `LiveHealthInput` had no member
// for a position, an order, a stop, or a close outcome, so NO input value
// could make the panel non-green while 3 real-money rows sat breached and
// unexitable behind `close_reject_breaker`.
describe('summarizeLiveHealth — live stop actionability (TRA-4281)', () => {
  function measured(
    over: Partial<Extract<LiveStopExitHealth, { instrumentBlind: false }>> = {},
  ): LiveStopExitHealth {
    return {
      instrumentBlind: false,
      breached: 0,
      actionable: 0,
      inFlight: 0,
      inert: 0,
      byReason: {},
      releasesAt: null,
      fullyReleasesAt: null,
      indefinite: 0,
      ...over,
    };
  }

  it('stays GREEN on a measured-live clean book (AC5, the passing direction)', () => {
    const s = summarizeLiveHealth(input({ liveStopActionability: measured() }));
    expect(s.status).toBe('green');
    expect(s.issues).toEqual([]);
    // The reading is echoed, not swallowed, so the panel can render the counts.
    expect(s.liveStopActionability).toEqual(measured());
  });

  it('goes RED on the planted TRA-4277 state: breached with nothing actionable (AC2/AC3/AC5)', () => {
    const s = summarizeLiveHealth(
      input({
        liveStopActionability: measured({
          breached: 3,
          inert: 3,
          byReason: { close_reject_breaker: 3 },
          indefinite: 3,
        }),
      }),
    );
    expect(s.status).toBe('red');
    // AC3 — the issue names the count, the reason, and the missing release.
    expect(s.issues[0]).toBe(
      '3 live rows breached, 0 actionable (close_reject_breaker) — no release scheduled',
    );
  });

  it('names the earliest release when one is scheduled', () => {
    const s = summarizeLiveHealth(
      input({
        liveStopActionability: measured({
          breached: 1,
          inert: 1,
          byReason: { opening_range_hold: 1 },
          releasesAt: '2026-09-01T14:00:00.000Z',
        }),
      }),
    );
    expect(s.status).toBe('red');
    expect(s.issues[0]).toBe(
      '1 live row breached, 0 actionable (opening_range_hold) — earliest release 2026-09-01T14:00:00.000Z',
    );
  });

  it('does NOT go red when every breached row already has a working exit in flight', () => {
    // `pendingExit` means an order is working at the broker: something IS
    // acting, and a stalling order is `staleWorkingExits`' measurement. AC2's
    // literal predicate would flash RED on every healthy stop fire.
    const s = summarizeLiveHealth(
      input({ liveStopActionability: measured({ breached: 2, inFlight: 2 }) }),
    );
    expect(s.status).toBe('green');
    expect(s.issues).toEqual([]);
  });

  it('is YELLOW when some — but not all — breached rows are inert', () => {
    const s = summarizeLiveHealth(
      input({
        liveStopActionability: measured({
          breached: 3,
          actionable: 1,
          inFlight: 1,
          inert: 1,
          byReason: { covered_write: 1 },
        }),
      }),
    );
    expect(s.status).toBe('yellow');
    expect(s.issues[0]).toMatch(/1\/3 breached live rows are inert \(covered_write\)/);
  });

  it('a BLIND instrument on a live book is not green (AC4)', () => {
    const s = summarizeLiveHealth(
      input({
        liveStopActionability: { instrumentBlind: true, blindReason: 'boom' },
      }),
    );
    expect(s.status).toBe('yellow');
    expect(s.issues[0]).toMatch(/instrument is BLIND \(boom\)/);
  });

  it('a blind instrument on a DEMO book is quiet (the fold only counts live rows)', () => {
    const s = summarizeLiveHealth(
      input({
        mode: 'demo',
        liveStopActionability: { instrumentBlind: true, blindReason: 'boom' },
      }),
    );
    expect(s.status).toBe('green');
  });

  it('a MEASURED breach escalates even under a demo settings mode', () => {
    // The fold only ever counts LIVE rows, so a non-zero reading is real money
    // whatever the settings say the mode is.
    const s = summarizeLiveHealth(
      input({
        mode: 'demo',
        liveStopActionability: measured({
          breached: 1,
          inert: 1,
          byReason: { close_reject_breaker_exhausted: 1 },
        }),
      }),
    );
    expect(s.status).toBe('red');
  });

  it('multiple inert reasons are all named, with counts, largest first', () => {
    const s = summarizeLiveHealth(
      input({
        liveStopActionability: measured({
          breached: 3,
          inert: 3,
          byReason: { close_reject_breaker: 2, multi_leg_combo: 1 },
        }),
      }),
    );
    expect(s.issues[0]).toMatch(/\(close_reject_breaker×2, multi_leg_combo×1\)/);
  });
});
