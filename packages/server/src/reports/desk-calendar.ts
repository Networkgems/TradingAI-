import type { EodReport, EodTradeEntry } from '@trading-app/shared';
import type { OptionTradeJournalRecord } from '../option-trade-journal.js';
import { etDateString, isMarketDayIso } from '../scheduler.js';
import { excludeTestAccountRows } from '../test-accounts.js';

// TRA-1413 — the DESK (all demo books) calendar aggregation.
//
// Board decision on TRA-1398 (local-board picked C): keep the per-user Calendar
// exactly as-is and ADD a separate "Desk (all demo books)" view fed by the
// firm-wide Option-Trade Journal (`option-trade-journal.ts`). The per-user
// Calendar reads each user's own account book; this reads the ONE shared,
// firm-wide demo option-trade journal — the whole fleet's demo option P&L — so
// the fleet/desk number (e.g. Wed 07-01 ≈ +$10,564 / 191 closes) finally has a
// clearly-labelled UI home instead of only living in `/api/health/option-journal`.
//
// This module is a PURE fold: journal rows in → per-ET-day `EodReport`-shaped
// cells out, reusing the exact shape the Calendar grid already consumes so the
// UI only has to switch its data source, not its rendering. NO data-model change
// (option A — adding a username to journal rows — was explicitly NOT chosen);
// the journal has no per-user field and this fold adds none. Nothing here routes
// an order or reads a secret — it is the same firm-wide, demo-only, observe-only
// basis as the journal health readout.

/**
 * Map one closed journal row to the Calendar detail view's per-trade row. The
 * journal records the setup + realized outcome (P&L / R), not the per-contract
 * entry/exit premiums the equity EOD exporter carries, so price/qty fields that
 * the journal never captured are surfaced as 0 rather than a fabricated value.
 * `kind: 'option'` marks the row as an option close for the detail table.
 */
function journalRowToTradeEntry(r: OptionTradeJournalRecord): EodTradeEntry {
  return {
    id: r.id,
    symbol: r.symbol,
    // The desk book is options-only; every close maps to the generic 'Options'
    // strategy label (the journal keys on `structure`, not the equity signal
    // taxonomy the EodTradeEntry.strategy union enumerates).
    strategy: 'Options',
    side: 'buy',
    entryPrice: 0,
    exitPrice: 0,
    quantity: 0,
    pnl: r.realizedPnlUsd ?? 0,
    rr: r.realizedR ?? 0,
    openedAt: r.openTs,
    closedAt: r.closeTs ?? r.openTs,
    kind: 'option',
  };
}

/**
 * Fold the closed rows that landed on one ET day into an `EodReport`-shaped
 * desk cell. Only realized option P&L exists here (no equity/crypto legs, no
 * open MTM), so `realizedPnl` (equity) is 0, `optionsPnl` carries the day's
 * summed realized option P&L, and `combinedPnl === optionsPnl` — the figure the
 * calendar grid renders. `generatedAt` is injected so the fold stays pure/
 * deterministic for tests.
 */
export function buildDeskDayReport(
  date: string,
  closedRows: OptionTradeJournalRecord[],
  generatedAt: number,
): EodReport {
  const totalTrades = closedRows.length;
  const winners = closedRows.filter((r) => r.outcome === 'WIN').length;
  const losers = closedRows.filter((r) => r.outcome === 'LOSS').length;
  const optionsPnl = closedRows.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0);
  const sumR = closedRows.reduce((acc, r) => acc + (r.realizedR ?? 0), 0);
  const avgRR = totalTrades > 0 ? sumR / totalTrades : 0;
  const winRate = totalTrades > 0 ? winners / totalTrades : 0;

  return {
    date,
    generatedAt,
    realizedPnl: 0,
    unrealizedPnl: 0,
    totalPnl: optionsPnl,
    optionsPnl,
    combinedPnl: optionsPnl,
    totalEquity: 0,
    managedEquity: 0,
    availableCash: 0,
    trades: closedRows.map(journalRowToTradeEntry),
    openPositionCount: 0,
    winRate,
    avgRR,
    totalTrades,
    winners,
    losers,
    expectancy: avgRR,
    maxDrawdown: 0,
    sharpeRatio: 0,
    top5Movers: [],
    signalAccuracy: { totalSignals: 0, winningSignals: 0, winRate: 0, avgRR: 0 },
    // TRA-1413 — the desk cell is a live journal fold, not an archived narrative
    // report; the markdown body is unused by the calendar grid/detail, so it's a
    // one-line provenance stamp rather than a generated report.
    markdown: `Desk (all demo books) — firm-wide demo option journal, ${date}: `
      + `${totalTrades} closed, realized $${optionsPnl.toFixed(2)}.`,
  };
}

/**
 * TRA-1413 — fold the firm-wide demo journal into per-ET-day desk cells, keyed
 * by the ET day the position CLOSED on (`closeTs`), matching how the per-user
 * calendar books realized option P&L on its close day. Open rows and any close
 * missing a `closeTs` are skipped (no realized P&L to book). Returns a map of
 * `YYYY-MM-DD` → cell so the route can serve both the date list and a single
 * day without re-folding.
 */
export function aggregateDeskCalendar(
  rows: OptionTradeJournalRecord[],
  generatedAt: number,
): Map<string, EodReport> {
  const out = new Map<string, EodReport>();
  for (const [date, list] of closedRowsByEtDay(rows)) {
    // TRA-3298 — a close whose ET day is not a session (weekend OR holiday, per
    // the independent `isMarketDayIso` calendar TRA-3284 grades against) cannot
    // be a genuine market close. Every such row on record came from a sweep
    // batch-closing a book under the TRA-3267 UTC-day bug (07-04/07-05/07-11
    // carried $647.61; 07-03, the observed July-4 holiday, carried 52 zero-P&L
    // churn closes a day-of-week check would have missed). These are retracted
    // from every calendar view — never reattributed to a neighbouring session,
    // whose settled cell they would silently restate. The retraction is not
    // silent: `nonSessionCloseRetractions` enumerates the dropped rows and the
    // desk index route publishes it beside `dates`.
    if (!isMarketDayIso(date)) continue;
    out.set(date, buildDeskDayReport(date, list, generatedAt));
  }
  return out;
}

/** Group CLOSED journal rows by the ET day of `closeTs` (open rows skipped). */
function closedRowsByEtDay(
  rows: OptionTradeJournalRecord[],
): Map<string, OptionTradeJournalRecord[]> {
  const byDay = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of rows) {
    if (r.outcome === 'OPEN' || r.closeTs === undefined) continue;
    const day = etDateString(new Date(r.closeTs));
    const list = byDay.get(day) ?? [];
    list.push(r);
    byDay.set(day, list);
  }
  return byDay;
}

/** TRA-3298 — one non-session ET day whose closed rows were retracted from the fold. */
export interface NonSessionRetraction {
  date: string;
  totalTrades: number;
  /** Summed realized P&L the retraction removed from any monthly total, USD. */
  realizedPnlUsd: number;
  rowIds: string[];
}

/**
 * TRA-3298 — enumerate what {@link aggregateDeskCalendar} retracted, on the
 * same row basis the fold itself uses (`excludeTestAccountRows` composed in,
 * same `includeTest` escape). A retraction that only manifests as a date
 * quietly missing from the index is the "silent skip" failure mode TRA-3100
 * exists to kill; this is the enumeration that keeps it loud.
 */
export function nonSessionCloseRetractions(
  rows: OptionTradeJournalRecord[],
  opts: { includeTest?: boolean } = {},
): NonSessionRetraction[] {
  const out: NonSessionRetraction[] = [];
  for (const [date, list] of closedRowsByEtDay(excludeTestAccountRows(rows, opts))) {
    if (isMarketDayIso(date)) continue;
    out.push({
      date,
      totalTrades: list.length,
      realizedPnlUsd: Number(
        list.reduce((acc, r) => acc + (r.realizedPnlUsd ?? 0), 0).toFixed(2),
      ),
      rowIds: list.map((r) => r.id),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * TRA-2210 — the ONE way to turn firm-wide demo journal rows into calendar
 * cells: QA/test-book de-noise (TRA-1475) composed with the fold, in that order.
 *
 * The de-noise used to live at the two `/api/reports/desk*` call sites only.
 * TRA-1572 then added a THIRD consumer — the per-account DEMO calendar fills a
 * day the personal book was silent on from this same journal — and it called
 * the bare `aggregateDeskCalendar`, so it summed the QA churn the Desk view
 * drops. Both views read the same journal and disagreed: on 2026-07-22 "My
 * Account" showed **+$4,919.50** against Desk's **+$119.50** — a 41x overstatement,
 * $4,800 of it three fixture mirrors of ONE SMCI close (+$1,600 x3, each with a
 * distinct `id`, so id-dedupe sees no duplicate). A per-user view reading HIGHER
 * than the whole firm is the shape of that bug, and it is exactly what the board
 * saw.
 *
 * Filtering here rather than at each caller makes the omission structurally
 * impossible: there is no longer a call site that CAN forget. `includeTest`
 * (the routes' `?includeTest=1`) still opts the churn back in for debugging.
 */
export function buildJournalCalendarCells(
  rows: OptionTradeJournalRecord[],
  generatedAt: number,
  opts: { includeTest?: boolean } = {},
): Map<string, EodReport> {
  return aggregateDeskCalendar(excludeTestAccountRows(rows, opts), generatedAt);
}
