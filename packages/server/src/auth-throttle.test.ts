import { describe, it, expect, beforeEach } from 'vitest';
import { checkThrottle, recordFailure, recordSuccess, resetThrottle } from './auth-throttle.js';

// Default config (no AUTH_THROTTLE_* env overrides in the test env):
//   FREE_ATTEMPTS = 5, BASE_BACKOFF = 2s, MAX_BACKOFF = 900s,
//   LOCKOUT_AFTER = 12 failures, LOCKOUT = 60min.
// Every call passes an explicit `now` so the tests are deterministic.

beforeEach(() => resetThrottle());

describe('checkThrottle / recordFailure — free attempts', () => {
  it('does not block an unseen key', () => {
    expect(checkThrottle('login:ip:1.2.3.4', 0).blocked).toBe(false);
  });

  it('allows the first 5 failures with no penalty', () => {
    for (let i = 0; i < 5; i++) {
      const d = recordFailure('k', 0);
      expect(d.blocked).toBe(false);
    }
    expect(checkThrottle('k', 0).blocked).toBe(false);
  });
});

describe('recordFailure — exponential backoff after the free attempts', () => {
  it('blocks on the 6th failure with a 2s backoff', () => {
    for (let i = 0; i < 5; i++) recordFailure('k', 0);
    const d = recordFailure('k', 0); // 6th
    expect(d.blocked).toBe(true);
    expect(d.retryAfterSec).toBe(2);
  });

  it('doubles the backoff with each further failure', () => {
    for (let i = 0; i < 5; i++) recordFailure('k', 0);
    expect(recordFailure('k', 0).retryAfterSec).toBe(2); // 6th
    expect(recordFailure('k', 0).retryAfterSec).toBe(4); // 7th
    expect(recordFailure('k', 0).retryAfterSec).toBe(8); // 8th
    expect(recordFailure('k', 0).retryAfterSec).toBe(16); // 9th
  });

  it('reports the remaining wait via checkThrottle and clears once it elapses', () => {
    for (let i = 0; i < 6; i++) recordFailure('k', 1_000); // blockedUntil = 3_000
    expect(checkThrottle('k', 1_000)).toEqual({ blocked: true, retryAfterSec: 2 });
    expect(checkThrottle('k', 2_000).retryAfterSec).toBe(1);
    expect(checkThrottle('k', 3_000).blocked).toBe(false);
  });
});

describe('recordFailure — hard lockout', () => {
  it('locks the key out for ~60 minutes after 12 failures', () => {
    let last = { blocked: false, retryAfterSec: 0 };
    for (let i = 0; i < 12; i++) last = recordFailure('k', 0);
    expect(last.blocked).toBe(true);
    expect(last.retryAfterSec).toBe(60 * 60);
  });
});

describe('recordSuccess', () => {
  it('wipes the failure history so the key is clean again', () => {
    for (let i = 0; i < 6; i++) recordFailure('k', 0);
    expect(checkThrottle('k', 0).blocked).toBe(true);
    recordSuccess('k');
    expect(checkThrottle('k', 0).blocked).toBe(false);
  });
});

describe('per-key isolation', () => {
  it('throttles keys independently', () => {
    for (let i = 0; i < 6; i++) recordFailure('login:ip:attacker', 0);
    expect(checkThrottle('login:ip:attacker', 0).blocked).toBe(true);
    expect(checkThrottle('login:ip:innocent', 0).blocked).toBe(false);
  });
});
