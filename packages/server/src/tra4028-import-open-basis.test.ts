// TRA-4028 (parent TRA-3989) — an IMPORTED lot's journal OPEN row carries the
// lot's OWN fill as `atRiskUsd` when the ledger can attribute one, else the
// mark AND says so; and a one-shot, witnessed `amend_open_basis` restates the
// one row a reconcile import priced off the broker's blend.
//
// ── The measured incident (bqb1, BAC260925C00063000, admin book) ─────────────
//
//   2026-08-20T13:36:22.482Z  engine opens 1 @ mark 1.51 (row `0e180e8c`);
//                             ledger `buy_to_open` 1 @ 1.65, order 142603649.
//   2026-08-20 (17:00:00Z synthetic stamp)  desk adds 1 @ 1.17 by hand; the
//                             reconcile importer writes it as `history_import`.
//                             Tradier now reports ONE row: 2 contracts, cost
//                             basis ½·(1.65 + 1.17) = 1.41 per contract.
//   2026-08-21T17:05:10.473Z  engine exits ITS contract (order 142899523, 0.91).
//   2026-08-21T17:06:09.836Z  reconciler MINTS `6bbc5d17` for the residual
//                             desk lot: `premiumPaid` = the broker's 1.41 blend,
//                             so `atRiskUsd = 1.41 × 1 × 100 = 141`. Nothing on
//                             the ledger ever traded at 1.41.
//   2026-08-24T19:31:08.062Z  the lot's real exit, −$3.00 (TRA-4004). The row
//                             publishes R = −3/141 = −0.0213; the export copies
//                             it (`pnl_r −0.021`). The TRA-3989 AC1 expectation
//                             was −3/117 = −0.026 — the desk's own fill.
//
// Negative control (run before the mint change landed): `mint with a known
// fill` was RED with `atRiskUsd 141` and no `atRiskBasis` on the row. Same
// assertion, unedited, green after.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  liveOptionFillsForContract,
  type LiveOptionFillRecord,
} from './live-options-fee-slippage-ledger.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeOpenBasis,
  getOptionTradeOpenBasisAmends,
  TRADIER_IMPORT_STRUCTURE,
  type OptionTradeJournalOpen,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { resolveImportOpenBasis } from './tra4028-import-open-basis.js';
import { selectJournalExportRows } from './export-history.js';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const OCC = 'BAC260925C00063000';
const ENGINE_OPEN = Date.parse('2026-08-20T13:36:22.482Z');
const ENGINE_FILL_TS = Date.parse('2026-08-20T13:36:23.573Z');
/** The reconcile importer's synthetic stamp for the desk's hand-placed buy. */
const DESK_FILL_TS = Date.parse('2026-08-20T17:00:00.000Z');
const ENGINE_CLOSE = Date.parse('2026-08-21T17:05:10.473Z');
const MINT_TS = Date.parse('2026-08-21T17:06:09.836Z');
const REAL_CLOSE = Date.parse('2026-08-24T19:31:08.062Z');
const ENGINE_FILL = 1.65;
const DESK_FILL = 1.17;
const BLEND = 1.41;

function fill(
  p: Pick<LiveOptionFillRecord, 'ts' | 'side' | 'contracts' | 'filledPrice'> & Partial<LiveOptionFillRecord>,
): LiveOptionFillRecord {
  return {
    mode: 'live',
    etDay: '2026-08-20',
    sleeve: 'unattributed',
    book: null,
    optionSymbol: OCC,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    fees: null,
    feeSource: null,
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'history_import',
    ...p,
  };
}

/** The engine's own row, CLOSED on its own exit — the sibling that owns the 1.65 entry and the 0.91 exit. */
function engineRow(): OptionTradeJournalRecord {
  return {
    id: '0e180e8c',
    openTs: ENGINE_OPEN,
    symbol: 'BAC',
    structure: 'single_leg_otm',
    mode: 'live',
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    entryDelta: 0.53,
    entryDte: 36,
    atRiskUsd: 151,
    optionSymbol: OCC,
    contracts: 1,
    outcome: 'LOSS',
    closeTs: ENGINE_CLOSE,
    realizedPnlUsd: -74,
    realizedR: -0.49,
    exitReason: 'chandelier_restarted',
    holdDays: 1.14,
    brokerOrderId: 142899523,
  } as OptionTradeJournalRecord;
}

const BAC_LEDGER: LiveOptionFillRecord[] = [
  fill({ ts: ENGINE_FILL_TS, side: 'buy_to_open', contracts: 1, filledPrice: ENGINE_FILL, orderId: 142603649, origin: 'fill', sleeve: 'single_leg_otm' }),
  fill({ ts: DESK_FILL_TS, side: 'buy_to_open', contracts: 1, filledPrice: DESK_FILL }),
  fill({ ts: ENGINE_CLOSE, side: 'sell_to_close', contracts: 1, filledPrice: 0.91, orderId: 142899523, origin: 'fill', etDay: '2026-08-21' }),
];

const deskLot = (over: Partial<Parameters<typeof resolveImportOpenBasis>[0]> = {}) => ({
  id: '6bbc5d17',
  optionSymbol: OCC,
  mode: 'live' as const,
  contracts: 1,
  premiumPaid: BLEND,
  ...over,
});

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-4028 AC2/AC4 — resolveImportOpenBasis (pure)', () => {
  it('the incident: the engine row claims its 1.65 entry and 0.91 exit; the desk lot gets its own 1.17 → $117, basis fill', () => {
    const r = resolveImportOpenBasis(deskLot(), [engineRow()], BAC_LEDGER);
    expect(r.atRiskBasis).toBe('fill');
    expect(r.atRiskUsd).toBe(DESK_FILL * 100 * 1);
    expect(r.premiumPerContract).toBeCloseTo(DESK_FILL, 9);
    expect(r.markReason).toBeNull();
    expect(r.atRiskProvenance).toBe('ledger_fill:history_import');
    expect(r.fills).toEqual([{ ts: DESK_FILL_TS, contracts: 1, filledPrice: DESK_FILL, orderId: null, origin: 'history_import' }]);
  });

  it('CONTROL — the same lot, with NO sibling row to claim the engine fills: the unclaimed exit makes the buys unattributable → mark, and says why', () => {
    const r = resolveImportOpenBasis(deskLot(), [], BAC_LEDGER);
    expect(r.atRiskBasis).toBe('mark');
    expect(r.markReason).toBe('unclaimed_sells');
    // The mark basis is the book figure — the blend — exactly what the old
    // mint wrote unconditionally. The difference is that the row now SAYS so.
    expect(r.atRiskUsd).toBe(BLEND * 100);
    expect(r.atRiskProvenance).toBe('mark:unclaimed_sells');
  });

  it('no ledger fills on the contract → mark:no_ledger_fills at the book figure', () => {
    const r = resolveImportOpenBasis(deskLot(), [engineRow()], []);
    expect(r).toMatchObject({ atRiskBasis: 'mark', markReason: 'no_ledger_fills', atRiskUsd: 141 });
  });

  it('a demo import never consults the (live-only) ledger', () => {
    const r = resolveImportOpenBasis(deskLot({ mode: 'demo' }), [], BAC_LEDGER);
    expect(r).toMatchObject({ atRiskBasis: 'mark', markReason: 'demo_book' });
  });

  it('two unclaimed buys and a 1-lot: which one is this lot\'s is unknowable → remainder_excess; a 2-lot takes both, quantity-weighted', () => {
    const twoBuys = [
      fill({ ts: ENGINE_FILL_TS, side: 'buy_to_open', contracts: 1, filledPrice: ENGINE_FILL }),
      fill({ ts: DESK_FILL_TS, side: 'buy_to_open', contracts: 1, filledPrice: DESK_FILL }),
    ];
    const one = resolveImportOpenBasis(deskLot(), [], twoBuys);
    expect(one).toMatchObject({ atRiskBasis: 'mark', markReason: 'remainder_excess', atRiskUsd: 141 });
    const two = resolveImportOpenBasis(deskLot({ contracts: 2 }), [], twoBuys);
    expect(two.atRiskBasis).toBe('fill');
    expect(two.atRiskUsd).toBe((ENGINE_FILL + DESK_FILL) * 100);
    expect(two.premiumPerContract).toBeCloseTo(BLEND, 9);
    expect(two.fills).toHaveLength(2);
  });

  it('a remainder SHORT of the lot (a contract the ledger cannot price) is a mark, never a partial average', () => {
    const r = resolveImportOpenBasis(deskLot({ contracts: 2 }), [engineRow()], BAC_LEDGER);
    expect(r).toMatchObject({ atRiskBasis: 'mark', markReason: 'remainder_short' });
  });

  it('an unpriced buy in the remainder refuses rather than averaging over the priced subset', () => {
    const r = resolveImportOpenBasis(deskLot(), [engineRow()], [
      ...BAC_LEDGER.filter((f) => f.ts !== DESK_FILL_TS),
      fill({ ts: DESK_FILL_TS, side: 'buy_to_open', contracts: 1, filledPrice: null }),
    ]);
    expect(r).toMatchObject({ atRiskBasis: 'mark', markReason: 'unpriced_fill' });
  });

  it('a TRA-3958 operator pin outranks the allocation and names its citation', () => {
    const r = resolveImportOpenBasis(
      deskLot({ premiumPaid: DESK_FILL, operatorBasisPin: { premiumPaid: DESK_FILL, contracts: 1, provenance: 'TRA-3958' } }),
      [],
      [],
    );
    expect(r).toMatchObject({ atRiskBasis: 'fill', atRiskUsd: 117, atRiskProvenance: 'operator_pin:TRA-3958', markReason: null });
  });

  it('a TRA-3909 desk-add mint priced from the TRA-3939 capture is a fill basis with its order ids', () => {
    const r = resolveImportOpenBasis(
      deskLot({ premiumPaid: DESK_FILL, deskAddBasis: { source: 'capture_fill', orderIds: [143000001] } }),
      [],
      [],
    );
    expect(r).toMatchObject({ atRiskBasis: 'fill', atRiskUsd: 117, atRiskProvenance: 'desk_add_capture:143000001' });
    // A residual-identity desk-add is NOT a fill source; it falls through to the allocation.
    const residual = resolveImportOpenBasis(
      deskLot({ deskAddBasis: { source: 'residual_identity', orderIds: [] } }),
      [],
      [],
    );
    expect(residual).toMatchObject({ atRiskBasis: 'mark', markReason: 'no_ledger_fills' });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The mint itself, driven through `reconcileTradierPositions` against the REAL
// ledger module — the function that runs on bqb1, not a stub of it (AC4).
let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4028-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
  clearLiveOptionsFeeSlippageLedger();
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  clearLiveOptionsFeeSlippageLedger();
  await rm(tmpFile, { force: true });
});

function brokerRow(over: Partial<TradierOpenOptionPosition> = {}): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'BAC',
    optionType: 'call',
    strike: 63,
    expiration: '2026-09-25',
    contracts: 1,
    // The broker's BLEND — what Tradier reports for the residual contract.
    premiumPaid: BLEND,
    acquiredAt: ENGINE_OPEN,
    ...over,
  };
}

describe('TRA-4028 AC4 — the reconcile import mint', () => {
  it('mint with a known fill → atRiskUsd == fill × 100 × contracts, atRiskBasis fill', async () => {
    recordLiveOptionFill({
      ts: DESK_FILL_TS,
      etDay: '2026-08-20',
      sleeve: 'unattributed',
      optionSymbol: OCC,
      side: 'buy_to_open',
      contracts: 1,
      filledPrice: DESK_FILL,
      orderId: null,
      origin: 'history_import',
    });
    expect(liveOptionFillsForContract(OCC)).toHaveLength(1);
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    const r = acct.reconcileTradierPositions([brokerRow()], 'live');
    expect(r.added).toBe(1);
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const rec = rows[0]!;
    expect(rec.structure).toBe(TRADIER_IMPORT_STRUCTURE);
    // THE assertion. The old mint wrote `premiumPaid × contracts × 100` = 141.
    expect(rec.atRiskUsd).toBe(DESK_FILL * 100 * 1);
    expect(rec.atRiskBasis).toBe('fill');
    expect(rec.atRiskProvenance).toBe('ledger_fill:history_import');
    // The BOOK row is untouched — the broker copy still carries the blend; the
    // TRA-3958 pin is the instrument for that, not this ticket.
    expect(acct.getState().openOptions[0]!.premiumPaid).toBe(BLEND);
  });

  it('mint with NO fill → mark basis at the book figure, and the row says `mark`', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
    acct.reconcileTradierPositions([brokerRow()], 'live');
    await acct.flushOptionTradeJournal();
    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.atRiskUsd).toBe(BLEND * 100);
    expect(rec.atRiskBasis).toBe('mark');
    expect(rec.atRiskProvenance).toBe('mark:no_ledger_fills');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — the one-shot amendment, on the incident's exact numbers.
function incidentOpen(id = '6bbc5d17-40da-4999-ab4e-f8920fe42adb'): OptionTradeJournalOpen {
  return {
    id,
    openTs: ENGINE_OPEN,
    symbol: 'BAC',
    structure: TRADIER_IMPORT_STRUCTURE,
    mode: 'live',
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    sentimentIcBand: null,
    entryDelta: 0,
    entryDte: 36,
    atRiskUsd: 141,
    agentConviction: null,
    optionSymbol: OCC,
    contracts: 1,
    account: 'admin',
    mintedAt: MINT_TS,
    riskThrottleMultiplier: 1,
    riskThrottleArmedScope: 'demo',
    riskThrottleDecided: 1,
    riskThrottleSizingPath: null,
  };
}

async function writeIncidentRow(): Promise<string> {
  const open = incidentOpen();
  expect(await recordOptionTradeOpen(open)).toBe(true);
  const wrote = await recordOptionTradeClose(open.id, {
    closeTs: REAL_CLOSE,
    outcome: 'SCRATCH',
    realizedPnlUsd: -3,
    realizedR: -0.0213,
    exitReason: 'chandelier_daily_close',
    holdDays: 4.246,
    brokerOrderId: 143160792,
  });
  expect(wrote).toBe('written');
  return open.id;
}

describe('TRA-4028 AC3 — amend_open_basis on the incident row', () => {
  it('restates $141 → $117 with provenance TRA-3958, re-derives realizedR to −0.0256, keeps the old basis on the row, and the export re-reads pnl_r −0.026', async () => {
    const id = await writeIncidentRow();
    const before = (await listOptionTradeJournal())[0]!;
    expect(before.realizedR).toBeCloseTo(-0.0213, 4);

    const res = await recordOptionTradeOpenBasis(
      id,
      { atRiskUsd: 117, atRiskBasis: 'fill', provenance: 'TRA-3958' },
      { reason: 'admin_restatement:TRA-3958', issue: 'TRA-4028' },
      REAL_CLOSE + 86_400_000,
    );
    expect(res).toEqual({ applied: true, refusal: null });

    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.atRiskUsd).toBe(117);
    expect(rec.atRiskBasis).toBe('fill');
    expect(rec.atRiskProvenance).toBe('TRA-3958');
    expect(rec.realizedR).toBeCloseTo(-3 / 117, 4); // −0.0256
    expect(rec.outcome).toBe('SCRATCH');
    // The money and the close do NOT move.
    expect(rec.realizedPnlUsd).toBe(-3);
    expect(rec.closeTs).toBe(REAL_CLOSE);
    expect(rec.exitReason).toBe('chandelier_daily_close');
    expect(rec.brokerOrderId).toBe(143160792);
    // The old basis is kept ON the row.
    expect(rec.supersededOpenBasis).toHaveLength(1);
    expect(rec.supersededOpenBasis![0]).toMatchObject({
      atRiskUsd: 141,
      atRiskBasis: null,
      realizedR: -0.0213,
      outcome: 'SCRATCH',
      reason: 'admin_restatement:TRA-3958',
      issue: 'TRA-4028',
      supersededAt: REAL_CLOSE + 86_400_000,
    });
    // The witness saw exactly one APPLIED amendment, with both figures.
    const w = getOptionTradeOpenBasisAmends();
    expect(w).toMatchObject({ applied: 1, refused: 0, live: 1 });
    expect(w.recent[0]).toMatchObject({ id, applied: true, atRiskUsdBefore: 141, atRiskUsdAfter: 117, realizedRBefore: -0.0213, realizedRAfter: -0.0256 });

    // AC3's grade: the export re-reads the literal TRA-3989 AC1 expectation.
    const served = selectJournalExportRows([rec], new Set());
    expect(served).toHaveLength(1);
    expect(served[0]!.pnl_r).toBeCloseTo(-0.026, 2);
    expect(Math.abs((served[0]!.pnl_r as number) - -0.026)).toBeLessThanOrEqual(0.002);
    expect(served[0]!.premium_basis_usd).toBe(117);
  });

  it('survives a replay of the file — the amendment is a durable line, not an in-memory patch', async () => {
    const id = await writeIncidentRow();
    await recordOptionTradeOpenBasis(id, { atRiskUsd: 117, atRiskBasis: 'fill', provenance: 'TRA-3958' }, { reason: 'admin_restatement:TRA-3958', issue: 'TRA-4028' });
    setOptionTradeJournalFileForTests(tmpFile); // drop the cache, cold replay
    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.atRiskUsd).toBe(117);
    expect(rec.realizedR).toBeCloseTo(-0.0256, 4);
    expect(rec.supersededOpenBasis).toHaveLength(1);
    expect(getOptionTradeOpenBasisAmends().applied).toBe(1);
  });

  it('refuses — and witnesses — an unknown id, an unchanged figure (idempotent re-POST), and a malformed figure', async () => {
    const id = await writeIncidentRow();
    expect(await recordOptionTradeOpenBasis('nope', { atRiskUsd: 117, atRiskBasis: 'fill', provenance: 'TRA-3958' }, { reason: 't', issue: 'TRA-4028' }))
      .toEqual({ applied: false, refusal: 'unknown_row' });
    expect(await recordOptionTradeOpenBasis(id, { atRiskUsd: 141, atRiskBasis: 'mark', provenance: 'TRA-3958' }, { reason: 't', issue: 'TRA-4028' }))
      .toEqual({ applied: false, refusal: 'unchanged' });
    expect(await recordOptionTradeOpenBasis(id, { atRiskUsd: 0, atRiskBasis: 'fill', provenance: 'TRA-3958' }, { reason: 't', issue: 'TRA-4028' }))
      .toEqual({ applied: false, refusal: 'malformed' });
    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.atRiskUsd).toBe(141);
    expect(rec.supersededOpenBasis).toBeUndefined();
    expect(getOptionTradeOpenBasisAmends()).toMatchObject({ applied: 0, refused: 3 });
    // Nothing refused reached the file: a cold replay holds the same row.
    setOptionTradeJournalFileForTests(tmpFile);
    expect((await listOptionTradeJournal())[0]!.atRiskUsd).toBe(141);
    expect(getOptionTradeOpenBasisAmends().total).toBe(0);
  });

  it('on an OPEN row only the basis moves; the eventual close divides by it', async () => {
    const open = incidentOpen('open-row');
    await recordOptionTradeOpen(open);
    const res = await recordOptionTradeOpenBasis('open-row', { atRiskUsd: 117, atRiskBasis: 'fill', provenance: 'TRA-3958' }, { reason: 't', issue: 'TRA-4028' });
    expect(res.applied).toBe(true);
    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.outcome).toBe('OPEN');
    expect(rec.atRiskUsd).toBe(117);
    expect(rec.realizedR).toBeUndefined();
    expect(rec.supersededOpenBasis![0]!.realizedR).toBeNull();
    expect(getOptionTradeOpenBasisAmends().recent[0]).toMatchObject({ realizedRBefore: null, realizedRAfter: null });
  });
});
