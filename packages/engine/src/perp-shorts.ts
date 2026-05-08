import type { TradeSignal } from '@trading-app/shared';
import type { Regime } from './regime.js';

/**
 * Crypto perp shorts strategy spec wiring (TRA-261).
 *
 * The TRA-249 perp execution layer ships the routing surface (Coinbase INTX
 * order placement, position reconciliation). This module is the **strategy
 * layer**: it owns the universe restriction, the multiplicative short filters
 * (TRA-255 §5), the short sizing/caps (TRA-255 §6), and the lifecycle
 * additions (TRA-255 §7). Long-side flow is untouched; every export here is
 * referenced only on signals where `side === 'sell'`.
 *
 * Skip-reason strings are part of the public contract — they show up on the
 * dashboard via `TradeSignal.signalSkipReason` and are asserted verbatim by
 * the unit tests. Edit with care; the spec doc and the dashboard tests both
 * pin them as load-bearing.
 */

// ── Universe (TRA-255 §2) ──────────────────────────────────────────────────

/**
 * Phase-1 perp shorts universe. Shorts on any other watchlist symbol are
 * suppressed with `signalSkipReason = SKIP_NOT_IN_UNIVERSE`. Adding a symbol
 * here is an explicit decision pending walk-forward results — keep it
 * conservative until §8 acceptance bars are met for the new addition.
 */
export const PERP_SHORTS_UNIVERSE: readonly string[] = [
  'BTC-USD',
  'ETH-USD',
  'SOL-USD',
  'XRP-USD',
  'DOGE-USD',
];

const PERP_SHORTS_UNIVERSE_SET: ReadonlySet<string> = new Set(PERP_SHORTS_UNIVERSE);

/**
 * Tier-2 symbols inside the universe (TRA-255 §6). DOGE is the canonical
 * member — Tier-2 caps per-trade short risk at 0.30% equity instead of the
 * 0.50% Tier-1 default to compensate for thinner book depth.
 */
export const PERP_SHORTS_TIER2: readonly string[] = ['DOGE-USD'];

const PERP_SHORTS_TIER2_SET: ReadonlySet<string> = new Set(PERP_SHORTS_TIER2);

export function isPerpShortSymbol(symbol: string): boolean {
  return PERP_SHORTS_UNIVERSE_SET.has(symbol);
}

export function isTier2PerpShort(symbol: string): boolean {
  return PERP_SHORTS_TIER2_SET.has(symbol);
}

/**
 * BTC-USD and any other Tier-1 majors are *not* gated by the BTC dominance
 * overlay (filter 2) — only alts are. Used by the BTC regime filter to skip
 * the alt-only gate when the symbol is already BTC.
 */
const BTC_BASE_SYMBOL = 'BTC-USD';
function isAltSymbol(symbol: string): boolean {
  return symbol !== BTC_BASE_SYMBOL;
}

// ── Skip reason strings (TRA-255 §5) ───────────────────────────────────────
//
// EXACT strings. The unit tests assert verbatim, the dashboard groups skips
// by reason, and the TRA-255 spec doc pins them as the public contract.

export const SKIP_NOT_IN_UNIVERSE = 'shorts disabled — symbol not in perp universe';
export const SKIP_MR_OFF_STRATEGY = 'shorts off-strategy';
export const SKIP_FUNDING_TOO_NEGATIVE = 'funding too negative — squeeze risk';
export const SKIP_BTC_TREND_UP = 'BTC trend up — alt short blocked';
export const SKIP_SPREAD_TOO_WIDE = 'spread too wide for perp short';
export const SKIP_OI_UNDER_MIN = 'perp OI under min';
export const SKIP_TOTAL_SHORT_NOTIONAL = 'total short notional cap';
export const SKIP_SINGLE_SYMBOL_CAP = 'single-symbol short cap';
export const SKIP_CROSS_STRATEGY_CAP = 'cross-strategy per-symbol short cap';
/**
 * TRA-255 §3.1 — per-symbol cooldown after three consecutive losing shorts.
 * Suppresses new short entries on that symbol for 48h wall-clock; other
 * symbols are unaffected and held positions are NOT auto-flatted. Threshold
 * and window are first-pass (revisit after Phase-1 walk-forward).
 */
export const SKIP_CONSECUTIVE_LOSSES = '3 consecutive short losses — symbol cooldown';
/**
 * TRA-255 §6 — book-wide cap on the number of OPEN short positions across
 * all strategies. Hard limit of 3 concurrent shorts; checked before order
 * submit alongside the existing notional caps so a fresh signal that would
 * push us past the count is dropped with this reason rather than silently
 * stacked.
 */
export const SKIP_MAX_CONCURRENT_SHORTS = 'max 3 concurrent shorts';
/**
 * TRA-255 §8.1 — Phase-1 1D timeframe is parked for all 5 universe symbols.
 * The TRA-266 §8 walk-forward sweep on daily bars hit the §8 PARK threshold
 * (consecutive failure streaks 10–15 vs the 4-window bar) on every symbol;
 * QuantTrader's r3 call was a timeframe pivot to 4H, not parameter cycling.
 * Any short signal generated against 1D bars is suppressed with this reason
 * so the dashboard surfaces the park instead of silently dropping the
 * signal. The 4H short-timeframe layer (§12 r3, Phase-1.1) is not parked —
 * the gate keys on the timeframe of the bars the strategy evaluated, not
 * the symbol.
 */
export const SKIP_PARKED_1D_DAILY = 'parked — failed §8 daily';
/**
 * TRA-255 §4.4 r6 — Phase-1.1 4H Layer 1+2 parked pending Layer 3 cascade-leg
 * trigger. The Layer 1 (r4) and Layer 2 (r5) 4H sweeps both produced
 * 0 / 9 windows with empty pre-route skip-reason histograms, confirming the
 * §4.1 / §4.2 entry triggers themselves were the binding constraint on 4H —
 * not the §3 / §5 / §6 gate stack and not the parameter values.
 *
 * While Layer 3 is in flight, every 4H short emission that is NOT routed
 * through the new cascade-leg trigger (Momentum-short on 4H) or the relaxed
 * Breakout-short knobs is suppressed pre-route with this reason so the
 * dashboard surfaces the park instead of silently dropping the signal.
 * Once Layer 3 lands and §8 4H passes, the park lifts (analogous to how 1D
 * parked baseline works today). Until then, no Mean Reversion short or
 * other off-spec 4H emission reaches sizing.
 */
export const SKIP_PARKED_4H_LAYER12 = 'parked — failed §8 4H Layer 1+2';
/**
 * TRA-255 r9 §4.4 Layer 3 v3 / §8.3 — Phase-1.1 4H universe is reduced to
 * `['SOL-USD','DOGE-USD']` after the v2 §8 4H sweep failed three of five
 * acceptance bars. BTC-USD / ETH-USD / XRP-USD are parked on 4H and any short
 * signal generated against 4H bars on those symbols is suppressed with this
 * reason so the §8 sidecar surfaces the explicit park instead of a generic
 * not-in-universe drop. Re-enablement protocol per §8.3 clause 1: a future
 * funding-active sweep that moves a parked symbol out of the §8 PARK streak
 * triggers spec amendment to re-include the symbol.
 */
export const SKIP_PARKED_4H_R9 = 'parked — failed §8 4H r9';

// ── Filter thresholds (TRA-255 §5) ─────────────────────────────────────────

/**
 * Funding-rate gate (filter 1). A funding rate ≤ this threshold (per-hour,
 * negative-meaning-shorts-pay) means the carry cost on the short is already
 * elevated AND a squeeze is likelier — pulling the trigger here is paying to
 * ride against the crowd. Threshold sourced from TRA-255 §5; tuned with the
 * funding flip stop in §7 (which exits an open short on three consecutive
 * intervals at this level).
 */
export const FUNDING_GATE_THRESHOLD_PER_HOUR = -0.0005; // -0.05%/h

/**
 * Spread gate (filter 3). Spread is `(ask - bid) / mid`. Above 10 bps the
 * round-trip cost on a short eats most of the expected edge per TRA-255 §5,
 * and getting filled at all on a market exit becomes uncertain.
 */
export const SPREAD_GATE_FRACTION = 0.001; // 0.10% of mid

/**
 * Open-interest gate (filter 4). 24h OI in USD; below this perp depth is
 * thin enough that liquidations cluster (the strategy's edge inverts in
 * thin tape). $25M is the TRA-255 §5 starting threshold.
 */
export const OI_GATE_USD = 25_000_000;

// ── Sizing & caps (TRA-255 §6) ─────────────────────────────────────────────

/**
 * Per-trade risk fractions for shorts (Momentum / Breakout). Halved relative
 * to the long-side 1% baseline, with Tier-2 (DOGE) further halved to 0.30%
 * to cover the thinner book.
 */
export const PERP_SHORT_RISK_TIER1 = 0.005; // 0.50% of strategy equity
export const PERP_SHORT_RISK_TIER2 = 0.003; // 0.30% of strategy equity

/**
 * Resolve the per-trade risk fraction for a short signal on `symbol`.
 * Returns the Tier-2 fraction for DOGE (and any future Tier-2 additions),
 * Tier-1 otherwise. Long signals never hit this path.
 */
export function perpShortRiskFraction(symbol: string): number {
  return isTier2PerpShort(symbol) ? PERP_SHORT_RISK_TIER2 : PERP_SHORT_RISK_TIER1;
}

/**
 * Single-symbol cap on shorts opened by ONE strategy: 15% of that strategy's
 * managed equity. Prevents a single-symbol short from dominating a single
 * strategy's risk budget even when the per-trade sizing comes in light.
 *
 * Default only — the live preset can override this per-user via
 * `AccountSettings.liveSingleSymbolShortCap`. {@link resolveSingleSymbolShortCap}
 * clamps the override to a sane band before the cap is applied.
 */
export const PERP_SHORT_SINGLE_SYMBOL_CAP = 0.15;

/**
 * Upper bound for the operator-tunable single-symbol cap (TRA-341). 1.0 ↔
 * "single-symbol shorts may consume the entire strategy slice" — anything
 * above that is meaningless under 1× isolated leverage and would let the gate
 * silently no-op. The cross-strategy and total caps still apply downstream so
 * a 1.0 setting doesn't mean "unlimited shorts on one symbol".
 */
export const PERP_SHORT_SINGLE_SYMBOL_CAP_MAX = 1.0;

/**
 * Resolve the active single-symbol cap from an optional operator override.
 * Returns the spec default when the override is undefined, ≤ 0, or non-finite,
 * and clamps positive values to {@link PERP_SHORT_SINGLE_SYMBOL_CAP_MAX} so a
 * fat-finger entry can't disable the gate by accident.
 */
export function resolveSingleSymbolShortCap(override: number | undefined): number {
  if (override === undefined || !Number.isFinite(override) || override <= 0) {
    return PERP_SHORT_SINGLE_SYMBOL_CAP;
  }
  return Math.min(override, PERP_SHORT_SINGLE_SYMBOL_CAP_MAX);
}

/**
 * Cross-strategy cap on shorts opened across all strategies on the SAME
 * symbol: 20% of total account equity. Tighter than naively summing the
 * 15% per-strategy cap so two strategies firing concurrently don't stack
 * to 30% on one ticker.
 */
export const PERP_SHORT_CROSS_STRATEGY_CAP = 0.20;

/**
 * Total short notional ceiling: 30% of total account equity, summed across
 * every open short position. Checked **before** order submit so a fresh
 * signal that would push us over the line is dropped with the cap reason
 * instead of the broker eating the order.
 */
export const PERP_SHORT_TOTAL_NOTIONAL_CAP = 0.30;

// ── Lifecycle thresholds (TRA-255 §7) ──────────────────────────────────────

/**
 * Funding flip stop trigger: three consecutive funding intervals (Coinbase
 * settles every ~8h, so ~24h total) of funding rate ≤ -0.05%/h. The carry
 * has flipped against the short — exit before the next settlement bills us.
 */
export const FUNDING_FLIP_INTERVALS = 3;

/**
 * Adverse vol expansion exit (Momentum shorts only): ATR(14) +50% over
 * 5 bars while the position is at break-even or worse → exit at market.
 */
export const VOL_EXPANSION_ATR_RATIO = 1.5;
export const VOL_EXPANSION_BAR_LOOKBACK = 5;

/**
 * Daily short circuit breaker: realised + unrealised short P&L for the day
 * ≤ -2% of total equity → halt new short entries until UTC day rollover.
 * Held shorts are NOT auto-flatted (spec §7).
 */
export const DAILY_SHORT_CIRCUIT_BREAKER_PCT = -0.02;

// ── Book caps & cooldown (TRA-255 §3.1 / §6) ──────────────────────────────

/**
 * Maximum number of open short positions across all strategies and symbols.
 * Spec §6 final row. Checked before order submit by `evaluateShortBookCaps`;
 * the user sees the candidate signal on the dashboard with `signalSkipReason`
 * stamped to `SKIP_MAX_CONCURRENT_SHORTS` when this trips.
 */
export const MAX_CONCURRENT_SHORTS = 3;

/**
 * Per-symbol consecutive-loss threshold before the cooldown engages. Three
 * back-to-back closed-at-loss shorts on the same symbol → cooldown for
 * `CONSECUTIVE_LOSS_COOLDOWN_MS`. Resets on the first non-loss close. Spec
 * §3.1 — first-pass values, revisit after Phase-1 walk-forward.
 */
export const CONSECUTIVE_LOSS_THRESHOLD = 3;

/**
 * Per-symbol cooldown window after the consecutive-loss threshold trips.
 * 48h wall-clock per spec §3.1. Other symbols are unaffected; held positions
 * are not auto-flatted.
 */
export const CONSECUTIVE_LOSS_COOLDOWN_MS = 48 * 60 * 60 * 1000;

// ── Filter pipeline ────────────────────────────────────────────────────────

/**
 * Inputs needed to evaluate the short filters for one signal. The strategy
 * layer doesn't know how to fetch funding/OI/spread/regime itself — the
 * caller (engine) supplies whatever it has. Each input is optional so the
 * pipeline degrades gracefully when a particular data source isn't yet
 * wired (e.g. OI: TRA-255 §5 explicitly allows skipping the OI gate with
 * a TODO if the data feed isn't ready).
 */
export interface ShortFilterContext {
  /**
   * Coinbase perp `funding_rate` for the product, expressed per-hour as a
   * fraction (e.g. -0.0006 means -0.06%/h). Negative = shorts pay longs.
   * Undefined = funding gate is skipped (data feed not yet wired); log
   * once at the call site so an outage isn't silent.
   */
  fundingRatePerHour?: number;
  /**
   * Active regime label for `BTC-USD`. The alt-only filter blocks alt
   * shorts when BTC is in `trend_up`. Undefined = filter is skipped (e.g.
   * BTC has insufficient bars for the regime detector). Always undefined
   * when `signal.symbol === 'BTC-USD'` — BTC shorts skip this gate by spec.
   */
  btcRegime?: Regime;
  /**
   * TRA-255 §4.4 r5 (2026-05-03) Layer 2 — BTC alt-overlay softening.
   *
   * `true` = BTC's daily MA200 slope is positive over the last 5 daily bars
   *          (i.e. a "real" uptrend). The alt-overlay block stays in effect.
   * `false` = the regime is labelled `trend_up` but the daily MA200 slope is
   *           **not** positive over 5 daily bars (a regime-detector hiccup,
   *           not a sustained uptrend). The alt-overlay block is **skipped**.
   * `undefined` = caller did not supply the slope diagnostic. The alt-overlay
   *               block applies whenever `btcRegime === 'trend_up'` (original
   *               r1-r4 behaviour). Backwards-compatible default.
   *
   * Skip-reason string is unchanged on a failing gate per spec.
   */
  btcDailyMa200SlopePositiveOver5DailyBars?: boolean;
  /**
   * Live order-book spread as a fraction of mid: `(ask - bid) / mid`. The
   * spot-spread guard (TRA-243) feeds the same value with a different
   * threshold; perp routing retunes to 10 bps per spec §5.
   */
  spreadFraction?: number;
  /**
   * 24h open interest in USD for the perp product. Undefined = OI gate is
   * skipped (data feed not yet wired — see TRA-255 §5 explicit allowance
   * and the data-feed follow-up issue).
   */
  openInterestUsd?: number;
}

/**
 * Run the multiplicative short filters from TRA-255 §5 in declaration order.
 * Returns the first failing skip-reason string, or `null` if all gates pass.
 *
 * Strict ordering:
 *   1. Funding rate
 *   2. BTC regime (alts only)
 *   3. Spread
 *   4. OI
 *
 * The order matches the spec doc and is asserted by the unit tests so a
 * later refactor doesn't accidentally re-arrange the priority. If two gates
 * would fail simultaneously, the user sees the higher-priority reason —
 * funding-driven squeezes are a more specific actionable diagnosis than a
 * thin-OI generic "no perp", for example.
 *
 * The pipeline is "best-effort": missing inputs (undefined) skip the
 * corresponding gate. The engine is responsible for logging when an input
 * goes missing so a silent data-feed outage isn't masked as "all gates
 * passed".
 */
export function evaluateShortFilters(
  signal: TradeSignal,
  ctx: ShortFilterContext,
): string | null {
  if (signal.side !== 'sell') return null;

  if (
    ctx.fundingRatePerHour !== undefined
    && Number.isFinite(ctx.fundingRatePerHour)
    && ctx.fundingRatePerHour <= FUNDING_GATE_THRESHOLD_PER_HOUR
  ) {
    return SKIP_FUNDING_TOO_NEGATIVE;
  }

  if (
    isAltSymbol(signal.symbol)
    && ctx.btcRegime === 'trend_up'
    // §4.4 r5 Layer 2 softening: a `trend_up` label without a positive daily
    // MA200 slope over 5 daily bars is a regime-detector hiccup, not a real
    // uptrend — let the alt short through. Undefined preserves r1-r4 behaviour.
    && ctx.btcDailyMa200SlopePositiveOver5DailyBars !== false
  ) {
    return SKIP_BTC_TREND_UP;
  }

  if (
    ctx.spreadFraction !== undefined
    && Number.isFinite(ctx.spreadFraction)
    && ctx.spreadFraction > SPREAD_GATE_FRACTION
  ) {
    return SKIP_SPREAD_TOO_WIDE;
  }

  if (
    ctx.openInterestUsd !== undefined
    && Number.isFinite(ctx.openInterestUsd)
    && ctx.openInterestUsd < OI_GATE_USD
  ) {
    return SKIP_OI_UNDER_MIN;
  }

  return null;
}

// ── Notional caps (TRA-255 §6) ─────────────────────────────────────────────

/**
 * Inputs to `evaluateShortNotionalCaps`. All notionals in USD. Notionals are
 * computed by the caller (engine) since open-position bookkeeping lives
 * across both the demo paper account and the live Coinbase account.
 */
export interface ShortNotionalCapInputs {
  /** Total account equity (combined cash + position notionals + unrealised P&L). */
  totalEquityUsd: number;
  /** Equity slice the originating strategy is allowed to manage. */
  strategyEquityUsd: number;
  /** Notional of THIS pending short (entry × qty). */
  candidateShortNotionalUsd: number;
  /** Sum of open short notional, this strategy + this symbol. */
  openShortsThisStrategyThisSymbolUsd: number;
  /** Sum of open short notional, all strategies + this symbol. */
  openShortsAllStrategiesThisSymbolUsd: number;
  /** Sum of open short notional across the whole book (all strategies + symbols). */
  openShortsTotalUsd: number;
  /**
   * TRA-341 — operator-tunable override for the §6 single-symbol cap. Expressed
   * as a fraction of strategy equity (e.g. `0.25` ↔ 25%). Undefined ↔ use the
   * spec default {@link PERP_SHORT_SINGLE_SYMBOL_CAP} (0.15). The cross-strategy
   * (§6 row 2) and total-book (§6 row 3) caps are intentionally NOT overridable
   * here — they're whole-book risk ceilings, not per-strategy budgets, and
   * relaxing them is a code-and-spec change rather than an operator knob.
   *
   * Why a knob: on small live accounts (e.g. the TRA-324 $180 board) the
   * default 15% cap maps to a $27 per-symbol budget, which is below
   * MIN_NOTIONAL_USD on most pairs after the engine's own sizing — every
   * candidate fires `SKIP_SINGLE_SYMBOL_CAP` before the order ever reaches
   * Coinbase. Letting the user dial this up on the live preset unblocks the
   * test rig without loosening the global ceilings.
   *
   * Bounds: clamped to (0, 1] at use-time. A value ≤ 0 falls back to the
   * default rather than disabling shorts entirely; > 1 would let a single
   * short exceed strategy equity which 1× isolated leverage already prevents
   * upstream, but we still bound to 1.0 so the gate doesn't no-op silently.
   */
  singleSymbolCapOverride?: number;
}

/**
 * Verify the candidate short does not breach any of the §6 notional caps.
 * Returns the first breaching cap's skip-reason string, or `null` if all
 * caps pass. Caller stamps the returned reason on `signal.signalSkipReason`
 * and skips order submit.
 *
 * Order matches the spec table:
 *   1. Single-symbol cap (per-strategy, 15% strategy equity by default;
 *      operator-overridable via `inputs.singleSymbolCapOverride`).
 *   2. Cross-strategy per-symbol cap (20% total equity)
 *   3. Total short notional ceiling (30% total equity)
 */
export function evaluateShortNotionalCaps(inputs: ShortNotionalCapInputs): string | null {
  const {
    totalEquityUsd,
    strategyEquityUsd,
    candidateShortNotionalUsd,
    openShortsThisStrategyThisSymbolUsd,
    openShortsAllStrategiesThisSymbolUsd,
    openShortsTotalUsd,
    singleSymbolCapOverride,
  } = inputs;

  if (strategyEquityUsd > 0) {
    const singleSymbolCap = resolveSingleSymbolShortCap(singleSymbolCapOverride);
    const singleSymbolLimit = strategyEquityUsd * singleSymbolCap;
    if (openShortsThisStrategyThisSymbolUsd + candidateShortNotionalUsd > singleSymbolLimit) {
      return SKIP_SINGLE_SYMBOL_CAP;
    }
  }

  if (totalEquityUsd > 0) {
    const crossStrategyLimit = totalEquityUsd * PERP_SHORT_CROSS_STRATEGY_CAP;
    if (openShortsAllStrategiesThisSymbolUsd + candidateShortNotionalUsd > crossStrategyLimit) {
      return SKIP_CROSS_STRATEGY_CAP;
    }

    const totalLimit = totalEquityUsd * PERP_SHORT_TOTAL_NOTIONAL_CAP;
    if (openShortsTotalUsd + candidateShortNotionalUsd > totalLimit) {
      return SKIP_TOTAL_SHORT_NOTIONAL;
    }
  }

  return null;
}

// ── Book caps & cooldown gates (TRA-255 §3.1 / §6) ────────────────────────

/**
 * Inputs to {@link evaluateShortBookCaps}. The two book-wide pre-route gates
 * that aren't tied to a candidate's notional:
 *   1. Per-symbol consecutive-loss cooldown (§3.1).
 *   2. Whole-book max-concurrent-shorts count (§6).
 *
 * The caller (engine) owns the bookkeeping for both — this helper just
 * inspects the supplied state. Keeping the gates state-free here means the
 * same helper drives both the live-broker path and the demo path without
 * either side having to grow new dependencies.
 */
export interface ShortBookCapInputs {
  /**
   * Number of currently-open short positions across all strategies and
   * symbols. Counted right before order submit.
   */
  openShortCount: number;
  /**
   * `true` iff this signal's symbol is currently inside the §3.1 cooldown
   * window (3 consecutive closed-at-loss shorts on this symbol within the
   * last `CONSECUTIVE_LOSS_COOLDOWN_MS`). Caller resolves this from its
   * own per-symbol short-loss bookkeeping; the helper deliberately does
   * not own that state because closed-position history lives in the demo
   * paper account / live broker reconciler, not the strategy layer.
   */
  symbolCooldownActive: boolean;
}

/**
 * Run the book-wide pre-route caps from TRA-255 §3.1 / §6. Returns the
 * first failing skip reason, or `null` when both gates pass. Order:
 *
 *   1. Per-symbol cooldown — diagnoses the more specific suppression first.
 *      A symbol-cooldown skip is recoverable on the next signal once the
 *      cooldown elapses; the count cap is a book-state issue that affects
 *      every fresh signal until something closes.
 *   2. Max-concurrent-shorts count.
 *
 * Live signals carrying `side !== 'sell'` short-circuit to null so the
 * helper can be called unconditionally on every candidate without leaking
 * cap logic into long routing.
 */
export function evaluateShortBookCaps(
  signal: TradeSignal,
  inputs: ShortBookCapInputs,
): string | null {
  if (signal.side !== 'sell') return null;
  if (inputs.symbolCooldownActive) return SKIP_CONSECUTIVE_LOSSES;
  if (inputs.openShortCount >= MAX_CONCURRENT_SHORTS) return SKIP_MAX_CONCURRENT_SHORTS;
  return null;
}

/**
 * Closed-short trade record fed to {@link symbolShortCooldownActive}. The
 * caller passes whatever subset of its closed-position history it has —
 * we only inspect entries on the matching symbol and only the `side === 'sell'`
 * ones, so passing the full closed-positions list is fine (a long close is
 * silently ignored).
 */
export interface ClosedShortTrade {
  symbol: string;
  /** P&L in USD on the close. Negative = loss. */
  pnlUsd: number;
  /** Wall-clock close time (ms since epoch). */
  closedAt: number;
  /** Trade side. Long entries are skipped by the cooldown logic. */
  side: 'buy' | 'sell';
}

/**
 * Determine whether `symbol` is currently inside the §3.1 short cooldown:
 * the last `CONSECUTIVE_LOSS_THRESHOLD` consecutive closed shorts on that
 * symbol were all losses, AND the most recent of those losses is within
 * `CONSECUTIVE_LOSS_COOLDOWN_MS` of `nowMs`.
 *
 * A non-loss close (any short with `pnlUsd >= 0`) breaks the streak — the
 * symbol exits the cooldown immediately even if there was an earlier
 * 3-loss run, mirroring the spec's "consecutive" wording. Long closes on
 * the same symbol are ignored entirely (the cooldown is short-specific).
 */
export function symbolShortCooldownActive(
  symbol: string,
  closedTrades: readonly ClosedShortTrade[],
  nowMs: number,
): boolean {
  // Walk most-recent-first so the consecutive-loss streak is read from the
  // present back into history.
  const ordered = [...closedTrades].sort((a, b) => b.closedAt - a.closedAt);
  let consecutiveLosses = 0;
  let mostRecentLossAt: number | null = null;
  for (const t of ordered) {
    if (t.symbol !== symbol) continue;
    if (t.side !== 'sell') continue;
    if (t.pnlUsd < 0) {
      consecutiveLosses++;
      if (mostRecentLossAt === null) mostRecentLossAt = t.closedAt;
      if (consecutiveLosses >= CONSECUTIVE_LOSS_THRESHOLD) {
        if (mostRecentLossAt === null) return false;
        return nowMs - mostRecentLossAt <= CONSECUTIVE_LOSS_COOLDOWN_MS;
      }
    } else {
      // Non-loss close breaks the streak per the spec's "consecutive" rule.
      return false;
    }
  }
  return false;
}

// ── Lifecycle helpers (TRA-255 §7) ────────────────────────────────────────

/**
 * Funding flip stop: returns true iff the last `FUNDING_FLIP_INTERVALS`
 * consecutive funding rates (per-hour, most-recent last) are all
 * ≤ FUNDING_GATE_THRESHOLD_PER_HOUR. Caller passes whatever buffer of
 * funding intervals it has; we only inspect the tail.
 *
 * Coinbase perps settle funding ~every 8h, so 3 intervals ≈ 24h — long
 * enough to confirm a real flip, short enough to exit before the carry
 * cost compounds another full day.
 */
export function fundingFlipStopTriggered(fundingHistoryPerHour: readonly number[]): boolean {
  if (fundingHistoryPerHour.length < FUNDING_FLIP_INTERVALS) return false;
  const tail = fundingHistoryPerHour.slice(-FUNDING_FLIP_INTERVALS);
  return tail.every((r) => Number.isFinite(r) && r <= FUNDING_GATE_THRESHOLD_PER_HOUR);
}

/**
 * Adverse vol expansion exit (Momentum shorts only). Returns true iff
 * current ATR is ≥ `VOL_EXPANSION_ATR_RATIO ×` the ATR `VOL_EXPANSION_BAR_LOOKBACK`
 * bars ago AND the position is at break-even or worse. Caller is
 * responsible for restricting this to Momentum shorts (the runner already
 * walks each open position and knows the strategy type).
 *
 * The break-even predicate is "unrealised P&L ≤ 0" — for a short that
 * means current price ≥ entry. A position already in profit is allowed to
 * ride through a vol spike per spec §7.
 */
export function adverseVolExpansionShortExitTriggered(args: {
  currentAtr: number;
  atrLookbackBarsAgo: number;
  currentPrice: number;
  entryPrice: number;
}): boolean {
  const { currentAtr, atrLookbackBarsAgo, currentPrice, entryPrice } = args;
  if (!Number.isFinite(currentAtr) || currentAtr <= 0) return false;
  if (!Number.isFinite(atrLookbackBarsAgo) || atrLookbackBarsAgo <= 0) return false;
  const expanded = currentAtr >= atrLookbackBarsAgo * VOL_EXPANSION_ATR_RATIO;
  if (!expanded) return false;
  // Short P&L ≤ 0 ⇔ currentPrice ≥ entryPrice (we owe at least as much as
  // we sold for). Equality is "break-even" per spec wording.
  const breakEvenOrWorse = currentPrice >= entryPrice;
  return breakEvenOrWorse;
}

/**
 * Daily short circuit breaker: returns true iff the day's combined
 * realised + unrealised short P&L is ≤ -2% of total equity. When tripped,
 * the engine halts NEW short entries (held shorts are not auto-flatted)
 * until UTC day rollover.
 */
export function dailyShortCircuitBreakerTripped(args: {
  shortPnlTodayUsd: number;
  totalEquityUsd: number;
}): boolean {
  const { shortPnlTodayUsd, totalEquityUsd } = args;
  if (totalEquityUsd <= 0) return false;
  const drawdownFraction = shortPnlTodayUsd / totalEquityUsd;
  return drawdownFraction <= DAILY_SHORT_CIRCUIT_BREAKER_PCT;
}
