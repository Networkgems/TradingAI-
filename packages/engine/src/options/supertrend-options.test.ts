import { describe, it, expect } from 'vitest';
import type { AccountState } from '@trading-app/shared';
import { RiskManager } from '../risk.js';
import {
  selectStructureByIv,
  selectExpiry,
  isThirdFriday,
  selectStrikeByDelta,
  deltasForStrikes,
  optionTypeForSide,
  evaluateExit,
  sizeOptionContracts,
  DEFAULT_EXIT_PARAMS,
  type ExpiryCandidate,
  type ExitState,
} from './supertrend-options.js';

describe('selectStructureByIv (IV gate)', () => {
  it('defaults to single_leg when IV-rank is unknown', () => {
    expect(selectStructureByIv(null).structure).toBe('single_leg');
  });
  it('buys a single leg in low IV (< 40)', () => {
    expect(selectStructureByIv(25).structure).toBe('single_leg');
    expect(selectStructureByIv(39.9).structure).toBe('single_leg');
  });
  it('switches to a debit vertical in high IV (>= 60)', () => {
    expect(selectStructureByIv(60).structure).toBe('debit_vertical');
    expect(selectStructureByIv(85).structure).toBe('debit_vertical');
  });
  it('defaults the 40-60 dead-zone to single_leg (tunable in Phase 2)', () => {
    expect(selectStructureByIv(50).structure).toBe('single_leg');
  });
  it('honours custom thresholds', () => {
    expect(selectStructureByIv(45, { singleLegMaxIvRank: 30, verticalMinIvRank: 45 }).structure).toBe(
      'debit_vertical',
    );
  });
});

describe('isThirdFriday', () => {
  it('recognises the standard monthly (3rd Friday)', () => {
    expect(isThirdFriday('2026-01-16')).toBe(true); // 3rd Friday of Jan 2026
  });
  it('rejects other Fridays and non-Fridays', () => {
    expect(isThirdFriday('2026-01-09')).toBe(false); // 2nd Friday
    expect(isThirdFriday('2026-01-23')).toBe(false); // 4th Friday
    expect(isThirdFriday('2026-01-15')).toBe(false); // Thursday
    expect(isThirdFriday('garbage')).toBe(false);
  });
});

describe('selectExpiry (2-4 weeks, no weeklies)', () => {
  const candidates: ExpiryCandidate[] = [
    { expiration: '2026-06-12', daysToExpiry: 4, isMonthly: false }, // too soon
    { expiration: '2026-06-19', daysToExpiry: 11, isMonthly: true }, // too soon
    { expiration: '2026-06-26', daysToExpiry: 21, isMonthly: false }, // weekly on-target — excluded by default
    { expiration: '2026-07-17', daysToExpiry: 23, isMonthly: true }, // in band, monthly
    { expiration: '2026-08-21', daysToExpiry: 52, isMonthly: true }, // too far
  ];
  it('picks the in-band monthly nearest the 3-week target', () => {
    expect(selectExpiry(candidates)!.expiration).toBe('2026-07-17');
  });
  it('drops weeklies when excludeWeeklies is set', () => {
    // 06-26 (21d) sits exactly on target but is a weekly ⇒ skipped for the monthly.
    expect(selectExpiry(candidates)!.isMonthly).toBe(true);
  });
  it('can include weeklies when configured', () => {
    const pick = selectExpiry(candidates, {
      minDays: 14,
      maxDays: 28,
      targetDays: 21,
      excludeWeeklies: false,
    });
    expect(pick!.expiration).toBe('2026-06-26'); // 21d, exactly on target
  });
  it('returns null when nothing qualifies', () => {
    expect(selectExpiry([{ expiration: '2026-06-12', daysToExpiry: 3, isMonthly: false }])).toBeNull();
  });
});

describe('selectStrikeByDelta (~0.60-0.70)', () => {
  it('picks the strike nearest the 0.65 target inside the band', () => {
    const pick = selectStrikeByDelta([
      { strike: 100, delta: 0.5 },
      { strike: 95, delta: 0.62 },
      { strike: 90, delta: 0.68 },
      { strike: 85, delta: 0.8 },
    ]);
    expect(pick!.strike).toBe(95); // |0.62-0.65|=0.03 < |0.68-0.65|=0.03? tie → first; both in band, 0.62 wins by order
  });
  it('works for puts (negative deltas, selected by magnitude)', () => {
    const pick = selectStrikeByDelta([
      { strike: 100, delta: -0.55 },
      { strike: 105, delta: -0.66 },
    ]);
    expect(pick!.strike).toBe(105);
  });
  it('returns null on empty input', () => {
    expect(selectStrikeByDelta([])).toBeNull();
  });
  it('builds candidate deltas via Black-Scholes and maps side→type', () => {
    expect(optionTypeForSide('buy')).toBe('call');
    expect(optionTypeForSide('sell')).toBe('put');
    const cands = deltasForStrikes([90, 100, 110], {
      spot: 100,
      timeToExpiryYears: 21 / 365,
      riskFreeRate: 0.045,
      volatility: 0.3,
      optionType: 'call',
    });
    // ITM (90) has the highest call delta; OTM (110) the lowest.
    expect(cands[0].delta).toBeGreaterThan(cands[2].delta);
    expect(cands[0].delta).toBeGreaterThan(0.5);
  });
});

describe('evaluateExit (parameterized exit rules)', () => {
  const base: ExitState = {
    side: 'buy',
    supertrendDirection: 'green',
    underlyingClose: 105,
    ma20: 100,
    entryPremium: 2,
    currentPremium: 2,
    barsHeld: 1,
    hadFollowThrough: true,
  };
  it('holds when nothing triggers', () => {
    expect(evaluateExit(base)).toBeNull();
  });
  it('hits the -50% premium stop', () => {
    expect(evaluateExit({ ...base, currentPremium: 1.0 })).toBe('premium_stop');
  });
  it('hits the +100% take-profit', () => {
    expect(evaluateExit({ ...base, currentPremium: 4.0 })).toBe('premium_take_profit');
  });
  it('exits on a Supertrend flip against the position', () => {
    expect(evaluateExit({ ...base, supertrendDirection: 'red' })).toBe('supertrend_flip');
  });
  it('exits when the underlying closes through MA20', () => {
    expect(evaluateExit({ ...base, underlyingClose: 99 })).toBe('ma20_close_through');
  });
  it('time-stops a stalled trade with no follow-through', () => {
    expect(evaluateExit({ ...base, barsHeld: 5, hadFollowThrough: false })).toBe('time_stop');
  });
  it('does not time-stop when the move followed through', () => {
    expect(evaluateExit({ ...base, barsHeld: 9, hadFollowThrough: true })).toBeNull();
  });
});

describe('evaluateExit — TRA-1409 confirmed N-bar Supertrend flip', () => {
  // Long call; underlying above MA20 and no premium move, so ONLY the flip logic
  // can trigger an exit (isolates the confirm-bars behaviour).
  const base: ExitState = {
    side: 'buy',
    supertrendDirection: 'red', // flipped against a long this bar
    underlyingClose: 105,
    ma20: 100,
    entryPremium: 2,
    currentPremium: 2,
    barsHeld: 1,
    hadFollowThrough: true,
  };
  const confirm2 = { ...DEFAULT_EXIT_PARAMS, supertrendFlipConfirmBars: 2 };

  it('N=2 holds a single-bar flip (whipsaw not confirmed)', () => {
    // Only the current bar is flipped → not yet 2 consecutive → hold.
    expect(
      evaluateExit({ ...base, recentSupertrendDirections: ['green', 'red'] }, confirm2),
    ).toBeNull();
  });
  it('N=2 exits when the flip persists for 2 consecutive bars', () => {
    expect(
      evaluateExit({ ...base, recentSupertrendDirections: ['red', 'red'] }, confirm2),
    ).toBe('supertrend_flip');
  });
  it('N=2 exits only on the LAST 2 bars being flipped (earlier greens ignored)', () => {
    expect(
      evaluateExit({ ...base, recentSupertrendDirections: ['green', 'red', 'red'] }, confirm2),
    ).toBe('supertrend_flip');
  });
  it('N=2 holds conservatively when no recent-direction history is supplied', () => {
    expect(evaluateExit({ ...base }, confirm2)).toBeNull();
  });
  it('N=1 (default) keeps the legacy single-bar flip exit', () => {
    expect(evaluateExit({ ...base, recentSupertrendDirections: ['green', 'red'] })).toBe(
      'supertrend_flip',
    );
  });
  it('never suppresses a risk-side premium stop while a flip is unconfirmed', () => {
    // Premium at -50% AND only a single-bar flip: the hard stop still wins.
    expect(
      evaluateExit(
        { ...base, currentPremium: 1.0, recentSupertrendDirections: ['green', 'red'] },
        confirm2,
      ),
    ).toBe('premium_stop');
  });
  it('falls through to ma20_close_through when the flip is held unconfirmed', () => {
    // Single-bar flip held by N=2, but the underlying has closed through MA20 —
    // the structural MA20 exit still fires (winners are not stranded).
    expect(
      evaluateExit(
        { ...base, underlyingClose: 99, recentSupertrendDirections: ['green', 'red'] },
        confirm2,
      ),
    ).toBe('ma20_close_through');
  });
});

describe('evaluateExit — TRA-1480 v2 winner-protect flip P&L gate', () => {
  // Long call, flipped against the position this bar, underlying still above MA20
  // so only the flip logic (and its P&L gate) can fire. entryPremium 2.
  const base: ExitState = {
    side: 'buy',
    supertrendDirection: 'red', // flipped against a long
    recentSupertrendDirections: ['red', 'red'], // 2-bar confirmed
    underlyingClose: 105,
    ma20: 100,
    entryPremium: 2,
    currentPremium: 2, // flat P&L
    barsHeld: 1,
    hadFollowThrough: true,
  };
  // v1 armed shape (confirm N=2) + v2 gate: only flip-exit once down ≥20%.
  const gated = {
    ...DEFAULT_EXIT_PARAMS,
    supertrendFlipConfirmBars: 2,
    supertrendFlipMinLossPctToExit: -0.2,
  };

  it('holds a confirmed flip on a FLAT position (winner runs to ma20)', () => {
    // Flat P&L (0) is above the -20% threshold → flip suppressed, nothing else
    // triggers (still above MA20) → hold.
    expect(evaluateExit({ ...base }, gated)).toBeNull();
  });
  it('holds a confirmed flip on a WINNING position', () => {
    expect(evaluateExit({ ...base, currentPremium: 2.6 /* +30% */ }, gated)).toBeNull();
  });
  it('still fires the confirmed flip once the loss reaches the threshold', () => {
    // -25% premium (currentPremium 1.5) is below the -20% gate → protective flip.
    expect(evaluateExit({ ...base, currentPremium: 1.5 }, gated)).toBe('supertrend_flip');
  });
  it('lets a flat, flip-suppressed position exit on ma20_close_through', () => {
    // Gate suppresses the flip; underlying has closed through MA20 → winner exit.
    expect(
      evaluateExit({ ...base, currentPremium: 2, underlyingClose: 99 }, gated),
    ).toBe('ma20_close_through');
  });
  it('gate never blocks the hard premium stop', () => {
    // -50% premium hits the hard stop first regardless of the flip gate.
    expect(evaluateExit({ ...base, currentPremium: 1.0 }, gated)).toBe('premium_stop');
  });
  it('undefined threshold = legacy: confirmed flip fires at any P&L', () => {
    const v1 = { ...DEFAULT_EXIT_PARAMS, supertrendFlipConfirmBars: 2 };
    expect(evaluateExit({ ...base, currentPremium: 2 }, v1)).toBe('supertrend_flip');
  });
  it('threshold 0 suppresses the flip on any non-losing position', () => {
    const gate0 = { ...DEFAULT_EXIT_PARAMS, supertrendFlipMinLossPctToExit: 0 };
    // Flat (0 <= 0) still allows the flip; a tiny gain suppresses it.
    expect(evaluateExit({ ...base, currentPremium: 2 }, gate0)).toBe('supertrend_flip');
    expect(evaluateExit({ ...base, currentPremium: 2.02 }, gate0)).toBeNull();
  });
  it('gate composes with confirm-bars: unconfirmed single-bar flip still holds', () => {
    // Only the current bar flipped (green,red) under N=2 → unconfirmed → hold,
    // independent of the P&L gate.
    expect(
      evaluateExit(
        { ...base, recentSupertrendDirections: ['green', 'red'], currentPremium: 1.5 },
        gated,
      ),
    ).toBeNull();
  });
});

describe('sizeOptionContracts (risk manager + caps)', () => {
  function makeAccount(equity: number): AccountState {
    return { totalEquity: equity, availableCash: equity, openPositions: [], dailyPnl: 0 };
  }
  it('sizes off the risk-manager budget when caps are not binding', () => {
    // managed = 50k, 1% per-trade = $500. perContractRisk = 2 * 0.5 * 100 = $100 ⇒ 5 contracts.
    const rm = new RiskManager(makeAccount(100_000));
    const r = sizeOptionContracts(rm, {
      entryPremium: 2,
      premiumStopPct: -0.5,
      nameRiskUsed: 0,
      sectorRiskUsed: 0,
    });
    expect(r.contracts).toBe(5);
    expect(r.riskDollars).toBe(500);
    expect(r.bound).toBe('risk_budget');
  });
  it('clamps to the per-name cap headroom', () => {
    // per-name cap 5% of 50k = $2500; $2400 already used ⇒ $100 headroom ⇒ 1 contract.
    const rm = new RiskManager(makeAccount(100_000));
    const r = sizeOptionContracts(rm, {
      entryPremium: 2,
      premiumStopPct: -0.5,
      nameRiskUsed: 2400,
      sectorRiskUsed: 0,
    });
    expect(r.contracts).toBe(1);
    expect(r.bound).toBe('per_name_cap');
  });
  it('returns zero when per-contract risk is degenerate', () => {
    const rm = new RiskManager(makeAccount(100_000));
    expect(
      sizeOptionContracts(rm, { entryPremium: 0, premiumStopPct: -0.5, nameRiskUsed: 0, sectorRiskUsed: 0 }).contracts,
    ).toBe(0);
  });
});
