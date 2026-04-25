import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { rsi, rsiDivergence } from '../indicators/rsi.js';
import { VwapTracker } from '../indicators/vwap.js';
import { detectPattern, isBullishPattern, isBearishPattern } from '../indicators/patterns.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface ReversalOptions {
  rsiPeriod?: number;
  /** RSI overbought threshold (default: 70). */
  rsiOverbought?: number;
  /** RSI oversold threshold (default: 30). */
  rsiOversold?: number;
  lookback?: number;
}

export class ReversalStrategy {
  private readonly rsiPeriod: number;
  private readonly rsiOverbought: number;
  private readonly rsiOversold: number;
  private readonly lookback: number;
  private readonly vwap = new VwapTracker();
  private lastSessionDate = -1;

  constructor(opts: ReversalOptions = {}) {
    this.rsiPeriod = opts.rsiPeriod ?? 14;
    this.rsiOverbought = opts.rsiOverbought ?? 70;
    this.rsiOversold = opts.rsiOversold ?? 30;
    this.lookback = opts.lookback ?? 5;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < this.rsiPeriod + this.lookback + 1) return null;

    const latest = candles[candles.length - 1];

    // Reset VWAP at the start of each trading session (new calendar day)
    const sessionDay = Math.floor(latest.timestamp / 86_400_000);
    if (sessionDay !== this.lastSessionDate) {
      this.vwap.reset();
      this.lastSessionDate = sessionDay;
    }

    // Update VWAP with all candles for the session
    let vwapState = { vwap: 0, stdDev: 0, upperBand: 0, lowerBand: 0 };
    for (const c of candles) vwapState = this.vwap.update(c);

    const closes = candles.map(c => c.close);
    const currentRsi = rsi(closes, this.rsiPeriod);
    if (isNaN(currentRsi)) return null;

    const divergence = rsiDivergence(closes, this.rsiPeriod, this.lookback);
    const pattern = detectPattern(candles.slice(-2));
    const vwapExtension = this.vwap.isExtended(latest.close, vwapState);

    // Volume climax: current volume > 2× average of lookback window
    const window = candles.slice(-this.lookback - 1, -1);
    const avgVolume = window.reduce((s, c) => s + c.volume, 0) / window.length;
    const volumeClimax = latest.volume > avgVolume * 2;

    let side: Side | null = null;

    // Sell reversal: RSI overbought + (bearish pattern OR bearish divergence) + extended above VWAP
    if (
      currentRsi > this.rsiOverbought &&
      (isBearishPattern(pattern) || divergence === 'bearish') &&
      vwapExtension === 'above' &&
      volumeClimax
    ) {
      side = 'sell';
    }

    // Buy reversal: RSI oversold + (bullish pattern OR bullish divergence) + extended below VWAP
    if (
      currentRsi < this.rsiOversold &&
      (isBullishPattern(pattern) || divergence === 'bullish') &&
      vwapExtension === 'below' &&
      volumeClimax
    ) {
      side = 'buy';
    }

    if (!side) return null;

    const windowHigh = Math.max(...window.map(c => c.high));
    const windowLow = Math.min(...window.map(c => c.low));
    const entryPrice = latest.close;
    const stopLoss = side === 'buy' ? windowLow : windowHigh;
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return null;

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
