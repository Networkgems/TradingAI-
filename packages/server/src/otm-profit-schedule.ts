// TRA-4244 (parent TRA-4238) — the OTM sleeve's PROFIT-SIDE schedule, resolved
// from env at boot so the fitted numbers are RE-CUTTABLE by an env write plus a
// zero-delta redeploy (TRA-3724) instead of a code change.
//
// The four knobs are the whole profit side of a long-premium OTM row:
//
//   OTM_TP1_PCT_OVERRIDE                      compiled `OTM_OPTIONS_TP1_PCT`   0.50
//   PROFIT_LOCK_ARM_R_OVERRIDE                compiled `PROFIT_LOCK_ARM_R`     0.75
//   PROFIT_LOCK_GIVEBACK_R_OVERRIDE           compiled `PROFIT_LOCK_GIVEBACK_R` 0.40
//   PROFIT_LOCK_TIGHTEN_GIVEBACK_R_OVERRIDE   compiled `PROFIT_LOCK_TIGHTEN_GIVEBACK_R` 0.25
//
// ⭐ WHOLE-SET FAIL-CLOSED. A half-valid schedule is the failure mode this
// module exists to refuse: the four numbers are not independent settings, they
// are one exit rule. `giveBackR` only means anything against the `armR` that
// armed it (TRA-4006: with the two equal the rule releases a winner at
// breakeven), and the ladder's rungs are ordered by both. So ANY rejected key —
// unparseable, non-positive, or invariant-violating — discards EVERY override
// and the caller runs the compiled defaults, with the offending key named in
// `rejected`. There is no partial application.
//
// Invariants, per the issue and TRA-4006:
//   • every supplied value parses finite and > 0
//   • giveBackR        < armR
//   • tightenGiveBackR < giveBackR
//   • armR             < PROFIT_FLOOR_RUNG2_PEAK_R   ← see `buildProfitFloorLadder`
//
// The last one is this module's own, not the issue's: the TRA-4020 floor ladder
// is built off `armR` as its FIRST rung and `profitLockDecision` walks the rungs
// assuming they ascend in `peakR` (`else break`). An `armR` at or above the
// second rung (1.50) would silently make the ladder non-monotone, and the rule
// would read the wrong rung rather than error. Cheaper to refuse the value.
//
// PURE over `env`. Nothing here reads a clock, a file or module state, so the
// health route, the account and the tests all resolve the same way from the same
// input — the TRA-3515 `barR` pattern.

import {
  OTM_OPTIONS_TP1_PCT,
  OTM_RISK_PARAMS,
  PROFIT_FLOOR_LADDER,
  PROFIT_FLOOR_ARM_R,
  PROFIT_FLOOR_RUNG1_FLOOR_R,
  PROFIT_FLOOR_RUNG2_PEAK_R,
  PROFIT_FLOOR_RUNG2_FLOOR_R,
  PROFIT_FLOOR_RUNG3_PEAK_R,
  PROFIT_FLOOR_RUNG3_FLOOR_R,
  PROFIT_LOCK_ARM_R,
  PROFIT_LOCK_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
  PROFIT_LOCK_TIGHTEN_PEAK_R,
  type OtmRiskParams,
  type ProfitFloorLadderStep,
} from '@trading-app/shared';

export const OTM_TP1_PCT_VAR = 'OTM_TP1_PCT_OVERRIDE';
export const PROFIT_LOCK_ARM_R_VAR = 'PROFIT_LOCK_ARM_R_OVERRIDE';
export const PROFIT_LOCK_GIVEBACK_R_VAR = 'PROFIT_LOCK_GIVEBACK_R_OVERRIDE';
export const PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR = 'PROFIT_LOCK_TIGHTEN_GIVEBACK_R_OVERRIDE';

/** The four override keys, in the order they are surfaced. */
export const OTM_PROFIT_SCHEDULE_VARS = [
  OTM_TP1_PCT_VAR,
  PROFIT_LOCK_ARM_R_VAR,
  PROFIT_LOCK_GIVEBACK_R_VAR,
  PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR,
] as const;

export type OtmProfitScheduleRejectionReason =
  /** Present but not a finite number (blank counts as ABSENT, not invalid). */
  | 'not_a_number'
  /** Parsed, but ≤ 0. Every knob here is a positive fraction or R multiple. */
  | 'not_positive'
  /** TRA-4006 — the give-back must be a strict fraction of the gain that arms it. */
  | 'giveback_not_below_arm'
  /** TRA-4006 — the tightened allowance must be strictly tighter than the base one. */
  | 'tighten_not_below_giveback'
  /** The arm would put the floor ladder's first rung at/above its second (see above). */
  | 'arm_not_below_ladder_rung2';

export interface OtmProfitScheduleRejection {
  /** The env key that carried the offending value. */
  key: string;
  /** The raw string as supplied, or `null` when the rejection is about the SET rather than one key. */
  raw: string | null;
  reason: OtmProfitScheduleRejectionReason;
}

export interface OtmProfitScheduleValues {
  /** TP1 trigger as a fraction of `premiumPaid` (`tp1Premium = premiumPaid × (1 + tp1Pct)`). */
  tp1Pct: number;
  /** Peak favourable excursion (R) at which the profit lock arms. */
  armR: number;
  /** Give-back allowance (R) from the peak while armed. */
  giveBackR: number;
  /** Tightened give-back (R), in force once `peakR ≥ tightenPeakR`. */
  tightenGiveBackR: number;
  /**
   * Peak (R) at which the allowance tightens. NOT overridable — the issue's four
   * knobs do not include it — but carried in the bundle so every call site takes
   * its whole schedule from one object instead of mixing a resolved value with a
   * compiled import.
   */
  tightenPeakR: number;
}

export interface OtmProfitSchedule extends OtmProfitScheduleValues {
  /**
   * `env` ⇒ at least one key was supplied AND the whole set validated.
   * `compiled` ⇒ no key was supplied, or the set failed and was discarded.
   * Read `rejected` to tell those two apart — a rejected read is NOT a quiet one.
   */
  source: 'env' | 'compiled';
  /** Keys that were supplied and accepted. Empty iff `source === 'compiled'`. */
  applied: string[];
  /** Non-empty ⇒ the whole set was discarded; each entry names a key and why. */
  rejected: OtmProfitScheduleRejection[];
}

/** The compiled schedule — what the sleeve runs with no env keys set. */
export const COMPILED_OTM_PROFIT_SCHEDULE: Readonly<OtmProfitScheduleValues> = Object.freeze({
  tp1Pct: OTM_OPTIONS_TP1_PCT,
  armR: PROFIT_LOCK_ARM_R,
  giveBackR: PROFIT_LOCK_GIVEBACK_R,
  tightenGiveBackR: PROFIT_LOCK_TIGHTEN_GIVEBACK_R,
  tightenPeakR: PROFIT_LOCK_TIGHTEN_PEAK_R,
});

const COMPILED_SCHEDULE: OtmProfitSchedule = Object.freeze({
  ...COMPILED_OTM_PROFIT_SCHEDULE,
  source: 'compiled' as const,
  applied: [] as string[],
  rejected: [] as OtmProfitScheduleRejection[],
});

/** Blank / whitespace-only is ABSENT — an emptied Render key must read as "unset". */
function rawOf(env: NodeJS.ProcessEnv, key: string): string | null {
  const raw = env[key];
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Resolve the effective profit-side schedule. PURE over `env`.
 *
 * With no keys set this returns the compiled bundle and `source: 'compiled'`,
 * which is what makes the default path bit-identical to the pre-TRA-4244 build.
 */
export function resolveOtmProfitSchedule(env: NodeJS.ProcessEnv = process.env): OtmProfitSchedule {
  const rejected: OtmProfitScheduleRejection[] = [];
  const applied: string[] = [];
  const values: OtmProfitScheduleValues = { ...COMPILED_OTM_PROFIT_SCHEDULE };

  const read = (key: string, assign: (v: number) => void): void => {
    const raw = rawOf(env, key);
    if (raw === null) return;
    const parsed = Number(raw);
    if (!Number.isFinite(parsed)) {
      rejected.push({ key, raw, reason: 'not_a_number' });
      return;
    }
    if (!(parsed > 0)) {
      rejected.push({ key, raw, reason: 'not_positive' });
      return;
    }
    assign(parsed);
    applied.push(key);
  };

  read(OTM_TP1_PCT_VAR, (v) => { values.tp1Pct = v; });
  read(PROFIT_LOCK_ARM_R_VAR, (v) => { values.armR = v; });
  read(PROFIT_LOCK_GIVEBACK_R_VAR, (v) => { values.giveBackR = v; });
  read(PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR, (v) => { values.tightenGiveBackR = v; });

  // Invariants are checked against the CANDIDATE set (supplied values over
  // compiled ones), because that is the schedule that would run. Overriding one
  // key against a compiled partner is exactly how a half-valid rule gets built.
  if (!(values.giveBackR < values.armR)) {
    rejected.push({
      key: PROFIT_LOCK_GIVEBACK_R_VAR,
      raw: rawOf(env, PROFIT_LOCK_GIVEBACK_R_VAR),
      reason: 'giveback_not_below_arm',
    });
  }
  if (!(values.tightenGiveBackR < values.giveBackR)) {
    rejected.push({
      key: PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR,
      raw: rawOf(env, PROFIT_LOCK_TIGHTEN_GIVEBACK_R_VAR),
      reason: 'tighten_not_below_giveback',
    });
  }
  if (!(values.armR < PROFIT_FLOOR_RUNG2_PEAK_R)) {
    rejected.push({
      key: PROFIT_LOCK_ARM_R_VAR,
      raw: rawOf(env, PROFIT_LOCK_ARM_R_VAR),
      reason: 'arm_not_below_ladder_rung2',
    });
  }

  if (rejected.length > 0) {
    // Whole-set fail-closed. `applied` is deliberately emptied: nothing was.
    return { ...COMPILED_OTM_PROFIT_SCHEDULE, source: 'compiled', applied: [], rejected };
  }
  if (applied.length === 0) return COMPILED_SCHEDULE;
  return { ...values, source: 'env', applied, rejected };
}

/**
 * The OTM risk bundle with the schedule's TP1 folded in. Returns the compiled
 * `OTM_RISK_PARAMS` OBJECT ITSELF (not a copy) when nothing was overridden, so
 * the no-env path is identical by reference as well as by value.
 */
export function otmRiskParamsFor(schedule: OtmProfitSchedule): OtmRiskParams {
  if (schedule.tp1Pct === OTM_RISK_PARAMS.tp1Pct) return OTM_RISK_PARAMS;
  return { ...OTM_RISK_PARAMS, tp1Pct: schedule.tp1Pct };
}

/**
 * TRA-4020's floor ladder, rebuilt against the EFFECTIVE give-backs.
 *
 * The ladder's floors are the TRA-4020 spec's numbers and are NOT part of this
 * schedule; its give-backs ARE the shipped `PROFIT_LOCK_*` allowances (see the
 * `PROFIT_FLOOR_LADDER` comment in `@trading-app/shared`), so an env re-cut that
 * moved the allowance without moving the ladder would leave the flag-on rule
 * running the OLD give-back — the "consistent with the effective values" clause
 * in the issue.
 *
 * Returns the frozen compiled `PROFIT_FLOOR_LADDER` itself when the schedule is
 * compiled, so the default path is unchanged by reference.
 */
export function buildProfitFloorLadder(
  schedule: OtmProfitSchedule,
): readonly ProfitFloorLadderStep[] {
  if (
    schedule.armR === PROFIT_FLOOR_ARM_R
    && schedule.giveBackR === PROFIT_LOCK_GIVEBACK_R
    && schedule.tightenGiveBackR === PROFIT_LOCK_TIGHTEN_GIVEBACK_R
    && schedule.tightenPeakR === PROFIT_LOCK_TIGHTEN_PEAK_R
  ) {
    return PROFIT_FLOOR_LADDER;
  }
  return Object.freeze([
    { peakR: schedule.armR, giveBackR: schedule.giveBackR, floorR: PROFIT_FLOOR_RUNG1_FLOOR_R },
    { peakR: PROFIT_FLOOR_RUNG2_PEAK_R, giveBackR: schedule.giveBackR, floorR: PROFIT_FLOOR_RUNG2_FLOOR_R },
    { peakR: schedule.tightenPeakR, giveBackR: schedule.tightenGiveBackR, floorR: PROFIT_FLOOR_RUNG2_FLOOR_R },
    { peakR: PROFIT_FLOOR_RUNG3_PEAK_R, giveBackR: schedule.tightenGiveBackR, floorR: PROFIT_FLOOR_RUNG3_FLOOR_R },
  ]);
}

/** One key's contribution to the effective schedule, for the health surface. */
export interface OtmProfitScheduleKeyReport {
  raw: string | null;
  applied: boolean;
  source: 'env' | 'compiled';
  rejectedReason: OtmProfitScheduleRejectionReason | null;
}

export interface OtmProfitScheduleReport {
  issue: 'TRA-4244';
  source: 'env' | 'compiled';
  /** What the sleeve actually runs. */
  effective: OtmProfitScheduleValues;
  /** What it would run with no env keys set. */
  compiled: OtmProfitScheduleValues;
  /** Per-key: what was supplied, whether it landed, and why not. */
  keys: Record<string, OtmProfitScheduleKeyReport>;
  rejected: OtmProfitScheduleRejection[];
  /** The floor ladder as the exit pass will read it, with the effective give-backs. */
  floorLadder: readonly ProfitFloorLadderStep[];
  note: string;
}

/**
 * Describe the resolved schedule for `/api/health/live-enforce-gates`. PURE over
 * env — the route calls this with the same `process.env` the account read at
 * boot, so a divergence between the wire and the running rule can only come from
 * an env write made AFTER boot (which does not take effect until a redeploy;
 * TRA-3724), and that is exactly the thing the reader needs to be able to see.
 */
export function describeOtmProfitSchedule(
  env: NodeJS.ProcessEnv = process.env,
): OtmProfitScheduleReport {
  const schedule = resolveOtmProfitSchedule(env);
  const keys: Record<string, OtmProfitScheduleKeyReport> = {};
  for (const key of OTM_PROFIT_SCHEDULE_VARS) {
    const rejection = schedule.rejected.find((r) => r.key === key) ?? null;
    const applied = schedule.applied.includes(key);
    keys[key] = {
      raw: rawOf(env, key),
      applied,
      source: applied ? 'env' : 'compiled',
      rejectedReason: rejection?.reason ?? null,
    };
  }
  const note = schedule.rejected.length > 0
    ? `⚠️ OVERRIDES DISCARDED — the whole set failed closed to the compiled schedule. `
      + `Rejected: ${schedule.rejected.map((r) => `${r.key}=${r.raw ?? '(unset)'} (${r.reason})`).join('; ')}. `
      + 'The four knobs are one exit rule, so a partial application is never made (TRA-4244).'
    : schedule.source === 'env'
      ? `Effective from env: ${schedule.applied.join(', ')}. Every other value is the compiled default.`
      : 'No override keys set — running the compiled schedule (bit-identical to the pre-TRA-4244 build).';
  return {
    issue: 'TRA-4244',
    source: schedule.source,
    effective: {
      tp1Pct: schedule.tp1Pct,
      armR: schedule.armR,
      giveBackR: schedule.giveBackR,
      tightenGiveBackR: schedule.tightenGiveBackR,
      tightenPeakR: schedule.tightenPeakR,
    },
    compiled: { ...COMPILED_OTM_PROFIT_SCHEDULE },
    keys,
    rejected: schedule.rejected,
    floorLadder: buildProfitFloorLadder(schedule),
    note,
  };
}
