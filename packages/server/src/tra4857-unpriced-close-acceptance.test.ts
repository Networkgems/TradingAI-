// TRA-4857 AC1 + AC2, and the TRA-4860 pin that keeps the predicate from being
// "simplified" back into a tape-wide false positive.
//
// ── What this file exists to fail ────────────────────────────────────────────
//
// TRA-4857 shipped `queueJournalClose`'s unpriced-close predicate
//
//     const unpricedClose = exitReason === 'broker_reconcile' && brokerOrderId === null;
//
// and closed with all four of its ACs ungraded (TRA-4860). AC1 and AC2 were
// filed as "needs a live unpriced reconcile close", which cannot be forced: it
// requires the broker to go flat on a position we hold. But AC1's own words are
// "**Both arms tested**", and both arms are reachable at the write site through
// public `PaperOptionsAccount` API. So they are graded here, not waited on.
//
// The load-bearing property is a DISCRIMINATION, and it runs in both directions:
//
//   • ARM A — a reconcile close with NO fill to price against writes honest
//     nulls (`realizedPnlUsd: null`, `realizedR: null`, `outcome: 'UNMEASURED'`)
//     instead of the fabricated `0`/`SCRATCH` that TRA-3978 measured as ~$36.50
//     of real loss recorded as flat.
//   • ARM B — a reconcile close that DID find a broker fill (the `a2f9c8cd`
//     shape: NOK261002C00010500, brokerOrderId 144350660, −$22.50 LOSS) still
//     writes a real signed P&L and a WIN/LOSS/SCRATCH outcome. Same
//     `exitReason`; the ONLY difference between the two arms here is the
//     presence of a broker order id, which is what makes this a test of the
//     predicate rather than of the exit label.
//   • ARM C (TRA-4860's own regression) — a close under ANY OTHER exit reason
//     with `brokerOrderId === null` still writes real money. This is the arm
//     that `brokerOrderId === null` ALONE destroys: `brokerOrderId` is passed by
//     exactly two of `queueJournalClose`'s thirteen call sites, so keying on it
//     alone stamps `UNMEASURED` over essentially the whole tape, forward-only,
//     while the historical table keeps reading normal. That widened predicate
//     was shipped as `7b2f9b50`, served bqb1 for 12 minutes overnight
//     (00:25:10Z → 00:37:17Z, market closed, zero closes written under it) and
//     was reverted in `a73706dc`. Nothing pinned it. ARM C is that pin.
//
// AC2 is graded against `buildTapeExpectancyTable` by equality with an
// unpriced-free CONTROL table: the priced statistics must be BIT-identical with
// the UNMEASURED rows present, and the cell's `n` must be lower than the row
// count by exactly the number of unpriced rows, which is AC2's sentence
// verbatim. Bit-identity is the discrimination — a null `realizedR` coerced to 0
// (the TRA-4857 AC3 failure mode, one consumer over) would move `meanR_gate` and
// `lowerCI95` while leaving `n` alone.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { tmpdir } from 'os';
import { join } from 'path';
import { rm } from 'fs/promises';
import { PaperOptionsAccount } from './options-account.js';
import {
  listOptionTradeJournal,
  setOptionTradeJournalFileForTests,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';
import {
  buildTapeExpectancyTable,
  tapeExpectancyCellKey,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';
import type { TradierOpenOptionPosition } from '@trading-app/engine';

const TRADING_TIME = Date.parse('2026-09-24T14:00:00Z');
const OCC = 'SPY260515C00450000';
/** The `a2f9c8cd` order id, kept literal so the shape is recognisable. */
const A2F9_ORDER_ID = 144_350_660;
/** 4 contracts at 1.60 → $640 at risk; the max loss on a long option IS its premium. */
const PREMIUM_PAID = 1.6;
const CONTRACTS = 4;
const AT_RISK_USD = PREMIUM_PAID * CONTRACTS * 100;
/** Sell at 1.20 against a 1.60 basis: −$160 on 4 contracts, R = −0.25. */
const EXIT_FILL = 1.2;
const REAL_PNL_USD = (EXIT_FILL - PREMIUM_PAID) * CONTRACTS * 100;

function buildImport(
  overrides: Partial<TradierOpenOptionPosition> = {},
): TradierOpenOptionPosition {
  return {
    optionSymbol: OCC,
    underlying: 'SPY',
    optionType: 'call',
    strike: 450,
    expiration: '2026-05-15',
    contracts: CONTRACTS,
    premiumPaid: PREMIUM_PAID,
    acquiredAt: TRADING_TIME,
    ...overrides,
  };
}

let tmpFile: string;
let fileCounter = 0;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  process.env['ENABLE_OPTION_TRADE_JOURNAL'] = '1';
  tmpFile = join(tmpdir(), `tra4857-journal-${process.pid}-${fileCounter++}.jsonl`);
  setOptionTradeJournalFileForTests(tmpFile);
});

afterEach(async () => {
  vi.useRealTimers();
  delete process.env['ENABLE_OPTION_TRADE_JOURNAL'];
  setOptionTradeJournalFileForTests(null);
  await rm(tmpFile, { force: true });
});

/** An imported live contract, journalled at OPEN by the reconcile (TRA-2937). */
function seedImportedOpen(): { acct: PaperOptionsAccount; id: string } {
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'sandbox' });
  acct.reconcileTradierPositions([buildImport()], 'live');
  const id = acct.getStateForMode('live').openOptions[0]!.id;
  return { acct, id };
}

async function closeRow(acct: PaperOptionsAccount): Promise<OptionTradeJournalRecord> {
  await acct.flushOptionTradeJournal();
  const rows = await listOptionTradeJournal();
  expect(rows).toHaveLength(1);
  const row = rows[0]!;
  expect(row.outcome).not.toBe('OPEN');
  return row;
}

describe('TRA-4857 AC1 — the unpriced predicate, both arms, at the write site', () => {
  it('ARM A: a reconcile close with NO broker fill writes honest nulls, not 0/SCRATCH', async () => {
    const { acct } = seedImportedOpen();

    // The broker stops reporting the OCC. Past the working-open-order grace
    // window, the sweep books the close locally at its best-known mark — there
    // is no fill and no order id, and `closeBrokerFlatPosition`'s sibling path
    // synthesises a break-even price, so the fabricated P&L arrives downstream
    // as a finite, plausible number. `exitReason` is the only surviving marker.
    vi.setSystemTime(TRADING_TIME + 60 * 60 * 1000);
    acct.reconcileTradierPositions([], 'live');

    const row = await closeRow(acct);
    expect(row.exitReason).toBe('broker_reconcile');
    expect(row.outcome).toBe('UNMEASURED');
    expect(row.realizedPnlUsd).toBeNull();
    expect(row.realizedR).toBeNull();
    // NEGATIVE CONTROL — the literal the pre-TRA-4857 build wrote here, and the
    // one TRA-3978 measured on `34f1ee99`. A fabricated zero is not "flat".
    expect(row.realizedPnlUsd as number | null).not.toBe(0);
    expect(row.outcome).not.toBe('SCRATCH');
  });

  it('ARM B: the SAME exit reason WITH a broker fill still writes real signed money', async () => {
    const { acct, id } = seedImportedOpen();

    // The `a2f9c8cd` shape: a reconcile close that DID find its fill. The order
    // id is captured off `pendingCloseOrderId` inside `recordImportedFill`.
    expect(acct.setPendingCloseOrderId(id, A2F9_ORDER_ID)).toBe(true);
    expect(acct.recordImportedFill(id, EXIT_FILL, 'broker_reconcile')).not.toBeNull();

    const row = await closeRow(acct);
    // Same label as ARM A — so this cannot be passing because of the exit reason.
    expect(row.exitReason).toBe('broker_reconcile');
    expect(row.realizedPnlUsd).toBeCloseTo(REAL_PNL_USD, 5);
    expect(row.realizedR).toBeCloseTo(REAL_PNL_USD / AT_RISK_USD, 5);
    expect(row.outcome).toBe('LOSS');
    expect(row.outcome).not.toBe('UNMEASURED');
  });

  it('ARM C (TRA-4860 pin): a NON-reconcile close with no order id keeps its real P&L', async () => {
    // Eleven of `queueJournalClose`'s thirteen call sites pass no order id while
    // carrying a perfectly real `position.pnl`. If this row ever reads
    // UNMEASURED, the predicate has been widened to `brokerOrderId === null`
    // again and the whole forward tape is being deleted silently.
    const { acct, id } = seedImportedOpen();
    expect(acct.recordImportedFill(id, EXIT_FILL)).not.toBeNull();

    const row = await closeRow(acct);
    expect(row.exitReason).toBe('manual');
    expect(row.outcome).toBe('LOSS');
    expect(row.realizedPnlUsd).toBeCloseTo(REAL_PNL_USD, 5);
    expect(row.realizedR).toBeCloseTo(REAL_PNL_USD / AT_RISK_USD, 5);
    expect(row.outcome).not.toBe('UNMEASURED');
    expect(row.realizedPnlUsd).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// AC2 — the unpriced row is absent from the fold AND visible in a named
// per-cell counter, and the cell's `n` is lower by exactly that count.
// ═══════════════════════════════════════════════════════════════════════════
const OTM = 'single_leg_otm';
const T0 = 1_700_000_000_000;
const BUCKET = '0.50-0.55';
/** Priced rows, deliberately asymmetric so a diluting zero would move the mean. */
const PRICED_R = [0.4, -0.2, 0.9, -0.5, 0.3, 0.75, -0.1, 0.2, 1.1, -0.35];

function tapeRow(opts: {
  realizedR: number | null;
  outcome?: string;
  delta?: number;
}): OptionTradeJournalRecord {
  return {
    structure: OTM,
    outcome: opts.outcome ?? 'WIN',
    entryDelta: opts.delta ?? 0.52,
    realizedR: opts.realizedR,
    closeTs: T0,
    mode: 'demo',
  } as unknown as OptionTradeJournalRecord;
}

function cellOf(cells: readonly TapeExpectancyCell[], bucket = BUCKET): TapeExpectancyCell {
  const found = cells.find((c) => c.cellKey === tapeExpectancyCellKey(OTM, bucket));
  if (!found) throw new Error(`no cell ${bucket} in [${cells.map((c) => c.cellKey).join(', ')}]`);
  return found;
}

describe('TRA-4857 AC2 — UNMEASURED rows leave the fold and land in a named counter', () => {
  /** The unpriced row as the journal actually writes it: null R, UNMEASURED. */
  const unpriced = () => tapeRow({ realizedR: null, outcome: 'UNMEASURED' });

  it("drops the unpriced rows from the cell and decrements `n` by exactly their count", () => {
    const priced = PRICED_R.map((r) => tapeRow({ realizedR: r }));
    const control = buildTapeExpectancyTable(priced, { windowDays: null, nowMs: T0 });
    const withUnpriced = buildTapeExpectancyTable([...priced, unpriced(), unpriced()], {
      windowDays: null,
      nowMs: T0,
    });

    const c = cellOf(control.cells);
    const u = cellOf(withUnpriced.cells);

    // AC2's sentence: `n` is lower than the row count by exactly the unpriced count.
    expect(u.n).toBe(c.n);
    expect(u.n).toBe(PRICED_R.length);
    expect(u.n + u.droppedUnpricedCloses).toBe(PRICED_R.length + 2);

    // Named per-cell counter, and its route-level companion.
    expect(u.droppedUnpricedCloses).toBe(2);
    expect(withUnpriced.rowsDroppedUnpriced).toBe(2);
    expect(withUnpriced.rowsUsed).toBe(control.rowsUsed);
    // NOT conflated with "still OPEN" — that is a different reader's question.
    expect(withUnpriced.rowsDroppedUnresolved).toBe(control.rowsDroppedUnresolved);

    // BIT-identical statistics. A null R coerced to 0 would move all three while
    // leaving `n` alone, which is the failure this equality is here to catch.
    expect(u.meanR_gate).toBe(c.meanR_gate);
    expect(u.sdR_gate).toBe(c.sdR_gate);
    expect(u.lowerCI95).toBe(c.lowerCI95);
  });

  it('a cell whose ONLY rows are unpriced still publishes itself, at n = 0', () => {
    // Otherwise "closed but unpriceable" disappears from the table entirely and
    // the cell reads as a quiet day rather than as an unmeasured one.
    const t = buildTapeExpectancyTable([unpriced(), unpriced(), unpriced()], {
      windowDays: null,
      nowMs: T0,
    });
    const c = cellOf(t.cells);
    expect(c.n).toBe(0);
    expect(c.droppedUnpricedCloses).toBe(3);
    expect(t.rowsDroppedUnpriced).toBe(3);
    expect(t.rowsUsed).toBe(0);
    expect(c.admits).toBe(false);
  });

  it('the counter is per CELL, not smeared across the table', () => {
    const rows = [
      ...PRICED_R.map((r) => tapeRow({ realizedR: r })),
      unpriced(),
      tapeRow({ realizedR: null, outcome: 'UNMEASURED', delta: 0.47 }),
    ];
    const t = buildTapeExpectancyTable(rows, { windowDays: null, nowMs: T0 });
    expect(cellOf(t.cells, BUCKET).droppedUnpricedCloses).toBe(1);
    expect(cellOf(t.cells, '0.45-0.50').droppedUnpricedCloses).toBe(1);
    expect(t.rowsDroppedUnpriced).toBe(2);
  });
});
