import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  TRADIER_REJECTED_STATUSES,
  TRADIER_TERMINAL_STATUSES,
  roundToCent,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

const closeLog = logger.child({ module: 'tradier-smart-close' });

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
      } catch (err) {
        // Best-effort cleanup; the next limit submission still proceeds.
        // TRA-406 — was a bare `catch {}`. Cancel failures are expected when
        // the order already terminated, but on a broker path they must not be
        // invisible: a repeated cancel failure can mean a stale live limit.
        closeLog.warn('cancelOrder failed during smart-close walk', {
          orderId: order.id,
          attempt,
          reason: err instanceof Error ? err.message : String(err),
        });
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
 *  - `partial_fill` → TRA-416. The order filled PART of its quantity at
 *    `avgFillPrice` and then went terminal (expired / cancelled) with a
 *    non-zero `filledQty` left un-filled. Caller books the filled slice as a
 *    realised close, reduces the local position to the remainder, and
 *    re-submits a fresh `sell_to_close` for what's left so the exit
 *    completes. Without this branch the slice that DID fill leaks: the
 *    position + P&L stay as if nothing closed.
 *  - `rejected` → broker drove the order to a terminal non-fill state
 *    (cancel / reject / expire / error) with NOTHING filled; caller clears
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
  | { status: 'partial_fill'; orderId: number | string; avgFillPrice: number; filledQty: number }
  | { status: 'rejected'; orderId: number | string; reason: string }
  | { status: 'pending'; orderId: number | string }
  | { status: 'unknown'; orderId: number | string; reason: string };

/**
 * TRA-416 — extract the filled slice of a TERMINAL `sell_to_close` order.
 * Returns `{ filledQty, avgFillPrice }` only when the order genuinely
 * filled part of its quantity at a usable price; returns `null` (→ caller
 * treats it as a plain no-fill rejection) when:
 *  - `exec_quantity` is absent / ≤ 0 (nothing filled), or
 *  - `avg_fill_price` is absent / ≤ 0 (a fill we can't price — booking it at
 *    $0 would corrupt P&L; the periodic portfolio reconcile picks up the
 *    contract drift instead).
 */
function extractPartialFill(
  detail: TradierOrderDetail,
): { filledQty: number; avgFillPrice: number } | null {
  const filledQty =
    typeof detail.exec_quantity === 'number' && Number.isFinite(detail.exec_quantity)
      ? detail.exec_quantity
      : 0;
  if (!(filledQty > 0)) return null;
  const avg =
    typeof detail.avg_fill_price === 'number' && Number.isFinite(detail.avg_fill_price)
      ? detail.avg_fill_price
      : NaN;
  if (!Number.isFinite(avg) || avg <= 0) return null;
  return { filledQty, avgFillPrice: avg };
}

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
    // TRA-416 — a "rejected"-family terminal state (cancelled / expired /
    // error) can still carry a non-zero `exec_quantity`: the order filled
    // PART of its size before the broker terminated it. Book that slice as a
    // partial fill instead of throwing the whole position back OPEN.
    const partial = extractPartialFill(detail);
    if (partial) {
      return { status: 'partial_fill', orderId, avgFillPrice: partial.avgFillPrice, filledQty: partial.filledQty };
    }
    return {
      status: 'rejected',
      orderId,
      reason: detail.reason_description?.trim() || status,
    };
  }
  if (TRADIER_TERMINAL_STATUSES.has(status)) {
    // Defensive — TRADIER_TERMINAL_STATUSES is filled + rejected family.
    // Any other terminal state we haven't categorized: surface a partial
    // fill if one is present, else treat as rejected so the user can
    // re-click Close instead of getting stuck.
    const partial = extractPartialFill(detail);
    if (partial) {
      return { status: 'partial_fill', orderId, avgFillPrice: partial.avgFillPrice, filledQty: partial.filledQty };
    }
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

/* -------------------------------------------------------------------------
 * TRA-392 — fill-chaser repricer for stuck `pending` sell_to_close orders.
 * ---------------------------------------------------------------------- */

/**
 * TRA-392 — fill-chaser tuning. Hardcoded defaults (no settings knob — see
 * TRA-392 AC #5) documented here as the single source of truth:
 *
 *  - {@link PENDING_CLOSE_REPRICE_STALENESS_MS} — a `sell_to_close` must sit
 *    `pending`/`open` at least this long before the per-tick reconciler
 *    cancels and resubmits it one step lower. The engine tick is ~30s, so 20s
 *    means a pending order stamped on tick N is repriced on tick N+1 — every
 *    price level gets one full tick (~30s) to fill before stepping down.
 *  - {@link PENDING_CLOSE_MAX_REPRICE_STEPS} — hard cap on cancel+reprice
 *    cycles. After this many steps the reconciler stops walking and just
 *    polls; by the final step the order sits exactly on the bid (a sell limit
 *    at the bid is immediately marketable), which is the most aggressive
 *    price the chaser will ever use.
 */
export const PENDING_CLOSE_REPRICE_STALENESS_MS = 20_000;
export const PENDING_CLOSE_MAX_REPRICE_STEPS = 4;

/**
 * TRA-392 — fraction of the bid/ask spread the chaser's FIRST reprice step
 * sits above the bid. The smart-close walk ({@link submitSmartSellToClose})
 * leaves its pending order at `bid + 0.25 × spread` (attempt 1 of a 2-attempt
 * walk), so the chaser starts just below that and walks down to the bid.
 */
const CHASE_START_FRACTION = 0.2;

/**
 * TRA-392 — outcome of {@link repricePendingCloseOrder}:
 *  - `repriced` → the stale order was cancelled and a fresh limit
 *    `sell_to_close` was submitted at `limitPrice`; caller restamps the row
 *    with the new `orderId` and bumps the reprice-step counter.
 *  - `held` → no usable lower limit could be priced (no quote this tick, or
 *    the price floor was reached). The ORIGINAL order is left live and
 *    pending — we never cancel into a no-order limbo. Caller leaves the row
 *    alone and tries again next tick.
 *  - `error` → the cancel went through but the resubmit failed; the original
 *    order is gone. Caller clears the pending marker so the row re-renders
 *    Close (imported) or lets `checkExits` retry (engine-opened).
 */
export type RepriceOutcome =
  | { status: 'repriced'; orderId: number; limitPrice: number; step: number }
  | { status: 'held'; reason: string }
  | { status: 'error'; reason: string };

/**
 * TRA-392 — compute the limit price for the n-th fill-chaser reprice step,
 * pulling the geometry from a FRESH option quote. Exported for unit tests.
 *
 * Mid path (bid > 0 and ask > 0): walk the limit down toward the bid. Step 1
 * sits at `bid + 0.2 × spread` (just below where {@link submitSmartSellToClose}
 * left the order); the final step lands exactly on the bid. Linear in between.
 *
 * Last path (single-sided quote — no bid to anchor on): walk the limit down
 * toward, but never reaching, zero (`step k → last × (steps−k+1)/(steps+1)`),
 * so we never submit a $0 order Tradier would reject.
 *
 * Returns `null` when no usable quote is available or the computed limit
 * rounds to ≤ 0 — the caller treats `null` as "hold, don't reprice".
 */
export function computeRepriceLimit(
  quote: TradierOptionQuote | null,
  step: number,
  maxSteps: number,
): number | null {
  const path = derivePricingPath(quote);
  if (path.kind === 'none') return null;
  const steps = Math.max(1, Math.floor(maxSteps));
  const k = Math.min(Math.max(1, Math.floor(step)), steps);
  let raw: number;
  if (path.kind === 'mid') {
    const spread = Math.max(0, path.ask - path.bid);
    // fraction: step 1 → CHASE_START_FRACTION, final step → 0 (the bid).
    const fraction = steps <= 1 ? 0 : (CHASE_START_FRACTION * (steps - k)) / (steps - 1);
    raw = path.bid + spread * fraction;
  } else {
    // Single-sided quote — walk down toward (never reaching) zero.
    raw = (path.last * (steps - k + 1)) / (steps + 1);
  }
  const limit = roundToCent(raw);
  if (!Number.isFinite(limit) || limit <= 0) return null;
  return limit;
}

/**
 * TRA-392 — fill-chaser. Cancel a stale `pending` `sell_to_close` and
 * resubmit it one step lower toward the live bid so closes don't stall at the
 * original limit. Called by the engine's per-tick close reconciler once an
 * order has been pending past {@link PENDING_CLOSE_REPRICE_STALENESS_MS}.
 *
 * Order of operations matters for AC #3 (never leave the row with no live
 * order): we pull a fresh quote and compute the next limit BEFORE touching
 * the broker. If no valid lower limit can be priced we return `held` and the
 * existing order stays live. Only once we have a real limit do we cancel the
 * stale order and submit the replacement.
 */
export async function repricePendingCloseOrder(
  client: Pick<TradierOptionsClient, 'getOptionQuote' | 'sellContractsLimit' | 'cancelOrder'>,
  optionSymbol: string,
  qty: number,
  currentOrderId: number | string,
  step: number,
  maxSteps: number,
): Promise<RepriceOutcome> {
  // AC #2 — fresh quote every reprice so the new limit tracks the live
  // bid/ask, not the stale quote from the original submit.
  let quote: TradierOptionQuote | null;
  try {
    quote = await client.getOptionQuote(optionSymbol);
  } catch (err: unknown) {
    return {
      status: 'held',
      reason: `quote lookup failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  // AC #3 — price the next step before cancelling. A null limit (no quote /
  // floor reached) means we hold: the existing order stays live and pending.
  const limitPrice = computeRepriceLimit(quote, step, maxSteps);
  if (limitPrice === null) {
    return { status: 'held', reason: 'no usable quote / price floor reached' };
  }
  // Cancel the stale order first so the resubmit doesn't double the close
  // size. Best-effort: Tradier sometimes 422s if the order already
  // terminated between the reconcile poll and here — the resubmit proceeds.
  try {
    await client.cancelOrder(currentOrderId);
  } catch {
    // Swallow — proceed to resubmit at the lower limit.
  }
  let order;
  try {
    order = await client.sellContractsLimit(optionSymbol, qty, limitPrice);
  } catch (err: unknown) {
    return { status: 'error', reason: err instanceof Error ? err.message : String(err) };
  }
  return { status: 'repriced', orderId: order.id, limitPrice, step };
}
