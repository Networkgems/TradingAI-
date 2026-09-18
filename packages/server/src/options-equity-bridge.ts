import type { AccountMode } from '@trading-app/shared';
import type { PaperAccount } from './paper-account.js';
import type { PaperOptionsAccount } from './options-account.js';
import { recordHardControlsPnl } from './hard-controls.js';

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
 *
 * ## TRA-2885 — this filter is the SOLE gate, and it is where the live question lives
 *
 * As of TRA-2885 every realized-P&L accrual in `PaperOptionsAccount` — engine
 * closes, the demo combo settle, the imported-fill realtime estimate, and the EOD
 * Tradier restatement — routes through `bookRealizedPnl`, so every one of them
 * offers its delta to the sink below. The `mode !== 'demo'` line is therefore the
 * one and only place live realized P&L is refused entry to the sizing book.
 *
 * That matters because TRA-2801 (and TRA-2885's own description) recorded the
 * opposite diagnosis: that `addReconciledTradierPnl`'s bare `optionsPnlByMode.live
 * +=` was why EOD broker truth could never restate sizing equity, and that routing
 * it through the choke point would change live buying-power behaviour. It would
 * not, and it did not — the credit was always dropped here. Routing the three
 * dot-form accruals moved $0 on the live book.
 *
 * So "estimate now, restate later" for the LIVE sizing book is a decision about
 * THIS LINE, not about any call site. Whoever reopens it owns the double-count
 * against the TRA-359 override (gated on `settings.mode === 'live'` regardless of
 * Tradier env — see `equity-backfill-credit.ts`'s header for why the env is the
 * wrong discriminator), and owns it for the WHOLE live book at once, since all
 * four accrual paths now arrive here together.
 */
export function bindOptionsPnlToEquityBook(
  optionsAccount: PaperOptionsAccount,
  equityBook: PaperAccount,
): void {
  optionsAccount.setRealizedPnlSink((mode: AccountMode, delta: number) => {
    // TRA-4650 — control 2's feed (the TRA-4655 $500 daily-loss lockout).
    // This sink is already the one seam every realized-P&L accrual in
    // `PaperOptionsAccount` reaches (see the TRA-2885 note above), so the
    // lockout is fed HERE rather than at any of the four accrual call sites.
    // Live P&L still never touches the paper sizing book (the refusal below
    // stands); it now also latches the fleet-wide lockout. A NON-FINITE delta
    // deliberately flows through — `recordHardControlsPnl` latches the day
    // unreadable on it, which refuses all opens (fail closed). Best-effort
    // wrap: a hard-controls persistence throw must never reach the booking
    // path that offered the delta.
    if (mode === 'live') {
      try {
        recordHardControlsPnl(delta);
      } catch {
        // recordHardControlsPnl persists fail-soft itself; this guard is for
        // anything unexpected above that. The booking path must not die here.
      }
      return;
    }
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
