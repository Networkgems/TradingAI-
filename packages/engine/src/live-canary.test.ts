import { describe, it, expect } from 'vitest';
import {
  DEFAULT_CANARY_LIMITS,
  DEFAULT_CANARY_PROMOTION_CRITERIA,
  evaluateCanaryGuards,
  applyGuardEvaluation,
  initialCanaryState,
  evaluateCanaryPromotion,
  type CanaryTelemetry,
  type CanaryPromotionInput,
  type CanaryState,
} from './live-canary.js';

// A telemetry snapshot that clears ALL five guards on a $25k canary allocation
// (the TRA-2040 bankroll). Each guard test perturbs ONE field of this base.
function cleanTelemetry(): CanaryTelemetry {
  return {
    allocation: 25_000,
    cumulativePnl: -1_000, // -4% cumulative, under the 15% cap
    dailyPnl: -500, // -2% today, under the 5% breaker
    tradesToday: 3, // <= 5
    concurrentPositions: 2, // <= 3
    realizedSlippageBps: 6, // modeled 5 -> threshold min(2*5, 5+10)=10, ok
    modeledSlippageBps: 5,
    maxTradeNotional: 20_000, // <= 1.0 * 25_000
  };
}

describe('evaluateCanaryGuards — clean pass', () => {
  it('passes when every limit has headroom, with no fail-closed', () => {
    const e = evaluateCanaryGuards(cleanTelemetry());
    expect(e.ok).toBe(true);
    expect(e.breaches).toEqual([]);
    expect(e.failClosed).toBe(false);
    expect(e.headroom).toHaveLength(5);
    for (const h of e.headroom) {
      expect(h.breached).toBe(false);
      expect(h.headroom).toBeGreaterThan(0);
    }
  });
});

describe('evaluateCanaryGuards — each hard limit trips independently', () => {
  it('CUMULATIVE_LOSS_CAP at >= 15% of allocation', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), cumulativePnl: -3_750 }); // -15%
    expect(e.ok).toBe(false);
    expect(e.breaches).toContain('CUMULATIVE_LOSS_CAP');
    expect(e.failClosed).toBe(false);
  });

  it('does NOT trip cumulative on profit (positive PnL)', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), cumulativePnl: 50_000 });
    expect(e.breaches).not.toContain('CUMULATIVE_LOSS_CAP');
  });

  it('DAILY_LOSS_CAP at >= 5% of allocation', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), dailyPnl: -1_250 }); // -5%
    expect(e.breaches).toContain('DAILY_LOSS_CAP');
  });

  it('TRADE_RATE_CAP when trades today exceed N', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), tradesToday: 6 });
    expect(e.breaches).toContain('TRADE_RATE_CAP');
  });

  it('TRADE_RATE_CAP when concurrency exceeds K', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), concurrentPositions: 4 });
    expect(e.breaches).toContain('TRADE_RATE_CAP');
  });

  it('SLIPPAGE_DIVERGENCE when realized reaches the 2x-modeled multiple', () => {
    // modeled 5 -> multiple 10, absolute 15 -> threshold min = 10; realized 10 trips.
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), realizedSlippageBps: 10 });
    expect(e.breaches).toContain('SLIPPAGE_DIVERGENCE');
  });

  it('SLIPPAGE_DIVERGENCE via the absolute-bps tolerance when modeled is ~0', () => {
    // modeled 0 -> multiple 0, absolute 10 -> threshold 0? min(0, 10) = 0, so any
    // realized >= 0 trips. That is the fail-closed-on-zero-modeled intent: with no
    // modeled slippage basis we cannot certify fidelity, so realized > 0 demotes.
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), modeledSlippageBps: 0, realizedSlippageBps: 3 });
    expect(e.breaches).toContain('SLIPPAGE_DIVERGENCE');
  });

  it('NOTIONAL_CAP when a trade exceeds the per-trade cap', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), maxTradeNotional: 25_001 });
    expect(e.breaches).toContain('NOTIONAL_CAP');
  });

  it('lists EVERY breached limit at once', () => {
    const e = evaluateCanaryGuards({
      ...cleanTelemetry(),
      cumulativePnl: -10_000,
      dailyPnl: -5_000,
      tradesToday: 99,
    });
    expect(e.breaches).toEqual(
      expect.arrayContaining(['CUMULATIVE_LOSS_CAP', 'DAILY_LOSS_CAP', 'TRADE_RATE_CAP']),
    );
  });
});

describe('evaluateCanaryGuards — FAIL-CLOSED', () => {
  it('demotes on a missing/NaN telemetry field', () => {
    const t = cleanTelemetry();
    // @ts-expect-error — deliberately corrupt one reading
    t.realizedSlippageBps = undefined;
    const e = evaluateCanaryGuards(t);
    expect(e.ok).toBe(false);
    expect(e.failClosed).toBe(true);
    expect(e.breaches).toEqual(['TELEMETRY_MISSING']);
  });

  it('demotes on a non-finite reading', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), dailyPnl: Number.NaN });
    expect(e.failClosed).toBe(true);
    expect(e.breaches).toEqual(['TELEMETRY_MISSING']);
  });

  it('demotes on a non-positive allocation (no denominator for the caps)', () => {
    const e = evaluateCanaryGuards({ ...cleanTelemetry(), allocation: 0 });
    expect(e.failClosed).toBe(true);
    expect(e.breaches).toEqual(['TELEMETRY_MISSING']);
  });
});

describe('applyGuardEvaluation — state machine + demote latch', () => {
  const armed: CanaryState = { ...initialCanaryState(), stage: 'canary', candidateId: 'cand-1' };

  it('continues a clean armed canary', () => {
    const clean = evaluateCanaryGuards(cleanTelemetry());
    const { state, action } = applyGuardEvaluation(armed, clean, 1_000);
    expect(action).toBe('continue');
    expect(state.stage).toBe('canary');
    expect(state.canaryDemoted).toBe(false);
  });

  it('demotes to shadow and LATCHES on any breach', () => {
    const breach = evaluateCanaryGuards({ ...cleanTelemetry(), dailyPnl: -5_000 });
    const { state, action } = applyGuardEvaluation(armed, breach, 2_000);
    expect(action).toBe('demote');
    expect(state.stage).toBe('shadow');
    expect(state.candidateId).toBeNull();
    expect(state.canaryDemoted).toBe(true);
    expect(state.demotionReasons).toContain('DAILY_LOSS_CAP');
    expect(state.demotedAt).toBe(2_000);
  });

  it('a fail-closed evaluation ALSO demotes (ambiguity = demote)', () => {
    const failClosed = evaluateCanaryGuards({ ...cleanTelemetry(), allocation: -1 });
    const { state, action } = applyGuardEvaluation(armed, failClosed, 3_000);
    expect(action).toBe('demote');
    expect(state.canaryDemoted).toBe(true);
    expect(state.demotionReasons).toEqual(['TELEMETRY_MISSING']);
  });

  it('the latch survives — a later clean sweep after demotion cannot silently re-arm', () => {
    const demoted: CanaryState = {
      stage: 'shadow',
      candidateId: null,
      canaryDemoted: true,
      demotionReasons: ['DAILY_LOSS_CAP'],
      demotedAt: 2_000,
    };
    const clean = evaluateCanaryGuards(cleanTelemetry());
    const { state, action } = applyGuardEvaluation(demoted, clean, 4_000);
    // Stage is shadow, so guards are inert; the latch stays set.
    expect(action).toBe('noop');
    expect(state.stage).toBe('shadow');
    expect(state.canaryDemoted).toBe(true);
  });

  it('guards are inert in shadow and full_live (noop)', () => {
    const breach = evaluateCanaryGuards({ ...cleanTelemetry(), dailyPnl: -5_000 });
    expect(applyGuardEvaluation(initialCanaryState(), breach, 5).action).toBe('noop');
    const full: CanaryState = { ...initialCanaryState(), stage: 'full_live' };
    expect(applyGuardEvaluation(full, breach, 5).action).toBe('noop');
  });

  it('fail-closed by default: a fresh state is shadow-only, latch clear', () => {
    const s = initialCanaryState();
    expect(s.stage).toBe('shadow');
    expect(s.candidateId).toBeNull();
    expect(s.canaryDemoted).toBe(false);
  });
});

describe('evaluateCanaryPromotion — inert criteria (canary -> full_live)', () => {
  function eligibleInput(): CanaryPromotionInput {
    return {
      tradeCount: 30,
      daysActive: 20,
      breachCount: 0,
      realizedExpectancyR: 0.15,
      modeledExpectancyR: 0.15,
      realizedWinRate: 0.55,
      modeledWinRate: 0.55,
      realizedSlippageBps: 6,
      modeledSlippageBps: 5,
      sixGuardGatePass: true,
      validatorSignoffPresent: true,
    };
  }

  it('eligible only when EVERY gate holds', () => {
    const v = evaluateCanaryPromotion(eligibleInput());
    expect(v.eligible).toBe(true);
    expect(v.blockers).toEqual([]);
  });

  it('profitability alone does NOT promote — fidelity (slippage) must also hold', () => {
    const v = evaluateCanaryPromotion({
      ...eligibleInput(),
      realizedExpectancyR: 0.9, // very profitable
      realizedSlippageBps: 50, // ...but slippage diverged from modeled 5
    });
    expect(v.eligible).toBe(false);
    expect(v.blockers).toContain('SLIPPAGE_OUT_OF_TOLERANCE');
    expect(v.blockers).toContain('EXPECTANCY_OUT_OF_TOLERANCE');
  });

  it('fidelity alone does NOT promote — the validator co-sign must be present', () => {
    const v = evaluateCanaryPromotion({ ...eligibleInput(), validatorSignoffPresent: false });
    expect(v.eligible).toBe(false);
    expect(v.blockers).toEqual(['VALIDATOR_SIGNOFF_MISSING']);
  });

  it('blocks on any breach in the window', () => {
    const v = evaluateCanaryPromotion({ ...eligibleInput(), breachCount: 1 });
    expect(v.blockers).toContain('BREACHES_PRESENT');
  });

  it('blocks below the trade/day minimums', () => {
    const v = evaluateCanaryPromotion({ ...eligibleInput(), tradeCount: 29, daysActive: 19 });
    expect(v.blockers).toEqual(
      expect.arrayContaining(['INSUFFICIENT_TRADES', 'INSUFFICIENT_DAYS']),
    );
  });

  it('blocks when the six-guard gate is not green', () => {
    const v = evaluateCanaryPromotion({ ...eligibleInput(), sixGuardGatePass: false });
    expect(v.blockers).toContain('SIX_GUARD_GATE_NOT_GREEN');
  });

  it('realized slippage BELOW modeled is fine (one-sided tolerance)', () => {
    const v = evaluateCanaryPromotion({ ...eligibleInput(), realizedSlippageBps: 1, modeledSlippageBps: 5 });
    expect(v.blockers).not.toContain('SLIPPAGE_OUT_OF_TOLERANCE');
  });

  it('fail-closed on a non-finite metric', () => {
    const v = evaluateCanaryPromotion({ ...eligibleInput(), realizedExpectancyR: Number.NaN });
    expect(v.eligible).toBe(false);
    expect(v.blockers).toContain('EXPECTANCY_OUT_OF_TOLERANCE');
  });

  it('exposes the board-approved defaults', () => {
    expect(DEFAULT_CANARY_PROMOTION_CRITERIA.minTrades).toBe(30);
    expect(DEFAULT_CANARY_PROMOTION_CRITERIA.minDays).toBe(20);
    expect(DEFAULT_CANARY_LIMITS.cumulativeLossCapPct).toBe(0.15);
    expect(DEFAULT_CANARY_LIMITS.dailyLossCapPct).toBe(0.05);
  });
});
