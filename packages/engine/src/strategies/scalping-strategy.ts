import { Candle, TradeSignal, Side, isValidCryptoTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ema, emaCross } from '../indicators/ema.js';
import { rsi } from '../indicators/rsi.js';
import { VwapTracker } from '../indicators/vwap.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface ScalpingOptions {
  /** Fast EMA period (default: 9) */
  fastEmaPeriod?: number;
  /** Slow EMA period (default: 21) */
  slowEmaPeriod?: number;
  /** RSI period — use 7 or 9 for scalping (default: 9) */
  rsiPeriod?: number;
  /** RSI buy zone lower bound — dip to this level signals pullback entry (default: 40) */
  rsiBuyLow?: number;
  /** RSI buy zone upper bound (default: 55) */
  rsiBuyHigh?: number;
  /** RSI sell zone lower bound (default: 45) */
  rsiSellLow?: number;
  /** RSI sell zone upper bound (default: 60) */
  rsiSellHigh?: number;
  /** Volume multiplier vs average to confirm spike (default: 1.5) */
  volumeMultiplier?: number;
  /** Bars to average for volume baseline (default: 10) */
  volumeLookback?: number;
  /** Stop loss as fraction of entry price — 0.5–1% for scalping (default: 0.0075) */
  stopPct?: number;
  /** Risk-reward ratio for take-profit (default: 2) */
  rrRatio?: number;
  /** Set false for 24/7 crypto markets (default: false) */
  enforceTimeFilter?: boolean;
}

/**
 * Scalping strategy for 1–5 min charts.
 *
 * Buy:  9 EMA crosses above 21 EMA + price above VWAP + RSI dips to 40–55 and turns up + volume spike
 * Sell: 9 EMA crosses below 21 EMA + price below VWAP + RSI near 45–60 and turns down + volume spike
 *
 * Stop loss: fixed % from entry (0.75% default). Take profit: 2:1 R:R.
 */
export class ScalpingStrategy {
  private readonly fastEmaPeriod: number;
  private readonly slowEmaPeriod: number;
  private readonly rsiPeriod: number;
  private readonly rsiBuyLow: number;
  private readonly rsiBuyHigh: number;
  private readonly rsiSellLow: number;
  private readonly rsiSellHigh: number;
  private readonly volumeMultiplier: number;
  private readonly volumeLookback: number;
  private readonly stopPct: number;
  private readonly rrRatio: number;
  private readonly enforceTimeFilter: boolean;
  private readonly vwap = new VwapTracker();

  constructor(opts: ScalpingOptions = {}) {
    this.fastEmaPeriod = opts.fastEmaPeriod ?? 9;
    this.slowEmaPeriod = opts.slowEmaPeriod ?? 21;
    this.rsiPeriod = opts.rsiPeriod ?? 9;
    this.rsiBuyLow = opts.rsiBuyLow ?? 40;
    this.rsiBuyHigh = opts.rsiBuyHigh ?? 55;
    this.rsiSellLow = opts.rsiSellLow ?? 45;
    this.rsiSellHigh = opts.rsiSellHigh ?? 60;
    this.volumeMultiplier = opts.volumeMultiplier ?? 1.5;
    this.volumeLookback = opts.volumeLookback ?? 10;
    this.stopPct = opts.stopPct ?? 0.0075;
    this.rrRatio = opts.rrRatio ?? 2;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? false;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    const minBars = Math.max(this.slowEmaPeriod + 2, this.volumeLookback + 1, this.rsiPeriod + 2);
    if (candles.length < minBars) return null;

    const latest = candles[candles.length - 1];
    if (this.enforceTimeFilter && !isValidCryptoTradingWindow(latest.timestamp)) return null;

    const closes = candles.map(c => c.close);

    // 9 EMA / 21 EMA crossover — primary directional trigger
    const cross = emaCross(closes, this.fastEmaPeriod, this.slowEmaPeriod);
    if (!cross) return null;

    // RSI direction: compare current vs previous bar to detect "turning up/down"
    const currentRsi = rsi(closes, this.rsiPeriod);
    const prevRsi = rsi(closes.slice(0, -1), this.rsiPeriod);
    if (isNaN(currentRsi) || isNaN(prevRsi)) return null;
    const rsiTurningUp = currentRsi > prevRsi;
    const rsiTurningDown = currentRsi < prevRsi;

    // VWAP directional bias
    this.vwap.reset();
    let vwapState = { vwap: 0, stdDev: 0, upperBand: 0, lowerBand: 0 };
    for (const c of candles) vwapState = this.vwap.update(c);
    const aboveVwap = latest.close > vwapState.vwap;

    // Volume spike confirmation
    const volWindow = candles.slice(-this.volumeLookback - 1, -1);
    const avgVolume = volWindow.reduce((s, c) => s + c.volume, 0) / volWindow.length;
    if (latest.volume <= avgVolume * this.volumeMultiplier) return null;

    let side: Side | null = null;

    // Buy: EMA cross up + price above VWAP + RSI dipped to 40–55 and turning up
    if (
      cross === 'bullish' &&
      aboveVwap &&
      currentRsi >= this.rsiBuyLow && currentRsi <= this.rsiBuyHigh &&
      rsiTurningUp
    ) {
      side = 'buy';
    }

    // Sell: EMA cross down + price below VWAP + RSI near 45–60 and turning down
    if (
      cross === 'bearish' &&
      !aboveVwap &&
      currentRsi >= this.rsiSellLow && currentRsi <= this.rsiSellHigh &&
      rsiTurningDown
    ) {
      side = 'sell';
    }

    if (!side) return null;

    const entryPrice = latest.close;
    const stopLoss = side === 'buy'
      ? entryPrice * (1 - this.stopPct)
      : entryPrice * (1 + this.stopPct);
    const stopDistance = Math.abs(entryPrice - stopLoss);
    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * this.rrRatio
      : entryPrice - stopDistance * this.rrRatio;

    return {
      id: randomUUID(),
      symbol,
      type: 'scalping',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: this.rrRatio,
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
