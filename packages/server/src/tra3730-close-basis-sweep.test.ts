// TRA-3730 — the SELF-DRIVING half of the close-basis restatement.
//
// TRA-2819's planner has its own suite and nothing here re-tests the pricing
// arithmetic. What is under test is the part that only exists because the pass
// is UNATTENDED:
//
//   * it must WRITE without an admin token (the whole point — the repair route
//     is `requireAuth + requireAdmin` and admin writes are unreachable on bqb1), and
//   * it must NOT write in the situations where an unattended writer is more
//     dangerous than no writer at all: a fee that is still UNMEASURED, a fill
//     ledger that cannot supply broker truth, an explicit observe-only hold, and
//     a row the fold itself refuses.
//
// The fee case is the load-bearing one and it is the ticket's own pre-registered
// AC3. `fees: null` means UNMEASURED, not free (TRA-1707). A just-closed row
// legitimately has no fees yet; zero-filling it would publish a GROSS number
// wearing a broker-settled label, which is strictly worse than the wrong number
// it replaced because it stops anyone from looking again. So the row must be
// SKIPPED, must keep its old `realizedPnlUsd`, must receive no `pnlBasis` — and
// must be COUNTED, because a skip nobody can see is how a permanent backlog
// reads as a finished job.
//
// The alarm carries the same asymmetry TRA-3547 published under: `count: null`
// (never checked) and `count: 0` (checked, clean) must never collapse into each
// other, so both are asserted directly rather than through a truthiness test
// that would pass on either.

import { describe, it, expect, beforeEach } from 'vitest';

import type { LiveOptionFillRecord } from './live-options-fee-slippage-ledger.js';
import type { OptionTradeCloseBasis, OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  runCloseBasisSweep,
  getCloseBasisSweepState,
  resetCloseBasisSweepStateForTests,
  isCloseBasisSweepObserveOnly,
  type CloseBasisSweepDeps,
} from './tra3730-close-basis-sweep.js';

const T = (iso: string): number => Date.parse(iso);
const NOW = T('2026-08-14T22:00:00Z');

// ── The residual cohort, from the CTO's 2026-08-14 read of prod bqb1 build
//    `0e9f0e8bb4b6` ────────────────────────────────────────────────────────────
//
// Two of the four rows the ticket tables, transcribed. Their `app booked`,
// `broker-fill net` and `measured fees` columns are the ticket's own numbers;
// the per-leg fill PRICES are not published there, so they are the smallest
// reconstruction that reproduces the published triple exactly. That is what
// makes the assertions below a grader for the ticket's claim — *the error IS the
// fee, on every row* — rather than a test of arithmetic against itself.
//
//   ABCL260918C00010000  08-11  −16.00 → −16.86   fees 0.86
//   TROW260918C00115000  08-10  −79.00 → −79.24   fees 0.24
//
// Both rows' ENTRY basis is already correct (`restateEngineOpenedBasis`,
// TRA-2889, reached them while they were open), so `entryMarkUsd` equals the
// entry fill and the whole delta is commission. That is the ticket's central
// distinction from the 07-30 cohort, and it is asserted directly.

function fill(
  over: Partial<LiveOptionFillRecord> &
    Pick<LiveOptionFillRecord, 'optionSymbol' | 'side' | 'ts' | 'contracts'>,
): LiveOptionFillRecord {
  return {
    mode: 'live',
    etDay: '2026-08-11',
    sleeve: 'single_leg_otm',
    submittedLimit: null,
    askAtSubmit: null,
    midAtSubmit: null,
    filledPrice: null,
    fees: null,
    feeSource: 'gainloss_derived',
    slippageVsAsk: null,
    slippageVsMid: null,
    orderId: null,
    origin: 'fill',
    ...over,
  } as LiveOptionFillRecord;
}

const ABCL_OPEN = T('2026-08-06T14:05:00Z');
const ABCL_CLOSE = T('2026-08-11T17:20:00Z');
const TROW_OPEN = T('2026-08-05T15:10:00Z');
const TROW_CLOSE = T('2026-08-10T18:40:00Z');

function abclRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'abcl-row',
    openTs: ABCL_OPEN,
    closeTs: ABCL_CLOSE,
    symbol: 'ABCL',
    optionSymbol: 'ABCL260918C00010000',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'up',
    entryDelta: 0.21,
    entryDte: 43,
    atRiskUsd: 60,
    contracts: 2,
    entryMarkUsd: 0.3,
    account: 'admin',
    outcome: 'LOSS',
    realizedPnlUsd: -16,
    realizedR: -0.2667,
    exitReason: 'stop',
    holdDays: 5.1,
    ...over,
  } as OptionTradeJournalRecord;
}

function trowRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'trow-row',
    openTs: TROW_OPEN,
    closeTs: TROW_CLOSE,
    symbol: 'TROW',
    optionSymbol: 'TROW260918C00115000',
    structure: 'single_leg_otm',
    mode: 'live',
    trend: 'up',
    entryDelta: 0.3,
    entryDte: 44,
    atRiskUsd: 120,
    contracts: 1,
    entryMarkUsd: 1.2,
    account: 'admin',
    outcome: 'LOSS',
    realizedPnlUsd: -79,
    realizedR: -0.6583,
    exitReason: 'stop',
    holdDays: 5.15,
    ...over,
  } as OptionTradeJournalRecord;
}

/** ABCL fills with fees MEASURED (i.e. the reconcile has reached this lot). */
function abclFills(fees: { entry: number | null; exit: number | null } = { entry: 0.43, exit: 0.43 }): LiveOptionFillRecord[] {
  return [
    fill({
      optionSymbol: 'ABCL260918C00010000',
      side: 'buy_to_open',
      ts: ABCL_OPEN + 1_200,
      contracts: 2,
      filledPrice: 0.3,
      fees: fees.entry,
    }),
    fill({
      optionSymbol: 'ABCL260918C00010000',
      side: 'sell_to_close',
      ts: ABCL_CLOSE - 800,
      contracts: 2,
      filledPrice: 0.22,
      fees: fees.exit,
    }),
  ];
}

function trowFills(): LiveOptionFillRecord[] {
  return [
    fill({
      optionSymbol: 'TROW260918C00115000',
      side: 'buy_to_open',
      ts: TROW_OPEN + 900,
      contracts: 1,
      filledPrice: 1.2,
      fees: 0.12,
    }),
    fill({
      optionSymbol: 'TROW260918C00115000',
      side: 'sell_to_close',
      ts: TROW_CLOSE - 500,
      contracts: 1,
      filledPrice: 0.41,
      fees: 0.12,
    }),
  ];
}

interface Harness {
  deps: CloseBasisSweepDeps;
  writes: { id: string; basis: OptionTradeCloseBasis }[];
}

function harness(
  opts: {
    rows?: OptionTradeJournalRecord[];
    ledger?: LiveOptionFillRecord[];
    enabled?: boolean;
    durability?: { ephemeral: boolean; appendErrors: number };
    ledgerN?: number;
    observeOnly?: boolean;
    accept?: (id: string) => boolean;
    listThrows?: boolean;
  } = {},
): Harness {
  const writes: Harness['writes'] = [];
  const ledger = opts.ledger ?? [];
  const deps: CloseBasisSweepDeps = {
    journalEnabled: () => opts.enabled ?? true,
    listLiveJournalRows: async () => {
      if (opts.listThrows) throw new Error('journal store unreadable');
      return opts.rows ?? [];
    },
    readLedger: () => ({
      n: opts.ledgerN ?? ledger.length,
      records: ledger,
      durability: opts.durability ?? { ephemeral: false, appendErrors: 0 },
    }),
    recordCloseBasis: async (id, basis) => {
      const ok = opts.accept ? opts.accept(id) : true;
      if (ok) writes.push({ id, basis });
      return ok;
    },
    now: () => NOW,
    observeOnly: () => opts.observeOnly ?? false,
  };
  return { deps, writes };
}

beforeEach(() => {
  resetCloseBasisSweepStateForTests();
});

describe('TRA-3730 close-basis sweep — writes broker truth without an admin token', () => {
  it('restates the live residual cohort, and each correction is EXACTLY that row\'s measured fee', async () => {
    const h = harness({ rows: [abclRow(), trowRow()], ledger: [...abclFills(), ...trowFills()] });
    const st = await runCloseBasisSweep(h.deps);

    expect(st.lastOutcome).toBe('restated');
    expect(st.lastApplied.restated).toBe(2);
    // AC2 of the ticket: the fold accepted every write it was offered.
    expect(st.lastApplied.refused).toBe(0);

    const byId = new Map(h.writes.map((w) => [w.id, w.basis]));
    // The ticket's `broker-fill net` column, to the cent.
    expect(byId.get('abcl-row')?.realizedPnlUsd).toBe(-16.86);
    expect(byId.get('trow-row')?.realizedPnlUsd).toBe(-79.24);
    expect(byId.get('abcl-row')?.feesUsd).toBe(0.86);
    expect(byId.get('trow-row')?.feesUsd).toBe(0.24);

    // The ticket's finding, as an assertion: the ENTRY basis on these rows was
    // already correct, so the whole delta is commission and nothing else. A
    // future row where these diverge is a row that is wrong for a THIRD reason,
    // and this is what would catch it.
    const evidence = new Map(st.lastRows.map((r) => [r.id, r]));
    expect(evidence.get('abcl-row')?.deltaUsd).toBe(-0.86);
    expect(evidence.get('trow-row')?.deltaUsd).toBe(-0.24);
    expect(st.lastApplied.netDeltaUsd).toBe(-1.1);
  });

  it('is idempotent: a second tick over restated rows writes nothing and reads clean', async () => {
    const restated = [
      abclRow({ pnlBasis: 'broker-fill', realizedPnlUsd: -16.86 }),
      trowRow({ pnlBasis: 'broker-fill', realizedPnlUsd: -79.24 }),
    ];
    const h = harness({ rows: restated, ledger: [...abclFills(), ...trowFills()] });
    const st = await runCloseBasisSweep(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(st.lastOutcome).toBe('clean');
    expect(st.counts?.restatable).toBe(0);
    expect(st.counts?.alreadyRestated).toBe(2);
    // Steady-state rows do not flood the evidence; their count carries them.
    expect(st.lastRows).toHaveLength(0);
  });

  it('lifetime totals accumulate across ticks while last-tick totals reset', async () => {
    const first = harness({ rows: [abclRow()], ledger: abclFills() });
    await runCloseBasisSweep(first.deps);
    const second = harness({
      rows: [abclRow({ pnlBasis: 'broker-fill', realizedPnlUsd: -16.86 }), trowRow()],
      ledger: [...abclFills(), ...trowFills()],
    });
    const st = await runCloseBasisSweep(second.deps);

    expect(st.ticks).toBe(2);
    expect(st.lastApplied.restated).toBe(1);
    expect(st.lastApplied.netDeltaUsd).toBe(-0.24);
    expect(st.lifetime.restated).toBe(2);
    expect(st.lifetime.netDeltaUsd).toBe(-1.1);
  });
});

describe('TRA-3730 close-basis sweep — the fee refusal an unattended writer needs (AC3)', () => {
  it('SKIPS a row whose fees are unmeasured rather than zero-filling it, and says so', async () => {
    const h = harness({
      rows: [abclRow()],
      ledger: abclFills({ entry: 0.43, exit: null }),
    });
    const st = await runCloseBasisSweep(h.deps);

    // Nothing written: the row keeps its gross `realizedPnlUsd` and gets no
    // `pnlBasis`. A gross figure labelled broker-settled is worse than the wrong
    // figure it would replace.
    expect(h.writes).toHaveLength(0);
    expect(st.counts?.restatable).toBe(0);
    expect(st.counts?.feesPending).toBe(1);
    expect(st.counts?.skipsByReason['fees_unmeasured']).toBe(1);

    // ...and the skip is NAMED, not silent. This is the difference between "come
    // back next tick" and "there was nothing to do".
    expect(st.lastOutcome).toBe('fees-pending');
    expect(st.lastRows).toHaveLength(1);
    expect(st.lastRows[0]?.skipReason).toBe('fees_unmeasured');
    expect(st.lastRows[0]?.applied).toBe(false);
    expect(st.feesPendingRows).toEqual({ count: 1, checked: true });
  });

  it('picks the same row up on a later tick once the reconcile has measured it', async () => {
    // Tick 1: the lot has not settled into /gainloss yet.
    const pending = harness({ rows: [abclRow()], ledger: abclFills({ entry: null, exit: null }) });
    const before = await runCloseBasisSweep(pending.deps);
    expect(before.lastOutcome).toBe('fees-pending');
    expect(pending.writes).toHaveLength(0);

    // Tick 2: same journal row, same code, fees now back-filled by the reconcile.
    // Nothing else changed — which is the whole claim of this ticket: the fee
    // measurement is what drives the restatement.
    const measured = harness({ rows: [abclRow()], ledger: abclFills() });
    const after = await runCloseBasisSweep(measured.deps);
    expect(after.lastOutcome).toBe('restated');
    expect(measured.writes).toHaveLength(1);
    expect(measured.writes[0]?.basis.realizedPnlUsd).toBe(-16.86);
  });

  it('does not collapse "waiting on the broker" into "clean" — the two quiet states are distinct', async () => {
    const waiting = harness({ rows: [abclRow()], ledger: abclFills({ entry: 0.43, exit: null }) });
    const quiet = harness({
      rows: [abclRow({ pnlBasis: 'broker-fill', realizedPnlUsd: -16.86 })],
      ledger: abclFills(),
    });

    const a = await runCloseBasisSweep(waiting.deps);
    expect(a.lastOutcome).toBe('fees-pending');
    resetCloseBasisSweepStateForTests();
    const b = await runCloseBasisSweep(quiet.deps);
    expect(b.lastOutcome).toBe('clean');
    // Both wrote nothing. Only the outcome tells them apart, and a reader who
    // cannot would call a permanent backlog a finished job.
    expect(waiting.writes).toHaveLength(0);
    expect(quiet.writes).toHaveLength(0);
  });

  it('pro-rates a shared fee rather than charging the whole record to one row', async () => {
    // The QQQ260911P00545000 shape from the ticket: a 0.86 fee on a fill record
    // that covers more contracts than this row, so the row's share is a fraction
    // of it. Charging the whole fee would move P&L in the wrong direction.
    const shared = [
      fill({
        optionSymbol: 'ABCL260918C00010000',
        side: 'buy_to_open',
        ts: ABCL_OPEN + 1_200,
        contracts: 4,
        filledPrice: 0.3,
        fees: 0.86,
      }),
      fill({
        optionSymbol: 'ABCL260918C00010000',
        side: 'sell_to_close',
        ts: ABCL_CLOSE - 800,
        contracts: 4,
        filledPrice: 0.22,
        fees: 0.86,
      }),
    ];
    const h = harness({ rows: [abclRow()], ledger: shared });
    await runCloseBasisSweep(h.deps);
    // 2 of 4 contracts on each leg → 0.43 + 0.43.
    expect(h.writes[0]?.basis.feesUsd).toBe(0.86);
    expect(h.writes[0]?.basis.realizedPnlUsd).toBe(-16.86);
  });
});

describe('TRA-3730 close-basis sweep — the other refusals', () => {
  it('publishes the measurement but writes nothing when the fill ledger is unusable', async () => {
    const h = harness({
      rows: [abclRow()],
      ledger: abclFills(),
      durability: { ephemeral: true, appendErrors: 0 },
    });
    const st = await runCloseBasisSweep(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(st.lastOutcome).toBe('ledger-unusable');
    expect(st.ledgerUsable).toBe(false);
    // The alarm survives the condition that makes repair impossible — otherwise
    // the one state where nothing can be fixed is also the one where nothing is
    // reported.
    expect(st.restatableRows.count).toBe(1);
    expect(st.lastRows[0]?.reason).toContain('refusing to write');
  });

  it('an EMPTY ledger is unusable, not clean', async () => {
    const h = harness({ rows: [abclRow()], ledger: [], ledgerN: 0 });
    const st = await runCloseBasisSweep(h.deps);
    expect(st.lastOutcome).toBe('ledger-unusable');
    expect(h.writes).toHaveLength(0);
  });

  it('observe-only keeps the measurement and writes nothing', async () => {
    const h = harness({ rows: [abclRow()], ledger: abclFills(), observeOnly: true });
    const st = await runCloseBasisSweep(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(st.lastOutcome).toBe('observe-only');
    expect(st.observeOnly).toBe(true);
    expect(st.restatableRows.count).toBe(1);
    expect(st.counts?.plannedNetDeltaUsd).toBe(-0.86);
  });

  it('reads the observe-only switch off the env, defaulting to ARMED', () => {
    expect(isCloseBasisSweepObserveOnly({} as NodeJS.ProcessEnv)).toBe(false);
    expect(isCloseBasisSweepObserveOnly({ CLOSE_BASIS_SWEEP_OBSERVE_ONLY: 'TRUE' } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(isCloseBasisSweepObserveOnly({ CLOSE_BASIS_SWEEP_OBSERVE_ONLY: 'no' } as unknown as NodeJS.ProcessEnv)).toBe(false);
  });

  it('records a fold refusal instead of dropping it (the OPEN guard is never routed around)', async () => {
    const h = harness({ rows: [abclRow()], ledger: abclFills(), accept: () => false });
    const st = await runCloseBasisSweep(h.deps);

    expect(h.writes).toHaveLength(0);
    expect(st.lastOutcome).toBe('refused');
    expect(st.lastApplied.refused).toBe(1);
    expect(st.lastApplied.restated).toBe(0);
    // A refusal must not move the book figure.
    expect(st.lastApplied.netDeltaUsd).toBe(0);
    expect(st.lastRows[0]?.reason).toContain('REFUSED by the fold');
  });

  it('never restates a DEMO row — there is no broker behind a demo fill', async () => {
    const h = harness({
      rows: [abclRow({ id: 'demo-row', mode: 'demo' })],
      ledger: abclFills(),
    });
    const st = await runCloseBasisSweep(h.deps);
    expect(h.writes).toHaveLength(0);
    expect(st.counts?.closedLiveRows).toBe(0);
    expect(st.lastOutcome).toBe('no-closed-rows');
  });

  it('never restates an OPEN row — a realized figure must not land on an unsettled position', async () => {
    const h = harness({
      rows: [abclRow({ outcome: 'OPEN', closeTs: undefined, realizedPnlUsd: undefined })],
      ledger: abclFills(),
    });
    const st = await runCloseBasisSweep(h.deps);
    expect(h.writes).toHaveLength(0);
    expect(st.counts?.closedLiveRows).toBe(0);
  });
});

describe('TRA-3730 close-basis sweep — the positive zero, and never starving its host tick', () => {
  it('never-checked and checked-clean are different readings', async () => {
    // Before any tick.
    expect(getCloseBasisSweepState().restatableRows).toEqual({ count: null, checked: false, asOf: null });

    const h = harness({
      rows: [abclRow({ pnlBasis: 'broker-fill', realizedPnlUsd: -16.86 })],
      ledger: abclFills(),
    });
    const st = await runCloseBasisSweep(h.deps);
    expect(st.restatableRows.count).toBe(0);
    expect(st.restatableRows.checked).toBe(true);
    expect(st.restatableRows.asOf).toBe(new Date(NOW).toISOString());
  });

  it('a disabled journal reports `disabled` and stays UNCHECKED, never a clean zero', async () => {
    const h = harness({ rows: [abclRow()], ledger: abclFills(), enabled: false });
    const st = await runCloseBasisSweep(h.deps);
    expect(st.lastOutcome).toBe('disabled');
    expect(st.checked).toBe(false);
    expect(st.restatableRows.count).toBeNull();
    expect(h.writes).toHaveLength(0);
  });

  it('swallows a failure into the state instead of throwing into the scheduler tick', async () => {
    const h = harness({ listThrows: true });
    await expect(runCloseBasisSweep(h.deps)).resolves.toBeDefined();
    const st = getCloseBasisSweepState();
    expect(st.lastOutcome).toBe('error');
    expect(st.lastError).toContain('journal store unreadable');
  });
});
