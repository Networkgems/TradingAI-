import { describe, it, expect } from 'vitest';
import {
  aggregateRealizedOptionsPnl,
  isOptionCloseDescription,
  realizedOptionsPnlByCloseDate,
} from './tradier-reconcile.js';
import {
  LIVE_TRADIER_TAPE,
  TRADIER_GAINLOSS_BY_CLOSE_DATE,
} from './tra2864-live-tradier-tape.fixture.js';

// TRA-2864 -- "Live production calendar is not tracking correctly".
//
// WHY THIS FILE EXISTS AND `tradier-reconcile.test.ts` WAS NOT ENOUGH.
//
// Every pre-existing test on this module builds its fills with a description
// like `'Sell to Close 2 SPY May 15 2026 $450 Call'`. Tradier PRODUCTION does
// not emit that. It emits `'AAPL Sep 4, 2026 $280.00 Put'` -- instrument only,
// no action prefix (the same discovery TRA-2810 made one layer over, in
// `historyFillSide`). So the synthetic tape exercised a branch the live account
// could never reach, and a reconcile that matched ZERO of the account's 38 real
// option closes reported an empty map -- which is indistinguishable from a
// quiet book. The suite was green against a code path production never runs.
//
// The fixture here is the board's actual live-production export, and the
// expectations are Tradier's OWN gain/loss report for the same account -- a
// genuinely independent second source, not our output snapshotted back.
//
// NOTE: keep at least one assertion in each block that FAILS on the pre-fix code.
// The pre-fix numbers are written into the test names so a future reader can
// tell a real pass from a vacuous one.

const isOptionClose = (f: (typeof LIVE_TRADIER_TAPE)[number]) =>
  f.tradeType === 'option' && f.amount > 0;

describe('TRA-2864 live production tape -- shape of the real data', () => {
  it('has the option closes the account actually made', () => {
    expect(LIVE_TRADIER_TAPE.filter(isOptionClose).length).toBe(38);
  });

  it('NOT ONE production description carries an action keyword', () => {
    const withKeyword = LIVE_TRADIER_TAPE.filter(f =>
      /buy to open|sell to close|buy to close|sell to open/i.test(f.description),
    );
    // This is the precondition that makes every description-gated filter
    // vacuous on the live account. If Tradier ever starts sending prefixes this
    // test flips, and the amount-sign fallback becomes belt-and-braces rather
    // than the only thing holding the reconcile up.
    expect(withKeyword).toEqual([]);
  });
});

describe('isOptionCloseDescription (TRA-2864 amount-sign fallback)', () => {
  it('resolves every real production close from the amount sign', () => {
    // Pre-fix (description only): 0 of 38.
    const detected = LIVE_TRADIER_TAPE.filter(
      f => f.tradeType === 'option' && isOptionCloseDescription(f.description, f.amount),
    );
    expect(detected.length).toBe(38);
    expect(detected.every(f => f.amount > 0)).toBe(true);
  });

  it('never mistakes a production OPEN for a close', () => {
    const opens = LIVE_TRADIER_TAPE.filter(f => f.tradeType === 'option' && f.amount < 0);
    expect(opens.length).toBeGreaterThan(0);
    expect(opens.some(f => isOptionCloseDescription(f.description, f.amount))).toBe(false);
  });

  it('keeps the keyword authoritative when Tradier does send one', () => {
    // A "Buy to Open" that somehow credited cash is still an open. Keyword wins
    // over sign, so sandbox/legacy tapes behave exactly as before.
    expect(isOptionCloseDescription('Buy to Open 2 SPY ...', 500)).toBe(false);
    expect(isOptionCloseDescription('Sell to Close 2 SPY ...', -500)).toBe(true);
  });

  it('treats a zero amount as ambiguous, not as a close', () => {
    expect(isOptionCloseDescription('AAPL Sep 4, 2026 $280.00 Put', 0)).toBe(false);
    expect(isOptionCloseDescription('AAPL Sep 4, 2026 $280.00 Put')).toBe(false);
  });
});

describe('realizedOptionsPnlByCloseDate vs Tradier gain/loss (broker truth)', () => {
  const { realizedByDate } = realizedOptionsPnlByCloseDate(LIVE_TRADIER_TAPE);

  it.each(Object.entries(TRADIER_GAINLOSS_BY_CLOSE_DATE))(
    '%s matches Tradier to the cent (%s)',
    (date, expected) => {
      expect(realizedByDate.get(date) ?? 0).toBeCloseTo(expected, 2);
    },
  );

  it('reconstructs the partial close that broke the reconcile path', () => {
    // SPY260904C00816000: opened 4 @ -$32.42 on 07-30, closed 3 (+$35.66) and
    // then 1 (+$11.87) on 07-31. Tradier books +$11.35 and +$3.76 = +$15.11.
    const spy = LIVE_TRADIER_TAPE.filter(f => f.symbol === 'SPY260904C00816000');
    const { realizedByDate: only } = realizedOptionsPnlByCloseDate(spy);
    expect(only.get('2026-07-31')).toBeCloseTo(15.11, 2);
  });
});

describe('aggregateRealizedOptionsPnl on the live tape (TRA-2864)', () => {
  it('books the account real realized P&L instead of nothing', () => {
    // Pre-fix: realizedByDate.size === 0 and seenTransactionIds.size === 0, on
    // every single pass, forever -- which also drove `plan.persistFills` false
    // so the daily-totals sidecar was never written, and left
    // `netAdded = -realtimeOffset`, backing every realtime estimate out to $0.
    const totals = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, new Set<string>());
    expect(totals.realizedByDate.size).toBeGreaterThan(0);
    expect(totals.seenTransactionIds.size).toBeGreaterThan(0);
  });

  it('agrees with the backfill path day-for-day', () => {
    // The two paths implementing one rule twice, and disagreeing, IS the bug.
    // Pre-fix they differed by $746.75 across this tape.
    const live = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, new Set<string>());
    const { realizedByDate: backfill } = realizedOptionsPnlByCloseDate(LIVE_TRADIER_TAPE);
    expect([...live.realizedByDate.keys()].sort()).toEqual([...backfill.keys()].sort());
    for (const [date, value] of backfill) {
      expect(live.realizedByDate.get(date)).toBeCloseTo(value, 6);
    }
  });

  it.each(Object.entries(TRADIER_GAINLOSS_BY_CLOSE_DATE))(
    '%s matches Tradier gain/loss (%s)',
    (date, expected) => {
      const totals = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, new Set<string>());
      expect(totals.realizedByDate.get(date) ?? 0).toBeCloseTo(expected, 2);
    },
  );

  it('no longer invents green days out of unmatched closes', () => {
    // 2026-05-27 (+$165.75) and 2026-05-20 (+$16.35) are closes whose opens
    // predate the export. The old gross-proceeds fallback booked the full
    // proceeds as profit -- the exact mechanism behind the original phantom
    // June calendar. They must now be absent, not zero-valued and not positive.
    const totals = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, new Set<string>());
    // Guard the vacuous arm: pre-fix this whole map was EMPTY, so "05-27 is
    // absent" was true for the wrong reason. Prove the matcher ran first.
    expect(totals.realizedByDate.get('2026-07-31')).toBeCloseTo(713.73, 2);
    expect(totals.realizedByDate.has('2026-05-27')).toBe(false);
    expect(totals.realizedByDate.has('2026-05-20')).toBe(false);
    // ...and an unattributed close is NOT cursored, so a later pass whose
    // window reaches the open can still pick it up.
    const mayCloses = LIVE_TRADIER_TAPE.filter(
      f => isOptionClose(f) && f.date.startsWith('2026-05'),
    );
    expect(mayCloses.length).toBeGreaterThan(0);
    for (const f of mayCloses) {
      expect(totals.seenTransactionIds.has(f.transactionId)).toBe(false);
    }
  });

  it('is idempotent across overlapping windows (the rolling-fetch case)', () => {
    // The reconcile refetches a rolling window every pass. Pass 2 must add
    // nothing, and must not mis-match the second close of a partial exit
    // against a basis pass 1 already consumed.
    const first = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, new Set<string>());
    const second = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, first.seenTransactionIds);
    expect(second.realizedByDate.size).toBe(0);
    expect(second.seenTransactionIds.size).toBe(0);
  });

  it('an open already in the cursor still supplies its cost basis', () => {
    // Opens are cost basis, not output. Cursoring one must not strand its
    // close: the pre-fix code filtered opens by `knownIds` and would have.
    const spy = LIVE_TRADIER_TAPE.filter(f => f.symbol === 'SPY260904C00816000');
    const openIds = new Set(spy.filter(f => f.amount < 0).map(f => f.transactionId));
    const totals = aggregateRealizedOptionsPnl(spy, openIds);
    expect(totals.realizedByDate.get('2026-07-31')).toBeCloseTo(15.11, 2);
  });

  it('counts a close exactly once when the window is re-read mid-exit', () => {
    // Pass 1 sees the 07-30 open and only the first (qty 3) leg of the 07-31
    // exit; pass 2 sees the whole thing. Total must be Tradier's +$15.11, not
    // +$15.11 plus a re-booked first leg.
    const spy = LIVE_TRADIER_TAPE.filter(f => f.symbol === 'SPY260904C00816000');
    const firstLeg = spy.filter(f => f.amount < 0 || f.quantity === 3);
    const pass1 = aggregateRealizedOptionsPnl(firstLeg, new Set<string>());
    const pass2 = aggregateRealizedOptionsPnl(spy, pass1.seenTransactionIds);
    const total =
      (pass1.realizedByDate.get('2026-07-31') ?? 0) +
      (pass2.realizedByDate.get('2026-07-31') ?? 0);
    expect(total).toBeCloseTo(15.11, 2);
  });

  it('ignores the equity legs on the tape (documented scope, not an oversight)', () => {
    // Tradier's gain/loss report also books equity closes -- MIR +$0.80 on
    // 2026-06-16 -- which neither path aggregates. That is why 06-16 is pinned
    // at the OPTIONS-only -163.15 above and not the all-instrument -162.35.
    // Filed separately; pinned here so the gap is deliberate and visible.
    const equity = LIVE_TRADIER_TAPE.filter(f => f.tradeType === 'equity');
    expect(equity.length).toBeGreaterThan(0);
    const totals = aggregateRealizedOptionsPnl(LIVE_TRADIER_TAPE, new Set<string>());
    expect(totals.realizedByDate.get('2026-06-16')).toBeCloseTo(-163.15, 2);
  });
});
