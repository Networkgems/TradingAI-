/**
 * TRA-4570 — Panic Reversal Scanner
 *
 * Detects big selloff → stabilization → reversal setups for OTM call entries.
 *
 * Setup (DAILY bars — TRA-4706):
 * - A peak-to-trough decline ≥5% inside the lookback window (the panic)
 * - A bounce off the trough: the trough is not the latest bar and the latest
 *   close is above the trough close (the stabilization)
 * - RSI(14) back at or above `minRsi` (the reversal confirmation)
 * - Elevated IV rank + steep wing skew (the surface is still pricing the panic)
 * - Not yet run away from the low (≤ `maxSupportDistanceAtr` ATRs off it)
 *
 * Entry: 0.25–0.40 delta OTM call, 25–60 DTE
 * Thesis: Option surface still pricing panic while underlying reverses
 *
 * ⛔ TRA-4706 — why the decline is PEAK-TO-TROUGH and not "latest vs N bars ago".
 * The first cut required the LATEST close to still be ≥5% below the close N bars
 * back AND RSI ≥ 35 on that same bar: it demanded the stock be mid-collapse and
 * already recovered at once. A decline deep enough to clear −5% drags RSI(14)
 * under 35, so the mock fixture could not be satisfied, and neither could the
 * tape. The panic and the reversal are two moments; they are now measured as two.
 */

import type { Candle, PanicReversalSignal } from '@trading-app/shared';
import type { OptionChainRow } from '@trading-app/engine';
import { randomUUID } from 'crypto';
import { rsi, daysToExpiration } from '@trading-app/engine';
import { pickDeltaBandOption, underlyingRiskReward } from './swing-scanner-common.js';

export interface PanicReversalConfig {
  /** Minimum peak-to-trough decline % to qualify as panic (default: 5.0) */
  minDeclinePct?: number;
  /** DAILY bars the peak and trough are searched in, ending at the latest bar (default: 10 ≈ two weeks) */
  declineLookbackBars?: number;
  /** Minimum IV rank to confirm elevated volatility (default: 60) */
  minIvRank?: number;
  /**
   * Minimum wing skew, ~5%-OTM put IV ÷ ~5%-OTM call IV on one expiry
   * (default: 1.15). ⚠️ Not calibrated on tape — observe-only until graded.
   */
  minPutCallSkew?: number;
  /** Target delta range for OTM calls */
  targetDeltaMin?: number;
  targetDeltaMax?: number;
  /** Target DTE range */
  dteMin?: number;
  dteMax?: number;
  /** Minimum RSI(14) on the latest bar for reversal confirmation (default: 35) */
  minRsi?: number;
  /** Maximum distance from the trough low, in ATRs (default: 2.0) */
  maxSupportDistanceAtr?: number;
}

export interface PanicReversalScanInput {
  symbol: string;
  /** DAILY bars, oldest first. */
  candles: Candle[];
  optionChain: OptionChainRow[];
  ivRank: number;
  currentPrice: number;
  /** Daily ATR(14); when present, gates how far price may have run off the low. */
  atr?: number;
  riskFreeRate?: number;
  /** Clock for DTE; defaults to now. */
  asOf?: number;
}

const DEFAULT_CONFIG: Required<PanicReversalConfig> = {
  minDeclinePct: 5.0,
  declineLookbackBars: 10,
  minIvRank: 60,
  minPutCallSkew: 1.15,
  targetDeltaMin: 0.25,
  targetDeltaMax: 0.40,
  dteMin: 25,
  dteMax: 60,
  minRsi: 35,
  maxSupportDistanceAtr: 2.0,
};

/** RSI(14) needs 15 closes. */
const RSI_PERIOD = 14;

/**
 * Scan for panic reversal setups.
 * Returns the best candidate OTM call signal, or null if no setup qualifies.
 */
export function scanPanicReversal(
  input: PanicReversalScanInput,
  config: PanicReversalConfig = {},
): PanicReversalSignal | null {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const { symbol, candles, optionChain, ivRank, currentPrice, atr, riskFreeRate = 0.04 } = input;
  const asOf = input.asOf ?? Date.now();

  if (candles.length < Math.max(cfg.declineLookbackBars + 1, RSI_PERIOD + 1)) return null;

  // 1. Panic: the deepest peak-to-trough drop inside the window (peak before trough).
  const last = candles.length - 1;
  const start = last - cfg.declineLookbackBars;
  let peakIdx = start;
  let best: { peakIdx: number; troughIdx: number; pct: number } | null = null;
  for (let i = start; i <= last; i++) {
    if (candles[i].close > candles[peakIdx].close) peakIdx = i;
    const pct = ((candles[i].close - candles[peakIdx].close) / candles[peakIdx].close) * 100;
    if (!best || pct < best.pct) best = { peakIdx, troughIdx: i, pct };
  }
  if (!best || best.pct > -cfg.minDeclinePct) return null;
  const peak = candles[best.peakIdx];
  const trough = candles[best.troughIdx];

  // 2. Stabilization: the trough is behind us and price is off it. (A trough ON
  //    the latest bar fails this too: its close cannot exceed itself.)
  const latest = candles[last];
  if (!(latest.close > trough.close)) return null;
  const bouncePct = ((latest.close - trough.close) / trough.close) * 100;

  // 3. IV rank gate — volatility should be elevated
  if (ivRank < cfg.minIvRank) return null;

  // 4. Reversal confirmation via RSI
  const currentRsi = rsi(candles.map((c) => c.close), RSI_PERIOD);
  if (isNaN(currentRsi) || currentRsi < cfg.minRsi) return null;

  // 5. Not already run away from the low. The panic low IS the support level.
  const troughLow = Math.min(...candles.slice(best.troughIdx, last + 1).map((c) => c.low));
  let supportDistance = 0;
  if (atr !== undefined && atr > 0) {
    supportDistance = (currentPrice - troughLow) / atr;
    if (supportDistance > cfg.maxSupportDistanceAtr) return null;
  }

  // 6. The surface is still pricing the panic
  const putCallSkew = wingSkew(optionChain, currentPrice, cfg, asOf);
  if (putCallSkew === null || putCallSkew < cfg.minPutCallSkew) return null;

  // 7. Best OTM call
  const pick = pickDeltaBandOption({
    chain: optionChain,
    optionType: 'call',
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

  // Underlying levels: a new low invalidates; a full retrace to the peak pays.
  const stopLoss = troughLow;
  const takeProfit = peak.close;
  const riskRewardRatio = underlyingRiskReward(currentPrice, stopLoss, takeProfit, 'bullish');
  if (riskRewardRatio === null) return null;

  const reversalScore = calculateReversalScore({
    rsi: currentRsi,
    ivRank,
    putCallSkew,
    supportDistance,
    recentDeclinePct: best.pct,
    config: cfg,
  });

  return {
    id: randomUUID(),
    symbol,
    type: 'panic_reversal',
    side: 'buy',
    optionSymbol: pick.row.optionSymbol ?? `${symbol}_${pick.row.expiration}_C_${pick.row.strike}`,
    optionType: 'call',
    strike: pick.row.strike,
    expiration: pick.row.expiration,
    mark: pick.mark,
    recentDeclinePct: best.pct,
    bouncePct,
    ivRank,
    putCallSkew,
    supportDistance,
    reversalScore,
    delta: pick.delta,
    rsi: currentRsi,
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
 * Wing skew on ONE expiry: IV of the put struck nearest 95% of spot ÷ IV of the
 * call struck nearest 105%, on the in-band expiry closest to the band's middle.
 *
 * ⛔ TRA-4706 — the first cut divided the ATM put IV by the ATM call IV. Put-call
 * parity pins those two together (same strike, same expiry ⇒ same σ up to
 * borrow/dividend noise), so that ratio sits at ~1.0 on every tape and the 1.3
 * gate could never pass. Skew is a WING property. Returns `null` (never 1.0)
 * when no expiry carries both wings — unreadable is not "no skew".
 */
export function wingSkew(
  chain: readonly OptionChainRow[],
  spot: number,
  cfg: Pick<Required<PanicReversalConfig>, 'dteMin' | 'dteMax'>,
  asOf: number,
): number | null {
  const byExp = new Map<string, OptionChainRow[]>();
  for (const r of chain) {
    if (!(r.midIv != null && r.midIv > 0)) continue;
    const dte = daysToExpiration(r.expiration, asOf);
    if (dte < cfg.dteMin || dte > cfg.dteMax) continue;
    const list = byExp.get(r.expiration);
    if (list) list.push(r);
    else byExp.set(r.expiration, [r]);
  }
  const mid = (cfg.dteMin + cfg.dteMax) / 2;
  const exps = [...byExp.keys()].sort(
    (a, b) => Math.abs(daysToExpiration(a, asOf) - mid) - Math.abs(daysToExpiration(b, asOf) - mid),
  );
  for (const exp of exps) {
    const rows = byExp.get(exp)!;
    const nearest = (type: 'put' | 'call', target: number) => rows
      .filter((r) => r.optionType === type && (type === 'put' ? r.strike < spot : r.strike > spot))
      .sort((a, b) => Math.abs(a.strike - target) - Math.abs(b.strike - target))[0];
    const put = nearest('put', spot * 0.95);
    const call = nearest('call', spot * 1.05);
    if (put?.midIv && call?.midIv) return put.midIv / call.midIv;
  }
  return null;
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
  const rsiScore = Math.max(0, Math.min(100, ((rsi - 30) / 20) * 100));

  // IV rank score (higher = more elevated volatility)
  const ivScore = Math.min(100, ivRank);

  // Skew score (higher skew = more put richness)
  const skewScore = Math.max(0, Math.min(100, ((putCallSkew - 1.0) / 0.5) * 100));

  // Support proximity score (closer to the low = better risk/reward)
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
