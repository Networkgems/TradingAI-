// TRA-1216 (parent TRA-1214, epic TRA-1210) — perpetual funding-rate carry
// OBSERVE-ONLY scanner feature flag + config resolution.
//
// GREENLIT from the TRA-1211 crypto-regime research memo. The signal is a
// delta-neutral funding carry (long spot / short perp): when perp funding is
// POSITIVE, longs pay shorts, so a long-spot/short-perp structure earns the
// funding payment with ≈ zero directional delta. This flag turns on an
// OBSERVE-AND-CAPTURE pass (mirror the TRA-1156 IV-vs-RV scanner) that ranks
// eligible perps by net funding APR and accrues a forward funding-history series
// (the sole persisted artifact) so a future carry backtest becomes possible.
//
// OFF by default ⇒ zero cost/IO: no funding fetch, no history file writes, an
// empty scan store, and `enabled:false` on `GET /api/health/perp-funding-carry`.
// There is NO order/entry/sizing path anywhere off this flag — the short-perp
// leg carries a liquidation-risk note but is never sized here. Live-capital
// promotion stays gated on TRA-382 regardless of this flag.
//
// Mirrors the `option-exec-flag.ts` checker shape (1/true/yes/on). The flag is
// also on `DEMO_FLAG_ALLOWLIST` so a non-admin operator can flip it on the
// self-hosted host via `<DATA_DIR>/demo-flags.json` (see demo-flags.ts).

export const PERP_FUNDING_CARRY_FLAG = 'ENABLE_PERP_FUNDING_CARRY_OBSERVE';

function flagOn(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** True iff the observe-only perp funding-carry scanner flag is enabled. */
export function isPerpFundingCarryEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return flagOn(env[PERP_FUNDING_CARRY_FLAG]);
}

// ── Tunable thresholds (QuantTrader sign-off — spec §3) ──────────────────────
//
// All observe-only knobs default to the spec values and are env-overridable so
// QuantTrader / the operator can retune the surfacing/strong cut WITHOUT a code
// change. A non-finite / negative override falls back to the default so a
// fat-finger env can't invert the math.

export const PERP_CARRY_MIN_NET_APR_VAR = 'PERP_CARRY_MIN_NET_APR';
export const PERP_CARRY_FEE_BPS_ROUNDTRIP_VAR = 'PERP_CARRY_FEE_BPS_ROUNDTRIP';
export const PERP_CARRY_BORROW_APR_VAR = 'PERP_CARRY_BORROW_APR';
export const PERP_CARRY_WATCHLIST_VAR = 'PERP_CARRY_WATCHLIST';

/** Net-APR floor for the `strong` materiality tier (spec §3). */
export const PERP_CARRY_DEFAULT_MIN_NET_APR = 0.05;
/** Round-trip taker fee estimate, both legs in+out, in bps (spec §2/§3). */
export const PERP_CARRY_DEFAULT_FEE_BPS_ROUNDTRIP = 20;
/** Cost of capital / borrow on the structure, spot fully funded ⇒ 0 (spec §3). */
export const PERP_CARRY_DEFAULT_BORROW_APR = 0;
/**
 * Perps to observe funding for — fetched REGARDLESS of open positions so a
 * forward carry series accrues. Coinbase INTX product-id form is `BASE-PERP-INTX`.
 */
export const PERP_CARRY_DEFAULT_WATCHLIST = ['BTC-PERP-INTX', 'ETH-PERP-INTX', 'SOL-PERP-INTX'];

export interface PerpCarryConfig {
  /** Net-APR at/above which a candidate is tagged `strong` (else `marginal`). */
  minNetApr: number;
  /** Round-trip taker fee (both legs, in+out) in bps for the breakeven horizon. */
  feeBpsRoundTrip: number;
  /** Annualised borrow / cost-of-capital subtracted from funding APR. */
  borrowApr: number;
}

function parseNonNegFloat(raw: string | undefined, fallback: number): number {
  if (typeof raw !== 'string') return fallback;
  const n = Number(raw.trim());
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * Resolve the observe-only carry thresholds from the environment, falling back
 * to the spec defaults for any unset/invalid value so the math never inverts.
 */
export function resolvePerpCarryConfig(env: NodeJS.ProcessEnv = process.env): PerpCarryConfig {
  return {
    minNetApr: parseNonNegFloat(env[PERP_CARRY_MIN_NET_APR_VAR], PERP_CARRY_DEFAULT_MIN_NET_APR),
    feeBpsRoundTrip: parseNonNegFloat(
      env[PERP_CARRY_FEE_BPS_ROUNDTRIP_VAR],
      PERP_CARRY_DEFAULT_FEE_BPS_ROUNDTRIP,
    ),
    borrowApr: parseNonNegFloat(env[PERP_CARRY_BORROW_APR_VAR], PERP_CARRY_DEFAULT_BORROW_APR),
  };
}

/**
 * Resolve the perp watchlist to observe. Comma/whitespace-separated env override,
 * upper-cased + de-duped; falls back to {@link PERP_CARRY_DEFAULT_WATCHLIST} when
 * unset or empty after parsing.
 */
export function resolvePerpCarryWatchlist(env: NodeJS.ProcessEnv = process.env): string[] {
  const raw = env[PERP_CARRY_WATCHLIST_VAR];
  if (typeof raw !== 'string' || raw.trim() === '') return [...PERP_CARRY_DEFAULT_WATCHLIST];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tok of raw.split(/[,\s]+/)) {
    const id = tok.trim().toUpperCase();
    if (id === '' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.length > 0 ? out : [...PERP_CARRY_DEFAULT_WATCHLIST];
}
