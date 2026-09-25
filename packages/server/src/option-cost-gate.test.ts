import { describe, it, expect } from 'vitest';
import {
  isOptionCostAwareGateEnabled,
  resolveCostGateConfig,
  admissionBarR,
  structureCostR,
  isEquityStructure,
  DEFAULT_COST_GATE_CONFIG,
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
  it('options structures resolve to the ~0.4386R bar', () => {
    // costModel 0.0036 (MEASURED commission, TRA-4890) + 0.235 (MEASURED spread
    // cross) = 0.2386, + 0.20 margin = 0.4386, clear of the 0.30 backstop floor.
    // Was 0.485 off the conservative 0.05 commission stand-in, and 1.25R before
    // that off the phantom 1.00R spread input.
    for (const s of ['single_leg_otm', 'single_leg_rv', 'directional', 'bull_put']) {
      expect(admissionBarR(s)).toBeCloseTo(0.4386, 10);
    }
  });

  it('the TRA-4890 commission retune does not let the backstop floor pin the bar', () => {
    // The retune LOOSENS, so the failure mode that matters is the opposite one:
    // a floor at or above the new model bar would make the cost inputs inert and
    // the gate would read "retuned" while behaving identically. Checked for both
    // configs that exist — the shipped 0.20 margin and bqb1's env-set 0.10.
    expect(admissionBarR('single_leg_otm')).toBeGreaterThan(DEFAULT_COST_GATE_CONFIG.optionsMinGrossR);
    const live = { ...DEFAULT_COST_GATE_CONFIG, safetyMarginR: 0.1 };
    expect(admissionBarR('single_leg_otm', live)).toBeCloseTo(0.3386, 10);
    expect(admissionBarR('single_leg_otm', live)).toBeGreaterThan(live.optionsMinGrossR);
  });

  it('moves the bar by exactly the 0.0464R the TRA-4894 controls are written against', () => {
    // tra4894-real-fill-promotion-gate.test.ts hard-codes this delta as the move
    // that flips `single_leg_otm::0.50-0.55` on the POOLED arm. If this drifts,
    // that file's premise is stale and its controls stop grading what they claim.
    const prior = { ...DEFAULT_COST_GATE_CONFIG, optionsCost: { ...DEFAULT_COST_GATE_CONFIG.optionsCost, commissionR: 0.05 } };
    expect(admissionBarR('single_leg_otm', prior) - admissionBarR('single_leg_otm')).toBeCloseTo(0.0464, 10);
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
    // model bar (0.2386+0.20=0.4386) is below the 1.5 floor, so the floor wins.
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

// TRA-3391 — the `admitByCostAwareGate` suite that lived here was deleted with the
// function. The admit/reject decision moved to `tapeExpectancyVerdict`
// (`option-tape-expectancy.test.ts`), which tests the same three properties on the
// number that replaced `modeledGrossR`: it clears/misses the SAME `admissionBarR`,
// it never admits on a non-finite edge, and options and equity keep different bars.
// The BAR itself is still tested above — that half was not retired.

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
    expect(cfg.optionsCost.commissionR).toBeCloseTo(0.0036, 10);
    expect(cfg.optionsMinGrossR).toBeCloseTo(0.3, 10);
  });
});

// ── TRA-3216 / TRA-3391: the CONSTANT half of "why did the bar block" ────────
//
// The shortfall CLASSIFIER moved to `option-tape-expectancy.ts` with the decision
// (its bucket edges, `COST_GATE_SHORTFALL_BUCKETS_R`, stay here because they are
// read against `admissionBarR`). What is still this module's to prove is the bar
// description — including the floor-pinning trap, which is unaffected by the
// estimator swap and is still the most common way a "retune" ships as a no-op.
describe('cost gate bar description (TRA-3216)', () => {
  it('describes the bar composition, and flags the floor PINNING it (a retune no-op)', () => {
    // Shipped config: 0.0036 + 0.235 + 0.20 = 0.4386R, clear of the 0.30 floor.
    const shipped = describeCostGateBar('single_leg_otm');
    expect(shipped.barR).toBeCloseTo(0.4386, 10);
    expect(shipped.barPinnedByFloor).toBe(false);
    // The TRA-4890 retune shrinks the commission term by ~14×, so the spread
    // cross dominates by MORE than before — the retune cannot silently hand
    // dominance to the term it just cut.
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
