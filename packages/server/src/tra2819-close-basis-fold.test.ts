// TRA-2819 — the `amend_close_basis` line: restating the MONEY on a settled row.
//
// The planner suite (`tra2819-close-basis-restate.test.ts`) grades the
// arithmetic against Tradier's own `/gainloss` figures. This one grades the
// STORE: that the correction survives a cold replay, that it refuses to land on
// an unsettled position, and that it leaves a witness a reader can tell apart
// from "the pass never ran".
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
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
  tmpFile = join(tmpdir(), `tra2819-basis-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

function baseOpen(over: Partial<OptionTradeJournalOpen> = {}): OptionTradeJournalOpen {
  return {
    id: 'pos-2819',
    openTs: 1785418939751,
    symbol: 'AAPL',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'sideways',
    entryDelta: 0.0667,
    entryDte: 36,
    atRiskUsd: 398,
    entrySlippageUsd: 20,
    optionSymbol: 'AAPL260904P00280000',
    contracts: 4,
    entryMarkUsd: 0.995,
    account: 'admin',
    ...over,
  } as OptionTradeJournalOpen;
}

/** Broker truth for the AAPL lot: +695.09 net of 0.91 commission. */
const BROKER: OptionTradeCloseBasis = {
  realizedPnlUsd: 695.09,
  realizedR: 1.7465,
  outcome: 'WIN',
  feesUsd: 0.91,
  entryFillPremium: 1.04,
  exitFillPremium: 2.78,
};

async function openAndClose(): Promise<void> {
  await recordOptionTradeOpen(baseOpen());
  await recordOptionTradeClose('pos-2819', {
    closeTs: 1785505404222,
    outcome: 'WIN',
    realizedPnlUsd: 714,
    realizedR: 1.7939,
    exitReason: 'trail',
    holdDays: 1.0007,
  });
}

describe('TRA-2819 amend_close_basis', () => {
  it('supersedes the money and SURVIVES a cold replay of the append-only store', async () => {
    await openAndClose();
    expect(await recordOptionTradeCloseBasis('pos-2819', BROKER, 1786000000000)).toBe(true);

    // Re-pointing at the same file drops the in-process fold and forces a cold
    // replay from bytes. A same-cache re-read would be vacuous: it would prove
    // the map was mutated, not that the correction is durable (TRA-3485).
    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();
    const row = rows.find((r) => r.id === 'pos-2819')!;

    expect(row.realizedPnlUsd).toBe(695.09);
    expect(row.realizedR).toBe(1.7465);
    expect(row.pnlBasis).toBe('broker-fill');
    expect(row.feesUsd).toBe(0.91);
    expect(row.entryFillPremium).toBe(1.04);
    expect(row.exitFillPremium).toBe(2.78);
    // The witness carried ON the row: the correction is auditable from the row
    // alone, without a diff against a store nobody kept.
    expect(row.realizedPnlUsdBeforeRestatement).toBe(714);
  });

  it('leaves closeTs, exitReason, holdDays and outcome-story untouched', async () => {
    await openAndClose();
    await recordOptionTradeCloseBasis('pos-2819', BROKER);
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-2819')!;
    // Broker fills say what a trade earned. They cannot say why it was exited,
    // and the engine already journalled that.
    expect(row.exitReason).toBe('trail');
    expect(row.closeTs).toBe(1785505404222);
    expect(row.holdDays).toBe(1.0007);
  });

  it('REFUSES an OPEN row — a realized figure must never land on an unsettled position', async () => {
    await recordOptionTradeOpen(baseOpen());
    expect(await recordOptionTradeCloseBasis('pos-2819', BROKER)).toBe(false);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-2819')!;
    expect(row.outcome).toBe('OPEN');
    expect(row.realizedPnlUsd).toBeUndefined();
    expect(row.pnlBasis).toBeUndefined();
  });

  it('no-ops on an unknown id and on a non-finite basis', async () => {
    await openAndClose();
    expect(await recordOptionTradeCloseBasis('missing', BROKER)).toBe(false);
    expect(await recordOptionTradeCloseBasis('pos-2819', { ...BROKER, realizedPnlUsd: NaN })).toBe(false);
    // A null fee must not reach the store as a number either — the planner
    // refuses first, but the writer is the last line and does not assume it.
    expect(
      await recordOptionTradeCloseBasis('pos-2819', { ...BROKER, feesUsd: NaN }),
    ).toBe(false);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-2819')!;
    expect(row.realizedPnlUsd).toBe(714);
  });

  it('publishes a witness with the net delta, which is what tells a real pass from a no-run', async () => {
    await openAndClose();
    await recordOptionTradeCloseBasis('pos-2819', BROKER, 1786000000000);
    setOptionTradeJournalFileForTests(tmpFile);
    await listOptionTradeJournal(); // force the replay that rebuilds the witness

    const w = getOptionTradeCloseBasisAmends();
    expect(w.applied).toBe(1);
    expect(w.refused).toBe(0);
    expect(w.live).toBe(1);
    // +714.00 booked, +695.09 settled: the app was OVERSTATING by 18.91.
    expect(w.netDeltaUsd).toBe(-18.91);
    expect(w.recent[0]).toMatchObject({
      id: 'pos-2819',
      applied: true,
      realizedPnlUsdBefore: 714,
      realizedPnlUsdAfter: 695.09,
      deltaUsd: -18.91,
      feesUsd: 0.91,
      optionSymbol: 'AAPL260904P00280000',
    });
  });

  it('records a REFUSED amend rather than dropping it silently', async () => {
    // An amend line that arrives for a row still OPEN — the out-of-order case
    // the fold guard exists for. It would mean something is pricing a live
    // position as settled, and the silence would be the expensive part.
    await recordOptionTradeOpen(baseOpen());
    const { appendFile } = await import('fs/promises');
    await appendFile(
      tmpFile,
      `${JSON.stringify({ kind: 'amend_close_basis', id: 'pos-2819', ts: 1786000000000, basis: BROKER })}\n`,
      'utf-8',
    );
    setOptionTradeJournalFileForTests(tmpFile);
    await listOptionTradeJournal();

    const w = getOptionTradeCloseBasisAmends();
    expect(w.applied).toBe(0);
    expect(w.refused).toBe(1);
    expect(w.netDeltaUsd).toBe(0);
    expect(w.recent[0]!.applied).toBe(false);
  });

  it('pins the ORIGINAL pre-state across a second amend, so a replay cannot launder it', async () => {
    // Money is last-write-wins; the pre-state is not. Reading it off the record
    // a second time would record 695.09 as "what the engine said" and quietly
    // shrink the recorded size of the defect.
    await openAndClose();
    await recordOptionTradeCloseBasis('pos-2819', BROKER);
    await recordOptionTradeCloseBasis('pos-2819', { ...BROKER, realizedPnlUsd: 695.5 });
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-2819')!;
    expect(row.realizedPnlUsd).toBe(695.5);
    expect(row.realizedPnlUsdBeforeRestatement).toBe(714);
  });

  it('a close arriving AFTER a restatement cannot re-inflate the money', async () => {
    // `recordOptionTradeClose` refuses anything not OPEN, and a restated row is
    // closed. This pins that the restatement does not reopen that door.
    await openAndClose();
    await recordOptionTradeCloseBasis('pos-2819', BROKER);
    await recordOptionTradeClose('pos-2819', {
      closeTs: 1785505404222,
      outcome: 'WIN',
      realizedPnlUsd: 714,
      realizedR: 1.7939,
      exitReason: 'trail',
      holdDays: 1.0007,
    });
    setOptionTradeJournalFileForTests(tmpFile);
    const row = (await listOptionTradeJournal()).find((r) => r.id === 'pos-2819')!;
    expect(row.realizedPnlUsd).toBe(695.09);
  });
});
