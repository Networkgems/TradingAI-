import { Candle, TradeSignal, Side, ADX_TRENDING_THRESHOLD, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { macdCross } from '../indicators/macd.js';
import { bollinger } from '../indicators/bollinger.js';
import { VwapTracker } from '../indicators/vwap.js';
import { adx } from '../indicators/adx.js';
import { atr } from '../indicators/atr.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface MacdTrendOptions {
  /** BB period — used for trend-side stop placement (default: 20) */
  bbPeriod?: number;
  /** BB multiplier (default: 2) */
  bbMultiplier?: number;
  /** Volume multiplier to confirm signal (default: 1.5x average) */
  volumeMultiplier?: number;
  /** Bars to average for volume baseline (default: 20) */
  volumeLookback?: number;
  /** Set false for 24/7 markets like crypto (default: true). */
  enforceTimeFilter?: boolean;
  /** ATR lookback period (default: 14). */
  atrPeriod?: number;
  /**
   * If set, stop distance is `atrStopMultiplier × ATR` instead of the
   * structural opposite-band stop. Default undefined → keep BB-band stops.
   */
  atrStopMultiplier?: number;
  /**
   * If set, take-profit distance is `atrTpMultiplier × ATR`. Defaults to
   * undefined → fall back to the strategy's 2× R:R.
   */
  atrTpMultiplier?: number;
  /**
   * Dead-tape filter: skip signals when ATR / price is below this fraction.
   * Default 0.003 (0.3%). Set 0 to disable.
   */
  volatilityFloorPct?: number;
}

/**
 * MACD trend-continuation strategy (TRA-170 split).
 *
 * Buy:  MACD bullish cross + ADX ≥ 25 + price above VWAP + price above BB middle
 * Sell: MACD bearish cross + ADX ≥ 25 + price below VWAP + price below BB middle
 *
 * Stop = opposite BB band (loose stop on a trending move); take-profit at 2:1 R:R.
 *
 * The previous `MacdBollingerStrategy` mixed this trend bias with a "price near
 * lower BB" mean-reversion check, which fired only twice on a 90-day BTC/ETH/SOL
 * backtest. Splitting the two ideas restores both edges.
 */
export class MacdTrendStrategy {
  private readonly bbPeriod: number;
  private readonly bbMultiplier: number;
  private readonly volumeMultiplier: number;
  private readonly volumeLookback: number;
  private readonly enforceTimeFilter: boolean;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number | null;
  private readonly atrTpMultiplier: number | null;
  private readonly volatilityFloorPct: number;
  private readonly vwap = new VwapTracker();

  constructor(opts: MacdTrendOptions = {}) {
    this.bbPeriod = opts.bbPeriod ?? 20;
    this.bbMultiplier = opts.bbMultiplier ?? 2;
    this.volumeMultiplier = opts.volumeMultiplier ?? 1.5;
    this.volumeLookback = opts.volumeLookback ?? 20;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? true;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.atrStopMultiplier = opts.atrStopMultiplier ?? null;
    this.atrTpMultiplier = opts.atrTpMultiplier ?? null;
    this.volatilityFloorPct = opts.volatilityFloorPct ?? 0.003;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < Math.max(35, this.bbPeriod, this.volumeLookback + 1)) return null;

    const closes = candles.map(c => c.close);
    const latest = candles[candles.length - 1];

    if (this.enforceTimeFilter && !isValidTradingWindow(latest.timestamp)) return null;

    const cross = macdCross(closes);
    if (!cross) return null;

    const bands = bollinger(closes, this.bbPeriod, this.bbMultiplier);
    if (!bands) return null;

    const volWindow = candles.slice(-this.volumeLookback - 1, -1);
    const avgVolume = volWindow.reduce((s, c) => s + c.volume, 0) / volWindow.length;
    if (latest.volume <= avgVolume * this.volumeMultiplier) return null;

    // Trend regime gate
    const adxResult = adx(candles);
    if (adxResult && adxResult.adx < ADX_TRENDING_THRESHOLD) return null;

    this.vwap.reset();
    let vwapState = { vwap: 0, stdDev: 0, upperBand: 0, lowerBand: 0 };
    for (const c of candles) vwapState = this.vwap.update(c);
    const aboveVwap = latest.close > vwapState.vwap;

    let side: Side | null = null;

    // Trend continuation long: MACD bullish + price above middle band + above VWAP
    if (cross === 'bullish' && latest.close > bands.middle && aboveVwap) {
      side = 'buy';
    }

    // Trend continuation short: MACD bearish + price below middle band + below VWAP
    if (cross === 'bearish' && latest.close < bands.middle && !aboveVwap) {
      side = 'sell';
    }

    if (!side) return null;

    const entryPrice = latest.close;

    // Volatility regime gate: skip dead tape so stops cover spread + commissions.
    const atrValue = atr(candles, this.atrPeriod);
    if (atrValue !== null && this.volatilityFloorPct > 0) {
      const atrFraction = entryPrice > 0 ? atrValue / entryPrice : 0;
      if (atrFraction < this.volatilityFloorPct) return null;
    }

    // Stop: ATR-based when configured; otherwise opposite BB band (default).
    const useAtrStop = atrValue !== null && this.atrStopMultiplier !== null && this.atrStopMultiplier > 0;
    let stopDistance: number;
    if (useAtrStop) {
      stopDistance = (this.atrStopMultiplier as number) * atrValue;
    } else {
      const structuralStop = side === 'buy' ? bands.lower : bands.upper;
      stopDistance = Math.abs(entryPrice - structuralStop);
    }
    if (stopDistance <= 0) return null;

    const tpDistance = useAtrStop && this.atrTpMultiplier !== null
      ? this.atrTpMultiplier * (atrValue as number)
      : stopDistance * 2;

    const stopLoss = side === 'buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit = side === 'buy' ? entryPrice + tpDistance : entryPrice - tpDistance;

    return {
      id: randomUUID(),
      symbol,
      type: 'macd_trend',
      side,
      entryPrice,
      stopLoss,
      takeProfit,
      riskRewardRatio: tpDistance / stopDistance,
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
