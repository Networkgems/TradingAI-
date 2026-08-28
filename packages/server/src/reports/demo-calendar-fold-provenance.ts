// TRA-4203 — LABEL the firm-wide demo fold on its way out of the per-account
// calendar route.
//
// `demo-calendar-fill-scope.ts` (TRA-2407) answers WHO may be served the fold.
// This module answers the question nobody was answering: once served, HOW DOES
// THE READER KNOW IT IS NOT THEIR MONEY.
//
// The fold itself is not a bug and is not touched here. `/api/reports/:date`
// under `mode=demo` serves the firm-wide Option-Trade Journal cell when the
// personal book is hollow for the day and the caller is an operator book —
// TRA-1572's board directive, scoped by TRA-2407. The cell it serves is
// byte-identical to `/api/reports/desk/{date}`: every demo book in the company,
// 1,602 trades in July 2026, none of them the logged-in account's.
//
// Measured on TRA-4199 (2026-08-28, live build 092d087775dc): 65% of the demo
// "My Account" July total (+$2,259.16 of +$3,488.26) and 100% of August's
// -$228.09 was that fold, rendered under a "My Account" heading with no visual
// difference from a cell the account actually traded. Single folded rows read
// +$1,298.55 (NKE, 07-02) and -$918.00 (STRC, 07-01) against a book whose
// equity is ~$2,008.
//
// ⛔ SCOPE, deliberately narrow, all three from the ticket's DO-NOT list:
//   1. No change to WHO may see the fold — that is `shouldServeFirmWideDemoFold`
//      and it stays exactly as TRA-2407 left it (default-deny).
//   2. No change to the fold's ARITHMETIC. This adds a field; it removes,
//      re-scopes and re-derives nothing. A calendar whose numbers move as part
//      of a labelling fix is unverifiable against the measurement that motivated
//      it.
//   3. No stamp on the DESK route (`/api/reports/desk*`). That view is already
//      titled "Desk" and is admin-gated; badging every cell there would train
//      the reader to ignore the badge in the one place it carries information.
//
// Pure. Reads no env, no clock, no I/O — the timestamp-free shape is what lets
// the test assert byte-equality of the stamp.

/** The one scope that exists. A second one would be a second `kind`, never a boolean. */
export const FIRM_WIDE_DEMO_FOLD_KIND = 'firm_wide_demo_desk_fold' as const;

/**
 * The grid badge. One character, same weight as the `B` / `R` / `E` measure
 * codes already in `CalendarTab.tsx` — this is a peer of those markers, not an
 * alarm. The cell is not wrong; it is just not yours.
 */
export const FIRM_WIDE_DEMO_FOLD_CODE = 'D' as const;

/** The admin route that serves these exact bytes, named so a reader can check. */
export const FIRM_WIDE_DEMO_FOLD_EQUIVALENT_ROUTE = '/api/reports/desk/{date}';

export interface FirmWideDemoFoldScope {
  kind: typeof FIRM_WIDE_DEMO_FOLD_KIND;
  code: typeof FIRM_WIDE_DEMO_FOLD_CODE;
  label: string;
  detail: string;
  tradeCount: number;
  equivalentTo: string;
}

/**
 * Build the scope stamp for one folded cell.
 *
 * `tradeCount` is the journal cell's own `totalTrades`. It is carried because
 * it is the cheapest single piece of evidence that the cell is firm-wide: a
 * personal demo book that closed 47 option trades in a day it otherwise has no
 * file for is not a thing, and a reader who sees the count next to the label
 * can tell without an API call.
 */
export function firmWideDemoFoldScope(tradeCount: number): FirmWideDemoFoldScope {
  const n = Number.isFinite(tradeCount) && tradeCount > 0 ? Math.trunc(tradeCount) : 0;
  return {
    kind: FIRM_WIDE_DEMO_FOLD_KIND,
    code: FIRM_WIDE_DEMO_FOLD_CODE,
    label: 'Desk fold — firm-wide demo, not this account',
    detail:
      `This day is the FIRM-WIDE demo Option-Trade Journal (${n} trade${n === 1 ? '' : 's'} across ` +
      'every demo book in the company), folded in because this account\'s own demo book has nothing ' +
      `for the day. It is not this account's money. The same figure is served at ` +
      `${FIRM_WIDE_DEMO_FOLD_EQUIVALENT_ROUTE} under the Desk view.`,
    tradeCount: n,
    equivalentTo: FIRM_WIDE_DEMO_FOLD_EQUIVALENT_ROUTE,
  };
}

/**
 * Stamp a folded calendar cell with {@link firmWideDemoFoldScope}.
 *
 * NON-MUTATING by contract. `demoJournalCalendarCells()` hands back cells built
 * from the shared journal aggregation, and the same object graph is reachable
 * from the Desk route; writing into it in place would leak the "not your money"
 * label onto the view where it is false. Returns a shallow copy.
 *
 * Idempotent: re-stamping an already-stamped cell yields the same object shape,
 * so a future caller cannot accumulate a second, contradicting label.
 */
export function stampFirmWideDemoFoldScope<T extends { totalTrades?: number }>(
  cell: T,
): T & { cellScope: FirmWideDemoFoldScope } {
  return { ...cell, cellScope: firmWideDemoFoldScope(cell.totalTrades ?? 0) };
}
