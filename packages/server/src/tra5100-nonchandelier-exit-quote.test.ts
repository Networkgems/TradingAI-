// TRA-5100 (parent TRA-5098) — price the crossed/cost arm on NON-chandelier
// exits.
//
// Measured 2026-10-04 (live `b2dca7c1`): in the desk demo directional cell,
// crossed pricing covered 16/19 chandelier closes and 0/8 non-chandelier ones
// (`ma20_close_through` / `time_stop` / `profit_lock`, all
// `exit_quote_missing`) — coverage 100% confounded with `exitReason`. Cause:
// the structural-exit branch and the TP1 full exit close INLINE and `continue`
// before the SL/trail funnel's `stampExitMarkProvenance` call, so they fired
// on the per-tick mark and then DISCARDED its provenance; their rows never
// carried `markProvenance.quoteAtFire` and (pre-TRA-4997) nothing else either.
//
// The fix under test here:
//   1. the structural branch (`supertrend_flip` / `ma20_close_through` /
//      `time_stop`) stamps the same per-tick provenance the funnel stamps;
//   2. the TP1 FULL exit does too — and the TP1 PARTIAL deliberately does NOT
//      (first-write-wins would freeze the TP1 tick's book onto whatever close
//      ends the row later);
//   3. `foldOptionSleeveCells` publishes `strategyCrossedByExitClass`, the
//      chandelier vs non-chandelier crossed-coverage split the TRA-5098
//      prereg's rule 5 reads (cost arm → co-primary at coverage ≥ 0.80).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount, type OptionTradeJournalSetup } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  foldOptionSleeveCells,
  isChandelierExitReason,
} from './option-journal-sleeve-cells.js';
import type { RelativeValueSignal, OtmMispricingSignal } from '@trading-app/shared';
import type { ExitState } from '@trading-app/engine';

// Tuesday 2024-06-04 10:00 ET; the 2024-07-05 expiration is 31 DTE at entry ⇒
// the TRA-4500 churn-exit minimum hold is 3.1 trading sessions.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
// Tuesday 2024-06-11: 5 trading sessions held ≥ 3.1 — churn exits released.
const AFTER_MIN_HOLD = Date.parse('2024-06-11T14:00:00Z');

// A two-sided book straddling the flat mark the exit states use.
const QUOTE = { bid: 0.98, ask: 1.02 };

const tmpFile = join(tmpdir(), `tra5100-journal-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);

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
    id: 'rv-5100',
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
    supertrendDirection: 'green',
    underlyingClose: 398,
    ma20: 400,
    entryPremium,
    currentPremium: entryPremium,
    barsHeld: 3,
    hadFollowThrough: true,
  };
}

/** A stalled position past the 5-bar time stop, trend still with it. */
function stalledState(entryPremium: number): ExitState {
  return {
    side: 'buy',
    supertrendDirection: 'green',
    underlyingClose: 405,
    ma20: 400,
    entryPremium,
    currentPremium: entryPremium,
    barsHeld: 9,
    hadFollowThrough: false,
  };
}

function openDirectionalRow(acct: PaperOptionsAccount) {
  const pos = acct.openOptionFromRvCandidate(
    buildRvSignal(),
    'demo',
    undefined,
    undefined,
    { ...baseSetup, structureLabel: 'single_leg_directional' },
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
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = 'true';
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-5100 — structural exits capture the fire-tick book', () => {
  it('ma20_close_through stamps the per-tick provenance, and the journal row carries BOTH the quote and a fire_tick exitQuote', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openDirectionalRow(acct);
    const sym = pos.optionSymbol!;

    vi.setSystemTime(AFTER_MIN_HOLD);
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    const closed = runExits(acct, pos.id, ma20ThroughState(pos.premiumPaid), 1.0, sym);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('ma20_close_through');

    // The fix: the branch used to `continue` before the funnel's stamp, so
    // this field was undefined on every structural close.
    expect(closed[0]!.exitMarkProvenance).toBeDefined();
    expect(closed[0]!.exitMarkProvenance!.quoteAtFire).toEqual(QUOTE);

    // …and the surface the crossed re-pricing actually reads: the close row.
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    const row = rows.find((r) => r.outcome !== 'OPEN')!;
    expect(row).toBeDefined();
    expect(row.exitReason).toBe('ma20_close_through');
    expect(row.markProvenance?.quoteAtFire).toEqual(QUOTE);
    expect(row.exitQuote).toMatchObject({ bid: QUOTE.bid, ask: QUOTE.ask, source: 'fire_tick' });
  });

  it('time_stop stamps the same way', () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openDirectionalRow(acct);
    const sym = pos.optionSymbol!;

    vi.setSystemTime(AFTER_MIN_HOLD);
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    const closed = runExits(acct, pos.id, stalledState(pos.premiumPaid), 1.0, sym);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('time_stop');
    expect(closed[0]!.exitMarkProvenance!.quoteAtFire).toEqual(QUOTE);
  });

  it('with a DARK fan at the fire, the row still prices via the TRA-4997 last_known fallback — attributed, never laundered as fresh', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = openDirectionalRow(acct);
    const sym = pos.optionSymbol!;

    vi.setSystemTime(AFTER_MIN_HOLD);
    // A pass served the book, then the NEXT pass went dark: `liveQuoteFor`
    // reads the (now empty) fan, `lastUsableQuote` survives on the position.
    acct.refreshOptionQuotes(new Map([[sym, QUOTE]]));
    vi.setSystemTime(AFTER_MIN_HOLD + 30_000);
    acct.refreshOptionQuotes(new Map());

    const closed = runExits(acct, pos.id, ma20ThroughState(pos.premiumPaid), 1.0, sym);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitMarkProvenance!.quoteAtFire).toBeNull();

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    const row = rows.find((r) => r.outcome !== 'OPEN')!;
    expect(row.exitQuote).toMatchObject({ bid: QUOTE.bid, ask: QUOTE.ask, source: 'last_known' });
    expect(row.exitQuote!.ageMs).toBeGreaterThanOrEqual(30_000);
  });
});

describe('TRA-5100 — TP1', () => {
  function buildOtmSignal(): OtmMispricingSignal {
    return {
      id: 'sig-5100',
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
    };
  }
  const TP1_QUOTE = { bid: 1.48, ask: 1.52 };

  function otmAccount(contracts: number) {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      tp1FullExit1Lot: true,
    });
    const pos = acct.openOptionFromCandidate(
      buildOtmSignal(), 'demo', 50_000, undefined, baseSetup, contracts,
    );
    expect(pos).not.toBeNull();
    const sym = pos!.optionSymbol!;
    const tick = (mark: number) =>
      acct.checkExits(new Map([['AAPL', 200]]), new Map([[sym, mark]]), 'demo', {});
    return { acct, pos: pos!, sym, tick };
  }

  it('a TP1 FULL exit (1-lot) stamps the fire-tick provenance', () => {
    const { acct, sym, tick } = otmAccount(1);
    acct.refreshOptionQuotes(new Map([[sym, TP1_QUOTE]]));
    const closed = tick(1.50);
    expect(closed).toHaveLength(1);
    expect(closed[0]!.exitReason).toBe('tp1');
    expect(closed[0]!.exitMarkProvenance!.quoteAtFire).toEqual(TP1_QUOTE);
  });

  it('a TP1 PARTIAL does NOT stamp — first-write-wins must stay free for the close that ends the row', () => {
    const { acct, sym, tick } = otmAccount(5);
    acct.refreshOptionQuotes(new Map([[sym, TP1_QUOTE]]));
    expect(tick(1.50)).toHaveLength(0); // a partial is not a close
    const open = acct.getState().openOptions[0]!;
    expect(open.tp1Hit).toBe(true);
    expect(open.exitMarkProvenance).toBeUndefined();
  });
});

describe('TRA-5100 — strategyCrossedByExitClass on the sleeve cell grid', () => {
  const T = Date.UTC(2026, 9, 2, 14, 0, 0);
  function rec(over: Partial<OptionTradeJournalRecord> & { id: string }): OptionTradeJournalRecord {
    return {
      openTs: T - 86_400_000,
      symbol: 'AAPL',
      structure: 'single_leg_directional',
      mode: 'demo',
      ivRank: 40,
      trend: 'up',
      sentiment: 0,
      entryDelta: 0.45,
      entryDte: 35,
      atRiskUsd: 200,
      entryArchetype: 'directional',
      account: 'admin',
      outcome: 'WIN',
      closeTs: T,
      realizedPnlUsd: 20,
      realizedR: 0.1,
      exitReason: 'chandelier',
      holdDays: 1,
      contracts: 1,
      entryAskAtOpen: 1.0,
      entryBidAtOpen: 0.96,
      ...over,
    };
  }

  it('classifies the chandelier FAMILY by prefix, not the bare label', () => {
    for (const r of ['chandelier', 'chandelier_daily_close', 'chandelier_restarted', 'chandelier_spot_seeded']) {
      expect(isChandelierExitReason(r)).toBe(true);
    }
    for (const r of ['ma20_close_through', 'time_stop', 'profit_lock', 'sl', null, undefined]) {
      expect(isChandelierExitReason(r)).toBe(false);
    }
  });

  it('splits strategy-exit crossed coverage by exit class, with the AC2 provenance fields on each slice', () => {
    const rows: OptionTradeJournalRecord[] = [
      // chandelier, priced off the fire-tick book
      rec({ id: 'c1', markProvenance: { markSource: 'quote', staleMarkTicks: 0, quoteAtFire: { bid: 1.1, ask: 1.2 }, at: T } }),
      // chandelier, no book at all
      rec({ id: 'c2' }),
      // non-chandelier, priced off a last_known close-seam stamp
      rec({ id: 'n1', exitReason: 'ma20_close_through', exitQuote: { bid: 1.05, ask: 1.15, source: 'last_known', at: T - 45_000, ageMs: 45_000 } }),
      // non-chandelier, nothing — the TRA-5100 historical shape
      rec({ id: 'n2', exitReason: 'time_stop' }),
      // harness close — must be EXCLUDED from both slices
      rec({ id: 'h1', exitReason: 'manual', markProvenance: { markSource: 'quote', staleMarkTicks: 0, quoteAtFire: { bid: 1.0, ask: 1.1 }, at: T } }),
    ];
    const grid = foldOptionSleeveCells(rows);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_directional' && c.entryArchetype === 'directional',
    )!;
    expect(cell).toBeDefined();

    const split = cell.strategyCrossedByExitClass;
    // Exhaustive over the strategy slice — the invariant a reader leans on.
    expect(split.chandelier.closed + split.nonChandelier.closed).toBe(cell.strategyExits.n);
    expect(cell.strategyExits.n).toBe(4); // manual is harness, not strategy

    expect(split.chandelier.closed).toBe(2);
    expect(split.chandelier.crossed.priced).toBe(1);
    expect(split.chandelier.coverage).toBeCloseTo(0.5, 9);
    expect(split.chandelier.crossed.pricedByFireTickQuote).toBe(1);

    expect(split.nonChandelier.closed).toBe(2);
    expect(split.nonChandelier.crossed.priced).toBe(1);
    expect(split.nonChandelier.coverage).toBeCloseTo(0.5, 9);
    // AC2 — the fallback is attributed, and its age is published beside it.
    expect(split.nonChandelier.crossed.pricedByLastKnownQuote).toBe(1);
    expect(split.nonChandelier.crossed.lastKnownQuoteMeanAgeMs).toBe(45_000);
    expect(split.nonChandelier.crossed.unpricedReasons.exit_quote_missing).toBe(1);
  });

  it('an empty slice publishes coverage null — never 0 — and a dark mean age stays null', () => {
    const rows = [rec({ id: 'c1' })]; // one chandelier row, nothing else
    const grid = foldOptionSleeveCells(rows);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_directional' && c.entryArchetype === 'directional',
    )!;
    expect(cell.strategyCrossedByExitClass.nonChandelier.closed).toBe(0);
    expect(cell.strategyCrossedByExitClass.nonChandelier.coverage).toBeNull();
    expect(cell.strategyCrossedByExitClass.chandelier.crossed.lastKnownQuoteMeanAgeMs).toBeNull();
  });
});
