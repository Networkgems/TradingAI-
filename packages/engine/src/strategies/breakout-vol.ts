import type { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { atr } from '../indicators/atr.js';
import { classifyRegime, type Regime, type RegimeDetectorOptions } from '../regime.js';

export interface BreakoutVolOptions {
  /** Bars of consolidation inspected for the channel + volume baseline. Spec §4 default: 20. */
  consolidationBars?: number;
  /**
   * Maximum consolidation range as a fraction of latest close. The spec §4
   * starting value is 6%; flagged TBD pending walk-forward. A tighter range
   * means a cleaner coil, so the breakout is more likely to be a real
   * volatility expansion rather than mid-trend noise.
   */
  maxRangeFraction?: number;
  /**
   * Entry-bar volume multiplier vs. the consolidation-window SMA. Spec §4
   * default: 2.0. The volume confirmation is the load-bearing filter — a
   * breakout-without-volume tends to be a false break that snaps back.
   */
  volumeMultiplier?: number;
  /** ATR lookback for stop/target sizing. Spec §4 default: 14. */
  atrPeriod?: number;
  /** Hard-stop distance = `atrStopMultiplier × ATR`. Spec §4 default: 2.0. */
  atrStopMultiplier?: number;
  /** Take-profit distance = `atrTpMultiplier × ATR`. Spec §4 default: 4.0 → 2:1 R:R. */
  atrTpMultiplier?: number;
  /**
   * Optional override for the internal `classifyRegime` call. Only used when
   * the caller does not pass a `regime` to `evaluate()` (i.e. self-contained
   * usage / unit tests). Router-driven flow with a stateful `RegimeDetector`
   * supplies the active label and ignores this.
   */
  regimeOptions?: RegimeDetectorOptions;
}

/**
 * Breakout / volatility-expansion strategy (TRA-207, B8 in TRA-197 spec §4).
 *
 * Entry premise: price has been coiling in a tight range (consolidation) and
 * just printed a breakout candle with abnormally high volume. The
 * volume-confirmation filter is what separates a real expansion from the
 * "Donchian fakeout" that mean-reverts within a couple of bars.
 *
 * Regime gate (per spec §4):
 *   - `high_vol` is the canonical home for this strategy.
 *   - `flat` is also allowed: the spec specifically wants to catch the
 *     `flat → high_vol` transition bar where the expansion fires *as* the
 *     regime detector is still hysteresis-confirming. The runner is responsible
 *     for closing-at-market if `high_vol` is not confirmed within 2 bars
 *     (spec §4 lifecycle); the strategy's job is just to fire on the edge.
 *   - `trend_up`, `trend_down`, `range` → bail. Those are momentum / mean-rev
 *     territory; firing breakout there pollutes the strategy's edge with
 *     setups that already have a better-fit owner.
 *
 * Trigger:
 *   - Long  — close strictly above the consolidation high (max(high) over the
 *     prior `consolidationBars`, current bar excluded) AND current-bar volume
 *     ≥ `volumeMultiplier × SMA(volume, consolidationBars)` over the same
 *     window AND consolidation range / close < `maxRangeFraction`.
 *   - Short — mirror image on the consolidation low.
 *
 * Risk:
 *   - Hard stop = `atrStopMultiplier × ATR(atrPeriod)`.
 *   - Take-profit = `atrTpMultiplier × ATR(atrPeriod)`.
 *   - Trailing (BE after +2·ATR, then 2·ATR trail) and the 15-bar time stop
 *     from spec §4 are runner / position-manager responsibilities — see the
 *     same split-of-concerns used by `MomentumStrategy` and
 *     `MeanReversionCryptoStrategy`. `evaluate()` only emits the entry.
 */
export class BreakoutVolStrategy {
  private readonly consolidationBars: number;
  private readonly maxRangeFraction: number;
  private readonly volumeMultiplier: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;
  private readonly atrTpMultiplier: number;
  private readonly regimeOptions?: RegimeDetectorOptions;

  constructor(opts: BreakoutVolOptions = {}) {
    this.consolidationBars = opts.consolidationBars ?? 20;
    this.maxRangeFraction = opts.maxRangeFraction ?? 0.06;
    this.volumeMultiplier = opts.volumeMultiplier ?? 2.0;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.atrStopMultiplier = opts.atrStopMultiplier ?? 2.0;
    this.atrTpMultiplier = opts.atrTpMultiplier ?? 4.0;
    this.regimeOptions = opts.regimeOptions;
  }

  evaluate(symbol: string, candles: Candle[], regime?: Regime): TradeSignal | null {
    const minBars = Math.max(
      // Need the consolidation window prior to the entry bar, plus the entry bar itself.
      this.consolidationBars + 1,
      this.atrPeriod + 1,
      // classifyRegime walks a 50-bar EMA, so the auto-classify path needs ≥50 bars.
      50,
    );
    if (candles.length < minBars) return null;

    const effectiveRegime = regime ?? classifyRegime(candles, this.regimeOptions ?? {});
    // Spec §4: high_vol is the canonical home; flat is allowed for the
    // flat → high_vol transition bar. trend_up/trend_down/range are owned by
    // momentum / mean-rev and would dilute this strategy's edge.
    if (effectiveRegime !== 'high_vol' && effectiveRegime !== 'flat') return null;

    const latest = candles[candles.length - 1];
    const windowStart = candles.length - 1 - this.consolidationBars;
    const window = candles.slice(windowStart, candles.length - 1);

    let consolidationHigh = -Infinity;
    let consolidationLow = Infinity;
    let volumeSum = 0;
    for (const c of window) {
      if (c.high > consolidationHigh) consolidationHigh = c.high;
      if (c.low < consolidationLow) consolidationLow = c.low;
      volumeSum += c.volume;
    }
    if (!Number.isFinite(consolidationHigh) || !Number.isFinite(consolidationLow)) return null;

    const close = latest.close;
    if (close <= 0) return null;

    // Consolidation tightness gate. A wide "range" isn't actually a coil —
    // it's mid-trend noise, and the breakout edge degrades sharply.
    const rangeFraction = (consolidationHigh - consolidationLow) / close;
    if (!Number.isFinite(rangeFraction) || rangeFraction >= this.maxRangeFraction) return null;

    const volumeSma = volumeSum / window.length;
    // Zero-volume windows can come from sparse/missing data — refuse rather
    // than dividing through and emitting a phantom signal.
    if (!(volumeSma > 0)) return null;
    const volumeOk = latest.volume >= this.volumeMultiplier * volumeSma;
    if (!volumeOk) return null;

    const atrValue = atr(candles, this.atrPeriod);
    if (atrValue === null || atrValue <= 0) return null;

    const stopDistance = this.atrStopMultiplier * atrValue;
    const tpDistance = this.atrTpMultiplier * atrValue;
    if (stopDistance <= 0 || tpDistance <= 0) return null;

    const breakoutLong = close > consolidationHigh;
    const breakoutShort = close < consolidationLow;
    if (!breakoutLong && !breakoutShort) return null;

    const side = breakoutLong ? 'buy' : 'sell';
    const stopLoss = side === 'buy' ? close - stopDistance : close + stopDistance;
    const takeProfit = side === 'buy' ? close + tpDistance : close - tpDistance;

    return {
      id: randomUUID(),
      symbol,
      type: 'breakout_vol',
      side,
      entryPrice: close,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
      timestamp: latest.timestamp,
    };
  }
}
