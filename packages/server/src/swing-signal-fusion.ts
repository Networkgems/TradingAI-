/**
 * TRA-4570 — Swing Signal Fusion Engine
 *
 * Combines signals from multiple swing strategies and scores them using
 * independent confirmation layers:
 * - Technical (price action, volume, momentum)
 * - IV/RV (implied vs realized volatility)
 * - Relative Strength (vs sector)
 * - IV Skew
 * - OTM Mispricing
 *
 * Returns ranked signals with composite scores (0-100).
 */

import type {
  Candle,
  TradeSignal,
  PanicReversalSignal,
  MomentumBreakoutIvLagSignal,
  PostEarningsIvCrushSignal,
} from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import {
  scanPanicReversal,
  type PanicReversalScanInput,
  type PanicReversalConfig,
} from './panic-reversal-scanner.js';
import {
  scanMomentumBreakoutIvLag,
  type MomentumBreakoutScanInput,
  type MomentumBreakoutIvLagConfig,
} from './momentum-breakout-iv-lag-scanner.js';
import {
  scanPostEarningsIvCrush,
  type PostEarningsIvCrushScanInput,
  type PostEarningsIvCrushConfig,
} from './post-earnings-iv-crush-scanner.js';

export interface SwingSignalCandidate {
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal;
  score: number;
  breakdown: SignalScoreBreakdown;
}

export interface SignalScoreBreakdown {
  /** Technical score (0-100): price action, volume, momentum */
  technical: number;
  /** Momentum score (0-100): trend strength, velocity */
  momentum: number;
  /** Mean reversion score (0-100): oversold/overbought, reversal signals */
  meanReversion: number;
  /** Relative strength (0-100): vs sector/index */
  relativeStrength: number;
  /** IV/RV score (0-100): implied vs realized volatility spread */
  ivRv: number;
  /** IV skew score (0-100): put/call skew analysis */
  ivSkew: number;
  /** OTM mispricing score (0-100): option cheapness */
  otmMispricing: number;
  /** Liquidity score (0-100): bid/ask spread, volume */
  liquidity: number;
}

export interface FusionEngineConfig {
  panicReversal?: PanicReversalConfig;
  momentumBreakout?: MomentumBreakoutIvLagConfig;
  postEarningsIvCrush?: PostEarningsIvCrushConfig;
  /** Weight for each scoring dimension (default: equal weight) */
  weights?: Partial<SignalScoreBreakdown>;
  /** Minimum composite score to return (default: 60) */
  minScore?: number;
  /** Maximum signals to return (default: 10) */
  maxSignals?: number;
}

export interface FusionScanInput {
  symbol: string;
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivPercentile: number;
  ivRank?: number;
  currentPrice: number;

  // Optional enrichment data
  avgVolume?: number;
  relativeStrength?: number;
  supportLevel?: number;
  resistanceLevel?: number;
  atr?: number;
  realizedVol?: number; // Historical realized volatility
  sectorIv?: number; // Sector average IV for comparison

  // Earnings-specific
  earningsDate?: Date | number;
  ivPercentilePriorToEarnings?: number;
  openingPriceOnEarningsDay?: number;

  // Risk-free rate
  riskFreeRate?: number;
}

const DEFAULT_WEIGHTS: SignalScoreBreakdown = {
  technical: 0.15,
  momentum: 0.15,
  meanReversion: 0.10,
  relativeStrength: 0.15,
  ivRv: 0.15,
  ivSkew: 0.15,
  otmMispricing: 0.10,
  liquidity: 0.05,
};

/**
 * Run all swing scanners and return ranked candidates.
 */
export function scanAndRankSwingSignals(
  input: FusionScanInput,
  config: FusionEngineConfig = {},
): SwingSignalCandidate[] {
  const candidates: SwingSignalCandidate[] = [];
  const weights = { ...DEFAULT_WEIGHTS, ...config.weights };
  const minScore = config.minScore ?? 60;
  const maxSignals = config.maxSignals ?? 10;

  // Run each scanner
  const signals: Array<PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal | null> = [];

  // 1. Panic Reversal Scanner
  if (input.ivRank !== undefined) {
    try {
      const prSignal = scanPanicReversal(
        {
          symbol: input.symbol,
          candles: input.candles,
          optionChain: input.optionChain,
          ivRank: input.ivRank,
          currentPrice: input.currentPrice,
          supportLevel: input.supportLevel,
          atr: input.atr,
          riskFreeRate: input.riskFreeRate,
        },
        config.panicReversal,
      );
      if (prSignal) signals.push(prSignal);
    } catch (err) {
      console.warn('Panic reversal scanner error:', err);
    }
  }

  // 2. Momentum Breakout + IV Lag Scanner
  if (input.avgVolume) {
    try {
      const mbSignal = scanMomentumBreakoutIvLag(
        {
          symbol: input.symbol,
          candles: input.candles,
          optionChain: input.optionChain,
          ivPercentile: input.ivPercentile,
          currentPrice: input.currentPrice,
          avgVolume: input.avgVolume,
          relativeStrength: input.relativeStrength,
          riskFreeRate: input.riskFreeRate,
        },
        config.momentumBreakout,
      );
      if (mbSignal) signals.push(mbSignal);
    } catch (err) {
      console.warn('Momentum breakout scanner error:', err);
    }
  }

  // 3. Post-Earnings IV Crush Scanner
  if (input.earningsDate) {
    try {
      const peSignal = scanPostEarningsIvCrush(
        {
          symbol: input.symbol,
          candles: input.candles,
          optionChain: input.optionChain,
          ivPercentile: input.ivPercentile,
          ivPercentilePriorToEarnings: input.ivPercentilePriorToEarnings,
          earningsDate: input.earningsDate,
          currentPrice: input.currentPrice,
          openingPriceOnEarningsDay: input.openingPriceOnEarningsDay,
          relativeStrength: input.relativeStrength,
          resistanceLevel: input.resistanceLevel,
          supportLevel: input.supportLevel,
          riskFreeRate: input.riskFreeRate,
        },
        config.postEarningsIvCrush,
      );
      if (peSignal) signals.push(peSignal);
    } catch (err) {
      console.warn('Post-earnings IV crush scanner error:', err);
    }
  }

  // Score each signal
  for (const signal of signals) {
    if (!signal) continue;

    const breakdown = scoreSignal(signal, input);
    const compositeScore = calculateCompositeScore(breakdown, weights);

    if (compositeScore >= minScore) {
      candidates.push({
        signal,
        score: compositeScore,
        breakdown,
      });
    }
  }

  // Sort by score descending and limit
  return candidates
    .sort((a, b) => b.score - a.score)
    .slice(0, maxSignals);
}

/**
 * Score a signal across all dimensions.
 */
function scoreSignal(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): SignalScoreBreakdown {
  return {
    technical: scoreTechnical(signal, input),
    momentum: scoreMomentum(signal, input),
    meanReversion: scoreMeanReversion(signal, input),
    relativeStrength: scoreRelativeStrength(signal, input),
    ivRv: scoreIvRv(signal, input),
    ivSkew: scoreIvSkew(signal, input),
    otmMispricing: scoreOtmMispricing(signal, input),
    liquidity: scoreLiquidity(signal, input),
  };
}

/**
 * Calculate weighted composite score.
 */
function calculateCompositeScore(
  breakdown: SignalScoreBreakdown,
  weights: SignalScoreBreakdown,
): number {
  return (
    breakdown.technical * weights.technical +
    breakdown.momentum * weights.momentum +
    breakdown.meanReversion * weights.meanReversion +
    breakdown.relativeStrength * weights.relativeStrength +
    breakdown.ivRv * weights.ivRv +
    breakdown.ivSkew * weights.ivSkew +
    breakdown.otmMispricing * weights.otmMispricing +
    breakdown.liquidity * weights.liquidity
  );
}

// Scoring functions for each dimension

function scoreTechnical(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  let score = 50; // Base

  // Risk/reward ratio contribution
  if (signal.riskRewardRatio > 3) score += 30;
  else if (signal.riskRewardRatio > 2) score += 20;
  else if (signal.riskRewardRatio > 1.5) score += 10;

  // Delta appropriateness (closer to 0.30 is ideal)
  const deltaScore = Math.max(0, 100 - Math.abs(Math.abs(signal.delta) - 0.30) * 200);
  score += deltaScore * 0.2;

  return Math.min(100, score);
}

function scoreMomentum(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  if (signal.type === 'momentum_breakout_iv_lag') {
    return signal.momentumScore;
  }

  // For other types, estimate from price action
  if (input.candles.length < 10) return 50;

  const recent = input.candles.slice(-10);
  const priceChange = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close) * 100;

  return Math.min(100, Math.abs(priceChange) * 5); // 20% move = 100 score
}

function scoreMeanReversion(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  if (signal.type === 'panic_reversal') {
    return signal.reversalScore;
  }

  // Not applicable for momentum/earnings strategies
  return 50;
}

function scoreRelativeStrength(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  if ('relativeStrength' in signal && signal.relativeStrength !== undefined) {
    return signal.relativeStrength;
  }

  return input.relativeStrength ?? 50;
}

function scoreIvRv(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  if (!input.realizedVol) return 50;

  // Estimate IV from signal context
  let currentIv = 0.30; // Default

  if (signal.type === 'panic_reversal') {
    currentIv = 0.40 + (signal.ivRank / 100) * 0.30; // Higher IV for panic
  } else if (signal.type === 'momentum_breakout_iv_lag') {
    currentIv = 0.25 + (signal.ivPercentile / 100) * 0.20; // Lower IV
  } else if (signal.type === 'post_earnings_iv_crush') {
    currentIv = 0.20 + (signal.ivPercentile / 100) * 0.25; // Crushed IV
  }

  const ivRvSpread = currentIv - input.realizedVol;

  // Negative spread = IV < RV = options cheap = good score
  if (ivRvSpread < -0.05) return 90;
  if (ivRvSpread < 0) return 70;
  if (ivRvSpread < 0.05) return 50;
  return 30;
}

function scoreIvSkew(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  if (signal.type === 'panic_reversal') {
    // Put/call skew is directly measured
    return Math.min(100, ((signal.putCallSkew - 1.0) / 0.5) * 100);
  }

  // For other types, estimate from option type and direction
  return 50;
}

function scoreOtmMispricing(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  // All these strategies target OTM mispricing opportunities
  // Score based on how "cheap" the option should be

  if (signal.type === 'post_earnings_iv_crush') {
    // Lower IV percentile = cheaper options = higher score
    return 100 - signal.ivPercentile;
  }

  if (signal.type === 'momentum_breakout_iv_lag') {
    // IV hasn't caught up = cheap
    return 100 - signal.ivPercentile * 1.5; // Penalize higher IV percentiles
  }

  if (signal.type === 'panic_reversal') {
    // Calls should be cheap despite elevated overall IV
    return 75; // Moderate - skew makes calls cheaper
  }

  return 50;
}

function scoreLiquidity(
  signal: PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal,
  input: FusionScanInput,
): number {
  if (!signal.bid || !signal.ask || signal.mark === 0) return 0;

  const spread = signal.ask - signal.bid;
  const spreadPct = (spread / signal.mark) * 100;

  // Tighter spread = higher score
  if (spreadPct < 5) return 95;
  if (spreadPct < 10) return 80;
  if (spreadPct < 15) return 60;
  if (spreadPct < 25) return 40;
  return 20;
}

/**
 * Format a fusion candidate for display.
 */
export function formatSwingSignalCandidate(candidate: SwingSignalCandidate): string {
  const { signal, score, breakdown } = candidate;

  const lines = [
    `${signal.symbol} ${signal.side.toUpperCase()} — ${score.toFixed(0)}/100`,
    `Strategy: ${signal.type}`,
    `Option: ${signal.optionType} $${signal.strike} exp ${signal.expiration}`,
    `Entry: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(2)}`,
    `Stop: $${signal.stopLoss.toFixed(2)} | Target: $${signal.takeProfit.toFixed(2)}`,
    `R:R: ${signal.riskRewardRatio.toFixed(2)}`,
    ``,
    `Score Breakdown:`,
    `  Technical: ${breakdown.technical.toFixed(0)}`,
    `  Momentum: ${breakdown.momentum.toFixed(0)}`,
    `  Relative Strength: ${breakdown.relativeStrength.toFixed(0)}`,
    `  IV/RV: ${breakdown.ivRv.toFixed(0)}`,
    `  IV Skew: ${breakdown.ivSkew.toFixed(0)}`,
    `  OTM Mispricing: ${breakdown.otmMispricing.toFixed(0)}`,
    `  Liquidity: ${breakdown.liquidity.toFixed(0)}`,
  ];

  return lines.join('\n');
}
