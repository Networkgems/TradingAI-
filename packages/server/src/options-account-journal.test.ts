import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount, type OptionTradeJournalSetup } from './options-account.js';
import {
  listOptionTradeJournal,
  recordOptionTradeOpen,
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
  riskThrottleMultiplier: 1, // TRA-2333 — un-throttled fixture fill
  riskThrottleDecided: 1, // TRA-2339 — and the autopilot decided no trim either
  // TRA-2375 — this fixture drives `openDefinedRiskSpread`, which takes no sizing
  // scalar and is not a chokepoint at any scope ⇒ OUT of the throttle cohort.
  riskThrottleSizingPath: null,
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
      riskThrottleMultiplier: 1,
      riskThrottleDecided: 1,
      riskThrottleSizingPath: 'options_single_leg', // TRA-2375 — RV single-leg IS a chokepoint
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
      riskThrottleMultiplier: 1,
      riskThrottleDecided: 1,
      riskThrottleSizingPath: 'options_single_leg', // TRA-2375 — RV single-leg IS a chokepoint
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
      { ivRank: null, trend: 'up', entryDelta: 0.35, entryArchetype: 'ema-pullback', riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: 'options_single_leg' },
    );
    expect(tagged).not.toBeNull();
    // ...and a bare RV long on a different OCC (no archetype → unspecified).
    const bare = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-bare', optionSymbol: 'MSFT240705C00410000', strike: 410 }),
      'demo',
      undefined,
      undefined,
      { ivRank: null, trend: 'up', entryDelta: 0.35, riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: 'options_single_leg' },
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

  // TRA-1200 — closed-row attribution must split per entry-DTE band AND carry
  // the full WIN/LOSS/SCRATCH columns per archetype, so the three TRA-1028
  // sub-flags can earn a per-item promote/fail verdict on real outcomes.
  it('splits closed rows by DTE band and reports per-archetype win/loss/scratch', () => {
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
      // 30to45 band: one ema-pullback win + one bare scratch.
      { ...base, id: 'a', openTs: 0, entryDte: 35, entryArchetype: 'ema-pullback',
        outcome: 'WIN', realizedPnlUsd: 30, realizedR: 0.3, exitReason: 'tp1', holdDays: 3 },
      { ...base, id: 'b', openTs: 0, entryDte: 40, outcome: 'SCRATCH',
        realizedPnlUsd: 1, realizedR: 0.01, exitReason: 'time_stop', holdDays: 1 },
      // gt45 band: one volume-breakout loss (the wider DTE window cohort).
      { ...base, id: 'c', openTs: 0, entryDte: 55, entryArchetype: 'volume-breakout',
        structure: 'bull_put', outcome: 'LOSS', realizedPnlUsd: -50, realizedR: -0.5,
        exitReason: 'sl', holdDays: 4 },
      // lt30 band, still OPEN — excluded from every resolved rollup.
      { ...base, id: 'd', openTs: 0, entryDte: 20, outcome: 'OPEN' },
    ];

    const summary = summarizeOptionTradeJournal(rows);

    // byDte: three closed rows split lt30/30to45/gt45, emitted in band order.
    expect(summary.byDte.map((d) => d.band)).toEqual(['30to45', 'gt45']);
    const mid = summary.byDte.find((d) => d.band === '30to45')!;
    expect(mid.closed).toBe(2);
    expect(mid.win).toBe(1);
    expect(mid.scratch).toBe(1);
    expect(mid.avgEntryDte).toBeCloseTo(37.5, 5);
    const wide = summary.byDte.find((d) => d.band === 'gt45')!;
    expect(wide.closed).toBe(1);
    expect(wide.loss).toBe(1);
    expect(wide.realizedPnlUsd).toBe(-50);
    // Closed counts reconcile across bands to the headline closed total.
    expect(summary.byDte.reduce((acc, d) => acc + d.closed, 0)).toBe(summary.closed);

    // byArchetype now carries the win/loss/scratch columns over resolved rows.
    const vol = summary.byArchetype.find((x) => x.archetype === 'volume-breakout')!;
    expect(vol.total).toBe(1);
    expect(vol.closed).toBe(1);
    expect(vol.loss).toBe(1);
    expect(vol.scratchRate).toBe(0);
    const ema = summary.byArchetype.find((x) => x.archetype === 'ema-pullback')!;
    expect(ema.win).toBe(1);
    expect(ema.winRate).toBe(1);
  });
});

// TRA-1978 — the wheel's covered-write opens (CSP / CC, TRA-1976/1977) must
// journal to the per-fill option-trade journal so CSP/CC outcomes accrue
// evidence, folded closed on settlement (expired / bought-back / assigned /
// called-away / liquidation). Additive + flag-gated; journaling never alters
// execution (mirrors the TRA-991 fire-and-forget pattern on the long paths).
describe('PaperOptionsAccount wheel covered-write journal (TRA-1978)', () => {
  const cspParams = (overrides: Record<string, unknown> = {}) => ({
    symbol: 'AAPL',
    optionSymbol: 'AAPL240705P00050000',
    strike: 50,
    expiration: '2024-07-05', // ~31 DTE from the pinned Tuesday → clears the C3 floor
    creditPerShare: 1.5,
    spot: 55,
    entryDelta: -0.25,
    ...overrides,
  });
  const ccParams = (overrides: Record<string, unknown> = {}) => ({
    symbol: 'AAPL',
    optionSymbol: 'AAPL240705C00052000',
    strike: 52,
    expiration: '2024-07-05',
    creditPerShare: 1.0,
    spot: 55,
    entryDelta: 0.3,
    ...overrides,
  });
  const wheelSetup = (
    archetype: 'wheel-csp' | 'wheel-cc',
    entryDelta: number,
  ): OptionTradeJournalSetup => ({
    ivRank: 62,
    trend: 'sideways', // a premium-selling wheel is a direction-neutral vol sleeve
    entryDelta,
    sentiment: null,
    sentimentIcBand: null,
    agentConviction: null,
    entryArchetype: archetype,
    riskThrottleMultiplier: 1, // TRA-2333 — the wheel does not consult the throttle
    riskThrottleDecided: 1, // TRA-2339 — nor would it at any scope
    riskThrottleSizingPath: null, // TRA-2375 — ⇒ out of cohort, not un-trimmed in it
  });

  it('journals a CSP open (cash_secured_put, at-risk = collateral) and folds the expired-worthless close', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const csp = acct.openCashSecuredPut(cspParams(), 'demo', wheelSetup('wheel-csp', -0.25))!;
    expect(csp).not.toBeNull();
    await acct.flushOptionTradeJournal();

    let rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(csp.id);
    expect(rows[0]!.structure).toBe('cash_secured_put');
    expect(rows[0]!.outcome).toBe('OPEN');
    // Honest at-risk basis: the full-strike cash COLLATERAL (50 × 100), not the
    // (strike − credit) max-loss figure.
    expect(rows[0]!.atRiskUsd).toBe(5_000);
    expect(rows[0]!.ivRank).toBe(62);
    expect(rows[0]!.trend).toBe('sideways');
    expect(rows[0]!.entryArchetype).toBe('wheel-csp');
    expect(rows[0]!.entryDelta).toBeCloseTo(0.25, 5); // |delta| folded

    // Expire OTM: keep the full $150 credit against the $5k collateral basis.
    acct.settleCoveredWrite(csp.id, { kind: 'expired_worthless' });
    await acct.flushOptionTradeJournal();

    rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1); // folded onto the same id, not a new row
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.exitReason).toBe('expired');
    expect(rows[0]!.realizedPnlUsd).toBe(150);
    expect(rows[0]!.realizedR).toBeCloseTo(150 / 5_000, 5);
  });

  it('journals a bought-back CSP close under the bought_back exit reason', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const csp = acct.openCashSecuredPut(cspParams(), 'demo', wheelSetup('wheel-csp', -0.25))!;
    acct.settleCoveredWrite(csp.id, { kind: 'bought_back', debitPerShare: 0.4 });
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.exitReason).toBe('bought_back');
    expect(rows[0]!.realizedPnlUsd).toBe(110); // 150 credit − 40 buy-back
  });

  it('journals an assigned CSP (exit reason assigned) then the covered call called-away', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const csp = acct.openCashSecuredPut(cspParams(), 'demo', wheelSetup('wheel-csp', -0.25))!;
    acct.settleCoveredWrite(csp.id, { kind: 'assigned' });
    const cc = acct.openCoveredCall(ccParams(), 'demo', wheelSetup('wheel-cc', 0.3))!;
    expect(cc).not.toBeNull();
    // Called away: stock (52 − 50)×100 + call credit 100 = 300.
    acct.settleCoveredWrite(cc.id, { kind: 'assigned' });
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    const cspRow = rows.find((r) => r.id === csp.id)!;
    const ccRow = rows.find((r) => r.id === cc.id)!;
    // CSP leg resolves at assignment keeping just the credit (the stock P&L then
    // accrues under the covered-call row).
    expect(cspRow.structure).toBe('cash_secured_put');
    expect(cspRow.exitReason).toBe('assigned');
    expect(cspRow.realizedPnlUsd).toBe(150);
    // CC leg: assignment-strike notional at-risk basis + the wheel's stock-leg
    // P&L booked on called-away.
    expect(ccRow.structure).toBe('covered_call');
    expect(ccRow.exitReason).toBe('called_away');
    expect(ccRow.atRiskUsd).toBe(5_000); // assignmentStrike (50) × 100
    expect(ccRow.entryArchetype).toBe('wheel-cc');
    expect(ccRow.realizedPnlUsd).toBe(300);
  });

  it('journals a covered-call close under the liquidation reason (stock_stop)', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const csp = acct.openCashSecuredPut(cspParams(), 'demo', wheelSetup('wheel-csp', -0.25))!;
    acct.settleCoveredWrite(csp.id, { kind: 'assigned' });
    const cc = acct.openCoveredCall(ccParams(), 'demo', wheelSetup('wheel-cc', 0.3))!;
    const lotId = acct.getAssignedShares()[0]!.id;
    // Crash to 40: the call is deep OTM (bought back ≈ 0, keep the $100 credit),
    // and the lot is liquidated on the stock-side stop.
    acct.liquidateAssignedShares(lotId, 40, 'stock_stop');
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    const ccRow = rows.find((r) => r.id === cc.id)!;
    expect(ccRow.structure).toBe('covered_call');
    expect(ccRow.outcome).not.toBe('OPEN');
    expect(ccRow.exitReason).toBe('stock_stop');
    expect(ccRow.realizedPnlUsd).toBe(100); // credit kept; buy-back ≈ 0
  });

  it('no-ops when the journal flag is off, and when the flag is on but no setup is supplied', async () => {
    // Flag off → even with a setup, nothing is journaled.
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    const off = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const a = off.openCashSecuredPut(cspParams(), 'demo', wheelSetup('wheel-csp', -0.25))!;
    off.settleCoveredWrite(a.id, { kind: 'expired_worthless' });
    await off.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(0);

    // Flag on but no journalSetup passed → nothing to attribute, still no row.
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    const noSetup = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const b = noSetup.openCashSecuredPut(cspParams({ optionSymbol: 'AAPL240705P00045000', strike: 45 }))!;
    noSetup.settleCoveredWrite(b.id, { kind: 'expired_worthless' });
    await noSetup.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });
});

// TRA-2333 (parent TRA-2331) — the applied risk-throttle multiplier is STAMPED
// on the fill. Before this the multiplier lived only in the since-boot `byPath`
// counters, which say how MANY tickets were trimmed and never WHICH — so a trim
// could not be joined to the trade's own R/P&L and "grade the trims" was not
// computable. These pin the two properties the grade depends on: the stamp is
// present on a trimmed fill, and it is present *as exactly 1* on an un-trimmed
// one rather than absent.
describe('risk-throttle stamp on the journal open row (TRA-2333)', () => {
  const stampSetup = (
    riskThrottleMultiplier: number,
    // TRA-2339 — defaults to the applied term, i.e. the armed case where the two
    // agree. The dark case passes them apart explicitly.
    riskThrottleDecided: number = riskThrottleMultiplier,
  ): OptionTradeJournalSetup => ({
    ivRank: 30,
    trend: 'up',
    entryDelta: 0.35,
    sentiment: null,
    sentimentIcBand: null,
    agentConviction: null,
    riskThrottleMultiplier,
    riskThrottleDecided,
    // TRA-2375 — these fixtures model a fill that went through a real sizing
    // chokepoint, which is what makes its `decided`/`applied` pair meaningful.
    riskThrottleSizingPath: 'options_single_leg',
  });

  it('a fill sized under a sub-1 throttle carries riskThrottleMultiplier < 1', async () => {
    process.env['RISK_THROTTLE_SIZING_ENABLED'] = 'demo';
    try {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      const pos = acct.openOptionFromRvCandidate(
        buildRvSignal(), 'demo', undefined, undefined, stampSetup(0.5), 0.5,
      );
      expect(pos).not.toBeNull();
      await acct.flushOptionTradeJournal();

      const row = (await listOptionTradeJournal())[0]!;
      expect(row.riskThrottleMultiplier).toBe(0.5);
      expect(row.riskThrottleMultiplier!).toBeLessThan(1);
      expect(row.riskThrottleArmedScope).toBe('demo');
    } finally {
      delete process.env['RISK_THROTTLE_SIZING_ENABLED'];
    }
  });

  it('a fill sized at FULL risk carries exactly 1 — present, not absent', async () => {
    // The TRA-2302 `?? 0` lesson. If the stamp were written only on a trim,
    // ABSENT would collapse into "un-trimmed" and a build where the stamp
    // regressed would be indistinguishable from a calm market. Absent must keep
    // meaning exactly one thing: written by a pre-TRA-2333 build.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromRvCandidate(
      buildRvSignal(), 'demo', undefined, undefined, stampSetup(1),
    );
    expect(pos).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row).toHaveProperty('riskThrottleMultiplier');
    expect(row.riskThrottleMultiplier).toBe(1);
    expect(row.riskThrottleArmedScope).toBe('off'); // dark ⇒ the scope says so
  });

  it('the trimmed and un-trimmed rows partition cleanly on `< 1`', async () => {
    // Exactly the query TRA-2331 runs: trimmed fills vs the contemporaneous
    // full-size ones, joined to each row's own outcome fields.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-trim', optionSymbol: 'MSFT240705C00400000' }),
      'demo', undefined, undefined, stampSetup(0.25), 0.25,
    );
    acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-full', optionSymbol: 'MSFT240705C00410000', strike: 410 }),
      'demo', undefined, undefined, stampSetup(1),
    );
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    const trimmed = rows.filter((r) => r.riskThrottleMultiplier! < 1);
    const full = rows.filter((r) => r.riskThrottleMultiplier === 1);
    expect(trimmed).toHaveLength(1);
    expect(full).toHaveLength(1);
    // Every row lands in exactly one side — no row is unattributable.
    expect(trimmed.length + full.length).toBe(rows.length);
    expect(trimmed[0]!.contracts!).toBeLessThan(full[0]!.contracts!);
  });
});

// TRA-2339 (parent TRA-2331) — the DECIDED term next to the applied one.
//
// The applied stamp above cannot answer the question the board's LIVE arm turns
// on. Under `demo` the live chokepoints resolve `armed: false` by design, so
// their `riskThrottleMultiplier` is pinned at 1 — and a fill taken while the
// autopilot sat at 0.35 stamps EXACTLY the same `1` as a fill taken while it sat
// at 1.0. There is no observation period that separates them, because arming live
// to find out is the very decision the measurement is meant to inform.
//
// These pin the property that closes that: on a dark path the row still records
// what WOULD have happened, so `decided < 1 && multiplier === 1` names the
// would-have-been-trimmed cohort per fill, joined to that row's own outcome.
describe('decided-vs-applied throttle stamp on the journal open row (TRA-2339)', () => {
  const stampSetup = (
    riskThrottleMultiplier: number,
    riskThrottleDecided: number = riskThrottleMultiplier,
  ): OptionTradeJournalSetup => ({
    ivRank: 30,
    trend: 'up',
    entryDelta: 0.35,
    sentiment: null,
    sentimentIcBand: null,
    agentConviction: null,
    riskThrottleMultiplier,
    riskThrottleDecided,
    // TRA-2375 — these fixtures model a fill that went through a real sizing
    // chokepoint, which is what makes its `decided`/`applied` pair meaningful.
    riskThrottleSizingPath: 'options_single_leg',
  });

  it('a DARK fill records the throttle that was decided and not applied', async () => {
    // The defect in one assertion. Flag off ⇒ full size was taken (multiplier 1),
    // but the autopilot had de-risked to 0.4 and the row says so. Pre-TRA-2339
    // this fill was indistinguishable from one taken in a calm market.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, undefined, stampSetup(1, 0.4));
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.riskThrottleMultiplier).toBe(1); // nothing was trimmed…
    expect(row.riskThrottleDecided).toBe(0.4); // …but something WOULD have been
    expect(row.riskThrottleArmedScope).toBe('off');
  });

  it('is written as exactly 1 when the autopilot decided no trim — present, not absent', async () => {
    // Same TRA-2302 `?? 0` rule the applied stamp follows. If `decided` were
    // written only when sub-1, ABSENT would collapse into "the autopilot was
    // calm" and a regressed stamp would read as a quiet week. Absent must keep
    // meaning exactly one thing: written by a pre-TRA-2339 build.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromRvCandidate(buildRvSignal(), 'demo', undefined, undefined, stampSetup(1));
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row).toHaveProperty('riskThrottleDecided');
    expect(row.riskThrottleDecided).toBe(1);
  });

  it('separates the dark cohort from the calm one — which the applied term alone cannot', async () => {
    // Two dark fills: one the autopilot would have trimmed, one it would not.
    // Both carry the identical applied term, so a partition on
    // `riskThrottleMultiplier` puts them in the same bucket. The decided term is
    // the only field that tells them apart.
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const would = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-would', optionSymbol: 'MSFT240705C00400000' }),
      'demo', undefined, undefined, stampSetup(1, 0.35),
    );
    const calm = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-calm', optionSymbol: 'MSFT240705C00410000', strike: 410 }),
      'demo', undefined, undefined, stampSetup(1, 1),
    );
    expect(would).not.toBeNull();
    expect(calm).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    // The applied term cannot see the difference…
    expect(rows.every((r) => r.riskThrottleMultiplier === 1)).toBe(true);
    // …the decided term can, and it is the per-fill dark cohort.
    const wouldHave = rows.filter((r) => r.riskThrottleDecided! < 1 && r.riskThrottleMultiplier === 1);
    expect(wouldHave).toHaveLength(1);
    expect(wouldHave[0]!.id).toBe(would!.id);
    // Same contracts on both: the dark cohort is a LABEL on an un-trimmed fill,
    // not a differently-sized one. That is what makes it a clean counterfactual.
    expect(rows[0]!.contracts).toBe(rows[1]!.contracts);
  });

  it('an ARMED trimmed fill has both terms sub-1 and agreeing', async () => {
    process.env['RISK_THROTTLE_SIZING_ENABLED'] = 'demo';
    try {
      const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
      acct.openOptionFromRvCandidate(
        buildRvSignal(), 'demo', undefined, undefined, stampSetup(0.5), 0.5,
      );
      await acct.flushOptionTradeJournal();

      const row = (await listOptionTradeJournal())[0]!;
      expect(row.riskThrottleMultiplier).toBe(0.5);
      expect(row.riskThrottleDecided).toBe(0.5);
      // Not in the dark cohort — it was decided AND consumed.
      expect(row.riskThrottleDecided! < 1 && row.riskThrottleMultiplier === 1).toBe(false);
    } finally {
      delete process.env['RISK_THROTTLE_SIZING_ENABLED'];
    }
  });
});

// TRA-2375 — the NEXT layer of the TRA-2339 defect, not a regression of it.
//
// TRA-2339 made "would this fill have been trimmed?" countable per fill. It did
// NOT make "was this fill even ELIGIBLE to be trimmed?" countable, and those are
// different questions. `riskThrottleDecided === 1` is stamped by two populations:
//
//   (a) IN COHORT, untrimmed — the open path consulted the throttle and the
//       autopilot happened to be at full size. A true control observation.
//   (b) OUT OF COHORT — the open path is not a chokepoint at ANY scope (the three
//       defined-risk-spread sites, the wheel's CSP/CC, the bounded-live 1-contract
//       override), so it stamps a hardcoded 1.
//
// Partition on `decided === 1` and (b) lands in the CONTROL arm — trades the
// throttle could never have touched, in the arm TRA-2331 compares against.
//
// Today that share is small, and it is a POLICY variable, not a constant
// (TRA-2385; TRA-2375 shipped saying "a large share" and never counted it).
// Measured 2026-07-26 vs live 408f06a5, n=2,383: 0 of the 115 demo desk rows the
// grade partitions on, 28 of 2,383 overall (all in the unattributed bucket the
// grade already drops), 0 wheel rows anywhere. The day the desk turns the wheel
// on or routes spreads that changes with no code change here — and it fails
// SILENTLY, because a contaminated control arm just looks big and healthy.
//
// These pin the property that closes it: cohort membership is carried on the row
// as an identity, and is read as a PRESENCE test in two steps — `hasOwnProperty`
// for "does this build stamp it at all", then `!= null` for "was this fill
// eligible". Three states, none of which can collapse into another.
describe('throttle CHOKEPOINT identity on the journal open row (TRA-2375)', () => {
  const chokepointSetup = (): OptionTradeJournalSetup => ({
    ivRank: 30,
    trend: 'up',
    entryDelta: 0.35,
    sentiment: null,
    sentimentIcBand: null,
    agentConviction: null,
    riskThrottleMultiplier: 1,
    riskThrottleDecided: 1,
    riskThrottleSizingPath: 'options_single_leg',
  });

  // The partition the TRA-2331 grade runs (scripts/tra2331-throttle-grade.mjs
  // `eligibility()`), restated here against rows the REAL writer produced. Stated
  // as a two-step presence test on purpose — that is the property under test.
  const stamps = (r: OptionTradeJournalRecord): boolean =>
    Object.prototype.hasOwnProperty.call(r, 'riskThrottleSizingPath');
  const eligible = (r: OptionTradeJournalRecord): boolean =>
    stamps(r) && r.riskThrottleSizingPath != null;

  it('stamps the consulting chokepoint identity on an in-cohort fill', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromRvCandidate(
      buildRvSignal(), 'demo', undefined, undefined, chokepointSetup(),
    );
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.riskThrottleSizingPath).toBe('options_single_leg');
    expect(eligible(row)).toBe(true);
  });

  it('stamps an explicit null — not an ABSENT key — on an out-of-cohort spread open', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.riskThrottleSizingPath).toBeNull();
    expect(eligible(row)).toBe(false);
    // The load-bearing half: the KEY IS THERE. If a non-chokepoint open omitted
    // it, these rows would fail the `hasOwnProperty` step and drag the whole
    // grade back onto its structure-based proxy — the exact-basis partition this
    // ticket exists to supply would never engage on a book that holds spreads.
    expect(stamps(row)).toBe(true);
  });

  it('THE DEFECT: two rows identical on the TRA-2339 pair, only one of them a control observation', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    // A single-leg fill that DID consult the throttle and was not trimmed…
    const consulted = acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-consulted' }), 'demo', undefined, undefined, chokepointSetup(),
    );
    // …and a defined-risk spread, which consults nothing at any scope.
    const spread = acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup);
    expect(consulted).not.toBeNull();
    expect(spread).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);

    // Every field a pre-TRA-2375 grade could partition on reads IDENTICALLY.
    // This is the whole bug: there is no failing state to notice.
    expect(rows.every((r) => r.riskThrottleMultiplier === 1)).toBe(true);
    expect(rows.every((r) => r.riskThrottleDecided === 1)).toBe(true);
    expect(new Set(rows.map((r) => r.riskThrottleArmedScope)).size).toBe(1);

    // So the naive control arm swallows both — one of them a trade the throttle
    // could never have touched.
    const naiveControl = rows.filter((r) => r.riskThrottleDecided === 1);
    expect(naiveControl).toHaveLength(2);

    // The path stamp is the only thing that separates them.
    const trueControl = rows.filter((r) => eligible(r) && r.riskThrottleMultiplier === 1);
    expect(trueControl).toHaveLength(1);
    expect(trueControl[0]!.id).toBe(consulted!.id);
  });

  it('ABSENT (pre-TRA-2375 build) stays distinguishable from a written null', async () => {
    // A row exactly as an older build wrote it: both throttle terms stamped, no
    // chokepoint identity. It must NOT read as "out of cohort" — that would let a
    // regressed or rolled-back writer hide inside the out-of-cohort population
    // and silently shrink the eligible set with no tell.
    await recordOptionTradeOpen({
      id: 'pre-2375',
      openTs: TRADING_TIME,
      symbol: 'AAPL',
      structure: 'single_leg_rv',
      mode: 'demo',
      ivRank: 30,
      trend: 'up',
      sentiment: null,
      sentimentIcBand: null,
      entryDelta: 0.35,
      entryDte: 30,
      atRiskUsd: 100,
      agentConviction: null,
      riskThrottleMultiplier: 1,
      riskThrottleDecided: 1,
    });

    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-current' }), 'demo', undefined, undefined, chokepointSetup(),
    );
    expect(acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    const old = rows.find((r) => r.id === 'pre-2375')!;
    const current = rows.find((r) => r.id !== 'pre-2375' && r.structure === 'single_leg_rv')!;
    const outOfCohort = rows.find((r) => r.structure === 'bull_put')!;

    // THREE states, and every pair of them is distinguishable.
    expect(stamps(old)).toBe(false); // absent  ⇒ basis unknown
    expect(stamps(outOfCohort)).toBe(true); // null ⇒ known: not a chokepoint
    expect(outOfCohort.riskThrottleSizingPath).toBeNull();
    expect(stamps(current)).toBe(true); // a path ⇒ known: in cohort
    expect(current.riskThrottleSizingPath).toBe('options_single_leg');

    // And the one collapse that must never happen: an old row is not eligible,
    // but it is also NOT the same thing as a known-ineligible one.
    expect(eligible(old)).toBe(false);
    expect(eligible(outOfCohort)).toBe(false);
    expect(stamps(old)).not.toBe(stamps(outOfCohort));

    // A bare `isThrottleChokepoint: boolean` would have merged the first two
    // under `?? false`. Reading the field as a boolean reproduces that collapse
    // exactly — which is why the field is an identity, not a flag.
    const asBoolean = (r: OptionTradeJournalRecord): boolean => Boolean(r.riskThrottleSizingPath);
    expect(asBoolean(old)).toBe(asBoolean(outOfCohort)); // indistinguishable again
  });

  it('the null survives the JSONL round trip (it is a written value, not a dropped key)', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    expect(acct.openDefinedRiskSpread(spreadParams(), 'demo', undefined, setup)).not.toBeNull();
    acct.openOptionFromRvCandidate(
      buildRvSignal({ id: 'rv-rt' }), 'demo', undefined, undefined, chokepointSetup(),
    );
    await acct.flushOptionTradeJournal();

    // Drop the in-memory cache and re-read from disk. `undefined` would not have
    // survived JSON.stringify — the key would come back ABSENT and every
    // non-chokepoint row would silently rejoin the "old build" population after
    // the next restart, with the in-process test still green.
    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    const reread = rows.find((r) => r.structure === 'bull_put')!;
    expect(stamps(reread)).toBe(true);
    expect(reread.riskThrottleSizingPath).toBeNull();
    expect(rows.find((r) => r.structure === 'single_leg_rv')!.riskThrottleSizingPath)
      .toBe('options_single_leg');
  });
});
