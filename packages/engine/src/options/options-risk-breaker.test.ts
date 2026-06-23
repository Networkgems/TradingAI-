import { describe, it, expect } from 'vitest';
import {
  OptionsRiskBreaker,
  DEFAULT_OPTIONS_BREAKER_PARAMS,
} from './options-risk-breaker.js';

// Fixed sleeve-equity baseline used across the drawdown tests.
const EQUITY = 25_000;

describe('OptionsRiskBreaker', () => {
  it('starts un-halted with zeroed tallies', () => {
    const b = new OptionsRiskBreaker();
    expect(b.isHalted()).toBe(false);
    const s = b.snapshot();
    expect(s.cumulativeR).toBe(0);
    expect(s.dailyPnl).toBe(0);
    expect(s.closes).toBe(0);
  });

  it('trips on cumulative −2R from defined-risk losses', () => {
    const b = new OptionsRiskBreaker();
    // Two full −1R losses on $200-risk spreads → −2R exactly.
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(false);
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(true);
    expect(b.getHaltReason()).toMatch(/cumulative/i);
    expect(b.snapshot().cumulativeR).toBeCloseTo(-2, 5);
  });

  it('does NOT trip on a run of small theta scratches a winner offsets (R-multiple, not loss-count)', () => {
    const b = new OptionsRiskBreaker();
    // Three small −0.2R scratches (a 3-loss COUNT breaker would trip here)...
    b.recordClose({ pnl: -40, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -40, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -40, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(false);
    // ...more than paid for by one +1R winner.
    b.recordClose({ pnl: 200, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(false);
    expect(b.snapshot().cumulativeR).toBeCloseTo(0.4, 5);
  });

  it('trips on sleeve daily drawdown even when R has not reached the limit', () => {
    // Tight 5% drawdown on $25k = $1,250. A single big-risk loss inside −2R but
    // beyond the dollar drawdown should still halt.
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: -1_300, riskUsd: 2_000 }, EQUITY); // −0.65R, but −5.2% sleeve
    expect(b.isHalted()).toBe(true);
    expect(b.getHaltReason()).toMatch(/drawdown/i);
  });

  it('does not count gains toward drawdown, only realized losses', () => {
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: 5_000, riskUsd: 200 }, EQUITY); // huge win, |dailyPnl| large but positive
    expect(b.isHalted()).toBe(false);
  });

  it('resets tallies and halt on the injected day roll', () => {
    let day = '2026-06-23';
    const b = new OptionsRiskBreaker(
      DEFAULT_OPTIONS_BREAKER_PARAMS,
      () => new Date(),
      () => day,
    );
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(true);
    day = '2026-06-24';
    expect(b.isHalted()).toBe(false);
    expect(b.snapshot().cumulativeR).toBe(0);
  });

  it('fires the halt listener exactly once on the false→true transition', () => {
    const reasons: string[] = [];
    const b = new OptionsRiskBreaker();
    b.setHaltListener((r) => reasons.push(r));
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY); // trips here
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY); // already halted — no re-fire
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toMatch(/sleeve/i);
  });

  it('operator reset clears the halt and tallies', () => {
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(true);
    b.reset();
    expect(b.isHalted()).toBe(false);
    expect(b.snapshot().dailyPnl).toBe(0);
  });

  it('ignores non-finite pnl/risk without throwing', () => {
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: Number.NaN, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -100, riskUsd: 0 }, EQUITY); // risk 0 → no R contribution
    const s = b.snapshot();
    expect(Number.isFinite(s.cumulativeR)).toBe(true);
    expect(s.dailyPnl).toBe(-100);
  });
});
