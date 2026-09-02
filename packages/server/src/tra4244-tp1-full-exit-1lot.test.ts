// TRA-4244 (b)/(c) (parent TRA-4238) — TP1 on a 1-LOT row.
//
// The defect measured on the parent: `contractsRemaining > 1` gates the TP1
// partial, and `floor(n × 0.4)` would size the slice at 0 for n ≤ 2 anyway.
// Every row the live OTM sleeve has opened is a 1-lot, so TP1 is not a rule
// that rarely fires on that book — it is DEAD, at any threshold. That is why
// re-cutting `OTM_TP1_PCT_OVERRIDE` to the fitted 0.12 would have changed
// nothing on its own, and it is what this branch fixes.
//
// Geometry (the TRA-4020 fixture): open at 1.00, −20% stop ⇒ R = 0.20.
//   compiled TP1 +50% ⇒ 1.50 · fitted TP1 +12% ⇒ 1.12
// The premium trail activates at +30% (1.30) with a 20% offset, so at 1.50 the
// trail sits at 1.20 and does not fire on the same tick; at 1.12 it is dormant.
//
// The FLAG-OFF branch of every scenario is asserted alongside the flag-on one,
// so "off is today's behaviour" is a measurement here, not a sentence.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import { listOptionTradeJournal, setOptionTradeJournalFileForTests } from './option-trade-journal.js';
import { resolveOtmProfitSchedule } from './otm-profit-schedule.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const MIN = 60_000;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4244',
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

const JOURNAL_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

/** No ATR ⇒ the chandelier is inert; the window is on. TP1 is the rule under test. */
const RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };

interface Fixture {
  contracts?: number;
  tp1FullExit1Lot?: boolean;
  env?: NodeJS.ProcessEnv;
  mode?: 'live' | 'demo';
}

function account({ contracts = 1, tp1FullExit1Lot = false, env, mode = 'demo' }: Fixture = {}) {
  vi.setSystemTime(TRADING_TIME);
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    tp1FullExit1Lot,
    ...(env !== undefined ? { otmProfitSchedule: resolveOtmProfitSchedule(env) } : {}),
  });
  // `boundedLiveContracts` opens EXACTLY this many contracts, which is how the
  // live sleeve's 1-lot is reproduced without reverse-engineering the sizer.
  const pos = acct.openOptionFromCandidate(
    buildSignal(), mode, 50_000, undefined, JOURNAL_SETUP, contracts,
  );
  expect(pos).not.toBeNull();
  expect(pos!.contractsRemaining).toBe(contracts);
  expect(pos!.premiumPaid).toBe(1.0);
  expect(pos!.stopLossPremium).toBeCloseTo(0.80, 9); // R = 0.20
  const id = pos!.id;
  const sym = pos!.optionSymbol!;
  const tick = (mark: number, options: Parameters<PaperOptionsAccount['checkExits']>[3] = {}) =>
    acct.checkExits(new Map([['AAPL', 200]]), new Map([[sym, mark]]), mode, options, undefined, RISK);
  const row = () => acct.getState().openOptions[0];
  return { acct, tick, row, id, tp1Premium: pos!.tp1Premium };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-4244 (b) — the 1-lot row', () => {
  it('FLAG OFF: a 1-lot row through TP1 is untouched — no exit, no partial, no tp1Hit (today’s behaviour)', () => {
    const { tick, row } = account({ tp1FullExit1Lot: false });
    expect(tick(1.50)).toHaveLength(0);
    expect(row().contractsRemaining).toBe(1);
    expect(row().tp1Hit).toBeFalsy();
    // …and stays untouched on a mark far above the target, which is the point:
    // the rule is dead, not merely late.
    expect(tick(2.00)).toHaveLength(0);
    expect(row().contractsRemaining).toBe(1);
  });

  it('FLAG ON: the row exits in FULL at TP1, is retired from the book, and journals `tp1`', () => {
    const { acct, tick } = account({ tp1FullExit1Lot: true });
    const closed = tick(1.50);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('tp1');
    expect(closed[0]!.contractsRemaining).toBe(0);
    expect(closed[0]!.tp1Hit).toBe(true);
    expect(closed[0]!.closedAt).toBe(TRADING_TIME);
    // ⭐ Retired, not left open with 0 contracts — a row nothing can ever close.
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('FLAG ON: it does not fire BELOW the target, and the row keeps running its other rules', () => {
    const { tick, row } = account({ tp1FullExit1Lot: true });
    expect(tick(1.49)).toHaveLength(0);
    expect(row().contractsRemaining).toBe(1);
    // The hard stop still owns the loss side on the same row.
    const closed = tick(0.79);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).not.toBe('tp1');
  });

  it('FLAG ON: a 2+ lot row is UNTOUCHED — it still takes the partial and keeps the remainder', () => {
    const { acct, tick, row } = account({ contracts: 5, tp1FullExit1Lot: true });
    expect(tick(1.50)).toHaveLength(0); // a partial is not a close
    expect(row().contractsRemaining).toBe(3); // floor(5 × 0.4) = 2 sold
    expect(row().tp1Hit).toBe(true);
    expect(row().trailingActive).toBe(true);
    expect(acct.getState().openOptions).toHaveLength(1);
  });

  it('composes with (a): the fitted TP1 override moves the target to +12% and the 1-lot exits there', () => {
    const { acct, tick, tp1Premium } = account({
      tp1FullExit1Lot: true,
      env: { OTM_TP1_PCT_OVERRIDE: '0.12' },
    });
    expect(tp1Premium).toBeCloseTo(1.12, 9);
    const closed = tick(1.12);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('tp1');
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('a REJECTED override cannot move the target — the whole set fails closed to +50%', () => {
    const { tp1Premium, tick, row } = account({
      tp1FullExit1Lot: true,
      // TP1 is valid; the give-back violates TRA-4006 ⇒ the SET is discarded.
      env: { OTM_TP1_PCT_OVERRIDE: '0.12', PROFIT_LOCK_GIVEBACK_R_OVERRIDE: '0.90' },
    });
    expect(tp1Premium).toBeCloseTo(1.50, 9);
    expect(tick(1.12)).toHaveLength(0);
    expect(row().contractsRemaining).toBe(1);
  });
});

describe('TRA-4244 (b) — the live staging path and the stale-limit lifecycle', () => {
  it('FLAG ON, waitAndHold: stages the WHOLE lot at tp1Premium as kind `tp1`, and the fill closes the row', () => {
    const { acct, tick, row, id } = account({ mode: 'live', tp1FullExit1Lot: true });
    const staged = tick(1.50, { waitAndHold: true });
    expect(staged).toHaveLength(1);
    expect(row().pendingExit).toMatchObject({
      qty: 1,
      limitPrice: 1.50,
      kind: 'tp1',
      pricing: 'limit',
      journalReason: 'tp1',
      tradierOrderId: '',
    });
    // The row is still OPEN until the broker fills — it is a staged intent.
    expect(acct.getState().openOptions).toHaveLength(1);
    expect(row().contractsRemaining).toBe(1);

    // `finalizePendingExit` already routes a `tp1` fill that sold the last
    // contracts to its full-close branch (`kind === 'tp1' && remaining > 0` is
    // the PARTIAL branch), so the live half needed no new lifecycle.
    const done = acct.finalizePendingExit(id, 1.50);
    expect(done).not.toBeNull();
    expect(done!.exitReason).toBe('tp1');
    expect(done!.contractsRemaining).toBe(0);
    expect(acct.getState().openOptions).toHaveLength(0);
  });

  it('an UNFILLED tp1 limit ages out through the TRA-2956 withdrawal, which is kind-agnostic', () => {
    // The failure this closes: a TP1 limit sits ABOVE the market, so a reversal
    // moves it FURTHER out of the money while `pendingExit` detaches EVERY exit
    // rule on the row (`if (opt.pendingExit) continue`). Nothing about that
    // machinery is scoped to a partial — but a full-lot `tp1` is a new caller of
    // it, so the selection is measured rather than assumed.
    const { acct, tick, row, id } = account({ mode: 'live', tp1FullExit1Lot: true });
    tick(1.50, { waitAndHold: true });
    // A staged intent with NO order id belongs to TRA-2819's reap, not this
    // selector — they are deliberately disjoint.
    expect(acct.listStaleWorkingExits(TRADING_TIME + 60 * MIN)).toHaveLength(0);

    // The engine submits and attaches the broker id.
    expect(acct.attachPendingExit(id, 'ord-4244')).toBe(true);
    // Inside WORKING_EXIT_MAX_AGE_MS (15 min) nothing is withdrawn.
    expect(acct.listStaleWorkingExits(TRADING_TIME + 14 * MIN)).toHaveLength(0);
    // Past it, the full-lot tp1 is selected for withdrawal and re-decision.
    const stale = acct.listStaleWorkingExits(TRADING_TIME + 15 * MIN);
    expect(stale).toHaveLength(1);
    expect(stale[0]).toMatchObject({ id, kind: 'tp1', qty: 1, tradierOrderId: 'ord-4244' });

    // And the withdrawal returns the row to rule management: with the latch
    // cleared the stop is live again on the very next tick.
    acct.clearPendingExit(id);
    expect(row().pendingExit).toBeUndefined();
    const closed = tick(0.70, { waitAndHold: false });
    expect(closed).toHaveLength(1);
    expect(closed[0]!.contractsRemaining).toBe(0);
  });
});

describe('TRA-4244 (c) — the journal row', () => {
  let tmpFile: string;
  let fileCounter = 0;

  beforeEach(() => {
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    tmpFile = join(tmpdir(), `tra4244-journal-${process.pid}-${fileCounter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  it('the 1-lot full exit writes a CLOSE row reasoned `tp1`, not a partial', async () => {
    const { acct, tick } = account({ tp1FullExit1Lot: true });
    await acct.flushOptionTradeJournal();
    expect(tick(1.50)).toHaveLength(1);
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    const closes = rows.filter((r) => r.outcome !== 'OPEN');
    expect(closes).toHaveLength(1);
    expect(closes[0]!.exitReason).toBe('tp1');
  });
});
