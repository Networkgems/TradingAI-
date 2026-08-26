// TRA-3986 — one fill is one lot's fill: the stale-OPEN planner must not
// allocate a ledger fill that is already the entry or exit of ANOTHER journal row.
//
// Every fixture below is the live BAC260925C00063000 tape as read off bqb1
// `85c788e5cdc9` on 2026-08-26 (`/api/health/live-options-fee-slippage`
// `records[]` + `/api/health/option-journal?rows=all`), not an invention:
//
//   journal 0e180e8c single_leg_otm  openTs 08-20T13:36:22.482Z  CLOSED 08-21T17:05:10.473Z chandelier_restarted −74 (engine lot)
//   journal 6bbc5d17 tradier_import  openTs 08-20T13:36:22.761Z  OPEN                                                (desk lot, TRA-3933 mint)
//   ledger  08-20T13:36:23.573Z buy_to_open   1 @ 1.65 order 142603649 (engine entry)
//   ledger  08-20T17:00:00.000Z buy_to_open   1 @ 1.17 history_import   (desk entry, synthetic stamp)
//   ledger  08-21T17:05:10.473Z sell_to_close 1 @ 0.91 order 142899523 (engine exit — ALREADY 0e180e8c's close)
//
// On 2026-08-21T18:01:50Z the TRA-3547 sweep planned `6bbc5d17` against exactly
// this ledger and, allocating oldest-first with no notion of what `0e180e8c`
// already owned, wrote the engine's round trip onto the desk row: −$74,
// `reconstructed-TRA-3472`. The desk lot was still at the broker; its real exit
// on 08-24 (order 143160792, −$3.00) then found the row shut (TRA-4004).
import { describe, it, expect } from 'vitest';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import { SAME_CLOSE_TOLERANCE_MS } from './option-trade-journal.js';
import {
  planStaleOpenRepair,
  claimFillsBySiblingRows,
  RECONSTRUCTED_EXIT_REASON,
} from './tra3485-stale-open-repair.js';

const T = (iso: string): number => Date.parse(iso);
const OCC = 'BAC260925C00063000';

function row(overrides: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'row',
    openTs: T('2026-08-20T13:36:22.761Z'),
    symbol: 'BAC',
    optionSymbol: OCC,
    structure: 'tradier_import',
    mode: 'live',
    outcome: 'OPEN',
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    entryDelta: 0,
    entryDte: 36,
    atRiskUsd: 141,
    contracts: 1,
    ...overrides,
  };
}

function fill(overrides: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: T('2026-08-20T13:36:23.573Z'),
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    book: null,
    optionSymbol: OCC,
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: 1.65,
    askAtSubmit: 1.65,
    midAtSubmit: 1.51,
    filledPrice: 1.65,
    fees: 0.13,
    feeSource: 'gainloss_derived',
    slippageVsAsk: 0,
    slippageVsMid: 0.14,
    orderId: 142603649,
    origin: 'fill',
    ...overrides,
  };
}

/** The engine's row, exactly as the journal carried it on 08-21 after its real close. */
const engineRow = (): OptionTradeJournalRecord => row({
  id: '0e180e8c',
  openTs: T('2026-08-20T13:36:22.482Z'),
  structure: 'single_leg_otm',
  outcome: 'LOSS',
  closeTs: T('2026-08-21T17:05:10.473Z'),
  realizedPnlUsd: -74,
  realizedR: -0.49,
  exitReason: 'chandelier_restarted',
  atRiskUsd: 151,
  // The engine row carries NO brokerOrderId on the live journal — the claim has
  // to come from the millisecond, which is the fixture's point.
});

/** The desk's residual lot: the reconciler mint, still OPEN, 279 ms after the engine's openTs. */
const deskRow = (): OptionTradeJournalRecord => row({ id: '6bbc5d17' });

const engineEntry = (): LiveOptionFillRecord => fill();
const deskEntryImport = (): LiveOptionFillRecord => fill({
  ts: T('2026-08-20T17:00:00.000Z'),
  sleeve: 'unattributed',
  filledPrice: 1.17,
  submittedLimit: null as unknown as number,
  askAtSubmit: null,
  midAtSubmit: null,
  fees: null,
  feeSource: null as unknown as LiveOptionFillRecord['feeSource'],
  slippageVsAsk: null,
  slippageVsMid: null,
  orderId: null,
  origin: 'history_import',
});
const engineExit = (): LiveOptionFillRecord => fill({
  ts: T('2026-08-21T17:05:10.473Z'),
  etDay: '2026-08-21',
  sleeve: 'unattributed',
  side: 'sell_to_close',
  filledPrice: 0.91,
  submittedLimit: 0.91,
  askAtSubmit: 0.95,
  midAtSubmit: 0.93,
  fees: 0.13,
  orderId: 142899523,
});

describe('TRA-3986 — the 2026-08-21 BAC shape', () => {
  it('POSITIVE CONTROL: with the engine row absent, the planner writes the −$74 close the sweep wrote live', () => {
    // This is the defect, reproduced. It exists so the test below is graded
    // against a planner that DOES allocate these fills when nothing owns them —
    // otherwise `no_action` could be a broken planner rather than the guard.
    const plan = planStaleOpenRepair([deskRow()], [engineEntry(), deskEntryImport(), engineExit()]);
    expect(plan.counts).toEqual({ retract: 0, backfillClose: 1, noAction: 0 });
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('backfill_close');
    expect(r.close?.exitReason).toBe(RECONSTRUCTED_EXIT_REASON);
    expect(r.close?.closeTs).toBe(T('2026-08-21T17:05:10.473Z'));
    // (0.91 − 1.65) × 100 − 0.13 − 0.13 = −74.26; the live row read −74 because
    // the fee reconcile had not matched the fills yet on 08-21.
    expect(r.close?.realizedPnlUsd).toBe(-74.26);
    expect(r.allocations.map((a) => a.orderId)).toEqual([142603649, 142899523]);
  });

  it('with the engine row PRESENT and CLOSED, the desk row gets NEITHER the engine entry nor the engine exit', () => {
    const plan = planStaleOpenRepair(
      [engineRow(), deskRow()],
      [engineEntry(), deskEntryImport(), engineExit()],
    );
    // Only the OPEN row is planned; the engine row is a claimant, not a subject.
    expect(plan.scanned).toBe(1);
    expect(plan.counts).toEqual({ retract: 0, backfillClose: 0, noAction: 1 });
    const r = plan.rows[0]!;
    expect(r.id).toBe('6bbc5d17');
    expect(r.treatment).toBe('no_action');
    expect(r.close).toBeUndefined();
    expect(r.allocations).toEqual([]);
    // The remainder is the history_import open at the synthetic 17:00:00Z stamp,
    // 3h24m outside the entry window — so the honest verdict is "cannot
    // establish the entry basis", the same refusal TRA-3485 makes for any row
    // whose fills do not line up. NOT a retraction: the lot was at the broker.
    expect(r.reason).toMatch(/none of the opens is within the entry window/);
    // Both engine fills are stated as excluded, naming the row that owns them.
    const claimed = r.excluded.filter((e) => /TRA-3986/.test(e.why));
    expect(claimed.map((e) => [e.side, e.ts])).toEqual([
      ['buy_to_open', T('2026-08-20T13:36:23.573Z')],
      ['sell_to_close', T('2026-08-21T17:05:10.473Z')],
    ]);
    expect(claimed[0]!.why).toMatch(/0e180e8c:entry/);
    expect(claimed[1]!.why).toMatch(/0e180e8c:exit/);
    // The ledger census on the row still reports the WHOLE contract, so an
    // auditor can see the fills exist and were declined, not that they vanished.
    expect(r.ledgerOpens).toBe(2);
    expect(r.ledgerCloses).toBe(1);
  });

  it('claims the exit by millisecond when the closed row carries no brokerOrderId, and by orderId when it does', () => {
    const byContract = new Map([[OCC, [engineEntry(), deskEntryImport(), engineExit()]]]);
    const byMs = claimFillsBySiblingRows([engineRow(), deskRow()], byContract);
    const exitFill = byContract.get(OCC)![2]!;
    expect(byMs.get(exitFill)).toEqual({ total: 1, by: [{ row: '0e180e8c', leg: 'exit', contracts: 1 }] });

    // Same row, but its closeTs is off by more than the tolerance while its
    // brokerOrderId matches the fill — the order id is the stronger witness.
    const byOrder = claimFillsBySiblingRows(
      [engineRow(), row({ id: 'x', outcome: 'LOSS', closeTs: T('2026-08-21T17:05:20.000Z'), brokerOrderId: 142899523 })],
      byContract,
    );
    // 0e180e8c (ms match) claimed the single contract first; the order-id row finds nothing left.
    expect(byOrder.get(exitFill)).toEqual({ total: 1, by: [{ row: '0e180e8c', leg: 'exit', contracts: 1 }] });
    const onlyOrder = claimFillsBySiblingRows(
      [row({ id: 'x', outcome: 'LOSS', closeTs: T('2026-08-21T17:05:20.000Z'), brokerOrderId: '142899523' })],
      byContract,
    );
    expect(onlyOrder.get(exitFill)).toEqual({ total: 1, by: [{ row: 'x', leg: 'exit', contracts: 1 }] });
    // A closeTs outside the tolerance and no order id claims nothing.
    const neither = claimFillsBySiblingRows(
      [row({ id: 'x', outcome: 'LOSS', closeTs: T('2026-08-21T17:05:10.473Z') + SAME_CLOSE_TOLERANCE_MS + 1 })],
      byContract,
    );
    expect(neither.get(exitFill)).toBeUndefined();
  });
});

describe('TRA-3986 — what a claim must NOT do', () => {
  it('every fill already another row\'s ⇒ no_action, never RETRACT (a duplicate mint and an uncaptured lot look identical)', () => {
    // The BAC tape minus the history_import open: the ledger holds ONLY the
    // engine's round trip. Under the old planner the desk row would take both
    // fills; a naive "nothing left ⇒ Group A" would VOID it instead. Neither.
    const plan = planStaleOpenRepair([engineRow(), deskRow()], [engineEntry(), engineExit()]);
    expect(plan.counts).toEqual({ retract: 0, backfillClose: 0, noAction: 1 });
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('no_action');
    expect(r.reason).toMatch(/every one is already the entry or exit of another journal row/);
    expect(r.ledgerOpens).toBe(1);
    expect(r.ledgerCloses).toBe(1);
  });

  it('a genuinely empty ledger is still Group A — the claim pass does not disturb the retract branch', () => {
    const plan = planStaleOpenRepair([engineRow(), deskRow()], []);
    expect(plan.counts).toEqual({ retract: 1, backfillClose: 0, noAction: 0 });
  });

  it('a partial claim leaves the remainder on offer: the QQQ260911P00545000 5-contract exit covering a 4-ct row and a 1-ct import', () => {
    // Live shape (2026-08-04/05): engine row 4 ct, imported lot 1 ct, ONE
    // sell_to_close of 5 contracts. With the engine row closed on that fill's
    // millisecond it claims 4; the imported row's plan sees exactly 1 left.
    const QQQ = 'QQQ260911P00545000';
    const closeTs = T('2026-08-05T13:44:17.690Z');
    const engine = row({
      id: 'engine', optionSymbol: QQQ, symbol: 'QQQ', structure: 'single_leg_otm', contracts: 4,
      openTs: T('2026-08-04T13:47:54.649Z'), outcome: 'LOSS', closeTs, exitReason: RECONSTRUCTED_EXIT_REASON,
    });
    const imported = row({
      id: 'import', optionSymbol: QQQ, symbol: 'QQQ', contracts: 1, atRiskUsd: 53,
      openTs: T('2026-08-04T17:00:00.000Z'),
    });
    const ledger: LiveOptionFillRecord[] = [
      fill({ optionSymbol: QQQ, ts: T('2026-08-04T13:47:55.711Z'), contracts: 4, filledPrice: 0.58, orderId: 140028484, fees: 0.52 }),
      fill({ optionSymbol: QQQ, ts: T('2026-08-04T17:00:00.000Z'), contracts: 1, filledPrice: 0.53, orderId: null, origin: 'history_import', fees: null }),
      fill({ optionSymbol: QQQ, ts: closeTs, side: 'sell_to_close', contracts: 5, filledPrice: 0.438, orderId: 140287732, fees: 0.65 }),
    ];
    const plan = planStaleOpenRepair([engine, imported], ledger);
    expect(plan.counts).toEqual({ retract: 0, backfillClose: 1, noAction: 0 });
    const r = plan.rows[0]!;
    expect(r.id).toBe('import');
    const exit = r.allocations.find((a) => a.side === 'sell_to_close')!;
    expect(exit.recordContracts).toBe(5);
    expect(exit.allocatedContracts).toBe(1);
    // Fee pro-rated off the RECORD's size, not the remainder: 0.65 × 1/5.
    expect(exit.allocatedFees).toBe(0.13);
    // (0.438 − 0.53) × 100 − 0.13 = −9.33; the entry's fee is unmeasured (null).
    expect(r.close?.realizedPnlUsd).toBe(-9.33);
    expect(r.feesComplete).toBe(false);
    // The 5-ct exit is only PARTIALLY claimed, so it stays on offer and is NOT
    // in `excluded`; the engine's 4-ct entry is wholly its own and IS.
    const claimed = r.excluded.filter((e) => /TRA-3986/.test(e.why));
    expect(claimed.map((e) => [e.side, e.contracts])).toEqual([['buy_to_open', 4]]);
    expect(claimed[0]!.why).toMatch(/engine:entry/);
  });

  it('an earlier-opened sibling claims the entry first; a later one cannot take it (openTs order)', () => {
    const early = row({ id: 'early', openTs: T('2026-08-20T13:36:22.482Z'), structure: 'single_leg_otm' });
    const late = row({ id: 'late', openTs: T('2026-08-20T13:36:22.761Z') });
    const byContract = new Map([[OCC, [engineEntry()]]]);
    const claims = claimFillsBySiblingRows([late, early], byContract);
    expect(claims.get(byContract.get(OCC)![0]!)).toEqual({ total: 1, by: [{ row: 'early', leg: 'entry', contracts: 1 }] });
  });

  it('a sibling with no contracts count claims nothing, and a superseded close claims nothing', () => {
    const sized = engineRow();
    const unsized = row({ ...engineRow(), id: 'unsized', contracts: undefined });
    const fills = [engineEntry(), engineExit()];
    expect(claimFillsBySiblingRows([unsized], new Map([[OCC, fills]])).size).toBe(0);
    // The desk row as it reads TODAY (post TRA-4004): closed 08-24 with the
    // 08-21 close under supersededCloses[]. It must claim the 08-24 exit only.
    const exit0824 = fill({ ts: T('2026-08-24T19:31:08.062Z'), etDay: '2026-08-24', side: 'sell_to_close', filledPrice: 1.14, orderId: 143160792 });
    const deskToday = row({
      id: '6bbc5d17', outcome: 'SCRATCH', closeTs: T('2026-08-24T19:31:08.062Z'), brokerOrderId: 143160792,
      exitReason: 'chandelier_daily_close', realizedPnlUsd: -3,
      supersededCloses: [{
        closeTs: T('2026-08-21T17:05:10.473Z'), outcome: 'LOSS', realizedPnlUsd: -74, realizedR: -0.5248,
        exitReason: RECONSTRUCTED_EXIT_REASON, brokerOrderId: null, supersededAt: T('2026-08-26T04:10:29.410Z'), reason: 'admin_backfill:TRA-4004',
      }],
    });
    const all = [engineEntry(), deskEntryImport(), engineExit(), exit0824];
    const claims = claimFillsBySiblingRows([sized, deskToday], new Map([[OCC, all]]));
    expect(claims.get(all[2]!)).toEqual({ total: 1, by: [{ row: '0e180e8c', leg: 'exit', contracts: 1 }] });
    expect(claims.get(all[3]!)).toEqual({ total: 1, by: [{ row: '6bbc5d17', leg: 'exit', contracts: 1 }] });
  });
});
