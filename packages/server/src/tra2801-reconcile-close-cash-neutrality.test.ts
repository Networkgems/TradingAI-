import { describe, it, expect } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { AccountMode, OptionPosition } from '@trading-app/shared';

// ─── TRA-2801 RESIDUAL A — the reconcile close credited paper cash, paper
//     equity, and the SIZING equity book at the last known mark, and nothing
//     restated any of the three.
//
// Decision implemented: option 1 on the ticket. `closeBrokerFlatPosition` books
// at BREAK-EVEN — refund exactly the premium the open debited for the remaining
// contracts, book $0 realized — and lets the EOD reconcile add broker truth on
// top of $0.
//
// Why not option 2 ("keep the P&L estimate, neutralise only cash/equity"): the
// realized estimate is booked through `bookRealizedPnl`, whose `realizedPnlSink`
// credits the owning `PaperAccount` — the book `sizingEquity()` measures against
// (TRA-2323). The EOD restatement `addReconciledTradierPnl` does a bare
// `optionsPnlByMode.live +=` and NEVER reaches that sink. So keeping the
// estimate leaves the bucket that authorises real orders inflated permanently,
// which is the exact harm the ticket names. Option 2 does not close it.
//
// Why not option 3 ("extend the EOD reconcile to restate cash/equity"):
// `aggregateRealizedOptionsPnl` yields realized P&L per date, never the gross
// proceeds a cash restatement needs, and it is shared with the imported branch
// on a live book.
//
// THE AXES ARE ASSERTED SEPARATELY, per the ticket. A row-count assertion
// ("the row left the book") passes under both the old and the new accounting and
// is therefore not evidence about dollars.
const TRADING_TIME = Date.parse('2026-08-04T14:00:00Z');
const AGED = TRADING_TIME - 6 * 60 * 60 * 1000;

const SEED_CASH = 20_000;

/** The SPY 820C row from TRA-2799: 2 contracts, paid 0.07, marked 0.44. */
function engineRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'opt-spy-820c',
    symbol: 'SPY',
    optionSymbol: 'SPY260904C00820000',
    optionType: 'call',
    strike: 820,
    expiration: '2026-09-04',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 0.07,
    currentPremium: 0.44,
    tp1Premium: 0.14,
    tp1Hit: false,
    stopLossPremium: 0.035,
    peakPremium: 0.44,
    trailingActive: true,
    trailingStopPremium: 0.69,
    underlyingEntryPrice: 640,
    openedAt: AGED,
    signalId: 'sig-otm-1',
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    ...overrides,
  } as OptionPosition;
}

/**
 * Seeds an account whose paper cash has ALREADY been debited for the rows, which
 * is what an entry path does (`cash -= contracts * premiumPaid * 100`). Without
 * that, "cash is neutral" would be measured against a bucket the open never
 * touched and the refund could not be compared to anything.
 */
function seed(rows: OptionPosition[]) {
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
  const debited = rows.reduce((sum, r) => sum + r.premiumPaid * r.contracts * 100, 0);
  acct.importSnapshot({
    openOptions: rows,
    closedOptions: [],
    optionsPnl: 0,
    optionsPnlByMode: { demo: 0, live: 0 },
    dailyCount: 1,
    currentDayKey: '2026-08-04',
    cash: SEED_CASH - debited,
    equity: 25_000,
  });
  return { acct, debited, cashAfterOpen: SEED_CASH - debited };
}

/** Captures every `bookRealizedPnl` accrual that reaches the sizing equity book. */
function withSink(acct: PaperOptionsAccount) {
  const calls: Array<{ mode: AccountMode; delta: number }> = [];
  acct.setRealizedPnlSink((mode, delta) => calls.push({ mode, delta }));
  return calls;
}

describe('TRA-2801 Residual A — the reconcile close is cash/equity neutral', () => {
  // ── DOLLARS AXIS ──────────────────────────────────────────────────────────
  it('CASH: refunds exactly what the open debited, not the mark ($14, not $88)', () => {
    const { acct, debited, cashAfterOpen } = seed([engineRow()]);
    expect(debited).toBeCloseTo(14, 5); // 0.07 × 2 × 100

    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');

    // Cash returns to its pre-open value. Under the mark accounting this was
    // cashAfterOpen + $88 — a $74 invention on a contract Tradier was not
    // holding, and nothing anywhere removed it.
    expect(acct.getStateForMode('live').optionsCash).toBeCloseTo(SEED_CASH, 5);
    expect(acct.getStateForMode('live').optionsCash - cashAfterOpen).toBeCloseTo(debited, 5);
  });

  it('EQUITY: paper equity does not move at all', () => {
    const { acct } = seed([engineRow()]);
    const before = acct.getEquity();
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    // Was +$74 under the mark accounting, and `addReconciledTradierPnl` touches
    // `optionsPnlByMode` only, so it never came back off.
    expect(acct.getEquity()).toBeCloseTo(before, 5);
  });

  it('REALIZED: books $0, not the +$74 mark estimate', () => {
    const { acct } = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(0, 5);
  });

  it('SIZING EQUITY: the realizedPnlSink is never notified', () => {
    const { acct } = seed([engineRow()]);
    const calls = withSink(acct);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    // This is the axis option 2 could not have closed: the sink credits the
    // `PaperAccount` that `sizingEquity()` reads, and the EOD restatement
    // (`addReconciledTradierPnl`, a bare `optionsPnlByMode.live +=`) cannot
    // reach it. An estimate delivered here is an estimate delivered forever.
    expect(calls).toEqual([]);
  });

  it('the archived row carries $0 P&L, so "banked today" does not show phantom profit', () => {
    const { acct } = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    const closed = acct.getClosedOptionsForMode('live');
    expect(closed).toHaveLength(1);
    expect(closed[0].pnl ?? 0).toBeCloseTo(0, 5);
    // `dailyRealizedOptionsPnlForMode` sums `opt.pnl` over rows closed today.
    expect(acct.getStateForMode('live').dailyRealizedOptionsPnl).toBeCloseTo(0, 5);
  });

  // ── ROW-COUNT AXIS, asserted separately ───────────────────────────────────
  it('ROW COUNT: the row still leaves the open book and lands in the archive', () => {
    const { acct } = seed([engineRow()]);
    expect(acct.getStateForMode('live').openOptions).toHaveLength(1);

    const closed = acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');

    expect(closed).not.toBeNull();
    expect(acct.getStateForMode('live').openOptions).toHaveLength(0);
    expect(acct.getClosedOptionsForMode('live')).toHaveLength(1);
    // befc82f's contract is intact: the reason rides the archived snapshot.
    expect(acct.getClosedOptionsForMode('live')[0].exitErrorReason).toBe('broker flat');
    // NOTE: this test passes identically under the OLD mark accounting. It is
    // here to prove the fix did not regress the row disposal, NOT as dollar
    // evidence — that is what the assertions above are for.
  });

  it('the refusals are unchanged (imported / demo / combo / covered write)', () => {
    const { acct } = seed([
      engineRow({ id: 'r-imported', importedFromTradier: true }),
      engineRow({ id: 'r-demo', mode: 'demo' }),
      engineRow({
        id: 'r-combo',
        legs: [{ action: 'buy', optionType: 'call', strike: 820, expiration: '2026-09-04' }],
      }),
      engineRow({ id: 'r-covered', coveredWrite: 'covered_call' }),
    ]);
    for (const id of ['r-imported', 'r-demo', 'r-combo', 'r-covered']) {
      expect(acct.closeBrokerFlatPosition(id, 'broker flat')).toBeNull();
    }
    expect(acct.getStateForMode('live').optionsCash).toBeCloseTo(
      SEED_CASH - (0.07 * 2 * 100) * 4,
      5,
    );
  });

  // ── BOTH WORLDS ───────────────────────────────────────────────────────────
  it('WORLD A broker closed it out-of-band: EOD lands on broker truth exactly', () => {
    const { acct } = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');

    // EOD (index.ts, TRA-367): netAdded = brokerTruth − drainedOffset.
    const brokerTruth = 70;
    let offset = 0;
    for (const v of acct.consumeRealtimeImportedPnl().values()) offset += v;
    // Nothing to dedupe, because nothing was estimated.
    expect(offset).toBeCloseTo(0, 5);
    const netAdded = brokerTruth - offset;
    acct.addReconciledTradierPnl(netAdded);

    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(70, 5);
    // Under the mark accounting BEFORE 4ffbe10 this read $144; 4ffbe10 got it to
    // $70 by deduping. Break-even gets to $70 without needing the dedupe at all.
  });

  it('WORLD B the open never filled: $0 stands, with nothing to back out', () => {
    const { acct } = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');

    // No Tradier history row exists, so the EOD reconcile adds nothing.
    let offset = 0;
    for (const v of acct.consumeRealtimeImportedPnl().values()) offset += v;
    const netAdded = 0 - offset;
    if (netAdded !== 0) acct.addReconciledTradierPnl(netAdded);

    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(0, 5);
    // …and this is the world where cash matters most: the premium came back and
    // no profit was invented on a contract that never existed.
    expect(acct.getStateForMode('live').optionsCash).toBeCloseTo(SEED_CASH, 5);
  });

  // ── SCALE: the three rows on TRA-2799 ─────────────────────────────────────
  it('the three TRA-2799 rows: $630 of invented cash removed, $446 refunded', () => {
    const rows = [
      engineRow(), // debit 0.07×2×100 = $14   · mark credit 0.44×2×100 = $88
      engineRow({
        id: 'opt-spy-816c',
        optionSymbol: 'SPY260904C00816000',
        strike: 816,
        contracts: 4,
        contractsRemaining: 4,
        premiumPaid: 0.08, // debit $32 · mark credit 0.54×4×100 = $216
        currentPremium: 0.54,
      }),
      engineRow({
        id: 'opt-aapl-280p',
        symbol: 'AAPL',
        optionSymbol: 'AAPL260904P00280000',
        optionType: 'put',
        strike: 280,
        contracts: 4,
        contractsRemaining: 4,
        premiumPaid: 1.0, // debit $400 · mark credit 1.93×4×100 = $772
        currentPremium: 1.93,
      }),
    ];
    const { acct, debited } = seed(rows);
    const calls = withSink(acct);
    expect(debited).toBeCloseTo(14 + 32 + 400, 5); // $446

    for (const r of rows) {
      expect(acct.closeBrokerFlatPosition(r.id, 'broker flat')).not.toBeNull();
    }

    const markCredit = 88 + 216 + 772; // $1,076
    // DOLLARS: cash back to pre-open, i.e. $446 refunded and the $630 gap
    // between the mark credit and the true debit never created.
    expect(acct.getStateForMode('live').optionsCash).toBeCloseTo(SEED_CASH, 5);
    expect(markCredit - debited).toBeCloseTo(630, 5);
    expect(acct.getStateForMode('live').optionsPnl).toBeCloseTo(0, 5);
    expect(calls).toEqual([]);
    // ROW COUNT, separately: all three left the book.
    expect(acct.getStateForMode('live').openOptions).toHaveLength(0);
    expect(acct.getClosedOptionsForMode('live')).toHaveLength(3);
  });

  // ── 4ffbe10's registration is now a no-op BY CONSTRUCTION ─────────────────
  it('the dedupe registration is a no-op: delta is $0 and the map stays empty', () => {
    const { acct } = seed([engineRow()]);
    acct.closeBrokerFlatPosition('opt-spy-820c', 'broker flat');
    // If a future change reintroduces a non-zero estimate this fails and points
    // at `closeBrokerFlatPosition`. 4ffbe10's registration line is kept there so
    // that such an estimate would still be routed correctly — TRA-2801 removes
    // the estimate rather than deduping it.
    expect(acct.consumeRealtimeImportedPnl().size).toBe(0);
  });
});
