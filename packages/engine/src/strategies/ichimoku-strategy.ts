import { Candle, TradeSignal, Side, ADX_TRENDING_THRESHOLD, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ichimoku, tkCross } from '../indicators/ichimoku.js';
import { adx } from '../indicators/adx.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

/**
 * Ichimoku Cloud strategy — improved with:
 *   1. ADX trending confirmation: require ADX ≥ 25 (cloud signals are trend-following)
 *   2. Explicit cloud thickness check: price must be fully outside the cloud, not inside
 *   3. Time filter: only fires in valid ET trading windows
 *
 * Buy:  Bullish TK cross + price above cloud top + chikou confirms + ADX trending
 * Sell: Bearish TK cross + price below cloud bottom + chikou confirms + ADX trending
 *
 * Stop loss at kijun-sen (base line); take-profit at 2:1 R:R.
 * Requires ≥ 79 candles (78 for ichimoku + 1 for TK cross comparison).
 */
export class IchimokuStrategy {
  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < 79) return null;

    const latest = candles[candles.length - 1];

    // Time filter: only trade during high-volume windows
    if (!isValidTradingWindow(latest.timestamp)) return null;

    const cloud = ichimoku(candles);
    if (!cloud) return null;

    const cross = tkCross(candles);
    if (!cross) return null;

    // ADX regime filter: Ichimoku is a trend-following system
    const adxResult = adx(candles);
    if (adxResult && adxResult.adx < ADX_TRENDING_THRESHOLD) return null;

    const price = latest.close;

    let side: Side | null = null;

    if (
      cross === 'bullish' &&
      price > cloud.cloudTop &&   // price fully above cloud (not inside it)
      cloud.chikouAbove
    ) {
      side = 'buy';
    }

    if (
      cross === 'bearish' &&
      price < cloud.cloudBottom && // price fully below cloud (not inside it)
      !cloud.chikouAbove
    ) {
      side = 'sell';
    }

    if (!side) return null;

    const entryPrice = price;
    const stopLoss = side === 'buy'
      ? Math.min(cloud.kijun, cloud.cloudBottom)
      : Math.max(cloud.kijun, cloud.cloudTop);

    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return null;

    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

    return {
      id: randomUUID(),
      symbol,
      type: 'ichimoku',
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
