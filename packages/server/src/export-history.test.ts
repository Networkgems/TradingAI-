import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import type { OptionPosition } from '@trading-app/shared';
import { buildExport, toCsv, EXPORT_COLUMNS, type ExportFilters } from './export.js';
import {
  checkExportRangeServable,
  collectJournalMoneyRestatements,
  coverageHeaderValue,
  journalFloorForMode,
  resolveExportCoverage,
  rowFromJournalRecord,
  selectJournalExportRows,
} from './export-history.js';
import {
  journalIdForPosition,
  type OptionTradeJournalRecord,
} from './option-trade-journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3860 — `/api/trades/export` accepted a historical `from`/`to` range it
// could not serve and answered it with `200 {"trades": []}`, byte-identical to a
// day that genuinely had no trades.
//
// The fixtures below are the FILED INCIDENT, to the millisecond: bqb1's two live
// option closes on ET 2026-08-18 (PLTR + SPY, both `exitReason: "sl"`, -$115 and
// -$278 = -$393), and the 2026-08-19T01:00:06.467Z archive tick that deleted them
// from the in-memory book four hours before QA ran the export. Every assertion in
// AC1 is against those exact values rather than a synthetic shape, so a change
// that merely makes ranges non-empty cannot satisfy it.
//
// ⚠️ The SPY row's -$278 is the value AS FILED, and the live journal no longer
// holds it: TRA-2819/TRA-3730's close-basis restatement has since rewritten that
// row to -$156.23 (`feesUsd: 0.23`, `realizedPnlUsdBeforeRestatement: -278`), so
// the live export totals -$271.23 rather than -$393. That is a different ticket's
// writer moving the money, not this route mis-reading it — and these fixtures are
// deliberately pinned to the filed numbers so this suite keeps testing THIS
// change instead of tracking someone else's restatements.
// ─────────────────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

/** The 2026-08-19T01:00:06.467Z archive tick from the incident log line. */
const ARCHIVE_BOUNDARY = Date.parse('2026-08-19T01:00:06.467Z');
/** Process start, well after the boundary — the conservative fallback floor. */
const PROCESS_START = Date.parse('2026-08-19T05:00:00.000Z');

function journalRow(over: Partial<OptionTradeJournalRecord> = {}): OptionTradeJournalRecord {
  return {
    id: 'row-1',
    openTs: Date.parse('2026-08-17T13:46:42.923Z'),
    symbol: 'PLTR',
    structure: 'tradier_import',
    mode: 'live',
    ivRank: null,
    trend: 'unknown',
    sentiment: null,
    entryDelta: 0,
    entryDte: 4,
    atRiskUsd: 152,
    account: 'admin',
    outcome: 'LOSS',
    closeTs: Date.parse('2026-08-18T13:30:14.833Z'),
    realizedPnlUsd: -115.00000000000001,
    realizedR: -0.7565789473684211,
    exitReason: 'sl',
    optionSymbol: 'PLTR260821C00180000',
    contracts: 1,
    ...over,
  } as OptionTradeJournalRecord;
}

/** The two live closes bqb1 archived on 2026-08-19T01:00Z, as the journal holds them. */
const LIVE_0818: OptionTradeJournalRecord[] = [
  journalRow(),
  journalRow({
    id: 'row-2',
    symbol: 'SPY',
    optionSymbol: 'SPY260821C00777000',
    openTs: Date.parse('2026-08-17T17:04:49.377Z'),
    closeTs: Date.parse('2026-08-18T13:45:40.706Z'),
    atRiskUsd: 219,
    realizedPnlUsd: -278,
    realizedR: -1.269406392694064,
  }),
];

/** Whole-UTC-day bounds, exactly as `parseExportBoundary` produces them. */
function day(date: string): { from: number; to: number } {
  const from = Date.parse(date);
  return { from, to: from + 86_400_000 - 1 };
}

function coverageFor(
  rows: readonly OptionTradeJournalRecord[],
  filters: Pick<ExportFilters, 'modes' | 'markets'>,
  archiveBoundaryMs: number | null = ARCHIVE_BOUNDARY,
) {
  return resolveExportCoverage({
    archiveBoundaryMs,
    processStartMs: PROCESS_START,
    journalRows: rows,
    filters,
  });
}

describe('TRA-3860 AC1 — an archived day is served, with its exit reasons', () => {
  it('returns both 2026-08-18 live closes with exit_reason after the archive deleted them', () => {
    const filters: ExportFilters = {
      markets: ['options'],
      modes: ['live'],
      ...day('2026-08-18'),
    };
    const coverage = coverageFor(LIVE_0818, filters);

    // The floor moved back to the earliest event the journal holds for this
    // book — the PLTR open — not to the earliest close, which sits nine hours
    // INSIDE the requested day and would refuse the very query QA filed.
    expect(coverage.options.since).toBe(Date.parse('2026-08-17T13:46:42.923Z'));
    expect(coverage.options.source).toBe('option-trade-journal');

    expect(checkExportRangeServable(filters, coverage).ok).toBe(true);

    const { rows, summary } = buildExport(
      {
        // The book is EMPTY — this is the post-archive state QA measured.
        stocksClosed: [],
        cryptoClosed: [],
        optionsClosed: [],
        preMappedRows: selectJournalExportRows(LIVE_0818, new Set()),
      },
      filters,
    );

    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.symbol).sort()).toEqual([
      'PLTR260821C00180000',
      'SPY260821C00777000',
    ]);
    expect(rows.map(r => r.exit_reason)).toEqual(['sl', 'sl']);
    expect(rows.every(r => r.mode === 'live' && r.market === 'options')).toBe(true);
    // -$393 to the cent — the figure the filing ticket published.
    expect(summary.totals.net_pnl_usd).toBe(-393);
  });

  it('does not fabricate the prices the journal never recorded', () => {
    const row = rowFromJournalRecord(journalRow());
    // `tradier_import` rows carry no fill mark, and an UNRESTATED journal row
    // records no exit premium. Blank, never a stand-in — a fabricated price in an
    // audit export is worse than a missing one. (A row RESTATED from the fill
    // ledger does hold measured broker fills; see the TRA-3875 block below. A
    // measured fill is not a fabrication, and this row has neither.)
    expect(row.entry_price).toBeNull();
    expect(row.exit_price).toBeNull();
    // What it DOES know is carried exactly.
    expect(row.exit_reason).toBe('sl');
    expect(row.quantity).toBe(1);
    expect(row.net_pnl_usd).toBe(-115);
    expect(row.strategy).toBe('tradier_import');
  });
});

describe('TRA-3860 AC2 — the fix must DISCRIMINATE, not just return more rows', () => {
  it('a day fully INSIDE coverage that genuinely had no trades is served as 0', () => {
    // 2026-08-19 sits after the journal's floor for this book (2026-08-17T13:46Z)
    // and nothing closed on it. Served, and EMPTY — that is the answer, not the
    // bug. This is the assertion that fails a "make every range non-empty"
    // change, which the filing ticket called out as worse than the defect.
    const filters: ExportFilters = {
      markets: ['options'],
      modes: ['live'],
      ...day('2026-08-19'),
    };
    const coverage = coverageFor(LIVE_0818, filters);
    expect(checkExportRangeServable(filters, coverage).ok).toBe(true);

    const { rows, summary } = buildExport(
      { preMappedRows: selectJournalExportRows(LIVE_0818, new Set()) },
      filters,
    );
    expect(rows).toHaveLength(0);
    expect(summary.count).toBe(0);
  });

  it('a day BEFORE coverage is refused, not answered with the same 0', () => {
    // The discriminator. 2026-08-16 predates the journal's floor for this book,
    // so the honest answer is "cannot say" — and it must not share a response
    // shape with the servable empty day above.
    const filters: ExportFilters = {
      markets: ['options'],
      modes: ['live'],
      ...day('2026-08-16'),
    };
    const verdict = checkExportRangeServable(filters, coverageFor(LIVE_0818, filters));
    expect(verdict.ok).toBe(false);
  });
});

describe('TRA-3860 AC3 — an unservable range is refused, naming the limit', () => {
  it('refuses a from earlier than the stocks/crypto archive boundary', () => {
    const filters: ExportFilters = {
      markets: ['stocks'],
      modes: ['live'],
      ...day('2026-08-18'),
    };
    const coverage = coverageFor(LIVE_0818, filters);
    const verdict = checkExportRangeServable(filters, coverage);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.unservableMarkets).toEqual(['stocks']);
    // The limit is NAMED, with its provenance, not just asserted.
    expect(verdict.refusal.detail).toContain('2026-08-19T01:00:06.467Z');
    expect(verdict.refusal.detail).toContain('archive-boundary');
    expect(verdict.refusal.coverage.stocks.since).toBe(ARCHIVE_BOUNDARY);
  });

  it('the option journal extends OPTIONS only — stocks in the same request still refuse', () => {
    // The failure mode this guards: options history is recoverable and stocks
    // history is not, so a request spanning both must not be half-answered behind
    // a 200. `markets` unset ⇒ all three.
    const filters: ExportFilters = { modes: ['live'], ...day('2026-08-18') };
    const coverage = coverageFor(LIVE_0818, filters);
    const verdict = checkExportRangeServable(filters, coverage);

    expect(verdict.ok).toBe(false);
    if (verdict.ok) return;
    expect(verdict.refusal.unservableMarkets).toEqual(['stocks', 'crypto']);
    expect(coverage.options.source).toBe('option-trade-journal');
  });

  it('an UNBOUNDED export is not refused, but states its coverage', () => {
    // The UI's own export button sends no `from`. Refusing it would break every
    // caller who never asked for history; the coverage block is what stops the
    // emptiness from reading as a complete record.
    const filters: ExportFilters = { markets: ['options'], modes: ['live'] };
    const coverage = coverageFor([], filters);
    expect(checkExportRangeServable(filters, coverage).ok).toBe(true);
    expect(coverage.options.since).toBe(ARCHIVE_BOUNDARY);
    expect(coverage.note).toContain('refused with 400');
  });
});

describe('TRA-3860 — the coverage floor itself', () => {
  it('takes the MAX across requested modes, so a partial leg is refused not served', () => {
    // demo history back to 08-10, live only from 08-18. A `from` of 08-12 is
    // servable for demo and NOT for live; answering it would put a silently
    // partial live leg behind a 200 — the original defect with extra steps.
    const rows = [
      journalRow({
        id: 'demo-1',
        mode: 'demo',
        openTs: Date.parse('2026-08-10T18:00:00.000Z'),
        closeTs: Date.parse('2026-08-10T19:00:00.000Z'),
      }),
      ...LIVE_0818,
    ];
    const filters: ExportFilters = {
      markets: ['options'],
      modes: ['demo', 'live'],
      from: Date.parse('2026-08-12T00:00:00.000Z'),
    };
    const coverage = coverageFor(rows, filters);

    expect(journalFloorForMode(rows, 'demo')).toBe(Date.parse('2026-08-10T18:00:00.000Z'));
    expect(journalFloorForMode(rows, 'live')).toBe(Date.parse('2026-08-17T13:46:42.923Z'));
    // MAX, not MIN.
    expect(coverage.options.since).toBe(Date.parse('2026-08-17T13:46:42.923Z'));
    expect(checkExportRangeServable(filters, coverage).ok).toBe(false);

    // Ask for demo alone and the same `from` IS servable.
    const demoOnly: ExportFilters = { ...filters, modes: ['demo'] };
    expect(checkExportRangeServable(demoOnly, coverageFor(rows, demoOnly)).ok).toBe(true);
  });

  it('falls back to process start — never epoch 0 — when no archive has been observed', () => {
    // A snapshot written before this ticket has no boundary. The floor must be
    // conservative (refuse), not permissive: an epoch-0 default would read as
    // "this export covers all of history", which is the one wrong answer.
    const coverage = coverageFor([], { markets: ['stocks'], modes: ['live'] }, null);
    expect(coverage.stocks.since).toBe(PROCESS_START);
    expect(coverage.stocks.source).toBe('process-start');

    const filters: ExportFilters = {
      markets: ['stocks'],
      modes: ['live'],
      from: Date.parse('2026-08-19T04:00:00.000Z'),
    };
    expect(checkExportRangeServable(filters, coverageFor([], filters, null)).ok).toBe(false);
  });

  it('an OPEN journal row EXTENDS the floor but is never exported', () => {
    // An open row at time T is positive evidence the journal was capturing this
    // book at T — so it moves the floor. It has no exit, so it is not a trade the
    // export can list; the two facts are deliberately decoupled.
    const open = journalRow({
      id: 'open-1',
      outcome: 'OPEN',
      closeTs: undefined,
      exitReason: undefined,
      openTs: Date.parse('2026-08-01T14:00:00.000Z'),
    });
    const rows = [open, ...LIVE_0818];
    expect(journalFloorForMode(rows, 'live')).toBe(Date.parse('2026-08-01T14:00:00.000Z'));
    expect(selectJournalExportRows(rows, new Set()).map(r => r.symbol)).toEqual([
      'PLTR260821C00180000',
      'SPY260821C00777000',
    ]);
  });
});

describe('TRA-3860 — the X-Export-Coverage header value', () => {
  // Regression, measured on live bqb1: the first cut set the header to a bare
  // `JSON.stringify(coverage)`. `res.setHeader` rejects any character outside
  // latin1 with ERR_INVALID_CHAR, and the coverage note is human prose carrying
  // an em-dash — so EVERY CSV export, the route's DEFAULT format, returned 500.
  it('is pure printable ASCII even when the coverage note is not', () => {
    const coverage = coverageFor(LIVE_0818, { markets: ['options'], modes: ['live'] });
    // The note really does contain the character that broke it.
    expect(coverage.note).toMatch(/[^\x20-\x7E]/);

    const header = coverageHeaderValue(coverage);
    expect(header).not.toMatch(/[^\x20-\x7E]/);
    // Still machine-readable, and still carries the floors a reader needs.
    const parsed = JSON.parse(header);
    expect(parsed.options.sinceIso).toBe('2026-08-17T13:46:42.923Z');
    expect(parsed.options.source).toBe('option-trade-journal');
    // The prose lives in the JSON body, not on every CSV response.
    expect(parsed.note).toBeUndefined();
    expect(parsed.noteIn).toContain('summary.coverage.note');
  });

  it('survives a note deliberately seeded with astral and control characters', () => {
    const coverage = coverageFor([], { markets: ['options'], modes: ['live'] });
    const header = coverageHeaderValue({ ...coverage, note: 'x\u{1F600} —y' });
    expect(header).not.toMatch(/[^\x20-\x7E]/);
    expect(() => JSON.parse(header)).not.toThrow();
  });
});

describe('TRA-3860 — the refusal names the constraint that actually binds', () => {
  it('blames the journal floor for options and the archive for stocks', () => {
    const optionsOnly: ExportFilters = {
      markets: ['options'],
      modes: ['live'],
      from: Date.parse('2026-07-01T00:00:00.000Z'),
    };
    const o = checkExportRangeServable(optionsOnly, coverageFor(LIVE_0818, optionsOnly));
    expect(o.ok).toBe(false);
    if (o.ok) return;
    // Sending a reader to the archive for a journal-bound refusal is the same
    // class of defect as the empty 200 this route is being fixed for.
    expect(o.refusal.detail).toContain('option-trade journal only begins recording');
    expect(o.refusal.detail).not.toContain('21:00 ET archive');

    const stocksOnly: ExportFilters = {
      markets: ['stocks'],
      modes: ['live'],
      from: Date.parse('2026-08-18T00:00:00.000Z'),
    };
    const s = checkExportRangeServable(stocksOnly, coverageFor(LIVE_0818, stocksOnly));
    expect(s.ok).toBe(false);
    if (s.ok) return;
    expect(s.refusal.detail).toContain('21:00 ET archive');
  });
});

describe('TRA-3860 — the book wins over its journal twin', () => {
  it('drops the journal row whose id the in-memory book still holds', () => {
    // Same trade, two records. Serving both would double-count the day's P&L in
    // an export a human reconciles against a broker statement.
    const served = selectJournalExportRows(LIVE_0818, new Set(['row-1']));
    expect(served).toHaveLength(1);
    expect(served[0]!.symbol).toBe('SPY260821C00777000');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3864 AC2 — `fees_usd: 0` / `gross === net` on every journal-sourced row.
//
// `rowFromJournalRecord` inherited `export.ts`'s premise ("the engine does not
// record a per-trade commission on `Position`/`OptionPosition`, so `fees_usd` is
// always 0"). True of the BOOK; false of the JOURNAL, which has carried
// `feesUsd` since TRA-2819 and got it on the live money book via the TRA-3730
// sweep.
//
// The fixture is the live row as the journal holds it TODAY (build
// `bc92e57109c1`, measured 2026-08-19), deliberately distinct from `LIVE_0818`
// above, which stays pinned to the pre-restatement figures TRA-3860 was filed
// against.
// ─────────────────────────────────────────────────────────────────────────────

/** `SPY260821C00777000` as the live journal holds it AFTER the restatement. */
const SPY_RESTATED = journalRow({
  id: 'row-2',
  symbol: 'SPY',
  optionSymbol: 'SPY260821C00777000',
  openTs: Date.parse('2026-08-17T17:04:49.377Z'),
  closeTs: Date.parse('2026-08-18T13:45:40.706Z'),
  atRiskUsd: 219,
  realizedPnlUsd: -156.23,
  realizedR: -1.269406392694064,
  pnlBasis: 'broker-fill',
  feesUsd: 0.23,
  realizedPnlUsdBeforeRestatement: -278,
} as Partial<OptionTradeJournalRecord>);

describe('TRA-3864 AC2 — a restated journal row exports the fee it actually paid', () => {
  it('publishes the measured fee and a gross that is net + fees', () => {
    const row = rowFromJournalRecord(SPY_RESTATED);
    // The number the route published before this fix was 0 on a row whose fee
    // was measured. In an audit export that is indistinguishable from a trade
    // that genuinely paid nothing.
    expect(row.fees_usd).toBe(0.23);
    // `realizedPnlUsd` is NET of `feesUsd`, so it is untouched...
    expect(row.net_pnl_usd).toBe(-156.23);
    // ...and gross is reconstructed rather than copied from net.
    expect(row.gross_pnl_usd).toBe(-156);
    // The identity now has CONTENT. Before the fix it held vacuously, because
    // both operands were the same number and the subtrahend was 0.
    expect(row.gross_pnl_usd! - row.fees_usd).toBeCloseTo(row.net_pnl_usd!, 10);
    expect(row.gross_pnl_usd).not.toBe(row.net_pnl_usd);
  });

  it('leaves an UNRESTATED row at 0 rather than inventing a fee', () => {
    // `feesUsd` is set ONLY alongside `pnlBasis: 'broker-fill'`. The PLTR row on
    // the same live day carries neither, and QA graded its 0 as correct.
    const row = rowFromJournalRecord(journalRow());
    expect(row.fees_usd).toBe(0);
    expect(row.gross_pnl_usd).toBe(-115);
    expect(row.net_pnl_usd).toBe(-115);
  });

  it('rolls the fee into the export summary instead of totalling 0', () => {
    const filters: ExportFilters = {
      markets: ['options'],
      modes: ['live'],
      ...day('2026-08-18'),
    };
    const { rows, summary } = buildExport(
      { preMappedRows: selectJournalExportRows([journalRow(), SPY_RESTATED], new Set()) },
      filters,
    );
    expect(rows).toHaveLength(2);
    // The live day as the journal now holds it: -115.00 + -156.23.
    expect(summary.totals.net_pnl_usd).toBe(-271.23);
    expect(summary.totals.fees_usd).toBe(0.23);
    expect(summary.totals.gross_pnl_usd).toBe(-271);
  });

  it('does not disturb a null P&L row', () => {
    // A row with no `realizedPnlUsd` must not acquire a gross of `0 + fees`.
    const row = rowFromJournalRecord(
      journalRow({ realizedPnlUsd: undefined, feesUsd: 0.23 } as Partial<OptionTradeJournalRecord>),
    );
    expect(row.net_pnl_usd).toBeNull();
    expect(row.gross_pnl_usd).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3875 — the route published TWO P&L figures for one contract, selected by
// nothing but the HOUR of the read.
//
// `SPY260821C00777000`, live money, closed 2026-08-18: **-278.00** before the
// 21:00 ET archive and **-156.23** after it. Day total -393.00 then -271.23. A
// $121.77 swing, same route, same query, same trade — and the half served during
// the trading day, the one a desk actually reads, was the SUPERSEDED one.
//
// Two correct tickets composing into a hole:
//   1. TRA-2819/TRA-3730 restate the JOURNAL and deliberately never touch
//      `OptionPosition.pnl` on the in-memory book.
//   2. TRA-3860's dedupe drops the journal twin whenever the book still holds the
//      same `position.id` — and dropped its restated MONEY with it.
//   3. `archiveClosedOptions()` empties `closedOptions` at 21:00 ET, so the book
//      twin, and with it the superseded figure, vanishes on a clock.
//
// The worst part is the reconciliation inversion: pre-archive the export total
// (-393.00) MATCHED the frozen day cell (-393.00), so an export-vs-day-cell check
// came back GREEN during the trading day and RED after it — and the RED one is
// the correct state, because TRA-3864 ruled (b) FREEZE so the divergence stays
// visible. Two surfaces sharing one superseded number is not corroboration.
//
// ## The pre-registered read this suite stands in for
//
// QA could not measure the pre-archive half: the 21:00 ET archive had already run
// and `closedOptions` was 0 across every book, so no book twin was left to serve.
// The claim was filed DERIVED, with the confirming read pre-registered for the
// next ET day carrying an imported option close. These fixtures ARE that read,
// constructed from the deployed source: `BOOK_SPY` is the book twin as
// `archiveClosedOptions()` had already deleted it, and every number in it is an
// incident anchor. The suite therefore runs the pre-archive half that the live
// box will not offer again until the next imported close.
//
// **Both halves are asserted in the same test.** The defect is not that either
// figure is wrong on its own — it is that the two DISAGREE and are never on
// screen together. A suite that measured one hour would reproduce exactly the
// blindness being fixed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The SPY book twin as bqb1 held it before the 2026-08-19T01:00Z archive.
 *
 * `pnl: -278` is the engine's own close arithmetic and the value the frozen day
 * cell is built from (-115.00 + -278.00 = -393.00). The premiums reconstruct it
 * exactly: (1.41 − 4.19) × 1 × 100 = -278. `stopLossPremium: 2` reproduces the
 * journal's `atRiskUsd: 219`, so the book's own R is -278/219 = -1.269 — which is
 * what makes the R assertion below discriminating rather than decorative.
 */
function bookSpy(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'row-2',
    symbol: 'SPY',
    optionSymbol: 'SPY260821C00777000',
    optionType: 'call',
    strike: 777,
    expiration: '2026-08-21',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: 4.19,
    currentPremium: 1.41,
    stopLossPremium: 2,
    openedAt: Date.parse('2026-08-17T17:04:49.377Z'),
    closedAt: Date.parse('2026-08-18T13:45:40.706Z'),
    pnl: -278,
    signalType: 'tradier_import',
    exitReason: 'sl',
    mode: 'live',
    ...overrides,
  } as OptionPosition;
}

/** The PLTR book twin. Its journal row was never restated — nothing to supersede. */
function bookPltr(overrides: Partial<OptionPosition> = {}): OptionPosition {
  return {
    id: 'row-1',
    symbol: 'PLTR',
    optionSymbol: 'PLTR260821C00180000',
    optionType: 'call',
    strike: 180,
    expiration: '2026-08-21',
    contracts: 1,
    contractsRemaining: 0,
    premiumPaid: 3.04,
    currentPremium: 1.89,
    stopLossPremium: 1.52,
    openedAt: Date.parse('2026-08-17T13:46:42.923Z'),
    closedAt: Date.parse('2026-08-18T13:30:14.833Z'),
    pnl: -115,
    signalType: 'tradier_import',
    exitReason: 'sl',
    mode: 'live',
    ...overrides,
  } as OptionPosition;
}

/**
 * `SPY260821C00777000` as the journal holds it after the TRA-3730 sweep, WITH the
 * broker fills the restatement measures (`tra2819-close-basis-restate.ts` —
 * `entryCost / contracts / 100`, per share).
 *
 * `realizedR` is re-derived by the restatement in the same write that moves the
 * money (`option-trade-journal.ts`), so it is -156.23/219 = -0.713 here, NOT the
 * -1.269 the book still carries. `SPY_RESTATED` above keeps the book's R because
 * TRA-3864 only ever read `feesUsd` off it; this fixture is the one that has to
 * be right about R.
 */
const SPY_RESTATED_WITH_FILLS = journalRow({
  id: 'row-2',
  symbol: 'SPY',
  optionSymbol: 'SPY260821C00777000',
  openTs: Date.parse('2026-08-17T17:04:49.377Z'),
  closeTs: Date.parse('2026-08-18T13:45:40.706Z'),
  atRiskUsd: 219,
  realizedPnlUsd: -156.23,
  realizedR: -0.7133789954337899,
  pnlBasis: 'broker-fill',
  feesUsd: 0.23,
  entryFillPremium: 3.2,
  exitFillPremium: 1.64,
  realizedPnlUsdBeforeRestatement: -278,
} as Partial<OptionTradeJournalRecord>);

/** The live journal for ET 2026-08-18: PLTR unrestated, SPY restated. */
const JOURNAL_0818 = [journalRow(), SPY_RESTATED_WITH_FILLS];

const DAY_0818: ExportFilters = {
  markets: ['options'],
  modes: ['live'],
  ...day('2026-08-18'),
};

/**
 * One export, at one of the two hours. `archived` is the ONLY thing that varies —
 * it is exactly what `archiveClosedOptions()` does at 21:00 ET, and the whole
 * ticket is the claim that it must not change the money.
 */
function exportAt({ archived }: { archived: boolean }) {
  const optionsClosed = archived ? [] : [bookPltr(), bookSpy()];
  const bookIds = new Set(optionsClosed.map(o => o.id));
  return buildExport(
    {
      stocksClosed: [],
      cryptoClosed: [],
      optionsClosed,
      preMappedRows: selectJournalExportRows(JOURNAL_0818, bookIds),
      optionMoneyRestatements: collectJournalMoneyRestatements(JOURNAL_0818, bookIds),
    },
    DAY_0818,
  );
}

const spyRow = (rows: ReturnType<typeof exportAt>['rows']) =>
  rows.find(r => r.symbol === 'SPY260821C00777000')!;
const pltrRow = (rows: ReturnType<typeof exportAt>['rows']) =>
  rows.find(r => r.symbol === 'PLTR260821C00180000')!;

describe('TRA-3875 AC1 — the money columns do not move on the clock', () => {
  it('serves -156.23 / -271.23 BOTH before and after the 21:00 ET archive', () => {
    const before = exportAt({ archived: false });
    const after = exportAt({ archived: true });

    // The pre-archive half is the one that was wrong. It published -278.00 and a
    // day of -393.00 — the arithmetic sum of the two BOOK figures, which is also
    // the frozen day cell, which is why the reconciliation came back GREEN for
    // the wrong reason.
    expect(spyRow(before.rows).net_pnl_usd).toBe(-156.23);
    expect(before.summary.totals.net_pnl_usd).toBe(-271.23);

    // The post-archive half was already right and must stay untouched.
    expect(spyRow(after.rows).net_pnl_usd).toBe(-156.23);
    expect(after.summary.totals.net_pnl_usd).toBe(-271.23);

    // The defect itself, stated as one assertion: the two hours agree.
    expect(before.summary.totals).toEqual(after.summary.totals);
  });

  it('carries fees and gross across too, not just net', () => {
    const before = exportAt({ archived: false }).summary;
    const after = exportAt({ archived: true }).summary;
    // The book records no per-trade commission, so pre-archive this totalled 0
    // fees on a day whose fee was MEASURED at $0.23 (TRA-3864, one surface over).
    expect(before.totals.fees_usd).toBe(0.23);
    expect(after.totals.fees_usd).toBe(0.23);
    expect(before.totals.gross_pnl_usd).toBe(-271);
    // gross − fees === net, with content rather than vacuously.
    const spy = spyRow(exportAt({ archived: false }).rows);
    expect(spy.gross_pnl_usd).toBe(-156);
    expect(spy.fees_usd).toBe(0.23);
    expect(spy.gross_pnl_usd! - spy.fees_usd).toBeCloseTo(spy.net_pnl_usd!, 10);
  });

  it('moves pnl_r with the money instead of leaving an R computed from the figure it replaced', () => {
    const spy = spyRow(exportAt({ archived: false }).rows);
    // The book's own R is -278/219 = -1.269 and would be arithmetically
    // inconsistent with a net of -156.23 sitting in the next column.
    expect(spy.pnl_r).toBe(-0.713);
    expect(spy.pnl_r).not.toBe(-1.269);
  });
});

describe('TRA-3875 AC2 — the exit premium is NOT the price of the fix', () => {
  it('keeps a measured exit price on the restated row, from the broker fill', () => {
    const before = spyRow(exportAt({ archived: false }).rows);
    const after = spyRow(exportAt({ archived: true }).rows);
    // TRA-3860's dedupe existed because "only the book has the exit premium".
    // On a RESTATED row that is false: the restatement measures `exitFillPremium`,
    // a broker fill, which beats the book's last mark of 1.41.
    expect(before.exit_price).toBe(1.64);
    expect(after.exit_price).toBe(1.64);
    expect(before.entry_price).toBe(3.2);
    // So option (2) "journal wins outright, accept a null exit_price" would have
    // paid a price this route does not actually have to pay.
    expect(before.exit_price).not.toBeNull();
  });

  it('leaves the columns the journal does not restate to the book', () => {
    const before = spyRow(exportAt({ archived: false }).rows);
    // `closeTs`, `exitReason` and the strategy label are carried through the
    // restatement by the spread and deliberately not restated.
    expect(before.exit_reason).toBe('sl');
    expect(before.strategy).toBe('tradier_import');
    expect(before.exit_time).toBe('2026-08-18T13:45:40.706Z');
    expect(before.quantity).toBe(1);
  });
});

describe('TRA-3875 AC3 — an UNRESTATED twin is left exactly as it was', () => {
  it('does not touch PLTR, whose journal row carries no pnlBasis', () => {
    const before = pltrRow(exportAt({ archived: false }).rows);
    expect(before.net_pnl_usd).toBe(-115);
    expect(before.fees_usd).toBe(0);
    expect(before.pnl_basis).toBe('book');
    // The BOOK's mark survives, because there is no broker fill to prefer.
    expect(before.exit_price).toBe(1.89);
    expect(before.entry_price).toBe(3.04);
  });

  it('reports no restatement for a row with no measured disagreement', () => {
    const restatements = collectJournalMoneyRestatements(
      [journalRow()],
      new Set(['row-1']),
    );
    // Manufacturing an entry here would replace a number with itself while
    // incrementing `supersededRowCount` — a fabricated conflict.
    expect(restatements.size).toBe(0);
  });
});

describe('TRA-3875 AC4 — the two paths PARTITION the journal, so nothing doubles', () => {
  it('still drops the journal twin: two rows, never four', () => {
    expect(exportAt({ archived: false }).rows).toHaveLength(2);
    expect(exportAt({ archived: true }).rows).toHaveLength(2);
  });

  it('routes a row with NO book twin to the served path, not the restatement path', () => {
    // Post-archive: `bookIds` is empty, so the restatement map must be empty and
    // the row must instead be SERVED by `selectJournalExportRows` carrying its own
    // restated money. Exactly one path per row, in both directions.
    expect(collectJournalMoneyRestatements(JOURNAL_0818, new Set()).size).toBe(0);
    expect(selectJournalExportRows(JOURNAL_0818, new Set())).toHaveLength(2);

    // Pre-archive: the mirror. The restatement path takes SPY, the served path
    // takes neither.
    const bookIds = new Set(['row-1', 'row-2']);
    expect([...collectJournalMoneyRestatements(JOURNAL_0818, bookIds).keys()]).toEqual(['row-2']);
    expect(selectJournalExportRows(JOURNAL_0818, bookIds)).toHaveLength(0);
  });
});

describe('TRA-3875 AC5 — the merge is PUBLISHED, not silent', () => {
  it('states source and pnl_basis on every row, and counts the supersession', () => {
    const before = exportAt({ archived: false }).summary;
    const after = exportAt({ archived: true }).summary;

    expect(before.sources).toEqual({ book: 2, journal: 0 });
    expect(after.sources).toEqual({ book: 0, journal: 2 });

    // The row is book-IDENTITY carrying broker-settled MONEY — the two are
    // independent, which is the whole reason both fields exist.
    const spy = spyRow(exportAt({ archived: false }).rows);
    expect(spy.source).toBe('book');
    expect(spy.pnl_basis).toBe('broker-fill');

    // One row disagreed and the journal won. After the archive there is no book
    // twin left to disagree — the 0 means "nothing to supersede", not "resolved".
    expect(before.supersededRowCount).toBe(1);
    expect(after.supersededRowCount).toBe(0);
  });

  it('counts over the SERVED rows, so a filter that drops the restated row reports 0', () => {
    const { summary } = buildExport(
      {
        optionsClosed: [bookPltr(), bookSpy()],
        optionMoneyRestatements: collectJournalMoneyRestatements(
          JOURNAL_0818,
          new Set(['row-1', 'row-2']),
        ),
      },
      // A window that excludes SPY's 13:45 close but keeps PLTR's 13:30 one.
      { markets: ['options'], modes: ['live'], from: day('2026-08-18').from, to: Date.parse('2026-08-18T13:40:00.000Z') },
    );
    expect(summary.count).toBe(1);
    expect(summary.supersededRowCount).toBe(0);
  });
});

describe('TRA-3875 AC6 — the design §2.3 CSV header is byte-identical', () => {
  it('adds the provenance fields to JSON only', () => {
    const { rows } = exportAt({ archived: false });
    const csv = toCsv(rows);
    const header = csv.split('\r\n')[0];
    expect(header).toBe(EXPORT_COLUMNS.join(','));
    expect(header).not.toContain('source');
    expect(header).not.toContain('pnl_basis');
    // And no row leaks a value into the body either.
    expect(csv).not.toContain('broker-fill');
    // The restated money DOES reach the CSV — it is a money column, not a new one.
    expect(csv).toContain('-156.23');
    expect(csv).not.toContain('-278');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// TRA-3930 — the export DOUBLE-COUNTED every live option close while its book
// twin was still in memory: bqb1 published **-130.00 for a -65.00 day** on ET
// 2026-08-21, `summary.count 4` for two real closes.
//
// The fixtures below are that day's closes exactly as the live reads held them
// (build `4e10132`, pid 73, pinned before AND after every read): `/api/state →
// options.closedOptions`, and `/api/health/option-journal?rows=all` filtered to
// `closeEtDay: "2026-08-21"` and `mode: "live"`. BOTH causes are in the one
// fixture because both were on the wire at once.
// ─────────────────────────────────────────────────────────────────────────────

/** ms-epoch exit stamps, identical across both stores on the wire. */
const XLF_CLOSE_TS = Date.parse('2026-08-21T13:48:04.444Z');
const BAC_CLOSE_TS = Date.parse('2026-08-21T17:05:10.473Z');

/**
 * The XLF close, whose book id and journal id DIFFER — the reconcile REBOUND it
 * onto a pre-existing OPEN row (TRA-3078), so `journalId` is where the binding
 * lives. The direct-id control on the live reader confirmed `4128b85b…` is not
 * in the journal AT ALL, which is why the old key could never exclude anything
 * for this position.
 */
const XLF_BOOK_ID = '4128b85b-b025-4455-8589-c40c5099d8a0';
const XLF_JOURNAL_ID = 'be56369f-5f1d-4479-8000-9c679e4dab3e';
/** The BAC close, resolved to identity — `journalId` absent on the wire. */
const BAC_ID = '0e180e8c-fe75-49d9-a7f8-84267b610c22';
/** The DUPLICATE record of that same BAC close: MINTed, not rebound. */
const BAC_DUP_ID = '6bbc5d17-40da-4999-ab4e-f8920fe42adb';

function book0821(): OptionPosition[] {
  return [
    {
      id: XLF_BOOK_ID,
      // ⚠️ The whole of Cause 1 is in this one field.
      journalId: XLF_JOURNAL_ID,
      symbol: 'XLF',
      optionSymbol: 'XLF260925C00057500',
      contracts: 2,
      premiumPaid: 0.965,
      currentPremium: 1.01,
      openedAt: Date.parse('2026-08-21T13:23:02.482Z'),
      closedAt: XLF_CLOSE_TS,
      pnl: 9,
      signalType: 'otm_mispricing',
      exitReason: 'chandelier_spot_seeded',
      mode: 'live',
    } as unknown as OptionPosition,
    {
      id: BAC_ID,
      symbol: 'BAC',
      optionSymbol: 'BAC260925C00063000',
      contracts: 1,
      premiumPaid: 1.65,
      currentPremium: 0.91,
      openedAt: 1787232982482,
      closedAt: BAC_CLOSE_TS,
      pnl: -74,
      signalType: 'otm_mispricing',
      exitReason: 'chandelier_restarted',
      mode: 'live',
    } as unknown as OptionPosition,
  ];
}

/**
 * The three live journal rows for that ET day. XLF's twin, BAC's engine-authored
 * twin, and BAC's TRA-3485 reconstruction — which is the SAME close as the row
 * before it (`closeTs` identical to the millisecond, same OCC, same contracts,
 * -73.99999999999999 vs -74), minted rather than rebound by
 * `reconcileTradierPositions`. Their `openTs` differ by the observed 279 ms.
 */
const JOURNAL_0821: OptionTradeJournalRecord[] = [
  journalRow({
    id: XLF_JOURNAL_ID,
    symbol: 'XLF',
    optionSymbol: 'XLF260925C00057500',
    structure: 'single_leg_otm',
    outcome: 'SCRATCH',
    openTs: Date.parse('2026-08-21T13:23:02.482Z'),
    closeTs: XLF_CLOSE_TS,
    atRiskUsd: 101,
    entryMarkUsd: 1.01,
    contracts: 1,
    realizedPnlUsd: 9,
    realizedR: 0.0891089108910891,
    exitReason: 'chandelier_spot_seeded',
  } as Partial<OptionTradeJournalRecord>),
  journalRow({
    id: BAC_ID,
    symbol: 'BAC',
    optionSymbol: 'BAC260925C00063000',
    structure: 'single_leg_otm',
    outcome: 'LOSS',
    openTs: 1787232982482,
    closeTs: BAC_CLOSE_TS,
    atRiskUsd: 151,
    contracts: 1,
    realizedPnlUsd: -73.99999999999999,
    realizedR: -0.49,
    exitReason: 'chandelier_restarted',
  } as Partial<OptionTradeJournalRecord>),
  journalRow({
    id: BAC_DUP_ID,
    symbol: 'BAC',
    optionSymbol: 'BAC260925C00063000',
    structure: 'tradier_import',
    outcome: 'LOSS',
    // 279 ms after the real OPEN — the signature of a second mint.
    openTs: 1787232982761,
    closeTs: BAC_CLOSE_TS,
    atRiskUsd: 141,
    contracts: 1,
    realizedPnlUsd: -74,
    realizedR: -0.5248,
    exitReason: 'reconstructed-TRA-3472',
  } as Partial<OptionTradeJournalRecord>),
];

const DAY_0821: ExportFilters = {
  markets: ['options'],
  modes: ['live'],
  ...day('2026-08-21'),
};

/**
 * One export of ET 2026-08-21. `archived` is again the only variable: the 21:00
 * ET tick is what emptied the book half, and it is why this defect survived —
 * every reading ever taken before that day was post-archive, i.e. single-copy.
 *
 * ⚠️ The book id set is built the way `index.ts` builds it — through
 * `journalIdForPosition`. A test that spelled it `o.id` here would encode the
 * bug and go green against it.
 */
function exportAt0821({ archived }: { archived: boolean }) {
  const optionsClosed = archived ? [] : book0821();
  const bookIds = new Set(optionsClosed.map(o => journalIdForPosition(o)));
  return buildExport(
    {
      optionsClosed,
      preMappedRows: selectJournalExportRows(JOURNAL_0821, bookIds),
      optionMoneyRestatements: collectJournalMoneyRestatements(JOURNAL_0821, bookIds),
    },
    DAY_0821,
  );
}

describe('TRA-3930 AC1 — the published day is the day that happened', () => {
  it('serves 2 rows and -65.00, not 4 rows and -130.00', () => {
    const { rows, summary } = exportAt0821({ archived: false });

    // The filed symptom, exactly: `count 4`, `net_pnl_usd -130`.
    expect(summary.count).toBe(2);
    expect(summary.totals.net_pnl_usd).toBe(-65);
    expect(summary.totals.gross_pnl_usd).toBe(-65);

    // No consumer joining on OCC can get two contradictory answers for one trade.
    expect(rows.map(r => r.symbol).sort()).toEqual([
      'BAC260925C00063000',
      'XLF260925C00057500',
    ]);
    // `win_rate` read 0.5 both before and after, because the duplication was
    // symmetric — one win doubled, one loss doubled. It is asserted for the
    // DENOMINATOR, which was 4 and is now 2, not for the ratio.
    expect(summary.win_rate).toBe(0.5);
  });

  it('does not move on the 21:00 ET archive clock', () => {
    const before = exportAt0821({ archived: false });
    const after = exportAt0821({ archived: true });
    expect(before.summary.count).toBe(after.summary.count);
    expect(before.summary.totals.net_pnl_usd).toBe(after.summary.totals.net_pnl_usd);
    // Provenance DOES move, and honestly so: `sources.book: 2` is the pre-archive
    // census, and 2026-08-21 was the first day that census was ever non-zero on
    // bqb1 — which is the whole reason this was readable for exactly one day.
    expect(before.summary.sources).toEqual({ book: 2, journal: 0 });
    expect(after.summary.sources).toEqual({ book: 0, journal: 2 });
  });
});

describe('TRA-3930 AC2 — Cause 1: the dedup key is the JOURNAL id, not the book id', () => {
  it('excludes the twin of a REBOUND position, whose two ids differ', () => {
    const bookIds = new Set(book0821().map(o => journalIdForPosition(o)));
    expect(bookIds.has(XLF_JOURNAL_ID)).toBe(true);
    expect(bookIds.has(XLF_BOOK_ID)).toBe(false);
    expect(selectJournalExportRows(JOURNAL_0821, bookIds)).toEqual([]);
  });

  it('NEGATIVE CONTROL: the old book-id key still lets the rebound twin through', () => {
    // Keyed the pre-fix way, with Cause 2 already repaired — so this isolates
    // Cause 1 alone. Without this the suite would only pin the right answer and
    // could not show the wrong one was reachable.
    const wrongKey = new Set(book0821().map(o => o.id));
    const served = selectJournalExportRows(JOURNAL_0821, wrongKey);
    // 1 of the day's 2 book rows (50%) had `journalId != id`.
    expect(served.map(r => r.symbol)).toEqual(['XLF260925C00057500']);
    const { summary } = buildExport(
      { optionsClosed: book0821(), preMappedRows: served },
      DAY_0821,
    );
    expect(summary.count).toBe(3);
    expect(summary.totals.net_pnl_usd).toBe(-56);
  });

  it('carries the restatement onto the book row under the JOURNAL id', () => {
    // The latent MONEY half of the same key. A rebound position whose twin is
    // `broker-fill` was BOTH unrestated AND published twice — which lands on
    // TRA-3875's stated FAIL condition (`supersededRowCount: 0` beside a
    // `pnl_basis: "book"` row whose twin is `broker-fill`) via a cause that has
    // nothing to do with the restatement logic.
    const restated = JOURNAL_0821.map(r =>
      r.id === XLF_JOURNAL_ID
        ? ({
            ...r,
            pnlBasis: 'broker-fill',
            feesUsd: 0.7,
            realizedPnlUsd: 8.3,
            realizedR: 0.082,
            entryFillPremium: 0.96,
            exitFillPremium: 1.0,
          } as OptionTradeJournalRecord)
        : r,
    );
    const bookIds = new Set(book0821().map(o => journalIdForPosition(o)));
    expect([...collectJournalMoneyRestatements(restated, bookIds).keys()]).toEqual([
      XLF_JOURNAL_ID,
    ]);

    const { rows, summary } = buildExport(
      {
        optionsClosed: book0821(),
        preMappedRows: selectJournalExportRows(restated, bookIds),
        optionMoneyRestatements: collectJournalMoneyRestatements(restated, bookIds),
      },
      DAY_0821,
    );
    expect(summary.count).toBe(2);
    expect(summary.supersededRowCount).toBe(1);
    const xlf = rows.find(r => r.symbol === 'XLF260925C00057500')!;
    expect(xlf.source).toBe('book');
    expect(xlf.pnl_basis).toBe('broker-fill');
    expect(xlf.net_pnl_usd).toBe(8.3);
  });
});

describe('TRA-3930 AC3 — Cause 2: one close is one row, even with two journal records', () => {
  it('drops the reconstruction whose close is book-held under a DIFFERENT id', () => {
    // `6bbc5d17` has no book twin under ANY id, so no set of book ids — however
    // it is keyed — can exclude it. It is dropped because its CLOSE is served.
    const bookIds = new Set(book0821().map(o => journalIdForPosition(o)));
    expect(bookIds.has(BAC_DUP_ID)).toBe(false);
    expect(selectJournalExportRows(JOURNAL_0821, bookIds)).toHaveLength(0);
  });

  it('post-archive, publishes the ENGINE record of the close, not the repair one', () => {
    // Both BAC records survive the book test once the book is empty. Exactly one
    // is served, and it is the one that knows WHY the trade was exited:
    // `reconstructed-TRA-3472` explicitly means the real exit was LOST (TRA-3485)
    // and must not join `byExitReason` as if it had been observed.
    const served = selectJournalExportRows(JOURNAL_0821, new Set());
    expect(served).toHaveLength(2);
    expect(served.filter(r => r.symbol === 'BAC260925C00063000')).toHaveLength(1);
    expect(served.find(r => r.symbol === 'BAC260925C00063000')!.exit_reason).toBe(
      'chandelier_restarted',
    );
  });

  it('takes MEASURED money off a SIBLING record of the same close', () => {
    // Once two records can describe one close, the record holding the exit
    // DECISION and the record holding broker truth need not be the same row.
    // Scoped to `mode|OCC|closeTs`, never across closes.
    const withFill = JOURNAL_0821.map(r =>
      r.id === BAC_DUP_ID
        ? ({
            ...r,
            pnlBasis: 'broker-fill',
            feesUsd: 0.34,
            realizedPnlUsd: -70.5,
            realizedR: -0.5,
            exitFillPremium: 0.95,
          } as OptionTradeJournalRecord)
        : r,
    );
    const bac = selectJournalExportRows(withFill, new Set()).find(
      r => r.symbol === 'BAC260925C00063000',
    )!;
    expect(bac.exit_reason).toBe('chandelier_restarted');
    expect(bac.net_pnl_usd).toBe(-70.5);
    expect(bac.pnl_basis).toBe('broker-fill');
  });

  it('never collapses two DIFFERENT closes of the same contract', () => {
    // `closeTs` is the discriminator. A second exit of the same contract one
    // second later is a second trade, and merging them would be this ticket's
    // defect in the expensive direction — an UNDER-count.
    const second = { ...JOURNAL_0821[1]!, id: 'later', closeTs: BAC_CLOSE_TS + 1000 };
    const served = selectJournalExportRows([...JOURNAL_0821, second], new Set());
    expect(served.filter(r => r.symbol === 'BAC260925C00063000')).toHaveLength(2);
  });

  it('never collapses across BOOKS: demo and live are separate closes', () => {
    const demoTwin = { ...JOURNAL_0821[1]!, id: 'demo-1', mode: 'demo' } as OptionTradeJournalRecord;
    const served = selectJournalExportRows([...JOURNAL_0821, demoTwin], new Set());
    expect(served.filter(r => r.symbol === 'BAC260925C00063000')).toHaveLength(2);
  });

  it('leaves a row with NO optionSymbol ungrouped rather than guessing', () => {
    // Pre-TRA-1656 rows carry no contract identity, so there is nothing to assert
    // sameness ON. Collapsing them on `mode|closeTs` alone would merge two
    // genuinely different contracts closed in the same batch.
    const anon = (id: string) =>
      ({ ...JOURNAL_0821[1]!, id, optionSymbol: undefined }) as OptionTradeJournalRecord;
    expect(selectJournalExportRows([anon('a'), anon('b')], new Set())).toHaveLength(2);
  });
});

describe('TRA-3930 AC4 — the ROUTE builds the key the fixed way', () => {
  // Everything above grades the library. The defect was in the CALL SITE: the
  // library was handed a set of the wrong ids. `export-request.integration.test`
  // re-implements the route rather than importing `index.ts`, so there is no
  // wire-level suite this can hang off — and a green library over a call site
  // nobody graded is the TRA-2298/TRA-2320 shape exactly. This reads the source.
  const src = readFileSync(join(__dirname, 'index.ts'), 'utf-8');

  it('derives `bookOptionIds` through `journalIdForPosition`, never a bare `o.id`', () => {
    expect(src).toContain('new Set(optionsClosed.map(o => journalIdForPosition(o)))');
    // The exact pre-fix expression, which must not come back.
    expect(src).not.toContain('new Set(optionsClosed.map(o => o.id))');
  });

  it('hands the SAME set to both call sites, so the two paths still partition', () => {
    expect(src).toContain('selectJournalExportRows(bookJournalRows, bookOptionIds)');
    expect(src).toContain('collectJournalMoneyRestatements(bookJournalRows, bookOptionIds)');
  });

  it('joins the restatement back onto the book row by the journal id', () => {
    // The other half of the same key: `export.ts` looks the map up per position,
    // and a lookup by `o.id` against a map keyed by journal id silently misses.
    const exportSrc = readFileSync(join(__dirname, 'export.ts'), 'utf-8');
    expect(exportSrc).toContain('optionMoneyRestatements?.get(journalIdForPosition(o))');
    expect(exportSrc).not.toContain('optionMoneyRestatements?.get(o.id)');
  });
});
