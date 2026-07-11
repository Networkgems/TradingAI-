import { describe, it, expect } from 'vitest';
import {
  resolveLiveCapitalGateCriteria,
  evaluateLiveCapitalGate,
  LIVE_CAPITAL_GATE,
} from './live-capital-gate.js';
import type { ForwardTestReport } from './options-forward-test.js';

// TRA-1600 (deliverable B) — the cost-aware raised live-capital expectancy bar.

describe('resolveLiveCapitalGateCriteria (TRA-1600 B)', () => {
  it('returns the shipped gate (net > 0) when the cost-aware flag is off', () => {
    expect(resolveLiveCapitalGateCriteria({})).toEqual(LIVE_CAPITAL_GATE);
    expect(resolveLiveCapitalGateCriteria({})).toBe(LIVE_CAPITAL_GATE);
  });

  it('lifts the expectancy bar to the safety margin (default 0.20R) when the flag is on', () => {
    const c = resolveLiveCapitalGateCriteria({ ENABLE_OPTION_COST_AWARE_GATE: '1' });
    expect(c.minExpectancyR).toBeCloseTo(0.2, 10);
    // Every other criterion is unchanged.
    expect(c.minResolvedIdeas).toBe(LIVE_CAPITAL_GATE.minResolvedIdeas);
    expect(c.minWeeksWithResolved).toBe(LIVE_CAPITAL_GATE.minWeeksWithResolved);
  });

  it('honours an operator-tuned safety margin override', () => {
    const c = resolveLiveCapitalGateCriteria({
      ENABLE_OPTION_COST_AWARE_GATE: 'on',
      OPTION_COST_GATE_SAFETY_MARGIN_R: '0.30',
    });
    expect(c.minExpectancyR).toBeCloseTo(0.3, 10);
  });
});

// Minimal report builder — only the totals fields the gate reads.
function reportWith(expectancyNetR: number): ForwardTestReport {
  return {
    asOfDate: '2026-07-11',
    totals: {
      weeksWithResolved: 8,
      weeksPositiveExpectancyNet: 6,
      popCalibrationGap: 0.05,
      resolved: 30,
      expectancyNetR,
      maxLossBreaches: 0,
    },
  } as unknown as ForwardTestReport;
}

describe('evaluateLiveCapitalGate under the cost-aware bar', () => {
  it('a +0.1R cost-net book PASSES the flat bar but FAILS the raised 0.2R bar', () => {
    const report = reportWith(0.1);
    // Flat shipped bar (net > 0): the expectancy criterion passes.
    const flat = evaluateLiveCapitalGate(report, LIVE_CAPITAL_GATE);
    expect(flat.criteria.find((c) => c.name === 'positive_expectancy')?.pass).toBe(true);
    // Raised cost-aware bar (net > 0.2): the same book now fails the expectancy criterion.
    const raised = evaluateLiveCapitalGate(
      report,
      resolveLiveCapitalGateCriteria({ ENABLE_OPTION_COST_AWARE_GATE: '1' }),
    );
    expect(raised.criteria.find((c) => c.name === 'positive_expectancy')?.pass).toBe(false);
    expect(raised.passed).toBe(false);
  });

  it('a +0.45R cost-net book clears the raised bar', () => {
    const raised = evaluateLiveCapitalGate(
      reportWith(0.45),
      resolveLiveCapitalGateCriteria({ ENABLE_OPTION_COST_AWARE_GATE: '1' }),
    );
    expect(raised.criteria.find((c) => c.name === 'positive_expectancy')?.pass).toBe(true);
    expect(raised.passed).toBe(true);
  });
});
