import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  TRADIER_REJECTED_STATUSES,
  roundToCent,
} from '@trading-app/engine';
import { logger } from './observability/index.js';

const openLog = logger.child({ module: 'tradier-smart-open' });

/**
 * TRA-374 — outcome of {@link submitSmartBuyToOpen}. The live-entry mirror
 * branches on `status`:
 *  - `filled` → mirror succeeded; signal-engine keeps the paper open and
 *    stamps the broker order id. `avgFillPrice` is the broker's actual fill
 *    so callers can compute realised slippage vs. the engine's mark.
 *  - `rejected` → broker drove the order to a non-fill terminal state
 *    (cancel / reject / expire / error). Caller voids the paper open.
 *  - `no_quote` → we couldn't pull a usable bid/ask/last for the OCC; we
 *    refuse to submit a market order against a dead contract (the whole
 *    point of the smart-open walk is to avoid paying the ASK on a wide-
 *    spread quote). Caller voids the paper open.
 *  - `walk_exhausted` → walked from mid all the way to the ask without
 *    filling. Caller voids the paper open (no live position exists). The
 *    last in-flight order has already been cancelled by this helper.
 */
export type SmartBuyOutcome =
  | {
      status: 'filled';
      orderId: number;
      avgFillPrice: number;
      limitPrice: number;
      /** 0-indexed walk step that produced the fill (0 = mid+1¢, 4 = ask). */
      walk: number;
      /** Midpoint at the moment the helper pulled the quote, or `null` on an ask-only path. */
      mid: number | null;
      /** Ask at the moment the helper pulled the quote. */
      ask: number;
    }
  | { status: 'rejected'; orderId?: number; reason: string }
  | { status: 'walk_exhausted'; reason: string; lastLimitPrice: number }
  | { status: 'no_quote'; reason: string };

export interface SmartBuyOptions {
  /** Wait window per attempt (defaults to 30s — spec calls for a longer hold than smart-close). */
  timeoutMs?: number;
  /** Injectable for tests so we don't need real timers. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * TRA-374 — fractional walk schedule used by {@link submitSmartBuyToOpen}.
 * Attempt 0 starts at the midpoint biased up by 1¢ so we land just above the
 * mid and bias toward a fill. Subsequent attempts walk a quarter-step toward
 * the ask. Attempt 4 lands exactly at the ask, after which we give up rather
 * than crossing through it.
 *
 * Exported for unit tests.
 */
export const SMART_BUY_WALK_FRACTIONS: readonly number[] = [0, 0.25, 0.5, 0.75, 1.0];

/**
 * TRA-374 — entry-side limit walk for a long option contract. Pulls a fresh
 * bid/ask from Tradier, submits a LIMIT `buy_to_open` at `mid + 1¢` (attempt
 * 0), waits up to `timeoutMs`, and on each timeout cancels and re-submits at
 * `mid + walkPct × (ask − mid)` with `walkPct ∈ {0.25, 0.5, 0.75, 1.0}`. If
 * the final attempt (= the ask) doesn't fill inside the wait window, we
 * cancel and return `walk_exhausted` so the caller voids the paper open
 * with `liveSkipReason: "Tradier LIMIT walk to ask exhausted"`.
 *
 * Why limit instead of market: on the wide-spread, low-volume OTM contracts
 * the RV scanner surfaces, a market `buy_to_open` reliably fills at the
 * ASK (TRA-371 §3 forensics). The engine's signal already booked at the
 * mid — the difference is structural slippage demo never paid. Walking the
 * limit recovers any discount the market is willing to give before falling
 * back to the same fill a market order would have produced. Worst case
 * (walked all the way to the ask and still didn't fill in 30s × 5 attempts)
 * we void the paper open instead of taking a real fill at a worse price —
 * a missed entry is recoverable, a phantom paper position is not.
 *
 * Reference: `packages/server/src/tradier-smart-close.ts` (the close-side
 * counterpart this is modelled on).
 */
export async function submitSmartBuyToOpen(
  client: Pick<TradierOptionsClient, 'getOptionQuote' | 'buyContractsLimit' | 'cancelOrder' | 'waitForOrderTerminalStatus'>,
  optionSymbol: string,
  qty: number,
  options: SmartBuyOptions = {},
): Promise<SmartBuyOutcome> {
  const timeoutMs = options.timeoutMs ?? 30_000;
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

  const path = derivePricingPath(quote);
  if (path.kind === 'none') {
    return {
      status: 'no_quote',
      reason: 'No quote available — refusing market buy on dead contract.',
    };
  }

  let lastOrderId: number | undefined;
  let lastLimitPrice = 0;
  for (let attempt = 0; attempt < SMART_BUY_WALK_FRACTIONS.length; attempt += 1) {
    const limitPrice = roundToCent(priceForAttempt(path, attempt));
    // Tradier rejects limit prices ≤ 0 on equity options; bail with no_quote
    // instead of submitting a doomed order.
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      return {
        status: 'no_quote',
        reason: 'No quote available — refusing market buy on dead contract.',
      };
    }
    lastLimitPrice = limitPrice;

    let order;
    try {
      order = await client.buyContractsLimit(optionSymbol, qty, limitPrice);
    } catch (err: unknown) {
      return {
        status: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        ...(lastOrderId !== undefined ? { orderId: lastOrderId } : {}),
      };
    }
    lastOrderId = order.id;
    const detail: TradierOrderDetail | null = await client.waitForOrderTerminalStatus(order.id, {
      timeoutMs,
      sleep,
    });
    const status = detail?.status ?? '';
    if (status === 'filled') {
      const avgFill = detail?.avg_fill_price;
      return {
        status: 'filled',
        orderId: order.id,
        avgFillPrice:
          typeof avgFill === 'number' && Number.isFinite(avgFill) ? avgFill : limitPrice,
        limitPrice,
        walk: attempt,
        mid: path.kind === 'mid' ? (path.bid + path.ask) / 2 : null,
        ask: path.ask,
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
    try {
      await client.cancelOrder(order.id);
    } catch (err) {
      // Best-effort cleanup; the next limit submission still proceeds.
      // TRA-406 — was a bare `catch {}`. Logged so a persistent cancel
      // failure (a live limit that won't clear) is visible on the broker path.
      openLog.warn('cancelOrder failed during smart-open walk', {
        orderId: order.id,
        reason: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Walked from mid to the ask without a fill — give up rather than
  // crossing through with a market order at a worse price.
  return {
    status: 'walk_exhausted',
    reason: 'Tradier LIMIT walk to ask exhausted',
    lastLimitPrice,
  };
}

interface MidPath {
  kind: 'mid';
  bid: number;
  ask: number;
}

interface AskOnlyPath {
  kind: 'ask_only';
  ask: number;
}

interface NoPath {
  kind: 'none';
}

/**
 * TRA-374 — collapse a Tradier option quote into the pricing path the buy
 * walk uses. Decision table:
 *  - bid > 0 and ask > 0 → mid path (walk goes mid + 1¢ → 0.25 → 0.5 → 0.75 → ask)
 *  - ask > 0 only (no bid) → ask-only path: every attempt is the ask. A
 *    one-sided quote can't be triangulated; falling back to the ask is the
 *    same outcome a market buy would have produced.
 *  - nothing usable → none (caller returns no_quote and voids the paper open)
 *
 * Exported for unit tests.
 */
export function derivePricingPath(quote: TradierOptionQuote | null): MidPath | AskOnlyPath | NoPath {
  if (!quote) return { kind: 'none' };
  const bid = typeof quote.bid === 'number' && Number.isFinite(quote.bid) && quote.bid > 0 ? quote.bid : 0;
  const ask = typeof quote.ask === 'number' && Number.isFinite(quote.ask) && quote.ask > 0 ? quote.ask : 0;
  if (bid > 0 && ask > 0 && ask >= bid) return { kind: 'mid', bid, ask };
  if (ask > 0) return { kind: 'ask_only', ask };
  return { kind: 'none' };
}

/**
 * TRA-374 — limit price for the n-th attempt along the configured pricing
 * path. Mid path walks from `mid + 1¢` toward the ask:
 *  - attempt 0: mid + min(1¢, half-spread)
 *  - attempt 1: mid + 0.25 × (ask − mid)
 *  - attempt 2: mid + 0.50 × (ask − mid)
 *  - attempt 3: mid + 0.75 × (ask − mid)
 *  - attempt 4: ask
 *
 * On attempt 0 we cap the 1¢ bias at half the spread so we don't accidentally
 * jump past the ask on a 1-tick-wide quote (bid 0.20 / ask 0.21 → mid 0.205;
 * mid + 0.01 = 0.215 would already be over the ask). On ask-only paths the
 * limit is always the ask.
 */
function priceForAttempt(path: MidPath | AskOnlyPath, attempt: number): number {
  if (path.kind === 'ask_only') return path.ask;
  const mid = (path.bid + path.ask) / 2;
  const halfSpread = (path.ask - path.bid) / 2;
  if (attempt === 0) return mid + Math.min(0.01, Math.max(0, halfSpread));
  const fraction = SMART_BUY_WALK_FRACTIONS[Math.min(attempt, SMART_BUY_WALK_FRACTIONS.length - 1)] ?? 1;
  return mid + (path.ask - mid) * fraction;
}
