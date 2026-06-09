import { describe, it, expect } from 'vitest';
import type { Candle } from '@trading-app/shared';
import { blackScholesDelta } from '@trading-app/engine';
import {
  profitFactor,
  tradeSharpe,
  tradeSortino,
  downsideDeviation,
  maxDrawdown,
  annualizedSharpe,
  summarizeTrades,
  PROFIT_FACTOR_CAP,
} from './tra731-metrics.js';
import {
  realizedVolatility,
  realizedVolSeries,
  ivRank,
  syntheticIv,
  buildSyntheticChain,
  roundStrike,
  DEFAULT_IV_MODEL,
} from './synthetic-chain.js';
import {
  replaySymbol,
  replayPortfolio,
  DEFAULT_REPLAY_PARAMS,
} from './supertrend-confluence-replay.js';
import { runTrackA, buyHoldStat } from './tra731-track-a.js';
import { trendingCandles, mixedRegimeCandles } from './synthetic.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Daily-spaced bar series from a list of closes (OHLC collapsed to close ± tiny wick). */
function dailyBars(symbol: string, closes: number[], startMs = Date.UTC(2025, 0, 2, 14)): Candle[] {
  return closes.map((close, i) => ({
    symbol,
    timestamp: startMs + i * DAY_MS,
    open: i === 0 ? close : closes[i - 1],
    high: close * 1.005,
    low: close * 0.995,
    close,
    volume: 1_000_000,
  }));
}

// ── tra731-metrics ────────────────────────────────────────────────────────────

describe('tra731-metrics', () => {
  it('profit factor = gross win / gross loss, capped when no losses', () => {
    expect(profitFactor([2, -1, 3, -1])).toBeCloseTo(5 / 2, 6);
    expect(profitFactor([1, 2, 3])).toBe(PROFIT_FACTOR_CAP);
    expect(profitFactor([])).toBe(0);
    expect(profitFactor([0, 0])).toBe(0);
  });

  it('sharpe = mean/stdev; sortino uses downside only', () => {
    const rs = [1, -1, 1, -1];
    expect(tradeSharpe(rs)).toBeCloseTo(0, 6); // zero mean
    expect(downsideDeviation([1, -1, -1])).toBeGreaterThan(0);
    expect(tradeSortino([2, 2, -1])).toBeGreaterThan(0);
    expect(tradeSharpe([1])).toBe(0); // too few
  });

  it('maxDrawdown finds the worst peak-to-trough', () => {
    const dd = maxDrawdown([100, 120, 90, 130, 80]);
    expect(dd.dollars).toBeCloseTo(50, 6); // 130 → 80
    expect(dd.pct).toBeCloseTo(50 / 130, 6);
  });

  it('annualizedSharpe scales by sqrt(periods)', () => {
    const s = annualizedSharpe([0.01, 0.02, -0.005, 0.015], 252);
    expect(Number.isFinite(s)).toBe(true);
    expect(annualizedSharpe([0.01], 252)).toBe(0);
  });

  it('summarizeTrades reports consistent counts', () => {
    const m = summarizeTrades([1, -1, 2], [100, -100, 200]);
    expect(m.trades).toBe(3);
    expect(m.winners).toBe(2);
    expect(m.winRate).toBeCloseTo(2 / 3, 6);
    expect(m.totalPnl).toBe(200);
    expect(m.profitFactor).toBeCloseTo(300 / 100, 6);
    // Cumulative-R curve 1 → 0 → 2: worst dip is 1R (peak 1 down to 0).
    expect(m.maxDrawdownR).toBeCloseTo(1, 6);
  });
});

// ── synthetic-chain + IV model ──────────────────────────────────────────────────

describe('synthetic-chain IV model', () => {
  it('realized vol is annualized and null on short history', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 * 1.001 ** i);
    const rv = realizedVolatility(closes, 20);
    expect(rv).not.toBeNull();
    expect(rv!).toBeGreaterThan(0);
    expect(realizedVolatility([100, 101], 20)).toBeNull();
  });

  it('ivRank is within [0,100] and null on degenerate range', () => {
    const series = [0.2, 0.3, 0.25, 0.4, 0.1];
    const r = ivRank(0.25, series);
    expect(r).not.toBeNull();
    expect(r!).toBeGreaterThanOrEqual(0);
    expect(r!).toBeLessThanOrEqual(100);
    expect(ivRank(0.2, [0.2, 0.2, 0.2])).toBeNull();
    expect(ivRank(0.2, [null, null])).toBeNull();
  });

  it('term structure makes longer-dated IV richer than short-dated', () => {
    const wk1 = syntheticIv(0.3, 7, DEFAULT_IV_MODEL);
    const wk6 = syntheticIv(0.3, 42, DEFAULT_IV_MODEL);
    expect(wk6).toBeGreaterThan(wk1);
    // Clamped to [minIv, maxIv].
    expect(syntheticIv(10, 30, DEFAULT_IV_MODEL)).toBeLessThanOrEqual(DEFAULT_IV_MODEL.maxIv);
    expect(syntheticIv(0.0001, 30, DEFAULT_IV_MODEL)).toBeGreaterThanOrEqual(DEFAULT_IV_MODEL.minIv);
  });

  it('roundStrike snaps to a sensible increment', () => {
    expect(roundStrike(10.2)).toBe(10); // <25 → 0.5 step
    expect(roundStrike(60.4)).toBe(60); // <100 → 1 step
    expect(roundStrike(101.3)).toBe(102.5); // <250 → 2.5 step
    expect(roundStrike(312)).toBe(310); // >=250 → 5 step
  });

  it('buildSyntheticChain emits priced call+put rows covering the delta band', () => {
    const closes = Array.from({ length: 60 }, (_, i) => 100 + Math.sin(i / 3) * 2 + i * 0.1);
    const bars = dailyBars('AAPL', closes);
    const file = buildSyntheticChain('AAPL', bars);
    expect(file).not.toBeNull();
    expect(file!.source).toBe('synthetic');
    expect(file!.symbol).toBe('AAPL');
    expect(file!.rows.length).toBeGreaterThan(0);
    // Every row priced > 0 with IV stamped and a non-crossed quote.
    for (const r of file!.rows) {
      expect(r.midIv).toBeGreaterThan(0);
      expect(r.smvVol).toBeGreaterThan(0);
      expect((r.ask ?? 0)).toBeGreaterThanOrEqual(r.bid ?? 0);
      expect(r.openInterest ?? 0).toBeGreaterThan(50); // passes scanner floor
    }
    // Coverage: at least one call with |delta| in 0.50–0.80 for a ~3wk expiry.
    const nowMs = file!.recordedAt;
    const hasBandStrike = file!.rows.some((r) => {
      if (r.optionType !== 'call') return false;
      const expMs = Date.parse(`${r.expiration}T16:00:00-04:00`);
      const T = (expMs - nowMs) / (365 * DAY_MS);
      if (T <= 0) return false;
      const d = Math.abs(
        blackScholesDelta({
          spot: file!.spot,
          strike: r.strike,
          timeToExpiryYears: T,
          riskFreeRate: 0.045,
          volatility: r.smvVol!,
          optionType: 'call',
        }),
      );
      return d >= 0.5 && d <= 0.8;
    });
    expect(hasBandStrike).toBe(true);
  });

  it('returns null without enough history for a realized-vol estimate', () => {
    const bars = dailyBars('X', [100, 101, 102]);
    expect(buildSyntheticChain('X', bars)).toBeNull();
  });

  it('realizedVolSeries is null during warm-up then defined', () => {
    const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
    const series = realizedVolSeries(closes, 20);
    expect(series[10]).toBeNull();
    expect(series[29]).not.toBeNull();
  });
});

// ── Track B replay ──────────────────────────────────────────────────────────────

describe('supertrend-confluence synthetic replay (Track B)', () => {
  it('replaySymbol runs and returns internally consistent metrics', () => {
    const bars = mixedRegimeCandles(400, 'NVDA', 120, 11);
    const result = replaySymbol('NVDA', bars, DEFAULT_REPLAY_PARAMS);
    expect(result.symbol).toBe('NVDA');
    expect(result.bars).toBe(bars.length);
    expect(result.metrics.winners).toBeLessThanOrEqual(result.metrics.trades);
    expect(result.metrics.trades).toBe(result.trades.length);
    expect(Number.isFinite(result.metrics.profitFactor)).toBe(true);
    expect(result.metrics.profitFactor).toBeLessThanOrEqual(PROFIT_FACTOR_CAP);
    // Every recorded trade is well-formed.
    for (const t of result.trades) {
      expect(t.exitDate >= t.entryDate).toBe(true);
      expect(Number.isFinite(t.r)).toBe(true);
      expect(t.entryPremium).toBeGreaterThan(0);
      expect(['call', 'put']).toContain(t.optionType);
    }
  });

  it('replayPortfolio pools per-symbol trades', () => {
    const map = new Map<string, Candle[]>([
      ['AMD', trendingCandles(300, 'AMD', 'up', 100, 3)],
      ['SPY', mixedRegimeCandles(300, 'SPY', 400, 5)],
    ]);
    const pf = replayPortfolio(map, DEFAULT_REPLAY_PARAMS);
    expect(pf.perSymbol.length).toBe(2);
    const pooled = pf.perSymbol.reduce((a, s) => a + s.metrics.trades, 0);
    expect(pf.totalTrades).toBe(pooled);
    expect(pf.totalSuppressed).toBeGreaterThanOrEqual(0);
  });

  it('a higher IV-rank cutoff (vertical threshold) never increases the trade count', () => {
    // Raising verticalMinIvRank routes fewer regimes to a (suppressed) vertical,
    // so tradeable single-leg entries are monotonic non-decreasing with the cutoff.
    const bars = mixedRegimeCandles(400, 'MSFT', 300, 9);
    const low = replaySymbol('MSFT', bars, {
      ...DEFAULT_REPLAY_PARAMS,
      ivGate: { singleLegMaxIvRank: 40, verticalMinIvRank: 30 },
    });
    const high = replaySymbol('MSFT', bars, {
      ...DEFAULT_REPLAY_PARAMS,
      ivGate: { singleLegMaxIvRank: 40, verticalMinIvRank: 95 },
    });
    expect(high.trades.length).toBeGreaterThanOrEqual(low.trades.length);
  });
});

// ── Track A ──────────────────────────────────────────────────────────────────────

describe('Track A equity-signal validation', () => {
  it('buyHoldStat reports total return / sharpe / drawdown', () => {
    const bars = dailyBars('SPY', Array.from({ length: 50 }, (_, i) => 100 * 1.002 ** i));
    const bh = buyHoldStat('SPY', bars);
    expect(bh.totalReturnPct).toBeGreaterThan(0);
    expect(Number.isFinite(bh.annualizedSharpe)).toBe(true);
    expect(bh.maxDrawdownPct).toBeGreaterThanOrEqual(0);
  });

  it('runTrackA pools accuracy and computes edge vs macd', () => {
    const map = new Map<string, Candle[]>([
      ['AMD', mixedRegimeCandles(350, 'AMD', 100, 1)],
      ['NVDA', mixedRegimeCandles(350, 'NVDA', 120, 2)],
    ]);
    const report = runTrackA(map);
    expect(report.perSymbol.length).toBe(2);
    expect(report.supertrend.winRate).toBeGreaterThanOrEqual(0);
    expect(report.supertrend.winRate).toBeLessThanOrEqual(1);
    expect(Number.isFinite(report.edgeVsMacd.avgRDelta)).toBe(true);
    expect(Number.isFinite(report.avgBuyHoldReturnPct)).toBe(true);
  });
});
