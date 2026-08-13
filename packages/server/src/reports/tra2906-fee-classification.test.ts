import { describe, expect, it } from 'vitest';
import { isCapitalMovement } from '@trading-app/engine';
import type { TradierCashEvent } from '@trading-app/engine';
import {
  computeBalanceDailyPnl,
  deriveNetByDateFromEvents,
  mergeCashEventsIntoRecord,
  resolveCashFlowNetByDate,
  sumCashFlowOverSpan,
} from './tradier-reconcile.js';

/**
 * TRA-2906 — a broker fee is a cost of doing business and belongs IN P&L.
 *
 * `fee` used to sit in `TRADIER_CASH_EVENT_TYPES` next to `ach`, and that single
 * fact made the settled Live-calendar cell report P&L GROSS of broker fees:
 *
 *     pnl = todayBalance − prevBalance − netCashFlow
 *
 * A $10 fee moves the balance by −10 AND contributes −10 to `netCashFlow`, so
 * `pnl = delta − (−10) = delta + 10`. The fee was added straight back.
 *
 * The tests below pin the CLASSIFICATION per type. That is the point of the
 * ticket: the next person to change this list has to change a stated intent and
 * a named expectation, not quietly edit a set.
 */

const ev = (
  type: string,
  amount: number,
  date = '2026-07-07',
  transactionId = `${date}|${type}|${amount}`,
): TradierCashEvent => ({ date, type, amount, transactionId });

describe('TRA-2906 isCapitalMovement — stated intent per Tradier event type', () => {
  // Funding: capital the USER moved. Must be excluded from P&L.
  it.each(['ach', 'wire', 'check', 'deposit', 'withdrawal', 'journal'])(
    '`%s` is capital movement (excluded from P&L)',
    (type) => {
      expect(isCapitalMovement(type)).toBe(true);
    },
  );

  // The ruling. A fee is a cost the ACCOUNT incurred by operating.
  it('`fee` is NOT capital movement — it stays in P&L (the TRA-2906 ruling)', () => {
    expect(isCapitalMovement('fee')).toBe(false);
  });

  // Unchanged by this ticket, asserted so a later change is deliberate.
  it.each(['dividend', 'interest', 'adjustment'])(
    '`%s` remains capital movement — unchanged by TRA-2906, pinned so a flip is deliberate',
    (type) => {
      expect(isCapitalMovement(type)).toBe(true);
    },
  );

  it('is case-insensitive — Tradier has shipped both casings on this feed', () => {
    expect(isCapitalMovement('ACH')).toBe(true);
    expect(isCapitalMovement('Fee')).toBe(false);
  });

  it('an UNRECOGNISED type stays in P&L rather than being silently subtracted', () => {
    // Excluding an unknown type deletes it from performance invisibly; keeping
    // it leaves a number a human can argue with.
    expect(isCapitalMovement('some_new_tradier_type')).toBe(false);
  });
});

describe('TRA-2906 deriveNetByDateFromEvents — read-time classification', () => {
  it('a fee on day D leaves netCashFlow for D UNCHANGED (acceptance #1)', () => {
    const net = deriveNetByDateFromEvents([ev('fee', -10, '2026-07-07')]);
    expect(net['2026-07-07']).toBeUndefined();
    expect(sumCashFlowOverSpan(net, '2026-07-06', '2026-07-07')).toBe(0);
  });

  it('an ACH deposit on day D still contributes FULLY (acceptance #2)', () => {
    const net = deriveNetByDateFromEvents([ev('ach', 500, '2026-07-07')]);
    expect(net['2026-07-07']).toBe(500);
    expect(sumCashFlowOverSpan(net, '2026-07-06', '2026-07-07')).toBe(500);
  });

  it('a fee and a deposit on the SAME day net to the deposit alone', () => {
    const net = deriveNetByDateFromEvents([
      ev('ach', 500, '2026-07-07'),
      ev('fee', -10, '2026-07-07'),
    ]);
    expect(net['2026-07-07']).toBe(500);
  });

  it('drops a non-finite amount rather than propagating NaN into the daily cell', () => {
    const net = deriveNetByDateFromEvents([
      ev('ach', Number.NaN, '2026-07-07'),
      ev('ach', 50, '2026-07-07'),
    ]);
    expect(net['2026-07-07']).toBe(50);
  });
});

describe('TRA-2906 the defect this ticket fixes, end to end', () => {
  /**
   * The pre-fix behaviour is pinned as a MEASUREMENT, not asserted as an
   * abstraction: the fee really did make the day read $10 better.
   */
  it('the settled cell is $10.00 worse once the fee is no longer added back', () => {
    const prevBalance = 1_000;
    // A flat trading day on which a single $10 broker fee landed.
    const todayBalance = 990;
    const events = [ev('fee', -10, '2026-07-07')];

    // Pre-fix: `fee` was a member of the cash-event set, so it landed in
    // netByDate and was subtracted back out.
    const preFixNetByDate = { '2026-07-07': -10 };
    const preFix = computeBalanceDailyPnl(
      todayBalance,
      prevBalance,
      sumCashFlowOverSpan(preFixNetByDate, '2026-07-06', '2026-07-07'),
    );
    expect(preFix).toBe(0); // the fee vanished — the day reads FLAT

    // Post-fix: the fee is classified as NOT capital movement, so it stays in.
    const postFix = computeBalanceDailyPnl(
      todayBalance,
      prevBalance,
      sumCashFlowOverSpan(deriveNetByDateFromEvents(events), '2026-07-06', '2026-07-07'),
    );
    expect(postFix).toBe(-10); // the day reads the cost it actually incurred

    expect(postFix! - preFix!).toBe(-10);
  });

  it('a deposit is still removed, so the fix did not break the thing the subtraction is FOR', () => {
    // Positive control. If this passed only because everything stopped being
    // subtracted, the fee test above would be vacuous.
    const pnl = computeBalanceDailyPnl(
      1_500,
      1_000,
      sumCashFlowOverSpan(
        deriveNetByDateFromEvents([ev('ach', 500, '2026-07-07')]),
        '2026-07-06',
        '2026-07-07',
      ),
    );
    expect(pnl).toBe(0); // a $500 deposit is NOT a $500 trading win
  });
});

describe('TRA-2906 record shapes — the half-migrated file is unrepresentable', () => {
  it('a v1 aggregate returns its stored totals unchanged, fees still baked in', () => {
    // Until the one-time rebuild runs there is no typed record to reclassify
    // from, and the legacy totals are the ONLY record of those deposits.
    const net = resolveCashFlowNetByDate({
      schema: 'v1-aggregate',
      netByDate: { '2026-07-07': -10 },
      seenIds: ['t1'],
    });
    expect(net['2026-07-07']).toBe(-10);
  });

  it('a v2 typed record reclassifies, and never consults a legacy aggregate', () => {
    const net = resolveCashFlowNetByDate({
      schema: 'v2-typed',
      events: [ev('fee', -10, '2026-07-07'), ev('ach', 300, '2026-08-03')],
    });
    expect(net['2026-07-07']).toBeUndefined();
    expect(net['2026-08-03']).toBe(300);
  });

  it('merging dedups on transactionId so a re-fetch cannot inflate the record', () => {
    const first = mergeCashEventsIntoRecord([], [ev('ach', 300, '2026-08-03', 'tx-1')]);
    const again = mergeCashEventsIntoRecord(first, [ev('ach', 300, '2026-08-03', 'tx-1')]);
    expect(again).toHaveLength(1);
    expect(deriveNetByDateFromEvents(again)['2026-08-03']).toBe(300);
  });

  it('merge keeps the EXISTING row on an id collision, so a re-fetch cannot rewrite history', () => {
    const first = mergeCashEventsIntoRecord([], [ev('ach', 300, '2026-08-03', 'tx-1')]);
    const mutated = mergeCashEventsIntoRecord(first, [ev('ach', 999, '2026-08-03', 'tx-1')]);
    expect(deriveNetByDateFromEvents(mutated)['2026-08-03']).toBe(300);
  });

  it('merge preserves fee events in the record even though they never reach netByDate', () => {
    // The fee is RECORDED and merely not classified as capital movement. Keeping
    // it is what makes the classification changeable later without a migration —
    // which is the entire reason this ticket is not a one-line set edit.
    const merged = mergeCashEventsIntoRecord([], [ev('fee', -10, '2026-07-07', 'tx-fee')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.type).toBe('fee');
    expect(deriveNetByDateFromEvents(merged)['2026-07-07']).toBeUndefined();
  });
});
