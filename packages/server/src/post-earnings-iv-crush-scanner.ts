/**
 * TRA-4570 — Post-Earnings IV Crush + Continuation Scanner
 *
 * Detects post-earnings setups where IV has collapsed and price continues trending.
 *
 * Two sub-strategies:
 * A. Earnings gap + continuation
 *    - Stock gaps significantly (e.g., +8%)
 *    - IV collapses after earnings
 *    - Stock holds the gap and begins trending
 *    - Now looking for cheap OTM calls + confirmed post-earnings trend
 *
 * B. Earnings gap reversal
 *    - Stock gaps (e.g., +10%)
 *    - Fails at resistance / fills the gap / loses opening range
 *    - Relative strength deteriorates
 *    - OTM puts where post-earnings IV surface hasn't fully repriced
 *
 * Entry: 1–3 week swing (25-45 DTE OTM options)
 * Thesis: Earnings shock → IV reset → directional signal → option mispricing
 */

import type { Candle, PostEarningsIvCrushSignal, OptionType } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { randomUUID } from 'crypto';
import { blackScholesDelta, daysToExpiration } from '@trading-app/engine';

export interface PostEarningsIvCrushConfig {
  /** Maximum days since earnings event (default: 5) */
  maxDaysSinceEarnings?: number;
  /** Minimum gap % to qualify (default: 5.0) */
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
  /** Minimum relative strength for continuation (default: 70) */
  minRelativeStrengthContinuation?: number;
  /** Maximum relative strength for reversal (default: 40 = deteriorating) */
  maxRelativeStrengthReversal?: number;
}

export interface PostEarningsIvCrushScanInput {
  symbol: string;
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivPercentile: number;
  ivPercentilePriorToEarnings?: number; // For measuring IV drop
  earningsDate: Date | number; // Earnings event date
  currentPrice: number;
  openingPriceOnEarningsDay?: number; // For gap calculation
  relativeStrength?: number;
  resistanceLevel?: number; // For reversal detection
  supportLevel?: number;
  riskFreeRate?: number;
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
    openingPriceOnEarningsDay,
    relativeStrength,
    resistanceLevel,
    supportLevel,
    riskFreeRate = 0.04,
  } = input;

  if (candles.length < 10) return null;

  const latest = candles[candles.length - 1];
  const earningsTimestamp = typeof earningsDate === 'number' ? earningsDate : earningsDate.getTime();

  // 1. Days since earnings check
  const daysSinceEarnings = (latest.timestamp - earningsTimestamp) / (1000 * 60 * 60 * 24);
  if (daysSinceEarnings < 0 || daysSinceEarnings > cfg.maxDaysSinceEarnings) return null;

  // 2. IV crush verification
  if (ivPercentile > cfg.maxIvPercentile) return null;

  // Verify significant IV drop if we have prior data
  if (ivPercentilePriorToEarnings !== undefined) {
    const ivDrop = ivPercentilePriorToEarnings - ivPercentile;
    if (ivDrop < cfg.minIvDrop) return null;
  }

  // 3. Calculate gap
  const gapPercent = openingPriceOnEarningsDay
    ? ((openingPriceOnEarningsDay - candles[0].close) / candles[0].close) * 100
    : 0;

  if (Math.abs(gapPercent) < cfg.minGapPct) return null;

  // 4. Determine setup type: Continuation vs Reversal
  const isBullishGap = gapPercent > 0;
  let setupType: 'continuation' | 'reversal' = 'continuation';
  let trendDirection: 'bullish' | 'bearish';

  if (isBullishGap) {
    // Bullish gap: check if continuing or reversing
    if (resistanceLevel && currentPrice < resistanceLevel * 0.995) {
      // Failed at resistance → reversal to downside
      setupType = 'reversal';
      trendDirection = 'bearish';
    } else if (relativeStrength !== undefined && relativeStrength >= cfg.minRelativeStrengthContinuation) {
      // Strong continuation
      setupType = 'continuation';
      trendDirection = 'bullish';
    } else {
      return null; // Unclear setup
    }
  } else {
    // Bearish gap: check if continuing down or reversing up
    if (supportLevel && currentPrice > supportLevel * 1.005) {
      // Holding above support → reversal to upside
      setupType = 'reversal';
      trendDirection = 'bullish';
    } else if (relativeStrength !== undefined && relativeStrength <= cfg.maxRelativeStrengthReversal) {
      // Weak continuation down
      setupType = 'continuation';
      trendDirection = 'bearish';
    } else {
      return null; // Unclear setup
    }
  }

  // 5. Find best option candidate
  const targetOptionType: OptionType = trendDirection === 'bullish' ? 'call' : 'put';
  const side: 'buy' | 'sell' = 'buy'; // Always buying options in this strategy
  const now = Date.now();

  const candidates = optionChain
    .filter(row => row.optionType === targetOptionType)
    .filter(row => {
      const dte = daysToExpiration(row.expiration, now);
      return dte >= cfg.dteMin && dte <= cfg.dteMax;
    })
    .filter(row => {
      // OTM filter
      if (targetOptionType === 'call') return row.strike > currentPrice;
      else return row.strike < currentPrice;
    })
    .filter(row => row.bid && row.ask && row.bid > 0);

  if (candidates.length === 0) return null;

  // Score candidates
  const scoredCandidates = candidates.map(row => {
    const mark = (row.bid! + row.ask!) / 2;
    const dte = daysToExpiration(row.expiration, now);
    const iv = row.midIv ?? 0.25; // Lower default post-IV-crush

    const delta = Math.abs(blackScholesDelta({
      spot: currentPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      volatility: iv,
      riskFreeRate: riskFreeRate,
      optionType: targetOptionType,
    }));

    const targetDeltaMid = (cfg.targetDeltaMin + cfg.targetDeltaMax) / 2;
    const deltaScore = 1 - Math.abs(delta - targetDeltaMid) / targetDeltaMid;

    // Prefer contracts with lower IV (cheaper post-crush)
    const ivScore = 1 - (iv / 0.8); // Normalize against typical high IV of 0.8

    return { row, mark, delta, deltaScore, ivScore, dte, iv };
  });

  const validCandidates = scoredCandidates
    .filter(c => c.delta >= cfg.targetDeltaMin && c.delta <= cfg.targetDeltaMax)
    .sort((a, b) => {
      const scoreA = a.deltaScore * 0.6 + a.ivScore * 0.4;
      const scoreB = b.deltaScore * 0.6 + b.ivScore * 0.4;
      return scoreB - scoreA;
    });

  if (validCandidates.length === 0) return null;

  const best = validCandidates[0];

  // Entry/stop/target
  const entryPrice = best.mark;
  const stopLoss = trendDirection === 'bullish'
    ? (supportLevel ?? currentPrice * 0.95)
    : (resistanceLevel ?? currentPrice * 1.05);
  const takeProfit = trendDirection === 'bullish'
    ? currentPrice * 1.12
    : currentPrice * 0.88;

  return {
    id: randomUUID(),
    symbol,
    type: 'post_earnings_iv_crush',
    side,
    optionSymbol: best.row.optionSymbol ?? `${symbol}_${best.row.expiration}_${targetOptionType[0].toUpperCase()}_${best.row.strike}`,
    optionType: targetOptionType,
    strike: best.row.strike,
    expiration: best.row.expiration,
    mark: best.mark,
    daysSinceEarnings,
    ivPercentile,
    gapPercent,
    delta: best.delta,
    trendDirection,
    relativeStrength,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss),
    timestamp: latest.timestamp,
    bid: best.row.bid,
    ask: best.row.ask,
  };
}
