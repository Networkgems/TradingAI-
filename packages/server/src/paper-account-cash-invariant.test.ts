import { describe, it, expect } from 'vitest';
import type { Position, TradeSignal } from '@trading-app/shared';
import { PaperAccount } from './paper-account.js';

// ---------------------------------------------------------------------------
// TRA-2301 (TRA-2297a) — cash/equity invariant across a round trip, both sides.
//
// `openPosition()` used to debit cash by `price x qty` for BOTH sides. Opening
// a short should CREDIT cash. Since `pnl` is correctly sign-flipped for shorts
// (`multiplier = -1`), one short round trip moved cash by `(X-E)*Q` and equity
// by `(E-X)*Q` — opposite signs — permanently driving `availableCash` away from
// `totalEquity` by `2 x pnl`, with nothing to ever re-reconcile them. On bqb1
// this drifted 6 of 13 books in BOTH directions and throttled the 'Richard'
// book to ~15% of its own capital via the `cost > cash` gate, which logged
// "existing positions consuming cash" against an empty book.
//
// The LONG cases are the positive control: they passed before the fix and still
// pass, which proves these assertions can distinguish a pass from a fail.
//
// CryptoPaperAccount fixed the identical bug under TRA-330; PaperAccount never
// got the same treatment. The two books now agree.
// ---------------------------------------------------------------------------

function tradeSignal(
  side: 'buy' | 'sell',
  entry: number,
  stop: number,
  tp: number,
  overrides: Partial<TradeSignal> = {},
): TradeSignal {
  return {
    id: 'x',
    symbol: 'AAA',
    side,
    type: 'momentum',
    entryPrice: entry,
    stopLoss: stop,
    takeProfit: tp,
    timestamp: Date.now(),
    ...overrides,
  } as unknown as TradeSignal;
}

function heldPosition(overrides: Partial<Position>): Position {
  return {
    id: 'p1',
    symbol: 'AAA',
    side: 'buy',
    signalType: 'momentum',
    entryPrice: 50,
    quantity: 10,
    stopLoss: 45,
    takeProfit: 60,
    openedAt: 1,
    mode: 'demo',
    ...overrides,
  } as Position;
}

/** The book the issue's proof harness uses: $2k, fully managed, 50% risk. */
function book(initialEquity = 2000): PaperAccount {
  return new PaperAccount({ initialEquity, managedAccountRatio: 1, riskPerTrade: 0.5 });
}

describe('PaperAccount — cash/equity invariant with no open positions (TRA-2301)', () => {
  it('LONG round trip: cash === equity after close (positive control)', () => {
    const a = book();
    expect(a.openPosition(tradeSignal('buy', 100, 90, 110), 100)).not.toBeNull();
    a.checkExits(new Map([['AAA', 110]]));
    const s = a.getState();
    expect(s.openPositions).toHaveLength(0);
    expect(s.totalEquity).toBeCloseTo(2200, 6);
    expect(s.availableCash).toBeCloseTo(s.totalEquity, 6);
  });

  it('SHORT round trip: cash === equity after close', () => {
    const a = book();
    expect(a.openPosition(tradeSignal('sell', 100, 110, 90), 100)).not.toBeNull();
    a.checkExits(new Map([['AAA', 90]]));
    const s = a.getState();
    expect(s.openPositions).toHaveLength(0);
    // Pre-fix this read equity 2200 / cash 1800: a $200 profit with cash DOWN
    // $200 — a gap of exactly 2 x pnl.
    expect(s.totalEquity).toBeCloseTo(2200, 6);
    expect(s.availableCash).toBeCloseTo(s.totalEquity, 6);
  });

  it('LOSING short also telescopes (live drift ran both directions)', () => {
    const a = book();
    expect(a.openPosition(tradeSignal('sell', 100, 110, 90), 100)).not.toBeNull();
    a.checkExits(new Map([['AAA', 110]])); // stopped out
    const s = a.getState();
    expect(s.openPositions).toHaveLength(0);
    expect(s.totalEquity).toBeLessThan(2000);
    expect(s.availableCash).toBeCloseTo(s.totalEquity, 6);
  });

  it('closePosition (not just checkExits) settles a short to cash === equity', () => {
    const a = book();
    const pos = a.openPosition(tradeSignal('sell', 100, 110, 90), 100)!;
    a.closePosition(pos.id, 95);
    const s = a.getState();
    expect(s.openPositions).toHaveLength(0);
    expect(s.availableCash).toBeCloseTo(s.totalEquity, 6);
  });
});

describe('PaperAccount — short open credits cash (TRA-2301)', () => {
  it('credits cash by cost basis while the short is open; equity is unmoved', () => {
    const a = book();
    const pos = a.openPosition(tradeSignal('sell', 100, 110, 90), 100)!;
    const s = a.getState();
    expect(s.availableCash).toBeCloseTo(2000 + 100 * pos.quantity, 6);
    expect(s.totalEquity).toBeCloseTo(2000, 6); // equity is not marked to market
  });

  it('a long still DEBITS cash by cost basis (positive control)', () => {
    const a = book();
    const pos = a.openPosition(tradeSignal('buy', 100, 90, 110), 100)!;
    expect(a.getState().availableCash).toBeCloseTo(2000 - 100 * pos.quantity, 6);
  });

  it('a short DCA add credits cash, and the round trip still telescopes', () => {
    const a = book();
    const pos = a.openPosition(tradeSignal('sell', 100, 110, 90), 100)!;
    const cashAfterOpen = a.getState().availableCash;
    expect(a.addToPosition(pos.id, 3, 104)).not.toBeNull();
    expect(a.getState().availableCash).toBeCloseTo(cashAfterOpen + 3 * 104, 6);
    a.closePosition(pos.id, 90);
    const s = a.getState();
    expect(s.availableCash).toBeCloseTo(s.totalEquity, 6);
  });

  it('a short is not refused by the long-only spot-cash gate', () => {
    const a = book();
    // Consume the entire cash balance with a long first.
    expect(a.openPosition(tradeSignal('buy', 100, 90, 110), 100)).not.toBeNull();
    expect(a.getState().availableCash).toBeCloseTo(0, 6);
    // Pre-fix the short was refused here for "cost exceeds cash". Shorts
    // collateralise against equity (the managedEquity sizing cap is their
    // margin floor), so the spot-cash gate must not apply to them.
    const shorted = a.openPosition(
      tradeSignal('sell', 100, 110, 90, { id: 'x2', symbol: 'BBB' }),
      100,
    );
    expect(shorted).not.toBeNull();
  });

  it('the spot-cash gate still bites on a long once cash is committed', () => {
    // Positive control for the gate itself: without this, the test above could
    // be passing because the gate stopped working rather than because shorts
    // are correctly exempt from it.
    const a = book();
    expect(a.openPosition(tradeSignal('buy', 100, 90, 110), 100)).not.toBeNull();
    expect(a.getState().availableCash).toBeCloseTo(0, 6);
    const secondLong = a.openPosition(
      tradeSignal('buy', 100, 90, 110, { id: 'x3', symbol: 'CCC' }),
      100,
    );
    expect(secondLong).toBeNull();
  });

  it('short proceeds raise spendable cash for a subsequent long', () => {
    // A documented consequence of crediting short proceeds, and the correct
    // margin-account behaviour: a short sale funds buying power. The
    // managedEquity notional cap remains the per-position margin floor.
    const a = book();
    expect(a.openPosition(tradeSignal('buy', 100, 90, 110), 100)).not.toBeNull();
    expect(a.getState().availableCash).toBeCloseTo(0, 6);
    expect(a.openPosition(tradeSignal('sell', 100, 110, 90, { id: 'x2', symbol: 'BBB' }), 100)).not.toBeNull();
    expect(a.getState().availableCash).toBeCloseTo(2000, 6);
    expect(
      a.openPosition(tradeSignal('buy', 100, 90, 110, { id: 'x3', symbol: 'CCC' }), 100),
    ).not.toBeNull();
  });
});

describe('PaperAccount — one-shot repair of drifted persisted books (TRA-2301)', () => {
  it('repairs a flat book whose cash sits BELOW equity (winning-short signature)', () => {
    const a = new PaperAccount({ initialEquity: 2000 });
    // bqb1 'Richard' (demo-1): $2,233.91 equity, $325.91 cash, nothing open.
    a.importSnapshot({
      cash: 325.91, equity: 2233.91, initialEquity: 2000, dailyPnl: 0, openPositions: [],
    });
    expect(a.getState().availableCash).toBeCloseTo(2233.91, 6);
    expect(a.getCashRepair()).toMatchObject({ from: 325.91, to: 2233.91 });
    expect(a.getCashRepair()!.delta).toBeCloseTo(1908.0, 6);
  });

  it('repairs a flat book whose cash sits ABOVE equity (losing-short signature)', () => {
    const a = new PaperAccount({ initialEquity: 25000 });
    // bqb1 'test-1': cash $27.50 ABOVE equity with nothing open — no legitimate
    // holding can produce that.
    a.importSnapshot({
      cash: 25004.81, equity: 24977.31, initialEquity: 25000, dailyPnl: 0, openPositions: [],
    });
    expect(a.getState().availableCash).toBeCloseTo(24977.31, 6);
    expect(a.getCashRepair()!.delta).toBeCloseTo(-27.5, 6);
  });

  it('leaves a consistent book untouched and records no repair', () => {
    const a = new PaperAccount({ initialEquity: 2000 });
    a.importSnapshot({
      cash: 2000, equity: 2000, initialEquity: 2000, dailyPnl: 0, openPositions: [],
    });
    expect(a.getState().availableCash).toBe(2000);
    expect(a.getCashRepair()).toBeNull();
  });

  it('does not mistake a legitimately-held long for drift', () => {
    const a = new PaperAccount({ initialEquity: 2000 });
    a.importSnapshot({
      cash: 1500, equity: 2000, initialEquity: 2000, dailyPnl: 0,
      openPositions: [heldPosition({ side: 'buy', entryPrice: 50, quantity: 10 })],
    });
    expect(a.getState().availableCash).toBe(1500);
    expect(a.getCashRepair()).toBeNull();
  });

  it('migrates an in-flight short opened under the buggy code', () => {
    const a = new PaperAccount({ initialEquity: 2000 });
    // The buggy open debited 10 x $50 where the fixed model credits it, so the
    // correction is a 2 x E x Q swing.
    a.importSnapshot({
      cash: 1500, equity: 2000, initialEquity: 2000, dailyPnl: 0,
      openPositions: [heldPosition({
        id: 'p2', side: 'sell', entryPrice: 50, quantity: 10, stopLoss: 60, takeProfit: 40,
      })],
    });
    expect(a.getState().availableCash).toBeCloseTo(2500, 6);
    // …and the cover then settles the pair.
    a.closePosition('p2', 40);
    const s = a.getState();
    expect(s.openPositions).toHaveLength(0);
    expect(s.availableCash).toBeCloseTo(s.totalEquity, 6);
  });

  it('survives the snapshot round trip; re-import is a no-op and the trace persists', () => {
    const a = new PaperAccount({ initialEquity: 2000 });
    a.importSnapshot({
      cash: 325.91, equity: 2233.91, initialEquity: 2000, dailyPnl: 0, openPositions: [],
    });
    const snap = a.exportSnapshot();
    expect(snap.cash).toBeCloseTo(2233.91, 6);

    const b = new PaperAccount({ initialEquity: 2000 });
    b.importSnapshot(snap);
    expect(b.getState().availableCash).toBeCloseTo(2233.91, 6);
    // The trace has to persist: a repaired book and a book that never drifted
    // both report gap 0, so without this record they read IDENTICALLY and the
    // repair is unverifiable after the fact.
    expect(b.getCashRepair()).toMatchObject({ from: 325.91, to: 2233.91 });
  });

  it('ignores sub-cent float residue instead of emitting a repair every restart', () => {
    const a = new PaperAccount({ initialEquity: 2000 });
    a.importSnapshot({
      cash: 2000.004, equity: 2000, initialEquity: 2000, dailyPnl: 0, openPositions: [],
    });
    expect(a.getState().availableCash).toBe(2000.004);
    expect(a.getCashRepair()).toBeNull();
  });

  it('unthrottles the Richard book: the repaired cash lets a sized entry through', () => {
    const a = new PaperAccount({ initialEquity: 2000, managedAccountRatio: 1, riskPerTrade: 0.5 });
    a.importSnapshot({
      cash: 325.91, equity: 2233.91, initialEquity: 2000, dailyPnl: 0, openPositions: [],
    });
    // Sizing reads managedEquity ($2,233.91) → 22 shares @ $100 = $2,200 cost,
    // which the un-repaired $325.91 cash would have refused.
    const opened = a.openPosition(tradeSignal('buy', 100, 90, 110), 100);
    expect(opened).not.toBeNull();
    expect(opened!.quantity).toBe(22);
  });
});
