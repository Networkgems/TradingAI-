import { Candle, TradeSignal, ADX_RANGING_THRESHOLD, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { bollinger } from '../indicators/bollinger.js';
import { rsi } from '../indicators/rsi.js';
import { adx } from '../indicators/adx.js';
import { atr } from '../indicators/atr.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface BbFadeOptions {
  /** BB period (default: 20) */
  bbPeriod?: number;
  /** BB multiplier (default: 2) */
  bbMultiplier?: number;
  /** RSI period (default: 14) */
  rsiPeriod?: number;
  /** RSI long-entry threshold (default: 30) */
  rsiOversold?: number;
  /** Set false for 24/7 markets like crypto (default: true). */
  enforceTimeFilter?: boolean;
  /** ATR lookback period (default: 14). */
  atrPeriod?: number;
  /**
   * Dead-tape filter: skip signals when ATR / price is below this fraction.
   * Default 0.003 (0.3%). Set 0 to disable. The fade stop is intentionally
   * tight (sub-band low), so an ATR-stop override is not exposed here.
   */
  volatilityFloorPct?: number;
}

/**
 * Bollinger-band mean-reversion fade (TRA-170 split — long-only).
 *
 * Buy: ADX ≤ 20 (ranging regime) + price at/below the lower band + RSI < 30.
 *
 * Stop  = min(latest.low, lower band) − 1¢ (recent low, bounded away from
 *         entry so a flat lower-band sweep doesn't yield a zero-width stop).
 * Target = BB middle band (statistically the cleanest mean-reversion exit).
 *
 * No short side: fading the upper band on the way down is structurally
 * different (no symmetric "RSI > 70 + ADX low" edge in our backtests) and
 * will be added later if the long side proves out.
 */
export class BbFadeStrategy {
  private readonly bbPeriod: number;
  private readonly bbMultiplier: number;
  private readonly rsiPeriod: number;
  private readonly rsiOversold: number;
  private readonly enforceTimeFilter: boolean;
  private readonly atrPeriod: number;
  private readonly volatilityFloorPct: number;

  constructor(opts: BbFadeOptions = {}) {
    this.bbPeriod = opts.bbPeriod ?? 20;
    this.bbMultiplier = opts.bbMultiplier ?? 2;
    this.rsiPeriod = opts.rsiPeriod ?? 14;
    this.rsiOversold = opts.rsiOversold ?? 30;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? true;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.volatilityFloorPct = opts.volatilityFloorPct ?? 0.003;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < Math.max(this.bbPeriod, this.rsiPeriod + 1, 28)) return null;

    const closes = candles.map(c => c.close);
    const latest = candles[candles.length - 1];

    if (this.enforceTimeFilter && !isValidTradingWindow(latest.timestamp)) return null;

    const bands = bollinger(closes, this.bbPeriod, this.bbMultiplier);
    if (!bands) return null;

    // Range regime gate — pure mean-reversion only fires in chop, not trend.
    const adxResult = adx(candles);
    if (adxResult && adxResult.adx > ADX_RANGING_THRESHOLD) return null;

    // Price has tagged the lower band (touch or break).
    if (latest.close > bands.lower) return null;

    const currentRsi = rsi(closes, this.rsiPeriod);
    if (isNaN(currentRsi) || currentRsi >= this.rsiOversold) return null;

    const entryPrice = latest.close;

    // Dead-tape filter: don't fade chop where the spread eats the fade.
    if (this.volatilityFloorPct > 0) {
      const atrValue = atr(candles, this.atrPeriod);
      if (atrValue !== null) {
        const atrFraction = entryPrice > 0 ? atrValue / entryPrice : 0;
        if (atrFraction < this.volatilityFloorPct) return null;
      }
    }

    const stopLoss = Math.min(latest.low, bands.lower) - 0.01;
    const stopDistance = entryPrice - stopLoss;
    if (stopDistance <= 0) return null;

    // Target = middle band (mean reversion exit).
    const takeProfit = bands.middle;
    const reward = takeProfit - entryPrice;
    if (reward <= 0) return null;

    return {
      id: randomUUID(),
      symbol,
      type: 'bb_fade',
      side: 'buy',
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: reward / stopDistance,
      timestamp: latest.timestamp,
    };
  }

  async evaluateAndOrder(
    symbol: string,
    candles: Candle[],
    riskManager: RiskManager,
    orderClient: AlpacaOrderClient,
  ): Promise<TradeSignal | null> {
    const signal = this.evaluate(symbol, candles);
    if (!signal) return null;

    const qty = riskManager.sizeFromStop(signal.entryPrice, signal.stopLoss);
    if (qty <= 0) return null;

    await orderClient.submitBracketOrder({
      symbol: signal.symbol,
      qty,
      side: signal.side,
      limitPrice: signal.entryPrice,
      takeProfitPrice: signal.takeProfit,
      stopLossPrice: signal.stopLoss,
    });

    return signal;
  }
}
