import { describe, it, expect } from 'vitest';
import type { OptionTradeJournalRecord } from '../option-trade-journal.js';
import {
  buildJournalCalendarCells,
  nonSessionCloseRetractions,
} from './desk-calendar.js';

// TRA-3298 — the desk/demo calendar fold retracts closes stamped on non-session
// ET days. The three weekend rows ($647.61 across 2026-07-04 / 07-05 / 07-11)
// and the 2026-07-03 holiday churn were written by the TRA-3267 sweep bug; the
// writer fix cannot retract rows already on the journal, so the fold has to.
// The calendar authority is `isMarketDayIso` (the independent session calendar
// TRA-3284 grades against), NOT day-of-week — a phantom on a weekday holiday
// (07-03, Thanksgiving, Christmas) must be caught too.

let seq = 0;

function closedRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  const closeTs = over.closeTs ?? Date.parse('2026-07-06T14:00:00-04:00');
  return {
    id: `row-${seq++}`,
    openTs: closeTs - 86_400_000,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 30,
    atRiskUsd: 100,
    outcome: 'WIN',
    realizedPnlUsd: 10,
    realizedR: 0.1,
    exitReason: 'tp1',
    holdDays: 1,
    ...over,
    closeTs,
  };
}

describe('TRA-3298 non-session close retraction', () => {
  it('retracts the three phantom weekend days and keeps real sessions', () => {
    const rows = [
      // The real contamination, at its live timestamps and P&L.
      closedRow({ symbol: 'INTC', closeTs: 1783215608260, realizedPnlUsd: 145 }), // Sat 07-04 21:40 ET
      closedRow({ symbol: 'META', closeTs: 1783215608260, realizedPnlUsd: 111 }),
      closedRow({ symbol: 'PAYX', closeTs: 1783283657175, realizedPnlUsd: 335 }), // Sun 07-05 16:34 ET
      closedRow({ symbol: 'NVDA', closeTs: 1783756930688, realizedPnlUsd: 56.61 }), // Sat 07-11 04:02 ET
      // A genuine Monday session close survives.
      closedRow({ symbol: 'QQQ', closeTs: Date.parse('2026-07-06T14:00:00-04:00'), realizedPnlUsd: 50 }),
    ];
    const cells = buildJournalCalendarCells(rows, Date.now());
    expect([...cells.keys()].sort()).toEqual(['2026-07-06']);
    expect(cells.get('2026-07-06')?.combinedPnl).toBe(50);
  });

  it('retracts a weekday HOLIDAY close — the case day-of-week cannot catch', () => {
    const rows = [
      closedRow({ closeTs: Date.parse('2026-07-03T11:55:00-04:00') }), // Fri, July-4 observed
      closedRow({ closeTs: Date.parse('2026-11-26T14:00:00-05:00') }), // Thu, Thanksgiving
      closedRow({ closeTs: Date.parse('2026-11-27T10:00:00-05:00') }), // Fri after — a session
    ];
    const cells = buildJournalCalendarCells(rows, Date.now());
    expect([...cells.keys()]).toEqual(['2026-11-27']);
  });

  it('keys the session test on the ET day, not the UTC day', () => {
    // 23:30 ET Friday is already Saturday in UTC; the close is still Friday's.
    const rows = [closedRow({ closeTs: Date.parse('2026-07-10T23:30:00-04:00') })];
    const cells = buildJournalCalendarCells(rows, Date.now());
    expect([...cells.keys()]).toEqual(['2026-07-10']);
  });

  it('enumerates every retraction with date, count, sum and row ids', () => {
    const a = closedRow({ closeTs: 1783215608260, realizedPnlUsd: 145 });
    const b = closedRow({ closeTs: 1783215608260, realizedPnlUsd: 111 });
    const c = closedRow({ closeTs: 1783756930688, realizedPnlUsd: 56.61 });
    const kept = closedRow({ closeTs: Date.parse('2026-07-06T14:00:00-04:00') });
    const open = closedRow({ closeTs: 1783215608260 });
    (open as { outcome: string }).outcome = 'OPEN';

    const retracted = nonSessionCloseRetractions([a, b, c, kept, open]);
    expect(retracted).toEqual([
      { date: '2026-07-04', totalTrades: 2, realizedPnlUsd: 256, rowIds: [a.id, b.id] },
      { date: '2026-07-11', totalTrades: 1, realizedPnlUsd: 56.61, rowIds: [c.id] },
    ]);
  });

  it('applies the same QA/test-book de-noise basis as the fold (TRA-1475)', () => {
    const qa = closedRow({ closeTs: 1783215608260, realizedPnlUsd: 999, account: 'qa_fixture_1' });
    const real = closedRow({ closeTs: 1783215608260, realizedPnlUsd: 145, account: 'richard' });

    const denoised = nonSessionCloseRetractions([qa, real]);
    expect(denoised).toHaveLength(1);
    expect(denoised[0].realizedPnlUsd).toBe(145);
    expect(denoised[0].rowIds).toEqual([real.id]);

    const withTest = nonSessionCloseRetractions([qa, real], { includeTest: true });
    expect(withTest[0].totalTrades).toBe(2);
    expect(withTest[0].realizedPnlUsd).toBe(1144);
  });
});
