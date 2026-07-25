import type { AccountMode } from '@trading-app/shared';
import type { PaperAccount } from './paper-account.js';
import type { PaperOptionsAccount } from './options-account.js';

/**
 * TRA-2323 — the bridge between the options ledger and the equity book.
 *
 * Parent TRA-2297 asked why the demo book "uses the same 2k everyday". The
 * answer is structural: `PaperAccount` (the dashboard's "Total Value", and the
 * figure `sizeFromStop` / `managedEquity` size off) and `PaperOptionsAccount`
 * were two disjoint ledgers seeded from the same $2,000. Realized option P&L
 * accrued in `optionsPnlByMode` and NOTHING ever moved it into equity — the only
 * place the two were ever combined was arithmetic on a *report*
 * (`combinedPnl = realized + optionsPnl`), which writes a display number and
 * never touches the book. Live on `65276dd`: admin's stock leg was 0.00 on all
 * 10 book-days since the 2026-07-12 baseline while its options leg booked
 * +$529.59, so equity sat at $2,008.29 with nothing to compound.
 *
 * Kept as its own module, rather than a closure inside `SignalEngine`, for one
 * reason: the acceptance test has to exercise the REAL binding. A test that
 * hand-wires its own sink proves the accounts *can* be connected, not that
 * production *did* connect them — and "wired in the test, unwired in prod" is
 * precisely the class of bug this ticket exists to fix.
 *
 * ## Only `demo` P&L is credited
 *
 * `mode === 'live'` P&L belongs to the real broker book (Tradier), whose truth
 * is the broker balance — `index.ts` already overrides live `combinedPnl` from
 * it (TRA-359). Crediting live option P&L into the paper `PaperAccount` would
 * invent paper equity from broker fills and double-count against that override.
 */
export function bindOptionsPnlToEquityBook(
  optionsAccount: PaperOptionsAccount,
  equityBook: PaperAccount,
): void {
  optionsAccount.setRealizedPnlSink((mode: AccountMode, delta: number) => {
    if (mode !== 'demo') return;
    equityBook.creditRealizedOptionsPnl(delta);
  });
  // TRA-2323 AC3 — the other half of the double-seed. Routing P&L into equity
  // is pointless if the options sizer keeps measuring against its OWN $2,000
  // copy: the book would grow and the tickets would not. Binding the sizing
  // basis makes `PaperAccount` the single equity authority, so option size
  // actually tracks the compounding book. The bucket keeps its own cash /
  // collateral ledger — that is a position container, not a capital claim.
  optionsAccount.setEquityBasisProvider(() => equityBook.getState().totalEquity);
}
