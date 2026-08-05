import { describe, it, expect } from 'vitest';
import {
  computeBalanceDailyPnl,
  findPreviousBalanceSnapshot,
  sumCashFlowOverSpan,
} from './tradier-reconcile.js';

/**
 * TRA-2875 — the settled live-calendar cell is a balance delta:
 *
 *   pnl = todayBalance − prevSnapshot.balance − netCashFlow
 *
 * The delta spans `(prev.date, reportDate]`. Before this ticket the cash-flow
 * correction was `netByDate[reportDate]` — ONE day. Any cash event landing
 * strictly inside the gap was booked as trading P&L.
 *
 * These tests assert the ACTUAL corrected number, not merely "not the buggy
 * one", and each states the value the pre-fix single-day lookup produced so a
 * regression is unambiguous.
 */
describe('TRA-2875 — cash flow is corrected over the whole balance-delta span', () => {
  it('does not book a deposit that lands in a snapshot gap (the acceptance case)', () => {
    // Snapshots on D−3 and D, none on D−1 or D−2; a +$300 deposit on D−1.
    const snapshots = {
      '2026-07-29': 5_000,
      '2026-08-01': 5_290,
    };
    const netByDate: Record<string, number> = { '2026-07-31': 300 };
    const reportDate = '2026-08-01';

    const prev = findPreviousBalanceSnapshot(
      Object.fromEntries(Object.entries(snapshots).filter(([d]) => d !== reportDate)),
      reportDate,
    );
    expect(prev).toEqual({ date: '2026-07-29', balance: 5_000 });

    const netCashFlow = sumCashFlowOverSpan(netByDate, prev!.date, reportDate);
    expect(netCashFlow).toBe(300);

    // Balance rose $290 but $300 of that was a deposit: the real trading day
    // is a $10 LOSS, not a $290 gain.
    const pnl = computeBalanceDailyPnl(5_290, prev!.balance, netCashFlow);
    expect(pnl).toBe(-10);

    // Pre-fix behaviour, pinned: netByDate[reportDate] is undefined -> 0, so
    // the whole deposit was reported as a fabricated green day.
    const preFix = computeBalanceDailyPnl(5_290, prev!.balance, netByDate[reportDate] ?? 0);
    expect(preFix).toBe(290);
  });

  it('excludes the anchor day itself — prevBalance already contains it', () => {
    // The 21:00 ET snapshot is taken AFTER that day's cash events, so counting
    // the anchor day again would double-subtract.
    const netByDate = { '2026-07-29': 400, '2026-07-31': 300 };
    expect(sumCashFlowOverSpan(netByDate, '2026-07-29', '2026-08-01')).toBe(300);
  });

  it('excludes events after the report date', () => {
    const netByDate = { '2026-07-31': 300, '2026-08-02': 999 };
    expect(sumCashFlowOverSpan(netByDate, '2026-07-29', '2026-08-01')).toBe(300);
  });

  it('sums multiple interior events, including withdrawals', () => {
    // Both June ACH deposits plus the reverse-split-fee style debit.
    const netByDate = {
      '2026-06-05': 400,
      '2026-06-09': 300,
      '2026-06-15': -0.75,
    };
    expect(sumCashFlowOverSpan(netByDate, '2026-06-04', '2026-06-16')).toBeCloseTo(699.25, 10);
  });

  it('is unchanged on the ordinary consecutive-day case', () => {
    // No regression for the common path: anchor is yesterday, deposit today.
    const netByDate = { '2026-08-04': 300 };
    expect(sumCashFlowOverSpan(netByDate, '2026-08-03', '2026-08-04')).toBe(300);
  });

  it('ignores non-finite persisted amounts rather than poisoning the cell', () => {
    const netByDate = { '2026-07-31': Number.NaN, '2026-08-01': 50 } as Record<string, number>;
    expect(sumCashFlowOverSpan(netByDate, '2026-07-30', '2026-08-01')).toBe(50);
  });

  it('returns 0 when nothing falls in the span', () => {
    expect(sumCashFlowOverSpan({ '2026-06-05': 400 }, '2026-07-29', '2026-08-01')).toBe(0);
  });
});
