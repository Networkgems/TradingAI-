/**
 * TRA-5278 — a live calendar cell must not carry option P&L dated before its
 * book's `liveOptionsOnsetDate`; and a cash movement can never reach the write
 * path's `realizedByDate`.
 *
 * Fixtures are the 11 `admin` cells TRA-5273 identified (07-15..07-29, sum
 * $987.60, the demo-mode cohort named in `pnl-reconciliation.ts`), onset
 * 2026-07-30.
 */
import { describe, expect, it } from 'vitest';
import { parseTradierHistory } from '@trading-app/engine';
import { auditLiveCellSource, type LiveCellSourceInput } from './live-cell-broker-source.js';
import { realizedPnlByCloseDate } from './tradier-reconcile.js';

const CELLS: ReadonlyArray<readonly [string, number]> = [
  ['2026-07-15', 17.0], ['2026-07-16', -4.5], ['2026-07-17', 217.5], ['2026-07-20', 75.3],
  ['2026-07-21', 80.5], ['2026-07-22', 54.4], ['2026-07-23', 29.89], ['2026-07-24', 59.5],
  ['2026-07-27', 140.0], ['2026-07-28', 68.0], ['2026-07-29', 250.01],
];

function cell(over: Partial<LiveCellSourceInput>): LiveCellSourceInput {
  return {
    reportDate: '2026-07-20',
    pnlSource: undefined,
    combinedPnl: 0,
    realizedPnl: 0,
    optionsPnl: 0,
    markdown: undefined,
    broker: { known: true, realizedUsd: 0 },
    liveOptionsOnsetDate: '2026-07-30',
    ...over,
  };
}

describe('TRA-5278 onset guard', () => {
  it('fixture sums to 987.60', () => {
    expect(Number(CELLS.reduce((s, [, v]) => s + v, 0).toFixed(2))).toBe(987.6);
  });

  it('flags all 11 pre-onset cells, whatever the pnlSource label', () => {
    for (const src of [undefined, 'engine', 'tradier-balance']) {
      for (const [d, v] of CELLS) {
        const verdict = auditLiveCellSource(
          cell({ reportDate: d, optionsPnl: v, combinedPnl: v, pnlSource: src }),
        );
        expect(verdict.status, `${d}/${src}`).toBe('pre_onset_demo_option_pnl');
      }
    }
  });

  // NEGATIVE CONTROL: the same cell dated ON the onset date, and the same cell with
  // the arm disarmed, must NOT carry the verdict. Removing the `reportDate < onset`
  // predicate turns the first red; removing the arm turns the 11-cell test red.
  it('does not flag a cell dated on or after onset', () => {
    const v = auditLiveCellSource(
      cell({ reportDate: '2026-07-30', optionsPnl: 50, combinedPnl: 50, broker: { known: true, realizedUsd: 50 } }),
    );
    expect(v.status).not.toBe('pre_onset_demo_option_pnl');
  });

  // NEGATIVE CONTROL (CEO review): a broker-reconstructed cell before onset is real money.
  it('does not flag a pre-onset realized-backfill cell (07-01 / 07-08 tie to the broker)', () => {
    for (const [d, v] of [['2026-07-01', -116.48], ['2026-07-08', -106.24]] as const) {
      const r = auditLiveCellSource(
        cell({ reportDate: d, pnlSource: 'realized-backfill', optionsPnl: v, combinedPnl: v, broker: { known: true, realizedUsd: v } }),
      );
      expect(r.status, d).toBe('ok');
    }
  });

  it('does not flag a pre-onset cell carrying no option P&L', () => {
    expect(auditLiveCellSource(cell({ reportDate: '2026-07-20' })).status).toBe('ok');
  });

  it('null onset is UNMEASURED for this arm, not flagged and not claimed clean', () => {
    const v = auditLiveCellSource(cell({ optionsPnl: 75.3, combinedPnl: 75.3, liveOptionsOnsetDate: null }));
    expect(v.status).not.toBe('pre_onset_demo_option_pnl');
  });

  it('07-17 (header +300.00 ACH, tradier-balance) is caught by the guard before the header arm', () => {
    const v = auditLiveCellSource(
      cell({
        reportDate: '2026-07-17',
        pnlSource: 'tradier-balance',
        combinedPnl: 217.5,
        optionsPnl: 217.5,
        markdown:
          '> **Live P&L source: Tradier broker balance (TRA-359).** Combined P&L for 2026-07-17 = '
          + 'x = **+300.00**.',
      }),
    );
    expect(v.status).toBe('pre_onset_demo_option_pnl');
  });
});

describe('TRA-5278 write path is trade-only', () => {
  it('no non-trade history row reaches realizedByDate', () => {
    const fills = parseTradierHistory({
      history: {
        event: [
          { date: '2026-07-17', amount: 300, type: 'ach' },
          { date: '2026-07-17', amount: 300, type: 'journal', trade: { symbol: 'SPY260717C00450000', trade_type: 'option', price: 1, quantity: 1 } },
          { date: '2026-07-17', amount: 12, type: 'dividend', trade: { symbol: 'AAPL', trade_type: 'equity', price: 1, quantity: 1 } },
          { date: '2026-07-17', amount: 1, type: 'interest' },
          { date: '2026-07-17', amount: -5, type: 'fee' },
        ],
      },
    } as never);
    expect(fills).toEqual([]);
    const r = realizedPnlByCloseDate(fills, { includeEquity: true });
    expect(r.realizedByDate.size).toBe(0);
    expect(r.closeCountByDate.size).toBe(0);
  });
});
