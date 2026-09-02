// TRA-3943 (parent TRA-3927, board card `a29b2db8` accepted 2026-08-22T04:18Z) —
// the OTM sleeve's INTRADAY stop.
//
// ── What the tape said (finding F4) ─────────────────────────────────────────
// `liveStopPolicy: daily_close` reads the −20% stop only in the last 30 min of
// RTH, and `holdLiveOptionsOvernightForPdt` refuses EVERY engine exit on a row
// opened today. Composed, a day-one entry had NO stop until the next session's
// close window, and the losers ran to −45…−75% (AMZN put −$189, SPY −$156,
// PLTR −$115, BAC −$74) while the winners were cut at the next open.
//
// ── What is asserted, and why it is paired ──────────────────────────────────
// Every SUBJECT here runs against a POSITIVE CONTROL on the same account shape,
// the same clock and the same price path with the rule DETACHED (`otmDayOneStop`
// absent from the options bag) — which is exactly the pre-TRA-3943 build. Without
// that pairing "the row closed" proves nothing: a −35% mark is also below the
// −20% `stopLossPremium`, so a close could be the OLD stop firing under a policy
// this file never set, and the test would read green against the defect.
//
// The controls are the reason the ordering below is what it is:
//   1. the RULE resolver — defaults, the one disarming token, and env_invalid;
//   2. the LEVEL helper — every fail-closed direction, incl. the TRA-2893 put;
//   3. AC1 — the three verdicts, on a LIVE DAY-ONE row under the PDT hold;
//   4. the RELEASE — capacity-aware, fail-closed, latched;
//   5. scope — RV / directional rows, and the opening-range window;
//   6. actionable — the staged order is the same one the trail exit stages;
//   7. AC2 — the posture endpoint's fields;
//   8. AC4 — the arm, the row size and the 2-row cap are not read.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  PaperOptionsAccount,
  summarizeDayOneStopPosture,
  mergeDayOneStopPosture,
  blindDayOneStopPosture,
  summarizeLiveStopActionability,
  type LiveStopActionabilityContext,
} from './options-account.js';
import {
  resolveOtmDayOneStopRule,
  resolveOtmDayOneStopRelease,
  otmDayOneStopVerdict,
  otmAtrInvalidationLevel,
  OTM_DAY_ONE_STOP_VALUE,
  OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE,
  OTM_DAY_ONE_STOP_ATR_MULT_VALUE,
  OTM_DAY_ONE_STOP_PREMIUM_PCT_DEFAULT,
  OTM_DAY_ONE_STOP_ATR_MULT_DEFAULT,
  OTM_DAY_ONE_STOP_BASIS,
} from './otm-day-one-stop.js';
import type { OtmMispricingSignal, RelativeValueSignal, OptionPosition } from '@trading-app/shared';

const HERE = dirname(fileURLToPath(import.meta.url));

// 11:00 ET on a Wednesday (15:00Z under EDT): inside RTH, past the 15-minute
// opening-range window, and far from the 15:30 ET daily-close window — so the
// ONLY rule that can close a row on this clock is the one under test.
const D1_OPEN = Date.parse('2024-06-05T13:30:00.000Z'); // 09:30 ET
const MIDDAY = D1_OPEN + 90 * 60_000;                   // 11:00 ET, same ET day

/** The board's live policy, so the `daily_close` backstop is genuinely in play. */
const DAILY_CLOSE = { policy: 'daily_close' as const, closeWindowMin: 30, catastrophicLossPct: 0.5 };

const RULE = resolveOtmDayOneStopRule({});
/** ***0154's shape: a CASH account, no PDT bucket to burn. */
const CASH_RELEASE = resolveOtmDayOneStopRelease({ accountType: 'cash', dayTradeBuyingPower: null });
/** A margin account with the day-trade bucket exhausted — the fail-closed world. */
const NO_CAPACITY = resolveOtmDayOneStopRelease({ accountType: 'margin', dayTradeBuyingPower: 0 });

const ARMED = { rule: RULE, release: CASH_RELEASE };

function buildOtmSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-otm-3943',
    symbol: 'AAPL',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: MIDDAY,
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

function buildRvSignal(): RelativeValueSignal {
  return {
    id: 'sig-rv-3943',
    symbol: 'MSFT',
    type: 'relative_value',
    side: 'buy',
    entryPrice: 1.0,
    stopLoss: 0.75,
    takeProfit: 1.5,
    riskRewardRatio: 2,
    timestamp: MIDDAY,
    optionSymbol: 'MSFT240705C00400000',
    optionType: 'call',
    strike: 400,
    expiration: '2024-07-05',
    mark: 1.0,
    fairPrice: 1.30,
    mispricingPct: -0.23,
    zScore: -1.8,
    ivFitted: 0.30,
    ivUsed: 0.24,
    delta: 0.5,
    reason: 'TRA-3943 scope control',
  };
}

/**
 * A LIVE, DAY-ONE OTM call under the PDT overnight hold — the exact population
 * TRA-3892 measured as carrying full-premium downside.
 *
 * Entry 1.00 at spot 200, ATR(14, daily) 5 ⇒ invalidation level 195. Stop
 * `stopLossPremium` 0.80 (−20%), TP1 1.50. `contracts` is deliberately > 1 so a
 * TP1 partial is REACHABLE on this row (see the risk-reducing-only test).
 */
function liveOtmRow(opts: { optionType?: 'call' | 'put'; spot?: number; atr?: number } = {}) {
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: true,
  });
  const optionType = opts.optionType ?? 'call';
  const spot = opts.spot ?? 200;
  const pos = acct.openOptionFromCandidate(
    buildOtmSignal(
      optionType === 'put'
        ? { optionType: 'put', optionSymbol: 'AAPL240705P00190000', strike: 190 }
        : {},
    ),
    'live',
    50_000,
    spot,
  );
  expect(pos).not.toBeNull();
  expect(pos!.mode).toBe('live');
  expect(pos!.signalType).toBe('otm_mispricing');
  expect(pos!.premiumPaid).toBeCloseTo(1.0, 6);
  expect(pos!.stopLossPremium).toBeCloseTo(0.80, 6);
  expect(pos!.underlyingEntryPrice).toBeCloseTo(spot, 6);
  const stamped = acct.stampOtmAtrInvalidation(pos!.id, {
    atrDaily: opts.atr ?? 5,
    atrMult: RULE.atrMult,
  });
  const sym = pos!.optionSymbol!;
  const row = (): OptionPosition => acct.getState().openOptions[0];
  /**
   * One exit-cadence tick. `bag` carries the rule; passing `{}` is the
   * pre-TRA-3943 build on the identical account, clock and price.
   */
  const tick = (
    mark: number,
    underlying: number,
    bag: Record<string, unknown> = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: ARMED },
  ) => acct.checkExits(
    new Map([[pos!.symbol, underlying]]),
    new Map([[sym, mark]]),
    'live',
    bag,
  );
  return { acct, sym, pos: pos!, row, tick, stamped };
}

/** The pre-TRA-3943 options bag: same policy, same window, no rule. */
const DETACHED = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15 };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(MIDDAY);
});

afterEach(() => {
  vi.useRealTimers();
});

// ── 1. the resolver ─────────────────────────────────────────────────────────
describe('TRA-3943 — resolveOtmDayOneStopRule', () => {
  it('defaults to the board ruling: ARMED, −35% premium, 1×ATR', () => {
    expect(resolveOtmDayOneStopRule({})).toEqual({
      armed: true,
      premiumStopPct: OTM_DAY_ONE_STOP_PREMIUM_PCT_DEFAULT,
      markFloorRatio: 0.65,
      atrMult: OTM_DAY_ONE_STOP_ATR_MULT_DEFAULT,
      source: 'default',
    });
    expect(OTM_DAY_ONE_STOP_PREMIUM_PCT_DEFAULT).toBe(0.35);
    expect(OTM_DAY_ONE_STOP_ATR_MULT_DEFAULT).toBe(1);
  });

  it('disarms ONLY on the exact token `off`, and says where the value came from', () => {
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'off' }))
      .toMatchObject({ armed: false, source: 'env' });
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: '  OFF ' }))
      .toMatchObject({ armed: false, source: 'env' });
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'on' }))
      .toMatchObject({ armed: true, source: 'env' });
  });

  it('a TYPO stays ARMED and is visible — never a silent revert to the decorative stop', () => {
    // The direction that matters. `disabled` is a plausible spelling of `off`,
    // and resolving it to "no stop" would restore the −45…−75% tape while the
    // wire read exactly like a healthy box.
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'disabled' }))
      .toMatchObject({ armed: true, source: 'env_invalid' });
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE]: 'nope' }))
      .toMatchObject({ premiumStopPct: 0.35, source: 'env_invalid' });
    // Bounds: 0 is "never fire" and 1 is "fire at zero premium" — this rule
    // spelled as its own absence, both times.
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE]: '0' }))
      .toMatchObject({ premiumStopPct: 0.35, source: 'env_invalid' });
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE]: '1' }))
      .toMatchObject({ premiumStopPct: 0.35, source: 'env_invalid' });
    expect(resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_ATR_MULT_VALUE]: '-1' }))
      .toMatchObject({ atrMult: 1, source: 'env_invalid' });
  });

  it('a deliberate, in-bounds tightening is honoured and reads `env`', () => {
    expect(resolveOtmDayOneStopRule({
      [OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE]: '0.25',
      [OTM_DAY_ONE_STOP_ATR_MULT_VALUE]: '1.5',
    })).toEqual({
      armed: true, premiumStopPct: 0.25, markFloorRatio: 0.75, atrMult: 1.5, source: 'env',
    });
  });
});

// ── 2. the level helper ─────────────────────────────────────────────────────
describe('TRA-3943 — otmAtrInvalidationLevel is fail-CLOSED in every direction', () => {
  it('a call invalidates BELOW entry and a put ABOVE it', () => {
    expect(otmAtrInvalidationLevel({
      optionType: 'call', underlyingEntryPrice: 200, atrDaily: 5, atrMult: 1,
    })).toBeCloseTo(195, 6);
    expect(otmAtrInvalidationLevel({
      optionType: 'put', underlyingEntryPrice: 200, atrDaily: 5, atrMult: 1,
    })).toBeCloseTo(205, 6);
  });

  it('THE TRA-2893 DIRECTION — a `0` entry anchor yields NO level, not a level at ±ATR', () => {
    // `underlyingEntryPrice` is a hard `0` on every `tradier_import` row. A put
    // level of `0 + 5 = 5` makes `spot >= level` ALWAYS TRUE, which force-exits
    // every imported put on the first tick and journals it as a real stop. The
    // helper must refuse, and the CALL side (which escapes by luck, `0 − 5 < 0`)
    // must refuse for the same stated reason rather than by accident.
    expect(otmAtrInvalidationLevel({
      optionType: 'put', underlyingEntryPrice: 0, atrDaily: 5, atrMult: 1,
    })).toBeNull();
    expect(otmAtrInvalidationLevel({
      optionType: 'call', underlyingEntryPrice: 0, atrDaily: 5, atrMult: 1,
    })).toBeNull();
    expect(otmAtrInvalidationLevel({
      optionType: 'put', underlyingEntryPrice: undefined, atrDaily: 5, atrMult: 1,
    })).toBeNull();
    expect(otmAtrInvalidationLevel({
      optionType: 'put', underlyingEntryPrice: Number.NaN, atrDaily: 5, atrMult: 1,
    })).toBeNull();
  });

  it('a cold ATR feed yields NO level, and a call whose band reaches through zero yields none either', () => {
    expect(otmAtrInvalidationLevel({
      optionType: 'call', underlyingEntryPrice: 200, atrDaily: undefined, atrMult: 1,
    })).toBeNull();
    expect(otmAtrInvalidationLevel({
      optionType: 'call', underlyingEntryPrice: 200, atrDaily: 0, atrMult: 1,
    })).toBeNull();
    // `spot <= -50` is unreachable, so publishing it would claim a leg that can
    // never fire.
    expect(otmAtrInvalidationLevel({
      optionType: 'call', underlyingEntryPrice: 200, atrDaily: 250, atrMult: 1,
    })).toBeNull();
  });

  it('a dark mark lands in the HOLD branch, not the firing one', () => {
    // `NaN <= floor` is false, but so is `NaN > floor` — the value has to be
    // refused explicitly or a future rewrite flips which way it falls (TRA-3440).
    const v = otmDayOneStopVerdict(
      { premiumPaid: 1, optionType: 'call', otmAtrInvalidationLevel: 195 },
      { mark: Number.NaN, underlyingSpot: 200, rule: RULE },
    );
    expect(v.fires).toBe(false);
  });
});

// ── 3. AC1 ──────────────────────────────────────────────────────────────────
// "mark falls to 64% of entry on day one -> close order emitted within one
//  exit-cadence tick; spot crosses 1xATR invalidation -> close; neither -> hold."
describe('TRA-3943 AC1 — the three verdicts on a LIVE DAY-ONE row', () => {
  it('POSITIVE CONTROL — with the rule DETACHED, a 0.64 mark on day one closes NOTHING', () => {
    // This is the defect, reproduced on the same clock and price the subject
    // below fires on: −36% of premium, the −20% stop through, and the row is
    // held to the next session by the PDT gate. Every number this test asserts
    // is what the box shipped before TRA-3943.
    const { row, tick } = liveOtmRow();
    expect(tick(0.64, 200, DETACHED)).toHaveLength(0);
    expect(row().pendingExit).toBeUndefined();
    expect(row().contractsRemaining).toBeGreaterThan(0);
  });

  it('SUBJECT — a 0.64 mark on day one emits a close in ONE tick, journalled `sl_otm_premium_pct`', () => {
    const { acct, row, tick } = liveOtmRow();
    const closed = tick(0.64, 200);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl_otm_premium_pct');
    // Fired at the MARK, not at the −35% level: a limit resting at the level
    // would sit above a market that has already traded through it.
    expect(closed[0].currentPremium).toBeCloseTo(0.64, 6);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ premiumPct: 1, atrInvalidation: 0, pdtHeld: 0 });
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(row).toBeDefined();
  });

  it('SUBJECT — 0.65 exactly is THROUGH (`<=`), 0.66 is not', () => {
    // The board wrote "mark <= 65% of entry premium". The boundary is the whole
    // difference between a −35% stop and a −34% one on a $250 row.
    expect(liveOtmRow().tick(0.65, 200)).toHaveLength(1);
    expect(liveOtmRow().tick(0.66, 200)).toHaveLength(0);
  });

  it('SUBJECT — spot through the 1×ATR invalidation closes, journalled `sl_otm_atr_invalidation`', () => {
    // Entry spot 200, ATR 5 ⇒ level 195. Mark 0.90 is −10%: nowhere near the
    // premium leg, and ABOVE the −20% `stopLossPremium`, so no other rule in
    // the cascade can account for this close.
    const { acct, tick, stamped } = liveOtmRow();
    expect(stamped).toBe(true);
    const closed = tick(0.90, 194.9);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl_otm_atr_invalidation');
    expect(closed[0].currentPremium).toBeCloseTo(0.90, 6);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ premiumPct: 0, atrInvalidation: 1 });
  });

  it('SUBJECT — a PUT invalidates on the OTHER side of entry', () => {
    // Same 200 entry, ATR 5 ⇒ level 205. A rise is the wrong side for a put.
    const { acct, tick } = liveOtmRow({ optionType: 'put' });
    expect(acct.getState().openOptions[0].otmAtrInvalidationLevel).toBeCloseTo(205, 6);
    expect(tick(0.90, 204.9)).toHaveLength(0); // not yet through
    const closed = tick(0.90, 205.1);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl_otm_atr_invalidation');
  });

  it('SUBJECT — NEITHER leg through: the row is HELD, and the same account fires on the next tick', () => {
    // The "hold" half of AC1 needs the rule proven live on the SAME account, or
    // it is indistinguishable from a rule that never ran at all.
    const { acct, row, tick } = liveOtmRow();
    expect(tick(0.90, 198)).toHaveLength(0);
    expect(row().pendingExit).toBeUndefined();
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ premiumPct: 0, atrInvalidation: 0, pdtHeld: 0 });
    // Same tick shape, one leg now through — so the hold above was a decision.
    expect(tick(0.60, 198)).toHaveLength(1);
  });

  it('SUBJECT — the rule governs EVERY day, not only day one', () => {
    // "day-one (and every day)". On day 2 the PDT hold has released, so this
    // asserts the rule outranks the `daily_close` DEFERRAL rather than the hold:
    // pre-TRA-3943, a −36% mark at 11:00 ET on day 2 read `daily_close_hold`
    // and waited for 15:30 ET.
    // BOTH books open on day 1 — the control has to be the same age as the
    // subject or it is day-one itself and gets held by the PDT gate instead of
    // the deferral this test is about.
    const { acct, tick } = liveOtmRow();
    const control = liveOtmRow();
    vi.setSystemTime(MIDDAY + 24 * 60 * 60_000);
    // Positive control on the sibling book: detached, the row is deferred.
    expect(control.tick(0.64, 200, DETACHED)).toHaveLength(0);
    expect(control.row().slHeldForDailyClose).toBeTruthy();
    const closed = tick(0.64, 200);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl_otm_premium_pct');
    expect(acct.getSlDailyCloseHolds()).toBe(0);
  });

  it('the `daily_close` backstop SURVIVES below it — a row the rule declines still meets −50%', () => {
    // Nothing was removed. With the rule DISARMED by env the −50% catastrophic
    // level is reached exactly as TRA-3902 left it, which is what makes this a
    // reordering rather than a replacement.
    const disarmed = { rule: resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'off' }), release: CASH_RELEASE };
    const { tick } = liveOtmRow();
    vi.setSystemTime(MIDDAY + 24 * 60 * 60_000); // day 2: past the PDT hold
    const closed = tick(0.45, 200, { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: disarmed });
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl_catastrophic');
  });
});

// ── 4. the release ──────────────────────────────────────────────────────────
describe('TRA-3943 — the day-one PDT release is capacity-aware and fails CLOSED', () => {
  it('a CASH account releases (no PDT bucket exists to burn) — the ***0154 shape', () => {
    expect(resolveOtmDayOneStopRelease({ accountType: 'cash', dayTradeBuyingPower: null }))
      .toEqual({ released: true, reason: 'cash_account', accountType: 'cash', dayTradeBuyingPowerUsd: null });
  });

  it('a MARGIN account releases only with positive day-trade buying power', () => {
    expect(resolveOtmDayOneStopRelease({ accountType: 'margin', dayTradeBuyingPower: 2_500 }))
      .toMatchObject({ released: true, reason: 'day_trade_capacity' });
    expect(resolveOtmDayOneStopRelease({ accountType: 'margin', dayTradeBuyingPower: 0 }))
      .toMatchObject({ released: false, reason: 'dtbp_exhausted' });
  });

  it('an ABSENT or UNCLASSIFIED balance HOLDS, and says which', () => {
    // The snapshot is dropped when it goes stale, so "we have not heard from the
    // broker" must not authorise a same-day round trip.
    expect(resolveOtmDayOneStopRelease(null))
      .toEqual({ released: false, reason: 'capacity_unreadable', accountType: null, dayTradeBuyingPowerUsd: null });
    expect(resolveOtmDayOneStopRelease({ accountType: null, dayTradeBuyingPower: null }))
      .toMatchObject({ released: false, reason: 'capacity_unreadable' });
    // A non-cash account whose DTBP is a non-finite reading must NOT ride the
    // positive branch (TRA-3486, the other direction).
    expect(resolveOtmDayOneStopRelease({ accountType: 'margin', dayTradeBuyingPower: Number.NaN }))
      .toMatchObject({ released: false, reason: 'capacity_unreadable' });
  });

  it('SUBJECT — with no capacity the day-one fire is HELD, counted once, and latched', () => {
    const { acct, row, tick } = liveOtmRow();
    const held = { rule: RULE, release: NO_CAPACITY };
    const bag = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: held };
    expect(tick(0.64, 200, bag)).toHaveLength(0);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ pdtHeld: 1, premiumPct: 0 });
    expect(row().otmStopHeldForPdt).toBe('2024-06-05');
    // A second tick still through: held, and the latch means one count, not one
    // per tick.
    expect(tick(0.60, 200, bag)).toHaveLength(0);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ pdtHeld: 1 });
    // POSITIVE CONTROL — the identical tick with capacity fires, so the hold
    // above was the release refusing and not the rule failing to evaluate.
    expect(tick(0.60, 200)).toHaveLength(1);
  });

  it('SUBJECT — the release is scoped to DAY ONE: a row opened yesterday never consults it', () => {
    const { acct, tick } = liveOtmRow();
    vi.setSystemTime(MIDDAY + 24 * 60 * 60_000);
    const closed = tick(0.64, 200, {
      liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: { rule: RULE, release: NO_CAPACITY },
    });
    // `pdtHeldToday` is false on day 2, so a closed day-trade bucket cannot
    // suppress a stop that is not a day trade.
    expect(closed).toHaveLength(1);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ pdtHeld: 0 });
  });

  it('the latch CLEARS when the mark heals, so a later breach is not read as a carried hold', () => {
    const { row, tick } = liveOtmRow();
    const bag = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: { rule: RULE, release: NO_CAPACITY } };
    expect(tick(0.64, 200, bag)).toHaveLength(0);
    expect(row().otmStopHeldForPdt).toBe('2024-06-05');
    expect(tick(0.95, 200, bag)).toHaveLength(0);
    expect(row().otmStopHeldForPdt).toBeUndefined();
  });
});

// ── 5. scope ────────────────────────────────────────────────────────────────
describe('TRA-3943 — scope: one sleeve, and not the opening print', () => {
  it('an RV row at the same −36% on day one is UNTOUCHED', () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000, managedAccountRatio: 0.5, holdLiveOptionsOvernightForPdt: true,
    });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'live', 50_000, 400);
    expect(pos).not.toBeNull();
    expect(pos!.signalType).toBe('relative_value');
    const closed = acct.checkExits(
      new Map([['MSFT', 400]]), new Map([[pos!.optionSymbol!, 0.64]]), 'live',
      { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: ARMED },
    );
    // Held by the PDT gate exactly as before: the rule never looked at this row.
    expect(closed).toHaveLength(0);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ premiumPct: 0, pdtHeld: 0 });
  });

  it('the OPENING PRINT is not where this fires — held inside the window, fires on the first tick after', () => {
    // TRA-3902's first fix and TRA-3941's own tape agree that this sleeve's
    // exits went wrong AT THE OPEN (every chandelier close landed 0–18 min after
    // it). A −35% stop that fires on the widest quote of the session is the same
    // defect wearing this ticket's name.
    const { acct, tick } = liveOtmRow();
    vi.setSystemTime(D1_OPEN + 5 * 60_000); // 09:35 ET, inside the 15-min window
    expect(tick(0.64, 200)).toHaveLength(0);
    expect(acct.getOtmDayOneStopCounters()).toMatchObject({ premiumPct: 0, pdtHeld: 0 });
    vi.setSystemTime(D1_OPEN + 16 * 60_000); // 09:46 ET, first tick after
    const closed = tick(0.64, 200);
    expect(closed).toHaveLength(1);
    expect(closed[0].exitReason).toBe('sl_otm_premium_pct');
  });

  it('the release is RISK-REDUCING ONLY — a day-one TP1 partial is still held', () => {
    // TRA-3892 ruling 4's other half. The two conditions are near-disjoint on
    // today's thresholds, so this asserts the SCOPE and not the arithmetic: a
    // profitable day-one row must not walk through the PDT hold on a stop's
    // release.
    const { acct, row, tick } = liveOtmRow();
    expect(tick(1.60, 200)).toHaveLength(0); // 1.60 > TP1 1.50
    expect(row().tp1Hit).toBeFalsy();
    expect(row().contractsRemaining).toBe(acct.getState().openOptions[0].contracts);
  });
});

// ── 6. actionable ───────────────────────────────────────────────────────────
describe('TRA-3943 — the stop is ACTIONABLE: it stages the same order the trail stages', () => {
  it('under broker mirroring the fire stages a `sell_to_close` intent, kind `sl`, reason on the row', () => {
    const { row, tick } = liveOtmRow();
    const closed = tick(0.64, 200, {
      waitAndHold: true, liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: ARMED,
    });
    expect(closed).toHaveLength(1);
    const staged = row().pendingExit;
    expect(staged).toBeDefined();
    // `kind: 'sl'` is what puts it on the risk-REDUCING side of the TRA-2984
    // expiry escalation, so an unfilled stop crosses the spread on the retry
    // instead of repeating an order the market has already refused. That is the
    // difference between an actionable stop and a decorative one.
    expect(staged!.kind).toBe('sl');
    expect(staged!.journalReason).toBe('sl_otm_premium_pct');
    expect(staged!.qty).toBeGreaterThan(0);
    expect(staged!.limitPrice).toBeCloseTo(0.64, 6);
    // The row stays open until the broker fill lands — the TRA-354 contract,
    // identical to the trail exit's staging.
    expect(row().contractsRemaining).toBeGreaterThan(0);
  });

  it('the staged price is the MARK, so the limit is not left resting above the market', () => {
    const { row, tick } = liveOtmRow();
    tick(0.50, 200, { waitAndHold: true, liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15, otmDayOneStop: ARMED });
    expect(row().pendingExit!.limitPrice).toBeCloseTo(0.50, 6);
    // NOT `stopLossPremium` (0.80) and NOT the −35% level (0.65): both sit above
    // a market that has already traded through them.
    expect(row().pendingExit!.limitPrice).not.toBeCloseTo(0.80, 6);
  });
});

// ── 7. AC2 ──────────────────────────────────────────────────────────────────
// "/api/health/options-live liveDayOneStopPosture shows stopBasis != full_premium
//  for OTM rows, with the two thresholds exposed."
describe('TRA-3943 AC2 — the posture endpoint', () => {
  const rowAt = (over: Partial<OptionPosition>): OptionPosition => ({
    id: 'p1', symbol: 'AAPL', optionSymbol: 'AAPL240705C00200000', optionType: 'call',
    strike: 200, expiration: '2024-07-05', contracts: 1, contractsRemaining: 1,
    premiumPaid: 2.5, currentPremium: 2.5, tp1Premium: 3.75, tp1Hit: false,
    stopLossPremium: 2.0, peakPremium: 2.5, trailingActive: false, trailingStopPremium: 3.25,
    underlyingEntryPrice: 200, openedAt: MIDDAY, signalId: 's1',
    signalType: 'otm_mispricing', mode: 'live',
    ...over,
  } as OptionPosition);

  it('POSITIVE CONTROL — with no rule attached the reading is the TRA-3892 one, unchanged', () => {
    const p = summarizeDayOneStopPosture([rowAt({})], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY,
    });
    expect(p.stopBasis).toBe('full_premium');
    expect(p.otmDayOneStop).toBeNull();
    expect(p.rows).toBe(1);
    expect(p.premiumAtRiskUsd).toBeCloseTo(250, 2);
  });

  it('SUBJECT — an OTM row reads `premium_pct_or_atr` with BOTH thresholds on the wire', () => {
    const p = summarizeDayOneStopPosture([rowAt({ otmAtrInvalidationLevel: 195 })], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    expect(p.stopBasis).toBe(OTM_DAY_ONE_STOP_BASIS);
    expect(p.stopBasis).not.toBe('full_premium');
    expect(p.stopBasisBySleeve).toEqual({ otm_mispricing: OTM_DAY_ONE_STOP_BASIS });
    // The two thresholds AC2 names.
    expect(p.otmDayOneStop).toMatchObject({
      armed: true, premiumStopPct: 0.35, markFloorRatio: 0.65, atrMult: 1, source: 'default',
    });
    expect(p.otmDayOneStop!.release).toMatchObject({ released: true, reason: 'cash_account' });
    expect(p.otmDayOneStop!.atrLegRows).toBe(1);
    expect(p.otmDayOneStop!.atrLegInertRows).toBe(0);
  });

  it('SUBJECT — an UNSTAMPED row is counted as ATR-leg INERT, never silently included', () => {
    const p = summarizeDayOneStopPosture([rowAt({}), rowAt({ id: 'p2', otmAtrInvalidationLevel: 195 })], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    // Both rows are governed (the premium leg needs no stamp), but only one has
    // a level. Publishing the rule without this denominator is the `evaluated:0`
    // trap TRA-3926 paid for.
    expect(p.otmDayOneStop!.atrLegRows).toBe(1);
    expect(p.otmDayOneStop!.atrLegInertRows).toBe(1);
    expect(p.stopBasisBySleeve.otm_mispricing).toBe(OTM_DAY_ONE_STOP_BASIS);
  });

  it('SUBJECT — a mixed book reads `mixed` at the fleet level and the TRUTH per sleeve', () => {
    const p = summarizeDayOneStopPosture(
      [rowAt({ otmAtrInvalidationLevel: 195 }), rowAt({ id: 'p2', signalType: 'relative_value' })],
      { holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED },
    );
    // The fold cannot answer AC2's question once the book holds an RV row; the
    // per-sleeve map is what does.
    expect(p.stopBasis).toBe('mixed');
    expect(p.stopBasisBySleeve).toEqual({
      otm_mispricing: OTM_DAY_ONE_STOP_BASIS,
      relative_value: 'full_premium',
    });
  });

  it('a DISARMED rule reads `full_premium` — the basis tracks the rule, not the deploy', () => {
    const p = summarizeDayOneStopPosture([rowAt({ otmAtrInvalidationLevel: 195 })], {
      holdLiveOptionsOvernightForPdt: true,
      now: MIDDAY,
      otmDayOneStop: { rule: resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'off' }), release: CASH_RELEASE },
    });
    expect(p.stopBasis).toBe('full_premium');
    expect(p.otmDayOneStop).toMatchObject({ armed: false });
  });

  it('an EMPTY book reads `full_premium`, never the rule token — a dark book is blind, not passing', () => {
    const p = summarizeDayOneStopPosture([], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    expect(p.rows).toBe(0);
    expect(p.stopBasis).toBe('full_premium');
  });

  it('the fleet MERGE keeps the pessimistic fold and adds the row counters', () => {
    const otm = summarizeDayOneStopPosture([rowAt({ otmAtrInvalidationLevel: 195 })], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    const rv = summarizeDayOneStopPosture([rowAt({ id: 'p2', signalType: 'relative_value' })], {
      holdLiveOptionsOvernightForPdt: true, now: MIDDAY, otmDayOneStop: ARMED,
    });
    const merged = mergeDayOneStopPosture([otm, rv]);
    expect(merged.rows).toBe(2);
    expect(merged.stopBasis).toBe('mixed');
    expect(merged.stopBasisBySleeve.otm_mispricing).toBe(OTM_DAY_ONE_STOP_BASIS);
    expect(merged.stopBasisBySleeve.relative_value).toBe('full_premium');
    expect(merged.otmDayOneStop!.atrLegRows).toBe(1);
  });

  it('the BLIND twin nulls the new fields and keeps the SAFE basis literal', () => {
    const blind = blindDayOneStopPosture();
    expect(blind.stopBasisBySleeve).toBeNull();
    expect(blind.otmDayOneStop).toBeNull();
    // A blind instrument must not publish the token that says "this sleeve has
    // a day-one stop" — the same argument TRA-3892 made for the literal.
    expect(blind.stopBasis).toBe('full_premium');
  });

  it('the ACCOUNT read folds its own since-boot counters into the posture', () => {
    const { acct, tick } = liveOtmRow();
    expect(tick(0.64, 200)).toHaveLength(1);
    const p = acct.dayOneStopPosture(MIDDAY, ARMED);
    // TRA-4055 — `byMarkSource` is the additive split of the same fire. This
    // fixture never fans a provenance map (no `refreshOptionMarkSources`), so
    // the fire is `unknown`: undecidable, and counted as such rather than
    // defaulted into a bucket it was never observed in.
    expect(p.otmDayOneStop!.fires).toEqual({
      premiumPct: 1,
      atrInvalidation: 0,
      pdtHeld: 0,
      byMarkSource: { quote: 0, last: 0, delta_backstop: 0, unknown: 1 },
    });
    // `rows: 0` after the close — which is exactly why the cumulative twin has
    // to exist: the live row count says nothing about whether the rule fired.
    expect(p.rows).toBe(0);
  });
});

// ── 8. AC4 ──────────────────────────────────────────────────────────────────
describe('TRA-3943 AC4 — the real-money arm, the row size and the 2-row cap are untouched', () => {
  const SRC = readFileSync(join(HERE, 'otm-day-one-stop.ts'), 'utf8');

  it('the rule module reads nothing but its own three env keys', () => {
    const envReads = [...SRC.matchAll(/env\[([A-Z_]+|'[^']+')\]/g)].map((m) => m[1]);
    expect(new Set(envReads)).toEqual(new Set([
      'OTM_DAY_ONE_STOP_VALUE',
      'OTM_DAY_ONE_STOP_PREMIUM_PCT_VALUE',
      'OTM_DAY_ONE_STOP_ATR_MULT_VALUE',
    ]));
  });

  it('the rule module names no arm, no sizing and no row cap', () => {
    for (const forbidden of [
      'otmArmed',
      'isOptionLiveOtmArmed',
      'resolveLiveOptionTestNotionalCapUsd',
      'resolveLiveOptionTestMaxContracts',
      'resolveLiveOptionTestContracts',
      'resolveCanaryCeiling',
      'sizeContracts',
    ]) {
      expect(SRC, forbidden).not.toContain(forbidden);
    }
  });

  it('a fire does not move the account\'s sizing inputs', () => {
    const { acct, tick } = liveOtmRow();
    const before = acct.getState();
    const contracts = before.openOptions[0].contracts;
    expect(tick(0.64, 200)).toHaveLength(1);
    // The stop closes the row it fired on and touches nothing that authorises
    // the NEXT one.
    expect(acct.getState().openOptions).toHaveLength(0);
    expect(contracts).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 9. The DETECTOR, not the rule (`summarizeLiveStopActionability`).
//
// Found by re-grading this ticket on the CURRENT build (`2fa34b84`) rather than
// the one it was graded against — TRA-3927's own hook.
//
// `liveStopActionability.inert` is TRA-3822's decorative-stop number and the
// instrument TRA-3892 grades this sleeve's posture with. Its walk models the
// `continue` chain in `checkExits`; the TRA-3943 stop does NOT live in that
// chain, it lives ABOVE it and OUTRANKS two of its gates. So before this fix the
// detector reported `inert / daily_close_hold` (and on the entry day
// `inert / pdt_hold_today`) against a row `checkExits` was firing at the mark.
//
// That is worse than a cosmetic drift: on Monday's first live OTM loser the
// instrument built to catch decorative stops would have declared this remedy
// decorative. Each subject below is therefore paired with the SAME row under a
// context that omits `otmDayOneStop` — the pre-fix walk — so a green assertion
// cannot be the old behaviour wearing a new name.
// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-3943 — the actionability walk knows about the OTM intraday stop', () => {
  /** 11:00 ET: inside RTH, past the opening range, outside the close window. */
  const AT = MIDDAY;

  const BOOK: LiveStopActionabilityContext = {
    brokerMirroring: true,
    autoManageImportedTradierOptions: true,
    actOnAdoptedBrokerRows: true,
    // The gate this rule outranks. `true` is the shipped resolver default.
    holdLiveOptionsOvernightForPdt: true,
    swingHoldOptions: false,
    openingRangeGuardMin: 15,
    liveStopPolicy: DAILY_CLOSE,
    now: AT,
  };
  /** The pre-TRA-3943 walk: same book, rule detached. The control. */
  const PRE_FIX: LiveStopActionabilityContext = { ...BOOK };
  const WITH_RULE: LiveStopActionabilityContext = {
    ...BOOK,
    otmDayOneStop: { rule: RULE, release: CASH_RELEASE },
  };

  /**
   * A live `otm_mispricing` row at −36% of entry premium: through the −35% leg,
   * and (necessarily) also through its own −20% `stopLossPremium`, which is what
   * made the mis-attribution invisible — the walk SAW the breach, it just named
   * the wrong gate.
   */
  function otmRow(overrides: Partial<OptionPosition> = {}): OptionPosition {
    return {
      id: 'otm-d1',
      symbol: 'SOFI',
      optionSymbol: 'SOFI260918C00030000',
      optionType: 'call',
      strike: 30,
      expiration: '2026-09-18',
      contracts: 1,
      contractsRemaining: 1,
      premiumPaid: 1.0,
      currentPremium: 0.64,
      tp1Premium: 1.5,
      tp1Hit: false,
      stopLossPremium: 0.8,
      peakPremium: 1.0,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: 30,
      openedAt: D1_OPEN,
      signalId: 'otm-SOFI260918C00030000',
      signalType: 'otm_mispricing',
      mode: 'live',
      ...overrides,
    } as OptionPosition;
  }

  it('POSITIVE CONTROL — the pre-fix walk calls a firing day-one row inert', () => {
    const s = summarizeLiveStopActionability([otmRow()], PRE_FIX);
    expect(s.breached).toBe(1);
    expect(s.actionable).toBe(0);
    expect(s.inert).toBe(1);
    // On its ENTRY day the PDT gate is the first refusal the old walk reaches.
    expect(s.byReason).toEqual({ pdt_hold_today: 1 });
  });

  it('a day-one row through −35% on a CASH account is ACTIONABLE', () => {
    const s = summarizeLiveStopActionability([otmRow()], WITH_RULE);
    expect(s.actionable).toBe(1);
    expect(s.inert).toBe(0);
    expect(s.byReason).toEqual({});
    // The identity the summary's own docblock promises.
    expect(s.breached).toBe(s.actionable + s.inFlight + s.inert);
  });

  it('a DAY-TWO row through −35% outside the close window is ACTIONABLE, not daily_close_hold', () => {
    // Opened the previous UTC day, so the PDT gate cannot be the refusal and the
    // ONLY thing that could hold it is the TRA-3902 `daily_close` deferral.
    const row = otmRow({ id: 'otm-d2', openedAt: D1_OPEN - 24 * 3_600_000 });
    expect(summarizeLiveStopActionability([row], PRE_FIX).byReason)
      .toEqual({ daily_close_hold: 1 });
    const s = summarizeLiveStopActionability([row], WITH_RULE);
    expect(s.actionable).toBe(1);
    expect(s.inert).toBe(0);
  });

  it('the release fails CLOSED — an unreadable balance leaves the day-one row held', () => {
    const held = resolveOtmDayOneStopRelease(null);
    expect(held.released).toBe(false);
    const s = summarizeLiveStopActionability([otmRow()], {
      ...BOOK,
      otmDayOneStop: { rule: RULE, release: held },
    });
    expect(s.actionable).toBe(0);
    expect(s.byReason).toEqual({ pdt_hold_today: 1 });
  });

  it('the opening-range window still wins — the rule does not override it', () => {
    // A DAY-TWO row, so `pdt_hold_today` (which sits ABOVE the window in both
    // the walk and `checkExits`) cannot be the refusal and the window is
    // isolated. 09:40 ET, 10 minutes into the 15-minute guard.
    const row = otmRow({ id: 'otm-d2', openedAt: D1_OPEN - 24 * 3_600_000 });
    const s = summarizeLiveStopActionability([row], {
      ...WITH_RULE,
      now: D1_OPEN + 10 * 60_000,
    });
    expect(s.actionable).toBe(0);
    expect(s.byReason).toEqual({ opening_range_hold: 1 });
  });

  it('inside the window on DAY ONE the PDT gate is named, not the window', () => {
    // Not a widening — the walk has always ordered `pdt_hold_today` first, and
    // `checkExits` agrees (`:7129` `continue`s long before the opening-range SL
    // branch). Pinned so the new branch cannot be blamed for the ordering.
    const s = summarizeLiveStopActionability([otmRow()], {
      ...WITH_RULE,
      now: D1_OPEN + 10 * 60_000,
    });
    expect(s.byReason).toEqual({ pdt_hold_today: 1 });
  });

  it('a gate ABOVE the rule still refuses — the branch is placed, not prepended', () => {
    // `checkExits` `continue`s on the close-reject breaker long before `:7129`,
    // so the OTM stop never reaches its fire site on this row either.
    // TRA-4266 — pinned on the EXHAUSTED latch, which refuses on every instant.
    // A probing latch also `continue`s here, but only until its next retest, and
    // a clock-dependent fixture would grade the clock rather than the placement
    // of the branch.
    const s = summarizeLiveStopActionability(
      [otmRow({ closeRejectCount: 5, closeRejectProbeCount: 4 })],
      WITH_RULE,
    );
    expect(s.actionable).toBe(0);
    expect(s.byReason).toEqual({ close_reject_breaker_exhausted: 1 });
  });

  it('a row through −35% with NO armed premium stop is still counted as breached', () => {
    // `stopLossPremium: 0` is "no stop" (TRA-2957), so the old walk skipped the
    // row entirely — invisible rather than mis-attributed.
    const row = otmRow({ id: 'otm-nostop', stopLossPremium: 0 });
    expect(summarizeLiveStopActionability([row], PRE_FIX).breached).toBe(0);
    const s = summarizeLiveStopActionability([row], WITH_RULE);
    expect(s.breached).toBe(1);
    expect(s.actionable).toBe(1);
  });

  it('NEGATIVE — a row above the −35% floor is untouched by the new branch', () => {
    // −30%: through the −20% stop, NOT through this rule. It must keep reading
    // as held by the daily-close policy, or the detector has over-matched.
    const row = otmRow({ id: 'otm-30', currentPremium: 0.70, openedAt: D1_OPEN - 24 * 3_600_000 });
    const s = summarizeLiveStopActionability([row], WITH_RULE);
    expect(s.actionable).toBe(0);
    expect(s.byReason).toEqual({ daily_close_hold: 1 });
  });

  it('NEGATIVE — an RV row on the same book is byte-identical with and without the rule', () => {
    const rv = otmRow({
      id: 'rv-1',
      signalType: 'relative_value',
      openedAt: D1_OPEN - 24 * 3_600_000,
    });
    expect(summarizeLiveStopActionability([rv], WITH_RULE))
      .toEqual(summarizeLiveStopActionability([rv], PRE_FIX));
  });

  it('NEGATIVE — a DISARMED rule leaves the walk exactly where it was', () => {
    const rows = [otmRow(), otmRow({ id: 'otm-d2', openedAt: D1_OPEN - 24 * 3_600_000 })];
    const disarmed = resolveOtmDayOneStopRule({ [OTM_DAY_ONE_STOP_VALUE]: 'off' });
    expect(disarmed.armed).toBe(false);
    expect(summarizeLiveStopActionability(rows, {
      ...BOOK,
      otmDayOneStop: { rule: disarmed, release: CASH_RELEASE },
    })).toEqual(summarizeLiveStopActionability(rows, PRE_FIX));
  });

  it('the ATR leg cannot fire in this walk, and that direction is PESSIMISTIC', () => {
    // The walk has no underlying price. A row whose spot is through the level
    // but whose mark is not through −35% therefore still reads `inert` — the
    // disclosed limitation, asserted so a future reader cannot mistake it for a
    // claim that the ATR leg is covered here.
    const row = otmRow({
      id: 'otm-atr',
      // −25%: through the −20% `stopLossPremium` so the walk DOES reach the gate
      // chain, but above the −35% floor so only the ATR leg could rescue it.
      currentPremium: 0.75,
      otmAtrInvalidationLevel: 29,   // a call: spot <= 29 invalidates
      openedAt: D1_OPEN - 24 * 3_600_000,
    } as Partial<OptionPosition>);
    const s = summarizeLiveStopActionability([row], WITH_RULE);
    expect(s.actionable).toBe(0);
    expect(s.byReason).toEqual({ daily_close_hold: 1 });
  });
});
