// TRA-4025 (parent TRA-4004) — the 2026-08-21T18:01:50Z write, replayed through
// BOTH layers that let it happen, with a positive control at each layer.
//
// The tape (bqb1, BAC260925C00063000; every stamp is the live one):
//
//   08-20T13:36:22.482Z  journal 0e180e8c single_leg_otm OPEN            (engine lot)
//   08-20T13:36:23.573Z  ledger  buy_to_open   1 @ 1.65  order 142603649 (engine entry)
//   08-20T17:00:00.000Z  ledger  buy_to_open   1 @ 1.17  history_import  (desk entry, synthetic stamp)
//   08-21T17:05:10.473Z  ledger  sell_to_close 1 @ 0.91  order 142899523 (engine exit; 0e180e8c CLOSED on it, same ms)
//   08-21T17:06:09.836Z  reconciler MINTS 6bbc5d17 tradier_import, openTs INHERITED = 13:36:22.761Z (TRA-3933)
//   08-21T18:01:50.133Z  zombie sweep: liveOpenRows 2, zombieOpenRows 1, oldestZombieAgeHours 28.4, backfillClose 1
//                        → 6bbc5d17 CLOSED at 17:05:10.473Z, −74, reconstructed-TRA-3472   ← THE WRITE
//   08-24T19:31:08.062Z  ledger  sell_to_close 1 @ 1.14  order 143160792 (the lot's REAL exit; dropped → TRA-4004)
//
// Two defects, two guards, and each guard is proven ALONE:
//   AC1/AC2  the planner handed the desk row fills that were already 0e180e8c's
//            (the sibling-claim rule, shipped under TRA-3986 as `claimFillsBySiblingRows`);
//   AC3      the sweep read the 55-minute-old mint as a 28.4-hour zombie off the
//            inherited `openTs` and cleared the age floor (`zombieAgeAnchorTs`);
//   AC4      the close-basis restatement shares the exclusion through
//            `partitionClaimedFills` rather than re-spelling it.
import { describe, it, expect, beforeEach } from 'vitest';
import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeJournalClose, OptionTradeJournalRecord } from './option-trade-journal.js';
import { planCloseBasisRestate } from './tra2819-close-basis-restate.js';
import { planStaleOpenRepair, RECONSTRUCTED_EXIT_REASON } from './tra3485-stale-open-repair.js';
import {
  runZombieOpenSweep,
  resetZombieOpenSweepStateForTests,
  zombieAgeAnchorTs,
  ZOMBIE_MIN_AGE_MS,
  type ZombieSweepDeps,
} from './zombie-open-journal-sweep.js';

const T = (iso: string): number => Date.parse(iso);
const OCC = 'BAC260925C00063000';

/** The sweep tick that wrote the bad close. */
const SWEEP_AT = T('2026-08-21T18:01:50.133Z');
/** When the reconciler actually wrote row 6bbc5d17. */
const MINTED_AT = T('2026-08-21T17:06:09.836Z');
/** What the mint copied from the broker aggregate — the ENGINE lot's acquisition. */
const INHERITED_OPEN_TS = T('2026-08-20T13:36:22.761Z');

function row(overrides: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'row',
    openTs: INHERITED_OPEN_TS,
    symbol: 'BAC',
    optionSymbol: OCC,
    structure: 'tradier_import',
    mode: 'live',
    outcome: 'OPEN',
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    entryDelta: 0,
    entryDte: 36,
    atRiskUsd: 141,
    contracts: 1,
    ...overrides,
  };
}

function fill(overrides: Partial<LiveOptionFillRecord> = {}): LiveOptionFillRecord {
  return {
    mode: 'live',
    ts: T('2026-08-20T13:36:23.573Z'),
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    book: null,
    optionSymbol: OCC,
    side: 'buy_to_open',
    contracts: 1,
    submittedLimit: 1.65,
    askAtSubmit: 1.65,
    midAtSubmit: 1.51,
    filledPrice: 1.65,
    fees: 0.13,
    feeSource: 'gainloss_derived',
    slippageVsAsk: 0,
    slippageVsMid: 0.14,
    orderId: 142603649,
    origin: 'fill',
    ...overrides,
  };
}

/** The engine's row as the journal carried it at 18:01Z on 08-21: closed 56 minutes earlier. */
const engineRow = (): OptionTradeJournalRecord => row({
  id: '0e180e8c',
  openTs: T('2026-08-20T13:36:22.482Z'),
  structure: 'single_leg_otm',
  outcome: 'LOSS',
  closeTs: T('2026-08-21T17:05:10.473Z'),
  realizedPnlUsd: -74,
  realizedR: -0.49,
  exitReason: 'chandelier_restarted',
  atRiskUsd: 151,
});

/** The desk's residual lot as the sweep saw it: OPEN, 55 minutes old, wearing the engine's openTs. */
const deskRowAtSweep = (): OptionTradeJournalRecord => row({ id: '6bbc5d17', mintedAt: MINTED_AT });

const engineEntry = (): LiveOptionFillRecord => fill();
const deskEntryImport = (): LiveOptionFillRecord => fill({
  ts: T('2026-08-20T17:00:00.000Z'),
  sleeve: 'unattributed',
  filledPrice: 1.17,
  submittedLimit: null as unknown as number,
  askAtSubmit: null,
  midAtSubmit: null,
  fees: null,
  feeSource: null as unknown as LiveOptionFillRecord['feeSource'],
  slippageVsAsk: null,
  slippageVsMid: null,
  orderId: null,
  origin: 'history_import',
});
const engineExit = (): LiveOptionFillRecord => fill({
  ts: T('2026-08-21T17:05:10.473Z'),
  etDay: '2026-08-21',
  sleeve: 'unattributed',
  side: 'sell_to_close',
  filledPrice: 0.91,
  submittedLimit: 0.91,
  askAtSubmit: 0.95,
  midAtSubmit: 0.93,
  fees: 0.13,
  orderId: 142899523,
});
const deskExit0824 = (): LiveOptionFillRecord => fill({
  ts: T('2026-08-24T19:31:08.062Z'),
  etDay: '2026-08-24',
  sleeve: 'unattributed',
  side: 'sell_to_close',
  filledPrice: 1.14,
  submittedLimit: 1.14,
  askAtSubmit: 1.16,
  midAtSubmit: 1.15,
  fees: 0.13,
  orderId: 143160792,
});

/** The ledger exactly as it stood at 18:01Z on 08-21 (the 08-24 exit had not happened). */
const ledgerAtSweep = (): LiveOptionFillRecord[] => [engineEntry(), deskEntryImport(), engineExit()];

function sweepHarness(rows: OptionTradeJournalRecord[], records: LiveOptionFillRecord[]): {
  deps: ZombieSweepDeps;
  closes: { id: string; close: OptionTradeJournalClose }[];
  voids: { id: string; reason: string }[];
} {
  const closes: { id: string; close: OptionTradeJournalClose }[] = [];
  const voids: { id: string; reason: string }[] = [];
  return {
    closes,
    voids,
    deps: {
      journalEnabled: () => true,
      listLiveJournalRows: async () => rows,
      readLedger: () => ({ n: records.length, records, durability: { ephemeral: false, appendErrors: 0 } }),
      recordClose: async (id, close) => { closes.push({ id, close }); },
      recordVoid: async (id, reason) => { voids.push({ id, reason }); return true; },
      now: () => SWEEP_AT,
      observeOnly: () => false,
    },
  };
}

beforeEach(() => resetZombieOpenSweepStateForTests());

describe('TRA-4025 AC2 — the 2026-08-21T18:01:50Z sweep tick, replayed', () => {
  it('POSITIVE CONTROL: with BOTH guards disarmed the sweep writes the −74 close it wrote live', async () => {
    // Engine row absent (no sibling to claim) AND the mint stamped old enough
    // to clear the floor on its OWN write time. Neither guard applies, so this
    // is the write the sweep made — proof the harness reaches `recordClose`.
    const h = sweepHarness([row({ id: '6bbc5d17', mintedAt: SWEEP_AT - ZOMBIE_MIN_AGE_MS - 1 })], ledgerAtSweep());
    const s = await runZombieOpenSweep(h.deps);
    expect(s.lastOutcome).toBe('repaired');
    expect(h.closes).toHaveLength(1);
    expect(h.closes[0]!.id).toBe('6bbc5d17');
    expect(h.closes[0]!.close.closeTs).toBe(T('2026-08-21T17:05:10.473Z'));
    expect(h.closes[0]!.close.exitReason).toBe(RECONSTRUCTED_EXIT_REASON);
    expect(h.closes[0]!.close.realizedPnlUsd).toBe(-74.26);
  });

  it('AC3 ALONE: engine row absent, but the mint is 55 minutes old on its own write time ⇒ youngHeld, no write', async () => {
    // The planner still says backfill_close here (nothing claims the fills),
    // which is exactly the live plan. The sweep read that row as 28.4h old off
    // `openTs`; on `mintedAt` it is 0.9h old and the floor holds it.
    const h = sweepHarness([deskRowAtSweep()], ledgerAtSweep());
    const s = await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(0);
    expect(h.voids).toHaveLength(0);
    expect(s.lastOutcome).toBe('held-young');
    expect(s.counts).toMatchObject({ liveOpenRows: 1, zombieOpenRows: 1, backfillClose: 1, youngHeld: 1, ageUnknownHeld: 0 });
    // 28.4h is what the live tick logged; 0.9h is the truth.
    expect(s.counts!.oldestZombieAgeHours).toBe(0.9);
    expect(s.lastRows[0]).toMatchObject({ id: '6bbc5d17', treatment: 'backfill_close', ageHours: 0.9, applied: false });
    expect(s.lastRows[0]!.reason).toMatch(/held: 0\.9h old \(write-time basis\)/);
  });

  it('AC1 ALONE: engine row present and closed ⇒ the planner refuses (no_action), so there is no zombie to hold', async () => {
    // Even with the mint stamped old enough to clear the floor, the fills are
    // 0e180e8c's and the row is not a zombie at all.
    const h = sweepHarness(
      [engineRow(), row({ id: '6bbc5d17', mintedAt: SWEEP_AT - ZOMBIE_MIN_AGE_MS - 1 })],
      ledgerAtSweep(),
    );
    const s = await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(0);
    expect(h.voids).toHaveLength(0);
    expect(s.lastOutcome).toBe('clean');
    expect(s.counts).toMatchObject({ liveOpenRows: 1, zombieOpenRows: 0, noAction: 1, backfillClose: 0 });
  });

  it('THE TAPE: both guards armed, the row as it actually was ⇒ no_action, nothing written', async () => {
    const h = sweepHarness([engineRow(), deskRowAtSweep()], ledgerAtSweep());
    const s = await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(0);
    expect(h.voids).toHaveLength(0);
    expect(s.lastOutcome).toBe('clean');
    expect(s.counts).toMatchObject({ liveOpenRows: 1, zombieOpenRows: 0, noAction: 1, youngHeld: 0 });

    // And the planner's own verdict names the sibling that owns each fill.
    const plan = planStaleOpenRepair([engineRow(), deskRowAtSweep()], ledgerAtSweep());
    const r = plan.rows[0]!;
    expect(r.id).toBe('6bbc5d17');
    expect(r.treatment).toBe('no_action');
    expect(r.mintedAt).toBe(MINTED_AT);
    expect(r.structure).toBe('tradier_import');
    const claimed = r.excluded.filter((e) => /TRA-3986/.test(e.why));
    expect(claimed.map((e) => e.side)).toEqual(['buy_to_open', 'sell_to_close']);
    expect(claimed[1]!.why).toMatch(/0e180e8c:exit/);
  });
});

describe('TRA-4025 AC3 — the age floor is measured from the row\'s WRITE time', () => {
  it('an engine row anchors on openTs (the OPEN is written before the broker is contacted)', () => {
    const r = { structure: 'single_leg_otm', openTs: 1_000, mintedAt: null };
    expect(zombieAgeAnchorTs(r)).toBe(1_000);
    // Even when an engine row carries a mintedAt, openTs is its write time.
    expect(zombieAgeAnchorTs({ ...r, mintedAt: 5_000 })).toBe(1_000);
  });

  it('a tradier_import row anchors on mintedAt and NEVER falls back to its inherited openTs', () => {
    expect(zombieAgeAnchorTs({ structure: 'tradier_import', openTs: INHERITED_OPEN_TS, mintedAt: MINTED_AT })).toBe(MINTED_AT);
    expect(zombieAgeAnchorTs({ structure: 'tradier_import', openTs: INHERITED_OPEN_TS, mintedAt: null })).toBeNull();
  });

  it('a legacy import with no mintedAt is HELD as age-unknown, counted, and named — not swept off openTs', async () => {
    // Pre-TRA-4025 mint: the exact 08-21 row shape minus the stamp. Its openTs
    // is 28.4h before the tick; the planner says backfill. The sweep must not
    // read that as old enough.
    const h = sweepHarness([row({ id: '6bbc5d17' })], ledgerAtSweep());
    const s = await runZombieOpenSweep(h.deps);
    expect(h.closes).toHaveLength(0);
    expect(s.lastOutcome).toBe('held-young');
    expect(s.counts).toMatchObject({ zombieOpenRows: 1, youngHeld: 1, ageUnknownHeld: 1, oldestZombieAgeHours: null });
    expect(s.lastRows[0]).toMatchObject({ id: '6bbc5d17', ageHours: null, applied: false });
    expect(s.lastRows[0]!.reason).toMatch(/write time UNKNOWN/);
    expect(s.lastRows[0]!.reason).toMatch(/TRA-4025/);
  });

  it('an engine row 28h old with the same fills is still swept — the anchor change is scoped to imports', async () => {
    const engineShaped = row({ id: 'engine-zombie', structure: 'single_leg_otm', openTs: T('2026-08-20T13:36:22.482Z') });
    const h = sweepHarness([engineShaped], ledgerAtSweep());
    const s = await runZombieOpenSweep(h.deps);
    expect(s.lastOutcome).toBe('repaired');
    expect(h.closes.map((c) => c.id)).toEqual(['engine-zombie']);
    expect(s.counts!.oldestZombieAgeHours).toBe(28.4);
  });
});

describe('TRA-4025 AC4 — the close-basis restatement applies the same exclusion', () => {
  /** 6bbc5d17 as it reads TODAY: closed 08-24 by the real exit (TRA-4004), the 08-21 close superseded, no pnlBasis. */
  const deskRowToday = (): OptionTradeJournalRecord => row({
    id: '6bbc5d17',
    mintedAt: MINTED_AT,
    outcome: 'SCRATCH',
    closeTs: T('2026-08-24T19:31:08.062Z'),
    brokerOrderId: 143160792,
    exitReason: 'chandelier_daily_close',
    realizedPnlUsd: -3,
    realizedR: -0.0213,
    supersededCloses: [{
      closeTs: T('2026-08-21T17:05:10.473Z'), outcome: 'LOSS', realizedPnlUsd: -74, realizedR: -0.5248,
      exitReason: RECONSTRUCTED_EXIT_REASON, brokerOrderId: null, supersededAt: T('2026-08-26T04:10:29.410Z'), reason: 'admin_backfill:TRA-4004',
    }],
  });
  const ledgerToday = (): LiveOptionFillRecord[] => [engineEntry(), deskEntryImport(), engineExit(), deskExit0824()];

  it('POSITIVE CONTROL: with the engine row absent the restatement BORROWS the engine\'s 1.65 entry and 0.91 exit', () => {
    // This is the write the ticket warns about: a row without pnlBasis, and
    // the sibling's fills inside its windows. Oldest-first takes the engine's
    // round trip and restates the desk's −3 to the engine's −74.26.
    const plan = planCloseBasisRestate([deskRowToday()], ledgerToday());
    const r = plan.rows[0]!;
    expect(r.treatment).toBe('restate');
    expect(r.entryFillPremium).toBe(1.65);
    expect(r.exitFillPremium).toBe(0.91);
    expect(r.realizedPnlUsdAfter).toBe(-74.26);
    expect(r.deltaUsd).toBe(-71.26);
  });

  it('with the engine row present, the desk row is SKIPPED and both engine fills are excluded naming 0e180e8c', () => {
    const plan = planCloseBasisRestate([engineRow(), deskRowToday()], ledgerToday());
    const desk = plan.rows.find((r) => r.id === '6bbc5d17')!;
    expect(desk.treatment).toBe('skip');
    // What is left for the desk row is the history_import open at the
    // synthetic 17:00Z stamp, 3h24m outside its (inherited) entry window — the
    // honest refusal, the same one the stale-OPEN planner makes.
    expect(desk.skipReason).toBe('no_entry_fill_in_window');
    expect(desk.realizedPnlUsdAfter).toBeNull();
    const claimed = desk.excluded.filter((e) => /TRA-3986/.test(e.why));
    expect(claimed.map((e) => [e.side, e.ts])).toEqual([
      ['buy_to_open', T('2026-08-20T13:36:23.573Z')],
      ['sell_to_close', T('2026-08-21T17:05:10.473Z')],
    ]);
    expect(claimed[0]!.why).toMatch(/0e180e8c:entry/);
    expect(claimed[1]!.why).toMatch(/0e180e8c:exit/);
    expect(plan.skipsByReason['no_entry_fill_in_window']).toBe(1);
  });

  it('the engine row itself still restates off its OWN fills, and the desk\'s 08-24 exit is excluded as 6bbc5d17\'s', () => {
    const plan = planCloseBasisRestate([engineRow(), deskRowToday()], ledgerToday());
    const engine = plan.rows.find((r) => r.id === '0e180e8c')!;
    expect(engine.treatment).toBe('restate');
    expect(engine.entryFillPremium).toBe(1.65);
    expect(engine.exitFillPremium).toBe(0.91);
    // −74 gross → −74.26 net of the two measured 0.13 commissions.
    expect(engine.realizedPnlUsdAfter).toBe(-74.26);
    expect(engine.deltaUsd).toBe(-0.26);
    const claimed = engine.excluded.filter((e) => /TRA-3986/.test(e.why));
    expect(claimed.map((e) => [e.side, e.ts])).toEqual([['sell_to_close', T('2026-08-24T19:31:08.062Z')]]);
    expect(claimed[0]!.why).toMatch(/6bbc5d17:exit/);
  });

  it('every fill on the contract a sibling\'s ⇒ fills_claimed_by_sibling, named, never no_entry_fill_in_window', () => {
    // The ledger minus the history_import open and the 08-24 exit: only the
    // engine's round trip exists, and all of it is 0e180e8c's.
    const plan = planCloseBasisRestate([engineRow(), deskRowToday()], [engineEntry(), engineExit()]);
    const desk = plan.rows.find((r) => r.id === '6bbc5d17')!;
    expect(desk.treatment).toBe('skip');
    expect(desk.skipReason).toBe('fills_claimed_by_sibling');
    expect(desk.reason).toMatch(/TRA-4004/);
    expect(desk.excluded).toHaveLength(2);
    expect(plan.skipsByReason['fills_claimed_by_sibling']).toBe(1);
  });

  it('a partial claim leaves the remainder on offer to the restatement (5-ct exit over a 4-ct row + 1-ct import)', () => {
    // The QQQ260911P00545000 live shape, restated rather than reconstructed:
    // the imported 1-ct row is CLOSED on the 5-ct exit's millisecond and must
    // price its exit off the 1 contract the engine row did not claim.
    const QQQ = 'QQQ260911P00545000';
    const closeTs = T('2026-08-05T13:44:17.690Z');
    const engine = row({
      id: 'engine', optionSymbol: QQQ, symbol: 'QQQ', structure: 'single_leg_otm', contracts: 4, atRiskUsd: 232,
      openTs: T('2026-08-04T13:47:54.649Z'), outcome: 'LOSS', closeTs, realizedPnlUsd: -56.8, pnlBasis: 'broker-fill',
    });
    const imported = row({
      id: 'import', optionSymbol: QQQ, symbol: 'QQQ', contracts: 1, atRiskUsd: 53, mintedAt: T('2026-08-04T17:00:05.000Z'),
      openTs: T('2026-08-04T17:00:00.000Z'), outcome: 'LOSS', closeTs, realizedPnlUsd: -9.2,
    });
    const ledger: LiveOptionFillRecord[] = [
      fill({ optionSymbol: QQQ, ts: T('2026-08-04T13:47:55.711Z'), contracts: 4, filledPrice: 0.58, orderId: 140028484, fees: 0.52 }),
      fill({ optionSymbol: QQQ, ts: T('2026-08-04T17:00:00.000Z'), contracts: 1, filledPrice: 0.53, orderId: null, origin: 'history_import', fees: 0.13 }),
      fill({ optionSymbol: QQQ, ts: closeTs, side: 'sell_to_close', contracts: 5, filledPrice: 0.438, orderId: 140287732, fees: 0.65 }),
    ];
    const plan = planCloseBasisRestate([engine, imported], ledger);
    const r = plan.rows.find((x) => x.id === 'import')!;
    expect(r.treatment).toBe('restate');
    const exit = r.allocations.find((a) => a.side === 'sell_to_close')!;
    expect(exit.recordContracts).toBe(5);
    expect(exit.allocatedContracts).toBe(1);
    expect(exit.allocatedFees).toBe(0.13);
    // (0.438 − 0.53) × 100 − 0.13 − 0.13 = −9.46
    expect(r.realizedPnlUsdAfter).toBe(-9.46);
    // The engine's 4-ct entry is wholly its own and is named; the 5-ct exit is
    // only partially claimed and stays on offer.
    const claimed = r.excluded.filter((e) => /TRA-3986/.test(e.why));
    expect(claimed.map((e) => [e.side, e.contracts])).toEqual([['buy_to_open', 4]]);
  });
});
