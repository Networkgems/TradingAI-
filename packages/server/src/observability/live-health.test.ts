// TRA-528 — live-health summarizer tests.

import { describe, it, expect } from 'vitest';
import { summarizeFeed, summarizeLiveHealth, type LiveHealthInput } from './live-health.js';

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
