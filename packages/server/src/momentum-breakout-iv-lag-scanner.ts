/**
 * TRA-4570 — Momentum Breakout + IV Lag Scanner
 *
 * Detects when price breaks out but option IV hasn't repriced yet.
 *
 * Setup (DAILY bars — TRA-4706):
 * - Price clears the prior ~5-month high (or breaks the prior low)
 * - Today's volume > the prior 20 sessions' average (confirmation)
 * - Relative strength increasing
 * - Momentum increasing
 * - IV percentile still low (hasn't caught up)
 *
 * Entry: 0.25–0.40 delta OTM option before IV reprices
 * Thesis: Price has moved before option volatility catches up
 *
 * ⛔ TRA-4706 — the breakout level is taken over the bars BEFORE the latest one.
 * The first cut took the high of a window that INCLUDED the latest bar and then
 * asked `currentPrice > thatHigh × 1.015`. The latest bar's own high is ≥ its
 * close ≈ spot, so the test could essentially never pass: a breakout cannot
 * clear a level it defines. That was the mock test's momentum failure.
 */

import type { Candle, MomentumBreakoutIvLagSignal, OptionType } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { randomUUID } from 'crypto';
import { pickDeltaBandOption, underlyingRiskReward } from './swing-scanner-common.js';

export interface MomentumBreakoutIvLagConfig {
  /** Minimum breakout % beyond the prior high/low (default: 1.5) */
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
  /**
   * DAILY bars before the latest one the breakout level is taken over
   * (default: 100 ≈ 5 months). Sized to fit the 120-bar shared daily series
   * (`OTM_DAILY_SERIES_BARS`) with headroom, so short-history listings still read.
   */
  resistanceLookbackBars?: number;
}

export interface MomentumBreakoutScanInput {
  symbol: string;
  /** DAILY bars, oldest first. The latest bar may be today's forming session. */
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivPercentile: number;
  currentPrice: number;
  /** Average DAILY volume over the sessions before the latest bar. */
  avgVolume: number;
  relativeStrength?: number; // vs sector (0-100)
  riskFreeRate?: number;
  /** Clock for DTE; defaults to now. */
  asOf?: number;
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
  resistanceLookbackBars: 100,
};

/** The momentum score reads a 20-bar change. */
const MOMENTUM_BARS = 20;

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
  const asOf = input.asOf ?? Date.now();

  // Need the full prior window plus the latest bar
  if (candles.length < Math.max(cfg.resistanceLookbackBars, MOMENTUM_BARS) + 1) return null;
  if (!(avgVolume > 0)) return null;

  const latest = candles[candles.length - 1];

  // 1. The prior range — every bar in the window EXCEPT the latest
  const prior = candles.slice(-(cfg.resistanceLookbackBars + 1), -1);
  const resistanceLevel = Math.max(...prior.map(c => c.high));
  const supportLevel = Math.min(...prior.map(c => c.low));

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
    candles,
    currentPrice,
    volumeRatio,
    relativeStrength: relativeStrength ?? 50,
  });

  if (momentumScore < cfg.minMomentumScore) return null;

  // 7. Find best option candidate
  const targetOptionType: OptionType = bullishBreakout ? 'call' : 'put';
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
    fallbackIv: 0.3,
  });
  if (!pick) return null;

  // Underlying levels: back through the breakout level invalidates; ±10% pays.
  const stopLoss = bullishBreakout
    ? breakoutLevel * 0.98
    : breakoutLevel * 1.02;
  const takeProfit = bullishBreakout
    ? currentPrice * 1.10
    : currentPrice * 0.90;
  const riskRewardRatio = underlyingRiskReward(
    currentPrice, stopLoss, takeProfit, bullishBreakout ? 'bullish' : 'bearish',
  );
  if (riskRewardRatio === null) return null;

  return {
    id: randomUUID(),
    symbol,
    type: 'momentum_breakout_iv_lag',
    side,
    optionSymbol: pick.row.optionSymbol ?? `${symbol}_${pick.row.expiration}_${targetOptionType[0].toUpperCase()}_${pick.row.strike}`,
    optionType: targetOptionType,
    strike: pick.row.strike,
    expiration: pick.row.expiration,
    mark: pick.mark,
    breakoutLevel,
    ivPercentile,
    volumeRatio,
    momentumScore,
    delta: pick.delta,
    relativeStrength: relativeStrength ?? 50,
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

  if (candles.length < MOMENTUM_BARS) return 0;

  // Price momentum: % change over last 20 bars
  const startPrice = candles[candles.length - MOMENTUM_BARS].close;
  const priceChangePct = ((currentPrice - startPrice) / startPrice) * 100;
  const priceScore = Math.min(100, Math.abs(priceChangePct) * 5); // 20% change = 100 score

  // Volume momentum score
  const volumeScore = Math.max(0, Math.min(100, (volumeRatio - 1.0) * 50)); // 3x volume = 100 score

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
