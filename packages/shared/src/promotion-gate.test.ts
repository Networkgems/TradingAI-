import { describe, it, expect } from 'vitest';
import {
  DEFAULT_PROMOTION_THRESHOLDS,
  computePaperGateMetrics,
  evaluateBacktestGate,
  evaluatePaperGate,
  evaluatePromotion,
  PROFIT_FACTOR_CAP,
  type BacktestGateMetrics,
  type PromotionTradeSample,
} from './promotion-gate.js';

// A backtest report that clears every Stage-1 threshold.
const PASSING_BT: BacktestGateMetrics = {
  sharpe: 1.4,
  expectancy: 0.2,
  profitFactor: 1.6,
  maxDrawdown: 0.12,
  tradeCount: 140,
};

/**
 * Build N paper trades with a fixed risk distance so R = pnl / (risk*qty) is
 * controllable. risk distance = 1, qty = 1 → R == pnl.
 */
function trade(pnl: number, extra: Partial<PromotionTradeSample> = {}): PromotionTradeSample {
  return { pnl, entryPrice: 100, stopLoss: 99, quantity: 1, ...extra };
}

describe('computePaperGateMetrics — metrics are derived from the ledger, not hand-entered', () => {
  it('computes expectancy as mean R, profit factor, and per-trade Sharpe', () => {
    // R values: +2, +2, -1, -1, +1  → mean = 0.6
    const trades = [trade(2), trade(2), trade(-1), trade(-1), trade(1)];
    const m = computePaperGateMetrics(trades);
    expect(m.tradeCount).toBe(5);
    expect(m.expectancy).toBeCloseTo(0.6, 6);
    // grossWin = 5, grossLoss = 2 → PF = 2.5
    expect(m.profitFactor).toBeCloseTo(2.5, 6);
    expect(m.sharpe).toBeGreaterThan(0);
  });

  it('caps profit factor when there are no losses (JSON-safe, not Infinity)', () => {
    const m = computePaperGateMetrics([trade(1), trade(2), trade(3)]);
    expect(m.profitFactor).toBe(PROFIT_FACTOR_CAP);
    expect(Number.isFinite(m.profitFactor)).toBe(true);
  });

  it('ignores trades with no pnl and trades with zero risk distance for R', () => {
    const trades: PromotionTradeSample[] = [
      trade(2),
      { entryPrice: 100, stopLoss: 99, quantity: 1 }, // no pnl → ignored entirely
      { pnl: 5, entryPrice: 100, stopLoss: 100, quantity: 1 }, // zero risk → counts for PF/count, not R
    ];
    const m = computePaperGateMetrics(trades);
    // two trades carry pnl
    expect(m.tradeCount).toBe(2);
    // only the first has a valid R → expectancy = 2
    expect(m.expectancy).toBeCloseTo(2, 6);
  });

  it('reports slippageRatio only when modeled slippage is instrumented; else null', () => {
    const noSlip = computePaperGateMetrics([trade(1), trade(-1)]);
    expect(noSlip.slippageRatio).toBeNull();
    expect(noSlip.slippageSampleSize).toBe(0);

    const withSlip = computePaperGateMetrics([
      trade(1, { realizedSlippage: 2, modeledSlippage: 2 }),
      trade(-1, { realizedSlippage: 1, modeledSlippage: 1 }),
    ]);
    expect(withSlip.slippageRatio).toBeCloseTo(1, 6);
    expect(withSlip.slippageSampleSize).toBe(2);
  });
});

describe('evaluateBacktestGate (Stage 1)', () => {
  it('passes when all thresholds are met', () => {
    expect(evaluateBacktestGate(PASSING_BT).state).toBe('pass');
  });

  it('is missing when no report is registered', () => {
    expect(evaluateBacktestGate(null).state).toBe('missing');
  });

  it('fails and names each unmet threshold', () => {
    const r = evaluateBacktestGate({
      sharpe: 0.5,
      expectancy: -0.1,
      profitFactor: 1.0,
      maxDrawdown: 0.3,
      tradeCount: 40,
    });
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/Sharpe/);
    expect(r.failedChecks.join(' ')).toMatch(/expectancy/);
    expect(r.failedChecks.join(' ')).toMatch(/profit factor/);
    expect(r.failedChecks.join(' ')).toMatch(/drawdown/);
    expect(r.failedChecks.join(' ')).toMatch(/trade count/);
    expect(r.failedChecks).toHaveLength(5);
  });
});

describe('evaluatePaperGate (Stage 2)', () => {
  // 60 strong paper trades: alternating +2 / +1 with a few losers → positive expectancy.
  // 50 winners of +1.5, 10 small losers of -0.5 → mean R ≈ 1.17, Sharpe ≈ 1.5,
  // comfortably clearing every Stage-2 threshold.
  const strongPaper = computePaperGateMetrics(
    Array.from({ length: 60 }, (_, i) => trade(i % 6 === 0 ? -0.5 : 1.5)),
  );

  it('passes when count, expectancy, ratio, and Sharpe clear thresholds', () => {
    const r = evaluatePaperGate(strongPaper, PASSING_BT);
    expect(r.state).toBe('pass');
  });

  it('is missing with no paper trades', () => {
    expect(evaluatePaperGate(null, PASSING_BT).state).toBe('missing');
  });

  it('fails when paper expectancy collapses below 0.5x backtest (overfit signal)', () => {
    // backtest expectancy 0.2 → floor 0.1. Paper expectancy ~0.02 (tiny edge).
    const weak = computePaperGateMetrics(
      Array.from({ length: 60 }, (_, i) => trade(i % 2 === 0 ? 0.5 : -0.46)),
    );
    const r = evaluatePaperGate(weak, PASSING_BT);
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/overfit/);
  });

  it('fails when fewer than 50 monitored trades', () => {
    const few = computePaperGateMetrics(Array.from({ length: 20 }, () => trade(1)));
    const r = evaluatePaperGate(few, PASSING_BT);
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/trade count/);
  });

  it('treats unverified slippage as advisory (does not fail the stage)', () => {
    expect(strongPaper.slippageRatio).toBeNull();
    expect(evaluatePaperGate(strongPaper, PASSING_BT).state).toBe('pass');
  });

  it('fails when realized slippage exceeds 1.5x modeled', () => {
    const slipped = computePaperGateMetrics(
      Array.from({ length: 60 }, (_, i) =>
        trade(i % 5 === 0 ? -1 : 1, { realizedSlippage: 2, modeledSlippage: 1 }),
      ),
    );
    const r = evaluatePaperGate(slipped, PASSING_BT);
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/slippage/);
  });
});

describe('evaluatePromotion — overall verdict (the one-line rule)', () => {
  // 50 winners of +1.5, 10 small losers of -0.5 → mean R ≈ 1.17, Sharpe ≈ 1.5,
  // comfortably clearing every Stage-2 threshold.
  const strongPaper = computePaperGateMetrics(
    Array.from({ length: 60 }, (_, i) => trade(i % 6 === 0 ? -0.5 : 1.5)),
  );

  it('allows live only when backtest=pass AND paper=pass AND signoff=present', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT,
      paper: strongPaper,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(true);
    expect(r.blockedReasons).toHaveLength(0);
    expect(r.backtest.state).toBe('pass');
    expect(r.paper.state).toBe('pass');
  });

  it('blocks with a clear reason when sign-off is absent even though both gates pass', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT,
      paper: strongPaper,
      signoff: 'absent',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.blockedReasons.join(' ')).toMatch(/sign-off/i);
  });

  it('blocks when the backtest report is missing', () => {
    const r = evaluatePromotion({
      strategyId: 'momentum',
      backtest: null,
      paper: strongPaper,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.blockedReasons.join(' ')).toMatch(/Stage 1/);
  });

  it('blocks a fresh strategy on all three stages', () => {
    const r = evaluatePromotion({
      strategyId: 'new_strat',
      backtest: null,
      paper: null,
      signoff: 'absent',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.blockedReasons).toHaveLength(3);
  });

  it('default thresholds match the TRA-527 v1 spec', () => {
    expect(DEFAULT_PROMOTION_THRESHOLDS.backtest.minSharpe).toBe(1.0);
    expect(DEFAULT_PROMOTION_THRESHOLDS.backtest.minProfitFactor).toBe(1.3);
    expect(DEFAULT_PROMOTION_THRESHOLDS.backtest.maxDrawdownPct).toBe(0.2);
    expect(DEFAULT_PROMOTION_THRESHOLDS.backtest.minTradeCount).toBe(100);
    expect(DEFAULT_PROMOTION_THRESHOLDS.paper.minTradeCount).toBe(50);
    expect(DEFAULT_PROMOTION_THRESHOLDS.paper.minSharpe).toBe(0.8);
    expect(DEFAULT_PROMOTION_THRESHOLDS.paper.minExpectancyVsBacktestRatio).toBe(0.5);
    expect(DEFAULT_PROMOTION_THRESHOLDS.paper.maxSlippageRatio).toBe(1.5);
  });
});
