import { describe, it, expect } from 'vitest';
import {
  OptionsRiskBreaker,
  DEFAULT_OPTIONS_BREAKER_PARAMS,
  MIN_OPTIONS_RISK_THROTTLE,
  resolveOptionsThrottleBand,
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

// TRA-3086 (CTO ruling on TRA-2878) — the sub-halt THROTTLE stage.
//
// The sleeve had a halt and no throttle, so an option ticket was trimmed only
// while the EQUITY book happened to sit at exactly two consecutive losses. These
// pin the stage that fixes that, and the two ways it could ship looking fine and
// be useless: a band that cannot fire, and a "throttle" that loosens.
describe('OptionsRiskBreaker.riskThrottle — the sub-halt stage (TRA-3086)', () => {
  it('is 1 on a fresh sleeve with no closes', () => {
    const b = new OptionsRiskBreaker();
    expect(b.riskThrottle()).toBe(1);
    expect(b.snapshot().throttle.reason).toBeNull();
  });

  it('fires on the cumulative-R leg STRICTLY BELOW the halt, and the halt still needs −2R', () => {
    const b = new OptionsRiskBreaker();
    // −0.9R: inside neither stage.
    b.recordClose({ pnl: -180, riskUsd: 200 }, EQUITY);
    expect(b.riskThrottle()).toBe(1);
    expect(b.isHalted()).toBe(false);

    // −1.1R: past the throttle band (−1R), nowhere near the halt (−2R). THIS is
    // the region that did not exist before — the whole point of the stage.
    b.recordClose({ pnl: -40, riskUsd: 200 }, EQUITY);
    expect(b.riskThrottle()).toBe(0.5);
    expect(b.isHalted()).toBe(false);
    expect(b.snapshot().throttle.reason).toMatch(/cumulative/i);
  });

  it('fires on the drawdown leg strictly below the halt, off the retained baseline', () => {
    const b = new OptionsRiskBreaker();
    // −3% of a 25k sleeve: past the 2.5% throttle band, short of the 5% halt.
    // riskUsd 0 ⇒ no R contribution, so ONLY the drawdown leg can be firing.
    b.recordClose({ pnl: -750, riskUsd: 0 }, EQUITY);
    expect(b.snapshot().cumulativeR).toBe(0);
    expect(b.isHalted()).toBe(false);
    expect(b.riskThrottle()).toBe(0.5);
    expect(b.snapshot().throttle.reason).toMatch(/drawdown/i);
    // The denominator came from `recordClose`, not from a new input.
    expect(b.snapshot().throttle.sleeveEquity).toBe(EQUITY);
  });

  it('a WINNING sleeve is never throttled — tighten-only, not "any movement"', () => {
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: 2_000, riskUsd: 200 }, EQUITY); // +10R, +8% of the sleeve
    expect(b.riskThrottle()).toBe(1);
    expect(b.snapshot().throttle.reason).toBeNull();
  });

  it('stays trimmed past the halt — monotone in loss, never looser at the worst state', () => {
    // A `halted ⇒ 1` branch would make the throttle read LOOSER at −2R than at
    // −1R. The halt is enforced elsewhere; this must not un-trim underneath it.
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    b.recordClose({ pnl: -200, riskUsd: 200 }, EQUITY);
    expect(b.isHalted()).toBe(true);
    expect(b.riskThrottle()).toBe(0.5);
  });

  it('a win that climbs back out of the band restores full size', () => {
    const b = new OptionsRiskBreaker();
    b.recordClose({ pnl: -220, riskUsd: 200 }, EQUITY); // −1.1R
    expect(b.riskThrottle()).toBe(0.5);
    b.recordClose({ pnl: 200, riskUsd: 200 }, EQUITY); // back to −0.1R
    expect(b.riskThrottle()).toBe(1);
  });

  it('resets on the ET day roll and on an operator reset', () => {
    let now = new Date('2026-08-05T18:00:00Z');
    const b = new OptionsRiskBreaker(DEFAULT_OPTIONS_BREAKER_PARAMS, () => now);
    b.recordClose({ pnl: -220, riskUsd: 200 }, EQUITY);
    expect(b.riskThrottle()).toBe(0.5);

    now = new Date('2026-08-06T18:00:00Z');
    expect(b.riskThrottle()).toBe(1);
    expect(b.snapshot().throttle.sleeveEquity).toBeNull();

    now = new Date('2026-08-06T19:00:00Z');
    b.recordClose({ pnl: -220, riskUsd: 200 }, EQUITY);
    expect(b.riskThrottle()).toBe(0.5);
    b.reset();
    expect(b.riskThrottle()).toBe(1);
    expect(b.snapshot().throttle.sleeveEquity).toBeNull();
  });

  it('property: over a sweep of sleeve states the multiplier is always in (0, 1]', () => {
    for (const pnl of [-5_000, -1_000, -220, -1, 0, 1, 220, 5_000]) {
      for (const risk of [0, 1, 200, 10_000]) {
        const b = new OptionsRiskBreaker();
        b.recordClose({ pnl, riskUsd: risk }, EQUITY);
        const m = b.riskThrottle();
        expect(m).toBeGreaterThan(0);
        expect(m).toBeLessThanOrEqual(1);
      }
    }
  });
});

// The band resolution itself. A band at or above the halt has no region between
// the two stages, so its leg can never fire — and a refusal branch that cannot
// fire reads EXACTLY like one that simply never fired. These make the degenerate
// case a surfaced state instead of a silent one.
describe('resolveOptionsThrottleBand — the band cannot be silently unreachable (TRA-3086)', () => {
  it('the shipped defaults are a well-formed band, strictly below both halt legs', () => {
    const band = resolveOptionsThrottleBand(DEFAULT_OPTIONS_BREAKER_PARAMS);
    expect(band.degenerate).toBe(false);
    expect(band.cumulativeLossR).toBeLessThan(DEFAULT_OPTIONS_BREAKER_PARAMS.maxCumulativeLossR);
    expect(band.drawdownPct).toBeLessThan(DEFAULT_OPTIONS_BREAKER_PARAMS.dailyDrawdownPct);
    expect(band.multiplier).toBeGreaterThan(0);
    expect(band.multiplier).toBeLessThan(1);
  });

  it('DROPS a leg at or above its halt counterpart and says so', () => {
    for (const bad of [2, 3]) {
      const band = resolveOptionsThrottleBand({
        ...DEFAULT_OPTIONS_BREAKER_PARAMS,
        throttleCumulativeLossR: bad, // halt is 2 ⇒ never strictly below
      });
      expect(band.cumulativeLossR).toBeNull();
      expect(band.degenerate).toBe(true);
    }
    const dd = resolveOptionsThrottleBand({
      ...DEFAULT_OPTIONS_BREAKER_PARAMS,
      throttleDrawdownPct: 0.05, // equals the halt
    });
    expect(dd.drawdownPct).toBeNull();
    expect(dd.degenerate).toBe(true);
  });

  it('a dropped leg does not trim — and the breaker reports the band, not just a 1', () => {
    // Positive control for the assertion above: with the R leg dropped, a −1.5R
    // sleeve reads 1.0. Indistinguishable from a calm sleeve on the multiplier
    // ALONE, which is why `degenerate` has to be on the snapshot.
    const b = new OptionsRiskBreaker({ ...DEFAULT_OPTIONS_BREAKER_PARAMS, throttleCumulativeLossR: 2 });
    b.recordClose({ pnl: -300, riskUsd: 200 }, EQUITY); // −1.5R
    expect(b.riskThrottle()).toBe(1);
    expect(b.snapshot().throttle.band.degenerate).toBe(true);

    const healthy = new OptionsRiskBreaker();
    expect(healthy.riskThrottle()).toBe(1);
    expect(healthy.snapshot().throttle.band.degenerate).toBe(false);
  });

  it('clamps the band multiplier tighten-only: > 1 ⇒ 1, ≤ 0 / non-finite ⇒ floored', () => {
    const m = (v: number) =>
      resolveOptionsThrottleBand({ ...DEFAULT_OPTIONS_BREAKER_PARAMS, throttleMultiplier: v }).multiplier;
    expect(m(1.5)).toBe(1); // a throttle may never RAISE size
    expect(m(Number.NaN)).toBe(1); // no information ⇒ no trim
    expect(m(0)).toBe(MIN_OPTIONS_RISK_THROTTLE); // de-risk means size small…
    expect(m(-2)).toBe(MIN_OPTIONS_RISK_THROTTLE); // …never a silent second halt
    expect(m(0.5)).toBe(0.5);
  });

  it('a >1 band multiplier cannot loosen sizing through the breaker either', () => {
    const b = new OptionsRiskBreaker({ ...DEFAULT_OPTIONS_BREAKER_PARAMS, throttleMultiplier: 4 });
    b.recordClose({ pnl: -300, riskUsd: 200 }, EQUITY); // deep in the band
    expect(b.riskThrottle()).toBe(1);
  });
});
