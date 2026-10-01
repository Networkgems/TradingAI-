// TRA-4947 — the THIRD close-basis treatment: no broker number AND the number
// already on the row is itself unbacked, so the honest write is nulls.
//
// Delegated out of TRA-4859; the ruling is TRA-3978 comment `821c3fef`. TRA-4857
// made the FORWARD path write `realizedPnlUsd: null` / `outcome: 'UNMEASURED'`
// for a `broker_reconcile` close with no `brokerOrderId`, but it is forward-only
// and there was no write path that could reach the rows already on the tape.
//
// ── The fixture is the real row ──────────────────────────────────────────────
//
// `ROW_34F1EE99` is transcribed field-for-field from the live plan on bqb1
// serving commit `faae9388`, read 2026-10-01T17:08Z via
// `POST /api/health/option-journal/close-basis-repair` (dry run). The ledger
// genuinely holds ZERO fills on `SOFI260925C00019000` — `[]`, measured — which
// is why the close-basis pass refuses it as `no_entry_fill_in_window` and why
// its journalled `0` was synthesised at `breakEvenFill = premiumPaid` rather
// than observed. `atRiskUsd 120.5` against a last mark of 0.865 is the ~$36.50
// of real loss TRA-3978 filed.
//
// ── What this suite exists to stop ──────────────────────────────────────────
//
// `7b2f9b50`. It dropped the `exitReason === 'broker_reconcile'` term from this
// predicate on a code-review ask ("`brokerOrderId === null` is strictly safer"),
// served bqb1 from 00:25:10Z to 00:37:17Z on 2026-09-25, and was reverted in
// `a73706dc`. `queueJournalClose` has 13 call sites and exactly 2 pass a
// `brokerOrderId`; the other 11 default to null while carrying a real
// `position.pnl`. MEASURED on the live tape the same day this suite was written:
// 18 of 27 closed live rows carry `broker_order_id: null`, so the widened form
// labels two thirds of the tape UNMEASURED — and forward-only, so every
// historical surface keeps reading normal while new closes stop landing.
//
// Four tests here are POSITIVE CONTROLS for that: each one goes red if a
// specific conjunct or exclusion is removed, and the comment on each says which
// edit it catches. They are not paraphrases of the implementation — each is
// built from a row shape that exists on the live tape.
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import {
  listOptionTradeJournal,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseBasis,
  recordOptionTradeCloseUnmeasured,
  getOptionTradeCloseUnmeasuredAmends,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalOpen,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  planCloseBasisRestate,
  isUnpricedReconcileClose,
  UNPRICEABLE_SKIP_REASONS,
} from './tra2819-close-basis-restate.js';

// ── fixtures ────────────────────────────────────────────────────────────────

const OCC = 'SOFI260925C00019000';
const TARGET = '34f1ee99-0207-4fb6-9884-cca2e5d47fdc';

/** The live row, transcribed. See the header for the provenance. */
function ROW_34F1EE99(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: TARGET,
    openTs: 1787322245307,
    closeTs: 1787578495545,
    symbol: 'SOFI',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'up',
    entryDelta: 0.52,
    entryDte: 7,
    atRiskUsd: 120.5,
    entrySlippageUsd: 0,
    optionSymbol: OCC,
    contracts: 1,
    entryMarkUsd: 1.205,
    account: 'admin',
    // The fabrication this ticket retracts: a flat 0 on a position last marked
    // 0.865 against a 1.205 basis.
    outcome: 'SCRATCH',
    realizedPnlUsd: 0,
    realizedR: 0,
    exitReason: 'broker_reconcile',
    brokerOrderId: null,
    holdDays: 2.96,
    ...over,
  } as OptionTradeJournalRecord;
}

function fill(over: Partial<LiveOptionFillRecord> & Pick<LiveOptionFillRecord, 'optionSymbol' | 'side' | 'ts' | 'contracts'>): LiveOptionFillRecord {
  return {
    mode: 'live',
    etDay: '2026-09-25',
    sleeve: 'single_leg_otm',
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: null,
    fees: null,
    feeSource: 'gainloss_derived',
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'fill',
    ...over,
  } as LiveOptionFillRecord;
}

/** The ledger as live holds it for this contract: EMPTY. Measured, not assumed. */
const NO_FILLS: LiveOptionFillRecord[] = [];

function planFor(rows: OptionTradeJournalRecord[], ledger = NO_FILLS) {
  const plan = planCloseBasisRestate(rows, ledger);
  return { plan, byId: new Map(plan.rows.map((r) => [r.id, r])) };
}

// ── the planner: the predicate ──────────────────────────────────────────────

describe('TRA-4947 planner — the third treatment fires on the conjunction and nothing else', () => {
  it('plans `unmeasure` on row 34f1ee99 with the honest-nulls payload and its authority', () => {
    const { plan, byId } = planFor([ROW_34F1EE99()]);
    expect(plan.counts).toEqual({ restate: 0, skip: 0, unmeasure: 1 });
    const r = byId.get(TARGET)!;
    expect(r.treatment).toBe('unmeasure');
    expect(r.skipReason).toBe('no_entry_fill_in_window');
    // Both conjuncts are PUBLISHED on the plan row. Before this ticket neither
    // was, so a reader outside the planner saw `undefined` for both and any AND
    // over them was vacuously true — the first attempt to grade this predicate
    // from the live plan "matched" all 32 rows on the `brokerOrderId` term.
    expect(r.exitReason).toBe('broker_reconcile');
    expect(r.brokerOrderId).toBeNull();
    // The audit record TRA-4859's AC2 is graded on: the authority, by name.
    expect(r.unmeasured?.issue).toContain('TRA-4859');
    expect(r.unmeasured?.issue).toContain('821c3fef');
    expect(r.unmeasured?.skipReason).toBe('no_entry_fill_in_window');
    expect(r.unmeasured?.reason).toContain('breakEvenFill');
    // It is NOT a restatement: there is no number to publish, so there must be
    // no `basis`, and `deltaUsd` must stay null rather than read 0.
    expect(r.basis).toBeUndefined();
    expect(r.realizedPnlUsdAfter).toBeNull();
    expect(r.deltaUsd).toBeNull();
    // ...and the pass's own headline must not absorb it as "moved the book by 0".
    expect(plan.netDeltaUsd).toBe(0);
  });

  it('POSITIVE CONTROL — spares the 11 call sites that book locally with no brokerOrderId', () => {
    // These are the shapes `7b2f9b50` swept: a real `position.pnl` from a local
    // close, with `brokerOrderId` defaulted to null because the call site never
    // had one. Live counterparts: `96b0dc72` (profit_lock, -7.00), `f3b34f34`
    // (manual, -68.24), `f5c27e1d` (sl, -115.00), `6bbc5d17`
    // (chandelier_daily_close, -3.00) — all `broker_order_id: null`, all with
    // `no_entry_fill_in_window`, all carrying real money.
    //
    // ⛔ GOES RED if the `exitReason === 'broker_reconcile'` conjunct is dropped.
    const locals = ['profit_lock', 'manual', 'sl', 'tp1', 'chandelier_daily_close', 'expired', 'assigned', 'called_away', 'partial_drain'];
    const rows = locals.map((exitReason, i) =>
      ROW_34F1EE99({
        id: `local-${exitReason}`,
        exitReason,
        brokerOrderId: null,
        realizedPnlUsd: -7 - i,
        realizedR: (-7 - i) / 120.5,
        outcome: 'LOSS',
      }),
    );
    const { plan } = planFor(rows);
    expect(plan.counts.unmeasure).toBe(0);
    expect(plan.counts.skip).toBe(locals.length);
    for (const r of plan.rows) {
      expect(r.treatment).toBe('skip');
      // The money each one carries survives untouched.
      expect(r.realizedPnlUsdBefore).not.toBeNull();
    }
  });

  it('POSITIVE CONTROL — spares a broker_reconcile close that DID find a fill (live a2f9c8cd)', () => {
    // The real second `broker_reconcile` row on the live tape:
    // `a2f9c8cd` / NOK261002C00010500, `broker_order_id 144350660`,
    // `net_pnl_usd -22.50`. Measured 2026-10-01T17:08Z. Its figure WAS priced
    // against a fill, so it must keep it — this is the row the TRA-4857 commit
    // message named as the one the conjunction has to spare.
    //
    // ⛔ GOES RED if the `brokerOrderId == null` conjunct is dropped.
    const { plan, byId } = planFor([
      ROW_34F1EE99({
        id: 'a2f9c8cd-b174-46e3-b183-028b0ecc7ca9',
        symbol: 'NOK',
        optionSymbol: 'NOK261002C00010500',
        atRiskUsd: 57,
        exitReason: 'broker_reconcile',
        brokerOrderId: 144350660,
        realizedPnlUsd: -22.499999999999996,
        realizedR: -22.499999999999996 / 57,
        outcome: 'LOSS',
      }),
    ]);
    expect(plan.counts.unmeasure).toBe(0);
    expect(byId.get('a2f9c8cd-b174-46e3-b183-028b0ecc7ca9')!.treatment).toBe('skip');
  });

  it('POSITIVE CONTROL — a numeric brokerOrderId of 0 is a real handle, not an absent one', () => {
    // `?? null` / `== null`, never `!brokerOrderId`. A falsy-test here would
    // read order 0 as "no order" and retract a row that has one.
    //
    // ⛔ GOES RED if either site is rewritten as a truthiness check.
    expect(isUnpricedReconcileClose({ exitReason: 'broker_reconcile', brokerOrderId: 0 })).toBe(false);
    expect(isUnpricedReconcileClose({ exitReason: 'broker_reconcile', brokerOrderId: null })).toBe(true);
    expect(isUnpricedReconcileClose({ exitReason: 'broker_reconcile' })).toBe(true);
    expect(isUnpricedReconcileClose({ exitReason: 'tp1', brokerOrderId: null })).toBe(false);

    const { plan } = planFor([ROW_34F1EE99({ id: 'order-zero', brokerOrderId: 0 })]);
    expect(plan.counts.unmeasure).toBe(0);
  });

  it('POSITIVE CONTROL — `fees_unmeasured` is TEMPORARY and must never be retracted', () => {
    // Both legs are in the ledger and priced; only the fee reconcile is behind
    // (it back-fills a day after settlement). Retracting here would destroy a
    // row the very next pass could restate properly.
    //
    // ⛔ GOES RED if `fees_unmeasured` is added to UNPRICEABLE_SKIP_REASONS.
    expect(UNPRICEABLE_SKIP_REASONS).not.toContain('fees_unmeasured');
    expect(UNPRICEABLE_SKIP_REASONS).not.toContain('zero_delta');
    expect(UNPRICEABLE_SKIP_REASONS).not.toContain('already_restated');

    const priced: LiveOptionFillRecord[] = [
      fill({ optionSymbol: OCC, side: 'buy_to_open', ts: 1787322245400, contracts: 1, filledPrice: 1.23, fees: null }),
      fill({ optionSymbol: OCC, side: 'sell_to_close', ts: 1787578495000, contracts: 1, filledPrice: 0.865, fees: null }),
    ];
    const { plan, byId } = planFor([ROW_34F1EE99()], priced);
    expect(byId.get(TARGET)!.skipReason).toBe('fees_unmeasured');
    expect(plan.counts.unmeasure).toBe(0);
    expect(byId.get(TARGET)!.treatment).toBe('skip');
  });

  it('POSITIVE CONTROL — a row the pass CAN price is restated, not retracted, even on a reconcile close', () => {
    // The ordering claim: `unmeasure` is the treatment for a row with NO number,
    // and a reconcile close whose fills are all present and fee-complete is a
    // `restate`. If the upgrade were applied before the pricing attempt, this
    // row's real -40.08 would be deleted instead of written.
    //
    // ⛔ GOES RED if the upgrade is moved ahead of the allocation/fee path.
    const complete: LiveOptionFillRecord[] = [
      fill({ optionSymbol: OCC, side: 'buy_to_open', ts: 1787322245400, contracts: 1, filledPrice: 1.23, fees: 0.33 }),
      fill({ optionSymbol: OCC, side: 'sell_to_close', ts: 1787578495000, contracts: 1, filledPrice: 0.83, fees: 0.35 }),
    ];
    const { plan, byId } = planFor([ROW_34F1EE99()], complete);
    const r = byId.get(TARGET)!;
    expect(r.treatment).toBe('restate');
    expect(plan.counts.unmeasure).toBe(0);
    // (0.83 − 1.23) × 100 − 0.68
    expect(r.realizedPnlUsdAfter).toBe(-40.68);
    expect(r.unmeasured).toBeUndefined();
  });

  it('is idempotent — an already-retracted row reports `already_unmeasured`, not `unmeasure` forever', () => {
    const { plan, byId } = planFor([
      ROW_34F1EE99({ outcome: 'UNMEASURED', realizedPnlUsd: null, realizedR: null }),
    ]);
    expect(plan.counts).toEqual({ restate: 0, skip: 1, unmeasure: 0 });
    expect(byId.get(TARGET)!.skipReason).toBe('already_unmeasured');
  });

  it('a HALF-applied row (UNMEASURED label beside a surviving figure) is still a candidate', () => {
    // Keyed on the label AND the emptiness of the column. Keying on the label
    // alone would leave a row that got the outcome but not the money stuck
    // forever, reading as finished.
    const { plan } = planFor([ROW_34F1EE99({ outcome: 'UNMEASURED', realizedPnlUsd: 0, realizedR: 0 })]);
    expect(plan.counts.unmeasure).toBe(1);
  });
});

// ── the fold and the writer ─────────────────────────────────────────────────

let tmpFile: string;
let counter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4947-unmeasure-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

function openFixture(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
  return {
    id: TARGET,
    openTs: 1787322245307,
    symbol: 'SOFI',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'up',
    entryDelta: 0.52,
    entryDte: 7,
    atRiskUsd: 120.5,
    entrySlippageUsd: 0,
    optionSymbol: OCC,
    contracts: 1,
    entryMarkUsd: 1.205,
    account: 'admin',
    ...over,
  } as OptionTradeJournalOpen;
}

const AUTHORITY = {
  reason: 'unpriced broker_reconcile close with no brokerOrderId; figure synthesised at breakEvenFill = premiumPaid',
  issue: 'TRA-4947 (TRA-4859; ruling TRA-3978 comment 821c3fef)',
  skipReason: 'no_entry_fill_in_window',
};

/** The row as live holds it: closed `broker_reconcile`, no order, flat 0. */
async function seedFabricatedRow(): Promise<void> {
  await recordOptionTradeOpen(openFixture());
  await recordOptionTradeClose(TARGET, {
    closeTs: 1787578495545,
    outcome: 'SCRATCH',
    realizedPnlUsd: 0,
    realizedR: 0,
    exitReason: 'broker_reconcile',
    brokerOrderId: null,
    holdDays: 2.96,
  });
}

describe('TRA-4947 fold — the retraction writes nulls, survives a cold replay, and is witnessed', () => {
  it('writes realizedPnlUsd/realizedR null + outcome UNMEASURED, and the row reads that way from BYTES', async () => {
    await seedFabricatedRow();
    const res = await recordOptionTradeCloseUnmeasured(TARGET, AUTHORITY, 1790000000000);
    expect(res).toEqual({ applied: true, refusal: null });

    // Cold replay — re-point at the same file so the fold runs from disk. A
    // correction that only exists in the live map is not a correction.
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === TARGET)!;
    expect(row.outcome).toBe('UNMEASURED');
    expect(row.realizedPnlUsd).toBeNull();
    expect(row.realizedR).toBeNull();
    // The audit pin: what the engine said, kept on the row forever.
    expect(row.realizedPnlUsdBeforeRestatement).toBe(0);
    // NOT stamped broker-fill. There is no broker fill — that absence is the
    // whole finding — and stamping it would also make the close-basis planner
    // skip the row as `already_restated` and stop publishing it.
    expect(row.pnlBasis).toBeUndefined();
    // The close itself is untouched: it genuinely happened and the engine
    // genuinely journalled why.
    expect(row.exitReason).toBe('broker_reconcile');
    expect(row.closeTs).toBe(1787578495545);
    expect(row.atRiskUsd).toBe(120.5);

    const w = getOptionTradeCloseUnmeasuredAmends();
    expect(w.applied).toBe(1);
    expect(w.refused).toBe(0);
    expect(w.live).toBe(1);
    // How much fabricated money left the tape. 0 here, because the fabrication
    // WAS a zero — and that is exactly why `applied` and not this figure is the
    // witness that something happened.
    expect(w.retractedAbsUsd).toBe(0);
    expect(w.recent[0]).toMatchObject({
      id: TARGET,
      applied: true,
      refusal: null,
      mode: 'live',
      optionSymbol: OCC,
      outcomeBefore: 'SCRATCH',
      realizedPnlUsdBefore: 0,
      realizedRBefore: 0,
      issue: AUTHORITY.issue,
      skipReason: 'no_entry_fill_in_window',
    });
  });

  it('POSITIVE CONTROL — REFUSES a row already priced from broker fills, and nothing reaches the file', async () => {
    // The one way this line kind can do damage that `amend_close_basis` cannot:
    // delete a number that IS broker truth. Refused in the FOLD, so no caller
    // can route around it.
    //
    // ⛔ GOES RED if the `pnlBasis === 'broker-fill'` guard is removed.
    await seedFabricatedRow();
    expect(await recordOptionTradeCloseBasis(TARGET, {
      realizedPnlUsd: -40.68,
      realizedR: -40.68 / 120.5,
      outcome: 'LOSS',
      feesUsd: 0.68,
      entryFillPremium: 1.23,
      exitFillPremium: 0.83,
    })).toBe(true);

    const res = await recordOptionTradeCloseUnmeasured(TARGET, AUTHORITY);
    expect(res).toEqual({ applied: false, refusal: 'has_broker_fill_basis' });

    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === TARGET)!;
    expect(row.realizedPnlUsd).toBe(-40.68);
    expect(row.outcome).toBe('LOSS');
    expect(row.pnlBasis).toBe('broker-fill');
  });

  it('REFUSES an OPEN row — a retraction must never land on an unsettled position', async () => {
    await recordOptionTradeOpen(openFixture());
    expect(await recordOptionTradeCloseUnmeasured(TARGET, AUTHORITY))
      .toEqual({ applied: false, refusal: 'row_open' });
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === TARGET)!;
    expect(row.outcome).toBe('OPEN');
  });

  it('POSITIVE CONTROL — REFUSES an unauditable retraction (no reason / no issue)', async () => {
    // A money column going from a figure to empty with no authority recorded
    // beside it is indistinguishable from a silent edit, which is the complaint
    // TRA-3978 was filed about.
    //
    // ⛔ GOES RED if `reason`/`issue` stop being required.
    await seedFabricatedRow();
    expect(await recordOptionTradeCloseUnmeasured(TARGET, { ...AUTHORITY, issue: '' }))
      .toEqual({ applied: false, refusal: 'malformed' });
    expect(await recordOptionTradeCloseUnmeasured(TARGET, { ...AUTHORITY, reason: '   ' }))
      .toEqual({ applied: false, refusal: 'malformed' });
    expect(await recordOptionTradeCloseUnmeasured(TARGET, { ...AUTHORITY, skipReason: '' }))
      .toEqual({ applied: false, refusal: 'malformed' });

    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === TARGET)!;
    expect(row.realizedPnlUsd).toBe(0);
    expect(row.outcome).toBe('SCRATCH');
    expect(getOptionTradeCloseUnmeasuredAmends().applied).toBe(0);
  });

  it('REFUSES an unknown id — never resurrects a row', async () => {
    await seedFabricatedRow();
    expect(await recordOptionTradeCloseUnmeasured('no-such-row', AUTHORITY))
      .toEqual({ applied: false, refusal: 'unknown_row' });
  });

  it('is idempotent at the fold — a second retraction is refused and WITNESSED, never silently dropped', async () => {
    await seedFabricatedRow();
    expect((await recordOptionTradeCloseUnmeasured(TARGET, AUTHORITY)).applied).toBe(true);
    expect(await recordOptionTradeCloseUnmeasured(TARGET, AUTHORITY))
      .toEqual({ applied: false, refusal: 'already_unmeasured' });

    const w = getOptionTradeCloseUnmeasuredAmends();
    expect(w.applied).toBe(1);
    expect(w.refused).toBe(1);
    // The pin never moves off the ORIGINAL figure on a replay of two lines.
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === TARGET)!;
    expect(row.realizedPnlUsdBeforeRestatement).toBe(0);
    expect(row.realizedPnlUsd).toBeNull();
  });

  it('retracts a NON-zero fabrication and reports the figure that left the tape', async () => {
    // The branch is not special-cased to 0. A future reconcile-with-no-order row
    // carrying any synthesised figure gets the same honest nulls, and
    // `retractedAbsUsd` says how much left.
    await recordOptionTradeOpen(openFixture({ id: 'nonzero' }));
    await recordOptionTradeClose('nonzero', {
      closeTs: 1787578495545,
      outcome: 'LOSS',
      realizedPnlUsd: -36.5,
      realizedR: -36.5 / 120.5,
      exitReason: 'broker_reconcile',
      brokerOrderId: null,
      holdDays: 2.96,
    });
    expect((await recordOptionTradeCloseUnmeasured('nonzero', AUTHORITY)).applied).toBe(true);
    const w = getOptionTradeCloseUnmeasuredAmends();
    expect(w.retractedAbsUsd).toBe(36.5);
    expect(w.recent[0]!.outcomeBefore).toBe('LOSS');
    expect(w.recent[0]!.realizedPnlUsdBefore).toBe(-36.5);
  });
});

// ── end to end: plan → write → re-plan ──────────────────────────────────────

describe('TRA-4947 end to end — the planner and the writer agree, and the backlog clears', () => {
  it('plans `unmeasure`, applies it, and the SAME planner then reports `already_unmeasured`', async () => {
    await seedFabricatedRow();

    const before = (await listOptionTradeJournal({ mode: 'live' }));
    const planBefore = planCloseBasisRestate(before, NO_FILLS);
    expect(planBefore.counts.unmeasure).toBe(1);
    const planned = planBefore.rows.find((r) => r.id === TARGET)!;
    expect(planned.unmeasured).toBeDefined();

    // Write exactly what the planner produced — no hand-assembled payload, so
    // the two halves cannot drift.
    const res = await recordOptionTradeCloseUnmeasured(TARGET, planned.unmeasured!);
    expect(res.applied).toBe(true);

    const after = (await listOptionTradeJournal({ mode: 'live' }));
    const planAfter = planCloseBasisRestate(after, NO_FILLS);
    expect(planAfter.counts.unmeasure).toBe(0);
    expect(planAfter.rows.find((r) => r.id === TARGET)!.skipReason).toBe('already_unmeasured');
    // And the row itself.
    const row = after.find((r) => r.id === TARGET)!;
    expect([row.outcome, row.realizedPnlUsd, row.realizedR]).toEqual(['UNMEASURED', null, null]);
  });
});
