import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  gradeLiveOtmFleetBound,
  type LiveOtmFleetBoundRow,
} from './option-exec-flag.js';

/**
 * TRA-3881 — `aggregateFleetBound` published `fleetCapitalCeilingUsd` /
 * `fleetCapitalHeadroomUsd` against the STALE φ long after TRA-3879 retired the
 * precondition they describe, so a healthy fleet served
 *
 *     verdict: "within" … fleetCapitalHeadroomUsd: -120.81
 *
 * on a real-money health route — permanently, on every reading, by construction.
 * A permanent false alarm gets muted, and a muted alarm and a deleted alarm end
 * in the same place.
 *
 * ⭐ EVERY SCENARIO HERE IS BUILT FROM THE CAPTURED LIVE PAYLOAD, NOT FROM
 * LITERALS (TRA-3723). `tra3737-live-bound-in-force-2026-08-20.json` is the
 * verbatim 04:06Z reading this ticket was filed against — bqb1 `2e4654b142d4`,
 * two armed books, `phi_fleet_derived`, complete at 2/2. A test asserting
 * numbers typed into the test proves only that arithmetic works; a test built
 * from the bytes that shipped proves something about the system.
 */

const CAPTURE = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../scripts/fixtures/tra3737-live-bound-in-force-2026-08-20.json', import.meta.url)),
    'utf8',
  ),
) as {
  fee: {
    aggregateCapUsd: number;
    fleetRiskFraction: number;
    aggregateFleetBound: { fleetCapitalCeilingUsd: number; fleetCapitalHeadroomUsd: number };
    aggregateExposure: Array<LiveOtmFleetBoundRow & { liveEntryGateOpen: boolean }>;
  };
};

const A = CAPTURE.fee.aggregateCapUsd;
const PHI = CAPTURE.fee.fleetRiskFraction;
/** The armed rows exactly as bqb1 served them. */
const liveRows = (): LiveOtmFleetBoundRow[] =>
  JSON.parse(JSON.stringify(CAPTURE.fee.aggregateExposure)) as LiveOtmFleetBoundRow[];
const armed = () => liveRows().filter(r => r.liveEntryGateOpen === true);

/** The ONE-LINE restatement of the defect, in the units it was filed in. */
const SERVED_CEILING = CAPTURE.fee.aggregateFleetBound.fleetCapitalCeilingUsd; // 1029.23
const SERVED_HEADROOM = CAPTURE.fee.aggregateFleetBound.fleetCapitalHeadroomUsd; // -120.81

describe('TRA-3881 — the fitted ceiling is published only where it still governs', () => {
  it('the CAPTURE really is the incident: healthy, derived, complete, and carrying a negative headroom', () => {
    // A control that does not contain what it detects is a control over nothing.
    expect(SERVED_HEADROOM).toBeLessThan(0);
    expect(SERVED_CEILING).toBeCloseTo(A / PHI, 2);
    const rows = armed();
    expect(rows).toHaveLength(2);
    expect(rows.every(r => r.fleetSizingReason === 'phi_fleet_derived')).toBe(true);
    expect(rows.every(r => r.availableCashUsd !== null)).toBe(true);
  });

  // ---- AC1 -------------------------------------------------------------
  describe('AC1 — every armed book on phi_fleet_derived', () => {
    const g = () => gradeLiveOtmFleetBound(armed(), A, PHI);

    it('withholds the fitted ceiling/headroom pair rather than serving a stale one', () => {
      expect(g().fleetCapitalCeilingUsd).toBeNull();
      expect(g().fleetCapitalHeadroomUsd).toBeNull();
    });

    it('NO published numeric field implies the fleet is over a limit', () => {
      const grade = g() as unknown as Record<string, unknown>;
      expect(grade.verdict).toBe('within');
      // The blanket assertion, not a field list: a future field that adds a new
      // way to publish a negative dollar figure fails HERE, without anyone
      // remembering to extend this test.
      const negatives = Object.entries(grade)
        .filter(([k, v]) => typeof v === 'number' && v < 0 && k.endsWith('Usd'))
        .map(([k, v]) => `${k}=${v}`);
      expect(negatives).toEqual([]);
      expect(grade.overageUsd).toBe(0);
    });

    it('names WHY it withheld them, and points at the instrument that replaced them', () => {
      const basis = g().fleetCapitalCeilingBasis;
      expect(basis).toMatch(/withheld/);
      expect(basis).toMatch(/phi_fleet_derived/);
      expect(basis).toMatch(/fleetSizedHeadroomUsd/);
      // "absent" and "absent for a reason" must not look alike.
      expect(basis.length).toBeGreaterThan(0);
    });

    it('publishes the bound that DOES govern: φ_eff · Σ E_i = A to the cent, headroom $0.00', () => {
      const grade = g();
      expect(grade.fleetSizingReason).toBe('phi_fleet_derived');
      expect(grade.fleetRiskFractionEffective).toBe(armed()[0]!.fleetRiskFractionEffective);
      expect(grade.fleetSizedMaxSumUsd).toBe(A);
      expect(grade.fleetSizedHeadroomUsd).toBe(0);
      // ⚠ NOT -0: a signed zero serialises as 0 but compares as a different
      // value, and the whole ticket is about a sign that reads as an alarm.
      expect(Object.is(grade.fleetSizedHeadroomUsd, -0)).toBe(false);
    });

    it('DETECTS the pre-fix behaviour — this assertion is the defect restated', () => {
      // Demonstrates rather than detects: the served capture still carries it.
      expect(SERVED_HEADROOM).toBe(-120.81);
      // Detects: the shipped grader no longer reproduces it.
      expect(g().fleetCapitalHeadroomUsd).not.toBe(SERVED_HEADROOM);
    });
  });

  // ---- AC2 -------------------------------------------------------------
  describe('AC2 — phi_configured with a complete fleet read', () => {
    /**
     * A genuine `phi_configured` reading is one where φ BINDS, i.e.
     * `A/Σ E_i ≥ φ`. Built from the live rows by raising `A` past the point
     * where the derived branch takes over — the same books, the same balances,
     * the same φ, one authorization moved. Nothing is typed in but the new `A`.
     */
    const capital = armed().reduce((s, r) => s + (r.availableCashUsd ?? 0), 0);
    const bigA = Math.ceil(PHI * capital) + 100; // φ binds comfortably
    const configuredRows = () =>
      armed().map(r => ({
        ...r,
        capUsd: Math.floor(PHI * (r.availableCashUsd ?? 0) * 100) / 100,
        fleetRiskFractionEffective: PHI,
        fleetSizingReason: 'phi_configured' as const,
      }));

    it('still publishes the pair — the fitted precondition is genuinely what bounds that budget', () => {
      const grade = gradeLiveOtmFleetBound(configuredRows(), bigA, PHI);
      expect(grade.fleetSizingReason).toBe('phi_configured');
      expect(grade.fleetCapitalCeilingUsd).toBe(Math.round((bigA / PHI) * 100) / 100);
      expect(grade.fleetCapitalHeadroomUsd).toBe(
        Math.round((grade.fleetCapitalCeilingUsd! - capital) * 100) / 100,
      );
      expect(grade.fleetCapitalCeilingBasis).toMatch(/IN FORCE/);
    });

    it('reads EXACTLY as it does today on the pre-TRA-3879 bytes it was built for', () => {
      // Rows with no sizing block at all = a build from before TRA-3879. There
      // the fitted precondition is the ONLY thing between Σ B_i and A, so
      // retiring the instrument would delete the TRA-3723 finding itself.
      const legacy = armed().map(({ book, liveEntryGateOpen, capUsd, availableCashUsd }) => ({
        book, liveEntryGateOpen, capUsd, availableCashUsd,
      }));
      const grade = gradeLiveOtmFleetBound(legacy, A, PHI);
      expect(grade.fleetSizingReason).toBeNull();
      expect(grade.fleetCapitalCeilingUsd).toBe(SERVED_CEILING);
      expect(grade.fleetCapitalHeadroomUsd).toBe(SERVED_HEADROOM);
      expect(grade.fleetCapitalCeilingBasis).toMatch(/pre-TRA-3879/);
    });
  });

  // ---- AC3 -------------------------------------------------------------
  describe('AC3 — fleet_capital_unreadable keeps the pair, and keeps its teeth', () => {
    /**
     * The one state where `Σ B_i` is unbounded again: the cross-engine read was
     * unwired or threw, so each book fell back to `min(φ·E_i, A)` — the
     * pre-TRA-3879 bound. A change that blinds the detector HERE is worse than
     * the wrong sign, because it removes the evidence too.
     */
    const unreadableRows = () =>
      armed().map(r => ({
        ...r,
        capUsd: Math.min(Math.floor(PHI * (r.availableCashUsd ?? 0) * 100) / 100, A),
        fleetRiskFractionEffective: PHI,
        fleetCapitalUsd: null,
        fleetSizingReason: 'fleet_capital_unreadable' as const,
      }));

    it('publishes the ceiling AND lets the headroom go negative', () => {
      const grade = gradeLiveOtmFleetBound(unreadableRows(), A, PHI);
      expect(grade.fleetSizingReason).toBe('fleet_capital_unreadable');
      expect(grade.fleetCapitalCeilingUsd).toBe(SERVED_CEILING);
      expect(grade.fleetCapitalHeadroomUsd).toBe(SERVED_HEADROOM);
      expect(grade.fleetCapitalHeadroomUsd!).toBeLessThan(0);
      expect(grade.fleetCapitalCeilingBasis).toMatch(/fleet_capital_unreadable/);
    });

    it('the sum really IS unbounded there — the verdict breaches, not just the column', () => {
      const grade = gradeLiveOtmFleetBound(unreadableRows(), A, PHI);
      expect(grade.verdict).toBe('breach');
      expect(grade.overageUsd!).toBeGreaterThan(0);
      // And the second instrument agrees, from different arithmetic.
      expect(grade.fleetSizedHeadroomUsd!).toBeLessThan(0);
    });

    it('ONE unreadable book among derived ones is enough — the evidence wins the tie', () => {
      const mixed = armed();
      mixed[1] = {
        ...mixed[1]!,
        fleetCapitalUsd: null,
        fleetRiskFractionEffective: PHI,
        fleetSizingReason: 'fleet_capital_unreadable',
      };
      const grade = gradeLiveOtmFleetBound(mixed, A, PHI);
      expect(grade.fleetSizingReason).toBe('mixed');
      expect(grade.fleetCapitalCeilingUsd).not.toBeNull();
      expect(grade.fleetCapitalCeilingBasis).toMatch(/IN FORCE/);
    });
  });

  // ---- the suppression must not be buyable with a label ------------------
  describe('the label does not buy the suppression — the arithmetic does', () => {
    it('rows CLAIMING phi_fleet_derived with a φ_eff that misses the bound keep the old instrument', () => {
      // The TRA-3831 shape: rename the reason to something reassuring and the
      // gate must still refuse. Here φ_eff is left at the STALE φ while the rows
      // assert the derived branch — exactly what a regression at the order site
      // would look like from this route.
      const lying = armed().map(r => ({
        ...r,
        fleetRiskFractionEffective: PHI,
        fleetSizingReason: 'phi_fleet_derived' as const,
      }));
      const grade = gradeLiveOtmFleetBound(lying, A, PHI);
      expect(grade.fleetSizingReason).toBe('phi_fleet_derived'); // the claim is published
      expect(grade.fleetCapitalCeilingUsd).toBe(SERVED_CEILING); // and not believed
      expect(grade.fleetCapitalHeadroomUsd).toBe(SERVED_HEADROOM);
      expect(grade.fleetCapitalCeilingBasis).toMatch(/EXCEEDS A/);
      expect(grade.fleetSizedHeadroomUsd!).toBeLessThan(0);
    });

    it('a fleet read that missed a book shows up as a negative fleetSizedHeadroomUsd', () => {
      // Each row's self-reported Σ E_i is HALVED while the balances stay put, so
      // φ_eff is derived too loose. The grade takes Σ E_i from its own capital
      // column — a different column — which is what catches this.
      const short = armed().map(r => ({
        ...r,
        fleetCapitalUsd: (r.fleetCapitalUsd ?? 0) / 2,
        fleetRiskFractionEffective: A / ((r.fleetCapitalUsd ?? 0) / 2),
        fleetSizingReason: 'phi_fleet_derived' as const,
      }));
      const grade = gradeLiveOtmFleetBound(short, A, PHI);
      expect(grade.fleetSizedMaxSumUsd!).toBeGreaterThan(A);
      expect(grade.fleetSizedHeadroomUsd!).toBeLessThan(0);
      expect(grade.fleetCapitalCeilingUsd).not.toBeNull();
    });
  });

  // ---- the always-on instrument -----------------------------------------
  describe('fleetSizedMaxSumUsd / fleetSizedHeadroomUsd are never suppressed', () => {
    for (const [name, rows] of [
      ['live derived capture', () => armed()],
      ['unreadable fleet read', () => armed().map(r => ({ ...r, fleetCapitalUsd: null, fleetSizingReason: 'fleet_capital_unreadable' as const }))],
      ['legacy rows', () => armed().map(({ book, liveEntryGateOpen, capUsd, availableCashUsd }) => ({ book, liveEntryGateOpen, capUsd, availableCashUsd }))],
    ] as const) {
      it(`publishes on: ${name}`, () => {
        const grade = gradeLiveOtmFleetBound(rows(), A, PHI);
        expect(grade.fleetSizedMaxSumUsd).not.toBeNull();
        expect(grade.fleetSizedHeadroomUsd).not.toBeNull();
        expect(grade.fleetCapitalCeilingBasis).toBeTruthy();
      });
    }

    it('φ_eff is taken at its LOOSEST across the arm, never the first or the mean', () => {
      const rows = armed();
      rows[0] = { ...rows[0]!, fleetRiskFractionEffective: 0.01 };
      const grade = gradeLiveOtmFleetBound(rows, A, PHI);
      // A mean or a first-row read would let the 0.01 hide the other book's
      // fraction, and Σ B_i is bounded only if the LARGEST holds.
      expect(grade.fleetRiskFractionEffective).toBe(rows[1]!.fleetRiskFractionEffective);
    });

    it('a blind grade nulls them and says so — never a silent absence', () => {
      const grade = gradeLiveOtmFleetBound(null, A, PHI);
      expect(grade.verdict).toBe('blind');
      expect(grade.fleetSizedMaxSumUsd).toBeNull();
      expect(grade.fleetSizedHeadroomUsd).toBeNull();
      expect(grade.fleetSizingReason).toBeNull();
      expect(grade.fleetCapitalCeilingBasis).toMatch(/blind/);
    });
  });
});
