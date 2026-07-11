import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeEntrySlippage,
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalOpen,
} from './option-trade-journal.js';

// TRA-1601 — the LIVE smart-open mirror reconciles the real avgFillPrice-vs-mid
// slippage back onto the already-written OPEN row via an amend line.

let tmpFile: string;
let counter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra1601-amend-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

function baseOpen(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
  return {
    id: 'pos-1',
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'live',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 40,
    atRiskUsd: 100,
    entrySlippageUsd: 0, // live opens at premiumPaid == rawMark → 0 until the fill reconciles
    ...over,
  };
}

describe('recordOptionTradeEntrySlippage (TRA-1601)', () => {
  it('supersedes the OPEN row entry slippage with the measured fill value', async () => {
    await recordOptionTradeOpen(baseOpen());
    let rows = await listOptionTradeJournal();
    expect(rows[0].entrySlippageUsd).toBe(0);

    expect(await recordOptionTradeEntrySlippage('pos-1', 7.5)).toBe(true);
    rows = await listOptionTradeJournal();
    expect(rows[0].entrySlippageUsd).toBe(7.5);
  });

  it('persists across a reload from disk', async () => {
    await recordOptionTradeOpen(baseOpen());
    await recordOptionTradeEntrySlippage('pos-1', -3);
    // Re-point at the same file to force a fresh fold from the JSONL.
    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();
    expect(rows[0].entrySlippageUsd).toBe(-3);
  });

  it('no-ops for an unknown id', async () => {
    expect(await recordOptionTradeEntrySlippage('missing', 5)).toBe(false);
  });

  it('refuses to amend an already-closed row', async () => {
    await recordOptionTradeOpen(baseOpen());
    await recordOptionTradeClose('pos-1', {
      closeTs: 10,
      outcome: 'WIN',
      realizedPnlUsd: 50,
      realizedR: 0.5,
      exitReason: 'tp',
      holdDays: 1,
    });
    expect(await recordOptionTradeEntrySlippage('pos-1', 9)).toBe(false);
  });

  it('no-ops when the journal flag is off', async () => {
    await recordOptionTradeOpen(baseOpen());
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    expect(await recordOptionTradeEntrySlippage('pos-1', 9)).toBe(false);
  });

  it('ignores a non-finite slippage value', async () => {
    await recordOptionTradeOpen(baseOpen());
    expect(await recordOptionTradeEntrySlippage('pos-1', Number.NaN)).toBe(false);
    const rows = await listOptionTradeJournal();
    expect(rows[0].entrySlippageUsd).toBe(0);
  });
});
