// TRA-4749 (parent TRA-4622 §4) — the bar every gated structure faces.
//
// The defect: `arm.costBar.bar` published ONE bar, hard-coded to
// `single_leg_otm`, while the retained ledger recorded `single_leg_rv` at 633
// evaluated / 633 blocked by the same gate. These tests pin the two claims the
// sleeve owner's re-ruling rests on:
//
//   1. RV is charged the OTM bar — the SAME number, not a coincidentally equal
//      one — because `admissionBarR` branches only on `isEquityStructure`.
//   2. The structure list is derived from LIVE RECORDED STATE, so the next
//      unpublished sleeve appears on its first decision instead of waiting for
//      someone to notice a literal.

import { describe, it, expect } from 'vitest';
import {
  resolveGatedStructureBars,
  COST_BAR_PUBLISHED_STRUCTURE,
} from './live-enforce-gate-bars.js';
import { DEFAULT_COST_GATE_CONFIG, describeCostGateBar } from './option-cost-gate.js';

/**
 * The live bqb1 config: margin cut to 0.1 via `OPTION_COST_GATE_SAFETY_MARGIN_R`
 * — the host sets that key and NO other cost knob (measured against its env list
 * 2026-09-25), which is why the `commissionR` default is load-bearing here —
 * floor 0.3. The bar was 0.385 until TRA-4890 retuned `commissionR` 0.05 →
 * 0.0036 (the MEASURED Tradier Pro fee); it is now 0.0036 + 0.235 + 0.1 = 0.3386.
 */
const LIVE_CONFIG = { ...DEFAULT_COST_GATE_CONFIG, safetyMarginR: 0.1 };

describe('resolveGatedStructureBars — the RV question (AC1/AC3)', () => {
  it('publishes single_leg_rv once the ledger has recorded a single decision under it', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_otm', 'single_leg_rv'],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    const rv = bars.find((b) => b.structure === 'single_leg_rv');
    expect(rv, 'single_leg_rv must be published, not inferred from the OTM bar').toBeDefined();
    expect(rv!.sources).toContain('ledger_scope');
    expect(rv!.scopeLabels).toEqual(['single_leg_rv']);
  });

  it('charges single_leg_rv the OTM bar — identical composition, field for field', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_rv'],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    const rv = bars.find((b) => b.structure === 'single_leg_rv')!;
    const otm = bars.find((b) => b.structure === COST_BAR_PUBLISHED_STRUCTURE)!;

    expect(rv.barIdenticalToOtm).toBe(true);
    expect(rv.costInputs).toBe('options');
    // The live numbers the ticket cites, so a config move is caught here.
    expect(rv.barR).toBeCloseTo(0.3386, 10);
    expect(rv.costModelR).toBeCloseTo(0.2386, 10);
    expect(rv.spreadCrossR).toBeCloseTo(0.235, 10);
    // The retune LOOSENS, so the floor is the thing that could silently absorb
    // it. 0.3386 clears the 0.3 floor, so the move reaches the live gate.
    expect(rv.barPinnedByFloor).toBe(false);
    // Every composition field equals OTM's. `structure` and the provenance
    // fields are the only things that may differ.
    for (const k of [
      'barR',
      'costModelR',
      'commissionR',
      'spreadCrossR',
      'safetyMarginR',
      'minGrossR',
      'barPinnedByFloor',
      'dominantTerm',
    ] as const) {
      expect(rv[k], `${k} must equal the OTM bar's`).toEqual(otm[k]);
    }
  });

  it('is byte-identical to `describeCostGateBar` for each structure — it renders, never re-derives', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_rv', 'directional'],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    for (const b of bars) {
      const { sources, scopeLabels, costInputs, barIdenticalToOtm, ...composition } = b;
      expect(composition).toEqual(describeCostGateBar(b.structure, LIVE_CONFIG));
      expect(sources.length).toBeGreaterThan(0);
      expect(scopeLabels.length).toBeGreaterThan(0);
      expect(typeof costInputs).toBe('string');
      expect(typeof barIdenticalToOtm).toBe('boolean');
    }
  });

  it('folds `directional` onto `single_leg_directional` and keeps BOTH raw labels readable', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['directional'],
      cellStructures: ['single_leg_directional'],
      config: LIVE_CONFIG,
    });
    const dir = bars.filter((b) => b.structure.includes('directional'));
    expect(dir).toHaveLength(1);
    expect(dir[0]!.structure).toBe('single_leg_directional');
    // A reader holding a `byScope: "directional"` row must be able to find it.
    expect(dir[0]!.scopeLabels).toEqual(['directional', 'single_leg_directional']);
    expect(dir[0]!.sources).toEqual(['ledger_scope', 'expectancy_cell']);
  });

  it('equity takes the OTHER cost-input set — the only branch that exists', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['equity_swing'],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    const eq = bars.find((b) => b.structure === 'equity_swing')!;
    expect(eq.costInputs).toBe('equity');
    expect(eq.barIdenticalToOtm).toBe(false);
    expect(eq.barR).toBeCloseTo(0.12, 10); // 0.00 + 0.02 + 0.1, no floor
  });
});

describe('resolveGatedStructureBars — derived from live state, never a roster', () => {
  it('always publishes the structure `bar` is hard-coded to, even at zero observations', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: [],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    expect(bars).toHaveLength(1);
    expect(bars[0]!.structure).toBe(COST_BAR_PUBLISHED_STRUCTURE);
    expect(bars[0]!.sources).toEqual(['published_bar']);
  });

  it('picks up a sleeve that has only ever been FOLDED, never decided', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: [],
      cellStructures: ['single_leg_rv'],
      config: LIVE_CONFIG,
    });
    const rv = bars.find((b) => b.structure === 'single_leg_rv')!;
    expect(rv.sources).toEqual(['expectancy_cell']);
  });

  it('dedupes repeated scopes and ignores blank labels', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_rv', 'single_leg_rv', '  ', ''],
      cellStructures: ['single_leg_rv'],
      config: LIVE_CONFIG,
    });
    expect(bars.map((b) => b.structure)).toEqual(['single_leg_otm', 'single_leg_rv']);
    const rv = bars[1]!;
    expect(rv.scopeLabels).toEqual(['single_leg_rv']);
    expect(rv.sources).toEqual(['ledger_scope', 'expectancy_cell']);
  });

  it('orders the published structure first, then alphabetically — a stable diff', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_rv', 'equity_swing', 'single_leg_directional'],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    expect(bars.map((b) => b.structure)).toEqual([
      'single_leg_otm',
      'equity_swing',
      'single_leg_directional',
      'single_leg_rv',
    ]);
  });

  it('an UNRECOGNISED sleeve gets the options bar, not a free pass', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['some_new_sleeve'],
      cellStructures: [],
      config: LIVE_CONFIG,
    });
    const s = bars.find((b) => b.structure === 'some_new_sleeve')!;
    expect(s.costInputs).toBe('options');
    expect(s.barIdenticalToOtm).toBe(true);
  });
});

describe('resolveGatedStructureBars — AC4: it moves no number', () => {
  it('the OTM entry equals the config the route already publishes as `bar`', () => {
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_rv'],
      cellStructures: ['single_leg_rv', 'single_leg_otm'],
      config: DEFAULT_COST_GATE_CONFIG,
    });
    const otm = bars.find((b) => b.structure === COST_BAR_PUBLISHED_STRUCTURE)!;
    const {
      sources: _s, scopeLabels: _l, costInputs: _c, barIdenticalToOtm: _i, ...composition
    } = otm;
    expect(composition).toEqual(
      describeCostGateBar(COST_BAR_PUBLISHED_STRUCTURE, DEFAULT_COST_GATE_CONFIG),
    );
    // Nothing in this module can reach a config; it is handed one.
    expect(composition.safetyMarginR).toBe(DEFAULT_COST_GATE_CONFIG.safetyMarginR);
    expect(composition.minGrossR).toBe(DEFAULT_COST_GATE_CONFIG.optionsMinGrossR);
  });

  it('⭐ the 0.30 options FLOOR refuses the live RV cell under a ZEROED cost model', () => {
    // The live `single_leg_rv::0.55-1.00` cell bound, read 2026-09-20.
    const rvLowerCI95 = -0.05111250957930491;
    const zeroed = {
      ...LIVE_CONFIG,
      optionsCost: { commissionR: 0, makerAdjustedSpreadCrossR: 0 },
      safetyMarginR: 0,
    };
    const bars = resolveGatedStructureBars({
      scopeLabels: ['single_leg_rv'],
      cellStructures: [],
      config: zeroed,
    });
    const rv = bars.find((b) => b.structure === 'single_leg_rv')!;
    // Every cost input at zero and the bar is STILL the floor, not zero.
    expect(rv.barR).toBeCloseTo(0.3, 10);
    expect(rv.barPinnedByFloor).toBe(true);
    expect(rv.dominantTerm).toBe('min_gross_floor');
    // So the 633 refusals are invariant to every cost parameter: the cell bound
    // is NEGATIVE and the cheapest reachable options bar is +0.30.
    expect(rvLowerCI95).toBeLessThan(rv.barR);
  });
});
