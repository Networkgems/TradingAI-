import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

// Inside an ET trading window: 10:00 AM ET = 14:00 UTC during EDT (UTC-4).
// Pin to a Tuesday so the weekday/window predicate passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-1',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.30,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('PaperOptionsAccount.openOptionFromCandidate', () => {
  it('opens a position sized off mark*100 using the OTM budget ratio (TRA-160)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildSignal({ mark: 1.0 });
    // OTM budget = 50_000 * 0.5 * 0.025 = $625 → 6 contracts at $100 each.
    const pos = acct.openOptionFromCandidate(sig);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(6);
    expect(pos!.premiumPaid).toBe(1.0);
    expect(pos!.signalType).toBe('otm_mispricing');
    expect(pos!.optionSymbol).toBe('AAPL240705C00200000');
    expect(pos!.strike).toBe(200);
    expect(pos!.expiration).toBe('2024-07-05');
    // SL/TP must follow the OTM overrides, not the ATM defaults.
    expect(pos!.stopLossPremium).toBeCloseTo(0.80, 5);    // 1 − 0.20 SL
    expect(pos!.tp1Premium).toBeCloseTo(1.50, 5);          // 1 + 0.50 TP1
  });

  it('returns null when contracts size to zero (mark too rich for the OTM budget)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 1_000, managedAccountRatio: 0.5 });
    // OTM budget = 1_000 * 0.5 * 0.025 = $12.50; one contract at mark=$1 costs $100 → 0 contracts.
    const sig = buildSignal({ mark: 1.0 });
    expect(acct.openOptionFromCandidate(sig)).toBeNull();
    // Cash untouched.
    expect(acct.getState().optionsCash).toBe(1_000);
    expect(acct.getState().dailyOptionsCount).toBe(0);
  });

  it('caps OTM entries against the user-configurable optionsDailyTradesLimit (TRA-195)', () => {
    // Unified cap = 2 → third OTM candidate must be refused regardless of which scanner
    // path it came from. Pre-TRA-195 this was a per-source OTM cap; the wake comment on
    // TRA-195 confirmed users want one knob that governs the total daily options count.
    const acct = new PaperOptionsAccount({
      initialEquity: 200_000,
      managedAccountRatio: 0.5,
      optionsDailyTradesLimit: 2,
    });
    const a = acct.openOptionFromCandidate(buildSignal({ optionSymbol: 'AAA', strike: 200 }));
    const b = acct.openOptionFromCandidate(buildSignal({ id: 's2', optionSymbol: 'BBB', strike: 210 }));
    const c = acct.openOptionFromCandidate(buildSignal({ id: 's3', optionSymbol: 'CCC', strike: 220 }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(c).toBeNull();
    expect(acct.getState().openOptions).toHaveLength(2);
  });

  it('dedups by OCC symbol — second call with same optionSymbol is a no-op', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const sig = buildSignal();
    const first = acct.openOptionFromCandidate(sig);
    expect(first).not.toBeNull();
    const second = acct.openOptionFromCandidate({ ...sig, id: 'sig-2' });
    expect(second).toBeNull();
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('allows another OTM contract on the same underlying with a different OCC', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const a = acct.openOptionFromCandidate(buildSignal({ optionSymbol: 'AAPL240705C00200000' }));
    const b = acct.openOptionFromCandidate(buildSignal({ id: 'sig-2', optionSymbol: 'AAPL240705C00210000', strike: 210 }));
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(acct.getState().openOptions).toHaveLength(2);
  });

  it('refuses to open outside ET trading windows', () => {
    // 02:00 UTC on a weekday — well outside the 9:35–11:30 / 13:30–15:30 ET windows.
    vi.setSystemTime(Date.parse('2024-06-04T02:00:00Z'));
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.openOptionFromCandidate(buildSignal())).toBeNull();
  });
});

describe('PaperOptionsAccount.checkExits — chain-driven OTM marks', () => {
  it('uses the option mark from the chain map for OTM positions and exits on the tighter OTM SL', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }));
    expect(pos).not.toBeNull();

    // Mark drops 25% — past the OTM −20% stop-loss → full exit at the SL level.
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.75]]);
    const closed = acct.checkExits(new Map(), marks);

    expect(closed).toHaveLength(1);
    expect(closed[0].closedAt).toBeDefined();
    expect(closed[0].pnl).toBeLessThan(0);
    // Realized loss = (0.80 - 1.0) * 6 contracts * 100 = -$120
    expect(closed[0].pnl).toBeCloseTo(-120, 0);
  });

  it('skips OTM positions when no chain mark is supplied (waits for next tick)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }));
    expect(pos).not.toBeNull();
    const before = acct.getState().openOptions[0].currentPremium;

    // Underlying moves but no option mark — OTM position must NOT be re-priced
    // off the underlying because the mark-refresh path is the source of truth.
    const closed = acct.checkExits(new Map([['AAPL', 250]]), new Map());

    expect(closed).toHaveLength(0);
    expect(acct.getState().openOptions[0].currentPremium).toBe(before);
  });

  it('keeps the legacy delta-extrapolation path for ATM (non-OTM) positions', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Open an ATM call via the existing openOption path.
    const pos = acct.openOption({
      id: 'sig-atm',
      symbol: 'AAPL',
      type: 'orb_breakout',
      side: 'buy',
      entryPrice: 100,
      stopLoss: 98,
      takeProfit: 105,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
    }, 100);
    expect(pos).not.toBeNull();
    const entryPremium = pos!.premiumPaid;

    // Underlying drops $2 → premium move = -2 * 0.5 = -$1.0 (50% of premium).
    // Premium ≈ 1.0; new mark ≈ entryPremium - 1.0 = 1.0 → already past SL.
    const closed = acct.checkExits(new Map([['AAPL', 98]]));
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);
    expect(entryPremium).toBe(2.0);
  });
});
