// TRA-2233 (parent TRA-2174) — env flag + config resolver for the marketable(bid)
// open-position valuation. Mirrors the `exit-risk-rules-flag.ts` shape so the
// whole path ships DARK and can be armed/reverted atomically.
//
// OFF by default — nothing changes until an operator flips
// `ENABLE_MARKETABLE_OPEN_MTM`, which is gated on the forward-validation harness
// confirming the modeled mark against real Tradier sandbox fills (see
// `scripts/marketable-mtm-forward-validation.mjs`). DEMO-scoped downstream: the
// account only applies the marketable basis on the demo/paper book and demo close
// fills, so this flag is structurally incapable of changing a live number
// (TRA-1897 hold safe).

import {
  DEFAULT_MARKETABLE_HALF_SPREAD_FRAC,
  clampHalfSpreadFrac,
  type MarketableOpenMtmConfig,
} from './marketable-open-mtm.js';

export const MARKETABLE_OPEN_MTM_FLAG = 'ENABLE_MARKETABLE_OPEN_MTM';
/** Optional override for the modeled half-spread fraction `(mid − bid)/mid`. */
export const MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC_ENV = 'MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the marketable(bid) valuation is armed (accepts 1/true/yes/on). */
export function isMarketableOpenMtmEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[MARKETABLE_OPEN_MTM_FLAG]);
}

/**
 * Resolve the full {@link MarketableOpenMtmConfig} from the environment: the
 * enable flag plus the optional modeled half-spread fraction (default = the
 * measured demo-journal mean, {@link DEFAULT_MARKETABLE_HALF_SPREAD_FRAC}). A
 * non-finite / out-of-range override is clamped by {@link clampHalfSpreadFrac};
 * an unparseable one falls back to the default rather than zeroing the haircut.
 */
export function resolveMarketableOpenMtmConfig(
  env: NodeJS.ProcessEnv = process.env,
): MarketableOpenMtmConfig {
  const raw = env[MARKETABLE_OPEN_MTM_HALF_SPREAD_FRAC_ENV];
  const parsed = raw !== undefined ? Number(raw) : Number.NaN;
  const halfSpreadFrac = Number.isFinite(parsed)
    ? clampHalfSpreadFrac(parsed)
    : DEFAULT_MARKETABLE_HALF_SPREAD_FRAC;
  return {
    enabled: isMarketableOpenMtmEnabled(env),
    halfSpreadFrac,
  };
}
