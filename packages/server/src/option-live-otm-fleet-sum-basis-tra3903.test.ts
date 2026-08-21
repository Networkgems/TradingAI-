// TRA-3903 (residual of TRA-3897) — `Σ E_i` INSIDE THE GRADE was still CASH.
//
// TRA-3897 re-based the per-book cap on CAPITAL (`E_i = availableCash +
// openPremiumAtRisk`). The per-book half shipped and works. The GRADE's own
// fold did not follow, so one `aggregateFleetBound` object served:
//
//     sumBookCapUsd        $499.99   the Σ B_i it was actually serving
//     fleetSizedMaxSumUsd  $326.66   published as the CEILING on that same sum
//     fleetSizedHeadroomUsd $173.34  advertised headroom
//     (true headroom)        $0.01
//
// A ceiling cannot sit $173.33 below the value it is a ceiling ON. Measured on
// bqb1 `f3718bcee7a6` 2026-08-20T23:52Z over a COMPLETE population
// (`unreadableBalanceBooks: []`) with the OTM sleeve ARMED.
//
// ⚠⚠ WHAT THIS IS NOT. The filing predicted a second, independent defect: that
// the ENGINE's runtime `Σ E_i` was cash-only too, which would make `φ_eff` too
// large and let `Σ B_i` grow past `A` — TRA-3723's fail-open reborn. PROBED
// FIRST, per AC3, and REFUTED: on the same reading every armed row published
// `fleetCapitalUsd 1032.68` (the correct capital sum) and `φ_eff 0.484177 =
// A/1032.68`, and the served caps reproduce exactly as `φ_eff · E_i`. The order
// site was sizing on the RIGHT basis the whole time. Only the grade's column
// was wrong, so this is a DETECTOR defect, not a live fail-open — which is why
// nothing here touches `verdict`.
//
// That distinction is the finding, not a caveat: the remedy for a lying
// instrument is different from the remedy for an unbounded fleet, and shipping
// the second when you have the first is how a fix that "also blinds the
// detector" gets written.
//
// ⭐ EVERY NUMBER BELOW COMES FROM THE CAPTURED LIVE PAYLOAD. Nothing is typed.
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  gradeLiveOtmFleetBound,
  type LiveOtmFleetBoundRow,
} from './option-exec-flag.js';

/** The verbatim capture of the contradiction, taken while it was on the wire. */
const CAPTURE = JSON.parse(
  readFileSync(
    new URL(
      '../../../scripts/fixtures/tra3903-live-detector-contradiction-2026-08-20.json',
      import.meta.url,
    ),
    'utf8',
  ),
) as {
  live: { build: { commitShort: string; startedAt: string } };
  fee: {
    aggregateCapUsd: number;
    fleetRiskFraction: number;
    aggregateFleetBound: {
      verdict: string;
      sumBookCapUsd: number;
      fleetCapitalUsd: number;
      fleetSizedMaxSumUsd: number;
      fleetSizedHeadroomUsd: number;
      unreadableBalanceBooks: unknown[];
    };
    aggregateExposure: Array<Record<string, unknown>>;
  };
};

const A = CAPTURE.fee.aggregateCapUsd;
const PHI = CAPTURE.fee.fleetRiskFraction;
const SERVED = CAPTURE.fee.aggregateFleetBound;
/** The armed rows exactly as the route published them. */
const rows = () =>
  JSON.parse(JSON.stringify(CAPTURE.fee.aggregateExposure)) as LiveOtmFleetBoundRow[];
const armed = () => rows().filter(r => r.liveEntryGateOpen === true);
const cents = (n: number) => Math.round(n * 100);

describe('TRA-3903 — the capture is the incident (else every control here is vacuous)', () => {
  it('the live route published a ceiling BELOW the sum it was serving', () => {
    expect(CAPTURE.live.build.commitShort).toBe('f3718bcee7a6');
    expect(SERVED.verdict).toBe('within');
    expect(SERVED.unreadableBalanceBooks).toEqual([]);
    expect(SERVED.fleetSizedMaxSumUsd).toBeLessThan(SERVED.sumBookCapUsd);
    expect(SERVED.sumBookCapUsd - SERVED.fleetSizedMaxSumUsd).toBeCloseTo(173.33, 2);
    // The headroom it advertised vs the headroom that existed.
    expect(SERVED.fleetSizedHeadroomUsd).toBeCloseTo(173.34, 2);
    expect(A - SERVED.sumBookCapUsd).toBeCloseTo(0.01, 2);
  });

  it('the two columns in one payload disagree about what E_i means', () => {
    const basis = armed().reduce((s, r) => s + cents(r.sizingBasisUsd as number), 0) / 100;
    const cash = armed().reduce((s, r) => s + cents(r.availableCashUsd as number), 0) / 100;
    expect(SERVED.fleetCapitalUsd).toBeCloseTo(cash, 2); // the grade folded CASH
    expect(basis).toBeGreaterThan(cash); // the rows publish CAPITAL
    expect(basis - cash).toBeCloseTo(358.0, 2); // admin's open premium, exactly
  });
});

describe('TRA-3903 AC3 — defect (2) is PROBED, and refuted', () => {
  it('the ORDER SITE was sizing on the correct capital basis all along', () => {
    // The strongest available proof that the engine's runtime Σ E_i was NOT
    // cash-only: each row's self-reported fleet capital equals the CAPITAL sum,
    // and each served cap reproduces as φ_eff · E_i to the cent. If the runtime
    // sum had been cash-only these three columns could not all agree.
    const basis = armed().reduce((s, r) => s + cents(r.sizingBasisUsd as number), 0) / 100;
    for (const r of armed()) {
      expect(r.fleetCapitalUsd).toBeCloseTo(basis, 2);
      expect(r.fleetRiskFractionEffective).toBeCloseTo(A / basis, 9);
      expect(cents(r.capUsd)).toBe(
        cents(Math.floor((r.fleetRiskFractionEffective as number) * (r.sizingBasisUsd as number) * 100) / 100),
      );
    }
    // …and therefore Σ B_i ≤ A genuinely held. No fail-open on this reading.
    const sumB = armed().reduce((s, r) => s + cents(r.capUsd), 0) / 100;
    expect(sumB).toBeLessThanOrEqual(A);
  });
});

describe('TRA-3903 AC1 — the grade folds the SAME basis the rows publish', () => {
  it('fleetCapitalUsd equals Σ sizingBasisUsd, taken from a DIFFERENT column', () => {
    // CROSS-COLUMN, per AC1: Σ E_i for the assertion comes off `sizingBasisUsd`,
    // never from re-reading the field under test (TRA-3881 — read one column
    // twice and the check is vacuous).
    const expected = armed().reduce((s, r) => s + cents(r.sizingBasisUsd as number), 0) / 100;
    const g = gradeLiveOtmFleetBound(rows(), A, PHI);
    expect(g.fleetCapitalUsd).toBeCloseTo(expected, 2);
    expect(g.fleetCapitalUsd).not.toBeCloseTo(SERVED.fleetCapitalUsd, 2); // not the old cash fold
    expect(g.fleetCapitalBasis).toBe('capital');
  });

  it('AC2 — the ceiling now covers the sum, and the contradiction is gone', () => {
    const g = gradeLiveOtmFleetBound(rows(), A, PHI);
    expect(g.fleetSizedMaxSumUsd).not.toBeNull();
    expect(cents(g.fleetSizedMaxSumUsd as number)).toBeGreaterThanOrEqual(cents(g.sumBookCapUsd as number));
    expect(g.sizedCeilingCoversSum).toBe(true);
    // ⚠ `fleetSizedHeadroomUsd` is `A − ceiling` — what the SIZING RULE leaves
    // unreachable — NOT `A − Σ B_i`. It now reads $0.00: φ_eff = A/Σ E_i, so the
    // rule can produce exactly the authorization and not a cent more. That is
    // the honest reading of a fleet sitting AT its ceiling, and it replaces the
    // $173.34 the route was advertising.
    expect(g.fleetSizedHeadroomUsd).toBeCloseTo(0, 2);
    expect(g.fleetSizedHeadroomUsd).not.toBeCloseTo(SERVED.fleetSizedHeadroomUsd, 1);
    // The 1¢ between the ceiling and the served sum is the per-book floor-to-
    // cents in `B_i`, not slack in the bound.
    expect(A - (g.sumBookCapUsd as number)).toBeCloseTo(0.01, 2);
  });

  it('the verdict is UNTOUCHED — a column fix must not become a fleet finding', () => {
    const g = gradeLiveOtmFleetBound(rows(), A, PHI);
    expect(g.verdict).toBe(SERVED.verdict); // still `within`, as the live host said
    expect(g.sumBookCapUsd).toBeCloseTo(SERVED.sumBookCapUsd, 2);
    expect(g.overageUsd).toBe(0);
  });
});

describe('TRA-3903 — absence is a real reading, not a gap to default away', () => {
  it('pre-TRA-3897 rows (no sizingBasisUsd) still fold on CASH, and say so', () => {
    // A build whose rows predate the capital basis genuinely sized on cash.
    // Defaulting those to a post-fix value would make an old build grade like a
    // new one — the direction that costs money.
    const stripped = armed().map(({ sizingBasisUsd: _drop, ...rest }) => rest as LiveOtmFleetBoundRow);
    const cash = stripped.reduce((s, r) => s + cents(r.availableCashUsd as number), 0) / 100;
    const g = gradeLiveOtmFleetBound(stripped, A, PHI);
    expect(g.fleetCapitalUsd).toBeCloseTo(cash, 2);
    expect(g.fleetCapitalBasis).toBe('cash_only');
  });

  it('a fleet caught MID-DEPLOY folds each row on its own basis and reports `mixed`', () => {
    const half = armed();
    delete half[0].sizingBasisUsd;
    const expected =
      cents(half[0].availableCashUsd as number) + cents(half[1].sizingBasisUsd as number);
    const g = gradeLiveOtmFleetBound(half, A, PHI);
    expect(cents(g.fleetCapitalUsd as number)).toBe(expected);
    expect(g.fleetCapitalBasis).toBe('mixed');
  });

  it('a blind grade claims no basis and computes no coverage', () => {
    const g = gradeLiveOtmFleetBound(null, A, PHI);
    expect(g.verdict).toBe('blind');
    expect(g.fleetCapitalBasis).toBe('cash_only');
    expect(g.sizedCeilingCoversSum).toBeNull();
  });
});

describe('TRA-3903 AC5 — the new columns are gradeable by FIELD PRESENCE', () => {
  it('both keys exist on EVERY grade, including blind', () => {
    // Ancestry is only a lower bound on content, so the deploy is graded on the
    // key being there. A field that appears only sometimes cannot be asserted
    // on, and its absence reads as "fine" rather than "not measured".
    for (const g of [gradeLiveOtmFleetBound(rows(), A, PHI), gradeLiveOtmFleetBound(null, A, PHI)]) {
      expect(Object.prototype.hasOwnProperty.call(g, 'fleetCapitalBasis')).toBe(true);
      expect(Object.prototype.hasOwnProperty.call(g, 'sizedCeilingCoversSum')).toBe(true);
    }
  });

  it('sizedCeilingCoversSum is FALSE on the defect it was written for', () => {
    // The detector must be able to catch a REGRESSION, not just be right today.
    // Re-create the shipped defect by handing the grade cash-only rows while the
    // caps stay as the capital basis sized them: that is byte-for-byte the state
    // `f3718bcee7a6` served.
    const cashOnly = armed().map(r => ({ ...r, sizingBasisUsd: r.availableCashUsd }));
    const g = gradeLiveOtmFleetBound(cashOnly, A, PHI);
    expect(g.fleetCapitalUsd).toBeCloseTo(SERVED.fleetCapitalUsd, 2);
    expect(g.fleetSizedMaxSumUsd).toBeCloseTo(SERVED.fleetSizedMaxSumUsd, 1);
    expect(g.sizedCeilingCoversSum).toBe(false);
    expect(g.verdict).toBe('within'); // …and the verdict still says fine. That is the point.
  });
});
