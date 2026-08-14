// TRA-3730 — the sweep driven through the REAL journal fold, not a stub writer.
//
// ── WHY THIS SUITE EXISTS, AND WHY IT IS NOT OPTIONAL ───────────────────────
//
// Graded on live bqb1 bytes immediately after the ship (build `71400070fe64`,
// pid 73, startedAt 2026-08-14T08:23:45Z), the pass read:
//
//   ticks 1 · outcome `clean` · closedLiveRows 13 · restatable 0
//   alreadyRestated 7 · zeroDelta 6 · feesPending 0 · otherSkips 0
//   closeBasisAmends: applied 7, refused 0, netDeltaUsd −27.46
//
// That is a healthy reading and it corroborates the ticket to the cent
// (−25.27 for the 07-30 cohort plus −2.19 for the four residual rows:
// 0.42 + 0.67 + 0.24 + 0.86). It also means the CTO's hand-run had already
// restated every row the ticket names, so the sweep's WRITE PATH had nothing to
// do and **did not execute in production**. The live `clean` therefore proves
// the read, the join, the pricing and the idempotency check — 6 rows were priced
// off fills and found broker-exact — but it proves NOTHING about the write.
//
// A green that comes from an empty population is the failure shape this board
// keeps hitting. So the write is controlled HERE instead, and against the real
// store rather than a spy: the one class of defect a stubbed
// `recordCloseBasis` cannot catch is the sweep being wired to something that
// is not the production fold, which is exactly what the live reading also
// cannot see.
//
// ── AND WHY IT REPLAYS COLD ─────────────────────────────────────────────────
// The journal is an append-only `/data` fold held in memory. Asserting on the
// in-process map after a write proves the map was mutated, not that anything is
// durable (TRA-3485). Every assertion below that matters is made AFTER
// re-pointing the store at the same file, which drops the fold and forces a
// replay from bytes — the same discriminator AC4 puts on the live grade.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import {
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseBasis,
  listOptionTradeJournal,
  isOptionTradeJournalEnabled,
  getOptionTradeCloseBasisAmends,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalOpen,
} from './option-trade-journal.js';
import {
  runCloseBasisSweep,
  resetCloseBasisSweepStateForTests,
  type CloseBasisSweepDeps,
} from './tra3730-close-basis-sweep.js';

const OPEN_TS = Date.parse('2026-08-06T14:05:00Z');
const CLOSE_TS = Date.parse('2026-08-11T17:20:00Z');
const OCC = 'ABCL260918C00010000';

let tmpFile: string;
let counter = 0;

beforeEach(() => {
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra3730-sweep-${process.pid}-${counter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
  resetCloseBasisSweepStateForTests();
});

afterEach(async () => {
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/**
 * The ABCL row from the ticket's residual table, laid down the way production
 * lays it down: an engine OPEN, then a `queueJournalClose` booking
 * `(exit − premiumPaid) × contracts × 100` = −16.00, GROSS of commission,
 * because commission is not knowable at close time.
 */
async function layDownTheLiveRow(): Promise<void> {
  await recordOptionTradeOpen({
    id: 'abcl-live',
    openTs: OPEN_TS,
    symbol: 'ABCL',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'up',
    entryDelta: 0.21,
    entryDte: 43,
    atRiskUsd: 60,
    entrySlippageUsd: 0,
    optionSymbol: OCC,
    contracts: 2,
    entryMarkUsd: 0.3,
    account: 'admin',
  } as OptionTradeJournalOpen);
  await recordOptionTradeClose('abcl-live', {
    closeTs: CLOSE_TS,
    outcome: 'LOSS',
    realizedPnlUsd: -16,
    realizedR: -0.2667,
    exitReason: 'stop',
    holdDays: 5.13,
  });
}

function fills(fees: { entry: number | null; exit: number | null }): LiveOptionFillRecord[] {
  const base = {
    mode: 'live',
    etDay: '2026-08-11',
    sleeve: 'single_leg_otm',
    optionSymbol: OCC,
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    feeSource: 'gainloss_derived',
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'fill',
  };
  return [
    { ...base, side: 'buy_to_open', ts: OPEN_TS + 1_200, contracts: 2, filledPrice: 0.3, fees: fees.entry },
    { ...base, side: 'sell_to_close', ts: CLOSE_TS - 800, contracts: 2, filledPrice: 0.22, fees: fees.exit },
  ] as LiveOptionFillRecord[];
}

/**
 * The deps as `index.ts` builds them, with the REAL journal module on both the
 * read and the write side. Only the fill ledger is supplied directly — it is the
 * broker's half, and the point of the suite is the journal's.
 */
function realDeps(ledger: LiveOptionFillRecord[]): CloseBasisSweepDeps {
  return {
    journalEnabled: () => isOptionTradeJournalEnabled(),
    listLiveJournalRows: () => listOptionTradeJournal({ mode: 'live' }),
    readLedger: () => ({ n: ledger.length, records: ledger, durability: { ephemeral: false, appendErrors: 0 } }),
    recordCloseBasis: (id, basis) => recordOptionTradeCloseBasis(id, basis),
    observeOnly: () => false,
  };
}

/** Drop the in-process fold and replay the store from bytes. */
async function coldReplay() {
  setOptionTradeJournalFileForTests(tmpFile);
  return listOptionTradeJournal({ mode: 'live' });
}

describe('TRA-3730 sweep x real journal fold — the write path the live grade could not exercise', () => {
  it('restates a gross row to broker truth, and the correction SURVIVES a cold replay', async () => {
    await layDownTheLiveRow();
    const before = (await listOptionTradeJournal({ mode: 'live' }))[0]!;
    expect(before.realizedPnlUsd).toBe(-16);
    expect(before.pnlBasis).toBeUndefined();

    const st = await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: 0.43 })));
    expect(st.lastOutcome).toBe('restated');
    expect(st.lastApplied).toEqual({ restated: 1, refused: 0, netDeltaUsd: -0.86 });

    // The assertion that counts: from BYTES, not from the mutated map.
    const [row] = await coldReplay();
    expect(row?.realizedPnlUsd).toBe(-16.86);
    expect(row?.pnlBasis).toBe('broker-fill');
    expect(row?.feesUsd).toBe(0.86);
    // Money moved; the narrative did not. Broker fills say what a trade earned,
    // never why it was exited.
    expect(row?.exitReason).toBe('stop');
    expect(row?.closeTs).toBe(CLOSE_TS);
    expect(row?.holdDays).toBe(5.13);
  });

  it('moves the acceptance witness the way AC2 pre-registers it', async () => {
    await layDownTheLiveRow();
    await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: 0.43 })));

    const amends = getOptionTradeCloseBasisAmends();
    expect(amends.applied).toBe(1);
    // AC2: `closeBasisAmends.refused` stays 0.
    expect(amends.refused).toBe(0);
    // The error IS the fee, so the book moves by exactly the commission.
    expect(amends.netDeltaUsd).toBe(-0.86);
  });

  it('is idempotent ACROSS A RESTART: the replayed row is not re-priced', async () => {
    await layDownTheLiveRow();
    await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: 0.43 })));
    await coldReplay();

    resetCloseBasisSweepStateForTests();
    const second = await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: 0.43 })));

    expect(second.lastOutcome).toBe('clean');
    expect(second.lastApplied.restated).toBe(0);
    expect(second.counts?.alreadyRestated).toBe(1);
    // A second amend line per row per boot would make `netDeltaUsd` — the
    // acceptance figure — drift on an unchanged book.
    expect(getOptionTradeCloseBasisAmends().applied).toBe(1);
    expect(getOptionTradeCloseBasisAmends().netDeltaUsd).toBe(-0.86);
  });

  it('AC3 through the real store: an unmeasured fee leaves the row untouched on disk', async () => {
    await layDownTheLiveRow();
    const st = await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: null })));
    expect(st.lastOutcome).toBe('fees-pending');

    const [row] = await coldReplay();
    // Unchanged `realizedPnlUsd`, and NO `pnlBasis` — the row is still honestly
    // labelled as the engine's own arithmetic. Zero-filling would have written
    // −16.43 here wearing a broker-settled label, which is the one outcome the
    // ticket names as strictly worse than the number it replaced.
    expect(row?.realizedPnlUsd).toBe(-16);
    expect(row?.pnlBasis).toBeUndefined();
    expect(getOptionTradeCloseBasisAmends().total).toBe(0);
  });

  it('AC1 in miniature: the SAME row restates on a later tick once the fee lands, unattended', async () => {
    await layDownTheLiveRow();

    // Tick 1 — lot has not settled into /gainloss.
    expect((await runCloseBasisSweep(realDeps(fills({ entry: null, exit: null })))).lastOutcome).toBe('fees-pending');
    expect((await coldReplay())[0]?.pnlBasis).toBeUndefined();

    // Tick 2 — the fee reconcile has since back-filled the lot. Nothing else
    // changed: no deploy, no admin POST, no operator. That is the whole claim.
    resetCloseBasisSweepStateForTests();
    expect((await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: 0.43 })))).lastOutcome).toBe('restated');

    const [row] = await coldReplay();
    expect(row?.pnlBasis).toBe('broker-fill');
    expect(row?.realizedPnlUsd).toBe(-16.86);
  });

  it('the OPEN guard holds through the real fold, not merely through the planner filter', async () => {
    // The planner already declines to offer an OPEN row, so this reaches past it
    // and asks the WRITER directly with the basis the sweep would have carried.
    // If that guard ever softened, the sweep's own filter would be the only thing
    // left between an unsettled position and a realized figure.
    await recordOptionTradeOpen({
      id: 'still-open',
      openTs: OPEN_TS,
      symbol: 'ABCL',
      structure: 'single_leg_otm',
      mode: 'live',
      trend: 'up',
      entryDelta: 0.21,
      entryDte: 43,
      atRiskUsd: 60,
      entrySlippageUsd: 0,
      optionSymbol: OCC,
      contracts: 2,
      entryMarkUsd: 0.3,
      account: 'admin',
    } as OptionTradeJournalOpen);

    const refused = await recordOptionTradeCloseBasis('still-open', {
      realizedPnlUsd: -16.86,
      realizedR: -0.281,
      outcome: 'LOSS',
      feesUsd: 0.86,
      entryFillPremium: 0.3,
      exitFillPremium: 0.22,
    });
    expect(refused).toBe(false);

    const st = await runCloseBasisSweep(realDeps(fills({ entry: 0.43, exit: 0.43 })));
    expect(st.counts?.closedLiveRows).toBe(0);
    const [row] = await coldReplay();
    expect(row?.outcome).toBe('OPEN');
    expect(row?.pnlBasis).toBeUndefined();
  });
});
