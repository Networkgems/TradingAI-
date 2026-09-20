// TRA-4759 — take_profit_early fires LIVE (TAKE_PROFIT_EARLY_LIVE_ENABLED,
// armed 2026-09-20T13:47:23.779Z) and, until this ticket, recorded NOTHING a
// grader could read: the call site computed a full `takeProfitEarlyDecision`
// and kept only `shouldExit`; the reason was absent from
// `TRAIL_FAMILY_EXIT_REASONS`; and `exitOwnerTable` owned it `harness`, so the
// surface's own instruction ("grade a sleeve on `strategyExits`") made every
// live row invisible. 100% of live rows landed in TRA-4758's ungradeable
// class U2 — a pre-registered revert trigger.
//
// What is asserted, by ticket item:
//   1. (AC1) A live TP-early fire stamps `takeProfitEarlyFire` — the capture
//      operands PLUS the levels the fire pre-empted (trail, hard stop, and the
//      co-resident give-back decision evaluated purely) — first-fire-only, and
//      the journal close row publishes it verbatim.
//   2. (AC4) The shadow continuation keeps ratcheting the displaced family on
//      the SAME `checkExits` maps the live stops read, settles the journal row
//      with `displacedLevelContinued` + the counterfactual reason + instant,
//      and survives a snapshot round trip (deploy mid-continuation).
//   3. (AC2) The row lands in `releaseForensics` with `stamped: true`; an
//      unstamped (pre-stamp) TP-early row still lands, `stamped: false`.
//   4. (AC3) Ownership is ROW-conditional: a live post-arm row lands in
//      `strategyExits` AND a pre-arm row still lands in `harnessExits`, in the
//      same read, with `exitOwnerCountsSumToClosed` intact.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  foldOptionSleeveCells,
  classifyOptionExitOwner,
  classifyOptionExitOwnerForRow,
  TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS,
} from './option-journal-sleeve-cells.js';
import { buildOptionJournalReport } from './observability/health-routes.js';
import type { OptionTakeProfitEarlyFire, OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const MIN = 60_000;

// Same ETHA geometry as the TRA-4317/4285 suites: entry 1.28 → OTM stop
// 1.024 (−20%) → R = 0.256; OTM TP1 at +50% → tp1Premium 1.92.
const ENTRY = 1.28;
const R_UNIT = 0.256;
const TP1 = 1.92;

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-4759',
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

// No ATR ⇒ the chandelier is inert; no ladder ⇒ the scalar 0.75/0.40 lock;
// `takeProfitEarlyCaptureFrac` present ⇒ the TP-early rule is armed, exactly
// as the live engine arms it under TAKE_PROFIT_EARLY_LIVE_ENABLED.
const RISK: OptionExitRiskInput = {
  underlyingAtrBySymbol: new Map(),
  openingRangeGuardMin: 15,
  takeProfitEarlyCaptureFrac: 0.6,
};

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
  const tick = (quote: { bid: number; ask: number } | null, on: PaperOptionsAccount = acct) => {
    on.refreshOptionQuotes(quote ? new Map([[sym, quote]]) : new Map());
    const mid = quote ? (quote.bid + quote.ask) / 2 : ENTRY;
    return on.checkExits(
      new Map([['ETHA', 19]]),
      new Map([[sym, mid]]),
      'live',
      { waitAndHold: true },
      undefined,
      RISK,
    );
  };
  const row = () => acct.getState().openOptions[0];
  return { acct, tick, row, id: pos!.id, sym };
}

/**
 * Drive the account to a live `take_profit_early` close: mid 1.75 captures
 * (1.75 − 1.28)/(1.92 − 1.28) = 0.734375 ≥ 0.6 of the available profit.
 */
async function closeByTakeProfitEarly() {
  const h = liveAccount();
  vi.setSystemTime(TRADING_TIME + 1 * MIN);
  const staged = h.tick({ bid: 1.7, ask: 1.8 });
  expect(staged).toHaveLength(1);
  expect(staged[0]!.pendingExit!.journalReason).toBe('take_profit_early');
  const fire = h.row().takeProfitEarlyFire;
  const finalised = h.acct.finalizePendingExit(h.id, 1.7);
  expect(finalised!.exitReason).toBe('take_profit_early');
  await h.acct.flushOptionTradeJournal(); // close row written, shadow registered
  return { ...h, fire: fire! };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  tmpFile = join(tmpdir(), `tra4759-journal-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-4759 item 1 (AC1) — the fire is stamped and the close row publishes it', () => {
  it('a quoted TP-early fire stamps the decision operands AND the pre-empted levels, and the journal carries them verbatim', async () => {
    const { fire } = await closeByTakeProfitEarly();
    const FIRE_TIME = TRADING_TIME + 1 * MIN;

    // The decision's own operands — what the call site used to discard.
    expect(fire.at).toBe(FIRE_TIME);
    expect(fire.availableProfit).toBeCloseTo(TP1 - ENTRY, 9); // 0.64
    expect(fire.currentProfit).toBeCloseTo(1.75 - ENTRY, 9); // mid 1.75 at the fire
    expect(fire.capturedFrac).toBeCloseTo((1.75 - ENTRY) / (TP1 - ENTRY), 9); // 0.734375
    expect(fire.captureFrac).toBe(0.6);
    expect(fire.markAtFire).toBeCloseTo(1.75, 9);
    expect(fire.execBidAtFire).toBe(1.7);
    expect(fire.markSource).not.toBeUndefined();

    // The levels the fire pre-empted — the close destroys them.
    expect(fire.tp1Premium).toBeCloseTo(TP1, 9);
    expect(fire.peakPremium).toBeCloseTo(1.75, 9); // this tick's ratchet ran first
    expect(fire.peakPremiumExec).toBe(1.7);
    expect(fire.stopLossPremium).toBeCloseTo(ENTRY * 0.8, 9);
    // mid 1.75 ≥ 1.28 × 1.30 activated the OTM trail this same tick.
    expect(fire.trailingActiveAtFire).toBe(true);
    expect(fire.trailingStopPremiumAtFire).toBeCloseTo(1.75 * 0.8, 9);

    // The co-resident lock, evaluated purely on the executable basis: peakR =
    // (1.70 − 1.28)/0.256 = 1.640625 ⇒ armed, level 1.240625R = 1.5976 — and
    // NOT exiting, which is the pre-emption this stamp exists to show.
    expect(fire.profitLock.armed).toBe(true);
    expect(fire.profitLock.peakR).toBeCloseTo(1.640625, 9);
    expect(fire.profitLock.giveBackR).toBeCloseTo(0.4, 9);
    expect(fire.profitLock.exitLevelR).toBeCloseTo(1.240625, 9);
    expect(fire.profitLock.levelPremium).toBeCloseTo(ENTRY + 1.240625 * R_UNIT, 9);
    expect(fire.profitLock.stopBasisPremium).toBeCloseTo(R_UNIT, 9);
    expect(fire.profitLock.peakPremiumConsumed).toBe(1.7);
    expect(fire.profitLock.shouldExit).toBe(false);

    // `toEqual` on the WHOLE object on purpose (TRA-4246 AC2 rationale): a
    // stamp field that never reaches the journal is the defect itself.
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.exitReason).toBe('take_profit_early');
    expect(rows[0]!.takeProfitEarlyFire).toEqual(fire);
  });

  it('CONTROL — a profit-lock close carries no takeProfitEarlyFire: the column is never fabricated for another rule', async () => {
    const { acct, tick, row, id } = liveAccount();
    // Arm the lock without crossing the 0.6 capture level (1.664): bid 1.48
    // arms (≥ 1.28 + 0.75R = 1.472), mid 1.53 < 1.664 keeps TP-early quiet.
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(tick({ bid: 1.48, ask: 1.58 })).toHaveLength(0);
    vi.setSystemTime(TRADING_TIME + 3 * MIN);
    const staged = tick({ bid: 1.37, ask: 1.47 });
    expect(staged).toHaveLength(1);
    expect(staged[0]!.pendingExit!.journalReason).toBe('profit_lock');
    expect(row().takeProfitEarlyFire).toBeUndefined();
    acct.finalizePendingExit(id, 1.37);
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows[0]!.takeProfitEarlyFire).toBeUndefined();
    expect(rows[0]!.takeProfitEarlyShadow).toBeUndefined(); // shadow is TP-early-only
  });
});

describe('TRA-4759 item 2 (AC4) — the shadow continuation answers the counterfactual', () => {
  it('keeps ratcheting on the live tick maps and settles the journal row when the displaced lock would have released', async () => {
    const { acct, tick } = await closeByTakeProfitEarly();
    expect(acct.getState().openOptions).toHaveLength(0); // the row is CLOSED

    // Continuation tick 1 — the path runs on: peak 1.75→1.81 (mid), exec
    // 1.70→1.76. Lock level R = (1.76−1.28)/0.256 − 0.40 = 1.475 ⇒ 1.6576;
    // bid 1.76 above it ⇒ still riding.
    vi.setSystemTime(TRADING_TIME + 5 * MIN);
    expect(tick({ bid: 1.76, ask: 1.86 })).toHaveLength(0);

    // Continuation tick 2 — bid 1.60 ≤ 1.6576 ⇒ the displaced lock releases.
    const SETTLE_TIME = TRADING_TIME + 7 * MIN;
    vi.setSystemTime(SETTLE_TIME);
    expect(tick({ bid: 1.6, ask: 1.7 })).toHaveLength(0);
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.takeProfitEarlyShadow).toEqual({
      exitReason: 'profit_lock',
      at: SETTLE_TIME,
      // The family exits at the mark, exactly as the live branch does.
      displacedLevelContinued: 1.65,
      continuedPeakPremium: 1.81,
      continuedPeakPremiumExec: 1.76,
      ticksObserved: 2,
    });
    // Settled once — a later tick must not resurrect or re-write it.
    vi.setSystemTime(TRADING_TIME + 9 * MIN);
    expect(tick({ bid: 1.0, ask: 1.1 })).toHaveLength(0);
    await acct.flushOptionTradeJournal();
    expect((await listOptionTradeJournal())[0]!.takeProfitEarlyShadow!.at).toBe(SETTLE_TIME);
  });

  it('survives a snapshot round trip (deploy mid-continuation) and settles on the restored account', async () => {
    const { acct, tick } = await closeByTakeProfitEarly();
    const snap = acct.exportSnapshot();
    expect(snap.tpEarlyShadows).toHaveLength(1);
    expect(snap.tpEarlyShadows![0]!.optionSymbol).toBe('ETHA241002C00019000');

    const restored = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    restored.importSnapshot(snap);
    const SETTLE_TIME = TRADING_TIME + 10 * MIN;
    vi.setSystemTime(SETTLE_TIME);
    // Straight to a level under the displaced lock's release (peak carried in
    // the snapshot is 1.75 mid / 1.70 exec ⇒ level 1.5976 exec-basis).
    expect(tick({ bid: 1.4, ask: 1.5 }, restored)).toHaveLength(0);
    await restored.flushOptionTradeJournal();
    const shadow = (await listOptionTradeJournal())[0]!.takeProfitEarlyShadow!;
    expect(shadow.exitReason).toBe('profit_lock');
    expect(shadow.at).toBe(SETTLE_TIME);
    expect(shadow.displacedLevelContinued).toBeCloseTo(1.45, 9);
  });

  it('the contract\'s own expiration day is the hard horizon: past it the shadow settles as expiry', async () => {
    const { acct, tick } = await closeByTakeProfitEarly();
    // One observed continuation tick, then jump past the 2024-10-02 expiry.
    vi.setSystemTime(TRADING_TIME + 5 * MIN);
    expect(tick({ bid: 1.76, ask: 1.86 })).toHaveLength(0);
    const AFTER_EXPIRY = Date.parse('2024-10-03T15:00:00Z');
    vi.setSystemTime(AFTER_EXPIRY);
    expect(tick(null)).toHaveLength(0);
    await acct.flushOptionTradeJournal();
    const shadow = (await listOptionTradeJournal())[0]!.takeProfitEarlyShadow!;
    expect(shadow.exitReason).toBe('expiry');
    expect(shadow.at).toBe(AFTER_EXPIRY);
    expect(shadow.displacedLevelContinued).toBeCloseTo(1.81, 9); // the last observed mark
    expect(shadow.ticksObserved).toBe(1);
  });
});

// ── Items 3 & 4 — the published read surfaces, driven as pure folds ─────────

let seq = 0;
function closedRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  seq += 1;
  return {
    id: `row-${seq}`,
    symbol: 'ETHA',
    optionSymbol: `ETHA241002C0001900${seq}`,
    mode: 'live',
    account: 'desk',
    structure: 'single_leg_otm',
    entryArchetype: undefined,
    contracts: 1,
    atRiskUsd: 128,
    entryDte: 30,
    entryDelta: 0.18,
    ivRank: null,
    trend: 'up',
    sentiment: null,
    agentConviction: null,
    openTs: Date.UTC(2026, 8, 18, 14, 0),
    outcome: 'WIN',
    closeTs: TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS + 60_000,
    realizedPnlUsd: 42,
    realizedR: 0.33,
    exitReason: 'take_profit_early',
    ...over,
  } as unknown as OptionTradeJournalRecord;
}

const STAMP: OptionTakeProfitEarlyFire = {
  at: TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS + 30_000,
  availableProfit: 0.64,
  currentProfit: 0.47,
  capturedFrac: 0.734375,
  captureFrac: 0.6,
  markAtFire: 1.75,
  execBidAtFire: 1.7,
  tp1Premium: 1.92,
  peakPremium: 1.75,
  peakPremiumExec: 1.7,
  stopLossPremium: 1.024,
  trailingStopPremiumAtFire: 1.4,
  trailingActiveAtFire: true,
  profitLock: {
    armed: true,
    peakR: 1.640625,
    giveBackR: 0.4,
    exitLevelR: 1.240625,
    levelPremium: 1.5976,
    stopBasisPremium: 0.256,
    peakPremiumConsumed: 1.7,
    shouldExit: false,
  },
  markSource: 'quote',
  staleMarkTicks: 0,
};

describe('TRA-4759 item 3 (AC2) — take_profit_early is on the release-forensics list', () => {
  function tpCell(rows: OptionTradeJournalRecord[]) {
    return buildOptionJournalReport(rows, Date.UTC(2026, 8, 21), true).summary.byAccountClass
      .desk.byStructureExit.cells.find(
        (c) => c.structure === 'single_leg_otm' && c.exitReason === 'take_profit_early',
      )!;
  }

  it('a stamped row reads stamped:true with the capture level as its release level; an unstamped row still lands, stamped:false', () => {
    const cell = tpCell([
      closedRow({
        takeProfitEarlyFire: STAMP,
        pnlBasis: 'broker-fill',
        exitFillPremium: 1.7,
      } as Partial<OptionTradeJournalRecord>),
      // The pre-stamp close: on the list BY LABEL, stamped false — the
      // "correct and intended reading" the ticket names.
      closedRow({ closeTs: TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS - 60_000 }),
    ]);
    expect(cell.releaseForensicsTruncated).toBe(0);
    const [stamped, unstamped] = cell.releaseForensics;
    expect(stamped!.stamped).toBe(true);
    expect(stamped!.armed).toBe(true);
    // Release level = entry + captureFrac × availableProfit, entry recovered
    // as tp1 − availableProfit: 1.28 + 0.6 × 0.64 = 1.664.
    expect(stamped!.levelPremium).toBeCloseTo(1.664, 9);
    expect(stamped!.levelR).toBeCloseTo((1.664 - 1.28) / 0.256, 9); // 1.5
    expect(stamped!.stopBasisPremium).toBeCloseTo(0.256, 9);
    expect(stamped!.peakPremiumAtFire).toBe(1.7);
    expect(stamped!.markAtFire).toBe(1.75);
    expect(stamped!.execBidAtFire).toBe(1.7);
    expect(stamped!.fillVsLevelPremium).toBeCloseTo(1.7 - 1.664, 9);
    expect(stamped!.markVsLevelPremium).toBeCloseTo(1.75 - 1.664, 9);

    expect(unstamped!.stamped).toBe(false);
    expect(unstamped!.armed).toBeNull();
    expect(unstamped!.levelPremium).toBeNull();
  });
});

describe('TRA-4759 item 4 (AC3) — ownership is ROW-conditional, asserted from both sides in one read', () => {
  it('classifier: live post-arm ⇒ strategy; pre-arm, demo, or unclosed ⇒ the table\'s harness', () => {
    const T = TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS;
    expect(new Date(T).toISOString()).toBe('2026-09-20T13:47:23.779Z');
    const base = { exitReason: 'take_profit_early' as const };
    expect(classifyOptionExitOwnerForRow({ ...base, mode: 'live', closeTs: T })).toBe('strategy');
    expect(classifyOptionExitOwnerForRow({ ...base, mode: 'live', closeTs: T - 1 })).toBe('harness');
    expect(classifyOptionExitOwnerForRow({ ...base, mode: 'demo', closeTs: T + 1 })).toBe('harness');
    expect(classifyOptionExitOwnerForRow({ ...base, mode: 'live', closeTs: undefined })).toBe('harness');
    // Every other reason delegates to the table untouched.
    expect(classifyOptionExitOwnerForRow({ exitReason: 'profit_lock', mode: 'live', closeTs: T }))
      .toBe(classifyOptionExitOwner('profit_lock'));
    // The reason-level base rule is UNCHANGED — the pre-arm baseline's rule.
    expect(classifyOptionExitOwner('take_profit_early')).toBe('harness');
  });

  it('the grid: both sides land in the same read, sums hold, and byExitReason names both owners', () => {
    const T = TAKE_PROFIT_EARLY_LIVE_STRATEGY_SINCE_TS;
    const grid = foldOptionSleeveCells([
      closedRow({ closeTs: T + 1_000 }), // live post-arm ⇒ strategy
      closedRow({ closeTs: T - 1_000 }), // live pre-arm ⇒ harness (TRA-3709 baseline)
      closedRow({ mode: 'demo', closeTs: T + 1_000 } as Partial<OptionTradeJournalRecord>), // demo stays harness
    ]);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
    )!;
    expect(cell.all.n).toBe(3);
    expect(cell.strategyExits.n).toBe(1);
    expect(cell.harnessExits.n).toBe(2);
    expect(cell.unknownExits.n).toBe(0);
    expect(cell.exitOwnerCountsSumToClosed).toBe(true);
    expect(grid.cellsSumToClosed).toBe(true);
    const tpStats = cell.byExitReason.filter((s) => s.exitReason === 'take_profit_early');
    expect(tpStats.map((s) => [s.owner, s.closed]).sort()).toEqual([
      ['harness', 2],
      ['strategy', 1],
    ]);
  });
});
