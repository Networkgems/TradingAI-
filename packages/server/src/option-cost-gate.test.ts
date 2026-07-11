import { describe, it, expect } from 'vitest';
import {
  isOptionCostAwareGateEnabled,
  resolveCostGateConfig,
  admissionBarR,
  admitByCostAwareGate,
  structureCostR,
  isEquityStructure,
  DEFAULT_COST_GATE_CONFIG,
} from './option-cost-gate.js';

// TRA-1600 — cost-aware options admission gate (deliverables B + C).

describe('isOptionCostAwareGateEnabled', () => {
  it('is off by default and accepts 1/true/yes/on (case/space-insensitive)', () => {
    expect(isOptionCostAwareGateEnabled({})).toBe(false);
    for (const v of ['1', 'true', 'YES', ' on ', 'True']) {
      expect(isOptionCostAwareGateEnabled({ ENABLE_OPTION_COST_AWARE_GATE: v })).toBe(true);
    }
    expect(isOptionCostAwareGateEnabled({ ENABLE_OPTION_COST_AWARE_GATE: 'off' })).toBe(false);
  });
});

describe('admissionBarR — default config reproduces the plan headline (25%-premium R, TRA-1603)', () => {
  it('options structures resolve to the ~1.25R bar', () => {
    // costModel 0.05 + 1.00 = 1.05, + 0.20 margin = 1.25, above the 1.20 floor.
    for (const s of ['single_leg_otm', 'single_leg_rv', 'directional', 'bull_put']) {
      expect(admissionBarR(s)).toBeCloseTo(1.25, 10);
    }
  });

  it('equity structures keep a far lower bar', () => {
    // 0.00 + 0.02 = 0.02, + 0.20 margin = 0.22, no floor.
    expect(admissionBarR('equity')).toBeCloseTo(0.22, 10);
    expect(admissionBarR('equity_swing')).toBeCloseTo(0.22, 10);
  });

  it('the options floor lifts the bar above the pure cost model when set high', () => {
    const cfg = { ...DEFAULT_COST_GATE_CONFIG, optionsMinGrossR: 1.5 };
    expect(admissionBarR('single_leg_rv', cfg)).toBeCloseTo(1.5, 10);
    // model bar (1.05+0.20=1.25) is below the 1.5 floor, so the floor wins.
  });
});

describe('isEquityStructure', () => {
  it('recognises equity sleeves and treats unknown structures as options (conservative)', () => {
    expect(isEquityStructure('equity')).toBe(true);
    expect(isEquityStructure('EQUITY_SWING')).toBe(true);
    expect(isEquityStructure('swing')).toBe(true);
    expect(isEquityStructure('single_leg_otm')).toBe(false);
    expect(isEquityStructure('mystery_structure')).toBe(false);
  });
});

describe('structureCostR', () => {
  it('sums commission and maker-adjusted spread cross', () => {
    expect(structureCostR({ commissionR: 0.1, makerAdjustedSpreadCrossR: 0.5 })).toBeCloseTo(0.6, 10);
  });
});

describe('admitByCostAwareGate', () => {
  it('admits an options idea at/above the 1.25R bar and rejects below', () => {
    expect(admitByCostAwareGate(1.25, 'single_leg_rv').admit).toBe(true);
    expect(admitByCostAwareGate(1.26, 'single_leg_otm').admit).toBe(true);
    const rej = admitByCostAwareGate(0.9, 'single_leg_otm');
    expect(rej.admit).toBe(false);
    expect(rej.reason).toMatch(/cost-aware gate/);
    expect(rej.reason).toMatch(/1\.25R bar/);
  });

  it('never admits on a non-finite modeled gross R', () => {
    expect(admitByCostAwareGate(Number.NaN, 'single_leg_rv').admit).toBe(false);
    expect(admitByCostAwareGate(Number.POSITIVE_INFINITY, 'single_leg_rv').admit).toBe(false);
  });

  it('a thin-edge scratch-tier idea (~0R) is rejected — the core intent', () => {
    // The whole point: stop firing ~0-edge scratches that pay spread cross.
    const v = admitByCostAwareGate(0.03, 'single_leg_otm');
    expect(v.admit).toBe(false);
  });

  it('equity admits at a much lower gross than options', () => {
    // 0.3R gross: rejected on options (< 1.25), admitted on equity (>= 0.22).
    expect(admitByCostAwareGate(0.3, 'single_leg_rv').admit).toBe(false);
    expect(admitByCostAwareGate(0.3, 'equity').admit).toBe(true);
  });

  it('surfaces the bar decomposition on the verdict', () => {
    const v = admitByCostAwareGate(0.5, 'single_leg_rv');
    expect(v.barR).toBeCloseTo(1.25, 10);
    expect(v.costModelR).toBeCloseTo(1.05, 10);
    expect(v.safetyMarginR).toBeCloseTo(0.2, 10);
  });
});

describe('resolveCostGateConfig', () => {
  it('falls back to the shipped defaults on an empty env', () => {
    expect(resolveCostGateConfig({})).toEqual(DEFAULT_COST_GATE_CONFIG);
  });

  it('honours per-knob overrides and ignores malformed values', () => {
    const cfg = resolveCostGateConfig({
      OPTION_COST_GATE_COMMISSION_R: '0.05',
      OPTION_COST_GATE_SPREAD_CROSS_R: '0.25',
      OPTION_COST_GATE_SAFETY_MARGIN_R: '0.15',
      OPTION_COST_GATE_MIN_GROSS_R: '0.55',
    });
    expect(cfg.optionsCost.commissionR).toBeCloseTo(0.05, 10);
    expect(cfg.optionsCost.makerAdjustedSpreadCrossR).toBeCloseTo(0.25, 10);
    expect(cfg.safetyMarginR).toBeCloseTo(0.15, 10);
    expect(cfg.optionsMinGrossR).toBeCloseTo(0.55, 10);
    // Effective bar now = max(0.05+0.25+0.15, 0.55) = max(0.45, 0.55) = 0.55.
    expect(admissionBarR('single_leg_rv', cfg)).toBeCloseTo(0.55, 10);
  });

  it('rejects negative / non-numeric overrides and keeps the default', () => {
    const cfg = resolveCostGateConfig({
      OPTION_COST_GATE_COMMISSION_R: '-1',
      OPTION_COST_GATE_MIN_GROSS_R: 'abc',
    });
    expect(cfg.optionsCost.commissionR).toBeCloseTo(0.05, 10);
    expect(cfg.optionsMinGrossR).toBeCloseTo(1.2, 10);
  });
});
