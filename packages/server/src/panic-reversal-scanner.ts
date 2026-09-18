/**
 * TRA-4570 — Panic Reversal Scanner
 *
 * Detects big selloff → stabilization → reversal setups for OTM call entries.
 *
 * Setup:
 * - Recent decline ≥5% (panic event)
 * - Elevated IV + steep put skew (market pricing downside)
 * - Price stabilization + reversal confirmation
 * - OTM call relatively cheap despite elevated IV
 *
 * Entry: 0.25–0.40 delta OTM call, 25–60 DTE
 * Thesis: Option surface still pricing panic while underlying reverses
 */

import type { Candle, PanicReversalSignal, OptionType } from '@trading-app/shared';
import type { TradierOptionsClient, OptionChainRow } from '@trading-app/engine';
import { randomUUID } from 'crypto';
import { rsi, blackScholesDelta, daysToExpiration } from '@trading-app/engine';

export interface PanicReversalConfig {
  /** Minimum decline % to qualify as panic (default: 5.0) */
  minDeclinePct?: number;
  /** Lookback bars for decline measurement (default: 5 = 2-3 days on 1h) */
  declineLookbackBars?: number;
  /** Minimum IV rank to confirm elevated volatility (default: 60) */
  minIvRank?: number;
  /** Minimum put/call skew ratio (default: 1.3 = puts 30% more expensive) */
  minPutCallSkew?: number;
  /** Target delta range for OTM calls */
  targetDeltaMin?: number;
  targetDeltaMax?: number;
  /** Target DTE range */
  dteMin?: number;
  dteMax?: number;
  /** Minimum RSI for reversal confirmation (default: 35 = recovering from oversold) */
  minRsi?: number;
  /** Maximum distance to support as % of ATR (default: 2.0) */
  maxSupportDistanceAtr?: number;
}

export interface PanicReversalScanInput {
  symbol: string;
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivRank: number;
  currentPrice: number;
  supportLevel?: number;
  atr?: number;
  riskFreeRate?: number;
}

const DEFAULT_CONFIG: Required<PanicReversalConfig> = {
  minDeclinePct: 5.0,
  declineLookbackBars: 5,
  minIvRank: 60,
  minPutCallSkew: 1.3,
  targetDeltaMin: 0.25,
  targetDeltaMax: 0.40,
  dteMin: 25,
  dteMax: 60,
  minRsi: 35,
  maxSupportDistanceAtr: 2.0,
};

/**
 * Scan for panic reversal setups.
 * Returns the best candidate OTM call signal, or null if no setup qualifies.
 */
export function scanPanicReversal(
  input: PanicReversalScanInput,
  config: PanicReversalConfig = {},
): PanicReversalSignal | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { symbol, candles, optionChain, ivRank, currentPrice, supportLevel, atr, riskFreeRate = 0.04 } = input;

  // Need sufficient candles for decline + reversal measurement
  if (candles.length < cfg.declineLookbackBars + 14) return null;

  // 1. Measure recent decline
  const closes = candles.map(c => c.close);
  const latest = candles[candles.length - 1];
  const lookbackPrice = candles[candles.length - cfg.declineLookbackBars].close;
  const recentDeclinePct = ((latest.close - lookbackPrice) / lookbackPrice) * 100;

  // Must be a real decline
  if (recentDeclinePct > -cfg.minDeclinePct) return null;

  // 2. IV rank gate — volatility should be elevated
  if (ivRank < cfg.minIvRank) return null;

  // 3. Reversal confirmation via RSI
  const currentRsi = rsi(closes, 14);
  if (isNaN(currentRsi) || currentRsi < cfg.minRsi) return null;

  // 4. Support distance check (if support provided)
  let supportDistance = 0;
  if (supportLevel !== undefined && atr !== undefined && atr > 0) {
    supportDistance = (currentPrice - supportLevel) / atr;
    if (supportDistance > cfg.maxSupportDistanceAtr) return null;
  }

  // 5. Calculate put/call skew from option chain
  const putCallSkew = calculatePutCallSkew(optionChain, currentPrice);
  if (putCallSkew < cfg.minPutCallSkew) return null;

  // 6. Find best OTM call candidate
  const now = Date.now();
  const callCandidates = optionChain
    .filter(row => row.optionType === 'call')
    .filter(row => {
      const dte = daysToExpiration(row.expiration, now);
      return dte >= cfg.dteMin && dte <= cfg.dteMax;
    })
    .filter(row => row.strike > currentPrice) // OTM
    .filter(row => row.bid && row.ask && row.bid > 0); // Liquid

  if (callCandidates.length === 0) return null;

  // Score candidates by delta proximity to target range
  const scoredCandidates = callCandidates.map(row => {
    const mark = (row.bid! + row.ask!) / 2;
    const dte = daysToExpiration(row.expiration, now);
    const iv = row.midIv ?? 0.3; // Fallback IV if missing

    const delta = blackScholesDelta({
      spot: currentPrice,
      strike: row.strike,
      timeToExpiryYears: dte / 365,
      volatility: iv,
      riskFreeRate: riskFreeRate,
      optionType: 'call',
    });

    // Score: closer to middle of target delta range = better
    const targetDeltaMid = (cfg.targetDeltaMin + cfg.targetDeltaMax) / 2;
    const deltaScore = 1 - Math.abs(delta - targetDeltaMid) / targetDeltaMid;

    return { row, mark, delta, deltaScore, dte, iv };
  });

  // Find best candidate within delta range
  const validCandidates = scoredCandidates
    .filter(c => c.delta >= cfg.targetDeltaMin && c.delta <= cfg.targetDeltaMax)
    .sort((a, b) => b.deltaScore - a.deltaScore);

  if (validCandidates.length === 0) return null;

  const best = validCandidates[0];

  // Calculate reversal score (0-100)
  const reversalScore = calculateReversalScore({
    rsi: currentRsi,
    ivRank,
    putCallSkew,
    supportDistance,
    recentDeclinePct,
    config: cfg,
  });

  // Entry/stop/target calculation
  const entryPrice = best.mark;
  // Stop: below support or -20% on option premium
  const stopLoss = supportLevel
    ? Math.max(supportLevel - (atr ?? 0), currentPrice * 0.97)
    : currentPrice * 0.97;
  // Target: +50% on option premium (conservative for swing)
  const takeProfit = currentPrice * 1.08; // Underlying target

  return {
    id: randomUUID(),
    symbol,
    type: 'panic_reversal',
    side: 'buy',
    optionSymbol: best.row.optionSymbol ?? `${symbol}_${best.row.expiration}_C_${best.row.strike}`,
    optionType: 'call',
    strike: best.row.strike,
    expiration: best.row.expiration,
    mark: best.mark,
    recentDeclinePct,
    ivRank,
    putCallSkew,
    supportDistance,
    reversalScore,
    delta: best.delta,
    rsi: currentRsi,
    entryPrice,
    stopLoss,
    takeProfit,
    riskRewardRatio: (takeProfit - entryPrice) / (entryPrice - stopLoss),
    timestamp: latest.timestamp,
    bid: best.row.bid,
    ask: best.row.ask,
  };
}

/**
 * Calculate put/call skew ratio.
 * Returns ratio of ATM put IV to ATM call IV.
 */
function calculatePutCallSkew(chain: OptionChainRow[], spot: number): number {
  // Find ATM or nearest strikes
  const sorted = [...chain].sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot));

  const atmPut = sorted.find(r => r.optionType === 'put' && r.midIv);
  const atmCall = sorted.find(r => r.optionType === 'call' && r.midIv);

  if (!atmPut?.midIv || !atmCall?.midIv) {
    return 1.0; // No skew data
  }

  return atmPut.midIv / atmCall.midIv;
}

/**
 * Calculate composite reversal score (0-100).
 * Higher score = stronger reversal setup.
 */
function calculateReversalScore(params: {
  rsi: number;
  ivRank: number;
  putCallSkew: number;
  supportDistance: number;
  recentDeclinePct: number;
  config: Required<PanicReversalConfig>;
}): number {
  const { rsi, ivRank, putCallSkew, supportDistance, recentDeclinePct, config } = params;

  // RSI recovery score (higher RSI from oversold = better)
  const rsiScore = Math.min(100, ((rsi - 30) / 20) * 100);

  // IV rank score (higher = more elevated volatility)
  const ivScore = Math.min(100, ivRank);

  // Skew score (higher skew = more put richness)
  const skewScore = Math.min(100, ((putCallSkew - 1.0) / 0.5) * 100);

  // Support proximity score (closer to support = better risk/reward)
  const supportScore = supportDistance > 0
    ? Math.max(0, 100 - (supportDistance / config.maxSupportDistanceAtr) * 100)
    : 50;

  // Decline severity score (bigger decline = bigger opportunity if it reverses)
  const declineScore = Math.min(100, (Math.abs(recentDeclinePct) / 10) * 100);

  // Weighted composite
  return (
    rsiScore * 0.25 +
    ivScore * 0.20 +
    skewScore * 0.25 +
    supportScore * 0.15 +
    declineScore * 0.15
  );
}
