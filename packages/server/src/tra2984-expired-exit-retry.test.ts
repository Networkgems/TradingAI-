// TRA-2984 — a live `sell_to_close` expired unfilled and NOTHING followed up.
//
// The production state, read off bqb1 on 2026-08-06: TSLA260911C00555000 ×4,
// mode `live`, still OPEN, `exitErrorReason: "Tradier sell_to_close expired"`,
// `closeRejectCount: 1`, `trailingActive: true`, `trailingStopPremium: 0.3017`
// against a mark of `0.275` — i.e. the trailing stop was BREACHED and the
// position was running anyway.
//
// Three separate defects met on that row:
//
//  1. An expiry was counted as a broker REJECTION. It is the opposite failure:
//     a rejection means the broker refuses this contract (stop trying), an
//     expiry means our own limit was never hit (try harder). Sharing
//     `closeRejectCount` meant three no-fill sessions would trip the TRA-450
//     breaker and permanently detach the exit rules from a live position under
//     a breached stop — while the broker had never refused anything.
//
//  2. The "retry" was the SAME ORDER AGAIN. The next session re-staged an
//     identical LIMIT at a price the market had already declined, which lapses
//     the same way. A repeat is not a retry.
//
//  3. It was invisible. An order that never fills appends NO row to the
//     fee/slippage ledger, so every monitor that grades on ledger rows scored
//     the position healthy — "no exit row" is also what a position that never
//     tried to exit looks like. The only surface was a free-text string on the
//     authenticated `/api/state`, which nothing polled.
//
// These tests pin all three, and each one is written so that REMOVING the fix
// changes the assertion rather than leaving it vacuously true — the escalation
// tests assert `pricing`, which is `'limit'` in the broken build and `'market'`
// in the fixed one, on the same staged intent.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PaperOptionsAccount,
  summarizeLiveExitErrors,
} from './options-account.js';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';

// 10:00 AM ET = 14:00 UTC during EDT, pinned to a Tuesday so weekday /
// trading-window predicates pass.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const NEXT_SESSION = Date.parse('2024-06-05T14:00:00Z');

// Mirrors the constant in options-account.ts. Deliberately re-stated rather
// than imported: if someone widens the production gate, this should FAIL and
// force the decision to be re-argued, not silently follow it.
const MAX_CONSECUTIVE_EXIT_EXPIRIES = 3;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-2984',
    symbol: 'TSLA',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'TSLA240705C00555000',
    optionType: 'call',
    strike: 555,
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

describe('TRA-2984 — an exit that expired unfilled is retried, escalated, and counted', () => {
  /** Entry: premiumPaid 1.0, SL 0.80. Opened on a DEMO book unless asked. */
  function openCall(mode: 'demo' | 'live' = 'demo') {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), mode, undefined, 200);
    expect(pos).not.toBeNull();
    return { acct, sym: pos!.optionSymbol!, id: pos!.id };
  }

  /**
   * Drive the REAL staging path to a breached stop, then resolve the staged
   * order the way Tradier resolved the production one: expired, unfilled.
   *
   * No test-only mutation of the position — the state under test is produced by
   * `checkExits` + `clearPendingExit`, which is exactly the pair that ran on
   * bqb1.
   */
  function stageThenExpire(acct: PaperOptionsAccount, sym: string, id: string, mark = 0.7) {
    const staged = acct.checkExits(new Map(), new Map([[sym, mark]]), undefined, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(acct.attachPendingExit(id, 139775135)).toBe(true);
    expect(acct.clearPendingExit(id, 'Tradier sell_to_close expired', { expired: true })).toBe(true);
    return staged[0];
  }

  function row(acct: PaperOptionsAccount): OptionPosition {
    return acct.getState().openOptions[0];
  }

  it('does NOT charge an expiry to the TRA-450 rejection breaker', () => {
    const { acct, sym, id } = openCall();
    stageThenExpire(acct, sym, id);

    const r = row(acct);
    // The production row had `closeRejectCount: 1` from a single expiry — two
    // more sessions from disarming its own stop. That is the bug.
    expect(r.closeRejectCount).toBeUndefined();
    expect(r.exitExpiredCount).toBe(1);
    expect(r.exitErrorReason).toBe('Tradier sell_to_close expired');
  });

  it('escalates the NEXT stop re-stage from LIMIT to MARKET', () => {
    const { acct, sym, id } = openCall();
    const first = stageThenExpire(acct, sym, id);
    // The order that lapsed was an ordinary limit — this is the control.
    expect(first.pendingExit?.pricing).toBe('limit');

    vi.setSystemTime(NEXT_SESSION);
    const retry = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });

    expect(retry).toHaveLength(1);
    // The discriminator. Without the escalation this is `'limit'` — the same
    // order, at the same price the market already declined, which lapses again.
    expect(retry[0].pendingExit?.pricing).toBe('market');
    expect(retry[0].pendingExit?.kind).toBe('sl');
    expect(acct.getExpiredExitStats().escalatedTotal).toBe(1);
  });

  it('does NOT escalate a take-profit — an unfilled TP1 costs upside, not safety', () => {
    const { acct, sym, id } = openCall();
    // Run the position into TP1 territory (premiumPaid 1.0, tp1 at +50%) with
    // enough contracts for a partial.
    const staged = acct.checkExits(new Map(), new Map([[sym, 2.0]]), undefined, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(staged[0].pendingExit?.kind).toBe('tp1');
    expect(acct.attachPendingExit(id, 1)).toBe(true);
    expect(acct.clearPendingExit(id, 'Tradier sell_to_close expired', { expired: true })).toBe(true);
    expect(row(acct).exitExpiredCount).toBe(1);

    vi.setSystemTime(NEXT_SESSION);
    const retry = acct.checkExits(new Map(), new Map([[sym, 2.0]]), undefined, { waitAndHold: true });
    expect(retry).toHaveLength(1);
    expect(retry[0].pendingExit?.kind).toBe('tp1');
    // Crossing the spread to capture a partial profit is a worse trade than
    // waiting for the mark to come back. Only risk-reducing legs escalate.
    expect(retry[0].pendingExit?.pricing).toBe('limit');
    expect(acct.getExpiredExitStats().escalatedTotal).toBe(0);
  });

  it('stops staging after MAX_CONSECUTIVE_EXIT_EXPIRIES and says on the row that it stopped', () => {
    const { acct, sym, id } = openCall();
    for (let i = 0; i < MAX_CONSECUTIVE_EXIT_EXPIRIES; i += 1) {
      vi.setSystemTime(TRADING_TIME + i * 86_400_000);
      stageThenExpire(acct, sym, id);
    }
    expect(row(acct).exitExpiredCount).toBe(MAX_CONSECUTIVE_EXIT_EXPIRIES);

    vi.setSystemTime(TRADING_TIME + 10 * 86_400_000);
    const after = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(after).toHaveLength(0);
    expect(row(acct).pendingExit).toBeUndefined();

    // "expired" alone reads as "it will go again next session". After this
    // point it will not, and the row has to say so — this is the difference
    // between a position waiting on the engine and one waiting on a human.
    expect(row(acct).exitErrorReason).toMatch(/auto-close paused/i);
    expect(row(acct).exitErrorReason).toMatch(/expired unfilled/i);
  });

  it('a fill clears the expiry counter so a later exit does not cross the spread on a stale lapse', () => {
    const { acct, sym, id } = openCall();
    stageThenExpire(acct, sym, id);
    expect(row(acct).exitExpiredCount).toBe(1);

    // Re-stage (escalated) and let this one FILL.
    vi.setSystemTime(NEXT_SESSION);
    const retry = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(retry).toHaveLength(1);
    expect(acct.attachPendingExit(id, 2)).toBe(true);
    expect(acct.finalizePendingExit(id, 0.7)).not.toBeNull();

    // Row is closed out here; the counter must not survive onto the archive
    // snapshot either.
    const closed = acct.getState().closedOptions.at(-1)!;
    expect(closed.exitExpiredCount).toBeUndefined();
  });

  it('a user re-stage clears the expiry counter — their order, their pricing', () => {
    const { acct, sym, id } = openCall();
    stageThenExpire(acct, sym, id);
    expect(row(acct).exitExpiredCount).toBe(1);

    expect(acct.stageManualPendingExit(id, row(acct).contractsRemaining, 0.7)).not.toBeNull();
    expect(row(acct).exitExpiredCount).toBeUndefined();
    expect(row(acct).exitErrorReason).toBeUndefined();
  });

  it('counts live expiries separately from demo ones', () => {
    const demo = openCall('demo');
    stageThenExpire(demo.acct, demo.sym, demo.id);
    expect(demo.acct.getExpiredExitStats()).toMatchObject({ expiredTotal: 1, expiredLiveTotal: 0 });

    const live = openCall('live');
    // TRA-483 holds a live position opened TODAY, so the exit can only stage on
    // a later session — which is also how the production row got there.
    vi.setSystemTime(NEXT_SESSION);
    stageThenExpire(live.acct, live.sym, live.id);
    expect(live.acct.getExpiredExitStats()).toMatchObject({ expiredTotal: 1, expiredLiveTotal: 1 });
  });
});

describe('TRA-2984 — summarizeLiveExitErrors makes `exitErrorReason` countable', () => {
  function pos(overrides: Partial<OptionPosition>): OptionPosition {
    return {
      id: 'p',
      symbol: 'TSLA',
      optionSymbol: 'TSLA260911C00555000',
      optionType: 'call',
      strike: 555,
      expiration: '2026-09-11',
      contracts: 4,
      contractsRemaining: 4,
      premiumPaid: 0.27,
      currentPremium: 0.275,
      tp1Premium: null,
      tp1Hit: false,
      stopLossPremium: 0,
      peakPremium: 0.355,
      trailingActive: true,
      trailingStopPremium: 0.3017,
      openedAt: TRADING_TIME,
      mode: 'live',
      ...overrides,
    } as OptionPosition;
  }

  it('counts the production row — one live position with a failed, unresolved exit', () => {
    // These are the exact fields bqb1 was serving on 2026-08-06.
    const s = summarizeLiveExitErrors([pos({ exitErrorReason: 'Tradier sell_to_close expired', exitExpiredCount: 1 })]);
    expect(s).toEqual({ total: 1, expired: 1, stagingStopped: 0 });
  });

  it('is 0 on a clean book — the count must be able to be right, not just non-zero', () => {
    expect(summarizeLiveExitErrors([pos({})])).toEqual({ total: 0, expired: 0, stagingStopped: 0 });
  });

  it('ignores the demo book — this route exists to watch real money', () => {
    const s = summarizeLiveExitErrors([
      pos({ mode: 'demo', exitErrorReason: 'Tradier sell_to_close expired', exitExpiredCount: 1 }),
    ]);
    expect(s).toEqual({ total: 0, expired: 0, stagingStopped: 0 });
  });

  it('flags a row the engine has GIVEN UP on, via either breaker', () => {
    const byExpiry = summarizeLiveExitErrors([
      pos({ exitErrorReason: 'auto-close paused …', exitExpiredCount: MAX_CONSECUTIVE_EXIT_EXPIRIES }),
    ]);
    expect(byExpiry.stagingStopped).toBe(1);

    const byRejection = summarizeLiveExitErrors([
      pos({ exitErrorReason: 'auto-close paused …', closeRejectCount: 3 }),
    ]);
    expect(byRejection.stagingStopped).toBe(1);
    // A rejection is not an expiry — the two must stay distinguishable here too.
    expect(byRejection.expired).toBe(0);
  });

  it('separates a closed row from an open one', () => {
    const s = summarizeLiveExitErrors([
      pos({ exitErrorReason: 'Tradier sell_to_close expired', exitExpiredCount: 1, closedAt: TRADING_TIME }),
    ]);
    expect(s.total).toBe(0);
  });
});
