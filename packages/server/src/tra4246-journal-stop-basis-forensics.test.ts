/**
 * TRA-4246 — the journal must publish the forensics a `profit_lock` verdict is
 * graded on, instead of making every reader re-derive them off a constant that
 * describes a different sleeve.
 *
 * Four things are pinned here, in the order the ticket asks for them:
 *
 *  AC1 the close row's OWN stop-basis R, from the `stopLossPremium` the exit
 *      evaluation consumed — and a NULL WITH A REASON where the stop is
 *      unarmed or degenerate, never a defaulted number;
 *  AC2 the give-back decision's own operands at the fire (`armed`, the peak it
 *      consumed, `peakR`, `giveBackR`, the stop-basis risk unit), so
 *      level-vs-fill slip is a READ;
 *  AC3 the divisor, measured per row and folded per cell, beside — never
 *      instead of — the gate's constant, with `unanimous:false` where no single
 *      divisor describes a cell;
 *  AC4 a supersede that changes a row's headline `exitReason` is NAMED on the
 *      sleeve surface, so a `byExitReason` fold cannot silently attribute a
 *      stop fire to the give-back rule.
 *
 * The numbers in the AC1/AC3 cases are the live ones from the TRA-4243 pin:
 * `NOK261002C00010500` read `premiumPaid 0.57`, `stopLossPremium 0.456`,
 * `peakPremium 0.665` on `/api/state` — a 0.114 risk unit and a **5×**
 * premium→stop-basis divisor, against the `gateRPerPremiumR: 4` the sleeve cell
 * published. That 4-vs-5 is the 20% understatement in the CFO's give-back
 * table, and it is what the `unanimous` flag exists to catch the next time.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { rm } from 'node:fs/promises';
import { computeOptionStopBasisR } from './option-stop-basis-r.js';
import { foldOptionSleeveCells } from './option-journal-sleeve-cells.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { rowFromJournalRecord } from './export-history.js';
import { PaperOptionsAccount, type OptionExitRiskInput } from './options-account.js';
import { profitLockDecision } from '@trading-app/engine';
import type { OtmMispricingSignal } from '@trading-app/shared';

// ── AC1 ──────────────────────────────────────────────────────────────────────

describe('TRA-4246 AC1 — the close row computes stop-basis R off the row\'s own stop', () => {
  it('divides by |premiumPaid - stopLossPremium| x contracts x 100, not by the premium', () => {
    // NOK, live operands. Risk unit 0.114/share x 2 contracts x 100 = $22.80.
    const r = computeOptionStopBasisR({
      premiumPaid: 0.57,
      stopLossPremium: 0.456,
      contracts: 2,
      realizedPnlUsd: -11.4,
    });
    expect(r.pnlRStopBasis).toBe(-0.5);
    expect(r.reason).toBeUndefined();
    expect(r.stopBasisPremium).toBeCloseTo(0.114, 12);
    // AC3, per row: 0.57 / 0.114 = 5. The gate's constant is 4. If this ever
    // reads 4 the sleeve stop has moved to 0.25 and every give-back magnitude
    // graded against the old divisor is 25% out.
    expect(r.stopBasisRPerPremiumR).toBeCloseTo(5, 12);
  });

  it('the premium basis and the stop basis are DIFFERENT numbers on the same row', () => {
    // The whole point of the column. Premium R = -11.4 / (0.57 x 2 x 100) = -0.1.
    const stop = computeOptionStopBasisR({
      premiumPaid: 0.57,
      stopLossPremium: 0.456,
      contracts: 2,
      realizedPnlUsd: -11.4,
    });
    const premiumR = -11.4 / (0.57 * 2 * 100);
    expect(premiumR).toBeCloseTo(-0.1, 12);
    expect(stop.pnlRStopBasis).toBe(-0.5);
    // ...and they differ by EXACTLY the row's own divisor, which is the
    // identity a reader may now use instead of the cell constant.
    expect((stop.pnlRStopBasis as number) / premiumR).toBeCloseTo(
      stop.stopBasisRPerPremiumR as number,
      9,
    );
  });

  it('the `stopLossPremium: 0` sentinel yields NULL + a reason, never a number', () => {
    // An unauthorized adopted lot carries the sentinel. A distance measured off
    // it equals the PREMIUM basis exactly, so a defaulted number here would
    // read as a coincidence rather than as "this row had no stop".
    const r = computeOptionStopBasisR({
      premiumPaid: 0.57,
      stopLossPremium: 0,
      contracts: 2,
      realizedPnlUsd: -11.4,
    });
    expect(r.pnlRStopBasis).toBeNull();
    expect(r.reason).toBe('stop_unarmed');
    expect(r.stopBasisPremium).toBeUndefined();
    expect(r.stopBasisRPerPremiumR).toBeUndefined();
  });

  it('a stop AT the basis is `nonpositive_r`, not +/-Infinity', () => {
    const r = computeOptionStopBasisR({
      premiumPaid: 0.57,
      stopLossPremium: 0.57,
      contracts: 2,
      realizedPnlUsd: -11.4,
    });
    expect(r.pnlRStopBasis).toBeNull();
    expect(r.reason).toBe('nonpositive_r');
  });

  it('an unmeasured P&L keeps the DIVISOR (the risk unit is known) and nulls only the quotient', () => {
    const r = computeOptionStopBasisR({
      premiumPaid: 0.57,
      stopLossPremium: 0.456,
      contracts: 2,
      realizedPnlUsd: undefined,
    });
    expect(r.pnlRStopBasis).toBeNull();
    expect(r.reason).toBe('pnl_unknown');
    expect(r.stopBasisRPerPremiumR).toBeCloseTo(5, 12);
  });

  it('a missing basis is `basis_unknown`, and an unarmed stop OUTRANKS it', () => {
    expect(computeOptionStopBasisR({
      premiumPaid: undefined, stopLossPremium: 0.456, contracts: 2, realizedPnlUsd: -1,
    }).reason).toBe('basis_unknown');
    // Both broken: "no stop" is the fact an operator acts on.
    expect(computeOptionStopBasisR({
      premiumPaid: undefined, stopLossPremium: 0, contracts: 2, realizedPnlUsd: -1,
    }).reason).toBe('stop_unarmed');
  });
});

// ── AC1, END TO END: book → journal close row → /api/trades/export ──────────
//
// The unit cases above prove the arithmetic. THIS proves the plumbing, which is
// where the defect actually lived: `optionStopRiskUsd` has computed the right
// figure for book-served rows all along, and the export still published
// `pnl_r_stop_basis: null` on 106 of 106 rows — because the archive is
// journal-served and the journal dropped the stop at the close.
//
// ETHA geometry, verbatim from `tra4317-profit-lock-level-publication.test.ts`:
// entry 1.28 → stopLossPremium 1.024 (the −20% OTM stop) → R = 0.256/share.

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const MIN = 60_000;
const ENTRY = 1.28;
const R_UNIT = 0.256;

const JOURNAL_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};
// TRA-4440 — underscore-prefixed, not deleted: this fixture is never passed to a
// call in this file (the cases below build their risk input inline). Kept because it
// records the shape the forensics were taken against; if a case ever needs the
// give-back risk operands, this is the fixture it should use.
const _RISK: OptionExitRiskInput = { underlyingAtrBySymbol: new Map(), openingRangeGuardMin: 15 };

function buildSignal(): OtmMispricingSignal {
  return {
    id: 'sig-4246',
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
  } as OtmMispricingSignal;
}

describe('TRA-4246 AC1 end-to-end — the stop survives the close and reaches the export', () => {
  let tmpFile: string;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(TRADING_TIME);
    tmpFile = join(tmpdir(), `tra4246-journal-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
    setOptionTradeJournalFileForTests(tmpFile);
  });

  afterEach(async () => {
    vi.useRealTimers();
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    setOptionTradeJournalFileForTests(null);
    await rm(tmpFile, { force: true });
  });

  it('the close row carries the row\'s own R and divisor, and `pnl_r_stop_basis` stops being null', async () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      holdLiveOptionsOvernightForPdt: false,
    });
    const pos = acct.openOptionFromCandidate(buildSignal(), 'live', 50_000, undefined, JOURNAL_SETUP);
    expect(pos).not.toBeNull();
    // The sleeve's own stop: 1.024, i.e. entry x 0.80. The gate's model would
    // be entry x 0.75 = 0.96 -- the 4-vs-5 divergence, right here on the row.
    expect(pos!.stopLossPremium).toBeCloseTo(1.024, 9);

    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    const finalised = acct.closeOption(pos!.id, 1.408, 'manual');
    expect(finalised).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const rec = rows[0]!;
    expect(rec.outcome).not.toBe('OPEN');

    // +0.128/share on a 0.256 risk unit = +0.5R stop basis, on whatever
    // contract count the sizer chose -- the quotient is scale-free.
    expect(rec.pnlRStopBasis).toBeCloseTo(0.5, 6);
    expect(rec.pnlRStopBasisReason).toBeUndefined();
    expect(rec.stopBasisPremium).toBeCloseTo(R_UNIT, 9);
    // AC3 per row: 1.28 / 0.256 = 5.0. NOT the cell's gate constant of 4.
    expect(rec.stopBasisRPerPremiumR).toBeCloseTo(5, 9);

    // And the premium basis is a DIFFERENT number on the same row: +0.1R.
    expect(rec.realizedR).toBeCloseTo(0.1, 6);

    // The archive-served export row now publishes it. This assertion is the
    // one that was 0-of-106 before this ticket.
    const exported = rowFromJournalRecord(rec);
    expect(exported.pnl_r_stop_basis).toBeCloseTo(0.5, 6);
    expect(exported.pnl_r).toBeCloseTo(0.1, 6);
  });

  it('a row whose stop is the `0` sentinel exports NULL and says WHY on the record', async () => {
    const acct = new PaperOptionsAccount({
      initialEquity: 50_000,
      managedAccountRatio: 0.5,
      holdLiveOptionsOvernightForPdt: false,
    });
    const pos = acct.openOptionFromCandidate(buildSignal(), 'live', 50_000, undefined, JOURNAL_SETUP);
    // The unauthorized-adopted-lot shape: no stop at all.
    acct.getState().openOptions[0]!.stopLossPremium = 0;
    vi.setSystemTime(TRADING_TIME + 1 * MIN);
    expect(acct.closeOption(pos!.id, 1.408, 'manual')).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rec = (await listOptionTradeJournal())[0]!;
    // ⛔ Not `0.1` (the premium basis by coincidence) and not a defaulted 0.
    expect(rec.pnlRStopBasis).toBeNull();
    expect(rec.pnlRStopBasisReason).toBe('stop_unarmed');
    expect(rec.stopBasisRPerPremiumR).toBeUndefined();
    expect(rowFromJournalRecord(rec).pnl_r_stop_basis).toBeNull();
  });
});

// ── AC2 ──────────────────────────────────────────────────────────────────────

describe('TRA-4246 AC2 — the give-back decision publishes its own operands', () => {
  it('every field the journal stamp needs comes off ONE decision, not a constant', () => {
    // NOK's live arm: entry 0.57, stop 0.456 (R = 0.114), peak 0.665.
    const d = profitLockDecision({
      side: 'buy', entry: 0.57, initialStop: 0.456, peakPrice: 0.665, currentPrice: 0.60,
    });
    expect(d.armed).toBe(true);
    expect(d.R).toBeCloseTo(0.114, 12);
    // peakR = (0.665 - 0.57) / 0.114 = +0.8333R -- the figure QuantTrader had
    // to compute by hand off `/api/state` because no close row carried it.
    expect(d.peakR).toBeCloseTo(0.8333333333, 8);
    const levelR = d.floor?.exitLevelR ?? d.peakR - d.giveBackR;
    const levelPremium = 0.57 + levelR * d.R;
    // The release level: +0.4333R stop-basis = 0.6194 in premium terms.
    expect(levelR).toBeCloseTo(0.4333333333, 8);
    expect(levelPremium).toBeCloseTo(0.6194, 4);
  });

  it('a degenerate risk unit reports armed:false with R = 0 — the stamp can say so', () => {
    // This is the shape that makes `armed` worth publishing: a `profit_lock`
    // label on a row whose decision could not arm is a RELABEL, not a release.
    const d = profitLockDecision({
      side: 'buy', entry: 0.57, initialStop: 0.57, peakPrice: 1.2, currentPrice: 0.6,
    });
    expect(d.R).toBe(0);
    expect(d.armed).toBe(false);
    expect(d.shouldExit).toBe(false);
  });
});

// ── AC3 / AC4 — the sleeve surface ───────────────────────────────────────────

let seq = 0;
function closedRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  seq += 1;
  return {
    id: `row-${seq}`,
    symbol: 'NOK',
    optionSymbol: `NOK261002C0001050${seq}`,
    mode: 'live',
    account: 'desk',
    structure: 'single_leg_otm',
    entryArchetype: undefined,
    contracts: 2,
    openTs: Date.UTC(2026, 7, 28, 14, 35),
    outcome: 'LOSS',
    closeTs: Date.UTC(2026, 7, 31, 19, 0),
    realizedPnlUsd: -11.4,
    realizedR: -0.1,
    exitReason: 'profit_lock',
    holdDays: 3,
    ...over,
  } as unknown as OptionTradeJournalRecord;
}

describe('TRA-4246 AC3 — the cell publishes a MEASURED divisor beside the gate constant', () => {
  it('folds the rows\' own divisors and marks a single-stop cell unanimous', () => {
    const grid = foldOptionSleeveCells([
      closedRow({ stopBasisRPerPremiumR: 5 }),
      closedRow({ stopBasisRPerPremiumR: 5 }),
    ]);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
    )!;
    // The gate constant is UNCHANGED -- it is correct about the gate, and this
    // ticket does not move it. What changes is that it is no longer the only
    // divisor on the wire.
    expect(cell.gateRPerPremiumR).toBe(4);
    expect(cell.stopRPerPremiumR).not.toBeNull();
    expect(cell.stopRPerPremiumR!.n).toBe(2);
    expect(cell.stopRPerPremiumR!.median).toBe(5);
    expect(cell.stopRPerPremiumR!.unanimous).toBe(true);
    // And the two disagree by exactly the 20% the TRA-4243 table was out by.
    expect(cell.gateRPerPremiumR! / cell.stopRPerPremiumR!.median).toBeCloseTo(0.8, 12);
  });

  it('a cell spanning two stop rules is NOT unanimous and publishes no single divisor as truth', () => {
    const grid = foldOptionSleeveCells([
      closedRow({ stopBasisRPerPremiumR: 5 }),
      closedRow({ stopBasisRPerPremiumR: 4 }),
    ]);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
    )!;
    expect(cell.stopRPerPremiumR!.unanimous).toBe(false);
    expect(cell.stopRPerPremiumR!.min).toBe(4);
    expect(cell.stopRPerPremiumR!.max).toBe(5);
    // Lower median at even n -- a divisor a row actually carried. An
    // interpolated 4.5 is a conversion factor no sleeve in this book uses.
    expect(cell.stopRPerPremiumR!.median).toBe(4);
  });

  it('rows carrying no divisor make the field NULL, never the gate constant by default', () => {
    const grid = foldOptionSleeveCells([closedRow(), closedRow()]);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
    )!;
    expect(cell.stopRPerPremiumR).toBeNull();
    expect(cell.gateRPerPremiumR).toBe(4);
  });

  it('`missing` is published so `n` is read against its own denominator', () => {
    const grid = foldOptionSleeveCells([
      closedRow({ stopBasisRPerPremiumR: 5 }),
      closedRow(),
      closedRow(),
    ]);
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
    )!;
    expect(cell.stopRPerPremiumR!.n).toBe(1);
    expect(cell.stopRPerPremiumR!.missing).toBe(2);
  });
});

describe('TRA-4246 AC4 — a supersede that changes the headline reason is NAMED', () => {
  it('the RIG shape: `byExitReason` counts profit_lock, and the surface says which row is a relabel', () => {
    // RIG260925C00006000 closed 2026-08-24 under `sl_otm_premium_pct` (broker
    // 143048620, a filled sell). The 08-26 supersede replaced it with a
    // DIFFERENT filled sell's close and the headline became `profit_lock` --
    // so a -2.31R STOP landed in the give-back population.
    const rig = closedRow({
      optionSymbol: 'RIG260925C00006000',
      exitReason: 'profit_lock',
      brokerOrderId: 143384264,
      realizedR: -2.31,
      supersededCloses: [{
        closeTs: Date.UTC(2026, 7, 24, 19, 31),
        outcome: 'LOSS',
        realizedPnlUsd: -15.24,
        realizedR: -2.31,
        exitReason: 'sl_otm_premium_pct',
        brokerOrderId: 143048620,
        supersededAt: Date.UTC(2026, 7, 26, 13, 45, 31),
        reason: 'engine_close_on_already_closed_row',
      }],
    });
    const grid = foldOptionSleeveCells([rig, closedRow()]);

    // The fold is UNCHANGED -- the row is still counted where its headline
    // says. This AC does not silently re-attribute anything; it publishes the
    // fact that the headline was written by a supersede.
    const cell = grid.cells.find(
      (c) => c.accountClass === 'desk' && c.structure === 'single_leg_otm',
    )!;
    expect(cell.byExitReason.find((s) => s.exitReason === 'profit_lock')!.closed).toBe(2);

    expect(grid.exitReasonSupersedes).toHaveLength(1);
    const s = grid.exitReasonSupersedes[0]!;
    expect(s.optionSymbol).toBe('RIG260925C00006000');
    expect(s.headlineExitReason).toBe('profit_lock');
    expect(s.supersededExitReason).toBe('sl_otm_premium_pct');
    // Both broker orders, because "which fill realized this P&L" is the
    // question TRA-4241 keys its refusal on and a reader must be able to ask it.
    expect(s.headlineBrokerOrderId).toBe(143384264);
    expect(s.supersededBrokerOrderId).toBe(143048620);
    expect(s.supersedeReason).toBe('engine_close_on_already_closed_row');
  });

  it('a supersede that did NOT change the label is not listed — there is nothing to correct', () => {
    const row = closedRow({
      exitReason: 'profit_lock',
      supersededCloses: [{
        closeTs: Date.UTC(2026, 7, 24, 19, 31),
        outcome: 'LOSS',
        realizedPnlUsd: -1,
        realizedR: -0.1,
        exitReason: 'profit_lock',
        brokerOrderId: 1,
        supersededAt: Date.UTC(2026, 7, 26, 13, 45),
        reason: 'engine_close_on_already_closed_row',
      }],
    });
    expect(foldOptionSleeveCells([row]).exitReasonSupersedes).toHaveLength(0);
  });

  it('an ordinary row contributes nothing to the list', () => {
    expect(foldOptionSleeveCells([closedRow(), closedRow()]).exitReasonSupersedes)
      .toHaveLength(0);
  });
});
