// TRA-5297 — `liveStopGovernance` published the MIN release across a row's
// concurrent holds, where the instant the row becomes actionable is the MAX.
//
// THE POPULATION, measured on bqb1 pid 76 (booted 2026-10-07T11:51:07.068Z,
// sha `73c7f495077e76422faa87e7ee4bce28131244b0`) — two reads on the SAME
// process, 50 minutes apart, over the same two real-money rows:
//
//                            13:0xZ (pre-open)          13:52:46Z (post-release)
//   heldBy                   {opening_range_hold: 2,    {daily_close_hold: 2}
//                             daily_close_hold: 2}
//   multiHeld                2                          0
//   releasesAt               2026-10-07T13:45:00.000Z   2026-10-07T19:30:00.000Z
//   byClass.held_with_release 2                         2
//   nothingWillAct           2                          2
//
// At 13:0xZ BOTH holds were in force. `opening_range_hold` lifted at 13:45Z;
// `daily_close_hold` ran to 19:30Z. So the earliest instant either row could be
// acted on was 19:30Z, and the field said 13:45Z — understating the ungoverned
// span by 5h45m.
//
// The field misleads ONLY when `multiHeld > 0`, which is exactly when a reader
// needs it: once a row is singly held the min and the max coincide and the
// surface reads perfectly correct. That self-concealment is why this is a fix
// and not a doc note, and it is why EVERY assertion below is written over a
// row with >= 2 concurrent clocked gates at DISTINCT instants (AC2). A
// single-held row cannot distinguish min from max, so a green read on one would
// be vacuous rather than passing.
//
// The cost is on the record: TRA-5296 was filed off the 13:0xZ read and its
// description asserts "nothing will act on them until 13:45Z", scoping a whole
// acceptance criterion around a post-13:45Z read. The agent that wrote it had
// `multiHeld: 2` and `heldBy` in the same payload and still took the published
// scalar at face value.
import { describe, it, expect } from 'vitest';
import {
  summarizeLiveStopGovernance,
  mergeLiveStopGovernance,
  blindLiveStopGovernance,
  type LiveStopActionabilityContext,
} from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';

/**
 * 2026-10-07T13:05:00Z — 09:05 ET, 25 minutes BEFORE the RTH open, which is the
 * phase the 13:0xZ live read was taken in. Both gates bind here:
 *
 *   • `opening_range_hold` — the walk's predicate is `minutesSinceRthOpen <
 *     openingRangeGuardMin`, and a pre-open tick counts as inside (TRA-3902),
 *     so −25 < 15 holds. Release = `now + (15 − (−25))·60s` = **13:45Z**.
 *   • `daily_close_hold` — outside the close window under the `daily_close`
 *     policy. Release = the start of today's window = `now + (360 − (−25))·60s`
 *     = **19:30Z** (`RTH_SESSION_MIN 390 − closeWindowMin 30`).
 *
 * Both instants are reproduced from the clock, not pinned — so this fixture
 * really is the live pair and not two hand-written strings that happen to look
 * like it.
 */
const PRE_OPEN = Date.UTC(2026, 9, 7, 13, 5, 0);
const OPENING_RANGE_RELEASE = '2026-10-07T13:45:00.000Z';
const DAILY_CLOSE_RELEASE = '2026-10-07T19:30:00.000Z';

/** Days earlier, so neither date-keyed hold (`pdt` / `swing`) is in the walk. */
const OPENED_AT = Date.UTC(2026, 9, 2, 14, 30, 0);

/**
 * The 2026-10-07 live posture: mirror up, `daily_close` policy with a 30-minute
 * window, a 15-minute opening-range guard. `holdLiveOptionsOvernightForPdt` is
 * on (it was) and is inert here because the rows opened days ago — deliberately
 * left ON rather than switched off, so the fixture is the real runtime.
 */
const MONEY_BOOK_1007: LiveStopActionabilityContext = {
  brokerMirroring: true,
  autoManageImportedTradierOptions: true,
  actOnAdoptedBrokerRows: false,
  holdLiveOptionsOvernightForPdt: true,
  swingHoldOptions: false,
  openingRangeGuardMin: 15,
  liveStopPolicy: { policy: 'daily_close', closeWindowMin: 30, catastrophicLossPct: 0.5 },
  now: PRE_OPEN,
};

function liveRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'row',
    symbol: 'SOFI',
    optionSymbol: 'SOFI261016C00030000',
    optionType: 'call',
    strike: 30,
    expiration: '2026-10-16',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.0,
    currentPremium: 0.9,
    tp1Premium: 1.5,
    tp1Hit: false,
    stopLossPremium: 0.8,
    peakPremium: 1.0,
    trailingActive: false,
    trailingStopPremium: 0,
    underlyingEntryPrice: 0,
    openedAt: OPENED_AT,
    signalId: 'otm-SOFI261016C00030000',
    signalType: 'otm_mispricing',
    mode: 'live',
    ...overrides,
  };
}

/** The two carried G2 rows: same book, same two gates, same two instants. */
const MULTI_HELD_PAIR = (): OptionPosition[] => [
  liveRow({ id: 'sofi-149507369' }),
  liveRow({
    id: 'nu-149502608',
    symbol: 'NU',
    optionSymbol: 'NU261016C00016000',
    strike: 16,
    premiumPaid: 0.6,
    currentPremium: 0.55,
    tp1Premium: 0.9,
    stopLossPremium: 0.48,
    peakPremium: 0.6,
    signalId: 'otm-NU261016C00016000',
  }),
];

describe('TRA-5297 — the fixture really is multi-held (AC2 denominator)', () => {
  it('reproduces the 10-07 pair: 2 clocked gates, 2 distinct instants, multiHeld 2', () => {
    // If this ever stops holding, every assertion below is VACUOUS rather than
    // passing — a single-held row cannot tell a min from a max. It is first in
    // the file for that reason.
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), MONEY_BOOK_1007);
    expect(g.rows).toBe(2);
    expect(g.heldBy).toEqual({ opening_range_hold: 2, daily_close_hold: 2 });
    expect(g.multiHeld).toBe(2);
    expect(g.byClass.held_with_release).toBe(2);
    expect(g.byClass.held_indefinite).toBe(0);
    expect(g.nothingWillAct).toBe(2);
    expect(g.recovery.automatic).toBe(2);
    // The two gates lift at DIFFERENT instants, which is the other half of the
    // precondition: identical instants would also make min == max.
    expect(OPENING_RANGE_RELEASE).not.toBe(DAILY_CLOSE_RELEASE);
  });
});

describe('TRA-5297 AC1 — the published horizon reflects actionability', () => {
  it('`actionableAt` is the LATER gate (19:30Z), not the earlier one (13:45Z)', () => {
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), MONEY_BOOK_1007);
    // THE REGRESSION. Under the pre-fix fold this read 13:45Z, understating the
    // span nothing would act in by 5h45m.
    expect(g.actionableAt).toBe(DAILY_CLOSE_RELEASE);
    expect(g.actionableAt).not.toBe(OPENING_RANGE_RELEASE);
  });

  it('`nextHoldReleaseAt` still carries the EARLIEST release event — renamed, not deleted', () => {
    // The old value is not wrong, it was mis-NAMED: 13:45Z is when the next
    // thing changes, i.e. when a reader should look again. Keeping it under an
    // honest name is why this fix does not delete a truthful surface.
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), MONEY_BOOK_1007);
    expect(g.nextHoldReleaseAt).toBe(OPENING_RANGE_RELEASE);
  });

  it('`fullyReleasesAt` is when the LAST held row is actionable', () => {
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), MONEY_BOOK_1007);
    // Both rows carry the identical gate pair, so all three rows of the horizon
    // collapse onto the same two instants here; the staggered case is below.
    expect(g.fullyReleasesAt).toBe(DAILY_CLOSE_RELEASE);
  });

  it('the invariant holds: nextHoldReleaseAt <= actionableAt <= fullyReleasesAt', () => {
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), MONEY_BOOK_1007);
    expect(g.nextHoldReleaseAt).not.toBeNull();
    expect(g.actionableAt).not.toBeNull();
    expect(g.fullyReleasesAt).not.toBeNull();
    expect(g.nextHoldReleaseAt! <= g.actionableAt!).toBe(true);
    expect(g.actionableAt! <= g.fullyReleasesAt!).toBe(true);
    // …and it is a STRICT inequality on this population, so the test is not
    // passing because all three fields are the same number.
    expect(g.nextHoldReleaseAt! < g.actionableAt!).toBe(true);
  });

  it('separates the three horizons when the rows are staggered, not just the gates', () => {
    // One row held by both gates (actionable 19:30Z), one held by the opening
    // range alone (actionable 13:45Z). `actionableAt` must be the FIRST row's
    // own max — 13:45Z — while `fullyReleasesAt` is 19:30Z. Reading either as
    // the other collapses the pair.
    //
    // The second row escapes `daily_close_hold` through the ONE door the walk
    // leaves open outside the close window: it is catastrophically breached
    // (`mark <= premiumPaid × (1 − 0.5)`). That branch also needs `inSession`,
    // which is false pre-open — so instead this row takes the policy out of the
    // picture per-book and the staggered case is built as a fleet fold below.
    const bothGates = summarizeLiveStopGovernance([liveRow({ id: 'both' })], MONEY_BOOK_1007);
    const openingRangeOnly = summarizeLiveStopGovernance(
      [liveRow({ id: 'opening-only' })],
      // Same instant, no `daily_close` policy ⇒ `dailyClosePhase` is null and
      // the only gate left is the opening range.
      { ...MONEY_BOOK_1007, liveStopPolicy: undefined },
    );
    expect(openingRangeOnly.heldBy).toEqual({ opening_range_hold: 1 });
    expect(openingRangeOnly.multiHeld).toBe(0);

    const fleet = mergeLiveStopGovernance([bothGates, openingRangeOnly]);
    expect(fleet.held).toBe(2);
    expect(fleet.nextHoldReleaseAt).toBe(OPENING_RANGE_RELEASE);
    // The earliest row to become actionable is the singly-held one.
    expect(fleet.actionableAt).toBe(OPENING_RANGE_RELEASE);
    // …and the last one is the multi-held row, at its LATER gate.
    expect(fleet.fullyReleasesAt).toBe(DAILY_CLOSE_RELEASE);
  });
});

describe('TRA-5297 — an unclocked gate has no actionability instant', () => {
  /** A close-reject latch with its whole probe budget spent — no release. */
  const EXHAUSTED_LATCH = { closeRejectCount: 7, closeRejectProbeCount: 4 } as const;

  it('a row with one unclocked gate contributes NOTHING, and does not borrow its siblings\' max', () => {
    // The permissive direction this ticket is about, one level deeper: a row
    // held by {exhausted latch, opening range, daily close} has no instant at
    // which it becomes actionable at all. Folding its clocked gates' max in
    // anyway would publish 19:30Z for a row that needs a human.
    const g = summarizeLiveStopGovernance(
      [liveRow({ id: 'latched', ...EXHAUSTED_LATCH })],
      MONEY_BOOK_1007,
    );
    expect(g.heldBy.close_reject_breaker_exhausted).toBe(1);
    expect(g.byClass.held_indefinite).toBe(1);
    expect(g.byClass.held_with_release).toBe(0);
    expect(g.actionableAt).toBeNull();
    expect(g.fullyReleasesAt).toBeNull();
    // …while the release EVENT is still real: the clocked siblings do lift.
    expect(g.nextHoldReleaseAt).toBe(OPENING_RANGE_RELEASE);
  });

  it('one indefinite row nulls `fullyReleasesAt` but not `actionableAt`', () => {
    const rows = [liveRow({ id: 'clocked' }), liveRow({ id: 'latched', ...EXHAUSTED_LATCH })];
    const g = summarizeLiveStopGovernance(rows, MONEY_BOOK_1007);
    expect(g.byClass.held_with_release).toBe(1);
    expect(g.byClass.held_indefinite).toBe(1);
    // A row IS scheduled to become actionable…
    expect(g.actionableAt).toBe(DAILY_CLOSE_RELEASE);
    // …but no instant exists by which EVERY held row is, so claiming one would
    // read as "all clear by then" (the sibling surface's TRA-3822 convention).
    expect(g.fullyReleasesAt).toBeNull();
  });

  it('the fleet fold nulls `fullyReleasesAt` when ANY book holds an indefinite row', () => {
    const clocked = summarizeLiveStopGovernance([liveRow({ id: 'clocked' })], MONEY_BOOK_1007);
    const latched = summarizeLiveStopGovernance(
      [liveRow({ id: 'latched', ...EXHAUSTED_LATCH })],
      MONEY_BOOK_1007,
    );
    expect(clocked.fullyReleasesAt).toBe(DAILY_CLOSE_RELEASE);
    const fleet = mergeLiveStopGovernance([clocked, latched]);
    expect(fleet.byClass.held_indefinite).toBe(1);
    expect(fleet.actionableAt).toBe(DAILY_CLOSE_RELEASE);
    expect(fleet.fullyReleasesAt).toBeNull();
    // Order must not matter — the nulling is applied once, after every book's
    // class counts are in, not folded in book order.
    expect(mergeLiveStopGovernance([latched, clocked]).fullyReleasesAt).toBeNull();
  });
});

describe('TRA-5297 negative controls', () => {
  it('a singly-held row collapses all three horizons — the self-concealing read', () => {
    // 13:52:46Z on the live box: `opening_range_hold` has lifted, `multiHeld 0`,
    // and the surface reads correct. This is the state the OLD field was right
    // in, and it is why the defect survived. A suite built only on this row
    // would have gone green against the bug.
    const postRelease: LiveStopActionabilityContext = {
      ...MONEY_BOOK_1007,
      now: Date.UTC(2026, 9, 7, 13, 52, 46),
    };
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), postRelease);
    expect(g.heldBy).toEqual({ daily_close_hold: 2 });
    expect(g.multiHeld).toBe(0);
    expect(g.nextHoldReleaseAt).toBe(DAILY_CLOSE_RELEASE);
    expect(g.actionableAt).toBe(DAILY_CLOSE_RELEASE);
    expect(g.fullyReleasesAt).toBe(DAILY_CLOSE_RELEASE);
  });

  it('a governed book publishes three nulls, and an empty book does too', () => {
    const healthy = summarizeLiveStopGovernance(
      // Nothing holds it: no opening-range guard, no daily-close policy.
      [liveRow({ id: 'healthy', currentPremium: 1.2 })],
      { ...MONEY_BOOK_1007, openingRangeGuardMin: 0, liveStopPolicy: undefined },
    );
    expect(healthy.byClass.governed).toBe(1);
    expect(healthy.nextHoldReleaseAt).toBeNull();
    expect(healthy.actionableAt).toBeNull();
    expect(healthy.fullyReleasesAt).toBeNull();

    const empty = summarizeLiveStopGovernance([], MONEY_BOOK_1007);
    expect(empty.actionableAt).toBeNull();
    expect(empty.fullyReleasesAt).toBeNull();
    const fleet = mergeLiveStopGovernance([]);
    expect(fleet.actionableAt).toBeNull();
    expect(fleet.fullyReleasesAt).toBeNull();
  });

  it('a `no_stop_written` row has no gate to lift and is not in the horizons', () => {
    // The horizons are scoped to HELD rows. A row with nothing to act ON is in
    // `nothingWillAct` and its remedy is `liveUnmanagedRisk`'s (TRA-2820), not
    // a clock's — publishing a release instant for it would promise a fix the
    // clock cannot deliver.
    const g = summarizeLiveStopGovernance(
      [liveRow({ id: 'nostop', stopLossPremium: 0 })],
      MONEY_BOOK_1007,
    );
    expect(g.byClass.no_stop_written).toBe(1);
    expect(g.held).toBe(0);
    expect(g.nothingWillAct).toBe(1);
    expect(g.actionableAt).toBeNull();
    expect(g.fullyReleasesAt).toBeNull();
  });

  it('the blind shape still names every key, including the two new ones', () => {
    // The TRA-3839 discipline: the blind reading is TYPED off the success shape,
    // so a horizon cannot ship on one branch only. A key that is an instant
    // when the instrument works and ABSENT when it is blind renders as "no
    // release scheduled" either way.
    const blind = blindLiveStopGovernance();
    const g = summarizeLiveStopGovernance(MULTI_HELD_PAIR(), MONEY_BOOK_1007);
    expect(Object.keys(blind).sort()).toEqual(Object.keys(g).sort());
    expect(blind.actionableAt).toBeNull();
    expect(blind.fullyReleasesAt).toBeNull();
    expect(blind.nextHoldReleaseAt).toBeNull();
    // The old name must be GONE, not aliased: an alias that still parses as an
    // ISO string and now means something else is the silent direction.
    expect(Object.keys(g)).not.toContain('releasesAt');
  });
});
