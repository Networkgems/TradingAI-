// TRA-4020 (parent TRA-4010) — the account-level half: R2 (freshness-scoped
// opening-range guard), R3 (the armed floor fires through the three
// suppressions as `profit_floor`) and R4 (MFE + the refusal record on the
// journal close). The pure ladder (R1) is pinned in
// `packages/engine/src/tra4020-profit-floor-ladder.test.ts`.
//
// Every scenario is run against the SAME `checkExits` the production pass
// calls, with the flag expressed the way the engine expresses it — as
// `exitRisk.profitFloorLadder` present (ON) or absent (OFF). The OFF branch
// of each scenario is the pre-change behaviour and is asserted alongside, so
// "flag off is byte-identical" is a measurement here, not a sentence.
//
// Geometry: the OTM fixture opens at 1.00 with a −20% stop ⇒ R = 0.20.
//   peakR 1.0  ⇒ peak 1.20 (below the +30% trail activation, so the premium
//                trail stays dormant and the lock / floor are the rules under test)
//   ladder in force at peakR 1.0: give-back 0.40 ⇒ level +0.60R (1.12),
//                floor +0.25R (1.05)
//   1.10 = +0.5R ⇒ inside (floor, level]: the GIVE-BACK leg (trail-family)
//   1.04 = +0.2R ⇒ under the floor: the FLOOR leg (exempt)
//
// TRADING_TIME is 14:00Z = 10:00 ET on Tue 2024-06-04; day 1's open is
// 2024-06-05T13:30Z (EDT), so `D1_OPEN + n min` lands inside the 15-minute
// window for n < 15.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import { listOptionTradeJournal, setOptionTradeJournalFileForTests } from './option-trade-journal.js';
import { resolveOtmDayOneStopRule, type OtmDayOneStopRelease } from './otm-day-one-stop.js';
import { PROFIT_FLOOR_LADDER } from '@trading-app/shared';
import type { OtmMispricingSignal, RelativeValueSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const D1_OPEN = Date.parse('2024-06-05T13:30:00.000Z');
const MIN = 60_000;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4020',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    mark: 1.0,
    theo: 1.30,
    mispricingPct: -0.23,
    delta: 0.18,
    ...overrides,
  };
}

function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-4020',
    symbol: 'MSFT',
    type: 'relative_value',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.7,
    takeProfit: 1.6,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'MSFT240705C00400000',
    optionType: 'call',
    strike: 400,
    expiration: '2024-07-05',
    mark: 1.0,
    fairPrice: 1.3,
    mispricingPct: -0.23,
    zScore: -2.1,
    ivFitted: 0.25,
    ivUsed: 0.22,
    delta: 0.35,
    reason: 'cheap vs skew',
    ...overrides,
  };
}

const JOURNAL_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

// No ATR ⇒ the chandelier is inert; the window is on; the lock / floor are the rules under test.
const RISK_OFF: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };
const RISK_ON: OptionExitRiskInput = { ...RISK_OFF, profitFloorLadder: PROFIT_FLOOR_LADDER };
// ATR 4 ⇒ chandelier width 12 (the TRA-3217 pin), for the chandelier scenarios.
const RISK_CH_OFF: OptionExitRiskInput = { underlyingAtrBySymbol: new Map([['AAPL', 4]]), openingRangeGuardMin: 15 };
const RISK_CH_ON: OptionExitRiskInput = { ...RISK_CH_OFF, profitFloorLadder: PROFIT_FLOOR_LADDER };

const RELEASED: OtmDayOneStopRelease = {
  released: true,
  reason: 'day_trade_capacity',
  accountType: 'margin',
  dayTradeBuyingPowerUsd: 25_000,
};
const HELD: OtmDayOneStopRelease = {
  released: false,
  reason: 'dtbp_exhausted',
  accountType: 'margin',
  dayTradeBuyingPowerUsd: 0,
};
// The OTM day-one stop itself spelled OFF, so only the RELEASE object is in play.
const OTM_STOP_OFF = resolveOtmDayOneStopRule({ OTM_DAY_ONE_STOP: 'off' });

function liveAccount(openAt: number = TRADING_TIME) {
  vi.setSystemTime(openAt);
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: true,
  });
  const pos = acct.openOptionFromCandidate(buildSignal({ mark: 1.0 }), 'live', 50_000, undefined, JOURNAL_SETUP);
  expect(pos).not.toBeNull();
  expect(pos!.mode).toBe('live');
  expect(pos!.premiumPaid).toBe(1.0);
  expect(pos!.stopLossPremium).toBeCloseTo(0.80, 9); // R = 0.20
  const sym = pos!.optionSymbol!;
  const tick = (mark: number, risk: OptionExitRiskInput, options: Parameters<PaperOptionsAccount['checkExits']>[3] = {}) =>
    acct.checkExits(new Map([['AAPL', 200]]), new Map([[sym, mark]]), 'live', options, undefined, risk);
  const tickSpot = (spot: number, risk: OptionExitRiskInput) =>
    acct.checkExits(new Map([['AAPL', spot]]), new Map([[sym, 1.0]]), 'live', {}, undefined, risk);
  const row = () => acct.getState().openOptions[0];
  return { acct, tick, tickSpot, row };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4020 R2 — the opening-range guard is a STALENESS test, not a clock test', () => {
  it.each([
    ['OFF', RISK_OFF],
    ['ON', RISK_ON],
  ])('flag %s: a give-back off YESTERDAY’s peak is refused inside the window and fires after it; the refusal is counted (R4)', (_label, risk) => {
    const { tick, row } = liveAccount();
    // Day 0: the peak is set at 10:00 ET.
    expect(tick(1.20, risk)).toHaveLength(0);
    expect(row().peakPremium).toBe(1.20);
    expect(row().peakPremiumAt).toBe(TRADING_TIME);
    // A flat tick does not refresh the stamp.
    expect(tick(1.15, risk)).toHaveLength(0);
    expect(row().peakPremiumAt).toBe(TRADING_TIME);

    // Day 1, 09:35 ET: +0.5R is the give-back leg (level +0.6R). The peak is
    // yesterday's ⇒ STALE ⇒ refused under both flag states.
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(tick(1.10, risk)).toHaveLength(0);
    expect(row().openingRangeSuppressed).toEqual({
      fires: 1,
      firstSuppressedAt: D1_OPEN + 5 * MIN,
      lastSuppressedAt: D1_OPEN + 5 * MIN,
      premiumAtSuppression: 1.10,
    });
    vi.setSystemTime(D1_OPEN + 10 * MIN);
    expect(tick(1.10, risk)).toHaveLength(0);
    expect(row().openingRangeSuppressed!.fires).toBe(2);
    expect(row().openingRangeSuppressed!.lastSuppressedAt).toBe(D1_OPEN + 10 * MIN);

    // 09:45 ET: the window has closed ⇒ the lock fires, and the record carries
    // the mark at the fire.
    vi.setSystemTime(D1_OPEN + 15 * MIN);
    const closed = tick(1.10, risk);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_lock');
    expect(closed[0]!.openingRangeSuppressed).toEqual({
      fires: 2,
      firstSuppressedAt: D1_OPEN + 5 * MIN,
      lastSuppressedAt: D1_OPEN + 10 * MIN,
      premiumAtSuppression: 1.10,
      premiumAtFire: 1.10,
    });
  });

  it('flag ON: a peak advanced THIS session (09:33) lets the give-back fire at 09:35; flag OFF the clock still refuses it', () => {
    const on = liveAccount();
    expect(on.tick(1.0, RISK_ON)).toHaveLength(0);
    expect(on.row().peakPremiumAt).toBeUndefined(); // no new high yet
    vi.setSystemTime(D1_OPEN + 3 * MIN);
    expect(on.tick(1.20, RISK_ON)).toHaveLength(0); // the run-up, this session
    expect(on.row().peakPremiumAt).toBe(D1_OPEN + 3 * MIN);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    const closed = on.tick(1.10, RISK_ON);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_lock');
    expect(closed[0]!.openingRangeSuppressed).toBeUndefined(); // never refused

    // NEGATIVE CONTROL — the same tape with the flag off is the clock test.
    const off = liveAccount();
    expect(off.tick(1.0, RISK_OFF)).toHaveLength(0);
    vi.setSystemTime(D1_OPEN + 3 * MIN);
    expect(off.tick(1.20, RISK_OFF)).toHaveLength(0);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(off.tick(1.10, RISK_OFF)).toHaveLength(0);
    expect(off.row().openingRangeSuppressed!.fires).toBe(1);
    vi.setSystemTime(D1_OPEN + 15 * MIN);
    expect(off.tick(1.10, RISK_OFF)[0]!.exitReason).toBe('profit_lock');
  });

  it('flag ON: a LEGACY row (no peakPremiumAt) reads as STALE — refused, exactly as today', () => {
    const { tick, row } = liveAccount();
    expect(tick(1.20, RISK_ON)).toHaveLength(0);
    // A snapshot written by a build without the stamp.
    delete row().peakPremiumAt;
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(tick(1.10, RISK_ON)).toHaveLength(0);
    expect(row().peakPremiumAt).toBeUndefined();
    expect(row().openingRangeSuppressed!.fires).toBe(1);
    vi.setSystemTime(D1_OPEN + 15 * MIN);
    expect(tick(1.10, RISK_ON)[0]!.exitReason).toBe('profit_lock');
  });

  it('flag ON: a pre-open tick is never "fresh" (fail-closed on the calendar), so nothing fires before the bell', () => {
    const { tick, row } = liveAccount();
    vi.setSystemTime(D1_OPEN - 30 * MIN); // 09:00 ET day 1
    expect(tick(1.20, RISK_ON)).toHaveLength(0); // peak set pre-open
    expect(row().peakPremiumAt).toBe(D1_OPEN - 30 * MIN);
    vi.setSystemTime(D1_OPEN - 20 * MIN);
    expect(tick(1.10, RISK_ON)).toHaveLength(0); // negative minutes ⇒ inside the window, and the stamp predates the open
    expect(row().openingRangeSuppressed!.fires).toBe(1);
  });

  it('chandelier: yesterday’s UNDERLYING extreme stays suppressed at 09:35 and still RE-ANCHORS (TRA-3217 path unchanged); today’s extreme fires', () => {
    // Stale — identical to the TRA-3217 pin, with the flag ON.
    const stale = liveAccount();
    expect(stale.tickSpot(200, RISK_CH_ON)).toHaveLength(0);
    expect(stale.tickSpot(210, RISK_CH_ON)).toHaveLength(0);
    expect(stale.row().peakUnderlying).toBe(210);
    expect(stale.row().peakUnderlyingAt).toBe(TRADING_TIME);
    expect(stale.row().chandelierStop).toBeCloseTo(198, 6);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(stale.tickSpot(195, RISK_CH_ON)).toHaveLength(0);
    expect(stale.row().chandelierBreachedWhileSuppressed).toBe(true);
    expect(stale.row().openingRangeSuppressed!.fires).toBe(1); // R4 counts the chandelier refusal too
    vi.setSystemTime(D1_OPEN + 20 * MIN);
    expect(stale.tickSpot(195, RISK_CH_ON)).toHaveLength(0);
    expect(stale.row().peakUnderlying).toBe(195);
    expect(stale.row().chandelierStop).toBeCloseTo(183, 6);
    expect(stale.acct.getChandelierStaleBreachVetoes()).toBe(1);

    // Fresh — the extreme advanced at 09:32 today, so the 09:35 breach is a real break.
    const fresh = liveAccount();
    fresh.tickSpot(200, RISK_CH_ON);
    fresh.tickSpot(210, RISK_CH_ON);
    vi.setSystemTime(D1_OPEN + 2 * MIN);
    expect(fresh.tickSpot(215, RISK_CH_ON)).toHaveLength(0); // new high ⇒ stop 203
    expect(fresh.row().peakUnderlyingAt).toBe(D1_OPEN + 2 * MIN);
    expect(fresh.row().chandelierStop).toBeCloseTo(203, 6);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    const closed = fresh.tickSpot(202, RISK_CH_ON);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('chandelier');
    expect(fresh.acct.getChandelierStaleBreachVetoes()).toBe(0);

    // NEGATIVE CONTROL — flag OFF, same fresh tape: the clock refuses it.
    const off = liveAccount();
    off.tickSpot(200, RISK_CH_OFF);
    off.tickSpot(210, RISK_CH_OFF);
    vi.setSystemTime(D1_OPEN + 2 * MIN);
    off.tickSpot(215, RISK_CH_OFF);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(off.tickSpot(202, RISK_CH_OFF)).toHaveLength(0);
    expect(off.row().chandelierBreachedWhileSuppressed).toBe(true);
  });

  it('the TRA-3902 hard-stop hold keeps the CLOCK window even when the peak is fresh, and the floor never realises a LOSS through it', () => {
    const { tick, row, acct } = liveAccount();
    vi.setSystemTime(D1_OPEN + 2 * MIN);
    expect(tick(1.20, RISK_ON)).toHaveLength(0); // fresh peak, floor armed at +0.25R
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    // A gap from +1.0R straight through the floor AND the 0.80 stop to −1.25R.
    // The floor is a PROFIT lock: below 0R the row is the stop's, and the stop
    // is HELD inside the window (board directive). Nothing sells this print.
    expect(tick(0.75, RISK_ON)).toHaveLength(0);
    expect(row().slHeldInOpeningRange).toBe(true);
    expect(acct.getSlOpeningRangeHolds()).toBe(1);
    expect(acct.getProfitFloorFires()).toBe(0);
    // Between 0R and the floor the floor DOES fire (that is the lock).
    const winner = liveAccount();
    vi.setSystemTime(D1_OPEN + 2 * MIN);
    winner.tick(1.20, RISK_ON);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(winner.tick(1.01, RISK_ON)[0]!.exitReason).toBe('profit_floor'); // +0.05R
    // And a small loser at the open is NOT the floor's, and a fresh peak does
    // NOT release the window for it either: inside the window nothing sells a
    // loser. It is held (and counted), then the give-back leg takes it at
    // 09:45 as an ordinary `profit_lock`.
    const loser = liveAccount();
    vi.setSystemTime(D1_OPEN + 2 * MIN);
    loser.tick(1.20, RISK_ON);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(loser.tick(0.98, RISK_ON)).toHaveLength(0); // −0.1R, above the 0.80 stop
    expect(loser.row().openingRangeSuppressed!.fires).toBe(1);
    expect(loser.acct.getProfitFloorFires()).toBe(0);
    vi.setSystemTime(D1_OPEN + 15 * MIN);
    const closed = loser.tick(0.98, RISK_ON);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_lock');
    // Symmetric on the chandelier: a fresh underlying high does not release the
    // window for a row whose PREMIUM is under water.
    const chLoser = liveAccount();
    chLoser.tickSpot(200, RISK_CH_ON);
    chLoser.tickSpot(210, RISK_CH_ON);
    vi.setSystemTime(D1_OPEN + 2 * MIN);
    chLoser.tickSpot(215, RISK_CH_ON); // fresh high ⇒ stop 203
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    const sym = chLoser.acct.getState().openOptions[0]!.optionSymbol!;
    const heldLoser = chLoser.acct.checkExits(new Map([['AAPL', 202]]), new Map([[sym, 0.95]]), 'live', {}, undefined, RISK_CH_ON);
    expect(heldLoser).toHaveLength(0);
    expect(chLoser.row().chandelierBreachedWhileSuppressed).toBe(true);
  });
});

describe('TRA-4020 R3 — an armed FLOOR fires through all three suppressions as `profit_floor`', () => {
  it('through the opening-range window at 09:35 (flag ON); the same tick is refused with the flag OFF', () => {
    const on = liveAccount();
    expect(on.tick(1.20, RISK_ON)).toHaveLength(0); // peakR 1.0 ⇒ floor +0.25R = 1.05
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    const closed = on.tick(1.04, RISK_ON); // +0.2R: under the floor, yesterday's peak, inside the window
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_floor');
    expect(closed[0]!.openingRangeSuppressed).toBeUndefined(); // it was never refused
    expect(on.acct.getProfitFloorFires()).toBe(1);
    expect(on.acct.getState().openOptions).toHaveLength(0);

    const off = liveAccount();
    expect(off.tick(1.20, RISK_OFF)).toHaveLength(0);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(off.tick(1.04, RISK_OFF)).toHaveLength(0);
    expect(off.row().openingRangeSuppressed!.fires).toBe(1);
    expect(off.acct.getProfitFloorFires()).toBe(0);
    vi.setSystemTime(D1_OPEN + 15 * MIN);
    expect(off.tick(1.04, RISK_OFF)[0]!.exitReason).toBe('profit_lock'); // today's rule, after the wait
  });

  it('the give-back leg above the floor is NOT exempt: +0.5R at 09:35 off a stale peak is still refused with the flag ON', () => {
    const { tick, row } = liveAccount();
    tick(1.20, RISK_ON);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(tick(1.10, RISK_ON)).toHaveLength(0);
    expect(row().openingRangeSuppressed!.fires).toBe(1);
  });

  it('through the PDT hold ONLY with day-trade capacity: released ⇒ fires; held / absent release ⇒ held, counted once per day', () => {
    // Open on day 1 at 10:00 ET (inside the entry window) so the row is
    // day-one (`pdtHeldToday`). The opening-range window is closed by then —
    // this scenario is about the PDT hold alone.
    const D1_1000 = D1_OPEN + 30 * MIN;
    const released = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    expect(released.tick(1.20, RISK_ON, { otmDayOneStop: { rule: OTM_STOP_OFF, release: RELEASED } })).toHaveLength(0);
    vi.setSystemTime(D1_1000 + 5 * MIN);
    const closed = released.tick(1.04, RISK_ON, { otmDayOneStop: { rule: OTM_STOP_OFF, release: RELEASED } });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_floor');
    expect(released.acct.getProfitFloorPdtHolds()).toBe(0);

    // No capacity ⇒ held, latched once per row per ET day.
    const held = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    held.tick(1.20, RISK_ON, { otmDayOneStop: { rule: OTM_STOP_OFF, release: HELD } });
    vi.setSystemTime(D1_1000 + 5 * MIN);
    expect(held.tick(1.04, RISK_ON, { otmDayOneStop: { rule: OTM_STOP_OFF, release: HELD } })).toHaveLength(0);
    // TRA-4030 — the latch is now the per-row record; its day-key set is the latch.
    expect(held.row().profitFloorHeldForPdt).toEqual({
      holds: 1,
      firstHeldAt: D1_1000 + 5 * MIN,
      lastHeldAt: D1_1000 + 5 * MIN,
      etDayKeys: ['2024-06-05'],
      premiumAtFirstHold: 1.04,
    });
    expect(held.acct.getProfitFloorPdtHolds()).toBe(1);
    vi.setSystemTime(D1_1000 + 30 * MIN);
    expect(held.tick(1.04, RISK_ON, { otmDayOneStop: { rule: OTM_STOP_OFF, release: HELD } })).toHaveLength(0);
    expect(held.acct.getProfitFloorPdtHolds()).toBe(1); // once per row per day …
    expect(held.row().profitFloorHeldForPdt!.holds).toBe(2); // … but every held TICK on the row
    expect(held.row().profitFloorHeldForPdt!.etDayKeys).toEqual(['2024-06-05']);

    // No release object at all ⇒ fail closed: held.
    const absent = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    absent.tick(1.20, RISK_ON);
    vi.setSystemTime(D1_1000 + 5 * MIN);
    expect(absent.tick(1.04, RISK_ON)).toHaveLength(0);
    expect(absent.acct.getProfitFloorPdtHolds()).toBe(1);

    // NEGATIVE CONTROL — flag OFF with capacity: the PDT hold still holds everything.
    // TRA-4030 — and that hold is NOT a capacity hold, so the PDT column stays absent.
    const off = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    off.tick(1.20, RISK_OFF, { otmDayOneStop: { rule: OTM_STOP_OFF, release: RELEASED } });
    vi.setSystemTime(D1_1000 + 30 * MIN);
    expect(off.tick(1.04, RISK_OFF, { otmDayOneStop: { rule: OTM_STOP_OFF, release: RELEASED } })).toHaveLength(0);
    expect(off.acct.getProfitFloorPdtHolds()).toBe(0);
    expect(off.row().profitFloorHeldForPdt).toBeUndefined();
  });

  it('through the swing hold (demo RV row under `swingHoldOptions`) as `profit_floor`; held with the flag OFF', () => {
    const run = (risk: OptionExitRiskInput) => {
      vi.setSystemTime(TRADING_TIME);
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5, swingHoldOptions: true });
      const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, undefined, JOURNAL_SETUP);
      expect(pos).not.toBeNull();
      const sym = pos!.optionSymbol!;
      const R = pos!.premiumPaid - pos!.stopLossPremium;
      expect(R).toBeGreaterThan(0);
      const at = (r: number) => pos!.premiumPaid + r * R;
      const tick = (mark: number) =>
        acct.checkExits(new Map([['MSFT', 400]]), new Map([[sym, mark]]), 'demo', {}, undefined, risk);
      // Same session (10:05 ET) ⇒ `swingHeldToday`. peakR 0.9 sits under the RV
      // trail activation (+25%) so the premium trail stays dormant.
      vi.setSystemTime(TRADING_TIME + 5 * MIN);
      expect(tick(at(0.9))).toHaveLength(0);
      vi.setSystemTime(TRADING_TIME + 10 * MIN);
      return { acct, closed: tick(at(0.2)) }; // under the +0.25R floor
    };
    const on = run(RISK_ON);
    expect(on.closed).toHaveLength(1);
    expect(on.closed[0]!.exitReason).toBe('profit_floor');
    expect(on.acct.getProfitFloorFires()).toBe(1);

    const off = run(RISK_OFF);
    expect(off.closed).toHaveLength(0);
    expect(off.acct.getState().openOptions).toHaveLength(1);
  });

  it('an UNMANAGED row (riskUnmanagedReason) never gets the floor — the exemption is not a side door', () => {
    const { tick, row } = liveAccount();
    tick(1.20, RISK_ON);
    row().riskUnmanagedReason = 'sub_floor_premium';
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    expect(tick(1.04, RISK_ON)).toHaveLength(0);
  });
});

describe('TRA-4020 R4 — the journal close row carries MFE and the refusal record', () => {
  let tmpFile: string;
  let fileCounter = 0;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra4020-journal-${process.pid}-${fileCounter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  it('a suppressed-then-fired row (flag OFF) lands peakPremium / peakPremiumAt / openingRangeSuppressed with both premiums', async () => {
    const { acct, tick } = liveAccount();
    await acct.flushOptionTradeJournal();
    tick(1.20, RISK_OFF);
    vi.setSystemTime(D1_OPEN + 5 * MIN);
    tick(1.10, RISK_OFF);
    vi.setSystemTime(D1_OPEN + 10 * MIN);
    tick(1.10, RISK_OFF);
    vi.setSystemTime(D1_OPEN + 15 * MIN);
    const closed = tick(1.10, RISK_OFF);
    expect(closed).toHaveLength(1);
    await acct.flushOptionTradeJournal();

    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.outcome).not.toBe('OPEN');
    expect(rec.exitReason).toBe('profit_lock');
    expect(rec.peakPremium).toBe(1.20);
    expect(rec.peakPremiumAt).toBe(TRADING_TIME);
    expect(rec.openingRangeSuppressed).toEqual({
      fires: 2,
      firstSuppressedAt: D1_OPEN + 5 * MIN,
      lastSuppressedAt: D1_OPEN + 10 * MIN,
      premiumAtSuppression: 1.10,
      premiumAtFire: 1.10,
    });
  });

  it('a row the window never refused carries the MFE and NO refusal record (absent stays absent)', async () => {
    const { acct, tick } = liveAccount();
    await acct.flushOptionTradeJournal();
    tick(1.20, RISK_ON);
    vi.setSystemTime(D1_OPEN + 30 * MIN); // outside the window: a plain give-back
    const closed = tick(1.10, RISK_ON);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_lock');
    await acct.flushOptionTradeJournal();
    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.peakPremium).toBe(1.20);
    expect(rec.peakPremiumAt).toBe(TRADING_TIME);
    expect(rec.openingRangeSuppressed).toBeUndefined();
    expect(rec.profitFloorHeldForPdt).toBeUndefined();
  });
});

// TRA-4030 (parent TRA-4029) — the PDT column of the R4 instrument. The
// opening-range half above already persists per row; the PDT half was a
// since-boot counter that every restart zeroed and that could not be joined to
// the row it held. These scenarios are the done bar, in order: accrues with the
// flag OFF (the cohort being priced), survives a snapshot round trip, lands on
// the journal close row beside `openingRangeSuppressed`, and is served by the
// `?rows=all` dump the TRA-4029 read runs against.
describe('TRA-4030 R4 — the PDT hold is per-row, restart-durable, and on the journal close', () => {
  const D1_1000 = D1_OPEN + 30 * MIN;
  const HELD_OPTS = { otmDayOneStop: { rule: OTM_STOP_OFF, release: HELD } };
  let tmpFile: string;
  let fileCounter = 0;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra4030-journal-${process.pid}-${fileCounter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  it('flag OFF (PROFIT_FLOOR_TRAIL_ENABLED unset): a held SHADOW floor accrues the record per tick and changes no decision', () => {
    expect(process.env['PROFIT_FLOOR_TRAIL_ENABLED']).toBeUndefined();
    const { acct, tick, row } = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    expect(tick(1.20, RISK_OFF, HELD_OPTS)).toHaveLength(0); // peakR 1.0 ⇒ shadow floor +0.25R = 1.05
    expect(row().profitFloorHeldForPdt).toBeUndefined(); // above the floor: nothing to hold
    vi.setSystemTime(D1_1000 + 5 * MIN);
    expect(tick(1.04, RISK_OFF, HELD_OPTS)).toHaveLength(0); // under the floor, no capacity ⇒ HELD
    expect(row().profitFloorHeldForPdt).toEqual({
      holds: 1,
      firstHeldAt: D1_1000 + 5 * MIN,
      lastHeldAt: D1_1000 + 5 * MIN,
      etDayKeys: ['2024-06-05'],
      premiumAtFirstHold: 1.04,
    });
    // A second read on the SAME tick is one wait, not two.
    expect(tick(1.03, RISK_OFF, HELD_OPTS)).toHaveLength(0);
    expect(row().profitFloorHeldForPdt!.holds).toBe(1);
    vi.setSystemTime(D1_1000 + 6 * MIN);
    expect(tick(1.03, RISK_OFF, HELD_OPTS)).toHaveLength(0);
    expect(row().profitFloorHeldForPdt!.holds).toBe(2);
    expect(row().profitFloorHeldForPdt!.lastHeldAt).toBe(D1_1000 + 6 * MIN);
    expect(row().profitFloorHeldForPdt!.premiumAtFirstHold).toBe(1.04); // first hold's mark, never overwritten
    // The flag is OFF: no `profit_floor` fired, the row is still open, the
    // since-boot counter says one row-day.
    expect(acct.getProfitFloorFires()).toBe(0);
    expect(acct.getState().openOptions).toHaveLength(1);
    expect(acct.getProfitFloorPdtHolds()).toBe(1);
    // An absent release object fails closed the same way.
    const absent = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    absent.tick(1.20, RISK_OFF);
    vi.setSystemTime(D1_1000 + 5 * MIN);
    expect(absent.tick(1.04, RISK_OFF)).toHaveLength(0);
    expect(absent.row().profitFloorHeldForPdt!.holds).toBe(1);
  });

  it('the record rides the position snapshot: a hold that spans a restart is one hold on one row, and the next ET day appends its key', () => {
    const { acct, tick, row } = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    tick(1.20, RISK_OFF, HELD_OPTS);
    vi.setSystemTime(D1_1000 + 5 * MIN);
    tick(1.04, RISK_OFF, HELD_OPTS);
    expect(row().profitFloorHeldForPdt!.holds).toBe(1);
    expect(acct.getProfitFloorPdtHolds()).toBe(1);

    // RESTART — through the durable boundary: JSON out, JSON in, a fresh process.
    const snap = JSON.parse(JSON.stringify(acct.exportSnapshot()));
    const restarted = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      holdLiveOptionsOvernightForPdt: true,
    });
    restarted.importSnapshot(snap);
    expect(restarted.getProfitFloorPdtHolds()).toBe(0); // the since-boot counter is what a restart zeroes …
    const row2 = () => restarted.getState().openOptions[0]!;
    expect(row2().profitFloorHeldForPdt).toEqual({          // … the row is what it does not
      holds: 1,
      firstHeldAt: D1_1000 + 5 * MIN,
      lastHeldAt: D1_1000 + 5 * MIN,
      etDayKeys: ['2024-06-05'],
      premiumAtFirstHold: 1.04,
    });
    const sym = row2().optionSymbol!;
    const tick2 = (mark: number, options: Parameters<PaperOptionsAccount['checkExits']>[3] = {}) =>
      restarted.checkExits(new Map([['AAPL', 200]]), new Map([[sym, mark]]), 'live', options, undefined, RISK_OFF);
    // Same ET day, after the restart: the count CONTINUES, the day-key set does not grow.
    vi.setSystemTime(D1_1000 + 10 * MIN);
    expect(tick2(1.04, HELD_OPTS)).toHaveLength(0);
    expect(row2().profitFloorHeldForPdt!.holds).toBe(2);
    expect(row2().profitFloorHeldForPdt!.etDayKeys).toEqual(['2024-06-05']);
    expect(restarted.getProfitFloorPdtHolds()).toBe(0); // not a new row-day ⇒ the log/counter event does not re-fire
    // A restart in the middle of the next session: the row opened yesterday
    // (2024-06-05 ET), so it is no longer day-one and the PDT hold releases it.
    // Under the flag-off rule the give-back leg (`profit_lock`, level +0.6R)
    // takes it, and the record is stamped with the mark at the fire.
    const D2_1000 = D1_1000 + 24 * 60 * MIN;
    vi.setSystemTime(D2_1000);
    const closed = tick2(1.04, HELD_OPTS);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_lock');
    expect(closed[0]!.profitFloorHeldForPdt).toEqual({
      holds: 2,
      firstHeldAt: D1_1000 + 5 * MIN,
      lastHeldAt: D1_1000 + 10 * MIN,
      etDayKeys: ['2024-06-05'],
      premiumAtFirstHold: 1.04,
      premiumAtFire: 1.04,
    });
  });

  it('a snapshot written by the TRA-4020 build (bare day-key string) imports cleanly: the scalar is dropped, not read as a record', () => {
    const { acct, tick } = liveAccount(D1_1000);
    vi.setSystemTime(D1_1000 + 2 * MIN);
    tick(1.20, RISK_OFF, HELD_OPTS);
    const snap = JSON.parse(JSON.stringify(acct.exportSnapshot()));
    snap.openOptions[0].profitFloorHeldForPdt = '2024-06-05';
    const restarted = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5, holdLiveOptionsOvernightForPdt: true });
    restarted.importSnapshot(snap);
    const row2 = () => restarted.getState().openOptions[0]!;
    expect(row2().profitFloorHeldForPdt).toBeUndefined();
    const sym = row2().optionSymbol!;
    vi.setSystemTime(D1_1000 + 5 * MIN);
    restarted.checkExits(new Map([['AAPL', 200]]), new Map([[sym, 1.04]]), 'live', HELD_OPTS, undefined, RISK_OFF);
    expect(row2().profitFloorHeldForPdt!.holds).toBe(1); // a fresh record starts from the first post-migration hold
  });

  it('flag OFF: the journal close row carries profitFloorHeldForPdt beside openingRangeSuppressed, and it is served by ?rows=all', async () => {
    const { acct, tick } = liveAccount(D1_1000);
    await acct.flushOptionTradeJournal();
    vi.setSystemTime(D1_1000 + 2 * MIN);
    tick(1.20, RISK_OFF, HELD_OPTS);
    vi.setSystemTime(D1_1000 + 5 * MIN);
    tick(1.04, RISK_OFF, HELD_OPTS);
    vi.setSystemTime(D1_1000 + 6 * MIN);
    tick(1.04, RISK_OFF, HELD_OPTS);
    // Day 2, INSIDE the opening-range window: the give-back off yesterday's
    // peak is refused by the window (the opening-range column accrues on the
    // same row), then fires at 09:45 as `profit_lock`.
    const D2_OPEN = D1_OPEN + 24 * 60 * MIN;
    vi.setSystemTime(D2_OPEN + 5 * MIN);
    expect(tick(1.02, RISK_OFF, HELD_OPTS)).toHaveLength(0);
    vi.setSystemTime(D2_OPEN + 15 * MIN);
    const closed = tick(1.02, RISK_OFF, HELD_OPTS);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('profit_lock');
    await acct.flushOptionTradeJournal();

    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.outcome).not.toBe('OPEN');
    expect(rec.openingRangeSuppressed).toEqual({
      fires: 1,
      firstSuppressedAt: D2_OPEN + 5 * MIN,
      lastSuppressedAt: D2_OPEN + 5 * MIN,
      premiumAtSuppression: 1.02,
      premiumAtFire: 1.02,
    });
    expect(rec.profitFloorHeldForPdt).toEqual({
      holds: 2,
      firstHeldAt: D1_1000 + 5 * MIN,
      lastHeldAt: D1_1000 + 6 * MIN,
      etDayKeys: ['2024-06-05'],
      premiumAtFirstHold: 1.04,
      premiumAtFire: 1.02,
    });
    // One grader, two columns: the same subtraction on each.
    expect(rec.profitFloorHeldForPdt!.premiumAtFirstHold - rec.profitFloorHeldForPdt!.premiumAtFire!).toBeCloseTo(0.02, 9);
    expect(rec.openingRangeSuppressed!.premiumAtSuppression - rec.openingRangeSuppressed!.premiumAtFire!).toBeCloseTo(0, 9);

    // The read TRA-4029 runs: `/api/health/option-journal?rows=all` dumps the
    // folded record verbatim, so both columns are on the wire together.
    const { buildOptionJournalReport } = await import('./observability/health-routes.js');
    const report = buildOptionJournalReport(await listOptionTradeJournal(), Date.now(), true, undefined, undefined, 'all');
    expect(report.rowsMode).toBe('all');
    const dumped = report.rows!.find((r) => r.id === rec.id)!;
    expect(dumped.profitFloorHeldForPdt).toEqual(rec.profitFloorHeldForPdt);
    expect(dumped.openingRangeSuppressed).toEqual(rec.openingRangeSuppressed);
    // TRA-4440 — explicit 30s timeout. This case measures 3381ms ALONE (94% of this
    // file's 3607ms), against vitest's 5000ms default: a 1.6s margin. Under the full
    // 444-file suite it exceeded 5000ms on both observed runs, while passing solo —
    // i.e. the failure tracked machine contention, not the assertions. The number is
    // raised rather than the work reduced because the journal flush + `?rows=all`
    // round-trip IS what R4 is asserting on.
  }, 30_000);
});
