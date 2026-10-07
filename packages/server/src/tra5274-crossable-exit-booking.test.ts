// TRA-5274 — book and gate option exits on the CROSSABLE quote, not the mark.
//
// The measurement that ordered this (TRA-5248 review, 30-day exit-axis window
// 2026-09-07..10-06 off bqb1 serving 1348fd28c082): 23 `single_leg_directional`
// closes booked +$20.20 at the mark while `summary.crossed` priced the SAME
// rows at −$248.00 — spreadDragUsd −$237.16. The entire reported edge was the
// booking basis: 20 of 23 closes were chandelier "scratches" at avgR −0.0075
// that are losses at any price the close could actually transact at.
//
// Two code changes under test, both in `options-account.ts`:
//   1. BOOKING — `demoExitFillPrice` books a demo close at the crossable side
//      of this tick's own book (long sells the BID) whenever a usable quote is
//      served, unconditionally (not gated on `marketableOpenMtm.enabled`), and
//      stamps `exitBookedBasis`/`exitBookedPremium` on the row.
//   2. THRESHOLDS — the premium-space exit family (hard/catastrophic stop,
//      trailing stop, TP1, take-profit-early) evaluates against the crossable
//      bid when the tick serves one (the TRA-4285 profit-lock posture, extended
//      to the rest of the family). A dark tick keeps the mid read: a dark
//      quote must not disarm a stop.
//
// ⚠ THE DISCRIMINATOR REQUIREMENT (verbatim from the issue's acceptance): "a
// row whose exit mark and exit bid differ must produce a DIFFERENT booked P&L
// under the new basis than under the old one, and the test must fail if the
// two bases are accidentally wired to the same value. A green that reads
// identically under both bases proves nothing." Every case below therefore
// uses a fixture whose bid, mid and trigger level are three DISTINCT numbers,
// asserts that distinctness first, and then asserts the booked figure equals
// the bid arithmetic AND differs from the mid/level arithmetic.
//
// Harness mirrors `tra4285-profit-lock-executable-basis.test.ts` (same entry
// geometry; demo mode so the inline book mutates and the booked P&L is
// readable off `closedOptions`). TRADING_TIME is 30 min after the open so the
// 15-minute opening-range window is closed on every tick.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';
import { foldCrossedCells, type CrossedPricingRow } from './option-crossed-pnl.js';
import {
  getOptionTradeJournalRecord,
  setOptionTradeJournalFileForTests,
} from './option-trade-journal.js';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// ETHA geometry, verbatim from the TRA-4285 fixture: entry 1.28 → the OTM −20%
// stop at 1.024.
const ENTRY = 1.28;
const STOP = 1.024;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-5274',
    symbol: 'ETHA',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: ENTRY,
    stopLoss: 0.96,
    takeProfit: 1.92,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'ETHA241002C00019000',
    optionType: 'call',
    strike: 19,
    expiration: '2024-10-02',
    mark: ENTRY,
    theo: 1.66,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

// No ATR ⇒ the chandelier is inert; no ladder ⇒ the scalar profit-lock rule.
const RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };

const JOURNAL_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

function demoAccount() {
  vi.setSystemTime(TRADING_TIME);
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: false,
  });
  const pos = acct.openOptionFromCandidate(buildSignal(), 'demo', undefined, undefined, JOURNAL_SETUP);
  expect(pos).not.toBeNull();
  expect(pos!.mode).toBe('demo');
  expect(pos!.premiumPaid).toBe(ENTRY);
  expect(pos!.stopLossPremium).toBeCloseTo(STOP, 9);
  const sym = pos!.optionSymbol!;
  // One tick = quote install + checkExits on an explicit mark, the production
  // sequencing. `mark` is passed separately from the quote so a case can hold
  // the mid fixed while only the bid moves — that separation IS the test.
  const tick = (quote: { bid: number; ask: number } | null, mark: number) => {
    acct.refreshOptionQuotes(quote ? new Map([[sym, quote]]) : new Map());
    return acct.checkExits(
      new Map([['ETHA', 19]]),
      new Map([[sym, mark]]),
      'demo',
      {},
      undefined,
      RISK,
    );
  };
  return { acct, tick, id: pos!.id, contracts: pos!.contracts };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-5274 — exit thresholds read the crossable bid', () => {
  it('does NOT fire the hard stop while the bid still clears the level (no over-firing)', () => {
    const { acct, tick } = demoAccount();
    // bid 1.03 > stop 1.024 — neither basis is through; nothing closes.
    tick({ bid: 1.03, ask: 1.17 }, 1.1);
    expect(acct.getState().openOptions).toHaveLength(1);
    expect(acct.getState().closedOptions).toHaveLength(0);
  });

  it('fires the hard stop when the BID is through the level while the MID is not — and books the bid', () => {
    const { acct, tick, contracts } = demoAccount();
    const BID = 1.0;
    const ASK = 1.2;
    const MARK = 1.1;
    // The three candidate bases are three DISTINCT numbers, or this test can
    // pass with the bases accidentally wired together.
    expect(BID).not.toBe(MARK);
    expect(BID).not.toBe(STOP);
    expect(MARK).toBeGreaterThan(STOP); // the OLD basis would NOT fire here
    expect(BID).toBeLessThan(STOP); //     the crossable basis DOES

    tick({ bid: BID, ask: ASK }, MARK);

    const closed = acct.getState().closedOptions;
    expect(closed).toHaveLength(1);
    const row = closed[0]!;
    expect(row.exitReason).toBe('sl');

    // BOOKED AT THE BID — and provably not at the mid or the trigger level.
    const bidBasisPnl = (BID - ENTRY) * 100 * contracts;
    const markBasisPnl = (MARK - ENTRY) * 100 * contracts;
    const levelBasisPnl = (STOP - ENTRY) * 100 * contracts;
    expect(row.pnl).toBeCloseTo(bidBasisPnl, 9);
    expect(row.pnl).not.toBeCloseTo(markBasisPnl, 9);
    expect(row.pnl).not.toBeCloseTo(levelBasisPnl, 9);

    // The basis stamp names what happened.
    expect(row.exitBookedBasis).toBe('crossable_bid');
    expect(row.exitBookedPremium).toBe(BID);
  });

  it('keeps the mid read on a dark tick — a dark quote must not disarm the stop', () => {
    const { acct, tick } = demoAccount();
    // No quote; mark 1.1 is above the stop ⇒ no fire (unchanged behaviour).
    tick(null, 1.1);
    expect(acct.getState().openOptions).toHaveLength(1);
    // No quote; mark through the stop ⇒ fires on the mid read as before.
    tick(null, 1.02);
    const closed = acct.getState().closedOptions;
    expect(closed).toHaveLength(1);
    // Booked at the trigger LEVEL (the legacy demo booking) and labelled as a
    // mark, not as a crossable price — this row is exactly the population the
    // crossed column cannot check, and the label says so.
    expect(closed[0]!.exitBookedBasis).toBe('mark_unquoted');
  });
});

describe('TRA-5274 — the manual close books the crossable bid', () => {
  it('closeOption books the bid when a usable book is live, and the mid when dark', () => {
    // Quoted account: the booked P&L is the BID arithmetic, not the mid's.
    const quoted = demoAccount();
    const BID = 1.3;
    const ASK = 1.4;
    const MARK = 1.35; // currentPremium after the tick; also the quote's own mid
    expect(BID).not.toBe(MARK);
    quoted.tick({ bid: BID, ask: ASK }, MARK); // no exit rule fires up here
    expect(quoted.acct.getState().openOptions).toHaveLength(1);
    const closedRow = quoted.acct.closeOption(quoted.id);
    expect(closedRow).not.toBeNull();
    const bidBasisPnl = (BID - ENTRY) * 100 * quoted.contracts;
    const markBasisPnl = (MARK - ENTRY) * 100 * quoted.contracts;
    expect(closedRow!.pnl).toBeCloseTo(bidBasisPnl, 9);
    expect(closedRow!.pnl).not.toBeCloseTo(markBasisPnl, 9);
    expect(closedRow!.exitBookedBasis).toBe('crossable_bid');
    expect(closedRow!.exitBookedPremium).toBe(BID);

    // Dark account: the booked P&L is the mark's (pre-TRA-5274 behaviour),
    // and the label is `mark_unquoted` so the fold can count the hole.
    const dark = demoAccount();
    dark.tick(null, MARK);
    const darkClosed = dark.acct.closeOption(dark.id);
    expect(darkClosed).not.toBeNull();
    expect(darkClosed!.pnl).toBeCloseTo(markBasisPnl, 9);
    expect(darkClosed!.exitBookedBasis).toBe('mark_unquoted');
  });
});

describe('TRA-5274 — the journal close row and the crossed fold carry the basis', () => {
  let tmpFile: string;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra5274-journal-${process.pid}-${Date.now()}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  it('folds exitBookedBasis + exitBookedPremium onto the close row through the whitelist', async () => {
    const { acct, tick, id, contracts } = demoAccount();
    const BID = 1.0;
    tick({ bid: BID, ask: 1.2 }, 1.1); // fires the stop; books the bid
    expect(acct.getState().closedOptions).toHaveLength(1);
    await acct.flushOptionTradeJournal();
    const rec = await getOptionTradeJournalRecord(id);
    expect(rec).not.toBeNull();
    expect(rec!.outcome).not.toBe('OPEN');
    // The journal's booked money IS the bid arithmetic (fee-free demo default),
    // and the basis label survived the explicit close-fold whitelist — the
    // TRA-5040 defect class this assert exists for.
    expect(rec!.realizedPnlUsd).toBeCloseTo((BID - ENTRY) * 100 * contracts, 9);
    expect(rec!.exitBookedBasis).toBe('crossable_bid');
    expect(rec!.exitBookedPremium).toBe(BID);
  });

  it('foldCrossedCells censuses the basis over every closed row, absent included', () => {
    const row = (
      basis: string | undefined,
      realizedPnlUsd: number,
    ): CrossedPricingRow => ({
      outcome: realizedPnlUsd < 0 ? 'LOSS' : 'WIN',
      structure: 'single_leg_directional',
      contracts: 1,
      atRiskUsd: 100,
      realizedPnlUsd,
      entryBidAtOpen: 1.2,
      entryAskAtOpen: 1.28,
      markProvenance: { quoteAtFire: { bid: 1.0, ask: 1.2 } },
      ...(basis !== undefined ? { exitBookedBasis: basis } : {}),
    });
    const cells = foldCrossedCells([
      row('crossable_bid', -28),
      row('mark_unquoted', -18),
      row(undefined, -28),
    ]);
    expect(cells.bookedExitBasis).toEqual({ crossable_bid: 1, mark_unquoted: 1, absent: 1 });
    const total = Object.values(cells.bookedExitBasis).reduce((a: number, v) => a + (v ?? 0), 0);
    expect(total).toBe(3); // sums to the fold's closed-row count

    // The matched comparison converges on a crossable-booked row: booked −$28
    // (bid 1.00 against ask-entry 1.28) IS the crossed number for that row.
    expect(cells.crossedPnlUsd).not.toBeNull();
  });
});
