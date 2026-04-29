import { Candle, TradeSignal, Side, isValidTradingWindow } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { ichimoku, tkCross } from '../indicators/ichimoku.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

/**
 * Ichimoku Cloud strategy.
 *
 * TRA-170: dropped the ADX ≥ 25 gate — Ichimoku already encodes trend through
 * the TK cross + price-vs-cloud structure, so layering ADX on top was redundant
 * and choked signal frequency to 3 fires across 90d×1h BTC/ETH/SOL. The
 * regime check is now `(cloudTop − cloudBottom) / price ≥ 0.005`, i.e. the
 * cloud must express a meaningful trend on its own terms.
 *
 * Buy:  Bullish TK cross + price above cloud top + chikou confirms + thick cloud
 * Sell: Bearish TK cross + price below cloud bottom + chikou confirms + thick cloud
 *
 * Stop loss at kijun-sen (base line); take-profit at 2:1 R:R.
 * Requires ≥ 79 candles (78 for ichimoku + 1 for TK cross comparison).
 */
// TRA-170 follow-up: lowered from 0.5% → 0.3%. Real Coinbase 1h bars only
// produced 0–6 ichimoku fires/asset/90d at 0.5%; 0.3% still requires a
// meaningful cloud while letting more genuine breakouts through.
const DEFAULT_KUMO_THICKNESS_PCT = 0.003;

export interface IchimokuOptions {
  /**
   * Minimum cloud thickness (cloudTop − cloudBottom) / price required to
   * accept a signal. Default 0.003 (0.3%, post-TRA-170). Exposed (TRA-177) so
   * walk-forward can sweep it.
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
    if (!cloud) return null;

    const cross = tkCross(candles);
    if (!cross) return null;

    const price = latest.close;

    // Kumo-thickness regime check (TRA-170): cloud must express a real trend.
    // Replaces the previous ADX ≥ 25 gate.
    if (price <= 0) return null;
    const cloudThicknessPct = (cloud.cloudTop - cloud.cloudBottom) / price;
    if (cloudThicknessPct < this.kumoThicknessFloor) return null;

    let side: Side | null = null;

    if (
      cross === 'bullish' &&
      price > cloud.cloudTop &&   // price fully above cloud (not inside it)
      cloud.chikouAbove
    ) {
      side = 'buy';
    }

    if (
      cross === 'bearish' &&
      price < cloud.cloudBottom && // price fully below cloud (not inside it)
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
