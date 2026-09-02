// TRA-4225 — the close-reject breaker recorded no trip time and no cause class,
// and its three published counts read as three separate hazards from one cause.
//
// The population, off pin `092d087775dc` / pid 52 (parent TRA-4217, split from
// its ask 2 + defect 3). On 2026-08-31 all THREE open real-money rows in the
// production `admin` book (***0154) carried `closeRejectCount: 3` and the
// byte-identical reason — one Tradier HTTP 500 on the `sell_to_close` submit:
//
//   f3b34f34 KO261002C00090000   paid 1.83  mark 1.27   stop 1.464  ← through
//   7e6fef50 NOK261002C00010500  paid 0.73  mark 0.505  stop 0.584  ← through
//   a2f9c8cd NOK261002C00010500  paid 0.57  mark 0.505  stop 0.456  ← adopted
//
// Three published surfaces described that one population, and no two agreed:
//
//   liveUnmanagedRisk.total              = 0
//   otmSleeveStopCoverage.ungovernedRows = 1
//   liveStopActionability.inert          = 2   byReason { close_reject_breaker: 2 }
//
// (TRA-4217 later corrected its own filing: the middle count grades only the
// day-one rule's claim — `a2f9c8cd` carried a breached `stopLossPremium` the
// whole time — and it is since renamed `dayOneStopUngovernedRows`.)
//
// Every number is correct for the question its field asks. The third row's latch
// is missing from the last one because the walk names the FIRST refusing gate
// and the adopted/imported gates sit upstream of the breaker branch. The board
// asked for THE PARTITION, not a fourth count.
//
// Each test is written so that removing the fix changes the assertion rather
// than leaving it vacuously true.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  PaperOptionsAccount,
  summarizeLiveStopActionability,
  summarizeLiveStopGovernance,
  mergeLiveStopGovernance,
  blindLiveStopGovernance,
  classifyExitBreakerCause,
  describeExitBreakerLatch,
  type LiveStopActionabilityContext,
  type LiveStopGovernanceSummary,
} from './options-account.js';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';

/** The verbatim text the three live rows carried, before our pause decoration. */
const LIVE_500_REASON =
  'Tradier sell_to_close submit threw: Tradier order failed (500): '
  + 'An error occurred while communicating with the backend.';

/** A real 4xx refusal — the broker LOOKED at the contract and said no. */
const LIVE_REFUSAL_REASON =
  'Tradier order rejected: Account is restricted for option trading.';

/** 2026-08-31T19:00:00Z — 15:00 ET, mid-session on the incident day. */
const MEASURED_AT = Date.UTC(2026, 7, 31, 19, 0, 0);
/** The rows were opened days earlier, so no date-keyed hold binds them. */
const OPENED_AT = Date.UTC(2026, 7, 28, 14, 30, 0);

/**
 * The ***0154 runtime on 08-31: mirror up, imported auto-management ON, and the
 * TRA-3829 adopted-row arm OFF (the posture that masked row a2f9c8cd).
 *
 * `liveStopPolicy` is deliberately left off: the incident's published reading
 * attributed to `close_reject_breaker`, and adding a `daily_close` phase here
 * would put a second gate on every row and blur the very count under test. It
 * gets its own fixture in the multi-gate group below.
 */
const MONEY_BOOK: LiveStopActionabilityContext = {
  brokerMirroring: true,
  autoManageImportedTradierOptions: true,
  actOnAdoptedBrokerRows: false,
  holdLiveOptionsOvernightForPdt: true,
  swingHoldOptions: false,
  openingRangeGuardMin: 15,
  now: MEASURED_AT,
};

function liveRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'row',
    symbol: 'KO',
    optionSymbol: 'KO261002C00090000',
    optionType: 'call',
    strike: 90,
    expiration: '2026-10-02',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.83,
    currentPremium: 1.27,
    tp1Premium: 2.745,
    tp1Hit: false,
    stopLossPremium: 1.464,
    peakPremium: 1.83,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 0,
    openedAt: OPENED_AT,
    signalId: 'otm-KO261002C00090000',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  };
}

/**
 * TRA-4266 — the retest instant these rows carry under the build that has a
 * half-open. On 2026-08-31 the field did not exist, and the ABSENCE of it is
 * what this ticket's sibling turned out to be about: the latch had no release
 * because nothing ever scheduled one. The fixtures are restated rather than
 * frozen, because the population they stand for (three real-money rows, one
 * cause) is unchanged — only the answer to "when does it lift" is.
 *
 * `importSnapshot` stamps exactly this on the way in for a latched row that
 * arrives without one, so it is what the incident book looks like today.
 */
const FIRST_PROBE_AT = MEASURED_AT + 300_000;

/** A latch that has spent its whole probe budget — the only one with NO release. */
const EXHAUSTED_LATCH = { closeRejectCount: 7, closeRejectProbeCount: 4 } as const;

/** f3b34f34 — engine-opened, through its stop, latched by the 500. */
const KO_ROW = (): OptionPosition => liveRow({
  id: 'f3b34f34',
  closeRejectCount: 3,
  closeRejectProbeNotBeforeMs: FIRST_PROBE_AT,
  exitErrorReason: `${LIVE_500_REASON} — auto-close paused after 3 rejected attempts; `
    + 'close this position manually on Tradier or with the Close button.',
});

/** 7e6fef50 — the second engine-opened row, same fault, also through its stop. */
const NOK_THROUGH = (): OptionPosition => liveRow({
  id: '7e6fef50',
  symbol: 'NOK',
  optionSymbol: 'NOK261002C00010500',
  strike: 10.5,
  premiumPaid: 0.73,
  currentPremium: 0.505,
  stopLossPremium: 0.584,
  closeRejectCount: 3,
  closeRejectProbeNotBeforeMs: FIRST_PROBE_AT, // TRA-4266
  exitErrorReason: `${LIVE_500_REASON} — auto-close paused after 3 rejected attempts; `
    + 'close this position manually on Tradier or with the Close button.',
});

/**
 * a2f9c8cd — the ADOPTED row. Same contract, same fault, same latch, and NOT
 * through its stop (0.505 > 0.456). Two independent reasons it was invisible:
 * it is not breached, so the breach-keyed surface never looks at it; and the
 * adopted gate sits upstream of the breaker, so even when it IS breached the
 * first-gate walk publishes the adoption refusal instead of the latch.
 */
const NOK_ADOPTED = (): OptionPosition => liveRow({
  id: 'a2f9c8cd',
  symbol: 'NOK',
  optionSymbol: 'NOK261002C00010500',
  strike: 10.5,
  premiumPaid: 0.57,
  currentPremium: 0.505,
  stopLossPremium: 0.456,
  importedFromTradier: true,
  tradierEnv: 'production',
  closeRejectCount: 3,
  closeRejectProbeNotBeforeMs: FIRST_PROBE_AT, // TRA-4266
  exitErrorReason: `${LIVE_500_REASON} — auto-close paused after 3 rejected attempts; `
    + 'close this position manually on Tradier or with the Close button.',
});

const ADMIN_BOOK_0831 = () => [KO_ROW(), NOK_THROUGH(), NOK_ADOPTED()];

// ─── AC1 — the trip records an instant and a machine-readable cause ──────────

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4225',
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

function openCall() {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
  const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'demo', undefined, 200);
  expect(pos).not.toBeNull();
  return { acct, sym: pos!.optionSymbol!, id: pos!.id };
}

function row(acct: PaperOptionsAccount): OptionPosition {
  return acct.getState().openOptions[0] as OptionPosition;
}

/**
 * Drive the REAL path to a tripped close-reject breaker: three staged exits,
 * each cleared as a broker rejection. No test-only mutation of the row — the
 * state under test is produced by `checkExits` + `clearPendingExit`, the pair
 * that ran on bqb1.
 */
function tripCloseRejectBreaker(
  acct: PaperOptionsAccount,
  sym: string,
  id: string,
  reason: string,
): void {
  for (let i = 0; i < 3; i += 1) {
    const staged = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(acct.clearPendingExit(id, reason)).toBe(true);
  }
}

describe('TRA-4225 AC1 — a breaker trip records WHEN and WHY', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stamps the instant and the cause class when the close-reject breaker trips', () => {
    const { acct, sym, id } = openCall();
    expect(row(acct).exitBreakerTrip).toBeUndefined();
    tripCloseRejectBreaker(acct, sym, id, LIVE_REFUSAL_REASON);
    expect(row(acct).closeRejectCount).toBe(3);
    expect(row(acct).exitBreakerTrip).toEqual({
      breaker: 'close_reject',
      at: TRADING_TIME,
      causeClass: 'broker_refusal',
      count: 3,
    });
  });

  it('classifies the 2026-08-31 Tradier 500 as a TRANSPORT fault, not a refusal', () => {
    // The whole ask-2 question: "name what latched close_reject_breaker". A
    // caller that does not classify (every caller before TRA-4218) still lands
    // the fault in the reject counter — and this is the only place that says so.
    const { acct, sym, id } = openCall();
    tripCloseRejectBreaker(acct, sym, id, LIVE_500_REASON);
    expect(row(acct).exitBreakerTrip?.causeClass).toBe('transport_fault');
  });

  it('classifies the BROKER text, never our own pause decoration', () => {
    // The decorated string ("auto-close paused after 3 rejected attempts…") is
    // ours and contains no broker verdict at all. Classifying it would read
    // every trip on earth as `broker_refusal` — the exact conflation this
    // ticket exists to end — so the stored text and the class must disagree.
    const { acct, sym, id } = openCall();
    tripCloseRejectBreaker(acct, sym, id, LIVE_500_REASON);
    const r = row(acct);
    expect(r.exitErrorReason).toContain('auto-close paused after 3 rejected attempts');
    expect(classifyExitBreakerCause(r.exitErrorReason)).toBe('transport_fault');
    expect(r.exitBreakerTrip?.causeClass).toBe('transport_fault');
  });

  it('does not stamp before the breaker actually trips', () => {
    const { acct, sym, id } = openCall();
    const staged = acct.checkExits(new Map(), new Map([[sym, 0.7]]), undefined, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(acct.clearPendingExit(id, LIVE_REFUSAL_REASON)).toBe(true);
    expect(row(acct).closeRejectCount).toBe(1);
    expect(row(acct).exitBreakerTrip).toBeUndefined();
  });

  it('carries the trip through an export/import round trip, instant intact', () => {
    // The counter rides the snapshot (that is what made the latch survive a
    // restart, TRA-4218). The record of WHEN it tripped has to ride with it, or
    // the answer is lost at exactly the boot where someone goes looking.
    const { acct, sym, id } = openCall();
    tripCloseRejectBreaker(acct, sym, id, LIVE_REFUSAL_REASON);
    const snap = acct.exportSnapshot();
    vi.setSystemTime(TRADING_TIME + 11 * 60 * 60 * 1000);
    const restored = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restored.importSnapshot(snap);
    expect(row(restored).exitBreakerTrip?.at).toBe(TRADING_TIME);
    expect(row(restored).exitBreakerTrip?.causeClass).toBe('broker_refusal');
  });

  it('a user re-stage clears the latch AND its trip record together', () => {
    const { acct, sym, id } = openCall();
    tripCloseRejectBreaker(acct, sym, id, LIVE_REFUSAL_REASON);
    expect(acct.stageManualPendingExit(id, 1, 0.7)).not.toBeNull();
    const r = row(acct);
    expect(r.closeRejectCount).toBeUndefined();
    // A stamp outliving its latch would publish a breaker on a row nothing is
    // holding — the opposite failure, and just as unreadable.
    expect(r.exitBreakerTrip).toBeUndefined();
    expect(describeExitBreakerLatch(r)).toBeNull();
  });

  it('the TRA-4218 transport heal takes the trip record with the counter', () => {
    const { acct, sym, id } = openCall();
    tripCloseRejectBreaker(acct, sym, id, LIVE_500_REASON);
    const snap = acct.exportSnapshot();
    // TRA-4218 — `tripCloseRejectBreaker` drives the CURRENT rejection branch to
    // stand in for the pre-fix build, and that branch now stamps
    // `closeRejectRefusalsOnly`. The heal reads its absence as "legacy counter",
    // which is the whole population it exists for; the 08-31 rows latched before
    // the field existed. Strip it so this row is the legacy row it represents.
    // Everything else on the row, including the reason string, still comes from
    // the producer.
    expect(snap.openOptions[0]!.closeRejectRefusalsOnly).toBe(true);
    delete snap.openOptions[0]!.closeRejectRefusalsOnly;
    const restored = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restored.importSnapshot(snap);
    const r = row(restored);
    expect(r.closeRejectCount).toBeUndefined();
    expect(r.exitBreakerTrip).toBeUndefined();
  });
});

describe('TRA-4225 AC1 — the cause class on a row that predates the stamp', () => {
  it('infers the class off the row text and says the instant is unknown', () => {
    // The 08-31 rows. They latched before this field existed, they are still
    // latched, and "no stamp" must not read as "no breaker".
    const latch = describeExitBreakerLatch(KO_ROW());
    expect(latch).toEqual({
      breaker: 'close_reject',
      causeClass: 'transport_fault',
      at: null,
      provenance: 'inferred',
      count: 3,
    });
  });

  it('prefers the STAMP over the text when both are present', () => {
    const latch = describeExitBreakerLatch(liveRow({
      closeRejectCount: 3,
      exitErrorReason: LIVE_500_REASON,
      exitBreakerTrip: {
        breaker: 'close_reject',
        at: MEASURED_AT,
        causeClass: 'broker_refusal',
        count: 3,
      },
    }));
    expect(latch?.provenance).toBe('stamped');
    expect(latch?.at).toBe(MEASURED_AT);
    expect(latch?.causeClass).toBe('broker_refusal');
  });

  it('reads an unrecorded reason as `unknown`, never as a refusal', () => {
    // "We did not record why" and "the broker refused it" are different facts,
    // and the second one is an accusation.
    expect(classifyExitBreakerCause(undefined)).toBe('unknown');
    expect(classifyExitBreakerCause('   ')).toBe('unknown');
    expect(describeExitBreakerLatch(liveRow({ closeRejectCount: 3 }))?.causeClass).toBe('unknown');
  });

  it('names the EXPIRY breaker with its own class, and no latch when neither is tripped', () => {
    expect(describeExitBreakerLatch(liveRow({ exitExpiredCount: 3 }))).toEqual({
      breaker: 'exit_expired',
      causeClass: 'expiry',
      at: null,
      provenance: 'inferred',
      count: 3,
    });
    expect(describeExitBreakerLatch(liveRow({ closeRejectCount: 2, exitExpiredCount: 2 }))).toBeNull();
  });
});

// ─── AC2/AC3 — one population, one cause; every gate published ───────────────

describe('TRA-4225 AC2 — the 2026-08-31 admin book is ONE population with ONE cause', () => {
  it('reproduces the published 0 / 1 / 2 disagreement on the OLD surface', () => {
    // The control for the whole ticket: if this stops reading 2 the fixture has
    // drifted off the incident and nothing below is grading it.
    const s = summarizeLiveStopActionability(ADMIN_BOOK_0831(), MONEY_BOOK);
    expect(s.breached).toBe(2);
    expect(s.inert).toBe(2);
    expect(s.byReason).toEqual({ close_reject_breaker: 2 });
    // …and the third row, latched by the identical fault, is nowhere in it.
    expect(s.breached + s.actionable).toBe(2);
    // TRA-4266 — this WAS `null`, and that null is the sibling ticket: a latch
    // with no scheduled retest. The disagreement under test here (0 / 1 / 2) is
    // about which rows the surface can SEE, not about when they lift, and it is
    // unchanged.
    expect(s.releasesAt).toBe(new Date(FIRST_PROBE_AT).toISOString());
    expect(s.indefinite).toBe(0);
  });

  it('publishes all three rows as one latched population under one cause', () => {
    const g = summarizeLiveStopGovernance(ADMIN_BOOK_0831(), MONEY_BOOK);
    expect(g.rows).toBe(3);
    expect(g.held).toBe(3);
    // TRA-4266 — still three held rows under one cause, which is this
    // ticket's claim. What changed is the CLASS: the breaker now retests, so the
    // hold lifts on a clock instead of on a human.
    //
    // Two, not three: `a2f9c8cd` is ALSO held by `adopted_not_authorized`, which
    // has no release, and a row is only `held_with_release` when EVERY gate on
    // it lifts on a clock. That is this suite's own rule read in the other
    // direction, and clearing the breaker on that row would still leave it
    // held — which is the fact the partition exists to publish.
    expect(g.byClass.held_with_release).toBe(2);
    expect(g.byClass.held_indefinite).toBe(1);
    expect(g.byClass.governed).toBe(0);
    // The number the incident could not produce anywhere: 3, not 0 / 1 / 2.
    expect(g.heldBy.close_reject_breaker).toBe(3);
    expect(g.breakerLatched.rows).toBe(3);
    expect(g.breakerLatched.byCause).toEqual({
      broker_refusal: 0,
      transport_fault: 3,
      expiry: 0,
      unknown: 0,
    });
    // Nothing was stamped on 08-31 — the field did not exist — and the fold says
    // so rather than implying it recorded three trips.
    expect(g.breakerLatched.inferred).toBe(3);
    expect(g.breakerLatched.stamped).toBe(0);
    expect(g.breakerLatched.firstTrippedAt).toBeNull();
  });

  it('counts the un-breached latched row, which the breach-keyed surface cannot see', () => {
    // a2f9c8cd alone. `liveStopActionability` reads a clean, correct zero over
    // it; this surface reads a held row, because "will anything act on this
    // stop" is answerable before the mark crosses.
    const only = [NOK_ADOPTED()];
    expect(summarizeLiveStopActionability(only, MONEY_BOOK)).toMatchObject({
      breached: 0, inert: 0, byReason: {},
    });
    const g = summarizeLiveStopGovernance(only, MONEY_BOOK);
    expect(g.held).toBe(1);
    expect(g.heldBreached).toBe(0);
    expect(g.breakerLatched.rows).toBe(1);
  });

  it('AC3 — a row held by two gates publishes BOTH, not only the first', () => {
    const g = summarizeLiveStopGovernance([NOK_ADOPTED()], MONEY_BOOK);
    expect(g.heldBy).toEqual({ adopted_not_authorized: 1, close_reject_breaker: 1 });
    expect(g.multiHeld).toBe(1);
    // …while the first-gate walk keeps naming the gate that did the not-acting.
    // Both answers are right; only one of them was published before.
    const breachedTwin = NOK_ADOPTED();
    breachedTwin.currentPremium = 0.4; // now through its 0.456 stop
    expect(summarizeLiveStopActionability([breachedTwin], MONEY_BOOK).byReason)
      .toEqual({ adopted_not_authorized: 1 });
    expect(summarizeLiveStopGovernance([breachedTwin], MONEY_BOOK).heldBy)
      .toEqual({ adopted_not_authorized: 1, close_reject_breaker: 1 });
  });

  it('publishes the imported-auto-manage masking the same way', () => {
    // The other upstream gate the ticket names. Same row, a deployment with
    // imported auto-management off: three gates now, and the breaker is the
    // third of them.
    const ctx: LiveStopActionabilityContext = {
      ...MONEY_BOOK,
      autoManageImportedTradierOptions: false,
    };
    const g = summarizeLiveStopGovernance([NOK_ADOPTED()], ctx);
    expect(g.heldBy).toEqual({
      imported_auto_manage_off: 1,
      adopted_not_authorized: 1,
      close_reject_breaker: 1,
    });
    expect(g.multiHeld).toBe(1);
    expect(g.breakerLatched.byCause.transport_fault).toBe(1);
  });

  it('`heldBy` deliberately over-counts rows, and `multiHeld` is the overlap', () => {
    const g = summarizeLiveStopGovernance(ADMIN_BOOK_0831(), MONEY_BOOK);
    const gateTotal = Object.values(g.heldBy).reduce((a, b) => a + (b ?? 0), 0);
    expect(gateTotal).toBe(4);          // 3 breakers + 1 adoption refusal
    expect(g.held).toBe(3);
    expect(g.multiHeld).toBe(1);
  });

  it('a second gate with a CLOCK does not make an indefinite row look released', () => {
    // Outside the close window every row picks up `daily_close_hold`, which has
    // a release. The latched rows must still read `held_indefinite`: one gate
    // with a clock does not lift the gate without one.
    //
    // TRA-4266 — graded on the EXHAUSTED latch now, because that is the only
    // close-reject state left with no release of its own; a probing latch is
    // legitimately `held_with_release` and would make this control vacuous.
    const ctx: LiveStopActionabilityContext = {
      ...MONEY_BOOK,
      liveStopPolicy: { policy: 'daily_close', closeWindowMin: 30, catastrophicLossPct: 0.5 },
    };
    const g = summarizeLiveStopGovernance([liveRow({ ...EXHAUSTED_LATCH })], ctx);
    expect(g.heldBy.close_reject_breaker_exhausted).toBe(1);
    expect(g.byClass.held_indefinite).toBe(1);
    expect(g.byClass.held_with_release).toBe(0);
  });
});

// ─── AC4 — release semantics ────────────────────────────────────────────────

describe('TRA-4225 AC4 — "no automated release" is not "no way out"', () => {
  // The re-stage control below drives the REAL open/exit path, which is
  // trading-window gated; every summary call in here passes its own `ctx.now`
  // and is unaffected by the pin.
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a PROBING latch is `automatic` — the retest is the release', () => {
    // TRA-4266 — this was `manual_restage` with a null `releasesAt`, and that
    // pair is precisely what the sibling ticket calls a permanent disarm. While
    // the breaker still has retests, no human is required and the fold must not
    // ask for one.
    const g = summarizeLiveStopGovernance([KO_ROW()], MONEY_BOOK);
    expect(g.recovery).toEqual({
      automatic: 1, config_change: 0, manual_restage: 0, close_position_only: 0,
    });
    expect(g.releasesAt).toBe(new Date(FIRST_PROBE_AT).toISOString());
  });

  it('an EXHAUSTED engine-opened latch is a Close button away — `manual_restage`', () => {
    const g = summarizeLiveStopGovernance([liveRow({ ...EXHAUSTED_LATCH })], MONEY_BOOK);
    expect(g.recovery).toEqual({
      automatic: 0, config_change: 0, manual_restage: 1, close_position_only: 0,
    });
    expect(g.releasesAt).toBeNull();
  });

  it('an IMPORTED exhausted latch can only be un-held by giving up the position', () => {
    const g = summarizeLiveStopGovernance(
      [{ ...NOK_ADOPTED(), ...EXHAUSTED_LATCH, closeRejectProbeNotBeforeMs: undefined }],
      MONEY_BOOK,
    );
    // `close_position_only` beats the adopted row's own `config_change`: arming
    // adoption would not clear the breaker, and clearing the breaker is the
    // thing with no path that keeps the row.
    expect(g.recovery.close_position_only).toBe(1);
    expect(g.recovery.config_change).toBe(0);
  });

  it('and the claim is measured, not asserted: the re-stage path really refuses it', () => {
    // The reason `close_position_only` is a distinct class at all. If
    // `stageManualPendingExit` ever accepted imported rows this would go green
    // as `manual_restage` and the class would be a lie.
    //
    // ⚠️ It says nothing about the Close BUTTON, which TRA-4224 measured as
    // working on exactly this row (imported rows take the TRA-323 sub-path).
    // The claim under test is narrower and is the one AC4 needs: no in-app
    // action releases the latch and leaves the position open.
    const { acct, sym, id } = openCall();
    tripCloseRejectBreaker(acct, sym, id, LIVE_REFUSAL_REASON);
    expect(acct.stageManualPendingExit(id, 1, 0.7)).not.toBeNull();  // engine row: released

    // A genuine refusal, NOT the 500: the TRA-4218 import heal clears a
    // transport-accrued counter on the way in, which is its job — and would
    // make this control vacuous by releasing the row before it is tested.
    const importedLatched = NOK_ADOPTED();
    importedLatched.exitErrorReason =
      `${LIVE_REFUSAL_REASON} — auto-close paused after 3 rejected attempts; `
      + 'close this position manually on Tradier or with the Close button.';
    const imported = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    imported.importSnapshot({
      ...acct.exportSnapshot(),
      openOptions: [importedLatched],
    });
    expect(imported.stageManualPendingExit('a2f9c8cd', 1, 0.5)).toBeNull();
    // …and the latch is still there afterwards, which is the whole point.
    expect(describeExitBreakerLatch(imported.getState().openOptions[0] as OptionPosition))
      .not.toBeNull();
  });

  it('a clocked hold is `automatic`, and it publishes the instant it lifts', () => {
    const heldToday = liveRow({
      id: 'opened-today',
      openedAt: MEASURED_AT - 60_000,
      currentPremium: 1.0,       // through the 1.464 stop
    });
    const g = summarizeLiveStopGovernance([heldToday], MONEY_BOOK);
    expect(g.byClass.held_with_release).toBe(1);
    expect(g.recovery.automatic).toBe(1);
    expect(g.releasesAt).toBe('2026-09-01T00:00:00.000Z');
  });

  it('a config refusal is `config_change` — a settings write, not a human at the row', () => {
    const adoptedOnly = NOK_ADOPTED();
    delete adoptedOnly.closeRejectCount;
    delete adoptedOnly.exitErrorReason;
    const g = summarizeLiveStopGovernance([adoptedOnly], MONEY_BOOK);
    expect(g.recovery).toEqual({
      automatic: 0, config_change: 1, manual_restage: 0, close_position_only: 0,
    });
    expect(g.breakerLatched.rows).toBe(0);
  });

  it('the TRA-4218 transport BACKOFF reads as automatic, not as a latch', () => {
    // The gate that looks like a breaker and is not one: it releases itself.
    const backing = liveRow({
      id: 'backoff',
      exitTransportFailCount: 1,
      exitRetryNotBeforeMs: MEASURED_AT + 30_000,
    });
    const g = summarizeLiveStopGovernance([backing], MONEY_BOOK);
    expect(g.heldBy).toEqual({ exit_transport_backoff: 1 });
    expect(g.byClass.held_with_release).toBe(1);
    expect(g.recovery.automatic).toBe(1);
    expect(g.releasesAt).toBe(new Date(MEASURED_AT + 30_000).toISOString());
    expect(g.breakerLatched.rows).toBe(0);
  });
});

// ─── NEGATIVE CONTROLS — a detector that over-matches voids every clean read ─

describe('TRA-4225 negative controls', () => {
  it('a healthy live row reads governed, with every breaker count at 0', () => {
    const healthy = liveRow({ id: 'healthy', currentPremium: 1.9 });
    const g = summarizeLiveStopGovernance([healthy], MONEY_BOOK);
    expect(g.byClass.governed).toBe(1);
    expect(g.held).toBe(0);
    expect(g.nothingWillAct).toBe(0);
    expect(g.heldBy).toEqual({});
    expect(g.multiHeld).toBe(0);
    expect(g.breakerLatched.rows).toBe(0);
    expect(g.breakerLatched.byCause).toEqual({
      broker_refusal: 0, transport_fault: 0, expiry: 0, unknown: 0,
    });
  });

  it('demo rows and closed rows are not in the denominator', () => {
    const rows = [
      liveRow({ id: 'demo', mode: 'demo', closeRejectCount: 3 }),
      liveRow({ id: 'closed', closedAt: MEASURED_AT - 1000, closeRejectCount: 3 }),
      KO_ROW(),
    ];
    const g = summarizeLiveStopGovernance(rows, MONEY_BOOK);
    expect(g.rows).toBe(1);
    expect(g.breakerLatched.rows).toBe(1);
  });

  it('an in-flight exit is not "nothing will act"', () => {
    const working = liveRow({
      id: 'working',
      pendingExit: {
        tradierOrderId: '12345',
        qty: 1,
        limitPrice: 1.3,
        submittedAt: MEASURED_AT - 5_000,
        kind: 'sl',
        duration: 'day',
      },
    });
    const g = summarizeLiveStopGovernance([working], MONEY_BOOK);
    expect(g.byClass.in_flight).toBe(1);
    expect(g.held).toBe(0);
    expect(g.heldBy).toEqual({});
  });

  it('a row with no stop at all is its own class, not a held one', () => {
    const noStop = liveRow({ id: 'nostop', stopLossPremium: 0 });
    const g = summarizeLiveStopGovernance([noStop], MONEY_BOOK);
    expect(g.byClass.no_stop_written).toBe(1);
    expect(g.held).toBe(0);
    // …but it IS in the union, because nothing will act on it either.
    expect(g.nothingWillAct).toBe(1);
  });

  it('rows === Σ byClass on every mixed population', () => {
    const rows = [
      ...ADMIN_BOOK_0831(),
      liveRow({ id: 'healthy', currentPremium: 1.9 }),
      liveRow({ id: 'nostop', stopLossPremium: 0 }),
      liveRow({ id: 'demo', mode: 'demo' }),
    ];
    const g = summarizeLiveStopGovernance(rows, MONEY_BOOK);
    const total = Object.values(g.byClass).reduce((a, b) => a + b, 0);
    expect(g.rows).toBe(5);
    expect(total).toBe(5);
    expect(g.held).toBe(g.byClass.held_with_release + g.byClass.held_indefinite);
    expect(g.nothingWillAct).toBe(g.held + g.byClass.no_stop_written);
  });

  it('an empty book publishes zeros, not nulls — blind is a different reading', () => {
    const g = summarizeLiveStopGovernance([], MONEY_BOOK);
    expect(g.rows).toBe(0);
    expect(g.breakerLatched.byCause.transport_fault).toBe(0);
    expect(g.releasesAt).toBeNull();
    // The blind shape is every key null, so a reader can tell "measured zero"
    // from "could not measure" — the TRA-3839 discipline, one field over.
    const blind = blindLiveStopGovernance();
    for (const value of Object.values(blind)) expect(value).toBeNull();
    expect(Object.keys(blind).sort()).toEqual(Object.keys(g).sort());
  });
});

describe('TRA-4225 — the fleet fold', () => {
  it('sums the counts, takes the EARLIEST release and extremises the trip instants', () => {
    const bookA: LiveStopGovernanceSummary = summarizeLiveStopGovernance(
      [KO_ROW()],
      MONEY_BOOK,
    );
    const stampedRow = liveRow({
      id: 'stamped',
      closeRejectCount: 3,
      closeRejectProbeNotBeforeMs: FIRST_PROBE_AT + 60_000, // TRA-4266
      exitErrorReason: LIVE_REFUSAL_REASON,
      exitBreakerTrip: {
        breaker: 'close_reject',
        at: MEASURED_AT - 3_600_000,
        causeClass: 'broker_refusal',
        count: 3,
      },
    });
    const bookB = summarizeLiveStopGovernance([stampedRow], MONEY_BOOK);
    const fleet = mergeLiveStopGovernance([bookA, bookB]);
    expect(fleet.rows).toBe(2);
    expect(fleet.held).toBe(2);
    expect(fleet.heldBy.close_reject_breaker).toBe(2);
    expect(fleet.breakerLatched.rows).toBe(2);
    expect(fleet.breakerLatched.byCause).toEqual({
      broker_refusal: 1, transport_fault: 1, expiry: 0, unknown: 0,
    });
    expect(fleet.breakerLatched.stamped).toBe(1);
    expect(fleet.breakerLatched.inferred).toBe(1);
    // A book with nothing stamped contributes nothing rather than nulling it.
    expect(fleet.breakerLatched.firstTrippedAt)
      .toBe(new Date(MEASURED_AT - 3_600_000).toISOString());
    expect(fleet.breakerLatched.lastTrippedAt)
      .toBe(new Date(MEASURED_AT - 3_600_000).toISOString());
    // TRA-4266 — both books' latches are still probing, so the fleet's recovery
    // path is the clock, not a person. `releasesAt` extremises to the EARLIEST.
    expect(fleet.recovery.automatic).toBe(2);
    expect(fleet.recovery.manual_restage).toBe(0);
    expect(fleet.releasesAt).toBe(new Date(FIRST_PROBE_AT).toISOString());
  });

  it('folds an empty fleet to zeros', () => {
    const fleet = mergeLiveStopGovernance([]);
    expect(fleet.rows).toBe(0);
    expect(fleet.releasesAt).toBeNull();
    expect(fleet.byClass.governed).toBe(0);
  });
});
