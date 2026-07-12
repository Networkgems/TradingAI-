import { describe, it, expect } from 'vitest';
import {
  estimateModeledGrossR,
  resolveModeledGrossRConfig,
  DEFAULT_MODELED_GROSS_R_CONFIG,
} from './option-modeled-gross-r.js';
import { admitByCostAwareGate } from './option-cost-gate.js';

// TRA-1602 (deliverable C of TRA-1600) — per-candidate modeled gross R estimator.
// PROPOSED construction pending QuantTrader spec sign-off; these tests pin the
// strawman's arithmetic so a spec change is a visible, intentional diff.

describe('estimateModeledGrossR — RV/OTM 2:1 structures', () => {
  it('reduces to 3·|delta| − 1 on a mark*1.5 / mark*0.75 (2:1) structure', () => {
    // rewardR = (1.5m − m)/(m − 0.75m) = 0.5/0.25 = 2; winProb = |delta|.
    // modeledGrossR = |delta|·2 − (1 − |delta|) = 3·|delta| − 1.
    const mark = 2.0;
    for (const delta of [0.3, 0.4, 0.5, 0.6, 0.7]) {
      const est = estimateModeledGrossR({
        mark,
        delta,
        targetPrice: mark * 1.5,
        stopPrice: mark * 0.75,
      });
      expect(est.rewardR).toBeCloseTo(2, 10);
      expect(est.rewardSource).toBe('target_stop');
      expect(est.modeledGrossR).toBeCloseTo(3 * delta - 1, 10);
    }
  });

  it('clears the MEASURED-cost 0.485R options bar around |delta| ≈ 0.495 (TRA-1661)', () => {
    const mark = 3.0;
    // TRA-1661 replaced the gate's phantom 1.00R spread input with the MEASURED
    // 0.235R (TRA-1656) and unpinned the floor, dropping the effective options bar
    // 1.25R → 0.485R. Under the same `3·|delta| − 1` estimator the admission
    // boundary therefore moves 0.75 → ~0.495; use deltas comfortably either side so
    // the assertion is not sitting on the float-exact knife-edge.
    const at55 = estimateModeledGrossR({ mark, delta: 0.55, targetPrice: mark * 1.5, stopPrice: mark * 0.75 });
    const at45 = estimateModeledGrossR({ mark, delta: 0.45, targetPrice: mark * 1.5, stopPrice: mark * 0.75 });
    // 3·0.55 − 1 = 0.65 → admits; 3·0.45 − 1 = 0.35 → rejects.
    expect(admitByCostAwareGate(at55.modeledGrossR, 'single_leg_rv').admit).toBe(true);
    expect(admitByCostAwareGate(at45.modeledGrossR, 'single_leg_otm').admit).toBe(false);
  });

  it('rejects a far-OTM lottery delta (0.40 floor) as scratch-tier', () => {
    const mark = 0.5;
    const est = estimateModeledGrossR({ mark, delta: 0.4, targetPrice: mark * 1.5, stopPrice: mark * 0.75 });
    // 3·0.40 − 1 = 0.20R — still under the 0.485R options bar even after TRA-1661
    // dropped it off the measured spread cross.
    expect(est.modeledGrossR).toBeCloseTo(0.2, 10);
    expect(admitByCostAwareGate(est.modeledGrossR, 'single_leg_otm').admit).toBe(false);
  });

  it('uses the real target/stop reward ratio, not a hardcoded 2, for skewed exits', () => {
    // A 3:1 structure (target +75%, stop −25% of premium) at 0.5 delta.
    const mark = 4.0;
    const est = estimateModeledGrossR({ mark, delta: 0.5, targetPrice: mark * 1.75, stopPrice: mark * 0.75 });
    expect(est.rewardR).toBeCloseTo(3, 10); // 0.75 / 0.25
    expect(est.modeledGrossR).toBeCloseTo(0.5 * 3 - 0.5, 10); // 1.0R
  });
});

describe('estimateModeledGrossR — directional path (no fixed target/stop)', () => {
  it('falls back to the signal riskRewardRatio when target/stop are absent', () => {
    const est = estimateModeledGrossR({ mark: 2.5, delta: 0.55, riskRewardRatio: 2 });
    expect(est.rewardSource).toBe('risk_reward_ratio');
    expect(est.rewardR).toBeCloseTo(2, 10);
    expect(est.modeledGrossR).toBeCloseTo(3 * 0.55 - 1, 10); // 0.65R
  });

  it('falls back to the config default reward when neither target/stop nor ratio given', () => {
    const est = estimateModeledGrossR({ mark: 2.5, delta: 0.55 });
    expect(est.rewardSource).toBe('default');
    expect(est.rewardR).toBeCloseTo(DEFAULT_MODELED_GROSS_R_CONFIG.defaultRewardR, 10);
  });

  it('⚠ ADMITS a near-ATM 0.50-delta directional read by 0.015R at the TRA-1661 bar', () => {
    // 0/0 target/stop (the deterministic directional path) → default 2:1.
    const est = estimateModeledGrossR({ mark: 2.5, delta: 0.5, targetPrice: 0, stopPrice: 0, riskRewardRatio: 2 });
    expect(est.rewardSource).toBe('risk_reward_ratio'); // 0/0 is not a valid target/stop
    expect(est.modeledGrossR).toBeCloseTo(0.5, 10); // 3·0.5 − 1
    // This assertion INVERTED at TRA-1661 and the flip is load-bearing, so it is
    // pinned rather than quietly updated. The near-ATM ~0.50-delta directional open
    // is the path `signal-engine.ts` calls "the dominant scratch churner", and
    // rejecting it was a stated purpose of the TRA-1602 gate. Against the MEASURED
    // cost bar (0.485R) it now CLEARS by 0.015R — because the 1.25R bar that used to
    // reject it was built on a spread input TRA-1656 refuted, not because the trade
    // got better. Whether 0.50-delta directional SHOULD fire is a live question for
    // the TRA-1647 re-grade: it turns entirely on the estimator's delta-slope, which
    // the realized book contradicts, and which the `byDelta` rollup exists to settle.
    // Do not "fix" this by re-pinning the floor — that would make the measured cost
    // input inert again (see DEFAULT_COST_GATE_CONFIG).
    expect(admitByCostAwareGate(est.modeledGrossR, 'directional').admit).toBe(true);
    expect(admitByCostAwareGate(est.modeledGrossR, 'directional').barR).toBeCloseTo(0.485, 3);
  });
});

describe('estimateModeledGrossR — guards', () => {
  it('returns NaN (→ gate reject) on non-finite / non-positive mark or delta', () => {
    for (const bad of [
      { mark: Number.NaN, delta: 0.5 },
      { mark: 0, delta: 0.5 },
      { mark: -1, delta: 0.5 },
      { mark: 2, delta: Number.NaN },
      { mark: 2, delta: Number.POSITIVE_INFINITY },
    ]) {
      const est = estimateModeledGrossR(bad);
      expect(Number.isNaN(est.modeledGrossR)).toBe(true);
      expect(admitByCostAwareGate(est.modeledGrossR, 'single_leg_rv').admit).toBe(false);
    }
  });

  it('uses |delta| — puts (negative delta) model identically to calls', () => {
    const call = estimateModeledGrossR({ mark: 2, delta: 0.62, targetPrice: 3, stopPrice: 1.5 });
    const put = estimateModeledGrossR({ mark: 2, delta: -0.62, targetPrice: 3, stopPrice: 1.5 });
    expect(put.modeledGrossR).toBeCloseTo(call.modeledGrossR, 10);
  });

  it('caps the win probability so a deep-ITM ~1.0 delta is not near-certain', () => {
    const est = estimateModeledGrossR({ mark: 5, delta: 0.99, targetPrice: 7.5, stopPrice: 3.75 });
    expect(est.winProb).toBeCloseTo(DEFAULT_MODELED_GROSS_R_CONFIG.winProbCap, 10); // 0.95, not 0.99
  });

  it('ignores an inverted/degenerate target<stop and falls back to the ratio', () => {
    const est = estimateModeledGrossR({ mark: 2, delta: 0.6, targetPrice: 1.5, stopPrice: 2.5, riskRewardRatio: 2 });
    expect(est.rewardSource).toBe('risk_reward_ratio');
  });
});

describe('resolveModeledGrossRConfig — env knobs', () => {
  it('defaults to the proposed reference config when unset', () => {
    expect(resolveModeledGrossRConfig({})).toEqual(DEFAULT_MODELED_GROSS_R_CONFIG);
  });

  it('applies a QuantTrader win-prob haircut multiplier', () => {
    const cfg = resolveModeledGrossRConfig({ OPTION_COST_GATE_WIN_PROB_DELTA_MULT: '0.8' });
    expect(cfg.winProbDeltaMultiplier).toBeCloseTo(0.8, 10);
    // At 0.8× a 0.60 delta now models winProb 0.48 → 0.48·2 − 0.52 = 0.44R (rejected).
    const est = estimateModeledGrossR({ mark: 2, delta: 0.6, targetPrice: 3, stopPrice: 1.5 }, cfg);
    expect(est.modeledGrossR).toBeCloseTo(0.44, 10);
    expect(admitByCostAwareGate(est.modeledGrossR, 'single_leg_rv').admit).toBe(false);
  });

  it('rejects malformed / out-of-bounds knobs and keeps the default', () => {
    const cfg = resolveModeledGrossRConfig({
      OPTION_COST_GATE_WIN_PROB_DELTA_MULT: 'abc',
      OPTION_COST_GATE_DEFAULT_REWARD_R: '-3',
      OPTION_COST_GATE_WIN_PROB_CAP: '2',
    });
    expect(cfg).toEqual(DEFAULT_MODELED_GROSS_R_CONFIG);
  });
});
