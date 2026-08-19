// TRA-2819 — a staged exit that never reached the broker was a PERMANENT,
// INVISIBLE strand, and it disarmed the position it sat on.
//
// `checkExits({ waitAndHold: true })` stages `pendingExit` with
// `tradierOrderId: ''`; `submitStagedOptionExits` is supposed to either attach
// a real order id or clear the intent. When that pair breaks — the submit half
// returning early on a null `tradierLiveClient` (a mid-pass `mode` flip, the
// TRA-2693 bistable window), or the process dying between the two — the
// unattached intent survives, and then every automated path declines to touch
// it for a locally-correct reason that is wrong in aggregate:
//
//   • `resolvePendingOptionExits` skips it — nothing to poll without an id;
//   • the TRA-2799 broker-flat sweep skips it — `pendingExit` rows are
//     "owned by the pollers", which this one is not;
//   • `checkExits` itself skips it (`if (opt.pendingExit) continue`), so SL /
//     TP1 / trail / chandelier all stop being evaluated on a live position;
//   • `stageManualPendingExit` refuses to re-stage over it, so the user's own
//     Close button is blocked too.
//
// The only escape was a human noticing and clicking cancel-pending-exit. That
// is the 4-day phantom TRA-2819 measured with real money on 2026-07-31.
//
// These tests pin the reaper: unattached-and-aged intents are cleared, ATTACHED
// intents are never touched, the reap does not trip the TRA-450 auto-close
// breaker, and the freed row is genuinely back under management on every one of
// the four paths above.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OtmMispricingSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

// 10:00 AM ET = 14:00 UTC during EDT. Pinned to a Tuesday so the weekday /
// trading-window predicates pass.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// Mirrors the constant in options-account.ts. Deliberately re-stated rather
// than imported: if someone shortens the production gate, these tests should
// fail and force the decision to be re-argued, not silently follow it.
const REAP_AGE_MS = 30 * 60_000;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-2819',
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

describe('TRA-2819 — abandoned staged exits are reaped, not left to strand', () => {
  /** Entry: premiumPaid 1.0, SL 0.80, TP1 1.50. */
  function openCall(mode: 'demo' | 'live' = 'demo'): {
    acct: PaperOptionsAccount;
    sym: string;
    id: string;
  } {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), mode, undefined, 200);
    expect(pos).not.toBeNull();
    return { acct, sym: pos!.optionSymbol!, id: pos!.id };
  }

  /**
   * Reproduce the exact production state: an SL trigger stages an intent under
   * wait-and-hold, and the submit half never runs. No test-only mutation — the
   * strand is produced by the real staging path and then simply not followed.
   */
  function strand(mode: 'demo' | 'live' = 'demo') {
    const { acct, sym, id } = openCall(mode);
    const staged = acct.checkExits(new Map(), new Map([[sym, 0.7]]), mode, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(staged[0].pendingExit?.tradierOrderId).toBe('');
    return { acct, sym, id };
  }

  it('leaves an unattached intent alone while it is still inside the age gate', () => {
    const { acct, id } = strand();
    vi.advanceTimersByTime(REAP_AGE_MS - 1_000);
    expect(acct.reapAbandonedStagedExits()).toHaveLength(0);
    expect(acct.getState().openOptions[0].pendingExit).toBeDefined();
    expect(acct.getAbandonedStagedExitStats().reapedTotal).toBe(0);
    // A slow submit must be able to land on a merely-old intent.
    expect(acct.attachPendingExit(id, 4242)).toBe(true);
  });

  it('reaps an unattached intent once it is older than the age gate', () => {
    const { acct, sym } = strand();
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);

    const reaped = acct.reapAbandonedStagedExits();
    expect(reaped).toHaveLength(1);
    expect(reaped[0].optionSymbol).toBe(sym);
    expect(reaped[0].kind).toBe('sl');
    expect(reaped[0].ageMs).toBeGreaterThan(REAP_AGE_MS);

    const row = acct.getState().openOptions[0];
    expect(row.pendingExit).toBeUndefined();
    // Durable evidence on the row itself — the counter resets on restart, this
    // does not.
    expect(row.exitErrorReason).toMatch(/never submitted to Tradier/i);
    expect(row.exitErrorReason).toMatch(/TRA-2819/);
  });

  it('never touches an intent that DID reach the broker, however old', () => {
    const { acct, id } = strand();
    expect(acct.attachPendingExit(id, 998877)).toBe(true);
    // Ten times the age gate. An attached intent is owned by
    // `resolvePendingOptionExits`, which books the real fill price; reaping it
    // would re-arm an exit against a position the broker is already selling.
    vi.advanceTimersByTime(REAP_AGE_MS * 10);

    expect(acct.reapAbandonedStagedExits()).toHaveLength(0);
    expect(acct.getState().openOptions[0].pendingExit?.tradierOrderId).toBe(998877);
  });

  it('does NOT advance the TRA-450 auto-close breaker — nothing was ever sent', () => {
    const { acct } = strand();
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);
    expect(acct.reapAbandonedStagedExits()).toHaveLength(1);
    // `closeRejectCount` gates re-staging in `checkExits`. Counting a reap
    // would pause auto-close on exactly the position that just proved it needs
    // it — the strand made worse, not better.
    expect(acct.getState().openOptions[0].closeRejectCount).toBeUndefined();
  });

  // The four paths the strand disarmed. Each is the real cost of the bug.

  it('restores exit evaluation — the stop loss is evaluated again after the reap', () => {
    const { acct, sym } = strand();
    const marks = new Map([[sym, 0.7]]);

    // While stranded, `checkExits` skips the row outright: the mark is far
    // below the 0.80 stop and NOTHING fires. This is the disarm.
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);
    expect(acct.checkExits(new Map(), marks, 'demo')).toHaveLength(0);
    expect(acct.getState().openOptions).toHaveLength(1);

    expect(acct.reapAbandonedStagedExits()).toHaveLength(1);

    const closed = acct.checkExits(new Map(), marks, 'demo');
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl');
  });

  it("restores the user's Close button — stageManualPendingExit works again", () => {
    const { acct, id } = strand();
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);

    // Blocked by the strand: `stageManualPendingExit` refuses to stomp an
    // "in-flight" intent that is not in flight at all.
    expect(acct.stageManualPendingExit(id, 1, 0.9)).toBeNull();

    expect(acct.reapAbandonedStagedExits()).toHaveLength(1);
    expect(acct.stageManualPendingExit(id, 1, 0.9)).not.toBeNull();
  });

  it('restores the TRA-2799 broker-flat sweep on a live row', () => {
    const { acct } = strand('live');
    // Past both the reap gate and BROKER_MISSING_MIN_AGE_MS (5 min).
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);

    // Stranded: the sweep skips `pendingExit` rows, so two empty payloads —
    // the broker plainly reporting flat — close nothing. This is the phantom.
    const empty: TradierOpenOptionPosition[] = [];
    expect(acct.reconcileTradierPositions(empty, 'live').removed).toBe(0);
    expect(acct.reconcileTradierPositions(empty, 'live').removed).toBe(0);
    expect(acct.getState().openOptions).toHaveLength(1);

    expect(acct.reapAbandonedStagedExits()).toHaveLength(1);

    // Freed: BROKER_MISSING_SWEEPS_TO_CLOSE is 2, so the second sweep closes it.
    expect(acct.reconcileTradierPositions(empty, 'live').removed).toBe(0);
    expect(acct.reconcileTradierPositions(empty, 'live').removed).toBe(1);
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('counts live reaps separately — only that half had real money exposed', () => {
    const live = strand('live');
    const demo = strand('demo');
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);

    live.acct.reapAbandonedStagedExits();
    demo.acct.reapAbandonedStagedExits();

    expect(live.acct.getAbandonedStagedExitStats()).toMatchObject({
      reapedTotal: 1,
      reapedLiveTotal: 1,
    });
    expect(demo.acct.getAbandonedStagedExitStats()).toMatchObject({
      reapedTotal: 1,
      reapedLiveTotal: 0,
    });
    expect(live.acct.getAbandonedStagedExitStats().lastReapedAt).toBe(Date.now());
  });

  it('reaps an intent that cannot date itself, rather than skipping it forever', () => {
    const { acct } = strand();
    // A snapshot persisted before `submittedAt` existed, or corrupted since.
    // Skipping it "because we cannot tell if it is recent" would rebuild the
    // exact strand on the one shape nothing else can clear either — the
    // locally-correct skip that is wrong in aggregate, one more time.
    delete (acct.getState().openOptions[0].pendingExit as { submittedAt?: number }).submittedAt;

    const reaped = acct.reapAbandonedStagedExits();
    expect(reaped).toHaveLength(1);
    expect(acct.getState().openOptions[0].pendingExit).toBeUndefined();
    expect(acct.getState().openOptions[0].exitErrorReason).toMatch(/no staging timestamp/i);
  });

  it('is idempotent — a second pass over a reaped book finds nothing', () => {
    const { acct } = strand();
    vi.advanceTimersByTime(REAP_AGE_MS + 1_000);
    expect(acct.reapAbandonedStagedExits()).toHaveLength(1);
    expect(acct.reapAbandonedStagedExits()).toHaveLength(0);
    expect(acct.getAbandonedStagedExitStats().reapedTotal).toBe(1);
  });
});
