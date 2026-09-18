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
  PanicReversalSignal,
  MomentumBreakoutIvLagSignal,
  PostEarningsIvCrushSignal,
  SwingSignalCandidate,
  SignalScoreBreakdown,
} from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { scanPanicReversal, type PanicReversalConfig } from './panic-reversal-scanner.js';
import { scanMomentumBreakoutIvLag, type MomentumBreakoutIvLagConfig } from './momentum-breakout-iv-lag-scanner.js';
import { scanPostEarningsIvCrush, type PostEarningsIvCrushConfig } from './post-earnings-iv-crush-scanner.js';

// TRA-4706 — the candidate/breakdown shapes are the SHARED ones (they ride
// EngineState to the desktop); the first cut kept a local copy that could drift.
export type { SwingSignalCandidate, SignalScoreBreakdown };

export type SwingSignal = PanicReversalSignal | MomentumBreakoutIvLagSignal | PostEarningsIvCrushSignal;

export type SwingScoreWeights = Record<keyof SignalScoreBreakdown, number>;

export interface FusionEngineConfig {
  panicReversal?: PanicReversalConfig;
  momentumBreakout?: MomentumBreakoutIvLagConfig;
  postEarningsIvCrush?: PostEarningsIvCrushConfig;
  /** Weight for each scoring dimension (default: equal weight) */
  weights?: Partial<SwingScoreWeights>;
  /** Minimum composite score to return (default: 60) */
  minScore?: number;
  /** Maximum signals to return (default: 10) */
  maxSignals?: number;
}

export interface FusionScanInput {
  symbol: string;
  /**
   * DAILY bars, oldest first. ⛔ TRA-4706 — never the 5m `candleCache`: every
   * scanner here reads multi-day structure (a 5-month breakout level, a
   * two-week panic, the earnings reaction session), and 5m bars answer those
   * questions about the last few hours without failing.
   */
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivPercentile: number;
  ivRank?: number;
  currentPrice: number;

  // Optional enrichment data
  /** Average DAILY volume over the sessions before the latest bar. */
  avgVolume?: number;
  relativeStrength?: number;
  /** Daily ATR(14). */
  atr?: number;
  realizedVol?: number; // Historical realized volatility
  sectorIv?: number; // Sector average IV for comparison

  // Earnings-specific
  /** Most recent earnings date (`YYYY-MM-DD`) from the earnings store; absent ⇒ scanner skipped. */
  earningsDate?: string;
  ivPercentilePriorToEarnings?: number;

  // Risk-free rate
  riskFreeRate?: number;
  /** Clock for DTE; defaults to now. */
  asOf?: number;
}

/** What each scanner emitted, and what survived the composite-score cut. */
export interface SwingFusionResult {
  /** Every scanner signal BEFORE the min-score cut. */
  emitted: SwingSignal[];
  /** Survivors of the cut, best first, capped at `maxSignals`. */
  ranked: SwingSignalCandidate[];
}

const DEFAULT_WEIGHTS: SwingScoreWeights = {
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
): SwingFusionResult {
  const weights = { ...DEFAULT_WEIGHTS, ...config.weights };
  const minScore = config.minScore ?? 60;
  const maxSignals = config.maxSignals ?? 10;

  const emitted: SwingSignal[] = [];

  // 1. Panic Reversal Scanner
  if (input.ivRank !== undefined) {
    const prSignal = scanPanicReversal(
      {
        symbol: input.symbol,
        candles: input.candles,
        optionChain: input.optionChain,
        ivRank: input.ivRank,
        currentPrice: input.currentPrice,
        atr: input.atr,
        riskFreeRate: input.riskFreeRate,
        asOf: input.asOf,
      },
      config.panicReversal,
    );
    if (prSignal) emitted.push(prSignal);
  }

  // 2. Momentum Breakout + IV Lag Scanner
  if (input.avgVolume) {
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
        asOf: input.asOf,
      },
      config.momentumBreakout,
    );
    if (mbSignal) emitted.push(mbSignal);
  }

  // 3. Post-Earnings IV Crush Scanner
  if (input.earningsDate) {
    const peSignal = scanPostEarningsIvCrush(
      {
        symbol: input.symbol,
        candles: input.candles,
        optionChain: input.optionChain,
        ivPercentile: input.ivPercentile,
        ivPercentilePriorToEarnings: input.ivPercentilePriorToEarnings,
        earningsDate: input.earningsDate,
        currentPrice: input.currentPrice,
        relativeStrength: input.relativeStrength,
        riskFreeRate: input.riskFreeRate,
        asOf: input.asOf,
      },
      config.postEarningsIvCrush,
    );
    if (peSignal) emitted.push(peSignal);
  }

  // Score each signal
  const ranked: SwingSignalCandidate[] = [];
  for (const signal of emitted) {
    const breakdown = scoreSignal(signal, input);
    const compositeScore = calculateCompositeScore(breakdown, weights);
    if (compositeScore >= minScore) {
      ranked.push({ signal, score: compositeScore, breakdown });
    }
  }

  // Sort by score descending and limit
  return {
    emitted,
    ranked: ranked.sort((a, b) => b.score - a.score).slice(0, maxSignals),
  };
}

/**
 * Score a signal across all dimensions.
 */
function scoreSignal(signal: SwingSignal, input: FusionScanInput): SignalScoreBreakdown {
  return {
    technical: scoreTechnical(signal),
    momentum: scoreMomentum(signal, input),
    meanReversion: scoreMeanReversion(signal),
    relativeStrength: scoreRelativeStrength(signal, input),
    ivRv: scoreIvRv(signal, input),
    ivSkew: scoreIvSkew(signal),
    otmMispricing: scoreOtmMispricing(signal),
    liquidity: scoreLiquidity(signal),
  };
}

/**
 * Weighted mean over the MEASURED dimensions (`null` cells carry no weight).
 * Exported for the test that pins the renormalisation.
 */
export function calculateCompositeScore(
  breakdown: SignalScoreBreakdown,
  weights: SwingScoreWeights,
): number {
  let sum = 0;
  let weight = 0;
  for (const key of Object.keys(weights) as Array<keyof SignalScoreBreakdown>) {
    const v = breakdown[key];
    if (v === null) continue;
    sum += v * weights[key];
    weight += weights[key];
  }
  return weight > 0 ? sum / weight : 0;
}

// Scoring functions for each dimension. `null` = not measured for this signal.

function scoreTechnical(signal: SwingSignal): number {
  let score = 50; // Base

  // Risk/reward ratio contribution — underlying dollars on both legs (TRA-4706)
  if (signal.riskRewardRatio > 3) score += 30;
  else if (signal.riskRewardRatio > 2) score += 20;
  else if (signal.riskRewardRatio > 1.5) score += 10;

  // Delta appropriateness (closer to 0.30 is ideal)
  const deltaScore = Math.max(0, 100 - Math.abs(Math.abs(signal.delta) - 0.30) * 200);
  score += deltaScore * 0.2;

  return Math.min(100, score);
}

function scoreMomentum(signal: SwingSignal, input: FusionScanInput): number | null {
  if (signal.type === 'momentum_breakout_iv_lag') {
    return signal.momentumScore;
  }

  // For other types, estimate from the last 10 daily closes
  if (input.candles.length < 10) return null;

  const recent = input.candles.slice(-10);
  const priceChange = ((recent[recent.length - 1].close - recent[0].close) / recent[0].close) * 100;

  return Math.min(100, Math.abs(priceChange) * 5); // 20% move = 100 score
}

function scoreMeanReversion(signal: SwingSignal): number | null {
  // Only the panic setup measures one
  return signal.type === 'panic_reversal' ? signal.reversalScore : null;
}

function scoreRelativeStrength(_signal: SwingSignal, input: FusionScanInput): number | null {
  // ⛔ Only a SUPPLIED relative strength counts. The momentum signal carries
  // `relativeStrength ?? 50` for display; scoring that 50 would re-admit the
  // placeholder this breakdown exists to exclude.
  return input.relativeStrength ?? null;
}

function scoreIvRv(signal: SwingSignal, input: FusionScanInput): number | null {
  if (!input.realizedVol) return null;

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

function scoreIvSkew(signal: SwingSignal): number | null {
  // Wing skew is only measured by the panic setup
  if (signal.type !== 'panic_reversal') return null;
  return Math.max(0, Math.min(100, ((signal.putCallSkew - 1.0) / 0.5) * 100));
}

function scoreOtmMispricing(signal: SwingSignal): number {
  // All these strategies target OTM mispricing opportunities
  // Score based on how "cheap" the option should be

  if (signal.type === 'post_earnings_iv_crush') {
    // Lower IV percentile = cheaper options = higher score
    return 100 - signal.ivPercentile;
  }

  if (signal.type === 'momentum_breakout_iv_lag') {
    // IV hasn't caught up = cheap
    return Math.max(0, 100 - signal.ivPercentile * 1.5); // Penalize higher IV percentiles
  }

  // panic_reversal: calls should be cheap despite elevated overall IV
  return 75; // Moderate - skew makes calls cheaper
}

function scoreLiquidity(signal: SwingSignal): number | null {
  if (!signal.bid || !signal.ask || signal.mark === 0) return null;

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
  const cell = (v: number | null) => (v === null ? '—' : v.toFixed(0));

  const lines = [
    `${signal.symbol} ${signal.side.toUpperCase()} — ${score.toFixed(0)}/100`,
    `Strategy: ${signal.type}`,
    `Option: ${signal.optionType} $${signal.strike} exp ${signal.expiration}`,
    `Premium: $${signal.mark.toFixed(2)} | Delta: ${signal.delta.toFixed(2)}`,
    `Underlying $${signal.underlyingPrice.toFixed(2)} → Stop: $${signal.stopLoss.toFixed(2)} | Target: $${signal.takeProfit.toFixed(2)}`,
    `R:R (underlying): ${signal.riskRewardRatio.toFixed(2)}`,
    ``,
    `Score Breakdown:`,
    `  Technical: ${cell(breakdown.technical)}`,
    `  Momentum: ${cell(breakdown.momentum)}`,
    `  Mean Reversion: ${cell(breakdown.meanReversion)}`,
    `  Relative Strength: ${cell(breakdown.relativeStrength)}`,
    `  IV/RV: ${cell(breakdown.ivRv)}`,
    `  IV Skew: ${cell(breakdown.ivSkew)}`,
    `  OTM Mispricing: ${cell(breakdown.otmMispricing)}`,
    `  Liquidity: ${cell(breakdown.liquidity)}`,
  ];

  return lines.join('\n');
}
