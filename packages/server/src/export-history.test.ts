import { describe, it, expect } from 'vitest';
import { buildExport, type ExportFilters } from './export.js';
import {
  checkExportRangeServable,
  coverageHeaderValue,
  journalFloorForMode,
  resolveExportCoverage,
  rowFromJournalRecord,
  selectJournalExportRows,
} from './export-history.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

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
    // `tradier_import` rows carry no fill mark, and the journal records no exit
    // premium for ANY row. Blank, never a stand-in — a fabricated price in an
    // audit export is worse than a missing one.
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
