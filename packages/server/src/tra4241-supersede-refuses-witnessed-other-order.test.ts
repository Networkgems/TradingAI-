// TRA-4241 — the `supersede_close` fold used to demote a WITNESSED broker fill.
//
// ── The measured incident (bqb1, RIG260925C00006000, admin book, REAL MONEY) ──
//
// Journal row `8a849902-8dec-409a-9498-d1411e97f26f`, restated between two
// pinned captures with the SAME row id:
//
//   field           2026-08-26 capture      2026-09-01 capture
//   closeTs         2026-08-24T15:15:55Z    2026-08-26T13:45:31Z
//   exitReason      sl_otm_premium_pct      profit_lock
//   brokerOrderId   143048620               143384264
//
// `closeSupersedes.recent` records the move as `engine_close_on_already_closed_row`,
// `applied: true`, `refusal: null`. Lifetime at the time of filing: total 2,
// applied 2, refused 0 — the path had never refused anything.
//
// ── What the BROKER tape says (TRA-3939 durable capture, read 2026-09-08) ─────
//
//   142920548  08-21T18:04:24.685Z  buy_to_open   filled 1  engine_placed
//   143033860  08-24T14:46:13.078Z  buy_to_open   filled 1  desk_placed
//   143048620  08-24T15:15:54.134Z  sell_to_close filled 1  engine_placed
//   143384264  08-26T13:45:30.269Z  sell_to_close filled 1  engine_placed
//
// TWO lots, TWO exits, both filled. So the second close was a REAL exit of a
// REAL contract — it just was not the exit of the lot the row described. The
// money survived the restatement; what did not survive is WHEN the row closed
// and WHY, which is the entire content of a strategy grade. TRA-3957's closed
// BREACH verdict was graded on `sl_otm_premium_pct` closing on 08-24, and after
// the supersede the row it names carries neither.
//
// ── The rule ─────────────────────────────────────────────────────────────────
//
// A position closes ONCE. When the close already on the row is one the BROKER
// witnessed under some order, a close arriving under a DIFFERENT order is not a
// correction of it — it is a second lot's exit. Key on the broker order, never
// on the clock (the TRA-4082 rule). REFUSE, and say so ON THE ROW.
//
// Two closes it must still let through:
//   • a RECONSTRUCTED close — nobody witnessed it, nothing real is demoted.
//     That is the shape TRA-4004 built the path for and it must keep working;
//   • a RESTORE — an incoming close whose order is already in this row's own
//     `supersededCloses[]`. This is the door the TRA-4082 detach repair leaves
//     through, and it authorises itself off the row rather than off a flag.
//
// Negative control: every assertion below that names `refused` / `witnessed_other_order`
// / `refusedCloseSupersedes` fails against the pre-TRA-4241 fold, which applied
// the incident payload unconditionally.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import {
  setOptionTradeJournalFileForTests,
  recordOptionTradeOpen,
  recordOptionTradeClose,
  recordOptionTradeCloseSupersede,
  getOptionTradeCloseSupersedes,
  getOptionTradeJournalRecord,
  RECONSTRUCTED_EXIT_REASON,
} from './option-trade-journal.js';

const OCC = 'RIG260925C00006000';
const ROW_ID = '8a849902-8dec-409a-9498-d1411e97f26f';
/** 2026-08-21T18:04:24Z — the engine lot's entry (order 142920548). */
const ENGINE_OPEN = Date.parse('2026-08-21T18:04:24.494Z');
/** The close the row CARRIED: order 143048620, filled 08-24. */
const ENGINE_CLOSE = Date.parse('2026-08-24T15:15:55.327Z');
const ENGINE_ORDER = 143048620;
/** The close that ARRIVED: order 143384264, filled 08-26 — the OTHER lot's. */
const RESIDUAL_CLOSE = Date.parse('2026-08-26T13:45:31.275Z');
const RESIDUAL_ORDER = 143384264;
const ENGINE_BASIS = 0.33;

/** The incident's incoming payload, verbatim off `closeSupersedes.recent`. */
const INCOMING_CLOSE = {
  closeTs: RESIDUAL_CLOSE,
  outcome: 'LOSS' as const,
  realizedPnlUsd: -7,
  realizedR: -0.2121,
  exitReason: 'profit_lock',
  holdDays: (RESIDUAL_CLOSE - ENGINE_OPEN) / 86_400_000,
  brokerOrderId: RESIDUAL_ORDER,
};

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(ENGINE_OPEN);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4241-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

async function seedRow(exitReason: string, brokerOrderId: number | null): Promise<void> {
  expect(await recordOptionTradeOpen({
    id: ROW_ID, openTs: ENGINE_OPEN, symbol: 'RIG', structure: 'single_leg_otm', mode: 'live',
    ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.3, entryDte: 35,
    atRiskUsd: ENGINE_BASIS * 100, optionSymbol: OCC, contracts: 1, account: 'admin',
  })).toBe(true);
  expect(await recordOptionTradeClose(ROW_ID, {
    closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15.24, realizedR: -0.4618,
    exitReason, holdDays: (ENGINE_CLOSE - ENGINE_OPEN) / 86_400_000,
    ...(brokerOrderId === null ? {} : { brokerOrderId }),
    entryBasisPremium: ENGINE_BASIS,
  })).toBe('written');
}

describe('TRA-4241 — a supersede may not demote a witnessed broker fill', () => {
  it('AC2 positive control: the incident\'s own two payloads — REFUSED, not applied', async () => {
    await seedRow('sl_otm_premium_pct', ENGINE_ORDER);

    const result = await recordOptionTradeCloseSupersede(
      ROW_ID,
      INCOMING_CLOSE,
      { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' },
      RESIDUAL_CLOSE,
    );

    expect(result.applied).toBe(false);
    expect(result.refusal).toBe('witnessed_other_order');

    // The three columns TRA-3957 was graded on are still the ones it was graded on.
    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.closeTs).toBe(ENGINE_CLOSE);
    expect(row?.exitReason).toBe('sl_otm_premium_pct');
    expect(row?.brokerOrderId).toBe(ENGINE_ORDER);
    expect(row?.realizedPnlUsd).toBe(-15.24);
    // …and nothing was demoted into `supersededCloses[]`, where no export looks.
    expect(row?.supersededCloses ?? []).toEqual([]);

    const witness = getOptionTradeCloseSupersedes();
    expect(witness.refused).toBeGreaterThanOrEqual(1);
    expect(witness.recent.at(-1)).toMatchObject({
      id: ROW_ID,
      applied: false,
      refusal: 'witnessed_other_order',
      optionSymbol: OCC,
      mode: 'live',
      supersededExitReason: 'sl_otm_premium_pct',
    });
  });

  it('AC2: the clock is NOT the key — a two-day gap does not license the move', async () => {
    // The pre-TRA-4241 fold refused only on `closeTs` proximity, so the further
    // apart the two closes were the MORE certain it was that the move was right.
    // The incident's closes are 46.5 hours apart and the move was still wrong.
    await seedRow('sl_otm_premium_pct', ENGINE_ORDER);
    const gapHours = (RESIDUAL_CLOSE - ENGINE_CLOSE) / 3_600_000;
    expect(gapHours).toBeGreaterThan(46);

    const result = await recordOptionTradeCloseSupersede(
      ROW_ID, INCOMING_CLOSE, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    );
    expect(result.refusal).toBe('witnessed_other_order');
  });

  it('AC3: the refusal is readable ON THE ROW, with both closes named', async () => {
    await seedRow('sl_otm_premium_pct', ENGINE_ORDER);
    await recordOptionTradeCloseSupersede(
      ROW_ID, INCOMING_CLOSE, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    );

    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.refusedCloseSupersedes).toHaveLength(1);
    expect(row?.refusedCloseSupersedes?.[0]).toEqual({
      refusal: 'witnessed_other_order',
      refusedAt: RESIDUAL_CLOSE,
      closeTs: RESIDUAL_CLOSE,
      exitReason: 'profit_lock',
      realizedPnlUsd: -7,
      brokerOrderId: RESIDUAL_ORDER,
      retainedCloseTs: ENGINE_CLOSE,
      retainedExitReason: 'sl_otm_premium_pct',
      retainedRealizedPnlUsd: -15.24,
      retainedBrokerOrderId: ENGINE_ORDER,
      reason: 'engine_close_on_already_closed_row',
      issue: 'TRA-4004',
    });
  });

  it('AC3: the row\'s testimony survives a RELOAD — the refused line is durable', async () => {
    // The bounded in-memory ring is emptied by every restart and evicted at 500
    // entries. A grade re-derived from the row after a redeploy has to still see
    // that something tried to restate it.
    await seedRow('sl_otm_premium_pct', ENGINE_ORDER);
    await recordOptionTradeCloseSupersede(
      ROW_ID, INCOMING_CLOSE, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    );

    // Re-pointing at the SAME file drops the in-memory cache and every witness
    // ring, so the next read is a cold replay of the bytes on disk — the same
    // thing a redeploy does.
    setOptionTradeJournalFileForTests(tmpFile);

    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.exitReason).toBe('sl_otm_premium_pct');
    expect(row?.brokerOrderId).toBe(ENGINE_ORDER);
    // Rebuilt by the replay, and exactly ONCE — the fold is deterministic, so a
    // durable refused line must not accumulate a fresh entry on every reload.
    expect(row?.refusedCloseSupersedes).toHaveLength(1);
    expect(row?.refusedCloseSupersedes?.[0]?.brokerOrderId).toBe(RESIDUAL_ORDER);
  });

  it('TRA-4004 still works: a RECONSTRUCTED close is not a witnessed fill', async () => {
    // `6bbc5d17`'s shape — the row's close was BUILT by the TRA-3547 sweep, not
    // observed. Nothing real is demoted, so the real close must still land.
    await seedRow(RECONSTRUCTED_EXIT_REASON, ENGINE_ORDER);
    const result = await recordOptionTradeCloseSupersede(
      ROW_ID, INCOMING_CLOSE, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    );
    expect(result.applied).toBe(true);
    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.exitReason).toBe('profit_lock');
    expect(row?.brokerOrderId).toBe(RESIDUAL_ORDER);
    expect(row?.supersededCloses).toHaveLength(1);
  });

  it('a close on a row whose own close carries NO broker order still lands', async () => {
    // Nobody witnessed the close on the row, so there is nothing to protect.
    await seedRow('chandelier', null);
    const result = await recordOptionTradeCloseSupersede(
      ROW_ID, INCOMING_CLOSE, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    );
    expect(result.applied).toBe(true);
    expect((await getOptionTradeJournalRecord(ROW_ID))?.brokerOrderId).toBe(RESIDUAL_ORDER);
  });

  it('TRA-4082 detach still works: RESTORING a close the row already superseded', async () => {
    // The repair that undid the incident. The row has been wrongly moved to the
    // residual's close; putting the engine's close back cannot demote anything,
    // because the row itself testifies it once carried it.
    await seedRow(RECONSTRUCTED_EXIT_REASON, ENGINE_ORDER);
    expect((await recordOptionTradeCloseSupersede(
      ROW_ID, INCOMING_CLOSE, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    )).applied).toBe(true);

    const restored = await recordOptionTradeCloseSupersede(
      ROW_ID,
      {
        closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15.24, realizedR: -0.4618,
        exitReason: 'sl_otm_premium_pct', holdDays: (ENGINE_CLOSE - ENGINE_OPEN) / 86_400_000,
        brokerOrderId: ENGINE_ORDER,
      },
      { reason: 'admin_detach_restore:TRA-4082:moved_to:96b0dc72', issue: 'TRA-4082' },
      RESIDUAL_CLOSE + 1,
    );
    expect(restored.applied).toBe(true);
    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.exitReason).toBe('sl_otm_premium_pct');
    expect(row?.brokerOrderId).toBe(ENGINE_ORDER);
  });

  it('an incoming close carrying NO broker order cannot displace a witnessed one', async () => {
    // The permissive direction: `null` is not "matches whatever is there". An
    // unattributed close replacing a witnessed fill is the same demotion with
    // less evidence behind it.
    await seedRow('sl_otm_premium_pct', ENGINE_ORDER);
    const { brokerOrderId: _drop, ...unattributed } = INCOMING_CLOSE;
    void _drop;
    const result = await recordOptionTradeCloseSupersede(
      ROW_ID, unattributed, { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' }, RESIDUAL_CLOSE,
    );
    expect(result.refusal).toBe('witnessed_other_order');
    expect((await getOptionTradeJournalRecord(ROW_ID))?.exitReason).toBe('sl_otm_premium_pct');
  });

  it('the duplicate-event guard is untouched: same order, same millisecond, still `same_close`', async () => {
    await seedRow('sl_otm_premium_pct', ENGINE_ORDER);
    const result = await recordOptionTradeCloseSupersede(
      ROW_ID,
      { ...INCOMING_CLOSE, closeTs: ENGINE_CLOSE, brokerOrderId: ENGINE_ORDER },
      { reason: 'engine_close_on_already_closed_row', issue: 'TRA-4004' },
      RESIDUAL_CLOSE,
    );
    expect(result.refusal).toBe('same_close');
    // …and `same_close` writes NOTHING to the row: it is the pre-existing
    // duplicate drop, not a new audit event.
    expect((await getOptionTradeJournalRecord(ROW_ID))?.refusedCloseSupersedes).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The deploy question, answered before the deploy.
//
// The journal is an append-only LOG and the fold is its INTERPRETER, so a new
// refusal does not only change what happens next — it changes how the bytes
// already on disk replay. bqb1's file holds the incident's own `supersede_close`
// line, written by the pre-TRA-4241 build. Under the new fold that line is
// re-refused, which means the state it produced is never rebuilt and the TRA-4082
// admin repair that undid it (2026-09-03) lands on a row that was never moved.
//
// That has to be PROVEN, not assumed: this is a settled real-money row and the
// failure mode of getting it wrong is a silent revert on the next restart. So the
// live line sequence is replayed here, cold, off bytes on disk.
import { appendFile } from 'fs/promises';
import { listOptionTradeJournal } from './option-trade-journal.js';
import { selectJournalExportRows } from './export-history.js';

/** The lot row TRA-4082 minted for the desk residual on 2026-09-03. */
const LOT_ID = '96b0dc72';

describe('TRA-4241 — replaying bqb1\'s ACTUAL journal bytes under the new fold', () => {
  /**
   * Row `8a849902`'s line sequence as the live file carries it, in order:
   *
   *   1  open              2026-08-21T18:04:24Z, atRisk 33, basis 0.33
   *   2  close             08-24T15:15:55.327Z sl_otm_premium_pct −15.24 order 143048620
   *   3  supersede_close   08-26T13:45:31.278Z → profit_lock −7 order 143384264
   *                        (`engine_close_on_already_closed_row` — THE DEFECT)
   *   4  amend_close_basis 08-26T14:01:03Z, the TRA-3730 sweep: −15.24 broker-fill,
   *                        fills 0.33→0.18, fees 0.24
   *   5  supersede_close   09-03T13:56:56.531Z → back to sl_otm_premium_pct order
   *                        143048620 (`admin_detach_restore:TRA-4082`)
   *
   * plus the lot row `96b0dc72`'s own open/close, which no supersede touches.
   */
  async function writeLiveBytes(): Promise<void> {
    const lines = [
      { kind: 'open', rec: {
        id: ROW_ID, openTs: ENGINE_OPEN, symbol: 'RIG', structure: 'single_leg_otm', mode: 'live',
        ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0.5218980495019767, entryDte: 35,
        atRiskUsd: 33, optionSymbol: OCC, contracts: 1, account: 'admin',
      } },
      { kind: 'close', id: ROW_ID, close: {
        closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15.24, realizedR: -0.4618,
        exitReason: 'sl_otm_premium_pct', holdDays: 2.8829957523148146,
        brokerOrderId: ENGINE_ORDER, entryBasisPremium: 0.33,
      } },
      { kind: 'supersede_close', id: ROW_ID, ts: 1787751931278, reason: 'engine_close_on_already_closed_row',
        issue: 'TRA-4004', close: {
          closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -0.2121,
          exitReason: 'profit_lock', holdDays: 4.820213240740741, brokerOrderId: RESIDUAL_ORDER,
        } },
      { kind: 'amend_close_basis', id: ROW_ID, ts: 1787752831278, basis: {
        realizedPnlUsd: -15.24, realizedR: -0.4618, outcome: 'LOSS', feesUsd: 0.24,
        entryFillPremium: 0.33, exitFillPremium: 0.18,
      } },
      { kind: 'open', rec: {
        id: LOT_ID, openTs: 1787335464851, symbol: 'RIG', structure: 'tradier_import', mode: 'live',
        ivRank: null, trend: 'unknown', sentiment: null, entryDelta: 0, entryDte: 35,
        atRiskUsd: 22, optionSymbol: OCC, contracts: 1, account: 'admin',
      } },
      { kind: 'close', id: LOT_ID, close: {
        closeTs: RESIDUAL_CLOSE, outcome: 'LOSS', realizedPnlUsd: -7, realizedR: -0.3182,
        exitReason: 'profit_lock', holdDays: 4.820213240740741,
        brokerOrderId: RESIDUAL_ORDER, entryBasisPremium: 0.22,
      } },
      { kind: 'supersede_close', id: ROW_ID, ts: 1788443816531, issue: 'TRA-4082',
        reason: 'admin_detach_restore:TRA-4082:moved_to:96b0dc72', close: {
          closeTs: ENGINE_CLOSE, outcome: 'LOSS', realizedPnlUsd: -15.24, realizedR: -0.4618,
          exitReason: 'sl_otm_premium_pct', holdDays: 2.8829957523148146,
          brokerOrderId: ENGINE_ORDER, entryBasisPremium: 0.33,
        } },
    ];
    await appendFile(tmpFile, lines.map((l) => JSON.stringify(l)).join('\n') + '\n', 'utf-8');
    // Cold load off those bytes — what the next boot does.
    setOptionTradeJournalFileForTests(tmpFile);
  }

  it('AC4 — the incident line is re-REFUSED on replay, so the row is never moved', async () => {
    await writeLiveBytes();

    const row = await getOptionTradeJournalRecord(ROW_ID);
    // The three columns TRA-3957 was graded on, rebuilt from the log alone.
    expect(row?.closeTs).toBe(ENGINE_CLOSE);
    expect(row?.exitReason).toBe('sl_otm_premium_pct');
    expect(row?.brokerOrderId).toBe(ENGINE_ORDER);
    expect(row?.realizedPnlUsd).toBe(-15.24);
    expect(row?.realizedR).toBe(-0.4618);

    const witness = getOptionTradeCloseSupersedes();
    expect(witness.refused).toBeGreaterThanOrEqual(1);
    expect(witness.recent.map((r) => r.refusal)).toEqual(['witnessed_other_order', 'same_close']);
    // The 09-03 repair is now a no-op that refuses `same_close` — it was undoing
    // a move that no longer happens. Neither line applies, and neither is needed.
    expect(witness.applied).toBe(0);
  });

  it('AC3 — the row testifies to the refusal after a cold load, with no ring to help it', async () => {
    await writeLiveBytes();
    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.refusedCloseSupersedes).toHaveLength(1);
    expect(row?.refusedCloseSupersedes?.[0]).toMatchObject({
      refusal: 'witnessed_other_order',
      exitReason: 'profit_lock',
      brokerOrderId: RESIDUAL_ORDER,
      retainedExitReason: 'sl_otm_premium_pct',
      retainedBrokerOrderId: ENGINE_ORDER,
      reason: 'engine_close_on_already_closed_row',
    });
    // `same_close` writes nothing, so the 09-03 line leaves no second entry.
    expect(row?.refusedCloseSupersedes).toHaveLength(1);
  });

  it('the money is unchanged: BOTH RIG fills still export, −22.24 total (TRA-4082\'s subject)', async () => {
    await writeLiveBytes();
    const served = selectJournalExportRows(await listOptionTradeJournal(), new Set());
    expect(served.map((r) => [r.exit_reason, r.net_pnl_usd]).sort()).toEqual(
      [['profit_lock', -7], ['sl_otm_premium_pct', -15.24]].sort(),
    );
    expect(served.reduce((s, x) => s + (x.net_pnl_usd ?? 0), 0)).toBeCloseTo(-22.24, 6);
  });

  it('replay is IDEMPOTENT — loading the same bytes twice does not accumulate refusals on the row', async () => {
    await writeLiveBytes();
    setOptionTradeJournalFileForTests(tmpFile);
    const row = await getOptionTradeJournalRecord(ROW_ID);
    expect(row?.refusedCloseSupersedes).toHaveLength(1);
    expect(row?.exitReason).toBe('sl_otm_premium_pct');
  });
});
