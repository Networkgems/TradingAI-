// TRA-3272 — unit tests for the NET-EDGE cost-bar form (pure logic + resolver).
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_NET_EDGE_BAR_CONFIG,
  OPTION_NET_EDGE_BAR_FLAG,
  OPTION_NET_EDGE_K_VAR,
  OPTION_NET_EDGE_FEES_PER_CONTRACT_RT_VAR,
  OPTION_NET_EDGE_ABS_COST_FRAC_CEILING_VAR,
  OPTION_NET_EDGE_STRUCTURES_VAR,
  isNetEdgeGovernedStructure,
  netEdgeBarVerdict,
  resolveNetEdgeBarConfig,
  describeNetEdgeBar,
} from './option-net-edge-bar.js';

const CFG = { k: 1.0, feesPerContractRoundTrip: 0.229, absCostFracCeiling: 0.5 };

describe('netEdgeBarVerdict', () => {
  it('admits a tight-quoted OTM candidate whose edge covers its own cost (the TRA-3271 re-opened band)', () => {
    // |delta| 0.20 on the 2:1 bracket → modeled edge 3·0.20 − 1 = −0.40… that is
    // negative; use 0.40 delta → edge 0.20R. mark $0.50, 2-cent spread.
    // cost = 0.02 + 0.00229 = $0.02229/share; risk = 0.125/share → costR 0.178.
    // 0.178 ≤ 1.0 × 0.20 → ADMIT. The flat 0.485R bar blocks this same candidate.
    const v = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.49, ask: 0.51, riskPerShare: 0.125, modeledGrossR: 0.2 },
      CFG,
    );
    expect(v.admit).toBe(true);
    expect(v.reasonCode).toBeNull();
    expect(v.costR).toBeCloseTo(0.17832, 4);
    expect(v.requiredEdgeR).toBeCloseTo(0.17832, 4);
  });

  it('blocks when cost exceeds k × edge, with the foldable reason code', () => {
    // Same candidate but a 10-cent spread: cost = 0.10229/share → costR 0.818 > 0.20.
    const v = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.45, ask: 0.55, riskPerShare: 0.125, modeledGrossR: 0.2 },
      CFG,
    );
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('net_edge_cost_exceeds_k_edge');
    expect(v.reason).toContain('net-edge bar');
  });

  it('k scales the bar: the same candidate flips with a looser k', () => {
    const inputs = { mark: 0.5, bid: 0.47, ask: 0.53, riskPerShare: 0.125, modeledGrossR: 0.2 };
    // cost = 0.06229 → costR 0.498 > 1.0×0.2 (block) but ≤ 3.0×0.2 (admit).
    expect(netEdgeBarVerdict(inputs, CFG).admit).toBe(false);
    expect(netEdgeBarVerdict(inputs, { ...CFG, k: 3.0 }).admit).toBe(true);
  });

  it('the absolute ceiling blocks a deep-cheap contract regardless of modeled edge', () => {
    // mark $0.04: fees alone are 0.00229/0.04 = 5.7% but a 2-cent spread makes
    // cost 0.02229/0.04 = 55.7% of premium > 50% ceiling. Edge 5R does not rescue it.
    const v = netEdgeBarVerdict(
      { mark: 0.04, bid: 0.03, ask: 0.05, riskPerShare: 0.01, modeledGrossR: 5 },
      CFG,
    );
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('net_edge_abs_ceiling');
  });

  it('a negative or zero modeled edge blocks (any positive cost exceeds k × edge)', () => {
    const v = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.49, ask: 0.51, riskPerShare: 0.125, modeledGrossR: -0.4 },
      CFG,
    );
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('net_edge_cost_exceeds_k_edge');
  });

  it('fails CLOSED on an unusable quote (missing / inverted / non-finite)', () => {
    for (const [bid, ask] of [
      [undefined, 0.51],
      [0.49, undefined],
      [0.51, 0.49], // inverted
      [Number.NaN, 0.51],
    ] as Array<[number | undefined, number | undefined]>) {
      const v = netEdgeBarVerdict({ mark: 0.5, bid, ask, modeledGrossR: 2 }, CFG);
      expect(v.admit).toBe(false);
      expect(v.reasonCode).toBe('net_edge_quote_unusable');
    }
  });

  it('fails CLOSED on a non-finite modeled edge (estimator defect, not tuning)', () => {
    const v = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.49, ask: 0.51, riskPerShare: 0.125, modeledGrossR: Number.NaN },
      CFG,
    );
    expect(v.admit).toBe(false);
    expect(v.reasonCode).toBe('net_edge_edge_unknown');
  });

  it('falls back to the 0.25·mark R basis when no riskPerShare is given', () => {
    const explicit = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.49, ask: 0.51, riskPerShare: 0.125, modeledGrossR: 0.2 },
      CFG,
    );
    const fallback = netEdgeBarVerdict(
      { mark: 0.5, bid: 0.49, ask: 0.51, modeledGrossR: 0.2 },
      CFG,
    );
    expect(fallback.costR).toBeCloseTo(explicit.costR, 10);
  });
});

describe('resolveNetEdgeBarConfig', () => {
  it('is OFF by default with the shipped placeholders', () => {
    const c = resolveNetEdgeBarConfig({});
    expect(c.enabled).toBe(false);
    expect(c.k).toBe(DEFAULT_NET_EDGE_BAR_CONFIG.k);
    expect(c.feesPerContractRoundTrip).toBe(0.229);
    expect(c.absCostFracCeiling).toBe(0.5);
    expect(c.structures).toEqual(['single_leg_otm']);
  });

  it('reads the knobs and falls back field-by-field on malformed values', () => {
    const c = resolveNetEdgeBarConfig({
      [OPTION_NET_EDGE_BAR_FLAG]: '1',
      [OPTION_NET_EDGE_K_VAR]: '0.75',
      [OPTION_NET_EDGE_FEES_PER_CONTRACT_RT_VAR]: 'garbage',
      [OPTION_NET_EDGE_ABS_COST_FRAC_CEILING_VAR]: '0', // a 0 ceiling blocks everything — treated as typo
      [OPTION_NET_EDGE_STRUCTURES_VAR]: 'single_leg_otm, Single_Leg_RV',
    });
    expect(c.enabled).toBe(true);
    expect(c.k).toBe(0.75);
    expect(c.feesPerContractRoundTrip).toBe(0.229);
    expect(c.absCostFracCeiling).toBe(0.5);
    expect(c.structures).toEqual(['single_leg_otm', 'single_leg_rv']);
  });

  it('an empty STRUCTURES value falls back to the default list', () => {
    const c = resolveNetEdgeBarConfig({ [OPTION_NET_EDGE_STRUCTURES_VAR]: ' , ' });
    expect(c.structures).toEqual(['single_leg_otm']);
  });
});

describe('isNetEdgeGovernedStructure', () => {
  it('requires the flag AND structure membership', () => {
    const off = resolveNetEdgeBarConfig({});
    const on = resolveNetEdgeBarConfig({ [OPTION_NET_EDGE_BAR_FLAG]: 'true' });
    expect(isNetEdgeGovernedStructure('single_leg_otm', off)).toBe(false);
    expect(isNetEdgeGovernedStructure('single_leg_otm', on)).toBe(true);
    expect(isNetEdgeGovernedStructure('single_leg_rv', on)).toBe(false);
    expect(isNetEdgeGovernedStructure('directional', on)).toBe(false);
  });
});

describe('describeNetEdgeBar', () => {
  it('publishes resolved values AND the raw env so a typo is visible, not inferred', () => {
    const d = describeNetEdgeBar({ [OPTION_NET_EDGE_K_VAR]: 'oops' });
    expect(d.enabled).toBe(false);
    expect(d.k).toBe(1.0);
    expect(d.raw.k).toBe('oops');
    expect(d.raw.fees).toBeNull();
  });
});
