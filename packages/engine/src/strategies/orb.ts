import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';

/** Opening Range Breakout strategy — range defined by first N minutes of session. */
export class OrbStrategy {
  private rangeMinutes: number;

  constructor(rangeMinutes = 30) {
    this.rangeMinutes = rangeMinutes;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < 2) return null;

    const openTime = candles[0].timestamp;
    const rangeCutoff = openTime + this.rangeMinutes * 60 * 1000;
    const rangeCandles = candles.filter(c => c.timestamp <= rangeCutoff);
    if (rangeCandles.length === 0) return null;

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
}
