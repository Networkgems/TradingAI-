import { Candle, TradeSignal, Side, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ichimoku } from '../indicators/ichimoku.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

/**
 * Ichimoku Cloud strategy.
 *
 * TRA-182: replaced entry trigger from "TK cross on cross-bar + price already
 * above/below cloud" to "kumo breakout + TK bias agrees". The previous trigger
 * was doubly restrictive (tight timing) yet late-stage (price had already
 * extended past the cloud), producing 17 signals / 4.8% winRate / 17.6% hit1R
 * across 90d×1h BTC/ETH/SOL. The breakout entry fires on the bar where price
 * actually closes through the cloud edge, with the TK line bias confirming the
 * direction. The chikou span and kumo-thickness gates are retained.
 *
 * TRA-170: dropped the ADX ≥ 25 gate — Ichimoku already encodes trend through
 * the kumo structure, so layering ADX on top was redundant and choked signal
 * frequency. The regime check is `(cloudTop − cloudBottom) / price ≥
 * kumoThicknessFloor`, i.e. the cloud must express a meaningful trend on its
 * own terms.
 *
 * Buy:  prev close ≤ prev cloudTop AND curr close > curr cloudTop (breakout)
 *       + tenkan > kijun (TK bias bullish) + chikou confirms + thick cloud
 * Sell: prev close ≥ prev cloudBottom AND curr close < curr cloudBottom
 *       + tenkan < kijun + chikou confirms + thick cloud
 *
 * Stop loss at kijun / opposite cloud edge; take-profit at 2:1 R:R.
 * Requires ≥ 79 candles (78 for ichimoku + 1 for the prev-bar comparison).
 */
const DEFAULT_KUMO_THICKNESS_PCT = 0.005;

export interface IchimokuOptions {
  /**
   * Minimum cloud thickness (cloudTop − cloudBottom) / price required to
   * accept a signal. Default 0.005 (0.5%). Exposed so walk-forward (TRA-177)
   * can sweep it.
   */
  kumoThicknessFloor?: number;
  /** Set false for 24/7 markets like crypto (default: true). */
  enforceTimeFilter?: boolean;
}

export class IchimokuStrategy {
  private readonly kumoThicknessFloor: number;
  private readonly enforceTimeFilter: boolean;

  constructor(opts: IchimokuOptions = {}) {
    this.kumoThicknessFloor = opts.kumoThicknessFloor ?? DEFAULT_KUMO_THICKNESS_PCT;
    this.enforceTimeFilter = opts.enforceTimeFilter ?? true;
  }

  evaluate(symbol: string, candles: Candle[]): TradeSignal | null {
    if (candles.length < 79) return null;

    const latest = candles[candles.length - 1];

    // Time filter: only trade during high-volume windows (equity only;
    // disabled for 24/7 crypto datasets via enforceTimeFilter=false).
    if (this.enforceTimeFilter && !isValidTradingWindow(latest.timestamp)) return null;

    const cloud = ichimoku(candles);
    const prevCloud = ichimoku(candles.slice(0, -1));
    if (!cloud || !prevCloud) return null;

    const price = latest.close;
    const prevClose = candles[candles.length - 2].close;

    // Kumo-thickness regime check (TRA-170): cloud must express a real trend.
    if (price <= 0) return null;
    const cloudThicknessPct = (cloud.cloudTop - cloud.cloudBottom) / price;
    if (cloudThicknessPct < this.kumoThicknessFloor) return null;

    let side: Side | null = null;

    // Bull kumo breakout: prev close at-or-below the cloud top, curr close
    // through it. TK bias must agree (tenkan > kijun) and chikou confirms.
    if (
      prevClose <= prevCloud.cloudTop &&
      price > cloud.cloudTop &&
      cloud.tenkan > cloud.kijun &&
      cloud.chikouAbove
    ) {
      side = 'buy';
    }

    // Bear kumo breakout: prev close at-or-above the cloud bottom, curr close
    // through it. TK bias must agree (tenkan < kijun) and chikou confirms.
    if (
      prevClose >= prevCloud.cloudBottom &&
      price < cloud.cloudBottom &&
      cloud.tenkan < cloud.kijun &&
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
