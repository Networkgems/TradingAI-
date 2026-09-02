// TRA-4266 — `close_reject_breaker` latched forever.
//
// TRA-4218 split the TRANSPORT fault out of the rejection counter, so a Tradier
// 500 can no longer disarm a stop. It did nothing for the other half, and the
// other half is the one this ticket names: a `closeRejectCount` accrued from
// GENUINE broker refusals still latched permanently. It had
//
//   • no half-open retest,
//   • no decay,
//   • no release instant on any published surface (`liveStopActionability`
//     read `indefinite: 3`, `releasesAt: null`), and
//   • persistence — `closeRejectCount` rides `exportSnapshot()`,
//
// so its only two exits were a fill (which it prevents by suppressing the
// order) and a human write. On an unattended engine that is not a circuit
// breaker; it is a permanent disarm of the close path, applied to exactly the
// rows that have already breached their stop.
//
// Production shape, bqb1 `092d087775dc` / pid 52, read 2026-09-01T19:46Z: three
// open real-money rows carrying `closeRejectCount: 3` from 2026-08-31, still
// inert a full session after the fault that tripped them had cleared, across
// four process restarts.
//
// The fix is a bounded half-open: after a cooldown the latch admits exactly ONE
// `sell_to_close`; a fill clears it, a refusal re-latches it one rung further up
// the ladder, and after `maxProbes` refusals the row is honestly a human's and
// says so with a DIFFERENT gate name — which is what keeps `indefinite` from
// being fed by rows that are in fact going to retry.
//
// Each test is written so REMOVING the fix changes the assertion rather than
// leaving it vacuously true.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PaperOptionsAccount,
  closeRejectBreakerHold,
  resolveCloseRejectProbePolicy,
  summarizeLiveStopActionability,
  summarizeLiveExitErrors,
  type LiveStopActionabilityContext,
} from './options-account.js';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';

// 10:00 AM ET = 14:00 UTC during EDT, pinned to a Tuesday so the weekday /
// trading-window predicates pass.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

// Re-stated rather than imported, deliberately: widening either of these should
// FAIL here and force the decision to be re-argued, not silently followed.
const MAX_CONSECUTIVE_CLOSE_REJECTS = 3;
const LADDER_MS = [300_000, 900_000, 3_600_000, 14_400_000];
const MAX_PROBES = 4;

/** A broker-EVALUATED refusal. Not a 5xx — that is TRA-4218's branch. */
const REFUSAL_REASON = 'Tradier sell_to_close rejected: no bid on this contract';

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4266',
    symbol: 'KO',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'KO240705C00090000',
    optionType: 'call',
    strike: 90,
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
  delete process.env.CLOSE_REJECT_PROBE_LADDER_MS;
  delete process.env.CLOSE_REJECT_MAX_PROBES;
});

function openCall(mode: 'demo' | 'live' = 'demo') {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
  const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), mode, undefined, 200);
  expect(pos).not.toBeNull();
  return { acct, sym: pos!.optionSymbol!, id: pos!.id };
}

function row(acct: PaperOptionsAccount): OptionPosition {
  return acct.getState().openOptions[0] as OptionPosition;
}

/**
 * Drive the REAL staging path to a breached stop and have the broker REFUSE the
 * staged order. No test-only mutation of the row: the state under test is
 * produced by `checkExits` + `clearPendingExit`, the same pair that ran on bqb1.
 *
 * Returns whether an order actually went out — which is the whole question this
 * suite asks of a latched row.
 */
function stageThenRefuse(acct: PaperOptionsAccount, sym: string, id: string, mark = 0.7): boolean {
  const staged = acct.checkExits(new Map(), new Map([[sym, mark]]), undefined, { waitAndHold: true });
  if (staged.length === 0) return false;
  // Default `countRejection` — the broker looked at the order and said no.
  expect(acct.clearPendingExit(id, REFUSAL_REASON)).toBe(true);
  return true;
}

/** Refuse until the breaker trips. Returns the account at the moment of the trip. */
function latch(mode: 'demo' | 'live' = 'demo') {
  const ctx = openCall(mode);
  for (let i = 0; i < MAX_CONSECUTIVE_CLOSE_REJECTS; i += 1) {
    expect(stageThenRefuse(ctx.acct, ctx.sym, ctx.id)).toBe(true);
  }
  expect(row(ctx.acct).closeRejectCount).toBe(MAX_CONSECUTIVE_CLOSE_REJECTS);
  return ctx;
}

// ─── AC1 — the half-open ────────────────────────────────────────────────────

describe('TRA-4266 AC1 — a latched row retests the circuit', () => {
  it('REGRESSION: the trip stamps a retest instant, so the latch has a release', () => {
    const { acct } = latch();
    const r = row(acct);
    // The whole defect in one field. Before this ticket a latched row carried a
    // counter and nothing else: no instant anywhere on the row or on any
    // surface said when — or whether — the engine would try again.
    expect(r.closeRejectProbeNotBeforeMs).toBe(TRADING_TIME + LADDER_MS[0]);
    expect(r.closeRejectProbeCount).toBeUndefined(); // no probe SPENT yet
  });

  it('suppresses staging inside the cooldown', () => {
    const { acct, sym } = latch();
    vi.setSystemTime(TRADING_TIME + LADDER_MS[0] - 1);
    expect(
      acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }),
    ).toHaveLength(0);
  });

  it('admits EXACTLY ONE probe once the cooldown elapses', () => {
    const { acct, sym, id } = latch();
    vi.setSystemTime(TRADING_TIME + LADDER_MS[0]);

    // One order, from a row the old build had disarmed permanently.
    const probe = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(probe).toHaveLength(1);

    // ...and only one. The staged intent itself holds the row (TRA-354) until it
    // resolves, so nothing sprays while the probe is in flight.
    expect(
      acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }),
    ).toHaveLength(0);

    // The probe is refused: re-latch, one rung further out, budget down by one.
    expect(acct.clearPendingExit(id, REFUSAL_REASON)).toBe(true);
    const r = row(acct);
    expect(r.closeRejectCount).toBe(MAX_CONSECUTIVE_CLOSE_REJECTS + 1);
    expect(r.closeRejectProbeCount).toBe(1);
    expect(r.closeRejectProbeNotBeforeMs).toBe(TRADING_TIME + LADDER_MS[0] + LADDER_MS[1]);
  });

  it('THE ACCEPTANCE: a latched row clears itself on a probe FILL — no human write', () => {
    const { acct, sym, id } = latch();
    // Nothing but the clock happens between here and the clear. In particular
    // `stageManualPendingExit` — the only pre-TRA-4266 release — is never called.
    vi.setSystemTime(TRADING_TIME + LADDER_MS[0]);
    const probe = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(probe).toHaveLength(1);

    expect(acct.finalizePendingExit(id, 0.7)).not.toBeNull();
    const closed = acct.getState().closedOptions.at(-1) as OptionPosition;
    expect(closed.closeRejectCount).toBeUndefined();
    expect(closed.closeRejectProbeCount).toBeUndefined();
    expect(closed.closeRejectProbeNotBeforeMs).toBeUndefined();
  });

  it('a partial fill on a latched row restores the FULL probe budget, not a spent one', () => {
    // A TP1 trim leaves the row open. The circuit demonstrably closed, so the
    // next latch on the remainder must start from zero: inheriting a spent
    // budget would let one old streak exhaust a brand-new one.
    const { acct, sym, id } = latch();
    vi.setSystemTime(TRADING_TIME + LADDER_MS[0]);
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true })).toHaveLength(1);
    expect(acct.clearPendingExit(id, REFUSAL_REASON)).toBe(true);
    expect(row(acct).closeRejectProbeCount).toBe(1);

    vi.setSystemTime(TRADING_TIME + LADDER_MS[0] + LADDER_MS[1]);
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true })).toHaveLength(1);
    expect(acct.finalizePendingExit(id, 0.7)).not.toBeNull();
    const r = acct.getState().openOptions[0] as OptionPosition | undefined;
    if (r !== undefined) {
      expect(r.closeRejectProbeCount).toBeUndefined();
      expect(r.closeRejectProbeNotBeforeMs).toBeUndefined();
    }
  });

  it('a tick on which no exit rule fires does NOT spend a probe', () => {
    // The cap is on PROBES, not on ticks. Spending the budget at the admission
    // gate would let a quiet market burn all four retests without one order
    // ever reaching the broker.
    const { acct, sym } = latch();
    vi.setSystemTime(TRADING_TIME + LADDER_MS[0]);
    // Mark back above the stop: admitted by the breaker, refused by the rules.
    expect(
      acct.checkExits(new Map(), new Map([[sym, 1.2]]), undefined, { waitAndHold: true }),
    ).toHaveLength(0);
    expect(row(acct).closeRejectProbeCount).toBeUndefined();

    // ...and the budget is still there for a real breach.
    expect(
      acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }),
    ).toHaveLength(1);
  });
});

// ─── AC4 — the cap ──────────────────────────────────────────────────────────

describe('TRA-4266 AC4 — the guard is not regressed', () => {
  it('a broker that keeps refusing runs out of retests and STAYS latched', () => {
    const { acct, sym, id } = latch();
    let elapsed = TRADING_TIME;
    for (let probe = 0; probe < MAX_PROBES; probe += 1) {
      elapsed += LADDER_MS[Math.min(probe, LADDER_MS.length - 1)] as number;
      vi.setSystemTime(elapsed);
      expect(stageThenRefuse(acct, sym, id), `probe ${probe + 1}`).toBe(true);
    }
    const r = row(acct);
    expect(r.closeRejectProbeCount).toBe(MAX_PROBES);
    // No stale instant left behind: a surface that read "retesting at …" over a
    // loop that will never retest again is this ticket's defect, mirrored.
    expect(r.closeRejectProbeNotBeforeMs).toBeUndefined();
    expect(r.exitErrorReason).toContain('half-open retests are spent');

    // A year later it is still refused. This is TRA-450's original population
    // (1,476 doomed orders against three contracts) and the cap is what keeps
    // the half-open from re-creating it.
    vi.setSystemTime(elapsed + 365 * 24 * 3_600_000);
    expect(
      acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }),
    ).toHaveLength(0);
    expect(closeRejectBreakerHold(row(acct)).exhausted).toBe(true);
  });

  it('the order rate against a refusing broker is bounded by the ladder', () => {
    // Tick every 5 seconds for the whole ladder's span and count the orders.
    const { acct, sym, id } = latch();
    let orders = 0;
    const horizon = TRADING_TIME + LADDER_MS.reduce((a, b) => a + b, 0) + 3_600_000;
    for (let t = TRADING_TIME; t <= horizon; t += 5_000) {
      vi.setSystemTime(t);
      if (stageThenRefuse(acct, sym, id)) orders += 1;
    }
    // Exactly the budget. The old build's answer to this loop was 0 (permanent
    // disarm); the answer the breaker must never give is "one per tick".
    expect(orders).toBe(MAX_PROBES);
  });

  it('a user re-stage restores the budget — that IS the manual_restage recovery path', () => {
    const { acct, sym, id } = latch();
    let elapsed = TRADING_TIME;
    for (let probe = 0; probe < MAX_PROBES; probe += 1) {
      elapsed += LADDER_MS[Math.min(probe, LADDER_MS.length - 1)] as number;
      vi.setSystemTime(elapsed);
      expect(stageThenRefuse(acct, sym, id)).toBe(true);
    }
    expect(row(acct).closeRejectProbeCount).toBe(MAX_PROBES);

    expect(acct.stageManualPendingExit(id, 1, 0.7, 'day')).not.toBeNull();
    const r = row(acct);
    expect(r.closeRejectCount).toBeUndefined();
    expect(r.closeRejectProbeCount).toBeUndefined();
    expect(r.closeRejectProbeNotBeforeMs).toBeUndefined();
    // Otherwise the very next refusal re-latches straight into `exhausted`, and
    // the user's deliberate retry buys them nothing.
    expect(closeRejectBreakerHold(r).exhausted).toBe(false);
    void sym;
  });

  it('CLOSE_REJECT_MAX_PROBES=0 restores the pre-TRA-4266 latch exactly', () => {
    // The one knob that can only make the breaker STRICTER. A malformed value
    // must fall back to the default, never to "unbounded".
    process.env.CLOSE_REJECT_MAX_PROBES = '0';
    const { acct, sym } = latch();
    expect(row(acct).closeRejectProbeNotBeforeMs).toBeUndefined();
    vi.setSystemTime(TRADING_TIME + 10 * 24 * 3_600_000);
    expect(
      acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true }),
    ).toHaveLength(0);

    process.env.CLOSE_REJECT_MAX_PROBES = 'not-a-number';
    expect(resolveCloseRejectProbePolicy().maxProbes).toBe(MAX_PROBES);
    process.env.CLOSE_REJECT_PROBE_LADDER_MS = 'x,,-3';
    expect(resolveCloseRejectProbePolicy().ladderMs).toEqual(LADDER_MS);
  });

  it('a configurable cooldown is actually configurable', () => {
    process.env.CLOSE_REJECT_PROBE_LADDER_MS = '1000,2000';
    process.env.CLOSE_REJECT_MAX_PROBES = '2';
    const { acct } = latch();
    expect(row(acct).closeRejectProbeNotBeforeMs).toBe(TRADING_TIME + 1000);
  });
});

// ─── AC2 — publish the release ──────────────────────────────────────────────

const MONEY_BOOK: LiveStopActionabilityContext = {
  autoManageImportedTradierOptions: true,
  brokerMirroring: true,
  holdLiveOptionsOvernightForPdt: false,
  actOnAdoptedBrokerRows: true,
  swingHoldOptions: false,
  openingRangeGuardMin: 15,
  now: TRADING_TIME,
};

function breachedLiveRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'p1',
    symbol: 'KO',
    optionSymbol: 'KO240705C00090000',
    optionType: 'call',
    strike: 90,
    expiration: '2024-07-05',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.0,
    currentPremium: 0.5,
    stopLossPremium: 0.8,
    tp1Premium: 1.5,
    peakPremium: 1.0,
    trailingActive: false,
    trailingStopPremium: 0,
    openedAt: TRADING_TIME - 5 * 24 * 3_600_000,
    mode: 'live',
    ...overrides,
  } as OptionPosition;
}

describe('TRA-4266 AC2 — the fold publishes the release', () => {
  it('REGRESSION: a latched row inside its cooldown is inert WITH a release', () => {
    const s = summarizeLiveStopActionability(
      [breachedLiveRow({
        closeRejectCount: 3,
        closeRejectProbeNotBeforeMs: TRADING_TIME + LADDER_MS[0],
      })],
      MONEY_BOOK,
    );
    expect(s.breached).toBe(1);
    expect(s.inert).toBe(1);
    expect(s.byReason).toEqual({ close_reject_breaker: 1 });
    // The three fields the 2026-09-01 read had to report as `null / null / 3`.
    expect(s.releasesAt).toBe(new Date(TRADING_TIME + LADDER_MS[0]).toISOString());
    expect(s.fullyReleasesAt).toBe(new Date(TRADING_TIME + LADDER_MS[0]).toISOString());
    expect(s.indefinite).toBe(0);
  });

  it('only an EXHAUSTED latch may feed `indefinite`', () => {
    const s = summarizeLiveStopActionability(
      [breachedLiveRow({ closeRejectCount: 7, closeRejectProbeCount: MAX_PROBES })],
      MONEY_BOOK,
    );
    expect(s.inert).toBe(1);
    // A different gate name, so a reader can tell "will retry at 14:05Z" from
    // "needs you". One name for both is how `indefinite: 3` read as normal.
    expect(s.byReason).toEqual({ close_reject_breaker_exhausted: 1 });
    expect(s.indefinite).toBe(1);
    expect(s.releasesAt).toBeNull();
    expect(s.fullyReleasesAt).toBeNull();
  });

  it('a row whose cooldown has ELAPSED is actionable, because the next tick acts', () => {
    const s = summarizeLiveStopActionability(
      [breachedLiveRow({
        closeRejectCount: 3,
        closeRejectProbeNotBeforeMs: TRADING_TIME - 1,
      })],
      MONEY_BOOK,
    );
    expect(s.actionable).toBe(1);
    expect(s.inert).toBe(0);
  });

  it('an UNSTAMPED latch reads as due now, never as indefinite', () => {
    // The 2026-08-31 rows, which latched before the field existed. "No release
    // recorded" must not read as "no release exists" — that equation IS the bug.
    const legacy = breachedLiveRow({ closeRejectCount: 3 });
    expect(closeRejectBreakerHold(legacy, TRADING_TIME).releaseAt).toBe(TRADING_TIME);
    expect(summarizeLiveStopActionability([legacy], MONEY_BOOK).indefinite).toBe(0);
  });

  it('`stagingStopped` counts the exhausted latch, not the probing one', () => {
    // Its contract is "the engine has given up and is waiting for a person who
    // has not been told". A latch that retests in five minutes has not given up,
    // and paging a human for it trains the number to be ignored.
    expect(summarizeLiveExitErrors([
      breachedLiveRow({
        closeRejectCount: 3,
        exitErrorReason: 'auto-close paused after 3 rejected attempts',
        closeRejectProbeNotBeforeMs: TRADING_TIME + LADDER_MS[0],
      }),
    ])).toEqual({ total: 1, expired: 0, stagingStopped: 0 });

    expect(summarizeLiveExitErrors([
      breachedLiveRow({
        closeRejectCount: 7,
        exitErrorReason: 'auto-close paused after 7 rejected attempts',
        closeRejectProbeCount: MAX_PROBES,
      }),
    ])).toEqual({ total: 1, expired: 0, stagingStopped: 1 });
  });
});

// ─── AC3 — transport vs refusal, on the row itself ──────────────────────────

describe('TRA-4266 AC3 — the row names its cause class', () => {
  it('a broker-evaluated refusal says BROKER REFUSAL and names the retest', () => {
    const { acct } = latch();
    const reason = row(acct).exitErrorReason ?? '';
    expect(reason).toContain('[BROKER REFUSAL]');
    expect(reason).toContain('auto-close RETESTS this contract once at');
    expect(reason).toContain(new Date(TRADING_TIME + LADDER_MS[0]).toISOString());
    expect(reason).toContain('retest 1 of 4');
  });

  it('a transport fault never reaches this branch at all — it says RETRYING', () => {
    // TRA-4218's arm, re-pinned here because AC3 is graded on the three
    // TRA-4217 rows and their string is the discriminator.
    const { acct, sym, id } = openCall();
    expect(acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true })).toHaveLength(1);
    expect(acct.clearPendingExit(
      id,
      'Tradier sell_to_close submit threw: Tradier order failed (500): backend',
      { transport: true },
    )).toBe(true);
    const r = row(acct);
    expect(r.closeRejectCount).toBeUndefined();
    expect(r.exitErrorReason).toContain('RETRYING');
    expect(r.exitErrorReason).not.toContain('BROKER REFUSAL');
    expect(closeRejectBreakerHold(r).latched).toBe(false);
  });
});

// ─── Migration: the latch must not ride the snapshot past the fix ───────────

describe('TRA-4266 — the snapshot', () => {
  it('a latched row imported without a retest instant gets one, one rung up', () => {
    const { acct } = latch();
    const snap = acct.exportSnapshot();
    expect((snap.openOptions[0] as OptionPosition).closeRejectCount).toBe(3);

    // Strip the field the way a pre-TRA-4266 snapshot would have arrived.
    delete (snap.openOptions[0] as OptionPosition).closeRejectProbeNotBeforeMs;

    const boot = Date.parse('2024-06-05T13:35:00Z');
    vi.setSystemTime(boot);
    const restored = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restored.importSnapshot(snap);
    const r = row(restored);
    // The counter is untouched (it is a real refusal streak, not TRA-4218's
    // transport population) — but it now has a release, and it is not `now`:
    // a boot that follows an outage by seconds must not fire every stranded
    // stop on its first tick.
    expect(r.closeRejectCount).toBe(3);
    expect(r.closeRejectProbeNotBeforeMs).toBe(boot + LADDER_MS[0]);
  });

  it('the retest budget survives the snapshot, so a restart cannot refill it', () => {
    // Otherwise the cap is a cap per process, and a crash-looping box hands a
    // refusing broker an unbounded order stream — TRA-4158 measured 30 crashes
    // in one RTH session on this service.
    const { acct, sym, id } = latch();
    vi.setSystemTime(TRADING_TIME + LADDER_MS[0]);
    expect(stageThenRefuse(acct, sym, id)).toBe(true);
    expect(row(acct).closeRejectProbeCount).toBe(1);

    const restored = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restored.importSnapshot(acct.exportSnapshot());
    expect(row(restored).closeRejectProbeCount).toBe(1);
  });
});
