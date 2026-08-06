// TRA-2956 — a `sell_to_close` the market never reaches latches `pendingExit`
// forever, and `if (opt.pendingExit) continue` at the TOP of the exit loop then
// detaches EVERY exit rule on the row: stop-loss, trailing, chandelier, time
// stop, supertrend flip. Not a degraded exit path — no exit path.
//
// `resolvePendingOptionExits` has three branches: `filled` → finalise,
// TRADIER_REJECTED_STATUSES → clear, and everything else → "still open/partial,
// the next tick polls again". An unfillable limit is neither filled nor
// rejected, so it takes the third branch every tick for the life of the order.
//
// Measured on production 2026-08-05: a 2-of-4 TP1 on TSLA260911C00555000 staged
// at 09:30:25 ET at a `null` limit (the TRA-2957 sentinel inversion), repriced
// to 0.36 — above the 0.355 high-water mark the row ever printed — and held the
// trailing stop off all 4 contracts for 5h09m while that stop sat violated
// (mark 0.265 vs trail 0.30175, 25.4% off peak against a 15% trail).
//
// Two properties make it worse than a stale order:
//   • the latch was set by a PARTIAL (2 of 4) and suspended management on the
//     whole row, including the 2 contracts never committed to the exit;
//   • a TP1 limit sits ABOVE the market, so an adverse move pushes it FURTHER
//     out of the money — more latched — exactly as the stop it is suppressing
//     becomes necessary. The mechanism fails OPEN on adverse moves.
//
// This is the attached-order sibling of TRA-2819's unattached-intent strand,
// and the two selectors must stay disjoint: one latch, one owner.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

// 10:00 AM ET = 14:00 UTC during EDT, pinned to a Tuesday so the weekday /
// trading-window predicates pass.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// Mirrors the constants in options-account.ts. Deliberately re-stated rather
// than imported: if someone loosens the production gates, these tests should
// fail and force the decision to be re-argued, not silently follow it.
const WORKING_AGE_MS = 15 * 60_000;
const MAX_CLEARS_PER_ROW = 8;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-2956',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.3,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-2956 — a working exit that cannot fill is withdrawn, not held forever', () => {
  /** Entry: premiumPaid 1.0, SL 0.80, TP1 1.50, 4 contracts. */
  function openCall(mode: 'demo' | 'live' = 'demo') {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), mode, undefined, 400);
    expect(pos).not.toBeNull();
    return { acct, sym: pos!.optionSymbol!, id: pos!.id };
  }

  /**
   * Reproduce the production state with NO test-only mutation: a real TP1
   * trigger stages the intent through `checkExits({ waitAndHold: true })`, and
   * a real `attachPendingExit` stamps the broker order id the submit half
   * returned. From here the order simply never fills — which is not a state
   * any test needs to fake, it is what the third poll branch does with it.
   */
  function latchUnfillableTp1(mode: 'demo' | 'live' = 'demo') {
    const { acct, sym, id } = openCall(mode);
    const staged = acct.checkExits(new Map(), new Map([[sym, 1.6]]), mode, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(staged[0].pendingExit?.kind).toBe('tp1');
    // The submit half succeeded — this is the half TRA-2819 was about missing.
    expect(acct.attachPendingExit(id, 140276225, 1.6)).toBe(true);
    return { acct, sym, id };
  }

  it('leaves a working order alone while it is still inside the age gate', () => {
    const { acct } = latchUnfillableTp1();
    vi.advanceTimersByTime(WORKING_AGE_MS - 1_000);
    expect(acct.listStaleWorkingExits()).toHaveLength(0);
    expect(acct.getState().openOptions[0].pendingExit).toBeDefined();
  });

  it('selects a working order once it is older than the age gate', () => {
    const { acct, sym } = latchUnfillableTp1();
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);

    const stale = acct.listStaleWorkingExits();
    expect(stale).toHaveLength(1);
    expect(stale[0].optionSymbol).toBe(sym);
    expect(stale[0].kind).toBe('tp1');
    expect(stale[0].tradierOrderId).toBe(140276225);
    expect(stale[0].ageMs).toBeGreaterThan(WORKING_AGE_MS);
    // The QUERY does not mutate: the cancel it authorises is a real broker
    // write, and the latch must not be marked handled before that is confirmed.
    expect(acct.getState().openOptions[0].pendingExit).toBeDefined();
  });

  // ── The positive control QA asked for, and the whole point of the ticket ──

  it('re-arms the stop on the FULL row — a 2-of-4 TP1 had disarmed all 4', () => {
    const { acct, sym } = latchUnfillableTp1();
    const row = acct.getState().openOptions[0];
    // The latch is a PARTIAL — strictly fewer contracts committed to the exit
    // than the row still holds. That gap is the residual the TP1 was never
    // entitled to suspend management on, and it is what this test measures.
    const held = row.contractsRemaining;
    const committed = row.pendingExit!.qty;
    expect(committed).toBeGreaterThan(0);
    expect(committed).toBeLessThan(held);

    // The market reverses hard, far below the 0.80 stop. This is the adverse
    // move the stop exists for, and the TP1 limit at 1.6 is now further out of
    // the money than ever — so it will never fill and never clear itself.
    const marks = new Map([[sym, 0.7]]);
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);

    // THE BUG: nothing fires. Not on the 2 committed contracts, not on the 2
    // that were never part of the exit. `checkExits` skips the row above the
    // line that reads the mark.
    expect(acct.checkExits(new Map(), marks, 'demo')).toHaveLength(0);
    expect(acct.getState().openOptions).toHaveLength(1);

    // THE FIX: withdraw the confirmed-unfilled order, and the row is back.
    const [stale] = acct.listStaleWorkingExits();
    expect(acct.noteStaleWorkingExitCleared(stale)).toBe(true);

    const closed = acct.checkExits(new Map(), marks, 'demo');
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl');
    // The FULL remaining position, not just the contracts the TP1 had claimed.
    expect(closed[0].contracts).toBe(held);
    expect(closed[0].contracts).toBeGreaterThan(committed);
  });

  it('stamps durable evidence on the row — the counter resets on restart, this does not', () => {
    const { acct } = latchUnfillableTp1();
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    const [stale] = acct.listStaleWorkingExits();
    acct.noteStaleWorkingExitCleared(stale);

    const row = acct.getState().openOptions[0];
    expect(row.pendingExit).toBeUndefined();
    expect(row.exitErrorReason).toMatch(/working at Tradier for 15 min/i);
    expect(row.exitErrorReason).toMatch(/No contracts were sold/i);
    expect(row.exitErrorReason).toMatch(/TRA-2956/);
  });

  it('does NOT advance the TRA-450 auto-close breaker — we withdrew, the broker did not refuse', () => {
    const { acct } = latchUnfillableTp1();
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    acct.noteStaleWorkingExitCleared(acct.listStaleWorkingExits()[0]);
    // Counting this would pause auto-close on exactly the row that just proved
    // it needs it — and unlike a genuine rejection this path repeats by design,
    // so it would trip the breaker on its own inside the retry budget.
    expect(acct.getState().openOptions[0].closeRejectCount).toBeUndefined();
  });

  // ── Disjointness from TRA-2819: one latch, one owner ──

  it('never selects an UNATTACHED intent — that is TRA-2819 reap territory', () => {
    const { acct, sym } = openCall();
    // Staged but never submitted: `tradierOrderId` is ''.
    acct.checkExits(new Map(), new Map([[sym, 0.7]]), 'demo', { waitAndHold: true });
    expect(acct.getState().openOptions[0].pendingExit?.tradierOrderId).toBe('');

    vi.advanceTimersByTime(WORKING_AGE_MS * 10);
    // There is no broker order to cancel, so this selector must not claim it.
    expect(acct.listStaleWorkingExits()).toHaveLength(0);
    // And its real owner still does.
    expect(acct.reapAbandonedStagedExits()).toHaveLength(1);
  });

  it('the TRA-2819 reaper never claims an ATTACHED order, so the two cannot both clear one latch', () => {
    const { acct } = latchUnfillableTp1();
    vi.advanceTimersByTime(WORKING_AGE_MS * 10);
    expect(acct.reapAbandonedStagedExits()).toHaveLength(0);
    expect(acct.listStaleWorkingExits()).toHaveLength(1);
  });

  it('SKIPS an order it cannot date — the inverse of the reap default, and deliberately so', () => {
    const { acct } = latchUnfillableTp1();
    // TRA-2819 reaps an undateable intent, because there it was PROVABLY never
    // sent. Here a live broker order exists: "cannot prove it is recent" must
    // never authorise cancelling it. Fail closed, in the other direction.
    delete (acct.getState().openOptions[0].pendingExit as { submittedAt?: number }).submittedAt;
    vi.advanceTimersByTime(WORKING_AGE_MS * 10);
    expect(acct.listStaleWorkingExits()).toHaveLength(0);
    expect(acct.getState().openOptions[0].pendingExit).toBeDefined();
  });

  // ── Churn budget ──

  it('stops selecting a row after its withdrawal budget is spent', () => {
    const { acct, sym } = latchUnfillableTp1();
    for (let i = 0; i < MAX_CLEARS_PER_ROW; i += 1) {
      vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
      const stale = acct.listStaleWorkingExits();
      expect(stale).toHaveLength(1);
      expect(acct.noteStaleWorkingExitCleared(stale[0])).toBe(true);
      // The row re-stages the same TP1 at a fresh price and it fails to fill
      // again — the loop this budget exists to bound.
      acct.checkExits(new Map(), new Map([[sym, 1.6]]), 'demo', { waitAndHold: true });
      acct.attachPendingExit(acct.getState().openOptions[0].id, 900_000 + i, 1.6);
    }
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    // Budget spent. The latch is LEFT ALONE on purpose: a row the engine cannot
    // price into the market is a human decision, not a ninth automated retry.
    expect(acct.listStaleWorkingExits()).toHaveLength(0);
    expect(acct.getState().openOptions[0].pendingExit).toBeDefined();
    expect(acct.getStaleWorkingExitStats().clearedTotal).toBe(MAX_CLEARS_PER_ROW);
  });

  // ── Telemetry ──

  it('counts live withdrawals separately — only that half had real money detached', () => {
    const live = latchUnfillableTp1('live');
    const demo = latchUnfillableTp1('demo');
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    live.acct.noteStaleWorkingExitCleared(live.acct.listStaleWorkingExits()[0]);
    demo.acct.noteStaleWorkingExitCleared(demo.acct.listStaleWorkingExits()[0]);

    expect(live.acct.getStaleWorkingExitStats()).toMatchObject({
      clearedTotal: 1,
      clearedLiveTotal: 1,
      holdAttemptsTotal: 0,
    });
    expect(demo.acct.getStaleWorkingExitStats()).toMatchObject({
      clearedTotal: 1,
      clearedLiveTotal: 0,
    });
    expect(live.acct.getStaleWorkingExitStats().lastClearedAt).toBe(Date.now());
  });

  it('counts a failed withdrawal ATTEMPT, and the row it left detached', () => {
    const { acct } = latchUnfillableTp1('live');
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    // The cancel threw, or the broker would not confirm it terminal-and-unfilled.
    acct.noteStaleWorkingExitHeld();
    expect(acct.getStaleWorkingExitStats()).toMatchObject({
      clearedTotal: 0,
      holdAttemptsTotal: 1,
      // Still latched, still detached — which is why it has to be countable
      // rather than inferred from the absence of a cleared count.
      detachedRows: 1,
      detachedRowsLive: 1,
      // ...but the withdrawal path will try again next tick, so no human is
      // needed yet. That distinction is the whole of TRA-3048.
      budgetExhausted: 0,
    });
    expect(acct.getState().openOptions[0].pendingExit).toBeDefined();
  });

  it('counts nothing when the latch resolved for real between query and cancel', () => {
    const { acct, id } = latchUnfillableTp1();
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    const [stale] = acct.listStaleWorkingExits();
    // A fill landed on another path first. That is not a detachment, and
    // counting it would inflate the defect rate with successful exits.
    expect(acct.finalizePendingExit(id, 1.6)).not.toBeNull();
    expect(acct.noteStaleWorkingExitCleared(stale)).toBe(false);
    expect(acct.getStaleWorkingExitStats().clearedTotal).toBe(0);
  });

  // ── TRA-3048 — the gauge the counter was mistaken for ──
  //
  // `held` shipped documented as "positions the automation has given up on"
  // and implemented as a monotonic count of failed withdrawal attempts. It was
  // wrong in both directions at once, and these four tests pin both:
  //   • 0 with a position permanently stranded (budget spent — that row never
  //     reaches the withdrawal path, so nothing can increment for it);
  //   • non-zero with nothing stranded (a throw that succeeded next tick).
  // The fix does not repair the counter — a rate is a fine thing to count. It
  // adds the gauge that answers the question the operator was told to ask.

  it('sees the budget-exhausted row the attempt counter structurally cannot', () => {
    const { acct, sym } = latchUnfillableTp1('live');
    for (let i = 0; i < MAX_CLEARS_PER_ROW; i += 1) {
      vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
      acct.noteStaleWorkingExitCleared(acct.listStaleWorkingExits()[0]);
      acct.checkExits(new Map(), new Map([[sym, 1.6]]), 'live', { waitAndHold: true });
      acct.attachPendingExit(acct.getState().openOptions[0].id, 900_000 + i, 1.6);
    }
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);

    // The selector correctly stops retrying...
    expect(acct.listStaleWorkingExits()).toHaveLength(0);
    // ...so no withdrawal is attempted, so no attempt can fail, so the counter
    // reads zero — on a live position with every exit rule off and no automated
    // path that will ever arm them again. This is the state the field existed
    // to make visible and the one state it could not see.
    const stats = acct.getStaleWorkingExitStats();
    expect(stats.holdAttemptsTotal).toBe(0);
    expect(stats).toMatchObject({
      detachedRows: 1,
      detachedRowsLive: 1,
      budgetExhausted: 1,
      budgetExhaustedLive: 1,
    });
  });

  it('falls back to zero when a transient failure heals, while the counter does not', () => {
    const { acct } = latchUnfillableTp1('live');
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    acct.noteStaleWorkingExitHeld();
    expect(acct.getStaleWorkingExitStats().detachedRows).toBe(1);

    // Next tick the cancel goes through. The position is fine.
    expect(acct.noteStaleWorkingExitCleared(acct.listStaleWorkingExits()[0])).toBe(true);
    const stats = acct.getStaleWorkingExitStats();
    expect(stats).toMatchObject({ detachedRows: 0, budgetExhausted: 0, clearedTotal: 1 });
    // The counter still reads 1 and will for the rest of the boot. That is
    // correct FOR A RATE and false for a gauge — which is why they are now two
    // fields with two names.
    expect(stats.holdAttemptsTotal).toBe(1);
  });

  it('counts attempts per tick, not positions — `holdAttempts: 3` is one row, three ticks', () => {
    const { acct } = latchUnfillableTp1('live');
    vi.advanceTimersByTime(WORKING_AGE_MS + 1_000);
    for (let i = 0; i < 3; i += 1) acct.noteStaleWorkingExitHeld();
    const stats = acct.getStaleWorkingExitStats();
    expect(stats.holdAttemptsTotal).toBe(3);
    // Nothing in the payload used to carry this, so a reader had no way to
    // convert ticks to positions. Now it does.
    expect(stats.detachedRows).toBe(1);
  });

  it('reads zero while the order is inside the age gate — a working order is not detached', () => {
    const { acct } = latchUnfillableTp1('live');
    vi.advanceTimersByTime(WORKING_AGE_MS - 1_000);
    expect(acct.getStaleWorkingExitStats()).toMatchObject({
      detachedRows: 0,
      budgetExhausted: 0,
    });
  });
});
