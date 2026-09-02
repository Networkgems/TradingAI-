import { describe, it, expect } from 'vitest';
import {
  summarizeLiveStopActionability,
  mergeLiveStopActionability,
  type LiveStopActionabilityContext,
} from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';

/**
 * TRA-3822 — controls for `summarizeLiveStopActionability`, in BOTH directions.
 *
 * The ticket's binding constraint is that this detector must be graded twice
 * over, because the two counters it exists to supplement (`liveUnmanagedRisk`
 * and `chandelier_deferred_breach`) each read a CORRECT `0` over the incident:
 *
 *   • **positive** — it must FLAG the 2026-08-17 money-book shape. If it does
 *     not, it is the third instrument that cannot contain the thing, and the
 *     whole ticket was a no-op. `A positive control must CONTAIN what it
 *     detects.`
 *   • **negative** — it must NOT flag a healthy row whose stop is simply not
 *     breached, nor a row that is genuinely about to be acted on. A detector
 *     that over-matches voids every future clean read, which is strictly worse
 *     than the blindness it replaces: the current zeros are at least honest.
 *
 * Every fixture below is real. The two rows are the ***0154 pair as measured on
 * `/api/state` at 2026-08-17T22:41Z (TRA-3821 §"the exposure it is failing to
 * manage"), including the awkward stop values — 1.07625 and 1.51500 — which are
 * the engine's own `premiumPaid * (1 - slPct)` output and not round numbers.
 */

/** 2026-08-17T13:46:42Z — the PLTR row's real `openedAt`. */
const PLTR_OPENED = Date.UTC(2026, 7, 17, 13, 46, 42);
/** 2026-08-17T17:04:49Z — the SPY row's real `openedAt`. */
const SPY_OPENED = Date.UTC(2026, 7, 17, 17, 4, 49);
/** 2026-08-17T22:41:00Z — the instant the incident was measured. Still 08-17 in UTC. */
const MEASURED_AT = Date.UTC(2026, 7, 17, 22, 41, 0);
/**
 * The release: `toDateKey` is `toISOString().slice(0, 10)`, a **UTC** day, so the
 * latch on rows opened 2026-08-17 expires at 2026-08-18T00:00:00.000Z — 20:00 ET
 * Monday, NOT ET midnight. Four hours earlier than the intuitive reading, and in
 * the direction that matters (the exposure ends sooner, unattended, and outside
 * RTH).
 */
const RELEASE_ISO = '2026-08-18T00:00:00.000Z';

/** The money book's live runtime on 08-17: PDT hold on, broker mirror up. */
const MONEY_BOOK: LiveStopActionabilityContext = {
  brokerMirroring: true,
  autoManageImportedTradierOptions: true,
  // TRA-3829 — `true` PINS THIS FILE TO THE PRE-TRA-3829 POSTURE, on purpose.
  //
  // TRA-3829 adds an `adopted_not_authorized` gate that sits AHEAD of
  // `pdt_hold_today` in the walk, so on the shipped TRA-3829 default every
  // assertion below would re-attribute to the new gate. That would silently
  // rewrite TRA-3822's finding — which is a statement about what the box did on
  // 2026-08-17, and is still `in_review` — into a statement about a build that
  // did not exist that day.
  //
  // The 08-17 box behaved exactly as `armed: true` describes: it WOULD have
  // acted on these adopted rows, and the only thing that stopped it was the PDT
  // hold releasing at 00:00Z. So this is not a fudge to keep tests green, it is
  // the literal 08-17 configuration. The disarmed direction is graded in
  // `tra3829-adopted-row-authorization.test.ts`, against these same two rows.
  actOnAdoptedBrokerRows: true,
  holdLiveOptionsOvernightForPdt: true,
  swingHoldOptions: false,
  // TRA-3902 — the shipped default window. MEASURED_AT is 22:41Z, hours past
  // it, so nothing in this file re-attributes to `opening_range_hold`.
  openingRangeGuardMin: 15,
  now: MEASURED_AT,
};

function pltrRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'pltr-0817',
    symbol: 'PLTR',
    optionSymbol: 'PLTR260821C00180000',
    optionType: 'call',
    strike: 180,
    expiration: '2026-08-21',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 1.435,
    currentPremium: 1.04,      // BREACHED by 3.4%
    tp1Premium: 2.1525,
    tp1Hit: false,
    stopLossPremium: 1.07625,
    peakPremium: 1.435,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 0,
    openedAt: PLTR_OPENED,
    signalId: 'tradier-import-PLTR260821C00180000',
    signalType: 'tradier_import',
    mode: 'live',
    importedFromTradier: true,
    // TRA-3829 ruling B (card 331ddc56, 2026-08-21) — the deployment flag alone
    // no longer admits an adopted row; a PER-ROW human hand-over is the second
    // key. This fixture carries one so the file keeps grading its own subject.
    engineHandover: { grantedAt: '2026-08-21T13:00:00.000Z', grantedBy: 'test-human' },
    ...overrides,
  };
}

function spyRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'spy-0817',
    symbol: 'SPY',
    optionSymbol: 'SPY260821C00777000',
    optionType: 'call',
    strike: 777,
    expiration: '2026-08-21',
    contracts: 2,
    contractsRemaining: 2,
    premiumPaid: 2.02,
    currentPremium: 1.42,      // BREACHED by 6.3%
    tp1Premium: 3.03,
    tp1Hit: false,
    stopLossPremium: 1.515,
    peakPremium: 2.02,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 0,
    openedAt: SPY_OPENED,
    signalId: 'tradier-import-SPY260821C00777000',
    signalType: 'tradier_import',
    mode: 'live',
    importedFromTradier: true,
    // TRA-3829 ruling B (card 331ddc56, 2026-08-21) — the deployment flag alone
    // no longer admits an adopted row; a PER-ROW human hand-over is the second
    // key. This fixture carries one so the file keeps grading its own subject.
    engineHandover: { grantedAt: '2026-08-21T13:00:00.000Z', grantedBy: 'test-human' },
    ...overrides,
  };
}

// ─── POSITIVE: it must contain the 2026-08-17 incident ───────────────────────

describe('TRA-3822 positive control — the 2026-08-17 ***0154 pair', () => {
  it('flags BOTH rows inert under pdt_hold_today, with the UTC-day release', () => {
    const s = summarizeLiveStopActionability([pltrRow(), spyRow()], MONEY_BOOK);
    expect(s).toEqual({
      breached: 2,
      actionable: 0,
      inFlight: 0,
      inert: 2,
      byReason: { pdt_hold_today: 2 },
      releasesAt: RELEASE_ISO,
      fullyReleasesAt: RELEASE_ISO,
      indefinite: 0,
    });
  });

  it('is a STRICTLY stronger reading than the two counters that were correct-and-blind', () => {
    // The point of the ticket, stated as an assertion rather than as prose. Both
    // rows carry a positive finite stop and no `riskUnmanagedReason`, so
    // `summarizeLiveUnmanagedRisk` returns 0/0 — arithmetically right. And no
    // exit fired, so `chandelier_deferred_breach` (a fire-time journal label)
    // has nothing to stamp. This detector reads 2 over the same two rows.
    const rows = [pltrRow(), spyRow()];
    for (const r of rows) {
      expect(r.stopLossPremium).toBeGreaterThan(0);
      expect(Number.isFinite(r.stopLossPremium)).toBe(true);
      expect(r.riskUnmanagedReason).toBeUndefined();
    }
    expect(summarizeLiveStopActionability(rows, MONEY_BOOK).inert).toBe(2);
  });

  it('the release is 00:00Z, NOT ET midnight — a four-hour error in the unsafe direction', () => {
    const s = summarizeLiveStopActionability([pltrRow()], MONEY_BOOK);
    // ET midnight on 08-17 would be 2026-08-18T04:00:00Z. The latch is UTC-keyed,
    // so it releases four hours earlier — into a closed market, unattended, with
    // the next tick that sees a mark firing the stop at Tuesday's open.
    expect(s.releasesAt).toBe(RELEASE_ISO);
    expect(new Date(s.releasesAt!).getTime()).toBeLessThan(Date.UTC(2026, 7, 18, 4, 0, 0));
  });

  it('a breach the hold has already released from reads ACTIONABLE, not inert', () => {
    // Same rows, one second past the release. This is the transition the desk
    // needs to see BEFORE it happens: nothing about the row changed, only the
    // clock, and the engine went from "cannot act" to "will act unattended".
    const s = summarizeLiveStopActionability([pltrRow(), spyRow()], {
      ...MONEY_BOOK,
      now: Date.UTC(2026, 7, 18, 0, 0, 1),
    });
    expect(s).toEqual({
      breached: 2,
      actionable: 2,
      inFlight: 0,
      inert: 0,
      byReason: {},
      releasesAt: null,
      fullyReleasesAt: null,
      indefinite: 0,
    });
  });
});

// ─── NEGATIVE: it must refuse to flag healthy and in-flight rows ─────────────

describe('TRA-3822 negative controls — what it must NOT flag', () => {
  it('an UNBREACHED row under the identical suppression is not counted at all', () => {
    // The suppression is real, the stop is real, the mark is simply above it.
    // This is the single most common live state and it must contribute nothing —
    // otherwise `inert` becomes a count of held positions, which is a number we
    // already have, and every clean read is voided.
    const s = summarizeLiveStopActionability(
      [pltrRow({ currentPremium: 1.30 }), spyRow({ currentPremium: 1.90 })],
      MONEY_BOOK,
    );
    expect(s.breached).toBe(0);
    expect(s.inert).toBe(0);
    expect(s.releasesAt).toBeNull();
  });

  it('a row EXACTLY at its stop IS breached — `mark <= stop`, the `:5332` predicate', () => {
    // Boundary pinned in the direction the engine actually fires. Off-by-one
    // here would silently drop the gap-open case.
    const s = summarizeLiveStopActionability([pltrRow({ currentPremium: 1.07625 })], MONEY_BOOK);
    expect(s.breached).toBe(1);
    expect(s.inert).toBe(1);
    // …and one tick above it is not.
    expect(
      summarizeLiveStopActionability([pltrRow({ currentPremium: 1.07626 })], MONEY_BOOK).breached,
    ).toBe(0);
  });

  it('a row with an exit ALREADY IN FLIGHT scores inFlight, never inert', () => {
    // TRA-354 holds the row precisely because a `sell_to_close` is working at the
    // broker. Something IS acting on it. Counting that as "nothing will act"
    // would flag every normal exit for its whole submit-to-fill window.
    const s = summarizeLiveStopActionability(
      [pltrRow({ pendingExit: { orderId: 12345, kind: 'sl', contracts: 2, stagedAt: MEASURED_AT } as never })],
      MONEY_BOOK,
    );
    expect(s).toEqual({
      breached: 1,
      actionable: 0,
      inFlight: 1,
      inert: 0,
      byReason: {},
      releasesAt: null,
      fullyReleasesAt: null,
      indefinite: 0,
    });
  });

  it('a DEMO row through its stop is out of scope even with the hold armed', () => {
    const s = summarizeLiveStopActionability(
      [pltrRow({ mode: 'demo' }), pltrRow({ mode: undefined, id: 'legacy-no-mode' })],
      MONEY_BOOK,
    );
    expect(s.breached).toBe(0);
  });

  it('a CLOSED row is out of scope', () => {
    const s = summarizeLiveStopActionability(
      [pltrRow({ closedAt: MEASURED_AT })],
      MONEY_BOOK,
    );
    expect(s.breached).toBe(0);
  });

  it('an UNARMED stop is `liveUnmanagedRisk`’s question, not this one', () => {
    // TRA-2957's sentinel zoo. `0`, `null` and `NaN` all mean "no stop", and
    // `mark <= null` would ToNumber-coerce to a false breach. A row with no stop
    // is an UNMANAGED row — that is the sibling counter's job, and double-
    // counting it here would make the two fields fight over the same incident.
    for (const stop of [0, null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const s = summarizeLiveStopActionability(
        [pltrRow({ stopLossPremium: stop as never, currentPremium: 0.01 })],
        MONEY_BOOK,
      );
      expect(s.breached, `stopLossPremium=${String(stop)}`).toBe(0);
    }
  });

  it('a non-finite MARK cannot manufacture a breach', () => {
    for (const mark of [Number.NaN, null, undefined, Number.NEGATIVE_INFINITY]) {
      const s = summarizeLiveStopActionability(
        [pltrRow({ currentPremium: mark as never })],
        MONEY_BOOK,
      );
      expect(s.breached, `currentPremium=${String(mark)}`).toBe(0);
    }
  });
});

// ─── Gate attribution: `byReason` must name the gate that actually refused ───

describe('TRA-3822 gate attribution', () => {
  /** No hold armed, so a bare breached row is actionable and each gate shows alone. */
  const NO_HOLD: LiveStopActionabilityContext = {
    ...MONEY_BOOK,
    holdLiveOptionsOvernightForPdt: false,
  };

  it('with no suppressor armed, a breached live row is ACTIONABLE', () => {
    const s = summarizeLiveStopActionability([pltrRow(), spyRow()], NO_HOLD);
    expect(s.actionable).toBe(2);
    expect(s.inert).toBe(0);
  });

  it.each([
    ['multi_leg_combo', { legs: [{}, {}] as never }],
    ['covered_write', { coveredWrite: 'covered_call' as const }],
    // TRA-4266 — `close_reject_breaker` LEFT this list. A latched row now
    // retests on a ladder, so it is a clocked hold and belongs with
    // `pdt_hold_today`; only the state that has spent every retest is a human's,
    // and it says so with its own gate name rather than sharing one.
    ['close_reject_breaker_exhausted', { closeRejectCount: 7, closeRejectProbeCount: 4 }],
    ['exit_expired_breaker', { exitExpiredCount: 3 }],
  ])('%s is INDEFINITE — no clock releases it, a human must', (reason, overrides) => {
    const s = summarizeLiveStopActionability([pltrRow(overrides)], NO_HOLD);
    expect(s.inert).toBe(1);
    expect(s.byReason).toEqual({ [reason]: 1 });
    expect(s.indefinite).toBe(1);
    // The desk gets no timestamp because there is no honest one to give.
    expect(s.releasesAt).toBeNull();
    expect(s.fullyReleasesAt).toBeNull();
  });

  it('a breaker BELOW its threshold does not gate — 2 rejects of 3 still acts', () => {
    expect(
      summarizeLiveStopActionability([pltrRow({ closeRejectCount: 2 })], NO_HOLD).actionable,
    ).toBe(1);
    expect(
      summarizeLiveStopActionability([pltrRow({ exitExpiredCount: 2 })], NO_HOLD).actionable,
    ).toBe(1);
  });

  it('imported_auto_manage_off and imported_no_broker_mirror split the TRA-361 pair', () => {
    expect(
      summarizeLiveStopActionability([pltrRow()], {
        ...NO_HOLD,
        autoManageImportedTradierOptions: false,
      }).byReason,
    ).toEqual({ imported_auto_manage_off: 1 });
    expect(
      summarizeLiveStopActionability([pltrRow()], { ...NO_HOLD, brokerMirroring: false }).byReason,
    ).toEqual({ imported_no_broker_mirror: 1 });
  });

  it('a NON-imported row is untouched by the TRA-361 gates', () => {
    // `:4726-4727` are inside `if (isImported)`. A native live row with no broker
    // mirror reaches the SL branch, so attributing it to an import gate would be
    // a false reason on a real breach — worse than no reason.
    const s = summarizeLiveStopActionability(
      [pltrRow({ importedFromTradier: false, signalType: 'otm_mispricing' })],
      { ...NO_HOLD, autoManageImportedTradierOptions: false, brokerMirroring: false },
    );
    expect(s.actionable).toBe(1);
    expect(s.byReason).toEqual({});
  });

  it('swing_hold_today needs signalType relative_value — an import is NEVER latched by it', () => {
    // The 08-17 rows are `tradier_import`. If this predicate were widened to
    // "any live row" the incident would have been attributed to the swing rule
    // instead of the PDT hold, and the remedy would have been aimed at the wrong
    // gate (TRA-3821's central finding: a correct diagnosis is not the cause).
    expect(
      summarizeLiveStopActionability([pltrRow({ signalType: 'tradier_import' })], NO_HOLD).byReason,
    ).toEqual({});
    expect(
      summarizeLiveStopActionability([pltrRow({ signalType: 'relative_value' })], NO_HOLD),
    ).toMatchObject({ inert: 1, byReason: { swing_hold_today: 1 }, releasesAt: RELEASE_ISO });
  });

  it('names the FIRST gate in checkExits order when several apply', () => {
    // A combo that is also PDT-held and also breaker-tripped. `checkExits` hits
    // the combo skip 300+ lines before the PDT `continue`, so the combo is the
    // gate that did the not-acting. Reporting the PDT hold here would hand the
    // desk a release timestamp for a row that will still be stuck after it.
    const s = summarizeLiveStopActionability(
      [pltrRow({ legs: [{}, {}] as never, closeRejectCount: 9 })],
      MONEY_BOOK,
    );
    expect(s.byReason).toEqual({ multi_leg_combo: 1 });
    expect(s.indefinite).toBe(1);
    expect(s.releasesAt).toBeNull();
  });

  it('pendingExit is checked AFTER the import gates, as checkExits does', () => {
    // `:4726-4727` precede `:4732`. An import with auto-management off and an
    // in-flight exit is inert-by-import in the engine's own order.
    const s = summarizeLiveStopActionability(
      [pltrRow({ pendingExit: { orderId: 1 } as never })],
      { ...MONEY_BOOK, autoManageImportedTradierOptions: false },
    );
    expect(s.inFlight).toBe(0);
    expect(s.byReason).toEqual({ imported_auto_manage_off: 1 });
  });

  it('breached === actionable + inFlight + inert over a mixed book', () => {
    const s = summarizeLiveStopActionability(
      [
        pltrRow(),                                                   // inert (pdt)
        spyRow(),                                                    // inert (pdt)
        pltrRow({ id: 'a', openedAt: Date.UTC(2026, 7, 14, 14, 0) }), // actionable (not today)
        spyRow({ id: 'b', pendingExit: { orderId: 7 } as never, openedAt: Date.UTC(2026, 7, 14, 14, 0) }),
        pltrRow({ id: 'c', currentPremium: 5 }),                     // unbreached
        pltrRow({ id: 'd', mode: 'demo' }),                          // out of scope
      ],
      MONEY_BOOK,
    );
    expect(s.breached).toBe(4);
    expect(s.actionable + s.inFlight + s.inert).toBe(s.breached);
    expect(s).toMatchObject({ actionable: 1, inFlight: 1, inert: 2 });
  });
});

// ─── Fleet fold ──────────────────────────────────────────────────────────────

describe('TRA-3822 mergeLiveStopActionability', () => {
  const empty = {
    breached: 0, actionable: 0, inFlight: 0, inert: 0,
    byReason: {}, releasesAt: null, fullyReleasesAt: null, indefinite: 0,
  };

  it('sums counts, extremises the two timestamps', () => {
    const merged = mergeLiveStopActionability([
      { ...empty, breached: 1, inert: 1, byReason: { pdt_hold_today: 1 }, releasesAt: '2026-08-18T00:00:00.000Z', fullyReleasesAt: '2026-08-18T00:00:00.000Z' },
      { ...empty, breached: 2, inert: 1, actionable: 1, byReason: { pdt_hold_today: 1 }, releasesAt: '2026-08-19T00:00:00.000Z', fullyReleasesAt: '2026-08-19T00:00:00.000Z' },
    ]);
    expect(merged).toEqual({
      breached: 3,
      actionable: 1,
      inFlight: 0,
      inert: 2,
      byReason: { pdt_hold_today: 2 },
      releasesAt: '2026-08-18T00:00:00.000Z',   // earliest — the pile starts unwinding
      fullyReleasesAt: '2026-08-19T00:00:00.000Z', // latest — it is done
      indefinite: 0,
    });
  });

  it('one indefinite row anywhere in the fleet nulls fullyReleasesAt', () => {
    // Otherwise the fleet reading advertises an all-clear instant that a stuck
    // row will still be sitting through.
    const merged = mergeLiveStopActionability([
      { ...empty, breached: 1, inert: 1, byReason: { pdt_hold_today: 1 }, releasesAt: '2026-08-18T00:00:00.000Z', fullyReleasesAt: '2026-08-18T00:00:00.000Z' },
      { ...empty, breached: 1, inert: 1, indefinite: 1, byReason: { close_reject_breaker: 1 } },
    ]);
    expect(merged.releasesAt).toBe('2026-08-18T00:00:00.000Z');
    expect(merged.fullyReleasesAt).toBeNull();
    expect(merged.indefinite).toBe(1);
  });

  it('an empty fleet folds to all-zero with null timestamps', () => {
    expect(mergeLiveStopActionability([])).toEqual(empty);
  });
});
