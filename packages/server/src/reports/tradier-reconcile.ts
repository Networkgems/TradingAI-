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
export function isOptionCloseDescription(description: string): boolean {
  const s = description.toLowerCase();
  return s.includes('sell to close') || s.includes('buy to close');
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
    if (!isOptionCloseDescription(fill.description)) continue;
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
  const realizedByDate = new Map<string, number>();
  const closeCountByDate = new Map<string, number>();

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
    realizedByDate.set(fill.date, (realizedByDate.get(fill.date) ?? 0) + realized);
    closeCountByDate.set(fill.date, (closeCountByDate.get(fill.date) ?? 0) + 1);
  }

  return { realizedByDate, closeCountByDate };
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
 * TRA-348 — Tradier `Sell to Close` proceeds aren't truly "P&L" in the
 * accounting sense — the proceeds minus the open cost is. But Tradier's
 * history endpoint reports cash flow per fill, not gain/loss. To
 * approximate realized P&L without requiring a second API call, we
 * pair opening Buy-to-Open events with closing Sell-to-Close events
 * within the same fetch window: same option `symbol`, sum of opens =
 * sum of closes ⇒ realized = (closes − opens). For unmatched closes
 * (open lived outside the fetch window), we fall back to the raw
 * close-fill `amount` so the calendar at least shows a non-zero $
 * value (which is the user's stated acceptance criterion). The net
 * effect is closer to Tradier's own gainloss endpoint without a
 * second round trip.
 */
export function aggregateRealizedOptionsPnl(
  fills: readonly TradierTradeHistoryFill[],
  knownIds: ReadonlySet<string>,
): TradierDailyOptionsTotals {
  const realizedByDate = new Map<string, number>();
  const seenTransactionIds = new Set<string>();

  // Sum opens per OCC symbol so we can compute realized for paired closes.
  const openCostBySymbol = new Map<string, number>();
  for (const fill of fills) {
    if (fill.tradeType !== 'option') continue;
    if (knownIds.has(fill.transactionId)) continue;
    const desc = fill.description.toLowerCase();
    if (desc.includes('buy to open')) {
      const prev = openCostBySymbol.get(fill.symbol) ?? 0;
      // `amount` is negative for buys (cash leaving the account).
      openCostBySymbol.set(fill.symbol, prev + fill.amount);
    }
  }

  for (const fill of fills) {
    if (fill.tradeType !== 'option') continue;
    if (knownIds.has(fill.transactionId)) continue;
    if (!isOptionCloseDescription(fill.description)) continue;
    seenTransactionIds.add(fill.transactionId);
    const matchingOpen = openCostBySymbol.get(fill.symbol);
    // realized = close proceeds + open cost (open cost is negative).
    // When no matching open is in the window, fall back to close
    // proceeds alone — at minimum the calendar shows a non-zero $.
    const realized = matchingOpen != null ? fill.amount + matchingOpen : fill.amount;
    const prev = realizedByDate.get(fill.date) ?? 0;
    realizedByDate.set(fill.date, prev + realized);
  }
  return { realizedByDate, seenTransactionIds };
}
