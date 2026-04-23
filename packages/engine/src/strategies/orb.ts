import { Candle, MarketQuote, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface OrbOptions {
  /** Minutes that define the opening range (default: 30). */
  rangeMinutes?: number;
  /** Minimum volume required to trigger a signal (default: 10_000). */
  minVolume?: number;
  /** Maximum bid-ask spread as a fraction of mid price (default: 0.0005 = 0.05%). */
  maxSpreadPct?: number;
}

export class OrbStrategy {
  private readonly rangeMinutes: number;
  private readonly minVolume: number;
  private readonly maxSpreadPct: number;

  constructor(opts: OrbOptions = {}) {
    this.rangeMinutes = opts.rangeMinutes ?? 30;
    this.minVolume = opts.minVolume ?? 10_000;
    this.maxSpreadPct = opts.maxSpreadPct ?? 0.0005;
  }

  evaluate(
    symbol: string,
    candles: Candle[],
    latestQuote?: MarketQuote,
  ): TradeSignal | null {
    if (candles.length < 2) return null;

    const openTime = candles[0].timestamp;
    const rangeCutoff = openTime + this.rangeMinutes * 60 * 1000;
    const rangeCandles = candles.filter(c => c.timestamp <= rangeCutoff);
    if (rangeCandles.length === 0) return null;

    // Volume filter: total volume in range must exceed threshold
    const rangeVolume = rangeCandles.reduce((s, c) => s + c.volume, 0);
    if (rangeVolume < this.minVolume) return null;

    // Spread filter: skip if bid-ask spread is too wide
    if (latestQuote) {
      const mid = (latestQuote.bidPrice + latestQuote.askPrice) / 2;
      if (mid > 0) {
        const spread = (latestQuote.askPrice - latestQuote.bidPrice) / mid;
        if (spread > this.maxSpreadPct) return null;
      }
    }

    const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
    const rangeLow = Math.min(...rangeCandles.map(c => c.low));
    const latest = candles[candles.length - 1];

    let side: Side | null = null;
    if (latest.close > rangeHigh) side = 'buy';
    else if (latest.close < rangeLow) side = 'sell';
    if (!side) return null;

    const entryPrice = latest.close;
    const stopLoss = side === 'buy' ? rangeLow : rangeHigh;
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return null;

    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

    return {
      id: randomUUID(),
      symbol,
      type: 'orb_breakout',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: 2,
      timestamp: latest.timestamp,
    };
  }

  /** Evaluate and auto-submit a bracket order if a signal fires. */
  async evaluateAndOrder(
    symbol: string,
    candles: Candle[],
    riskManager: RiskManager,
    orderClient: AlpacaOrderClient,
    latestQuote?: MarketQuote,
  ): Promise<TradeSignal | null> {
    const signal = this.evaluate(symbol, candles, latestQuote);
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
