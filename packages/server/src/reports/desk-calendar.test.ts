import { describe, it, expect } from 'vitest';
import { aggregateDeskCalendar, buildDeskDayReport, buildJournalCalendarCells } from './desk-calendar.js';
import { excludeTestAccountRows } from '../test-accounts.js';
import type { OptionTradeJournalRecord } from '../option-trade-journal.js';

// TRA-1413 — the DESK (all demo books) calendar folds the firm-wide demo
// Option-Trade Journal into per-ET-day cells the existing Calendar grid renders.

const GEN = 1_700_000_000_000;

/** A closed demo journal row. `closeTs` picks the ET day the P&L books on. */
function closed(
  overrides: Partial<OptionTradeJournalRecord> & { id: string; closeTs: number; realizedPnlUsd: number },
): OptionTradeJournalRecord {
  return {
    openTs: overrides.closeTs - 3 * 86_400_000,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 35,
    atRiskUsd: 100,
    outcome: overrides.realizedPnlUsd > 0 ? 'WIN' : overrides.realizedPnlUsd < 0 ? 'LOSS' : 'SCRATCH',
    realizedR: overrides.realizedPnlUsd / 100,
    exitReason: 'tp1',
    holdDays: 3,
    ...overrides,
  };
}

// 2026-07-01 ~14:30 ET (18:30Z, mid-session) — an unambiguous weekday close.
const JUL01 = Date.parse('2026-07-01T18:30:00Z');
// 2026-07-02 same time — next day.
const JUL02 = Date.parse('2026-07-02T18:30:00Z');

describe('aggregateDeskCalendar', () => {
  it('sums realized option P&L per ET close-day into combinedPnl', () => {
    const rows = [
      closed({ id: 'a', closeTs: JUL01, realizedPnlUsd: 300 }),
      closed({ id: 'b', closeTs: JUL01, realizedPnlUsd: -100 }),
      closed({ id: 'c', closeTs: JUL02, realizedPnlUsd: 50 }),
    ];
    const cells = aggregateDeskCalendar(rows, GEN);

    const jul01 = cells.get('2026-07-01');
    expect(jul01).toBeDefined();
    expect(jul01!.combinedPnl).toBe(200);
    expect(jul01!.optionsPnl).toBe(200);
    // realizedPnl is the equity leg only — the desk book has none.
    expect(jul01!.realizedPnl).toBe(0);
    expect(jul01!.totalTrades).toBe(2);
    expect(jul01!.winners).toBe(1);
    expect(jul01!.losers).toBe(1);

    expect(cells.get('2026-07-02')!.combinedPnl).toBe(50);
  });

  it('keys the cell on the ET close-day, not the open-day', () => {
    // Opens 3 days earlier but closes on Jul 1 — books on the close day.
    const cells = aggregateDeskCalendar([closed({ id: 'a', closeTs: JUL01, realizedPnlUsd: 10 })], GEN);
    expect([...cells.keys()]).toEqual(['2026-07-01']);
  });

  it('skips open rows and closes with no closeTs', () => {
    const openRow: OptionTradeJournalRecord = {
      ...closed({ id: 'open', closeTs: JUL01, realizedPnlUsd: 0 }),
      outcome: 'OPEN',
      closeTs: undefined,
      realizedPnlUsd: undefined,
      realizedR: undefined,
    };
    const cells = aggregateDeskCalendar([openRow, closed({ id: 'c', closeTs: JUL01, realizedPnlUsd: 40 })], GEN);
    expect(cells.get('2026-07-01')!.totalTrades).toBe(1);
    expect(cells.get('2026-07-01')!.combinedPnl).toBe(40);
  });

  it('maps each close to an option trade row for the detail view', () => {
    const cells = aggregateDeskCalendar([closed({ id: 'a', closeTs: JUL01, realizedPnlUsd: 25 })], GEN);
    const row = cells.get('2026-07-01')!.trades[0];
    expect(row.kind).toBe('option');
    expect(row.pnl).toBe(25);
    expect(row.symbol).toBe('AAPL');
  });
});

describe('DESK de-noise — excludeTestAccountRows feeding the fold (TRA-1475)', () => {
  it('drops QA/test book closes from the day cell, keeps real + un-owned', () => {
    const rows = [
      closed({ id: 'real', closeTs: JUL01, realizedPnlUsd: 300, account: 'richard' }),
      closed({ id: 'qa', closeTs: JUL01, realizedPnlUsd: 9000, account: 'qa_loop_7' }),
      closed({ id: 'cto', closeTs: JUL01, realizedPnlUsd: 5000, account: 'ctoverify1' }),
      closed({ id: 'legacy', closeTs: JUL01, realizedPnlUsd: 40 }), // un-owned → kept
    ];
    const cell = aggregateDeskCalendar(excludeTestAccountRows(rows), GEN).get('2026-07-01');
    // only the real (300) + legacy un-owned (40) closes survive
    expect(cell!.combinedPnl).toBe(340);
    expect(cell!.totalTrades).toBe(2);
  });

  it('includeTest keeps the QA churn in the number', () => {
    const rows = [
      closed({ id: 'real', closeTs: JUL01, realizedPnlUsd: 300, account: 'richard' }),
      closed({ id: 'qa', closeTs: JUL01, realizedPnlUsd: 9000, account: 'qa_loop_7' }),
    ];
    const cell = aggregateDeskCalendar(
      excludeTestAccountRows(rows, { includeTest: true }),
      GEN,
    ).get('2026-07-01');
    expect(cell!.combinedPnl).toBe(9300);
    expect(cell!.totalTrades).toBe(2);
  });
});

// TRA-2210 — the per-account DEMO calendar (TRA-1572) fills a day the personal
// book was silent on from this SAME firm-wide journal, and it used to call the
// bare fold — skipping the TRA-1475 QA de-noise both Desk routes apply. The two
// views then disagreed on identical input: 2026-07-22 read +$4,919.50 under "My
// Account" against +$119.50 on Desk. `buildJournalCalendarCells` is the single
// entry point that folds the filter in, so no caller can omit it.
describe('buildJournalCalendarCells — journal → cells, de-noise not optional (TRA-2210)', () => {
  // The real 2026-07-22 shape: one genuine +$1,600 SMCI close mirrored into
  // three QA fixture books with DISTINCT ids (id-dedupe finds no duplicate), on
  // top of $119.50 of real-book closes.
  const jul22 = [
    closed({ id: 'r1', closeTs: JUL01, realizedPnlUsd: 100, account: 'richard' }),
    closed({ id: 'r2', closeTs: JUL01, realizedPnlUsd: 19.5, account: 'admin' }),
    closed({ id: 'm1', closeTs: JUL01, realizedPnlUsd: 1600, symbol: 'SMCI', account: 'qa_mirror_1578_38096' }),
    closed({ id: 'm2', closeTs: JUL01, realizedPnlUsd: 1600, symbol: 'SMCI', account: 'qa_tra1475_1783821169' }),
    closed({ id: 'm3', closeTs: JUL01, realizedPnlUsd: 1600, symbol: 'SMCI', account: 'qa_reg_0710202220' }),
  ];

  it('drops QA fixture mirrors by default — the account view can no longer read 41x the desk', () => {
    const cell = buildJournalCalendarCells(jul22, GEN).get('2026-07-01');
    expect(cell!.combinedPnl).toBeCloseTo(119.5, 2);
    expect(cell!.totalTrades).toBe(2);
    // The pre-fix number, asserted explicitly so a regression names itself.
    expect(cell!.combinedPnl).not.toBeCloseTo(4919.5, 2);
  });

  it('produces the SAME cell the Desk routes do for identical rows', () => {
    const account = buildJournalCalendarCells(jul22, GEN).get('2026-07-01');
    const desk = aggregateDeskCalendar(excludeTestAccountRows(jul22), GEN).get('2026-07-01');
    expect(account!.combinedPnl).toBe(desk!.combinedPnl);
    expect(account!.totalTrades).toBe(desk!.totalTrades);
  });

  it('includeTest still opts the churn back in for debugging', () => {
    const cell = buildJournalCalendarCells(jul22, GEN, { includeTest: true }).get('2026-07-01');
    expect(cell!.combinedPnl).toBeCloseTo(4919.5, 2);
    expect(cell!.totalTrades).toBe(5);
  });

  it('keeps legacy un-owned rows — they cannot be classified, so excluding them would shrink history', () => {
    const cell = buildJournalCalendarCells(
      [closed({ id: 'legacy', closeTs: JUL01, realizedPnlUsd: 40 })],
      GEN,
    ).get('2026-07-01');
    expect(cell!.combinedPnl).toBe(40);
  });
});

describe('buildDeskDayReport', () => {
  it('reads a flat (no-close) day as $0, not missing data', () => {
    const cell = buildDeskDayReport('2026-07-01', [], GEN);
    expect(cell.combinedPnl).toBe(0);
    expect(cell.totalTrades).toBe(0);
    expect(cell.winRate).toBe(0);
  });
});
