import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  TRADIER_REJECTED_STATUSES,
  TRADIER_TERMINAL_STATUSES,
  roundToCent,
} from '@trading-app/engine';

/**
 * TRA-352 — outcome of {@link submitSmartSellToClose}. The HTTP close handler
 * branches on `status`:
 *  - `filled` → the local row closes at `avgFillPrice` (paper cash credited
 *    with the broker's actual fill, not the local mark).
 *  - `rejected` → the local row stays, the user sees `reason` in the UI,
 *    response is 502.
 *  - `pending` → the local row stays, `orderId` is stamped as
 *    `pendingCloseOrderId` so the dashboard renders "Pending #N" and a
 *    follow-up reconcile will finalize once Tradier reaches a terminal state.
 *  - `no_quote` → we couldn't read a usable bid/ask/last from Tradier for
 *    this OCC; we refuse to submit a market order against a dead contract
 *    (the whole point of the smart-pricing layer is to avoid filling at $0
 *    or a wide-spread bid). Response is 409.
 */
export type SmartSellOutcome =
  | { status: 'filled'; orderId: number; avgFillPrice: number; limitPrice: number }
  | { status: 'rejected'; orderId?: number; reason: string }
  | { status: 'pending'; orderId: number; limitPrice: number }
  | { status: 'no_quote'; reason: string };

export interface SmartSellOptions {
  /** TRA-352 — wait window per attempt (defaults to 5s to match TRA-348). */
  timeoutMs?: number;
  /** Bounded walk: 1 = mid only, 2 = mid then quarter-step toward bid, etc. */
  maxAttempts?: number;
  /** Injectable for tests so we don't need real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * TRA-352 — close-side limit walk for a long option contract. Pulls a fresh
 * `bid`/`ask` from Tradier, computes a midpoint, and submits a limit
 * `sell_to_close`. If Tradier doesn't take the order to a terminal state
 * inside the wait window, we cancel and resubmit a quarter-step toward the
 * bid (the wider the spread, the more aggressive the second step is). After
 * `maxAttempts` (default 2) we give up and return `pending` so the caller can
 * stamp the local row with the open order id and surface "Pending #N" in the
 * UI.
 *
 * Why limit instead of market: the user's report on the parent ticket (and
 * TRA-348 follow-up) was that the previous market `sell_to_close` was filling
 * at the bid on wide-spread contracts (bid 0.05 / ask 0.17 → broker fills at
 * 0.05). A limit at the mid (0.11) gives the user a fair shot at the
 * midpoint and falls back toward the bid only when the market doesn't meet
 * us there. Reference: `packages/engine/src/tradier/options-client.ts:476`
 * (legacy market `sellContracts`, kept around for non-close call-sites).
 *
 * Returns the outcome the HTTP close handler can pattern-match on. The
 * caller is responsible for cleaning up any in-flight order on its own side
 * (we already cancel between attempts, but a `pending` outcome leaves the
 * last attempt live on Tradier because the user wants the close to keep
 * working once they walk away from the screen).
 */
export async function submitSmartSellToClose(
  client: Pick<TradierOptionsClient, 'getOptionQuote' | 'sellContractsLimit' | 'cancelOrder' | 'waitForOrderTerminalStatus'>,
  optionSymbol: string,
  qty: number,
  options: SmartSellOptions = {},
): Promise<SmartSellOutcome> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));

  let quote: TradierOptionQuote | null = null;
  try {
    quote = await client.getOptionQuote(optionSymbol);
  } catch (err: unknown) {
    return {
      status: 'no_quote',
      reason: `Tradier quote lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const limitPath = derivePricingPath(quote);
  if (limitPath.kind === 'none') {
    return {
      status: 'no_quote',
      reason: 'No quote available — close this contract manually on Tradier.',
    };
  }

  let lastDetail: TradierOrderDetail | null = null;
  let lastOrderId: number | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const limitPrice = roundToCent(priceForAttempt(limitPath, attempt));
    // Tradier rejects limit prices ≤ 0 on equity options; bail with no_quote
    // instead of submitting a doomed order.
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      return {
        status: 'no_quote',
        reason: 'No quote available — close this contract manually on Tradier.',
      };
    }

    let order;
    try {
      order = await client.sellContractsLimit(optionSymbol, qty, limitPrice);
    } catch (err: unknown) {
      return {
        status: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        ...(lastOrderId !== undefined ? { orderId: lastOrderId } : {}),
      };
    }
    lastOrderId = order.id;
    const detail = await client.waitForOrderTerminalStatus(order.id, { timeoutMs, sleep });
    lastDetail = detail;
    const status = detail?.status ?? '';
    if (status === 'filled') {
      const avgFill = detail?.avg_fill_price;
      return {
        status: 'filled',
        orderId: order.id,
        avgFillPrice: typeof avgFill === 'number' && Number.isFinite(avgFill) ? avgFill : limitPrice,
        limitPrice,
      };
    }
    if (TRADIER_REJECTED_STATUSES.has(status)) {
      return {
        status: 'rejected',
        orderId: order.id,
        reason: detail?.reason_description?.trim() || status,
      };
    }
    // Still pending / open after the wait window. Cancel before walking the
    // price so we don't leave a stale limit live on the broker between
    // attempts. Cancel failures are swallowed — Tradier sometimes reports
    // 422 when the order already terminated between our last poll and the
    // cancel call; either way, we proceed to the next attempt or return.
    if (attempt < maxAttempts - 1) {
      try {
        await client.cancelOrder(order.id);
      } catch {
        // Best-effort cleanup; the next limit submission still proceeds.
      }
    }
  }

  // After the walk, hand the last in-flight order id back so the dashboard
  // can render "Pending #N" and the user knows where on Tradier to look.
  if (lastOrderId === undefined) {
    return {
      status: 'rejected',
      reason: lastDetail?.reason_description?.trim() || 'Tradier did not accept the close order.',
    };
  }
  return {
    status: 'pending',
    orderId: lastOrderId,
    limitPrice: roundToCent(priceForAttempt(limitPath, maxAttempts - 1)),
  };
}

interface MidPath {
  kind: 'mid';
  bid: number;
  ask: number;
}

interface LastPath {
  kind: 'last';
  last: number;
}

interface NoPath {
  kind: 'none';
}

/**
 * TRA-352 follow-up — outcome of {@link reconcilePendingCloseOrder}. Used by
 * the engine's per-tick reconciler to resolve `pendingCloseOrderId` rows
 * against the broker's actual terminal state:
 *  - `filled` → broker filled the order; caller closes the local row at
 *    `avgFillPrice` (paper bucket credited at the real fill, not the stale
 *    mid we submitted at).
 *  - `rejected` → broker drove the order to a terminal non-fill state
 *    (cancel / reject / expire / error); caller clears
 *    `pendingCloseOrderId` so the dashboard shows the row OPEN again and
 *    the user can re-click Close.
 *  - `pending` → still open / pending on Tradier; caller leaves the row as
 *    "Pending #N".
 *  - `unknown` → status lookup failed (transient HTTP / parse error or
 *    Tradier dropped the order); caller leaves the row pending and tries
 *    again on the next tick.
 *
 * This is the reconciliation layer that closes the loop the board flagged:
 * the smart-close walk submits a limit, waits 10s, then returns `pending`
 * if Tradier hasn't reached a terminal state yet. Without this reconciler,
 * the local row sits "Pending #N" forever even after Tradier fills /
 * cancels / expires the order, which is exactly the alignment problem in
 * the board screenshots (TradeAI says Pending, Tradier says Filled or
 * Cancelled). Engine ticks every 30s, so the staleness window shrinks
 * from "until the user restarts the server" to <30s.
 */
export type ReconcileOutcome =
  | { status: 'filled'; orderId: number | string; avgFillPrice: number; limitPrice?: number }
  | { status: 'rejected'; orderId: number | string; reason: string }
  | { status: 'pending'; orderId: number | string }
  | { status: 'unknown'; orderId: number | string; reason: string };

/**
 * TRA-352 follow-up — look up a single Tradier close order by id and map its
 * status into a {@link ReconcileOutcome}. The engine calls this every tick for
 * each open row carrying a `pendingCloseOrderId`. Errors from the broker are
 * swallowed into `unknown` (rather than thrown) so a transient 5xx on one
 * row doesn't abort the reconciliation pass for the rest.
 */
export async function reconcilePendingCloseOrder(
  client: Pick<TradierOptionsClient, 'getOrderStatus'>,
  orderId: string | number,
): Promise<ReconcileOutcome> {
  let detail: TradierOrderDetail | null;
  try {
    detail = await client.getOrderStatus(orderId);
  } catch (err: unknown) {
    return {
      status: 'unknown',
      orderId,
      reason: `getOrderStatus threw: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (!detail) {
    return { status: 'unknown', orderId, reason: 'Tradier returned no order envelope' };
  }
  const status = detail.status ?? '';
  if (status === 'filled') {
    const avgFill = typeof detail.avg_fill_price === 'number' && Number.isFinite(detail.avg_fill_price)
      ? detail.avg_fill_price
      : NaN;
    if (!Number.isFinite(avgFill) || avgFill <= 0) {
      // Tradier reported filled but no usable avg_fill_price. Treat as
      // unknown so we retry next tick rather than closing locally at 0.
      return { status: 'unknown', orderId, reason: 'filled but missing avg_fill_price' };
    }
    return { status: 'filled', orderId, avgFillPrice: avgFill };
  }
  if (TRADIER_REJECTED_STATUSES.has(status)) {
    return {
      status: 'rejected',
      orderId,
      reason: detail.reason_description?.trim() || status,
    };
  }
  if (TRADIER_TERMINAL_STATUSES.has(status)) {
    // Defensive — TRADIER_TERMINAL_STATUSES is filled + rejected family.
    // Any other terminal state we haven't categorized: treat as rejected so
    // the user can re-click Close instead of getting stuck.
    return { status: 'rejected', orderId, reason: status };
  }
  return { status: 'pending', orderId };
}

/**
 * TRA-352 — collapse a Tradier option quote into the pricing path we'll
 * use for the limit walk. Exported for unit tests. Decision table:
 *   - bid > 0 and ask > 0 → mid path (walk goes mid → quarter toward bid → …)
 *   - bid <= 0 / missing AND ask > 0 / last > 0 → last path (one-shot,
 *     no walk — a single-sided quote isn't enough to triangulate a midpoint)
 *   - nothing usable → none (caller returns 409 no_quote)
 *
 * The "ask present but bid missing" case is common on deep-OTM contracts
 * with no buyer interest. Falling back to `last` (or, lacking that, the ask
 * itself) gives the user a chance at a fill instead of refusing outright.
 */
export function derivePricingPath(quote: TradierOptionQuote | null): MidPath | LastPath | NoPath {
  if (!quote) return { kind: 'none' };
  const bid = typeof quote.bid === 'number' && Number.isFinite(quote.bid) && quote.bid > 0 ? quote.bid : 0;
  const ask = typeof quote.ask === 'number' && Number.isFinite(quote.ask) && quote.ask > 0 ? quote.ask : 0;
  const last = typeof quote.last === 'number' && Number.isFinite(quote.last) && quote.last > 0 ? quote.last : 0;
  if (bid > 0 && ask > 0) return { kind: 'mid', bid, ask };
  if (last > 0) return { kind: 'last', last };
  if (ask > 0) return { kind: 'last', last: ask };
  return { kind: 'none' };
}

/**
 * TRA-352 — compute the limit price for the n-th attempt along the configured
 * pricing path. Mid path walks from the midpoint toward the bid in quarter
 * steps so attempt 0 = mid, attempt 1 = bid + 0.75 × (ask − bid), and so on.
 * Last path is a one-shot (every attempt uses `last`); the caller bounds the
 * walk to one attempt for last paths in practice via `maxAttempts: 1` when
 * desired, but the function still answers consistently for higher attempts.
 */
function priceForAttempt(path: MidPath | LastPath, attempt: number): number {
  if (path.kind === 'last') return path.last;
  const spread = path.ask - path.bid;
  if (spread <= 0) return (path.bid + path.ask) / 2;
  // Attempt 0: midpoint (50% of spread above bid).
  // Attempt 1: 25% of spread above bid (a quarter-step toward the bid).
  // Attempt 2: 12.5% of spread above bid. We bound `attempt` so the price
  // never crosses below the bid.
  const fraction = Math.max(0, 0.5 / Math.pow(2, attempt));
  return path.bid + spread * fraction;
}
