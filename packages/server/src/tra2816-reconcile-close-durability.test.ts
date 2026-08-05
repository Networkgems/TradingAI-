import { describe, it, expect } from 'vitest';
import { PaperOptionsAccount } from './options-account.js';
import type { OptionPosition } from '@trading-app/shared';

// ─── TRA-2816: is the reconcile close DURABLE, or re-derived on every boot? ───
//
// The ticket was filed off a measurement taken on bqb1 across the 2026-08-04
// 20:42:07Z restart:
//
//   read            uptime  open  closed  the 3 target rows
//   20:41:17Z        ~210s     5       3  closed, prefix present
//   20:42:57Z (boot)   49s     8       0  OPEN AGAIN, brokerMissingSweeps: 1
//   20:43:42Z          94s     5       3  closed again, prefix present
//
// and concluded "the reconcile-close is re-derived on every boot, not
// persisted", which reads as a durability gap in `closeBrokerFlatPosition` /
// the sweep that calls it.
//
// IT IS NOT ONE. The measurement is confounded, and the confound is named in
// this repo: `trade-store.ts` (TRA-2817) records that `/data` on bqb1 returned
// `ENOSPC` on EVERY write from 2026-07-30T23:40:19Z until the inode prune on
// 2026-08-04T21:20Z — "the TRA-2817 inode outage froze `trades-stocks.json` for
// five days". `trades-stocks.json` is the file the boot restore reads
// `openOptions` out of. The 20:42Z measurement sits ~37 minutes INSIDE that
// outage, so the box could not have persisted the close — or anything else.
// What was measured is a five-day-stale snapshot being restored, not a close
// that declines to persist.
//
// The close travels the ordinary persisted path: the sweep runs inside
// `doTick` (`signal-engine.ts`, `signal.doTick.reconcile-live-portfolio`), the
// tick handlers fire at the end of the same tick, and `user-context.ts` wires
// `engine.onTick(() => scheduleStocksPersist(ctx))` → `persistStocksNow` →
// `saveStocksTradeSnapshot`, which writes `optionsByEnv` (both `openOptions`
// and `closedOptions`) to disk.
//
// These tests pin that seam so the claim stops depending on whether anyone
// remembers the outage. They deliberately assert on `exportSnapshot()` /
// `importSnapshot()` — the exact pair `persistStocksNow` and the boot restore
// call — rather than on `getState()`, because the in-memory view is identical
// in the durable and the frozen-file worlds. That is the whole reason this
// ticket exists: the post-boot read looks the same either way.
//
// The third test is the negative control, and it is the point of the file. An
// assertion that a restored book "does not re-open the rows" passes trivially
// against a book that never had them. So the same sweep is run against a
// snapshot taken BEFORE the close — the frozen-file case — and it MUST
// re-open all three and re-derive. That is what was measured on 08-04, and it
// pins the reappearance as a function of snapshot STALENESS, which the sweep
// cannot fix, rather than of the close path, which is where the ticket looked.

/** The three rows from the ticket, as engine-opened LIVE rows. */
const TARGETS: ReadonlyArray<Partial<OptionPosition>> = [
  { id: 'opt-spy-820c', symbol: 'SPY', optionSymbol: 'SPY260904C00820000', optionType: 'call', strike: 820, contracts: 2, contractsRemaining: 2, premiumPaid: 0.065, currentPremium: 0.075 },
  { id: 'opt-spy-816c', symbol: 'SPY', optionSymbol: 'SPY260904C00816000', optionType: 'call', strike: 816, contracts: 4, contractsRemaining: 4, premiumPaid: 0.075, currentPremium: 0.095 },
  { id: 'opt-aapl-280p', symbol: 'AAPL', optionSymbol: 'AAPL260904P00280000', optionType: 'put', strike: 280, contracts: 4, contractsRemaining: 4, premiumPaid: 0.995, currentPremium: 0.965 },
];

/** Well past `BROKER_MISSING_MIN_AGE_MS` (5 min) under the real clock. */
const AGED = Date.parse('2026-08-04T13:42:00Z');

function engineRow(o: Partial<OptionPosition>): OptionPosition {
  return {
    expiration: '2026-09-04',
    tp1Premium: Number.POSITIVE_INFINITY,
    tp1Hit: false,
    stopLossPremium: 0,
    peakPremium: o.currentPremium ?? 0,
    trailingActive: true,
    trailingStopPremium: 0,
    underlyingEntryPrice: 0,
    openedAt: AGED,
    signalId: `sig-${o.id}`,
    signalType: 'otm_mispricing',
    mode: 'live',
    tradierEnv: 'production',
    ...o,
  } as OptionPosition;
}

/** A boot: build a book and restore `snap` into it, exactly as `initUserContext` does. */
function bootFrom(snap: ReturnType<PaperOptionsAccount['exportSnapshot']>): PaperOptionsAccount {
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
  acct.importSnapshot(snap);
  return acct;
}

/** The book as it stood with the three rows still open — the pre-close snapshot. */
function strandedSnapshot(): ReturnType<PaperOptionsAccount['exportSnapshot']> {
  const acct = new PaperOptionsAccount({ initialEquity: 25_000, tradierEnv: 'production' });
  acct.importSnapshot({
    openOptions: TARGETS.map(engineRow),
    closedOptions: [],
    optionsPnl: 0,
    optionsPnlByMode: { demo: 0, live: 0 },
    dailyCount: 3,
    currentDayKey: '2026-08-04',
    cash: 20_000,
    equity: 25_000,
  });
  return acct.exportSnapshot();
}

/** Two consecutive empty sweeps — the broker reports nothing, twice. */
function sweepTwice(acct: PaperOptionsAccount): { first: number; second: number } {
  const first = acct.reconcileTradierPositions([], 'live').removed;
  const second = acct.reconcileTradierPositions([], 'live').removed;
  return { first, second };
}

const symbolsOf = (rows: readonly OptionPosition[]): string[] =>
  rows.map(r => r.optionSymbol ?? '').sort();

const TARGET_SYMBOLS = symbolsOf(TARGETS.map(engineRow));

describe('TRA-2816 — the reconcile close survives the persist/restore seam', () => {
  it('writes the close into `exportSnapshot()`, which is what `persistStocksNow` persists', () => {
    const acct = bootFrom(strandedSnapshot());
    const { first, second } = sweepTwice(acct);

    // One blank payload is not proof; the second sweep is the close.
    expect(first).toBe(0);
    expect(second).toBe(3);

    // THE SEAM. `persistStocksNow` writes `exportSnapshot()`, not `getState()`.
    const snap = acct.exportSnapshot();
    expect(symbolsOf(snap.openOptions)).not.toEqual(expect.arrayContaining(TARGET_SYMBOLS));
    expect(snap.openOptions).toHaveLength(0);
    expect(symbolsOf(snap.closedOptions)).toEqual(TARGET_SYMBOLS);
    for (const row of snap.closedOptions) {
      expect(row.exitErrorReason).toMatch(/^Closed by Tradier reconcile:/);
    }
  });

  it('a boot restored from that snapshot never shows the rows as open — not for one sweep', () => {
    const closed = bootFrom(strandedSnapshot());
    sweepTwice(closed);
    const persisted = closed.exportSnapshot();

    // The restart. This is acceptance #2: the rows must not appear as open at
    // ANY point, so the assertion is made BEFORE the first post-boot sweep —
    // the 49s-uptime read that saw all three back on the Open Options table.
    const rebooted = bootFrom(persisted);
    expect(rebooted.getStateForMode('live').openOptions).toHaveLength(0);
    expect(symbolsOf(rebooted.getStateForMode('live').closedOptions)).toEqual(TARGET_SYMBOLS);

    // And the sweep has nothing left to re-derive, so nothing is booked twice.
    const { first, second } = sweepTwice(rebooted);
    expect(first).toBe(0);
    expect(second).toBe(0);
    expect(rebooted.getStateForMode('live').openOptions).toHaveLength(0);
    expect(symbolsOf(rebooted.exportSnapshot().closedOptions)).toEqual(TARGET_SYMBOLS);
  });

  // ─── The negative control. Without it the test above is a tautology. ───
  it('a boot restored from a STALE snapshot does re-open all three — the 08-04 measurement', () => {
    // The TRA-2817 world: the close happened in memory, `/data` refused the
    // write, so the file the boot reads is the one written before it.
    const stale = strandedSnapshot();

    const rebooted = bootFrom(stale);
    // 49s uptime: three phantom rows, visible on the LIVE book with an armed
    // trailing stop. Exactly what the reporter saw, and what a user loading the
    // page inside the window still sees.
    expect(symbolsOf(rebooted.getStateForMode('live').openOptions)).toEqual(TARGET_SYMBOLS);
    for (const row of rebooted.getStateForMode('live').openOptions) {
      expect(row.brokerMissingSweeps).toBeUndefined();
    }

    // ~30s: the counter arms but the row stays. ~60-90s: the second sweep closes.
    expect(rebooted.reconcileTradierPositions([], 'live').removed).toBe(0);
    for (const row of rebooted.getStateForMode('live').openOptions) {
      expect(row.brokerMissingSweeps).toBe(1);
    }
    expect(rebooted.reconcileTradierPositions([], 'live').removed).toBe(3);
    expect(rebooted.getStateForMode('live').openOptions).toHaveLength(0);
  });

  it('re-derivation is idempotent — the stale path lands on the same book, not double it', () => {
    // The ticket measured `optionsPnl` at −2.00 ONCE after the rows closed
    // twice in three minutes, not −4.00, and called it "no double-count". That
    // holds for a reason worth pinning: the stale restore rewinds cash and the
    // realized buckets along with the rows, so re-deriving replays the same
    // close over the same starting book rather than applying it a second time.
    const durable = bootFrom(strandedSnapshot());
    sweepTwice(durable);
    const acrossDurableBoot = bootFrom(durable.exportSnapshot());

    const acrossStaleBoot = bootFrom(strandedSnapshot());
    sweepTwice(acrossStaleBoot);

    for (const book of [acrossDurableBoot, acrossStaleBoot]) {
      // TRA-2801 books the reconcile close at break-even: $0 realized, and the
      // refund is exactly the premium the open debited — `premiumPaid ×
      // remaining × 100`, i.e. 0.065×2×100 + 0.075×4×100 + 0.995×4×100 = $441
      // on a starting 20_000.
      expect(book.getStateForMode('live').optionsPnl).toBeCloseTo(0, 5);
      expect(book.getStateForMode('live').optionsCash).toBeCloseTo(20_000 + 441, 5);
      expect(book.getStateForMode('live').openOptions).toHaveLength(0);
    }
  });
});
