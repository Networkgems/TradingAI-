import { describe, it, expect } from 'vitest';
import {
  bsPrice,
  stressPosition,
  runWheelStressScenario,
  runWheelStressSuite,
  SYNTHETIC_SHOCK_SCENARIOS,
  DEFAULT_STRESS_SCENARIOS,
  type WheelBookPosition,
  type ShockScenario,
} from './wheel-vol-stress-harness.js';

const csp = (over: Partial<WheelBookPosition> = {}): WheelBookPosition => ({
  symbol: 'SPY',
  kind: 'cash_secured_put',
  contracts: 1,
  shares: 0,
  strike: 100,
  spot: 105,
  creditPerShare: 1.5,
  costBasisPerShare: 0,
  atmIv: 0.2,
  dte: 30,
  ...over,
});

describe('bsPrice', () => {
  it('is non-negative and collapses to intrinsic at zero vol/time', () => {
    expect(bsPrice('put', 90, 100, 0, 0)).toBe(10); // intrinsic ITM put
    expect(bsPrice('call', 110, 100, 0, 0)).toBe(10); // intrinsic ITM call
    expect(bsPrice('put', 110, 100, 0, 0)).toBe(0); // OTM put
  });

  it('a put is never worth more than its strike (r=0) — the CSP defined-risk bound', () => {
    for (const sigma of [0.5, 1, 2, 5]) {
      expect(bsPrice('put', 1, 100, 1, sigma)).toBeLessThanOrEqual(100 + 1e-9);
    }
  });

  it('rises with vol for an ATM option', () => {
    const lo = bsPrice('put', 100, 100, 0.25, 0.2);
    const hi = bsPrice('put', 100, 100, 0.25, 0.4);
    expect(hi).toBeGreaterThan(lo);
  });
});

describe('stressPosition — a cash-secured put never breaches its defined-risk max', () => {
  const scenarios: ShockScenario[] = [
    ...SYNTHETIC_SHOCK_SCENARIOS,
    { name: 'catastrophe', kind: 'synthetic', underlyingReturn: -0.9, ivMultiplier: 5 },
  ];
  it.each(scenarios.map((s) => [s.name, s] as const))('holds under %s', (_name, scenario) => {
    const s = stressPosition(csp(), scenario);
    expect(s.definedRiskBreach).toBe(false);
    expect(s.stressedLoss).toBeLessThanOrEqual(s.definedRiskMax + 1e-6);
    expect(s.definedRiskMax).toBeCloseTo((100 - 1.5) * 100, 6);
  });

  it('a gap-down loses money on the short put; a gap-up gains', () => {
    const down = stressPosition(csp(), SYNTHETIC_SHOCK_SCENARIOS[0]!); // gap_down_15
    const up = stressPosition(csp(), SYNTHETIC_SHOCK_SCENARIOS[1]!); // gap_up_15
    expect(down.stressedLoss).toBeGreaterThan(up.stressedLoss);
  });
});

describe('stressPosition — covered call / assigned lot lose on the stock leg', () => {
  it('a bare assigned lot loses its stock notional as the underlying falls', () => {
    const lot: WheelBookPosition = {
      symbol: 'AAPL', kind: 'assigned_lot', contracts: 0, shares: 100,
      strike: 0, spot: 100, creditPerShare: 0, costBasisPerShare: 100, atmIv: 0.25, dte: 0,
    };
    const s = stressPosition(lot, { name: 'down', kind: 'synthetic', underlyingReturn: -0.15, ivMultiplier: 1.5 });
    expect(s.stressedLoss).toBeCloseTo(0.15 * 100 * 100, 6); // (100-85)*100 shares
    expect(s.definedRiskBreach).toBe(false);
  });
});

describe('runWheelStressScenario — book-level caps', () => {
  it('flags a risk-cap breach when at-risk exceeds 6% of equity', () => {
    // One CSP with $9,850 at-risk on $100k equity → 9.85% > 6%.
    const r = runWheelStressScenario([csp()], SYNTHETIC_SHOCK_SCENARIOS[0]!, 100_000, {
      riskCapFrac: 0.06,
      notionalCapMultiple: 1.0,
    });
    expect(r.riskCapBreach).toBe(true);
    expect(r.anyBreach).toBe(true);
  });

  it('no cap breach when the book is small vs equity', () => {
    const r = runWheelStressScenario([csp()], SYNTHETIC_SHOCK_SCENARIOS[0]!, 1_000_000, {
      riskCapFrac: 0.06,
      notionalCapMultiple: 1.0,
    });
    expect(r.riskCapBreach).toBe(false);
    expect(r.notionalCapBreach).toBe(false);
    expect(r.definedRiskBreachCount).toBe(0);
    expect(r.anyBreach).toBe(false);
  });
});

describe('runWheelStressSuite', () => {
  it('an empty book yields an honest zero-breach result', () => {
    const suite = runWheelStressSuite([], 100_000);
    expect(suite.positionCount).toBe(0);
    expect(suite.anyBreach).toBe(false);
    expect(suite.definedRiskBreachCount).toBe(0);
    expect(suite.scenarios.length).toBe(DEFAULT_STRESS_SCENARIOS.length);
  });

  it('runs the synthetic script + the named regimes and holds defined risk for a well-sized book', () => {
    const suite = runWheelStressSuite([csp()], 1_000_000);
    expect(suite.definedRiskBreachCount).toBe(0);
    expect(suite.scenarios.some((s) => s.scenario.name === 'mar_2020_covid')).toBe(true);
    expect(suite.scenarios.some((s) => s.scenario.name === 'feb_2018_volmageddon')).toBe(true);
    // Even the worst regime keeps the CSP within its defined-risk max.
    expect(suite.anyBreach).toBe(false);
  });
});
