import { Candle, TradeSignal, Side } from '@trading-app/shared';
import { randomUUID } from 'crypto';
import {
  supertrendLatest,
  SUPERTREND_DEFAULT_PERIOD,
  type SupertrendOptions,
  type SupertrendBar,
} from '../indicators/supertrend.js';
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
 * Reuses existing primitives only: {@link supertrendLatest} (ATR-based), {@link smaSeries}
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
 * TRA-840 — minimum confirm-series length before the higher-timeframe Supertrend
 * is trusted as an MTF gate. The ATR warm-up consumes `period`+1 bars and the
 * seed direction needs a further run of real crosses to wash out; below this
 * floor the confirm read is warm-up/seed-dominated (TRA-809 root cause: a ~13-bar
 * confirm was deterministically `red` regardless of the real 1h trend, which
 * rubber-stamped shorts). 30 bars is well past the default 10-period warm-up.
 */
export const SUPERTREND_MIN_CONFIRM_BARS = 30;

function minConfirmBars(period: number): number {
  return Math.max(SUPERTREND_MIN_CONFIRM_BARS, period + 1 + 10);
}

/** Both sides' raw reads plus the latest Supertrend bar, computed once. */
interface ComputedReads {
  st: SupertrendBar;
  longReads: ConfluenceReads;
  shortReads: ConfluenceReads;
}

/**
 * Compute the latest Supertrend read and the per-component confluence booleans
 * for BOTH sides in one pass. Returns `null` only when there is not enough data
 * to define the indicators. Pure. Callers decide what counts as a pass.
 */
function computeReads(
  candles: Candle[],
  params: SupertrendConfluenceParams,
): ComputedReads | null {
  const p = resolve(params);
  const closes = candles.map(c => c.close);

  const minBars = Math.max(
    p.maLong,
    p.macdSlow + p.macdSignal + p.macdCrossLookback,
    p.rsiPeriod + 2,
    (p.supertrend.period ?? SUPERTREND_DEFAULT_PERIOD) + 1,
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

  return { st, longReads, shortReads };
}

/**
 * Evaluate the long-side and short-side confluence on a single timeframe and
 * return the side that passes all four gates, or `null` when neither does. Pure.
 */
export function confluenceSide(
  candles: Candle[],
  params: SupertrendConfluenceParams = {},
): { side: Side; reads: ConfluenceReads } | null {
  const r = computeReads(candles, params);
  if (!r) return null;
  const { st, longReads, shortReads } = r;

  if (longReads.supertrendGreen && longReads.maStackAligned && longReads.macdOk && longReads.rsiOk) {
    return { side: 'buy', reads: longReads };
  }
  if (st.direction === 'red' && shortReads.maStackAligned && shortReads.macdOk && shortReads.rsiOk) {
    return { side: 'sell', reads: shortReads };
  }
  return null;
}

/**
 * TRA-840 — raw per-component confluence reads for the side the Supertrend points
 * at (`green` → buy, `red` → sell), computed INDEPENDENTLY of whether the emit
 * gate passes. {@link confluenceSide} only ever returns reads on the all-true
 * pass branch, so anything recorded from it is tautologically TRUE and carries
 * zero attribution information (TRA-809 Anomaly 2). This variant returns the
 * implied side's reads even when one or more components fail, so a ledger that
 * records them has genuine variance (false-subset n>0). Returns `null` only when
 * there is not enough data to define the indicators.
 */
export function confluenceReads(
  candles: Candle[],
  params: SupertrendConfluenceParams = {},
): { side: Side; reads: ConfluenceReads } | null {
  const r = computeReads(candles, params);
  if (!r) return null;
  const side: Side = r.st.direction === 'green' ? 'buy' : 'sell';
  return { side, reads: side === 'buy' ? r.longReads : r.shortReads };
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
    // TRA-840 confirm-window length guard. A confirm series shorter than the
    // seed-independence floor is warm-up/seed-pinned (TRA-809: a ~13-bar confirm
    // read `red` regardless of the real 1h trend, rubber-stamping shorts). Emit
    // nothing rather than trust a too-short confirm.
    if (confirmCandles.length < minConfirmBars(p.supertrend.period ?? SUPERTREND_DEFAULT_PERIOD)) {
      return null;
    }
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
 * TRA-840 — one row of shadow-ledger telemetry for the Supertrend-implied side.
 * Unlike a routed {@link TradeSignal} this is captured even on a NEAR-MISS (the
 * Supertrend + MTF confirm agree on a side but one or more confluence components
 * fail), distinguished by {@link emitted}. The bracket fields mirror the emit
 * path so a near-miss resolves over the same forward horizon, giving the ledger
 * attribution variance without ever routing capital.
 */
export interface SupertrendShadowRow {
  side: Side;
  reads: ConfluenceReads;
  /** True iff all four confluence gates passed (a routable emit); false = near-miss. */
  emitted: boolean;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  riskRewardRatio: number;
  timestamp: number;
  /** The active Supertrend line on the signal bar (the bracket's stop basis). */
  supertrendLine: number;
}

/**
 * TRA-840 — shadow-ledger row for the Supertrend-implied side, captured whenever
 * the signal-timeframe read is defined AND the higher-timeframe confirm agrees
 * (subject to the same length guard as the emit path). `emitted` is true only
 * when every confluence component also passes — i.e. exactly when
 * {@link evaluateSupertrendConfluence} would have routed. Near-miss rows
 * (`emitted:false`) differ ONLY in their `maStack`/`macd`/`rsi` reads, so they
 * supply the false-subset the attribution needs without polluting it with rows
 * the trend filter would have blocked. Returns `null` when there is no defined
 * read, the confirm is missing/too-short/disagrees, or the bracket is degenerate.
 */
export function evaluateSupertrendConfluenceRow(
  symbol: string,
  signalCandles: Candle[],
  confirmCandles: Candle[] | null,
  params: SupertrendConfluenceParams = {},
): SupertrendShadowRow | null {
  const p = resolve(params);
  const r = computeReads(signalCandles, params);
  if (!r) return null;
  const side: Side = r.st.direction === 'green' ? 'buy' : 'sell';
  const reads = side === 'buy' ? r.longReads : r.shortReads;

  // Same MTF confirm gate (and TRA-840 length guard) as the emit path: only
  // capture rows the trend filter would let through, so candidate ≈ emit minus
  // the maStack/macd/rsi components.
  if (p.requireConfirmTrend) {
    if (!confirmCandles) return null;
    if (confirmCandles.length < minConfirmBars(p.supertrend.period ?? SUPERTREND_DEFAULT_PERIOD)) {
      return null;
    }
    const confirm = supertrendLatest(confirmCandles, p.supertrend);
    if (!confirm) return null;
    if ((confirm.direction === 'green') !== (side === 'buy')) return null;
  }

  // The Supertrend direction already matches the implied side, so the emit flag
  // is just the remaining three components (mirrors confluenceSide's branches).
  const emitted = reads.maStackAligned && reads.macdOk && reads.rsiOk;

  const latest = signalCandles[signalCandles.length - 1];
  const entryPrice = latest.close;
  const stopDistance = Math.abs(entryPrice - r.st.line);
  if (stopDistance <= 0) return null;
  const tpDistance = stopDistance * p.rewardRiskRatio;
  const stopLoss = side === 'buy' ? entryPrice - stopDistance : entryPrice + stopDistance;
  const takeProfit = side === 'buy' ? entryPrice + tpDistance : entryPrice - tpDistance;

  return {
    side,
    reads,
    emitted,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: p.rewardRiskRatio,
    timestamp: latest.timestamp,
    supertrendLine: r.st.line,
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

  /**
   * TRA-840 — shadow-ledger row (emit OR near-miss) for the Supertrend-implied
   * side, deriving the 1h confirm by resampling like {@link evaluate}. Observe-
   * only: the caller records it for attribution and never routes a near-miss.
   */
  evaluateShadowRow(symbol: string, signalCandles: Candle[]): SupertrendShadowRow | null {
    const confirm = resampleCandles(signalCandles, TF_BUCKET_MS['1h']);
    return evaluateSupertrendConfluenceRow(symbol, signalCandles, confirm, this.params);
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
