/**
 * TRA-731 (Phase 2, Track A) — equity-signal baseline validation.
 *
 * The cheap, methodology-independent kill-switch QuantTrader runs FIRST: if the
 * underlying SupertrendConfluence directional signal has no edge on the equity
 * bars, no options overlay can rescue it, so Track B (synthetic-chain replay) is
 * not worth running.
 *
 * Validates the SupertrendConfluence entry signal on >=12mo equity bars via the
 * existing `agent-scoring` primitives (`scoreSignal` / `summarizeAccuracy`),
 * reporting hit-rate + avg R, against TWO baselines:
 *   1. macd-trend — the existing trend strategy's signals, scored identically.
 *   2. delta-equivalent buy-and-hold — long the underlying continuously; total
 *      return, annualized Sharpe, max DD over the window.
 *
 * Pure & deterministic (signal `id`s aside): no network, no LLM spend.
 */

import {
  evaluateSupertrendConfluence,
  MacdTrendStrategy,
  type SupertrendConfluenceParams,
} from '@trading-app/engine';
import type { Candle, EodSignalAccuracy } from '@trading-app/shared';
import { scoreSignal, summarizeAccuracy, type ScoredSignal } from './agent-scoring.js';
import { annualizedSharpe, maxDrawdown } from './tra731-metrics.js';

export interface TrackAOptions {
  /** Bars of look-forward each signal is scored over. Default 20. */
  horizonBars: number;
  /** SupertrendConfluence params (sweepable). MTF confirm is off on daily bars. */
  confluence: SupertrendConfluenceParams;
  /** Minimum bars before a signal is evaluated. Default 60. */
  warmupBars: number;
}

export const DEFAULT_TRACK_A: TrackAOptions = {
  horizonBars: 20,
  confluence: {},
  warmupBars: 60,
};

export interface BuyHoldStat {
  symbol: string;
  bars: number;
  totalReturnPct: number;
  annualizedSharpe: number;
  maxDrawdownPct: number;
}

export interface SymbolTrackAResult {
  symbol: string;
  bars: number;
  supertrend: EodSignalAccuracy;
  macdTrend: EodSignalAccuracy;
  buyHold: BuyHoldStat;
}

/** Score one symbol's SupertrendConfluence + macd-trend signals + buy-hold baseline. */
export function trackASymbol(
  symbol: string,
  bars: readonly Candle[],
  opts: TrackAOptions = DEFAULT_TRACK_A,
): SymbolTrackAResult {
  const stScored: ScoredSignal[] = [];
  const macdScored: ScoredSignal[] = [];
  const macd = new MacdTrendStrategy({ enforceTimeFilter: false });
  const candles = bars as Candle[];

  for (let i = opts.warmupBars; i < bars.length; i += 1) {
    const prefix = candles.slice(0, i + 1);

    const stSignal = evaluateSupertrendConfluence(symbol, prefix, null, {
      ...opts.confluence,
      requireConfirmTrend: false,
    });
    if (stSignal) stScored.push(scoreSignal(stSignal, candles, i, opts.horizonBars));

    const macdSignal = macd.evaluate(symbol, prefix);
    if (macdSignal) macdScored.push(scoreSignal(macdSignal, candles, i, opts.horizonBars));
  }

  return {
    symbol,
    bars: bars.length,
    supertrend: summarizeAccuracy(stScored),
    macdTrend: summarizeAccuracy(macdScored),
    buyHold: buyHoldStat(symbol, bars),
  };
}

/** Delta-equivalent buy-and-hold: long the underlying for the whole window. */
export function buyHoldStat(symbol: string, bars: readonly Candle[]): BuyHoldStat {
  if (bars.length < 2) {
    return { symbol, bars: bars.length, totalReturnPct: 0, annualizedSharpe: 0, maxDrawdownPct: 0 };
  }
  const first = bars[0].close;
  const last = bars[bars.length - 1].close;
  const dailyReturns: number[] = [];
  const equityCurve: number[] = [];
  for (let i = 1; i < bars.length; i += 1) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (prev > 0) dailyReturns.push((cur - prev) / prev);
    equityCurve.push(cur);
  }
  return {
    symbol,
    bars: bars.length,
    totalReturnPct: first > 0 ? (last - first) / first : 0,
    annualizedSharpe: annualizedSharpe(dailyReturns),
    maxDrawdownPct: maxDrawdown(equityCurve).pct,
  };
}

export interface TrackAReport {
  perSymbol: SymbolTrackAResult[];
  /** Pooled SupertrendConfluence accuracy across all symbols. */
  supertrend: EodSignalAccuracy;
  macdTrend: EodSignalAccuracy;
  edgeVsMacd: { winRateDelta: number; avgRDelta: number };
  /** Mean buy-hold total return across symbols. */
  avgBuyHoldReturnPct: number;
  horizonBars: number;
}

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

function poolAccuracy(parts: EodSignalAccuracy[]): EodSignalAccuracy {
  const totalSignals = parts.reduce((a, p) => a + p.totalSignals, 0);
  const winningSignals = parts.reduce((a, p) => a + p.winningSignals, 0);
  // Weighted avg R by signal count.
  const weightedR = parts.reduce((a, p) => a + p.avgRR * p.totalSignals, 0);
  return {
    totalSignals,
    winningSignals,
    winRate: totalSignals > 0 ? round(winningSignals / totalSignals) : 0,
    avgRR: totalSignals > 0 ? round(weightedR / totalSignals) : 0,
  };
}

/** Run Track A across the universe and pool the per-symbol results. */
export function runTrackA(
  barsBySymbol: ReadonlyMap<string, readonly Candle[]>,
  opts: TrackAOptions = DEFAULT_TRACK_A,
): TrackAReport {
  const perSymbol: SymbolTrackAResult[] = [];
  for (const [symbol, bars] of barsBySymbol) {
    perSymbol.push(trackASymbol(symbol, bars, opts));
  }
  const supertrend = poolAccuracy(perSymbol.map((s) => s.supertrend));
  const macdTrend = poolAccuracy(perSymbol.map((s) => s.macdTrend));
  const avgBuyHoldReturnPct =
    perSymbol.length > 0 ? perSymbol.reduce((a, s) => a + s.buyHold.totalReturnPct, 0) / perSymbol.length : 0;
  return {
    perSymbol,
    supertrend,
    macdTrend,
    edgeVsMacd: {
      winRateDelta: round(supertrend.winRate - macdTrend.winRate),
      avgRDelta: round(supertrend.avgRR - macdTrend.avgRR),
    },
    avgBuyHoldReturnPct: round(avgBuyHoldReturnPct),
    horizonBars: opts.horizonBars,
  };
}
