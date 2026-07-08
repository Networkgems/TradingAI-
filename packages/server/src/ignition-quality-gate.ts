// TRA-1476 (parent TRA-1471) — liquidity/quality + per-name churn cap for the
// demo directional "ignition" entry path (TRA-1114 `evaluateDemoDirectional`).
//
// Evidence (bqb1 DEMO paper options desk, 2026-07-08): the deterministic
// directional call/put pass stacked AMPG — a thin, sub-liquidity micro-cap — 28
// times in one morning for −$432.50, nearly all losers (the worst single-name
// drag of the day). That path is the ONLY single-leg demo open that fires on a
// calm tape, and it had NONE of the containment the RV long path already carries:
//   • no min-price / min-$-volume floor (so a $2 micro-cap is as eligible as XLE);
//   • no per-name open cap (its only dedup is a 1-hour SAME-OCC guard, which a
//     drifting ATM strike sidesteps every few minutes → re-entry churn);
//   • it never even fed the TRA-1408 churn counter, so that brake couldn't see it.
//
// This module is the PURE decision surface for a defense-in-depth gate on that
// path. It is deliberately dependency-free (env parsing + arithmetic only) so it
// unit-tests without the engine. The signal-engine wires the verdict in on the
// DEMO directional chokepoint and records each open against the shared TRA-1408
// per-name counter.
//
// Layered ON TOP OF the existing ignition flag (`ENABLE_OPTION_DEMO_DIRECTIONAL`):
// the sub-flag `ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE` only takes effect when the
// directional path is itself enabled, so an operator can never accidentally arm
// the gate against a path that isn't running. OFF by default ⇒ the directional
// pass is byte-for-byte unchanged until the board arms it (demo-flags.json),
// keeping it DEMO-only until QuantTrader forward-validates the thresholds.
//
// Thresholds are all env-overridable with PROVISIONAL defaults — QuantTrader owns
// the final numbers (per the TRA-1476 ask, "will define the exact thresholds once
// you scope the filter hook"). The defaults are chosen only to reject the AMPG
// pathology on day one if armed unconfigured, not as a validated tuning.

import { isOptionDemoDirectionalEnabled } from './option-exec-flag.js';
import type { Candle } from '@trading-app/shared';

export const OPTION_DIRECTIONAL_QUALITY_GATE_FLAG = 'ENABLE_OPTION_DIRECTIONAL_QUALITY_GATE';

/** Env override: reject a directional open when the underlier spot is below this ($). */
export const OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_VAR = 'OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE';
/** Env override: reject when the avg per-bar dollar-volume (close×volume) is below this ($). */
export const OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_VAR = 'OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME';
/** Env override: max NEW directional opens per underlier per ET session. */
export const OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_VAR = 'OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME';

// PROVISIONAL defaults — QuantTrader confirms on TRA-1476. Sub-$5 names and the
// per-bar $-volume floor together exclude the AMPG-class micro-cap; the per-name
// cap mirrors the TRA-1408 default (3) for defense-in-depth symmetry.
export const OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_DEFAULT = 5;
export const OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_DEFAULT = 250_000;
export const OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_DEFAULT = 3;

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * True iff the directional path is on AND the quality-gate sub-flag is on. Reads
 * the sub-flag through the SAME env the caller resolves demo-flags.json into, so
 * a board file-flip is picked up on the next tick. Layered so the gate can never
 * bite a path that isn't running (and so turning the ignition flag off kills the
 * gate too).
 */
export function isDirectionalQualityGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isOptionDemoDirectionalEnabled(env) && flagOn(env[OPTION_DIRECTIONAL_QUALITY_GATE_FLAG]);
}

function parsePositiveFloat(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function parsePositiveInt(raw: string | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : undefined;
}

export interface DirectionalQualityThresholds {
  /** Minimum underlier spot ($). */
  minUnderlyingPrice: number;
  /** Minimum average per-bar dollar-volume ($). */
  minAvgDollarVolume: number;
  /** Maximum NEW directional opens per name per ET session. */
  maxOpensPerName: number;
}

/**
 * Resolve the (env-overridable) thresholds, each falling back to its PROVISIONAL
 * default on an unset / malformed / non-positive value — a fat-finger env can
 * never silently disable a floor (which would re-open the AMPG pathology). The
 * open cap is floored to an integer (a fractional count is meaningless).
 */
export function resolveDirectionalQualityThresholds(
  env: NodeJS.ProcessEnv = process.env,
): DirectionalQualityThresholds {
  return {
    minUnderlyingPrice:
      parsePositiveFloat(env[OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_VAR])
      ?? OPTION_DIRECTIONAL_MIN_UNDERLYING_PRICE_DEFAULT,
    minAvgDollarVolume:
      parsePositiveFloat(env[OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_VAR])
      ?? OPTION_DIRECTIONAL_MIN_AVG_DOLLAR_VOLUME_DEFAULT,
    maxOpensPerName:
      parsePositiveInt(env[OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_VAR])
      ?? OPTION_DIRECTIONAL_MAX_OPENS_PER_NAME_DEFAULT,
  };
}

/**
 * Average per-bar dollar-volume (close × volume) across the REAL bars of a series.
 * Synthetic gap-fill bars (flat, zero-volume — {@link Candle.synthetic}) are
 * excluded so a data gap can't dilute the estimate toward zero and spuriously
 * reject a liquid name. Returns 0 when there is no usable bar (an empty / all-
 * synthetic series is treated as "unknown liquidity" ⇒ the floor rejects it,
 * which is the safe default for the demo book). A non-finite or negative product
 * is clamped to 0 so a bad tick can't inflate the average.
 */
export function averageDollarVolume(candles: readonly Candle[]): number {
  let sum = 0;
  let n = 0;
  for (const c of candles) {
    if (c.synthetic) continue;
    const dv = c.close * c.volume;
    if (!Number.isFinite(dv) || dv < 0) continue;
    sum += dv;
    n += 1;
  }
  return n > 0 ? sum / n : 0;
}

export interface DirectionalQualityInput {
  /** Underlier spot at evaluation. */
  spot: number;
  /** Average per-bar dollar-volume from {@link averageDollarVolume}. */
  avgDollarVolume: number;
  /** NEW directional opens already recorded for this name this ET session. */
  opensToday: number;
}

export interface DirectionalQualityVerdict {
  admitted: boolean;
  /** Machine-tag of the failing rule (or null when admitted). */
  code: 'ok' | 'min_price' | 'min_dollar_volume' | 'per_name_cap';
  /** Human-readable rejection reason (or null when admitted). */
  reason: string | null;
}

const ADMITTED: DirectionalQualityVerdict = { admitted: true, code: 'ok', reason: null };

/**
 * Pure quality/liquidity + per-name-churn verdict for ONE directional entry.
 * Order of checks (cheapest / most-fundamental first): price floor, then
 * dollar-volume floor, then the per-name open cap. The caller only invokes this
 * when {@link isDirectionalQualityGateEnabled} is true, so an admitted verdict on
 * the disabled path is implicit (never called).
 */
export function directionalQualityVerdict(
  input: DirectionalQualityInput,
  thresholds: DirectionalQualityThresholds,
): DirectionalQualityVerdict {
  const { spot, avgDollarVolume, opensToday } = input;
  const { minUnderlyingPrice, minAvgDollarVolume, maxOpensPerName } = thresholds;

  if (!(spot >= minUnderlyingPrice)) {
    return {
      admitted: false,
      code: 'min_price',
      reason: `underlier $${spot.toFixed(2)} below min price $${minUnderlyingPrice.toFixed(2)}`,
    };
  }
  if (!(avgDollarVolume >= minAvgDollarVolume)) {
    return {
      admitted: false,
      code: 'min_dollar_volume',
      reason: `avg $-volume $${Math.round(avgDollarVolume)} below floor $${Math.round(minAvgDollarVolume)}`,
    };
  }
  if (opensToday >= maxOpensPerName) {
    return {
      admitted: false,
      code: 'per_name_cap',
      reason: `hit per-name directional open cap (${opensToday}/${maxOpensPerName})`,
    };
  }
  return ADMITTED;
}
