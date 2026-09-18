/**
 * TRA-4570 — Post-Earnings IV Crush + Continuation Scanner
 *
 * Detects post-earnings setups where IV has collapsed and price has either held
 * or filled the earnings gap.
 *
 * Two sub-strategies:
 * A. Earnings gap + continuation
 *    - The reaction session gaps significantly (e.g., +8%)
 *    - IV collapses after earnings
 *    - Price holds the gap (still beyond the reaction session's open)
 *    - Buy the OTM option in the gap's direction
 *
 * B. Earnings gap reversal
 *    - The reaction session gaps (e.g., +10%)
 *    - Price fills the gap (back through the pre-earnings close)
 *    - Buy the OTM option against the gap, where the post-earnings surface
 *      hasn't fully repriced
 *
 * Entry: 1–3 week swing (7–45 DTE OTM options)
 * Thesis: Earnings shock → IV reset → directional signal → option mispricing
 *
 * ⛔ TRA-4706 — everything is derived from DAILY bars + the earnings date.
 * The first cut measured the gap as `openingPriceOnEarningsDay − candles[0].close`
 * (the FIRST bar of whatever series it was handed — on the 5m cache, a bar from
 * days earlier) and, with no opening price supplied, as 0 ⇒ every symbol
 * rejected at the gap gate. It also classified continuation vs reversal off a
 * relative-strength / resistance input nothing in the engine supplies ⇒ "unclear
 * setup" even when a gap existed. The engine never passed `earningsDate` at all.
 * Any one of the three kept this scanner from firing live.
 */

import type { Candle, PostEarningsIvCrushSignal, OptionType } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { randomUUID } from 'crypto';
import { barDay, pickDeltaBandOption, underlyingRiskReward } from './swing-scanner-common.js';

export interface PostEarningsIvCrushConfig {
  /** Maximum daily sessions after the reaction session (default: 5) */
  maxDaysSinceEarnings?: number;
  /** Minimum reaction-session gap % to qualify (default: 5.0) */
  minGapPct?: number;
  /** Maximum IV percentile post-earnings (should be low = IV crushed) */
  maxIvPercentile?: number;
  /** Minimum IV percentile drop from pre-earnings (default: 30 = dropped 30 percentile points) */
  minIvDrop?: number;
  /** Target delta range */
  targetDeltaMin?: number;
  targetDeltaMax?: number;
  /** Target DTE range */
  dteMin?: number;
  dteMax?: number;
  /** When relative strength IS supplied: minimum for a bullish continuation (default: 70) */
  minRelativeStrengthContinuation?: number;
  /** When relative strength IS supplied: maximum for a bearish continuation (default: 40) */
  maxRelativeStrengthReversal?: number;
}

export interface PostEarningsIvCrushScanInput {
  symbol: string;
  /** DAILY bars, oldest first. */
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivPercentile: number;
  ivPercentilePriorToEarnings?: number; // For measuring IV drop
  /** The most recent earnings date, `YYYY-MM-DD` (from the earnings store). */
  earningsDate: string;
  currentPrice: number;
  relativeStrength?: number;
  riskFreeRate?: number;
  /** Clock for DTE; defaults to now. */
  asOf?: number;
}

const DEFAULT_CONFIG: Required<PostEarningsIvCrushConfig> = {
  maxDaysSinceEarnings: 5,
  minGapPct: 5.0,
  maxIvPercentile: 40,
  minIvDrop: 30,
  targetDeltaMin: 0.25,
  targetDeltaMax: 0.40,
  dteMin: 7, // 1 week min for post-earnings swings
  dteMax: 45, // 3 weeks max as stated in requirements
  minRelativeStrengthContinuation: 70,
  maxRelativeStrengthReversal: 40,
};

/**
 * The reaction session for an earnings date: of the first two daily bars dated
 * on/after it (the date itself for a pre-open report, the next session for an
 * after-close one — the calendar does not say which), the one with the larger
 * open-vs-prior-close gap. `null` when the series does not reach the date yet.
 */
export function findEarningsReaction(
  candles: readonly Candle[],
  earningsDate: string,
): { idx: number; gapPct: number } | null {
  const first = candles.findIndex((c) => barDay(c) >= earningsDate);
  if (first < 1) return null; // absent, or no prior close to gap from
  let best: { idx: number; gapPct: number } | null = null;
  for (const idx of [first, first + 1]) {
    if (idx >= candles.length) break;
    const prevClose = candles[idx - 1].close;
    if (!(prevClose > 0)) continue;
    const gapPct = ((candles[idx].open - prevClose) / prevClose) * 100;
    if (!best || Math.abs(gapPct) > Math.abs(best.gapPct)) best = { idx, gapPct };
  }
  return best;
}

/**
 * Scan for post-earnings IV crush setups.
 * Returns the best candidate signal, or null if no setup qualifies.
 */
export function scanPostEarningsIvCrush(
  input: PostEarningsIvCrushScanInput,
  config: PostEarningsIvCrushConfig = {},
): PostEarningsIvCrushSignal | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const {
    symbol,
    candles,
    optionChain,
    ivPercentile,
    ivPercentilePriorToEarnings,
    earningsDate,
    currentPrice,
    relativeStrength,
    riskFreeRate = 0.04,
  } = input;
  const asOf = input.asOf ?? Date.now();

  if (candles.length < 2) return null;

  // 1. The reaction session, and how long ago it was
  const reaction = findEarningsReaction(candles, earningsDate);
  if (!reaction) return null;
  const daysSinceEarnings = candles.length - 1 - reaction.idx;
  if (daysSinceEarnings > cfg.maxDaysSinceEarnings) return null;
  const gapBar = candles[reaction.idx];
  const preEarningsClose = candles[reaction.idx - 1].close;
  const gapPercent = reaction.gapPct;

  // 2. IV crush verification
  if (ivPercentile > cfg.maxIvPercentile) return null;

  // Verify significant IV drop if we have prior data
  if (ivPercentilePriorToEarnings !== undefined) {
    const ivDrop = ivPercentilePriorToEarnings - ivPercentile;
    if (ivDrop < cfg.minIvDrop) return null;
  }

  // 3. The gap itself
  if (Math.abs(gapPercent) < cfg.minGapPct) return null;

  // 4. Continuation (gap held) vs reversal (gap filled). Inside the gap = unclear.
  const isBullishGap = gapPercent > 0;
  let setupType: 'continuation' | 'reversal';
  let trendDirection: 'bullish' | 'bearish';
  if (isBullishGap) {
    if (currentPrice >= gapBar.open) {
      if (relativeStrength !== undefined && relativeStrength < cfg.minRelativeStrengthContinuation) return null;
      setupType = 'continuation';
      trendDirection = 'bullish';
    } else if (currentPrice < preEarningsClose) {
      setupType = 'reversal';
      trendDirection = 'bearish';
    } else {
      return null;
    }
  } else {
    if (currentPrice <= gapBar.open) {
      if (relativeStrength !== undefined && relativeStrength > cfg.maxRelativeStrengthReversal) return null;
      setupType = 'continuation';
      trendDirection = 'bearish';
    } else if (currentPrice > preEarningsClose) {
      setupType = 'reversal';
      trendDirection = 'bullish';
    } else {
      return null;
    }
  }

  // 5. Find best option candidate
  const targetOptionType: OptionType = trendDirection === 'bullish' ? 'call' : 'put';
  const pick = pickDeltaBandOption({
    chain: optionChain,
    optionType: targetOptionType,
    spot: currentPrice,
    deltaMin: cfg.targetDeltaMin,
    deltaMax: cfg.targetDeltaMax,
    dteMin: cfg.dteMin,
    dteMax: cfg.dteMax,
    asOf,
    riskFreeRate,
    fallbackIv: 0.25, // Lower default post-IV-crush
    // Prefer contracts with lower IV (cheaper post-crush), normalised against a typical high IV of 0.8
    rank: (p) => p.deltaScore * 0.6 + (1 - p.iv / 0.8) * 0.4,
  });
  if (!pick) return null;

  // Underlying levels. A continuation is invalidated by filling the gap (back
  // through the pre-earnings close); a reversal by reclaiming the gap open.
  const stopLoss = setupType === 'continuation' ? preEarningsClose : gapBar.open;
  const takeProfit = trendDirection === 'bullish'
    ? currentPrice * 1.12
    : currentPrice * 0.88;
  const riskRewardRatio = underlyingRiskReward(currentPrice, stopLoss, takeProfit, trendDirection);
  if (riskRewardRatio === null) return null;

  const latest = candles[candles.length - 1];
  return {
    id: randomUUID(),
    symbol,
    type: 'post_earnings_iv_crush',
    side: 'buy', // Always buying options in this strategy
    optionSymbol: pick.row.optionSymbol ?? `${symbol}_${pick.row.expiration}_${targetOptionType[0].toUpperCase()}_${pick.row.strike}`,
    optionType: targetOptionType,
    strike: pick.row.strike,
    expiration: pick.row.expiration,
    mark: pick.mark,
    earningsDate,
    daysSinceEarnings,
    ivPercentile,
    gapPercent,
    setupType,
    delta: pick.delta,
    trendDirection,
    relativeStrength,
    underlyingPrice: currentPrice,
    entryPrice: pick.mark,
    stopLoss,
    takeProfit,
    riskRewardRatio,
    timestamp: latest.timestamp,
    bid: pick.row.bid,
    ask: pick.row.ask,
  };
}
