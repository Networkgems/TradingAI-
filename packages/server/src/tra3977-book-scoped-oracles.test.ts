// TRA-3977 — THE EXIT BOUND'S ORACLES WERE BOOK-BLIND.
//
// Measured live on bqb1 `3d0c3582`, 2026-08-24T14:4xZ.
// `/api/health/live-options-fee-slippage` -> `aggregateExposure[]` carried TWO
// `mode: 'live'` books, both `liveEntryGateOpen: true`, on DIFFERENT broker
// accounts:
//
//     book admin   capUsd 309.82   openRows 2   atRisk 150   cash 500.92
//     book v0nni   capUsd 190.17   openRows 1   atRisk 154   cash 245.56
//
// …and the SAME `records[]` array carried, at 14:25:07.953Z:
//
//     NVTS261002C00012500  buy_to_open  ct=1 @1.54  oid=143021643  origin=fill
//
// $154 — v0nni's entire book — sitting next to admin's BAC / RIG / XLF rows,
// with nothing on the row saying so.
//
// ── What each arm of this file is for ───────────────────────────────────────
//   AC1 — the discriminator is on the record, written at fill time, and a
//         hydrate does NOT back-fill it.
//   AC2 — both oracles key on (book, OCC): a sibling's OPENS are not this
//         book's engine share, and a sibling's CLOSES do not net against it.
//         Both directions, because the defect points both ways and a fix that
//         only stopped the permissive one would strand the conservative one.
//   AC3 — an unattributed row is a REFUSAL, never a default. On the write path
//         that is BLIND-and-COUNTED with its own reason, never permission.
//   AC4 — ⭐ THE NEGATIVE CONTROL. With a single live book every answer is
//         byte-for-byte what it was before this ticket. Without this arm the
//         change is a behaviour rewrite wearing a scoping name.
//   AC5 — the census measures the reachability instead of arguing it, and a
//         tape nobody can read never folds to `clean`.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  clearLiveOptionsFeeSlippageLedger,
  recordLiveOptionFill,
  recordReconcileTermination,
  registerLiveOptionBook,
  bookScopingReachable,
  knownLiveOptionBooks,
  crossBookOpenEpisodeCensus,
  openEpisodeWindow,
  engineNetOpenContracts,
  recordedEngineOpenBasis,
  summarizeLiveOptionsFeeSlippage,
  LEDGER_FLEET_WIDE,
} from './live-options-fee-slippage-ledger.js';
import { boundExitContractsToEngineShare } from './option-exec-flag.js';

const OCC = 'XLF260925C00057500';
const ADMIN = 'admin';
const V0NNI = 'v0nni';
const T0 = Date.parse('2026-08-20T13:35:30Z');

function open(
  book: string | null,
  contracts: number,
  filledPrice: number,
  ts: number,
  origin: 'fill' | 'history_import' = 'fill',
  optionSymbol: string = OCC,
): void {
  recordLiveOptionFill({
    ts,
    etDay: '2026-08-20',
    sleeve: 'single_leg_otm',
    book,
    optionSymbol,
    side: 'buy_to_open',
    contracts,
    submittedLimit: filledPrice,
    askAtSubmit: filledPrice,
    midAtSubmit: filledPrice,
    filledPrice,
    fees: null,
    orderId: origin === 'fill' ? 142603071 : null,
    origin,
  });
}

function close(book: string | null, contracts: number, ts: number, optionSymbol: string = OCC): void {
  recordLiveOptionFill({
    ts,
    etDay: '2026-08-21',
    sleeve: 'single_leg_otm',
    book,
    optionSymbol,
    side: 'sell_to_close',
    contracts,
    submittedLimit: 1.01,
    askAtSubmit: 1.01,
    midAtSubmit: 1.0,
    filledPrice: 1.01,
    fees: null,
    orderId: 142806015,
    origin: 'fill',
  });
}

/** The row shape the exit bound reads — a live imported `engine_origin` row. */
const IMPORTED_ENGINE_ROW = {
  importedFromTradier: true,
  adoptionAuthority: 'engine_origin',
  tradierEnv: 'production',
  engineHandover: null,
};

/** Wire the bound to one book's oracles, exactly as `stageableExitContracts` does. */
function bound(book: string | null, requested: number, remaining: number) {
  return boundExitContractsToEngineShare(
    IMPORTED_ENGINE_ROW,
    requested,
    remaining,
    () => recordedEngineOpenBasis(OCC, book),
    false,
    () => engineNetOpenContracts(OCC, book),
  );
}

beforeEach(() => {
  clearLiveOptionsFeeSlippageLedger();
});

// ══════════════════════════════════════════════════════════════════════════
describe('TRA-3977 AC1 — the discriminator is on the record, written at fill time', () => {
  it('stamps the book the chokepoint passed, and does NOT invent one when it is absent', () => {
    open(V0NNI, 1, 1.54, T0);
    open(null, 1, 0.85, T0 + 1_000, 'history_import');
    const records = summarizeLiveOptionsFeeSlippage().records;
    // Newest-first.
    expect(records[1]!.book).toBe(V0NNI);
    expect(records[0]!.book).toBeNull();
  });

  it('normalises a blank book to null rather than to an empty-string "book"', () => {
    open('', 1, 1.54, T0);
    expect(summarizeLiveOptionsFeeSlippage().records[0]!.book).toBeNull();
    // …and an empty string must not register as a book, or one blank row would
    // flip `scopingReachable` on a genuinely single-book process.
    expect(knownLiveOptionBooks()).toEqual([]);
  });

  it('a fill REGISTERS its own book — the array is the witness, not the wire-up', () => {
    expect(bookScopingReachable()).toBe(false);
    open(ADMIN, 1, 1.08, T0);
    expect(bookScopingReachable()).toBe(false); // one book is not a question
    open(V0NNI, 1, 1.54, T0 + 1_000, 'fill', 'NVTS261002C00012500');
    expect(bookScopingReachable()).toBe(true);
    expect(knownLiveOptionBooks()).toEqual([ADMIN, V0NNI]);
  });

  it('the explicit wire-up makes it reachable BEFORE any fill lands', () => {
    registerLiveOptionBook(ADMIN);
    registerLiveOptionBook(V0NNI);
    expect(bookScopingReachable()).toBe(true);
    // …which is the point: a process that hydrates an unattributed legacy tape
    // must refuse from the FIRST tick, not from the first fill of each book.
    expect(summarizeLiveOptionsFeeSlippage().records).toHaveLength(0);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('TRA-3977 AC2 — both oracles key on (book, OCC)', () => {
  beforeEach(() => {
    registerLiveOptionBook(ADMIN);
    registerLiveOptionBook(V0NNI);
  });

  it('PERMISSIVE DIRECTION — a sibling book\'s engine open is NOT this book\'s engine share', () => {
    // The ticket's scenario 1, exactly: admin holds one DESK contract that
    // arrived as a history_import; v0nni holds one engine buy on the same OCC.
    open(ADMIN, 1, 0.85, T0, 'history_import');
    open(V0NNI, 1, 1.08, T0 + 1_000, 'fill');

    // Pre-fix (fleet-wide) this answered engineNet 1 and the bound PERMITTED
    // admin to sell the desk's contract. Kept as the positive control on the
    // fixture: without it, "the fix works" could just mean the tape is empty.
    const fleet = engineNetOpenContracts(OCC, LEDGER_FLEET_WIDE);
    expect(fleet.status).toBe('open');
    expect(fleet.engineOpenContracts).toBe(1);
    expect(fleet.engineNetContracts).toBe(1);

    // Scoped to admin: its only row is an import, so the ledger can say the
    // contract exists and CANNOT say it is ours.
    const mine = engineNetOpenContracts(OCC, ADMIN);
    expect(mine.status).toBe('open');
    expect(mine.netContracts).toBe(1);
    expect(mine.engineOpenContracts).toBe(0);
    expect(mine.importedOpenContracts).toBe(1);
    expect(mine.engineNetContracts).toBe(0);

    // …and the bound therefore does NOT return the "checked and clean"
    // `engine_net_of_closes` it used to. An import-only episode is BLIND.
    const b = bound(ADMIN, 1, 1);
    expect(b.reason).not.toBe('engine_net_of_closes');
    expect(b.blind).toBe(true);
  });

  it('CONSERVATIVE DIRECTION — a sibling book\'s close does NOT net against this book', () => {
    // The ticket's scenario 2: both books hold one engine contract on the OCC;
    // v0nni closes ITS own. Fleet-wide, that close consumed admin's share.
    open(ADMIN, 1, 1.08, T0, 'fill');
    open(V0NNI, 1, 1.08, T0 + 1_000, 'fill');
    close(V0NNI, 1, T0 + 2_000);

    const fleet = engineNetOpenContracts(OCC, LEDGER_FLEET_WIDE);
    expect(fleet.closedContracts).toBe(1);
    expect(fleet.engineNetContracts).toBe(1); // min(net 1, engine 2 − closed 1)

    const mine = engineNetOpenContracts(OCC, ADMIN);
    expect(mine.netContracts).toBe(1);
    expect(mine.engineOpenContracts).toBe(1);
    expect(mine.closedContracts).toBe(0); // ⭐ the sibling's close is not ours
    expect(mine.engineNetContracts).toBe(1);
    expect(bound(ADMIN, 1, 1).exitContracts).toBe(1); // admin still exits its own
  });

  it('the READER\'s oracle is scoped identically — a sibling\'s basis is not this row\'s', () => {
    open(ADMIN, 1, 0.85, T0, 'history_import');
    open(V0NNI, 1, 1.08, T0 + 1_000, 'fill');
    // Fleet-wide the basis absorbs v0nni's engine fill and reports 1 contract
    // the engine placed — TRA-3913's defect, arriving through a second door.
    expect(recordedEngineOpenBasis(OCC, LEDGER_FLEET_WIDE)!.enginePlacedContracts).toBe(1);
    const mine = recordedEngineOpenBasis(OCC, ADMIN)!;
    expect(mine.enginePlacedContracts).toBe(0);
    expect(mine.importedContracts).toBe(1);
  });

  it('a sibling book\'s reconcile TERMINAL MARKER does not truncate this book\'s episode', () => {
    // A marker binds the exit to ZERO (TRA-3976). Cross-book that would be a
    // refusal manufactured out of somebody else's position leaving somebody
    // else's account.
    open(ADMIN, 1, 1.08, T0, 'fill');
    open(V0NNI, 1, 1.08, T0 + 1_000, 'fill');
    expect(
      recordReconcileTermination({
        ts: T0 + 2_000,
        etDay: '2026-08-21',
        book: V0NNI,
        optionSymbol: OCC,
        contractsDropped: 1,
        positionId: 'v0nni-row',
        source: 'broker_flat_reconcile',
      }),
    ).toBe(true);

    expect(openEpisodeWindow(OCC, V0NNI).reason).toBe('reconcile_terminal');
    const mine = openEpisodeWindow(OCC, ADMIN);
    expect(mine.status).toBe('open');
    expect(mine.terminations).toBe(0);
    expect(bound(ADMIN, 1, 1).exitContracts).toBe(1);
  });

  it('two books dropping the same OCC in the same millisecond are two markers, not one', () => {
    const at = T0 + 2_000;
    const one = { ts: at, etDay: '2026-08-21', optionSymbol: OCC, contractsDropped: 1, source: 'broker_flat_reconcile' as const };
    expect(recordReconcileTermination({ ...one, book: ADMIN })).toBe(true);
    expect(recordReconcileTermination({ ...one, book: V0NNI })).toBe(true);
    // …and the same book twice is still ONE.
    expect(recordReconcileTermination({ ...one, book: ADMIN })).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('TRA-3977 AC3 — an unattributed row is a REFUSAL, never a default', () => {
  beforeEach(() => {
    registerLiveOptionBook(ADMIN);
    registerLiveOptionBook(V0NNI);
  });

  it('refuses rather than back-filling the rows to the book that is asking', () => {
    // The retained live tape, exactly: rows that predate the discriminator.
    open(null, 1, 1.08, T0, 'fill');
    const w = openEpisodeWindow(OCC, ADMIN);
    expect(w.status).toBe('indeterminate');
    expect(w.reason).toBe('book_unattributed');
    // ⛔ The permissive default would have answered `open` / engineNet 1 here.
    expect(engineNetOpenContracts(OCC, ADMIN).engineNetContracts).toBe(0);
    expect(engineNetOpenContracts(OCC, ADMIN).status).toBe('indeterminate');
    expect(recordedEngineOpenBasis(OCC, ADMIN)).toBeNull();
  });

  it('ONE unattributed row poisons the symbol even beside a fully attributed one', () => {
    open(ADMIN, 1, 1.08, T0, 'fill');
    open(null, 1, 0.85, T0 + 1_000, 'history_import');
    expect(openEpisodeWindow(OCC, ADMIN).reason).toBe('book_unattributed');
  });

  it('on the WRITE path the refusal is BLIND and COUNTED, with its OWN reason', () => {
    open(null, 1, 1.08, T0, 'fill');
    const b = bound(ADMIN, 1, 1);
    // BLIND — the pre-TRA-3926 quantity. Binding to 0 here would strand every
    // legacy row on the tape the day this ships (TRA-2820, at fleet scale).
    expect(b.exitContracts).toBe(1);
    expect(b.blind).toBe(true);
    expect(b.oracleRefused).toBe(true);
    expect(b.bounded).toBe(false);
    // …and NAMED, because its remedy differs from every other blind branch:
    // nothing is wrong with the ledger, the rows are simply older than the
    // column, and it self-heals as the retention window turns over.
    expect(b.reason).toBe('book_unattributed');
  });

  it('a caller that cannot NAME its book is refused too — from the other side', () => {
    open(ADMIN, 1, 1.08, T0, 'fill');
    // Every row names a book and the asker names none, so no row is provably
    // the asker's. Refuse; do not hand it the only book on the tape.
    expect(openEpisodeWindow(OCC, null).reason).toBe('book_unattributed');
    expect(recordedEngineOpenBasis(OCC, null)).toBeNull();
  });

  it('an OCC with no rows at all is still `no_record`, NOT the book refusal', () => {
    // The two silences must not merge: `no_record` is TRA-2820's shape and it
    // keeps its own branch (and its own remedy) on the write path.
    open(ADMIN, 1, 1.08, T0, 'fill');
    expect(openEpisodeWindow('SPY260904C00816000', ADMIN).status).toBe('no_record');
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('TRA-3977 AC4 — ⭐ NEGATIVE CONTROL: one book, and nothing changes', () => {
  it('with at most one book known, an unattributed tape answers exactly as before', () => {
    // This is the shape EVERY pre-TRA-3977 fixture in this repo has: rows with
    // no book, asked with no book. If the scoping changed these answers, the
    // ticket would be a behaviour rewrite wearing a scoping name.
    open(null, 1, 1.08, T0, 'fill');
    open(null, 1, 0.85, T0 + 1_000, 'history_import');
    expect(bookScopingReachable()).toBe(false);

    const w = openEpisodeWindow(OCC, null);
    expect(w.status).toBe('open');
    expect(w.netContracts).toBe(2);

    const net = engineNetOpenContracts(OCC, null);
    expect(net.engineOpenContracts).toBe(1);
    expect(net.importedOpenContracts).toBe(1);
    expect(net.engineNetContracts).toBe(1);

    // …and byte-for-byte what an explicitly fleet-wide read gives.
    expect(engineNetOpenContracts(OCC, LEDGER_FLEET_WIDE)).toEqual(net);
    expect(recordedEngineOpenBasis(OCC, null)).toEqual(
      recordedEngineOpenBasis(OCC, LEDGER_FLEET_WIDE),
    );
  });

  it('ONE registered book is still not a question — the gate is >1, not >0', () => {
    registerLiveOptionBook(ADMIN);
    open(null, 1, 1.08, T0, 'fill');
    expect(bookScopingReachable()).toBe(false);
    expect(openEpisodeWindow(OCC, ADMIN).status).toBe('open');
    expect(engineNetOpenContracts(OCC, ADMIN).engineNetContracts).toBe(1);
  });

  it('and the SECOND book is what flips it — same tape, opposite answer', () => {
    registerLiveOptionBook(ADMIN);
    open(null, 1, 1.08, T0, 'fill');
    expect(openEpisodeWindow(OCC, ADMIN).status).toBe('open');
    registerLiveOptionBook(V0NNI);
    expect(openEpisodeWindow(OCC, ADMIN).reason).toBe('book_unattributed');
  });

  it('the registry is cleared by the test seam — a stale book cannot fail the NEXT fixture', () => {
    registerLiveOptionBook(ADMIN);
    registerLiveOptionBook(V0NNI);
    expect(bookScopingReachable()).toBe(true);
    clearLiveOptionsFeeSlippageLedger();
    expect(bookScopingReachable()).toBe(false);
    expect(knownLiveOptionBooks()).toEqual([]);
  });
});

// ══════════════════════════════════════════════════════════════════════════
describe('TRA-3977 AC5 — the census MEASURES the reachability', () => {
  it('an unattributed tape reads `unattributed`, never `clean`', () => {
    registerLiveOptionBook(ADMIN);
    registerLiveOptionBook(V0NNI);
    open(null, 1, 1.08, T0, 'fill');
    const c = crossBookOpenEpisodeCensus();
    expect(c.verdict).toBe('unattributed');
    expect(c.scopingReachable).toBe(true);
    expect(c.unattributedRows).toBe(1);
    expect(c.unattributedSymbols).toBe(1);
    // ⛔ and the symbol it cannot read is NOT scored as a non-overlap.
    expect(c.overlappingSymbols).toBe(0);
    expect(c.rows).toEqual([]);
  });

  it('names the OCCs actually held open by two books — the reachability, MEASURED', () => {
    open(ADMIN, 1, 1.08, T0, 'fill');
    open(V0NNI, 2, 1.54, T0 + 1_000, 'fill');
    open(ADMIN, 1, 1.54, T0 + 2_000, 'fill', 'NVTS261002C00012500');
    const c = crossBookOpenEpisodeCensus();
    expect(c.verdict).toBe('overlap');
    expect(c.symbols).toBe(2);
    expect(c.overlappingSymbols).toBe(1);
    expect(c.rows).toEqual([
      { optionSymbol: OCC, books: [ADMIN, V0NNI], netContracts: [1, 2] },
    ]);
  });

  it('two books with no shared OCC read `clean` — today\'s live shape', () => {
    // admin holds BAC, v0nni holds NVTS: no overlap, and it is MEASURED, so a
    // reader can tell it from a tape nobody could partition.
    open(ADMIN, 1, 1.65, T0, 'fill', 'BAC260925C00063000');
    open(V0NNI, 1, 1.54, T0 + 1_000, 'fill', 'NVTS261002C00012500');
    const c = crossBookOpenEpisodeCensus();
    expect(c.verdict).toBe('clean');
    expect(c.scopingReachable).toBe(true);
    expect(c.books).toEqual([ADMIN, V0NNI]);
    expect(c.overlappingSymbols).toBe(0);
    expect(c.unattributedRows).toBe(0);
  });

  it('a single-book process reads `clean` with `scopingReachable: false` — a no-op, and it says so', () => {
    open(ADMIN, 1, 1.08, T0, 'fill');
    const c = crossBookOpenEpisodeCensus();
    expect(c.scopingReachable).toBe(false);
    expect(c.verdict).toBe('clean');
    expect(c.books).toEqual([ADMIN]);
  });

  it('is published on the summary the health route serves', () => {
    open(ADMIN, 1, 1.08, T0, 'fill');
    const s = summarizeLiveOptionsFeeSlippage();
    expect(Object.prototype.hasOwnProperty.call(s, 'crossBook')).toBe(true);
    expect(s.crossBook.verdict).toBe('clean');
  });
});
