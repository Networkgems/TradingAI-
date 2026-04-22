import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';

/** Reversal strategy — detects exhaustion at key levels via wick patterns. */
export class ReversalStrategy {
  private lookback: number;

  constructor(lookback = 5) {
    this.lookback = lookback;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < this.lookback + 1) return null;

    const window = candles.slice(-this.lookback);
    const latest = candles[candles.length - 1];
    const body = Math.abs(latest.close - latest.open);
    const upperWick = latest.high - Math.max(latest.open, latest.close);
    const lowerWick = Math.min(latest.open, latest.close) - latest.low;

    let side: Side | null = null;
    if (upperWick > body * 2 && latest.close < latest.open) side = 'sell';
    else if (lowerWick > body * 2 && latest.close > latest.open) side = 'buy';
    if (!side) return null;

    const windowHigh = Math.max(...window.map(c => c.high));
    const windowLow = Math.min(...window.map(c => c.low));
    const entryPrice = latest.close;
    const stopLoss = side === 'buy' ? windowLow : windowHigh;
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * 3
      : entryPrice - stopDistance * 3;

    return {
      id: randomUUID(),
      symbol,
      type: 'reversal',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: 3,
      timestamp: latest.timestamp,
    };
  }
}
