import { describe, it, expect } from 'vitest';
import {
  evaluateRiskAutopilot,
  guardLimitChange,
  clampThrottle,
  assertTightenOnly,
  MIN_RISK_THROTTLE,
  DEFAULT_AUTOPILOT_THRESHOLDS,
  type RiskAutopilotInput,
} from './risk-autopilot.js';

// TRA-995 — the risk autopilot is TIGHTEN-ONLY: it may halt / throttle on a
// drawdown / regime / loss-streak / feed / edge-decay trigger, log the reason,
// and NEVER raise a limit on its own. These tests pin each trigger and the
// invariant.

const base: RiskAutopilotInput = {
  dailyPnl: 0,
  managedEquity: 100_000,
  consecutiveLosses: 0,
};

describe('evaluateRiskAutopilot — no trigger', () => {
  it('is a no-op when nothing is wrong (full size, no halt, no actions)', () => {
    const d = evaluateRiskAutopilot(base);
    expect(d.halt).toBe(false);
    expect(d.riskThrottle).toBe(1);
    expect(d.actions).toHaveLength(0);
  });
});

describe('evaluateRiskAutopilot — HALT triggers', () => {
  it('halts on the consecutive-loss streak and logs the reason', () => {
    const d = evaluateRiskAutopilot({ ...base, consecutiveLosses: 3 });
    expect(d.halt).toBe(true);
    expect(d.haltReason).toMatch(/3 consecutive losses/i);
    expect(d.actions.some((a) => a.kind === 'halt' && a.trigger === 'loss_streak')).toBe(true);
  });

  it('halts on the daily-drawdown breach and logs the reason', () => {
    // −8% of 100k managed = −8000; cross it.
    const d = evaluateRiskAutopilot({ ...base, dailyPnl: -8_500 });
    expect(d.halt).toBe(true);
    expect(d.haltReason).toMatch(/drawdown/i);
    expect(d.actions.some((a) => a.trigger === 'daily_drawdown' && a.kind === 'halt')).toBe(true);
  });

  it('halts on a stale feed during market hours', () => {
    const d = evaluateRiskAutopilot({ ...base, feedStale: true });
    expect(d.halt).toBe(true);
    expect(d.haltReason).toMatch(/feed stale/i);
  });

  it('reports the throttle at the floor when halted (no new entries anyway)', () => {
    const d = evaluateRiskAutopilot({ ...base, consecutiveLosses: 3 });
    expect(d.riskThrottle).toBe(MIN_RISK_THROTTLE);
  });
});

describe('evaluateRiskAutopilot — THROTTLE triggers (de-risk short of a halt)', () => {
  it('throttles one loss BEFORE the hard halt', () => {
    const d = evaluateRiskAutopilot({ ...base, consecutiveLosses: 2 });
    expect(d.halt).toBe(false);
    expect(d.riskThrottle).toBe(DEFAULT_AUTOPILOT_THRESHOLDS.lossStreakThrottle);
    expect(d.actions.some((a) => a.kind === 'throttle' && a.trigger === 'loss_streak')).toBe(true);
  });

  it('throttles on a soft drawdown crossing before the hard halt', () => {
    // 4% drawdown: past the 4% soft limit (half of 8%) but under the 8% halt.
    const d = evaluateRiskAutopilot({ ...base, dailyPnl: -4_500 });
    expect(d.halt).toBe(false);
    expect(d.riskThrottle).toBeLessThan(1);
    expect(d.actions.some((a) => a.trigger === 'daily_drawdown' && a.kind === 'throttle')).toBe(
      true,
    );
  });

  it('throttles in a high-vol regime', () => {
    const d = evaluateRiskAutopilot({ ...base, regime: 'high_vol' });
    expect(d.halt).toBe(false);
    expect(d.riskThrottle).toBe(DEFAULT_AUTOPILOT_THRESHOLDS.highVolThrottle);
    expect(d.actions.some((a) => a.trigger === 'regime_shift')).toBe(true);
  });

  it('does NOT throttle on benign regimes', () => {
    for (const regime of ['trend_up', 'trend_down', 'range', 'flat', null] as const) {
      const d = evaluateRiskAutopilot({ ...base, regime });
      expect(d.actions.some((a) => a.trigger === 'regime_shift')).toBe(false);
    }
  });

  it('throttles per edge-decaying strategy and notes it is queued for review', () => {
    const d = evaluateRiskAutopilot({ ...base, decayingStrategies: ['bull_put'] });
    expect(d.halt).toBe(false);
    const act = d.actions.find((a) => a.trigger === 'edge_decay');
    expect(act).toBeDefined();
    expect(act!.reason).toMatch(/queued for review/i);
  });

  it('combines multiple throttles multiplicatively, floored', () => {
    const d = evaluateRiskAutopilot({
      ...base,
      consecutiveLosses: 2, // 0.5
      regime: 'high_vol', // 0.5
      decayingStrategies: ['a', 'b'], // 0.5 * 0.5
    });
    // 0.5*0.5*0.5*0.5 = 0.0625 → floored to MIN_RISK_THROTTLE.
    expect(d.riskThrottle).toBe(MIN_RISK_THROTTLE);
    expect(d.actions.filter((a) => a.kind === 'throttle').length).toBe(4);
  });
});

describe('Invariant 4 — tighten-only', () => {
  it('never returns a throttle above 1 for any input', () => {
    const inputs: RiskAutopilotInput[] = [
      base,
      { ...base, dailyPnl: 5_000 }, // a profitable day must NOT loosen
      { ...base, consecutiveLosses: 0, regime: 'trend_up' },
    ];
    for (const i of inputs) {
      const d = evaluateRiskAutopilot(i);
      expect(d.riskThrottle).toBeLessThanOrEqual(1);
      expect(() => assertTightenOnly(d)).not.toThrow();
    }
  });

  it('a winning day produces no loosening action', () => {
    const d = evaluateRiskAutopilot({ ...base, dailyPnl: 20_000 });
    expect(d.riskThrottle).toBe(1);
    expect(d.actions).toHaveLength(0);
  });

  it('assertTightenOnly throws if a decision smuggles a loosening', () => {
    expect(() =>
      assertTightenOnly({ halt: false, haltReason: null, riskThrottle: 1.5, actions: [] }),
    ).toThrow(/invariant violated/i);
  });
});

describe('clampThrottle', () => {
  it('floors at MIN_RISK_THROTTLE and ceils at 1', () => {
    expect(clampThrottle(0.0001)).toBe(MIN_RISK_THROTTLE);
    expect(clampThrottle(1.5)).toBe(1);
    expect(clampThrottle(0.6)).toBe(0.6);
    expect(clampThrottle(NaN)).toBe(1);
  });
});

describe('guardLimitChange — Invariant 4 chokepoint', () => {
  it('refuses to RAISE a cap-style limit and flags board ratification', () => {
    const r = guardLimitChange(0.01, 0.02); // raise risk-per-trade
    expect(r.applied).toBe(0.01);
    expect(r.requiresRatification).toBe(true);
    expect(r.reason).toMatch(/board ratification/i);
  });

  it('lets a TIGHTENING of a cap-style limit through', () => {
    const r = guardLimitChange(0.02, 0.01);
    expect(r.applied).toBe(0.01);
    expect(r.requiresRatification).toBe(false);
  });

  it('handles inverted limits where higher is tighter', () => {
    // e.g. a minimum-confidence floor: raising it is a tightening.
    const r = guardLimitChange(0.5, 0.7, false);
    expect(r.applied).toBe(0.7);
    expect(r.requiresRatification).toBe(false);
    const loosen = guardLimitChange(0.7, 0.5, false);
    expect(loosen.requiresRatification).toBe(true);
  });
});
