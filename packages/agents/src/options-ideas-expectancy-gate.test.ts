// TRA-2005 — the SHADOW positive-expectancy + IVR/credit-width admission gate.
// Pins the E[R] identity boundary (the +0.10R bar), the credit/width floor, the
// IV-rank gate, the parked family, the unpriced/out-of-scope verdicts, the interim
// POP haircut vs a supplied calibrated POP, and the env resolution (flag-off →
// null → no shadow pass).
import { describe, it, expect } from 'vitest';
import {
  evaluateIdeaExpectancy,
  evaluateIdeasExpectancyShadow,
  resolveExpectancyGateConfig,
  DEFAULT_EXPECTANCY_GATE_CONFIG,
  CREDIT_STRUCTURES,
  type IdeaExpectancyInput,
} from './options-ideas-expectancy-gate.js';

/** A priced, elevated-IV credit vertical; override per case. */
function creditIdea(over: Partial<IdeaExpectancyInput> = {}): IdeaExpectancyInput {
  return {
    strategy: 'bull_put_spread',
    pop: 0.9,
    maxLossUsd: 200, // (width − credit) × 100
    creditUsd: 100, // credit × 100 → rewardR = 100/200 = 0.5
    ivRank: 72,
    popCalibrated: 0.8,
    ...over,
  };
}

describe('evaluateIdeaExpectancy — E[R] identity', () => {
  it('reproduces the TRA-2000 QQQ negative-expectancy-at-POP leak (−0.05R)', () => {
    // QQQ bull_put width 4 / credit 0.76 → creditUsd 76, maxLoss (4−0.76)×100 = 324,
    // stated POP 0.766. Score at the RAW stated POP (popCalibrated) to reproduce.
    const r = evaluateIdeaExpectancy(
      creditIdea({ pop: 0.766, creditUsd: 76, maxLossUsd: 324, popCalibrated: 0.766 }),
    );
    expect(r.rewardR).toBeCloseTo(76 / 324, 6); // credit/(width−credit)
    expect(r.expectancyR).toBeCloseTo(0.766 * (76 / 324) - (1 - 0.766), 6);
    expect(r.expectancyR).toBeLessThan(0); // ≈ −0.054R
    expect(r.verdict).toBe('drop');
    expect(r.admit).toBe(false);
    expect(r.reasons[0]).toMatch(/E\[R\]=.*< 0\.10R/);
  });

  it('admits just above the +0.10R bar and drops just below', () => {
    // rewardR = 0.5. E[R] = pop·0.5 − (1−pop) = 1.5·pop − 1. = 0.10 at pop = 0.7333…
    const above = evaluateIdeaExpectancy(creditIdea({ popCalibrated: 0.74 }));
    expect(above.expectancyR).toBeCloseTo(1.5 * 0.74 - 1, 6); // 0.11
    expect(above.verdict).toBe('admit');
    expect(above.admit).toBe(true);
    expect(above.reasons).toEqual([]);

    const below = evaluateIdeaExpectancy(creditIdea({ popCalibrated: 0.72 }));
    expect(below.expectancyR).toBeCloseTo(1.5 * 0.72 - 1, 6); // 0.08
    expect(below.verdict).toBe('drop');
    expect(below.admit).toBe(false);
  });

  it('applies the interim −0.15 haircut when no calibrated POP is supplied', () => {
    // raw pop 0.9 → popUsed 0.75 → E[R] = 1.5·0.75 − 1 = 0.125 ≥ 0.10 → admit.
    const r = evaluateIdeaExpectancy(creditIdea({ pop: 0.9, popCalibrated: undefined }));
    expect(r.popUsed).toBeCloseTo(0.75, 6);
    expect(r.expectancyR).toBeCloseTo(0.125, 6);
    expect(r.verdict).toBe('admit');

    // raw pop 0.88 → popUsed 0.73 → E[R] = 0.095 < 0.10 → drop (the haircut bites).
    const r2 = evaluateIdeaExpectancy(creditIdea({ pop: 0.88, popCalibrated: undefined }));
    expect(r2.popUsed).toBeCloseTo(0.73, 6);
    expect(r2.expectancyR).toBeCloseTo(1.5 * 0.73 - 1, 6);
    expect(r2.verdict).toBe('drop');
  });
});

describe('evaluateIdeaExpectancy — the other gate legs', () => {
  it('drops a credit structure below the IV-rank floor and on unknown IV', () => {
    expect(evaluateIdeaExpectancy(creditIdea({ ivRank: 40 })).verdict).toBe('drop');
    expect(evaluateIdeaExpectancy(creditIdea({ ivRank: 40 })).reasons[0]).toMatch(/ivRank 40 < 50/);
    expect(evaluateIdeaExpectancy(creditIdea({ ivRank: null })).verdict).toBe('drop');
    expect(evaluateIdeaExpectancy(creditIdea({ ivRank: null })).reasons[0]).toMatch(/ivRank unknown/);
  });

  it('parks iron_condor regardless of a healthy modelled expectancy', () => {
    const r = evaluateIdeaExpectancy(
      creditIdea({ strategy: 'iron_condor', popCalibrated: 0.95 }),
    );
    expect(r.verdict).toBe('parked');
    expect(r.admit).toBe(false);
    expect(r.reasons[0]).toMatch(/parked/);
  });

  it('flags an unpriced credit structure but does NOT confirm-drop it', () => {
    const r = evaluateIdeaExpectancy(creditIdea({ creditUsd: undefined }));
    expect(r.verdict).toBe('unpriced');
    expect(r.admit).toBe(true); // data gap, not a proven negative-EV
    expect(r.reasons[0]).toMatch(/credit not provided/);
    // A non-positive credit is likewise unpriced.
    expect(evaluateIdeaExpectancy(creditIdea({ creditUsd: 0 })).verdict).toBe('unpriced');
  });

  it('treats debit / long-premium families as out of scope', () => {
    for (const strategy of ['long_call', 'long_put', 'bull_call_spread', 'call_calendar']) {
      const r = evaluateIdeaExpectancy(creditIdea({ strategy }));
      expect(r.verdict).toBe('not_credit');
      expect(r.admit).toBe(true);
    }
    expect(CREDIT_STRUCTURES.has('long_call')).toBe(false);
    expect(CREDIT_STRUCTURES.has('bull_put_spread')).toBe(true);
  });

  it('can fail the credit/width floor independently under a positive buffer', () => {
    // popCalibrated 0.80, creditUsd 100 / maxLoss 100 → rewardR 1, E[R]=0.6 (passes bar),
    // credit/width = 100/200 = 0.5, breakeven 1−0.8+0.35 = 0.55 → 0.5 < 0.55 → drop.
    const cfg = { ...DEFAULT_EXPECTANCY_GATE_CONFIG, creditWidthBuffer: 0.35 };
    const r = evaluateIdeaExpectancy(
      creditIdea({ creditUsd: 100, maxLossUsd: 100, popCalibrated: 0.8 }),
      cfg,
    );
    expect(r.expectancyR).toBeCloseTo(0.6, 6); // clears the E[R] bar
    expect(r.creditWidth).toBeCloseTo(0.5, 6);
    expect(r.breakevenCreditWidth).toBeCloseTo(0.55, 6);
    expect(r.verdict).toBe('drop');
    expect(r.reasons.some((x) => /credit\/width/.test(x))).toBe(true);
  });
});

describe('resolveExpectancyGateConfig', () => {
  it('returns null (disabled) when the flag is unset or falsey', () => {
    expect(resolveExpectancyGateConfig({})).toBeNull();
    expect(resolveExpectancyGateConfig({ ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '0' })).toBeNull();
    expect(resolveExpectancyGateConfig({ ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: 'false' })).toBeNull();
  });

  it('returns the reference config when the flag is on', () => {
    const cfg = resolveExpectancyGateConfig({ ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: 'true' });
    expect(cfg).not.toBeNull();
    expect(cfg!.minExpectancyR).toBe(0.1);
    expect(cfg!.minIvRank).toBe(50);
    expect(cfg!.popHaircut).toBe(0.15);
  });

  it('honours env overrides and ignores malformed ones', () => {
    const cfg = resolveExpectancyGateConfig({
      ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1',
      OPTIONS_IDEA_EXPECTANCY_MIN_R: '0.2',
      OPTIONS_IDEA_EXPECTANCY_MIN_IVR: '60',
      OPTIONS_IDEA_EXPECTANCY_POP_HAIRCUT: 'not-a-number',
    });
    expect(cfg!.minExpectancyR).toBe(0.2);
    expect(cfg!.minIvRank).toBe(60);
    expect(cfg!.popHaircut).toBe(0.15); // malformed → reference default
  });
});

describe('evaluateIdeasExpectancyShadow — ledger roll-up', () => {
  it('buckets verdicts without reordering or dropping', () => {
    const cfg = resolveExpectancyGateConfig({ ENABLE_OPTIONS_IDEA_EXPECTANCY_GATE: '1' })!;
    const shadow = evaluateIdeasExpectancyShadow(
      [
        { ticker: 'QQQ', rank: 1, ...creditIdea({ pop: 0.766, creditUsd: 76, maxLossUsd: 324, popCalibrated: 0.766 }) }, // drop
        { ticker: 'AAPL', rank: 2, ...creditIdea({ popCalibrated: 0.74 }) }, // admit
        { ticker: 'SPY', rank: 3, ...creditIdea({ strategy: 'iron_condor' }) }, // parked
        { ticker: 'MSFT', rank: 4, ...creditIdea({ creditUsd: undefined }) }, // unpriced
        { ticker: 'NVDA', rank: 5, ...creditIdea({ strategy: 'long_call' }) }, // not_credit
      ],
      cfg,
    );
    expect(shadow.counts).toEqual({ total: 5, admit: 1, drop: 1, parked: 1, unpriced: 1, notCredit: 1 });
    expect(shadow.entries.map((e) => e.rank)).toEqual([1, 2, 3, 4, 5]); // order preserved
    expect(shadow.config.minExpectancyR).toBe(0.1);
    expect(shadow.config.parked).toContain('iron_condor');
  });
});
