// TRA-3981 (parent TRA-3943, grandparent TRA-3927) — an ADOPTED OTM row's
// day-one stop anchored on a RESTATED basis, and its ATR leg was inert.
//
// ── What was measured, 2026-08-24T16:24Z on bqb1 `3d0c3582cef7` ─────────────
// Row `96b0dc72` `RIG260925C00006000`, live, open, `contractsRemaining 1`,
// opened 2026-08-21T18:04:24.851Z:
//
//   signalType          tradier_import
//   engineOriginSleeve  single_leg_otm   ⇒ isOtmSleeveRow() TRUE, rule GOVERNS
//   deskAddBasis        { source: residual_identity, residualPremiumPaid: 0.22 }
//   premiumPaid         0.22             ← a RESTATEMENT, not a fill
//   underlyingEntryPrice 0, underlyingEntryUnknownReason "no_spot_oracle"
//   otmAtrInvalidationLevel ABSENT
//
// The engine's own row on the SAME contract carried the fill, `0.33`. So the
// premium leg's floor resolved `0.65 × 0.22 = 0.143` instead of `0.2145` — the
// −35% stop declining until −57% off the fill — and the ATR leg could not
// evaluate at all. One leg, and that leg loosened. `lastMark` was `0.18`: BELOW
// the fill-derived floor and ABOVE the restated one, so the rule declined that
// row TODAY purely because of the restatement.
//
// ── The two disciplines this file encodes ───────────────────────────────────
//  1. The sign of a basis error IS the sign of the stop error. UNDER-stated is
//     permissive, over-stated is conservative — so an anchor of unknown
//     provenance is refused in BOTH directions rather than trusted in one.
//  2. A clean counter's population can be narrower than the rule's reach.
//     `summarizeDayOneStopPosture` windowed on `openedAt === today` and read
//     `atrLegInertRows: 0` while this row sat open and inert. That zero was
//     TRUE and it was not coverage. The pairing at the bottom of §2 pins the
//     gap so nobody re-reads the narrow counter as the wide one.
//
// Every SUBJECT here is paired with a control whose ONLY moving part is the one
// under test. AC1 asks for that explicitly: a rule-detached control must fail
// for the OPPOSITE reason, not for a stronger one — a control that also happens
// to be disarmed, off-sleeve or fed a non-finite mark proves nothing about the
// basis (TRA-3897's vacuous positive control, one ticket over).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  summarizeDayOneStopPosture,
  summarizeOtmSleeveStopCoverage,
  mergeOtmSleeveStopCoverage,
  blindOtmSleeveStopCoverage,
  otmDayOneStopSubject,
  isOtmSleeveRow,
} from './options-account.js';
import {
  resolveOtmDayOneStopRule,
  resolveOtmStopPremiumBasis,
  otmDayOneStopGovernance,
  otmDayOneStopVerdict,
  OTM_DAY_ONE_STOP_BASIS,
  OTM_DAY_ONE_STOP_VALUE,
  type OtmDayOneStopRelease,
} from './otm-day-one-stop.js';
import type { OptionPosition } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));

const RULE = resolveOtmDayOneStopRule({});
const CASH_RELEASE: OtmDayOneStopRelease = {
  released: true, reason: 'cash_account', accountType: 'cash', dayTradeBuyingPowerUsd: null,
};
const ARMED = { rule: RULE, release: CASH_RELEASE };

// The measured numbers, kept as the fixture so a future reader can join this
// file to the row it came from.
const FILL = 0.33;        // the engine sibling's fill on RIG260925C00006000
const RESTATED = 0.22;    // the residual identity's figure, stamped 14:47:02Z
const MARK = 0.18;        // `lastMark` at 16:24Z
const FILL_FLOOR = 0.2145;    // 0.65 × 0.33
const RESTATED_FLOOR = 0.143; // 0.65 × 0.22

const OPENED = Date.parse('2026-08-21T18:04:24.851Z');
const NOW = Date.parse('2026-08-24T16:24:00.000Z');

/** The live row, parameterised on the one axis under test. */
function row(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: '96b0dc72', symbol: 'RIG', optionSymbol: 'RIG260925C00006000',
    optionType: 'call', strike: 6, expiration: '2026-09-25',
    contracts: 1, contractsRemaining: 1,
    premiumPaid: FILL, currentPremium: MARK, tp1Premium: FILL * 1.5, tp1Hit: false,
    stopLossPremium: FILL * 0.8, peakPremium: FILL, trailingActive: false,
    trailingStopPremium: FILL * 0.867,
    underlyingEntryPrice: 5.8, openedAt: OPENED, signalId: 's1',
    signalType: 'otm_mispricing', mode: 'live',
    ...over,
  } as OptionPosition;
}

/** The ADOPTED twin, exactly as the wire carried it. */
function adoptedRow(over: Partial<OptionPosition> = {}): OptionPosition {
  return row({
    id: '96b0dc72-desk',
    premiumPaid: RESTATED,
    signalType: 'tradier_import',
    engineOriginSleeve: 'single_leg_otm',
    deskAddSleeve: 'single_leg_otm',
    importedFromTradier: true,
    // `underlyingEntryPrice: 0` with `no_spot_oracle` is why no level was ever
    // stamped — the field is absent, never a defaulted number (TRA-2893).
    underlyingEntryPrice: 0,
    underlyingEntryUnknownReason: 'no_spot_oracle',
    deskAddBasis: { source: 'residual_identity', orderIds: [], residualPremiumPaid: RESTATED, at: NOW },
    ...over,
  } as Partial<OptionPosition>);
}

// ── 1. AC1 — the premium leg anchors on a FILL, never on a restatement ───────
describe('TRA-3981 AC1 — the premium leg refuses a restated basis', () => {
  it('the live row IS admitted by the sleeve predicate — the rule really does reach it', () => {
    // If this were false the whole ticket would be moot, and the reader would be
    // entitled to think the row was out of scope all along.
    expect(isOtmSleeveRow(adoptedRow())).toBe(true);
  });

  it('classifies the four provenances, and only the two we OBSERVED are fill-grade', () => {
    expect(resolveOtmStopPremiumBasis({ premiumPaid: FILL }))
      .toMatchObject({ source: 'entry_fill', fillGrade: true, premiumBasisUsd: FILL });
    expect(resolveOtmStopPremiumBasis({
      premiumPaid: FILL, importedFromTradier: true, deskAddBasis: { source: 'capture_fill' },
    })).toMatchObject({ source: 'desk_capture_fill', fillGrade: true, premiumBasisUsd: FILL });
    expect(resolveOtmStopPremiumBasis({
      premiumPaid: RESTATED, importedFromTradier: true, deskAddBasis: { source: 'residual_identity' },
    })).toMatchObject({ source: 'restated_residual', fillGrade: false, premiumBasisUsd: null });
    // Adopted with NO stamp at all: the reconcile installed the broker's cost
    // basis, which on a multi-lot symbol is an average no lot traded at.
    expect(resolveOtmStopPremiumBasis({ premiumPaid: RESTATED, importedFromTradier: true }))
      .toMatchObject({ source: 'adopted_unstamped', fillGrade: false, premiumBasisUsd: null });
    // The row's own number is carried either way, so a reader sees BOTH claims.
    expect(resolveOtmStopPremiumBasis({
      premiumPaid: RESTATED, importedFromTradier: true, deskAddBasis: { source: 'residual_identity' },
    }).rowPremiumPaid).toBe(RESTATED);
  });

  it('SUBJECT — a desk lot priced off its OWN CAPTURED FILL anchors on the fill', () => {
    // The capture-sourced mint installs the fill as `premiumPaid` while
    // `deskAddBasis.residualPremiumPaid` still carries the residual identity's
    // disagreeing figure. The floor must come from the fill.
    const v = otmDayOneStopVerdict(
      otmDayOneStopSubject(adoptedRow({
        premiumPaid: FILL,
        deskAddBasis: { source: 'capture_fill', orderIds: [1], residualPremiumPaid: RESTATED, at: NOW },
      })),
      { mark: MARK, underlyingSpot: undefined, rule: RULE },
    );
    expect(v.premiumBasisSource).toBe('desk_capture_fill');
    expect(v.markFloor).toBeCloseTo(FILL_FLOOR, 6);
    expect(v.markFloor).not.toBeCloseTo(RESTATED_FLOOR, 6);
    expect(v.fires).toBe(true);
    expect(v.trigger).toBe('premium_pct');
  });

  it('SUBJECT — the RESTATED row publishes NO floor, so the permissive one cannot be reached', () => {
    const v = otmDayOneStopVerdict(
      otmDayOneStopSubject(adoptedRow()),
      { mark: MARK, underlyingSpot: undefined, rule: RULE },
    );
    expect(v.premiumBasisSource).toBe('restated_residual');
    expect(v.premiumLegInert).toBe(true);
    expect(v.markFloor).toBeNull();
    // The defect, stated as the thing that must NOT be on the wire.
    expect(v.markFloor).not.toBeCloseTo(RESTATED_FLOOR, 6);
    expect(v.fires).toBe(false);
  });

  it('POSITIVE CONTROL — the SAME row, SAME mark, SAME armed rule, fill provenance: it FIRES', () => {
    // Rule-detached in the only sense that matters here: the control differs
    // from the subject above on PROVENANCE and nothing else, so a green control
    // cannot be the rule being disarmed, the row being off-sleeve, or the mark
    // being unreadable. Those three are asserted, not assumed.
    const control = adoptedRow({
      premiumPaid: FILL,
      importedFromTradier: false,
      deskAddBasis: undefined,
    });
    expect(RULE.armed).toBe(true);
    expect(isOtmSleeveRow(control)).toBe(true);
    expect(Number.isFinite(MARK) && MARK > 0).toBe(true);

    const v = otmDayOneStopVerdict(
      otmDayOneStopSubject(control),
      { mark: MARK, underlyingSpot: undefined, rule: RULE },
    );
    expect(v.premiumBasisSource).toBe('entry_fill');
    expect(v.markFloor).toBeCloseTo(FILL_FLOOR, 6);
    expect(v.fires).toBe(true);
    expect(v.trigger).toBe('premium_pct');

    // …and the same mark against the restated floor would NOT have fired, which
    // is the "-57% off the fill" the filing measured, arithmetic and all.
    expect(MARK).toBeGreaterThan(RESTATED_FLOOR);
    expect(MARK).toBeLessThan(FILL_FLOOR);
    expect((MARK - FILL) / FILL).toBeCloseTo(-0.4545, 3);
    expect((RESTATED_FLOOR - FILL) / FILL).toBeCloseTo(-0.5667, 3);
  });

  it('NEGATIVE CONTROL — an unusable premium is inert too, and says so as a BASIS, not a source', () => {
    // `NaN` must land in the refused branch (`!(x > 0)`, TRA-3486) while still
    // reporting the provenance it had: "we could not use it" and "we did not
    // observe it" are different facts and share no field.
    const b = resolveOtmStopPremiumBasis({ premiumPaid: Number.NaN });
    expect(b.source).toBe('entry_fill');
    expect(b.fillGrade).toBe(true);
    expect(b.premiumBasisUsd).toBeNull();
  });
});

// ── 2. AC2/AC3 — governance, and the counter whose population is the RULE's ──
describe('TRA-3981 AC3 — a row with neither leg is NOT governed and does not read as governed', () => {
  it('SUBJECT — restated basis + no stamped level ⇒ both legs inert ⇒ ungoverned', () => {
    const g = otmDayOneStopGovernance(otmDayOneStopSubject(adoptedRow()), RULE);
    expect(g.premiumLegInert).toBe(true);
    expect(g.atrLegInert).toBe(true);
    expect(g.governs).toBe(false);
    expect(g.reason).toBe('both_legs_inert');
  });

  it('SUBJECT — a restated basis with a STAMPED level keeps the ATR leg and IS governed', () => {
    // The OR-structure is the point: one leg is enough to be governed, and the
    // refusal is scoped to the leg that cannot evaluate, never widened to the row.
    const g = otmDayOneStopGovernance(
      otmDayOneStopSubject(adoptedRow({ otmAtrInvalidationLevel: 5.2 })), RULE,
    );
    expect(g.premiumLegInert).toBe(true);
    expect(g.atrLegInert).toBe(false);
    expect(g.governs).toBe(true);
    expect(g.reason).toBe('governed');
    // …and it fires on the leg it still has.
    const v = otmDayOneStopVerdict(
      otmDayOneStopSubject(adoptedRow({ otmAtrInvalidationLevel: 5.2 })),
      { mark: MARK, underlyingSpot: 5.1, rule: RULE },
    );
    expect(v.trigger).toBe('atr_invalidation');
  });

  it('CONTROL — a DISARMED rule reads `rule_disarmed`, never `both_legs_inert`', () => {
    // Two different refusals must not share a reason code: one is a knob, the
    // other is a row we cannot price.
    const g = otmDayOneStopGovernance(
      otmDayOneStopSubject(row({ otmAtrInvalidationLevel: 5.2 })),
      resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'off' }),
    );
    expect(g.governs).toBe(false);
    expect(g.reason).toBe('rule_disarmed');
    expect(g.premiumLegInert).toBe(false);
    expect(g.atrLegInert).toBe(false);
  });

  it('the day-one posture reads `full_premium` for a sleeve holding an ungoverned row', () => {
    // The pessimistic fold now hears about the adopted row too: an ungoverned
    // row must not be hidden behind a governed neighbour.
    const openedToday = Date.parse('2026-08-24T14:00:00.000Z');
    const p = summarizeDayOneStopPosture(
      [row({ openedAt: openedToday, otmAtrInvalidationLevel: 5.2 }),
        adoptedRow({ openedAt: openedToday })],
      { holdLiveOptionsOvernightForPdt: true, now: NOW, otmDayOneStop: ARMED },
    );
    expect(p.rows).toBe(2);
    expect(p.stopBasisBySleeve.otm_mispricing).toBe(OTM_DAY_ONE_STOP_BASIS);
    expect(p.stopBasisBySleeve.tradier_import).toBe('full_premium');
    expect(p.stopBasis).toBe('mixed');
    // Counted over the rule's REACH, so the inert row stays in its own
    // denominator instead of being folded out with its governance.
    expect(p.otmDayOneStop!.atrLegRows).toBe(1);
    expect(p.otmDayOneStop!.atrLegInertRows).toBe(1);
  });
});

describe('TRA-3981 AC2 — the coverage counter counts the rule’s REACH, not today', () => {
  it('THE GAP, pinned: the day-one instrument reads a TRUE zero over a set that excludes the row', () => {
    // This is the exact pairing the filing turned on. Same book, same clock, two
    // instruments — and only the second one can answer "is any ATR leg inert?".
    const book = [adoptedRow()]; // opened 08-21, read on 08-24
    const dayOne = summarizeDayOneStopPosture(book, {
      holdLiveOptionsOvernightForPdt: true, now: NOW, otmDayOneStop: ARMED,
    });
    expect(dayOne.rows).toBe(0);
    expect(dayOne.otmDayOneStop!.atrLegInertRows).toBe(0); // TRUE, and not coverage

    const coverage = summarizeOtmSleeveStopCoverage(book, { otmDayOneStop: ARMED });
    expect(coverage.population).toBe('all_open_live_otm_sleeve_rows');
    expect(coverage.rows).toBe(1);
    expect(coverage.atrLegInertRows).toBe(1);
    expect(coverage.premiumLegInertRows).toBe(1);
    expect(coverage.governedRows).toBe(0);
    expect(coverage.ungovernedRows).toBe(1);
    expect(coverage.ungovernedPremiumUsd).toBeCloseTo(RESTATED * 100, 2);
    expect(coverage.ruleArmed).toBe(true);
  });

  it('scope — RV, directional, demo, closed and multi-leg rows are not in the population', () => {
    const coverage = summarizeOtmSleeveStopCoverage(
      [
        row({ id: 'rv', signalType: 'relative_value', engineOriginSleeve: undefined }),
        row({ id: 'demo', mode: 'demo' }),
        row({ id: 'closed', closedAt: NOW }),
        row({ id: 'combo', legs: [] as unknown as OptionPosition['legs'] }),
        row({ id: 'keep', otmAtrInvalidationLevel: 5.2 }),
      ],
      { otmDayOneStop: ARMED },
    );
    expect(coverage.rows).toBe(1);
    expect(coverage.governedRows).toBe(1);
  });

  it('an EMPTY book is zeros with the arm on the wire — never a coverage claim', () => {
    const coverage = summarizeOtmSleeveStopCoverage([], { otmDayOneStop: ARMED });
    expect(coverage.rows).toBe(0);
    expect(coverage.governedRows).toBe(0);
    expect(coverage.ungovernedRows).toBe(0);
    expect(coverage.ruleArmed).toBe(true);
  });

  it('with NO rule attached nothing is governed and the basis split is still published', () => {
    const coverage = summarizeOtmSleeveStopCoverage([adoptedRow(), row()], {});
    expect(coverage.ruleArmed).toBeNull();
    expect(coverage.governedRows).toBe(0);
    expect(coverage.basisSourceRows.entry_fill).toBe(1);
    expect(coverage.basisSourceRows.restated_residual).toBe(1);
  });
});

// ── 3. AC4 — the adopted population is VISIBLE, not inferable ────────────────
describe('TRA-3981 AC4 — the wire carries the adopted population and how it is priced', () => {
  const book = [
    row({ id: 'engine', otmAtrInvalidationLevel: 5.2 }),
    adoptedRow({ id: 'desk-restated' }),
    adoptedRow({
      id: 'desk-capture',
      premiumPaid: FILL,
      deskAddBasis: { source: 'capture_fill', orderIds: [11], residualPremiumPaid: RESTATED, at: NOW },
    }),
    adoptedRow({ id: 'foreign', deskAddBasis: undefined }),
  ];

  it('splits the population by basis source, and the split sums to `rows`', () => {
    const c = summarizeOtmSleeveStopCoverage(book, { otmDayOneStop: ARMED });
    expect(c.rows).toBe(4);
    expect(c.basisSourceRows).toEqual({
      entry_fill: 1, desk_capture_fill: 1, restated_residual: 1, adopted_unstamped: 1,
    });
    const sum = Object.values(c.basisSourceRows).reduce((a, b) => a + b, 0);
    expect(sum).toBe(c.rows);
    expect(c.adoptedRows).toBe(3);
    expect(c.adoptedFillBasisRows).toBe(1);
    expect(c.adoptedRestatedBasisRows).toBe(1);
    // A grader must be able to see the leg counts too, not just the population.
    expect(c.premiumLegRows).toBe(2);
    expect(c.premiumLegInertRows).toBe(2);
    expect(c.atrLegRows).toBe(1);
    expect(c.atrLegInertRows).toBe(3);
    expect(c.governedRows).toBe(2);   // engine (both legs) + desk-capture (premium)
    expect(c.ungovernedRows).toBe(2); // desk-restated + foreign
  });

  it('the fleet MERGE adds the counters and folds the arm PESSIMISTICALLY', () => {
    const a = summarizeOtmSleeveStopCoverage(book, { otmDayOneStop: ARMED });
    const b = summarizeOtmSleeveStopCoverage([adoptedRow({ id: 'other-book' })], {
      otmDayOneStop: { rule: resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'off' }) },
    });
    const m = mergeOtmSleeveStopCoverage([a, b]);
    expect(m.rows).toBe(5);
    expect(m.ungovernedRows).toBe(3);
    expect(m.basisSourceRows.restated_residual).toBe(2);
    expect(m.ruleArmed).toBe(false);
    expect(m.population).toBe('all_open_live_otm_sleeve_rows');
  });

  it('the BLIND twin NULLS every count — a catch branch must not mint `atrLegInertRows: 0`', () => {
    const blind = blindOtmSleeveStopCoverage();
    expect(blind.rows).toBeNull();
    expect(blind.atrLegInertRows).toBeNull();
    expect(blind.premiumLegInertRows).toBeNull();
    expect(blind.governedRows).toBeNull();
    expect(blind.basisSourceRows).toBeNull();
    // The population literal survives: it is what the field MEANS, not a count.
    expect(blind.population).toBe('all_open_live_otm_sleeve_rows');
  });
});

// ── 4. AC5 + the no-drift guard ─────────────────────────────────────────────
describe('TRA-3981 AC5 — no arm, no sizing, no cap, and no reader builds its own subject', () => {
  const RULE_SRC = readFileSync(join(HERE, 'otm-day-one-stop.ts'), 'utf8');
  const ACCT_SRC = readFileSync(join(HERE, 'options-account.ts'), 'utf8');

  it('the rule module still names no arm, no sizing and no row cap', () => {
    for (const forbidden of [
      'otmArmed', 'isOptionLiveOtmArmed',
      'resolveLiveOptionTestNotionalCapUsd', 'resolveLiveOptionTestMaxContracts',
      'resolveLiveOptionTestContracts', 'resolveCanaryCeiling', 'sizeContracts',
    ]) {
      expect(RULE_SRC, forbidden).not.toContain(forbidden);
    }
  });

  it('the rule module still reads its own three env keys and no others', () => {
    const envReads = [...RULE_SRC.matchAll(/env\[([A-Z_]+|'[^']+')\]/g)].map(m => m[1]);
    expect(new Set(envReads)).toEqual(new Set([
      'OTM_DAY_ONE_STOP_VALUE',
      'OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE',
      'OTM_DAY_ONE_STOP_ATR_MULT_VALUE',
    ]));
  });

  it('every verdict/governance call in `options-account.ts` goes through `otmDayOneStopSubject`', () => {
    // The drift this prevents: `importedFromTradier` / `deskAddBasis` are
    // OPTIONAL, so a hand-built `{ premiumPaid, optionType }` subject is
    // indistinguishable from an engine-opened row and silently restores the
    // permissive reading. Both readers used to build exactly that. A row is a
    // READER's claim and a WRITER's order ticket, and they must resolve it the
    // same way (TRA-3926) — this is what makes that structural.
    const calls = [...ACCT_SRC.matchAll(/otmDayOneStop(?:Verdict|Governance)\(\s*([^\n,]*)/g)]
      .map(m => m[1].trim())
      // The import list and the builder's own definition are not call sites.
      .filter(a => a !== '' && !a.startsWith(')'));
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const arg of calls) {
      expect(arg, `verdict/governance called with \`${arg}\``).toContain('otmDayOneStopSubject(');
    }
  });
});
