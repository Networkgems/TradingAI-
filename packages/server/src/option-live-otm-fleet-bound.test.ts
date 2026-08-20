// TRA-3723 — the FLEET bound is a fitted coincidence, not an identity.
//
// TRA-3674 shipped `B_i = min(φ · availableCash_i , A)` with a comment (in
// THREE files) asserting `Σ_i φ·E_i = φ·Σ_i E_i ≡ A`, i.e. that the fleet bound
// "falls out of the arithmetic". It does not. `min(…, A)` is a PER-BOOK clamp
// and a per-book clamp cannot bound a SUM. The identity holds only while
//
//     Σ_i E_i  ≤  A / φ  =  $1,543.96
//
// because φ = 0.4858 = 750 / 1,543.96 was fitted to the fleet capital measured
// on ONE NIGHT (admin $1,143.96 + v0nni $400.00, 2026-08-14T01:0xZ).
//
// ⭐ THE POSITIVE CONTROL CONTAINS WHAT IT DETECTS. `admin at $2,000` below is
// not a hand-written expectation: every budget in it is produced by the SHIPPED
// resolver `resolveLiveOptionTestBookAggregateCapUsd`, unchanged by this
// ticket, so the $944.32 fleet sum is what the live order sites would actually
// admit. A test that asserted the breach against numbers typed into the test
// would prove only that arithmetic works.
//
// Against pre-TRA-3723 code every `gradeLiveOtmFleetBound` assertion here FAILS
// (there is no detector), while the `sumBudgets(...)` assertions PASS — that
// split is the point: the defect was always measurable from the published
// rows, and nobody took the sum.
import { describe, it, expect } from 'vitest';
import {
  LIVE_OPTION_TEST_AGGREGATE_CAP_USD,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION,
  LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD,
  resolveLiveOptionTestBookAggregateCapUsd,
  gradeLiveOtmFleetBound,
  type LiveOtmFleetBoundRow,
} from './option-exec-flag.js';

const A = LIVE_OPTION_TEST_AGGREGATE_CAP_USD; // 750 — the board's TRA-3384 authorization
const PHI = LIVE_OPTION_TEST_FLEET_RISK_FRACTION; // 0.4858 — the compiled, fitted default

/** The two production books that hold `liveEntryGateOpen`, measured 2026-08-14T01:0xZ. */
const ADMIN_CASH_TODAY = 1143.96;
const V0NNI_CASH = 400.0;

/**
 * Build the health route's row for one book EXACTLY as the engine does — the
 * budget comes from the shipped resolver, never from a literal.
 */
function bookRow(
  book: string,
  availableCashUsd: number | null,
  liveEntryGateOpen = true,
): LiveOtmFleetBoundRow {
  return {
    book,
    liveEntryGateOpen,
    availableCashUsd,
    capUsd: resolveLiveOptionTestBookAggregateCapUsd(availableCashUsd, 0, A, PHI, null),
  };
}

/** The fleet number the board authorized: the sum over the ARMED books. */
function sumBudgets(rows: LiveOtmFleetBoundRow[]): number {
  return (
    rows
      .filter(r => r.liveEntryGateOpen)
      .reduce((acc, r) => acc + Math.round(r.capUsd * 100), 0) / 100
  );
}

describe('TRA-3723 — the fleet fail-open the per-book clamp cannot catch', () => {
  it('the compiled φ is exactly the fitted ratio A / one night of balances', () => {
    // If this drifts, every number in this file is about a different scheme.
    expect(ADMIN_CASH_TODAY + V0NNI_CASH).toBe(LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD);
    expect(PHI).toBeCloseTo(A / LIVE_OPTION_TEST_FLEET_CAPITAL_BASIS_USD, 4);
  });

  it("PER BOOK the docstring's promise is kept — no book can exceed A at any balance", () => {
    // This is the true half of the claim, and it is why the defect survived
    // review: every per-book assertion anyone could write passes.
    for (const cash of [400, 1143.96, 2000, 25_000, 10_000_000]) {
      expect(resolveLiveOptionTestBookAggregateCapUsd(cash, 0, A, PHI, null)).toBeLessThanOrEqual(A);
    }
  });

  describe('POSITIVE CONTROL — admin deposits to $2,000, nothing else changes', () => {
    const fleet = [bookRow('admin', 2000.0), bookRow('v0nni', V0NNI_CASH)];

    it('the SHIPPED resolver admits $944.32 against a $750 authorization', () => {
      // Neither book broke its own bound...
      expect(fleet[0].capUsd).toBe(750.0); // min(0.4858 × 2000 = 971.60, 750)
      expect(fleet[1].capUsd).toBe(194.32); // min(0.4858 ×  400 = 194.32, 750)
      // ...and the fleet is $194.32 over anyway. No edit, no env write, no flag:
      // the trigger is a DEPOSIT.
      expect(sumBudgets(fleet)).toBe(944.32);
      expect(sumBudgets(fleet)).toBeGreaterThan(A);
    });

    it('the grade names it a breach, with the arithmetic attached', () => {
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(g.verdict).toBe('breach');
      expect(g.sumBookCapUsd).toBe(944.32);
      expect(g.overageUsd).toBe(194.32);
      expect(g.gateOpenBooks).toBe(2);
      expect(g.books).toEqual(['admin', 'v0nni']);
      // The forward-looking column says WHY: capital passed the ceiling φ assumes.
      expect(g.fleetCapitalUsd).toBe(2400.0);
      expect(g.fleetCapitalCeilingUsd).toBe(1543.85); // A/φ, to the cent
      expect(g.fleetCapitalHeadroomUsd).toBe(-856.15);
      expect(g.reason).toContain('FLEET FAIL-OPEN');
    });

    it('the breach is not a rounding artifact — it is 1000x the φ slack', () => {
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(g.roundingAllowanceUsd).toBe(0.24); // 1e-4 × $2,400
      expect(g.overageUsd!).toBeGreaterThan(g.roundingAllowanceUsd! * 100);
    });

    it('the FIRST dollar past the fitted basis is already a real overage', () => {
      // Not a cliff at $2,000: the fail-open opens the moment Σ E_i clears the
      // basis, so a $200 deposit is enough to be over by more than the slack.
      const nudged = [bookRow('admin', ADMIN_CASH_TODAY + 200), bookRow('v0nni', V0NNI_CASH)];
      const g = gradeLiveOtmFleetBound(nudged, A, PHI);
      expect(g.verdict).toBe('breach');
      // φ × the deposit, on top of the 5¢ that was already disclosed.
      expect(g.overageUsd!).toBeCloseTo(200 * PHI + 0.05, 2);
      expect(g.overageUsd!).toBeGreaterThan(g.roundingAllowanceUsd!);
    });
  });

  describe('NEGATIVE CONTROLS — the grade must not cry breach on a healthy fleet', () => {
    it("today's live balances grade `rounding_only`, NOT `breach`", () => {
      // $750.05. The five cents are φ rounded UP at the 4th place, disclosed by
      // TRA-3674 and explicitly NOT what TRA-3723 is about. A detector that
      // pages on this is a detector nobody keeps.
      const fleet = [bookRow('admin', ADMIN_CASH_TODAY), bookRow('v0nni', V0NNI_CASH)];
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(g.sumBookCapUsd).toBe(750.05);
      expect(g.verdict).toBe('rounding_only');
      expect(g.overageUsd).toBe(0.05);
      expect(g.roundingAllowanceUsd).toBe(0.15); // 1e-4 × $1,543.96
      // ⭐ And the capital column is ALREADY NEGATIVE — by 11¢, because
      // `A/φ` = $1,543.85 sits below the $1,543.96 φ was fitted to. That 11¢
      // IS the 5¢: the precondition and the overage are the same fact seen
      // from two sides. A reader who took `headroom < 0` as the breach signal
      // would page on day one, which is why the VERDICT is the sum, not this.
      expect(g.fleetCapitalCeilingUsd).toBe(1543.85);
      expect(g.fleetCapitalHeadroomUsd).toBe(-0.11);
    });

    it('a fleet strictly under the basis grades `within`', () => {
      const fleet = [bookRow('admin', 900), bookRow('v0nni', V0NNI_CASH)];
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(g.verdict).toBe('within');
      expect(g.overageUsd).toBe(0);
      expect(g.sumBookCapUsd).toBeLessThan(A);
    });

    it('landing exactly on A is `within` — a maximum is attainable', () => {
      const fleet: LiveOtmFleetBoundRow[] = [
        { book: 'admin', liveEntryGateOpen: true, capUsd: 500, availableCashUsd: 1029.3 },
        { book: 'v0nni', liveEntryGateOpen: true, capUsd: 250, availableCashUsd: 514.6 },
      ];
      expect(gradeLiveOtmFleetBound(fleet, A, PHI).verdict).toBe('within');
    });
  });

  describe('the SUM is taken on `liveEntryGateOpen`, never on `mode`', () => {
    it('a live-mode but gate-CLOSED book does not inflate the fleet', () => {
      // bqb1 carries three `mode: 'live'` books and two armed ones. Summing the
      // wrong column manufactures a breach out of a book that cannot trade —
      // and a grader that false-accuses gets switched off (TRA-3445).
      const fleet = [
        bookRow('admin', ADMIN_CASH_TODAY),
        bookRow('v0nni', V0NNI_CASH),
        bookRow('darkbook', 50_000, /* liveEntryGateOpen */ false),
      ];
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(g.gateOpenBooks).toBe(2);
      expect(g.books).not.toContain('darkbook');
      expect(g.verdict).toBe('rounding_only');
    });

    it('a gate-open book joining the arm CAN push a within fleet into breach', () => {
      const fleet = [
        bookRow('admin', ADMIN_CASH_TODAY),
        bookRow('v0nni', V0NNI_CASH),
        bookRow('third', 1500),
      ];
      // Capital, not the cap, is what moved: a book joining the arm violates
      // `Σ E_i ≤ A/φ` exactly the way a deposit does.
      expect(gradeLiveOtmFleetBound(fleet, A, PHI).verdict).toBe('breach');
    });
  });

  describe('fails to `blind`, never to `within`', () => {
    it('an unwired exposure provider is `blind`, not an empty healthy fleet', () => {
      const g = gradeLiveOtmFleetBound(null, A, PHI);
      expect(g.verdict).toBe('blind');
      expect(g.sumBookCapUsd).toBeNull();
      expect(g.overageUsd).toBeNull();
    });

    it('an unusable fleet authorization A is `blind`', () => {
      for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
        expect(gradeLiveOtmFleetBound([bookRow('admin', 2000)], bad, PHI).verdict).toBe('blind');
      }
    });

    it('a non-finite published capUsd is `blind` — the sum is unknowable', () => {
      const fleet: LiveOtmFleetBoundRow[] = [
        { book: 'admin', liveEntryGateOpen: true, capUsd: Number.NaN, availableCashUsd: 2000 },
        bookRow('v0nni', V0NNI_CASH),
      ];
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(g.verdict).toBe('blind');
      expect(g.gateOpenBooks).toBe(2); // still attributable
    });

    it('no armed book is `within` at $0 — nothing can spend', () => {
      const g = gradeLiveOtmFleetBound([bookRow('admin', 2000, false)], A, PHI);
      expect(g.verdict).toBe('within');
      expect(g.sumBookCapUsd).toBe(0);
      expect(g.gateOpenBooks).toBe(0);
    });
  });

  describe('the capital column cannot suppress the verdict (TRA-3421)', () => {
    it('an unusable φ nulls the capital columns and STILL grades the sum', () => {
      // The primary reading is `Σ capUsd` vs `A`, which needs no φ. A validity
      // gate for the secondary reading that blinded the primary one is exactly
      // the shape TRA-3421 was filed on.
      const fleet = [bookRow('admin', 2000), bookRow('v0nni', V0NNI_CASH)];
      const g = gradeLiveOtmFleetBound(fleet, A, Number.NaN);
      expect(g.verdict).toBe('breach');
      expect(g.sumBookCapUsd).toBe(944.32);
      expect(g.fleetRiskFraction).toBeNull();
      expect(g.fleetCapitalCeilingUsd).toBeNull();
      expect(g.fleetCapitalHeadroomUsd).toBeNull();
    });

    it('a book with a dark balance contributes $0 and is NAMED, not silently dropped', () => {
      // `capUsd` is 0 by fail-closed, so the sum is exact — but the reader has
      // to know the fleet was graded one book short of its potential.
      const fleet = [bookRow('admin', 2000), bookRow('v0nni', null)];
      const g = gradeLiveOtmFleetBound(fleet, A, PHI);
      expect(fleet[1].capUsd).toBe(0);
      expect(g.unreadableBalanceBooks).toEqual(['v0nni']);
      expect(g.sumBookCapUsd).toBe(750.0);
      expect(g.fleetCapitalUsd).toBe(2000.0); // readable capital only
      expect(g.verdict).toBe('within'); // honest: nothing can spend past A right now
      // …and the reason says the pass is PARTIAL, so coverage is not read as
      // correctness. This is not hypothetical: seconds after the TRA-3723
      // deploy itself, v0nni had no balance snapshot and the live fleet read
      // $555.73 `within` — 74% of the authorization, which looks like room.
      expect(g.reason).toContain('PARTIAL');
      expect(g.reason).toContain('v0nni');
      expect(g.reason).toContain('1/2');
    });

    it('a FULL fleet carries no PARTIAL caveat — the marker must discriminate', () => {
      const g = gradeLiveOtmFleetBound(
        [bookRow('admin', ADMIN_CASH_TODAY), bookRow('v0nni', V0NNI_CASH)], A, PHI,
      );
      expect(g.unreadableBalanceBooks).toEqual([]);
      expect(g.reason).not.toContain('PARTIAL');
    });

    it('a BREACH is never softened by a PARTIAL caveat — it is already over', () => {
      // The overage is real whatever the dark book would have added; hedging it
      // is how a loud finding gets read as a caveat.
      const g = gradeLiveOtmFleetBound(
        [bookRow('admin', 2000), bookRow('v0nni', V0NNI_CASH), bookRow('third', null)], A, PHI,
      );
      expect(g.verdict).toBe('breach');
      expect(g.sumBookCapUsd).toBe(944.32); // the dark book added nothing and it is STILL over
      expect(g.unreadableBalanceBooks).toEqual(['third']);
      expect(g.reason).not.toContain('PARTIAL');
    });
  });
});
