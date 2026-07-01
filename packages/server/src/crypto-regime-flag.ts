// TRA-1220 (parent TRA-1218, rec #3 of the TRA-1211 memo) — crypto regime-filter
// overlay OBSERVE-ONLY scanner feature flag + config resolution.
//
// Mirrors `perp-funding-carry-flag.ts` (TRA-1216) exactly: a master flag checker
// (1/true/yes/on), a `resolveCryptoRegimeConfig(env)` that hydrates every
// classifier threshold from the environment (defaulting any unset/out-of-range
// value so a fat-finger env can't invert the vote), and a
// `resolveCryptoRegimeWatchlist(env)`.
//
// OFF by default ⇒ zero cost/IO: no 4H candle fetch, no store writes, an empty
// scan store, and `enabled:false` on `GET /api/health/crypto-regime`. There is NO
// order/entry/sizing path anywhere off this flag — the classifier emits labels
// only. Any move to gate live sizing on these labels returns to CFO separately
// (invariant #4 — that is rec #2's job, not this issue).
//
// The flag is on `DEMO_FLAG_ALLOWLIST` so a non-admin operator can flip it on the
// self-hosted host via `<DATA_DIR>/demo-flags.json` (see demo-flags.ts).

import { CRYPTO_REGIME_DEFAULTS, type CryptoRegimeConfig } from '@trading-app/engine';

export const CRYPTO_REGIME_FLAG = 'ENABLE_CRYPTO_REGIME_OVERLAY';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the observe-only crypto regime-overlay scanner flag is enabled. */
export function isCryptoRegimeEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CRYPTO_REGIME_FLAG]);
}

// ── Tunable thresholds (QuantTrader sign-off — spec §5) ──────────────────────
//
// Every classifier knob is env-overridable so QuantTrader / the operator can
// retune WITHOUT a code change. A non-finite / out-of-range override falls back
// to the spec default (from CRYPTO_REGIME_DEFAULTS) so the math never inverts.

export const CRYPTO_REGIME_ADX_PERIOD_VAR = 'CRYPTO_REGIME_ADX_PERIOD';
export const CRYPTO_REGIME_ADX_TREND_MIN_VAR = 'CRYPTO_REGIME_ADX_TREND_MIN';
export const CRYPTO_REGIME_ADX_RANGE_MAX_VAR = 'CRYPTO_REGIME_ADX_RANGE_MAX';
export const CRYPTO_REGIME_CHOP_PERIOD_VAR = 'CRYPTO_REGIME_CHOP_PERIOD';
export const CRYPTO_REGIME_CHOP_TREND_MAX_VAR = 'CRYPTO_REGIME_CHOP_TREND_MAX';
export const CRYPTO_REGIME_CHOP_CHOP_MIN_VAR = 'CRYPTO_REGIME_CHOP_CHOP_MIN';
export const CRYPTO_REGIME_ER_PERIOD_VAR = 'CRYPTO_REGIME_ER_PERIOD';
export const CRYPTO_REGIME_ER_TREND_MIN_VAR = 'CRYPTO_REGIME_ER_TREND_MIN';
export const CRYPTO_REGIME_ER_CHOP_MAX_VAR = 'CRYPTO_REGIME_ER_CHOP_MAX';
export const CRYPTO_REGIME_EMA_PERIOD_VAR = 'CRYPTO_REGIME_EMA_PERIOD';
export const CRYPTO_REGIME_MIN_TREND_VOTES_VAR = 'CRYPTO_REGIME_MIN_TREND_VOTES';
export const CRYPTO_REGIME_MIN_BARS_VAR = 'CRYPTO_REGIME_MIN_BARS';
export const CRYPTO_REGIME_WATCHLIST_VAR = 'CRYPTO_REGIME_WATCHLIST';

/** Coinbase spot form — the TRA-1211 4H universe (12 liquid majors). */
export const CRYPTO_REGIME_DEFAULT_WATCHLIST = [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'XRP-USD',
  'ADA-USD',
  'DOGE-USD',
  'AVAX-USD',
  'LINK-USD',
  'DOT-USD',
  'LTC-USD',
  'BCH-USD',
  'ATOM-USD',
];

/** Finite float ≥ min, else the default (guards a fat-finger / inverting env). */
function parseFloatMin(raw: string | undefined, fallback: number, min: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Positive integer, else the default. */
function parsePosInt(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isInteger(n) && n >= 1 ? n : fallback;
}

/**
 * Resolve the classifier config from the environment, defaulting every unset /
 * out-of-range value from {@link CRYPTO_REGIME_DEFAULTS}. All thresholds ≥ 0 (ER
 * cuts are in [0,1] but that is a soft expectation — a ≥0 floor is enough to keep
 * the interpolation finite); periods must be positive integers; `minTrendVotes`
 * is clamped to 1..3.
 */
export function resolveCryptoRegimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): CryptoRegimeConfig {
  const d = CRYPTO_REGIME_DEFAULTS;
  const votesRaw = Number((env[CRYPTO_REGIME_MIN_TREND_VOTES_VAR] ?? '').trim());
  const minTrendVotes =
    Number.isInteger(votesRaw) && votesRaw >= 1 && votesRaw <= 3 ? votesRaw : d.minTrendVotes;
  return {
    adxPeriod: parsePosInt(env[CRYPTO_REGIME_ADX_PERIOD_VAR], d.adxPeriod),
    adxTrendMin: parseFloatMin(env[CRYPTO_REGIME_ADX_TREND_MIN_VAR], d.adxTrendMin, 0),
    adxRangeMax: parseFloatMin(env[CRYPTO_REGIME_ADX_RANGE_MAX_VAR], d.adxRangeMax, 0),
    chopPeriod: parsePosInt(env[CRYPTO_REGIME_CHOP_PERIOD_VAR], d.chopPeriod),
    chopTrendMax: parseFloatMin(env[CRYPTO_REGIME_CHOP_TREND_MAX_VAR], d.chopTrendMax, 0),
    chopChopMin: parseFloatMin(env[CRYPTO_REGIME_CHOP_CHOP_MIN_VAR], d.chopChopMin, 0),
    erPeriod: parsePosInt(env[CRYPTO_REGIME_ER_PERIOD_VAR], d.erPeriod),
    erTrendMin: parseFloatMin(env[CRYPTO_REGIME_ER_TREND_MIN_VAR], d.erTrendMin, 0),
    erChopMax: parseFloatMin(env[CRYPTO_REGIME_ER_CHOP_MAX_VAR], d.erChopMax, 0),
    emaPeriod: parsePosInt(env[CRYPTO_REGIME_EMA_PERIOD_VAR], d.emaPeriod),
    minTrendVotes,
    minBars: parsePosInt(env[CRYPTO_REGIME_MIN_BARS_VAR], d.minBars),
  };
}

/**
 * Resolve the crypto watchlist to classify. Comma/whitespace-separated env
 * override, upper-cased + de-duped; falls back to
 * {@link CRYPTO_REGIME_DEFAULT_WATCHLIST} when unset or empty after parsing.
 */
export function resolveCryptoRegimeWatchlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[CRYPTO_REGIME_WATCHLIST_VAR];
  if (typeof raw !== 'string' || raw.trim() === '') return [...CRYPTO_REGIME_DEFAULT_WATCHLIST];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[,\s]+/)) {
    const id = tok.trim().toUpperCase();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : [...CRYPTO_REGIME_DEFAULT_WATCHLIST];
}
