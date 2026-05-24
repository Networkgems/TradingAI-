import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal, RelativeValueSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

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

// TRA-483 — PDT-aware overnight-hold gate. Live positions opened today
// must not auto-close today (TP1 / SL / trailing) so the round trip
// doesn't count as a day trade and burn DTBP. Demo positions are
// unaffected (paper round trips have no PDT impact). Tests opt in
// explicitly because the constructor default is OFF for back-compat
// with the broader unit-test surface — production wires the gate ON via
// `resolveHoldLiveOptionsOvernight(settings)`.
describe('PaperOptionsAccount.checkExits — TRA-483 overnight hold for live (PDT)', () => {
  function gatedAccount(extras: object = {}): PaperOptionsAccount {
    return new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      holdLiveOptionsOvernightForPdt: true,
      ...extras,
    });
  }

  it('skips a same-day live SL exit when the gate is on', () => {
    const acct = gatedAccount();
    // Live open at $1.00 mark — gate prevents same-day SL today even
    // though the mark crashes through the SL.
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();
    expect(pos!.mode).toBe('live');

    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const closed = acct.checkExits(new Map(), marks);

    // No exit fired: position must still be open and no closed row recorded.
    expect(closed).toHaveLength(0);
    expect(acct.getState().openOptions).toHaveLength(1);
    expect(acct.getState().closedOptions).toHaveLength(0);
    // But the mark / dashboard state did update — the gate must not freeze
    // the live mark on the position.
    expect(acct.getState().openOptions[0].currentPremium).toBe(0.30);
  });

  it('allows the SL exit on the next trading session', () => {
    const acct = gatedAccount();
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();

    // Advance the clock past today; openedAt's date key no longer matches
    // today, so the gate releases and the SL fires.
    vi.setSystemTime(TRADING_TIME + 24 * 60 * 60 * 1000);

    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const closed = acct.checkExits(new Map(), marks);

    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('still closes a same-day demo position even with the gate on (paper has no PDT impact)', () => {
    const acct = gatedAccount();
    // Demo open (no equityOverride) — gate must not apply, same-day SL fires.
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo');
    expect(pos).not.toBeNull();
    expect(pos!.mode).toBe('demo');

    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const closed = acct.checkExits(new Map(), marks);

    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);
  });

  it('honours the off-default constructor (legacy back-compat: same-day live SL fires)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();

    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const closed = acct.checkExits(new Map(), marks);

    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);
  });

  it('updateConfig({holdLiveOptionsOvernightForPdt:true}) flips the gate on at runtime', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();

    // Off by default — flip the gate on. A subsequent checkExits with the
    // mark crashed below SL must NOT close the position; the gate now
    // covers both pre-existing and freshly-opened live rows.
    acct.updateConfig({ holdLiveOptionsOvernightForPdt: true });
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const closed = acct.checkExits(new Map(), marks);

    expect(closed).toHaveLength(0);
    expect(acct.getState().openOptions).toHaveLength(1);
  });
});

describe('PaperOptionsAccount.voidOpenOption (TRA-319)', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('refunds cash and reverts the daily counter when an RV open is voided', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const startCash = acct.getState().optionsCash;
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    // RV budget = 50_000 * 0.5 * 0.02 = $500 → 5 contracts at $100 each.
    const cashAfterOpen = acct.getState().optionsCash;
    expect(cashAfterOpen).toBeLessThan(startCash);
    expect(acct.getState().dailyOptionsCount).toBe(1);

    expect(acct.voidOpenOption(pos!.id)).toBe(true);

    // Cash fully restored, position gone from open list, daily counter reverted.
    expect(acct.getState().optionsCash).toBeCloseTo(startCash, 5);
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(acct.getState().dailyOptionsCount).toBe(0);
    // Voided opens leave NO trace in closed-options (vs. closeOption).
    expect(acct.getState().closedOptions).toHaveLength(0);
    // No realized P&L attributed.
    expect(acct.getState().optionsPnl).toBe(0);
  });

  it('returns false for an unknown id', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.voidOpenOption('does-not-exist')).toBe(false);
  });

  it('floors the RV stop distance at the dollar floor on a low-premium open (TRA-462)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // $0.30 premium: the percentage stop distance is 0.30 · 0.25 = $0.075,
    // sub-tick. The $0.10 dollar floor governs → stop = 0.30 − 0.10 = 0.20.
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 0.30 }), 'demo');
    expect(pos).not.toBeNull();
    expect(pos!.stopLossPremium).toBeCloseTo(0.20, 5);
  });

  it('keeps the RV percentage stop when it dominates the dollar floor (TRA-462)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // $1.00 premium: percentage stop distance 1.00 · 0.25 = $0.25 > $0.10
    // floor → percentage governs, stop = 1.00 − 0.25 = 0.75.
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    expect(pos).not.toBeNull();
    expect(pos!.stopLossPremium).toBeCloseTo(0.75, 5);
  });

  it('frees the daily slot so a new RV open can take its place after a void', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      optionsDailyTradesLimit: 1,
    });
    const a = acct.openOptionFromRvCandidate(buildRvSignal({ optionSymbol: 'AAA' }), 'live');
    expect(a).not.toBeNull();
    expect(acct.voidOpenOption(a!.id)).toBe(true);
    // Slot must be reusable since the broker rejected the original — the user
    // shouldn't lose a daily entry to a trade that never happened.
    const b = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-2', optionSymbol: 'BBB', strike: 210 }),
      'live',
    );
    expect(b).not.toBeNull();
  });
});

describe('PaperOptionsAccount — TRA-332 live equity override sizing', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('sizes against equityOverride instead of paper equity in live mode', () => {
    // Paper account seeded at $50 K (matches the demo equity that survives a
    // live flip). TRA-378 — live sizing uses riskPerTrade, not the per-
    // strategy budgetRatio: without the override, demo budget =
    // 50_000 * 1.0 * 0.02 = $1,000 → 10 contracts. With override = $2,000 →
    // budget = min(2_000 * 1.0 * 0.10, 2_000 * 0.15) = $200 → 2 contracts.
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 2000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(2);
    expect(pos!.mode).toBe('live');
  });

  it('opens positions sized off the override when the live equity supports it', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.10,
    });
    // Override = $20 K → budget = min(20_000 * 0.5 * 0.10, 20_000 * 0.15)
    //   = min($1,000, $3,000) = $1,000 → 10 contracts at $100 each.
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 20_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(10);
    expect(pos!.mode).toBe('live');
  });

  it('skips the paper-cash check under an override (paper cash is bookkeeping in live mode)', () => {
    // initialEquity = $100 paper cash so the unconstrained sizing would
    // overflow the paper account. The override should bypass that check —
    // the real buying-power constraint is enforced upstream against
    // Tradier's optionBuyingPower, not paper cash.
    const acct = new PaperOptionsAccount({
      initialEquity: 100,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.10,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBeGreaterThan(0);
  });

  it('getRvBudgetForEquity reflects managedRatio and the riskPerTrade knob (TRA-378)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      riskPerTrade: 0.10,
    });
    // 300 * 0.5 * 0.10 = $15 (below the 15% cap of $45).
    expect(acct.getRvBudgetForEquity(300)).toBeCloseTo(15, 5);
    // Editing the riskPerTrade knob re-sizes the live budget.
    acct.updateConfig({ riskPerTrade: 0.20 });
    expect(acct.getRvBudgetForEquity(300)).toBeCloseTo(30, 5);
  });
});

// TRA-378 — small-account options sizing: riskPerTrade-driven live budget,
// the forced 1-contract floor, the 15%-of-equity per-position cap, and the
// sub-$5k OTM scanner gate.
describe('PaperOptionsAccount — TRA-378 small-account sizing', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  // $1k account, fully managed, 10% risk per trade — the board's live DCA case.
  function smallAccount(): PaperOptionsAccount {
    return new PaperOptionsAccount({
      initialEquity: 1_000,
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
    });
  }

  it('sizes a $1.00-mark RV candidate to ≥1 contract at $1k equity (was 0)', () => {
    // budget = min(1_000 * 1.0 * 0.10, 1_000 * 0.15) = $100; cost = $100 → 1.
    const pos = smallAccount().openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 1_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBeGreaterThanOrEqual(1);
  });

  it('forces a 1-contract floor when the budget alone rounds to 0 contracts', () => {
    // budget $100, mark $1.20 → cost $120 → floor(100/120) = 0. The $120
    // contract still clears the 15% cap ($150) → forced 1 contract.
    const pos = smallAccount().openOptionFromRvCandidate(buildRvSignal({ mark: 1.20 }), 'live', 1_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(1);
  });

  it('sizes a sub-dollar ($0.30) mark to multiple contracts at $1k equity', () => {
    // budget $100, cost $30 → 3 contracts.
    const pos = smallAccount().openOptionFromRvCandidate(buildRvSignal({ mark: 0.30 }), 'live', 1_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(3);
  });

  it('skips a $4.00-mark contract at $1k — the 15% cap, not a $400 position', () => {
    // cost $400 > 15% cap ($150) → the forced floor is gated off → null.
    const acct = smallAccount();
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 4.0 }), 'live', 1_000);
    expect(pos).toBeNull();
    expect(acct.getState().optionsCash).toBe(1_000); // cash untouched
  });

  it('skips a $3.00-mark contract at $1k — one ticket would be 30% of the book', () => {
    // cost $300 > 15% cap ($150) → null (issue #3 example).
    const pos = smallAccount().openOptionFromRvCandidate(buildRvSignal({ mark: 3.0 }), 'live', 1_000);
    expect(pos).toBeNull();
  });

  it('caps the riskPerTrade budget at 15% of equity before the floor', () => {
    // riskPerTrade 0.50 would budget $5,000 at $10k equity, but the cap
    // pins it to 0.15 * 10_000 = $1,500 → 15 contracts at $100, not 50.
    const acct = new PaperOptionsAccount({
      initialEquity: 10_000,
      managedAccountRatio: 1.0,
      riskPerTrade: 0.50,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 10_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(15);
  });

  it('getRvContractsForEquity matches what the open path would size', () => {
    const acct = smallAccount();
    expect(acct.getRvContractsForEquity(1_000, 1.0)).toBe(1);
    expect(acct.getRvContractsForEquity(1_000, 0.30)).toBe(3);
    expect(acct.getRvContractsForEquity(1_000, 4.0)).toBe(0); // 15% cap
  });

  it('demo sizing (no equityOverride) keeps the legacy null-on-zero behaviour', () => {
    // $1k DEMO account: budget = 1_000 * 1.0 * 0.02 = $20; no forced floor in
    // demo → a $1 mark ($100 cost) still returns null. Per-strategy
    // budgetRatio constants stay the demo / fallback default.
    const acct = new PaperOptionsAccount({ initialEquity: 1_000, managedAccountRatio: 1.0 });
    expect(acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo')).toBeNull();
  });

  it('gates the OTM scanner off below $5k live equity (RV-only)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 4_000,
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
    });
    // OTM open is refused under the equity floor regardless of sizing.
    expect(acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 4_000)).toBeNull();
    expect(acct.getOtmContractsForEquity(4_000, 1.0)).toBe(0);
  });

  it('allows the OTM scanner at or above $5k live equity', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 6_000,
      managedAccountRatio: 1.0,
      riskPerTrade: 0.10,
    });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 6_000);
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBeGreaterThanOrEqual(1);
  });

  it('OTM equity gate does not apply to demo sizing (no equityOverride)', () => {
    // A $1k DEMO account never hits the live OTM gate; it still sizes off
    // the per-strategy budgetRatio (and here rounds to 0 → null).
    const acct = new PaperOptionsAccount({ initialEquity: 1_000, managedAccountRatio: 1.0 });
    // Demo at 50k sizes fine — proves the gate is live-only, not a hard block.
    const big = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 1.0 });
    expect(big.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo')).not.toBeNull();
    expect(acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo')).toBeNull();
  });
});

describe('PaperOptionsAccount.getStateForMode — per-mode P&L (TRA-246)', () => {
  it('attributes a live-mode auto-exit to the live bucket only (demo dashboard stays $0)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Open as live so the position is mode-stamped 'live'.
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    // Mark drops past the OTM −20% SL → full exit at the SL level → realized loss.
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.75]]);
    const closed = acct.checkExits(new Map(), marks, 'live');
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeLessThan(0);

    const live = acct.getStateForMode('live');
    const demo = acct.getStateForMode('demo');
    // Live bucket holds the realized loss; demo bucket is untouched at $0
    // even though both views read from the same PaperOptionsAccount instance.
    expect(live.optionsPnl).toBeCloseTo(closed[0].pnl ?? 0, 5);
    expect(demo.optionsPnl).toBe(0);
    // Demo never opens options under TRA-220, so its visible cash is forced
    // to 0 to avoid surfacing the live-side cash on the Demo dashboard.
    expect(demo.optionsCash).toBe(0);
    // Live cash mirrors the underlying account cash (proceeds returned at exit).
    expect(live.optionsCash).toBeGreaterThan(0);
    // Bucket-wide getState() still exposes the cross-mode total for the EOD
    // report / PnlTracker consumers.
    expect(acct.getState().optionsPnl).toBeCloseTo(closed[0].pnl ?? 0, 5);
  });

  it('attributes a live manual closeOption to the live bucket only', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    // Bump the current premium so a manual close realizes a $+ P&L.
    const opened = acct.getState().openOptions[0];
    opened.currentPremium = 1.50;

    const closed = acct.closeOption(opened.id);
    expect(closed).not.toBeNull();
    expect(closed!.pnl).toBeGreaterThan(0);

    expect(acct.getStateForMode('demo').optionsPnl).toBe(0);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(closed!.pnl ?? 0, 5);
  });

  // TRA-352 — when the engine-opened live close path mirrored the
  // `sell_to_close` to Tradier and saw it fill, the broker's avg fill price
  // (not the local mark) drives realized P&L and the paper cash credit.
  // Without this, a stale mark on a wide-spread OCC would diverge from the
  // broker's actual fill and the user's "Recent Closed Options" pnl would
  // not match the Tradier history calendar.
  it('closeOption uses overrideFillPrice for cash + P&L when supplied', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    const opened = acct.getState().openOptions[0];
    // Stale local mark — 1.80 would have been used absent the override.
    opened.currentPremium = 1.80;
    const cashBefore = acct.getState().optionsCash;
    const contracts = opened.contractsRemaining;
    // Tradier filled at 1.50 — that's the price that should credit paper cash.
    const closed = acct.closeOption(opened.id, 1.50);
    expect(closed).not.toBeNull();
    // Realized = (1.50 − 1.00) × contracts × 100
    expect(closed!.pnl).toBeCloseTo(0.50 * contracts * 100, 5);
    expect(closed!.currentPremium).toBe(1.50);
    // Cash credit uses the broker fill, not the stale mark.
    expect(acct.getState().optionsCash - cashBefore).toBeCloseTo(1.50 * contracts * 100, 5);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(closed!.pnl ?? 0, 5);
  });

  it('closeOption falls back to currentPremium when overrideFillPrice is non-finite', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    const opened = acct.getState().openOptions[0];
    opened.currentPremium = 1.20;
    const closed = acct.closeOption(opened.id, Number.NaN);
    expect(closed).not.toBeNull();
    // Falls back to local mark: (1.20 − 1.00) × contracts × 100
    expect(closed!.pnl).toBeCloseTo(0.20 * opened.contracts * 100, 5);
  });

  it('legacy snapshot without optionsPnlByMode attributes the bucket-wide total to the live bucket', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // Pre-TRA-246 snapshot — only the bucket-wide optionsPnl is persisted.
    acct.importSnapshot({
      openOptions: [],
      closedOptions: [],
      optionsPnl: 524.50,
      dailyCount: 10,
      currentDayKey: '2026-04-28',
      cash: 25_000,
      equity: 25_524.50,
    });
    // TRA-220 forbids demo from opening options, so a legacy total can only
    // have come from live trades; route it to the live bucket on import.
    expect(acct.getStateForMode('live').optionsPnl).toBe(524.50);
    expect(acct.getStateForMode('demo').optionsPnl).toBe(0);
    // Total still equals the legacy field for back-compat consumers.
    expect(acct.getState().optionsPnl).toBe(524.50);
  });

  // ─── TRA-475: Daily-reset Opts P&L pill ────────────────────────────────────
  describe('PaperOptionsAccount — dailyOptionsPnl daily reset (TRA-475)', () => {
    it('returns 0 on day one with no closes and no marks', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      expect(acct.getStateForMode('live').dailyOptionsPnl).toBe(0);
      expect(acct.getStateForMode('demo').dailyOptionsPnl).toBe(0);
      expect(acct.getState().dailyOptionsPnl).toBe(0);
    });

    it('today\'s realized loss surfaces in dailyOptionsPnl AND in cumulative optionsPnl', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
      expect(pos).not.toBeNull();
      // SL fill → realized loss booked into the live bucket.
      acct.checkExits(new Map(), new Map([[pos!.optionSymbol!, 0.75]]), 'live');
      const live = acct.getStateForMode('live');
      // Cumulative and daily both reflect the loss on day one (opening baseline = 0).
      expect(live.optionsPnl).toBeLessThan(0);
      expect(live.dailyOptionsPnl).toBeCloseTo(live.optionsPnl, 5);
    });

    it('rolls the opening baseline forward on the next ET day — daily pill resets, cumulative persists', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
      acct.checkExits(new Map(), new Map([[pos!.optionSymbol!, 0.75]]), 'live');
      const liveBefore = acct.getStateForMode('live');
      expect(liveBefore.dailyOptionsPnl).toBeLessThan(0);
      const cumulative = liveBefore.optionsPnl;

      // Advance the clock past ET midnight so the next sample triggers
      // the daily rollover. `getStateForMode` itself calls resetDayIfNeeded
      // so we don't need to open a new position to force the rollover.
      vi.setSystemTime(TRADING_TIME + 24 * 60 * 60 * 1000);

      const liveAfter = acct.getStateForMode('live');
      // Cumulative realized survives the day change; daily delta resets to 0.
      expect(liveAfter.optionsPnl).toBeCloseTo(cumulative, 5);
      expect(liveAfter.dailyOptionsPnl).toBe(0);
    });

    it('dailyOptionsPnl includes unrealized MTM on currently-open positions for that mode', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
      expect(pos).not.toBeNull();
      // Mark the live position up (no exit) → only contributes via unrealized.
      const opened = acct.getStateForMode('live').openOptions[0];
      opened.currentPremium = 1.25;
      const live = acct.getStateForMode('live');
      // Unrealized = (1.25 − 1.00) × contracts × 100, fully credited to "today"
      // because the position was opened today and nothing's closed.
      const expectedUnrealized = (1.25 - 1.0) * opened.contractsRemaining * 100;
      expect(live.dailyOptionsPnl).toBeCloseTo(expectedUnrealized, 5);
      // No closes ⇒ cumulative realized still 0; the daily pill is the only
      // place the MTM shows up at the header.
      expect(live.optionsPnl).toBe(0);
    });

    it('open position without a fresh mark (currentPremium = 0) contributes 0 — no NaN from a stale tick', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
      const opened = acct.getStateForMode('live').openOptions[0];
      opened.currentPremium = 0; // stale: scanner hasn't populated a mark yet
      const live = acct.getStateForMode('live');
      expect(live.dailyOptionsPnl).toBe(0);
      expect(Number.isFinite(live.dailyOptionsPnl)).toBe(true);
    });

    it('per-mode daily pill is isolated — live MTM does not leak into demo dashboard', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
      const opened = acct.getStateForMode('live').openOptions[0];
      opened.currentPremium = 1.50; // live MTM gain
      expect(acct.getStateForMode('live').dailyOptionsPnl).toBeGreaterThan(0);
      // Demo dashboard sees $0 — the TRA-246 cross-mode shield extended to
      // the daily pill so a Demo viewer doesn't see Live's MTM.
      expect(acct.getStateForMode('demo').dailyOptionsPnl).toBe(0);
    });

    it('legacy snapshot without openingOptionsPnlByMode anchors baseline at current cumulative (post-restart pill = 0)', () => {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      // Pre-TRA-475 snapshot: per-mode realized P&L only.
      acct.importSnapshot({
        openOptions: [],
        closedOptions: [],
        optionsPnl: -19_471,
        optionsPnlByMode: { demo: 0, live: -19_471 },
        dailyCount: 1,
        currentDayKey: '2026-05-20',
        cash: 64_224.32,
        equity: 50_000 - 19_471,
      });
      // Cumulative survives the import.
      expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(-19_471, 5);
      // Daily resets to 0 — the rollover-from-snapshot can't reconstruct
      // when today's losses booked, so it anchors to "now" and starts fresh.
      // This is the exact symptom the user filed TRA-475 against (header
      // showing a huge negative cumulative as if it were today's number).
      expect(acct.getStateForMode('live').dailyOptionsPnl).toBe(0);
    });

    it('round-trips openingOptionsPnlByMode through export/import once an entry rolls it forward', () => {
      const a = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      const pos = a.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
      a.checkExits(new Map(), new Map([[pos!.optionSymbol!, 0.75]]), 'live');
      const dayOnePnl = a.getStateForMode('live').optionsPnl;

      // Advance to day two and open a fresh position — the entry path's
      // `resetDayIfNeeded()` is what actually rolls the opening baseline,
      // so the snapshot reflects "today started at the prior cumulative".
      vi.setSystemTime(TRADING_TIME + 24 * 60 * 60 * 1000);
      a.openOptionFromCandidate(buildSignal({ id: 's-d2', optionSymbol: 'AAPL240712C00200000', mark: 1.0 }), 'live');

      const snap = a.exportSnapshot();
      expect(snap.openingOptionsPnlByMode).toBeDefined();
      expect(snap.openingOptionsPnlByMode!.live).toBeCloseTo(dayOnePnl, 5);

      const b = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      b.importSnapshot(snap);
      // After import, the per-mode opening baseline persisted so cumulative
      // realized is preserved (the EOD / PnlTracker view).
      expect(b.getStateForMode('live').optionsPnl).toBeCloseTo(dayOnePnl, 5);
      // The day-two position has no mark yet, so its unrealized contribution
      // is 0, and realized hasn't moved since the roll — daily pill = 0.
      expect(b.getStateForMode('live').dailyOptionsPnl).toBe(0);
    });
  });

  it('round-trips per-mode P&L via export/import', () => {
    const a = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = a.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    a.checkExits(new Map(), new Map([[pos!.optionSymbol!, 0.75]]), 'live');
    const livePnl = a.getStateForMode('live').optionsPnl;
    expect(livePnl).toBeLessThan(0);

    const snap = a.exportSnapshot();
    expect(snap.optionsPnlByMode).toBeDefined();
    expect(snap.optionsPnlByMode!.live).toBeCloseTo(livePnl, 5);
    expect(snap.optionsPnlByMode!.demo).toBe(0);

    const b = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    b.importSnapshot(snap);
    expect(b.getStateForMode('live').optionsPnl).toBeCloseTo(livePnl, 5);
    expect(b.getStateForMode('demo').optionsPnl).toBe(0);
  });
});

// ─── TRA-323: Tradier-positions sync ─────────────────────────────────────────

function buildTradierPosition(overrides: Partial<TradierOpenOptionPosition> = {}): TradierOpenOptionPosition {
  return {
    optionSymbol: 'SPY260515C00450000',
    underlying: 'SPY',
    optionType: 'call',
    strike: 450,
    expiration: '2026-05-15',
    contracts: 2,
    premiumPaid: 1.6,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

describe('PaperOptionsAccount.reconcileTradierPositions', () => {
  it('imports unknown Tradier positions without touching cash or daily counters', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    const before = acct.getState();

    const summary = acct.reconcileTradierPositions([buildTradierPosition()]);

    expect(summary).toEqual({ added: 1, updated: 0, removed: 0, total: 1 });
    const state = acct.getState();
    expect(state.openOptions).toHaveLength(1);
    const imported = state.openOptions[0];
    expect(imported.importedFromTradier).toBe(true);
    expect(imported.signalType).toBe('tradier_import');
    expect(imported.symbol).toBe('SPY');
    expect(imported.optionSymbol).toBe('SPY260515C00450000');
    expect(imported.tradierEnv).toBe('sandbox');
    // Imported positions never touch cash or the daily counter — they live
    // on Tradier's books, not the local paper bucket.
    expect(state.optionsCash).toBe(before.optionsCash);
    expect(state.dailyOptionsCount).toBe(0);
  });

  it('updates an existing imported row when contracts or premium change', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ contracts: 2, premiumPaid: 1.6 })]);
    const summary = acct.reconcileTradierPositions([
      buildTradierPosition({ contracts: 3, premiumPaid: 1.7 }),
    ]);
    expect(summary).toEqual({ added: 0, updated: 1, removed: 0, total: 1 });
    const opt = acct.getState().openOptions[0];
    expect(opt.contracts).toBe(3);
    expect(opt.contractsRemaining).toBe(3);
    expect(opt.premiumPaid).toBeCloseTo(1.7, 5);
  });

  it('drops imported rows that disappear from Tradier (closed elsewhere) AND records the close into closedOptions (TRA-475)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([
      buildTradierPosition({ optionSymbol: 'SPY260515C00450000', premiumPaid: 1.6 }),
      buildTradierPosition({
        optionSymbol: 'AAPL260920P00187500',
        underlying: 'AAPL',
        optionType: 'put',
        strike: 187.5,
        expiration: '2026-09-20',
        contracts: 1,
        premiumPaid: 2.0,
      }),
    ]);
    expect(acct.getState().openOptions).toHaveLength(2);
    // Refresh the AAPL mark — what `refreshImportedMarks` would do after a
    // quote fetch — so the externally-closed row gets a realistic exit
    // estimate instead of break-even.
    acct.refreshImportedMarks(new Map([['AAPL260920P00187500', 2.5]]));

    const summary = acct.reconcileTradierPositions([
      buildTradierPosition({ optionSymbol: 'SPY260515C00450000', premiumPaid: 1.6 }),
    ]);
    expect(summary).toEqual({ added: 0, updated: 0, removed: 1, total: 1 });
    const open = acct.getState().openOptions;
    expect(open).toHaveLength(1);
    expect(open[0].optionSymbol).toBe('SPY260515C00450000');

    // TRA-475 — the dropped imported position must surface as a Closed Today
    // row so the user can see it (previously it silently disappeared).
    const closed = acct.getState().closedOptions;
    expect(closed).toHaveLength(1);
    expect(closed[0].optionSymbol).toBe('AAPL260920P00187500');
    expect(closed[0].importedFromTradier).toBe(true);
    // Exit premium = last refreshed mark (2.5), realised = (2.5 − 2.0) × 1 × 100 = +50.
    expect(closed[0].currentPremium).toBeCloseTo(2.5, 5);
    expect(closed[0].pnl).toBeCloseTo(50, 5);
    // And realised P&L lands on the live bucket immediately (the dashboard
    // pill no longer waits for the EOD Tradier-history reconcile).
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(50, 5);
  });

  // TRA-475 — when an imported position has no fresh mark (`currentPremium`
  // is 0 or still equal to `premiumPaid` because `refreshImportedMarks` hasn't
  // landed), recording a synthetic close still has to fire so the row appears
  // in the Closed Today table. The pnl falls back to 0 and the EOD Tradier
  // history reconcile corrects the cumulative pill on its next pass via the
  // existing `realtimeImportedPnlByDate` dedup.
  it('records a break-even synthetic close when an externally-closed import has no fresh mark (TRA-475)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([
      buildTradierPosition({ optionSymbol: 'SPY260515C00450000', premiumPaid: 1.6 }),
    ]);
    // No `refreshImportedMarks` — currentPremium is still 1.6 (the seed value
    // from reconcile). The "fresh mark" guard treats `currentPremium ===
    // premiumPaid` as the no-refresh case in practice; the synthetic close
    // still records, with pnl = 0.
    const summary = acct.reconcileTradierPositions([]);
    expect(summary).toEqual({ added: 0, updated: 0, removed: 1, total: 0 });
    const closed = acct.getState().closedOptions;
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeCloseTo(0, 5);
    // Live pill unchanged at $0 — the EOD reconcile will land the broker-side
    // P&L when it next runs, and the realtime dedup map is empty for this
    // case so no double-count.
    expect(acct.getStateForMode('live').optionsPnl).toBe(0);
  });

  // TRA-475 — the synthetic close from the portfolio-reconcile drop feeds
  // `realtimeImportedPnlByDate` so the EOD Tradier-history reconcile path
  // can subtract our estimate via `consumeRealtimeImportedPnl` before adding
  // broker-truth P&L. Without this, the same close would be double-counted
  // (once here, once when its Tradier history fill lands).
  it('externally-closed import dedups against the EOD Tradier-history reconcile (TRA-475)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    // Default Tradier position has 2 contracts; realised on close = (mark − paid) × 2 × 100.
    acct.reconcileTradierPositions([
      buildTradierPosition({ optionSymbol: 'SPY260515C00450000', premiumPaid: 1.6 }),
    ]);
    acct.refreshImportedMarks(new Map([['SPY260515C00450000', 1.8]]));
    // External close: position disappears from Tradier's payload.
    acct.reconcileTradierPositions([]);
    // Live pill jumped immediately by our estimate: +$40 = (1.8 − 1.6) × 2 × 100.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(40, 5);
    // The dedup map carries the same +$40 so the EOD reconcile can subtract
    // it before applying broker truth — no double-count when Tradier history
    // returns this fill on the next sweep.
    const realtime = acct.consumeRealtimeImportedPnl();
    const drained = Array.from(realtime.values()).reduce((a, b) => a + b, 0);
    expect(drained).toBeCloseTo(40, 5);
  });

  it('leaves engine-opened positions untouched even when Tradier reports the same OCC', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const sig = buildSignal({ optionSymbol: 'AAPL240705C00200000' });
    const opened = acct.openOptionFromCandidate(sig, 'live');
    expect(opened).not.toBeNull();
    const beforeContracts = opened!.contracts;
    const beforePremium = opened!.premiumPaid;

    const summary = acct.reconcileTradierPositions([
      buildTradierPosition({
        optionSymbol: 'AAPL240705C00200000',
        underlying: 'AAPL',
        optionType: 'call',
        strike: 200,
        expiration: '2024-07-05',
        contracts: 99,
        premiumPaid: 9.99,
      }),
    ]);
    // Engine-opened row covers this OCC; reconcile leaves it alone.
    expect(summary).toEqual({ added: 0, updated: 0, removed: 0, total: 1 });
    const survivor = acct.getState().openOptions.find(o => o.optionSymbol === 'AAPL240705C00200000');
    expect(survivor?.importedFromTradier).toBeFalsy();
    expect(survivor?.contracts).toBe(beforeContracts);
    expect(survivor?.premiumPaid).toBe(beforePremium);
  });

  it('checkExits skips imported positions without waitAndHold (no broker mirror available)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 1.6 })]);
    const open = acct.getState().openOptions[0];

    // TRA-361 — even with auto-management on (default), the caller must run
    // checkExits in waitAndHold mode for imports to fire. Without it there's
    // no path to mirror the exit to Tradier, and mutating the paper book
    // here would phantom-credit cash for a position still open at the
    // broker. The signal-engine only enables waitAndHold under live mirroring.
    const closed = acct.checkExits(new Map(), new Map([[open.optionSymbol!, 0.01]]), 'live');
    expect(closed).toEqual([]);
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('closeOption refuses imported positions; dropImportedPosition removes them cleanly', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition()]);
    const id = acct.getState().openOptions[0].id;
    const cashBefore = acct.getState().optionsCash;

    expect(acct.closeOption(id)).toBeNull(); // refuses — would double-count
    expect(acct.getState().openOptions).toHaveLength(1);

    const dropped = acct.dropImportedPosition(id);
    expect(dropped?.id).toBe(id);
    expect(acct.getState().openOptions).toHaveLength(0);
    // Cash untouched — imported positions never lived on the paper bucket.
    expect(acct.getState().optionsCash).toBe(cashBefore);
  });
});

// ─── TRA-361: auto-manage imported Tradier positions ────────────────────────

describe('PaperOptionsAccount auto-manage imported (TRA-361)', () => {
  // Mirrors the RV defaults from @trading-app/shared at the time of writing.
  // The test asserts a stable relationship (`SL = premiumPaid * (1 - slPct)`)
  // rather than a hard-coded number so a future RV-default tweak keeps the
  // contract intact.
  const importedSL = (premium: number, slPct: number) => premium * (1 - slPct);
  const importedTP1 = (premium: number, tp1Pct: number) => premium * (1 + tp1Pct);

  it('reconcile installs RV-default SL/TP/trail thresholds when auto-manage is on', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: true,
      rvRiskParams: {
        budgetRatio: 0.025,
        slPct: 0.25,
        slDollarFloor: 0.10,
        tp1Pct: 0.50,
        trailActivatePct: 0.20,
        trailOffsetPct: 0.12,
        partialExitRatio: 0.50,
        dailyLimit: 4,
      },
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 2.0 })]);
    const opt = acct.getState().openOptions[0];
    expect(opt.stopLossPremium).toBeCloseTo(importedSL(2.0, 0.25), 5); // 1.50
    expect(opt.tp1Premium).toBeCloseTo(importedTP1(2.0, 0.50), 5); // 3.00
    // Pre-activation sentinel: trailing stop seeded at activation threshold.
    expect(opt.trailingStopPremium).toBeCloseTo(2.0 * 1.20, 5); // 2.40
    expect(opt.trailingActive).toBe(false);
    expect(opt.tp1Hit).toBe(false);
  });

  it('does NOT auto-manage a sub-floor import even when auto-manage is on (TRA-462)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: true,
    });
    // premiumPaid $0.08 is below the $0.40 RV minMark floor — the engine
    // cannot risk-manage it (its stop would be sub-tick), so it stays on the
    // unmanaged sentinel path regardless of the auto-manage flag.
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 0.08 })]);
    const opt = acct.getState().openOptions[0];
    expect(opt.tp1Premium).toBe(Number.POSITIVE_INFINITY);
    expect(opt.stopLossPremium).toBe(0);
    expect(opt.trailingStopPremium).toBe(0);
    expect(opt.trailingActive).toBe(false);
  });

  it('still applies the RV schedule to an at-floor import (premiumPaid $0.60, TRA-462)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: true,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 0.60 })]);
    const opt = acct.getState().openOptions[0];
    // $0.60 ≥ $0.40 floor → RV schedule applies. Stop distance =
    // max(0.60 · 0.25, 0.10) = $0.15 → stopLossPremium = 0.60 − 0.15 = 0.45.
    expect(opt.stopLossPremium).toBeCloseTo(0.45, 5);
    expect(opt.tp1Premium).toBeLessThan(Number.POSITIVE_INFINITY);
    expect(opt.tp1Premium).toBeCloseTo(importedTP1(0.60, 0.40), 5); // 0.84
  });

  it('reconcile keeps sentinel thresholds when auto-manage is off', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: false,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 2.0 })]);
    const opt = acct.getState().openOptions[0];
    expect(opt.tp1Premium).toBe(Number.POSITIVE_INFINITY);
    expect(opt.stopLossPremium).toBe(0);
    expect(opt.trailingStopPremium).toBe(0);
  });

  it('flipping the toggle live (updateConfig) rewrites thresholds on existing imports', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: false,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 2.0 })]);
    expect(acct.getState().openOptions[0].stopLossPremium).toBe(0);

    acct.updateConfig({ autoManageImportedTradierOptions: true });
    const after = acct.getState().openOptions[0];
    expect(after.stopLossPremium).toBeGreaterThan(0);
    expect(after.tp1Premium).toBeLessThan(Number.POSITIVE_INFINITY);
  });

  it('checkExits stages a pendingExit LIMIT on imported SL trip without touching paper cash', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: true,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 2.0 })]);
    const open = acct.getState().openOptions[0];
    const cashBefore = acct.getState().optionsCash;
    const pnlBefore = acct.getState().optionsPnl;

    // Mark just below SL but well above the deep-underwater threshold:
    // SL = 1.50 (slPct=0.25 default); pick 1.45 which is inside the
    // [SL*(1−slPct/2), SL] band = [1.3125, 1.50].
    const staged = acct.checkExits(
      new Map(),
      new Map([[open.optionSymbol!, 1.45]]),
      'live',
      { waitAndHold: true },
    );

    expect(staged).toHaveLength(1);
    const pending = staged[0].pendingExit;
    expect(pending?.kind).toBe('sl');
    expect(pending?.pricing).toBe('limit');
    expect(pending?.qty).toBe(open.contracts);

    // Position must still be open; pendingExit attached.
    const state = acct.getState();
    expect(state.openOptions).toHaveLength(1);
    expect(state.openOptions[0].pendingExit).toBeDefined();
    // Phantom-P&L guardrail: nothing hits paper cash or the per-mode bucket.
    expect(state.optionsCash).toBe(cashBefore);
    expect(state.optionsPnl).toBe(pnlBefore);
  });

  it('checkExits escalates to MARKET pricing when an imported row is deep-underwater', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: true,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 10.0 })]);
    const open = acct.getState().openOptions[0];

    // Default slPct = 0.25; SL = 7.50. Deep threshold = SL * (1 − slPct/2)
    // = 7.50 * 0.875 = 6.5625. NFLX-style "-96%" mark: 0.40 sits well below.
    const staged = acct.checkExits(
      new Map(),
      new Map([[open.optionSymbol!, 0.40]]),
      'live',
      { waitAndHold: true },
    );
    expect(staged).toHaveLength(1);
    expect(staged[0].pendingExit?.pricing).toBe('market');
    expect(staged[0].pendingExit?.kind).toBe('sl');
  });

  it('checkExits leaves imports alone when auto-manage is off (legacy TRA-323 skip)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: false,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 1.6 })]);
    const open = acct.getState().openOptions[0];

    // Even in waitAndHold mode, a mark that would otherwise trip the SL must
    // not stage a pending exit when the user has opted out.
    const closed = acct.checkExits(
      new Map(),
      new Map([[open.optionSymbol!, 0.01]]),
      'live',
      { waitAndHold: true },
    );
    expect(closed).toEqual([]);
    expect(acct.getState().openOptions[0].pendingExit).toBeUndefined();
  });

  it('finalizePendingExit on an imported full-close leaves paper cash alone but updates live-mode P&L (TRA-367)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 25_000,
      tradierEnv: 'sandbox',
      autoManageImportedTradierOptions: true,
    });
    acct.reconcileTradierPositions([buildTradierPosition({ contracts: 2, premiumPaid: 2.0 })]);
    const open = acct.getState().openOptions[0];

    // Trip SL → stage pendingExit
    const staged = acct.checkExits(
      new Map(),
      new Map([[open.optionSymbol!, 1.45]]),
      'live',
      { waitAndHold: true },
    );
    expect(staged).toHaveLength(1);
    acct.attachPendingExit(open.id, 'tradier-order-1');

    const cashBefore = acct.getState().optionsCash;
    const pnlBeforeLive = acct.getStateForMode('live').optionsPnl;

    // Pretend Tradier filled at $1.50 — paper cash must not be credited
    // (proceeds live on Tradier).
    const finalised = acct.finalizePendingExit(open.id, 1.50);
    expect(finalised).not.toBeNull();
    expect(finalised?.contractsRemaining).toBe(0);
    expect(finalised?.pnl).toBeCloseTo((1.50 - 2.0) * 2 * 100, 5); // -$100

    const state = acct.getState();
    expect(state.openOptions).toHaveLength(0);
    expect(state.optionsCash).toBe(cashBefore);
    expect(state.closedOptions.find(o => o.id === open.id)).toBeDefined();

    // TRA-367 — the live-mode pill MUST reflect the realised loss
    // immediately instead of waiting for the EOD Tradier reconcile.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(pnlBeforeLive - 100, 5);

    // The per-date dedup map drains the realtime offset so the EOD
    // reconcile path can subtract it from the Tradier-history total.
    const realtime = acct.consumeRealtimeImportedPnl();
    const drained = Array.from(realtime.values()).reduce((a, b) => a + b, 0);
    expect(drained).toBeCloseTo(-100, 5);
    // Draining is idempotent — second consume returns empty.
    expect(acct.consumeRealtimeImportedPnl().size).toBe(0);
  });
});

// ─── TRA-351: imported-position mark refresh ─────────────────────────────────

describe('PaperOptionsAccount.refreshImportedMarks', () => {
  it('updates currentPremium for imported rows when a mark is supplied', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 1.6 })]);
    const symbol = acct.getState().openOptions[0].optionSymbol!;
    // Seed mark — premium paid was 1.60, fresh mark is 2.10 (+50¢ × 100 ×
    // 2 contracts = +$100 unrealized). Before this call the dashboard would
    // show "Current Mark = 1.60" and "P&L = $0".
    const updated = acct.refreshImportedMarks(new Map([[symbol, 2.10]]));
    expect(updated).toBe(1);
    const opt = acct.getState().openOptions[0];
    expect(opt.currentPremium).toBeCloseTo(2.10, 5);
  });

  it('leaves engine-opened positions alone (paper-side mark schedule owns them)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const opened = acct.openOptionFromCandidate(buildSignal({ optionSymbol: 'AAPL240705C00200000' }));
    expect(opened).not.toBeNull();
    const beforeMark = acct.getState().openOptions[0].currentPremium;
    const updated = acct.refreshImportedMarks(new Map([['AAPL240705C00200000', 99.99]]));
    expect(updated).toBe(0);
    expect(acct.getState().openOptions[0].currentPremium).toBe(beforeMark);
  });

  it('ignores rows whose OCC isn\'t in the mark map and zero/negative marks', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ premiumPaid: 1.6 })]);
    const symbol = acct.getState().openOptions[0].optionSymbol!;
    expect(acct.refreshImportedMarks(new Map())).toBe(0);
    expect(acct.refreshImportedMarks(new Map([[symbol, 0]]))).toBe(0);
    expect(acct.refreshImportedMarks(new Map([[symbol, -1]]))).toBe(0);
    // currentPremium should still be the seeded entry premium.
    expect(acct.getState().openOptions[0].currentPremium).toBeCloseTo(1.6, 5);
  });
});

// ─── TRA-348: drop-on-fill, pendingCloseOrderId, reconciled P&L ──────────────

describe('PaperOptionsAccount.recordImportedFill', () => {
  it('records a closed-options entry and removes the open row without touching cash', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ contracts: 2, premiumPaid: 1.6 })]);
    const id = acct.getState().openOptions[0].id;
    const cashBefore = acct.getState().optionsCash;

    const closed = acct.recordImportedFill(id, 1.85);
    expect(closed).not.toBeNull();
    expect(closed?.contractsRemaining).toBe(0);
    // Realized = (1.85 − 1.60) × 2 × 100 = +50
    expect(closed?.pnl).toBeCloseTo(50, 5);

    const state = acct.getState();
    expect(state.openOptions).toHaveLength(0);
    expect(state.closedOptions.find(o => o.id === id)?.pnl).toBeCloseTo(50, 5);
    // Imported close does NOT touch the paper cash — proceeds live on Tradier.
    expect(state.optionsCash).toBe(cashBefore);
  });

  it('returns null when the row is engine-opened (not imported)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const opened = acct.openOptionFromCandidate(buildSignal());
    expect(opened).not.toBeNull();
    expect(acct.recordImportedFill(opened!.id, 2.0)).toBeNull();
  });

  // TRA-367 — surfaces realised P&L on the Live pill the moment the
  // sell_to_close fills instead of waiting for the EOD Tradier-history
  // reconcile. The per-date dedup map then lets the reconcile pass
  // subtract this offset so the same close isn't counted twice.
  it('bumps optionsPnlByMode.live in realtime and exposes a drainable per-date offset', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    acct.reconcileTradierPositions([buildTradierPosition({ contracts: 2, premiumPaid: 1.6 })]);
    const id = acct.getState().openOptions[0].id;
    const liveBefore = acct.getStateForMode('live').optionsPnl;

    acct.recordImportedFill(id, 1.85); // +$50 realised

    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(liveBefore + 50, 5);
    const realtime = acct.consumeRealtimeImportedPnl();
    expect(Array.from(realtime.values()).reduce((a, b) => a + b, 0)).toBeCloseTo(50, 5);
    // Map drained.
    expect(acct.consumeRealtimeImportedPnl().size).toBe(0);
  });
});

describe('PaperOptionsAccount.setPendingCloseOrderId', () => {
  it('stamps pendingCloseOrderId on the imported row', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition()]);
    const id = acct.getState().openOptions[0].id;

    expect(acct.setPendingCloseOrderId(id, 99001)).toBe(true);
    const after = acct.getState().openOptions.find(o => o.id === id);
    expect(after?.pendingCloseOrderId).toBe(99001);
  });

  // TRA-352 — engine-opened live closes also mirror to Tradier (signal-engine
  // line 1017 fires a `buy_to_open`; the close path mirrors a `sell_to_close`),
  // so engine-opened rows with an in-flight close order need the pending tag
  // too. Prior to TRA-352 the close path was paper-only, so the helper
  // refused engine rows defensively.
  it('also stamps engine-opened rows so live closes can render "Pending #N"', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const opened = acct.openOptionFromCandidate(buildSignal());
    expect(opened).not.toBeNull();
    expect(acct.setPendingCloseOrderId(opened!.id, 4242)).toBe(true);
    const after = acct.getState().openOptions.find(o => o.id === opened!.id);
    expect(after?.pendingCloseOrderId).toBe(4242);
  });

  it('returns false for unknown ids', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    expect(acct.setPendingCloseOrderId('does-not-exist', 1)).toBe(false);
  });
});

// TRA-352 follow-up — the pending-close reconciler iterates these helpers to
// drive the local row's pending state to match Tradier's terminal state.
describe('PaperOptionsAccount.clearPendingCloseOrderId / listPendingCloses', () => {
  it('lists open rows carrying a pendingCloseOrderId and excludes the rest', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const a = acct.openOptionFromCandidate(buildSignal({ symbol: 'AAPL' }));
    // Distinct OCC so the dedup-by-optionSymbol guard in openOptionFromCandidate
    // doesn't refuse the second open.
    const b = acct.openOptionFromCandidate(
      buildSignal({ symbol: 'MSFT', optionSymbol: 'MSFT240705C00400000' }),
    );
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    acct.setPendingCloseOrderId(a!.id, 1234);
    // b stays open without a pending tag and shouldn't show up.

    const pending = acct.listPendingCloses();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.optionId).toBe(a!.id);
    expect(pending[0]?.pendingCloseOrderId).toBe(1234);
    expect(pending[0]?.importedFromTradier).toBe(false);
  });

  it('marks imported rows so the reconciler routes the fill through recordImportedFill', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition()]);
    const id = acct.getState().openOptions[0].id;
    acct.setPendingCloseOrderId(id, 9999);

    const pending = acct.listPendingCloses();
    expect(pending).toHaveLength(1);
    expect(pending[0]?.importedFromTradier).toBe(true);
  });

  it('clearPendingCloseOrderId removes the tag and reports true only on mutation', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    const opened = acct.openOptionFromCandidate(buildSignal());
    expect(opened).not.toBeNull();
    acct.setPendingCloseOrderId(opened!.id, 7);
    expect(acct.clearPendingCloseOrderId(opened!.id)).toBe(true);
    // The second clear is a no-op (already cleared).
    expect(acct.clearPendingCloseOrderId(opened!.id)).toBe(false);
    const after = acct.getState().openOptions.find(o => o.id === opened!.id);
    expect(after?.pendingCloseOrderId).toBeUndefined();
  });

  it('returns false when the option id is unknown so the caller can no-op', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tradierEnv: 'sandbox',
    });
    expect(acct.clearPendingCloseOrderId('nope')).toBe(false);
  });
});

describe('PaperOptionsAccount.addReconciledTradierPnl', () => {
  it('bumps the live-mode realized P&L bucket without touching demo', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    expect(acct.getState().optionsPnl).toBe(0);
    acct.addReconciledTradierPnl(123.45);
    // Live-mode bucket-wide total is the sum of live + demo.
    expect(acct.getState().optionsPnl).toBeCloseTo(123.45, 5);
    expect(acct.getStateForMode('demo').optionsPnl).toBe(0);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(123.45, 5);
  });

  it('is idempotent for non-finite or zero amounts', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.addReconciledTradierPnl(0);
    acct.addReconciledTradierPnl(Number.NaN);
    expect(acct.getState().optionsPnl).toBe(0);
  });
});

// ─── TRA-354 — wait-and-hold exit policy ────────────────────────────────────
// Engine-fired exits (TP1 partial, SL, trailing) under live mirroring must
// stage a pendingExit instead of mutating the paper book, leave the position
// open until Tradier confirms, and surface a notice when the broker rejects
// or cancels the sell_to_close.
describe('PaperOptionsAccount — TRA-354 wait-and-hold exits', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('SL trigger under waitAndHold stages a pendingExit without mutating cash or P&L', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    const cashBefore = acct.getState().optionsCash;

    // Mark drops past the RV SL (RV uses different params; 0.30 will be below
    // any RV stopLossPremium for a $1 entry). Drives a full SL exit intent.
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const staged = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });

    expect(staged).toHaveLength(1);
    expect(staged[0].pendingExit).toBeDefined();
    expect(staged[0].pendingExit?.kind).toBe('sl');
    expect(staged[0].pendingExit?.qty).toBe(pos!.contracts);
    // Paper book untouched — position still open, cash unchanged, no P&L
    // realised yet. The Tradier fill is what flips this.
    expect(acct.getState().openOptions).toHaveLength(1);
    expect(acct.getState().optionsCash).toBe(cashBefore);
    expect(acct.getState().optionsPnl).toBe(0);
    expect(acct.getState().closedOptions).toHaveLength(0);
  });

  it('subsequent checkExits ticks do not re-fire while pendingExit is set', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const first = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
    expect(first).toHaveLength(1);

    // Same mark, same trigger — second tick must NOT stage another exit; the
    // engine is still waiting for the broker to fill or reject the first.
    const second = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
    expect(second).toHaveLength(0);
  });

  it('finalizePendingExit on SL fill books P&L, closes the position, and clears pendingExit', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const cashBefore = acct.getState().optionsCash;

    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const staged = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
    const intent = staged[0].pendingExit!;

    // Tradier reports the fill at the staged limit price.
    const finalised = acct.finalizePendingExit(pos!.id, intent.limitPrice);
    expect(finalised).not.toBeNull();
    // Position retired into closedOptions; openOptions empty.
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(acct.getState().closedOptions).toHaveLength(1);
    // P&L = (limit − entry) * qty * 100. Loss for an SL fill.
    const expectedPnl = (intent.limitPrice - pos!.premiumPaid) * intent.qty * 100;
    expect(acct.getState().optionsPnl).toBeCloseTo(expectedPnl, 5);
    // Cash credited by the proceeds (limit * qty * 100).
    expect(acct.getState().optionsCash).toBeCloseTo(
      cashBefore + intent.limitPrice * intent.qty * 100,
      5,
    );
    // Closed snapshot has pendingExit cleared.
    expect(acct.getState().closedOptions[0].pendingExit).toBeUndefined();
  });

  it('TP1 trigger stages a partial pendingExit; finalize sells qty and leaves the remainder open with trailing engaged', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    expect(pos!.contracts).toBeGreaterThan(1);
    // Mark crosses the RV TP1 trigger (RV tp1Pct = 0.50 for premium=1.0 → 1.50).
    const marks = new Map<string, number>([[pos!.optionSymbol!, 1.60]]);

    const staged = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(staged[0].pendingExit?.kind).toBe('tp1');
    expect(staged[0].pendingExit!.qty).toBeLessThan(pos!.contracts);

    const intent = staged[0].pendingExit!;
    const finalised = acct.finalizePendingExit(pos!.id, intent.limitPrice);
    expect(finalised).not.toBeNull();
    // Position is still open with the remainder; pendingExit cleared.
    const remaining = acct.getState().openOptions[0];
    expect(remaining.id).toBe(pos!.id);
    expect(remaining.contractsRemaining).toBe(pos!.contracts - intent.qty);
    expect(remaining.tp1Hit).toBe(true);
    expect(remaining.trailingActive).toBe(true);
    expect(remaining.pendingExit).toBeUndefined();
    // P&L = (limit − entry) * qty * 100 — positive for a TP1 partial fill.
    const expectedPartialPnl = (intent.limitPrice - pos!.premiumPaid) * intent.qty * 100;
    expect(acct.getState().optionsPnl).toBeCloseTo(expectedPartialPnl, 5);
  });

  it('clearPendingExit leaves the position open and stamps exitErrorReason on the open row', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const cashBefore = acct.getState().optionsCash;

    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });

    expect(acct.clearPendingExit(pos!.id, 'Tradier sell_to_close canceled: insufficient buying power')).toBe(true);
    const open = acct.getState().openOptions[0];
    expect(open.id).toBe(pos!.id);
    expect(open.pendingExit).toBeUndefined();
    expect(open.exitErrorReason).toContain('canceled');
    expect(open.exitErrorReason).toContain('insufficient buying power');
    // Paper book untouched: cash, contracts, no closed-options entry.
    expect(acct.getState().optionsCash).toBe(cashBefore);
    expect(acct.getState().closedOptions).toHaveLength(0);
    expect(open.contractsRemaining).toBe(pos!.contracts);
  });

  it('TRA-450 — auto-close circuit breaker stops re-staging after MAX consecutive rejections', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);

    // Three ticks: each stages an exit; the broker rejects each one.
    for (let i = 0; i < 3; i += 1) {
      const staged = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
      expect(staged).toHaveLength(1);
      acct.clearPendingExit(pos!.id, 'Tradier sell_to_close rejected');
    }

    // Fourth tick: the breaker has tripped — checkExits must NOT stage another
    // exit even though the SL trigger still holds. This is the fix for the
    // 1,476-rejected-orders storm in the Tradier export on TRA-450.
    const fourth = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
    expect(fourth).toHaveLength(0);

    const open = acct.getState().openOptions[0];
    expect(open.id).toBe(pos!.id);
    expect(open.pendingExit).toBeUndefined();
    expect(open.closeRejectCount).toBe(3);
    // The surfaced reason explains the engine has stopped retrying.
    expect(open.exitErrorReason).toContain('auto-close paused');
    // Position is still open and the paper book is untouched.
    expect(open.contractsRemaining).toBe(pos!.contracts);
    expect(acct.getState().closedOptions).toHaveLength(0);
  });

  it('TRA-450 — a fill resets the rejection counter so a later exit gets a clean slate', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    // TP1 partial fill, then later an SL exit on the remainder.
    const tp1Marks = new Map<string, number>([[pos!.optionSymbol!, 1.60]]);
    const staged = acct.checkExits(new Map(), tp1Marks, 'live', { waitAndHold: true });
    // One rejection bumps the counter before the fill lands.
    acct.clearPendingExit(pos!.id, 'Tradier sell_to_close rejected');
    expect(acct.getState().openOptions[0].closeRejectCount).toBe(1);
    // Re-stage and fill the TP1 partial — finalize must clear the counter.
    acct.checkExits(new Map(), tp1Marks, 'live', { waitAndHold: true });
    acct.finalizePendingExit(pos!.id, staged[0].pendingExit!.limitPrice);
    expect(acct.getState().openOptions[0].closeRejectCount).toBeUndefined();
  });

  it('TRA-450 — a user re-stage (stageManualPendingExit) clears a tripped breaker', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    for (let i = 0; i < 3; i += 1) {
      acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
      acct.clearPendingExit(pos!.id, 'Tradier sell_to_close rejected');
    }
    expect(acct.getState().openOptions[0].closeRejectCount).toBe(3);
    // The user explicitly closes — the breaker resets so the attempt proceeds.
    const restaged = acct.stageManualPendingExit(pos!.id, 1, 0.30);
    expect(restaged).not.toBeNull();
    expect(acct.getState().openOptions[0].closeRejectCount).toBeUndefined();
  });

  it('TRA-450 — a user cancel does not count toward the breaker', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    for (let i = 0; i < 5; i += 1) {
      const staged = acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });
      expect(staged).toHaveLength(1);
      acct.clearPendingExit(pos!.id, 'User cancelled the close order.', { countRejection: false });
    }
    // Five user cancels never trip the breaker — the engine keeps staging.
    expect(acct.getState().openOptions[0].closeRejectCount).toBeUndefined();
    expect(acct.checkExits(new Map(), marks, 'live', { waitAndHold: true })).toHaveLength(1);
  });

  it('attachPendingExit stamps the Tradier order id; listPendingExits surfaces all in-flight rows', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    acct.checkExits(new Map(), marks, 'live', { waitAndHold: true });

    expect(acct.listPendingExits()).toHaveLength(1);
    expect(acct.listPendingExits()[0].pendingExit?.tradierOrderId).toBe('');
    expect(acct.attachPendingExit(pos!.id, 4242)).toBe(true);
    expect(acct.listPendingExits()[0].pendingExit?.tradierOrderId).toBe(4242);
  });

  it('without waitAndHold, the legacy demo path mutates the paper book immediately (regression check)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.30]]);
    const closed = acct.checkExits(new Map(), marks, 'demo');
    expect(closed).toHaveLength(1);
    // Demo path mutates immediately — no pendingExit ever surfaces.
    expect(closed[0].pendingExit).toBeUndefined();
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(acct.getState().closedOptions).toHaveLength(1);
    expect(acct.getState().optionsPnl).toBeLessThan(0);
  });
});

// ─── TRA-358 — user-initiated manual close (engine-opened LIVE) ─────────────
// The TradeAI Close drawer stages a `pendingExit` of kind 'manual' carrying
// the user's chosen limit price + qty + duration. The existing TRA-354 poller
// then finalises (on fill) or clears (on reject/cancel) the pending exit.
describe('PaperOptionsAccount — TRA-358 stageManualPendingExit', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('stages a pendingExit with kind="manual" and the chosen duration on a live engine-opened row', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    const cashBefore = acct.getState().optionsCash;

    const staged = acct.stageManualPendingExit(pos!.id, pos!.contractsRemaining, 1.42, 'gtc');
    expect(staged).not.toBeNull();
    expect(staged!.pendingExit?.kind).toBe('manual');
    expect(staged!.pendingExit?.duration).toBe('gtc');
    expect(staged!.pendingExit?.qty).toBe(pos!.contractsRemaining);
    expect(staged!.pendingExit?.limitPrice).toBeCloseTo(1.42, 5);
    // Paper book untouched until Tradier confirms the fill.
    expect(acct.getState().optionsCash).toBe(cashBefore);
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('refuses to stage when a pendingExit is already in flight (engine or manual)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const first = acct.stageManualPendingExit(pos!.id, 1, 1.10, 'day');
    expect(first).not.toBeNull();
    const second = acct.stageManualPendingExit(pos!.id, 1, 1.20, 'day');
    expect(second).toBeNull();
  });

  it('refuses to stage on imported rows, missing rows, and out-of-range qty / limit', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');

    expect(acct.stageManualPendingExit('nope', 1, 1.0, 'day')).toBeNull();
    expect(acct.stageManualPendingExit(pos!.id, 0, 1.0, 'day')).toBeNull();
    expect(acct.stageManualPendingExit(pos!.id, pos!.contractsRemaining + 1, 1.0, 'day')).toBeNull();
    expect(acct.stageManualPendingExit(pos!.id, 1, 0, 'day')).toBeNull();
    expect(acct.stageManualPendingExit(pos!.id, 1, Number.NaN, 'day')).toBeNull();
  });

  it('finalize on a partial manual close leaves the remainder open WITHOUT engaging trailing or tp1Hit', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    expect(pos!.contracts).toBeGreaterThan(1);
    const initialContracts = pos!.contracts;
    const partialQty = 1;
    const limit = 1.25;

    const staged = acct.stageManualPendingExit(pos!.id, partialQty, limit, 'day');
    expect(staged).not.toBeNull();

    const finalised = acct.finalizePendingExit(pos!.id, limit);
    expect(finalised).not.toBeNull();
    const remaining = acct.getState().openOptions[0];
    expect(remaining.id).toBe(pos!.id);
    expect(remaining.contractsRemaining).toBe(initialContracts - partialQty);
    // Manual partial does NOT engage the engine's TP1 trailing rule — the
    // user is just trimming exposure. The engine's TP/SL/trail keeps running
    // on the remainder unchanged.
    expect(remaining.tp1Hit).toBe(false);
    expect(remaining.trailingActive).toBe(false);
    expect(remaining.pendingExit).toBeUndefined();
  });

  it('finalize on a full manual close retires the position into closedOptions and credits cash at the fill', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live');
    const cashBefore = acct.getState().optionsCash;
    const initialContracts = pos!.contracts;
    const limit = 1.50;

    const staged = acct.stageManualPendingExit(pos!.id, initialContracts, limit, 'day');
    expect(staged).not.toBeNull();

    const finalised = acct.finalizePendingExit(pos!.id, limit);
    expect(finalised).not.toBeNull();
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(acct.getState().closedOptions).toHaveLength(1);
    expect(acct.getState().optionsCash).toBeCloseTo(cashBefore + limit * initialContracts * 100, 5);
    const expectedPnl = (limit - pos!.premiumPaid) * initialContracts * 100;
    expect(acct.getState().optionsPnl).toBeCloseTo(expectedPnl, 5);
  });
});

describe('PaperOptionsAccount — TRA-374 demo cost model', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
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
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('bumps premiumPaid up by demoSlippagePct on a demo RV open', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      demoSlippagePct: 0.05,
      demoFeePerContract: 0.35,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    expect(pos).not.toBeNull();
    // premiumPaid = 1.00 * 1.05 = 1.05
    expect(pos!.premiumPaid).toBeCloseTo(1.05, 5);
    const state = acct.getState();
    // demoSlippageCost = (1.05 − 1.00) × contracts × 100
    expect(state.demoSlippageCost).toBeCloseTo(0.05 * pos!.contracts * 100, 5);
    // demoFeeCost = contracts × 0.35
    expect(state.demoFeeCost).toBeCloseTo(pos!.contracts * 0.35, 5);
  });

  it('does NOT bump premiumPaid in live mode (Tradier already pays the real spread)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      demoSlippagePct: 0.05,
      demoFeePerContract: 0.35,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();
    expect(pos!.premiumPaid).toBe(1.0); // raw mark, no haircut
    expect(acct.getState().demoSlippageCost).toBe(0);
    expect(acct.getState().demoFeeCost).toBe(0);
  });

  it('applies haircut + fee on the full SL exit in demo (checkExits without waitAndHold)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      demoSlippagePct: 0.05,
      demoFeePerContract: 0.35,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    expect(pos).not.toBeNull();
    // Trigger SL: drive mark below stopLossPremium. RV slPct is 25%, so the
    // stop distance = max(1.05·0.25, 0.10) = 0.2625 and stopLossPremium =
    // 1.05 − 0.2625 = 0.7875. Mark 0.70 sits below it and trips SL.
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.70]]);
    const closed = acct.checkExits(new Map(), marks);
    expect(closed).toHaveLength(1);
    const closedPos = closed[0]!;
    // Effective exit = stopLossPremium × (1 − slippage).
    const expectedEffectiveExit = pos!.stopLossPremium * (1 - 0.05);
    expect(closedPos.currentPremium).toBeCloseTo(expectedEffectiveExit, 4);
    // Fee debited on close = contracts × 0.35
    const expectedExitFee = pos!.contracts * 0.35;
    const state = acct.getState();
    // demoFeeCost is open fee + close fee.
    expect(state.demoFeeCost).toBeCloseTo(pos!.contracts * 0.35 + expectedExitFee, 5);
    // demoSlippageCost is open slippage + close slippage haircut.
    const openSlippage = 0.05 * pos!.contracts * 100;
    const closeSlippage = (pos!.stopLossPremium - expectedEffectiveExit) * pos!.contracts * 100;
    expect(state.demoSlippageCost).toBeCloseTo(openSlippage + closeSlippage, 4);
  });

  it('does NOT apply slippage/fee on a live position exit (positionMode === live)', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      demoSlippagePct: 0.05,
      demoFeePerContract: 0.35,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'live', 50_000);
    expect(pos).not.toBeNull();
    const marks = new Map<string, number>([[pos!.optionSymbol!, 0.70]]);
    const closed = acct.checkExits(new Map(), marks);
    expect(closed).toHaveLength(1);
    // Live position exits at stopLossPremium exactly — no haircut.
    expect(closed[0]!.currentPremium).toBeCloseTo(pos!.stopLossPremium, 5);
    // No demo-cost accumulation from a live exit.
    expect(acct.getState().demoSlippageCost).toBe(0);
    expect(acct.getState().demoFeeCost).toBe(0);
  });

  it('exposes 0 demoSlippageCost / demoFeeCost in getStateForMode("live")', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      demoSlippagePct: 0.05,
      demoFeePerContract: 0.35,
    });
    acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    // The cumulative cost on the demo bucket is non-zero…
    expect(acct.getStateForMode('demo').demoSlippageCost).toBeGreaterThan(0);
    // …but the live envelope must zero it out so the dashboard doesn't
    // imply Tradier paid the modelled cost on top of its real spread.
    expect(acct.getStateForMode('live').demoSlippageCost).toBe(0);
    expect(acct.getStateForMode('live').demoFeeCost).toBe(0);
  });

  it('drops contracts count when slippage pushes per-contract cost above the budget', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      demoSlippagePct: 0.05,
      demoFeePerContract: 0,
    });
    // RV budget = 50_000 * 0.5 * 0.02 = $500.
    // mark = $1.60 → no slippage: floor(500 / 160) = 3 contracts.
    // With 5% slippage: 1.68 → floor(500 / 168) = floor(2.976) = 2 contracts.
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.60 }), 'demo');
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(2);
  });

  it('defaults to 0/0 when no demo cost config is supplied (back-compat)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    expect(pos).not.toBeNull();
    expect(pos!.premiumPaid).toBe(1.0); // no haircut
    expect(acct.getState().demoSlippageCost).toBe(0);
    expect(acct.getState().demoFeeCost).toBe(0);
  });

  it('flips on via updateConfig so a settings save takes effect on the next open', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.updateConfig({ demoSlippagePct: 0.05, demoFeePerContract: 0.35 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo');
    expect(pos).not.toBeNull();
    expect(pos!.premiumPaid).toBeCloseTo(1.05, 5);
  });
});

// ─── TRA-384 — stale-mark stop-loss backstop ───────────────────────────────
// Bug report: "TradeAI is not closing trades using stop losses." Root cause —
// `checkExits` skipped every OTM / RV position on any tick it couldn't fetch a
// fresh option mark, and that skip had no upper bound. When the mark feed
// stalled (after-hours, RV-scanner circuit breaker, illiquid contract with no
// bid/ask, rate limit) the position sat open with its stop loss never once
// evaluated. The fix lets the skip absorb a few transient blips, then falls
// back to the underlying-delta extrapolation so the SL can still fire.
describe('PaperOptionsAccount — TRA-384 stale-mark SL backstop', () => {
  function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
    return {
      id: 'rv-1',
      symbol: 'AAPL',
      type: 'relative_value',
      side: 'buy',
      entryPrice: 1.0, // per-share OPTION mark — NOT the underlying spot
      stopLoss: 0.75,
      takeProfit: 1.5,
      riskRewardRatio: 2,
      timestamp: TRADING_TIME,
      optionSymbol: 'AAPL240705C00200000',
      optionType: 'call',
      strike: 200,
      expiration: '2024-07-05',
      mark: 1.0,
      fairPrice: 1.30,
      mispricingPct: -0.23,
      zScore: -2.1,
      ivFitted: 0.32,
      ivUsed: 0.28,
      delta: 0.18,
      reason: 'cheap-vs-curve',
      ...overrides,
    };
  }

  it('persists entryDelta and the real underlying spot (not the option mark) at open', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo', undefined, 190);
    expect(pos).not.toBeNull();
    expect(pos!.entryDelta).toBe(0.18);
    // Seeded from the spot arg — the legacy `signal.entryPrice` (1.0) would be
    // the option mark and would make the delta extrapolation nonsense.
    expect(pos!.underlyingEntryPrice).toBe(190);
  });

  it('skips the first STALE_MARK_BACKSTOP_TICKS-1 missed marks, then fires SL off the underlying', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo', undefined, 100);
    expect(pos).not.toBeNull();
    // RV SL = premiumPaid − max(premiumPaid·0.25, 0.10) = 1.0 − 0.25 = 0.75.
    // Drive the underlying down so the delta-extrapolated mark
    // = 1.0 + (98 − 100) × 0.18 = 0.64 ≤ 0.75.
    const underlying = new Map<string, number>([['AAPL', 98]]);
    const noMarks = new Map<string, number>();

    // Ticks 1 & 2 — no mark, still inside the grace window: position untouched.
    expect(acct.checkExits(underlying, noMarks)).toHaveLength(0);
    expect(acct.getState().openOptions[0].staleMarkTicks).toBe(1);
    expect(acct.checkExits(underlying, noMarks)).toHaveLength(0);
    expect(acct.getState().openOptions[0].staleMarkTicks).toBe(2);

    // Tick 3 — third consecutive miss: backstop engages and the SL fires.
    const closed = acct.checkExits(underlying, noMarks);
    expect(closed).toHaveLength(1);
    expect(closed[0].closedAt).toBeDefined();
    expect(closed[0].currentPremium).toBeCloseTo(pos!.stopLossPremium, 5);
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('does NOT fire the backstop when the underlying has not breached the stop', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo', undefined, 100);
    // Underlying flat — extrapolated mark stays at premiumPaid, well above SL.
    const underlying = new Map<string, number>([['AAPL', 100]]);
    const noMarks = new Map<string, number>();
    for (let i = 0; i < 5; i += 1) acct.checkExits(underlying, noMarks);
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('resets the stale counter the moment a fresh mark lands', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), 'demo', undefined, 100);
    const underlying = new Map<string, number>([['AAPL', 98]]);
    const noMarks = new Map<string, number>();

    acct.checkExits(underlying, noMarks);
    acct.checkExits(underlying, noMarks);
    expect(acct.getState().openOptions[0].staleMarkTicks).toBe(2);

    // A real mark above the SL lands — counter clears, position stays open.
    const freshMark = new Map<string, number>([[pos!.optionSymbol!, 0.95]]);
    expect(acct.checkExits(underlying, freshMark)).toHaveLength(0);
    expect(acct.getState().openOptions[0].staleMarkTicks).toBe(0);

    // Two more misses only get back to 2 — the backstop does not engage early.
    acct.checkExits(underlying, noMarks);
    expect(acct.checkExits(underlying, noMarks)).toHaveLength(0);
    expect(acct.getState().openOptions).toHaveLength(1);
  });
});

// ─── TRA-416: partial-fill booking on a terminal sell_to_close ───────────────
//
// A `sell_to_close` can fill PART of its quantity and then go terminal
// (expire / cancel). `bookPartialClose` realises the filled slice, reduces
// the position to the remainder, and is idempotent against the per-tick
// reconcile sweep so a slice is never double-counted.
describe('PaperOptionsAccount.bookPartialClose (TRA-416)', () => {
  it('books the filled slice of an engine-opened position and leaves the remainder open', () => {
    // initialEquity 80k × 0.5 ratio × 0.025 budget ÷ ($1.00 × 100) = 10 contracts.
    const acct = new PaperOptionsAccount({ initialEquity: 80_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();
    expect(pos!.contracts).toBe(10);
    const cashBefore = acct.getState().optionsCash;

    // Order #501 filled 6 of 10 contracts at 1.50 then expired.
    const booked = acct.bookPartialClose(pos!.id, 501, 6, 1.50);

    expect(booked).not.toBeNull();
    // 6 closed → 4 remain, position stays open.
    expect(booked!.contractsRemaining).toBe(4);
    expect(acct.getState().openOptions).toHaveLength(1);
    expect(acct.getState().closedOptions).toHaveLength(0);
    // Realised slice P&L = (1.50 − 1.00) × 6 × 100 = $300.
    expect(booked!.pnl).toBeCloseTo(300, 5);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(300, 5);
    // Engine-opened rows credit the paper cash bucket at the broker fill.
    expect(acct.getState().optionsCash - cashBefore).toBeCloseTo(1.50 * 6 * 100, 5);
    // The terminal order id is stamped for the idempotency guard.
    expect(booked!.partialCloseBookedOrderId).toBe(501);
    expect(booked!.pendingCloseOrderId).toBeUndefined();
  });

  it('is idempotent — re-booking the same terminal order id does not double-count', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 80_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    const first = acct.bookPartialClose(pos!.id, 501, 6, 1.50);
    expect(first).not.toBeNull();
    const pnlAfterFirst = acct.getStateForMode('live').optionsPnl;
    const cashAfterFirst = acct.getState().optionsCash;
    const remainingAfterFirst = acct.getState().openOptions[0].contractsRemaining;

    // The per-tick sweep sees the same terminal order #501 again.
    const second = acct.bookPartialClose(pos!.id, 501, 6, 1.50);

    expect(second).toBeNull();
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(pnlAfterFirst, 5);
    expect(acct.getState().optionsCash).toBeCloseTo(cashAfterFirst, 5);
    expect(acct.getState().openOptions[0].contractsRemaining).toBe(remainingAfterFirst);
  });

  it('retires the position when a later partial drains the remainder, accumulating P&L', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 80_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    // Slice 1: 6 @ 1.50 → +$300, 4 remain.
    acct.bookPartialClose(pos!.id, 501, 6, 1.50);
    // Slice 2: a fresh order #502 fills the remaining 4 @ 1.20 → +$80, drains.
    const drained = acct.bookPartialClose(pos!.id, 502, 4, 1.20);

    expect(drained).not.toBeNull();
    expect(drained!.contractsRemaining).toBe(0);
    // Position retired into closed-options with the ACCUMULATED P&L.
    expect(acct.getState().openOptions).toHaveLength(0);
    const closed = acct.getState().closedOptions;
    expect(closed).toHaveLength(1);
    // 300 + (1.20 − 1.00) × 4 × 100 = 300 + 80 = 380.
    expect(closed[0].pnl).toBeCloseTo(380, 5);
  });

  it('clamps the slice to the contracts the position actually holds', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 80_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    // Broker reports 14 filled but the position only holds 10 — treat as a
    // full close, never book phantom contracts.
    const booked = acct.bookPartialClose(pos!.id, 501, 14, 1.50);

    expect(booked).not.toBeNull();
    expect(booked!.contractsRemaining).toBe(0);
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(acct.getState().closedOptions[0].pnl).toBeCloseTo(0.50 * 10 * 100, 5);
  });

  it('books an imported partial fill without touching the paper cash bucket', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition({ contracts: 10, premiumPaid: 1.0 })]);
    const imported = acct.getState().openOptions[0];
    expect(imported.importedFromTradier).toBe(true);
    const cashBefore = acct.getState().optionsCash;

    const booked = acct.bookPartialClose(imported.id, 777, 6, 1.50);

    expect(booked).not.toBeNull();
    expect(booked!.contractsRemaining).toBe(4);
    // Imported proceeds live on Tradier — paper cash is untouched.
    expect(acct.getState().optionsCash).toBe(cashBefore);
    // Realised slice P&L still surfaces on the live options pill.
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(0.50 * 6 * 100, 5);
  });

  it('rejects non-bookable inputs (unknown id, non-positive qty / price)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 80_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    expect(pos).not.toBeNull();

    expect(acct.bookPartialClose('no-such-id', 1, 6, 1.5)).toBeNull();
    expect(acct.bookPartialClose(pos!.id, 1, 0, 1.5)).toBeNull();
    expect(acct.bookPartialClose(pos!.id, 1, 6, 0)).toBeNull();
    // The position was not mutated by any of the rejected calls.
    expect(acct.getState().openOptions[0].contractsRemaining).toBe(10);
  });
});
