// TRA-2940 — exit attribution on closed option rows was structurally
// unreadable: no exit-reason field of any spelling existed on the published
// closed-position row, so a verdict like TRA-2934's "a closed put carries
// exitJournalReason: 'chandelier'" could not have been satisfied in any world,
// and the live QQQ put closed 2026-08-05 13:44Z could not be attributed to any
// recorded predicate after the fact.
//
// These tests pin the fix: every close path stamps `exitReason` on the row in
// the same breath as `closedAt`, with the SAME value it hands the option trade
// journal — including across the live wait-and-hold broker round-trip, where
// the TRUE rule (chandelier / profit_lock / take_profit_early / structural)
// previously collapsed into the broker-facing `kind` (`sl` / `trail`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// Inside an ET trading window: 10:00 AM ET = 14:00 UTC during EDT (UTC-4).
// Pin to a Tuesday so the weekday/window predicate passes.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-2940',
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

function buildTradierPosition(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
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

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-2940 — durable exit attribution on closed option rows', () => {
  // Entry: premiumPaid 1.0, SL 0.80, TP1 1.50, 6 contracts (same fixture the
  // TRA-1268 chandelier suite uses).
  function openCall(): { acct: PaperOptionsAccount; sym: string; id: string } {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo', undefined, 200);
    expect(pos).not.toBeNull();
    return { acct, sym: pos!.optionSymbol!, id: pos!.id };
  }

  it('stamps `sl` when the hard premium stop closes a demo position', () => {
    const { acct, sym } = openCall();
    const closed = acct.checkExits(new Map(), new Map([[sym, 0.70]]), 'demo');
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl');
    expect(acct.getState().closedOptions[0].exitReason).toBe('sl');
  });

  it('stamps `chandelier` when the underlying trail closes a demo position', () => {
    const { acct, sym } = openCall();
    const risk = { underlyingAtrBySymbol: new Map([['AAPL', 4]]) };
    const marks = new Map([[sym, 1.0]]);
    // Rally to 210 arms the trail at 198; pullback to 197 breaks it. The mark
    // stays at 1.0, well above the 0.80 premium stop, so the reason can only
    // be the chandelier.
    expect(acct.checkExits(new Map([['AAPL', 210]]), marks, 'demo', {}, undefined, risk)).toHaveLength(0);
    const closed = acct.checkExits(new Map([['AAPL', 197]]), marks, 'demo', {}, undefined, risk);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('chandelier');
    expect(acct.getState().closedOptions[0].exitReason).toBe('chandelier');
  });

  // The TRA-2934 criterion: on the LIVE path the exit is staged as a broker
  // order (`kind` collapses to sl/trail for order pricing) and only finalises
  // when the fill lands — the TRUE rule must survive that round-trip.
  it('preserves `chandelier` across the wait-and-hold stage → fill round-trip', () => {
    const { acct, sym, id } = openCall();
    const risk = { underlyingAtrBySymbol: new Map([['AAPL', 4]]) };
    const marks = new Map([[sym, 1.0]]);
    expect(acct.checkExits(new Map([['AAPL', 210]]), marks, 'demo', {}, undefined, risk)).toHaveLength(0);

    const staged = acct.checkExits(
      new Map([['AAPL', 197]]),
      marks,
      'demo',
      { waitAndHold: true },
      undefined,
      risk,
    );
    expect(staged).toHaveLength(1);
    // Broker-facing bucket stays trail; the true rule rides `journalReason`.
    expect(staged[0].pendingExit?.kind).toBe('trail');
    expect(staged[0].pendingExit?.journalReason).toBe('chandelier');

    expect(acct.attachPendingExit(id, 4242)).toBe(true);
    const closed = acct.finalizePendingExit(id, 1.0);
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('chandelier');
    expect(acct.getState().closedOptions[0].exitReason).toBe('chandelier');
  });

  it('falls back to the staged `kind` for legacy pendingExit records without journalReason', () => {
    const { acct, sym, id } = openCall();
    const staged = acct.checkExits(new Map(), new Map([[sym, 0.70]]), 'demo', { waitAndHold: true });
    expect(staged).toHaveLength(1);
    // Simulate a pendingExit persisted before the field shipped.
    const open = acct.getState().openOptions[0];
    delete open.pendingExit!.journalReason;
    acct.attachPendingExit(id, 4243);
    const closed = acct.finalizePendingExit(id, 0.80);
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('sl');
  });

  it('stamps `manual` on a user-initiated close', () => {
    const { acct, id } = openCall();
    const closed = acct.closeOption(id);
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('manual');
    expect(acct.getState().closedOptions[0].exitReason).toBe('manual');
  });

  it('stamps `broker_reconcile` when a live engine-opened row is closed broker-flat', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live');
    const row = acct.getStateForMode('live').openOptions[0];
    const closed = acct.closeBrokerFlatPosition(row.id, 'broker is flat');
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('broker_reconcile');
    expect(acct.getStateForMode('live').closedOptions[0].exitReason).toBe('broker_reconcile');
  });

  it('stamps `broker_reconcile` when an imported row leaves the broker book', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition()]);
    const id = acct.getState().openOptions[0].id;
    // Age the row past the working-open-order grace window, then report the
    // symbol absent twice (the sweep needs consecutive misses).
    vi.setSystemTime(TRADING_TIME + 60 * 60 * 1000);
    acct.reconcileTradierPositions([]);
    acct.reconcileTradierPositions([]);
    const closed = acct.getState().closedOptions.find(o => o.id === id);
    expect(closed).toBeDefined();
    expect(closed!.exitReason).toBe('broker_reconcile');
  });

  it('stamps `manual` (the default) when a user-initiated imported close fills', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildTradierPosition()]);
    const id = acct.getState().openOptions[0].id;
    const closed = acct.recordImportedFill(id, 1.85);
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('manual');
  });
});
