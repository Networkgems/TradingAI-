// TRA-4004 — a REAL engine close arriving on a journal row that a reconstruction
// had ALREADY closed used to vanish: `queueJournalClose` found `outcome !==
// 'OPEN'` and returned, with no log line and no witness. The book copy was the
// only record of the close, and the 21:00 ET archive (TRA-219) took it.
//
// ── The measured incident (bqb1, BAC260925C00063000, admin book) ─────────────
//
//   2026-08-21T17:05:10.473Z  engine exits ITS contract (order 142899523);
//                             row `0e180e8c` closes, chandelier_restarted, −$74.
//   2026-08-21T17:06:09.836Z  reconciler MINTS `6bbc5d17` for the desk's residual
//                             lot (TRA-3933), openTs inherited = 08-20T13:36:22Z.
//   2026-08-21T18:01:50.133Z  TRA-3547 zombie sweep: `oldestZombieAgeHours 28.4`,
//                             `backfillClose 1` — it read the 55-minute-old mint
//                             as a 28-hour zombie and allocated the ENGINE's entry
//                             fill and the ENGINE's exit fill to it. `6bbc5d17`
//                             now carries closeTs 17:05:10.473Z, −$74,
//                             `reconstructed-TRA-3472`. The lot is still at the
//                             broker.
//   2026-08-22               the lot is handed to the engine (TRA-3829) and its
//                             basis pinned to the desk's 1.17 (TRA-3958).
//   2026-08-24T19:31:08.062Z  the engine exits the lot for real: order 143160792,
//                             sell_to_close 1 @ 1.14, fees 0.13,
//                             `chandelier_daily_close`, −$3.00. `queueJournalClose`
//                             resolves `6bbc5d17`, finds it CLOSED, returns.
//                             Render tape at 20:45–21:05Z: ZERO journal lines on
//                             the OCC (the `no OPEN row` warn would have matched).
//   2026-08-25T01:00Z         archive. The −$3.00 is gone from `/api/trades/export`.
//
// A loss that leaves the journal is a missing row in the PERMISSIVE direction
// for every fold that counts closes from the journal (TRA-3945's window).
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// A position closes ONCE. If its row already carries a close at a DIFFERENT
// time, that close was never this position's, and the real close must land —
// by superseding the wrong one (`supersede_close`), never by a fresh row that
// would leave the wrong close double-counting. A close within
// `SAME_CLOSE_TOLERANCE_MS` of the existing one IS a duplicate event and must
// still be dropped — the guard is load-bearing (TRA-2819's note on it).
//
// Negative control (run 2026-08-26 before the `queueJournalClose` change
// landed): `the real close lands` was RED with `closeTs` still on the
// reconstruction's millisecond. Same assertion, unedited, green after.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  recordOptionTradeClose,
  recordOptionTradeCloseSupersede,
  getOptionTradeCloseSupersedes,
  SAME_CLOSE_TOLERANCE_MS,
} from './option-trade-journal.js';
import { RECONSTRUCTED_EXIT_REASON } from './tra3485-stale-open-repair.js';
import { selectJournalExportRows } from './export-history.js';
import type { RelativeValueSignal } from '@trading-app/shared';

const OCC = 'BAC260925C00063000';
/** 2026-08-20T13:36:22.482Z — the engine's fill. */
const ENGINE_OPEN = Date.parse('2026-08-20T13:36:22.482Z');
/** 2026-08-21T17:05:10.473Z — the ENGINE's exit, which the reconstruction wrote onto the wrong row. */
const RECONSTRUCTED_CLOSE = Date.parse('2026-08-21T17:05:10.473Z');
/** 2026-08-24T19:31:08.062Z — the lot's REAL exit (order 143160792). */
const REAL_CLOSE = Date.parse('2026-08-24T19:31:08.062Z');
const REAL_EXIT_FILL = 1.14;
const REAL_ORDER_ID = 143160792;
const ENGINE_PREMIUM = 1.65;
const ENGINE_MARK = 1.51;
const EQUITY = 20_000;

function engineSignal(): RelativeValueSignal {
  return {
    id: 'rv-4004',
    symbol: 'BAC',
    type: 'relative_value',
    side: 'buy',
    entryPrice: ENGINE_PREMIUM,
    stopLoss: 1.32,
    takeProfit: 2.475,
    riskRewardRatio: 2,
    timestamp: ENGINE_OPEN,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 63,
    expiration: '2026-09-25',
    mark: ENGINE_MARK,
    fairPrice: 1.9,
    mispricingPct: -0.2,
    zScore: -2.1,
    ivFitted: 0.25,
    ivUsed: 0.22,
    delta: 0.5277755827232543,
    reason: 'TRA-4004 fixture',
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

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ENGINE_OPEN);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4004-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/**
 * The incident's shape on ONE row: the engine opens a lot, a reconstruction
 * closes its row with somebody else's exit while the lot is still open on the
 * book, and the engine then exits the lot for real.
 */
async function openLotAndReconstructItsRow(): Promise<{ acct: PaperOptionsAccount; id: string; premiumPaid: number }> {
  const acct = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'sandbox' });
  const pos = acct.openOptionFromRvCandidate(engineSignal(), 'live', undefined, undefined, SETUP);
  expect(pos).not.toBeNull();
  await acct.flushOptionTradeJournal();

  // The reconstruction. This is what the TRA-3547 sweep wrote on `6bbc5d17`.
  vi.setSystemTime(RECONSTRUCTED_CLOSE + 56 * 60_000);
  const wrote = await recordOptionTradeClose(pos!.id, {
    closeTs: RECONSTRUCTED_CLOSE,
    outcome: 'LOSS',
    realizedPnlUsd: -74,
    realizedR: -0.5248,
    exitReason: RECONSTRUCTED_EXIT_REASON,
    holdDays: 1.1449966666666667,
    brokerOrderId: null,
  });
  expect(wrote).toBe('written');
  // The lot is still on the book — the row is closed, the position is not.
  expect(acct.getState().openOptions.some((o) => o.id === pos!.id)).toBe(true);
  return { acct, id: pos!.id, premiumPaid: pos!.premiumPaid };
}

describe('TRA-4004 — a real engine close on a row a reconstruction already closed', () => {
  it('the real close lands: the row carries the engine exit, and the reconstruction is kept as superseded', async () => {
    const { acct, id, premiumPaid } = await openLotAndReconstructItsRow();

    vi.setSystemTime(REAL_CLOSE);
    const closed = acct.closeOption(id, REAL_EXIT_FILL, 'chandelier_daily_close');
    expect(closed).not.toBeNull();
    await acct.flushOptionTradeJournal();

    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    const rec = rows[0]!;
    // THE assertion. On the old code this reads RECONSTRUCTED_CLOSE.
    expect(rec.closeTs).toBe(REAL_CLOSE);
    expect(rec.exitReason).toBe('chandelier_daily_close');
    expect(rec.outcome).not.toBe('OPEN');
    // The money is the engine's own close arithmetic for THIS lot, not the −74
    // the reconstruction borrowed from the other lot.
    const expectedPnl = (REAL_EXIT_FILL - premiumPaid) * closed!.contracts * 100;
    expect(rec.realizedPnlUsd).toBeCloseTo(expectedPnl, 6);
    expect(rec.realizedR).toBeCloseTo(expectedPnl / rec.atRiskUsd, 6);
    // The replaced close is kept ON the row, so the move is auditable from the
    // row alone (the same reason `realizedPnlUsdBeforeRestatement` exists).
    expect(rec.supersededCloses).toHaveLength(1);
    expect(rec.supersededCloses![0]).toMatchObject({
      closeTs: RECONSTRUCTED_CLOSE,
      realizedPnlUsd: -74,
      exitReason: RECONSTRUCTED_EXIT_REASON,
      reason: 'engine_close_on_already_closed_row',
    });
    // And the witness ledger saw exactly one APPLIED supersession.
    const w = getOptionTradeCloseSupersedes();
    expect(w.applied).toBe(1);
    expect(w.refused).toBe(0);
    expect(w.recent[0]).toMatchObject({ id, applied: true, supersededCloseTs: RECONSTRUCTED_CLOSE, closeTs: REAL_CLOSE });
  });

  it('the export serves the real close once the book twin is gone — the archive edge no longer loses it', async () => {
    const { acct, id } = await openLotAndReconstructItsRow();
    vi.setSystemTime(REAL_CLOSE);
    acct.closeOption(id, REAL_EXIT_FILL, 'chandelier_daily_close');
    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();

    // Post-archive: no book ids. This is the read that returned NOTHING for the
    // 08-24 BAC close on 2026-08-25.
    const served = selectJournalExportRows(rows, new Set());
    expect(served).toHaveLength(1);
    expect(served[0]!.exit_time).toBe(new Date(REAL_CLOSE).toISOString());
    expect(served[0]!.exit_reason).toBe('chandelier_daily_close');
  });

  it('survives a replay of the file — the supersession is a durable line, not an in-memory patch', async () => {
    const { acct, id } = await openLotAndReconstructItsRow();
    vi.setSystemTime(REAL_CLOSE);
    acct.closeOption(id, REAL_EXIT_FILL, 'chandelier_daily_close');
    await acct.flushOptionTradeJournal();

    // Re-point at the SAME file: drops the cache and forces a cold replay.
    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.closeTs).toBe(REAL_CLOSE);
    expect(rows[0]!.exitReason).toBe('chandelier_daily_close');
    expect(rows[0]!.supersededCloses).toHaveLength(1);
    // The witness was rebuilt from the replay too.
    expect(getOptionTradeCloseSupersedes().applied).toBe(1);
  });

  it('a DUPLICATE close event is still dropped — the same-close guard is load-bearing, and the drop is witnessed', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'sandbox' });
    const pos = acct.openOptionFromRvCandidate(engineSignal(), 'live', undefined, undefined, SETUP);
    await acct.flushOptionTradeJournal();
    vi.setSystemTime(REAL_CLOSE);
    acct.closeOption(pos!.id, REAL_EXIT_FILL, 'chandelier_daily_close');
    await acct.flushOptionTradeJournal();
    const before = (await listOptionTradeJournal())[0]!;

    // The same close, reported again a few hundred ms later (the
    // `finalizePendingExit` + `recordImportedFill` double-report shape).
    const again = await recordOptionTradeClose(pos!.id, {
      closeTs: REAL_CLOSE + 400,
      outcome: 'LOSS',
      realizedPnlUsd: before.realizedPnlUsd!,
      realizedR: before.realizedR!,
      exitReason: 'chandelier_daily_close',
      holdDays: before.holdDays!,
      brokerOrderId: REAL_ORDER_ID,
    });
    expect(again).toBe('already_closed');
    const sup = await recordOptionTradeCloseSupersede(
      pos!.id,
      {
        closeTs: REAL_CLOSE + SAME_CLOSE_TOLERANCE_MS,
        outcome: 'LOSS',
        realizedPnlUsd: before.realizedPnlUsd!,
        realizedR: before.realizedR!,
        exitReason: 'chandelier_daily_close',
        holdDays: before.holdDays!,
        brokerOrderId: REAL_ORDER_ID,
      },
      { reason: 'test_duplicate', issue: 'TRA-4004' },
    );
    expect(sup).toEqual({ applied: false, refusal: 'same_close' });
    const after = (await listOptionTradeJournal())[0]!;
    expect(after.closeTs).toBe(REAL_CLOSE);
    expect(after.supersededCloses).toBeUndefined();
    expect(getOptionTradeCloseSupersedes()).toMatchObject({ applied: 0, refused: 1 });
    expect(getOptionTradeCloseSupersedes().recent[0]!.refusal).toBe('same_close');
  });

  it('refuses to supersede an OPEN row or an unknown id — a supersede is never a close', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: EQUITY, tradierEnv: 'sandbox' });
    const pos = acct.openOptionFromRvCandidate(engineSignal(), 'live', undefined, undefined, SETUP);
    await acct.flushOptionTradeJournal();
    const close = {
      closeTs: REAL_CLOSE,
      outcome: 'LOSS' as const,
      realizedPnlUsd: -3,
      realizedR: -0.02,
      exitReason: 'chandelier_daily_close',
      holdDays: 4.3,
      brokerOrderId: REAL_ORDER_ID,
    };
    expect(await recordOptionTradeCloseSupersede(pos!.id, close, { reason: 'test', issue: 'TRA-4004' }))
      .toEqual({ applied: false, refusal: 'row_open' });
    expect(await recordOptionTradeCloseSupersede('no-such-row', close, { reason: 'test', issue: 'TRA-4004' }))
      .toEqual({ applied: false, refusal: 'unknown_row' });
    expect((await listOptionTradeJournal())[0]!.outcome).toBe('OPEN');
    expect(getOptionTradeCloseSupersedes()).toMatchObject({ applied: 0, refused: 2 });
  });

  it('a supersession drops the superseded close\'s broker-basis money rather than relabelling the new close as settled', async () => {
    const { acct, id } = await openLotAndReconstructItsRow();
    // A TRA-2819 restatement lands on the reconstruction (as the TRA-3730 sweep
    // would, against the WRONG fills).
    const { recordOptionTradeCloseBasis } = await import('./option-trade-journal.js');
    expect(await recordOptionTradeCloseBasis(id, {
      realizedPnlUsd: -74.26,
      realizedR: -0.4918,
      outcome: 'LOSS',
      feesUsd: 0.26,
      entryFillPremium: 1.65,
      exitFillPremium: 0.91,
    })).toBe(true);
    vi.setSystemTime(REAL_CLOSE);
    acct.closeOption(id, REAL_EXIT_FILL, 'chandelier_daily_close');
    await acct.flushOptionTradeJournal();
    const rec = (await listOptionTradeJournal())[0]!;
    expect(rec.closeTs).toBe(REAL_CLOSE);
    expect(rec.pnlBasis).toBeUndefined();
    expect(rec.feesUsd).toBeUndefined();
    expect(rec.entryFillPremium).toBeUndefined();
    expect(rec.exitFillPremium).toBeUndefined();
    expect(rec.realizedPnlUsdBeforeRestatement).toBeUndefined();
    // The superseded entry remembers the RESTATED figure it carried at the time.
    expect(rec.supersededCloses![0]!.realizedPnlUsd).toBe(-74.26);
  });
});
