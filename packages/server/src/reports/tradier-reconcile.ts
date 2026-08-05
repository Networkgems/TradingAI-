import type { TradierCashEvent, TradierTradeHistoryFill } from '@trading-app/engine';

/**
 * TRA-348 — distinguishing closing fills from opening fills based on
 * Tradier's `description` field. Opens are `Buy to Open` (long) /
 * `Sell to Open` (short); closes are `Sell to Close` (long) /
 * `Buy to Close` (short). Equity has no open/close distinction in the
 * description — `Buy ...` for shares opens; `Sell ...` against a tracked
 * position closes. We aggregate option closes only by default; equity is
 * out of scope for this issue (the live equity manual-close path lives
 * behind a separate ticket).
 */
/**
 * TRA-2864 — `amount` is now part of the signature because on the LIVE
 * production account the description alone cannot answer the question.
 *
 * Tradier's production history endpoint returns an INSTRUMENT-ONLY description
 * — `"AMZN Sep 4, 2026 $295.00 Call"` — with no action prefix at all. Across the
 * board's uploaded live-production activity export (89 trade events, 38 of them
 * real option closes) the keyword test below matched **zero** rows. Every
 * consumer that gated on it therefore saw an empty tape and could not tell that
 * apart from "the account did not trade" — the failure is silent and reads
 * exactly like a quiet book.
 *
 * This is the same defect TRA-2810 already fixed one layer over, in
 * `historyFillSide`; the rule is copied from there deliberately so the two
 * cannot drift: keywords are authoritative when present, otherwise the sign of
 * the net cash flow decides (a long open debits, a long close credits). An
 * `amount` of exactly 0 is ambiguous and stays `false`.
 *
 * Called with one argument the behaviour is unchanged (keyword-only), so the
 * sandbox/legacy descriptions that DO carry "Sell to Close" still work.
 */
export function isOptionCloseDescription(description: string, amount?: number): boolean {
  const s = description.toLowerCase();
  if (s.includes('sell to close') || s.includes('buy to close')) return true;
  if (s.includes('buy to open') || s.includes('sell to open')) return false;
  if (typeof amount === 'number' && Number.isFinite(amount) && amount !== 0) {
    return amount > 0; // cash IN = a close
  }
  return false;
}

export interface TradierDailyOptionsTotals {
  /** `YYYY-MM-DD` → realized options P&L from Tradier closes that day. */
  realizedByDate: Map<string, number>;
  /** Set of seen transaction ids — feeds the per-user cursor file. */
  seenTransactionIds: Set<string>;
}

/**
 * TRA-348 — aggregate Tradier closing fills into per-day realized
 * options P&L, skipping any transaction whose id is already in
 * `knownIds`. Realized P&L for a Sell-to-Close fill is the net cash
 * Tradier reports for the event (`amount` − `commission`); for a
 * Buy-to-Close (short option leg the user opened on Tradier directly,
 * not currently exposed in TradeAI's UI) we negate so the close shows
 * as a P&L *event* not a buy. Returns the computed totals plus the
 * set of newly-seen transaction ids so the caller can update the
 * cursor file.
 *
 * NOTE: Tradier's history `amount` already nets commissions, so the
 * subtraction here is a defensive guard against a future field-shape
 * change rather than current double-counting. The dedup-on-`id` keeps
 * a re-fetch over the same window from inflating the totals.
 */
export function aggregateOptionCloses(
  fills: readonly TradierTradeHistoryFill[],
  knownIds: ReadonlySet<string>,
): TradierDailyOptionsTotals {
  const realizedByDate = new Map<string, number>();
  const seenTransactionIds = new Set<string>();
  for (const fill of fills) {
    if (fill.tradeType !== 'option') continue;
    // TRA-2864 — pass `amount` so a production instrument-only description
    // still resolves a side. Without it this filter matches nothing on the
    // live account and the empty result reads as "no trading".
    if (!isOptionCloseDescription(fill.description, fill.amount)) continue;
    if (knownIds.has(fill.transactionId)) continue;
    seenTransactionIds.add(fill.transactionId);
    const realized = fill.amount; // Tradier's `amount` already nets commission.
    const prev = realizedByDate.get(fill.date) ?? 0;
    realizedByDate.set(fill.date, prev + realized);
  }
  return { realizedByDate, seenTransactionIds };
}

export interface RealizedBackfillTotals {
  /** `YYYY-MM-DD` (close date) → realized options P&L for closes that day. */
  realizedByDate: Map<string, number>;
  /** `YYYY-MM-DD` (close date) → number of closing fills booked that day. */
  closeCountByDate: Map<string, number>;
}

/**
 * TRA-244 — broker-truth realized options P&L per close date, reconstructed
 * from the Tradier trade-history fills by FIFO-matching each long close
 * (cash IN, `amount > 0`) against the earliest unconsumed open (cash OUT,
 * `amount < 0`) of the SAME OCC `symbol`.
 *
 * Open vs close is keyed off the sign of `amount`, NOT the `description`
 * string: Tradier's history endpoint labels the same leg inconsistently
 * ("Buy to Open" vs "UNSOLICITED, OPEN CONTRACT"), but a long open always
 * debits cash and a long close always credits it. These live accounts trade
 * long calls/puts only, so the sign convention is unambiguous.
 *
 * Unlike {@link aggregateRealizedOptionsPnl} (the live-reconcile path), this
 * is *strict*: a closing fill with no matching open inside the window is
 * skipped, NOT booked at gross proceeds. The gross-proceeds fallback is the
 * exact bug that produced the bogus June Live calendar cells (a close of an
 * imported position booked its whole proceeds as a "win"). For a one-shot
 * historical backfill we'd rather under-report an un-reconstructable day as
 * flat ($0) than re-introduce a phantom green day. Realized is attributed to
 * the *close* date, and `amount` is Tradier's net cash for the leg (already
 * nets commission), so per matched contract:
 *
 *   realized = (close proceeds / closeQty) − (open cost / openQty)
 *
 * summed over the matched quantity.
 */
export function realizedOptionsPnlByCloseDate(
  fills: readonly TradierTradeHistoryFill[],
): RealizedBackfillTotals {
  const { realizedByDate, closeCountByDate } = fifoRealizedOptionCloses(fills);
  return { realizedByDate, closeCountByDate };
}

/** Outcome of one FIFO pass over a window of option fills. */
interface FifoRealizedResult {
  /** `YYYY-MM-DD` (close date) → realized P&L ATTRIBUTED this pass. */
  realizedByDate: Map<string, number>;
  /** `YYYY-MM-DD` (close date) → number of closing fills attributed this pass. */
  closeCountByDate: Map<string, number>;
  /** Transaction ids of the closes actually attributed (matched, not skipped). */
  attributedCloseIds: Set<string>;
}

/**
 * TRA-2864 — the ONE FIFO matcher, shared by the historical backfill
 * ({@link realizedOptionsPnlByCloseDate}) and the go-forward live reconcile
 * ({@link aggregateRealizedOptionsPnl}).
 *
 * These two used to be separate implementations of the same idea, and they
 * disagreed by $746.75 over the board's uploaded live-production tape — the
 * backfill matched Tradier's own gain/loss report to the cent while the
 * reconcile path was off by −$448.84 on a single day (2026-07-31: real
 * +$713.73, computed +$264.89). Two implementations of one rule is the defect;
 * one implementation with two entry points is the fix.
 *
 * Rules, in the order they bite:
 *
 *  • **Side comes from the sign of `amount`, never the description.** Tradier
 *    production descriptions are instrument-only (see
 *    {@link isOptionCloseDescription}). A long open debits cash, a long close
 *    credits it. These live sleeves are long calls/puts only, so the sign is
 *    unambiguous.
 *  • **Per-contract FIFO, not per-symbol netting.** The old reconcile summed
 *    EVERY open of a symbol into one bucket and subtracted that whole bucket
 *    from EACH close of it, so a position opened once and closed in two fills
 *    paid its cost basis twice. Real case on the tape:
 *    `SPY260904C00816000` opened 4 @ −$32.42, closed 3 (+$35.66) then 1
 *    (+$11.87) — truth +$15.11, old code −$17.31.
 *  • **No gross-proceeds fallback.** A close whose open is outside the window
 *    is SKIPPED, not booked at its full proceeds. That fallback is what
 *    manufactured the original phantom-green June calendar (TRA-359's own
 *    docblock calls it "structurally wrong"), and it is still doing it: on this
 *    tape it invents +$165.75 on 2026-05-27 and +$16.35 on 2026-05-20, two days
 *    whose opens simply predate the export. Under-reporting an
 *    un-reconstructable day as flat is the lesser error, and — because an
 *    unattributed close is never added to `attributedCloseIds` — it stays
 *    retryable on a later, wider pass instead of being cursored away wrong.
 *
 * `skipCloseIds` is the dedup cursor. A close already in it is NOT attributed
 * again, but it still CONSUMES its lots: the lot book has to reflect every
 * close that really happened or the next close would be matched against a
 * basis that was already sold.
 */
function fifoRealizedOptionCloses(
  fills: readonly TradierTradeHistoryFill[],
  skipCloseIds: ReadonlySet<string> = new Set<string>(),
): FifoRealizedResult {
  const realizedByDate = new Map<string, number>();
  const closeCountByDate = new Map<string, number>();
  const attributedCloseIds = new Set<string>();

  // Process opens before closes within the same date so a same-day round
  // trip matches; otherwise sort by date ascending (Tradier returns newest
  // first). `quantity` is already absolute in the parsed fill.
  const ordered = [...fills]
    .filter(f => f.tradeType === 'option')
    .sort((a, b) => {
      if (a.date !== b.date) return a.date < b.date ? -1 : 1;
      const ao = a.amount < 0 ? 0 : 1; // opens (cash out) before closes
      const bo = b.amount < 0 ? 0 : 1;
      return ao - bo;
    });

  // Per-symbol FIFO queue of open long lots: cost is positive $/contract.
  const openLots = new Map<string, Array<{ qty: number; costPerContract: number }>>();

  for (const fill of ordered) {
    if (fill.quantity <= 0 || fill.amount === 0) continue;
    if (fill.amount < 0) {
      // Long open: `amount` is negative — store cost as a positive number.
      // NOTE: opens are cost basis, not output, so the dedup cursor must NOT
      // filter them. Dropping a "seen" open would strand its close unmatched.
      const costPerContract = Math.abs(fill.amount) / fill.quantity;
      const queue = openLots.get(fill.symbol) ?? [];
      queue.push({ qty: fill.quantity, costPerContract });
      openLots.set(fill.symbol, queue);
      continue;
    }

    // Long close: cash IN. FIFO-match against this symbol's open lots.
    const queue = openLots.get(fill.symbol) ?? [];
    const proceedsPerContract = fill.amount / fill.quantity; // positive for a sell
    let remaining = fill.quantity;
    let realized = 0;
    let matchedAny = false;
    while (remaining > 0 && queue.length > 0) {
      const lot = queue[0];
      const take = Math.min(remaining, lot.qty);
      realized += take * (proceedsPerContract - lot.costPerContract);
      lot.qty -= take;
      remaining -= take;
      matchedAny = true;
      if (lot.qty <= 0) queue.shift();
    }
    // Unmatched portion (open outside the window): skip rather than book
    // gross proceeds. If nothing matched at all, the day stays flat.
    if (!matchedAny) continue;
    // Lots are consumed above whether or not we attribute — a close that
    // already went into the cursor still really sold that basis.
    if (skipCloseIds.has(fill.transactionId)) continue;
    attributedCloseIds.add(fill.transactionId);
    realizedByDate.set(fill.date, (realizedByDate.get(fill.date) ?? 0) + realized);
    closeCountByDate.set(fill.date, (closeCountByDate.get(fill.date) ?? 0) + 1);
  }

  return { realizedByDate, closeCountByDate, attributedCloseIds };
}

/**
 * TRA-359 — per-day net cash flow into the Tradier account from
 * non-trade events (ACH / wire / journal / deposit / withdrawal /
 * dividend / interest / fee / adjustment). Used by the Live calendar
 * reconcile pass to subtract real deposits from the daily balance
 * delta so a $500 deposit doesn't show up as a $500 trading "win."
 */
export interface TradierDailyCashFlowTotals {
  /** `YYYY-MM-DD` → signed net cash flow that day (deposits + dividends − withdrawals − fees). */
  netByDate: Map<string, number>;
  /** Set of seen transaction ids — feeds the per-user cash-flow cursor. */
  seenTransactionIds: Set<string>;
}

/**
 * TRA-359 — aggregate Tradier non-trade events into per-day signed cash
 * flow, skipping any transaction whose id is already in `knownIds`.
 *
 * Tradier's `amount` is already signed (positive for deposits / dividends
 * / credits, negative for withdrawals / fees / debits) so we just sum
 * per date. The dedup-on-`id` keeps a re-fetch over the same window
 * from inflating the totals on the next reconcile tick.
 */
export function aggregateCashFlowByDate(
  events: readonly TradierCashEvent[],
  knownIds: ReadonlySet<string>,
): TradierDailyCashFlowTotals {
  const netByDate = new Map<string, number>();
  const seenTransactionIds = new Set<string>();
  for (const ev of events) {
    if (knownIds.has(ev.transactionId)) continue;
    seenTransactionIds.add(ev.transactionId);
    const prev = netByDate.get(ev.date) ?? 0;
    netByDate.set(ev.date, prev + ev.amount);
  }
  return { netByDate, seenTransactionIds };
}

/**
 * TRA-1192 — compute the rolling write/fetch window for the historical
 * Live-calendar realized-P&L backfill. The write window spans the first of the
 * month `monthsBack` months before `today` up to (but excluding) `today` —
 * today is owned by the live-intraday cell + the 9 PM EOD snapshot, never the
 * backfill. The fetch window starts `fetchLookbackDays` earlier so opens that
 * pair with in-window closes are captured for FIFO matching.
 *
 * Replaces the original hardcoded `2026-06-01..2026-06-10` constants so a
 * NEW live account opened mid-month still gets its earlier days reconstructed
 * from broker fills, not just the days after its 9 PM snapshot first ran.
 *
 * @param today  ET calendar date `YYYY-MM-DD` (exclusive upper bound).
 */
export function liveBackfillWriteWindow(
  today: string,
  monthsBack: number,
  fetchLookbackDays: number,
): { writeStart: string; fetchStart: string; end: string } {
  const [ty, tm] = today.split('-').map(Number); // tm is 1-based
  // monthIndex for this month is tm-1; go `monthsBack` months earlier.
  // Date.UTC normalises a negative month index across the year boundary.
  const writeStartDate = new Date(Date.UTC(ty, tm - 1 - monthsBack, 1));
  const writeStart = writeStartDate.toISOString().slice(0, 10);
  const fetchStart = new Date(
    writeStartDate.getTime() - fetchLookbackDays * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return { writeStart, fetchStart, end: today };
}

/**
 * TRA-359 — return the most recent balance snapshot strictly earlier
 * than `targetDate` (`YYYY-MM-DD`). Markets close Sat/Sun and holidays
 * so "yesterday" may be 1–3 calendar days back; we walk through the
 * snapshots map and pick the date closest to (but before) the target.
 * Returns `null` when no prior anchor exists — caller falls back to
 * engine-computed P&L for that single day.
 */
export function findPreviousBalanceSnapshot(
  snapshots: Readonly<Record<string, number>>,
  targetDate: string,
): { date: string; balance: number } | null {
  let bestDate: string | null = null;
  for (const date of Object.keys(snapshots)) {
    if (date >= targetDate) continue;
    if (bestDate === null || date > bestDate) bestDate = date;
  }
  if (bestDate === null) return null;
  return { date: bestDate, balance: snapshots[bestDate] };
}

/**
 * TRA-359 — compute Tradier-truth daily P&L from the broker's reported
 * balance series and persisted cash flow. The Live calendar overrides
 * `combinedPnl` to this value so the per-day cell mirrors what the user
 * sees on the Tradier dashboard.
 *
 * Returns `null` when we don't have enough history yet (either today's
 * balance is missing or there is no previous-day anchor). The caller
 * should fall back to the engine-computed `combinedPnl` rather than
 * write a 0 that could be mistaken for a real flat day.
 *
 * `prevBalance` is the most recent balance snapshot earlier than
 * `todayDate` (not necessarily yesterday — markets are closed on
 * weekends / holidays so the prior snapshot can be 1–3 calendar days
 * old). `netCashFlow` is the net deposit (positive) or withdrawal
 * (negative) recorded against `todayDate` across all events; subtract
 * it from the balance delta so cash movements aren't booked as P&L.
 */
export function computeBalanceDailyPnl(
  todayBalance: number | null | undefined,
  prevBalance: number | null | undefined,
  netCashFlow: number,
): number | null {
  if (typeof todayBalance !== 'number' || !Number.isFinite(todayBalance)) return null;
  if (typeof prevBalance !== 'number' || !Number.isFinite(prevBalance)) return null;
  const cashFlow = Number.isFinite(netCashFlow) ? netCashFlow : 0;
  return todayBalance - prevBalance - cashFlow;
}

/**
 * TRA-2801 RESIDUAL B — what the EOD reconcile is allowed to do this pass.
 *
 * `reconcileTradierOptionsHistory` used to early-return on `fills.length === 0`
 * and again on `seenTransactionIds.size === 0`, both BEFORE draining the realtime
 * estimate map via `consumeRealtimeImportedPnl()`. So the drain could not run in
 * exactly the case where a booked estimate is most wrong: the contract never
 * really filled at the broker, so the history window is empty and there is no
 * row to restate against. A drain gated on there being something to reconcile
 * cannot correct an estimate whose whole problem is that there is nothing to
 * reconcile against.
 *
 * Splitting the decision in two makes the rule explicit and testable:
 *   • `drainRealtime` — drain and apply `netAdded = added − offset` on EVERY
 *     SUCCESSFUL FETCH, empty window included. With `added = 0` that is
 *     `−offset`: an unmatched estimate goes back to $0, which is the correct
 *     resting value. If the fill is merely late, the next pass sees it with an
 *     empty offset and adds broker truth on top of $0 — same landing place.
 *   • `persistFills` — the sidecar and cursor writes, which genuinely have no
 *     work when no NEW transaction id was seen.
 *
 * A FAILED fetch drains NOTHING. It is BLIND, not empty, and the drain is
 * destructive (it clears the map). That distinction is the whole reason this is a
 * function and not a pair of `if`s: `fetchSucceeded === false` is the one input
 * for which `drainRealtime` is false.
 */
export interface TradierReconcilePlan {
  drainRealtime: boolean;
  persistFills: boolean;
}

export function planTradierReconcile(input: {
  fetchSucceeded: boolean;
  fillsInWindow: number;
  newTransactionIds: number;
}): TradierReconcilePlan {
  if (!input.fetchSucceeded) return { drainRealtime: false, persistFills: false };
  return { drainRealtime: true, persistFills: input.newTransactionIds > 0 };
}

/**
 * TRA-348 / TRA-2864 — realized options P&L per day for the go-forward live
 * reconcile pass, FIFO-matched against the opens in the same fetch window.
 *
 * This is now a thin wrapper over {@link fifoRealizedOptionCloses}, the same
 * matcher the historical backfill uses. Read that docblock for why: the two
 * paths previously implemented the same rule twice and disagreed, and the
 * reconcile copy was the wrong one on all three counts (description-gated side
 * detection that matches nothing in production, per-symbol netting that
 * double-charges a partial close, and a gross-proceeds fallback that invents
 * green days). Measured against the board's uploaded live-production tape it
 * booked −$1,018.94 where Tradier's own gain/loss report says −$272.19.
 *
 * `knownIds` remains the dedup cursor over CLOSES — a close already merged on a
 * previous pass is not counted again. Opens are never cursored: they are cost
 * basis, and the caller's rolling window re-reads them every pass.
 *
 * A close that cannot be matched to an open is deliberately NOT emitted, so it
 * also does not enter `seenTransactionIds` — the caller will not cursor it, and
 * a later pass whose window does reach the open will pick it up.
 */
export function aggregateRealizedOptionsPnl(
  fills: readonly TradierTradeHistoryFill[],
  knownIds: ReadonlySet<string>,
): TradierDailyOptionsTotals {
  const { realizedByDate, attributedCloseIds } = fifoRealizedOptionCloses(fills, knownIds);
  return { realizedByDate, seenTransactionIds: attributedCloseIds };
}
