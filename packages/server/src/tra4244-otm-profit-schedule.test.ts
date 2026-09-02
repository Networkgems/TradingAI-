// TRA-4244 (a) (parent TRA-4238) — the env-overridable profit-side schedule.
//
// Two properties carry this file, and they are the ones a half-applied re-cut
// would break:
//
//   1. NO KEYS ⇒ COMPILED, BY REFERENCE. `buildProfitFloorLadder` and
//      `otmRiskParamsFor` return the compiled objects THEMSELVES, so the
//      default path is not merely equal to the pre-TRA-4244 build, it is the
//      same object the pre-TRA-4244 build passed.
//   2. ANY REJECTION ⇒ THE WHOLE SET IS DISCARDED. The four knobs are one exit
//      rule (TRA-4006: a give-back only means something against the arm that
//      armed it), so a typo in one key must not leave three overrides running
//      against one compiled partner.
//
// Everything here is pure over an env object. Nothing reads `process.env`.
import { describe, it, expect } from 'vitest';
import {
  resolveOtmProfitSchedule,
  describeOtmProfitSchedule,
  buildProfitFloorLadder,
  otmRiskParamsFor,
  COMPILED_OTM_PROFIT_SCHEDULE,
  OTM_TP1_PCT_VAR,
  PROFIT_LOCK_ARM_R_VAR,
  PROFIT_LOCK_GIVEBACK_R_VAR,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR,
} from './otm-profit-schedule.js';
import {
  OTM_OPTIONS_TP1_PCT,
  OTM_RISK_PARAMS,
  PROFIT_FLOOR_LADDER,
  PROFIT_FLOOR_RUNG1_FLOOR_R,
  PROFIT_FLOOR_RUNG2_FLOOR_R,
  PROFIT_FLOOR_RUNG3_FLOOR_R,
  PROFIT_LOCK_ARM_R,
  PROFIT_LOCK_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
} from '@trading-app/shared';

/** The TRA-4238 fit: TP1 0.12, arm unchanged at 0.75, give-backs 0.25 / 0.15. */
const FITTED: NodeJS.ProcessEnv = {
  [OTM_TP1_PCT_VAR]: '0.12',
  [PROFIT_LOCK_ARM_R_VAR]: '0.75',
  [PROFIT_LOCK_GIVEBACK_R_VAR]: '0.25',
  [PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR]: '0.15',
};

describe('TRA-4244 (a) — no override keys is the compiled schedule, by reference', () => {
  it('resolves the compiled bundle with source `compiled` and nothing applied or rejected', () => {
    const s = resolveOtmProfitSchedule({});
    expect(s.source).toBe('compiled');
    expect(s.applied).toEqual([]);
    expect(s.rejected).toEqual([]);
    expect(s.tp1Pct).toBe(OTM_OPTIONS_TP1_PCT);
    expect(s.armR).toBe(PROFIT_LOCK_ARM_R);
    expect(s.giveBackR).toBe(PROFIT_LOCK_GIVEBACK_R);
    expect(s.tightenGiveBackR).toBe(PROFIT_LOCK_TIGHTEN_GIVEBACK_R);
  });

  it('hands back the compiled ladder and risk bundle THEMSELVES, not copies', () => {
    const s = resolveOtmProfitSchedule({});
    expect(buildProfitFloorLadder(s)).toBe(PROFIT_FLOOR_LADDER);
    expect(otmRiskParamsFor(s)).toBe(OTM_RISK_PARAMS);
  });

  it('treats a blank / whitespace-only key as ABSENT — an emptied Render key is "unset", not "0"', () => {
    const s = resolveOtmProfitSchedule({ [OTM_TP1_PCT_VAR]: '   ', [PROFIT_LOCK_GIVEBACK_R_VAR]: '' });
    expect(s.source).toBe('compiled');
    expect(s.rejected).toEqual([]);
    expect(s.tp1Pct).toBe(OTM_OPTIONS_TP1_PCT);
  });
});

describe('TRA-4244 (a) — a valid set applies, and the ladder moves with it', () => {
  it('applies the TRA-4238 fit and names every key it took', () => {
    const s = resolveOtmProfitSchedule(FITTED);
    expect(s.source).toBe('env');
    expect(s.rejected).toEqual([]);
    expect(s.applied).toEqual([
      OTM_TP1_PCT_VAR,
      PROFIT_LOCK_ARM_R_VAR,
      PROFIT_LOCK_GIVEBACK_R_VAR,
      PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR,
    ]);
    expect(s).toMatchObject({ tp1Pct: 0.12, armR: 0.75, giveBackR: 0.25, tightenGiveBackR: 0.15 });
  });

  it('a PARTIAL set is legal — the unsupplied knobs stay compiled', () => {
    const s = resolveOtmProfitSchedule({ [OTM_TP1_PCT_VAR]: '0.12' });
    expect(s.source).toBe('env');
    expect(s.applied).toEqual([OTM_TP1_PCT_VAR]);
    expect(s.tp1Pct).toBe(0.12);
    expect(s.armR).toBe(PROFIT_LOCK_ARM_R);
    expect(s.giveBackR).toBe(PROFIT_LOCK_GIVEBACK_R);
  });

  it('folds tp1Pct into the OTM risk bundle and leaves every other member alone', () => {
    const params = otmRiskParamsFor(resolveOtmProfitSchedule(FITTED));
    expect(params.tp1Pct).toBe(0.12);
    expect(params).toEqual({ ...OTM_RISK_PARAMS, tp1Pct: 0.12 });
  });

  it('rebuilds the TRA-4020 ladder with the EFFECTIVE give-backs, the spec floors, and ascending rungs', () => {
    const ladder = buildProfitFloorLadder(resolveOtmProfitSchedule(FITTED));
    expect(ladder).not.toBe(PROFIT_FLOOR_LADDER);
    expect(ladder).toEqual([
      { peakR: 0.75, giveBackR: 0.25, floorR: PROFIT_FLOOR_RUNG1_FLOOR_R },
      { peakR: 1.50, giveBackR: 0.25, floorR: PROFIT_FLOOR_RUNG2_FLOOR_R },
      { peakR: 2.00, giveBackR: 0.15, floorR: PROFIT_FLOOR_RUNG2_FLOOR_R },
      { peakR: 2.50, giveBackR: 0.15, floorR: PROFIT_FLOOR_RUNG3_FLOOR_R },
    ]);
    // `profitLockDecision` walks the rungs with `else break`, so a non-ascending
    // ladder would silently select the wrong rung rather than error.
    for (let i = 1; i < ladder.length; i += 1) {
      expect(ladder[i]!.peakR).toBeGreaterThan(ladder[i - 1]!.peakR);
    }
    // TRA-4020's safety property: the re-cut ladder is never LOOSER than the
    // one it replaces at any rung (give-backs only tighten, floors unchanged).
    for (let i = 0; i < ladder.length; i += 1) {
      expect(ladder[i]!.giveBackR).toBeLessThanOrEqual(PROFIT_FLOOR_LADDER[i]!.giveBackR);
      expect(ladder[i]!.floorR).toBe(PROFIT_FLOOR_LADDER[i]!.floorR);
    }
  });

  it('a schedule that re-states the compiled values is still the compiled ladder object', () => {
    const s = resolveOtmProfitSchedule({
      [PROFIT_LOCK_ARM_R_VAR]: String(PROFIT_LOCK_ARM_R),
      [PROFIT_LOCK_GIVEBACK_R_VAR]: String(PROFIT_LOCK_GIVEBACK_R),
    });
    expect(s.source).toBe('env');
    expect(buildProfitFloorLadder(s)).toBe(PROFIT_FLOOR_LADDER);
  });
});

describe('TRA-4244 (a) — the WHOLE SET fails closed on any violation', () => {
  it.each([
    ['not a number', { ...FITTED, [OTM_TP1_PCT_VAR]: 'zero point one two' }, OTM_TP1_PCT_VAR, 'not_a_number'],
    ['zero', { ...FITTED, [OTM_TP1_PCT_VAR]: '0' }, OTM_TP1_PCT_VAR, 'not_positive'],
    ['negative', { ...FITTED, [PROFIT_LOCK_GIVEBACK_R_VAR]: '-0.25' }, PROFIT_LOCK_GIVEBACK_R_VAR, 'not_positive'],
    // TRA-4006's defect, re-armed by env: give-back == arm releases a winner at breakeven.
    ['give-back == arm', { ...FITTED, [PROFIT_LOCK_GIVEBACK_R_VAR]: '0.75' }, PROFIT_LOCK_GIVEBACK_R_VAR, 'giveback_not_below_arm'],
    ['give-back > arm', { ...FITTED, [PROFIT_LOCK_GIVEBACK_R_VAR]: '0.90' }, PROFIT_LOCK_GIVEBACK_R_VAR, 'giveback_not_below_arm'],
    ['tighten == give-back', { ...FITTED, [PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR]: '0.25' }, PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR, 'tighten_not_below_giveback'],
    ['tighten > give-back', { ...FITTED, [PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR]: '0.40' }, PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR, 'tighten_not_below_giveback'],
    // Would put the ladder's first rung at/above its second.
    ['arm at the second rung', { ...FITTED, [PROFIT_LOCK_ARM_R_VAR]: '1.5' }, PROFIT_LOCK_ARM_R_VAR, 'arm_not_below_ladder_rung2'],
  ])('%s ⇒ every override discarded, the offending key named', (_label, env, key, reason) => {
    const s = resolveOtmProfitSchedule(env as NodeJS.ProcessEnv);
    expect(s.source).toBe('compiled');
    expect(s.applied).toEqual([]);
    expect(s.rejected.map((r) => r.key)).toContain(key);
    expect(s.rejected.map((r) => r.reason)).toContain(reason);
    // ⭐ The whole-set rule: the three VALID keys in each fixture are discarded too.
    expect(s).toMatchObject({ ...COMPILED_OTM_PROFIT_SCHEDULE });
    expect(buildProfitFloorLadder(s)).toBe(PROFIT_FLOOR_LADDER);
    expect(otmRiskParamsFor(s)).toBe(OTM_RISK_PARAMS);
  });

  it('an override checked against a COMPILED partner is still checked — 0.80 give-back vs the compiled 0.75 arm', () => {
    // Nothing else supplied, so the arm is the compiled 0.75. A give-back of
    // 0.80 alone would be exactly the half-valid schedule this refuses.
    const s = resolveOtmProfitSchedule({ [PROFIT_LOCK_GIVEBACK_R_VAR]: '0.80' });
    expect(s.source).toBe('compiled');
    expect(s.giveBackR).toBe(PROFIT_LOCK_GIVEBACK_R);
    expect(s.rejected[0]).toMatchObject({ key: PROFIT_LOCK_GIVEBACK_R_VAR, raw: '0.80', reason: 'giveback_not_below_arm' });
  });

  it('reports EVERY violation in the set, not just the first', () => {
    const s = resolveOtmProfitSchedule({
      [OTM_TP1_PCT_VAR]: 'nope',
      [PROFIT_LOCK_GIVEBACK_R_VAR]: '9',
    });
    expect(s.rejected.map((r) => r.reason).sort()).toEqual(['giveback_not_below_arm', 'not_a_number']);
  });
});

describe('TRA-4244 (a) — the /api/health/live-enforce-gates surface', () => {
  it('attributes every key to `env` or `compiled` and publishes the effective schedule', () => {
    const report = describeOtmProfitSchedule({ [OTM_TP1_PCT_VAR]: '0.12' });
    expect(report.source).toBe('env');
    expect(report.effective.tp1Pct).toBe(0.12);
    expect(report.compiled.tp1Pct).toBe(OTM_OPTIONS_TP1_PCT);
    expect(report.keys[OTM_TP1_PCT_VAR]).toEqual({
      raw: '0.12', applied: true, source: 'env', rejectedReason: null,
    });
    expect(report.keys[PROFIT_LOCK_ARM_R_VAR]).toEqual({
      raw: null, applied: false, source: 'compiled', rejectedReason: null,
    });
    expect(report.floorLadder).toBe(PROFIT_FLOOR_LADDER); // only tp1 moved
  });

  it('a rejected read is LOUD — source reads `compiled` with the key, its raw value and the reason', () => {
    const report = describeOtmProfitSchedule({ ...FITTED, [OTM_TP1_PCT_VAR]: 'x' });
    expect(report.source).toBe('compiled');
    expect(report.effective).toEqual({ ...COMPILED_OTM_PROFIT_SCHEDULE });
    expect(report.keys[OTM_TP1_PCT_VAR]).toEqual({
      raw: 'x', applied: false, source: 'compiled', rejectedReason: 'not_a_number',
    });
    // The three valid keys read `applied: false` too — they were discarded.
    expect(report.keys[PROFIT_LOCK_GIVEBACK_R_VAR]).toMatchObject({ raw: '0.25', applied: false, source: 'compiled' });
    expect(report.note).toContain('OVERRIDES DISCARDED');
    expect(report.note).toContain(OTM_TP1_PCT_VAR);
  });

  it('the quiet case says it is quiet rather than reading like an unset instrument', () => {
    const report = describeOtmProfitSchedule({});
    expect(report.source).toBe('compiled');
    expect(report.rejected).toEqual([]);
    expect(report.note).toContain('No override keys set');
  });
});
