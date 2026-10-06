// TRA-5162 — `profitLockFire` stamps fired but `execBidAtFire` was null on
// 19/19 journal-wide `profit_lock` forensics rows, and a bare null is
// indistinguishable from "never attempted". Parent TRA-4249's AC2/AC3 grade
// the release on the FILL basis, and the first live `profit_lock` close is a
// single unrepeatable row — so the instrument must be provably populated
// BEFORE that row lands, and every null must carry its cause.
//
// What is asserted, on the ETHA shape TRA-4249 AC2 specifies (peak ≥ arm,
// decay back toward entry, wide spread):
//   AC3  a quoted give-back fire, broker-fill restated, serves a NON-NULL,
//        FINITE `fillVsLevelR` on `releaseForensics` — end to end through the
//        engine stamp, the journal fold, the TRA-2819 restatement and the
//        route read. This is the assertion the existing floor tests lacked:
//        they asserted the floor, never that the instrument reading it is
//        populated.
//   AC2  every null travels with a reason code:
//        - a dark-tick fire stamps `no_usable_quote_at_fire`;
//        - a served-but-zero bid stamps `bid_zero_at_fire`;
//        - the `book_halt_flat` relabel stamps `halt_flat_no_exit_tick`;
//        - a pre-TRA-5162 stamped null reads `stamp_predates_reason_codes`;
//        - an unrestated row reads `exitFillUnmeasuredReason:
//          'not_broker_fill_restated'` instead of a bare null fill.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import {
  listOptionTradeJournal,
  recordOptionTradeCloseBasis,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { buildOptionJournalReport } from './observability/health-routes.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const MIN = 60_000;

// ETHA geometry, verbatim from `tra4285-profit-lock-executable-basis.test.ts`:
// broker-fill entry 1.28 → stopLossPremium 1.024 (−20% OTM stop) → R = 0.256.
const ENTRY = 1.28;
const R_UNIT = 0.256;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-5162',
    symbol: 'ETHA',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: ENTRY,
    stopLoss: 0.96,
    takeProfit: 1.92,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: 'ETHA241002C00019000',
    optionType: 'call',
    strike: 19,
    expiration: '2024-10-02',
    mark: ENTRY,
    theo: 1.66,
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

// No ATR ⇒ the chandelier is inert; no ladder ⇒ the scalar 0.75/0.40 rule.
const RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };

let tmpFile: string;

function liveAccount() {
  vi.setSystemTime(TRADING_TIME);
  const acct = new PaperOptionsAccount({
    initialEquity: 50_000,
    managedAccountRatio: 0.5,
    holdLiveOptionsOvernightForPdt: false,
  });
  const pos = acct.openOptionFromCandidate(buildSignal(), 'live', 50_000, undefined, JOURNAL_SETUP);
  expect(pos).not.toBeNull();
  const sym = pos!.optionSymbol!;
  const tick = (quote: { bid: number; ask: number } | null, midOverride?: number) => {
    acct.refreshOptionQuotes(quote ? new Map([[sym, quote]]) : new Map());
    const mid = midOverride ?? (quote ? (quote.bid + quote.ask) / 2 : ENTRY);
    return acct.checkExits(
      new Map([['ETHA', 19]]),
      new Map([[sym, mid]]),
      'live',
      { waitAndHold: true },
      undefined,
      RISK,
    );
  };
  const row = () => acct.getState().openOptions[0];
  return { acct, tick, row, id: pos!.id };
}

/** The desk/live `single_leg_otm` × `profit_lock` cell, wherever the class fold put it. */
function profitLockForensics(rows: OptionTradeJournalRecord[]) {
  const report = buildOptionJournalReport(rows, TRADING_TIME + 60 * MIN, true);
  const classes = Object.values(
    report.summary.byAccountClass as Record<
      string,
      { byStructureExit: { cells: Array<{ structure: string; exitReason: string; releaseForensics: unknown[] }> } }
    >,
  );
  for (const cls of classes) {
    const cell = cls.byStructureExit.cells.find(
      (c) => c.structure === 'single_leg_otm' && c.exitReason === 'profit_lock',
    );
    if (cell && cell.releaseForensics.length > 0) return cell.releaseForensics as Array<Record<string, unknown>>;
  }
  throw new Error('no profit_lock cell with forensics found');
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  tmpFile = join(tmpdir(), `tra5162-journal-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-5162 AC3 — the fill-basis instrument is POPULATED on the ETHA shape, end to end', () => {
  it('a quoted fire + broker-fill restatement serves a non-null, finite fillVsLevelR on releaseForensics', async () => {
    const { acct, tick, row, id } = liveAccount();

    // Arm on the executable basis: bid 1.48 ≥ ENTRY + 0.75R = 1.472.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);

    // Decay to the release: bid 1.37 ≤ 1.48 − 0.40R = 1.3776 ⇒ the lock fires.
    vi.setSystemTime(TRADING_TIME + 3 * MIN);
    const staged = tick({ bid: 1.37, ask: 1.47 });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');

    // A measured bid carries NO reason code — the reason rides only beside a null.
    const fire = row().profitLockFire!;
    expect(fire.execBidAtFire).toBe(1.37);
    expect(fire.execBidUnquotedReason).toBeUndefined();

    expect(acct.finalizePendingExit(id, 1.37)).not.toBeNull();
    await acct.flushOptionTradeJournal();
    const [rec] = await listOptionTradeJournal();
    expect(rec).toBeDefined();

    // The REAL TRA-2819 restatement, not a hand-spread fixture: the stamp must
    // survive the fold that writes `pnlBasis: 'broker-fill'`.
    const contracts = rec!.contracts as number;
    const feesUsd = 1.4;
    const realizedPnlUsd = (1.37 - ENTRY) * contracts * 100 - feesUsd;
    const atRisk = rec!.atRiskUsd as number;
    expect(
      await recordOptionTradeCloseBasis(rec!.id, {
        outcome: realizedPnlUsd >= 0 ? 'WIN' : 'LOSS',
        realizedPnlUsd,
        realizedR: realizedPnlUsd / atRisk,
        feesUsd,
        entryFillPremium: ENTRY,
        exitFillPremium: 1.37,
      }, TRADING_TIME + 4 * MIN),
    ).toBe(true);

    const rows = await listOptionTradeJournal();
    expect(rows[0]!.pnlBasis).toBe('broker-fill');
    expect(rows[0]!.profitLockFire).toBeDefined(); // the stamp survives the restatement

    const [f] = profitLockForensics(rows);
    // THE AC3 ASSERTION: the instrument TRA-4249 reads is populated and finite.
    expect(f!['fillVsLevelR']).not.toBeNull();
    expect(Number.isFinite(f!['fillVsLevelR'])).toBe(true);
    expect(f!['fillVsLevelR']).toBeCloseTo((1.37 - (fire.levelPremium as number)) / R_UNIT, 9);
    expect(f!['fillVsLevelPremium']).toBeCloseTo(1.37 - (fire.levelPremium as number), 9);
    expect(f!['execBidAtFire']).toBe(1.37);
    expect(f!['exitFillPremium']).toBe(1.37);
    // Measured columns carry NO reason codes.
    expect(f!['execBidUnquotedReason']).toBeNull();
    expect(f!['exitFillUnmeasuredReason']).toBeNull();
  });
});

describe('TRA-5162 AC2 — every null instrument column travels with its cause', () => {
  it('a dark-tick fire stamps no_usable_quote_at_fire and the unrestated row names its missing fill', async () => {
    const { acct, tick, row, id } = liveAccount();

    // Quoted run-up arms (mid peak 1.53); then the feed goes dark and the row
    // is marked at ENTRY — the NOK261016C00011000 shape (TRA-5162 AC1(a)).
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    vi.setSystemTime(TRADING_TIME + 2 * MIN);
    const staged = tick(null);
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');

    const fire = row().profitLockFire!;
    expect(fire.execBidAtFire).toBeNull();
    expect(fire.execBidUnquotedReason).toBe('no_usable_quote_at_fire');

    expect(acct.finalizePendingExit(id, 1.3)).not.toBeNull();
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    // The reason reaches the journal row verbatim…
    expect(rows[0]!.profitLockFire!.execBidUnquotedReason).toBe('no_usable_quote_at_fire');

    // …and the route serves it, plus the fill column's own reason: this row
    // was never broker-fill restated, so its fill is UNMEASURED, not dropped.
    const [f] = profitLockForensics(rows);
    expect(f!['execBidAtFire']).toBeNull();
    expect(f!['execBidUnquotedReason']).toBe('no_usable_quote_at_fire');
    expect(f!['exitFillPremium']).toBeNull();
    expect(f!['exitFillUnmeasuredReason']).toBe('not_broker_fill_restated');
    expect(f!['fillVsLevelR']).toBeNull();
  });

  it('a served-but-zero bid stamps bid_zero_at_fire — a 0 bid is a real, unsellable book', () => {
    const { tick, row } = liveAccount();

    // Arm on the quoted tick (exec peak 1.48); then the book collapses to
    // bid 0 / ask 2.60 — `liveQuoteFor` serves it (two-sided, uncrossed) but
    // the basis must not rest on a bid of 0. Mid 1.30 ≤ the MID-basis level
    // (peak 1.53 − 0.40R = 1.4276) ⇒ the lock fires on the fallback basis.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    vi.setSystemTime(TRADING_TIME + 2 * MIN);
    const staged = tick({ bid: 0, ask: 2.6 });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');

    const fire = row().profitLockFire!;
    expect(fire.execBidAtFire).toBeNull();
    expect(fire.execBidUnquotedReason).toBe('bid_zero_at_fire');
  });

  it('the book_halt_flat relabel stamps halt_flat_no_exit_tick — that path evaluates no exit tick', async () => {
    const { acct, tick, row, id } = liveAccount();

    // Ratchet the mid peak to 1.53 without firing (bid 1.48 > exec level
    // 1.3776), then flatten at 1.40 ≤ the mid-basis level 1.4276: the halt
    // close relabels to profit_lock (TRA-4335) and stamps the null's cause.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    expect(row().profitLockFire).toBeUndefined();

    vi.setSystemTime(TRADING_TIME + 2 * MIN);
    const closed = acct.closeOption(id, 1.4, 'book_halt_flat');
    expect(closed).not.toBeNull();
    expect(closed!.exitReason).toBe('profit_lock');
    expect(closed!.profitLockFire!.execBidAtFire).toBeNull();
    expect(closed!.profitLockFire!.execBidUnquotedReason).toBe('halt_flat_no_exit_tick');

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows[0]!.profitLockFire!.execBidUnquotedReason).toBe('halt_flat_no_exit_tick');
  });

  it('a pre-TRA-5162 stamped null reads stamp_predates_reason_codes on the route — never a bare null', () => {
    // Hand-rolled row: the exact NOK261016C00011000 stamp as it exists on the
    // 2026-09-11 tape — `execBidAtFire: null` with NO reason field.
    const nok = {
      id: 'row-nok-5162',
      symbol: 'NOK',
      optionSymbol: 'NOK261016C00011000',
      mode: 'live',
      account: 'desk',
      structure: 'single_leg_otm',
      contracts: 2,
      openTs: TRADING_TIME,
      outcome: 'WIN',
      closeTs: TRADING_TIME + 5 * MIN,
      realizedPnlUsd: 22.47,
      realizedR: 0.165,
      exitReason: 'profit_lock',
      holdDays: 0.05,
      atRiskUsd: 136,
      profitLockFire: {
        at: TRADING_TIME + 5 * MIN,
        levelR: 0.4224299065420557,
        levelPremium: 0.7636666666666666,
        markAtFire: 0.7632554912740327,
        execBidAtFire: null,
        armed: true,
        peakPremiumAtFire: 0.835,
        peakR: 0.8224299065420557,
        giveBackR: 0.4,
        stopBasisPremium: 0.17833333333333334,
      },
    } as unknown as OptionTradeJournalRecord;

    const [f] = profitLockForensics([nok]);
    expect(f!['stamped']).toBe(true);
    expect(f!['execBidAtFire']).toBeNull();
    expect(f!['execBidUnquotedReason']).toBe('stamp_predates_reason_codes');
    expect(f!['exitFillUnmeasuredReason']).toBe('not_broker_fill_restated');
  });
});
