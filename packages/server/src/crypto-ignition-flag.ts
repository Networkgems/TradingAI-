// TRA-1271 (parent TRA-1266 → TRA-1210) — observe-only crypto ignition scanner
// feature flag + strict-conviction config resolution.
//
// Mirrors `crypto-regime-tsmom-flag.ts` (TRA-1221), `perp-funding-carry-flag.ts`
// (TRA-1216), and `iv-rv` (TRA-1156): a master flag checker (1/true/yes/on), a
// `resolveIgnitionConfig(env)` that hydrates every knob from the environment
// (defaulting any unset/out-of-range value to the STRICT spec default so a
// fat-finger env can NEVER loosen the trigger), and a `resolveIgnitionWatchlist`
// that reuses the TRA-1217 42-name majors+mid-cap universe by default.
//
// OFF by default ⇒ zero cost/IO: no 4H candle fetch, no scan, no store writes,
// and `enabled:false` on `GET /api/health/crypto-ignition`.
//
// ── HARD INVARIANT (do NOT violate) ──────────────────────────────────────────
// Observe-only, ZERO capital, NO order submission, NO sizing, NO account touch
// anywhere off this flag. This is a *capture harness*, not a trading path. Any
// move to gate live sizing on these signals is a separate, board-visible decision
// (out of scope). The confirmed edge (+0.328R all-regime, TRA-1217 §4) lives
// ENTIRELY in the maker-fill assumption; the taker case only straddles 0 (P≈0.81),
// so graduation requires forward evidence that taker-cost CI is clearly > 0.
//
// The flag is on `DEMO_FLAG_ALLOWLIST` so a non-admin operator can flip it in demo
// via `<DATA_DIR>/demo-flags.json` (see demo-flags.ts) — the only writable switch a
// non-admin agent has on the self-hosted host.

export const CRYPTO_IGNITION_FLAG = 'ENABLE_CRYPTO_IGNITION_SCANNER';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the observe-only crypto ignition scanner flag is enabled. */
export function isCryptoIgnitionEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[CRYPTO_IGNITION_FLAG]);
}

// ── Config knobs (env vars) ──────────────────────────────────────────────────

export const CRYPTO_IGNITION_RVOL_MIN_VAR = 'CRYPTO_IGNITION_RVOL_MIN';
export const CRYPTO_IGNITION_SQUEEZE_PCT_VAR = 'CRYPTO_IGNITION_SQUEEZE_PCT';
export const CRYPTO_IGNITION_DONCH_LEN_VAR = 'CRYPTO_IGNITION_DONCH_LEN';
export const CRYPTO_IGNITION_SQUEEZE_LEN_VAR = 'CRYPTO_IGNITION_SQUEEZE_LEN';
export const CRYPTO_IGNITION_VOL_LEN_VAR = 'CRYPTO_IGNITION_VOL_LEN';
export const CRYPTO_IGNITION_TREND_LEN_VAR = 'CRYPTO_IGNITION_TREND_LEN';
export const CRYPTO_IGNITION_BULL_ONLY_VAR = 'CRYPTO_IGNITION_BULL_ONLY';
export const CRYPTO_IGNITION_TP_PCT_VAR = 'CRYPTO_IGNITION_TP_PCT';
export const CRYPTO_IGNITION_STOP_PCT_VAR = 'CRYPTO_IGNITION_STOP_PCT';
export const CRYPTO_IGNITION_MAX_HOLD_BARS_VAR = 'CRYPTO_IGNITION_MAX_HOLD_BARS';
export const CRYPTO_IGNITION_MAKER_FEE_BPS_VAR = 'CRYPTO_IGNITION_MAKER_FEE_BPS';
export const CRYPTO_IGNITION_TAKER_FEE_BPS_VAR = 'CRYPTO_IGNITION_TAKER_FEE_BPS';
export const CRYPTO_IGNITION_SLIP_BPS_VAR = 'CRYPTO_IGNITION_SLIP_BPS';
export const CRYPTO_IGNITION_WATCHLIST_VAR = 'CRYPTO_IGNITION_WATCHLIST';

export interface IgnitionConfig {
  /** RVOL threshold: bar volume / SMA(vol, volLen) ≥ this. STRICT — env can only raise. */
  rvolMin: number;
  /** Pre-breakout channel width must be < squeezePct × price. STRICT — env can only lower. */
  squeezePct: number;
  /** Donchian breakout lookback (bars). */
  donchLen: number;
  /** Pre-breakout window measured for tightness (bars). */
  squeezeLen: number;
  /** RVOL baseline SMA window (bars). */
  volLen: number;
  /** EMA trend-filter length (bars). */
  trendLen: number;
  /** Fire ONLY in bull (trend_up) regime — no bear sizing/observe. */
  bullOnly: boolean;
  /** Primary take-profit target (fraction, +10%). A +15% arm is tracked alongside. */
  tpPct: number;
  /** Primary hard stop (fraction, −4%). A −5% arm is tracked alongside. 1R = this distance. */
  stopPct: number;
  /** Pessimistic exit horizon (4H bars). */
  maxHoldBars: number;
  /** Maker (limit) fee, bps per leg — the fill assumption the confirmed edge rests on. */
  makerFeeBps: number;
  /** Taker (market) fee, bps per leg. */
  takerFeeBps: number;
  /** Slippage estimate, bps per leg (applied to the taker arm). */
  slipBps: number;
}

/** Strict-conviction spec defaults (TRA-1217 §2/§4 — the ONLY config with real edge). */
export const IGNITION_DEFAULTS: IgnitionConfig = {
  rvolMin: 6.0,
  squeezePct: 0.08,
  donchLen: 30,
  squeezeLen: 30,
  volLen: 30,
  trendLen: 50,
  bullOnly: true,
  tpPct: 0.1,
  stopPct: 0.04,
  maxHoldBars: 30,
  makerFeeBps: 20,
  takerFeeBps: 60,
  slipBps: 3,
};

/** The secondary TP/SL arm tracked alongside the primary (spec §1: "+15%/−5% arm"). */
export const IGNITION_SECONDARY_ARM = { tpPct: 0.15, stopPct: 0.05 } as const;

/** Finite float ≥ `min`, else the default. */
function parseFloatMin(raw: string | undefined, fallback: number, min: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= min ? n : fallback;
}

/** Finite float strictly > 0, else the default (tp/stop distances can't be ≤0). */
function parseFloatPos(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n > 0 ? n : fallback;
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
 * Resolve the strict ignition config from the environment. Every knob is
 * env-overridable, but the two TRIGGER-STRENGTH knobs are clamped so an override
 * can only make the trigger STRICTER, never looser (guardrail §1 — a fat-finger
 * env must never loosen the trigger):
 *   • `rvolMin` accepts an override only if ≥ the default (higher = fewer fires);
 *   • `squeezePct` accepts an override only in (0, default] (tighter = fewer fires).
 * A looser or out-of-range value silently falls back to the strict spec default.
 * The structural window knobs (donch/squeeze/vol/trend/maxHold) are positive ints,
 * fees/slip are ≥0, tp/stop are >0.
 */
export function resolveIgnitionConfig(
  env: NodeJS.ProcessEnv = process.env,
): IgnitionConfig {
  const d = IGNITION_DEFAULTS;
  // rvolMin: only accept a STRICTER (≥ default) override — never loosen.
  const rvolMin = parseFloatMin(env[CRYPTO_IGNITION_RVOL_MIN_VAR], d.rvolMin, d.rvolMin);
  // squeezePct: only accept a TIGHTER (>0 and ≤ default) override — never widen.
  const sqRaw = env[CRYPTO_IGNITION_SQUEEZE_PCT_VAR];
  const sqParsed = typeof sqRaw === 'string' ? Number(sqRaw.trim()) : NaN;
  const squeezePct =
    Number.isFinite(sqParsed) && sqParsed > 0 && sqParsed <= d.squeezePct ? sqParsed : d.squeezePct;
  return {
    rvolMin,
    squeezePct,
    donchLen: parsePosInt(env[CRYPTO_IGNITION_DONCH_LEN_VAR], d.donchLen),
    squeezeLen: parsePosInt(env[CRYPTO_IGNITION_SQUEEZE_LEN_VAR], d.squeezeLen),
    volLen: parsePosInt(env[CRYPTO_IGNITION_VOL_LEN_VAR], d.volLen),
    trendLen: parsePosInt(env[CRYPTO_IGNITION_TREND_LEN_VAR], d.trendLen),
    bullOnly: parseBool(env[CRYPTO_IGNITION_BULL_ONLY_VAR], d.bullOnly),
    tpPct: parseFloatPos(env[CRYPTO_IGNITION_TP_PCT_VAR], d.tpPct),
    stopPct: parseFloatPos(env[CRYPTO_IGNITION_STOP_PCT_VAR], d.stopPct),
    maxHoldBars: parsePosInt(env[CRYPTO_IGNITION_MAX_HOLD_BARS_VAR], d.maxHoldBars),
    makerFeeBps: parseFloatMin(env[CRYPTO_IGNITION_MAKER_FEE_BPS_VAR], d.makerFeeBps, 0),
    takerFeeBps: parseFloatMin(env[CRYPTO_IGNITION_TAKER_FEE_BPS_VAR], d.takerFeeBps, 0),
    slipBps: parseFloatMin(env[CRYPTO_IGNITION_SLIP_BPS_VAR], d.slipBps, 0),
  };
}

/**
 * TRA-1217 42-name majors + liquid mid-cap alt universe — where discrete 10-15%
 * pops actually happen. Kept in sync with `run-tra1217-ignition.ts` so the live
 * signal scans the SAME universe it was backtested on.
 */
export const CRYPTO_IGNITION_DEFAULT_WATCHLIST = [
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'ADA-USD', 'DOGE-USD', 'AVAX-USD',
  'LINK-USD', 'DOT-USD', 'LTC-USD', 'BCH-USD', 'ATOM-USD', 'UNI-USD', 'XLM-USD',
  'ETC-USD', 'FIL-USD', 'NEAR-USD', 'APT-USD', 'ARB-USD', 'OP-USD', 'INJ-USD',
  'SUI-USD', 'RENDER-USD', 'AAVE-USD', 'MKR-USD', 'CRV-USD', 'LDO-USD', 'SNX-USD',
  'GRT-USD', 'ALGO-USD', 'HBAR-USD', 'IMX-USD', 'SAND-USD', 'MANA-USD', 'APE-USD',
  'AXS-USD', 'CHZ-USD', 'COMP-USD', 'FLOW-USD', 'ICP-USD', 'POL-USD', 'ZEC-USD',
] as const;

/**
 * Resolve the crypto watchlist to scan. Comma/whitespace-separated env override,
 * upper-cased + de-duped; falls back to the TRA-1217 42-name universe.
 */
export function resolveIgnitionWatchlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[CRYPTO_IGNITION_WATCHLIST_VAR];
  if (typeof raw !== 'string' || raw.trim() === '') return [...CRYPTO_IGNITION_DEFAULT_WATCHLIST];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[,\s]+/)) {
    const id = tok.trim().toUpperCase();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : [...CRYPTO_IGNITION_DEFAULT_WATCHLIST];
}
