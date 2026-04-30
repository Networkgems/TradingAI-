import type { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { bollinger } from '../indicators/bollinger.js';
import { rsi } from '../indicators/rsi.js';
import { atr } from '../indicators/atr.js';
import { classifyRegime, type Regime, type RegimeDetectorOptions } from '../regime.js';

export interface MeanReversionCryptoOptions {
  /** Bollinger Band period. Spec §3 default: 20. */
  bbPeriod?: number;
  /** Bollinger Band stdev multiplier. Spec §3 default: 2.0. */
  bbMultiplier?: number;
  /** RSI period. Spec §3 default: 14. */
  rsiPeriod?: number;
  /** RSI long-entry threshold (oversold). Spec §3 default: 25. */
  rsiOversold?: number;
  /** RSI short-entry threshold (overbought). Spec §3 default: 75. */
  rsiOverbought?: number;
  /** ATR period for stop sizing. Spec §3 default: 14. */
  atrPeriod?: number;
  /** Hard-stop distance multiplier on ATR. Spec §3 default: 1.5. */
  atrStopMultiplier?: number;
  /**
   * Optional override for the internal `classifyRegime` call. Only used when
   * the caller does not pass a `regime` to `evaluate()` (i.e. self-contained
   * usage / unit tests). When the strategy router supplies the regime label
   * from a stateful `RegimeDetector`, these options are ignored.
   */
  regimeOptions?: RegimeDetectorOptions;
}

/**
 * Mean-reversion crypto strategy (TRA-206) — RSI extremes + Bollinger Band
 * reversion, hard-gated to the `range` regime.
 *
 * Spec: TRA-197 spec §3. The regime gate is non-negotiable — mean reversion
 * fired in a trend is the textbook way this stack blows up, so any non-`range`
 * label (`trend_up`, `trend_down`, `high_vol`, `flat`) is an immediate bail.
 *
 * Entry (both sides):
 *   Long  — RSI(14) < 25  AND close < lower BB(20, 2.0)
 *   Short — RSI(14) > 75  AND close > upper BB(20, 2.0)
 * Both indicator conditions must agree on the same closed bar.
 *
 * Stops/targets:
 *   Hard stop  = entry ± 1.5 × ATR(14)  (spec §3 / §5)
 *   Take profit = BB middle (SMA20) — the canonical mean-reversion exit. The
 *     RSI-re-crosses-50 alternate exit lives in the position manager / runner
 *     because it requires bar-by-bar tracking after entry.
 *
 * The 10-bar time stop and bar-by-bar trailing logic from spec §3/§5 are
 * intentionally NOT in this entry-signal class. Like the other strategies in
 * this package, `evaluate()` only emits the entry; lifecycle management
 * (time stop, target re-evaluation, bracket fills) is the runner/position
 * manager's job — keeps strategies stateless and replay-safe in backtests.
 */
export class MeanReversionCryptoStrategy {
  private readonly bbPeriod: number;
  private readonly bbMultiplier: number;
  private readonly rsiPeriod: number;
  private readonly rsiOversold: number;
  private readonly rsiOverbought: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;
  private readonly regimeOptions?: RegimeDetectorOptions;

  constructor(opts: MeanReversionCryptoOptions = {}) {
    this.bbPeriod = opts.bbPeriod ?? 20;
    this.bbMultiplier = opts.bbMultiplier ?? 2.0;
    this.rsiPeriod = opts.rsiPeriod ?? 14;
    this.rsiOversold = opts.rsiOversold ?? 25;
    this.rsiOverbought = opts.rsiOverbought ?? 75;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.atrStopMultiplier = opts.atrStopMultiplier ?? 1.5;
    this.regimeOptions = opts.regimeOptions;
  }

  /**
   * Evaluate the latest bar and return a TradeSignal if the entry rules fire.
   *
   * The router (TRA-208) drives a stateful `RegimeDetector` and passes the
   * active label as `regime`. When called without a label (tests, ad-hoc
   * use), we classify the current bar from `candles` and apply the same gate
   * — note this skips hysteresis, so router-driven flow is preferred in live.
   */
  evaluate(symbol: string, candles: Candle[], regime?: Regime): TradeSignal | null {
    // Need enough bars for BB, RSI, ATR, and the 50-bar EMA used by the
    // regime classifier. Pick the deepest requirement.
    const minBars = Math.max(this.bbPeriod, this.rsiPeriod + 1, this.atrPeriod + 1, 50);
    if (candles.length < minBars) return null;

    const effectiveRegime = regime ?? classifyRegime(candles, this.regimeOptions ?? {});
    if (effectiveRegime !== 'range') return null;

    const closes = candles.map((c) => c.close);
    const latest = candles[candles.length - 1];

    const bands = bollinger(closes, this.bbPeriod, this.bbMultiplier);
    if (!bands) return null;

    const currentRsi = rsi(closes, this.rsiPeriod);
    if (Number.isNaN(currentRsi)) return null;

    const atrValue = atr(candles, this.atrPeriod);
    if (atrValue === null || atrValue <= 0) return null;

    const entryPrice = latest.close;
    const stopDistance = atrValue * this.atrStopMultiplier;
    if (stopDistance <= 0) return null;

    // Long: oversold AND price closed below the lower band.
    if (currentRsi < this.rsiOversold && entryPrice < bands.lower) {
      const stopLoss = entryPrice - stopDistance;
      const takeProfit = bands.middle;
      const reward = takeProfit - entryPrice;
      // The mean-reversion premise is "price snaps back to the mean", so the
      // mean must be above us. If a wide BB plus a deep wick puts the middle
      // below entry, the trade isn't a reversion — skip.
      if (reward <= 0) return null;
      return {
        id: randomUUID(),
        symbol,
        type: 'mean_reversion',
        side: 'buy',
        entryPrice,
        stopLoss,
        takeProfit,
        riskRewardRatio: reward / stopDistance,
        timestamp: latest.timestamp,
      };
    }

    // Short: overbought AND price closed above the upper band.
    if (currentRsi > this.rsiOverbought && entryPrice > bands.upper) {
      const stopLoss = entryPrice + stopDistance;
      const takeProfit = bands.middle;
      const reward = entryPrice - takeProfit;
      if (reward <= 0) return null;
      return {
        id: randomUUID(),
        symbol,
        type: 'mean_reversion',
        side: 'sell',
        entryPrice,
        stopLoss,
        takeProfit,
        riskRewardRatio: reward / stopDistance,
        timestamp: latest.timestamp,
      };
    }

    return null;
  }
}
