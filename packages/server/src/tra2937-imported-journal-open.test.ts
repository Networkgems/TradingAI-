// TRA-2937 — a Tradier-imported option never journalled an OPEN, so its CLOSE
// was silently dropped and the trade left no ledger trace at all.
//
// `reconcileTradierPositions` minted the position with a fresh `randomUUID()`
// and never journalled it. `queueJournalClose` then did
//
//     const rec = await getOptionTradeJournalRecord(id);
//     if (!rec || rec.outcome !== 'OPEN') return;
//
// — an early `return`, not a caught error, so nothing warned. Measured on prod
// `tradingai-bqb1` 2026-08-05: four live imported contracts closed between
// 09:31 and 09:44 ET for a combined realized -$418 with `exit_reason` empty on
// every export row and no CLOSE row anywhere in the 2,514-row journal, while the
// rows that DID exist still read `outcome: "OPEN"` against closed, settled
// positions.
//
// Two failures with opposite fixes hide behind that one symptom, and this file
// pins both:
//
//   • a contract only ever IMPORTED has no journal row to close → mint one,
//     marked `tradier_import` so it can never be mistaken for a chosen trade;
//   • a contract the ENGINE opened and the local book then lost has a row under
//     the OLD id → rebind, so the close settles the original row rather than
//     stranding it and starting a second one.
//
// Plus the two consumers that made the gap invisible: the CSV export, which
// hardcoded `exit_reason: ''` for every option row, and the learned-weights
// fold, which must NOT start learning from imports now that they journal.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeOpen,
  TRADIER_IMPORT_STRUCTURE,
  isUnattributedImportRow,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import { computeOptionLearnedWeights } from './learned-option-weights.js';
import { rowFromOption } from './export.js';
import type { OptionPosition, RelativeValueSignal } from '@trading-app/shared';
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

function buildRvSignal(overrides: Partial<RelativeValueSignal> = {}): RelativeValueSignal {
  return {
    id: 'rv-2937',
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
    ...overrides,
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

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra2937-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-2937 — an imported position journals an OPEN, so its close lands', () => {
  it('writes an OPEN row marked tradier_import when the reconcile adopts a contract', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(acct.getStateForMode('live').openOptions[0]!.id);
    expect(row.structure).toBe(TRADIER_IMPORT_STRUCTURE);
    expect(row.optionSymbol).toBe(OCC);
    expect(row.mode).toBe('live');
    expect(row.outcome).toBe('OPEN');
    // The max loss on a long option IS its premium — a real basis for realizedR,
    // not a stand-in for a missing stop.
    expect(row.atRiskUsd).toBeCloseTo(1.6 * 4 * 100, 5);
    // Honest unknowns, not plausible defaults. `trend: 'unknown'` in particular:
    // no trend gate ran, and the three graded regimes had no member for that.
    expect(row.ivRank).toBeNull();
    expect(row.trend).toBe('unknown');
    expect(row.sentiment).toBeNull();
  });

  // The reported defect, stated as its own test: this assertion fails on the
  // pre-fix build (no CLOSE row exists at all).
  it('books the CLOSE, with its exit reason, when the imported round trip settles', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    const id = acct.getStateForMode('live').openOptions[0]!.id;

    // Sell at 1.20 against a 1.60 basis: −$160 realized on 4 contracts.
    const closed = acct.recordImportedFill(id, 1.2);
    expect(closed).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.outcome).not.toBe('OPEN');
    expect(row.exitReason).toBe('manual');
    expect(row.realizedPnlUsd).toBeCloseTo(-160, 5);
    expect(row.realizedR).toBeCloseTo(-160 / 640, 5);
    expect(row.outcome).toBe('LOSS');
  });

  it('books the CLOSE when the broker-reconcile sweep closes an imported row', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildImport()], 'live');

    // Age past the working-open-order grace window, then report the symbol
    // absent — the sweep books the close locally.
    vi.setSystemTime(TRADING_TIME + 60 * 60 * 1000);
    acct.reconcileTradierPositions([], 'live');
    await acct.flushOptionTradeJournal();

    const row = (await listOptionTradeJournal())[0]!;
    expect(row.outcome).not.toBe('OPEN');
    expect(row.exitReason).toBe('broker_reconcile');
  });

  it('does not duplicate the OPEN row across repeated reconcile sweeps', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
    acct.reconcileTradierPositions([buildImport()], 'live');
    acct.reconcileTradierPositions([buildImport()], 'live');
    acct.reconcileTradierPositions([buildImport({ premiumPaid: 1.75 })], 'live');
    await acct.flushOptionTradeJournal();

    expect(await listOptionTradeJournal()).toHaveLength(1);
  });
});

describe('TRA-2937 — a re-imported ENGINE row is rebound onto its original journal row', () => {
  /**
   * Reproduce the state the ticket describes, using the mechanism that actually
   * produces it in prod: a RESTART. The engine opens the contract on one book
   * (journal row under id A), the process comes back with an empty in-memory
   * book, and the next reconcile sees the broker still holding the contract.
   *
   * Modelling it as a second `PaperOptionsAccount` over the SAME journal file is
   * the honest simulation — the journal is process-level and survives, the book
   * is per-instance and does not — and it deliberately never touches a close
   * path, so row A is still `OPEN` exactly as prod found it.
   */
  async function engineOpenThenRestart(): Promise<{ acct: PaperOptionsAccount; journalId: string }> {
    const before = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    const pos = before.openOptionFromRvCandidate(buildRvSignal(), 'live', undefined, undefined, RV_SETUP);
    expect(pos).not.toBeNull();
    await before.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('OPEN');
    expect(rows[0]!.structure).not.toBe(TRADIER_IMPORT_STRUCTURE);

    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'sandbox' });
    expect(acct.getStateForMode('live').openOptions).toHaveLength(0);
    return { acct, journalId: pos!.id };
  }

  it('rebinds instead of writing a second OPEN row for the same contract', async () => {
    const { acct, journalId } = await engineOpenThenRestart();

    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    // One row, still the ENGINE's — no `tradier_import` twin over-stating the
    // book's open exposure on this contract.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(journalId);
    expect(rows[0]!.structure).not.toBe(TRADIER_IMPORT_STRUCTURE);

    const newId = acct.getStateForMode('live').openOptions[0]!.id;
    expect(newId).not.toBe(journalId);
  });

  it('settles the ORIGINAL row — with its real setup — when the re-imported row closes', async () => {
    const { acct, journalId } = await engineOpenThenRestart();
    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const newId = acct.getStateForMode('live').openOptions[0]!.id;
    expect(acct.recordImportedFill(newId, 1.2)).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.id).toBe(journalId);
    expect(row.outcome).not.toBe('OPEN');
    expect(row.exitReason).toBe('manual');
    // The de-censoring half: the trade's outcome comes back attached to the
    // setup the SELECTOR actually chose, so it re-enters the learner instead of
    // being dropped as an un-attributable import.
    expect(row.structure).not.toBe(TRADIER_IMPORT_STRUCTURE);
    expect(row.ivRank).toBe(18);
    expect(row.trend).toBe('up');
    expect(isUnattributedImportRow(row)).toBe(false);
  });

  it('refuses an AMBIGUOUS rebind and mints a tradier_import row instead', async () => {
    const { acct } = await engineOpenThenRestart();
    // A second OPEN row for the same contract in the same book. We have no
    // evidence which one the broker is handing back, and binding the close to
    // the wrong one would credit realized P&L to a trade that did not earn it.
    await recordOptionTradeOpen({
      id: 'duplicate-open-row',
      openTs: TRADING_TIME - 1000,
      symbol: 'SPY',
      structure: 'single_leg_rv',
      mode: 'live',
      ivRank: 40,
      trend: 'down',
      sentiment: null,
      entryDelta: 0.3,
      entryDte: 300,
      atRiskUsd: 500,
      optionSymbol: OCC,
      riskThrottleMultiplier: 1,
      riskThrottleDecided: 1,
      riskThrottleSizingPath: null,
    });

    acct.reconcileTradierPositions([buildImport()], 'live');
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(3);
    const newId = acct.getStateForMode('live').openOptions[0]!.id;
    const minted = rows.find(r => r.id === newId);
    expect(minted).toBeDefined();
    expect(minted!.structure).toBe(TRADIER_IMPORT_STRUCTURE);
    // Both candidates are untouched — neither was silently bound.
    expect(rows.filter(r => r.outcome === 'OPEN')).toHaveLength(3);
  });
});

describe('TRA-2937 — journalling an import must not start teaching the selector', () => {
  function row(over: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord {
    return {
      id: over.id ?? 'r',
      openTs: TRADING_TIME,
      symbol: 'SPY',
      structure: 'single_leg_rv',
      mode: 'live',
      ivRank: 40,
      trend: 'up',
      sentiment: null,
      entryDelta: 0.4,
      entryDte: 35,
      atRiskUsd: 500,
      outcome: 'WIN',
      realizedR: 1,
      ...over,
    } as OptionTradeJournalRecord;
  }

  it('excludes tradier_import rows from every fold and says how many it dropped', () => {
    const chosen = [
      row({ id: 'a', outcome: 'WIN', realizedR: 1 }),
      row({ id: 'b', outcome: 'LOSS', realizedR: -1 }),
    ];
    const imports = [
      row({ id: 'i1', structure: TRADIER_IMPORT_STRUCTURE, trend: 'unknown', outcome: 'LOSS', realizedR: -3 }),
      row({ id: 'i2', structure: TRADIER_IMPORT_STRUCTURE, trend: 'unknown', outcome: 'LOSS', realizedR: -3 }),
    ];

    const w = computeOptionLearnedWeights([...chosen, ...imports]);
    expect(w.generatedFrom.rows).toBe(2);
    expect(w.generatedFrom.resolved).toBe(2);
    expect(w.generatedFrom.excludedUnattributed).toBe(2);
    expect(w.byStructure.map(s => s.key)).not.toContain(TRADIER_IMPORT_STRUCTURE);
    expect(w.byTrend.map(s => s.key)).not.toContain('unknown');

    // The fold is byte-identical to one computed on the chosen rows alone — the
    // imports move nothing, rather than merely landing in some other bucket.
    expect(w.byStructure).toEqual(computeOptionLearnedWeights(chosen).byStructure);
    expect(w.byTrend).toEqual(computeOptionLearnedWeights(chosen).byTrend);
    expect(w.byDte).toEqual(computeOptionLearnedWeights(chosen).byDte);
  });

  it('reports 0 exclusions on an all-engine fold, so the count reads as a measurement', () => {
    const w = computeOptionLearnedWeights([row({ id: 'a' })]);
    expect(w.generatedFrom.excludedUnattributed).toBe(0);
    expect(w.generatedFrom.rows).toBe(1);
  });
});

describe('TRA-2937 — the CSV export stops hardcoding the exit reason away', () => {
  function closedOption(over: Partial<OptionPosition> = {}): OptionPosition {
    return {
      id: 'opt-1',
      symbol: 'SPY',
      optionSymbol: OCC,
      optionType: 'call',
      strike: 450,
      expiration: '2026-05-15',
      contracts: 4,
      contractsRemaining: 0,
      premiumPaid: 1.6,
      currentPremium: 1.2,
      tp1Premium: 2.4,
      tp1Hit: false,
      stopLossPremium: 1.2,
      peakPremium: 1.7,
      trailingActive: false,
      trailingStopPremium: 0,
      underlyingEntryPrice: 450,
      openedAt: TRADING_TIME,
      closedAt: TRADING_TIME + 3_600_000,
      signalId: 'sig',
      signalType: 'tradier_import',
      mode: 'live',
      pnl: -160,
      ...over,
    } as OptionPosition;
  }

  it('maps the stamped exitReason onto the export row', () => {
    expect(rowFromOption(closedOption({ exitReason: 'chandelier' })).exit_reason).toBe('chandelier');
    expect(rowFromOption(closedOption({ exitReason: 'broker_reconcile' })).exit_reason).toBe('broker_reconcile');
  });

  it('leaves it empty only for a row that closed before the stamp existed', () => {
    expect(rowFromOption(closedOption()).exit_reason).toBe('');
  });
});
