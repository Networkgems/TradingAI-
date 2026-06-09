/**
 * TRA-731 — shared performance-metric helpers for the Phase-2 synthetic-chain
 * backtest harness (Track A signal validation + Track B options replay).
 *
 * Everything here is pure and dependency-light. Profit factor reuses the same
 * {@link PROFIT_FACTOR_CAP} the live promotion gate uses so a zero-loss run is
 * JSON-safe and reads the same across reports. Sharpe / Sortino are reported
 * per-trade (mean / dispersion of the trade-R series), matching the codebase's
 * existing `sharpeRatio` convention (TRA-208) — NOT annualized, so they are
 * directly comparable cell-to-cell in the sweep regardless of trade count.
 */

import { PROFIT_FACTOR_CAP } from '@trading-app/shared';

export { PROFIT_FACTOR_CAP };

/** Sample standard deviation (n−1). Returns 0 for fewer than two samples. */
export function stdev(xs: readonly number[]): number {
  if (xs.length < 2) return 0;
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (xs.length - 1);
  return Math.sqrt(variance);
}

/**
 * Target-downside deviation about a 0 target: root of the mean squared negative
 * deviation, averaged over the FULL sample (the standard Sortino denominator).
 * Returns 0 only when there are no losing samples.
 */
export function downsideDeviation(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let sumSq = 0;
  let negatives = 0;
  for (const x of xs) {
    if (x < 0) {
      sumSq += x * x;
      negatives += 1;
    }
  }
  if (negatives === 0) return 0;
  return Math.sqrt(sumSq / xs.length);
}

/**
 * Profit factor = gross win / gross loss, clamped to {@link PROFIT_FACTOR_CAP}.
 * A run with no losses but some wins reads as the cap (finite); an empty / all-
 * flat run reads 0.
 */
export function profitFactor(pnls: readonly number[]): number {
  let grossWin = 0;
  let grossLoss = 0;
  for (const p of pnls) {
    if (p >= 0) grossWin += p;
    else grossLoss += -p;
  }
  if (grossLoss > 0) return Math.min(grossWin / grossLoss, PROFIT_FACTOR_CAP);
  return grossWin > 0 ? PROFIT_FACTOR_CAP : 0;
}

/** Per-trade Sharpe = mean(R) / stdev(R). 0 when fewer than two trades or zero variance. */
export function tradeSharpe(rs: readonly number[]): number {
  const sd = stdev(rs);
  if (sd <= 0) return 0;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  return mean / sd;
}

/** Per-trade Sortino = mean(R) / downsideDeviation(R). 0 when no usable downside. */
export function tradeSortino(rs: readonly number[]): number {
  const dd = downsideDeviation(rs);
  if (dd <= 0) return 0;
  const mean = rs.reduce((a, b) => a + b, 0) / rs.length;
  return mean / dd;
}

/** Max peak-to-trough drawdown of an equity curve, in currency and as a fraction of the peak. */
export function maxDrawdown(equityCurve: readonly number[]): { dollars: number; pct: number } {
  let peak = -Infinity;
  let maxDdDollars = 0;
  let maxDdPct = 0;
  for (const eq of equityCurve) {
    if (eq > peak) peak = eq;
    const dd = peak - eq;
    if (dd > maxDdDollars) maxDdDollars = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }
  return { dollars: maxDdDollars, pct: maxDdPct };
}

/** Annualized Sharpe of a daily-return series (× √252). 0 when too few points or zero variance. */
export function annualizedSharpe(dailyReturns: readonly number[], periodsPerYear = 252): number {
  const sd = stdev(dailyReturns);
  if (sd <= 0 || dailyReturns.length < 2) return 0;
  const mean = dailyReturns.reduce((a, b) => a + b, 0) / dailyReturns.length;
  return (mean / sd) * Math.sqrt(periodsPerYear);
}

/** Full summary of a closed-trade set keyed by per-trade R and absolute pnl. */
export interface TradeMetrics {
  trades: number;
  winners: number;
  winRate: number;
  avgR: number;
  /** Average winning R / average losing R magnitude — sanity vs win rate. */
  avgWin: number;
  avgLoss: number;
  profitFactor: number;
  sharpe: number;
  sortino: number;
  totalPnl: number;
  /**
   * Max peak-to-trough drawdown of the cumulative-R curve, in R units. Reported
   * in R (not % of equity) because trades are sized 1× with no bankroll, so a
   * "% of peak" figure would be ill-defined; R is sizing-independent.
   */
  maxDrawdownR: number;
}

/**
 * Summarize a closed-trade set. `rs` and `pnls` align index-for-index in trade
 * order. The drawdown is computed off the cumulative-R curve built from `rs`.
 */
export function summarizeTrades(rs: readonly number[], pnls: readonly number[]): TradeMetrics {
  const trades = rs.length;
  const winners = rs.filter((r) => r > 0).length;
  const wins = rs.filter((r) => r > 0);
  const losses = rs.filter((r) => r <= 0);
  const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

  // Cumulative-R curve for the drawdown.
  const cumR: number[] = [];
  let acc = 0;
  for (const r of rs) {
    acc += r;
    cumR.push(acc);
  }

  return {
    trades,
    winners,
    winRate: trades > 0 ? winners / trades : 0,
    avgR: mean(rs),
    avgWin: mean(wins),
    avgLoss: mean(losses),
    profitFactor: profitFactor(pnls),
    sharpe: tradeSharpe(rs),
    sortino: tradeSortino(rs),
    totalPnl: pnls.reduce((a, b) => a + b, 0),
    maxDrawdownR: maxDrawdown(cumR).dollars,
  };
}
