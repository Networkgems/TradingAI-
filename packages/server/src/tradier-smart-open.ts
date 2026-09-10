import {
  type TradierOptionQuote,
  type TradierOptionsClient,
  type TradierOrderDetail,
  // TRA-4483 — TERMINAL, not REJECTED. The walk now has to tell "the broker is
  // done with this order" from "the broker refused it", because a terminal
  // non-fill can still carry an executed slice that must be booked.
  TRADIER_TERMINAL_STATUSES,
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
import {
  resolveOrderQuoteGuardConfig,
  evaluateQuoteFreshness,
  recordOrderGuardOutcome,
  type OrderQuoteGuardConfig,
} from './order-quote-guard.js';
import {
  recordCancelReplaceLatency,
  recordOrderFillOutcome,
} from './execution-quality-telemetry.js';

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
 *  - `partial_fill` → TRA-4483. The walk MEASURED an aggregate fill strictly
 *    between 0 and `requestedQty` and then stopped (ladder exhausted, broker
 *    terminated the order, or the cancel lost the race). A live position
 *    EXISTS at `filledQty` contracts. Voiding here is what TRA-4476 found:
 *    contracts live at the broker with no paper row to close them.
 *  - `halted` → TRA-4483. The walk stopped because the broker's state is not
 *    KNOWABLE, not because it is bad. `confirmedFilledQty` is a LOWER BOUND,
 *    never a measurement — the caller must reconcile against the broker and
 *    must not size anything off it. No replacement was submitted.
 *
 * ## TRA-4483 — the aggregate invariant
 *
 * Every submission after the first is sized `requestedQty − confirmedFilled`,
 * where `confirmedFilled` is the sum of BROKER-CONFIRMED terminal executions
 * (`cancelOrderConfirmed` / a terminal poll), never `detail.exec_quantity` off
 * a still-working order. Combined with "an unconfirmed cancel halts the walk",
 * the aggregate submitted quantity can never exceed `requestedQty`.
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
       * TRA-3990 — bid on the SAME quote pull as `ask`/`mid`, or `null` on the
       * ask-only path. This is the quote the order actually crossed; the caller
       * stamps `entryBidAtOpen`/`entryAskAtOpen`/`entrySpreadPct` from it rather
       * than re-fetching, which would measure a different moment.
       */
      bid: number | null;
      /**
       * TRA-1601 (telemetry) — wall-clock ms from the first order submit to the
       * terminal `filled` poll. Feeds the maker-fill time-to-fill rollup.
       */
      timeToFillMs: number;
      /**
       * TRA-4483 — aggregate contracts the broker confirmed executed, summed
       * across every walk step. On `filled` this equals `requestedQty`.
       */
      filledQty: number;
      /** TRA-4483 — the quantity the caller asked for. */
      requestedQty: number;
    }
  | {
      /**
       * TRA-4483 — a MEASURED aggregate strictly between 0 and `requestedQty`.
       * A position exists. The caller must mirror it at `filledQty`, not void.
       */
      status: 'partial_fill';
      /** The LAST order id of the walk — the one the final slice came from. */
      orderId: number;
      filledQty: number;
      requestedQty: number;
      /** Contracts-weighted average across every filled slice of the walk. */
      avgFillPrice: number;
      /** The limit the last submission carried. */
      limitPrice: number;
      /** 0-indexed walk step the walk ended on. */
      walk: number;
      mid: number | null;
      ask: number;
      bid: number | null;
      timeToFillMs: number;
      /** Why the walk stopped short of the full aggregate. */
      reason: string;
    }
  | {
      /**
       * TRA-4483 — the walk stopped because the broker state is UNKNOWN.
       * Distinct from every other arm: the others are verdicts, this one is the
       * absence of one. No replacement was submitted and none may be.
       */
      status: 'halted';
      orderId: number;
      haltCode: SmartBuyHaltCode;
      reason: string;
      /**
       * Contracts confirmed executed BEFORE the unreadable step. A LOWER BOUND
       * on live exposure, never the exposure itself — the halted order may hold
       * up to `requestedQty − confirmedFilledQty` more.
       */
      confirmedFilledQty: number;
      requestedQty: number;
      lastLimitPrice: number;
    }
  | { status: 'rejected'; orderId?: number; reason: string }
  | { status: 'walk_exhausted'; reason: string; lastLimitPrice: number }
  | { status: 'no_quote'; reason: string };

/**
 * TRA-4483 — why the walk could not get a readable answer about the order it
 * was about to replace. Each of these is "we do not know", and they are kept
 * apart because they need different operator responses:
 *  - `cancel_unknown` — the order never reached a terminal state inside the
 *    cancel window, or its status could not be read at all. It may still be
 *    working AND may still fill.
 *  - `cancel_unmeasured_fill` — the order IS terminal, but the broker reported
 *    no executed quantity. Terminal is not the question; how much executed is,
 *    and an unreported `exec_quantity` is UNMEASURED, never zero (TRA-1707).
 *  - `cancel_threw` — the confirm call itself raised. The DELETE may still have
 *    been served, so this is an unknown, not a "nothing happened".
 */
export type SmartBuyHaltCode = 'cancel_unknown' | 'cancel_unmeasured_fill' | 'cancel_threw';

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
  /**
   * TRA-2045 — order-time quote-freshness guard config. Defaults to
   * {@link resolveOrderQuoteGuardConfig}(process.env) (mode `off` unless the
   * `ENABLE_ORDER_QUOTE_GUARD` env flag is set). Injectable for tests. When the
   * mode is not `off` the helper evaluates the option quote's own timestamp and,
   * in `enforce` mode, rejects a stale/timestamp-less quote before the walk;
   * `shadow` records the counted reason but proceeds.
   */
  quoteGuard?: OrderQuoteGuardConfig;
  /**
   * TRA-4483 — how long {@link TradierOrderClient.cancelOrderConfirmed} may
   * poll for a terminal state before the walk gives up and HALTS. Defaults to
   * the primitive's own 6s. This bound is not a fallback to "assume cancelled":
   * running it out produces `halted`, never a replacement.
   */
  cancelTimeoutMs?: number;
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
  client: Pick<
    TradierOptionsClient,
    | 'getOptionQuote'
    | 'buyContractsLimit'
    // TRA-4483 — `cancelOrderConfirmed`, NOT `cancelOrder`. The walk re-prices
    // over the cancel, so it is exactly the caller `cancelOrder`'s own doc
    // comment says must not use it: that method reports whether the DELETE was
    // ACCEPTED (swallowing 404/422, the two statuses a FILL also produces) and
    // cannot answer the only question the walk has — is the order gone, and how
    // much of it executed first.
    | 'cancelOrderConfirmed'
    | 'waitForOrderTerminalStatus'
  >,
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

  // TRA-2045 — order-time stale-quote gate (parity with the equity path). Off by
  // default (no-op). The option quote carries a broker timestamp only when
  // Tradier stamps `trade_date`; a quote without one records
  // `missing_quote_timestamp`. Enforce mode rejects a stale quote before the
  // walk; shadow records the counted reason and proceeds.
  const quoteGuard = options.quoteGuard ?? resolveOrderQuoteGuardConfig();
  if (quoteGuard.mode !== 'off') {
    const freshness = evaluateQuoteFreshness({
      quoteTimeMs: quote?.quoteTimeMs,
      nowMs: clock(),
      maxQuoteAgeMs: quoteGuard.maxQuoteAgeMs,
    });
    if (freshness.reason) {
      recordOrderGuardOutcome('options', freshness.reason, quoteGuard.mode);
      if (quoteGuard.mode === 'enforce') {
        const ageStr = freshness.ageMs === null ? 'no timestamp' : `${Math.round(freshness.ageMs / 1000)}s old`;
        return {
          status: 'rejected',
          reason: `stale quote at submit (${freshness.reason}, ${ageStr}) — buy_to_open skipped by freshness gate`,
        };
      }
    } else {
      recordOrderGuardOutcome('options', 'passed', quoteGuard.mode);
    }
  }

  // TRA-1601 (A) — materialise the full ladder of limit prices up front:
  // the fraction walk (mid → ask) plus any bounded cross-tick steps past the
  // ask. `walkLimits.length === walkConfig.fractions.length` when
  // `maxCrossTicks === 0` (the byte-for-byte TRA-374 default).
  const walkLimits = buildWalkLimits(path, walkConfig);
  const startedAt = clock();
  let lastOrderId: number | undefined;
  let lastLimitPrice = 0;

  // ⭐ TRA-4483 — THE AGGREGATE. `confirmedFilled` only ever moves on a
  // BROKER-CONFIRMED terminal execution; it is never fed from the telemetry
  // read of a still-working order, which is what `detail.exec_quantity` at the
  // poll site is. Everything below sizes itself off this and nothing else.
  let confirmedFilled = 0;
  // Σ (slice qty × slice price), so the reported average is contracts-weighted
  // across steps rather than "whatever the last slice happened to print".
  let filledNotional = 0;
  const mid = path.kind === 'mid' ? (path.bid + path.ask) / 2 : null;
  const bid = path.kind === 'mid' ? path.bid : null;

  /** Book a broker-confirmed slice, clamped so the aggregate can never exceed the request. */
  const bookSlice = (rawQty: number, rawPrice: number | undefined, limitPrice: number): number => {
    const room = qty - confirmedFilled;
    const slice = Math.min(Math.max(0, rawQty), Math.max(0, room));
    if (!(slice > 0)) return 0;
    // Same fallback the `filled` arm has always used: an unreported
    // `avg_fill_price` prices the slice at the limit we submitted. The QUANTITY
    // is what must never be guessed; the price has a defensible substitute.
    const price = typeof rawPrice === 'number' && Number.isFinite(rawPrice) && rawPrice > 0 ? rawPrice : limitPrice;
    confirmedFilled += slice;
    filledNotional += slice * price;
    return slice;
  };
  const avgFillPrice = (): number => (confirmedFilled > 0 ? filledNotional / confirmedFilled : 0);
  /**
   * The walk is over and `confirmedFilled > 0`. A COMPLETE aggregate is a
   * `filled`; anything short of it is a `partial_fill` — never a `filled` that
   * silently under-delivers, and never a `walk_exhausted` that pretends the
   * contracts are not there.
   */
  const settle = (orderId: number, limitPrice: number, attempt: number, reason: string): SmartBuyOutcome =>
    confirmedFilled >= qty
      ? {
          status: 'filled',
          orderId,
          avgFillPrice: avgFillPrice(),
          limitPrice,
          walk: attempt,
          mid,
          ask: path.ask,
          bid,
          timeToFillMs: Math.max(0, clock() - startedAt),
          filledQty: confirmedFilled,
          requestedQty: qty,
        }
      : {
          status: 'partial_fill',
          orderId,
          filledQty: confirmedFilled,
          requestedQty: qty,
          avgFillPrice: avgFillPrice(),
          limitPrice,
          walk: attempt,
          mid,
          ask: path.ask,
          bid,
          timeToFillMs: Math.max(0, clock() - startedAt),
          reason,
        };

  for (let attempt = 0; attempt < walkLimits.length; attempt += 1) {
    // ⭐ TRA-4483 (AC1) — THE REPLACEMENT IS NET OF WHAT ALREADY EXECUTED.
    // Before this, every step re-submitted the full `qty`, so a step that
    // filled 4 of 10 and then cancelled was followed by a fresh order for 10.
    const remainingQty = qty - confirmedFilled;
    if (remainingQty <= 0) break; // aggregate complete — settled below
    const limitPrice = roundToCent(walkLimits[attempt]);
    // Tradier rejects limit prices ≤ 0 on equity options; bail with no_quote
    // instead of submitting a doomed order.
    if (!Number.isFinite(limitPrice) || limitPrice <= 0) {
      // TRA-4483 — a bail AFTER a confirmed slice is not "no position exists".
      if (confirmedFilled > 0 && lastOrderId !== undefined) {
        return settle(lastOrderId, lastLimitPrice, attempt - 1, 'unusable limit price mid-walk');
      }
      return {
        status: 'no_quote',
        reason: 'No quote available — refusing market buy on dead contract.',
      };
    }
    lastLimitPrice = limitPrice;

    let order;
    const submitStart = clock();
    try {
      // TRA-4483 — `remainingQty`, not `qty`.
      order = await client.buyContractsLimit(optionSymbol, remainingQty, limitPrice);
    } catch (err: unknown) {
      // TRA-4483 — a throw on the REPLACEMENT leg leaves the earlier confirmed
      // slices live. Reporting `rejected` here voided them.
      if (confirmedFilled > 0 && lastOrderId !== undefined) {
        return settle(
          lastOrderId,
          lastLimitPrice,
          attempt - 1,
          `replacement submit threw: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
      return {
        status: 'rejected',
        reason: err instanceof Error ? err.message : String(err),
        ...(lastOrderId !== undefined ? { orderId: lastOrderId } : {}),
      };
    }
    // TRA-2046 — a re-submit after a cancelled prior step IS the "replace" leg of
    // the maker walk; capture its submit->ack latency (attempt 0 is the initial
    // submit, not a replace, so it is not counted).
    if (attempt > 0) {
      recordCancelReplaceLatency({
        engine: 'options',
        side: 'open',
        kind: 'replace',
        latencyMs: Math.max(0, clock() - submitStart),
      });
    }
    lastOrderId = order.id;
    const detail: TradierOrderDetail | null = await client.waitForOrderTerminalStatus(order.id, {
      timeoutMs,
      sleep,
    });
    const status = detail?.status ?? '';
    const terminal = TRADIER_TERMINAL_STATUSES.has(status);
    // TRA-2046 — partial-fill telemetry. Record only when the broker reported a
    // finite executed quantity; an omitted exec_quantity is UNMEASURED, never a
    // false-zero fill (TRA-1707). TRA-4483 — `orderedQty` is this STEP's size.
    if (detail && typeof detail.exec_quantity === 'number' && Number.isFinite(detail.exec_quantity)) {
      recordOrderFillOutcome({
        engine: 'options',
        side: 'open',
        orderedQty: remainingQty,
        execQty: detail.exec_quantity,
      });
    }
    // ⛔ TRA-4483 — `exec_quantity` is only booked into the aggregate when the
    // order is TERMINAL. On a still-working order it is a running figure that
    // the cancel confirmation below supersedes; adding it here and again there
    // would double-count the same contracts and under-size the replacement.
    const stepExec =
      detail && typeof detail.exec_quantity === 'number' && Number.isFinite(detail.exec_quantity)
        ? detail.exec_quantity
        : null;

    if (status === 'filled') {
      // A `filled` status with no `exec_quantity` means the whole step filled —
      // the status IS the measurement there, so `remainingQty` is not a guess.
      bookSlice(stepExec !== null && stepExec > 0 ? stepExec : remainingQty, detail?.avg_fill_price, limitPrice);
      return settle(order.id, limitPrice, attempt, 'broker filled the step');
    }
    if (terminal) {
      // TRA-4483 — a rejected-family TERMINAL state (canceled / expired /
      // rejected / error) can still carry a non-zero `exec_quantity`: the
      // broker filled PART of the step before terminating it. That slice is a
      // real position. This branch used to return `rejected` unconditionally,
      // and the caller voided the paper open on top of live contracts — the
      // same leak TRA-416 fixed on the close side.
      if (stepExec !== null && stepExec > 0) bookSlice(stepExec, detail?.avg_fill_price, limitPrice);
      if (confirmedFilled > 0) {
        return settle(order.id, limitPrice, attempt, detail?.reason_description?.trim() || status);
      }
      return {
        status: 'rejected',
        orderId: order.id,
        reason: detail?.reason_description?.trim() || status,
      };
    }

    // ⭐ TRA-4483 (AC2/AC3) — STILL WORKING. The walk is about to RE-PRICE this
    // order, so "did the DELETE get a 2xx" is the wrong question and always was:
    // `cancelOrder` swallowed 404/422, which are exactly the statuses a FILLED
    // order returns. The verdict now comes from the order's own terminal state.
    const cancelStart = clock();
    let cancelOutcome;
    try {
      cancelOutcome = await client.cancelOrderConfirmed(order.id, {
        timeoutMs: options.cancelTimeoutMs,
        sleep,
      });
    } catch (err) {
      // A confirm that RAISED may still have served its DELETE. Unknown, and an
      // unknown must never be re-priced over.
      openLog.error('cancelOrderConfirmed threw during smart-open walk — HALTING', {
        orderId: order.id,
        optionSymbol,
        confirmedFilled,
        requestedQty: qty,
        reason: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 'halted',
        orderId: order.id,
        haltCode: 'cancel_threw',
        reason: `cancel confirmation threw: ${err instanceof Error ? err.message : String(err)}`,
        confirmedFilledQty: confirmedFilled,
        requestedQty: qty,
        lastLimitPrice: limitPrice,
      };
    }

    if (cancelOutcome.kind === 'unknown') {
      // ⛔ THE DEFECT THIS TICKET IS NAMED FOR. The old comment here read
      // "Best-effort cleanup; the next limit submission still proceeds." — the
      // walk re-priced over a cancel it never confirmed, so a live limit and its
      // replacement could both be working, and both could fill.
      openLog.error('smart-open cancel unconfirmed — HALTING rather than re-pricing', {
        orderId: order.id,
        optionSymbol,
        reason: cancelOutcome.reason,
        ackStatus: cancelOutcome.ackStatus,
        ackError: cancelOutcome.ackError,
        confirmedFilled,
        requestedQty: qty,
      });
      return {
        status: 'halted',
        orderId: order.id,
        haltCode: 'cancel_unknown',
        reason: `cancel not confirmed (${cancelOutcome.reason}) — walk halted rather than re-pricing over a live order`,
        confirmedFilledQty: confirmedFilled,
        requestedQty: qty,
        lastLimitPrice: limitPrice,
      };
    }

    // TRA-2046 — cancel->ack latency, recorded only on a CONFIRMED terminal
    // outcome (an unknown is not an ack, so it must not enter the rollup).
    recordCancelReplaceLatency({
      engine: 'options',
      side: 'open',
      kind: 'cancel',
      latencyMs: Math.max(0, clock() - cancelStart),
    });

    if (cancelOutcome.filledQty === null) {
      // Terminal, but the broker did not say how much executed. Terminal is not
      // the question; the size of the replacement is, and `null` is UNMEASURED,
      // never zero (TRA-1707). Sizing off it would be a guess in the one
      // direction that can overshoot the request.
      openLog.error('smart-open cancel confirmed terminal but exec quantity UNMEASURED — HALTING', {
        orderId: order.id,
        optionSymbol,
        terminalKind: cancelOutcome.kind,
        confirmedFilled,
        requestedQty: qty,
      });
      return {
        status: 'halted',
        orderId: order.id,
        haltCode: 'cancel_unmeasured_fill',
        reason: `order reached '${cancelOutcome.kind}' but the broker reported no executed quantity — cannot size a replacement`,
        confirmedFilledQty: confirmedFilled,
        requestedQty: qty,
        lastLimitPrice: limitPrice,
      };
    }

    bookSlice(cancelOutcome.filledQty, cancelOutcome.detail?.avg_fill_price, limitPrice);

    if (cancelOutcome.kind === 'filled') {
      // ⭐ AC3 — THE CANCEL LOST THE RACE. The order is done. There is nothing
      // to replace and replacing it doubles the position; return here without
      // ever reaching the next `buyContractsLimit`.
      return settle(order.id, limitPrice, attempt, 'cancel lost the race — order filled');
    }
    if (confirmedFilled >= qty) {
      // Confirmed slices completed the aggregate across steps.
      return settle(order.id, limitPrice, attempt, 'aggregate completed across walk steps');
    }
    // `canceled`, partial-or-nothing, aggregate still short → the next iteration
    // sizes itself off the updated `confirmedFilled`.
  }

  // TRA-4483 — the ladder ran out. If slices executed along the way, a position
  // EXISTS; `walk_exhausted` means "nothing filled" to every caller and voiding
  // on it is what leaves contracts live with no paper row.
  if (confirmedFilled > 0 && lastOrderId !== undefined) {
    return settle(lastOrderId, lastLimitPrice, walkLimits.length - 1, 'Tradier LIMIT walk to ask exhausted');
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
