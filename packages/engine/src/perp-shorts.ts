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
 */
export const PERP_SHORT_SINGLE_SYMBOL_CAP = 0.15;

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
}

/**
 * Verify the candidate short does not breach any of the §6 notional caps.
 * Returns the first breaching cap's skip-reason string, or `null` if all
 * caps pass. Caller stamps the returned reason on `signal.signalSkipReason`
 * and skips order submit.
 *
 * Order matches the spec table:
 *   1. Single-symbol cap (per-strategy, 15% strategy equity)
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
  } = inputs;

  if (strategyEquityUsd > 0) {
    const singleSymbolLimit = strategyEquityUsd * PERP_SHORT_SINGLE_SYMBOL_CAP;
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
