import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount, type OptionTradeJournalSetup } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  summarizeOptionTradeJournal,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import type { RelativeValueSignal } from '@trading-app/shared';
import type { ExitState } from '@trading-app/engine';

// TRA-991 — wiring test for the option-trade-journal emit (open + close). The
// foundation (record/list/fold) is exercised by learned-option-weights.test.ts;
// here we prove the paper book actually CALLS the emit on open and close, behind
// the flag, and that the close folds onto the open by id.

// Inside an ET trading window, pinned to a Tuesday so the window predicate
// passes; ~31 DTE to the 2024-07-05 expiration clears the C3 entry-DTE floor.
const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

const setup: OptionTradeJournalSetup = {
  ivRank: 62,
  trend: 'up',
  sentiment: 0.3,
  sentimentIcBand: 'strong', // TRA-993 — sentiment-IC GRADE band (signal skill)
  agentConviction: 0.8,
  entryDelta: 0.22,
};

const bullPutLegs = [
  { action: 'sell' as const, optionType: 'put' as const, strike: 95, expiration: '2024-07-05' },
  { action: 'buy' as const, optionType: 'put' as const, strike: 90, expiration: '2024-07-05' },
];
const spreadParams = (overrides: Record<string, unknown> = {}) => ({
  symbol: 'AAPL',
  strategy: 'bull_put_spread',
  legs: bullPutLegs,
  netUsd: 180,
  maxLossUsd: 320, // → atRiskUsd reserved per lot
  maxProfitUsd: 180,
  breakevens: [93.2],
  spot: 100,
  ...overrides,
});

function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-1',
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

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra991-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('PaperOptionsAccount option-trade journal emit (TRA-991)', () => {
  it('writes one OPEN then one CLOSE row for a defined-risk demo spread, folded by id', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });

    const pos = acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup);
    expect(pos).not.toBeNull();
    await acct.flushOptionTradeJournal();

    let rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(pos!.id);
    expect(rows[0]!.outcome).toBe('OPEN');
    expect(rows[0]!.structure).toBe('bull_put'); // canonicalised from bull_put_spread
    expect(rows[0]!.mode).toBe('demo');
    expect(rows[0]!.ivRank).toBe(62);
    expect(rows[0]!.trend).toBe('up');
    expect(rows[0]!.sentiment).toBe(0.3);
    expect(rows[0]!.sentimentIcBand).toBe('strong'); // TRA-993 grade band recorded at open
    expect(rows[0]!.agentConviction).toBe(0.8);
    expect(rows[0]!.atRiskUsd).toBe(320); // reserved capital at risk per lot
    expect(rows[0]!.entryDelta).toBeCloseTo(0.22, 5);
    expect(rows[0]!.entryDte).toBeGreaterThan(0);

    // Close it for a winner: premiumPaid basis 3.2 → exit at 6.4 = +320 = +1R.
    const closed = acct.closeOption(pos!.id, 6.4);
    expect(closed).not.toBeNull();
    await acct.flushOptionTradeJournal();

    rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1); // folded onto the same id, not a new row
    expect(rows[0]!.outcome).toBe('WIN');
    expect(rows[0]!.realizedPnlUsd).toBeCloseTo(320, 5);
    expect(rows[0]!.realizedR).toBeCloseTo(1.0, 5);
    expect(rows[0]!.exitReason).toBe('manual');
    expect(rows[0]!.closeTs).toBe(TRADING_TIME);
  });

  it('records single-leg RV opens with the single_leg_rv structure and a LOSS close', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });

    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, undefined, {
      ivRank: 18,
      trend: 'down',
      sentiment: null,
    });
    expect(pos).not.toBeNull();
    const atRisk = pos!.contracts * pos!.premiumPaid * 100;
    await acct.flushOptionTradeJournal();

    let rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.structure).toBe('single_leg_rv');
    expect(rows[0]!.atRiskUsd).toBeCloseTo(atRisk, 5);
    // entryDelta falls back to the position's persisted scanner delta (0.35).
    expect(rows[0]!.entryDelta).toBeCloseTo(0.35, 5);
    expect(rows[0]!.sentiment).toBeNull();

    // Exit at 0.5 (from premiumPaid 1.0) → a loss.
    acct.closeOption(pos!.id, 0.5);
    await acct.flushOptionTradeJournal();

    rows = await listOptionTradeJournal();
    expect(rows[0]!.outcome).toBe('LOSS');
    expect(rows[0]!.realizedR).toBeLessThan(0);
  });

  // TRA-1187 — a structural RV exit must journal its ACTUAL reason
  // (supertrend_flip / ma20_close_through / time_stop), not the blanket `sl`.
  // Before the fix every structural close folded under `sl`, which made the 83%
  // scratch population unattributable on /api/health/option-journal.
  it('journals the real structural exit reason (supertrend_flip), not the blanket sl', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, undefined, {
      ivRank: 30,
      trend: 'up',
      sentiment: null,
    });
    expect(pos).not.toBeNull();
    await acct.flushOptionTradeJournal();

    // A supertrend flip against a long call: side 'buy' + supertrendDirection
    // 'red'. Mark 0.95 vs entry ~1.0 keeps it inside the scratch band and clear
    // of the -50% premium stop, so the STRUCTURAL exit (not the hard SL) fires.
    const exitState: ExitState = {
      side: 'buy',
      supertrendDirection: 'red',
      underlyingClose: 400,
      ma20: 399, // for a long, ma20-close-through needs close < ma20; 400 !< 399
      entryPremium: pos!.premiumPaid,
      currentPremium: 0.95,
      barsHeld: 1,
      hadFollowThrough: false,
    };
    const structuralExitStates = new Map<string, ExitState>([[pos!.id, exitState]]);
    const optionMarks = new Map<string, number>([['MSFT240705C00400000', 0.95]]);

    const closed = acct.checkExits(new Map([['MSFT', 400]]), optionMarks, 'demo', {}, structuralExitStates);
    expect(closed).toHaveLength(1);
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.exitReason).toBe('supertrend_flip');
    expect(rows[0]!.exitReason).not.toBe('sl');
  });

  it('no-ops when the journal flag is off (no setup-less or disabled writes)', async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup);
    expect(pos).not.toBeNull();
    acct.closeOption(pos!.id, 6.4);
    await acct.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });

  it('no-ops when the caller omits the selector setup (nothing to attribute)', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openDefinedRiskSpread(spreadParams()); // no journalSetup
    expect(pos).not.toBeNull();
    await acct.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });

  it('summarizeOptionTradeJournal rolls up closed rows after a demo round trip', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup);
    acct.closeOption(pos!.id, 6.4);
    await acct.flushOptionTradeJournal();

    const summary = summarizeOptionTradeJournal(await listOptionTradeJournal());
    expect(summary.total).toBe(1);
    expect(summary.closed).toBe(1);
    expect(summary.win).toBe(1);
    expect(summary.realizedPnlUsd).toBeCloseTo(320, 5);
    expect(summary.byStructure[0]!.structure).toBe('bull_put');
    expect(summary.byStructure[0]!.closed).toBe(1);
  });

  // TRA-1183 — ema-pullback single-leg fills must be countable distinctly from
  // bare single_leg_rv: the archetype tag rides the open row through to the
  // journal and into the per-archetype rollup (which counts open rows too).
  it('persists entryArchetype on the RV open row and counts it in byArchetype', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });

    // An ema-pullback-admitted RV long (carries the archetype tag)...
    const tagged = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-ema', optionSymbol: 'MSFT240705C00400000' }),
      'demo',
      undefined,
      undefined,
      { ivRank: null, trend: 'up', entryDelta: 0.35, entryArchetype: 'ema-pullback' },
    );
    expect(tagged).not.toBeNull();
    // ...and a bare RV long on a different OCC (no archetype → unspecified).
    const bare = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-bare', optionSymbol: 'MSFT240705C00410000', strike: 410 }),
      'demo',
      undefined,
      undefined,
      { ivRank: null, trend: 'up', entryDelta: 0.35 },
    );
    expect(bare).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    const taggedRow = rows.find((r) => r.id === tagged!.id)!;
    const bareRow = rows.find((r) => r.id === bare!.id)!;
    expect(taggedRow.entryArchetype).toBe('ema-pullback');
    // The bare RV open carries no archetype field at all (folds back as undefined).
    expect(bareRow.entryArchetype).toBeUndefined();
    // Both are the same structure — only the archetype distinguishes them.
    expect(taggedRow.structure).toBe('single_leg_rv');
    expect(bareRow.structure).toBe('single_leg_rv');

    // The rollup counts the still-open fills per archetype (total counts opens too).
    const summary = summarizeOptionTradeJournal(rows);
    const ema = summary.byArchetype.find((a) => a.archetype === 'ema-pullback')!;
    const unspec = summary.byArchetype.find((a) => a.archetype === 'unspecified')!;
    expect(ema.total).toBe(1);
    expect(ema.closed).toBe(0);
    expect(unspec.total).toBe(1);
  });

  // TRA-1187 — the scratch population must be attributable to its closing exit
  // reason so an exit-tuning change targets the right lever. byExitReason buckets
  // resolved rows by exitReason with per-reason scratch counts + hold/DTE means;
  // unlabelled closes fold under `unknown` so the buckets reconcile to `closed`.
  it('buckets resolved rows by exit reason with scratch counts and hold/DTE means', () => {
    const base = {
      symbol: 'MSFT',
      structure: 'single_leg_rv',
      mode: 'demo' as const,
      ivRank: null,
      trend: 'up' as const,
      sentiment: null,
      entryDelta: 0.35,
      atRiskUsd: 100,
    };
    const rows: OptionTradeJournalRecord[] = [
      // Two time_stop closes, both scratches (|R| <= 0.1), short holds vs 35 DTE.
      { ...base, id: 'a', openTs: 0, entryDte: 35, outcome: 'SCRATCH',
        realizedPnlUsd: 2, realizedR: 0.02, exitReason: 'time_stop', holdDays: 0.02 },
      { ...base, id: 'b', openTs: 0, entryDte: 35, outcome: 'SCRATCH',
        realizedPnlUsd: -3, realizedR: -0.03, exitReason: 'time_stop', holdDays: 0.04 },
      // One supertrend_flip win.
      { ...base, id: 'c', openTs: 0, entryDte: 20, outcome: 'WIN',
        realizedPnlUsd: 40, realizedR: 0.4, exitReason: 'supertrend_flip', holdDays: 1 },
      // One hard stop loss.
      { ...base, id: 'd', openTs: 0, entryDte: 40, outcome: 'LOSS',
        realizedPnlUsd: -50, realizedR: -0.5, exitReason: 'sl', holdDays: 2 },
      // A still-open row must be excluded from the resolved rollup entirely.
      { ...base, id: 'e', openTs: 0, entryDte: 35, outcome: 'OPEN' },
    ];

    const summary = summarizeOptionTradeJournal(rows);
    expect(summary.closed).toBe(4);

    const ts = summary.byExitReason.find((r) => r.exitReason === 'time_stop')!;
    expect(ts.closed).toBe(2);
    expect(ts.scratch).toBe(2);
    expect(ts.scratchRate).toBe(1);
    expect(ts.avgEntryDte).toBe(35);
    expect(ts.avgHoldDays).toBeCloseTo(0.03, 5);

    // time_stop is the largest closed bucket → sorts first.
    expect(summary.byExitReason[0]!.exitReason).toBe('time_stop');

    // Scratch counts reconcile across reasons to the headline scratch total.
    const scratchAcrossReasons = summary.byExitReason.reduce((acc, r) => acc + r.scratch, 0);
    expect(scratchAcrossReasons).toBe(summary.scratch);
  });
});
