// TRA-3962 (Q2, board ruling 2026-10-04) — the over-cap page classifier.
//
// Graded as a FULL MATRIX, not "a negative number pages": the detector has a
// gating leg (`openPremiumAtRiskUsd`) and a verdict leg (`headroomSignedUsd`),
// and the standing bug in this family is a two-term detector whose gating leg
// silently decides before the other is read. Every cell below says which leg
// decided and why.
import { describe, it, expect } from 'vitest';
import { classifyOverCapPage } from './tra3962-over-cap-page.js';
import { liveOptionTestAggregateHeadroomSignedUsd } from './option-exec-flag.js';

describe('classifyOverCapPage — TRA-3962 Q2, page-do-not-unwind', () => {
  it('pages CRITICAL on a production book over cap (the 08-21 admin state, −$51.68)', () => {
    expect(
      classifyOverCapPage({
        headroomSignedUsd: -51.68,
        openPremiumAtRiskUsd: 358,
        tradierEnv: 'production',
      }),
    ).toEqual({ action: 'page', severity: 'critical', reason: 'over_cap' });
  });

  it('pages WARNING, never critical, on a sandbox-env book — a paper env cannot page the desk at critical', () => {
    expect(
      classifyOverCapPage({
        headroomSignedUsd: -0.35,
        openPremiumAtRiskUsd: 194,
        tradierEnv: 'sandbox',
      }),
    ).toEqual({ action: 'page', severity: 'warning', reason: 'over_cap' });
  });

  it('does not page within cap, including EXACTLY at cap (headroom 0 is full, not over)', () => {
    expect(
      classifyOverCapPage({ headroomSignedUsd: 36.91, openPremiumAtRiskUsd: 273, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'within_cap' });
    expect(
      classifyOverCapPage({ headroomSignedUsd: 0, openPremiumAtRiskUsd: 273, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'within_cap' });
  });

  it('an UNREADABLE basis pages nobody and does not read clean — its own reason, never coerced to 0', () => {
    // `headroomSignedUsd: null` with live premium ON is "cannot read the cap",
    // not "over the cap" and not "fine". Coercing null to 0 here would page
    // (0 > atRisk ⇒ negative arithmetic elsewhere) or pass silently; both are
    // the absent-reads-as-measured bug this family exists to kill.
    expect(
      classifyOverCapPage({ headroomSignedUsd: null, openPremiumAtRiskUsd: 273, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'basis_unreadable' });
    // NaN is an unreadable reading, not a sign.
    expect(
      classifyOverCapPage({ headroomSignedUsd: Number.NaN, openPremiumAtRiskUsd: 273, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'basis_unreadable' });
  });

  it('TRA-3970 composition: a broker all-zeros artifact CANNOT page — the shipped fold reads null, not negative', () => {
    // The trap this classifier must never re-open: an unreadable balance
    // fail-closes `capUsd` to 0, and before TRA-3970 the same artifact
    // MANUFACTURED `headroomSignedUsd: −140.38` on a book that was not over
    // cap. Pin the composition through the REAL shipped function: capUsd 0
    // reads `null` (unreadable), so the classifier lands on
    // `basis_unreadable`, not on a page — a weekend maintenance window pages
    // nobody.
    const headroom = liveOptionTestAggregateHeadroomSignedUsd(273, 0);
    expect(headroom).toBeNull();
    expect(
      classifyOverCapPage({ headroomSignedUsd: headroom, openPremiumAtRiskUsd: 273, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'basis_unreadable' });
  });

  it('no live at-risk short-circuits as its OWN reason — the gating leg is named, never folded into "ok"', () => {
    // The gating leg decides here and must say so: `no_live_at_risk` and
    // `within_cap` are different facts (an empty book vs a graded one).
    expect(
      classifyOverCapPage({ headroomSignedUsd: 309.91, openPremiumAtRiskUsd: 0, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'no_live_at_risk' });
    // And it wins even against a nonsense negative reading: with nothing live
    // on, there is nothing to page a human about.
    expect(
      classifyOverCapPage({ headroomSignedUsd: -10, openPremiumAtRiskUsd: 0, tradierEnv: 'production' }),
    ).toEqual({ action: 'none', reason: 'no_live_at_risk' });
    expect(
      classifyOverCapPage({ headroomSignedUsd: null, openPremiumAtRiskUsd: Number.NaN, tradierEnv: 'sandbox' }),
    ).toEqual({ action: 'none', reason: 'no_live_at_risk' });
  });
});
