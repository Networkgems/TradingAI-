import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PaperAccount } from './paper-account.js';
import { PaperOptionsAccount } from './options-account.js';
import { bindOptionsPnlToEquityBook } from './options-equity-bridge.js';
import type { RelativeValueSignal, TradeSignal } from '@trading-app/shared';

/**
 * TRA-2323 — realized option P&L must reach `PaperAccount.totalEquity`.
 *
 * Parent TRA-2297: "we're using the same 2k everyday". The demo book kept two
 * disjoint ledgers seeded from the same $2,000 and nothing moved money between
 * them, so a profitable option round trip left "Total Value" untouched and the
 * engine — which sizes off `totalEquity` — never got a bigger book to trade.
 *
 * Every case below drives a REAL option round trip (open → `checkExits`), not a
 * hand-poked P&L accrual. The distinction is the point of the ticket: a test
 * that wires its own sink proves the two accounts *can* be connected, not that
 * the production exit paths *do* connect them.
 */

const INITIAL = 2_000;
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A book wired exactly the way `SignalEngine` wires it — via the real bridge. */
function makeBook() {
  const equityBook = new PaperAccount({ initialEquity: INITIAL });
  const options = new PaperOptionsAccount({ initialEquity: INITIAL, managedAccountRatio: 0.5 });
  bindOptionsPnlToEquityBook(options, equityBook);
  return { equityBook, options };
}

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
  } as RelativeValueSignal;
}

/**
 * Open a demo RV option and fully close it at `exitMark`.
 *
 * Uses the manual `closeOption` path rather than driving `checkExits` to a
 * take-profit: a winning mark trips TP1, which exits only 50% of the contracts
 * and trails the rest, so the position is not yet fully closed. This helper
 * needs a completed round trip on both sides of zero.
 */
function roundTrip(options: PaperOptionsAccount, exitMark: number, mode: 'demo' | 'live' = 'demo') {
  const pos = options.openOptionFromRvCandidate(buildRvSignal({ mark: 1.0 }), mode);
  expect(pos).not.toBeNull();
  expect(pos!.mode).toBe(mode);
  const closed = options.closeOption(pos!.id, exitMark);
  expect(closed).not.toBeNull();
  expect(closed!.contractsRemaining).toBe(0);
  return closed!;
}

describe('TRA-2323 — option P&L reaches the equity book', () => {
  it('a profitable closed option round trip lifts totalEquity, with no stock activity', () => {
    const { equityBook, options } = makeBook();
    expect(equityBook.getState().totalEquity).toBe(INITIAL);

    // Mark runs to the RV take-profit — a winning demo close.
    const closed = roundTrip(options, 1.6);
    expect(closed.pnl).toBeGreaterThan(0);

    // THE assertion the ticket opens with. Pre-fix this read exactly 2000.00:
    // the P&L landed in `optionsPnl` and equity never moved.
    expect(equityBook.getState().totalEquity).toBeGreaterThan(INITIAL);
    // ...and it moved by exactly the realized P&L, not some display proxy.
    expect(equityBook.getState().totalEquity).toBeCloseTo(INITIAL + closed.pnl!, 6);
    expect(equityBook.getOptionsCredited()).toBeCloseTo(closed.pnl!, 6);
  });

  it('a losing round trip debits equity — the credit is signed, not absolute', () => {
    const { equityBook, options } = makeBook();
    const closed = roundTrip(options, 0.30); // crashes through the RV stop
    expect(closed.pnl).toBeLessThan(0);
    expect(equityBook.getState().totalEquity).toBeLessThan(INITIAL);
    expect(equityBook.getState().totalEquity).toBeCloseTo(INITIAL + closed.pnl!, 6);
  });

  it('cash and equity move together — the TRA-2301 invariant survives (AC2)', () => {
    const { equityBook, options } = makeBook();
    roundTrip(options, 1.6);
    const st = equityBook.getState();
    // Flat stock book ⇒ committedCapital 0 ⇒ expectedCash == equity. A credit
    // that moved only equity would open a gap here and hand the TRA-2301 repair
    // a phantom to "fix" on every restore.
    expect(st.availableCash).toBeCloseTo(st.totalEquity, 6);
    expect(st.openPositions).toHaveLength(0);
  });

  it('does NOT touch dailyPnl — that leg stays stock-only (AC4 tripwire)', () => {
    const { equityBook, options } = makeBook();
    roundTrip(options, 1.6);
    // `pnl-reconciliation` grades `combinedPnl == stock dailyPnl + options
    // daily`. Options P&L reaching dailyPnl would sit on BOTH sides of that
    // identity and turn every option-trading day into a fresh offender.
    expect(equityBook.getState().dailyPnl).toBe(0);
  });

  it('ignores LIVE-mode option P&L — that book is broker truth, not paper equity', () => {
    const { equityBook, options } = makeBook();
    const closed = roundTrip(options, 1.6, 'live');
    expect(closed.pnl).toBeGreaterThan(0);
    expect(equityBook.getState().totalEquity).toBe(INITIAL);
    expect(equityBook.getOptionsCredited()).toBe(0);
  });

  it('positive control — a long stock round trip moves equity (the assertion CAN pass)', () => {
    const { equityBook } = makeBook();
    const signal = {
      id: 'sig-1',
      symbol: 'TEST',
      side: 'buy',
      type: 'breakout',
      entryPrice: 10,
      stopLoss: 9,
      takeProfit: 12,
    } as unknown as TradeSignal;
    const pos = equityBook.openPosition(signal, 10);
    expect(pos).not.toBeNull();
    equityBook.closePosition(pos!.id, 11);
    expect(equityBook.getState().totalEquity).toBeGreaterThan(INITIAL);
    // ...and a STOCK close DOES belong in dailyPnl, unlike the options credit.
    expect(equityBook.getState().dailyPnl).toBeGreaterThan(0);
  });

  it('credited total survives a snapshot round trip (telescopes across restarts)', () => {
    const { equityBook, options } = makeBook();
    const closed = roundTrip(options, 1.6);
    const snap = equityBook.exportSnapshot();
    expect(snap.optionsCredited).toBeCloseTo(closed.pnl!, 6);

    const restored = new PaperAccount({ initialEquity: INITIAL });
    restored.importSnapshot(snap);
    expect(restored.getState().totalEquity).toBeCloseTo(INITIAL + closed.pnl!, 6);
    expect(restored.getOptionsCredited()).toBeCloseTo(closed.pnl!, 6);
    // The restore must NOT read as a TRA-2301 cash-drift repair.
    expect(restored.getCashRepair()).toBeNull();
  });

  it('a legacy snapshot with no optionsCredited restores to 0, not undefined', () => {
    const restored = new PaperAccount({ initialEquity: INITIAL });
    restored.importSnapshot({
      cash: INITIAL, equity: INITIAL, initialEquity: INITIAL, dailyPnl: 0, openPositions: [],
    });
    expect(restored.getOptionsCredited()).toBe(0);
  });
});

describe('TRA-2323 — the options bucket sizes off the ONE equity book (AC3)', () => {
  it('sizing basis follows the equity book, not the bucket private copy', () => {
    const { equityBook, options } = makeBook();
    // Both start at the same $2,000 — the double seed. Day one is unchanged.
    expect(options.getEquity()).toBeCloseTo(INITIAL, 6);

    // A STOCK gain the options bucket knows nothing about.
    const signal = {
      id: 'sig-1', symbol: 'TEST', side: 'buy', type: 'breakout',
      entryPrice: 10, stopLoss: 9, takeProfit: 12,
    } as unknown as TradeSignal;
    const pos = equityBook.openPosition(signal, 10);
    equityBook.closePosition(pos!.id, 11);
    const grown = equityBook.getState().totalEquity;
    expect(grown).toBeGreaterThan(INITIAL);

    // The options sizer must see the BIGGER book. Pre-AC3 this returned the
    // bucket's own stale $2,000 and option tickets never grew.
    expect(options.getEquity()).toBeCloseTo(grown, 6);
    expect(options.managedEquity()).toBeCloseTo(grown * 0.5, 6);
  });

  it('an UNBOUND account still sizes off its own equity (unit-test surface intact)', () => {
    const solo = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(solo.getEquity()).toBeCloseTo(50_000, 6);
    expect(solo.managedEquity()).toBeCloseTo(25_000, 6);
  });
});

describe('TRA-2323 — the choke point is the ONLY realized-P&L mutation site', () => {
  /**
   * TRA-2210's lesson as an executable invariant rather than a review promise.
   * Eleven exit paths accrue realized options P&L; routing them by hand leaves
   * the missed ones silently unrouted, and a partially-routed book reads exactly
   * like a correct one from any single close. A twelfth exit path added with a
   * bare `optionsPnlByMode[...] +=` fails here.
   */
  it('no bare optionsPnlByMode[...] += survives outside bookRealizedPnl', () => {
    const src = readFileSync(join(__dirname, 'options-account.ts'), 'utf-8');
    const bare = src
      .split('\n')
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => /this\.optionsPnlByMode\[[^\]]+\]\s*\+=/.test(line))
      // The choke point itself is the one legitimate mutation.
      .filter(({ line }) => line !== 'this.optionsPnlByMode[mode] += delta;');
    expect(bare.map(b => `L${b.n}: ${b.line}`)).toEqual([]);
  });
});
