import { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';

/**
 * TRA-821 (TRA-817 workstream C) — `tsmom_majors` time-series-momentum candidate.
 *
 * Implements the frozen QuantTrader spec from the TRA-817 plan. The design,
 * params, universe and gate methodology are FIXED — this module adds no tunables
 * beyond the four below and no universe logic (the universe is enforced by the
 * caller / validation harness, not here).
 *
 * Mechanics:
 *   • Universe BTC-USD / ETH-USD / SOL-USD only, **daily** bars, **long-or-flat**
 *     (never shorts, never leverages — sizing is the VolKellySizer's job).
 *   • Signal: trailing L-day total return `r_L = close_t / close_{t-L} − 1`.
 *   • Enter long when `r_L >= +entryBandPct`; exit to flat when
 *     `r_L <= -exitBandPct`. The gap between the two bands is a hysteresis
 *     dead-zone that governs turnover (you hold through it rather than churn).
 *
 * Sizing is NOT decided here. The runner enables the existing `VolKellySizer`
 * for this strategy and feeds it `volTargetAnnualPct` as the annual vol anchor;
 * the per-trade risk fraction is vol-targeted (calm asset → larger fraction),
 * clamped to [0.5%, 1.75%], and Kelly-capped off the *validated OOS* net
 * expectancy (never in-sample). To turn that risk fraction into a quantity the
 * runner's `RiskManager.sizeFromStop` needs a stop distance, so the entry signal
 * carries a **sizing-only** protective stop one daily vol-target σ below entry
 * ({@link tsmomSizingStopFraction}). That stop is a risk-unit ("1R = one
 * daily-target-σ move"), NOT a real exit — the runner does not arm a bracket for
 * `tsmom_majors`; the only exit is the band cross ({@link tsmomExitToFlat}). The
 * far take-profit is an unused placeholder for the same reason.
 *
 * Pure & deterministic apart from the signal `id` (randomUUID, like every other
 * strategy): {@link evaluateTsmomMajors} and {@link tsmomExitToFlat} are golden-
 * fixture testable.
 */

export interface TsmomMajorsParams {
  /** Trailing total-return lookback in **daily** bars (`L`). Default 100. */
  lookbackDays?: number;
  /** Long-entry band: enter when `r_L >= entryBandPct/100`. Percent. Default 0. */
  entryBandPct?: number;
  /** Flat-exit band: exit when `r_L <= -exitBandPct/100`. Percent. Default 0. */
  exitBandPct?: number;
  /** Annualised volatility target (percent) — the VolKellySizer vol anchor. Default 60. */
  volTargetAnnualPct?: number;
}

export interface ResolvedTsmomMajorsParams {
  lookbackDays: number;
  entryBandPct: number;
  exitBandPct: number;
  volTargetAnnualPct: number;
}

/** Crypto trades every calendar day — annualise daily vol with √365, not √252. */
export const TSMOM_BARS_PER_YEAR = 365;

export function resolveTsmomMajorsParams(p: TsmomMajorsParams = {}): ResolvedTsmomMajorsParams {
  return {
    lookbackDays: p.lookbackDays ?? 100,
    entryBandPct: p.entryBandPct ?? 0,
    exitBandPct: p.exitBandPct ?? 0,
    volTargetAnnualPct: p.volTargetAnnualPct ?? 60,
  };
}

/**
 * Trailing L-day total return `close_t / close_{t-L} − 1`. Returns `null` when
 * there are not yet `L + 1` closes (so the very first L bars never fire). Pure.
 */
export function trailingTotalReturn(closes: readonly number[], lookbackDays: number): number | null {
  const L = Math.max(1, Math.floor(lookbackDays));
  if (closes.length < L + 1) return null;
  const cNow = closes[closes.length - 1];
  const cThen = closes[closes.length - 1 - L];
  if (!(cNow > 0) || !(cThen > 0)) return null;
  return cNow / cThen - 1;
}

/**
 * Sizing-only protective-stop distance as a fraction of entry: one **daily**
 * vol-target σ, i.e. `(volTargetAnnualPct/100) / √365`. This is the strategy's
 * 1R risk unit; the asset's *realised* vol enters only through the
 * VolKellySizer's risk fraction, so vol is never double-counted. Deliberately
 * constant per-config (not realised-vol-driven) for that reason.
 */
export function tsmomSizingStopFraction(volTargetAnnualPct: number): number {
  const annual = volTargetAnnualPct / 100;
  return annual / Math.sqrt(TSMOM_BARS_PER_YEAR);
}

/**
 * Should an open long exit to flat this bar? True when the trailing L-day total
 * return has crossed at or below `-exitBandPct/100`. Pure — the runner calls it
 * once per bar for any open `tsmom_majors` position.
 */
export function tsmomExitToFlat(candles: Candle[], params: TsmomMajorsParams = {}): boolean {
  const p = resolveTsmomMajorsParams(params);
  const rL = trailingTotalReturn(candles.map(c => c.close), p.lookbackDays);
  if (rL === null) return false;
  return rL <= -(p.exitBandPct / 100);
}

/**
 * Pure entry evaluation: emits a long `tsmom_majors` {@link TradeSignal} when the
 * trailing L-day return is at or above `+entryBandPct/100`, else `null`. The
 * runner's `alreadyOpen` guard keeps it long-or-flat (it drops repeat entries
 * while a position is open), so this can fire every bar the band condition holds.
 */
export function evaluateTsmomMajors(
  symbol: string,
  candles: Candle[],
  params: TsmomMajorsParams = {},
): TradeSignal | null {
  const p = resolveTsmomMajorsParams(params);
  const closes = candles.map(c => c.close);
  const rL = trailingTotalReturn(closes, p.lookbackDays);
  if (rL === null) return null;
  if (rL < p.entryBandPct / 100) return null;

  const latest = candles[candles.length - 1];
  const entryPrice = latest.close;
  if (!(entryPrice > 0)) return null;

  // Sizing-only stop (see module doc): one daily vol-target σ below entry. The
  // runner does NOT arm a bracket for tsmom_majors, so this never exits a trade —
  // it only sets the 1R denominator the VolKellySizer's risk fraction divides by.
  const stopFrac = tsmomSizingStopFraction(p.volTargetAnnualPct);
  const stopLoss = entryPrice * (1 - stopFrac);
  // Unused placeholder target (kept valid/far so any defensive bracket math is a
  // no-op). The only real exit is the band cross via tsmomExitToFlat.
  const takeProfit = entryPrice * (1 + stopFrac * 1000);

  return {
    id: randomUUID(),
    symbol,
    type: 'tsmom_majors',
    side: 'buy',
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: 1000,
    timestamp: latest.timestamp,
  };
}

/**
 * Strategy wrapper for router / runner compatibility — mirrors the other
 * strategies' `(symbol, candles)` shape. Stateless: the long-or-flat invariant is
 * enforced by the runner's open-position guard, not internal state.
 */
export class TsmomMajorsStrategy {
  private readonly params: TsmomMajorsParams;

  constructor(params: TsmomMajorsParams = {}) {
    this.params = params;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    return evaluateTsmomMajors(symbol, candles, this.params);
  }

  /** Should an open long for this strategy exit to flat this bar? */
  shouldExitToFlat(candles: Candle[]): boolean {
    return tsmomExitToFlat(candles, this.params);
  }
}
