import { Candle, TradeSignal } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ema } from '../indicators/ema.js';
import { atr } from '../indicators/atr.js';

export interface DcaOptions {
  /**
   * Trend-filter EMA period. Accumulation only fires when price is above this
   * EMA, so we DCA into strong/uptrending assets and pause through structural
   * downtrends (TRA-693 research: "above the 200-EMA = a buying opportunity").
   * Default 200.
   */
  trendEmaPeriod?: number;
  /**
   * When true (default) accumulation is gated to price > trend EMA. Set false
   * for unconditional periodic accumulation (classic time-only DCA).
   */
  requireUptrend?: boolean;
  /**
   * Minimum spacing between two accumulation buys for the same symbol, in
   * milliseconds. This is the "fixed interval" of dollar-cost averaging — the
   * engine ticks every candle, but DCA only fires once per cadence window.
   * Default 7 days (weekly DCA).
   */
  cadenceMs?: number;
  /** ATR lookback for the protective catastrophe stop (default 14). */
  atrPeriod?: number;
  /**
   * Catastrophe-stop distance as a multiple of ATR. DCA is a hold-oriented
   * strategy, so the stop sits far out — it exists to cap a structural-collapse
   * tail (TRA-693 non-negotiable: "stop-loss to prevent capital depletion"),
   * not to scalp wiggles. Default 6× ATR.
   */
  atrStopMultiplier?: number;
  /**
   * Fallback stop distance as a fraction of entry when ATR is unavailable
   * (insufficient bars). Default 0.25 (25%).
   */
  fallbackStopPct?: number;
  /**
   * Take-profit distance as a multiple of the stop distance (R-multiple). DCA
   * targets long-horizon appreciation, so the target is set wide; this still
   * satisfies the ≥1:2 reward:risk floor. Default 4.
   */
  targetRR?: number;
}

/**
 * Dollar-Cost Averaging (DCA) accumulation strategy (TRA-693).
 *
 * The board's primary recommendation for crypto: build a long-term position by
 * buying a fixed amount at regular intervals, smoothing volatility and lowering
 * the average entry. Unlike the timing strategies (swing / breakout / mean-
 * reversion), DCA does not depend on a per-trade edge that has to beat costs
 * out-of-sample — its robustness comes from cadence and a trend gate, which is
 * why it is a sound floor for the post-TRA-432 crypto roster.
 *
 * Mechanics, mapped onto the engine's bracket-order TradeSignal model:
 *   • Fires a BUY at most once per `cadenceMs` per symbol (the DCA interval).
 *   • Trend gate: only accumulates while price is above the `trendEmaPeriod`
 *     EMA, so capital is committed to assets in a healthy regime and paused
 *     through deep downtrends instead of catching a falling knife.
 *   • Long-only — DCA never shorts. Position SIZE (the "fixed amount") and the
 *     1–2% risk rule are enforced by the engine's risk layer (resolveRiskPerTrade
 *     / RiskManager), not here; this module only decides WHEN to accumulate and
 *     where the protective stop / long-horizon target sit.
 *   • A wide ATR-based catastrophe stop caps the structural-collapse tail; the
 *     target is set at `targetRR×` the stop distance (≥1:2 R:R floor).
 *
 * State: one `lastFireTs` per symbol, so a single shared instance paces every
 * symbol independently (mirrors MomentumStrategy's per-symbol fire-time state).
 * Requires `trendEmaPeriod + 1` bars before it will fire.
 */
export class CryptoDcaStrategy {
  private readonly trendEmaPeriod: number;
  private readonly requireUptrend: boolean;
  private readonly cadenceMs: number;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number;
  private readonly fallbackStopPct: number;
  private readonly targetRR: number;
  private readonly lastFireTs = new Map<string, number>();

  constructor(opts: DcaOptions = {}) {
    this.trendEmaPeriod = opts.trendEmaPeriod ?? 200;
    this.requireUptrend = opts.requireUptrend ?? true;
    this.cadenceMs = opts.cadenceMs ?? 7 * 24 * 60 * 60 * 1000;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.atrStopMultiplier = opts.atrStopMultiplier ?? 6;
    this.fallbackStopPct = opts.fallbackStopPct ?? 0.25;
    this.targetRR = opts.targetRR ?? 4;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < this.trendEmaPeriod + 1) return null;

    const latest = candles[candles.length - 1];
    const closes = candles.map(c => c.close);

    // Trend gate — only accumulate while price holds above the macro EMA.
    if (this.requireUptrend) {
      const trendEma = ema(closes, this.trendEmaPeriod);
      if (isNaN(trendEma) || latest.close <= trendEma) return null;
    }

    // Cadence gate — at most one accumulation per cadence window per symbol.
    const prevTs = this.lastFireTs.get(symbol);
    if (prevTs !== undefined && latest.timestamp - prevTs < this.cadenceMs) {
      return null;
    }

    const entryPrice = latest.close;
    if (entryPrice <= 0) return null;

    const atrValue = atr(candles, this.atrPeriod);
    const stopDistance = atrValue !== null && this.atrStopMultiplier > 0
      ? this.atrStopMultiplier * atrValue
      : entryPrice * this.fallbackStopPct;
    if (stopDistance <= 0) return null;

    const tpDistance = stopDistance * this.targetRR;
    const stopLoss = Math.max(0, entryPrice - stopDistance);
    const takeProfit = entryPrice + tpDistance;

    this.lastFireTs.set(symbol, latest.timestamp);

    return {
      id: randomUUID(),
      symbol,
      type: 'dca',
      side: 'buy',
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
      timestamp: latest.timestamp,
    };
  }

  /** Clear per-symbol cadence state. Test / backtest helper. */
  reset(): void {
    this.lastFireTs.clear();
  }
}
