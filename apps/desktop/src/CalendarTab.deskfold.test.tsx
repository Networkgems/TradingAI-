import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { EodReport } from '@trading-app/shared';
import {
  isDeskFoldCell,
  scopeSplit,
  ScopeBadge,
  ScopeSplitLine,
  DeskFoldNote,
} from './CalendarTab';

// TRA-4203 — the demo "My Account" calendar renders the FIRM-WIDE Desk fold in
// cells the account's own book has nothing for (TRA-1572, scoped by TRA-2407),
// and before this ticket rendered it with no visual difference from a cell the
// account traded. TRA-4199 measured 65% of July 2026's total and 100% of
// August's to be that fold on live 092d087775dc.
//
// ⚠️ Both directions, throughout. A test that only asserts "a folded cell is
// badged" would also pass if EVERY cell were badged — which is the opposite
// defect and a worse one, because a label that is always on is a label nobody
// reads. Every positive below is paired with the account-cell negative.

const day = (date: string, combinedPnl: number, extra: Record<string, unknown> = {}): EodReport =>
  ({
    date,
    generatedAt: 0,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: combinedPnl,
    optionsPnl: combinedPnl,
    combinedPnl,
    totalEquity: 2008,
    managedEquity: 1004,
    availableCash: 1004,
    trades: [],
    openPositionCount: 0,
    winRate: 0,
    avgRR: 0,
    totalTrades: 1,
    winners: 0,
    losers: 0,
    expectancy: 0,
    maxDrawdown: 0,
    sharpe: 0,
    top5Movers: [],
    signalAccuracy: { correct: 0, total: 0, pct: 0 },
    markdown: '',
    ...extra,
  }) as unknown as EodReport;

/** The stamp the server puts on a folded cell (`demo-calendar-fold-provenance.ts`). */
const FOLD = {
  kind: 'firm_wide_demo_desk_fold',
  code: 'D',
  label: 'Desk fold — firm-wide demo, not this account',
  detail: 'firm-wide demo journal; not this account\'s money.',
  tradeCount: 47,
  equivalentTo: '/api/reports/desk/{date}',
} as const;

const folded = (date: string, pnl: number) =>
  day(date, pnl, { cellScope: { ...FOLD } });

describe('isDeskFoldCell — whose book is this cell (TRA-4203)', () => {
  it('is TRUE for a stamped fold cell', () => {
    expect(isDeskFoldCell(folded('2026-07-02', 1298.55))).toBe(true);
  });

  it('is FALSE for this account\'s own cell — the common case, unlabelled by design', () => {
    expect(isDeskFoldCell(day('2026-07-02', 12.5))).toBe(false);
  });

  it('is FALSE for a missing day, and for an unrecognised future scope kind', () => {
    expect(isDeskFoldCell(undefined)).toBe(false);
    // A `kind` this build does not know is NOT "the Desk fold". Treating any
    // present `cellScope` as the fold would mislabel the first scope somebody
    // adds later.
    expect(isDeskFoldCell(
      day('2026-07-02', 1, { cellScope: { ...FOLD, kind: 'something_else' } }),
    )).toBe(false);
  });
});

describe('scopeSplit — the parts of a mixed total (TRA-4203)', () => {
  const july = [
    folded('2026-07-01', -918),
    folded('2026-07-02', 1298.55),
    day('2026-07-06', 40.25),
    day('2026-07-07', -10.25),
  ];

  it('splits the total by book without changing it', () => {
    const s = scopeSplit(july, 'B');
    expect(s.fold).toBeCloseTo(380.55, 2);
    expect(s.account).toBeCloseTo(30, 2);
    expect(s.foldDays).toBe(2);
    expect(s.accountDays).toBe(2);
    // ⛔ The ticket's DO-NOT: no change to the fold's arithmetic. The parts must
    // add back to exactly the Net P&L the strip already printed.
    expect(s.account + s.fold).toBeCloseTo(380.55 + 30, 2);
  });

  it('reports zero folded days on an ordinary account — the note must stay off', () => {
    const s = scopeSplit([day('2026-07-06', 40.25), day('2026-07-07', -10.25)], 'B');
    expect(s.foldDays).toBe(0);
    expect(s.fold).toBe(0);
    expect(s.account).toBeCloseTo(30, 2);
  });

  it('counts only days the grid counts — an excluded day is in neither part', () => {
    // TRA-3101/TRA-3102: an unmeasured or unconfirmed day is dropped from the
    // total, so it must be dropped from the split too, or the parts would stop
    // adding back to the whole.
    const s = scopeSplit([
      folded('2026-07-02', 1298.55),
      day('2026-07-03', 5, { pnlUnknown: { detail: 'no anchor' } }),
      day('2026-07-04', 9, { pnlUnreconciled: { detail: 'engine only' } }),
    ], 'B');
    expect(s.foldDays).toBe(1);
    expect(s.accountDays).toBe(0);
    expect(s.account).toBe(0);
  });

  it('the August shape: 100% of the total is the fold', () => {
    // Aug 2026 on the live demo book — zero own closes 07-30..08-28, so every
    // counted cell in the month was somebody else's.
    const s = scopeSplit([folded('2026-08-03', -128.09), folded('2026-08-04', -100)], 'B');
    expect(s.accountDays).toBe(0);
    expect(s.fold).toBeCloseTo(-228.09, 2);
  });
});

describe('ScopeBadge — the D marker (TRA-4203)', () => {
  it('renders D on a folded cell, with the explanation on hover', () => {
    render(<ScopeBadge report={folded('2026-07-02', 1298.55)} />);
    const badge = screen.getByText('D');
    expect(badge).toBeTruthy();
    expect(badge.getAttribute('title')).toContain('not this account');
  });

  it('renders NOTHING on this account\'s own cell', () => {
    const { container } = render(<ScopeBadge report={day('2026-07-06', 40.25)} />);
    expect(container.textContent).toBe('');
  });
});

describe('the strip and the footer note (TRA-4203)', () => {
  const july = [folded('2026-07-01', -918), day('2026-07-06', 40.25)];

  it('states the two subtotals separately inside the Net P&L tile', () => {
    // The strip is what gets screenshotted; the split has to be in the crop.
    const { container } = render(<ScopeSplitLine reports={july} view="B" />);
    expect(container.textContent).toContain('this account +$40.25');
    expect(container.textContent).toContain('Desk fold -$918.00');
  });

  it('prints one footer line naming the folded subtotal', () => {
    const { container } = render(<DeskFoldNote reports={july} view="B" />);
    expect(container.textContent).toContain('-$918.00');
    expect(container.textContent).toContain('firm-wide Desk fold');
    // It must say the money is still IN the totals — this ticket changed the
    // label, not the arithmetic, and a note that implied otherwise would send a
    // reader hunting for a discrepancy that does not exist.
    expect(container.textContent).toContain('included in the figures above');
  });

  it('renders NEITHER on a month with no folded cells', () => {
    const own = [day('2026-07-06', 40.25), day('2026-07-07', -10.25)];
    expect(render(<ScopeSplitLine reports={own} view="B" />).container.textContent).toBe('');
    expect(render(<DeskFoldNote reports={own} view="B" />).container.textContent).toBe('');
  });
});
