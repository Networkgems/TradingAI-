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
