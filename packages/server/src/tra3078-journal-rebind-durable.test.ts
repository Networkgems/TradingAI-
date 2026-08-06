// TRA-3078 — TRA-2937's ADOPT was not durable.
//
// The rebind lived in a private in-memory `Map<positionId, journalId>` on the
// account. `exportSnapshot` did not serialize it and `importSnapshot` did not
// restore it, so a binding established at boot N was gone at boot N+1 — and
// could never come back, because `queueJournalImportOpen` is reached only on the
// reconcile's `added` branch and a snapshot-restored contract is `existing` on
// every later pass. The close then landed against an id the journal had never
// seen and `queueJournalClose` dropped it: the original TRA-2937 symptom, one
// restart later, on a host that reboots several times a day.
//
// Measured on prod `tradingai-bqb1` 2026-08-06 (build f19fb1fa3068, pid 72):
// TSLA260911C00555000 sat in `openOptions` as book id 1e8540eb with journal OPEN
// row 959e542f (single_leg_otm, live) — two ids, one contract, no binding — and
// Render logs over 10:45–12:50Z carried ZERO `reconcile rebound an imported row`
// lines with all three reader controls passing.
//
// The fix moves the binding onto the position (`OptionPosition.journalId`), so
// it rides the existing snapshot, and adds the repair pass on the `existing`
// branch for the cohort that was already stranded.
//
// Every test here is a RESTART test: export → fresh account → import → reconcile
// → close, asserting the close settled the ORIGINAL row. The unit-level branch
// assertions live in `tra2937-imported-journal-open.test.ts` and still pass —
// they were never the thing that was broken.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  TRADIER_IMPORT_STRUCTURE,
} from './option-trade-journal.js';
import type { RelativeValueSignal } from '@trading-app/shared';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const OCC = 'SPY260515C00450000';

function buildImport(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'SPY',
    optionType: 'call',
    strike: 450,
    expiration: '2026-05-15',
    contracts: 4,
    premiumPaid: 1.6,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

function buildRvSignal(): RelativeValueSignal {
  return {
    id: 'rv-3078',
    symbol: 'SPY',
    type: 'relative_value',
    side: 'buy',
    entryPrice: 1.6,
    stopLoss: 1.2,
    takeProfit: 2.4,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 450,
    expiration: '2026-05-15',
    mark: 1.6,
    fairPrice: 2.0,
    mispricingPct: -0.2,
    zScore: -2.1,
    ivFitted: 0.25,
    ivUsed: 0.22,
    delta: 0.42,
    reason: 'cheap vs skew',
  };
}

const RV_SETUP = {
  ivRank: 18,
  trend: 'up' as const,
  sentiment: null,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: 'options_single_leg' as const,
};

/**
 * A restart, modelled the way prod produces one: the journal is process-level
 * and survives on disk, the book is per-instance and arrives through a snapshot.
 *
 * The snapshot is round-tripped through JSON deliberately — that is what the
 * durable store does, and a binding that only survives a structured clone is not
 * a binding that survives a reboot.
 */
function restart(from: PaperOptionsAccount): PaperOptionsAccount {
  const snap = JSON.parse(JSON.stringify(from.exportSnapshot()));
  const after = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
  after.importSnapshot(snap);
  return after;
}

/** Engine opens the contract, then the process dies with the book unsaved. */
async function engineOpenThenLoseTheBook(): Promise<{ acct: PaperOptionsAccount; journalId: string }> {
  const before = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
  const pos = before.openOptionFromRvCandidate(buildRvSignal(), 'live', undefined, undefined, RV_SETUP);
  expect(pos).not.toBeNull();
  await before.flushOptionTradeJournal();
  expect((await listOptionTradeJournal())[0]!.outcome).toBe('OPEN');

  const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
  expect(acct.getStateForMode('live').openOptions).toHaveLength(0);
  return { acct, journalId: pos!.id };
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra3078-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-3078 — an adopted rebind survives a restart', () => {
  // THE reported defect. This assertion fails on the pre-fix build: the close
  // lands under the position id, finds no OPEN row, warns, and drops — while
  // journal row A stays OPEN against a closed, settled position.
  it('settles the ORIGINAL journal row when the close happens after a reboot', async () => {
    const { acct, journalId } = await engineOpenThenLoseTheBook();
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const rebooted = restart(acct);
    // The broker still holds it, so the reconcile runs again — and finds the
    // contract `existing`, which is the branch that could never rebind.
    rebooted.reconcileTradierPositions([buildImport()], 'live');
    await rebooted.flushOptionTradeJournal();

    const positionId = rebooted.getStateForMode('live').openOptions[0]!.id;
    expect(positionId).not.toBe(journalId);
    expect(rebooted.recordImportedFill(positionId, 1.2)).not.toBeNull();
    await rebooted.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(journalId);
    expect(row.outcome).toBe('LOSS');
    expect(row.exitReason).toBe('manual');
    expect(row.realizedPnlUsd).toBeCloseTo(-160, 5);
    // The de-censoring half survives the reboot too: the outcome comes back
    // attached to the setup the SELECTOR chose, not to an import placeholder.
    expect(row.structure).not.toBe(TRADIER_IMPORT_STRUCTURE);
    expect(row.ivRank).toBe(18);
  });

  it('carries the binding through the snapshot itself, not through a re-lookup', async () => {
    const { acct, journalId } = await engineOpenThenLoseTheBook();
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();
    expect(acct.getStateForMode('live').openOptions[0]!.journalId).toBe(journalId);

    // No reconcile after the restart at all — the close is the very next thing
    // that happens. This is the leg that fails if the field is recomputed rather
    // than persisted, and it is the real prod ordering when a position closes
    // before the first post-boot reconcile completes.
    const rebooted = restart(acct);
    const positionId = rebooted.getStateForMode('live').openOptions[0]!;
    expect(positionId.journalId).toBe(journalId);
    expect(rebooted.recordImportedFill(positionId.id, 1.2)).not.toBeNull();
    await rebooted.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(journalId);
    expect(rows[0]!.outcome).not.toBe('OPEN');
  });

  it('survives more than one reboot — the binding does not decay', async () => {
    const { acct, journalId } = await engineOpenThenLoseTheBook();
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    let book = acct;
    for (let boot = 0; boot < 4; boot += 1) {
      book = restart(book);
      book.reconcileTradierPositions([buildImport()], 'live');
      await book.flushOptionTradeJournal();
      expect(book.getStateForMode('live').openOptions[0]!.journalId).toBe(journalId);
    }

    expect(await listOptionTradeJournal()).toHaveLength(1);
    const positionId = book.getStateForMode('live').openOptions[0]!.id;
    expect(book.recordImportedFill(positionId, 1.2)).not.toBeNull();
    await book.flushOptionTradeJournal();
    expect((await listOptionTradeJournal())[0]!.id).toBe(journalId);
  });
});

describe('TRA-3078 — the already-stranded cohort is repaired, not just new imports', () => {
  /**
   * The population the live box is actually carrying: an imported row sitting in
   * a snapshot with NO binding, because it was minted by a build that had no
   * `journalId` field (or by TRA-2937 whose map died with the process). It
   * reaches every later reconcile as `existing`, so the `added` branch cannot
   * see it — the "un-fixable cohort" this ticket names.
   */
  async function strandedLegacyRow(): Promise<{ acct: PaperOptionsAccount; journalId: string }> {
    const { acct, journalId } = await engineOpenThenLoseTheBook();
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const snap = JSON.parse(JSON.stringify(acct.exportSnapshot()));
    // Strip the field to reproduce a pre-fix snapshot exactly. This is the
    // whole point of the test: a build that only stamps on the `added` path
    // leaves this row unresolvable forever.
    for (const o of snap.openOptions) delete o.journalId;
    const legacy = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    legacy.importSnapshot(snap);
    expect(legacy.getStateForMode('live').openOptions[0]!.journalId).toBeUndefined();
    return { acct: legacy, journalId };
  }

  it('rebinds a snapshot-restored row on the existing branch and settles its close', async () => {
    const { acct, journalId } = await strandedLegacyRow();

    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();
    expect(acct.getStateForMode('live').openOptions[0]!.journalId).toBe(journalId);

    const positionId = acct.getStateForMode('live').openOptions[0]!.id;
    expect(acct.recordImportedFill(positionId, 1.2)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(journalId);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.structure).not.toBe(TRADIER_IMPORT_STRUCTURE);
  });

  it('repairs a MINTED row to identity without writing a second OPEN under one id', async () => {
    // No engine row anywhere — the contract was only ever imported, so the
    // repair must resolve to identity rather than mint again. Minting twice
    // under one id is the failure mode a naive "just call the add path" repair
    // ships, and it would double-count the book's open exposure.
    const first = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    first.reconcileTradierPositions([buildImport()], 'live');
    await first.flushOptionTradeJournal();
    const mintedId = first.getStateForMode('live').openOptions[0]!.id;
    expect((await listOptionTradeJournal())[0]!.id).toBe(mintedId);

    const snap = JSON.parse(JSON.stringify(first.exportSnapshot()));
    for (const o of snap.openOptions) delete o.journalId;
    const legacy = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    legacy.importSnapshot(snap);

    legacy.reconcileTradierPositions([buildImport()], 'live');
    legacy.reconcileTradierPositions([buildImport()], 'live');
    await legacy.flushOptionTradeJournal();

    expect(await listOptionTradeJournal()).toHaveLength(1);
    expect(legacy.getStateForMode('live').openOptions[0]!.journalId).toBe(mintedId);

    expect(legacy.recordImportedFill(mintedId, 1.2)).not.toBeNull();
    await legacy.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).not.toBe('OPEN');
    expect(rows[0]!.exitReason).toBe('manual');
  });

  it('leaves an engine-opened row alone — the repair is scoped to imports', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    const pos = acct.openOptionFromRvCandidate(buildRvSignal(), 'live', undefined, undefined, RV_SETUP);
    expect(pos).not.toBeNull();
    await acct.flushOptionTradeJournal();

    // The broker reports the same contract; the engine row is NOT imported, so
    // it takes the basis-restatement branch and never reaches the repair.
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const row = acct.getStateForMode('live').openOptions[0]!;
    expect(row.id).toBe(pos!.id);
    // Absent, and it must stay absent: identity is already correct for an
    // engine row, and `journalIdFor` resolves an absent field to `position.id`.
    expect(row.journalId).toBeUndefined();

    expect(acct.closeOption(pos!.id, 1.2)).not.toBeNull();
    await acct.flushOptionTradeJournal();
    expect((await listOptionTradeJournal())[0]!.outcome).not.toBe('OPEN');
  });
});
