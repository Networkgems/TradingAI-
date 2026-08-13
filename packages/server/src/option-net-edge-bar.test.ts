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
  // TRA-3483 — the recorder half.
  netEdgeCostBreakdown,
  netEdgeShadowAdmits,
  NET_EDGE_SHADOW_K_SWEEP,
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

// ── TRA-3483 — the recorder half (costR + the counterfactual sweep) ──────────

describe('netEdgeCostBreakdown (TRA-3483)', () => {
  it('decomposes cost into a quote term and a fee term that sum back to costR', () => {
    const b = netEdgeCostBreakdown({ mark: 1.00, bid: 0.95, ask: 1.05, riskPerShare: 0.25 }, 0.229)!;
    expect(b).not.toBeNull();
    expect(b.spreadPerShare).toBeCloseTo(0.10, 10);
    expect(b.feesPerShare).toBeCloseTo(0.00229, 10);
    expect(b.costPerShare).toBeCloseTo(0.10229, 10);
    // R basis is the trade's own (mark − stop) = 0.25.
    expect(b.costR).toBeCloseTo(0.40916, 10);
    expect(b.spreadR + b.feeR).toBeCloseTo(b.costR, 12);
    expect(b.costFracOfPremium).toBeCloseTo(0.10229, 10);
  });

  it('falls back to the 0.25·mark R basis when the site carries no stop', () => {
    const b = netEdgeCostBreakdown({ mark: 2.00, bid: 1.90, ask: 2.10 }, 0.229)!;
    expect(b.riskPerShare).toBeCloseTo(0.50, 10);
    // cost = 0.20 spread + 0.00229 fees = 0.20229 over a 0.50 R basis.
    expect(b.costR).toBeCloseTo(0.40458, 10);
  });

  it('returns null — not a zero — on an unusable quote (the fail-closed case)', () => {
    // A recorded 0 here would be a candidate whose cost is FREE. It has to be
    // absent so the ledger can count it as missing coverage instead.
    expect(netEdgeCostBreakdown({ mark: 1, bid: undefined, ask: 1.05 }, 0.229)).toBeNull();
    expect(netEdgeCostBreakdown({ mark: 1, bid: 1.10, ask: 1.05 }, 0.229)).toBeNull(); // inverted
    expect(netEdgeCostBreakdown({ mark: 0, bid: 0.95, ask: 1.05 }, 0.229)).toBeNull(); // no premium
    expect(netEdgeCostBreakdown({ mark: Number.NaN, bid: 0.95, ask: 1.05 }, 0.229)).toBeNull();
  });

  it('reports EXACTLY the costR the gate would decide on (recorder cannot drift from the form)', () => {
    // The whole point of TRA-3483: a recorder that computes its own copy of the
    // arithmetic can silently measure a different number than the gate uses, and
    // a `k` pre-registered against that number would be wrong in a way nothing
    // could detect. Both call the same primitive; this pins it.
    const inputs = { mark: 0.60, bid: 0.52, ask: 0.68, riskPerShare: 0.15 };
    const b = netEdgeCostBreakdown(inputs, CFG.feesPerContractRoundTrip)!;
    const v = netEdgeBarVerdict({ ...inputs, modeledGrossR: 0.5 }, CFG);
    expect(v.costR).toBe(b.costR);
    expect(v.costPerShare).toBe(b.costPerShare);
    expect(v.costFracOfPremium).toBe(b.costFracOfPremium);
  });
});

describe('netEdgeShadowAdmits (TRA-3483)', () => {
  const ceiling = DEFAULT_NET_EDGE_BAR_CONFIG.absCostFracCeiling;

  it('replays the ratio: admit iff costR <= k · grossR', () => {
    const s = { costR: 0.30, costFracOfPremium: 0.10, grossR: 0.50 };
    expect(netEdgeShadowAdmits(s, 0.50, ceiling)).toBe(false); // 0.30 > 0.25
    expect(netEdgeShadowAdmits(s, 0.60, ceiling)).toBe(true); // 0.30 <= 0.30
    expect(netEdgeShadowAdmits(s, 1.00, ceiling)).toBe(true);
  });

  it('is MONOTONE in k — a looser k can never admit fewer rows', () => {
    const rows = [
      { costR: 0.10, costFracOfPremium: 0.05, grossR: 0.40 },
      { costR: 0.30, costFracOfPremium: 0.10, grossR: 0.40 },
      { costR: 0.90, costFracOfPremium: 0.20, grossR: 0.40 },
    ];
    let prev = -1;
    for (const k of NET_EDGE_SHADOW_K_SWEEP) {
      const admits = rows.filter((r) => netEdgeShadowAdmits(r, k, ceiling)).length;
      expect(admits).toBeGreaterThanOrEqual(prev);
      prev = admits;
    }
  });

  it('blocks on the k-INDEPENDENT absolute ceiling and on an unknown edge at every k', () => {
    const overCeiling = { costR: 0.01, costFracOfPremium: 0.90, grossR: 99 };
    const noEdge = { costR: 0.01, costFracOfPremium: 0.05, grossR: null };
    for (const k of NET_EDGE_SHADOW_K_SWEEP) {
      expect(netEdgeShadowAdmits(overCeiling, k, ceiling)).toBe(false);
      expect(netEdgeShadowAdmits(noEdge, k, ceiling)).toBe(false);
    }
  });

  it('agrees with the real verdict on the same candidate (shadow is not a second model)', () => {
    const inputs = { mark: 1.00, bid: 0.95, ask: 1.05, riskPerShare: 0.25 };
    const b = netEdgeCostBreakdown(inputs, CFG.feesPerContractRoundTrip)!;
    for (const k of NET_EDGE_SHADOW_K_SWEEP) {
      for (const grossR of [0.1, 0.409, 0.5, 1.2]) {
        const real = netEdgeBarVerdict({ ...inputs, modeledGrossR: grossR }, { ...CFG, k }).admit;
        const shadow = netEdgeShadowAdmits(
          { costR: b.costR, costFracOfPremium: b.costFracOfPremium, grossR },
          k,
          CFG.absCostFracCeiling,
        );
        expect(shadow).toBe(real);
      }
    }
  });

  it('pins the pre-registered k grid TRA-3481 grades against', () => {
    expect([...NET_EDGE_SHADOW_K_SWEEP]).toEqual([0.40, 0.45, 0.50, 0.5876, 0.65, 0.75, 1.00, 1.25]);
  });
});
