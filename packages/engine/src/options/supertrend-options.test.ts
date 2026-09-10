import { describe, it, expect } from 'vitest';
import type { AccountState } from '@trading-app/shared';
import { RiskManager } from '../risk.js';
import {
  selectStructureByIv,
  preferCreditForEvent,
  DEFAULT_IV_GATE,
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
  type ExitParams,
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
    expect(
      selectStructureByIv(45, { singleLegMaxIvRank: 30, verticalMinIvRank: 45, eventIvMinRank: 50 }).structure,
    ).toBe('debit_vertical');
  });
});

describe('selectStructureByIv — TRA-1974 event-IV "sell-the-crush"', () => {
  // Earnings-inside-DTE × IV-rank matrix. Trigger = catalyst inside expiry AND
  // ivRank >= eventIvMinRank (50) → net-credit structure; else the legacy bands.
  const dte = 30;
  const earningsInside = { nextEarningsInDays: 5, daysToFOMC: null, daysToExpiration: dte };
  const earningsOutside = { nextEarningsInDays: 45, daysToFOMC: null, daysToExpiration: dte };
  const noEvent = { nextEarningsInDays: null, daysToFOMC: null, daysToExpiration: dte };

  it('routes to credit_spread when earnings sits inside the expiry and IV is elevated', () => {
    const d = selectStructureByIv(55, DEFAULT_IV_GATE, earningsInside);
    expect(d.structure).toBe('credit_spread');
    expect(d.reason).toContain('sell_the_crush');
    expect(d.reason).toContain('earnings in 5d');
  });

  it('fires exactly at the eventIvMinRank boundary (ivRank === 50)', () => {
    expect(selectStructureByIv(50, DEFAULT_IV_GATE, earningsInside).structure).toBe('credit_spread');
    expect(selectStructureByIv(49.9, DEFAULT_IV_GATE, earningsInside).structure).not.toBe('credit_spread');
  });

  it('fires at the DTE boundary (earnings on the expiry day) but not beyond it', () => {
    const onExpiry = { nextEarningsInDays: dte, daysToFOMC: null, daysToExpiration: dte };
    const dayAfter = { nextEarningsInDays: dte + 1, daysToFOMC: null, daysToExpiration: dte };
    expect(selectStructureByIv(70, DEFAULT_IV_GATE, onExpiry).structure).toBe('credit_spread');
    // Catalyst after expiry → no crush risk on this contract → legacy high-IV band.
    expect(selectStructureByIv(70, DEFAULT_IV_GATE, dayAfter).structure).toBe('debit_vertical');
  });

  it('does NOT fire when earnings is outside the expiry, regardless of IV', () => {
    expect(selectStructureByIv(90, DEFAULT_IV_GATE, earningsOutside).structure).toBe('debit_vertical');
    expect(selectStructureByIv(30, DEFAULT_IV_GATE, earningsOutside).structure).toBe('single_leg');
  });

  it('does NOT fire on elevated IV alone with no catalyst (falls through to bands)', () => {
    expect(selectStructureByIv(55, DEFAULT_IV_GATE, noEvent).structure).toBe('single_leg'); // 50-60 dead-zone
    expect(selectStructureByIv(65, DEFAULT_IV_GATE, noEvent).structure).toBe('debit_vertical');
  });

  it('does NOT fire when IV-rank is unknown even with earnings inside', () => {
    expect(selectStructureByIv(null, DEFAULT_IV_GATE, earningsInside).structure).toBe('single_leg');
  });

  it('treats FOMC-inside as a (secondary) trigger when earnings is absent', () => {
    const fomcInside = { nextEarningsInDays: null, daysToFOMC: 3, daysToExpiration: dte };
    const d = selectStructureByIv(60, DEFAULT_IV_GATE, fomcInside);
    expect(d.structure).toBe('credit_spread');
    expect(d.reason).toContain('FOMC in 3d');
  });

  it('earnings takes priority over FOMC in the reason when both sit inside', () => {
    const both = { nextEarningsInDays: 4, daysToFOMC: 2, daysToExpiration: dte };
    expect(selectStructureByIv(60, DEFAULT_IV_GATE, both).reason).toContain('earnings in 4d');
  });

  it('omitting the event arg preserves the legacy IV-rank-only behaviour', () => {
    expect(selectStructureByIv(90).structure).toBe('debit_vertical');
    expect(selectStructureByIv(30).structure).toBe('single_leg');
  });

  it('preferCreditForEvent is the pure predicate backing the rule', () => {
    expect(preferCreditForEvent(55, earningsInside)).toBe(true);
    expect(preferCreditForEvent(49, earningsInside)).toBe(false);
    expect(preferCreditForEvent(55, earningsOutside)).toBe(false);
    expect(preferCreditForEvent(null, earningsInside)).toBe(false);
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

describe('evaluateExit — TRA-4500 DTE-proportional minimum hold on the churn exits', () => {
  // Long call, trend still green, premium flat: only the ma20 / time-stop
  // branches can trigger, which isolates the churn-hold behaviour.
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
  // 34 DTE (the measured desk cohort) ⇒ minHold = max(1, 0.10 × 34) = 3.4
  // trading sessions.
  const dte34 = { entryDte: 34 };

  it('holds a confirmed ma20 close-through inside the minimum hold (34 DTE, 0 sessions held)', () => {
    expect(evaluateExit({ ...base, ...dte34, underlyingClose: 99, tradingDaysHeld: 0 })).toBeNull();
  });
  it('holds the ma20 close-through at 3 sessions held (3 < 3.4)', () => {
    expect(evaluateExit({ ...base, ...dte34, underlyingClose: 99, tradingDaysHeld: 3 })).toBeNull();
  });
  it('releases the ma20 close-through once the hold has elapsed (4 ≥ 3.4)', () => {
    expect(evaluateExit({ ...base, ...dte34, underlyingClose: 99, tradingDaysHeld: 4 })).toBe(
      'ma20_close_through',
    );
  });
  it('holds the bar-count time stop inside the minimum hold', () => {
    expect(
      evaluateExit({ ...base, ...dte34, barsHeld: 9, hadFollowThrough: false, tradingDaysHeld: 0 }),
    ).toBeNull();
  });
  it('releases the bar-count time stop once the hold has elapsed', () => {
    expect(
      evaluateExit({ ...base, ...dte34, barsHeld: 9, hadFollowThrough: false, tradingDaysHeld: 4 }),
    ).toBe('time_stop');
  });
  it('holds the swing-held trading-day time stop until the DTE hold elapses (60 DTE ⇒ 6 sessions)', () => {
    // 60 DTE ⇒ minHold 6 > timeStopTradingDays 4, so at 4 sessions the swing
    // arm's own threshold is met but the churn hold still refuses it. The
    // confirmed flip's winner-protect gate (-20%) is kept shut by the -5%
    // premium so only the time stop can fire (the TRA-2949 test pattern).
    const params = {
      ...DEFAULT_EXIT_PARAMS,
      supertrendFlipConfirmBars: 2,
      supertrendFlipMinLossPctToExit: -0.2,
    };
    const swing: ExitState = {
      ...base,
      entryDte: 60,
      swingHeld: true,
      supertrendDirection: 'red',
      recentSupertrendDirections: ['red', 'red'],
      currentPremium: 1.9,
      hadFollowThrough: false,
    };
    expect(evaluateExit({ ...swing, tradingDaysHeld: 4 }, params)).toBeNull();
    expect(evaluateExit({ ...swing, tradingDaysHeld: 6 }, params)).toBe('time_stop');
  });
  it('is inert below the 21-DTE floor (legacy behaviour)', () => {
    expect(
      evaluateExit({ ...base, entryDte: 20, barsHeld: 5, hadFollowThrough: false, tradingDaysHeld: 0 }),
    ).toBe('time_stop');
    expect(evaluateExit({ ...base, entryDte: 20, underlyingClose: 99, tradingDaysHeld: 0 })).toBe(
      'ma20_close_through',
    );
  });
  it('is inert when entryDte is absent (legacy callers)', () => {
    expect(evaluateExit({ ...base, underlyingClose: 99, tradingDaysHeld: 0 })).toBe(
      'ma20_close_through',
    );
  });
  it('holds conservatively when entryDte ≥ floor but tradingDaysHeld is unsupplied', () => {
    expect(evaluateExit({ ...base, ...dte34, underlyingClose: 99 })).toBeNull();
  });
  it('enforces the 1-full-session floor when the factor alone would allow less', () => {
    // Custom floor 5 so an 8-DTE row engages the gate: 0.10 × 8 = 0.8 < 1 ⇒
    // minHold clamps to 1 full session.
    const params = { ...DEFAULT_EXIT_PARAMS, dteMinHoldEntryDteFloor: 5 };
    expect(
      evaluateExit({ ...base, entryDte: 8, underlyingClose: 99, tradingDaysHeld: 0 }, params),
    ).toBeNull();
    expect(
      evaluateExit({ ...base, entryDte: 8, underlyingClose: 99, tradingDaysHeld: 1 }, params),
    ).toBe('ma20_close_through');
  });
  it('never touches the risk-side exits: the premium stop fires on tick one of a 34-DTE row', () => {
    expect(evaluateExit({ ...base, ...dte34, currentPremium: 1.0, tradingDaysHeld: 0 })).toBe(
      'premium_stop',
    );
  });
  it('never touches the take-profit or the supertrend flip', () => {
    expect(evaluateExit({ ...base, ...dte34, currentPremium: 4.0, tradingDaysHeld: 0 })).toBe(
      'premium_take_profit',
    );
    expect(
      evaluateExit({ ...base, ...dte34, supertrendDirection: 'red', tradingDaysHeld: 0 }),
    ).toBe('supertrend_flip');
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

describe('evaluateExit — TRA-2949 swing-held trading-day time stop', () => {
  // A long call just released from the PDT/swing overnight hold: `barsHeld` is
  // wall-clock/5min so it is trivially past the 5-bar stop at the next open —
  // exactly the mechanical next-open close the board rejected (TRA-2946).
  // `swingHeld` must switch the stop to trading days.
  const base: ExitState = {
    side: 'buy',
    supertrendDirection: 'green',
    underlyingClose: 105,
    ma20: 100,
    entryPremium: 2,
    currentPremium: 2,
    barsHeld: 80,
    hadFollowThrough: false,
    swingHeld: true,
  };
  // The live re-tune parameter set (RV_EXIT_RETUNE_LIVE_ENABLED): confirmed
  // 2-bar flip, winner-protect at -20%, confirmed 2-bar MA20 through.
  const liveRetune: ExitParams = {
    ...DEFAULT_EXIT_PARAMS,
    supertrendFlipConfirmBars: 2,
    supertrendFlipMinLossPctToExit: -0.2,
    ma20ConfirmBars: 2,
  };

  it('does NOT close at next-open while the trend is with the position', () => {
    expect(evaluateExit({ ...base, tradingDaysHeld: 1 })).toBeNull();
  });
  it('control: the same state WITHOUT swingHeld is the rejected next-open close', () => {
    expect(evaluateExit({ ...base, swingHeld: false, tradingDaysHeld: 1 })).toBe('time_stop');
  });
  it('closes on day timeStopTradingDays when trend-against is confirmed', () => {
    expect(
      evaluateExit(
        {
          ...base,
          supertrendDirection: 'red',
          recentSupertrendDirections: ['red', 'red'],
          currentPremium: 1.9, // -5%: winner-protect keeps the flip exit shut
          tradingDaysHeld: 4,
        },
        liveRetune,
      ),
    ).toBe('time_stop');
  });
  it('holds before day timeStopTradingDays even with trend-against confirmed', () => {
    expect(
      evaluateExit(
        {
          ...base,
          supertrendDirection: 'red',
          recentSupertrendDirections: ['red', 'red'],
          currentPremium: 1.9,
          tradingDaysHeld: 3,
        },
        liveRetune,
      ),
    ).toBeNull();
  });
  it('holds on day timeStopTradingDays when the trend-against read is a single unconfirmed bar', () => {
    expect(
      evaluateExit(
        {
          ...base,
          supertrendDirection: 'red',
          recentSupertrendDirections: ['green', 'red'],
          currentPremium: 1.9,
          tradingDaysHeld: 4,
        },
        liveRetune,
      ),
    ).toBeNull();
  });
  it('never time-stops a swing row that followed through', () => {
    expect(
      evaluateExit(
        {
          ...base,
          hadFollowThrough: true,
          supertrendDirection: 'red',
          recentSupertrendDirections: ['red', 'red'],
          currentPremium: 1.9,
          tradingDaysHeld: 9,
        },
        liveRetune,
      ),
    ).toBeNull();
  });
  it('timeStopTradingDays: 0 disables the time stop for swing-held rows', () => {
    expect(
      evaluateExit(
        {
          ...base,
          supertrendDirection: 'red',
          recentSupertrendDirections: ['red', 'red'],
          currentPremium: 1.9,
          tradingDaysHeld: 9,
        },
        { ...liveRetune, timeStopTradingDays: 0 },
      ),
    ).toBeNull();
  });
  it('a row down less than 20% does not close on a single flip bar', () => {
    expect(
      evaluateExit(
        {
          ...base,
          supertrendDirection: 'red',
          recentSupertrendDirections: ['green', 'red'],
          currentPremium: 1.7, // -15%: above the -20% winner-protect threshold
          tradingDaysHeld: 1,
        },
        liveRetune,
      ),
    ).toBeNull();
  });
  it('the hard premium stop still bypasses everything on a swing-held row', () => {
    expect(
      evaluateExit({ ...base, currentPremium: 1.0, tradingDaysHeld: 0 }, liveRetune),
    ).toBe('premium_stop');
  });
});

describe('evaluateExit — TRA-2949 confirmed N-bar MA20 close-through', () => {
  // Underlying through MA20 against a long; trend still green and premium flat
  // so ONLY the ma20 exit can trigger (isolates the confirm-bars behaviour).
  const base: ExitState = {
    side: 'buy',
    supertrendDirection: 'green',
    underlyingClose: 99,
    ma20: 100,
    entryPremium: 2,
    currentPremium: 2,
    barsHeld: 1,
    hadFollowThrough: true,
  };
  const confirm2: ExitParams = { ...DEFAULT_EXIT_PARAMS, ma20ConfirmBars: 2 };

  it('N=2 holds a single-bar close-through', () => {
    expect(evaluateExit({ ...base, recentMa20Through: [false, true] }, confirm2)).toBeNull();
  });
  it('N=2 exits when the close-through persists for 2 consecutive bars', () => {
    expect(evaluateExit({ ...base, recentMa20Through: [true, true] }, confirm2)).toBe(
      'ma20_close_through',
    );
  });
  it('N=2 holds conservatively when no through-history is supplied', () => {
    expect(evaluateExit(base, confirm2)).toBeNull();
  });
  it('N=1 (default) keeps the legacy single-bar close-through exit', () => {
    expect(evaluateExit({ ...base, recentMa20Through: [false, true] })).toBe(
      'ma20_close_through',
    );
  });
});
