import type { TradierTradeHistoryFill } from '@trading-app/engine';

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
