import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  TRADIER_REJECTED_STATUSES,
  TRADIER_TERMINAL_STATUSES,
  isTransportOrderFailure, // TRA-4260 — a 5xx is not a refusal
  roundToCent,
} from '@trading-app/engine';
import type { BrokerCloseEvent } from './broker-submit-census.js';
import { logger } from './observability/index.js';
import {
  recordCancelReplaceLatency,
  recordOrderFillOutcome,
} from './execution-quality-telemetry.js';

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
 *
 * ## TRA-4260 — the two fields the broker census needs and `status` cannot give
 *
 * The census close leg (`broker-submit-census.ts`) turns on ONE distinction:
 * did the order reach a broker DECISION. This helper's `status` cannot answer
 * it, in two independent ways, and both were silently wrong before this ticket:
 *
 *   • `rejected` has TWO producers — `sellContractsLimit` THREW (nothing
 *     reached a decision; on 2026-08-31 this is what a Tradier HTTP 500 did) and
 *     the broker drove the order to a rejected terminal status (it very much
 *     did). {@link SmartSellFailureKind} publishes the split, computed from the
 *     thrown error's `kind` via `isTransportOrderFailure` — never from the
 *     message text, so it agrees with every other close seam in the tree.
 *   • the walk submits up to `maxAttempts` orders and returns ONE outcome, so a
 *     caller counting outcomes under-counts the orders Tradier actually
 *     accepted. `submittedOrders` is that count, and it is on EVERY variant
 *     (including `no_quote`: attempt 1 can round to ≤ 0 after attempt 0 was
 *     already accepted and cancelled).
 *
 * Callers fold both through {@link smartSellCloseCensusEvents} rather than
 * re-deriving them; a caller that pattern-matches `status` by hand is how the
 * imported-close route came to be the one uninstrumented close seam.
 */
export type SmartSellOutcome =
  | {
      status: 'filled';
      orderId: number;
      avgFillPrice: number;
      limitPrice: number;
      /**
       * TRA-1601 — midpoint at the moment the helper pulled the quote, or `null`
       * on a single-sided (`last`) path where a mid can't be triangulated. Lets
       * the caller compute realised close-side slippage vs mid for telemetry.
       */
      mid: number | null;
      /** TRA-4260 — orders Tradier ACCEPTED during the walk. See above. */
      submittedOrders: number;
    }
  | {
      status: 'rejected';
      orderId?: number;
      reason: string;
      /** TRA-4260 — did this reach a broker decision, or did the submit throw? */
      failure: SmartSellFailureKind;
      submittedOrders: number;
    }
  | { status: 'pending'; orderId: number; limitPrice: number; submittedOrders: number }
  | {
      /**
       * TRA-4603 — the walk stopped because the broker's state is not KNOWABLE,
       * not because it is bad. A close order may still be WORKING at the broker;
       * no replacement was submitted and none may be until an operator or the
       * reconciler establishes terminal state.
       *
       * This is the close-side twin of smart-open's `halted`, and the asymmetry
       * matters: an unconfirmed cancel on the OPEN side risks a doubled entry,
       * whereas on the CLOSE side it risks selling contracts we do not own. On a
       * cash, option-level-2 account that is not a bigger position — it is a
       * broker rejection or a naked short the account is not permitted to hold.
       *
       * `confirmedFilledQty` is a LOWER BOUND, never a measurement. Do not size
       * anything from it; reconcile against the broker.
       */
      status: 'halted';
      orderId: number;
      haltCode: 'cancel_unknown' | 'cancel_threw' | 'exec_qty_unmeasured';
      reason: string;
      confirmedFilledQty: number | null;
      lastLimitPrice: number;
      submittedOrders: number;
    }
  | { status: 'no_quote'; reason: string; submittedOrders: number };

/**
 * TRA-4260 — why a {@link SmartSellOutcome} came back `rejected`, on the one
 * axis the broker census grades. Deliberately three members, not a boolean:
 * `transport_fault` and `submit_throw` both mean "no broker decision", but they
 * take different operator actions (wait for Tradier vs investigate our client),
 * which is the TRA-4226 line the census already draws on the entry leg.
 */
export type SmartSellFailureKind = 'broker_rejected' | 'submit_threw' | 'transport_fault';

/**
 * TRA-4260 — classify a throw off the error's `kind`, never its message text.
 * The return type excludes `broker_rejected` by construction: a throw is, by
 * definition, the absence of a broker decision.
 */
function failureKindForThrow(err: unknown): Exclude<SmartSellFailureKind, 'broker_rejected'> {
  return isTransportOrderFailure(err) ? 'transport_fault' : 'submit_threw';
}

/**
 * TRA-4260 — fold a {@link SmartSellOutcome} into the close-leg census events it
 * represents, in submission order. THE single place the mapping lives, so the
 * imported-close route, the fill-chaser's remainder re-submit and any future
 * caller cannot disagree about it.
 *
 * Emits one `submitted` per order Tradier accepted, then AT MOST one terminal
 * event for the outcome the caller is holding:
 *
 *   • `filled`   → `submitted` × n, then `filled`.
 *   • `pending`  → `submitted` × n and nothing else. The order is still working;
 *     its terminal event is recorded later by `reconcilePendingCloses`, and
 *     stamping one here would double-count the same order.
 *   • `rejected` → `submitted` × n, then `rejected` (the broker decided) or
 *     `transport_fault` / `submit_throw` (it did not). A throw is NEVER
 *     `rejected`: `submitted` means "the broker saw it and did not fill it", and
 *     a throw did not clear that bar.
 *   • `no_quote` → `submitted` × n (usually 0), then `no_quote_abort`.
 *   • `halted`   → `submitted` × n, then `halted` (TRA-4561). Not a broker
 *     verdict: the halted order id is stamped pending and the sweep records its
 *     real terminal event later, exactly as for `pending`. `halted` counts the
 *     walk stopping, which before TRA-4561 left no trace in the census at all.
 *
 * `expired` is not reachable from here: `submitSmartSellToClose` folds every
 * `TRADIER_REJECTED_STATUSES` member — expired included — into `rejected`
 * without publishing which one, so claiming `expired` would be a guess. The
 * sweep that DOES see the raw status records it.
 */
export function smartSellCloseCensusEvents(outcome: SmartSellOutcome): BrokerCloseEvent[] {
  const events: BrokerCloseEvent[] = [];
  for (let i = 0; i < outcome.submittedOrders; i += 1) events.push('submitted');
  switch (outcome.status) {
    case 'filled':
      events.push('filled');
      break;
    case 'pending':
      break;
    case 'no_quote':
      events.push('no_quote_abort');
      break;
    case 'halted':
      events.push('halted');
      break;
    case 'rejected':
      events.push(
        outcome.failure === 'broker_rejected'
          ? 'rejected'
          : outcome.failure === 'transport_fault'
            ? 'transport_fault'
            : 'submit_throw',
      );
      break;
    default: {
      // TRA-4561 — a new outcome status must fail the BUILD here, not fall
      // through silently the way `halted` did.
      const unhandled: never = outcome;
      return unhandled;
    }
  }
  return events;
}

export interface SmartSellOptions {
  /** TRA-352 — wait window per attempt (defaults to 5s to match TRA-348). */
  timeoutMs?: number;
  /** Bounded walk: 1 = mid only, 2 = mid then quarter-step toward bid, etc. */
  maxAttempts?: number;
  /** Injectable for tests so we don't need real timers. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * TRA-2046 — clock seam for cancel/replace latency telemetry (ms epoch).
   * Defaults to `Date.now`. Injectable so the latency capture is deterministic
   * in unit tests.
   */
  clock?: () => number;
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
  client: Pick<TradierOptionsClient, 'getOptionQuote' | 'sellContractsLimit' | 'cancelOrder' | 'cancelOrderConfirmed' | 'waitForOrderTerminalStatus'>,
  optionSymbol: string,
  qty: number,
  options: SmartSellOptions = {},
): Promise<SmartSellOutcome> {
  const timeoutMs = options.timeoutMs ?? 5000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 2);
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = options.clock ?? Date.now;

  // TRA-4260 — orders Tradier ACCEPTED across the whole walk. Carried on every
  // return so a caller folding this into the broker census counts the orders the
  // broker saw, not the outcomes we returned.
  let submittedOrders = 0;

  let quote: TradierOptionQuote | null = null;
  try {
    quote = await client.getOptionQuote(optionSymbol);
  } catch (err: unknown) {
    return {
      status: 'no_quote',
      reason: `Tradier quote lookup failed: ${err instanceof Error ? err.message : String(err)}`,
      submittedOrders,
    };
  }

  const limitPath = derivePricingPath(quote);
  if (limitPath.kind === 'none') {
    return {
      status: 'no_quote',
      reason: 'No quote available — close this contract manually on Tradier.',
      submittedOrders,
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
        submittedOrders,
      };
    }

    let order;
    const submitStart = clock();
    try {
      order = await client.sellContractsLimit(optionSymbol, qty, limitPrice);
    } catch (err: unknown) {
      return {
        status: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        // TRA-4260 — the submit THREW: nothing reached a broker decision, so
        // this must never fold to the census's `rejected`.
        failure: failureKindForThrow(err),
        submittedOrders,
        ...(lastOrderId !== undefined ? { orderId: lastOrderId } : {}),
      };
    }
    submittedOrders += 1;
    // TRA-2046 — attempt > 0 is a reprice re-submit (the "replace" leg); capture
    // its submit->ack latency. Attempt 0 is the initial submit, not a replace.
    if (attempt > 0) {
      recordCancelReplaceLatency({
        engine: 'options',
        side: 'close',
        kind: 'replace',
        latencyMs: Math.max(0, clock() - submitStart),
      });
    }
    lastOrderId = order.id;
    const detail = await client.waitForOrderTerminalStatus(order.id, { timeoutMs, sleep });
    lastDetail = detail;
    const status = detail?.status ?? '';
    // TRA-2046 — partial-fill telemetry. Record only when the broker reported a
    // finite executed quantity (an omitted exec_quantity is UNMEASURED, never a
    // false-zero fill — TRA-1707).
    if (detail && typeof detail.exec_quantity === 'number' && Number.isFinite(detail.exec_quantity)) {
      recordOrderFillOutcome({ engine: 'options', side: 'close', orderedQty: qty, execQty: detail.exec_quantity });
    }
    if (status === 'filled') {
      const avgFill = detail?.avg_fill_price;
      return {
        status: 'filled',
        orderId: order.id,
        avgFillPrice: typeof avgFill === 'number' && Number.isFinite(avgFill) ? avgFill : limitPrice,
        limitPrice,
        // TRA-1601 — mid only exists on a two-sided (mid) path; a single-sided
        // `last` fallback can't triangulate one, so telemetry drops the datum.
        mid: limitPath.kind === 'mid' ? (limitPath.bid + limitPath.ask) / 2 : null,
        submittedOrders,
      };
    }
    if (TRADIER_REJECTED_STATUSES.has(status)) {
      return {
        status: 'rejected',
        orderId: order.id,
        reason: detail?.reason_description?.trim() || status,
        // TRA-4260 — the broker HELD this order and decided against it.
        failure: 'broker_rejected',
        submittedOrders,
      };
    }
    // Still pending / open after the wait window. Cancel before walking the
    // price so we don't leave a stale limit live on the broker between
    // attempts. Cancel failures are swallowed — Tradier sometimes reports
    // 422 when the order already terminated between our last poll and the
    // cancel call; either way, we proceed to the next attempt or return.
    // ⭐ TRA-4603 — STILL WORKING, and the walk is about to RE-PRICE this order.
    //
    // THE DEFECT THIS CLOSES. This block used `cancelOrder`, whose contract is
    // "the DELETE was acknowledged" — and it swallowed 404/422, which are
    // exactly the statuses a FILLED order returns. A thrown cancel was logged
    // and the walk proceeded anyway ("Best-effort cleanup; the next limit
    // submission still proceeds"), so a live close limit and its replacement
    // could both be working, and both could fill. smart-open was fixed for the
    // same shape in TRA-4483; the close side and its pending fill-chaser were
    // left on the legacy API.
    //
    // The verdict now comes from the order's own TERMINAL STATE, never from the
    // DELETE's status code. An unconfirmed cancel HALTS the walk rather than
    // re-pricing over an order that may still be live.
    if (attempt < maxAttempts - 1) {
      const cancelStart = clock();
      let cancelOutcome;
      try {
        cancelOutcome = await client.cancelOrderConfirmed(order.id, { sleep });
      } catch (err) {
        // A confirm that RAISED may still have served its DELETE. Unknown, and
        // an unknown must never be re-priced over.
        closeLog.error('cancelOrderConfirmed threw during smart-close walk — HALTING', {
          orderId: order.id,
          attempt,
          reason: err instanceof Error ? err.message : String(err),
        });
        return {
          status: 'halted',
          orderId: order.id,
          haltCode: 'cancel_threw',
          reason: `cancel confirmation threw: ${err instanceof Error ? err.message : String(err)}`,
          confirmedFilledQty: null,
          lastLimitPrice: limitPrice,
          submittedOrders,
        };
      }

      if (cancelOutcome.kind === 'unknown') {
        closeLog.error('smart-close cancel unconfirmed — HALTING rather than re-pricing', {
          orderId: order.id,
          attempt,
          reason: cancelOutcome.reason,
          ackStatus: cancelOutcome.ackStatus,
          ackError: cancelOutcome.ackError,
        });
        return {
          status: 'halted',
          orderId: order.id,
          haltCode: 'cancel_unknown',
          reason: `cancel not confirmed (${cancelOutcome.reason}) — walk halted rather than re-pricing over a live close order`,
          confirmedFilledQty: null,
          lastLimitPrice: limitPrice,
          submittedOrders,
        };
      }

      // The cancel LOST THE RACE: the close already executed in full. There is
      // nothing left to close and a replacement would sell contracts we no
      // longer hold. Report it as the fill it is.
      if (cancelOutcome.kind === 'filled') {
        const avg = cancelOutcome.detail?.avg_fill_price;
        if (typeof avg === 'number' && Number.isFinite(avg)) {
          return {
            status: 'filled',
            orderId: order.id,
            avgFillPrice: avg,
            limitPrice: limitPrice,
            mid: limitPath.kind === 'mid' ? (limitPath.bid + limitPath.ask) / 2 : null,
            submittedOrders,
          };
        }
        // Terminal `filled` but no usable average — a real fill we cannot price.
        // Halting is the honest outcome; the reconciler owns it from here.
        closeLog.error('smart-close cancel raced a FILL with no avg_fill_price — HALTING', {
          orderId: order.id,
          attempt,
        });
        return {
          status: 'halted',
          orderId: order.id,
          haltCode: 'exec_qty_unmeasured',
          reason: 'close filled during cancel but the broker reported no avg_fill_price',
          confirmedFilledQty: cancelOutcome.filledQty,
          lastLimitPrice: limitPrice,
          submittedOrders,
        };
      }

      // TRA-2046 — cancel->ack latency, recorded only on a CONFIRMED terminal
      // outcome (an unknown is not an ack, so it must not enter the rollup).
      recordCancelReplaceLatency({
        engine: 'options',
        side: 'close',
        kind: 'cancel',
        latencyMs: Math.max(0, clock() - cancelStart),
      });

      // Terminal and unfilled-or-partial. A partial close means the NEXT
      // submission must be net of what already executed; an UNMEASURED
      // quantity (`null`, never 0 — TRA-1707) cannot be sized from at all.
      if (cancelOutcome.filledQty === null) {
        closeLog.error('smart-close cancel confirmed terminal but exec quantity UNMEASURED — HALTING', {
          orderId: order.id,
          attempt,
          terminalStatus: cancelOutcome.terminalStatus,
        });
        return {
          status: 'halted',
          orderId: order.id,
          haltCode: 'exec_qty_unmeasured',
          reason: 'cancel confirmed terminal but the broker did not report an executed quantity',
          confirmedFilledQty: null,
          lastLimitPrice: limitPrice,
          submittedOrders,
        };
      }
      if (cancelOutcome.filledQty > 0) {
        // A partial close executed. Re-pricing the ORIGINAL quantity here would
        // submit for more than remains. The walk does not currently carry a
        // per-attempt remaining-quantity, so the safe action is to stop and let
        // the reconciler pick up the residual position.
        closeLog.warn('smart-close cancel confirmed a PARTIAL fill — halting walk, residual is the reconciler\'s', {
          orderId: order.id,
          attempt,
          filledQty: cancelOutcome.filledQty,
        });
        return {
          status: 'halted',
          orderId: order.id,
          haltCode: 'exec_qty_unmeasured',
          reason: `close partially filled (${cancelOutcome.filledQty}) during cancel — walk halted rather than re-pricing the full quantity`,
          confirmedFilledQty: cancelOutcome.filledQty,
          lastLimitPrice: limitPrice,
          submittedOrders,
        };
      }
    }
  }

  // After the walk, hand the last in-flight order id back so the dashboard
  // can render "Pending #N" and the user knows where on Tradier to look.
  if (lastOrderId === undefined) {
    return {
      status: 'rejected',
      reason: lastDetail?.reason_description?.trim() || 'Tradier did not accept the close order.',
      // TRA-4260 — defensive-unreachable (`maxAttempts` ≥ 1 and every path out
      // of the loop body either returns or sets `lastOrderId`). If it ever does
      // fire, no order id exists, so no order reached a decision: `submit_threw`
      // is the honest read and `broker_rejected` would be an invented one.
      failure: 'submit_threw',
      submittedOrders,
    };
  }
  return {
    status: 'pending',
    orderId: lastOrderId,
    limitPrice: roundToCent(priceForAttempt(limitPath, maxAttempts - 1)),
    submittedOrders,
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
  | {
      status: 'rejected';
      orderId: number | string;
      reason: string;
      /**
       * TRA-4260 — the BROKER's own terminal status (`expired`, `canceled`,
       * `rejected`, `error`, …), verbatim. `reason` is free text and is often
       * this same word, but a caller must never key on free text; the census
       * splits `expired` out of `rejected` for the TRA-2984 reason (the order
       * reached the broker and lapsed — the broker refused nothing) and needs
       * the enum to do it. Empty string only when Tradier sent no status at all.
       */
      terminalStatus: string;
    }
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
      terminalStatus: status, // TRA-4260
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
    return { status: 'rejected', orderId, reason: status, terminalStatus: status }; // TRA-4260
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
 * TRA-2811 — maximum discount vs the quote midpoint a live `sell_to_close`
 * limit is allowed to carry. On 2026-08-03 an SL exit priced "on the bid" met
 * a pathologically wide book (`bid 0.17 / ask 2.49`, mid 1.33) and submitted a
 * $0.17 limit — ~87% below mid, effectively a market order with no floor — on
 * the production account (filled $0.89, −33% vs mid, ≈$44 donated on one
 * contract). The bid is only a sane price when the book is sane.
 *
 * 0.4 discriminates cleanly on the live tape: the sane same-day exits sat at
 * 6–14% below mid, the degenerate one at 87%. The floor is deliberately a
 * backstop against donation, not a cost optimizer — floored SL/trail orders
 * still want a fill, so the floor must stay near fillable territory. A tighter
 * floor turns a stop into a resting order that no longer protects.
 */
export const MAX_LIVE_SELL_LIMIT_DISCOUNT_VS_MID = 0.4;

/**
 * TRA-3418 — the CONCESSION CAP: the most a live `sell_to_close` may sit below
 * the quote midpoint **on its first attempt**.
 *
 * The TRA-2811 floor above is a donation backstop, and it works — nothing has
 * submitted 87% below mid since. But it left the ordinary case untouched, and
 * the ordinary case is where the money went. Sitting on the bid concedes the
 * FULL half-spread, and on a wide book that is the whole loss:
 *
 * | 2026-08-0x live | mid | limit = bid | vs mid | outcome |
 * |---|---|---|---|---|
 * | `TROW260918C00115000` | 3.60 | 3.00 | −16.7% | **filled AT 3.00** — the limit set the price, ≈$60 donated on one contract |
 * | `KVYO260918C00017500` | 1.425 | 1.20 | −15.8% | filled 1.3533 — the market, not us, saved it |
 * | `TSLA260911C00555000` | 0.245 | 0.22 | −10.2% | filled at the limit |
 *
 * Every one of those cleared the 40% floor untouched. TROW is the first case
 * where the floor-less limit demonstrably *set* the realised price rather than
 * merely risking it.
 *
 * **Why two terms.** A pure percentage bites hardest where it helps least: on a
 * $0.12 contract the whole spread is one or two ticks, 5% of mid is sub-tick,
 * and holding out for a cent buys nothing while adding non-fill risk to a stop.
 * So the cap is `max(MIN_LIVE_SELL_CONCESSION_ABS, mid × MAX_LIVE_SELL_CONCESSION_FRAC_OF_MID)`
 * — the absolute term keeps the penny-option regime behaving EXACTLY as it does
 * today, and the proportional term engages only once the concession is worth
 * real money. Against the tape: TSLA (concession $0.025) stays on the bid
 * untouched; KVYO ($0.225) and TROW ($0.60) are capped.
 *
 * **Why 5%.** KVYO is the empirical anchor: submitted at the bid, 15.8% under
 * mid, and the broker's routing filled it at 1.3533 — mid − 5.03%. The book's
 * real clearing price was ~5% under mid, and we asked for 15.8% under. 5% is
 * where that one honest observation says the liquidity actually was.
 *
 * **This cap is not a resting order.** It is the FIRST of two attempts. If the
 * capped limit does not fill inside the submit-wait window, the caller cancels
 * and re-submits at {@link LiveSellLimitResult.escalateTo} — the donation-floored
 * bid, i.e. exactly today's price. So the worst case is today's behaviour ~6s
 * later, and holding out above the bid never survives a tick boundary. That
 * bound is deliberate: a stop resting above the bid across ticks is the
 * self-reinforcing detachment TRA-2956 documents, and this must not reintroduce
 * it to buy a better price.
 */
export const MAX_LIVE_SELL_CONCESSION_FRAC_OF_MID = 0.05;

/** TRA-3418 — see {@link MAX_LIVE_SELL_CONCESSION_FRAC_OF_MID}: the absolute leg of the cap, per share. */
export const MIN_LIVE_SELL_CONCESSION_ABS = 0.05;

/** TRA-2811 / TRA-3418 — a priced live sell limit plus the provenance the caller logs. */
export interface LiveSellLimitResult {
  /** The per-share limit to submit FIRST (already floored, capped + cent-rounded). */
  limit: number;
  /** The pre-floor, pre-cap price the level selected (bid / mid / last). */
  raw: number;
  /** Quote midpoint the floor/cap were computed against; null on a single-sided book. */
  mid: number | null;
  /**
   * TRUE when `raw` sat below `mid × (1 − MAX_LIVE_SELL_LIMIT_DISCOUNT_VS_MID)`
   * and the price was lifted to the donation floor. The caller must surface this
   * loudly — it means the live book was too wide to trust the bid at all.
   */
  floored: boolean;
  /**
   * TRA-3418 — TRUE when the concession cap lifted `limit` ABOVE the price this
   * exit would otherwise have submitted at. Implies `escalateTo` is non-null.
   */
  capped: boolean;
  /**
   * TRA-3418 — the donation-floored level price (i.e. pre-TRA-3418 behaviour) to
   * re-submit at if `limit` does not fill inside the submit-wait window. `null`
   * when the cap did not engage, which is the signal that there is nothing to
   * escalate to.
   */
  escalateTo: number | null;
}

/**
 * TRA-450 — derive a LIVE per-share limit for an engine-staged
 * `sell_to_close` from a fresh Tradier option quote. The engine's staged-exit
 * path previously submitted at the position's entry-time trigger price
 * (`stopLossPremium` / `tp1Premium`), which goes stale the moment the
 * contract's mark drifts — the TRA-450 Tradier export showed a TSLA stop
 * submitting `limit @ 0.17` against a contract that had decayed to
 * $0.05–0.09. Pricing off the live quote keeps the order marketable.
 *
 * `level` picks how aggressive the limit is:
 *  - `'bid'` → an SL / trailing-stop exit wants a FILL, so sit on the bid;
 *    a sell limit at the bid is immediately marketable.
 *  - `'mid'` → a TP1 / manual exit should not give away the spread, so
 *    price at the midpoint.
 *
 * TRA-2811 — the bid level is FLOORED at
 * `mid × (1 − MAX_LIVE_SELL_LIMIT_DISCOUNT_VS_MID)`: when the book is so wide
 * that the bid is an implausible price (the defect case was a bid 87% below
 * mid), the limit rests at the floor instead of donating the spread. The mid
 * level is ≥ the floor by construction, and single-sided (`last`) quotes have
 * no mid to floor against, so only degenerate bid-level prices are lifted.
 *
 * TRA-3418 — the floored price is then CAPPED by
 * {@link MAX_LIVE_SELL_CONCESSION_FRAC_OF_MID}, so the FIRST submission never
 * concedes more than `max($0.05, 5% of mid)` below mid. When the cap engages,
 * `escalateTo` carries the un-capped (floored) price and the caller re-submits
 * there if the capped limit does not fill — the cap buys a better price, it
 * never abandons the exit. The mid level and single-sided (`last`) paths are
 * inert under the cap: a midpoint is above the cap by construction, and a
 * single-sided quote has no mid to measure a concession against.
 *
 * Single-sided quotes (no bid) fall back to `last` for either level — the
 * best live price we have. Returns `null` when the quote yields nothing
 * usable; the caller then falls back to the staged trigger price.
 */
export function liveSellLimitDetailed(
  quote: TradierOptionQuote | null,
  level: 'mid' | 'bid',
): LiveSellLimitResult | null {
  const path = derivePricingPath(quote);
  if (path.kind === 'none') return null;
  if (path.kind === 'last') {
    const limit = roundToCent(path.last);
    if (!Number.isFinite(limit) || limit <= 0) return null;
    return { limit, raw: limit, mid: null, floored: false, capped: false, escalateTo: null };
  }
  const mid = (path.bid + path.ask) / 2;
  const raw = roundToCent(level === 'bid' ? path.bid : mid);
  if (!Number.isFinite(raw) || raw <= 0) return null;
  const floor = roundToCent(mid * (1 - MAX_LIVE_SELL_LIMIT_DISCOUNT_VS_MID));
  const floored = raw < floor;
  // The price this exit would have submitted at before TRA-3418 — and the price
  // it escalates back to if the capped limit goes unfilled.
  const unCapped = floored ? floor : raw;
  const capPrice = roundToCent(
    mid - Math.max(MIN_LIVE_SELL_CONCESSION_ABS, mid * MAX_LIVE_SELL_CONCESSION_FRAC_OF_MID),
  );
  // A cap at or below zero is not a price — a contract cheaper than the absolute
  // concession leg (mid ≤ $0.05) can only be sold by crossing, so leave it alone.
  const capped = capPrice > 0 && unCapped < capPrice;
  return {
    limit: capped ? capPrice : unCapped,
    raw,
    mid: roundToCent(mid),
    floored,
    capped,
    escalateTo: capped ? unCapped : null,
  };
}

/**
 * Back-compat shape of {@link liveSellLimitDetailed} — just the (floored, capped)
 * limit.
 *
 * ⚠️ TRA-3418 — this shape DISCARDS `escalateTo`, so a caller using it submits the
 * concession-capped price with no way to fall back to the bid. On a wide book that
 * is an order resting ABOVE the bid with nothing scheduled to withdraw it, which is
 * the TRA-2956 detachment shape. Any live `sell_to_close` path must call
 * {@link liveSellLimitDetailed} and honour `escalateTo`; this wrapper is retained
 * for tests and for callers that only need to price a quote, not submit one.
 */
export function liveSellLimit(
  quote: TradierOptionQuote | null,
  level: 'mid' | 'bid',
): number | null {
  return liveSellLimitDetailed(quote, level)?.limit ?? null;
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
 *
 * TRA-4260 — `error` carries {@link SmartSellFailureKind} for the same reason
 * `SmartSellOutcome.rejected` does: the resubmit THREW, so nothing reached a
 * broker decision, and the census has to tell a Tradier outage apart from our
 * own client breaking. It is never `broker_rejected` — a refusal the broker
 * actually returned arrives as a terminal order status on a later sweep, not as
 * a throw here.
 *
 * `held` carries no census event at all, and that is not an omission: the
 * ORIGINAL order is still live and working at the broker. Nothing was
 * submitted, nothing was aborted, and the exit is still in flight.
 */
export type RepriceOutcome =
  | { status: 'repriced'; orderId: number; limitPrice: number; step: number }
  | { status: 'held'; reason: string }
  | { status: 'error'; reason: string; failure: Exclude<SmartSellFailureKind, 'broker_rejected'> };

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
    return {
      status: 'error',
      reason: err instanceof Error ? err.message : String(err),
      // TRA-4260 — off the error's `kind`, never its message text.
      failure: failureKindForThrow(err),
    };
  }
  return { status: 'repriced', orderId: order.id, limitPrice, step };
}
