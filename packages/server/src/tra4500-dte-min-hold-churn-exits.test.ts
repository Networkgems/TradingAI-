import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PaperOptionsAccount, type OptionTradeJournalSetup } from './options-account.js';
import type { RelativeValueSignal } from '@trading-app/shared';
import type { ExitState } from '@trading-app/engine';

// TRA-4500 (parent TRA-4290/TRA-4230) — the two desk churn exits through the
// account's own exit cascade:
//
//   D2 — `ma20_close_through` is scoped OUT of `single_leg_rv` entirely (a
//        20-period intraday close-through rule on a ~34-DTE option is a
//        timeframe error). `single_leg_directional` keeps the exit.
//   D1 — `time_stop` and `ma20_close_through` wait out a DTE-proportional
//        minimum hold, `max(1, 0.10 × entryDte)` trading sessions, on rows
//        with entryDte ≥ 21.
//
// Hard safety constraint (verbatim from the issue): the stop family must
// remain able to fire from the first tick — proven below by the hard SL
// closing a day-zero row whose churn exits are all held.

// Tuesday 2024-06-04 10:00 ET, inside the ET trading window; the 2024-07-05
// expiration is 31 DTE at entry ⇒ minHold = max(1, 0.10 × 31) = 3.1 sessions.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
// Tuesday 2024-06-11: 5 trading sessions held (Wed 5th … Tue 11th) ≥ 3.1.
const AFTER_MIN_HOLD = Date.parse('2024-06-11T14:00:00Z');

const baseSetup: OptionTradeJournalSetup = {
  ivRank: 30,
  trend: 'up',
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg',
};

function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-4500',
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

/** A confirmed MA20 close-through against a long call, everything else quiet. */
function ma20ThroughState(entryPremium: number): ExitState {
  return {
    side: 'buy',
    supertrendDirection: 'green', // no flip — isolates the ma20 branch
    underlyingClose: 398,
    ma20: 400, // close < ma20 against a long ⇒ through
    entryPremium,
    currentPremium: entryPremium, // flat premium: no premium stop / take-profit
    barsHeld: 3,
    hadFollowThrough: true, // no time stop
  };
}

/** A stalled position past the 5-bar time stop, trend still with it. */
function stalledState(entryPremium: number): ExitState {
  return {
    side: 'buy',
    supertrendDirection: 'green',
    underlyingClose: 405,
    ma20: 400, // above ma20 — ma20 branch quiet
    entryPremium,
    currentPremium: entryPremium,
    barsHeld: 9,
    hadFollowThrough: false,
  };
}

function openRow(
  acct: PaperOptionsAccount,
  structureLabel?: string,
  overrides: Partial<RelativeValueSignal> = {},
) {
  const pos = acct.openOptionFromRvCandidate(
    buildRvSignal(overrides),
    'demo',
    undefined,
    undefined,
    structureLabel !== undefined ? { ...baseSetup, structureLabel } : baseSetup,
  );
  expect(pos).not.toBeNull();
  return pos!;
}

function runExits(acct: PaperOptionsAccount, posId: string, state: ExitState, mark: number, optionSymbol: string | undefined) {
  const structuralExitStates = new Map<string, ExitState>([[posId, state]]);
  const optionMarks = new Map<string, number>([[optionSymbol ?? '', mark]]);
  return acct.checkExits(new Map([['MSFT', state.underlyingClose]]), optionMarks, 'demo', {}, structuralExitStates);
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4500 D2 — ma20_close_through scoped out of single_leg_rv', () => {
  it('stamps the journal structure label onto the position at open', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const rv = openRow(acct); // no structureLabel ⇒ the reserved RV default
    expect(rv.journalStructure).toBe('single_leg_rv');
    const acct2 = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const dir = openRow(acct2, 'single_leg_directional');
    expect(dir.journalStructure).toBe('single_leg_directional');
  });

  it('never closes a single_leg_rv row on ma20_close_through, even after the DTE hold has elapsed', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openRow(acct);
    vi.setSystemTime(AFTER_MIN_HOLD); // 5 sessions held ≥ 3.1 — only D2 can hold it now
    const closed = runExits(acct, pos.id, ma20ThroughState(pos.premiumPaid), pos.premiumPaid, pos.optionSymbol);
    expect(closed).toHaveLength(0);
  });

  it('control: the identical state on a single_leg_directional row still exits on ma20_close_through', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openRow(acct, 'single_leg_directional');
    vi.setSystemTime(AFTER_MIN_HOLD);
    const closed = runExits(acct, pos.id, ma20ThroughState(pos.premiumPaid), pos.premiumPaid, pos.optionSymbol);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('ma20_close_through');
  });
});

describe('TRA-4500 D1 — DTE-proportional minimum hold (entryDte 31 ⇒ 3.1 sessions)', () => {
  it('holds a directional ma20_close_through inside the minimum hold (day zero)', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openRow(acct, 'single_leg_directional');
    const closed = runExits(acct, pos.id, ma20ThroughState(pos.premiumPaid), pos.premiumPaid, pos.optionSymbol);
    expect(closed).toHaveLength(0);
  });

  it('holds the bar-count time_stop inside the minimum hold, then releases it', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openRow(acct); // single_leg_rv — D2 does not touch time_stop
    const held = runExits(acct, pos.id, stalledState(pos.premiumPaid), pos.premiumPaid, pos.optionSymbol);
    expect(held).toHaveLength(0);
    vi.setSystemTime(AFTER_MIN_HOLD);
    const closed = runExits(acct, pos.id, stalledState(pos.premiumPaid), pos.premiumPaid, pos.optionSymbol);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('time_stop');
  });
});

describe('TRA-4500 hard safety constraint — the stop family fires from the first tick', () => {
  it('the hard SL closes a day-zero single_leg_rv row while both churn exits are held', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openRow(acct);
    // Same session, two hours after the open window; mark deep through the
    // stop. The churn exits are all suppressed (D2 + day-zero D1), so the only
    // thing that can close this row is the stop family — and it must.
    vi.setSystemTime(TRADING_TIME + 2 * 60 * 60 * 1000);
    const state: ExitState = { ...ma20ThroughState(pos.premiumPaid), currentPremium: 0.4 };
    const closed = runExits(acct, pos.id, state, 0.4, pos.optionSymbol);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('sl');
  });
});
