// TRA-4453 (parent TRA-4028) — an import mint that ran BEFORE the
// `history_import` backfill labelled a fill divisor `'mark'` for good. The
// rigs below are the two live rows on bqb1, to the millisecond (read
// 2026-09-10T05:55Z, pin eb8a1738a5d5).
//
// NOK261002C00010500 (admin book):
//   08-28T14:36:01.574Z  engine row `7e6fef50` opens; ledger buy 1 @ 0.73, ord 143816913.
//   08-28T14:36:02.089Z  desk row `a2f9c8cd`'s openTs (it carries the engine lot's clock).
//   08-28T19:49:00.538Z  desk row MINTED at $57 → `mark:no_unclaimed_buys`.
//   later                the backfill appends the desk buy 1 @ 0.57, `history_import`,
//                        synthetic 08-28T17:00:00Z.
//   09-02T17:35:37.046Z  engine exit 1 @ 0.34, ord 144350514 (`fill`).
//   09-02T17:36:03.829Z  desk exit, ord 144350660 — on the ledger ONLY as a
//                        `history_import` sell 1 @ 0.34, orderId null, 17:00:00Z.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeOpenBasis,
  getOptionTradeOpenBasisAmends,
  isOptionTradeJournalEnabled,
  TRADIER_IMPORT_STRUCTURE,
  type OptionTradeJournalOpen,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { resolveImportOpenBasis } from './tra4028-import-open-basis.js';
import {
  planOpenBasisRegrade,
  regradeOpenBasisRow,
  runOpenBasisRegradePass,
  clearOpenBasisRegradeState,
  type OpenBasisRegradeDeps,
} from './tra4453-open-basis-regrade.js';
import { selectJournalExportRows } from './export-history.js';

const NOK = 'NOK261002C00010500';
const ENGINE_OPEN = Date.parse('2026-08-28T14:36:01.574Z');
const DESK_OPEN = Date.parse('2026-08-28T14:36:02.089Z');
const MINT = Date.parse('2026-08-28T19:49:00.538Z');
const ENGINE_CLOSE = Date.parse('2026-09-02T17:35:37.046Z');
const DESK_CLOSE = Date.parse('2026-09-02T17:36:03.829Z');
/** Outside RTH (Thu 05:55Z) — the pass refuses 13:30–20:00Z Mon–Fri. */
const PASS_AT = Date.parse('2026-09-10T05:55:00.000Z');

function fill(p: Pick<LiveOptionFillRecord, 'ts' | 'side' | 'contracts' | 'filledPrice' | 'etDay'> & Partial<LiveOptionFillRecord>): LiveOptionFillRecord {
  return {
    mode: 'live',
    sleeve: 'unattributed',
    book: 'admin',
    optionSymbol: NOK,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    fees: null,
    feeSource: null,
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'history_import',
    tsSynthetic: true,
    ...p,
  };
}

const ENGINE_BUY = fill({ ts: Date.parse('2026-08-28T14:36:02.948Z'), etDay: '2026-08-28', side: 'buy_to_open', contracts: 1, filledPrice: 0.73, orderId: 143816913, origin: 'fill', tsSynthetic: false });
const DESK_BUY = fill({ ts: Date.parse('2026-08-28T17:00:00.000Z'), etDay: '2026-08-28', side: 'buy_to_open', contracts: 1, filledPrice: 0.57 });
const ENGINE_SELL = fill({ ts: ENGINE_CLOSE, etDay: '2026-09-02', side: 'sell_to_close', contracts: 1, filledPrice: 0.34, orderId: 144350514, origin: 'fill', tsSynthetic: false });
const DESK_SELL = fill({ ts: Date.parse('2026-09-02T17:00:00.000Z'), etDay: '2026-09-02', side: 'sell_to_close', contracts: 1, filledPrice: 0.34 });

function engineRow(open = false): OptionTradeJournalRecord {
  return {
    id: '7e6fef50-f834-4c59-b735-cbf2f9c42195', openTs: ENGINE_OPEN, symbol: 'NOK', structure: 'single_leg_otm', mode: 'live',
    ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.3, entryDte: 35, atRiskUsd: 71, optionSymbol: NOK, contracts: 1,
    ...(open ? { outcome: 'OPEN' } : { outcome: 'LOSS', closeTs: ENGINE_CLOSE, realizedPnlUsd: -39.24, realizedR: -0.5527, brokerOrderId: 144350514 }),
  } as OptionTradeJournalRecord;
}

function deskRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'a2f9c8cd-b174-46e3-b183-028b0ecc7ca9', openTs: DESK_OPEN, symbol: 'NOK', structure: TRADIER_IMPORT_STRUCTURE, mode: 'live',
    ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0, entryDte: 35, atRiskUsd: 57, optionSymbol: NOK, contracts: 1,
    atRiskBasis: 'mark', atRiskProvenance: 'mark:no_unclaimed_buys', mintedAt: MINT,
    outcome: 'LOSS', closeTs: DESK_CLOSE, realizedPnlUsd: -22.499999999999996, realizedR: -0.3947368421052631, brokerOrderId: 144350660,
    ...over,
  } as OptionTradeJournalRecord;
}

// ─────────────────────────────────────────────────────────────────────────────
describe('TRA-4453 AC4 — the NOK rig', () => {
  it('reproduces the mint: ledger = the engine 0.73 only, claimed by its sibling ⇒ mark:no_unclaimed_buys', () => {
    const r = resolveImportOpenBasis(
      { id: deskRow().id, optionSymbol: NOK, mode: 'live', contracts: 1, premiumPaid: 0.57 },
      [engineRow(true)],
      [ENGINE_BUY],
    );
    expect(r).toMatchObject({ atRiskBasis: 'mark', markReason: 'no_unclaimed_buys', atRiskUsd: 57 });
  });

  it('append the 0.57 history_import buy ⇒ the re-grade promotes to fill at $57, figure unchanged', () => {
    const rows = [engineRow(), deskRow()];
    const g = regradeOpenBasisRow(deskRow(), rows, [ENGINE_BUY, DESK_BUY, ENGINE_SELL, DESK_SELL]);
    expect(g.basisClass).toBe('recoverable');
    expect(g.priorReason).toBe('no_unclaimed_buys');
    expect(g.lotInstant).toBe(MINT);
    expect(g.verdict).toBe('promote');
    expect(g.resolved).toMatchObject({ atRiskBasis: 'fill', atRiskUsd: 57, atRiskProvenance: 'ledger_fill:history_import' });
    expect(g.resolved!.fills).toEqual([{ ts: DESK_BUY.ts, contracts: 1, filledPrice: 0.57, orderId: null, origin: 'history_import' }]);
    expect(g.deltaUsd).toBe(0);
  });

  it('CONTROL — the SAME resolver on the UNBOUNDED current ledger reads the desk lot\'s own exit as an unclaimed sell', () => {
    // Why the ledger is bounded at the lot's instant: the desk exit is a
    // history_import sell with orderId null and a synthetic stamp, so no exit
    // rule can claim it, and the resolver refuses every buy behind it.
    const r = resolveImportOpenBasis(
      { id: deskRow().id, optionSymbol: NOK, mode: 'live', contracts: 1, premiumPaid: 0.57 },
      [engineRow(), deskRow()],
      [ENGINE_BUY, DESK_BUY, ENGINE_SELL, DESK_SELL],
    );
    expect(r).toMatchObject({ atRiskBasis: 'mark', markReason: 'unclaimed_sells' });
  });

  it('NEGATIVE — a 0.61 buy instead ⇒ the fill disagrees with the row ⇒ the pass REFUSES to amend and reports', async () => {
    const wrong = fill({ ts: DESK_BUY.ts, etDay: '2026-08-28', side: 'buy_to_open', contracts: 1, filledPrice: 0.61 });
    const g = regradeOpenBasisRow(deskRow(), [engineRow(), deskRow()], [ENGINE_BUY, wrong, ENGINE_SELL, DESK_SELL]);
    expect(g.verdict).toBe('disagree');
    expect(g.resolved).toMatchObject({ atRiskBasis: 'fill', atRiskUsd: 61 });
    expect(g.deltaUsd).toBe(4);

    const amended: string[] = [];
    const s = await runOpenBasisRegradePass(
      {
        journalEnabled: () => true,
        listRows: async () => [engineRow(), deskRow()],
        ledger: () => ({ records: [ENGINE_BUY, wrong, ENGINE_SELL, DESK_SELL], usable: true }),
        amend: async (id) => { amended.push(id); return { applied: true, refusal: null }; },
      },
      PASS_AT,
    );
    expect(amended).toEqual([]);
    expect(s.lastOutcome).toBe('graded');
    expect(s.lastCounts).toMatchObject({ promote: 0, disagree: 1 });
    expect(s.lastRows![0]).toMatchObject({ id: deskRow().id, verdict: 'disagree', atRiskUsd: 57, deltaUsd: 4 });
    expect(s.totalPromoted).toBe(0);
  });

  it('the backfill has NOT landed yet ⇒ still_mark with the same reason, nothing amended', () => {
    const g = regradeOpenBasisRow(deskRow(), [engineRow(), deskRow()], [ENGINE_BUY, ENGINE_SELL, DESK_SELL]);
    expect(g.verdict).toBe('still_mark');
    expect(g.resolved?.markReason).toBe('no_unclaimed_buys');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
const RIG = 'RIG260925C00006000';
const rigFill = (p: Parameters<typeof fill>[0]): LiveOptionFillRecord => fill({ optionSymbol: RIG, book: null, ...p });
const RIG_LEDGER: LiveOptionFillRecord[] = [
  rigFill({ ts: Date.parse('2026-08-21T18:04:24.983Z'), etDay: '2026-08-21', side: 'buy_to_open', contracts: 1, filledPrice: 0.33, orderId: 142920548, origin: 'fill', tsSynthetic: false }),
  rigFill({ ts: Date.parse('2026-08-24T15:15:55.328Z'), etDay: '2026-08-24', side: 'sell_to_close', contracts: 1, filledPrice: 0.18, orderId: 143048620, origin: 'fill', tsSynthetic: false }),
  rigFill({ ts: Date.parse('2026-08-24T17:00:00.000Z'), etDay: '2026-08-24', side: 'buy_to_open', contracts: 1, filledPrice: 0.22 }),
  rigFill({ ts: Date.parse('2026-08-26T13:45:31.275Z'), etDay: '2026-08-26', side: 'sell_to_close', contracts: 1, filledPrice: 0.15, orderId: 143384264, origin: 'fill', tsSynthetic: false }),
];
const rigEngine = {
  id: '8a849902-8dec-409a-9498-d1411e97f26f', openTs: Date.parse('2026-08-21T18:04:24.494Z'), symbol: 'RIG', structure: 'single_leg_otm', mode: 'live',
  ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.3, entryDte: 35, atRiskUsd: 33, optionSymbol: RIG, contracts: 1,
  outcome: 'LOSS', closeTs: Date.parse('2026-08-24T15:15:55.327Z'), realizedPnlUsd: -15.24, realizedR: -0.4618, brokerOrderId: 143048620,
} as OptionTradeJournalRecord;
const rigDetached = {
  id: '96b0dc72', openTs: Date.parse('2026-08-21T18:04:24.851Z'), symbol: 'RIG', structure: TRADIER_IMPORT_STRUCTURE, mode: 'live',
  ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0, entryDte: 35, atRiskUsd: 22, optionSymbol: RIG, contracts: 1,
  atRiskBasis: 'mark', atRiskProvenance: 'detached_from:8a849902-8dec-409a-9498-d1411e97f26f:TRA-4082', mintedAt: Date.parse('2026-09-03T13:56:56.531Z'),
  outcome: 'LOSS', closeTs: Date.parse('2026-08-26T13:45:31.275Z'), realizedPnlUsd: -7.000000000000001, realizedR: -0.3182, brokerOrderId: 143384264,
} as OptionTradeJournalRecord;

describe('TRA-4453 AC5 — the RIG detach row never consulted the resolver', () => {
  it('its `mark` is unconsulted; the first decision, bounded at its close, is fill at $22', () => {
    const g = regradeOpenBasisRow(rigDetached, [rigEngine, rigDetached], RIG_LEDGER);
    expect(g.basisClass).toBe('unconsulted');
    expect(g.priorReason).toBeNull();
    // mintedAt (09-03) postdates the close (08-26): the lot's instant is its close.
    expect(g.lotInstant).toBe(rigDetached.closeTs);
    expect(g.verdict).toBe('promote');
    expect(g.resolved).toMatchObject({ atRiskBasis: 'fill', atRiskUsd: 22 });
  });
});

describe('TRA-4453 AC2 — which mark reasons are re-graded at all', () => {
  it.each(['demo_book', 'no_contract_identity', 'unclaimed_sells', 'remainder_excess', 'unpriced_fill'])(
    'mark:%s is a statement about ambiguity ⇒ left alone even when the ledger would now say fill',
    (reason) => {
      const g = regradeOpenBasisRow(deskRow({ atRiskProvenance: `mark:${reason}` }), [engineRow(), deskRow()], [ENGINE_BUY, DESK_BUY]);
      expect(g).toMatchObject({ basisClass: 'not_recoverable', verdict: 'not_recoverable', resolved: null });
    },
  );

  it('mark:no_ledger_fills and mark:remainder_short are recoverable', () => {
    for (const reason of ['no_ledger_fills', 'remainder_short']) {
      expect(regradeOpenBasisRow(deskRow({ atRiskProvenance: `mark:${reason}` }), [engineRow(), deskRow()], [ENGINE_BUY, DESK_BUY]).verdict).toBe('promote');
    }
  });

  it('a row with no mintedAt cannot be bounded ⇒ no_lot_instant, never graded against the whole ledger', () => {
    const { mintedAt: _drop, ...noMint } = deskRow();
    expect(regradeOpenBasisRow(noMint as OptionTradeJournalRecord, [engineRow()], [ENGINE_BUY, DESK_BUY]).verdict).toBe('no_lot_instant');
  });

  it('only `atRiskBasis: mark` rows are candidates', () => {
    const plan = planOpenBasisRegrade([engineRow(), deskRow({ atRiskBasis: 'fill' })], [ENGINE_BUY, DESK_BUY]);
    expect(plan.rows).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC3 — through the REAL journal fold, file and export.
let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4453-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
  clearOpenBasisRegradeState();
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

function asOpen(r: OptionTradeJournalRecord): OptionTradeJournalOpen {
  return {
    id: r.id, openTs: r.openTs, symbol: r.symbol, structure: r.structure, mode: r.mode, ivRank: null, trend: 'unknown',
    sentiment: null, sentimentIcBand: null, entryDelta: r.entryDelta, entryDte: r.entryDte, atRiskUsd: r.atRiskUsd,
    agentConviction: null, optionSymbol: r.optionSymbol, contracts: r.contracts, account: 'admin',
    ...(r.atRiskBasis ? { atRiskBasis: r.atRiskBasis } : {}),
    ...(r.atRiskProvenance ? { atRiskProvenance: r.atRiskProvenance } : {}),
    ...(r.mintedAt ? { mintedAt: r.mintedAt } : {}),
    riskThrottleMultiplier: 1, riskThrottleDecided: 1, riskThrottleSizingPath: null,
  } as OptionTradeJournalOpen;
}

async function writeRow(r: OptionTradeJournalRecord): Promise<void> {
  expect(await recordOptionTradeOpen(asOpen(r))).toBe(true);
  expect(await recordOptionTradeClose(r.id, {
    closeTs: r.closeTs as number, outcome: r.outcome as 'LOSS', realizedPnlUsd: r.realizedPnlUsd as number,
    realizedR: r.realizedR as number, exitReason: 'profit_lock', holdDays: 5, brokerOrderId: r.brokerOrderId as number,
  })).toBe('written');
}

const realDeps = (records: LiveOptionFillRecord[]): OpenBasisRegradeDeps => ({
  journalEnabled: isOptionTradeJournalEnabled,
  listRows: () => listOptionTradeJournal(),
  ledger: () => ({ records, usable: true }),
  amend: recordOptionTradeOpenBasis,
});

describe('TRA-4453 AC3 — the pass on both live rows, through the fold and the export', () => {
  it('a2f9c8cd and 96b0dc72: basis → fill, atRiskUsd / realizedR / pnl_r byte-identical, pnl_r_basis premium-open-mark → premium-fill', async () => {
    for (const r of [engineRow(), deskRow(), rigEngine, rigDetached]) await writeRow(r);
    const before = await listOptionTradeJournal();
    const servedBefore = selectJournalExportRows(before, new Set());
    const pick = (rows: typeof servedBefore, id: string) => rows.find((t) => t.journal_id === id)!;
    expect(pick(servedBefore, deskRow().id).pnl_r_basis).toBe('premium-open-mark');
    expect(pick(servedBefore, rigDetached.id).pnl_r_basis).toBe('premium-open-mark');

    const s = await runOpenBasisRegradePass(realDeps([ENGINE_BUY, DESK_BUY, ENGINE_SELL, DESK_SELL, ...RIG_LEDGER]), PASS_AT);
    expect(s.lastOutcome).toBe('graded');
    expect(s.totalPromoted).toBe(2);
    expect(s.refused).toEqual([]);

    const after = await listOptionTradeJournal();
    for (const id of [deskRow().id, rigDetached.id]) {
      const b = before.find((r) => r.id === id)!;
      const a = after.find((r) => r.id === id)!;
      expect(a.atRiskBasis).toBe('fill');
      expect(a.atRiskUsd).toBe(b.atRiskUsd);
      expect(a.realizedR).toBe(b.realizedR);
      expect(a.outcome).toBe(b.outcome);
      expect(a.realizedPnlUsd).toBe(b.realizedPnlUsd);
      expect(a.atRiskProvenance).toMatch(/^TRA-4453 regrade: ledger_fill:history_import \(was /);
      expect(a.supersededOpenBasis).toHaveLength(1);
      expect(a.supersededOpenBasis![0]).toMatchObject({ atRiskUsd: b.atRiskUsd, atRiskBasis: 'mark', atRiskProvenance: b.atRiskProvenance, issue: 'TRA-4453' });
      const sb = pick(servedBefore, id);
      const sa = pick(selectJournalExportRows(after, new Set()), id);
      expect(sa.pnl_r_basis).toBe('premium-fill');
      expect(sa.pnl_r).toBe(sb.pnl_r);
      expect(sa.premium_basis_usd).toBe(sb.premium_basis_usd);
    }
    expect(after.find((r) => r.id === deskRow().id)!.atRiskUsd).toBe(57);
    expect(after.find((r) => r.id === rigDetached.id)!.atRiskUsd).toBe(22);

    // The witness names both as LABEL-only, with no figure moved.
    const w = getOptionTradeOpenBasisAmends();
    expect(w).toMatchObject({ applied: 2, refused: 0 });
    for (const rec of w.recent) {
      expect(rec).toMatchObject({ labelOnly: true, issue: 'TRA-4453' });
      expect(rec.atRiskUsdAfter).toBe(rec.atRiskUsdBefore);
      expect(rec.realizedRAfter).toBe(rec.realizedRBefore);
    }

    // Durable: a cold replay of the file holds the promotion.
    setOptionTradeJournalFileForTests(tmpFile);
    const replayed = (await listOptionTradeJournal()).find((r) => r.id === deskRow().id)!;
    expect(replayed).toMatchObject({ atRiskBasis: 'fill', atRiskUsd: 57, realizedR: -0.3947368421052631 });

    // Idempotent: nothing is a candidate any more.
    const again = await runOpenBasisRegradePass(realDeps([ENGINE_BUY, DESK_BUY, ENGINE_SELL, DESK_SELL, ...RIG_LEDGER]), PASS_AT + 3_600_000);
    expect(again.lastOutcome).toBe('no_candidates');
    expect(getOptionTradeOpenBasisAmends().applied).toBe(2);
  });

  it('refuses inside RTH — nothing is read or written', async () => {
    await writeRow(deskRow());
    const s = await runOpenBasisRegradePass(realDeps([ENGINE_BUY, DESK_BUY]), Date.parse('2026-09-10T14:00:00.000Z'));
    expect(s.lastOutcome).toBe('skipped_rth');
    expect((await listOptionTradeJournal())[0]!.atRiskBasis).toBe('mark');
  });

  it('the fold: same figure + same label is still `unchanged`; an absent label reads as mark', async () => {
    await writeRow(deskRow());
    const id = deskRow().id;
    expect(await recordOptionTradeOpenBasis(id, { atRiskUsd: 57, atRiskBasis: 'mark', provenance: 'TRA-4453' }, { reason: 't', issue: 'TRA-4453' }))
      .toEqual({ applied: false, refusal: 'unchanged' });
    await writeRow(deskRow({ id: 'unlabelled', atRiskBasis: undefined, atRiskProvenance: undefined }));
    expect(await recordOptionTradeOpenBasis('unlabelled', { atRiskUsd: 57, atRiskBasis: 'mark', provenance: 'TRA-4453' }, { reason: 't', issue: 'TRA-4453' }))
      .toEqual({ applied: false, refusal: 'unchanged' });
  });
});
