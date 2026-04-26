import { Candle, TradeSignal, Side, ADX_TRENDING_THRESHOLD } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ema } from '../indicators/ema.js';
import { rsi } from '../indicators/rsi.js';
import { macd } from '../indicators/macd.js';
import { adx } from '../indicators/adx.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface SwingOptions {
  /** Fast EMA period — 50-day by default (default: 50) */
  fastEmaPeriod?: number;
  /** Slow EMA period — 200-day defines macro trend (default: 200) */
  slowEmaPeriod?: number;
  /** RSI period (default: 14) */
  rsiPeriod?: number;
  /** RSI buy zone lower bound — pullback in uptrend (default: 40) */
  rsiBuyLow?: number;
  /** RSI buy zone upper bound (default: 50) */
  rsiBuyHigh?: number;
  /** RSI sell zone lower bound — rally rejection in downtrend (default: 50) */
  rsiSellLow?: number;
  /** RSI sell zone upper bound (default: 60) */
  rsiSellHigh?: number;
  /** Max distance from 50 EMA as a fraction of price to qualify as a pullback (default: 0.03) */
  ema50ProximityPct?: number;
  /** Stop loss as fraction of entry price — 3–8% for swing (default: 0.05) */
  stopPct?: number;
  /** Risk-reward ratio for take-profit (default: 2) */
  rrRatio?: number;
  /** Require ADX ≥ 25 before taking signals (default: true) */
  requireAdxTrend?: boolean;
}

/**
 * Swing trading strategy for 4H–Daily charts.
 *
 * Buy:  50 EMA > 200 EMA (uptrend) + price above 200 EMA + price pulls back to within 3% of 50 EMA
 *       + RSI 40–50 (not oversold — healthy pullback) + MACD histogram > 0 (momentum turning bullish)
 *
 * Sell: 50 EMA < 200 EMA (downtrend) + price below 200 EMA + price rallies to within 3% of 50 EMA
 *       + RSI 50–60 (rejection zone) + MACD histogram < 0 (momentum turning bearish)
 *
 * Stop loss: fixed % from entry (5% default for wider swing stops). Take profit: 2:1 R:R.
 * Requires at least 205 daily candles (200 EMA warm-up + signal bar).
 */
export class SwingStrategy {
  private readonly fastEmaPeriod: number;
  private readonly slowEmaPeriod: number;
  private readonly rsiPeriod: number;
  private readonly rsiBuyLow: number;
  private readonly rsiBuyHigh: number;
  private readonly rsiSellLow: number;
  private readonly rsiSellHigh: number;
  private readonly ema50ProximityPct: number;
  private readonly stopPct: number;
  private readonly rrRatio: number;
  private readonly requireAdxTrend: boolean;

  constructor(opts: SwingOptions = {}) {
    this.fastEmaPeriod = opts.fastEmaPeriod ?? 50;
    this.slowEmaPeriod = opts.slowEmaPeriod ?? 200;
    this.rsiPeriod = opts.rsiPeriod ?? 14;
    this.rsiBuyLow = opts.rsiBuyLow ?? 40;
    this.rsiBuyHigh = opts.rsiBuyHigh ?? 50;
    this.rsiSellLow = opts.rsiSellLow ?? 50;
    this.rsiSellHigh = opts.rsiSellHigh ?? 60;
    this.ema50ProximityPct = opts.ema50ProximityPct ?? 0.03;
    this.stopPct = opts.stopPct ?? 0.05;
    this.rrRatio = opts.rrRatio ?? 2;
    this.requireAdxTrend = opts.requireAdxTrend ?? true;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    // 200 EMA needs at least 200 bars; require 5 extra for MACD and RSI warm-up
    if (candles.length < this.slowEmaPeriod + 5) return null;

    const latest = candles[candles.length - 1];
    const closes = candles.map(c => c.close);

    // Macro trend: 50 EMA vs 200 EMA
    const ema50 = ema(closes, this.fastEmaPeriod);
    const ema200 = ema(closes, this.slowEmaPeriod);
    if (isNaN(ema50) || isNaN(ema200)) return null;

    const uptrend = ema50 > ema200;
    const downtrend = ema50 < ema200;

    // Price proximity to 50 EMA — the pullback/rally-to-resistance entry zone
    const distanceFromEma50 = Math.abs(latest.close - ema50) / latest.close;
    const nearEma50 = distanceFromEma50 <= this.ema50ProximityPct;
    if (!nearEma50) return null;

    // RSI momentum check
    const currentRsi = rsi(closes, this.rsiPeriod);
    if (isNaN(currentRsi)) return null;

    // MACD momentum confirmation
    const macdResult = macd(closes);
    if (!macdResult) return null;

    // ADX trend filter — only take signals in trending markets
    if (this.requireAdxTrend) {
      const adxResult = adx(candles);
      if (adxResult && adxResult.adx < ADX_TRENDING_THRESHOLD) return null;
    }

    let side: Side | null = null;

    // Buy: price in uptrend, pulled back to 50 EMA support, RSI in buy zone, MACD bullish
    if (
      uptrend &&
      latest.close > ema200 &&
      currentRsi >= this.rsiBuyLow && currentRsi <= this.rsiBuyHigh &&
      macdResult.histogram > 0
    ) {
      side = 'buy';
    }

    // Sell: price in downtrend, rallied to 50 EMA resistance, RSI in rejection zone, MACD bearish
    if (
      downtrend &&
      latest.close < ema200 &&
      currentRsi >= this.rsiSellLow && currentRsi <= this.rsiSellHigh &&
      macdResult.histogram < 0
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
      type: 'swing_trade',
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
