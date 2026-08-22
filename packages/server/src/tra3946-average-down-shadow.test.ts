// TRA-3946 (parent TRA-3907, board card `eefc204e` accepted 2026-08-22T04:21Z)
// — average-down PHASE 1: the observe-only shadow.
//
// ⛔ Nothing in this file, and nothing in the code it exercises, places an
// order. The negative control at the bottom is the point: with the flag ON, a
// row INSIDE the band, tier `in_band`, day 2, inside the add window, 30 DTE and
// every cap clear — the verdict is `wouldAdd` and the broker buy seam
// (`submitSmartBuyToOpen`, the ONLY `buy_to_open` path on the live book) has
// ZERO calls, the book has the same one row, and that row has the same
// contracts.
//
// Order of the file:
//   1. the flag resolver — default OFF, `env`, `env_invalid`
//   2. the ORIGINAL basis — a blended `premiumPaid` is NOT the band's basis
//   3. the pure evaluator — every reason reachable, `rule_off` ≠ `confidence_low`
//   4. the account hook — MAE + verdicts reach the durable journal, counts are
//      per ROW, MAE survives a simulated restart
//   5. the drift grader — an `engine_average_down` lot is not `excess`
//   6. the negative control
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import type { OptionPosition, OtmMispricingSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

vi.mock('./tradier-smart-open.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tradier-smart-open.js')>();
  return { ...actual, submitSmartBuyToOpen: vi.fn(actual.submitSmartBuyToOpen) };
});

import { submitSmartBuyToOpen } from './tradier-smart-open.js';
import {
  resolveAverageDownConfig,
  resolveAverageDownOriginalBasis,
  evaluateAverageDownShadow,
  foldAverageDownMae,
  AVERAGE_DOWN_SHADOW_REASONS,
  AVERAGE_DOWN_MAE_PERSIST_STEP,
  OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR,
  type AverageDownConfig,
  type AverageDownShadowInput,
  type AverageDownShadowReason,
} from './option-average-down-shadow.js';
import {
  listOptionTradeJournal,
  getOptionTradeJournalRecord,
  setOptionTradeJournalFileForTests,
  summarizeOptionJournalAverageDown,
  recordOptionTradeMae,
} from './option-trade-journal.js';
import { PaperOptionsAccount, type OptionTradeJournalSetup } from './options-account.js';
import { diffLiveBrokerPositions, isEngineManagedRow, DRIFT_MIN_ROW_AGE_MS } from './live-broker-position-drift.js';

// ── clocks ──────────────────────────────────────────────────────────────────
// Wednesday 2024-06-05, 11:00 ET (15:00Z under EDT): inside RTH, past the
// 15-min opening range, far from the 30-min close window. Day 2 is the same
// wall-clock on Thursday.
const D1_OPEN = Date.parse('2024-06-05T13:30:00.000Z');
const D1_MIDDAY = D1_OPEN + 90 * 60_000;
const D2_MIDDAY = D1_MIDDAY + 24 * 60 * 60_000;
const D2_OPEN_PLUS_5 = D1_OPEN + 24 * 60 * 60_000 + 5 * 60_000;
const D2_CLOSE_MINUS_10 = D1_OPEN + 24 * 60 * 60_000 + (390 - 10) * 60_000;
const D2_PRE_OPEN = D1_OPEN + 24 * 60 * 60_000 - 30 * 60_000;

const DAILY_CLOSE = { policy: 'daily_close' as const, closeWindowMin: 30, catastrophicLossPct: 0.5 };
const BAG = { liveStopPolicy: DAILY_CLOSE, openingRangeHoldMin: 15 };

const CONFIG_OFF: AverageDownConfig = resolveAverageDownConfig({});
const CONFIG_ON: AverageDownConfig = resolveAverageDownConfig({ [OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR]: '1' });

function row(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'row-1',
    symbol: 'AAPL',
    optionSymbol: 'AAPL240705C00200000',
    optionType: 'call',
    strike: 200,
    expiration: '2024-07-05',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: 1.0,
    currentPremium: 1.0,
    stopLossPremium: 0.8,
    peakPremium: 1.0,
    trailingActive: false,
    trailingStopPremium: 0,
    tp1Premium: 1.5,
    underlyingEntryPrice: 200,
    openedAt: D1_MIDDAY,
    signalId: 'sig-1',
    signalType: 'otm_mispricing',
    mode: 'live',
    entryNominatorSelection: 'in_band',
    ...over,
  } as unknown as OptionPosition;
}

/** Day 2, 11:00 ET, flag ON, a $100 book, the compiled $300/$500 ceiling. */
function input(over: Partial<AverageDownShadowInput> = {}): AverageDownShadowInput {
  return {
    mark: 0.85,
    now: D2_MIDDAY,
    nowEtDay: '2024-06-06',
    openedEtDay: '2024-06-05',
    minutesSinceRthOpen: 90,
    openingRangeMin: 15,
    closeWindowMin: 30,
    bookAtRiskUsd: 100,
    ceiling: { perOrderUsd: 300, aggregateUsd: 500 },
    config: CONFIG_ON,
    ...over,
  };
}

// ── 1. the resolver ─────────────────────────────────────────────────────────
describe('TRA-3946 — resolveAverageDownConfig', () => {
  it('defaults OFF with the ratified knobs, and says the value is a default', () => {
    expect(CONFIG_OFF).toMatchObject({
      enabled: false, source: 'default',
      bandMinPct: 0.10, bandMaxPct: 0.18, maxAddUsd: 150, maxRowUsd: 300, minDte: 21,
    });
  });

  it('reads process.env-shaped bags only — a deliberate ON/OFF reads `env`', () => {
    expect(resolveAverageDownConfig({ [OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR]: ' TRUE ' }))
      .toMatchObject({ enabled: true, source: 'env' });
    expect(resolveAverageDownConfig({ [OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR]: 'off' }))
      .toMatchObject({ enabled: false, source: 'env' });
  });

  it('a typo is OFF and VISIBLE (`env_invalid`), never a silent default', () => {
    expect(resolveAverageDownConfig({ [OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR]: 'enabled' }))
      .toMatchObject({ enabled: false, source: 'env_invalid' });
  });

  it('a knob may only tighten: an add cap above $150 falls back to $150', () => {
    expect(resolveAverageDownConfig({ OPTION_LIVE_AVERAGE_DOWN_MAX_ADD_USD: '900' }).maxAddUsd).toBe(150);
    expect(resolveAverageDownConfig({ OPTION_LIVE_AVERAGE_DOWN_MAX_ADD_USD: '75' }).maxAddUsd).toBe(75);
  });
});

// ── 2. the ORIGINAL basis ───────────────────────────────────────────────────
describe('TRA-3946 — the band is tested against the ORIGINAL basis', () => {
  it('a row whose premiumPaid has been BLENDED still tests against the broker entry fill', () => {
    // P₀ = 1.00 (the engine's own fill). A desk add at 0.70 blended
    // `premiumPaid` down to 0.85 (the TRA-3895 shape). Mark 0.85:
    //   vs blended  ⇒ 0 %     ⇒ not in band  (the wrong answer)
    //   vs original ⇒ −15 %   ⇒ in band      (the right one)
    const blended = row({ premiumPaid: 0.85, brokerEntryFill: { premiumPaid: 1.0, contracts: 1, at: D1_MIDDAY } });
    expect(resolveAverageDownOriginalBasis(blended)).toEqual({ premium: 1.0, source: 'broker_entry_fill' });
    const v = evaluateAverageDownShadow(blended, input({ mark: 0.85 }));
    expect(v).not.toBeNull();
    expect(v!.basis.source).toBe('broker_entry_fill');
    expect(v!.frac).toBeCloseTo(-0.15, 9);
    expect(v!.inBand).toBe(true);
    // The control: the same row with the fill stamp REMOVED tests against the
    // blend and is NOT in band. This is the mutation the test exists to catch.
    const control = row({ premiumPaid: 0.85 });
    expect(evaluateAverageDownShadow(control, input({ mark: 0.85 }))!.inBand).toBe(false);
  });

  it('an operator pin outranks premiumPaid; premiumPaid is the last resort and is labelled', () => {
    expect(resolveAverageDownOriginalBasis(row({ premiumPaid: 1.41, operatorBasisPin: { premiumPaid: 1.17, contracts: 1, at: 'x', provenance: 'p' } })))
      .toEqual({ premium: 1.17, source: 'operator_pin' });
    expect(resolveAverageDownOriginalBasis(row({ premiumPaid: 1.41 }))).toEqual({ premium: 1.41, source: 'premium_paid' });
    expect(resolveAverageDownOriginalBasis(row({ premiumPaid: 0 }))).toBeNull();
  });
});

// ── 3. the pure evaluator ───────────────────────────────────────────────────
describe('TRA-3946 — evaluateAverageDownShadow: every reason is reachable', () => {
  const seen = new Set<AverageDownShadowReason>();
  const expectReason = (r: ReturnType<typeof evaluateAverageDownShadow>, reason: AverageDownShadowReason) => {
    expect(r).not.toBeNull();
    expect(r!.reason).toBe(reason);
    seen.add(reason);
  };

  it('wouldAdd: the fully cleared row', () => {
    const v = evaluateAverageDownShadow(row(), input());
    expectReason(v, 'wouldAdd');
    // 1 contract × 0.85 × 100 = $85 ≤ $150; row 100 + 85 ≤ 300; book 100 + 85 ≤ 500.
    expect(v!.addUsd).toBe(85);
    expect(v!.dte).toBe(29);
  });

  it('rule_off vs confidence_low are DISTINCT: the same in-band row lands on one or the other', () => {
    const off = evaluateAverageDownShadow(row({ entryNominatorSelection: 'legacy' }), input({ config: CONFIG_OFF }));
    expectReason(off, 'rule_off');
    const on = evaluateAverageDownShadow(row({ entryNominatorSelection: 'legacy' }), input());
    expectReason(on, 'confidence_low');
    // `fallback_top_mispricing` and an ABSENT stamp are both not band-admitted.
    expect(evaluateAverageDownShadow(row({ entryNominatorSelection: 'fallback_top_mispricing' }), input())!.reason).toBe('confidence_low');
    expect(evaluateAverageDownShadow(row({ entryNominatorSelection: undefined }), input())!.reason).toBe('confidence_low');
    // `in_band_fair` passes.
    expect(evaluateAverageDownShadow(row({ entryNominatorSelection: 'in_band_fair' }), input())!.reason).toBe('wouldAdd');
  });

  it('day1: opened this ET session', () => {
    expectReason(evaluateAverageDownShadow(row(), input({ openedEtDay: '2024-06-06' })), 'day1');
  });

  it('window: first 15 min, last 30 min, pre-open, and calendar failure all refuse', () => {
    expectReason(evaluateAverageDownShadow(row(), input({ minutesSinceRthOpen: 5 })), 'window');
    expect(evaluateAverageDownShadow(row(), input({ minutesSinceRthOpen: 380 }))!.reason).toBe('window');
    expect(evaluateAverageDownShadow(row(), input({ minutesSinceRthOpen: -30 }))!.reason).toBe('window');
    expect(evaluateAverageDownShadow(row(), input({ minutesSinceRthOpen: null }))!.reason).toBe('window');
    // The edges: minute 15 is IN; minute 360 (= 390 − 30) is OUT.
    expect(evaluateAverageDownShadow(row(), input({ minutesSinceRthOpen: 15 }))!.reason).toBe('wouldAdd');
    expect(evaluateAverageDownShadow(row(), input({ minutesSinceRthOpen: 360 }))!.reason).toBe('window');
  });

  it('dte: fewer than 21 days, or no expiration at all', () => {
    expectReason(evaluateAverageDownShadow(row({ expiration: '2024-06-21' }), input()), 'dte');
    expect(evaluateAverageDownShadow(row({ expiration: undefined }), input())!.reason).toBe('dte');
  });

  it('cap: per add, per row, per book, and an UNREADABLE ceiling — all fail closed', () => {
    // Per row: 3 contracts at P₀ 1.00 = $300 entry; any add breaches $300.
    expectReason(evaluateAverageDownShadow(row({ contracts: 3, contractsRemaining: 3 }), input()), 'cap');
    // Per book: $450 already at risk + $85 > $500.
    expect(evaluateAverageDownShadow(row(), input({ bookAtRiskUsd: 450 }))!.reason).toBe('cap');
    // Unreadable fold / ceiling.
    expect(evaluateAverageDownShadow(row(), input({ bookAtRiskUsd: null }))!.reason).toBe('cap');
    expect(evaluateAverageDownShadow(row(), input({ ceiling: null }))!.reason).toBe('cap');
    // The add is sized in WHOLE contracts against the tightest residual budget:
    //   2 contracts at P₀ 0.50 = $100 entry; budget = min(150, 300−100, 300, 500−100) = $150;
    //   mark 0.425 ⇒ $42.50/contract ⇒ floor(150/42.5) = 3, clamped to the row's 2 ⇒ $85.
    expect(evaluateAverageDownShadow(row({ contracts: 2, contractsRemaining: 2, premiumPaid: 0.5 }), input({ mark: 0.425 })))
      .toMatchObject({ reason: 'wouldAdd', addUsd: 85 });
    //   1 contract at P₀ 2.50 = $250 entry (the live sleeve's ~$250 row); budget = 300−250 = $50;
    //   mark 2.125 ⇒ $212.50/contract ⇒ 0 contracts ⇒ cap. The $300/row ceiling binds the live book.
    expect(evaluateAverageDownShadow(row({ premiumPaid: 2.5 }), input({ mark: 2.125 }))!.reason).toBe('cap');
    //   2 contracts at P₀ 1.00 = $200; budget = min(150, 100, …) = $100; mark 0.85 ⇒ 1 contract ⇒ $85.
    expect(evaluateAverageDownShadow(row({ contracts: 2, contractsRemaining: 2 }), input())).toMatchObject({ reason: 'wouldAdd', addUsd: 85 });
  });

  it('band: below −18 % is recorded as past the add point; above −10 % is not a candidate', () => {
    expectReason(evaluateAverageDownShadow(row(), input({ mark: 0.75 })), 'band');
    const above = evaluateAverageDownShadow(row(), input({ mark: 0.95 }));
    expect(above!.inBand).toBe(false);
    expect(above!.reason).toBeNull();
    // Edges of the band, inclusive.
    expect(evaluateAverageDownShadow(row(), input({ mark: 0.90 }))!.inBand).toBe(true);
    expect(evaluateAverageDownShadow(row(), input({ mark: 0.82 }))!.inBand).toBe(true);
  });

  it('every reason in AVERAGE_DOWN_SHADOW_REASONS was reached above', () => {
    for (const r of AVERAGE_DOWN_SHADOW_REASONS) expect(seen.has(r), r).toBe(true);
  });

  it('foldAverageDownMae: monotone min, first observation persists, later ones on the step', () => {
    const r = row();
    const first = foldAverageDownMae(r, 1.02, D1_MIDDAY)!;
    expect(first.persist).toBe(true);
    expect(first.next.frac).toBeCloseTo(0.02, 9);
    r.averageDownMae = first.next;
    // A HIGHER mark never moves the min.
    const higher = foldAverageDownMae(r, 1.10, D1_MIDDAY + 1)!;
    expect(higher.next.frac).toBeCloseTo(0.02, 9);
    expect(higher.persist).toBe(false);
    // A drop smaller than the step updates memory but not the store.
    const small = foldAverageDownMae(r, 1.02 - AVERAGE_DOWN_MAE_PERSIST_STEP / 2, D1_MIDDAY + 2)!;
    expect(small.next.frac).toBeLessThan(0.02);
    expect(small.persist).toBe(false);
    r.averageDownMae = small.next;
    // A drop past the step persists.
    const big = foldAverageDownMae(r, 0.90, D1_MIDDAY + 3)!;
    expect(big.next).toMatchObject({ frac: expect.closeTo(-0.10, 9), mark: 0.90, at: D1_MIDDAY + 3, basisSource: 'premium_paid' });
    expect(big.persist).toBe(true);
  });
});

// ── 4. the account hook + the durable journal ───────────────────────────────
const SETUP: OptionTradeJournalSetup = {
  ivRank: 50, trend: 'up', sentiment: 0.2, sentimentIcBand: 'strong', agentConviction: 0.7, entryDelta: 0.18,
  riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: null,
};

function otmSignal(): OtmMispricingSignal {
  return {
    id: 'sig-otm-3946', symbol: 'AAPL', type: 'otm_mispricing', side: 'buy',
    entryPrice: 1.0, stopLoss: 0.75, takeProfit: 1.5, riskRewardRatio: 2, timestamp: D1_MIDDAY,
    optionSymbol: 'AAPL240705C00200000', optionType: 'call', strike: 200, expiration: '2024-07-05',
    mark: 1.0, theo: 1.30, mispricingPct: -0.23, delta: 0.18,
  };
}

let tmpFile: string;
let fileCounter = 0;

function liveBook() {
  const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5, holdLiveOptionsOvernightForPdt: true });
  // ONE contract (the bounded-live override), so entry = $100 and the $300/row
  // cap leaves a $150 budget — the cap test is then a genuine pass, not a
  // sizing accident.
  const pos = acct.openOptionFromCandidate(otmSignal(), 'live', 50_000, 200, SETUP, 1);
  expect(pos).not.toBeNull();
  expect(pos!.mode).toBe('live');
  expect(pos!.premiumPaid).toBeCloseTo(1.0, 9);
  expect(pos!.contracts).toBe(1);
  pos!.entryNominatorSelection = 'in_band';
  const sym = pos!.optionSymbol!;
  const tick = (mark: number) => acct.checkExits(new Map([['AAPL', 200]]), new Map([[sym, mark]]), 'live', BAG);
  const rowNow = () => acct.getState().openOptions.find((r) => r.id === pos!.id)!;
  return { acct, pos: pos!, tick, rowNow };
}

describe('TRA-3946 — the account hook writes the durable journal', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(D1_MIDDAY);
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    delete process.env[OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR];
    tmpFile = join(tmpdir(), `tra3946-journal-${process.pid}-${fileCounter++}.jsonl`);
    setOptionTradeJournalFileForTests(tmpFile);
    vi.mocked(submitSmartBuyToOpen).mockClear();
  });
  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    delete process.env[OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  it('MAE is a running min against the ORIGINAL basis, persisted on the step, and SURVIVES A RESTART', async () => {
    const { acct, pos, tick, rowNow } = liveBook();
    await acct.flushOptionTradeJournal();
    tick(1.02);
    tick(0.97);
    tick(0.93);
    tick(0.99); // a recovery never raises the min
    await acct.flushOptionTradeJournal();
    expect(rowNow().averageDownMae).toMatchObject({ frac: expect.closeTo(-0.07, 9), mark: 0.93, basisSource: 'premium_paid' });
    let rec = await getOptionTradeJournalRecord(pos.id);
    expect(rec?.mae).toMatchObject({ frac: expect.closeTo(-0.07, 9), mark: 0.93, basisPremium: 1.0 });

    // ── The simulated restart: drop the in-memory fold and the in-memory book,
    // re-point at the SAME file, replay. A since-boot fold would read 0 here.
    setOptionTradeJournalFileForTests(tmpFile);
    rec = await getOptionTradeJournalRecord(pos.id);
    expect(rec?.mae).toMatchObject({ frac: expect.closeTo(-0.07, 9), mark: 0.93 });
    // The raw tape holds the lines (no in-place rewrite anywhere).
    const kinds = readFileSync(tmpFile, 'utf-8').trim().split('\n').map((l) => (JSON.parse(l) as { kind: string }).kind);
    expect(kinds.filter((k) => k === 'mae').length).toBeGreaterThanOrEqual(2);
    // A replayed HIGHER value cannot raise it — the fold is a min.
    expect(await recordOptionTradeMae(pos.id, { frac: -0.01, mark: 0.99, at: D1_MIDDAY, basisPremium: 1.0, basisSource: 'premium_paid' })).toBe(false);
    expect((await getOptionTradeJournalRecord(pos.id))?.mae?.frac).toBeCloseTo(-0.07, 9);

    // The row-side twin rides the snapshot too.
    const snap = acct.exportSnapshot();
    const fresh = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    fresh.importSnapshot(snap);
    expect(fresh.getState().openOptions.find((r) => r.id === pos.id)?.averageDownMae?.frac).toBeCloseTo(-0.07, 9);
  });

  it('flag OFF: an in-band row is journalled `rule_off` — once per row, not once per tick', async () => {
    const { acct, pos, tick } = liveBook();
    vi.setSystemTime(D2_MIDDAY);
    tick(0.85);
    tick(0.86);
    tick(0.84);
    await acct.flushOptionTradeJournal();
    const rec = await getOptionTradeJournalRecord(pos.id);
    expect(rec?.averageDownShadow).toHaveLength(1);
    expect(rec!.averageDownShadow![0]).toMatchObject({ reason: 'rule_off', tier: 'in_band', frac: expect.closeTo(-0.15, 9), dte: 29 });
    const s = acct.averageDownShadowSinceBoot();
    expect(s.evaluations).toBe(3);
    expect(s.byReason.rule_off).toBe(3);
    expect(s.byReason.wouldAdd).toBe(0);
    const summary = summarizeOptionJournalAverageDown(await listOptionTradeJournal({ mode: 'live' }), AVERAGE_DOWN_SHADOW_REASONS);
    expect(summary).toMatchObject({ rowsTraversed: 1, wouldAdd: 0, blockedBy: { rule_off: 1, confidence_low: 0 }, rowsWithMae: 1 });
  });

  it('flag ON: day-1 / window / then wouldAdd — each reason ONE line, and the readout is per row', async () => {
    process.env[OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR] = '1';
    const { acct, pos, tick } = liveBook();
    tick(0.85);                              // day 1, in band
    vi.setSystemTime(D2_OPEN_PLUS_5); tick(0.85);   // day 2, opening range
    vi.setSystemTime(D2_CLOSE_MINUS_10); tick(0.85); // day 2, close window
    vi.setSystemTime(D2_PRE_OPEN); tick(0.85);       // day 2, pre-open
    vi.setSystemTime(D2_MIDDAY); tick(0.85); tick(0.86); // day 2, 11:00 ET ⇒ wouldAdd, twice
    await acct.flushOptionTradeJournal();
    const rec = await getOptionTradeJournalRecord(pos.id);
    expect(rec!.averageDownShadow!.map((s) => s.reason)).toEqual(['day1', 'window', 'wouldAdd']);
    expect(rec!.averageDownShadow![2]).toMatchObject({ addUsd: 85, tier: 'in_band' });
    const summary = summarizeOptionJournalAverageDown(await listOptionTradeJournal({ mode: 'live' }), AVERAGE_DOWN_SHADOW_REASONS);
    expect(summary.rowsTraversed).toBe(1);
    expect(summary.wouldAdd).toBe(1);
    expect(summary.blockedBy).toMatchObject({ day1: 1, window: 1, rule_off: 0, confidence_low: 0, dte: 0, cap: 0, band: 0 });
    expect(summary.firstVerdict.day1).toBe(1);
    // Since-boot counts EVALUATIONS (6), the journal counts the ROW (1).
    expect(acct.averageDownShadowSinceBoot().byReason.wouldAdd).toBe(2);
  });

  it('flag ON, tier absent: `confidence_low`, distinct from `rule_off` on the wire', async () => {
    process.env[OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR] = '1';
    const { acct, pos, tick, rowNow } = liveBook();
    rowNow().entryNominatorSelection = undefined;
    vi.setSystemTime(D2_MIDDAY);
    tick(0.85);
    await acct.flushOptionTradeJournal();
    expect((await getOptionTradeJournalRecord(pos.id))!.averageDownShadow![0]).toMatchObject({ reason: 'confidence_low', tier: null });
  });

  it('a DEMO row gets the MAE (the §5 mirror) but no shadow verdict', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, managedAccountRatio: 0.5 });
    const pos = acct.openOptionFromCandidate(otmSignal(), 'demo', undefined, 200, SETUP);
    expect(pos).not.toBeNull();
    vi.setSystemTime(D2_MIDDAY);
    acct.checkExits(new Map([['AAPL', 200]]), new Map([[pos!.optionSymbol!, 0.85]]), 'demo', BAG);
    await acct.flushOptionTradeJournal();
    const rec = await getOptionTradeJournalRecord(pos!.id);
    expect(rec?.mode).toBe('demo');
    expect(rec?.mae?.frac).toBeCloseTo(-0.15, 9);
    expect(rec?.averageDownShadow).toBeUndefined();
    expect(acct.averageDownShadowSinceBoot().evaluations).toBe(0);
  });

  // ── 6. the negative control ──────────────────────────────────────────────
  it('NEGATIVE CONTROL: flag ON, in band, tier in_band, verdict wouldAdd ⇒ the broker buy seam has ZERO calls and the book is unchanged', async () => {
    process.env[OPTION_LIVE_AVERAGE_DOWN_ENABLED_VAR] = '1';
    const { acct, pos, tick, rowNow } = liveBook();
    vi.setSystemTime(D2_MIDDAY);
    const rowsBefore = acct.getState().openOptions.length;
    const contractsBefore = rowNow().contracts;
    const exited = tick(0.85);
    await acct.flushOptionTradeJournal();
    // The verdict really was the permissive one — otherwise this control is vacuous.
    expect((await getOptionTradeJournalRecord(pos.id))!.averageDownShadow![0]!.reason).toBe('wouldAdd');
    expect(acct.averageDownShadowSinceBoot().byReason.wouldAdd).toBe(1);
    // …and nothing was bought, staged, or added.
    expect(vi.mocked(submitSmartBuyToOpen)).toHaveBeenCalledTimes(0);
    expect(acct.getState().openOptions.length).toBe(rowsBefore);
    expect(rowNow().contracts).toBe(contractsBefore);
    expect(rowNow().contractsRemaining).toBe(contractsBefore);
    expect(rowNow().addOrigin).toBeUndefined();
    expect(exited).toEqual([]);
    expect(rowNow().pendingExit).toBeUndefined();
    // The stop engine's inputs did not move: `premiumPaid` and the stop are byte-identical.
    expect(rowNow().premiumPaid).toBeCloseTo(1.0, 9);
    expect(rowNow().stopLossPremium).toBeCloseTo(0.8, 9);
  });
});

// ── 5. the drift grader ─────────────────────────────────────────────────────
describe('TRA-3946 — an engine_average_down lot is EXPECTED quantity, not excess', () => {
  const NOW = Date.parse('2026-08-24T18:00:00Z');
  const OLD = NOW - DRIFT_MIN_ROW_AGE_MS - 60_000;
  const OCC = 'PLTR260911C00170000';
  const lot = (over: Partial<OptionPosition> & { id: string }): OptionPosition => ({
    symbol: 'PLTR', optionSymbol: OCC, optionType: 'call', contracts: 1, contractsRemaining: 1,
    premiumPaid: 1.5, currentPremium: 1.3, stopLossPremium: 1.2, peakPremium: 1.5, trailingActive: false,
    trailingStopPremium: 0, tp1Premium: 2.2, underlyingEntryPrice: 170, openedAt: OLD,
    signalId: 'sig', signalType: 'otm_mispricing', mode: 'live', ...over,
  } as unknown as OptionPosition);
  const broker = (contracts: number) => ({
    ok: true as const,
    positions: [{ optionSymbol: OCC, underlying: 'PLTR', optionType: 'call', strike: 170, expiration: '2026-09-11', contracts, premiumPaid: 1.5, acquiredAt: OLD } as TradierOpenOptionPosition],
  });

  it('entry lot + engine add lot (own basis) vs broker 2 ⇒ clean', () => {
    const rows = [lot({ id: 'entry' }), lot({ id: 'add', premiumPaid: 1.3, addOrigin: 'engine_average_down' })];
    const report = diffLiveBrokerPositions(broker(2), rows, NOW);
    expect(report.status).toBe('clean');
    expect(report.excess).toEqual([]);
    expect(report.engineContractsChecked).toBe(2);
  });

  it('the same add lot after a re-adoption stamped it `unresolved` is STILL engine inventory', () => {
    const rows = [
      lot({ id: 'entry' }),
      lot({ id: 'add', premiumPaid: 1.3, addOrigin: 'engine_average_down', importedFromTradier: true, adoptionAuthority: 'unresolved' }),
    ];
    expect(isEngineManagedRow(rows[1]!)).toBe(true);
    expect(diffLiveBrokerPositions(broker(2), rows, NOW).status).toBe('clean');
  });

  it('CONTROL: without the provenance, the second contract IS excess (the TRA-3895 shape this field exists to prevent)', () => {
    const rows = [lot({ id: 'entry' })];
    const report = diffLiveBrokerPositions(broker(2), rows, NOW);
    expect(report.status).toBe('excess');
    expect(report.excessContracts).toBe(1);
    // And an `unresolved` import with NO addOrigin stays out of the denominator.
    const foreign = lot({ id: 'x', importedFromTradier: true, adoptionAuthority: 'unresolved' });
    expect(isEngineManagedRow(foreign)).toBe(false);
  });
});
