import { Candle, TradeSignal, Side, ADX_TRENDING_THRESHOLD, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { macdCross } from '../indicators/macd.js';
import { bollinger, bollingerZone } from '../indicators/bollinger.js';
import { VwapTracker } from '../indicators/vwap.js';
import { adx } from '../indicators/adx.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface MacdBollingerOptions {
  /** BB period (default: 20) */
  bbPeriod?: number;
  /** BB multiplier (default: 2) */
  bbMultiplier?: number;
  /** Volume multiplier to confirm signal (default: 1.5x average) */
  volumeMultiplier?: number;
  /** Bars to average for volume baseline (default: 20) */
  volumeLookback?: number;
}

/**
 * MACD-Bollinger confluence strategy — improved with:
 *   1. VWAP directional filter: buy only when price is above VWAP; sell only below
 *   2. ADX trending bias: require ADX ≥ 25 for best signal quality (trend strategy)
 *   3. Time filter: only fires in valid ET trading windows
 *
 * Entry logic:
 *   Buy:  MACD bullish cross + price at/below BB middle + above VWAP + volume + ADX trending
 *   Sell: MACD bearish cross + price at/above BB middle + below VWAP + volume + ADX trending
 *
 * Stop loss at the opposite BB band; take-profit at 2:1 R:R.
 */
export class MacdBollingerStrategy {
  private readonly bbPeriod: number;
  private readonly bbMultiplier: number;
  private readonly volumeMultiplier: number;
  private readonly volumeLookback: number;
  private readonly vwap = new VwapTracker();
  private lastSessionDate = -1;

  constructor(opts: MacdBollingerOptions = {}) {
    this.bbPeriod = opts.bbPeriod ?? 20;
    this.bbMultiplier = opts.bbMultiplier ?? 2;
    this.volumeMultiplier = opts.volumeMultiplier ?? 1.5;
    this.volumeLookback = opts.volumeLookback ?? 20;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    // Need slowPeriod(26) + signalPeriod(9) - 1 = 34 bars minimum for MACD cross
    if (candles.length < Math.max(35, this.bbPeriod, this.volumeLookback + 1)) return null;

    const closes = candles.map(c => c.close);
    const latest = candles[candles.length - 1];

    // Time filter: only trade during high-volume windows
    if (!isValidTradingWindow(latest.timestamp)) return null;

    const cross = macdCross(closes);
    if (!cross) return null;

    const bands = bollinger(closes, this.bbPeriod, this.bbMultiplier);
    if (!bands) return null;

    const zone = bollingerZone(latest.close, bands);

    const volWindow = candles.slice(-this.volumeLookback - 1, -1);
    const avgVolume = volWindow.reduce((s, c) => s + c.volume, 0) / volWindow.length;
    const volumeConfirm = latest.volume > avgVolume * this.volumeMultiplier;
    if (!volumeConfirm) return null;

    // ADX regime filter: MACD is a trend strategy — require trending market
    const adxResult = adx(candles);
    if (adxResult && adxResult.adx < ADX_TRENDING_THRESHOLD) return null;

    // VWAP directional filter
    const sessionDay = Math.floor(latest.timestamp / 86_400_000);
    if (sessionDay !== this.lastSessionDate) {
      this.vwap.reset();
      this.lastSessionDate = sessionDay;
    }
    let vwapState = { vwap: 0, stdDev: 0, upperBand: 0, lowerBand: 0 };
    for (const c of candles) vwapState = this.vwap.update(c);
    const aboveVwap = latest.close > vwapState.vwap;

    let side: Side | null = null;

    // Bullish: MACD cross up + price not yet extended above middle + price above VWAP
    if (
      cross === 'bullish' &&
      (zone === 'near_lower' || zone === 'below_lower' || zone === 'middle') &&
      aboveVwap
    ) {
      side = 'buy';
    }

    // Bearish: MACD cross down + price near or above middle + price below VWAP
    if (
      cross === 'bearish' &&
      (zone === 'near_upper' || zone === 'above_upper' || zone === 'middle') &&
      !aboveVwap
    ) {
      side = 'sell';
    }

    if (!side) return null;

    const entryPrice = latest.close;
    const stopLoss = side === 'buy' ? bands.lower : bands.upper;
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return null;

    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

    return {
      id: randomUUID(),
      symbol,
      type: 'macd_cross',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: 2,
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
