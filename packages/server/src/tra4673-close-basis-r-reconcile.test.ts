// TRA-4673 — the `amend_close_basis` fold must not take `realizedR` on faith.
//
// Filed off TRA-4610 Defect 3: the fold applied `basis.realizedR` verbatim and
// `recordOptionTradeCloseBasis` never validated it, so the whole surface rested
// on a single-writer assumption — the one production writer
// (`tra2819-close-basis-restate.ts`) recomputes R in the same step that moves
// the money. A SECOND writer that got R wrong would have landed silently and
// produced a frozen sample whose dollars and R disagree.
//
// What this suite pins:
//   • non-finite `realizedR` is refused at record AND at fold;
//   • an R that does not reconcile with `realizedPnlUsd / atRiskUsd` is refused
//     with a witness carrying the claimed and derived figures;
//   • a refused restatement never reaches the file (fold-first, append-if-applied);
//   • the guard is INERT for the honest writer: an exact R and a 4dp-rounded R
//     both still apply;
//   • a row with no usable `atRiskUsd` gets the finiteness assert alone.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, appendFile } from 'fs/promises';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseBasis,
  listOptionTradeJournal,
  getOptionTradeCloseBasisAmends,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalOpen,
  type OptionTradeCloseBasis,
} from './option-trade-journal.js';

let tmpFile: string;
let counter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4673-r-reconcile-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

function baseOpen(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
  return {
    id: 'pos-4673',
    openTs: 1789000000000,
    symbol: 'XLF',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'up',
    entryDelta: 0.21,
    entryDte: 30,
    atRiskUsd: 200,
    entrySlippageUsd: 0,
    optionSymbol: 'XLF261016C00060000',
    contracts: 2,
    entryMarkUsd: 1.0,
    account: 'admin',
    ...over,
  } as OptionTradeJournalOpen;
}

async function openAndClose(): Promise<void> {
  await recordOptionTradeOpen(baseOpen());
  await recordOptionTradeClose('pos-4673', {
    closeTs: 1789086400000,
    outcome: 'LOSS',
    realizedPnlUsd: -50,
    realizedR: -0.25,
    exitReason: 'stop',
    holdDays: 1,
  });
}

/** Broker truth whose R IS its own money over the row's basis: -60.5 / 200. */
const HONEST: OptionTradeCloseBasis = {
  realizedPnlUsd: -60.5,
  realizedR: -0.3025,
  outcome: 'LOSS',
  feesUsd: 0.5,
  entryFillPremium: 1.0,
  exitFillPremium: 0.6975,
};

describe('TRA-4673 — realizedR finiteness + reconciliation on the close-basis restatement', () => {
  it('REFUSES a non-finite realizedR at record time, and nothing reaches the file', async () => {
    await openAndClose();
    expect(await recordOptionTradeCloseBasis('pos-4673', { ...HONEST, realizedR: NaN })).toBe(false);
    expect(await recordOptionTradeCloseBasis('pos-4673', { ...HONEST, realizedR: Infinity })).toBe(false);

    // Cold replay from bytes: a refused line must never have been appended.
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-4673')!;
    expect(row.realizedPnlUsd).toBe(-50);
    expect(row.realizedR).toBe(-0.25);
    expect(row.pnlBasis).toBeUndefined();
    expect(getOptionTradeCloseBasisAmends().refused).toBe(0); // clean file → clean replay
  });

  it('REFUSES an R that disagrees with its own money over the row basis, with a witness naming both figures', async () => {
    await openAndClose();
    // A second writer that divided by the wrong denominator: -60.5 / 100 instead
    // of the row's atRiskUsd 200.
    expect(await recordOptionTradeCloseBasis('pos-4673', { ...HONEST, realizedR: -0.605 })).toBe(false);

    const w = getOptionTradeCloseBasisAmends();
    expect(w.applied).toBe(0);
    expect(w.refused).toBe(1);
    expect(w.recent[0]).toMatchObject({
      id: 'pos-4673',
      applied: false,
      refusal: 'r_mismatch',
      realizedRClaimed: -0.605,
      realizedRDerived: -0.3025,
    });

    // The refusal is durable in the right direction: the file carries no line.
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-4673')!;
    expect(row.realizedPnlUsd).toBe(-50);
    expect(row.realizedR).toBe(-0.25);
  });

  it('the FOLD refuses a mismatched line written to the file directly — the replay path a second writer cannot route around', async () => {
    await openAndClose();
    await appendFile(
      tmpFile,
      `${JSON.stringify({
        kind: 'amend_close_basis',
        id: 'pos-4673',
        ts: 1789090000000,
        basis: { ...HONEST, realizedR: 3.9 },
      })}\n`,
      'utf-8',
    );
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-4673')!;

    expect(row.realizedPnlUsd).toBe(-50);
    expect(row.realizedR).toBe(-0.25);
    expect(row.pnlBasis).toBeUndefined();
    const w = getOptionTradeCloseBasisAmends();
    expect(w.refused).toBe(1);
    expect(w.recent[0]!.refusal).toBe('r_mismatch');
  });

  it('stays INERT for the honest writer: an exact R and a 4dp-rounded R both apply', async () => {
    await openAndClose();
    // Exact: what tra2819-close-basis-restate.ts writes (unrounded division).
    expect(await recordOptionTradeCloseBasis('pos-4673', { ...HONEST, realizedR: -60.5 / 200 })).toBe(true);
    // 4dp-rounded on a figure that does not round clean: -60.51 / 200 =
    // -0.30255 → -0.3026 (the admin backfill route's convention). Must fit
    // inside the epsilon rather than manufacture refusals for a rounding path.
    expect(await recordOptionTradeCloseBasis('pos-4673', {
      ...HONEST, realizedPnlUsd: -60.51, realizedR: -0.3026,
    })).toBe(true);

    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-4673')!;
    expect(row.realizedPnlUsd).toBe(-60.51);
    expect(row.pnlBasis).toBe('broker-fill');
    expect(getOptionTradeCloseBasisAmends().refused).toBe(0);
  });

  it('a row with NO usable atRiskUsd gets the finiteness assert alone — reconciliation needs a denominator', async () => {
    // A legacy row that predates the basis field, laid down as raw lines.
    const open = { ...baseOpen({ id: 'pos-legacy' }) } as Record<string, unknown>;
    delete open['atRiskUsd'];
    await appendFile(
      tmpFile,
      `${JSON.stringify({ kind: 'open', rec: open })}\n`
      + `${JSON.stringify({
        kind: 'close',
        id: 'pos-legacy',
        close: { closeTs: 1789086400000, outcome: 'LOSS', realizedPnlUsd: -50, realizedR: -0.25, exitReason: 'stop', holdDays: 1 },
      })}\n`,
      'utf-8',
    );
    setOptionTradeJournalFileForTests(tmpFile);
    await listOptionTradeJournal();

    // No denominator → the mismatch predicate cannot run; finite R applies.
    expect(await recordOptionTradeCloseBasis('pos-legacy', { ...HONEST, realizedR: -0.9 })).toBe(true);
    // …but a non-finite one is still refused.
    expect(await recordOptionTradeCloseBasis('pos-legacy', { ...HONEST, realizedR: NaN })).toBe(false);

    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-legacy')!;
    expect(row.realizedPnlUsd).toBe(-60.5);
    expect(row.realizedR).toBe(-0.9);
  });
});
