import { describe, it, expect } from 'vitest';
import {
  detectVolEvent,
  buildWheelPromotionGate,
  type VixSession,
  type WheelPromotionGateInputs,
} from './wheel-promotion-gate.js';
import { runWheelStressSuite, type WheelBookPosition } from './wheel-vol-stress-harness.js';

const vix = (closes: number[]): VixSession[] =>
  closes.map((c, i) => ({ day: `2026-01-${String(i + 1).padStart(2, '0')}`, close: c }));

describe('detectVolEvent (TRA-2026 B1)', () => {
  it('qualifies on VIX ≥ 25 for ≥ 3 sessions', () => {
    const r = detectVolEvent(vix([15, 26, 27, 28, 14]));
    expect(r.qualifying).toBe(true);
    expect(r.sessionsAtOrAboveThreshold).toBe(3);
  });

  it('qualifies on a ≥ 30% peak-to-trough rise within a 5-session window', () => {
    const r = detectVolEvent(vix([15, 16, 21, 14, 15])); // 14 → 21 is +50% inside the window
    expect(r.qualifying).toBe(true);
    expect(r.maxWindowRiseFraction).toBeGreaterThanOrEqual(0.3);
  });

  it('does not qualify on a calm tape', () => {
    const r = detectVolEvent(vix([14, 15, 16, 15, 14, 15]));
    expect(r.qualifying).toBe(false);
  });

  it('a drop then a smaller rise does not fabricate a spike', () => {
    // Descending series: no trough-before-peak rise ≥ 30%, and no ≥25 cluster.
    const r = detectVolEvent(vix([20, 18, 16, 14, 12]));
    expect(r.qualifying).toBe(false);
  });
});

function inputs(over: Partial<WheelPromotionGateInputs> = {}): WheelPromotionGateInputs {
  return {
    stress: runWheelStressSuite([], 100_000),
    volEvent: detectVolEvent([]),
    resolvedLosers: { count: 0, realizedVsModeledMaxLossRatio: null },
    costNetRExpectancy: null,
    partA: { enteredCostNetR: null, unfilteredCostNetR: null },
    ...over,
  };
}

const wellSizedCsp: WheelBookPosition = {
  symbol: 'SPY', kind: 'cash_secured_put', contracts: 1, shares: 0,
  strike: 100, spot: 105, creditPerShare: 1.5, costBasisPerShare: 0, atmIv: 0.2, dte: 30,
};

describe('buildWheelPromotionGate', () => {
  it('is pending (not eligible) on an empty forward book', () => {
    const r = buildWheelPromotionGate(inputs());
    expect(r.promotionEligible).toBe(false);
    // Every criterion pending or, for the empty stress, pending — none is a hard pass.
    expect(r.criteria.every((c) => c.status !== 'pass')).toBe(true);
  });

  it('requires EVERY criterion to pass for eligibility', () => {
    const stress = runWheelStressSuite([wellSizedCsp], 1_000_000); // zero breaches
    const r = buildWheelPromotionGate(
      inputs({
        stress,
        volEvent: detectVolEvent(vix([26, 27, 28])), // qualifying vol event
        resolvedLosers: { count: 10, realizedVsModeledMaxLossRatio: 0.9 },
        costNetRExpectancy: 0.15,
        partA: { enteredCostNetR: 0.2, unfilteredCostNetR: 0.05 },
      }),
    );
    expect(r.promotionEligible).toBe(true);
    expect(r.criteria.every((c) => c.status === 'pass')).toBe(true);
  });

  it('B1 passes on zero-breach stress even without a live vol event', () => {
    const stress = runWheelStressSuite([wellSizedCsp], 1_000_000);
    const r = buildWheelPromotionGate(inputs({ stress }));
    const b1 = r.criteria.find((c) => c.key === 'B1_vol_event_or_stress');
    expect(b1?.status).toBe('pass');
  });

  it('B2 fails when a scenario trips a cap breach', () => {
    // Tiny equity → the CSP at-risk blows past the 6% risk cap on every scenario.
    const stress = runWheelStressSuite([wellSizedCsp], 1_000);
    const r = buildWheelPromotionGate(inputs({ stress }));
    const b2 = r.criteria.find((c) => c.key === 'B2_defined_risk_holds');
    expect(b2?.status).toBe('fail');
    expect(r.promotionEligible).toBe(false);
  });

  it('B3 fails when realized losses exceed the modeled defined-risk max', () => {
    const r = buildWheelPromotionGate(
      inputs({ resolvedLosers: { count: 12, realizedVsModeledMaxLossRatio: 1.4 } }),
    );
    const b3 = r.criteria.find((c) => c.key === 'B3_loss_distribution');
    expect(b3?.status).toBe('fail');
  });

  it('B3 stays pending below the ≥8-loser floor', () => {
    const r = buildWheelPromotionGate(
      inputs({ resolvedLosers: { count: 5, realizedVsModeledMaxLossRatio: 0.8 } }),
    );
    expect(r.criteria.find((c) => c.key === 'B3_loss_distribution')?.status).toBe('pending');
  });

  it('A fails when the entered set does not beat the unfiltered set', () => {
    const r = buildWheelPromotionGate(
      inputs({ partA: { enteredCostNetR: 0.05, unfilteredCostNetR: 0.05 } }),
    );
    expect(r.criteria.find((c) => c.key === 'A_iv_filter_edge')?.status).toBe('fail');
  });

  it('B4 fails on a negative cost-net R across the stressed window', () => {
    const r = buildWheelPromotionGate(inputs({ costNetRExpectancy: -0.1 }));
    expect(r.criteria.find((c) => c.key === 'B4_cost_net_r_positive')?.status).toBe('fail');
  });
});
