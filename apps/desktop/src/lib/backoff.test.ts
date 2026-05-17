import { afterEach, describe, expect, it, vi } from 'vitest';
import { computeBackoff, createReconnectController } from './backoff';

describe('computeBackoff (no jitter)', () => {
  const opts = { jitter: false } as const;

  it('grows exponentially from baseMs', () => {
    expect(computeBackoff(0, opts)).toBe(1000);
    expect(computeBackoff(1, opts)).toBe(2000);
    expect(computeBackoff(2, opts)).toBe(4000);
    expect(computeBackoff(3, opts)).toBe(8000);
  });

  it('caps the delay at maxMs', () => {
    expect(computeBackoff(20, opts)).toBe(30000);
  });

  it('treats negative attempts as attempt 0', () => {
    expect(computeBackoff(-5, opts)).toBe(1000);
  });

  it('honours custom base/factor/max', () => {
    expect(computeBackoff(2, { jitter: false, baseMs: 500, factor: 3, maxMs: 100000 })).toBe(4500);
  });
});

describe('computeBackoff (jitter)', () => {
  afterEach(() => vi.restoreAllMocks());

  it('keeps the delay within [raw/2, raw]', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    expect(computeBackoff(1, { baseMs: 1000, factor: 2 })).toBe(1000); // 2000/2
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(computeBackoff(1, { baseMs: 1000, factor: 2 })).toBe(2000); // ~raw
  });
});

describe('createReconnectController', () => {
  it('advances the attempt counter on each nextDelay call', () => {
    const ctrl = createReconnectController({ jitter: false });
    expect(ctrl.attempts).toBe(0);
    expect(ctrl.nextDelay()).toBe(1000);
    expect(ctrl.nextDelay()).toBe(2000);
    expect(ctrl.attempts).toBe(2);
  });

  it('reset() returns the backoff to the first attempt', () => {
    const ctrl = createReconnectController({ jitter: false });
    ctrl.nextDelay();
    ctrl.nextDelay();
    ctrl.reset();
    expect(ctrl.attempts).toBe(0);
    expect(ctrl.nextDelay()).toBe(1000);
  });
});
