import { describe, expect, it } from 'vitest';
import {
  LIVE_BALANCE_SETTLEMENT_GRACE_MS,
  foldUnsettledLivePremiumUsd,
  isLivePremiumUnsettled,
  resolveEffectiveFleetRiskFraction,
  resolveLiveOptionTestBookAggregateCapUsd,
  resolveLiveOtmSizingBasisUsd,
  resolveSettledAvailableCashUsd,
} from './option-exec-flag.js';

/**
 * TRA-3964 — the two halves of `E_i` are snapshots taken up to 120s apart.
 *
 * The engine-level grader lives in `signal-engine.test.ts`
 * (`unsettled premium (TRA-3964)`) because the defect is a TIMING property of
 * the order path and only the order path can express it. This file pins the
 * pure folds underneath it, and — the part that is not arithmetic — reproduces
 * the SIZE of the fail-open on the live book from the SHIPPED resolvers, so the
 * `φ_eff · x` claim is measured rather than asserted.
 */
describe('TRA-3964 — unsettled live premium', () => {
  describe('resolveSettledAvailableCashUsd', () => {
    it('deducts the pending premium, cent-exact', () => {
      expect(resolveSettledAvailableCashUsd(500, 82)).toBe(418);
      expect(resolveSettledAvailableCashUsd(379.15, 36.9)).toBe(342.25);
      // Float-safe: 0.1 + 0.2 arithmetic must not leak a 1e-14 tail into a cap.
      expect(resolveSettledAvailableCashUsd(0.3, 0.1)).toBe(0.2);
    });

    it('is a NO-OP when nothing is pending — the fix must not tighten a quiet book', () => {
      expect(resolveSettledAvailableCashUsd(500, 0)).toBe(500);
      expect(resolveSettledAvailableCashUsd(1143.96, 0)).toBe(1143.96);
    });

    it('keeps the existing fail-closed verdict on an unusable balance', () => {
      // `null`, never 0 — `no_balance_snapshot` must stay distinguishable from
      // a genuinely empty account, exactly as before this ticket.
      expect(resolveSettledAvailableCashUsd(null, 0)).toBeNull();
      expect(resolveSettledAvailableCashUsd(undefined, 0)).toBeNull();
      expect(resolveSettledAvailableCashUsd(Number.NaN, 0)).toBeNull();
      expect(resolveSettledAvailableCashUsd(-1, 0)).toBeNull();
    });

    it('FAILS CLOSED on an unusable deduction — "unreadable" must not read as "deduct nothing"', () => {
      // The whole ticket is about a term that goes missing in the loosening
      // direction. A `NaN` correction silently coerced to 0 would be that same
      // bug with a new spelling.
      expect(resolveSettledAvailableCashUsd(500, Number.NaN)).toBeNull();
      expect(resolveSettledAvailableCashUsd(500, Number.POSITIVE_INFINITY)).toBeNull();
      expect(resolveSettledAvailableCashUsd(500, undefined as unknown as number)).toBeNull();
    });

    it('floors at $0 rather than darkening a book that spent nearly all its cash', () => {
      // A NEGATIVE cash half is rejected by `resolveLiveOtmSizingBasisUsd` as
      // unusable, which would take the book OUT — a different failure from the
      // one being fixed. $0 is the honest reading: no spendable cash, `E_i`
      // equal to the premium already at risk, cap stops moving.
      expect(resolveSettledAvailableCashUsd(50, 82)).toBe(0);
      expect(resolveLiveOtmSizingBasisUsd(resolveSettledAvailableCashUsd(50, 82), 82)).toBe(82);
    });
  });

  describe('isLivePremiumUnsettled / foldUnsettledLivePremiumUsd', () => {
    const T = 1_700_000_000_000;
    const fill = { filledAtMs: T, premiumUsd: 82 };

    it('a snapshot taken BEFORE the fill cannot contain it', () => {
      expect(isLivePremiumUnsettled(fill, T - 1)).toBe(true);
      expect(isLivePremiumUnsettled(fill, T)).toBe(true);
    });

    it('⭐ a snapshot taken just AFTER the fill is NOT enough — the settlement race', () => {
      // This is why the one-line "refresh on `filled`" fix inverts the failure:
      // a balance fetched microseconds after the fill acknowledgment can come
      // back PRE-DEBIT, and clearing on it restores the double-count with the
      // refresh clock pushed out a further 120s.
      expect(isLivePremiumUnsettled(fill, T + 1)).toBe(true);
      expect(isLivePremiumUnsettled(fill, T + LIVE_BALANCE_SETTLEMENT_GRACE_MS - 1)).toBe(true);
      expect(isLivePremiumUnsettled(fill, T + LIVE_BALANCE_SETTLEMENT_GRACE_MS)).toBe(false);
    });

    it('no snapshot has ever landed ⇒ EVERYTHING is unsettled', () => {
      expect(isLivePremiumUnsettled(fill, 0)).toBe(true);
      expect(foldUnsettledLivePremiumUsd([fill], 0)).toEqual({ usd: 82, fills: 1, blindFills: 0 });
    });

    it('an unreadable fill timestamp reads UNSETTLED, never settled', () => {
      // An unreadable stamp must not become a licence to stop deducting.
      expect(isLivePremiumUnsettled(
        { filledAtMs: Number.NaN, premiumUsd: 82 }, T + 86_400_000,
      )).toBe(true);
    });

    it('folds only the pending fills, and counts them', () => {
      const asOf = T + LIVE_BALANCE_SETTLEMENT_GRACE_MS;
      const fills = [
        { filledAtMs: T - 60_000, premiumUsd: 156 },  // long settled
        { filledAtMs: T, premiumUsd: 82 },            // exactly on the grace ⇒ settled
        { filledAtMs: T + 1_000, premiumUsd: 36.9 },  // still pending
        { filledAtMs: T + 2_000, premiumUsd: 25 },    // still pending
      ];
      expect(foldUnsettledLivePremiumUsd(fills, asOf)).toEqual({
        usd: 61.9, fills: 2, blindFills: 0,
      });
    });

    it('an unreadable premium is counted as $0 but REPORTED — not silently absent', () => {
      // A `NaN` in the sum would null the whole basis and dark the book over one
      // malformed record. Counting it as 0 makes the correction UNDERSTATE, so
      // the understatement has to be readable rather than assumed away.
      const out = foldUnsettledLivePremiumUsd(
        [{ filledAtMs: T, premiumUsd: Number.NaN }, { filledAtMs: T, premiumUsd: 82 }], 0,
      );
      expect(out).toEqual({ usd: 82, fills: 2, blindFills: 1 });
    });

    it('an empty / absent list is $0 with 0 blind fills', () => {
      expect(foldUnsettledLivePremiumUsd([], T)).toEqual({ usd: 0, fills: 0, blindFills: 0 });
      expect(foldUnsettledLivePremiumUsd(null, T)).toEqual({ usd: 0, fills: 0, blindFills: 0 });
    });
  });

  // ── THE SIZE OF THE FAIL-OPEN, ON THE LIVE BOOK ────────────────────────────
  // bqb1 `admin`, live SHA `355ca553b437`, 2026-08-22: cash $379.15, at-risk
  // $273.00 ⇒ `E_i` $652.15, `φ_eff` 0.475217, `capUsd` $309.91. The fleet `A`
  // is $500 and the rest of the fleet contributes `E` $400 — SOLVED from the
  // published row, not assumed: those two are the only pair that reproduce
  // `φ_eff 0.475217` and `capUsd $309.91` together, and they then reproduce the
  // whole counterfactual table to the cent (below).
  //
  // Both columns come from the SAME shipped resolver. The only difference is
  // which cash figure it is handed: the stale snapshot (skewed) or the one net
  // of the premium just spent (true). Nothing here is re-derived by hand.
  describe('the overstatement, on the live admin row', () => {
    const CASH_USD = 379.15;
    const AT_RISK_USD = 273.00;
    const FLEET_CAP_USD = 500;
    const PHI = 0.4858;
    /** `Σ E_j` over the fleet EXCLUDING this book. */
    const OTHER_BOOKS_CAPITAL_USD = 400;

    /**
     * The cap the order site would resolve, with `Σ E_i` folded the way the
     * fleet read folds it: THIS book's basis plus the others'.
     *
     * ⚠ Self is INSIDE the fleet sum, which is why the overstatement is not
     * simply `φ_eff · x` — see the table test below.
     */
    const capFor = (cashUsd: number, atRiskUsd: number) => {
      const basis = resolveLiveOtmSizingBasisUsd(cashUsd, atRiskUsd) as number;
      return resolveLiveOptionTestBookAggregateCapUsd(
        cashUsd, atRiskUsd, FLEET_CAP_USD, PHI, basis + OTHER_BOOKS_CAPITAL_USD,
      );
    };

    it('reproduces the live row before any counterfactual — the positive control', () => {
      expect(resolveLiveOtmSizingBasisUsd(CASH_USD, AT_RISK_USD)).toBe(652.15);
      const phiEff = resolveEffectiveFleetRiskFraction(
        PHI, FLEET_CAP_USD, 652.15 + OTHER_BOOKS_CAPITAL_USD,
      ).phiEffective;
      expect(phiEff).toBeCloseTo(0.475217, 6);
      expect(capFor(CASH_USD, AT_RISK_USD)).toBe(309.91);
    });

    it.each([
      // fill $x · skewed capUsd · skewed headroomSigned · TRUE headroomSigned
      [25.00, 314.32, 16.32, 11.91],
      [36.90, 316.35, 6.45, 0.01],
      [50.00, 318.53, -4.47, -13.09],
      [100.00, 326.41, -46.59, -63.09],
      [156.00, 334.45, -94.55, -119.09],
    ])('a $%s fill: cap $%s, headroom $%s where the settled book has $%s', (x, cap, skewHs, trueHs) => {
      const atRisk = AT_RISK_USD + x;

      // SKEWED — what `355ca553` publishes for up to 120s after the fill: the
      // cash half is still pre-fill while the premium half already has the $x.
      const skewedCap = capFor(CASH_USD, atRisk);
      // TRUE — the cash half net of the premium that just left the account.
      const trueCap = capFor(resolveSettledAvailableCashUsd(CASH_USD, x) as number, atRisk);

      expect(skewedCap).toBe(cap);
      expect(skewedCap - atRisk).toBeCloseTo(skewHs, 2);
      expect(trueCap - atRisk).toBeCloseTo(trueHs, 2);
      // ⭐ The direction is the whole ticket: the skew always ADMITS more, and
      // by more the bigger the fill that caused it.
      expect(skewedCap).toBeGreaterThan(trueCap);
      // The settled cap does NOT move with the fill — that is the invariance.
      expect(trueCap).toBe(309.91);
    });

    it('the overstatement is BELOW φ_eff · x — φ_eff re-derives down as ΣE inflates', () => {
      // ⚠ The filing prose says the overstatement is `φ_eff · x`. That is the
      // per-book term only. This book's basis is INSIDE `Σ E_i`, so inflating it
      // also inflates the fleet sum and pushes `φ_eff = A/ΣE` down, which damps
      // the error. Measured: a $156 fill overstates by $24.54, not by
      // `0.475217 × 156 = $74.13`. The damping is a coincidence of the fleet's
      // composition, not a safeguard — it vanishes the moment `φ` (rather than
      // `A/ΣE`) is the binding constraint.
      for (const x of [25, 36.9, 50, 100, 156]) {
        const atRisk = AT_RISK_USD + x;
        const over = capFor(CASH_USD, atRisk)
          - capFor(resolveSettledAvailableCashUsd(CASH_USD, x) as number, atRisk);
        expect(over).toBeGreaterThan(0);
        expect(over).toBeLessThan(0.475217 * x);
      }
    });

    it('after spending its whole allowance the true book has $0.01 left, the skewed one offers $6.45', () => {
      // The concrete consequence, and the sharpest statement of the defect: the
      // engine offers a further $6.45 of admission out of a book that is full.
      const x = 36.90;
      const atRisk = AT_RISK_USD + x;
      const trueHeadroom = capFor(
        resolveSettledAvailableCashUsd(CASH_USD, x) as number, atRisk,
      ) - atRisk;
      expect(trueHeadroom).toBeCloseTo(0.01, 2);
      expect(capFor(CASH_USD, atRisk) - atRisk).toBeCloseTo(6.45, 2);
    });

    it('the corrected basis is INVARIANT across the fill — which is what TRA-3897 claimed', () => {
      // `E_i` must not move when cash turns into premium. Under the raw snapshot
      // it moves UP by the whole fill; under the correction it does not move.
      for (const x of [25, 36.9, 50, 100, 156]) {
        const corrected = resolveLiveOtmSizingBasisUsd(
          resolveSettledAvailableCashUsd(CASH_USD, x) as number, AT_RISK_USD + x,
        );
        expect(corrected).toBeCloseTo(652.15, 2);
        expect(resolveLiveOtmSizingBasisUsd(CASH_USD, AT_RISK_USD + x)).toBeCloseTo(652.15 + x, 2);
      }
    });
  });
});
