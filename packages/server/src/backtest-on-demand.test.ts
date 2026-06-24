// TRA-1046 (TRA-1041c L2) — on-demand backtest tests.
//
// Drives `runOnDemandBacktest` with a DETERMINISTIC injected executor (no on-disk
// cache, no clock) so the test asserts the apply→backtest→G0-grade contract the
// `POST /api/backtest` route relies on: a well-formed hypothesis comes back graded,
// a config delta reaches the executor, a malformed target is a 400-class error, and
// the run is read-only (returns the graded result without persisting a queue item).

import { describe, it, expect } from 'vitest';
import type { BacktestGateMetrics } from '@trading-app/shared';
import {
  runOnDemandBacktest,
  validateBacktestRequest,
  OnDemandBacktestBadRequest,
} from './backtest-on-demand.js';
import {
  type AppliedConfig,
  type BacktestExecutor,
  type ConfigSnapshot,
} from './hypothesis-pipeline.js';

const BASE: ConfigSnapshot = {
  RV_CRYPTO_MAJORS: { riskPerTradePct: 0.0075, bbMultiplier: 2 },
};

/** A passing metrics row (clears the default G0 thresholds). */
const PASS: BacktestGateMetrics = {
  sharpe: 1.5, expectancy: 0.2, profitFactor: 1.8, maxDrawdown: 0.1, tradeCount: 120,
};
/** A failing metrics row (flat expectancy ⇒ no edge). */
const FAIL: BacktestGateMetrics = {
  sharpe: 0.1, expectancy: 0, profitFactor: 0.9, maxDrawdown: 0.5, tradeCount: 5,
};

function stubExecutor(metrics: BacktestGateMetrics, sink?: (a: AppliedConfig) => void): BacktestExecutor {
  return async (applied) => {
    sink?.(applied);
    return metrics;
  };
}

describe('validateBacktestRequest', () => {
  it('accepts a well-formed request', () => {
    expect(
      validateBacktestRequest({
        target: { kind: 'selector_param', path: 'RV_CRYPTO_MAJORS.bbMultiplier' },
        proposedDelta: { op: 'mul', value: 1.1 },
      }),
    ).toBeNull();
  });

  it('rejects missing/garbage fields with a message', () => {
    expect(validateBacktestRequest(null)).toMatch(/json object/i);
    expect(validateBacktestRequest({})).toMatch(/target/);
    expect(validateBacktestRequest({ target: { kind: 'gate', path: '' }, proposedDelta: { op: 'set', value: 1 } }))
      .toMatch(/path/);
    expect(validateBacktestRequest({ target: { kind: 'bogus', path: 'x' }, proposedDelta: { op: 'set', value: 1 } }))
      .toMatch(/kind/);
    expect(validateBacktestRequest({ target: { kind: 'gate', path: 'x' }, proposedDelta: { op: 'pow', value: 1 } }))
      .toMatch(/op/);
    expect(validateBacktestRequest({ target: { kind: 'gate', path: 'x' }, proposedDelta: { op: 'set', value: 'NaN' } }))
      .toMatch(/finite/);
  });
});

describe('runOnDemandBacktest', () => {
  it('grades a passing hypothesis and carries the full evidence', async () => {
    const result = await runOnDemandBacktest(
      {
        target: { kind: 'selector_param', path: 'RV_CRYPTO_MAJORS.bbMultiplier' },
        proposedDelta: { op: 'set', value: 2.5 },
        createdAt: 123,
      },
      { baseConfig: BASE, runBacktest: stubExecutor(PASS), now: () => 1000 },
    );
    expect(result.grade.pass).toBe(true);
    expect(result.baseline).toBe(2);
    expect(result.applied).toBe(2.5);
    expect(result.metrics).toEqual(PASS);
    expect(result.hypothesis.id).toMatch(/^hyp-/);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it('fails grading for a no-edge metrics row and lists the failed checks', async () => {
    const result = await runOnDemandBacktest(
      {
        target: { kind: 'selector_param', path: 'RV_CRYPTO_MAJORS.bbMultiplier' },
        proposedDelta: { op: 'set', value: 3 },
      },
      { baseConfig: BASE, runBacktest: stubExecutor(FAIL) },
    );
    expect(result.grade.pass).toBe(false);
    expect(result.grade.failedChecks.length).toBeGreaterThan(0);
  });

  it('passes the mutated config through to the executor', async () => {
    let seen: AppliedConfig | undefined;
    await runOnDemandBacktest(
      {
        target: { kind: 'selector_param', path: 'RV_CRYPTO_MAJORS.riskPerTradePct' },
        proposedDelta: { op: 'mul', value: 2 },
      },
      { baseConfig: BASE, runBacktest: stubExecutor(PASS, (a) => (seen = a)) },
    );
    const cfg = seen!.config['RV_CRYPTO_MAJORS'] as Record<string, number>;
    expect(cfg['riskPerTradePct']).toBeCloseTo(0.015);
    // base config untouched (applied against a clone)
    expect((BASE['RV_CRYPTO_MAJORS'] as Record<string, number>)['riskPerTradePct']).toBe(0.0075);
  });

  it('throws a bad-request for a target path that is not a finite number', async () => {
    await expect(
      runOnDemandBacktest(
        { target: { kind: 'gate', path: 'RV_CRYPTO_MAJORS.doesNotExist' }, proposedDelta: { op: 'set', value: 1 } },
        { baseConfig: BASE, runBacktest: stubExecutor(PASS) },
      ),
    ).rejects.toBeInstanceOf(OnDemandBacktestBadRequest);
  });
});
