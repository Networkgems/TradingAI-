// TRA-3911 — THE ORDER PATH MUST BOUND *REACHABLE* EXPOSURE, NOT `Σ B_i`.
//
// CEO ruling, TRA-3703 comment `4b54935e`: **`A` bounds capital REACHABLE, not
// capital committed.** The served `aggregateFleetBound.verdict "within"` was not
// wrong about its own quantity — it bounds `Σ B_i`, the fleet's unspent BUDGET.
// That is simply not the quantity the board authorized.
//
// Measured live on bqb1 `020100dc56aaa43a176bb430bb3ac18bcfeab054`, pid 73,
// `startedAt 2026-08-21T00:10:46.728Z`, route stamp `00:19:40.584Z` — an
// independent reproduction, on a FRESH build, of the CEO's 23:47:29Z read and of
// LeadDev's 23:42Z read on TRA-3737 `6fe1d266`:
//
//                cap B_i    cash E_i   openRows   atRisk    headroomSigned
//     admin      $306.32    $274.68       2       $358.00      −$51.68
//     v0nni      $193.67    $400.00       0         $0.00     +$193.67
//
//     SERVED   within      Σ B_i $499.99 ≤ A $500.00
//     TRUE     reachable = $551.67 > A
//
// THE WHOLE GAP IS ONE GRANDFATHERED EXCESS. `admin`'s cap tightened underneath
// an already-open position — `A` came down on TRA-3827 and φ_eff moved — so its
// at-risk sits $51.68 above its own cap, having breached no gate: those entries
// fit the cap that was in force when they were admitted. `Σ B_i` omits that
// excess EXACTLY, because `B_i` is a budget and a budget cannot go negative.
//
// It recurs every time φ moves, so these tests are written against the TERM, not
// the instance: the live numbers appear as ONE fixture among several, and every
// invariant below is also asserted on shapes the live fleet has never been in.
//
// ⚠ THE THREE THINGS THAT ARE **NOT** THE FIX (all refused by the CEO, AC4):
//   • lowering `A` — `reachable(A) = 358 + A·(400/1032.68)` needs `A ≤ $366.60`
//     to clamp, and would not reduce at-risk by one cent. LOWERING `A` CANNOT
//     CURE AN OVERSHOOT ALREADY BELOW IT.
//   • force-closing — TRA-2693 measured that closing the window does nothing for
//     open rows; $358 is inside $500 on any reading.
//   • re-fitting φ — φ is the CONCENTRATION policy. The missing term is `Σ atRisk`.
import { describe, expect, it } from 'vitest';
import {
  fitsLiveOtmReachableBound,
  gradeLiveOtmFleetBound,
  resolveLiveOtmAdmissibleEntryUsd,
  sumLiveOtmFleetAtRiskUsd,
  type LiveOtmFleetBoundRow,
  type LiveOtmFleetCapitalRow,
} from './option-exec-flag.js';

const A = 500;

/** The 2026-08-21T00:19:40Z fleet, as `getLiveOtmFleetCapitalRow()` publishes it. */
const LIVE_CAPITAL_ROWS: LiveOtmFleetCapitalRow[] = [
  { book: 'admin', liveEntryGateOpen: true, availableCashUsd: 274.68, openPremiumAtRiskUsd: 358 },
  { book: 'v0nni', liveEntryGateOpen: true, availableCashUsd: 400, openPremiumAtRiskUsd: 0 },
  // Richard is `mode: 'live'` on SANDBOX with no options client — gate CLOSED.
  // Present so every fold below is exercised against the discriminating field
  // rather than against a pre-filtered array (TRA-3445).
  { book: 'Richard', liveEntryGateOpen: false, availableCashUsd: 9_000, openPremiumAtRiskUsd: 4_000 },
];

/** The same fleet as the GRADE reads it, on bytes that predate the AC1 gate. */
const LIVE_BOUND_ROWS_PRE_FIX: LiveOtmFleetBoundRow[] = [
  {
    book: 'admin', liveEntryGateOpen: true, capUsd: 306.32, availableCashUsd: 274.68,
    sizingBasisUsd: 632.68, openPremiumAtRiskUsd: 358, headroomSignedUsd: -51.68,
    fleetRiskFractionEffective: 0.48417709261339426, fleetCapitalUsd: 1032.68,
    fleetSizingReason: 'phi_fleet_derived',
  },
  {
    book: 'v0nni', liveEntryGateOpen: true, capUsd: 193.67, availableCashUsd: 400,
    sizingBasisUsd: 400, openPremiumAtRiskUsd: 0, headroomSignedUsd: 193.67,
    fleetRiskFractionEffective: 0.48417709261339426, fleetCapitalUsd: 1032.68,
    fleetSizingReason: 'phi_fleet_derived',
  },
];

// ---------------------------------------------------------------------------
describe('TRA-3911 AC1 — the order path bounds REACHABLE, not Σ B_i', () => {
  it('reproduces the CEO ruling arithmetic on the measured live fleet', () => {
    const fleetAtRisk = sumLiveOtmFleetAtRiskUsd(LIVE_CAPITAL_ROWS, {
      book: 'v0nni', openPremiumAtRiskUsd: 0,
    });
    // Σ_j atRisk_j is $358 — admin's, and ONLY over gate-open books. Richard's
    // $4,000 is on a sandbox book that cannot place a live order; folding it
    // would tighten every other book's entry to zero on a number that is not
    // real money at risk under this authorization.
    expect(fleetAtRisk.fleetAtRiskUsd).toBe(358);
    expect(fleetAtRisk.books).toBe(2);
    expect(fleetAtRisk.selfIncluded).toBe(true);

    const admissible = resolveLiveOtmAdmissibleEntryUsd(193.67, 0, A, fleetAtRisk);
    // ⭐ THE PASS NUMBER. v0nni's admissible entry goes $193.67 → $142.00.
    expect(admissible.admissibleUsd).toBe(142);
    expect(admissible.boundBy).toBe('fleet_reachable');
    expect(admissible.bookHeadroomSignedUsd).toBe(193.67);
    expect(admissible.fleetHeadroomSignedUsd).toBe(142);

    // ⭐ AND REACHABLE LANDS ON EXACTLY $500.00. Cost is $51.67 of headroom.
    const adminAdmissible = resolveLiveOtmAdmissibleEntryUsd(306.32, 358, A, fleetAtRisk);
    const reachable = 358 + adminAdmissible.admissibleUsd + admissible.admissibleUsd;
    expect(reachable).toBe(500);
  });

  it('THE CASE THIS TICKET IS ABOUT: a book ALREADY OVER its cap admits nothing', () => {
    // `headroomSignedUsd −51.68`. The `max(0, …)` is applied ONCE, at the END,
    // so the negative book headroom cannot be laundered into fleet headroom by
    // an earlier clamp — which is exactly what `liveOptionTestAggregateHeadroomUsd`'s
    // floor does one layer up, and exactly why the verdict could not see it.
    const fleetAtRisk = sumLiveOtmFleetAtRiskUsd(LIVE_CAPITAL_ROWS, {
      book: 'admin', openPremiumAtRiskUsd: 358,
    });
    const admissible = resolveLiveOtmAdmissibleEntryUsd(306.32, 358, A, fleetAtRisk);
    expect(admissible.bookHeadroomSignedUsd).toBe(-51.68);
    expect(admissible.admissibleUsd).toBe(0);
    expect(admissible.boundBy).toBe('none');
    expect(fitsLiveOtmReachableBound(0.01, admissible)).toBe(false);
  });

  it('the fleet term BINDS a book whose own cap would have admitted more', () => {
    // The whole point of the second operand. Pre-fix, v0nni's gate was
    // `atRisk + entry ≤ cap` = `0 + entry ≤ 193.67`, so a $150 entry passed and
    // took the fleet to $508 — over the authorization, with `Σ B_i` still
    // reading $499.99 `within` throughout.
    const fleetAtRisk = sumLiveOtmFleetAtRiskUsd(LIVE_CAPITAL_ROWS, {
      book: 'v0nni', openPremiumAtRiskUsd: 0,
    });
    const admissible = resolveLiveOtmAdmissibleEntryUsd(193.67, 0, A, fleetAtRisk);
    expect(fitsLiveOtmReachableBound(150, admissible)).toBe(false);
    expect(fitsLiveOtmReachableBound(142, admissible)).toBe(true);
    // Boundary INCLUSIVE, and cent-compared — same posture as
    // `fitsLiveOptionTestAggregateCap`, so the two gates cannot disagree about
    // their own boundary and send a reader chasing the wrong one.
    expect(fitsLiveOtmReachableBound(142.01, admissible)).toBe(false);
  });

  it('SEQUENTIAL INVARIANT: no sequence of admitted entries can take Σ atRisk past A', () => {
    // This is the property `Σ B_i ≤ A` was never able to state. The fleet fold
    // is re-read at every order, so each admission satisfies
    // `Σ_j atRisk_j + entry ≤ A` against the CURRENT sum.
    const books = [
      { book: 'admin', cash: 274.68, cap: 306.32, atRisk: 358 },
      { book: 'v0nni', cash: 400, cap: 193.67, atRisk: 0 },
    ];
    for (let round = 0; round < 6; round += 1) {
      for (const b of books) {
        const rows: LiveOtmFleetCapitalRow[] = books.map(x => ({
          book: x.book, liveEntryGateOpen: true, availableCashUsd: x.cash,
          openPremiumAtRiskUsd: x.atRisk,
        }));
        const adm = resolveLiveOtmAdmissibleEntryUsd(
          b.cap, b.atRisk, A,
          sumLiveOtmFleetAtRiskUsd(rows, { book: b.book, openPremiumAtRiskUsd: b.atRisk }),
        );
        // Take the largest entry the gate will admit, every time — the worst case.
        if (adm.admissibleUsd > 0) {
          expect(fitsLiveOtmReachableBound(adm.admissibleUsd, adm)).toBe(true);
          b.atRisk = Math.round((b.atRisk + adm.admissibleUsd) * 100) / 100;
          b.cash = Math.round((b.cash - adm.admissibleUsd) * 100) / 100;
        }
        expect(books.reduce((a, x) => a + x.atRisk, 0)).toBeLessThanOrEqual(A);
      }
    }
    // And it converges to the authorization rather than stopping short of it:
    // this is a bound, not a haircut.
    expect(books.reduce((a, x) => a + x.atRisk, 0)).toBe(A);
  });

  it('DEGRADES to the per-book bound when the fleet read is unwired — never darks a book', () => {
    // TRA-3879 AC4's contract, inherited verbatim: a missing operand costs the
    // fleet its improvement, never its floor. And the degrade is PUBLISHED, so
    // it can never be inferred from an admissible figure that looks normal.
    const unwired = sumLiveOtmFleetAtRiskUsd(null, { book: 'v0nni', openPremiumAtRiskUsd: 0 });
    expect(unwired.fleetAtRiskUsd).toBeNull();
    const admissible = resolveLiveOtmAdmissibleEntryUsd(193.67, 0, A, unwired);
    expect(admissible.admissibleUsd).toBe(193.67);
    expect(admissible.boundBy).toBe('fleet_unreadable');
    expect(admissible.fleetHeadroomSignedUsd).toBeNull();
  });

  it('an unwired provider does NOT report the caller as the whole fleet', () => {
    // The failure that would look like success: returning self's own at-risk as
    // `Σ_j atRisk_j` bounds the fleet on a strict SUBSET and calls it the fleet —
    // the same `min(…, A)`-is-per-book defect one level up, wearing a new name.
    const unwired = sumLiveOtmFleetAtRiskUsd(undefined, { book: 'admin', openPremiumAtRiskUsd: 358 });
    expect(unwired.fleetAtRiskUsd).toBeNull();
    expect(unwired.books).toBe(0);
    expect(unwired.selfIncluded).toBe(false);
  });

  it('an unreadable at-risk on a gate-open row NULLS the sum rather than contributing 0', () => {
    // The coercion direction is the opposite of `resolveLiveOtmSizingBasisUsd`'s,
    // on the SAME input, and that is why it cannot be shared: there, a missing
    // at-risk understates `E_i` and TIGHTENS the cap; here it would understate
    // `Σ atRisk` and WIDEN the headroom.
    for (const bad of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
      const rows = [
        { book: 'admin', liveEntryGateOpen: true, availableCashUsd: 274.68, openPremiumAtRiskUsd: bad },
        { book: 'v0nni', liveEntryGateOpen: true, availableCashUsd: 400, openPremiumAtRiskUsd: 0 },
      ] as unknown as LiveOtmFleetCapitalRow[];
      const fold = sumLiveOtmFleetAtRiskUsd(rows, { book: 'v0nni', openPremiumAtRiskUsd: 0 });
      expect(fold.fleetAtRiskUsd).toBeNull();
      // …and the caller therefore keeps the per-book bound, not a fabricated
      // $500 of fleet headroom.
      expect(resolveLiveOtmAdmissibleEntryUsd(193.67, 0, A, fold).boundBy).toBe('fleet_unreadable');
    }
  });

  it('our own book missing from the rows is folded in, never dropped', () => {
    // Dropping it is the loosening direction: the caller is about to ADD to the
    // very at-risk figure the sum would be missing.
    const rows: LiveOtmFleetCapitalRow[] = [
      { book: 'v0nni', liveEntryGateOpen: true, availableCashUsd: 400, openPremiumAtRiskUsd: 0 },
    ];
    const fold = sumLiveOtmFleetAtRiskUsd(rows, { book: 'admin', openPremiumAtRiskUsd: 358 });
    expect(fold.fleetAtRiskUsd).toBe(358);
    expect(fold.books).toBe(2);
    expect(fold.selfIncluded).toBe(true);
  });

  it('fails CLOSED on every unusable cap / at-risk / authorization', () => {
    const fleetAtRisk = sumLiveOtmFleetAtRiskUsd(LIVE_CAPITAL_ROWS, null);
    for (const [cap, atRisk, auth] of [
      [Number.NaN, 0, A], [0, 0, A], [-1, 0, A],
      [193.67, Number.NaN, A], [193.67, -1, A],
      [193.67, 0, 0], [193.67, 0, Number.NaN],
    ] as Array<[number, number, number]>) {
      const adm = resolveLiveOtmAdmissibleEntryUsd(cap, atRisk, auth, fleetAtRisk);
      expect(adm.admissibleUsd).toBe(0);
      expect(fitsLiveOtmReachableBound(1, adm)).toBe(false);
    }
    // An unreadable exposure is not evidence of headroom — same posture as
    // `fitsLiveOptionTestAggregateCap`, which this composes with by AND.
    const ok = resolveLiveOtmAdmissibleEntryUsd(193.67, 0, A, fleetAtRisk);
    for (const bad of [Number.NaN, 0, -5, Number.POSITIVE_INFINITY]) {
      expect(fitsLiveOtmReachableBound(bad, ok)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
describe('TRA-3911 AC2 — the verdict consumes the SIGNED column and publishes reachable', () => {
  it('PRE-FIX rows: the served `within` becomes a REACHABLE breach at $551.67', () => {
    const g = gradeLiveOtmFleetBound(LIVE_BOUND_ROWS_PRE_FIX, A, 0.4858);
    // The Σ B_i column is UNCHANGED and still published — the TRA-3879
    // invariant is real and separate, and collapsing the two is how they got
    // confused in the first place.
    expect(g.sumBookCapUsd).toBe(499.99);
    expect(g.overageUsd).toBe(0);
    // The quantity `A` actually bounds.
    expect(g.reachableSumUsd).toBe(551.67);
    expect(g.reachableOverageUsd).toBe(51.67);
    expect(g.grandfatheredExcessUsd).toBe(51.68);
    expect(g.fleetAtRiskUsd).toBe(358);
    expect(g.sumAdmissibleEntryUsd).toBe(193.67);
    expect(g.verdict).toBe('breach');
    expect(g.reachableBoundEnforced).toBe(false);
    // The reason must name the term, or the remedy it points at is the wrong one.
    expect(g.reason).toContain('REACHABLE');
    expect(g.reason).toContain('GRANDFATHERED');
    expect(g.reason).toContain('NOT enforcing');
  });

  it('reproduces the CEO closed form exactly: Σ B_i + Σ (atRisk − cap)⁺', () => {
    // The identity that makes this an implementation of the ruling rather than
    // a different number wearing its name. It holds for ANY pre-fix fleet, not
    // just the live one, because
    //   Σ (atRisk + (cap − atRisk)⁺) = Σ max(atRisk, cap) = Σ cap + Σ (atRisk − cap)⁺.
    const g = gradeLiveOtmFleetBound(LIVE_BOUND_ROWS_PRE_FIX, A, 0.4858);
    expect(g.reachableSumUsd).toBe(
      Math.round(((g.sumBookCapUsd as number) + (g.grandfatheredExcessUsd as number)) * 100) / 100,
    );
  });

  it('POST-FIX rows: reachable lands on exactly A and the verdict clears', () => {
    // ⭐ THE REASON THE CLOSED FORM COULD NOT BE THE IMPLEMENTATION.
    // `Σ B_i + Σ (atRisk − cap)⁺` is INVARIANT under the AC1 fix — neither
    // `B_i` nor `cap_i` moves — so a verdict graded on it would publish `breach`
    // forever after the order path was correctly bounded. A permanent false
    // alarm and a deleted alarm end in the same place (TRA-3881).
    const post: LiveOtmFleetBoundRow[] = [
      { ...LIVE_BOUND_ROWS_PRE_FIX[0], admissibleEntryUsd: 0, admissibleBoundBy: 'none' },
      { ...LIVE_BOUND_ROWS_PRE_FIX[1], admissibleEntryUsd: 142, admissibleBoundBy: 'fleet_reachable' },
    ];
    const g = gradeLiveOtmFleetBound(post, A, 0.4858);
    expect(g.reachableSumUsd).toBe(500);
    expect(g.reachableOverageUsd).toBe(0);
    // The grandfathered excess is STILL $51.68 and still published: it is real,
    // it is not closeable by refusing anything, and it clears when the open
    // position does. What changed is that nothing can add to it.
    expect(g.grandfatheredExcessUsd).toBe(51.68);
    expect(g.verdict).toBe('within');
    expect(g.reachableBoundEnforced).toBe(true);
    expect(g.reason).toContain('ENFORCING');
  });

  it('NEGATIVE CONTROL — the detector fires on `over cap`, not merely on `at cap`', () => {
    // Every assertion above is vacuous if the predicate cannot tell the two
    // apart, and telling them apart is the ENTIRE content of AC2: under the
    // clamped `headroomUsd`, a book $51.68 over its cap and a book exactly at it
    // are byte-identical. Same Σ B_i, same A, same φ — only the sign differs.
    const atCap: LiveOtmFleetBoundRow[] = [
      { ...LIVE_BOUND_ROWS_PRE_FIX[0], openPremiumAtRiskUsd: 306.32, headroomSignedUsd: 0 },
      { ...LIVE_BOUND_ROWS_PRE_FIX[1] },
    ];
    const gAt = gradeLiveOtmFleetBound(atCap, A, 0.4858);
    expect(gAt.grandfatheredExcessUsd).toBe(0);
    expect(gAt.reachableSumUsd).toBe(499.99);
    expect(gAt.verdict).toBe('within');

    const overCap = gradeLiveOtmFleetBound(LIVE_BOUND_ROWS_PRE_FIX, A, 0.4858);
    expect(overCap.verdict).toBe('breach');
    // Same Σ B_i on both readings — proof the discrimination came from the
    // SIGNED column and from nothing else.
    expect(gAt.sumBookCapUsd).toBe(overCap.sumBookCapUsd);
  });

  it('a row that publishes at-risk but NOT the signed column still grades right', () => {
    // `headroomSignedUsd` is recomputed from `capUsd − openPremiumAtRiskUsd`,
    // never defaulted to 0 — a producer may supply either.
    const rows = LIVE_BOUND_ROWS_PRE_FIX.map(r => ({ ...r, headroomSignedUsd: undefined }));
    const g = gradeLiveOtmFleetBound(rows, A, 0.4858);
    expect(g.grandfatheredExcessUsd).toBe(51.68);
    expect(g.reachableSumUsd).toBe(551.67);
    expect(g.verdict).toBe('breach');
  });

  it('PRE-TRA-3897 bytes: reachable is NULL, not 0, and the reason says so', () => {
    // "Nothing is at risk" is the fail-open reading of this exact field. A build
    // that cannot compute the term must say it cannot, and the verdict falls
    // back to the quantity it CAN compute rather than blinding the whole object.
    const rows = LIVE_BOUND_ROWS_PRE_FIX.map(r => ({
      ...r, openPremiumAtRiskUsd: undefined, headroomSignedUsd: undefined,
    }));
    const g = gradeLiveOtmFleetBound(rows, A, 0.4858);
    expect(g.reachableSumUsd).toBeNull();
    expect(g.grandfatheredExcessUsd).toBeNull();
    expect(g.fleetAtRiskUsd).toBeNull();
    expect(g.reachableBoundEnforced).toBe(false);
    expect(g.verdict).toBe('within');
    expect(g.reason).toContain('REACHABLE UNREADABLE');
  });

  it('a blind grade publishes NULL reachable, never 0, and never `enforced`', () => {
    const g = gradeLiveOtmFleetBound(null, A, 0.4858);
    expect(g.verdict).toBe('blind');
    expect(g.reachableSumUsd).toBeNull();
    expect(g.reachableOverageUsd).toBeNull();
    expect(g.grandfatheredExcessUsd).toBeNull();
    expect(g.fleetAtRiskUsd).toBeNull();
    expect(g.reachableBoundEnforced).toBe(false);
  });

  it('a row whose order site fell back to per-book is NOT counted as enforcing', () => {
    // `fleet_unreadable` is an ADMIT, and it is the one state where the fleet
    // term is not in force. It must never be inferred from an admissible figure
    // that merely looks normal.
    const mixed: LiveOtmFleetBoundRow[] = [
      { ...LIVE_BOUND_ROWS_PRE_FIX[0], admissibleEntryUsd: 0, admissibleBoundBy: 'none' },
      {
        ...LIVE_BOUND_ROWS_PRE_FIX[1],
        admissibleEntryUsd: 193.67, admissibleBoundBy: 'fleet_unreadable',
      },
    ];
    const g = gradeLiveOtmFleetBound(mixed, A, 0.4858);
    expect(g.reachableBoundEnforced).toBe(false);
    expect(g.reachableSumUsd).toBe(551.67);
    expect(g.verdict).toBe('breach');
  });

  it('gate-CLOSED books are excluded from every reachable column', () => {
    // Summed on `liveEntryGateOpen`, never on `mode` (TRA-3445). Richard is
    // live-mode on sandbox with $4,000 at risk and no options client; folding it
    // would manufacture a breach out of money this authorization does not cover.
    const withClosed: LiveOtmFleetBoundRow[] = [
      ...LIVE_BOUND_ROWS_PRE_FIX,
      {
        book: 'Richard', liveEntryGateOpen: false, capUsd: 500, availableCashUsd: 9_000,
        sizingBasisUsd: 13_000, openPremiumAtRiskUsd: 4_000, headroomSignedUsd: -3_500,
      },
    ];
    const g = gradeLiveOtmFleetBound(withClosed, A, 0.4858);
    expect(g.gateOpenBooks).toBe(2);
    expect(g.fleetAtRiskUsd).toBe(358);
    expect(g.reachableSumUsd).toBe(551.67);
  });
});
