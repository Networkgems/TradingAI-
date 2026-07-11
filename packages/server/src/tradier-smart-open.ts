import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  TRADIER_REJECTED_STATUSES,
  roundToCent,
  parseOccSymbol,
} from '@trading-app/engine';
import {
  DAY_TRADING_GUARDRAIL,
  checkEntryDte,
  dteFromExpiration,
  type DayTradingGuardrailConfig,
} from '@trading-app/shared';
import {
  type MakerWalkConfig,
  DEFAULT_MAKER_WALK_FRACTIONS,
  resolveMakerWalkConfig,
} from './option-maker-config.js';
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
      /**
       * 0-indexed walk step that produced the fill. `0 = mid+1¢`; the last
       * fraction step is the ask; any step BEYOND `fractions.length − 1` is a
       * bounded cross-tick step past the ask (TRA-1601 `maxCrossTicks`).
       */
      walk: number;
      /** Midpoint at the moment the helper pulled the quote, or `null` on an ask-only path. */
      mid: number | null;
      /** Ask at the moment the helper pulled the quote. */
      ask: number;
      /**
       * TRA-1601 (telemetry) — wall-clock ms from the first order submit to the
       * terminal `filled` poll. Feeds the maker-fill time-to-fill rollup.
       */
      timeToFillMs: number;
    }
  | { status: 'rejected'; orderId?: number; reason: string }
  | { status: 'walk_exhausted'; reason: string; lastLimitPrice: number }
  | { status: 'no_quote'; reason: string };

export interface SmartBuyOptions {
  /**
   * Wait window per attempt. Defaults to the resolved {@link MakerWalkConfig}
   * `stepWaitMs` (30 s unless `OPTION_MAKER_STEP_WAIT_MS` overrides it). An
   * explicit `timeoutMs` still wins for callers/tests that pass one.
   */
  timeoutMs?: number;
  /**
   * TRA-1601 (deliverable A) — the configurable chase ladder. Defaults to
   * {@link resolveMakerWalkConfig}(process.env), which is the byte-for-byte
   * TRA-374 schedule unless the `OPTION_MAKER_*` env knobs override it.
   * Injectable so tests exercise a specific ladder without touching env.
   */
  walk?: MakerWalkConfig;
  /** Injectable for tests so we don't need real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Clock seam for the time-to-fill telemetry (ms epoch). Defaults to `Date.now`. */
  clock?: () => number;
  /**
   * TRA-598 (C3) — no-day-trading guardrail config. Defaults to the shipped
   * {@link DAY_TRADING_GUARDRAIL}. The entry-DTE floor is enforced here as a
   * last-line backstop at the broker boundary (the OCC symbol encodes the
   * expiration), so a 0DTE / sub-threshold `buy_to_open` can never reach Tradier
   * even if a caller bypassed the account-level entry gate. Injectable for tests.
   */
  guardrail?: DayTradingGuardrailConfig;
  /** Clock seam for the DTE backstop (ms epoch). Defaults to `Date.now()`. */
  now?: number;
}

/**
 * TRA-374 — fractional walk schedule used by {@link submitSmartBuyToOpen}.
 * Attempt 0 starts at the midpoint biased up by 1¢ so we land just above the
 * mid and bias toward a fill. Subsequent attempts walk a quarter-step toward
 * the ask. Attempt 4 lands exactly at the ask, after which we give up rather
 * than crossing through it.
 *
 * TRA-1601 — this is now the DEFAULT of the configurable ladder; the live
 * schedule comes from {@link resolveMakerWalkConfig}. Kept as a re-export of
 * {@link DEFAULT_MAKER_WALK_FRACTIONS} for the existing unit tests.
 */
export const SMART_BUY_WALK_FRACTIONS: readonly number[] = DEFAULT_MAKER_WALK_FRACTIONS;

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
  // TRA-1601 (A) — the chase ladder is now configurable. Default resolves from
  // env (byte-for-byte TRA-374 unless overridden). An explicit `timeoutMs`
  // still wins over the ladder's `stepWaitMs` for callers that pass one.
  const walkConfig = options.walk ?? resolveMakerWalkConfig();
  const timeoutMs = options.timeoutMs ?? walkConfig.stepWaitMs;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const clock = options.clock ?? Date.now;

  // TRA-598 (C3) — no-day-trading backstop. The OCC symbol encodes the
  // expiration; refuse a sub-threshold-DTE `buy_to_open` before any broker call.
  // A non-OCC symbol (can't parse) skips the check rather than blocking blindly.
  const guardrail = options.guardrail ?? DAY_TRADING_GUARDRAIL;
  const parsed = parseOccSymbol(optionSymbol);
  if (parsed) {
    const dte = dteFromExpiration(parsed.expiration, options.now ?? Date.now());
    const verdict = checkEntryDte(dte ?? Number.NaN, guardrail);
    if (!verdict.allowed) {
      openLog.warn('buy_to_open blocked by no-day-trading guardrail', {
        optionSymbol,
        expiration: parsed.expiration,
        dte,
        reason: verdict.reason,
      });
      return { status: 'rejected', reason: verdict.reason ?? 'no day trading: entry DTE below minimum' };
    }
  }

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

  // TRA-1601 (A) — materialise the full ladder of limit prices up front:
  // the fraction walk (mid → ask) plus any bounded cross-tick steps past the
  // ask. `walkLimits.length === walkConfig.fractions.length` when
  // `maxCrossTicks === 0` (the byte-for-byte TRA-374 default).
  const walkLimits = buildWalkLimits(path, walkConfig);
  const startedAt = clock();
  let lastOrderId: number | undefined;
  let lastLimitPrice = 0;
  for (let attempt = 0; attempt < walkLimits.length; attempt += 1) {
    const limitPrice = roundToCent(walkLimits[attempt]);
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
        timeToFillMs: Math.max(0, clock() - startedAt),
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
 * TRA-1601 (A) — materialise the configured chase ladder into an ordered list
 * of raw (pre-round) limit prices, one per attempt.
 *
 * Mid path (`config.fractions` mid→ask):
 *  - fraction 0 → `mid + min(tick, half-spread)` (the `mid + 1¢` bias step). We
 *    cap the tick bias at half the spread so a 1-tick-wide quote (bid 0.20 /
 *    ask 0.21 → mid 0.205) doesn't jump past the ask on the very first step.
 *  - fraction f (0 < f ≤ 1) → `mid + f × (ask − mid)` (f = 1 lands on the ask).
 *  - then `maxCrossTicks` extra steps at `ask + k × tick` (k = 1…maxCrossTicks)
 *    — the bounded "last resort" that crosses a few ticks past the ask.
 *
 * Ask-only path (one-sided quote — no bid to triangulate a midpoint): every
 * fraction attempt is the ask (the same fill a market buy would produce),
 * preserving the TRA-374 N-identical-ask-submits behaviour, followed by the
 * same cross-tick tail.
 *
 * With the default config (`fractions = [0,0.25,0.5,0.75,1]`, `maxCrossTicks =
 * 0`, `tick = 0.01`) this reproduces the TRA-374 schedule byte-for-byte.
 * Exported for unit tests.
 */
export function buildWalkLimits(path: MidPath | AskOnlyPath, config: MakerWalkConfig): number[] {
  const tick = config.tickSize;
  const limits: number[] = [];
  if (path.kind === 'ask_only') {
    for (let i = 0; i < config.fractions.length; i += 1) limits.push(path.ask);
    for (let k = 1; k <= config.maxCrossTicks; k += 1) limits.push(path.ask + k * tick);
    return limits;
  }
  const mid = (path.bid + path.ask) / 2;
  const halfSpread = (path.ask - path.bid) / 2;
  for (const f of config.fractions) {
    if (f === 0) limits.push(mid + Math.min(tick, Math.max(0, halfSpread)));
    else limits.push(mid + (path.ask - mid) * f);
  }
  for (let k = 1; k <= config.maxCrossTicks; k += 1) limits.push(path.ask + k * tick);
  return limits;
}
