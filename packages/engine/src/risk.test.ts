import { describe, it, expect } from 'vitest';
import { RiskManager } from './risk.js';
import type { AccountState } from '@trading-app/shared';

function makeAccount(equity: number): AccountState {
  return {
    totalEquity: equity,
    availableCash: equity,
    openPositions: [],
    dailyPnl: 0,
  };
}

describe('RiskManager', () => {
  it('sizes from stop distance using 1% of managed equity (50% of total)', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account);
    // managed = 50_000; per-trade risk = 500. Stop distance $1 → 500 shares.
    expect(risk.sizeFromStop(100, 99)).toBe(500);
  });

  it('returns 0 when stop distance is 0', () => {
    const risk = new RiskManager(makeAccount(100_000));
    expect(risk.sizeFromStop(100, 100)).toBe(0);
  });

  it('grows position size when account equity grows (compounding)', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account);
    const before = risk.sizeFromStop(100, 99);

    account.totalEquity = 200_000; // simulate equity doubling intra-session
    const after = risk.sizeFromStop(100, 99);

    expect(after).toBeGreaterThan(before);
    expect(after).toBe(before * 2);
  });

  it('shrinks position size when account equity falls (brake disabled)', () => {
    // Disable the drawdown brake so this test isolates the compounding behavior;
    // the brake's amplification of the shrink is covered separately below.
    const account = makeAccount(100_000);
    const risk = new RiskManager(account, { drawdownBrakeThreshold: 1 });
    const before = risk.sizeFromStop(100, 99);

    account.totalEquity = 50_000;
    const after = risk.sizeFromStop(100, 99);

    expect(after).toBeLessThan(before);
    expect(after).toBe(Math.floor(before / 2));
  });

  it('halves per-trade risk when drawdown exceeds brake threshold', () => {
    // 10% default brake threshold → managed equity drop from 50k to ≤45k engages it.
    const account = makeAccount(100_000);
    const risk = new RiskManager(account);
    const baseline = risk.sizeFromStop(100, 99); // 500

    account.totalEquity = 80_000; // managed 40k → drawdown 20% from peak 50k
    const throttled = risk.sizeFromStop(100, 99);

    // Without the brake we'd expect 400 shares. With the 0.5× brake: 200.
    expect(throttled).toBe(200);
    expect(throttled).toBeLessThan(baseline);
  });

  it('disengages the brake once equity recovers above the threshold', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account);
    risk.sizeFromStop(100, 99); // record peak

    account.totalEquity = 80_000;
    const throttled = risk.sizeFromStop(100, 99); // brake active

    account.totalEquity = 100_000; // back to peak
    const recovered = risk.sizeFromStop(100, 99);

    expect(recovered).toBe(500);
    expect(recovered).toBeGreaterThan(throttled);
  });

  it('updates peak equity as account grows so future drawdowns are measured from the new peak', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account);

    account.totalEquity = 200_000; // new peak managed = 100k
    risk.sizeFromStop(100, 99); // observe the new peak

    account.totalEquity = 170_000; // managed 85k → drawdown 15% from new peak
    const throttled = risk.sizeFromStop(100, 99);

    // With brake: 0.5 × 1% × 85k = $425 risk over $1 stop → 425 shares.
    expect(throttled).toBe(425);
  });

  it('respects custom brake threshold and multiplier', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account, {
      drawdownBrakeThreshold: 0.05, // engage on 5% drawdown
      drawdownBrakeMultiplier: 0.25, // quarter the size
    });
    risk.sizeFromStop(100, 99); // peak = 50k managed

    account.totalEquity = 90_000; // managed 45k → 10% drawdown, well past 5% threshold
    const throttled = risk.sizeFromStop(100, 99);
    // 0.25 × 1% × 45k = $112.50 → floor(112.5) = 112 shares.
    expect(throttled).toBe(112);
  });
});
