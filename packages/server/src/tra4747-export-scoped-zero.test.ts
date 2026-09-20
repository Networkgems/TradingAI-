// TRA-4747 — a SCOPED ZERO must be distinguishable from a STALE ROUTE.
//
// The measured incident (live bqb1, 2026-09-20T05:36Z, pin `50671745b312`
// pid 77): `GET /api/trades/export?markets=options&from=2026-09-08&to=
// 2026-09-20` served `count: 0` / `sources {book:0, journal:0}` with the window
// INSIDE its own published floor, while `/api/health/option-journal` reported 15
// closed option trades in that exact window. It was filed as the export being 18
// days stale.
//
// It was not. Folding the firm-wide journal by `account` at the same beat:
// those 15 closes are **`enock`'s**, all `mode: demo`; the caller was `admin`,
// whose journal slice holds exactly **106** closes ending **2026-09-02** — the
// same 106 the unfiltered export served, to the row. `journalRowsForBook`
// (TRA-2421) had scoped `enock` out exactly as designed, and the zero was the
// correct answer for `admin`'s book.
//
// So this is TRA-4358's defect filed a second time by a second reader: the
// scope RULE was on the wire and the scope FACT was not. `summary.scope.note`
// reads identically on a 106-row export and an empty one, so it cannot be used
// to settle the question the reader actually has. The two census fields pinned
// here are that fact, and they are the reason the next reader does not need a
// second request — or a ticket — to tell "this book was quiet" from "this route
// is blind".
//
// Q3 of the filing asked whether the served `0` should become TRA-3860's `400`.
// It must not, and `serves a zero inside the floor` below is the regression
// guard for that: the 400 answers "you asked BELOW my floor", i.e. a window the
// route cannot see. This window is one the route CAN see and in which the book
// genuinely closed nothing. Refusing it would make "did this book trade?"
// unanswerable and would turn every quiet day into an error.
import { describe, it, expect } from 'vitest';
import {
  checkExportRangeServable,
  exportScopeFor,
  resolveExportCoverage,
  scopeHeaderValue,
} from './export-history.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const DAY = 86_400_000;
const SEP_02 = Date.parse('2026-09-02T17:36:03.829Z');
const JUL_30 = Date.parse('2026-07-30T13:42:19.751Z');

function close(
  id: string,
  over: Partial<OptionTradeJournalRecord> = {},
): OptionTradeJournalRecord {
  return {
    id,
    account: 'admin',
    mode: 'demo',
    optionSymbol: `SPY260902C0077${id}000`,
    outcome: 'WIN',
    openTs: JUL_30,
    closeTs: SEP_02,
    realizedPnlUsd: 10,
    ...over,
  } as unknown as OptionTradeJournalRecord;
}

describe('TRA-4747 — the scoped zero is legible from one response', () => {
  it('publishes this book\'s own close census and its newest close', () => {
    // `admin`'s slice as measured: closes ending 2026-09-02, nothing after.
    const rows = [
      close('1', { closeTs: SEP_02 - 10 * DAY }),
      close('2', { closeTs: SEP_02 - 3 * DAY }),
      close('3', { closeTs: SEP_02 }),
    ];
    const scope = exportScopeFor('admin', rows);
    expect(scope.book).toBe('admin');
    expect(scope.bookOptionJournalCloses).toBe(3);
    expect(scope.bookLatestOptionJournalCloseIso).toBe('2026-09-02T17:36:03.829Z');
  });

  it('counts by CLOSE, not by row — a duplicate record of one close is one close', () => {
    // TRA-3930: two records, same mode|OCC|closeTs, is a copy. The served count
    // collapses them, so a census that did not would publish a number the
    // document can never match and re-open the same reconciliation.
    const dup = [close('a'), close('b', { optionSymbol: 'SPY260902C00771000' })];
    dup[1] = { ...dup[1]!, optionSymbol: dup[0]!.optionSymbol } as OptionTradeJournalRecord;
    expect(exportScopeFor('admin', dup).bookOptionJournalCloses).toBe(1);
  });

  it('ignores OPEN rows and rows with no usable closeTs', () => {
    const rows = [
      close('1'),
      close('2', { outcome: 'OPEN', closeTs: undefined }),
      close('3', { closeTs: Number.NaN }),
      close('4', { closeTs: undefined }),
    ];
    const scope = exportScopeFor('admin', rows);
    expect(scope.bookOptionJournalCloses).toBe(1);
    expect(scope.bookLatestOptionJournalCloseIso).toBe('2026-09-02T17:36:03.829Z');
  });

  it('an empty slice reads as an honest zero, never as a missing field', () => {
    const scope = exportScopeFor('admin', []);
    expect(scope.bookOptionJournalCloses).toBe(0);
    expect(scope.bookLatestOptionJournalCloseIso).toBeNull();
    // Same shape when the journal failed to load: the route passes the empty
    // array its `catch` leaves behind, so a degraded read is not a crash and is
    // not a silent absence either.
    expect(exportScopeFor('admin').bookOptionJournalCloses).toBe(0);
  });

  it('the census is BOOK-scoped — the caller passes a scoped population', () => {
    // The fold deliberately does NOT re-implement `journalRowsForBook`; the
    // guarantee tested is that whatever it is handed is what it reports, so a
    // firm-wide input can never be laundered into a per-book statement by this
    // function. `enock`'s 15 are absent because the ROUTE scoped them out.
    const adminRows = [close('1')];
    expect(exportScopeFor('admin', adminRows).bookOptionJournalCloses).toBe(1);
  });

  it('rides the CSV header too, still printable ASCII', () => {
    const header = scopeHeaderValue(exportScopeFor('bücher', [close('1')]));
    expect(header).toMatch(/^[\x20-\x7E]*$/);
    const parsed = JSON.parse(header) as Record<string, unknown>;
    expect(parsed['book']).toBe('bücher');
    expect(parsed['bookOptionJournalCloses']).toBe(1);
    expect(parsed['bookLatestOptionJournalCloseIso']).toBe('2026-09-02T17:36:03.829Z');
    expect(parsed['note']).toBeUndefined();
  });

  it('the note tells a reader to check the census before filing staleness', () => {
    const { note } = exportScopeFor('admin', [close('1')]);
    // TRA-4358's rule survives verbatim...
    expect(note).toContain('ONE book');
    expect(note).toContain('FIRM-WIDE');
    expect(note).toContain('journalRowsForBook');
    // ...and now names the fields that settle it.
    expect(note).toContain('bookLatestOptionJournalCloseIso');
    expect(note).toContain('TRA-4747');
    // Still generic: the rule, never another book's name.
    expect(note).not.toContain('enock');
  });

  // ── Q3 — the served zero stays a 200 ────────────────────────────────────────
  it('serves a zero inside the floor rather than refusing it', () => {
    // BOTH modes carry a row: `modes: []` requests every mode, and the floor is
    // the MAX of the per-mode floors, so a mode with no journal history would
    // hold the published floor up at the archive boundary and the window under
    // test would be refused for an unrelated reason. That is the documented
    // behaviour, not the property this test is about.
    const rows = [
      close('1', { openTs: JUL_30, closeTs: SEP_02 }),
      close('2', { mode: 'live', openTs: JUL_30, closeTs: SEP_02 }),
    ];
    const coverage = resolveExportCoverage({
      archiveBoundaryMs: Date.parse('2026-09-19T01:00:00.000Z'),
      processStartMs: Date.parse('2026-09-19T20:32:11.945Z'),
      journalRows: rows,
      filters: { modes: [], markets: ['options'] },
    });
    // The window the filing asked about is ABOVE the options floor...
    expect(coverage.options.since).toBe(JUL_30);
    const servable = checkExportRangeServable(
      { from: Date.parse('2026-09-08T00:00:00.000Z'), modes: [], markets: ['options'] },
      coverage,
    );
    // ...so it is servable, and an empty result is a real answer about this
    // book, not a confession of blindness. TRA-3860's 400 is reserved for the
    // window BELOW the floor.
    expect(servable.ok).toBe(true);
    const below = checkExportRangeServable(
      { from: JUL_30 - DAY, modes: [], markets: ['options'] },
      coverage,
    );
    expect(below.ok).toBe(false);
  });

  it('the coverage note states the floor is an OPEN floor, not an exit floor', () => {
    // Q2 of the filing: `sinceIso` advertised 2026-07-30 while the payload
    // served an exit dated 2026-07-15. Both are true — `journalFloorForMode`
    // folds `openTs` by design (a close-anchored floor refuses ranges that
    // contain their own rows) and takes the MAX across requested modes. The
    // note said "earliest EXIT time", which is what made the pair read as a
    // contradiction.
    const coverage = resolveExportCoverage({
      archiveBoundaryMs: Date.parse('2026-09-19T01:00:00.000Z'),
      processStartMs: Date.parse('2026-09-19T20:32:11.945Z'),
      journalRows: [
        close('1', { openTs: JUL_30, closeTs: Date.parse('2026-07-15T16:00:24.600Z') }),
        close('2', { mode: 'live', openTs: JUL_30, closeTs: SEP_02 }),
      ],
      filters: { modes: [], markets: ['options'] },
    });
    expect(coverage.note).toContain('OPEN the journal holds for it, NOT its earliest close');
    expect(coverage.note).toContain('MAX of the per-mode floors');
    // And the stated hazard is real on this input: a served exit BELOW the floor.
    expect(coverage.options.since).toBe(JUL_30);
  });
});
