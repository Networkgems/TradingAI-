/**
 * TRA-4570 — Momentum Breakout + IV Lag Scanner
 *
 * Detects when price breaks out but option IV hasn't repriced yet.
 *
 * Setup:
 * - Stock breaks 6-month resistance (or breaks down through support)
 * - Volume > average (confirmation)
 * - Relative strength increasing
 * - Momentum increasing
 * - OTM call/put IV still near historical median (hasn't caught up)
 *
 * Entry: 0.25–0.40 delta OTM option before IV reprices
 * Thesis: Price has moved before option volatility catches up
 */

import type { Candle, MomentumBreakoutIvLagSignal, OptionType } from '@trading-app/shared';
import type { TradierOptionsClient, OptionChainRow } from '@trading-app/engine';
import { randomUUID } from 'crypto';
import { blackScholesDelta, daysToExpiration } from '@trading-app/engine';

export interface MomentumBreakoutIvLagConfig {
  /** Minimum breakout % above resistance (default: 1.5) */
  minBreakoutPct?: number;
  /** Minimum volume ratio vs average (default: 1.5x) */
  minVolumeRatio?: number;
  /** Maximum IV percentile (should be low - IV hasn't caught up yet) */
  maxIvPercentile?: number;
  /** Minimum relative strength vs sector (default: 80) */
  minRelativeStrength?: number;
  /** Minimum momentum score (default: 70) */
  minMomentumScore?: number;
  /** Target delta range */
  targetDeltaMin?: number;
  targetDeltaMax?: number;
  /** Target DTE range */
  dteMin?: number;
  dteMax?: number;
  /** Lookback bars for resistance calculation (default: 120 = ~6 months on daily) */
  resistanceLookbackBars?: number;
}

export interface MomentumBreakoutScanInput {
  symbol: string;
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivPercentile: number;
  currentPrice: number;
  avgVolume: number;
  relativeStrength?: number; // vs sector (0-100)
  riskFreeRate?: number;
}

const DEFAULT_CONFIG: Required<MomentumBreakoutIvLagConfig> = {
  minBreakoutPct: 1.5,
  minVolumeRatio: 1.5,
  maxIvPercentile: 50,
  minRelativeStrength: 80,
  minMomentumScore: 70,
  targetDeltaMin: 0.25,
  targetDeltaMax: 0.40,
  dteMin: 25,
  dteMax: 60,
  resistanceLookbackBars: 120,
};

/**
 * Scan for momentum breakout + IV lag setups.
 * Returns the best candidate signal, or null if no setup qualifies.
 */
export function scanMomentumBreakoutIvLag(
  input: MomentumBreakoutScanInput,
  config: MomentumBreakoutIvLagConfig = {},
): MomentumBreakoutIvLagSignal | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { symbol, candles, optionChain, ivPercentile, currentPrice, avgVolume, relativeStrength, riskFreeRate = 0.04 } = input;

  // Need sufficient history
  if (candles.length < cfg.resistanceLookbackBars + 20) return null;

  const latest = candles[candles.length - 1];

  // 1. Calculate resistance level (recent high in lookback period)
  const lookbackCandles = candles.slice(-cfg.resistanceLookbackBars);
  const resistanceLevel = Math.max(...lookbackCandles.map(c => c.high));

  // Also check for support (for bearish breakout)
  const supportLevel = Math.min(...lookbackCandles.map(c => c.low));

  // 2. Determine if we have a breakout
  const bullishBreakout = currentPrice > resistanceLevel * (1 + cfg.minBreakoutPct / 100);
  const bearishBreakout = currentPrice < supportLevel * (1 - cfg.minBreakoutPct / 100);

  if (!bullishBreakout && !bearishBreakout) return null;

  const side: 'buy' | 'sell' = bullishBreakout ? 'buy' : 'sell';
  const breakoutLevel = bullishBreakout ? resistanceLevel : supportLevel;

  // 3. Volume confirmation
  const volumeRatio = latest.volume / avgVolume;
  if (volumeRatio < cfg.minVolumeRatio) return null;

  // 4. IV percentile gate — IV should NOT be elevated (it hasn't caught up)
  if (ivPercentile > cfg.maxIvPercentile) return null;

  // 5. Relative strength check (if provided)
  if (relativeStrength !== undefined && relativeStrength < cfg.minRelativeStrength) {
    return null;
  }

  // 6. Calculate momentum score
  const momentumScore = calculateMomentumScore({
    candles: lookbackCandles,
    currentPrice,
    volumeRatio,
    relativeStrength: relativeStrength ?? 50,
  });

  if (momentumScore < cfg.minMomentumScore) return null;

  // 7. Find best option candidate
  const targetOptionType: OptionType = bullishBreakout ? 'call' : 'put';
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
    .filter(row => row.bid && row.ask && row.bid > 0); // Liquid

  if (candidates.length === 0) return null;

  // Score candidates
  const scoredCandidates = candidates.map(row => {
    const mark = (row.bid! + row.ask!) / 2;
    const dte = daysToExpiration(row.expiration, now);
    const iv = row.midIv ?? 0.3;

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

    return { row, mark, delta, deltaScore, dte, iv };
  });

  const validCandidates = scoredCandidates
    .filter(c => c.delta >= cfg.targetDeltaMin && c.delta <= cfg.targetDeltaMax)
    .sort((a, b) => b.deltaScore - a.deltaScore);

  if (validCandidates.length === 0) return null;

  const best = validCandidates[0];

  // Entry/stop/target
  const entryPrice = best.mark;
  const stopLoss = bullishBreakout
    ? breakoutLevel * 0.98  // Stop below breakout level
    : breakoutLevel * 1.02; // Stop above breakdown level
  const takeProfit = bullishBreakout
    ? currentPrice * 1.10   // +10% target
    : currentPrice * 0.90;  // -10% target

  return {
    id: randomUUID(),
    symbol,
    type: 'momentum_breakout_iv_lag',
    side,
    optionSymbol: best.row.optionSymbol ?? `${symbol}_${best.row.expiration}_${targetOptionType[0].toUpperCase()}_${best.row.strike}`,
    optionType: targetOptionType,
    strike: best.row.strike,
    expiration: best.row.expiration,
    mark: best.mark,
    breakoutLevel,
    ivPercentile,
    volumeRatio,
    momentumScore,
    delta: best.delta,
    relativeStrength: relativeStrength ?? 50,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: Math.abs(takeProfit - entryPrice) / Math.abs(entryPrice - stopLoss),
    timestamp: latest.timestamp,
    bid: best.row.bid,
    ask: best.row.ask,
  };
}

/**
 * Calculate momentum score (0-100).
 * Higher = stronger momentum.
 */
function calculateMomentumScore(params: {
  candles: Candle[];
  currentPrice: number;
  volumeRatio: number;
  relativeStrength: number;
}): number {
  const { candles, currentPrice, volumeRatio, relativeStrength } = params;

  if (candles.length < 20) return 0;

  // Price momentum: % change over last 20 bars
  const startPrice = candles[candles.length - 20].close;
  const priceChangePct = ((currentPrice - startPrice) / startPrice) * 100;
  const priceScore = Math.min(100, Math.abs(priceChangePct) * 5); // 20% change = 100 score

  // Volume momentum score
  const volumeScore = Math.min(100, (volumeRatio - 1.0) * 50); // 3x volume = 100 score

  // Trend consistency: count consecutive higher closes (or lower for bearish)
  const recentCandles = candles.slice(-10);
  const closes = recentCandles.map(c => c.close);
  let consecutiveTrend = 0;
  const isUptrend = closes[closes.length - 1] > closes[0];

  for (let i = 1; i < closes.length; i++) {
    if (isUptrend && closes[i] > closes[i - 1]) consecutiveTrend++;
    else if (!isUptrend && closes[i] < closes[i - 1]) consecutiveTrend++;
  }

  const trendScore = (consecutiveTrend / 9) * 100;

  // Composite
  return (
    priceScore * 0.35 +
    volumeScore * 0.25 +
    trendScore * 0.20 +
    relativeStrength * 0.20
  );
}
