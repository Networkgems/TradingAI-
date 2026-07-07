import { describe, it, expect } from 'vitest';
import { aggregateDeskCalendar, buildDeskDayReport } from './desk-calendar.js';
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

describe('buildDeskDayReport', () => {
  it('reads a flat (no-close) day as $0, not missing data', () => {
    const cell = buildDeskDayReport('2026-07-01', [], GEN);
    expect(cell.combinedPnl).toBe(0);
    expect(cell.totalTrades).toBe(0);
    expect(cell.winRate).toBe(0);
  });
});
