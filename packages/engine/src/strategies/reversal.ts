import { Candle, TradeSignal, Side, ADX_TRENDING_THRESHOLD, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { rsi, rsiDivergence } from '../indicators/rsi.js';
import { detectPattern, isBullishPattern, isBearishPattern } from '../indicators/patterns.js';
import { macdCross } from '../indicators/macd.js';
import { adx } from '../indicators/adx.js';
import { atr } from '../indicators/atr.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface ReversalOptions {
  rsiPeriod?: number;
  /** RSI overbought threshold (default: 70). */
  rsiOverbought?: number;
  /** RSI oversold threshold (default: 30). */
  rsiOversold?: number;
  lookback?: number;
  /** Set false for 24/7 markets like crypto (default: true). */
  enforceTimeFilter?: boolean;
  /** ATR lookback period (default: 14). */
  atrPeriod?: number;
  /**
   * If set, stop distance is `atrStopMultiplier × ATR` instead of the
   * structural window high/low. Default undefined → keep structural stops.
   */
  atrStopMultiplier?: number;
  /**
   * If set, take-profit distance is `atrTpMultiplier × ATR`. Defaults to
   * undefined → fall back to the strategy's 3× R:R.
   */
  atrTpMultiplier?: number;
  /**
   * Dead-tape filter: skip signals when ATR / price is below this fraction.
   * Default 0.003 (0.3%). Set 0 to disable.
   */
  volatilityFloorPct?: number;
  /**
   * Volume-climax multiplier vs. the trailing average over `lookback` bars.
   * Default 1.3 (matches the post-TRA-170 hardcode). Exposed so walk-forward
   * (TRA-172/177) can sweep it as a knob.
   */
  volumeMultiplier?: number;
}

/**
 * RSI reversal strategy.
 *
 * TRA-170: filters were too tight on real market data — 0 fires across 90d×1h
 * BTC/ETH/SOL. Loosened so a confirmed RSI extreme + (pattern OR divergence)
 * + volume spike can produce a signal even when MACD is flat. The MACD cross
 * direction is now a *tiebreaker* (it can veto the opposite-direction cross,
 * but a missing/neutral cross no longer blocks the entry).
 */
export class ReversalStrategy {
  private readonly rsiPeriod: number;
  private readonly rsiOverbought: number;
  private readonly rsiOversold: number;
  private readonly lookback: number;
  private readonly enforceTimeFilter: boolean;
  private readonly atrPeriod: number;
  private readonly atrStopMultiplier: number | null;
  private readonly atrTpMultiplier: number | null;
  private readonly volatilityFloorPct: number;
  private readonly volumeMultiplier: number;

  constructor(opts: ReversalOptions = {}) {
    this.rsiPeriod = opts.rsiPeriod ?? 14;
    this.rsiOverbought = opts.rsiOverbought ?? 70;
    this.rsiOversold = opts.rsiOversold ?? 30;
    this.lookback = opts.lookback ?? 5;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? true;
    this.atrPeriod = opts.atrPeriod ?? 14;
    this.atrStopMultiplier = opts.atrStopMultiplier ?? null;
    this.atrTpMultiplier = opts.atrTpMultiplier ?? null;
    this.volatilityFloorPct = opts.volatilityFloorPct ?? 0.003;
    this.volumeMultiplier = opts.volumeMultiplier ?? 1.3;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < this.rsiPeriod + this.lookback + 1) return null;

    const latest = candles[candles.length - 1];

    // Time filter: avoid midday chop and after-hours noise (equity only; disabled for crypto)
    if (this.enforceTimeFilter && !isValidTradingWindow(latest.timestamp)) return null;

    // ADX regime filter: reversals only work in ranging markets
    // Skip if ADX > 25 (strong trend makes mean reversion risky)
    const adxResult = adx(candles);
    if (adxResult && adxResult.adx > ADX_TRENDING_THRESHOLD) return null;

    const closes = candles.map(c => c.close);
    const currentRsi = rsi(closes, this.rsiPeriod);
    if (isNaN(currentRsi)) return null;

    const divergence = rsiDivergence(closes, this.rsiPeriod, this.lookback);
    const pattern = detectPattern(candles.slice(-2));

    // Volume climax: current volume > volumeMultiplier × average of lookback
    // window. TRA-170 lowered the default from 1.5× → 1.3× because the previous
    // threshold blocked most genuine reversals on 1h crypto bars (where volume
    // spikes are smaller than on equity 1-min bars). The multiplier is exposed
    // (TRA-177) so walk-forward can sweep it.
    const window = candles.slice(-this.lookback - 1, -1);
    const avgVolume = window.reduce((s, c) => s + c.volume, 0) / window.length;
    const volumeClimax = latest.volume > avgVolume * this.volumeMultiplier;

    // MACD direction is a *tiebreaker* (TRA-170): a contradictory cross vetoes
    // the entry, but a missing or neutral cross no longer blocks it.
    const cross = macdCross(closes);

    let side: Side | null = null;

    // Sell reversal: RSI overbought + (pattern OR divergence) + volume spike,
    // with no contradictory MACD bullish cross.
    if (
      currentRsi > this.rsiOverbought &&
      (isBearishPattern(pattern) || divergence === 'bearish') &&
      volumeClimax &&
      cross !== 'bullish'
    ) {
      side = 'sell';
    }

    // Buy reversal: RSI oversold + (pattern OR divergence) + volume spike,
    // with no contradictory MACD bearish cross.
    if (
      currentRsi < this.rsiOversold &&
      (isBullishPattern(pattern) || divergence === 'bullish') &&
      volumeClimax &&
      cross !== 'bearish'
    ) {
      side = 'buy';
    }

    if (!side) return null;

    const entryPrice = latest.close;

    // Volatility regime gate: skip dead tape where stops barely cover spread.
    const atrValue = atr(candles, this.atrPeriod);
    if (atrValue !== null && this.volatilityFloorPct > 0) {
      const atrFraction = entryPrice > 0 ? atrValue / entryPrice : 0;
      if (atrFraction < this.volatilityFloorPct) return null;
    }

    // Stop: ATR-based when the multiplier is set and ATR computes,
    // otherwise the structural window high/low (the original behavior).
    const useAtrStop = atrValue !== null && this.atrStopMultiplier !== null && this.atrStopMultiplier > 0;
    let stopDistance: number;
    if (useAtrStop) {
      stopDistance = (this.atrStopMultiplier as number) * atrValue;
    } else {
      const windowHigh = Math.max(...window.map(c => c.high));
      const windowLow = Math.min(...window.map(c => c.low));
      const structuralStop = side === 'buy' ? windowLow : windowHigh;
      stopDistance = Math.abs(entryPrice - structuralStop);
    }
    if (stopDistance <= 0) return null;

    const tpDistance = useAtrStop && this.atrTpMultiplier !== null
      ? this.atrTpMultiplier * (atrValue as number)
      : stopDistance * 3;

    const stopLoss = side === 'buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
    const takeProfit = side === 'buy' ? entryPrice + tpDistance : entryPrice - tpDistance;

    return {
      id: randomUUID(),
      symbol,
      type: 'reversal',
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
