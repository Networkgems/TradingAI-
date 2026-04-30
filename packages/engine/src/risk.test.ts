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

  // TRA-178: the no-cap bug surfaced by TRA-168 round-2 backtests where a tiny
  // ATR-derived stop sized BTC positions to ~60× managed equity ($3.6M on a
  // $100k account) and produced -30,000% return rows that were leverage
  // blow-ups, not strategy P&L.
  it('caps size by notional when stop distance is tiny relative to entry (default ratio = 1.0)', () => {
    const account = makeAccount(100_000); // managed = 50_000
    const risk = new RiskManager(account);
    // stop distance = entry × 0.0001 → risk budget would size to 50_000 shares.
    // Notional cap @ 1.0 × managedEquity / entry = 500 shares. The cap wins.
    const qty = risk.sizeFromStop(100, 100 - 100 * 0.0001);
    expect(qty).toBe(500);
    expect(qty * 100).toBeLessThanOrEqual(50_000); // notional ≤ managed equity
  });

  it('keeps risk-budget sizing when the stop is wide enough that notional is not the binding limit', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account);
    // $1 stop on $100 entry → risk budget = 500 shares ($50k notional);
    // notional cap = 500 shares. Both equal 500, so behavior is unchanged.
    expect(risk.sizeFromStop(100, 99)).toBe(500);
  });

  it('honours a custom maxNotionalRatio (e.g. 0.5 caps at half managed equity)', () => {
    const account = makeAccount(100_000); // managed = 50_000
    const risk = new RiskManager(account, { maxNotionalRatio: 0.5 });
    // 0.5 × 50_000 / 100 = 250 shares; risk budget would still allow 50_000.
    expect(risk.sizeFromStop(100, 100 - 100 * 0.0001)).toBe(250);
  });

  it('allows sizing past managed equity when maxNotionalRatio > 1 (explicit margin opt-in)', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account, { maxNotionalRatio: 2.0 });
    // 2.0 × 50_000 / 100 = 1000 share cap; risk budget binds at 500 here.
    expect(risk.sizeFromStop(100, 99)).toBe(500);
    // …but a tight stop now lets sizing grow up to the wider 1000-share cap.
    expect(risk.sizeFromStop(100, 100 - 100 * 0.0001)).toBe(1000);
  });

  it('TRA-186: fractionalQuantity preserves sub-unit sizing for high-priced assets', () => {
    // Without the flag: $100k account, $80k entry, 2% stop ($1600). Risk budget
    // = $500. riskBased = 500/1600 = 0.3125 → Math.floor → 0 (silent skip).
    const account = makeAccount(100_000);
    const integerSizing = new RiskManager(account);
    expect(integerSizing.sizeFromStop(80_000, 80_000 * 0.98)).toBe(0);

    // With the flag: same inputs return ~0.3125, capped by notional (50k/80k=0.625).
    // Risk-based binds first at 0.3125 BTC.
    const fractionalSizing = new RiskManager(account, { fractionalQuantity: true });
    const qty = fractionalSizing.sizeFromStop(80_000, 80_000 * 0.98);
    expect(qty).toBeCloseTo(0.3125, 4);
    // Sized notional ($25k) stays under the $50k managed-equity cap.
    expect(qty * 80_000).toBeLessThanOrEqual(50_000);
  });

  it('TRA-186: fractionalQuantity rounds down to 8dp to keep float noise out of PnL', () => {
    // Construct an entry/stop combo that makes risk-based sizing irrational.
    // Risk budget $500 / stop $0.7 = 714.2857142857142… A naive return would
    // carry float scraps; we expect truncation to exactly 8 dp.
    const risk = new RiskManager(makeAccount(100_000), { fractionalQuantity: true, maxNotionalRatio: 1000 });
    const qty = risk.sizeFromStop(0.5, 0.5 - 0.7); // stop distance = 0.7 (ignore sign)
    // 500 / 0.7 = 714.28571428571… → floor at 1e8 → 714.28571428
    expect(qty).toBe(714.28571428);
  });
});

describe('RiskManager.sizeFromAtr', () => {
  it('returns 0 for non-positive atr or multiplier (callers can short-circuit)', () => {
    const risk = new RiskManager(makeAccount(100_000), { fractionalQuantity: true });
    expect(risk.sizeFromAtr(60_000, 0, 2)).toBe(0);
    expect(risk.sizeFromAtr(60_000, -100, 2)).toBe(0);
    expect(risk.sizeFromAtr(60_000, 1500, 0)).toBe(0);
    expect(risk.sizeFromAtr(60_000, 1500, -1)).toBe(0);
    expect(risk.sizeFromAtr(60_000, Number.NaN, 2)).toBe(0);
  });

  it('TRA-202: sizes BTC at $60k with ATR $1.5k × 2 so per-trade $-risk equals the budget', () => {
    // $100k account → managed $50k → risk budget $500.
    // Stop distance = 1500 × 2 = $3000 → qty = 500/3000 = 0.16666666… BTC.
    const risk = new RiskManager(makeAccount(100_000), { fractionalQuantity: true });
    const qty = risk.sizeFromAtr(60_000, 1500, 2);
    expect(qty).toBeCloseTo(0.16666666, 6);
    // Achieved $-risk = qty × stopDistance ≈ budget.
    expect(qty * 3000).toBeCloseTo(500, 1);
  });

  it('TRA-202: BTC sizing scales linearly with the per-trade risk budget (0.5% / 1% / 2% slices)', () => {
    // Budget = totalEquity × MANAGED_ACCOUNT_RATIO × DEFAULT_RISK_PER_TRADE
    //        = totalEquity × 0.5 × 0.01 = 0.005 × totalEquity.
    // 50k → $250 (0.5% of $50k); 100k → $500 (0.5% of $100k = 1% of managed);
    // 200k → $1000. Stop distance is constant at $3000.
    const small = new RiskManager(makeAccount(50_000), { fractionalQuantity: true });
    const mid = new RiskManager(makeAccount(100_000), { fractionalQuantity: true });
    const big = new RiskManager(makeAccount(200_000), { fractionalQuantity: true });

    const a = small.sizeFromAtr(60_000, 1500, 2);
    const b = mid.sizeFromAtr(60_000, 1500, 2);
    const c = big.sizeFromAtr(60_000, 1500, 2);

    expect(a).toBeCloseTo(250 / 3000, 6);
    expect(b).toBeCloseTo(500 / 3000, 6);
    expect(c).toBeCloseTo(1000 / 3000, 6);
    expect(b / a).toBeCloseTo(2, 6);
    expect(c / a).toBeCloseTo(4, 6);
  });

  it('rounds down to an explicit lotSize (e.g. 1e-6 for 6dp BTC precision)', () => {
    const risk = new RiskManager(makeAccount(100_000), { fractionalQuantity: true });
    // 0.16666666… → floor to 1e-6 → 0.166666.
    const qty = risk.sizeFromAtr(60_000, 1500, 2, 1e-6);
    expect(qty).toBeCloseTo(0.166666, 6);
    // A coarser 1e-3 step floors the same input to 0.166.
    expect(risk.sizeFromAtr(60_000, 1500, 2, 1e-3)).toBeCloseTo(0.166, 6);
  });

  it('falls back to whole-unit sizing when neither lotSize nor fractionalQuantity is set', () => {
    // $100 entry, ATR $1, multiplier 1 → $1 stop. Budget $500 → 500 shares.
    const risk = new RiskManager(makeAccount(100_000));
    expect(risk.sizeFromAtr(100, 1, 1)).toBe(500);
  });

  it('caps notional when an ATR-derived stop is tiny relative to entry (TRA-178 protection)', () => {
    // ATR $0.001, mult 1 → stop $0.001 → risk-based = 500_000 shares.
    // Notional cap @ 1.0 × $50k / $100 = 500. The cap binds.
    const risk = new RiskManager(makeAccount(100_000));
    expect(risk.sizeFromAtr(100, 0.001, 1)).toBe(500);
  });

  it('engages the drawdown brake (per-trade halved past 10% drawdown)', () => {
    const account = makeAccount(100_000);
    const risk = new RiskManager(account, { fractionalQuantity: true });
    risk.sizeFromAtr(60_000, 1500, 2); // record peak

    account.totalEquity = 80_000; // managed 40k → 20% drawdown engages brake
    const throttled = risk.sizeFromAtr(60_000, 1500, 2);
    // 0.5 × 1% × 40_000 = $200 budget; stop $3000 → 200/3000 = 0.0666666…
    expect(throttled).toBeCloseTo(200 / 3000, 6);
  });

  it('honours a custom maxNotionalRatio (e.g. 0.5 caps at half managed equity)', () => {
    // ATR tight enough that the risk budget would normally exceed the cap.
    const risk = new RiskManager(makeAccount(100_000), { maxNotionalRatio: 0.5 });
    // 0.5 × $50k / $100 = 250 shares; risk-based would be 50_000.
    expect(risk.sizeFromAtr(100, 0.001, 1)).toBe(250);
  });
});
