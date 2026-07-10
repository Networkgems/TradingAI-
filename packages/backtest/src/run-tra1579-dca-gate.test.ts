import { describe, it, expect } from 'vitest';
import {
  evaluateAccumulationBacktestGate,
  DEFAULT_PROMOTION_THRESHOLDS,
  type AccumulationBacktestGateMetrics,
} from '@trading-app/shared';
import { computeTra1579DcaGate } from './run-tra1579-dca-gate.js';

// TRA-1579 — the harness maps the TRA-695 accumulation simulator onto the nine
// gate fields and lets `evaluateAccumulationBacktestGate` render the verdict, so
// the pass/fail is the gate's own, never hand-entered (TRA-527 §3). These tests
// lock: (1) the metrics are structurally well-formed and the OOS window clears
// the minimum horizon, and (2) on the pinned Coinbase 4H cache (a net-DOWN
// 2025→2026 BTC window) DCA legitimately FAILS Stage-1 — the honest input to the
// TRA-1575 go-live decision. Assertions are on signs/bands, not brittle floats.

const t = DEFAULT_PROMOTION_THRESHOLDS.accumulationBacktest;

function assertWellFormed(m: AccumulationBacktestGateMetrics): void {
  for (const [k, v] of Object.entries(m)) {
    expect(Number.isFinite(v), `${k} finite`).toBe(true);
  }
  expect(m.oosDays).toBeGreaterThanOrEqual(t.minOosDays); // ≥ 180d horizon
  expect(m.deploymentRatio).toBeGreaterThan(0);
  expect(m.deploymentRatio).toBeLessThanOrEqual(1);
  expect(m.cadenceVariantsTested).toBe(3);
  expect(m.cadenceVariantsConsistent).toBeLessThanOrEqual(m.cadenceVariantsTested);
}

describe('TRA-1579 crypto-DCA Stage-1 accumulation-backtest gate', () => {
  const { core, context } = computeTra1579DcaGate();

  it('BTC is the registered core leg with a ≥180d OOS window and a firing-but-not-degenerate trend gate', () => {
    expect(core.symbol).toBe('BTC-USD');
    assertWellFormed(core.metrics);
    // The trend gate must actually fire AND stand down sometimes (a real gate).
    expect(core.metrics.deploymentRatio).toBeGreaterThanOrEqual(t.minDeploymentRatio);
    expect(core.metrics.deploymentRatio).toBeLessThanOrEqual(t.maxDeploymentRatio);
  });

  it('the verdict is the gate\'s own re-evaluation of the emitted metrics (anti-gaming)', () => {
    expect(core.evaluation).toEqual(evaluateAccumulationBacktestGate(core.metrics));
  });

  it('BTC DCA FAILS Stage-1 on the pinned net-down OOS window (breaches DD + fee-adjusted value)', () => {
    expect(core.evaluation.state).toBe('fail');
    // Drawdown breach: the value/invested DD exceeds the 35% ceiling.
    expect(core.metrics.valueInvestedMaxDrawdown).toBeGreaterThan(t.maxValueInvestedDrawdownPct);
    // Fee-adjusted value ratio under 1 ⇒ the accumulation ended under water net of costs.
    expect(core.metrics.feeAdjustedValueRatio).toBeLessThan(t.minFeeAdjustedValueRatio);
    const joined = core.evaluation.failedChecks.join(' | ');
    expect(joined).toMatch(/value\/invested drawdown/);
    expect(joined).toMatch(/fee-adjusted value ratio/);
  });

  it('cadence direction is consistent across weekly/biweekly/monthly (not a single-cadence artifact)', () => {
    // Every cadence agreed in sign on the pinned data, so this is NOT the check
    // that fails — the failure is DD + fee ratio, a real accumulation weakness.
    expect(core.metrics.cadenceVariantsConsistent).toBe(core.metrics.cadenceVariantsTested);
  });

  it('SOL context leg is computed and well-formed (optional second major)', () => {
    expect(context.length).toBe(1);
    expect(context[0].symbol).toBe('SOL-USD');
    assertWellFormed(context[0].metrics);
  });
});
