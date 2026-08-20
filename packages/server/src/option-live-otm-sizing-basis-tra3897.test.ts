// TRA-3897 — the sizing basis was CASH, and cash is the wrong side of the
// transaction the cap bounds.
//
// `capUsd = φ · availableCash` is a ceiling on a book's TOTAL at-risk
// (`fitsLiveOptionTestAggregateCap` is `atRisk + entry ≤ cap`). Buying an option
// for `x` moves `atRisk` UP by `x` and moves `cap` DOWN by `φ·x`, because the
// cash that funded it left the basis. The two operands were measured on
// OPPOSITE SIDES of the same transaction, and the consequences were both
// measured live on bqb1 `1fed3f51c65c`:
//
//   1. THE FLEET METRIC MOVED THE WRONG WAY WHEN RISK WAS TAKEN. 03:07Z
//      `aggregateFleetBound.verdict` `breach`, Σ B_i $558.68 vs A $500. 20:33Z
//      the same field `within`, Σ B_i $327.75 — NO fix shipped in between; the
//      sleeve had converted $273.00 of cash into two real-money contracts.
//   2. ANY BOOK SPENDING MORE THAN `φ/(1+φ)` OF ITS CASH ENDED UP PERMANENTLY
//      OVER ITS OWN PUBLISHED CAP, BY CONSTRUCTION — 32.7% at φ 0.4858, having
//      broken no gate. `admin`: spent $273.00 against a $179.07 tipping point,
//      carrying `openPremiumAtRiskUsd $334.00` against `capUsd $133.43`.
//
// This file grades the ARITHMETIC of the remedy. The remedy's effect on the
// ADMIT DECISION is graded against the ENGINE in `signal-engine.test.ts`
// ("TRA-3897 — the sizing basis at the ORDER SITE"), because an order site that
// ignores the basis passes every arithmetic test there is — which is exactly
// how TRA-3674 shipped believed-safe.
//
// ⚠ AGAINST PRE-TRA-3897 CODE the invariance and over-cap assertions here FAIL
// and the flat-fleet ones PASS. That split is deliberate: on a flat fleet the
// capital basis reduces to cash EXACTLY, so this is a strict generalization and
// no existing claim in the suite had to be re-based to make room for it.
import { describe, it, expect } from 'vitest';
import {
  LIVE_OPTION_TEST_AGGREGATE_CAP_USD,
  LIVE_OPTION_TEST_FLEET_RISK_FRACTION,
  resolveLiveOtmSizingBasisUsd,
  resolveLiveOptionTestBookAggregateCapUsd,
  sumLiveOtmFleetCapitalUsd,
  fitsLiveOptionTestAggregateCap,
  liveOptionTestAggregateHeadroomUsd,
  liveOptionTestAggregateHeadroomSignedUsd,
  type LiveOtmFleetCapitalRow,
} from './option-exec-flag.js';

const A = LIVE_OPTION_TEST_AGGREGATE_CAP_USD; // 750 — the compiled authorization
const PHI = LIVE_OPTION_TEST_FLEET_RISK_FRACTION; // 0.4858 — the compiled, fitted φ

/** `B_i` as the order site resolves it, per book only (no fleet read). */
const cap = (cash: number | null, atRisk: number, fleetCapitalUsd: number | null = null) =>
  resolveLiveOptionTestBookAggregateCapUsd(cash, atRisk, A, PHI, fleetCapitalUsd);

const row = (
  book: string, availableCashUsd: number | null, openPremiumAtRiskUsd: number,
): LiveOtmFleetCapitalRow => ({
  book, liveEntryGateOpen: true, availableCashUsd, openPremiumAtRiskUsd,
});

describe('TRA-3897 — E_i is CAPITAL (cash + at-risk), not cash', () => {
  it('is a STRICT GENERALIZATION — on a FLAT book the basis IS the cash', () => {
    // The load-bearing compatibility claim. Every pre-existing control in this
    // suite varies balances on flat books, so if this holds to the cent none of
    // them needed re-basing — and none were re-based.
    for (const cash of [0, 1, 100, 400, 750, 1143.96, 1543.96, 5000, 100_000]) {
      expect(resolveLiveOtmSizingBasisUsd(cash, 0)).toBe(cash);
      expect(cap(cash, 0)).toBe(Math.min(Math.floor(cash * PHI * 100) / 100, A));
    }
    // The two live books, verbatim from TRA-3674's measurement.
    expect(cap(1143.96, 0)).toBe(555.73);
    expect(cap(400, 0)).toBe(194.32);
  });

  it('THE DEFECT, reproduced on the pre-fix basis — 32.7% of cash puts a book '
     + 'permanently over its own cap having broken no gate', () => {
    // `admin` on 2026-08-20, to the cent. Capital $547.68 (cash $274.68 + the
    // $273.00 it had just spent). The tipping point is `φ/(1+φ)` of the
    // PRE-SPEND cash — 32.696% at φ 0.4858, i.e. $179.07 here. (The filing
    // quoted $199.02 off a slightly different cash figure; the FRACTION is the
    // claim, and it is asserted rather than quoted.)
    const CASH_AFTER = 274.68;
    const SPENT = 273.0;
    expect(PHI / (1 + PHI)).toBeCloseTo(0.32696, 5);
    const threshold = (PHI / (1 + PHI)) * (CASH_AFTER + SPENT);
    expect(threshold).toBeCloseTo(179.07, 2);
    expect(SPENT).toBeGreaterThan(threshold);

    // PRE-FIX: the basis is the cash that is LEFT, so the cap collapses below
    // the position it is supposed to be bounding. The book is over its own cap
    // by an amount nothing in the order path can undo.
    const preFixCap = Math.min(Math.floor(CASH_AFTER * PHI * 100) / 100, A);
    expect(preFixCap).toBeCloseTo(133.43, 2);
    expect(preFixCap).toBeLessThan(SPENT);

    // POST-FIX: sized on capital. STILL over — the fix does not retroactively
    // clear `admin`, and overselling it as if it did would be the dishonest
    // reading. It cuts the overage from $139.57 to $6.94, and the residue is
    // the separate per-order sequencing question named in the filing.
    expect(cap(CASH_AFTER, SPENT)).toBeCloseTo(266.06, 2);
    expect(SPENT - preFixCap).toBeCloseTo(139.57, 2);
    expect(SPENT - cap(CASH_AFTER, SPENT)).toBeCloseTo(6.94, 2);
  });

  it('AC1 — the cap is INVARIANT across the cash→premium conversion', () => {
    // The book is held FIXED except for the conversion itself: capital $1,000,
    // spending `x` moves cash down by `x` and at-risk up by the same `x`. This
    // is the only candidate basis with that property, and it holds EXACTLY
    // (not approximately) because `foldOpenPremiumAtRisk` bases on the ENTRY
    // premium, never the mark — so a cap can never relax out of unrealized
    // gains either.
    const CAPITAL = 1000;
    const flat = cap(CAPITAL, 0);
    expect(flat).toBe(485.8);
    for (const x of [0, 1, 50, 200, 327.5, 400, 485.8, 900, 1000]) {
      expect(cap(CAPITAL - x, x)).toBe(flat);
      expect(resolveLiveOtmSizingBasisUsd(CAPITAL - x, x)).toBe(CAPITAL);
    }
    // …and the pre-fix cap fell on every one of those steps. Asserted rather
    // than described, so this test fails on a build that reverts the basis.
    const preFix = [0, 200, 400, 900].map(x => Math.floor((CAPITAL - x) * PHI * 100) / 100);
    for (let i = 1; i < preFix.length; i += 1) {
      expect(preFix[i]).toBeLessThan(preFix[i - 1]!);
    }
  });

  it('AC1 — an ADMITTED entry can never push a book past its own cap', () => {
    // The property that makes consequence 2 structurally impossible going
    // forward: admitting `x` requires `atRisk + x ≤ φ·E`, and `E` does not move
    // when the order fills, so `atRisk'` is still `≤ cap'`. Swept over the
    // whole admit surface rather than argued.
    for (const capital of [100, 400, 547.68, 1000, 1543.96, 5000]) {
      let cash = capital;
      let atRisk = 0;
      // Spend in $25 slices for as long as the gate admits, then assert the
      // book is INSIDE its cap at every step — including the last one.
      for (let i = 0; i < 400; i += 1) {
        const budget = cap(cash, atRisk);
        if (!fitsLiveOptionTestAggregateCap(atRisk, 25, budget)) break;
        cash -= 25;
        atRisk += 25;
        expect(cap(cash, atRisk)).toBeGreaterThanOrEqual(atRisk);
        expect(liveOptionTestAggregateHeadroomSignedUsd(atRisk, cap(cash, atRisk)))
          .toBeGreaterThanOrEqual(0);
      }
      // Vacuity guard: the loop must actually have admitted something, or the
      // assertions above are true of nothing.
      expect(atRisk).toBeGreaterThan(0);
    }
  });

  it('THE CEO\'s FINDING — Σ B_i no longer FALLS when the fleet takes risk', () => {
    // 2026-08-20 to the cent: `admin` converts $273.00 of cash into two
    // real-money contracts, `v0nni` flat at $400. Nothing else moves.
    const before = [row('admin', 547.68, 0), row('v0nni', 400, 0)];
    const after = [row('admin', 274.68, 273.0), row('v0nni', 400, 0)];

    const sumBudgets = (rows: LiveOtmFleetCapitalRow[]) => {
      const fleet = sumLiveOtmFleetCapitalUsd(rows);
      return rows.reduce(
        (acc, r) => acc + Math.round(
          cap(r.availableCashUsd, r.openPremiumAtRiskUsd, fleet.fleetCapitalUsd) * 100,
        ), 0,
      ) / 100;
    };

    expect(sumLiveOtmFleetCapitalUsd(before).fleetCapitalUsd).toBe(947.68);
    // ⭐ The fleet's capital does NOT shrink because the fleet bought something.
    expect(sumLiveOtmFleetCapitalUsd(after).fleetCapitalUsd).toBe(947.68);
    expect(sumBudgets(after)).toBe(sumBudgets(before));

    // The pre-fix behaviour, asserted so the regression is detectable: cash
    // alone falls by exactly what was spent, and so does every budget derived
    // from it. A reader grepping the route the next day would have seen the
    // breach "heal" without a line of code changing.
    const cashOnly = (rows: LiveOtmFleetCapitalRow[]) =>
      rows.reduce((acc, r) => acc + (r.availableCashUsd ?? 0), 0);
    expect(cashOnly(before) - cashOnly(after)).toBeCloseTo(273.0, 2);
  });

  it('Σ B_i ≤ A survives the basis change — φ_eff still binds the SUM', () => {
    // TRA-3879's structural bound is `φ_eff = min(φ, A / Σ E_i)`, and it is
    // stated over `Σ E_i`. Moving what `E_i` MEANS could have broken it, so it
    // is re-proved here over fleets that straddle `A/φ` in both directions.
    const fleets: Array<Array<[number, number]>> = [
      [[1143.96, 0], [400, 0]],
      [[274.68, 273.0], [400, 0]],
      [[100, 5000], [10_000, 0], [0, 0]],
      [[5000, 5000], [5000, 5000]],
      [[1, 0]],
    ];
    for (const f of fleets) {
      const rows = f.map(([c, r], i) => row(`b${i}`, c, r));
      const fleet = sumLiveOtmFleetCapitalUsd(rows);
      const sum = rows.reduce(
        (acc, r) => acc + Math.round(
          cap(r.availableCashUsd, r.openPremiumAtRiskUsd, fleet.fleetCapitalUsd) * 100,
        ), 0,
      ) / 100;
      expect(sum).toBeLessThanOrEqual(A);
    }
  });

  it('FAILS CLOSED on unreadable CASH, and DEGRADES (never darks) on unreadable '
     + 'at-risk', () => {
    // Cash: unchanged from the cash-only resolver — `no_balance_snapshot` keeps
    // its existing fail-closed verdict and this change adds no second one.
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1, -0.01]) {
      expect(resolveLiveOtmSizingBasisUsd(bad, 100)).toBeNull();
      expect(cap(bad as number | null, 100)).toBe(0);
    }
    // At-risk: coerces to 0, i.e. the basis degrades to CASH — which is exactly
    // the bound in force before this ticket. Per TRA-3879's rule a missing
    // operand costs the fleet its improvement, never its floor. It can only
    // ever UNDERSTATE `E_i`, so the resulting cap is tighter, never looser.
    for (const bad of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(resolveLiveOtmSizingBasisUsd(1000, bad)).toBe(1000);
      expect(cap(1000, bad as unknown as number)).toBe(cap(1000, 0));
      expect(cap(1000, bad as unknown as number)).toBeLessThanOrEqual(cap(1000, 250));
    }
  });

  it('sums in whole CENTS — no float drift creeps in through the second operand',
    () => {
      // Both halves are rounded to cents before being added, the same
      // discipline `sumLiveOtmFleetCapitalUsd` already used on cash alone.
      expect(resolveLiveOtmSizingBasisUsd(0.1, 0.2)).toBe(0.3);
      expect(resolveLiveOtmSizingBasisUsd(274.68, 273.0)).toBe(547.68);
      expect(sumLiveOtmFleetCapitalUsd([row('a', 0.1, 0.2), row('b', 0.1, 0.2)])
        .fleetCapitalUsd).toBe(0.6);
    });
});

describe('TRA-3897 AC2 — a book OVER its cap must not read as one exactly AT it', () => {
  it('the clamped field cannot separate them and the signed one can', () => {
    // `admin`'s live reading: cap $133.43 against $334.00 at risk. The route
    // served `0`, byte-identical to a book that had spent its budget to the
    // cent. A clamped metric is a deleted alarm (TRA-3827, same shape on a
    // different field; and the 08-17 breach in `canary-ceiling.ts`'s header).
    expect(liveOptionTestAggregateHeadroomUsd(334.0, 133.43)).toBe(0);
    expect(liveOptionTestAggregateHeadroomUsd(133.43, 133.43)).toBe(0);
    // ⭐ The two now differ, ON THE FIELD, without arithmetic by the reader.
    expect(liveOptionTestAggregateHeadroomSignedUsd(334.0, 133.43)).toBe(-200.57);
    expect(liveOptionTestAggregateHeadroomSignedUsd(133.43, 133.43)).toBe(0);
  });

  it('the two fields never disagree about whether a reading EXISTS', () => {
    // Only about its sign. A sibling that went `null` on inputs the original
    // reads (or vice versa) would make "over cap" and "unreadable" the new
    // indistinguishable pair — the defect moved rather than fixed.
    const inputs: Array<[number, number]> = [
      [0, 100], [100, 100], [334, 133.43], [Number.NaN, 100], [-1, 100],
      [100, 0], [100, -1], [100, Number.NaN], [100, Number.POSITIVE_INFINITY],
    ];
    for (const [atRisk, capUsd] of inputs) {
      const clamped = liveOptionTestAggregateHeadroomUsd(atRisk, capUsd);
      const signed = liveOptionTestAggregateHeadroomSignedUsd(atRisk, capUsd);
      expect(signed === null).toBe(clamped === null);
      if (signed !== null) expect(clamped).toBe(Math.max(0, signed));
    }
  });

  it('AC2 HAZARD — the clamped field KEEPS its non-negative range', () => {
    // The filing's own warning: `headroomUsd` has been non-negative on every
    // reading ever served, so anything consuming it may assume that. The signed
    // figure therefore arrives ADDITIVELY, as a sibling, rather than by
    // widening this field underneath its readers.
    for (const [atRisk, capUsd] of [[0, 100], [50, 100], [100, 100], [500, 100]]) {
      const v = liveOptionTestAggregateHeadroomUsd(atRisk!, capUsd!);
      expect(v).not.toBeNull();
      expect(v!).toBeGreaterThanOrEqual(0);
    }
  });
});
