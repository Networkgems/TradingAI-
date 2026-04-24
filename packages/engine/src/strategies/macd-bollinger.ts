import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { macdCross } from '../indicators/macd.js';
import { bollinger, bollingerZone } from '../indicators/bollinger.js';
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
 * MACD-Bollinger confluence strategy.
 *
 * Buy:  MACD bullish cross + price at/below BB middle + above-average volume
 * Sell: MACD bearish cross + price at/above BB middle + above-average volume
 *
 * Stop loss at the opposite BB band; take-profit at 2:1 R:R.
 */
export class MacdBollingerStrategy {
  private readonly bbPeriod: number;
  private readonly bbMultiplier: number;
  private readonly volumeMultiplier: number;
  private readonly volumeLookback: number;

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

    const cross = macdCross(closes);
    if (!cross) return null;

    const bands = bollinger(closes, this.bbPeriod, this.bbMultiplier);
    if (!bands) return null;

    const zone = bollingerZone(latest.close, bands);

    const volWindow = candles.slice(-this.volumeLookback - 1, -1);
    const avgVolume = volWindow.reduce((s, c) => s + c.volume, 0) / volWindow.length;
    const volumeConfirm = latest.volume > avgVolume * this.volumeMultiplier;
    if (!volumeConfirm) return null;

    let side: Side | null = null;

    // Bullish: MACD cross up + price not yet extended above middle (potential rally room)
    if (cross === 'bullish' && (zone === 'near_lower' || zone === 'below_lower' || zone === 'middle')) {
      side = 'buy';
    }

    // Bearish: MACD cross down + price near or above middle (potential drop room)
    if (cross === 'bearish' && (zone === 'near_upper' || zone === 'above_upper' || zone === 'middle')) {
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
