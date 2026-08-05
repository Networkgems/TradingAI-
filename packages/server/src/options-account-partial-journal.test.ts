import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
} from './option-trade-journal.js';
import { foldJournalClosesByEtDay } from './pnl-reconciliation.js';
import type { RelativeValueSignal } from '@trading-app/shared';

// TRA-2895 — the WRITE half. `options-partial-close-attribution.test.ts` pins the
// census arithmetic; this file pins that the paper book actually EMITS the rows
// that arithmetic reads, at each of the four sites that realize a slice without
// closing the position.
//
// Worth stating why this file has to exist separately: the census fix is
// unfalsifiable without it. A fold that handles `partials` correctly and a book
// that never writes one produce IDENTICAL output on every existing fixture —
// which is exactly the shape of defect TRA-2314's own instrument kept hitting.

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-partial-1',
    symbol: 'MSFT',
    type: 'relative_value',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.7,
    takeProfit: 1.6,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'MSFT240705C00400000',
    optionType: 'call',
    strike: 400,
    expiration: '2024-07-05',
    mark: 1.0,
    fairPrice: 1.3,
    mispricingPct: -0.23,
    zScore: -2.1,
    ivFitted: 0.25,
    ivUsed: 0.22,
    delta: 0.35,
    reason: 'cheap vs skew',
    ...overrides,
  };
}

const RV_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra2895-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/** Open a multi-contract demo RV position, or fail loudly — a 1-lot cannot trim. */
function openMultiContract(acct: PaperOptionsAccount) {
  const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, undefined, RV_SETUP);
  expect(pos).not.toBeNull();
  expect(pos!.contracts).toBeGreaterThan(1);
  return pos!;
}

describe('TRA-2895 — the demo TP1 trim journals its slice AND folds it into position.pnl', () => {
  it('writes a dated partial row on the trim, then a cumulative close row', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openMultiContract(acct);
    await acct.flushOptionTradeJournal();

    // A mark far above tp1Premium fires the partial. The trailing stop engages
    // at peak × (1 − offset), which sits below this mark, so the same tick does
    // NOT also close the remainder — one trim, position still open.
    acct.checkExits(
      new Map([['MSFT', 400]]),
      new Map([['MSFT240705C00400000', 5.0]]),
      'demo',
      {},
    );
    await acct.flushOptionTradeJournal();

    const afterTrim = (await listOptionTradeJournal())[0]!;
    expect(afterTrim.outcome).toBe('OPEN'); // still open — no close row yet
    expect(afterTrim.partials).toHaveLength(1);
    const slice = afterTrim.partials![0]!;
    expect(slice.exitReason).toBe('tp1');
    expect(slice.contracts).toBeGreaterThan(0);
    expect(slice.realizedPnlUsd).toBeGreaterThan(0);
    expect(slice.ts).toBe(TRADING_TIME);

    // The trim is BOOKED into the book's realized bucket, and — the part that was
    // broken — into the position's cumulative P&L. Before this ticket the demo
    // TP1 branch was the one partial site that skipped `position.pnl`, so the
    // close row below silently dropped the winning slice.
    const open = acct.getState().openOptions.find(o => o.id === pos.id)!;
    expect(open.pnl).toBeCloseTo(slice.realizedPnlUsd, 5);

    // Close the remainder for a further gain and read the trade-level row.
    acct.closeOption(pos.id, 6.0);
    await acct.flushOptionTradeJournal();

    const closed = (await listOptionTradeJournal())[0]!;
    expect(closed.outcome).not.toBe('OPEN');
    // CUMULATIVE: strictly greater than the residual alone, i.e. the slice is in.
    expect(closed.realizedPnlUsd!).toBeGreaterThan(slice.realizedPnlUsd);
    expect(closed.partials).toHaveLength(1);
  });

  it('the trade sums to the same dollars however the census splits the days', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openMultiContract(acct);

    acct.checkExits(
      new Map([['MSFT', 400]]),
      new Map([['MSFT240705C00400000', 5.0]]),
      'demo',
      {},
    );
    // The close lands on a LATER ET day — the multi-day shape that produced the
    // double attribution. Both events keep their own real timestamps.
    vi.setSystemTime(TRADING_TIME + 2 * 24 * 60 * 60 * 1000);
    acct.closeOption(pos.id, 6.0);
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    const cumulative = rows[0]!.realizedPnlUsd!;
    const byDay = foldJournalClosesByEtDay(rows, (ts: number) =>
      new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));

    expect(byDay.size).toBe(2); // the trim day and the close day, separately
    const dayTotal = [...byDay.values()].reduce((s, v) => s + v.realizedPnlUsd, 0);
    // Anchored to the BOOK's own realized bucket, not to the journal's close row.
    // `dayTotal === cumulative` alone is vacuous: the census subtracts the slice
    // it added, so it reproduces whatever the close row says — including a close
    // row that dropped the slice entirely (the pre-fix demo TP1 bug). Grading
    // against `optionsPnl`, which every partial site credits directly via
    // `bookRealizedPnl`, is the independent measurement.
    const bookRealized = acct.getState().optionsPnl;
    expect(cumulative).toBeCloseTo(bookRealized, 2);
    expect(dayTotal).toBeCloseTo(bookRealized, 2);
    // Neither day carries the whole trade: that would be the double-attribution.
    for (const v of byDay.values()) expect(Math.abs(v.realizedPnlUsd)).toBeLessThan(Math.abs(cumulative));
  });
});

describe('TRA-2895 — bookPartialClose journals a surviving slice, not a drained one', () => {
  it('writes a partial row when the position survives the slice', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openMultiContract(acct);

    const after = acct.bookPartialClose(pos.id, 'ord-1', 1, 2.0);
    expect(after).not.toBeNull();
    expect(after!.contractsRemaining).toBe(pos.contracts - 1);
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.outcome).toBe('OPEN');
    expect(row.partials).toHaveLength(1);
    expect(row.partials![0]!.exitReason).toBe('partial_fill');
    expect(row.partials![0]!.contracts).toBe(1);
  });

  it('the idempotency guard also stops the slice being journalled twice', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openMultiContract(acct);

    acct.bookPartialClose(pos.id, 'ord-1', 1, 2.0);
    // The per-tick reconcile sweep can observe the same terminal order again.
    expect(acct.bookPartialClose(pos.id, 'ord-1', 1, 2.0)).toBeNull();
    await acct.flushOptionTradeJournal();

    expect((await listOptionTradeJournal())[0]!.partials).toHaveLength(1);
  });

  it('a slice that DRAINS the position writes only the close row', async () => {
    // No partial row here on purpose: the slice and the close are the same
    // instant, so splitting them would enter one trade into the census as
    // `closes: 1, partialCloses: 1` with the residual netting back to zero.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openMultiContract(acct);

    acct.bookPartialClose(pos.id, 'ord-drain', pos.contracts, 2.0);
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.outcome).not.toBe('OPEN');
    expect(row.exitReason).toBe('partial_drain');
    expect(row.partials).toBeUndefined();
    // One trade, one census event, the whole cumulative figure on the close day.
    const byDay = foldJournalClosesByEtDay([row], (ts: number) =>
      new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    expect([...byDay.values()]).toEqual([
      { closes: 1, partialCloses: 0, realizedPnlUsd: row.realizedPnlUsd },
    ]);
  });
});

describe('TRA-2895 — the live manual-trim path (the 2026-08-04 tape)', () => {
  it('journals a `manual` slice when finalizePendingExit fills part of the position', async () => {
    // admin, 2026-08-04T13:49:21Z: MANUAL sell_to_close of 4 contracts on a
    // larger SPY position, order 140029724. Twelve journal rows stayed OPEN
    // afterwards, and the desk cell booked bucket-journal-silent -2.00.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openMultiContract(acct);

    const staged = acct.stageManualPendingExit(pos.id, 1, 2.0, 'day');
    expect(staged).not.toBeNull();
    acct.attachPendingExit(pos.id, 'ord-manual-1');
    const after = acct.finalizePendingExit(pos.id, 2.0);
    expect(after).not.toBeNull();
    expect(after!.contractsRemaining).toBe(pos.contracts - 1);
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.outcome).toBe('OPEN');
    expect(row.partials).toHaveLength(1);
    expect(row.partials![0]!.exitReason).toBe('manual');
    expect(row.partials![0]!.contracts).toBe(1);
    // The day is no longer silent — this is the whole point of the ticket.
    const byDay = foldJournalClosesByEtDay([row], (ts: number) =>
      new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }));
    expect([...byDay.values()][0]!.partialCloses).toBe(1);
  });
});
