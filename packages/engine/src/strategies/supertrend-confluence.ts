import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import { supertrend, supertrendLatest, type SupertrendOptions } from '../indicators/supertrend.js';
import { smaSeries } from '../sma200-signals.js';
import { macd, macdCross } from '../indicators/macd.js';
import { rsi } from '../indicators/rsi.js';
import { resampleCandles, TF_BUCKET_MS } from '../indicators/mtf.js';
import type { AlpacaOrderClient } from '../alpaca/index.js';
import type { RiskManager } from '../risk.js';

/**
 * TRA-728 (Phase 1) — SupertrendConfluence strategy.
 *
 * A slow, multi-confirmation trend-continuation signal designed to feed the
 * options-selection layer. All confluence gates must agree on the signal
 * timeframe (default 15m) AND a higher timeframe (default 60m) must agree on
 * trend direction via the Supertrend read.
 *
 * Long entry (all true on the signal timeframe):
 *   - Supertrend green (price above the ST line)
 *   - MA5 > MA10 > MA20 (SMA stack, fast over mid over slow)
 *   - MACD histogram > 0, OR a bullish MACD cross within the last N bars
 *   - RSI in [50,70] and rising
 *   - 60m Supertrend also green (confirm trend agrees)
 * Short entry is the exact mirror.
 *
 * Pure & deterministic apart from the signal `id` (randomUUID, like every other
 * strategy): the side/price/stop fields are a pure function of the candles, so
 * the confluence logic is golden-fixture testable via
 * {@link evaluateSupertrendConfluence}.
 *
 * Reuses existing primitives only: {@link supertrend} (ATR-based), {@link smaSeries}
 * (SMA 5/10/20), {@link macd}/{@link macdCross} (12/26/9), {@link rsi} (14), and
 * {@link resampleCandles} for the MTF confirm fold.
 */

export interface SupertrendConfluenceParams {
  /** Supertrend ATR length + factor (default {period:10, factor:3}). */
  supertrend?: SupertrendOptions;
  /** Fast SMA length (default 5). */
  maShort?: number;
  /** Mid SMA length (default 10). */
  maMid?: number;
  /** Slow SMA length (default 20). */
  maLong?: number;
  /** RSI length (default 14). */
  rsiPeriod?: number;
  /** Inclusive RSI band for longs (default [50, 70]). */
  rsiLongBand?: [number, number];
  /** Inclusive RSI band for shorts (default [30, 50]). */
  rsiShortBand?: [number, number];
  /** Require RSI to be rising (long) / falling (short). Default true. */
  requireRsiSlope?: boolean;
  /** MACD periods (defaults 12/26/9). */
  macdFast?: number;
  macdSlow?: number;
  macdSignal?: number;
  /** Bars to look back for a MACD cross when the histogram is not yet signed (default 3). */
  macdCrossLookback?: number;
  /** Require the higher-timeframe Supertrend to agree on direction. Default true. */
  requireConfirmTrend?: boolean;
  /** Reward:risk multiple used to derive the take-profit from the ST stop (default 2). */
  rewardRiskRatio?: number;
}

interface ResolvedParams {
  supertrend: SupertrendOptions;
  maShort: number;
  maMid: number;
  maLong: number;
  rsiPeriod: number;
  rsiLongBand: [number, number];
  rsiShortBand: [number, number];
  requireRsiSlope: boolean;
  macdFast: number;
  macdSlow: number;
  macdSignal: number;
  macdCrossLookback: number;
  requireConfirmTrend: boolean;
  rewardRiskRatio: number;
}

function resolve(p: SupertrendConfluenceParams): ResolvedParams {
  return {
    supertrend: p.supertrend ?? {},
    maShort: p.maShort ?? 5,
    maMid: p.maMid ?? 10,
    maLong: p.maLong ?? 20,
    rsiPeriod: p.rsiPeriod ?? 14,
    rsiLongBand: p.rsiLongBand ?? [50, 70],
    rsiShortBand: p.rsiShortBand ?? [30, 50],
    requireRsiSlope: p.requireRsiSlope ?? true,
    macdFast: p.macdFast ?? 12,
    macdSlow: p.macdSlow ?? 26,
    macdSignal: p.macdSignal ?? 9,
    macdCrossLookback: p.macdCrossLookback ?? 3,
    requireConfirmTrend: p.requireConfirmTrend ?? true,
    rewardRiskRatio: p.rewardRiskRatio ?? 2,
  };
}

/** Did a bullish MACD cross occur on any of the last `lookback` bars? */
function macdCrossWithin(
  closes: number[],
  direction: 'bullish' | 'bearish',
  lookback: number,
  fast: number,
  slow: number,
  signal: number,
): boolean {
  for (let back = 0; back < lookback; back++) {
    const slice = back === 0 ? closes : closes.slice(0, -back);
    if (macdCross(slice, fast, slow, signal) === direction) return true;
  }
  return false;
}

/** The four single-timeframe confluence reads for one side. Exported for tests. */
export interface ConfluenceReads {
  supertrendGreen: boolean;
  maStackAligned: boolean;
  macdOk: boolean;
  rsiOk: boolean;
}

/**
 * Evaluate the long-side and short-side confluence on a single timeframe and
 * return the side that passes all four gates, or `null` when neither does. Pure.
 */
export function confluenceSide(
  candles: Candle[],
  params: SupertrendConfluenceParams = {},
): { side: Side; reads: ConfluenceReads } | null {
  const p = resolve(params);
  const closes = candles.map(c => c.close);

  const minBars = Math.max(
    p.maLong,
    p.macdSlow + p.macdSignal + p.macdCrossLookback,
    p.rsiPeriod + 2,
    (p.supertrend.period ?? 10) + 1,
  );
  if (candles.length < minBars) return null;

  const st = supertrendLatest(candles, p.supertrend);
  if (!st) return null;

  const ma5 = smaSeries(closes, p.maShort);
  const ma10 = smaSeries(closes, p.maMid);
  const ma20 = smaSeries(closes, p.maLong);
  const m5 = ma5[ma5.length - 1];
  const m10 = ma10[ma10.length - 1];
  const m20 = ma20[ma20.length - 1];
  if (!Number.isFinite(m5) || !Number.isFinite(m10) || !Number.isFinite(m20)) return null;

  const macdRes = macd(closes, p.macdFast, p.macdSlow, p.macdSignal);
  if (!macdRes) return null;

  const rsiNow = rsi(closes, p.rsiPeriod);
  const rsiPrev = rsi(closes.slice(0, -1), p.rsiPeriod);
  if (!Number.isFinite(rsiNow) || !Number.isFinite(rsiPrev)) return null;

  // --- long reads ---
  const longReads: ConfluenceReads = {
    supertrendGreen: st.direction === 'green',
    maStackAligned: m5 > m10 && m10 > m20,
    macdOk:
      macdRes.histogram > 0 ||
      macdCrossWithin(closes, 'bullish', p.macdCrossLookback, p.macdFast, p.macdSlow, p.macdSignal),
    rsiOk:
      rsiNow >= p.rsiLongBand[0] &&
      rsiNow <= p.rsiLongBand[1] &&
      (!p.requireRsiSlope || rsiNow > rsiPrev),
  };
  if (longReads.supertrendGreen && longReads.maStackAligned && longReads.macdOk && longReads.rsiOk) {
    return { side: 'buy', reads: longReads };
  }

  // --- short reads (mirror) ---
  const shortReads: ConfluenceReads = {
    supertrendGreen: st.direction === 'green', // reported as-is; short wants red
    maStackAligned: m5 < m10 && m10 < m20,
    macdOk:
      macdRes.histogram < 0 ||
      macdCrossWithin(closes, 'bearish', p.macdCrossLookback, p.macdFast, p.macdSlow, p.macdSignal),
    rsiOk:
      rsiNow >= p.rsiShortBand[0] &&
      rsiNow <= p.rsiShortBand[1] &&
      (!p.requireRsiSlope || rsiNow < rsiPrev),
  };
  if (st.direction === 'red' && shortReads.maStackAligned && shortReads.macdOk && shortReads.rsiOk) {
    return { side: 'sell', reads: shortReads };
  }

  return null;
}

/**
 * Full pure evaluation: confluence on `signalCandles`, gated by the
 * higher-timeframe Supertrend on `confirmCandles`. Returns a `supertrend_confluence`
 * {@link TradeSignal} on the underlying, or `null`. The stop is the Supertrend
 * line (the trailing stop level); take-profit is `rewardRiskRatio × stopDistance`.
 *
 * `confirmCandles` may be `null` to skip the MTF gate (only valid when
 * `requireConfirmTrend` is false). When the gate is required and the confirm
 * series is missing or disagrees, the function returns `null`.
 */
export function evaluateSupertrendConfluence(
  symbol: string,
  signalCandles: Candle[],
  confirmCandles: Candle[] | null,
  params: SupertrendConfluenceParams = {},
): TradeSignal | null {
  const p = resolve(params);
  const decision = confluenceSide(signalCandles, params);
  if (!decision) return null;
  const { side } = decision;

  // MTF gate: the higher timeframe's Supertrend must agree on direction.
  if (p.requireConfirmTrend) {
    if (!confirmCandles) return null;
    const confirm = supertrendLatest(confirmCandles, p.supertrend);
    if (!confirm) return null;
    const wantGreen = side === 'buy';
    if ((confirm.direction === 'green') !== wantGreen) return null;
  }

  const latest = signalCandles[signalCandles.length - 1];
  const st = supertrendLatest(signalCandles, p.supertrend)!;
  const entryPrice = latest.close;
  const stopDistance = Math.abs(entryPrice - st.line);
  if (stopDistance <= 0) return null;

  const tpDistance = stopDistance * p.rewardRiskRatio;
  const stopLoss = side === 'buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const takeProfit = side === 'buy' ? entryPrice + tpDistance : entryPrice - tpDistance;

  return {
    id: randomUUID(),
    symbol,
    type: 'supertrend_confluence',
    side,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: p.rewardRiskRatio,
    timestamp: latest.timestamp,
  };
}

/**
 * Strategy wrapper for router compatibility. {@link evaluate} mirrors the other
 * strategies' `(symbol, candles)` shape: it treats the supplied candles as the
 * signal timeframe and derives the 60m confirm series by resampling them, so the
 * router can call it uniformly. Callers with explicit per-timeframe candle sets
 * should prefer {@link evaluateSupertrendConfluence} directly.
 */
export class SupertrendConfluenceStrategy {
  private readonly params: SupertrendConfluenceParams;

  constructor(params: SupertrendConfluenceParams = {}) {
    this.params = params;
  }

  /**
   * Evaluate on `signalCandles`, deriving the higher-timeframe confirm series by
   * resampling to 60m. `signalCandles` are assumed to be the signal timeframe
   * (default 15m) with real, monotonic timestamps so the resample buckets align.
   */
  evaluate(symbol: string, signalCandles: Candle[]): TradeSignal | null {
    const confirm = resampleCandles(signalCandles, TF_BUCKET_MS['1h']);
    return evaluateSupertrendConfluence(symbol, signalCandles, confirm, this.params);
  }

  async evaluateAndOrder(
    symbol: string,
    signalCandles: Candle[],
    riskManager: RiskManager,
    orderClient: AlpacaOrderClient,
  ): Promise<TradeSignal | null> {
    const signal = this.evaluate(symbol, signalCandles);
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
