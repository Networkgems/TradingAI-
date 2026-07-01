// TRA-1221 (parent TRA-1219, rec #2 of the TRA-1211 memo) — regime-gated TSMOM
// crypto OBSERVE-ONLY scanner feature flag + config resolution.
//
// Mirrors `perp-funding-carry-flag.ts` (TRA-1216) and `crypto-regime-flag.ts`
// (TRA-1220) exactly: a master flag checker (1/true/yes/on), a
// `resolveRegimeTsmomConfig(env)` that hydrates every band/fee/vol knob from the
// environment (defaulting any unset/out-of-range value so a fat-finger env can't
// invert the signal), and a `resolveRegimeTsmomWatchlist(env)` that reuses the
// TRA-1220 12-major universe by default.
//
// OFF by default ⇒ zero cost/IO: no 4H candle fetch, no classify, no store
// writes, and `enabled:false` on `GET /api/health/crypto-regime-tsmom`. There is
// NO order/entry/sizing path anywhere off this flag — the scanner emits would-be
// long/exit/short-observe SIGNALS only. Any move to gate live sizing on these
// signals returns to CFO separately (invariant #4).
//
// The flag is on `DEMO_FLAG_ALLOWLIST` so a non-admin operator can flip it on the
// self-hosted host via `<DATA_DIR>/demo-flags.json` (see demo-flags.ts).

import { CRYPTO_REGIME_DEFAULT_WATCHLIST } from './crypto-regime-flag.js';

export const CRYPTO_REGIME_TSMOM_FLAG = 'ENABLE_CRYPTO_REGIME_TSMOM';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the observe-only regime-gated TSMOM scanner flag is enabled. */
export function isRegimeTsmomEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CRYPTO_REGIME_TSMOM_FLAG]);
}

// ── Tunable bands / fees (QuantTrader sign-off — spec §4) ─────────────────────
//
// Every knob is env-overridable so QuantTrader / the operator can run the offline
// sweep grid (spec §6: entry/exit band ∈ {5,8,10,12,15}%, L ∈ {50,100,150,200})
// WITHOUT a code change. A non-finite / out-of-range override falls back to the
// spec default so the signal never inverts.

export const CRYPTO_REGIME_TSMOM_LOOKBACK_BARS_VAR = 'CRYPTO_REGIME_TSMOM_LOOKBACK_BARS';
export const CRYPTO_REGIME_TSMOM_ENTRY_BAND_PCT_VAR = 'CRYPTO_REGIME_TSMOM_ENTRY_BAND_PCT';
export const CRYPTO_REGIME_TSMOM_EXIT_BAND_PCT_VAR = 'CRYPTO_REGIME_TSMOM_EXIT_BAND_PCT';
export const CRYPTO_REGIME_TSMOM_MIN_CONFIDENCE_VAR = 'CRYPTO_REGIME_TSMOM_MIN_CONFIDENCE';
export const CRYPTO_REGIME_TSMOM_ALLOW_CHOP_LONG_VAR = 'CRYPTO_REGIME_TSMOM_ALLOW_CHOP_LONG';
export const CRYPTO_REGIME_TSMOM_SHORT_OBSERVE_VAR = 'CRYPTO_REGIME_TSMOM_SHORT_OBSERVE';
export const CRYPTO_REGIME_TSMOM_VOL_TARGET_PCT_VAR = 'CRYPTO_REGIME_TSMOM_VOL_TARGET_PCT';
export const CRYPTO_REGIME_TSMOM_FEE_BPS_VAR = 'CRYPTO_REGIME_TSMOM_FEE_BPS';
export const CRYPTO_REGIME_TSMOM_SLIP_BPS_VAR = 'CRYPTO_REGIME_TSMOM_SLIP_BPS';
export const CRYPTO_REGIME_TSMOM_WATCHLIST_VAR = 'CRYPTO_REGIME_TSMOM_WATCHLIST';

/** Spec §4 defaults — the memo baseline `L`, ±10% bands, 60bps taker + 3bps slip. */
export const REGIME_TSMOM_DEFAULTS: RegimeTsmomConfig = {
  lookbackBars: 100,
  entryBandPct: 10.0,
  exitBandPct: 10.0,
  minRegimeConfidence: 0.0,
  allowChopLong: false,
  shortObserve: true,
  volTargetPct: 60,
  feeBps: 60,
  slipBps: 3,
};

export interface RegimeTsmomConfig {
  /** Trailing total-return lookback in **4H** bars (`L`). */
  lookbackBars: number;
  /** Enter long when `r_L >= entryBandPct/100` (and the regime gate allows). Percent. */
  entryBandPct: number;
  /** Exit to flat when `r_L <= -exitBandPct/100` (or the regime leaves trend_up). Percent. */
  exitBandPct: number;
  /** Regime-confidence floor for a long to be eligible ([0,1]; 0 = capture-all). */
  minRegimeConfidence: number;
  /** Allow a long while regime is `chop` (default false — chop is the churn zone). */
  allowChopLong: boolean;
  /** Surface a would-be `short_observe` on bear down-momentum (observe-only, never sized). */
  shortObserve: boolean;
  /** Annualised vol-target % — the §5 1R denominator anchor (`(v/100)/√365`). */
  volTargetPct: number;
  /** Taker fee, bps, one leg. Round-trip cost = `2×(feeBps+slipBps)`. */
  feeBps: number;
  /** Slippage estimate, bps, one leg. */
  slipBps: number;
}

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

/** Explicit boolean override; unset/garbage → the default (no accidental flip). */
function parseBool(raw: string | undefined, fallback: boolean): boolean {
  if (typeof raw !== 'string' || raw.trim() === '') return fallback;
  const v = raw.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  return fallback;
}

/**
 * Resolve the observe-only TSMOM config from the environment, defaulting every
 * unset / out-of-range value from {@link REGIME_TSMOM_DEFAULTS} so the signal math
 * never inverts. Bands and vol-target must be strictly positive; confidence floor
 * lives in [0,1] but a ≥0 floor is enough to keep the gate finite.
 */
export function resolveRegimeTsmomConfig(
  env: NodeJS.ProcessEnv = process.env,
): RegimeTsmomConfig {
  const d = REGIME_TSMOM_DEFAULTS;
  const conf = parseFloatMin(env[CRYPTO_REGIME_TSMOM_MIN_CONFIDENCE_VAR], d.minRegimeConfidence, 0);
  return {
    lookbackBars: parsePosInt(env[CRYPTO_REGIME_TSMOM_LOOKBACK_BARS_VAR], d.lookbackBars),
    // Bands must be > 0 (a 0 band is the churny memo baseline this scanner exists
    // to fix); reject with parseFloatMin's min just above 0 by falling back on ≤0.
    entryBandPct: parseFloatMinPos(env[CRYPTO_REGIME_TSMOM_ENTRY_BAND_PCT_VAR], d.entryBandPct),
    exitBandPct: parseFloatMinPos(env[CRYPTO_REGIME_TSMOM_EXIT_BAND_PCT_VAR], d.exitBandPct),
    minRegimeConfidence: conf > 1 ? d.minRegimeConfidence : conf,
    allowChopLong: parseBool(env[CRYPTO_REGIME_TSMOM_ALLOW_CHOP_LONG_VAR], d.allowChopLong),
    shortObserve: parseBool(env[CRYPTO_REGIME_TSMOM_SHORT_OBSERVE_VAR], d.shortObserve),
    volTargetPct: parseFloatMinPos(env[CRYPTO_REGIME_TSMOM_VOL_TARGET_PCT_VAR], d.volTargetPct),
    feeBps: parseFloatMin(env[CRYPTO_REGIME_TSMOM_FEE_BPS_VAR], d.feeBps, 0),
    slipBps: parseFloatMin(env[CRYPTO_REGIME_TSMOM_SLIP_BPS_VAR], d.slipBps, 0),
  };
}

/** Finite float strictly > 0, else the default (bands / vol-target can't be ≤0). */
function parseFloatMinPos(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * Resolve the crypto watchlist to scan. Comma/whitespace-separated env override,
 * upper-cased + de-duped; falls back to the TRA-1220 12-major universe
 * ({@link CRYPTO_REGIME_DEFAULT_WATCHLIST}) so the TSMOM scan runs on the SAME
 * universe/bars as the regime overlay it consumes.
 */
export function resolveRegimeTsmomWatchlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[CRYPTO_REGIME_TSMOM_WATCHLIST_VAR];
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
