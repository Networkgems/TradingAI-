// TRA-4416 — the ratified band and the live band disagree, and nothing said so.
//
// Board card `439c4e46` (`widen_live_anyway`, 2026-09-09) pointed the live
// `single_leg_otm` selector at |Δ| ∈ [0.25, 0.40] while the TRA-3392 mandate
// authorizes [0.495, 0.55). The decision is accepted; the SILENCE is the defect.
//
// ⛔ THE LIVE READING THIS FILE IS PINNED TO — bqb1 `08f78eb46caa`, 2026-09-22T22:30Z:
//     /api/health/otm-sleeve-mandate  ceiling.mode 'enforce', inForce 0.55
//     /api/health/options-live        selectorBand [0.25, 0.40], source 'env'
//   An ARMED ceiling at 0.55 over an admitted band topping out below 0.40 cannot
//   refuse a single admissible contract, and every surface read green.
//
// Every assertion below has a MUTATED control beside it: a check that only ever
// fires in one direction cannot tell you it still works.

import { describe, it, expect } from 'vitest';
import {
  assessMandateBandContainment,
  assessMandateCohortDisjointness,
  deltaInterval,
  deltaIntervalContains,
  intersectDeltaIntervals,
  isEmptyDeltaInterval,
  mandateBandFor,
  mandateBoardOverridesFor,
  mandateCeilingFor,
  mandateFloorFor,
  mandateReopeningCohortMembership,
  MANDATE_REOPENING_COHORT,
  OTM_SLEEVE_MANDATE_STRUCTURE,
} from './otm-sleeve-mandate.js';
import {
  entryDeltaCeilingCoverage,
  entryDeltaCeilingLiveVerdict,
  resolveEntryDeltaCeilingLive,
  OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG,
} from './option-entry-delta-ceiling-live.js';

const S = OTM_SLEEVE_MANDATE_STRUCTURE;

/** The admitted band as the live box composes it: floor [0.25,0.40] ∩ selector [0.25,0.40). */
const LIVE_ADMITTED = intersectDeltaIntervals(
  deltaInterval(0.25, 0.40, true),
  deltaInterval(0.25, 0.40, false),
);

describe('TRA-4416 interval algebra — the two live filters disagree on the top edge', () => {
  it('floor is CLOSED and selector is HALF-OPEN, so the intersection excludes exactly 0.40', () => {
    expect(LIVE_ADMITTED).not.toBeNull();
    expect(LIVE_ADMITTED).toEqual({ from: 0.25, to: 0.40, upperInclusive: false, label: '[0.25,0.4)' });
  });

  it('MUTATED CONTROL — two CLOSED bands keep the inclusive edge', () => {
    expect(intersectDeltaIntervals(
      deltaInterval(0.25, 0.40, true),
      deltaInterval(0.25, 0.40, true),
    )?.upperInclusive).toBe(true);
  });

  it('non-overlapping bands intersect to null, not to an empty interval', () => {
    expect(intersectDeltaIntervals(deltaInterval(0.25, 0.40, true), deltaInterval(0.495, 0.55, false)))
      .toBeNull();
  });

  it('containment respects the top-edge strictness in BOTH directions', () => {
    const authorized = deltaInterval(0.495, 0.55, false);
    // Same top edge, inner EXCLUSIVE ⇒ contained.
    expect(deltaIntervalContains(authorized, deltaInterval(0.495, 0.55, false))).toBe(true);
    // Same top edge, inner INCLUSIVE ⇒ NOT contained (0.55 is outside the mandate).
    expect(deltaIntervalContains(authorized, deltaInterval(0.495, 0.55, true))).toBe(false);
  });

  it('empty intervals are detected under both conventions', () => {
    expect(isEmptyDeltaInterval(deltaInterval(0.4, 0.4, false))).toBe(true);
    expect(isEmptyDeltaInterval(deltaInterval(0.4, 0.4, true))).toBe(false);
  });
});

describe('TRA-4416 AC1 — the board override is ON RECORD and does NOT amend the table', () => {
  it('names card 439c4e46 and its decision verbatim', () => {
    const [o, ...rest] = mandateBoardOverridesFor(S);
    expect(rest).toEqual([]);
    expect(o.card).toBe('439c4e46');
    expect(o.decision).toBe('widen_live_anyway');
    expect(o.decidedAt).toBe('2026-09-09');
    expect(o.directedBand).toEqual({ from: 0.25, to: 0.40, label: '[0.25,0.40]' });
  });

  it('records what the RATIFIED table says about the directed band, unchanged', () => {
    expect(mandateBoardOverridesFor(S)[0].ratifiedAuthorizationOfDirectedBand)
      .toBe('insufficient_evidence');
    expect(mandateBandFor(S, 0.30)?.authorization).toBe('insufficient_evidence');
  });

  it('⛔ AC5 — the override does not move ANY enforcement number', () => {
    // This is the whole reason AC1 option (b) was taken over option (a):
    // `mandateCeilingFor` IS the number the armed live ceiling enforces.
    expect(mandateBoardOverridesFor(S)[0].amendsRatifiedTable).toBe(false);
    expect(mandateFloorFor(S)).toBe(0.495);
    expect(mandateCeilingFor(S)).toBe(0.55);
    expect(mandateBandFor(S, 0.50)?.authorization).toBe('authorized');
    expect(mandateBandFor(S, 0.10)?.authorization).toBe('de_authorized');
  });

  it('an unmandated structure has no overrides — an empty list, never a throw', () => {
    expect(mandateBoardOverridesFor('vertical_spread')).toEqual([]);
  });
});

describe('TRA-4416 AC2 — the disagreement is a boolean, and it is THREE-VALUED', () => {
  it('THE INCIDENT: the live admitted band is OUTSIDE the authorization', () => {
    const c = assessMandateBandContainment(S, LIVE_ADMITTED);
    expect(c.status).toBe('outside');
    expect(c.liveBandWithinAuthorized).toBe(false);
    expect(c.authorizedBand).toEqual({ from: 0.495, to: 0.55, upperInclusive: false, label: '[0.495,0.55)' });
    // The reason must name WHICH authorization is exceeded, not merely that one is.
    expect(c.admittedBandAuthorizations).toEqual([
      { at: 0.25, band: '[0.20,0.45)', authorization: 'insufficient_evidence' },
    ]);
    // …and must point at the override rather than reading as an unexplained breach.
    expect(c.reason).toContain('439c4e46');
    expect(c.boardOverrides).toHaveLength(1);
  });

  it('POSITIVE CONTROL — the ratified band itself reads `within`', () => {
    const c = assessMandateBandContainment(S, deltaInterval(0.495, 0.55, false));
    expect(c.status).toBe('within');
    expect(c.liveBandWithinAuthorized).toBe(true);
  });

  it('MUTATED CONTROL — one tick over the top edge flips it to `outside`', () => {
    // 0.55 inclusive is one contract outside the mandate, and the check sees it.
    expect(assessMandateBandContainment(S, deltaInterval(0.495, 0.55, true)).liveBandWithinAuthorized)
      .toBe(false);
    // …and so does one tick under the bottom edge.
    expect(assessMandateBandContainment(S, deltaInterval(0.494, 0.55, false)).liveBandWithinAuthorized)
      .toBe(false);
  });

  it('⛔ ABSENT ⇒ `unmeasured`, and the boolean is `null` — NEVER `true`, never `false`', () => {
    const c = assessMandateBandContainment(S, null);
    expect(c.status).toBe('unmeasured');
    expect(c.liveBandWithinAuthorized).toBeNull();
    // The two idioms that would turn this into a false green.
    expect(c.liveBandWithinAuthorized ?? true).not.toBe(false);   // `?? true` hides it
    expect(c.status).not.toBe('within');                           // the honest field does not
    expect(c.reason).toContain('NOT a pass');
  });

  it('⛔ EMPTY is its own status — a vacuous subset must not read as `within`', () => {
    const c = assessMandateBandContainment(S, deltaInterval(0.40, 0.40, false));
    expect(c.status).toBe('empty');
    // Set-theoretically the answer is `true`; operationally it means "admits nothing".
    expect(c.liveBandWithinAuthorized).toBeNull();
  });

  it('an unmandated structure is `unmeasured`, not a pass', () => {
    const c = assessMandateBandContainment('vertical_spread', LIVE_ADMITTED);
    expect(c.status).toBe('unmeasured');
    expect(c.liveBandWithinAuthorized).toBeNull();
  });
});

describe('TRA-4416 AC3 — an ARMED ceiling that cannot reach its population says so', () => {
  const armed = { [OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG]: '1' } as NodeJS.ProcessEnv;
  const resolution = resolveEntryDeltaCeilingLive(S, armed);

  it('the pinned live state really is `enforce` at 0.55', () => {
    expect(resolution.mode).toBe('enforce');
    expect(resolution.ceiling).toBe(0.55);
  });

  it('⛔ THE INCIDENT: enforce@0.55 over [0.25,0.40) is armed and STRUCTURALLY BLIND', () => {
    const cov = entryDeltaCeilingCoverage(resolution, LIVE_ADMITTED);
    expect(cov.coversAdmittedBand).toBe(false);
    expect(cov.armedButBlind).toBe(true);
    expect(cov.bitingBand).toBeNull();
    expect(cov.reason).toContain('CANNOT BITE');
    expect(cov.reason).toContain('MUST NOT BE READ AS PROTECTION');
  });

  it('POSITIVE CONTROL — a band that reaches the ceiling reports the biting sub-band', () => {
    const cov = entryDeltaCeilingCoverage(resolution, deltaInterval(0.495, 0.60, false));
    expect(cov.coversAdmittedBand).toBe(true);
    expect(cov.armedButBlind).toBe(false);
    expect(cov.bitingBand).toEqual({ from: 0.55, to: 0.60, upperInclusive: false, label: '[0.55,0.6)' });
  });

  it('MUTATED CONTROL — the top edge decides at exactly the ceiling, both ways', () => {
    // The gate blocks `|Δ| >= 0.55`, so an INCLUSIVE top at 0.55 is reachable…
    expect(entryDeltaCeilingCoverage(resolution, deltaInterval(0.25, 0.55, true)).coversAdmittedBand)
      .toBe(true);
    // …and an EXCLUSIVE top at 0.55 is not. One contract apart.
    expect(entryDeltaCeilingCoverage(resolution, deltaInterval(0.25, 0.55, false)).coversAdmittedBand)
      .toBe(false);
  });

  it('⛔ an unreadable admitted band is `null`, not coverage, and not an alarm', () => {
    const cov = entryDeltaCeilingCoverage(resolution, null);
    expect(cov.coversAdmittedBand).toBeNull();
    expect(cov.armedButBlind).toBe(false);
    expect(cov.reason).toContain('NOT coverage');
  });

  it('an EMPTY admitted band is neither covered nor blind — there is nothing to cover', () => {
    const cov = entryDeltaCeilingCoverage(resolution, deltaInterval(0.4, 0.4, false));
    expect(cov.coversAdmittedBand).toBeNull();
    expect(cov.armedButBlind).toBe(false);
  });

  it('`armedButBlind` is about ENFORCE specifically — observe/off are reported, not alarmed', () => {
    const off = resolveEntryDeltaCeilingLive(S, {} as NodeJS.ProcessEnv);
    const cov = entryDeltaCeilingCoverage(off, LIVE_ADMITTED);
    expect(cov.coversAdmittedBand).toBe(false);
    expect(cov.armedButBlind).toBe(false);
  });
});

describe('TRA-4416 AC4 — the reopening cohort is separated by MODE, not by band', () => {
  const d = assessMandateCohortDisjointness(S);

  it('⛔ THE TRAP, PUBLISHED: the bands DO overlap — band alone separates nothing', () => {
    expect(d.bandsOverlap).toBe(true);
    expect(MANDATE_REOPENING_COHORT.band.from).toBeLessThanOrEqual(0.25);
    expect(MANDATE_REOPENING_COHORT.band.to).toBeGreaterThan(0.40);
    expect(d.separatedBy).toBe('mode');
  });

  it('the populations are nonetheless disjoint, and the proof is run, not asserted', () => {
    expect(d.disjointFromLivePopulation).toBe(true);
  });

  it('NO live row in the board-directed band is a cohort member, at any edge or symbol', () => {
    for (const symbol of MANDATE_REOPENING_COHORT.symbols) {
      for (const absDelta of [0.25, 0.30, 0.325, 0.399, 0.40]) {
        const m = mandateReopeningCohortMembership({ mode: 'live', structure: S, symbol, absDelta });
        expect(m.member).toBe(false);
        expect(m.excludedBecause).toBe('mode_not_demo');
      }
    }
  });

  it('POSITIVE CONTROL — the identical row in DEMO mode IS a member', () => {
    // Without this the test above passes on a filter that rejects everything.
    const m = mandateReopeningCohortMembership({
      mode: 'demo', structure: S, symbol: 'AAPL', absDelta: 0.30,
    });
    expect(m.member).toBe(true);
    expect(m.excludedBecause).toBeNull();
  });

  it('⛔ FAIL-CLOSED — a row whose mode cannot be read is EXCLUDED, never pooled in', () => {
    for (const mode of [undefined, null, '']) {
      expect(mandateReopeningCohortMembership({ mode, structure: S, symbol: 'AAPL', absDelta: 0.30 }))
        .toEqual({ member: false, excludedBecause: 'mode_unknown' });
    }
  });

  it('the other three keys still bind — the cohort is not "demo and nothing else"', () => {
    const base = { mode: 'demo', structure: S, symbol: 'AAPL', absDelta: 0.30 };
    expect(mandateReopeningCohortMembership({ ...base, structure: 'directional' }).excludedBecause)
      .toBe('structure_mismatch');
    expect(mandateReopeningCohortMembership({ ...base, symbol: 'NKE' }).excludedBecause)
      .toBe('symbol_not_in_universe');
    expect(mandateReopeningCohortMembership({ ...base, absDelta: 0.50 }).excludedBecause)
      .toBe('delta_out_of_band');
    expect(mandateReopeningCohortMembership({ ...base, absDelta: 0.45 }).excludedBecause)
      .toBe('delta_out_of_band'); // top edge EXCLUSIVE, per doc §5
    expect(mandateReopeningCohortMembership({ ...base, absDelta: null }).excludedBecause)
      .toBe('delta_unreadable');
  });

  it('the pre-registered acceptance rule is carried verbatim and is not re-scopable here', () => {
    expect(MANDATE_REOPENING_COHORT.minN).toBe(100);
    expect(MANDATE_REOPENING_COHORT.passIfLower95AtLeast).toBe(0.485);
    expect(MANDATE_REOPENING_COHORT.mode).toBe('demo');
    expect(MANDATE_REOPENING_COHORT.symbols).toEqual(['AAPL', 'SPY', 'QQQ', 'PLTR', 'TSLA']);
  });
});

describe('TRA-4416 AC5 — NOTHING ABOUT WHAT TRADES CHANGED', () => {
  const armed = { [OPTION_ENTRY_DELTA_CEILING_LIVE_FLAG]: '1' } as NodeJS.ProcessEnv;

  it('the armed ceiling still admits every |Δ| in the board-directed band', () => {
    for (const delta of [0.25, 0.30, 0.325, 0.399, 0.40, 0.54999]) {
      const v = entryDeltaCeilingLiveVerdict(S, delta, armed);
      expect(v.blocked).toBe(false);
      expect(v.breached).toBe(false);
    }
  });

  it('…and still blocks at and above 0.55, exactly as before', () => {
    for (const delta of [0.55, 0.60, 0.99]) {
      expect(entryDeltaCeilingLiveVerdict(S, delta, armed).blocked).toBe(true);
    }
  });

  it('the ceiling in force is still the ratified number', () => {
    expect(resolveEntryDeltaCeilingLive(S, armed).ceiling).toBe(0.55);
    expect(resolveEntryDeltaCeilingLive(S, armed).mandateCeiling).toBe(0.55);
  });

  it('an absent delta still FAILS OPEN on the ceiling (the floor is what fails closed)', () => {
    expect(entryDeltaCeilingLiveVerdict(S, null, armed).blocked).toBe(false);
    expect(entryDeltaCeilingLiveVerdict(S, null, armed).bandLabel).toBe('unknown_delta');
  });
});
