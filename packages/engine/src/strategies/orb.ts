import { Candle, MarketQuote, TradeSignal, Side, ADX_RANGING_THRESHOLD, isValidTradingWindow, getEasternUtcOffset, validateBracket } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { adx } from '../indicators/adx.js';
import type { SharedTickIndicators } from './shared-indicators.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

export interface OrbOptions {
  /** Minutes that define the opening range (default: 30). */
  rangeMinutes?: number;
  /** Minimum volume required to trigger a signal (default: 10_000). */
  minVolume?: number;
  /** Maximum bid-ask spread as a fraction of mid price (default: 0.0005 = 0.05%). */
  maxSpreadPct?: number;
  /** Volume spike multiplier: breakout candle must have volume > N × range average (default: 1.5). */
  volumeSpikeMultiplier?: number;
  /** Custom time filter. Defaults to ET stock windows. */
  timeFilter?: (timestampMs: number) => boolean;
  /**
   * Custom session-anchor finder. Returns the UTC ms timestamp that opens the
   * session containing `latest`. Defaults to "first candle at or after 9:30 AM ET"
   * (US equity session). For 24/7 markets, pass a callback that returns
   * the start of the UTC day, e.g.
   *   `(latest) => Math.floor(latest.timestamp / 86_400_000) * 86_400_000`.
   */
  sessionAnchorTimestampOf?: (latest: Candle) => number | null;
}

/**
 * Opening Range Breakout strategy — improved with:
 *   1. ADX regime filter: skip when ADX < 20 (no trend → breakout likely to fail)
 *   2. Volume spike confluence: breakout candle must have volume > 1.5× range average
 *   3. Time filter: only fires in valid trading windows (ET for stocks; custom session windows otherwise)
 */
export class OrbStrategy {
  private readonly rangeMinutes: number;
  private readonly minVolume: number;
  private readonly maxSpreadPct: number;
  private readonly volumeSpikeMultiplier: number;
  private readonly timeFilter: (timestampMs: number) => boolean;
  private readonly sessionAnchorTimestampOf?: (latest: Candle) => number | null;

  constructor(opts: OrbOptions = {}) {
    this.rangeMinutes = opts.rangeMinutes ?? 30;
    this.minVolume = opts.minVolume ?? 10_000;
    this.maxSpreadPct = opts.maxSpreadPct ?? 0.0005;
    this.volumeSpikeMultiplier = opts.volumeSpikeMultiplier ?? 1.5;
    this.timeFilter = opts.timeFilter ?? isValidTradingWindow;
    this.sessionAnchorTimestampOf = opts.sessionAnchorTimestampOf;
  }

  evaluate(
    symbol: string,
    candles: Candle[],
    latestQuote?: MarketQuote,
    shared?: SharedTickIndicators,
  ): TradeSignal | null {
    if (candles.length < 2) return null;

    const latest = candles[candles.length - 1];

    // Time filter: only trade during high-volume windows
    if (!this.timeFilter(latest.timestamp)) return null;

    // Locate the session-opening timestamp. For ET equities (default), find
    // the first candle at or after 9:30 AM ET. For 24/7 markets, callers
    // inject `sessionAnchorTimestampOf` to anchor on UTC day boundaries
    // (00:00 UTC) or any other custom session schedule.
    let openTime: number;
    if (this.sessionAnchorTimestampOf) {
      const anchor = this.sessionAnchorTimestampOf(latest);
      if (anchor == null) return null;
      openTime = anchor;
    } else {
      const MARKET_OPEN_ET_MINUTE = 9 * 60 + 30;
      const sessionStart = candles.find(c => {
        const offset = getEasternUtcOffset(c.timestamp);
        const etMinutes = Math.floor((c.timestamp + offset * 3_600_000) / 60_000) % (24 * 60);
        return etMinutes >= MARKET_OPEN_ET_MINUTE;
      });
      if (!sessionStart) return null;
      openTime = sessionStart.timestamp;
    }
    const rangeCutoff = openTime + this.rangeMinutes * 60 * 1000;
    const rangeCandles = candles.filter(c => c.timestamp >= openTime && c.timestamp <= rangeCutoff);
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

    // ADX regime filter: ORB only works in trending markets (ADX ≥ 20).
    // TRA-1044 (F1) — reuse the per-tick snapshot's ADX when the caller has
    // already computed it for this symbol/series (shared with BbFade); the
    // snapshot is computed with the same default period so the value is
    // identical to recomputing here.
    const adxResult = shared ? shared.adx : adx(candles);
    if (adxResult && adxResult.adx < ADX_RANGING_THRESHOLD) return null;

    const rangeHigh = Math.max(...rangeCandles.map(c => c.high));
    const rangeLow = Math.min(...rangeCandles.map(c => c.low));

    let side: Side | null = null;
    if (latest.close > rangeHigh) side = 'buy';
    else if (latest.close < rangeLow) side = 'sell';
    if (!side) return null;

    // Volume spike confluence: breakout candle must spike above range average
    const avgRangeVolume = rangeVolume / rangeCandles.length;
    if (latest.volume < avgRangeVolume * this.volumeSpikeMultiplier) return null;

    const entryPrice = latest.close;
    const stopLoss = side === 'buy' ? rangeLow : rangeHigh;
    const stopDistance = Math.abs(entryPrice - stopLoss);
    if (stopDistance === 0) return null;

    const takeProfit = side === 'buy'
      ? entryPrice + stopDistance * 2
      : entryPrice - stopDistance * 2;

    // TRA-520 — on a low-priced short the 2R target can fall below zero
    // (e.g. PRFX entry 3.05, stop 4.64 → target −0.04), which is unreachable
    // and disables the profit-taking exit. Drop any signal whose bracket is
    // non-positive or on the wrong side of entry rather than emit it.
    if (!validateBracket(side, entryPrice, stopLoss, takeProfit).ok) return null;

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
