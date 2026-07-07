import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import { DEFAULT_MULTILEG_EXIT_PARAMS } from '@trading-app/engine';

// TRA-1418 (TRA-1417 build, parent TRA-1406 / TRA-1410 option a) — per-tick combo
// mark + defined-risk exit policy behind the DEMO-only ENABLE_OPTION_MULTILEG_EXIT
// flag. These exercise the options-account wiring: with the params present a demo
// combo resolves to a NON-$0 WIN/LOSS through the normal realized-P&L path; with
// them absent (flag off) the legacy blanket combo skip is byte-identical; live
// combos are never touched; and the OCC-miss → Black-Scholes backstop still marks.

// 10:00 AM ET Tuesday — inside the trading window, ~31 DTE to the 2024-07-05 expiry.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// Bull put credit spread: short the 95 put, long the 90 put ($5 wide).
const bullPutLegs = [
  { action: 'sell' as const, optionType: 'put' as const, strike: 95, expiration: '2024-07-05' },
  { action: 'buy' as const, optionType: 'put' as const, strike: 90, expiration: '2024-07-05' },
];
const spreadParams = (overrides: Record<string, unknown> = {}) => ({
  symbol: 'AAPL',
  strategy: 'bull_put_spread',
  legs: bullPutLegs,
  netUsd: 180, // + credit received per lot
  maxLossUsd: 320, // width(5)×100 − credit(180)
  maxProfitUsd: 180,
  breakevens: [93.2],
  spot: 100,
  ...overrides,
});

// OCC symbols the mark path reconstructs for the two legs.
const OCC_95P = 'AAPL240705P00095000';
const OCC_90P = 'AAPL240705P00090000';

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});
afterEach(() => {
  vi.useRealTimers();
});

describe('checkExits — TRA-1418 defined-risk combo exit (flag on, demo)', () => {
  it('credit spread hits the 50% capture target → WIN through the realized-P&L path', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openDefinedRiskSpread(spreadParams());
    expect(pos).not.toBeNull();
    expect(acct.getState().optionsCash).toBe(49_680); // $320 reserved

    // Legs decayed to 1.00 / 0.15 → markNet = 100×(0.15−1.00) = −85;
    // openPnl = −85 + 180 = +95 = 52.8% of the $180 max profit ≥ 0.50.
    const marks = new Map([[OCC_95P, 1.0], [OCC_90P, 0.15]]);
    const prices = new Map<string, number>();

    // First tick: min_hold_bars blocks a same-tick scratch (barsHeld 0).
    let closed = acct.checkExits(prices, marks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    expect(closed).toHaveLength(0);
    expect(acct.getState().openOptions).toHaveLength(1);

    // Second tick: barsHeld 1 → take-profit fires, WIN clamped to max profit.
    closed = acct.checkExits(prices, marks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeCloseTo(95, 5);
    expect(closed[0].contractsRemaining).toBe(0);
    expect(acct.getState().openOptions).toHaveLength(0);
    // Reserved $320 returned + $95 profit → 49,680 + 415 = 50,095.
    expect(acct.getState().optionsCash).toBeCloseTo(50_095, 5);
    expect(acct.getState().optionsPnl).toBeCloseTo(95, 5);
  });

  it('credit spread hits the 2× stop → LOSS clamped to maxLoss (never exceeds defined risk)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openDefinedRiskSpread(spreadParams());

    // markNet = 100×(0.20 − 6.00) = −580 → openPnl = −400 ≤ −2×180 = −360 → SL,
    // but the realized loss clamps to the reserved −$320 defined risk.
    const marks = new Map([[OCC_95P, 6.0], [OCC_90P, 0.2]]);
    const prices = new Map<string, number>();

    acct.checkExits(prices, marks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    const closed = acct.checkExits(prices, marks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBe(-320);
    // Reserved $320 fully lost → cash returns to the pre-reservation 49,680 − 320… wait:
    // entry reserved 320 (cash 49,680); close returns 320 + (−320) = 0 → cash stays 49,680.
    expect(acct.getState().optionsCash).toBeCloseTo(49_680, 5);
    expect(acct.getState().optionsPnl).toBe(-320);
  });

  it('debit spread take-profit → WIN, and debit stop → LOSS', () => {
    // Bear-put debit spread: long the 100 put, short the 95 put. netUsd < 0 = debit.
    const debitLegs = [
      { action: 'buy' as const, optionType: 'put' as const, strike: 100, expiration: '2024-07-05' },
      { action: 'sell' as const, optionType: 'put' as const, strike: 95, expiration: '2024-07-05' },
    ];
    const debitParams = (o: Record<string, unknown> = {}) => ({
      symbol: 'AAPL',
      strategy: 'bear_put_spread',
      legs: debitLegs,
      netUsd: -200, // paid $200 debit per lot
      maxLossUsd: 200,
      maxProfitUsd: 300,
      breakevens: [98],
      spot: 100,
      targetContracts: 1, // pin one lot so the P&L math reads per-lot
      ...o,
    });
    const OCC_100P = 'AAPL240705P00100000';

    // TP: markNet = 100×(3.50 − 0.00) = +350 → openPnl = +150 = 50% of $300 → WIN.
    const win = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    win.openDefinedRiskSpread(debitParams());
    const winMarks = new Map([[OCC_100P, 3.5], [OCC_95P, 0.0]]);
    win.checkExits(new Map(), winMarks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    // NB the 95 leg has mark 0 → OCC miss; force the primary path with both > 0.
    const winMarks2 = new Map([[OCC_100P, 3.6], [OCC_95P, 0.1]]);
    const wc = win.checkExits(new Map(), winMarks2, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    // markNet = 100×(3.6 − 0.1) = 350 → openPnl = 150 ≥ 0.5×300 → WIN.
    expect(wc).toHaveLength(1);
    expect(wc[0].pnl).toBeCloseTo(150, 5);

    // SL: markNet = 100×(0.90 − 0.00)… use both > 0. openPnl ≤ −0.5×200 = −100.
    const loss = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    loss.openDefinedRiskSpread(debitParams());
    // markNet = 100×(1.00 − 0.10) = 90 → openPnl = 90 + (−200) = −110 ≤ −100 → SL.
    const lossMarks = new Map([[OCC_100P, 1.0], [OCC_95P, 0.1]]);
    loss.checkExits(new Map(), lossMarks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    const lc = loss.checkExits(new Map(), lossMarks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    expect(lc).toHaveLength(1);
    expect(lc[0].pnl).toBeCloseTo(-110, 5);
  });

  it('DTE time-stop resolves the structure to a real WIN/LOSS', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openDefinedRiskSpread(spreadParams());
    // Advance to 20 days before expiry (≤ 21 DTE) with a modest profit mark.
    // markNet = 100×(0.30 − 1.20) = −90 → openPnl = +90 (below TP's +90? 90/180=0.5 → TP).
    // Use a sub-TP mark so the TIME-STOP (not TP) is what resolves it: openPnl +40.
    vi.setSystemTime(Date.parse('2024-06-15T14:00:00Z')); // 20 DTE to 2024-07-05
    const marks = new Map([[OCC_95P, 1.5], [OCC_90P, 0.1]]); // markNet 100×(0.1−1.5)=−140 → openPnl +40
    const prices = new Map<string, number>();
    acct.checkExits(prices, marks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    const closed = acct.checkExits(prices, marks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBeCloseTo(40, 5); // resolved, non-$0
  });

  it('marks via the Black-Scholes backstop when the OCC lookup misses', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openDefinedRiskSpread(spreadParams());
    // No OCC marks at all → primary misses every tick; after STALE_MARK_BACKSTOP_TICKS
    // (3) misses the per-leg BS reprice engages off the underlying. Drop the
    // underlying deep below both put strikes → the credit spread is a full loss,
    // clamped to −$320 defined risk.
    const emptyMarks = new Map<string, number>();
    const prices = new Map([['AAPL', 80]]); // was 100 at entry; both puts deep ITM
    let closed: ReturnType<typeof acct.checkExits> = [];
    for (let i = 0; i < 4 && closed.length === 0; i += 1) {
      closed = acct.checkExits(prices, emptyMarks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
    }
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl).toBe(-320); // BS-derived loss clamped to defined risk
  });

  it('HOLDs (no synthetic scratch) while the mark is unavailable', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openDefinedRiskSpread(spreadParams());
    // OCC miss AND no underlying price → no BS backstop possible → HOLD forever.
    const emptyMarks = new Map<string, number>();
    const noPrices = new Map<string, number>();
    for (let i = 0; i < 5; i += 1) {
      const closed = acct.checkExits(noPrices, emptyMarks, 'demo', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
      expect(closed).toHaveLength(0);
    }
    expect(acct.getState().openOptions).toHaveLength(1);
  });
});

describe('checkExits — TRA-1418 containment (flag off / live)', () => {
  it('flag off → legacy blanket combo skip is byte-identical (position stays open)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openDefinedRiskSpread(spreadParams());
    const marks = new Map([[OCC_95P, 1.0], [OCC_90P, 0.15]]); // would be a TP if armed
    // No multiLegExitParams arg (8th) → flag-off path, byte-identical legacy skip.
    for (let i = 0; i < 3; i += 1) {
      const closed = acct.checkExits(new Map(), marks, 'demo', {}, undefined, undefined, undefined);
      expect(closed).toHaveLength(0);
    }
    expect(acct.getState().openOptions).toHaveLength(1);
    // comboExitBars never touched on the skip path.
    expect(acct.getState().openOptions[0].comboExitBars).toBeUndefined();
  });

  it('live combo is never managed even with the params present (hard demo gate)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openDefinedRiskSpread(spreadParams(), 'live');
    const marks = new Map([[OCC_95P, 1.0], [OCC_90P, 0.15]]);
    for (let i = 0; i < 3; i += 1) {
      const closed = acct.checkExits(new Map(), marks, 'live', {}, undefined, undefined, undefined, DEFAULT_MULTILEG_EXIT_PARAMS);
      expect(closed).toHaveLength(0);
    }
    expect(acct.getState().openOptions).toHaveLength(1);
  });
});
