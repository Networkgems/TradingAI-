import { describe, it, expect } from 'vitest';
import {
  ACCUMULATE_STRATEGY_IDS,
  DEFAULT_PROMOTION_THRESHOLDS,
  computeAccumulationGateMetrics,
  computePaperGateMetrics,
  evaluateAccumulationGate,
  evaluateBacktestGate,
  evaluatePaperGate,
  evaluatePromotion,
  promotionStrategyClass,
  PROFIT_FACTOR_CAP,
  type AccumulationPositionSample,
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

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Build one paper trade with a fixed risk distance so R = pnl / (risk*qty) is
 * controllable. risk distance = 1, qty = 1 → R == pnl.
 */
function trade(pnl: number, extra: Partial<PromotionTradeSample> = {}): PromotionTradeSample {
  return { pnl, entryPrice: 100, stopLoss: 99, quantity: 1, ...extra };
}

/**
 * Build a ledger from a list of pnl (== R) values, spacing the trades evenly
 * across `spanDays` (open→close timestamps) so the gate can annualize the
 * Sharpe. `spanDays = 60` keeps the span comfortably above the
 * MIN_PAPER_SHARPE_YEARS_SPAN guard.
 */
function spaced(pnls: number[], spanDays = 60, extra: Partial<PromotionTradeSample> = {}): PromotionTradeSample[] {
  const stepMs = pnls.length > 1 ? (spanDays * MS_PER_DAY) / (pnls.length - 1) : MS_PER_DAY;
  return pnls.map((pnl, i) => trade(pnl, { openedAt: i * stepMs, closedAt: i * stepMs + 60_000, ...extra }));
}

describe('computePaperGateMetrics — metrics are derived from the ledger, not hand-entered', () => {
  it('computes expectancy as mean R, profit factor, and an annualized Sharpe', () => {
    // R values: +2, +2, -1, -1, +1  → mean = 0.6
    const trades = spaced([2, 2, -1, -1, 1]);
    const m = computePaperGateMetrics(trades);
    expect(m.tradeCount).toBe(5);
    expect(m.expectancy).toBeCloseTo(0.6, 6);
    // grossWin = 5, grossLoss = 2 → PF = 2.5
    expect(m.profitFactor).toBeCloseTo(2.5, 6);
    expect(m.sharpe).not.toBeNull();
    expect(m.sharpe as number).toBeGreaterThan(0);
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

  it('reports a null (unverified) Sharpe when the ledger carries no timestamps to annualize over', () => {
    // trade() omits openedAt/closedAt → no span → cannot annualize → null.
    const m = computePaperGateMetrics([trade(2), trade(-1), trade(1), trade(-0.5)]);
    expect(m.sharpe).toBeNull();
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
  it('passes when a passing optimization verdict is registered', () => {
    expect(evaluateBacktestGate(PASSING_BT, DEFAULT_PROMOTION_THRESHOLDS, { pass: true }).state).toBe('pass');
  });

  it('is missing when no report is registered', () => {
    expect(evaluateBacktestGate(null).state).toBe('missing');
  });

  // ── TRA-542: fail-closed — a registered verdict is REQUIRED ─────────────────
  it('fails closed when metrics are registered but no verdict is on record', () => {
    // PASSING_BT clears every legacy raw threshold, yet with no TRA-540 verdict
    // the leg must NOT pass — strong headline numbers alone can no longer mint a
    // Stage-1 pass.
    const r = evaluateBacktestGate(PASSING_BT);
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/no TRA-540 optimization verdict registered/);
    expect(r.failedChecks.join(' ')).toMatch(/fail-closed/);
  });
});

// ── TRA-541: the TRA-540 six-guard verdict gates Stage 1 ─────────────────────
describe('evaluateBacktestGate — optimization verdict is authoritative (TRA-541)', () => {
  it('FAILS the leg when verdict.pass === false even with strong headline metrics', () => {
    // PASSING_BT clears every raw threshold, but the six-guard battery is red.
    const r = evaluateBacktestGate(PASSING_BT, DEFAULT_PROMOTION_THRESHOLDS, {
      pass: false,
      guards: { G1: { pass: true, value: 0.6 }, G2: { pass: false, value: 1 }, G4: { pass: false, value: -10 } },
    });
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/verdict FAIL/);
    // names exactly the guards that were red
    expect(r.failedChecks.join(' ')).toMatch(/G2/);
    expect(r.failedChecks.join(' ')).toMatch(/G4/);
    expect(r.failedChecks.join(' ')).not.toMatch(/G1/);
  });

  it('PASSES the leg when verdict.pass === true (verdict supersedes raw thresholds)', () => {
    // Metrics that would FAIL the raw thresholds (sharpe < 1, tradeCount < 100),
    // but the six-guard battery is all green → the verdict clears Stage 1.
    const weakMetrics: BacktestGateMetrics = {
      sharpe: 0.6,
      expectancy: 0.05,
      profitFactor: 1.1,
      maxDrawdown: 0.05,
      tradeCount: 30,
    };
    const r = evaluateBacktestGate(weakMetrics, DEFAULT_PROMOTION_THRESHOLDS, { pass: true });
    expect(r.state).toBe('pass');
    expect(r.failedChecks).toHaveLength(0);
  });

  it('fails closed when no verdict is registered — TRA-542 (the raw-metric fallback is gone)', () => {
    // Previously the legacy register-a-BacktestResult path (no verdict) fell back
    // to raw thresholds and could PASS. TRA-542 makes that fail-closed: a passing
    // six-guard verdict is now required, so PASSING_BT alone fails Stage 1.
    expect(evaluateBacktestGate(PASSING_BT).state).toBe('fail');
    expect(evaluateBacktestGate(PASSING_BT, DEFAULT_PROMOTION_THRESHOLDS, null).state).toBe('fail');
    expect(evaluateBacktestGate(PASSING_BT, DEFAULT_PROMOTION_THRESHOLDS, null).failedChecks.join(' ')).toMatch(
      /no TRA-540 optimization verdict registered/,
    );
  });

  it('is still missing (not fail) when no metrics are registered, regardless of verdict', () => {
    expect(evaluateBacktestGate(null, DEFAULT_PROMOTION_THRESHOLDS, { pass: true }).state).toBe('missing');
  });
});

describe('evaluatePromotion — verdict.pass=false blocks live even with passing paper + sign-off (TRA-541)', () => {
  const strongPaper = computePaperGateMetrics(
    spaced(Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? -0.5 : 1.5))),
  );

  it('refuses go-live when the optimization verdict failed', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT,
      backtestVerdict: { pass: false, guards: { G3: { pass: false, value: 0.7 } } },
      paper: strongPaper,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.backtest.state).toBe('fail');
    expect(r.backtest.verdict?.pass).toBe(false);
    expect(r.blockedReasons.join(' ')).toMatch(/Stage 1.*verdict FAIL/);
  });

  it('allows go-live when the verdict passes and the other stages clear', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT,
      backtestVerdict: { pass: true },
      paper: strongPaper,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(true);
    expect(r.backtest.state).toBe('pass');
    expect(r.backtest.verdict?.pass).toBe(true);
  });
});

describe('evaluatePaperGate (Stage 2)', () => {
  // 60 strong paper trades over ~60 days: 50 winners of +1.5, 10 small losers of
  // -0.5 → mean R ≈ 1.17, annualized Sharpe well above 0.8, clearing every
  // Stage-2 threshold.
  const strongPaper = computePaperGateMetrics(
    spaced(Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? -0.5 : 1.5))),
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
      spaced(Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 0.5 : -0.46))),
    );
    const r = evaluatePaperGate(weak, PASSING_BT);
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/overfit/);
  });

  it('fails when fewer than 50 monitored trades', () => {
    const few = computePaperGateMetrics(spaced(Array.from({ length: 20 }, () => 1)));
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
      spaced(Array.from({ length: 60 }, (_, i) => (i % 5 === 0 ? -1 : 1)), 60, {
        realizedSlippage: 2,
        modeledSlippage: 1,
      }),
    );
    const r = evaluatePaperGate(slipped, PASSING_BT);
    expect(r.state).toBe('fail');
    expect(r.failedChecks.join(' ')).toMatch(/slippage/);
  });

  // ── TRA-538: paper Sharpe is annualized to the Stage-1 backtest basis ────────
  describe('annualized paper Sharpe (TRA-538)', () => {
    it('rejects a high per-trade-IR ledger that lacks the span to annualize (no √-blow-up pass)', () => {
      // 60 strong trades crammed into a single minute. Per-trade IR is high, but
      // the span is far under ~5 trading days, so the Sharpe is unverified and
      // Stage 2 fails — it does NOT auto-pass off a near-zero denominator.
      const burst = computePaperGateMetrics(
        Array.from({ length: 60 }, (_, i) =>
          trade(i % 6 === 0 ? -0.5 : 1.5, { openedAt: i * 1000, closedAt: i * 1000 + 500 }),
        ),
      );
      expect(burst.sharpe).toBeNull();
      const r = evaluatePaperGate(burst, PASSING_BT);
      expect(r.state).toBe('fail');
      expect(r.failedChecks.join(' ')).toMatch(/Sharpe unverified/);
    });

    it('passes a realistic ledger whose per-trade IR < 0.8 once annualized to ≥ 0.8', () => {
      // mean R = 0.12, sd ≈ 1.09 → per-trade IR ≈ 0.11, which is FAR under the
      // 0.8 bar the old un-annualized check compared against (it would have
      // wrongly failed). Spread over ~60 days the annualized Sharpe is ≈ 2.1, so
      // the strategy now correctly clears Stage 2.
      const pnls = Array.from({ length: 60 }, (_, i) => (i % 2 === 0 ? 1.2 : -0.96));
      const realistic = computePaperGateMetrics(spaced(pnls, 60));
      expect(realistic.expectancy).toBeCloseTo(0.12, 6);
      expect(realistic.sharpe).not.toBeNull();
      expect(realistic.sharpe as number).toBeGreaterThanOrEqual(0.8);
      expect(evaluatePaperGate(realistic, PASSING_BT).state).toBe('pass');

      // The very same R distribution crammed into seconds is unverified → fail.
      const crammed = computePaperGateMetrics(
        pnls.map((pnl, i) => trade(pnl, { openedAt: i * 1000, closedAt: i * 1000 + 500 })),
      );
      expect(crammed.sharpe).toBeNull();
      expect(evaluatePaperGate(crammed, PASSING_BT).state).toBe('fail');
    });
  });
});

describe('evaluatePromotion — overall verdict (the one-line rule)', () => {
  // 50 winners of +1.5, 10 small losers of -0.5 over ~60 days → mean R ≈ 1.17,
  // annualized Sharpe well above 0.8, comfortably clearing every Stage-2 threshold.
  const strongPaper = computePaperGateMetrics(
    spaced(Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? -0.5 : 1.5))),
  );

  it('allows live only when backtest=pass AND paper=pass AND signoff=present', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT,
      backtestVerdict: { pass: true }, // TRA-542 — Stage 1 requires a passing verdict
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
      backtestVerdict: { pass: true }, // Stage 1 + Stage 2 pass; only sign-off missing
      paper: strongPaper,
      signoff: 'absent',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.backtest.state).toBe('pass');
    expect(r.paper.state).toBe('pass');
    expect(r.blockedReasons.join(' ')).toMatch(/sign-off/i);
  });

  it('fails closed: a backtest report with no verdict blocks live on Stage 1 (TRA-542)', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT, // strong metrics, but no verdict registered
      paper: strongPaper,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.backtest.state).toBe('fail');
    expect(r.blockedReasons.join(' ')).toMatch(/Stage 1.*no TRA-540 optimization verdict registered/);
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

// ── TRA-1461 — accumulate/hold-mode Stage-2 leg ──────────────────────────────

const NOW = 100 * 365 * MS_PER_DAY; // a large fixed "now" so soak math is deterministic

/** One OPEN demo accumulation position: long, well-formed stop, opened `soakDays` ago. */
function accum(
  fills: number,
  soakDays: number,
  extra: Partial<AccumulationPositionSample> = {},
): AccumulationPositionSample {
  return {
    side: 'buy',
    entryPrice: 100,
    stopLoss: 90, // stop strictly below blended entry — risk invariant holds
    quantity: fills, // one unit per fill
    fills,
    hold: true,
    openedAt: NOW - soakDays * MS_PER_DAY,
    ...extra,
  };
}

describe('promotionStrategyClass — dca is the only accumulate strategy', () => {
  it('classifies dca as accumulate and everything else as close', () => {
    expect(promotionStrategyClass('dca')).toBe('accumulate');
    expect(promotionStrategyClass('bb_fade')).toBe('close');
    expect(promotionStrategyClass('supertrend_confluence')).toBe('close');
    expect(ACCUMULATE_STRATEGY_IDS.has('dca')).toBe(true);
  });
});

describe('computeAccumulationGateMetrics — derived from the demo book', () => {
  it('sums fills over open positions and measures the soak from the earliest open', () => {
    const m = computeAccumulationGateMetrics([accum(5, 20), accum(4, 30)], NOW);
    expect(m.positionCount).toBe(2);
    expect(m.totalFills).toBe(9);
    expect(m.soakDays).toBeCloseTo(30, 6); // earliest open, 30 days ago
    expect(m.unintendedSells).toBe(0);
    expect(m.riskInvariantBreaches).toBe(0);
  });

  it('flags a stop at/above blended entry as a risk-invariant breach', () => {
    const m = computeAccumulationGateMetrics([accum(10, 20, { stopLoss: 100 })], NOW);
    expect(m.riskInvariantBreaches).toBe(1);
  });

  it('flags a short (non-long) accumulation as a risk-invariant breach', () => {
    const m = computeAccumulationGateMetrics([accum(10, 20, { side: 'sell' })], NOW);
    expect(m.riskInvariantBreaches).toBe(1);
  });

  it('counts a held position sold outside its catastrophe stop as an unintended sell', () => {
    const closedTp: AccumulationPositionSample = {
      side: 'buy', entryPrice: 100, stopLoss: 90, quantity: 5, fills: 5, hold: true,
      openedAt: NOW - 40 * MS_PER_DAY, closedAt: NOW - 1 * MS_PER_DAY, exitReason: 'tp',
    };
    const closedSl: AccumulationPositionSample = { ...closedTp, exitReason: 'sl' };
    const m = computeAccumulationGateMetrics([accum(10, 20), closedTp, closedSl], NOW);
    expect(m.unintendedSells).toBe(1); // tp counts, sl does not
    expect(m.positionCount).toBe(1); // only the open position
  });
});

describe('evaluateAccumulationGate — accumulation correctness, not PF/expectancy', () => {
  it('passes a well-formed, well-soaked accumulation', () => {
    const m = computeAccumulationGateMetrics([accum(8, 14)], NOW);
    expect(evaluateAccumulationGate(m).state).toBe('pass');
  });

  it('is missing when no accumulation positions are monitored', () => {
    expect(evaluateAccumulationGate(null).state).toBe('missing');
    expect(evaluateAccumulationGate(computeAccumulationGateMetrics([], NOW)).state).toBe('missing');
  });

  it('fails when too few fills or too short a soak', () => {
    const tooFewFills = evaluateAccumulationGate(computeAccumulationGateMetrics([accum(3, 20)], NOW));
    expect(tooFewFills.state).toBe('fail');
    expect(tooFewFills.failedChecks.join(' ')).toMatch(/fills/);
    const tooShort = evaluateAccumulationGate(computeAccumulationGateMetrics([accum(10, 5)], NOW));
    expect(tooShort.state).toBe('fail');
    expect(tooShort.failedChecks.join(' ')).toMatch(/soak/);
  });

  it('fails on any unintended sell or risk-invariant breach', () => {
    const sell = evaluateAccumulationGate(
      computeAccumulationGateMetrics(
        [accum(10, 20), { side: 'buy', entryPrice: 100, stopLoss: 90, quantity: 1, fills: 1, hold: true, openedAt: NOW - 30 * MS_PER_DAY, closedAt: NOW, exitReason: 'tp' }],
        NOW,
      ),
    );
    expect(sell.state).toBe('fail');
    expect(sell.failedChecks.join(' ')).toMatch(/unintended sell/);
    const breach = evaluateAccumulationGate(computeAccumulationGateMetrics([accum(10, 20, { stopLoss: 110 })], NOW));
    expect(breach.state).toBe('fail');
    expect(breach.failedChecks.join(' ')).toMatch(/risk invariant/);
  });
});

describe('evaluatePromotion — class-aware Stage 2', () => {
  // Same variance-carrying ledger the overall-verdict suite uses so the paper
  // leg genuinely passes (a zero-variance ledger yields a null Sharpe → fail).
  const strongPaper = computePaperGateMetrics(
    spaced(Array.from({ length: 60 }, (_, i) => (i % 6 === 0 ? -0.5 : 1.5))),
  );
  const goodAccum = computeAccumulationGateMetrics([accum(10, 20)], NOW);

  it('an accumulate strategy clears live on Stage-1 verdict + accumulation + sign-off (no closed trades)', () => {
    const r = evaluatePromotion({
      strategyId: 'dca',
      strategyClass: 'accumulate',
      backtest: PASSING_BT,
      backtestVerdict: { pass: true },
      paper: null, // never any closed paper trades — the old structural blocker
      accumulation: goodAccum,
      signoff: 'present',
    });
    expect(r.strategyClass).toBe('accumulate');
    expect(r.canGoLive).toBe(true);
    expect(r.paper.accumulation).not.toBeNull();
    expect(r.paper.metrics).toBeNull();
  });

  it('an accumulate strategy is blocked on Stage 2 when accumulation is missing', () => {
    const r = evaluatePromotion({
      strategyId: 'dca',
      strategyClass: 'accumulate',
      backtest: PASSING_BT,
      backtestVerdict: { pass: true },
      paper: null,
      accumulation: null,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(false);
    expect(r.blockedReasons.join(' ')).toMatch(/Stage 2 \(accumulation\) missing/);
  });

  it('does NOT let closed-trade paper metrics promote an accumulate strategy', () => {
    // Even a strong closed-trade paper ledger must not clear Stage 2 for an
    // accumulate strategy — only accumulation correctness does.
    const r = evaluatePromotion({
      strategyId: 'dca',
      strategyClass: 'accumulate',
      backtest: PASSING_BT,
      backtestVerdict: { pass: true },
      paper: strongPaper,
      accumulation: null,
      signoff: 'present',
    });
    expect(r.canGoLive).toBe(false);
  });

  it('close-based strategies are unchanged: accumulation is ignored, paper leg still governs', () => {
    const r = evaluatePromotion({
      strategyId: 'bb_fade',
      backtest: PASSING_BT,
      backtestVerdict: { pass: true },
      paper: strongPaper,
      accumulation: goodAccum, // supplied but must be ignored for a close strategy
      signoff: 'present',
    });
    expect(r.strategyClass).toBe('close');
    expect(r.canGoLive).toBe(true);
    expect(r.paper.metrics).not.toBeNull();
    expect(r.paper.accumulation).toBeNull();
  });
});
