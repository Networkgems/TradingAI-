// TRA-4082 — a desk-add residual lot was REBOUND onto its engine sibling's
// journal row, so when the residual closed its close SUPERSEDED the sibling's
// real, broker-filled exit and the export lost it.
//
// ── The measured incident (bqb1 `56804e1a` pid 75, RIG260925C00006000) ───────
//
//   2026-08-21T18:04:24.494Z  engine lot opens; journal row `8a849902`, basis 0.33.
//   2026-08-21T18:04:24.851Z  desk adds 1 ct; reconciler mints residual `96b0dc72`
//                             (`residual_identity` 0.22); TRA-2937 rebind puts it
//                             ON `8a849902` — one row, two lots.
//   2026-08-24T15:15:55.327Z  engine lot exits `sl_otm_premium_pct` 0.33→0.18,
//                             order 143048620, −$15.24, R −0.4618 (TRA-3943 AC3's
//                             −45.45% breach). Row closes.
//   2026-08-26T13:45:31.275Z  residual exits `profit_lock` 0.22→0.15, order
//                             143384264, −$7. Close path finds the row CLOSED 1.9d
//                             earlier → `engine_close_on_already_closed_row`
//                             supersede. The 08-24 fill is now in
//                             `supersededCloses[]`; `/api/trades/export` serves
//                             ONE RIG row; totals +$8.24 with no fill behind it.
//
// Three fixes, each with its own test below, plus the repair:
//   (a) the mint — a `desk_add` lot never rebinds; it writes its OWN open row;
//   (b) the rebind stays for what it was written for (same position re-imported);
//   (c) the close path — a witnessed close under ANOTHER order on a shared row is
//       never superseded: the closing lot detaches to its own row (covers every
//       residual minted before this build, which is still rebound on bqb1);
//   (d) TRA-4004 is untouched: a RECONSTRUCTED close is still superseded, and the
//       same-event duplicate is still dropped (that one is asserted in
//       `tra4004-engine-close-on-reconstructed-row.test.ts`, unedited);
//   (e) the repair planner + apply on the incident's exact numbers;
//   (e2) the same repair on the row AS THE LIVE JOURNAL CARRIED IT ON 08-27: the
//       TRA-3730 sweep had restated the wrongful primary off the SIBLING's fills
//       (−7 → −15.24, 14:01Z 08-26), so the moved close must take its money from
//       `realizedPnlUsdBeforeRestatement`, and refuse by name when that is gone;
//   (f) after the repair the sweep CANNOT hand the lot row the sibling's fills
//       (the sibling-claim pass owns them), so the repair is not undone;
//   (g) the sweep prices a row's exit off the row's OWN broker order when the
//       window also holds another lot's sell — the allocation that produced the
//       08-26T14:01Z write.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseSupersede,
  recordOptionTradeCloseBasis,
  getOptionTradeCloseSupersedes,
  getOptionTradeJournalRecord,
  TRADIER_IMPORT_STRUCTURE,
} from './option-trade-journal.js';
import {
  recordLiveOptionFill,
  clearLiveOptionsFeeSlippageLedger,
  liveOptionFillsForContract,
} from './live-options-fee-slippage-ledger.js';
import { RECONSTRUCTED_EXIT_REASON } from './tra3485-stale-open-repair.js';
import { planCloseBasisRestate } from './tra2819-close-basis-restate.js';
import { selectJournalExportRows } from './export-history.js';
import { planDetachReboundClose, applyDetachReboundClose } from './tra4082-detach-rebound-close.js';
import type { OptionPosition, RelativeValueSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const OCC = 'RIG260925C00006000';
const ENGINE_OPEN = Date.parse('2026-08-21T18:04:24.494Z');
const RESIDUAL_OPEN = Date.parse('2026-08-21T18:04:24.851Z');
const ENGINE_CLOSE = Date.parse('2026-08-24T15:15:55.327Z');
const RESIDUAL_CLOSE = Date.parse('2026-08-26T13:45:31.275Z');
const ENGINE_ORDER = 143048620;
const RESIDUAL_ORDER = 143384264;
const ENGINE_BASIS = 0.33;
const RESIDUAL_BASIS = 0.22;
const EQUITY = 20_000;

function rigSignal(): RelativeValueSignal {
  return {
    id: 'rv-4082',
    symbol: 'RIG',
    type: 'relative_value',
    side: 'buy',
    entryPrice: ENGINE_BASIS,
    stopLoss: 0.2145,
    takeProfit: 0.495,
    riskRewardRatio: 2,
    timestamp: ENGINE_OPEN,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 6,
    expiration: '2026-09-25',
    mark: ENGINE_BASIS,
    fairPrice: 0.4,
    mispricingPct: -0.2,
    zScore: -2.1,
    ivFitted: 0.6,
    ivUsed: 0.55,
    delta: 0.3,
    reason: 'TRA-4082 fixture',
  };
}

const SETUP = {
  ivRank: null,
  trend: 'sideways' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

function brokerRow(over: Partial<TradierOpenOptionPosition> = {}): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'RIG',
    optionType: 'call',
    strike: 6,
    expiration: '2026-09-25',
    contracts: 1,
    premiumPaid: ENGINE_BASIS,
    acquiredAt: ENGINE_OPEN,
    ...over,
  };
}

/** The residual lot exactly as an OLDER build left it on the book: rebound onto `E`. */
function legacyReboundResidual(over: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'R',
    symbol: 'RIG',
    optionSymbol: OCC,
    optionType: 'call',
    strike: 6,
    expiration: '2026-09-25',
    contracts: 1,
    contractsRemaining: 1,
    premiumPaid: RESIDUAL_BASIS,
    currentPremium: 0.15,
    tp1Premium: Number.POSITIVE_INFINITY,
    tp1Hit: false,
    stopLossPremium: 0.143,
    peakPremium: 0.275,
    trailingActive: true,
    trailingStopPremium: 0.23375,
    underlyingEntryPrice: 0,
    openedAt: RESIDUAL_OPEN,
    signalId: `tradier-desk-add-${OCC}`,
    signalType: 'tradier_import',
    mode: 'live',
    importedFromTradier: true,
    adoptionAuthority: 'desk_add',
    deskAddSleeve: 'single_leg_otm',
    deskAddBasis: { source: 'residual_identity', orderIds: [], residualPremiumPaid: RESIDUAL_BASIS, at: RESIDUAL_OPEN },
    tradierEnv: 'production',
    journalId: 'E',
    pendingCloseOrderId: RESIDUAL_ORDER,
    ...over,
  } as OptionPosition;
}

async function seedEngineRowE(id = 'E'): Promise<void> {
  expect(await recordOptionTradeOpen({
    id, openTs: ENGINE_OPEN, symbol: 'RIG', structure: 'single_leg_otm', mode: 'live',
    ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.3, entryDte: 35,
    atRiskUsd: ENGINE_BASIS * 100, optionSymbol: OCC, contracts: 1, account: 'admin',
  })).toBe(true);
}

/** The engine lot's OBSERVED 08-24 exit on row `E`, as the live journal carried it. */
async function closeRowEObserved(): Promise<void> {
  expect(await recordOptionTradeClose('E', {
    closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15.24, realizedR: -0.4618,
    exitReason: 'sl_otm_premium_pct', holdDays: (ENGINE_CLOSE - ENGINE_OPEN) / 86_400_000,
    brokerOrderId: ENGINE_ORDER, entryBasisPremium: ENGINE_BASIS,
  })).toBe('written');
}

function bookWithOnly(rows: OptionPosition[], closed: OptionPosition[] = []): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'production' });
  acct.importSnapshot({
    openOptions: rows, closedOptions: closed, optionsPnl: 0, dailyCount: 0,
    currentDayKey: '2026-08-26', cash: EQUITY, equity: EQUITY,
  });
  return acct;
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ENGINE_OPEN);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4082-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
  clearLiveOptionsFeeSlippageLedger();
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  clearLiveOptionsFeeSlippageLedger();
  await rm(tmpFile, { force: true });
});

describe('TRA-4082 (a) — a desk-add residual writes its OWN journal row', () => {
  it('two lots on one OCC → two journal rows, two export rows, no supersession', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'production' });
    const engine = acct.openOptionFromRvCandidate(rigSignal(), 'live', undefined, undefined, SETUP);
    expect(engine).not.toBeNull();
    await acct.flushOptionTradeJournal();
    // The engine's own fill — the ledger row the desk lot's sleeve schedule is read from.
    recordLiveOptionFill({
      ts: ENGINE_OPEN, etDay: '2026-08-21', sleeve: 'single_leg_otm', optionSymbol: OCC,
      side: 'buy_to_open', contracts: 1, submittedLimit: engine!.premiumPaid, askAtSubmit: engine!.premiumPaid,
      midAtSubmit: engine!.premiumPaid, filledPrice: engine!.premiumPaid, fees: null, orderId: 143000001,
    });

    // The desk adds 1 ct at 0.22; Tradier reports 2 ct at the blend.
    const blend = (engine!.premiumPaid + RESIDUAL_BASIS) / 2;
    vi.setSystemTime(RESIDUAL_OPEN + 60_000);
    acct.reconcileTradierPositions([brokerRow({ contracts: 2, premiumPaid: blend })], 'live');
    await acct.flushOptionTradeJournal();

    const residual = acct.getState().openOptions.find((o) => o.adoptionAuthority === 'desk_add');
    expect(residual).toBeDefined();
    expect(residual!.premiumPaid).toBeCloseTo(RESIDUAL_BASIS, 9);
    expect(residual!.id).not.toBe(engine!.id);
    // THE assertion. On the old code this reads `engine.id` (the rebind).
    expect(residual!.journalId).toBe(residual!.id);

    let rows = await listOptionTradeJournal();
    expect(rows.map((r) => r.id).sort()).toEqual([engine!.id, residual!.id].sort());
    expect(rows.every((r) => r.outcome === 'OPEN')).toBe(true);
    const residualRow = rows.find((r) => r.id === residual!.id)!;
    expect(residualRow.structure).toBe(TRADIER_IMPORT_STRUCTURE);
    expect(residualRow.atRiskUsd).toBeCloseTo(RESIDUAL_BASIS * 100, 6);

    // 08-24: the engine lot exits. 08-26: the residual exits.
    vi.setSystemTime(ENGINE_CLOSE);
    expect(acct.closeOption(engine!.id, 0.18, 'sl_otm_premium_pct')).not.toBeNull();
    await acct.flushOptionTradeJournal();
    vi.setSystemTime(RESIDUAL_CLOSE);
    expect(acct.recordImportedFill(residual!.id, 0.15, 'profit_lock')).not.toBeNull();
    await acct.flushOptionTradeJournal();

    rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    const e = rows.find((r) => r.id === engine!.id)!;
    const r = rows.find((r) => r.id === residual!.id)!;
    expect(e.closeTs).toBe(ENGINE_CLOSE);
    expect(e.exitReason).toBe('sl_otm_premium_pct');
    expect(e.supersededCloses).toBeUndefined();
    expect(r.closeTs).toBe(RESIDUAL_CLOSE);
    expect(r.exitReason).toBe('profit_lock');
    expect(r.supersededCloses).toBeUndefined();
    // Each R divides by ITS lot's basis.
    expect(r.realizedR).toBeCloseTo(r.realizedPnlUsd! / (RESIDUAL_BASIS * 100), 6);
    expect(getOptionTradeCloseSupersedes()).toMatchObject({ applied: 0, refused: 0 });

    // Post-archive export: BOTH fills, distinguishable by journal id.
    const served = selectJournalExportRows(rows, new Set());
    expect(served).toHaveLength(2);
    expect(new Set(served.map((x) => x.journal_id)).size).toBe(2);
    expect(served.map((x) => x.exit_reason).sort()).toEqual(['profit_lock', 'sl_otm_premium_pct']);
  });
});

describe('TRA-4082 (b) — the TRA-2937 rebind survives for a genuine re-import', () => {
  it('the SAME position re-imported under a fresh id after a lost snapshot rebinds; no duplicate OPEN', async () => {
    const before = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'production' });
    const pos = before.openOptionFromRvCandidate(rigSignal(), 'live', undefined, undefined, SETUP);
    await before.flushOptionTradeJournal();
    expect(await listOptionTradeJournal()).toHaveLength(1);

    // "Restart" into a book that lost the row; Tradier still reports the 1 ct.
    const after = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'production' });
    after.reconcileTradierPositions([brokerRow()], 'live');
    await after.flushOptionTradeJournal();
    const imported = after.getState().openOptions[0]!;
    expect(imported.importedFromTradier).toBe(true);
    expect(imported.adoptionAuthority).not.toBe('desk_add');
    expect(imported.id).not.toBe(pos!.id);
    // Rebound onto the engine's row — this is the case the rebind was written for.
    expect(imported.journalId).toBe(pos!.id);
    expect(await listOptionTradeJournal()).toHaveLength(1);
  });
});

describe('TRA-4082 (c) — a lot rebound on an OLDER build detaches when it closes', () => {
  it('SUBJECT — the sibling\'s witnessed close stays primary; the lot gets its own row; both export', async () => {
    await seedEngineRowE();
    await closeRowEObserved();
    const acct = bookWithOnly([legacyReboundResidual()]);

    vi.setSystemTime(RESIDUAL_CLOSE);
    expect(acct.recordImportedFill('R', 0.15, 'profit_lock')).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const e = (await getOptionTradeJournalRecord('E'))!;
    // THE assertion. On the old code: `exitReason: profit_lock`, order 143384264,
    // and the 08-24 fill demoted into `supersededCloses[0]`.
    expect(e.closeTs).toBe(ENGINE_CLOSE);
    expect(e.exitReason).toBe('sl_otm_premium_pct');
    expect(e.brokerOrderId).toBe(ENGINE_ORDER);
    expect(e.realizedPnlUsd).toBe(-15.24);
    expect(e.supersededCloses).toBeUndefined();
    expect(getOptionTradeCloseSupersedes()).toMatchObject({ applied: 0, refused: 0 });

    const r = (await getOptionTradeJournalRecord('R'))!;
    expect(r.outcome).not.toBe('OPEN');
    expect(r.structure).toBe(TRADIER_IMPORT_STRUCTURE);
    expect(r.openTs).toBe(RESIDUAL_OPEN);
    expect(r.closeTs).toBe(RESIDUAL_CLOSE);
    expect(r.exitReason).toBe('profit_lock');
    expect(r.atRiskUsd).toBeCloseTo(RESIDUAL_BASIS * 100, 6);
    expect(r.realizedPnlUsd).toBeCloseTo((0.15 - RESIDUAL_BASIS) * 100, 6);
    // R against the lot's OWN basis (22), not the sibling's (33).
    expect(r.realizedR).toBeCloseTo(r.realizedPnlUsd! / (RESIDUAL_BASIS * 100), 6);
    expect(r.entryBasisPremium).toBeCloseTo(RESIDUAL_BASIS, 9);
    expect(r.brokerOrderId).toBe(RESIDUAL_ORDER);

    // The book twin now joins to its own row, so the export's book/journal
    // dedupe keys on the right id.
    const closed = acct.getState().closedOptions.find((o) => o.id === 'R')!;
    expect(closed.journalId).toBe('R');

    const served = selectJournalExportRows(await listOptionTradeJournal(), new Set());
    expect(served).toHaveLength(2);
    expect(served.map((x) => x.exit_reason).sort()).toEqual(['profit_lock', 'sl_otm_premium_pct']);
  });

  it('survives a replay of the file — the detach is durable lines, not an in-memory patch', async () => {
    await seedEngineRowE();
    await closeRowEObserved();
    const acct = bookWithOnly([legacyReboundResidual()]);
    vi.setSystemTime(RESIDUAL_CLOSE);
    expect(acct.recordImportedFill('R', 0.15, 'profit_lock')).not.toBeNull();
    await acct.flushOptionTradeJournal();

    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(2);
    expect(rows.find((x) => x.id === 'E')!.exitReason).toBe('sl_otm_premium_pct');
    expect(rows.find((x) => x.id === 'R')!.exitReason).toBe('profit_lock');
  });
});

describe('TRA-4082 (d) — TRA-4004 is untouched', () => {
  it('NEGATIVE CONTROL — a RECONSTRUCTED close on the shared row is still superseded, even under a broker order', async () => {
    await seedEngineRowE();
    // The TRA-3547 sweep's shape: a reconstruction carrying somebody else's order.
    expect(await recordOptionTradeClose('E', {
      closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15, realizedR: -0.4545,
      exitReason: RECONSTRUCTED_EXIT_REASON, holdDays: 2.88, brokerOrderId: ENGINE_ORDER,
    })).toBe('written');
    const acct = bookWithOnly([legacyReboundResidual()]);
    vi.setSystemTime(RESIDUAL_CLOSE);
    expect(acct.recordImportedFill('R', 0.15, 'profit_lock')).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const e = (await getOptionTradeJournalRecord('E'))!;
    expect(e.exitReason).toBe('profit_lock');
    expect(e.supersededCloses).toHaveLength(1);
    expect(e.supersededCloses![0]!.exitReason).toBe(RECONSTRUCTED_EXIT_REASON);
    expect(await getOptionTradeJournalRecord('R')).toBeUndefined();
    expect(getOptionTradeCloseSupersedes()).toMatchObject({ applied: 1, refused: 0 });
  });

  it('NEGATIVE CONTROL — a close on the shared row with NO broker order is still superseded', async () => {
    await seedEngineRowE();
    expect(await recordOptionTradeClose('E', {
      closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15, realizedR: -0.4545,
      exitReason: 'sl_otm_premium_pct', holdDays: 2.88, brokerOrderId: null,
    })).toBe('written');
    const acct = bookWithOnly([legacyReboundResidual()]);
    vi.setSystemTime(RESIDUAL_CLOSE);
    expect(acct.recordImportedFill('R', 0.15, 'profit_lock')).not.toBeNull();
    await acct.flushOptionTradeJournal();
    expect((await getOptionTradeJournalRecord('E'))!.exitReason).toBe('profit_lock');
    expect(await getOptionTradeJournalRecord('R')).toBeUndefined();
  });
});

describe('TRA-4082 (e) — the repair, on the incident\'s exact numbers', () => {
  /** Row `E` as the live journal carried `8a849902` at 2026-08-26T13:51Z. */
  async function seedIncidentState(): Promise<void> {
    await seedEngineRowE();
    await closeRowEObserved();
    const sup = await recordOptionTradeCloseSupersede('E', {
      closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -7 / 33,
      exitReason: 'profit_lock', holdDays: (RESIDUAL_CLOSE - ENGINE_OPEN) / 86_400_000,
      brokerOrderId: RESIDUAL_ORDER, entryBasisPremium: RESIDUAL_BASIS,
    }, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE + 3);
    expect(sup.applied).toBe(true);
    const e = (await getOptionTradeJournalRecord('E'))!;
    expect(e.exitReason).toBe('profit_lock');
    expect(e.supersededCloses).toHaveLength(1);
    expect(e.supersededCloses![0]!.brokerOrderId).toBe(ENGINE_ORDER);
    // The state the ticket was filed against: ONE export row, the 08-24 fill gone.
    const served = selectJournalExportRows(await listOptionTradeJournal(), new Set());
    expect(served).toHaveLength(1);
    expect(served[0]!.exit_reason).toBe('profit_lock');
  }

  const REQ = {
    journalId: 'E', lotId: 'R', lotOpenTs: RESIDUAL_OPEN, lotBasisPremium: RESIDUAL_BASIS,
    restoreBrokerOrderId: ENGINE_ORDER, restoreEntryBasisPremium: ENGINE_BASIS, provenance: 'TRA-4082',
  };
  const NOW = Date.parse('2026-08-26T20:30:00Z');

  it('SUBJECT — both fills export again; the 08-24 primary is back; the residual has its own row', async () => {
    await seedIncidentState();
    const plan = planDetachReboundClose(await getOptionTradeJournalRecord('E'), await getOptionTradeJournalRecord('R'), REQ, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.open.id).toBe('R');
    expect(plan.open.atRiskUsd).toBeCloseTo(22, 6);
    expect(plan.movedClose).toMatchObject({ closeTs: RESIDUAL_CLOSE, exitReason: 'profit_lock', realizedPnlUsd: -7, brokerOrderId: RESIDUAL_ORDER, entryBasisPremium: RESIDUAL_BASIS });
    expect(plan.movedClose.realizedR).toBeCloseTo(-7 / 22, 4);
    expect(plan.restoreClose).toMatchObject({ closeTs: ENGINE_CLOSE, exitReason: 'sl_otm_premium_pct', realizedPnlUsd: -15.24, realizedR: -0.4618, brokerOrderId: ENGINE_ORDER, entryBasisPremium: ENGINE_BASIS });

    const result = await applyDetachReboundClose(plan, NOW);
    expect(result).toMatchObject({ ok: true, opened: true, closed: 'written', restored: { applied: true, refusal: null } });

    const e = (await getOptionTradeJournalRecord('E'))!;
    expect(e.closeTs).toBe(ENGINE_CLOSE);
    expect(e.exitReason).toBe('sl_otm_premium_pct');
    expect(e.realizedPnlUsd).toBe(-15.24);
    expect(e.brokerOrderId).toBe(ENGINE_ORDER);
    expect(e.entryBasisPremium).toBe(ENGINE_BASIS);
    // Audit trail: the wrongful demotion AND the move back are both on the row.
    expect(e.supersededCloses).toHaveLength(2);
    expect(e.supersededCloses![1]).toMatchObject({ brokerOrderId: RESIDUAL_ORDER, exitReason: 'profit_lock' });
    expect(e.supersededCloses![1]!.reason).toContain('moved_to:R');

    const r = (await getOptionTradeJournalRecord('R'))!;
    expect(r).toMatchObject({
      outcome: 'LOSS', openTs: RESIDUAL_OPEN, closeTs: RESIDUAL_CLOSE, exitReason: 'profit_lock',
      realizedPnlUsd: -7, brokerOrderId: RESIDUAL_ORDER, atRiskUsd: 22, structure: TRADIER_IMPORT_STRUCTURE,
      atRiskProvenance: 'detached_from:E:TRA-4082', account: 'admin', optionSymbol: OCC, contracts: 1,
    });
    expect(r.realizedR).toBeCloseTo(-7 / 22, 4);

    const served = selectJournalExportRows(await listOptionTradeJournal(), new Set());
    expect(served).toHaveLength(2);
    expect(served.map((x) => [x.journal_id, x.exit_reason, x.broker_order_id]).sort()).toEqual([
      ['E', 'sl_otm_premium_pct', ENGINE_ORDER],
      ['R', 'profit_lock', RESIDUAL_ORDER],
    ]);
    // Totals: −15.24 + −7, not −7.
    expect(served.reduce((s, x) => s + (x.net_pnl_usd ?? 0), 0)).toBeCloseTo(-22.24, 6);

    // Durable across a replay.
    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();
    expect(rows.find((x) => x.id === 'E')!.exitReason).toBe('sl_otm_premium_pct');
    expect(rows.find((x) => x.id === 'R')!.exitReason).toBe('profit_lock');
  });

  it('is one-shot: planning again after apply refuses on the lot row, and the primary order', async () => {
    await seedIncidentState();
    const plan = planDetachReboundClose(await getOptionTradeJournalRecord('E'), await getOptionTradeJournalRecord('R'), REQ, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    await applyDetachReboundClose(plan, NOW);
    const again = planDetachReboundClose(await getOptionTradeJournalRecord('E'), await getOptionTradeJournalRecord('R'), REQ, NOW);
    expect(again.ok).toBe(false);
    if (again.ok) return;
    expect(again.refusal).toBe('lot_row_exists');
    // …and with a fresh lot id the primary already carries the restore order.
    const again2 = planDetachReboundClose(await getOptionTradeJournalRecord('E'), null, { ...REQ, lotId: 'R2' }, NOW);
    expect(again2.ok).toBe(false);
    if (again2.ok) return;
    expect(again2.refusal).toBe('primary_is_restore_order');
  });

  it('refuses every other shape by name', async () => {
    await seedIncidentState();
    const e = await getOptionTradeJournalRecord('E');
    const bad = (over: Partial<typeof REQ>, lot: Awaited<ReturnType<typeof getOptionTradeJournalRecord>> = undefined) =>
      planDetachReboundClose(e, lot, { ...REQ, ...over }, NOW);
    expect(bad({ provenance: 'no ticket' })).toMatchObject({ ok: false, refusal: 'bad_request' });
    expect(bad({ lotBasisPremium: 0 })).toMatchObject({ ok: false, refusal: 'bad_request' });
    expect(bad({ lotOpenTs: RESIDUAL_CLOSE + 1 })).toMatchObject({ ok: false, refusal: 'bad_request' });
    expect(bad({ lotId: 'E' })).toMatchObject({ ok: false, refusal: 'lot_is_row' });
    expect(bad({ restoreBrokerOrderId: 999 })).toMatchObject({ ok: false, refusal: 'restore_close_not_found' });
    expect(planDetachReboundClose(null, null, REQ, NOW)).toMatchObject({ ok: false, refusal: 'unknown_row' });
    // An OPEN row, and a row closed once with nothing superseded.
    await seedEngineRowE('O');
    expect(planDetachReboundClose(await getOptionTradeJournalRecord('O'), null, { ...REQ, journalId: 'O' }, NOW))
      .toMatchObject({ ok: false, refusal: 'row_open' });
    expect(await recordOptionTradeClose('O', { closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -1, realizedR: -0.03, exitReason: 'x', holdDays: 1, brokerOrderId: 5 })).toBe('written');
    expect(planDetachReboundClose(await getOptionTradeJournalRecord('O'), null, { ...REQ, journalId: 'O' }, NOW))
      .toMatchObject({ ok: false, refusal: 'no_superseded_closes' });
    // Nothing was written by any refusal.
    expect((await getOptionTradeJournalRecord('E'))!.exitReason).toBe('profit_lock');
    expect(await getOptionTradeJournalRecord('R')).toBeUndefined();
  });
});

// ── The live fill ledger for RIG260925C00006000, as bqb1 held it on 08-27 ──────
// (`/api/health/live-options-fee-slippage`, n=65). Four fills, two lots:
//   0.33 buy  08-21T18:04:24.983Z  order 142920548  fees 0.11  (engine entry)
//   0.18 sell 08-24T15:15:55.328Z  order 143048620  fees 0.13  (engine exit)
//   0.22 buy  08-24T17:00:00.000Z  order null       fees null  (desk add, `history_import`,
//                                   stamped at the reconcile's synthetic 17:00Z, not at .851Z)
//   0.15 sell 08-26T13:45:31.275Z  order 143384264  fees 0.13  (residual exit)
const ENGINE_ENTRY_FILL_TS = ENGINE_OPEN + 489;
const DESK_HISTORY_IMPORT_TS = Date.parse('2026-08-24T17:00:00.000Z');
function seedRigLedger(): void {
  recordLiveOptionFill({
    ts: ENGINE_ENTRY_FILL_TS, etDay: '2026-08-21', sleeve: 'single_leg_otm', optionSymbol: OCC, side: 'buy_to_open',
    contracts: 1, submittedLimit: 0.36, askAtSubmit: 0.36, midAtSubmit: 0.33, filledPrice: ENGINE_BASIS,
    fees: 0.11, feeSource: 'gainloss_derived', orderId: 142920548,
  });
  recordLiveOptionFill({
    ts: ENGINE_CLOSE + 1, etDay: '2026-08-24', sleeve: 'single_leg_otm', optionSymbol: OCC, side: 'sell_to_close',
    contracts: 1, submittedLimit: 0.12, askAtSubmit: 0.2, midAtSubmit: 0.16, filledPrice: 0.18,
    fees: 0.13, feeSource: 'gainloss_derived', orderId: ENGINE_ORDER,
  });
  recordLiveOptionFill({
    ts: DESK_HISTORY_IMPORT_TS, etDay: '2026-08-24', sleeve: 'unattributed', optionSymbol: OCC, side: 'buy_to_open',
    contracts: 1, submittedLimit: null, askAtSubmit: null, midAtSubmit: null, filledPrice: RESIDUAL_BASIS,
    fees: null, orderId: null, origin: 'history_import',
  });
  recordLiveOptionFill({
    ts: RESIDUAL_CLOSE, etDay: '2026-08-26', sleeve: 'single_leg_directional', optionSymbol: OCC, side: 'sell_to_close',
    contracts: 1, submittedLimit: 0.14, askAtSubmit: 0.28, midAtSubmit: 0.185, filledPrice: 0.15,
    fees: 0.13, feeSource: 'gainloss_derived', orderId: RESIDUAL_ORDER,
  });
}

describe('TRA-4082 (e2) — the repair on the row as the live journal carried it on 08-27 (RESTATED after the supersession)', () => {
  /**
   * Row `E` as bqb1 `56804e1a` carried `8a849902` at 2026-08-27T14:31Z: the
   * wrongful supersession (13:45:31Z 08-26), then the TRA-3730 sweep at
   * 14:01:03Z pricing the profit_lock/143384264 primary off the SIBLING's
   * 0.33→0.18 fills: `realizedPnlUsd −15.24, pnlBasis broker-fill, feesUsd 0.24,
   * entryFillPremium 0.33, exitFillPremium 0.18, realizedPnlUsdBeforeRestatement −7`.
   */
  async function seedRestatedIncidentState(): Promise<void> {
    await seedEngineRowE();
    await closeRowEObserved();
    const sup = await recordOptionTradeCloseSupersede('E', {
      closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -7 / 33,
      exitReason: 'profit_lock', holdDays: (RESIDUAL_CLOSE - ENGINE_OPEN) / 86_400_000,
      brokerOrderId: RESIDUAL_ORDER, entryBasisPremium: RESIDUAL_BASIS,
    }, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE + 3);
    expect(sup.applied).toBe(true);
    expect(await recordOptionTradeCloseBasis('E', {
      realizedPnlUsd: -15.24, realizedR: -0.4618, outcome: 'LOSS', feesUsd: 0.24,
      entryFillPremium: ENGINE_BASIS, exitFillPremium: 0.18,
    }, RESIDUAL_CLOSE + 15 * 60_000)).toBe(true);
    const e = (await getOptionTradeJournalRecord('E'))!;
    // The chimera the export served on 08-27: the residual's label and order,
    // the engine lot's money; the residual's own −7 survives ONLY as the pre-state.
    expect(e).toMatchObject({
      exitReason: 'profit_lock', brokerOrderId: RESIDUAL_ORDER, realizedPnlUsd: -15.24,
      pnlBasis: 'broker-fill', entryFillPremium: ENGINE_BASIS, exitFillPremium: 0.18,
      realizedPnlUsdBeforeRestatement: -7,
    });
    const served = selectJournalExportRows(await listOptionTradeJournal(), new Set());
    expect(served).toHaveLength(1);
    expect(served[0]!.net_pnl_usd).toBe(-15.24);
    expect(served[0]!.exit_reason).toBe('profit_lock');
  }

  const REQ = {
    journalId: 'E', lotId: 'R', lotOpenTs: RESIDUAL_OPEN, lotBasisPremium: RESIDUAL_BASIS,
    restoreBrokerOrderId: ENGINE_ORDER, restoreEntryBasisPremium: ENGINE_BASIS, provenance: 'TRA-4082',
  };
  const NOW = Date.parse('2026-08-27T20:30:00Z');

  it('SUBJECT — the moved close takes the lot\'s OWN −7 (pre-restatement), not the sibling\'s −15.24; both fills export, total −22.24', async () => {
    await seedRestatedIncidentState();
    const plan = planDetachReboundClose(await getOptionTradeJournalRecord('E'), await getOptionTradeJournalRecord('R'), REQ, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.movedPnlSource).toBe('pre_restatement');
    expect(plan.movedClose).toMatchObject({ closeTs: RESIDUAL_CLOSE, exitReason: 'profit_lock', realizedPnlUsd: -7, brokerOrderId: RESIDUAL_ORDER });
    expect(plan.movedClose.realizedR).toBeCloseTo(-7 / 22, 4);
    expect(plan.restoreClose).toMatchObject({ exitReason: 'sl_otm_premium_pct', realizedPnlUsd: -15.24, brokerOrderId: ENGINE_ORDER });

    const result = await applyDetachReboundClose(plan, NOW);
    expect(result).toMatchObject({ ok: true, opened: true, closed: 'written', restored: { applied: true, refusal: null } });

    const e = (await getOptionTradeJournalRecord('E'))!;
    expect(e).toMatchObject({ exitReason: 'sl_otm_premium_pct', realizedPnlUsd: -15.24, brokerOrderId: ENGINE_ORDER, closeTs: ENGINE_CLOSE });
    // The restore goes through supersede_close, which drops the restatement
    // keys — the row is back on engine basis and the sweep may re-price it
    // against its OWN fills (asserted in (f)).
    expect(e.pnlBasis).toBeUndefined();
    expect(e.realizedPnlUsdBeforeRestatement).toBeUndefined();
    const r = (await getOptionTradeJournalRecord('R'))!;
    expect(r).toMatchObject({ outcome: 'LOSS', exitReason: 'profit_lock', realizedPnlUsd: -7, brokerOrderId: RESIDUAL_ORDER, atRiskUsd: 22 });
    expect(r.pnlBasis).toBeUndefined();

    const served = selectJournalExportRows(await listOptionTradeJournal(), new Set());
    expect(served.map((x) => [x.journal_id, x.exit_reason, x.net_pnl_usd]).sort()).toEqual([
      ['E', 'sl_otm_premium_pct', -15.24],
      ['R', 'profit_lock', -7],
    ]);
    expect(served.reduce((s, x) => s + (x.net_pnl_usd ?? 0), 0)).toBeCloseTo(-22.24, 6);
  });

  it('the UNRESTATED row still moves the primary\'s own figure (source: primary)', async () => {
    await seedEngineRowE();
    await closeRowEObserved();
    await recordOptionTradeCloseSupersede('E', {
      closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -7 / 33,
      exitReason: 'profit_lock', holdDays: 4.82, brokerOrderId: RESIDUAL_ORDER, entryBasisPremium: RESIDUAL_BASIS,
    }, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE + 3);
    const plan = planDetachReboundClose(await getOptionTradeJournalRecord('E'), null, REQ, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.movedPnlSource).toBe('primary');
    expect(plan.movedClose.realizedPnlUsd).toBe(-7);
  });

  it('REFUSES by name when the primary is restated and the pre-restatement figure is gone — never a guess', async () => {
    await seedRestatedIncidentState();
    const e = (await getOptionTradeJournalRecord('E'))!;
    const { realizedPnlUsdBeforeRestatement: _gone, ...stripped } = e;
    void _gone;
    const plan = planDetachReboundClose(stripped, null, REQ, NOW);
    expect(plan).toMatchObject({ ok: false, refusal: 'moved_close_restated_unrecoverable' });
    if (plan.ok) return;
    expect(plan.detail).toMatch(/-15\.24/);
    expect(plan.detail).toMatch(/0\.33→0\.18/);
    // Nothing written by the refusal.
    expect(await getOptionTradeJournalRecord('R')).toBeUndefined();
    expect((await getOptionTradeJournalRecord('E'))!.exitReason).toBe('profit_lock');
  });

  it('(f) after the repair, the close-basis sweep cannot hand the lot row the sibling\'s fills — the repair is not undone', async () => {
    seedRigLedger();
    await seedRestatedIncidentState();
    const plan = planDetachReboundClose(await getOptionTradeJournalRecord('E'), null, REQ, NOW);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect((await applyDetachReboundClose(plan, NOW)).ok).toBe(true);

    const sweep = planCloseBasisRestate(await listOptionTradeJournal(), liveOptionFillsForContract(OCC));
    const e = sweep.rows.find((r) => r.id === 'E')!;
    const r = sweep.rows.find((r) => r.id === 'R')!;
    // The sibling re-prices against its OWN round trip and finds itself already
    // broker-exact (0.33→0.18 − 0.24 = −15.24): nothing to write.
    expect(e.treatment).toBe('skip');
    expect(e.skipReason).toBe('zero_delta');
    expect(e.entryFillPremium).toBe(ENGINE_BASIS);
    expect(e.exitFillPremium).toBe(0.18);
    expect(e.realizedPnlUsdAfter).toBe(-15.24);
    // The lot row: the 0.33 entry and 0.18 exit are E's (claimed, named), the
    // desk's own 0.22 sits at the reconcile's synthetic 17:00Z — outside the
    // entry window. The honest verdict is "cannot establish the entry basis";
    // the row keeps its −7 rather than borrowing the sibling's −15.24.
    expect(r.treatment).toBe('skip');
    expect(r.skipReason).toBe('no_entry_fill_in_window');
    expect(r.realizedPnlUsdAfter).toBeNull();
    const claimed = r.excluded.filter((x) => /TRA-3986/.test(x.why));
    expect(claimed.map((x) => [x.side, x.ts])).toEqual([
      ['buy_to_open', ENGINE_ENTRY_FILL_TS],
      ['sell_to_close', ENGINE_CLOSE + 1],
    ]);
    expect(claimed[0]!.why).toMatch(/E:entry/);
    expect(claimed[1]!.why).toMatch(/E:exit/);
    expect(sweep.counts.restate).toBe(0);
    expect((await getOptionTradeJournalRecord('R'))!.realizedPnlUsd).toBe(-7);
  });
});

describe('TRA-4082 (g) — the sweep prices a row\'s exit off the row\'s OWN broker order', () => {
  /**
   * The 08-26T14:01:03Z shape, isolated: ONE closed live row on the OCC whose
   * primary carries order 143384264 (the 0.15 sell) and a window that also holds
   * the earlier 0.18 sell (order 143048620). Oldest-first took 0.18 and wrote
   * −15.24 onto a row whose own fill was 0.15.
   */
  async function seedLoneRow(brokerOrderId: number): Promise<void> {
    await seedEngineRowE('X');
    expect(await recordOptionTradeClose('X', {
      closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -7 / 33,
      exitReason: 'profit_lock', holdDays: 4.82, brokerOrderId,
    })).toBe('written');
  }

  it('SUBJECT — the row\'s own order (0.15) is the exit; the window\'s other sell (0.18) is excluded and says why', async () => {
    seedRigLedger();
    await seedLoneRow(RESIDUAL_ORDER);
    const sweep = planCloseBasisRestate(await listOptionTradeJournal(), liveOptionFillsForContract(OCC));
    const x = sweep.rows.find((r) => r.id === 'X')!;
    expect(x.treatment).toBe('restate');
    expect(x.entryFillPremium).toBe(ENGINE_BASIS);
    expect(x.exitFillPremium).toBe(0.15);
    // (0.15 − 0.33) × 100 − (0.11 + 0.13) = −18.24, not the −15.24 the window wrote.
    expect(x.realizedPnlUsdAfter).toBe(-18.24);
    expect(x.allocations.filter((a) => a.side === 'sell_to_close').map((a) => a.orderId)).toEqual([RESIDUAL_ORDER]);
    const other = x.excluded.find((f) => f.side === 'sell_to_close' && f.ts === ENGINE_CLOSE + 1)!;
    expect(other.why).toMatch(/witnessed order beats the clock \(TRA-4082\)/);
    expect(other.why).toMatch(new RegExp(`order ${ENGINE_ORDER}`));
    expect(other.why).toMatch(new RegExp(`own close is order ${RESIDUAL_ORDER}`));
  });

  it('NEGATIVE CONTROL — a row whose order is NOT in the ledger falls back to the window rule (oldest sell first), unchanged', async () => {
    seedRigLedger();
    await seedLoneRow(999_999);
    const sweep = planCloseBasisRestate(await listOptionTradeJournal(), liveOptionFillsForContract(OCC));
    const x = sweep.rows.find((r) => r.id === 'X')!;
    expect(x.treatment).toBe('restate');
    expect(x.exitFillPremium).toBe(0.18);
    expect(x.realizedPnlUsdAfter).toBe(-15.24);
    expect(x.excluded.some((f) => /witnessed order beats the clock/.test(f.why))).toBe(false);
  });

  it('NEGATIVE CONTROL — a row with NO broker order behaves exactly as before', async () => {
    seedRigLedger();
    await seedEngineRowE('X');
    expect(await recordOptionTradeClose('X', {
      closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -7 / 33, exitReason: 'profit_lock', holdDays: 4.82,
    })).toBe('written');
    const sweep = planCloseBasisRestate(await listOptionTradeJournal(), liveOptionFillsForContract(OCC));
    const x = sweep.rows.find((r) => r.id === 'X')!;
    expect(x.treatment).toBe('restate');
    expect(x.exitFillPremium).toBe(0.18);
    expect(x.excluded.some((f) => /witnessed order beats the clock/.test(f.why))).toBe(false);
  });
});

describe('TRA-4082 — the closed book twin re-points at its own row', () => {
  it('rebinds a closed lot to ITS OWN id only', () => {
    const acct = bookWithOnly([], [legacyReboundResidual({ closedAt: RESIDUAL_CLOSE, pnl: -7, exitReason: 'profit_lock', contractsRemaining: 0 })]);
    expect(acct.rebindClosedOptionJournalId('R', 'E')).toMatchObject({ status: 'refused' });
    expect(acct.rebindClosedOptionJournalId('nope', 'nope')).toMatchObject({ status: 'not_found' });
    expect(acct.rebindClosedOptionJournalId('R', 'R')).toMatchObject({ status: 'rebound', before: 'E' });
    expect(acct.getState().closedOptions.find((o) => o.id === 'R')!.journalId).toBe('R');
    expect(acct.rebindClosedOptionJournalId('R', 'R')).toMatchObject({ status: 'already_bound' });
  });
});
