// TRA-3472 — a live journal OPEN for an order that NEVER FILLED was never retracted.
//
// ── The defect ─────────────────────────────────────────────────────────────
//
// The live open paths journal the OPEN row BEFORE contacting the broker:
// `signal-engine.ts` opens the paper position (which calls `queueJournalOpen`
// synchronously) and only then awaits `mirrorLiveOptionOpen`. Every abort inside
// that mirror — OBP pre-check, DTBP guard, liquidity/spread veto, `rejected`,
// `walk_exhausted`, `no_quote`, a throw — funnels into `tradierVoid`, which
// called `voidOpenOption` to refund the cash and DELETE the position.
//
// Nothing retracted the journal row. The position id it keys on was gone, so no
// close path could ever reach it: `mode:'live'`, `outcome:'OPEN'`, forever, for
// a trade that never happened.
//
// ── Why it is not TRA-2937 ─────────────────────────────────────────────────
//
// Measured on the real admin book on 2026-08-13, cross-joining the 13 stale live
// OPEN rows against the durable fee/slippage fill ledger: SEVEN had real broker
// fills on both legs (dropped closes — the TRA-2937 shape, all opened on or
// before 2026-08-04) and SIX had NO fill on either leg. The newest of those six,
// `SO260918C00092500`, opened 2026-08-11T18:15:24.701Z — six days AFTER the
// `6eb0065` fix that was assumed to cover this. It does not, and could not: a
// never-filled row is not a lost exit, and must never be backfilled as one.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm, appendFile } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  recordOptionTradeVoid,
  recordOptionTradeClose,
  setOptionTradeJournalFileForTests,
  getOptionTradeVoids,
} from './option-trade-journal.js';
import type { OtmMispricingSignal } from '@trading-app/shared';

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');
const OCC = 'SO260918C00092500';

function buildSignal(overrides: Partial<OtmMispricingSignal> = {}): OtmMispricingSignal {
  return {
    id: 'sig-3472',
    symbol: 'SO',
    type: 'otm_mispricing',
    side: 'buy',
    entryPrice: 1.725,
    stopLoss: 1.29,
    takeProfit: 2.6,
    riskRewardRatio: 2,
    timestamp: TRADING_TIME,
    optionSymbol: OCC,
    optionType: 'call',
    strike: 92.5,
    expiration: '2026-09-18',
    mark: 1.725,
    theo: 2.2,
    mispricingPct: -0.21,
    delta: 0.22,
    ...overrides,
  };
}

const OTM_SETUP = {
  ivRank: null,
  trend: 'sideways' as const,
  sentiment: null,
  entryDelta: 0.22,
  riskThrottleMultiplier: 1,
  riskThrottleDecided: 1,
  riskThrottleSizingPath: null,
};

/**
 * The live bounded-test open, exactly as `signal-engine.ts:10145` performs it:
 * two contracts, live mode, journal setup supplied. Deliberately does NOT flush
 * — `queueJournalOpen` chains the append onto `journalWrites` rather than
 * awaiting it, and that gap is itself under test below.
 */
function liveOtmOpen(acct: PaperOptionsAccount) {
  const pos = acct.openOptionFromCandidate(
    buildSignal(), 'live', undefined, 88.2, OTM_SETUP, 2,
  );
  expect(pos).not.toBeNull();
  return pos!;
}

/** What `tradierVoid` now does on every abort branch. */
async function voidLikeTheMirror(acct: PaperOptionsAccount, id: string): Promise<boolean> {
  acct.voidOpenOption(id);
  await acct.flushOptionTradeJournal();
  return recordOptionTradeVoid(id);
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra3472-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

describe('TRA-3472 — an order that never filled leaves no OPEN row behind', () => {
  // THE reported defect. This assertion fails on the pre-fix build: the row is
  // still there, still OPEN, with no position left for any close path to key on.
  it('retracts the journal OPEN when the broker leg voids', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);

    // Positive control: the row this test claims to remove must exist first, or
    // the assertion below passes against a journal that was simply never written.
    await acct.flushOptionTradeJournal();
    const before = await listOptionTradeJournal();
    expect(before).toHaveLength(1);
    expect(before[0]!.outcome).toBe('OPEN');
    expect(before[0]!.mode).toBe('live');
    expect(before[0]!.structure).toBe('single_leg_otm');
    expect(before[0]!.optionSymbol).toBe(OCC);

    expect(await voidLikeTheMirror(acct, pos.id)).toBe(true);

    expect(await listOptionTradeJournal()).toHaveLength(0);
    expect(acct.getStateForMode('live').openOptions).toHaveLength(0);
  });

  // The retraction has to survive the reboot, or it is a per-process illusion:
  // bqb1 restarts several times a day, and the fold replays the file from
  // scratch every time. Re-pointing the test seam at the SAME file drops the
  // cache and forces exactly that replay.
  it('stays retracted across a reload of the append-only file', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);
    await voidLikeTheMirror(acct, pos.id);

    setOptionTradeJournalFileForTests(tmpFile); // fresh load, same bytes
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });

  // The guard that matters more than the fix. A void able to unwind a SETTLED
  // round trip would erase real realized P&L — strictly worse than the stranded
  // row this ticket is about.
  it('REFUSES to void a row that has already closed', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);
    await acct.flushOptionTradeJournal();

    await recordOptionTradeClose(pos.id, {
      closeTs: TRADING_TIME + 3_600_000,
      outcome: 'WIN',
      realizedPnlUsd: 120,
      realizedR: 0.35,
      exitReason: 'take_profit',
      holdDays: 0,
    });

    expect(await recordOptionTradeVoid(pos.id)).toBe(false);
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('WIN');
    expect(rows[0]!.realizedPnlUsd).toBe(120);
  });

  // The flush inside `tradierVoid` is load-bearing, not defensive. This is the
  // race it exists to lose: `queueJournalOpen` CHAINS the append rather than
  // awaiting it, so a bare `recordOptionTradeVoid(id)` runs first, finds no row,
  // no-ops — and the OPEN then lands behind it. The stranded row survives, but
  // now with a retraction that appears to have run. If someone drops the flush,
  // this is the test that says why it was there.
  it('loses the race without the flush, which is why tradierVoid awaits it', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);

    // No flush: the queued OPEN append has not landed yet.
    expect(await recordOptionTradeVoid(pos.id)).toBe(false);

    await acct.flushOptionTradeJournal();
    const rows = await listOptionTradeJournal();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('OPEN'); // exactly the row we meant to remove

    // ...and the ordered form still cleans it up.
    expect(await recordOptionTradeVoid(pos.id)).toBe(true);
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });

  it('is a no-op for an unknown id, so a replayed void cannot delete a foreign row', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    liveOtmOpen(acct);
    await acct.flushOptionTradeJournal();

    expect(await recordOptionTradeVoid('no-such-position')).toBe(false);
    expect(await listOptionTradeJournal()).toHaveLength(1);
  });

  it('no-ops when the journal flag is off', async () => {
    delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
    expect(await recordOptionTradeVoid('anything')).toBe(false);
  });
});

// ── The acceptance witness ───────────────────────────────────────────────────
//
// The retraction above is correct and, on its own, UNGRADEABLE in production.
// It deletes the row, so a book with no stranded rows because the fix fired
// reads exactly like a book with no stranded rows because no order was ever
// attempted — and the second is what an overnight window actually looks like.
// The two `log` calls were the only witnesses, and `/v1/logs?text=` returns
// `logs:null` on bqb1 (TRA-2951 spent a run establishing that).
//
// So the `void` lines, which were already durable on `/data`, are now surfaced.
// A positive control must CONTAIN what it detects.
describe('TRA-3472 — the retraction is observable, or it cannot be accepted', () => {
  it('records a witness naming the abort branch, the OCC and the book', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);
    await acct.flushOptionTradeJournal();

    // Negative control: nothing to see before the void. Without this the
    // assertions below would pass against a ledger that reports every open.
    expect(getOptionTradeVoids().total).toBe(0);

    acct.voidOpenOption(pos.id);
    await acct.flushOptionTradeJournal();
    expect(await recordOptionTradeVoid(pos.id, 'walk_exhausted', TRADING_TIME + 1_000)).toBe(true);

    const voids = getOptionTradeVoids();
    expect(voids.total).toBe(1);
    expect(voids.applied).toBe(1);
    expect(voids.refused).toBe(0);
    expect(voids.live).toBe(1);
    expect(voids.dropped).toBe(0);
    expect(voids.recent[0]).toMatchObject({
      id: pos.id,
      ts: TRADING_TIME + 1_000,
      reason: 'walk_exhausted',
      applied: true,
      mode: 'live',
      symbol: 'SO',
      optionSymbol: OCC,
      structure: 'single_leg_otm',
    });

    // The row itself is gone — which is exactly why the witness has to exist.
    expect(await listOptionTradeJournal()).toHaveLength(0);
  });

  // The witness is read off the record the fold is ABOUT to delete. Get the
  // order wrong and every field but `id` comes back null, which reads as a
  // successful retraction of nothing.
  it('survives the reboot, because the witness is replayed from the file', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);
    await voidLikeTheMirror(acct, pos.id);

    setOptionTradeJournalFileForTests(tmpFile); // drops the cache, replays the bytes
    await listOptionTradeJournal(); // force the load
    const voids = getOptionTradeVoids();
    expect(voids.total).toBe(1);
    expect(voids.applied).toBe(1);
    expect(voids.recent[0]!.optionSymbol).toBe(OCC);
    expect(voids.recent[0]!.mode).toBe('live');
  });

  // A void that arrives for an ALREADY-CLOSED row is refused by the fold — the
  // guard that protects settled P&L. Refusing it silently would hide something
  // trying to unwind a real round trip, so it is recorded as `applied:false`.
  it('records a REFUSED void rather than dropping it', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);
    await acct.flushOptionTradeJournal();

    // Hand-write the out-of-order pair the writer's own guard would never emit,
    // then replay: open → close → void.
    await recordOptionTradeClose(pos.id, {
      closeTs: TRADING_TIME + 3_600_000,
      outcome: 'WIN',
      realizedPnlUsd: 120,
      realizedR: 0.35,
      exitReason: 'take_profit',
      holdDays: 0,
    });
    await appendFile(
      tmpFile,
      `${JSON.stringify({ kind: 'void', id: pos.id, ts: TRADING_TIME + 7_200_000, reason: 'replayed' })}\n`,
      'utf-8',
    );

    setOptionTradeJournalFileForTests(tmpFile);
    const rows = await listOptionTradeJournal();

    // The settled round trip is intact — the guard held.
    expect(rows).toHaveLength(1);
    expect(rows[0]!.outcome).toBe('WIN');
    expect(rows[0]!.realizedPnlUsd).toBe(120);

    // ...and the refusal is visible instead of silent.
    const voids = getOptionTradeVoids();
    expect(voids.total).toBe(1);
    expect(voids.applied).toBe(0);
    expect(voids.refused).toBe(1);
    expect(voids.recent[0]).toMatchObject({ id: pos.id, applied: false, reason: 'replayed' });
  });

  // A legacy `{kind,id}` line — written by the shipped `a4ed77a2` build before
  // this change — must still yield a usable witness, just without ts/reason.
  // Otherwise deploying the witness would make the retractions already on disk
  // read as if they had never happened.
  it('yields a witness for a pre-existing void line with no ts or reason', async () => {
    const acct = new PaperOptionsAccount({ initialEquity: 50_000, tradierEnv: 'production' });
    const pos = liveOtmOpen(acct);
    await acct.flushOptionTradeJournal();
    await appendFile(tmpFile, `${JSON.stringify({ kind: 'void', id: pos.id })}\n`, 'utf-8');

    setOptionTradeJournalFileForTests(tmpFile);
    expect(await listOptionTradeJournal()).toHaveLength(0);

    const voids = getOptionTradeVoids();
    expect(voids.total).toBe(1);
    expect(voids.applied).toBe(1);
    expect(voids.recent[0]).toMatchObject({
      id: pos.id,
      ts: null,
      reason: null,
      optionSymbol: OCC,
      mode: 'live',
    });
  });
});
