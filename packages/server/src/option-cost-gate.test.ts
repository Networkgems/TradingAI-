import { describe, it, expect } from 'vitest';
import {
  isOptionCostAwareGateEnabled,
  resolveCostGateConfig,
  admissionBarR,
  admitByCostAwareGate,
  structureCostR,
  isEquityStructure,
  DEFAULT_COST_GATE_CONFIG,
  costGateBlockReasonCode,
  describeCostGateBar,
} from './option-cost-gate.js';
import { SLEEVE_SPREAD_CEILINGS } from './option-spread-cost.js';

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

describe('admissionBarR — default config rides the MEASURED spread cross (TRA-1656 → TRA-1661)', () => {
  it('options structures resolve to the ~0.485R bar', () => {
    // costModel 0.05 + 0.235 (MEASURED) = 0.285, + 0.20 margin = 0.485, clear of
    // the 0.30 backstop floor. Was 1.25R off the phantom 1.00R spread input.
    for (const s of ['single_leg_otm', 'single_leg_rv', 'directional', 'bull_put']) {
      expect(admissionBarR(s)).toBeCloseTo(0.485, 10);
    }
  });

  it('the spread-cross input sits BELOW both sleeve ceilings (TRA-1656 feasibility)', () => {
    // The refutation that killed 1.00R: spreadCrossR = 4·spreadPct, and the
    // scanners hard-reject spreadPct > 0.20 (OTM) / 0.10 (RV) before selection,
    // so no admissible contract can cross above 0.80R / 0.40R. Any cost input
    // above a sleeve's ceiling bills candidates more than the worst contract the
    // scanner can buy. Guards a future retune from re-crossing that line.
    const crossR = DEFAULT_COST_GATE_CONFIG.optionsCost.makerAdjustedSpreadCrossR;
    expect(crossR).toBeLessThan(SLEEVE_SPREAD_CEILINGS['single_leg_otm']!.maxSpreadCrossR);
    expect(crossR).toBeLessThan(SLEEVE_SPREAD_CEILINGS['single_leg_rv']!.maxSpreadCrossR);
  });

  it('the shipped floor is NON-BINDING — the measured cost input actually moves the bar', () => {
    // The trap TRA-1661 calls out: admissionBarR = max(costModel+margin, floor),
    // so a floor left above the cost model PINS the bar and the cost input goes
    // inert — the gate reads as "retuned" while behaving identically. Assert the
    // default floor does NOT bind, and that the bar tracks the cost input.
    const { optionsCost, safetyMarginR, optionsMinGrossR } = DEFAULT_COST_GATE_CONFIG;
    const modelBar = optionsCost.commissionR + optionsCost.makerAdjustedSpreadCrossR + safetyMarginR;
    expect(optionsMinGrossR).toBeLessThan(modelBar);

    const halved = {
      ...DEFAULT_COST_GATE_CONFIG,
      optionsCost: { ...optionsCost, makerAdjustedSpreadCrossR: optionsCost.makerAdjustedSpreadCrossR / 2 },
    };
    expect(admissionBarR('single_leg_rv', halved)).toBeLessThan(admissionBarR('single_leg_rv'));
  });

  it('equity structures keep a far lower bar', () => {
    // 0.00 + 0.02 = 0.02, + 0.20 margin = 0.22, no floor.
    expect(admissionBarR('equity')).toBeCloseTo(0.22, 10);
    expect(admissionBarR('equity_swing')).toBeCloseTo(0.22, 10);
  });

  it('the options floor lifts the bar above the pure cost model when set high', () => {
    const cfg = { ...DEFAULT_COST_GATE_CONFIG, optionsMinGrossR: 1.5 };
    expect(admissionBarR('single_leg_rv', cfg)).toBeCloseTo(1.5, 10);
    // model bar (0.285+0.20=0.485) is below the 1.5 floor, so the floor wins.
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
  it('admits an options idea at/above the 0.485R bar and rejects below', () => {
    expect(admitByCostAwareGate(0.485, 'single_leg_rv').admit).toBe(true);
    expect(admitByCostAwareGate(0.5, 'single_leg_otm').admit).toBe(true);
    const rej = admitByCostAwareGate(0.4, 'single_leg_otm');
    expect(rej.admit).toBe(false);
    expect(rej.reason).toMatch(/cost-aware gate/);
    expect(rej.reason).toMatch(/0\.48R bar/); // barR.toFixed(2) of 0.485
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
    // 0.3R gross: rejected on options (< 0.485), admitted on equity (>= 0.22).
    expect(admitByCostAwareGate(0.3, 'single_leg_rv').admit).toBe(false);
    expect(admitByCostAwareGate(0.3, 'equity').admit).toBe(true);
  });

  it('surfaces the bar decomposition on the verdict', () => {
    const v = admitByCostAwareGate(0.4, 'single_leg_rv');
    expect(v.barR).toBeCloseTo(0.485, 10);
    expect(v.costModelR).toBeCloseTo(0.285, 10);
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
    expect(cfg.optionsMinGrossR).toBeCloseTo(0.3, 10);
  });
});

// ── TRA-3216: making a 99.15% live block rate diagnosable ────────────────────
describe('cost gate block classification (TRA-3216)', () => {
  const bar = admissionBarR('single_leg_otm'); // 0.485R under the shipped config

  it('returns null for an admit — an admitted candidate has no block to classify', () => {
    expect(costGateBlockReasonCode(admitByCostAwareGate(bar + 0.01, 'single_leg_otm'))).toBeNull();
  });

  it('buckets the shortfall so "how far would the bar have to move" is answerable', () => {
    const code = (gross: number) => costGateBlockReasonCode(admitByCostAwareGate(gross, 'single_leg_otm'));
    expect(code(bar - 0.01)).toBe('shortfall_lt_0.10');
    expect(code(bar - 0.15)).toBe('shortfall_0.10_0.25');
    expect(code(bar - 0.30)).toBe('shortfall_0.25_0.50');
    // The shipped 0.485R bar is too low for a >=0.50R shortfall to exist at a
    // NON-negative gross (0.485 - 0.50 < 0), and `gross_negative` deliberately
    // wins that overlap — so exercise the far bucket against a raised bar.
    const highBar = resolveCostGateConfig({ OPTION_COST_GATE_MIN_GROSS_R: '1.2' } as NodeJS.ProcessEnv);
    expect(costGateBlockReasonCode(admitByCostAwareGate(0.5, 'single_leg_otm', highBar))).toBe('shortfall_gte_0.50');
    // Negative gross classifies as negative regardless of how far under it is.
    expect(code(bar - 0.90)).toBe('gross_negative');
  });

  it('separates the two blocks NO bar retune can recover from the tuneable ones', () => {
    // Non-finite gross: the gate failed closed on an unknown edge. Dropping the
    // bar to zero admits none of these — the estimator is the defect, not the bar.
    expect(costGateBlockReasonCode(admitByCostAwareGate(Number.NaN, 'single_leg_otm'))).toBe('gross_unknown');
    // Negative modeled gross: structurally hopeless at any bar above 0.
    expect(costGateBlockReasonCode(admitByCostAwareGate(-0.2, 'single_leg_otm'))).toBe('gross_negative');
  });

  it('emits a BOUNDED key set — the codes must stay foldable across thousands of blocks', () => {
    const codes = new Set<string>();
    for (let g = -2; g <= 1; g += 0.001) {
      const c = costGateBlockReasonCode(admitByCostAwareGate(g, 'single_leg_otm'));
      if (c) codes.add(c);
    }
    expect(codes.size).toBeLessThanOrEqual(6);
  });

  it('describes the bar composition, and flags the floor PINNING it (a retune no-op)', () => {
    // Shipped config: 0.05 + 0.235 + 0.20 = 0.485R, clear of the 0.30 floor.
    const shipped = describeCostGateBar('single_leg_otm');
    expect(shipped.barR).toBeCloseTo(0.485, 10);
    expect(shipped.barPinnedByFloor).toBe(false);
    expect(shipped.dominantTerm).toBe('spread_cross');

    // Raise the floor above costModel+margin and the measured cost inputs go
    // INERT: retuning commission/spread alone cannot move the bar. This is the
    // exact trap DEFAULT_COST_GATE_CONFIG's docstring warns about.
    const pinned = describeCostGateBar(
      'single_leg_otm',
      resolveCostGateConfig({ OPTION_COST_GATE_MIN_GROSS_R: '1.2' } as NodeJS.ProcessEnv),
    );
    expect(pinned.barR).toBeCloseTo(1.2, 10);
    expect(pinned.barPinnedByFloor).toBe(true);
    expect(pinned.dominantTerm).toBe('min_gross_floor');

    // Proof it is a no-op while pinned: halve the spread cross, bar is unchanged.
    const stillPinned = describeCostGateBar(
      'single_leg_otm',
      resolveCostGateConfig({
        OPTION_COST_GATE_MIN_GROSS_R: '1.2',
        OPTION_COST_GATE_SPREAD_CROSS_R: '0.1175',
      } as NodeJS.ProcessEnv),
    );
    expect(stillPinned.barR).toBeCloseTo(pinned.barR, 10);
  });
});
