import type { Side } from '@trading-app/shared';
import {
  type IntentReconcileVerdict,
  type LatchReason,
  type OrderIntent,
  type OrderListRead,
  type ReconcilableOrderRow,
  type UnknownSubmitReason,
  getOrderIntentJournal,
  getUnknownIntentBreaker,
  intentBreakerKey,
  newIntentId,
  reconcileIntent,
  shapeFromOrderBody,
} from './order-intent.js';

export type TradierEnv = 'sandbox' | 'production';

export interface TradierBracketOrderParams {
  symbol: string;
  qty: number;
  side: Side;
  limitPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}

export interface TradierOrderResponse {
  id: number;
  status: string;
  partner_id?: string;
}

/**
 * TRA-4218 — an order submit that did not reach a broker DECISION.
 *
 * `postOrder` used to throw a bare `Error` for every non-2xx, which made a
 * Tradier 500 ("An error occurred while communicating with the backend")
 * indistinguishable at the catch site from a 400-class refusal. The exit path
 * counted both onto `closeRejectCount`, so three seconds of broker backend
 * trouble tripped the TRA-450 auto-close breaker and PERMANENTLY detached the
 * stop from a live position: the counter is persisted in the account snapshot
 * and its only two clear sites are a fill (unreachable — the engine has stopped
 * submitting) and a human pressing Close. On 2026-08-31 that stranded all three
 * open real-money rows, two of them already through their stop.
 *
 * `kind` is the classification the caller needs and MUST NOT be re-derived by
 * string-matching the message:
 *  - `transport` — 5xx, 429, or a network-level failure. The broker never
 *    decided. Retry is correct; consuming a refusal budget is not.
 *  - `refused` — 4xx, or a 2xx envelope carrying `errors.error`. The broker
 *    looked at the order and said no. This is what the TRA-450 breaker counts.
 *  - `malformed` — a 2xx with no `order` payload. Neither of the above.
 *
 * The `message` format is unchanged on purpose: `exitErrorReason` strings from
 * it are already on persisted rows and on the dashboard.
 *
 * ---
 *
 * TRA-4476 — **`kind` answers the BUDGET question. It does NOT answer the
 * EXPOSURE question, and it was being read as though it did.**
 *
 * The `transport` docblock above asserts the broker "never decided". For the
 * purpose it was written for — should this consume the TRA-450 refusal budget —
 * that is right, and every `kind` value below is byte-for-byte what TRA-4218
 * shipped. But a socket can reset, and a 500 can be returned, *after* Tradier has
 * accepted the order. So `transport` does not license a resubmit, and it was
 * being used as if it did.
 *
 * {@link outcome} is the second, orthogonal axis:
 *
 *  - `refused` — the broker read the order and declined it. **Provably no order
 *    exists.** Only a 4xx or an `errors` envelope earns this.
 *  - `not_placed` — the broker did not decide, AND a reconcile against
 *    `/accounts/{id}/orders` positively demonstrated our order is absent from a
 *    list that provably covers our submit instant. Resubmit is safe.
 *  - `unknown` — an order may exist. Resubmit of this shape is HALTED until a
 *    reconcile resolves it. See `order-intent.ts`.
 *
 * A failure is routinely `kind: 'transport'` (do not count a refusal) **and**
 * `outcome: 'unknown'` (do not resubmit) at once. Collapsing them onto one axis
 * is what let the ladder retry into a live order.
 */
export class TradierOrderError extends Error {
  readonly kind: 'transport' | 'refused' | 'malformed';

  readonly status?: number;

  /** TRA-4476 — the exposure axis. See the class docblock. */
  readonly outcome: 'refused' | 'not_placed' | 'unknown';

  /** TRA-4476 — the durable intent this submit was journalled under. */
  readonly intentId?: string;

  /** TRA-4476 — populated when `outcome` is `unknown`: where we lost sight. */
  readonly unknownReason?: UnknownSubmitReason;

  /** TRA-4476 — the reconcile verdict, when one was reached. */
  readonly reconcile?: IntentReconcileVerdict;

  constructor(
    message: string,
    kind: 'transport' | 'refused' | 'malformed',
    status?: number,
    detail: {
      outcome?: 'refused' | 'not_placed' | 'unknown';
      intentId?: string;
      unknownReason?: UnknownSubmitReason;
      reconcile?: IntentReconcileVerdict;
      cause?: unknown;
    } = {},
  ) {
    super(message);
    this.name = 'TradierOrderError';
    this.kind = kind;
    this.status = status;
    // Default the exposure axis off the budget axis so an error minted by older
    // code (or a test) is never silently treated as "provably nothing happened":
    // only an explicit `refused` kind maps to a provable no-order.
    this.outcome = detail.outcome ?? (kind === 'refused' ? 'refused' : 'unknown');
    this.intentId = detail.intentId;
    this.unknownReason = detail.unknownReason;
    this.reconcile = detail.reconcile;
    if (detail.cause !== undefined) (this as { cause?: unknown }).cause = detail.cause;
  }
}

/**
 * TRA-4218 — classify a thrown submit. Returns true when the failure must NOT
 * consume a rejection budget.
 *
 * Defaults to `false` for anything unrecognised: an unknown throw is treated as
 * a refusal, which is the conservative side FOR THE BUDGET (it can only stop us
 * trading, never make us spray orders at a broker that is refusing them).
 *
 * ⚠ TRA-4476 — **this is not the "is it safe to resubmit" predicate and never
 * was.** Its `true` answer means "the broker did not refuse", which is a
 * strictly weaker claim than "no order exists". Read
 * {@link TradierOrderError.outcome} for that question; `'not_placed'` is the
 * only value that licenses a resubmit, and reaching it costs a broker round trip
 * the caller does not have to make (`postOrder` has already made it).
 */
export function isTransportOrderFailure(err: unknown): boolean {
  if (err instanceof TradierOrderError) return err.kind === 'transport';
  // `fetch` itself failing (DNS, TLS, socket reset, abort) never reached the
  // broker either. Node surfaces these as a bare `TypeError: fetch failed`.
  if (err instanceof TypeError) return true;
  return false;
}

/**
 * TRA-4476 — is it safe to submit this order again?
 *
 * The predicate `isTransportOrderFailure` was standing in for, incorrectly.
 * Answers `false` for anything it does not positively recognise as safe.
 */
export function isSafeToResubmit(err: unknown): boolean {
  if (!(err instanceof TradierOrderError)) return false;
  return err.outcome === 'refused' || err.outcome === 'not_placed';
}

/**
 * TRA-4218 — an HTTP status the broker returned WITHOUT deciding on the order.
 * 5xx is the observed case (500 backend error); 429 and 408 are the same shape
 * — the request was shed, not refused.
 */
function isTransportStatus(status: number): boolean {
  return status >= 500 || status === 429 || status === 408;
}

/**
 * TRA-319 — full order detail returned by `/accounts/{id}/orders/{order_id}`.
 * `status` transitions through `open`/`pending` and lands on a terminal state
 * (`filled`, `canceled`, `rejected`, `expired`, `error`). `reason_description`
 * is populated by Tradier when the order is rejected/canceled (e.g. the
 * "insufficient buying power" string the user sees in their dashboard).
 */
export interface TradierOrderDetail {
  id: number;
  status: string;
  reason_description?: string;
  exec_quantity?: number;
  remaining_quantity?: number;
  avg_fill_price?: number;
}

/** TRA-319 — terminal Tradier order states (no further transitions expected). */
export const TRADIER_TERMINAL_STATUSES = new Set<string>([
  'filled',
  'canceled',
  'rejected',
  'expired',
  'error',
]);

/** TRA-319 — terminal states that mean the order did NOT result in a fill. */
export const TRADIER_REJECTED_STATUSES = new Set<string>([
  'canceled',
  'rejected',
  'expired',
  'error',
]);

interface TradierOrderEnvelope {
  order?: (TradierOrderResponse & TradierOrderDetail) & {
    errors?: { error: string | string[] };
    // TRA-416 — Tradier's cumulative filled-quantity field is `exec_quantity`
    // on the REST `/orders/{id}` payload, but the account-event / streaming
    // shapes surface the same number as `last_fill_quantity` / `fill_quantity`.
    // Declared here so `getOrderStatus` can coalesce whichever the broker sent.
    last_fill_quantity?: number;
    fill_quantity?: number;
  };
  errors?: { error: string | string[] };
}

/**
 * TRA-416 — return the first finite number from the candidates, or `undefined`
 * when none qualify. Used to coalesce Tradier's filled-quantity field, which
 * the broker names `exec_quantity` on the order-status payload but
 * `last_fill_quantity` / `fill_quantity` on other order shapes.
 */
function firstFiniteNumber(...values: unknown[]): number | undefined {
  for (const v of values) {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/**
 * TRA-415 — open equity (stock) position imported from Tradier's
 * `/accounts/{id}/positions` endpoint. That endpoint returns equity and
 * option rows together; option legs are dropped at the parser by symbol
 * shape (OCC option symbols decode, plain tickers don't). Holds the
 * minimum the engine's live equity mirror needs to surface the position.
 */
export interface TradierOpenEquityPosition {
  /** Plain equity ticker (e.g. `AAPL`). */
  symbol: string;
  /** Shares held. Always positive — `side` carries the long/short sign. */
  quantity: number;
  /** `'buy'` for a long position, `'sell'` for a short. */
  side: Side;
  /** Per-share cost basis (Tradier `cost_basis` ÷ shares). */
  costBasis: number;
  /** When Tradier acquired the position (ms epoch); falls back to `Date.now()`. */
  acquiredAt: number;
  /** Tradier's numeric position id, when the API surfaces one. */
  tradierPositionId?: number;
}

/** Raw shape of a single row in the Tradier `/positions` envelope. */
interface TradierRawPositionRow {
  symbol?: unknown;
  quantity?: unknown;
  cost_basis?: unknown;
  date_acquired?: unknown;
  id?: unknown;
}

/** Tradier returns `T | T[]`, sometimes `null`/empty string when there are none. */
interface TradierRawPositionsEnvelope {
  positions?:
    | { position?: TradierRawPositionRow | TradierRawPositionRow[] }
    | string
    | null;
}

/**
 * Matches an OCC option symbol — ROOT (1-6 letters) + YYMMDD + C/P +
 * 8-digit strike. Equity tickers never match, so a non-match is the
 * discriminator that keeps option legs out of the equity parser.
 */
const OCC_OPTION_SYMBOL = /^[A-Z]{1,6}\d{6}[CP]\d{8}$/;

/**
 * TRA-415 — normalise the Tradier `/accounts/{id}/positions` envelope into
 * a list of open equity positions. Exported so unit tests can exercise the
 * parser without mocking `fetch`. Drops option legs (their OCC symbols
 * match {@link OCC_OPTION_SYMBOL}), zero-quantity rows, and any row whose
 * symbol / quantity / cost basis can't be coerced — we'd rather omit a row
 * than poison the live equity mirror with garbage. A negative `quantity`
 * is a short position; it surfaces as `side: 'sell'` with a positive
 * `quantity` so downstream consumers don't have to special-case the sign.
 */
export function parseTradierEquityPositions(
  envelope: TradierRawPositionsEnvelope | null,
): TradierOpenEquityPosition[] {
  if (!envelope || typeof envelope.positions !== 'object' || envelope.positions == null) {
    return [];
  }
  const raw = envelope.positions.position;
  const rows = raw == null ? [] : Array.isArray(raw) ? raw : [raw];
  const out: TradierOpenEquityPosition[] = [];
  for (const row of rows) {
    if (typeof row.symbol !== 'string' || row.symbol === '') continue;
    // Option legs decode as OCC symbols — they go through the options path.
    if (OCC_OPTION_SYMBOL.test(row.symbol)) continue;
    if (typeof row.quantity !== 'number' || !Number.isFinite(row.quantity) || row.quantity === 0) {
      continue;
    }
    if (typeof row.cost_basis !== 'number' || !Number.isFinite(row.cost_basis)) continue;
    const shares = Math.abs(row.quantity);
    const costBasis = Math.abs(row.cost_basis) / shares;
    if (!Number.isFinite(costBasis) || costBasis <= 0) continue;
    const acquiredMs = Date.parse(String(row.date_acquired));
    out.push({
      symbol: row.symbol,
      quantity: shares,
      side: row.quantity > 0 ? 'buy' : 'sell',
      costBasis,
      acquiredAt: Number.isFinite(acquiredMs) ? acquiredMs : Date.now(),
      ...(typeof row.id === 'number' ? { tradierPositionId: row.id } : {}),
    });
  }
  return out;
}

/**
 * TRA-1269 — a single child leg of an OTOCO/OCO order as returned by
 * `/accounts/{id}/orders/{order_id}`. Once an OTOCO's entry fills, Tradier
 * exposes the take-profit and stop-loss as `leg[]` entries, each with its OWN
 * order `id`. To trail a live equity stop we must modify the STOP leg by its
 * leg id (not the OTOCO parent id), so we surface the minimum needed to pick it.
 */
export interface TradierOrderLeg {
  /** The leg's own order id — the handle used to cancel/modify just this leg. */
  id: number;
  /** `limit` (take-profit), `stop` (stop-loss), `market`, … */
  type: string;
  /** Close side of the leg (`buy`/`sell`); undefined when Tradier omits it. */
  side?: string;
  /** Leg lifecycle: `open`/`pending`/`filled`/`canceled`/… (lowercased). */
  status: string;
  /** Resting stop price on a `stop`/`stop_limit` leg, when present. */
  stopPrice?: number;
}

interface TradierRawLeg {
  id?: unknown;
  type?: unknown;
  side?: unknown;
  status?: unknown;
  stop_price?: unknown;
}

interface TradierOrderWithLegsEnvelope {
  order?: {
    id?: unknown;
    leg?: TradierRawLeg | TradierRawLeg[];
  };
}

/**
 * TRA-1269 — normalise the `leg[]` array off a Tradier order-status envelope
 * into typed legs. Exported so the stop-leg picker is unit-testable without
 * mocking `fetch`. Tradier returns `leg` as a single object when there is one
 * leg and an array when there are several; rows whose `id` can't be coerced are
 * dropped (we'd rather omit a leg than modify the wrong order id).
 */
export function parseTradierOrderLegs(
  envelope: TradierOrderWithLegsEnvelope | null,
): TradierOrderLeg[] {
  const raw = envelope?.order?.leg;
  if (raw == null) return [];
  const rows = Array.isArray(raw) ? raw : [raw];
  const out: TradierOrderLeg[] = [];
  for (const row of rows) {
    if (typeof row.id !== 'number' || !Number.isFinite(row.id)) continue;
    out.push({
      id: row.id,
      type: typeof row.type === 'string' ? row.type.toLowerCase() : '',
      side: typeof row.side === 'string' ? row.side.toLowerCase() : undefined,
      status: typeof row.status === 'string' ? row.status.toLowerCase() : '',
      stopPrice:
        typeof row.stop_price === 'number' && Number.isFinite(row.stop_price)
          ? row.stop_price
          : undefined,
    });
  }
  return out;
}

const SANDBOX_BASE = 'https://sandbox.tradier.com/v1';
const PROD_BASE = 'https://api.tradier.com/v1';

export function tradierBaseUrl(env: TradierEnv): string {
  return env === 'production' ? PROD_BASE : SANDBOX_BASE;
}

/**
 * TRA-3939 — one order id, observed AT SUBMIT, before and independent of any fill.
 *
 * ## Why this hook is at `postOrder` and not at the caller
 *
 * TRA-3932 measured that the broker order id reaches disk in exactly ONE place,
 * `live-options-fee-slippage.jsonl`, and only at **FILL** time — so an order we
 * placed whose fill the chokepoint missed leaves no id anywhere, and "absent from
 * our records" cannot refute engine origin.
 *
 * The obvious remedy — record `outcome.orderId` where the signal engine already
 * branches on the smart-open result — is **wrong, in the direction that
 * manufactures a false accusation**. {@link submitSmartBuyToOpen} walks a limit
 * ladder: it POSTs an order, waits, CANCELS it, and POSTs another at the next
 * price, up to five times. Each of those is a real order at the broker with its
 * own id, and each will appear in `/accounts/{id}/orders` as `canceled`. But the
 * outcome type carries an id only on `filled` and `rejected` — a `walk_exhausted`
 * outcome returns **no id at all**, having minted up to five. Recording only the
 * outcome's id would leave those cancelled steps absent from our set, and a later
 * provenance read would charge every one of them to the desk.
 *
 * `postOrder` is the only place every id is visible exactly once. It is also the
 * only place that is structurally exhaustive: a future submit path added anywhere
 * on this client is observed without being taught to observe itself.
 *
 * ⚠ **What this CANNOT capture, stated rather than implied.** `postOrder` throws
 * before returning when Tradier refuses at POST time (non-2xx, or an `errors`
 * envelope — the 2026-08-20 `Account is restricted for option trading.` shape).
 * No order was created and no id exists, so there is nothing to record and the
 * absence is not a gap in this instrument. What IS captured is every order the
 * broker ACKNOWLEDGED: the fills, the walk steps we cancelled, and the orders
 * that reached a terminal `rejected`/`expired`/`canceled` status after the ack.
 */
export interface TradierOrderSubmitEvent {
  /** The broker's id for the order it just acknowledged — the join key. */
  orderId: number;
  /** Tradier's status AT ACK (`ok`/`open`/`pending`), not a terminal state. */
  ackStatus: string;
  /** `production` vs `sandbox`. The provenance question is only ever about real money. */
  env: TradierEnv;
  accountId: string;
  /** `option` / `equity` / `multileg` / `otoco` — read off the submitted body. */
  orderClass: string | null;
  side: string | null;
  symbol: string | null;
  /** OCC contract when the body carried one (`option_symbol`, or leg 0 of a multileg). */
  optionSymbol: string | null;
  quantity: number | null;
  limitPrice: number | null;
  submittedAt: number;
}

export type TradierOrderSubmitObserver = (event: TradierOrderSubmitEvent) => void;

let orderSubmitObserver: TradierOrderSubmitObserver | null = null;

/**
 * Install the process-wide submit observer. `null` uninstalls (test seam).
 *
 * A module-level singleton rather than a constructor arg on purpose: clients are
 * built ad hoc in a dozen places (per operator, per env, per route), and a
 * per-client opt-in would silently miss whichever construction site nobody
 * remembered — which is precisely the class of gap this exists to close.
 */
export function setTradierOrderSubmitObserver(observer: TradierOrderSubmitObserver | null): void {
  orderSubmitObserver = observer;
}

/** Read back what is installed. Lets a health route publish `armed:false` rather than assume. */
export function getTradierOrderSubmitObserver(): TradierOrderSubmitObserver | null {
  return orderSubmitObserver;
}

/** First present value among `keys`, as a trimmed string, else `null`. */
function bodyString(body: URLSearchParams, ...keys: string[]): string | null {
  for (const k of keys) {
    const v = body.get(k);
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return null;
}

function bodyNumber(body: URLSearchParams, ...keys: string[]): number | null {
  const s = bodyString(body, ...keys);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * TRA-4476 — the confirmed outcome of {@link TradierOrderClient.cancelOrderConfirmed}.
 *
 * `ackStatus` / `ackError` record what the DELETE itself did. They are kept for
 * the operator and are deliberately NOT part of the verdict: the whole point of
 * this type is that the DELETE's status code does not decide anything.
 */
export type TradierCancelOutcome =
  | {
      kind: 'canceled';
      /** The terminal state actually reached: `canceled` / `rejected` / `expired` / `error`. */
      terminalStatus: string;
      ackStatus: number | null;
      ackError: string | null;
      detail: TradierOrderDetail;
      /** Executed before the cancel landed. `null` = UNMEASURED, never zero. */
      filledQty: number | null;
    }
  | {
      kind: 'filled';
      ackStatus: number | null;
      ackError: string | null;
      detail: TradierOrderDetail;
      filledQty: number | null;
    }
  | {
      kind: 'unknown';
      reason: 'still_working' | 'status_unreadable';
      ackStatus: number | null;
      ackError: string | null;
      detail: TradierOrderDetail | null;
      filledQty: null;
    };

/**
 * TRA-4476 — the outcome of a submit, as a value rather than a return-or-throw.
 *
 * `postOrder` keeps its throwing contract (every caller in the tree depends on
 * it), so this is what {@link TradierOrderClient.submitOrderWithOutcome} returns
 * for callers that want to branch instead of catch.
 */
export type TradierSubmitOutcome =
  | {
      kind: 'acknowledged';
      order: TradierOrderResponse;
      intent: OrderIntent;
      /**
       * True when the ack did not come from the POST response but was RECOVERED
       * by reconciling a lost response against the broker's order list. The order
       * is just as real; the flag exists so the operator can see it happened.
       */
      recovered: boolean;
    }
  | { kind: 'refused'; error: TradierOrderError; intent: OrderIntent }
  | { kind: 'not_placed'; error: TradierOrderError; intent: OrderIntent }
  | { kind: 'unknown'; error: TradierOrderError; intent: OrderIntent; latchReason: LatchReason };

/**
 * TRA-4476 — how long a submit POST may hang before we abort it.
 *
 * There was no bound at all: a submit that hung held the tick forever and had no
 * outcome, unknown or otherwise. 15s is well past Tradier's observed risk-check
 * pipeline (<2s per TRA-319) so a healthy order is never cut off, and an abort
 * lands in `unknown` — never in "nothing happened" — so the bound cannot itself
 * manufacture a duplicate.
 */
export const TRADIER_SUBMIT_TIMEOUT_MS = 15_000;

/**
 * TRA-4476 — did a reconciled order actually put on exposure?
 *
 * `terminal` alone is not the question. A terminal `canceled` order left nothing
 * behind and the shape is free; a terminal `filled` one IS a position, and
 * treating the two the same is how releasing a halt turns into a second order on
 * top of a realised fill.
 *
 * A reported `exec_quantity` of zero is a real zero here (the broker answered);
 * an UNREPORTED one is `null` and must not be read as zero (TRA-1707), so it
 * counts as a fill for the purpose of holding back — the cautious direction.
 */
function reconcileFoundAFill(verdict: IntentReconcileVerdict): boolean {
  if (verdict.kind !== 'placed') return false;
  if (verdict.rows.some((r) => r.status.trim().toLowerCase() === 'filled')) return true;
  if (verdict.filledQty === null) return true; // unmeasured ⇒ assume exposure
  return verdict.filledQty > 0;
}

export interface PostOrderOptions {
  /** Override {@link TRADIER_SUBMIT_TIMEOUT_MS}. Tests pass a short one. */
  timeoutMs?: number;
  /** Clock seam. */
  now?: () => number;
  /** Broker-vs-local clock skew tolerance for the reconcile window. */
  clockSkewMs?: number;
}

export class TradierOrderClient {
  protected readonly baseUrl: string;
  protected readonly accountId: string;
  protected readonly headers: Record<string, string>;
  /** TRA-3939 — kept so the submit observer can separate real money from sandbox. */
  protected readonly env: TradierEnv;

  constructor(apiToken: string, accountId: string, env: TradierEnv = 'sandbox') {
    this.baseUrl = tradierBaseUrl(env);
    this.accountId = accountId;
    this.env = env;
    this.headers = {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    };
  }

  /**
   * Tradier does not natively bundle take-profit/stop-loss with a market entry on
   * a single equity order, so we submit a primary OTOCO bracket: limit entry with
   * an OCO pair of take-profit (limit) and stop-loss (stop).
   */
  async submitBracketOrder(params: TradierBracketOrderParams): Promise<TradierOrderResponse> {
    // Tradier OTOCO orders are multileg: the underlying symbol and duration are
    // specified PER LEG (`symbol[n]` / `duration[n]`), not once at the top level,
    // and equity legs must NOT carry an `option_symbol[n]`. Sending a single
    // top-level `symbol` makes Tradier reject the order with
    // "Invalid parameter, symbol: is not valid" (TRA-553 sandbox validation).
    // Entry is `day`; the protective OCO legs are `gtc` so take-profit/stop-loss
    // stay working until one fills and cancels the other (a position can be held
    // past the session).
    const closeSide = params.side === 'buy' ? 'sell' : 'buy';
    const body = new URLSearchParams({
      class: 'otoco',
      // Leg 0 — entry (limit)
      'symbol[0]': params.symbol,
      'side[0]': params.side,
      'quantity[0]': String(params.qty),
      'type[0]': 'limit',
      'duration[0]': 'day',
      'price[0]': params.limitPrice.toFixed(2),
      // Leg 1 — take profit (limit close), OCO with leg 2
      'symbol[1]': params.symbol,
      'side[1]': closeSide,
      'quantity[1]': String(params.qty),
      'type[1]': 'limit',
      'duration[1]': 'gtc',
      'price[1]': params.takeProfitPrice.toFixed(2),
      // Leg 2 — stop loss (stop close), OCO with leg 1
      'symbol[2]': params.symbol,
      'side[2]': closeSide,
      'quantity[2]': String(params.qty),
      'type[2]': 'stop',
      'duration[2]': 'gtc',
      'stop[2]': params.stopLossPrice.toFixed(2),
    });

    return this.postOrder(body);
  }

  /**
   * ⚠ TRA-4476 — **this method cannot tell you the order is gone.** It reports
   * whether the DELETE was *accepted*, and it swallows 404 and 422 as success.
   *
   * 404/422 were believed to be the statuses Tradier returns when the order
   * terminated between our last poll and this call — and "terminated" includes
   * **`filled`**. Treating them as a successful cancel is how a partially- or
   * fully-filled order gets replaced by a fresh full-quantity order and the
   * aggregate exposure ends up above what was requested.
   *
   * ⚠ **TRA-4484 measured the sandbox on 2026-09-10 and Tradier returns NEITHER
   * of those codes.** The observed matrix (`scripts/tra4484-tradier-sandbox-semantics.mjs`,
   * raw run in `docs/tra4484-tradier-sandbox-semantics.md`):
   *
   *   working order          → **200** `{"order":{"id":N,"status":"ok"}}`
   *   already-terminal order → **400** `order already in finalized state: canceled`
   *   order id that is not ours (incl. one that never existed)
   *                          → **401** `Unauthorized Account: {accountId}`
   *   wrong account in path  → **401** `Unauthorized Account: {thatAccount}`
   *
   * Two consequences, both of which make this method WORSE than its docblock
   * suggested rather than better:
   *
   *  1. The `!== 422 && !== 404` swallow never fires against this broker, so
   *     `cancelOrder` **THROWS** on a routine already-terminal cancel. Callers
   *     that treat a throw as "cleanup failed" are reading a no-op as an error.
   *  2. 401 does not distinguish "no such order" from "credentials are wrong".
   *     A cancel aimed at a mistyped id and a cancel with a dead token are the
   *     same status and the same body.
   *
   * The `filled` row of that matrix is still **UNMEASURED** — producing a fill
   * needs an open market, and the measurement ran with the market shut. Do not
   * assume it mirrors the `canceled` row.
   *
   * None of this weakens {@link cancelOrderConfirmed}, which is why it exists:
   * it treats every one of these codes as an acknowledgement only and takes its
   * verdict from the status poll.
   *
   * Kept as-is for the callers that genuinely only want best-effort cleanup and
   * do not branch on the result. **Anything that replaces, re-prices or resizes
   * the order afterwards must use {@link cancelOrderConfirmed} instead**, which
   * requires a terminal state and tells you which one.
   */
  async cancelOrder(orderId: string | number): Promise<void> {
    const resp = await fetch(
      `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders/${encodeURIComponent(String(orderId))}`,
      { method: 'DELETE', headers: this.headers },
    );
    if (!resp.ok && resp.status !== 422 && resp.status !== 404) {
      throw new Error(`Tradier cancel failed (${resp.status})`);
    }
  }

  /**
   * TRA-4476 — cancel an order and CONFIRM it reached a terminal state.
   *
   * `waitForOrderTerminalStatus` (TRA-319) already existed and is the right
   * primitive; the cancel path simply never used it. The DELETE's status code is
   * treated as a *request acknowledgement only* — including 404 and 422, which
   * are not evidence of anything on their own — and the verdict comes from
   * polling the order's own status afterwards.
   *
   * The outcome the caller must branch on:
   *
   *  - `canceled` — terminal and unfilled-or-partial. `filledQty` is what the
   *    broker says executed before the cancel landed; a replacement must be net
   *    of it, not the original quantity.
   *  - `filled` — **the cancel lost the race.** The order is done. There is
   *    nothing to replace and replacing it doubles the position.
   *  - `unknown` — the order did not reach a terminal state inside the window,
   *    or its status could not be read. The caller must NOT replace it.
   *
   * Note `filledQty` is `null`, never `0`, when the broker did not report an
   * executed quantity (TRA-1707): unmeasured and zero are different facts and
   * only one of them is safe to size a replacement from.
   */
  async cancelOrderConfirmed(
    orderId: string | number,
    options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<TradierCancelOutcome> {
    let ackStatus: number | null = null;
    let ackError: string | null = null;
    try {
      const resp = await fetch(
        `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders/${encodeURIComponent(String(orderId))}`,
        { method: 'DELETE', headers: this.headers },
      );
      ackStatus = resp.status;
    } catch (err) {
      // A DELETE that threw may still have been served. That is precisely why
      // the verdict comes from the status poll and not from here.
      ackError = err instanceof Error ? err.message : String(err);
    }

    const detail = await this.waitForOrderTerminalStatus(orderId, {
      timeoutMs: options.timeoutMs ?? 6000,
      intervalMs: options.intervalMs,
      sleep: options.sleep,
    });

    if (detail === null) {
      return {
        kind: 'unknown',
        reason: 'status_unreadable',
        ackStatus,
        ackError,
        detail: null,
        filledQty: null,
      };
    }
    const status = detail.status.trim().toLowerCase();
    if (!TRADIER_TERMINAL_STATUSES.has(status)) {
      return {
        kind: 'unknown',
        reason: 'still_working',
        ackStatus,
        ackError,
        detail,
        filledQty: null,
      };
    }
    const filledQty =
      typeof detail.exec_quantity === 'number' && Number.isFinite(detail.exec_quantity)
        ? detail.exec_quantity
        : null;
    if (status === 'filled') {
      return { kind: 'filled', ackStatus, ackError, detail, filledQty };
    }
    return { kind: 'canceled', terminalStatus: status, ackStatus, ackError, detail, filledQty };
  }

  /**
   * TRA-1269 — fetch an order's child legs (`leg[]`). Used by the live-equity
   * chandelier trail to resolve the OTOCO's STOP-loss leg order id so it can be
   * modified in place. Returns `[]` on a non-2xx or leg-less envelope so a
   * transient failure can't be mistaken for "no stop leg to trail".
   */
  async getOrderLegs(orderId: string | number): Promise<TradierOrderLeg[]> {
    const resp = await fetch(
      `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders/${encodeURIComponent(String(orderId))}`,
      { method: 'GET', headers: { Authorization: this.headers.Authorization, Accept: 'application/json' } },
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as TradierOrderWithLegsEnvelope;
    return parseTradierOrderLegs(data);
  }

  /**
   * TRA-1269 — modify the resting STOP price of an existing stop leg in place
   * (`PUT /accounts/{id}/orders/{order_id}`). This is how the live-equity
   * chandelier ratchets the broker's OCO stop leg WITHOUT cancel+replace, so the
   * OCO pairing (stop ↔ take-profit) stays intact and the TP leg is never
   * touched. Only the stop trigger and duration are sent; `type` stays `stop`.
   * Throws on a non-2xx or a Tradier `errors` payload so the caller can log and
   * leave the prior (tighter-or-equal) stop resting.
   */
  async changeStopPrice(
    legOrderId: string | number,
    newStopPrice: number,
    duration: 'day' | 'gtc' = 'gtc',
  ): Promise<TradierOrderResponse> {
    const body = new URLSearchParams({
      type: 'stop',
      duration,
      stop: newStopPrice.toFixed(2),
    });
    const resp = await fetch(
      `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders/${encodeURIComponent(String(legOrderId))}`,
      { method: 'PUT', headers: this.headers, body: body.toString() },
    );
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Tradier stop-modify failed (${resp.status}): ${text}`);
    }
    const data = (await resp.json()) as TradierOrderEnvelope;
    const errors = data.errors?.error ?? data.order?.errors?.error;
    if (errors) {
      const msg = Array.isArray(errors) ? errors.join('; ') : errors;
      throw new Error(`Tradier stop-modify rejected: ${msg}`);
    }
    if (!data.order) {
      throw new Error('Tradier stop-modify response missing order payload');
    }
    return data.order;
  }

  /**
   * TRA-319 — fetch the current state of an order so callers can detect
   * post-acceptance cancellations (e.g. "insufficient buying power"). Returns
   * `null` when Tradier returns a non-2xx or an envelope without an `order`
   * payload so the caller can decide whether to retry or treat the order as
   * still pending.
   */
  async getOrderStatus(orderId: string | number): Promise<TradierOrderDetail | null> {
    const resp = await fetch(
      `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders/${encodeURIComponent(String(orderId))}`,
      { method: 'GET', headers: { Authorization: this.headers.Authorization, Accept: 'application/json' } },
    );
    if (!resp.ok) return null;
    const data = (await resp.json()) as TradierOrderEnvelope;
    if (!data.order) return null;
    const o = data.order;
    return {
      id: o.id,
      status: typeof o.status === 'string' ? o.status.toLowerCase() : '',
      reason_description: o.reason_description,
      // TRA-416 — coalesce the filled-quantity field across the names Tradier
      // uses on different order shapes so a partial-fill detector downstream
      // sees a value regardless of which envelope the broker returned.
      exec_quantity: firstFiniteNumber(o.exec_quantity, o.last_fill_quantity, o.fill_quantity),
      remaining_quantity: typeof o.remaining_quantity === 'number' ? o.remaining_quantity : undefined,
      avg_fill_price: typeof o.avg_fill_price === 'number' ? o.avg_fill_price : undefined,
    };
  }

  /**
   * TRA-319 — poll `getOrderStatus` until the order reaches a terminal state
   * or the timeout elapses. Used to detect Tradier post-acceptance cancels
   * (insufficient buying power, account flags, etc.) before the engine
   * commits a paper-side "open" record. Returns the final `TradierOrderDetail`
   * (still pending if it didn't terminate within the window) or `null` when
   * every poll attempt failed.
   *
   * The poll cadence is tuned for the "place order then check fill"
   * synchronous flow — short enough to keep the engine's tick responsive but
   * long enough that Tradier's risk-check pipeline (typically <2s) can run.
   */
  async waitForOrderTerminalStatus(
    orderId: string | number,
    options: { timeoutMs?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void> } = {},
  ): Promise<TradierOrderDetail | null> {
    const timeoutMs = options.timeoutMs ?? 6000;
    const intervalMs = options.intervalMs ?? 750;
    const sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    const deadline = Date.now() + timeoutMs;
    let last: TradierOrderDetail | null = null;
    while (Date.now() < deadline) {
      const detail = await this.getOrderStatus(orderId);
      if (detail) {
        last = detail;
        if (TRADIER_TERMINAL_STATUSES.has(detail.status)) return detail;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(intervalMs, remaining));
    }
    return last;
  }

  /**
   * TRA-415 — list open equity positions held in the configured Tradier
   * account. Tradier's `/accounts/{id}/positions` endpoint returns equity
   * and option rows together; option legs are filtered out at the parser
   * by symbol shape. Used by the engine's periodic equity reconcile so a
   * stock opened / closed out-of-band (on Tradier's web UI, or by a failed
   * mirror order) flows back into local state. Returns `[]` on a non-2xx
   * response so a transient Tradier failure can't poison the live equity
   * mirror with a half-fetched list.
   */
  async listOpenEquityPositions(): Promise<TradierOpenEquityPosition[]> {
    const resp = await fetch(
      `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/positions`,
      { headers: { Authorization: this.headers.Authorization, Accept: 'application/json' } },
    );
    if (!resp.ok) return [];
    const data = (await resp.json()) as TradierRawPositionsEnvelope;
    return parseTradierEquityPositions(data);
  }

  /**
   * TRA-2126 — submit a single plain equity order (market by default). Used by
   * the no-auth SANDBOX smoke-order health route to validate the
   * order → fill → reconcile → journal path end to end. `postOrder` is
   * `protected`, so this is the public entry point for a non-bracket equity
   * order. Only `market` and `limit` types are supported here; a `limit` order
   * requires a positive `limitPrice`.
   */
  async submitEquityOrder(params: {
    symbol: string;
    side: 'buy' | 'sell' | 'buy_to_cover' | 'sell_short';
    qty: number;
    type?: 'market' | 'limit';
    limitPrice?: number;
    duration?: 'day' | 'gtc';
  }): Promise<TradierOrderResponse> {
    const type = params.type ?? 'market';
    const body = new URLSearchParams({
      class: 'equity',
      symbol: params.symbol,
      side: params.side,
      quantity: String(params.qty),
      type,
      duration: params.duration ?? 'day',
    });
    if (type === 'limit') {
      if (
        typeof params.limitPrice !== 'number'
        || !Number.isFinite(params.limitPrice)
        || params.limitPrice <= 0
      ) {
        throw new Error('submitEquityOrder: a limit order requires a positive limitPrice');
      }
      body.set('price', params.limitPrice.toFixed(2));
    }
    return this.postOrder(body);
  }

  /**
   * TRA-4476 — read `/accounts/{id}/orders` in a form that can say it FAILED.
   *
   * `TradierOptionsClient.listOrders()` returns `[]` on auth/network failure and
   * its own docblock names that ambiguity as by-construction. The reconcile
   * cannot consume it: `[]` read as "no order exists" licenses an immediate
   * resubmit into a live order. This is the same fetch with the discriminator
   * kept.
   */
  protected async listOrdersForReconcile(): Promise<OrderListRead> {
    let resp: Response;
    try {
      resp = await fetch(
        `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders?includeTags=true`,
        { method: 'GET', headers: { Authorization: this.headers.Authorization, Accept: 'application/json' } },
      );
    } catch (err) {
      return { ok: false, reason: `orders fetch threw: ${err instanceof Error ? err.message : String(err)}` };
    }
    if (!resp.ok) return { ok: false, reason: `orders read HTTP ${resp.status}` };
    let data: unknown;
    try {
      data = await resp.json();
    } catch (err) {
      return { ok: false, reason: `orders body unparseable: ${err instanceof Error ? err.message : String(err)}` };
    }
    try {
      // Dynamic import, deliberately. `parseTradierOrders` lives in
      // `options-client.ts`, which `extends` this class at module top level — a
      // static import edge back would be a genuine ESM evaluation cycle (the
      // subclass's `extends` clause would hit the base class in its TDZ), not
      // merely a type one. This runs only after a submit already went unknown,
      // so a cold path's one-time module resolution costs nothing, and it keeps
      // ONE parser for this envelope rather than a second copy that can drift.
      const { parseTradierOrders } = await import('./options-client.js');
      return { ok: true, orders: parseTradierOrders(data as never) as ReconcilableOrderRow[] };
    } catch (err) {
      return { ok: false, reason: `orders parse failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  /**
   * TRA-4476 — resolve one intent against the broker and move the breaker.
   * Returns the verdict so callers (and the health surface) can report it.
   */
  protected async reconcileOneIntent(
    intent: OrderIntent,
    options: PostOrderOptions = {},
  ): Promise<IntentReconcileVerdict> {
    const now = options.now ?? Date.now;
    const read = await this.listOrdersForReconcile();
    const verdict = reconcileIntent(intent, read, {
      now: now(),
      ...(options.clockSkewMs !== undefined ? { clockSkewMs: options.clockSkewMs } : {}),
    });
    const key = intentBreakerKey(intent.accountId, intent.shape);
    const journal = getOrderIntentJournal();
    const brk = getUnknownIntentBreaker();

    if (verdict.kind === 'placed' && verdict.terminal) {
      // The order exists and is DONE. Nothing is working, so nothing is at risk
      // from a later submit of the same shape — release the halt.
      journal.update({ ...intent, status: 'acknowledged', orderId: verdict.orderId, updatedAt: now() });
      brk.clear(key);
      return verdict;
    }
    if (verdict.kind === 'placed') {
      // Alive and non-terminal. The invariant is explicit that a replacement
      // requires a terminal state first, so this HOLDS the halt rather than
      // clearing it — even though we now know exactly which order it is.
      journal.update({ ...intent, status: 'acknowledged', orderId: verdict.orderId, updatedAt: now() });
      brk.latch(key, { intent, reason: 'order_working', latchedAt: now() });
      return verdict;
    }
    if (verdict.kind === 'not_placed') {
      journal.update({ ...intent, status: 'not_placed', updatedAt: now() });
      brk.clear(key);
      return verdict;
    }
    journal.update({ ...intent, status: 'unknown', updatedAt: now() });
    brk.latch(key, { intent, reason: verdict.reason, latchedAt: now() });
    return verdict;
  }

  /**
   * TRA-4476 — submit, and return the outcome as a value.
   *
   * The state machine, in order:
   *
   *  1. **Halt check.** If this account already holds an unresolved unknown of
   *     this shape, try once to resolve it. If it still will not resolve, refuse
   *     to submit. This is the "one economic order per intent" guarantee.
   *  2. **Journal the intent BEFORE the POST.** `submitStartedAt` is stamped here
   *     and nowhere later — a timestamp taken after the failure would exclude the
   *     very order we would then be hunting for.
   *  3. **POST under a bounded timeout.**
   *  4. **Classify** into `acknowledged` / `refused` / `unknown`, at the stage
   *     that failed rather than by inspecting an exception type after the fact.
   *  5. On `unknown`, **reconcile**, and latch the breaker unless the reconcile
   *     resolved to a terminal or absent order.
   */
  protected async submitOrderWithOutcome(
    body: URLSearchParams,
    options: PostOrderOptions = {},
  ): Promise<TradierSubmitOutcome> {
    const now = options.now ?? Date.now;
    const shape = shapeFromOrderBody(body);
    const key = intentBreakerKey(this.accountId, shape);
    const journal = getOrderIntentJournal();
    const brk = getUnknownIntentBreaker();

    // ── 1. the halt ────────────────────────────────────────────────────────
    const latched = brk.get(key);
    if (latched) {
      const verdict = await this.reconcileOneIntent(latched.intent, options);

      // The order we lost turns out to have FILLED. Clearing the halt and
      // letting this submit through would place a SECOND order on top of a
      // realised position — the exact duplication this breaker exists to stop,
      // arrived at through the resolve path instead of the retry path.
      //
      // So the fill is DELIVERED to the caller as a recovered acknowledgement
      // rather than silently released. `reconcileOneIntent` has already cleared
      // the latch (a filled order is terminal — nothing is working), which makes
      // this a one-shot: the caller is told exactly once, and a later submit of
      // the same shape is ordinary new business.
      if (verdict.kind === 'placed' && verdict.terminal && reconcileFoundAFill(verdict)) {
        const recovered: TradierOrderResponse = {
          id: verdict.orderId,
          status: verdict.rows[0]?.status ?? 'filled',
        };
        this.emitSubmitObserved(new URLSearchParams(), recovered.id, recovered.status, latched.intent);
        return { kind: 'acknowledged', order: recovered, intent: latched.intent, recovered: true };
      }

      const stillLatched = brk.get(key);
      if (stillLatched) {
        brk.countHalt();
        const error = new TradierOrderError(
          `Tradier submit halted: an earlier order of this shape has an unresolved outcome `
          + `(intent ${stillLatched.intent.intentId}, ${stillLatched.reason}). `
          + `Resubmitting could duplicate live exposure.`,
          // Not a refusal — the broker never saw this attempt, so this must not
          // consume the TRA-450 rejection budget.
          'transport',
          undefined,
          {
            outcome: 'unknown',
            intentId: stillLatched.intent.intentId,
            reconcile: verdict,
          },
        );
        return { kind: 'unknown', error, intent: stillLatched.intent, latchReason: stillLatched.reason };
      }
    }

    // ── 2. the durable pre-submit record ───────────────────────────────────
    const intent: OrderIntent = {
      intentId: newIntentId(now()),
      accountId: this.accountId,
      env: this.env,
      submitStartedAt: now(),
      shape,
      status: 'submitting',
      updatedAt: now(),
    };
    try {
      journal.record(intent);
    } catch {
      // The journal must never turn a healthy order into a failure. A journal
      // that is failing degrades us to the pre-TRA-4476 behaviour, which is the
      // status quo, not a new hazard — and the server-side journal counts its
      // own write failures on its own side.
    }

    // ── 3. the bounded POST ────────────────────────────────────────────────
    const timeoutMs = options.timeoutMs ?? TRADIER_SUBMIT_TIMEOUT_MS;
    let resp: Response;
    try {
      resp = await fetch(
        `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders`,
        {
          method: 'POST',
          headers: this.headers,
          body: body.toString(),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
    } catch (err) {
      // The message is preserved VERBATIM: `exitErrorReason` strings derived
      // from it are already on persisted rows and on the dashboard (TRA-4218).
      const isAbort =
        err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
      return this.finishUnknown(
        intent,
        err instanceof Error ? err.message : String(err),
        isAbort ? 'timeout' : 'network_throw',
        undefined,
        err,
        options,
      );
    }

    // ── 4. classify ────────────────────────────────────────────────────────
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      // TRA-4218 — same message, but the STATUS now rides the throw so the exit
      // path can tell "the broker refused this contract" from "the broker's
      // backend fell over". Those take opposite remedies.
      const message = `Tradier order failed (${resp.status}): ${text}`;
      if (isTransportStatus(resp.status)) {
        // TRA-4476 — 5xx/429/408. The broker's edge answered; its order book may
        // still have taken the order. `kind` stays `transport` so the refusal
        // budget is untouched, exactly as before.
        return this.finishUnknown(
          intent, message, 'broker_transport_status', resp.status, undefined, options,
        );
      }
      // A 4xx IS the broker deciding. Provably no order.
      const error = new TradierOrderError(message, 'refused', resp.status, {
        outcome: 'refused',
        intentId: intent.intentId,
      });
      this.settleIntent(intent, 'refused', message, now);
      return { kind: 'refused', error, intent };
    }

    let data: TradierOrderEnvelope;
    try {
      data = (await resp.json()) as TradierOrderEnvelope;
    } catch (err) {
      // A 2xx we could not read is OUR blindness, not the broker's refusal.
      return this.finishUnknown(
        intent,
        `Tradier order response unreadable: ${err instanceof Error ? err.message : String(err)}`,
        'unreadable_response',
        resp.status,
        err,
        options,
      );
    }

    const errors = data.errors?.error ?? data.order?.errors?.error;
    if (errors) {
      const msg = Array.isArray(errors) ? errors.join('; ') : errors;
      const message = `Tradier order rejected: ${msg}`;
      const error = new TradierOrderError(message, 'refused', resp.status, {
        outcome: 'refused',
        intentId: intent.intentId,
      });
      this.settleIntent(intent, 'refused', message, now);
      return { kind: 'refused', error, intent };
    }
    if (!data.order) {
      // TRA-4476 — this used to sit beside the refusals as `malformed`. A 2xx is
      // the broker saying it succeeded; a payload we cannot find is not a
      // refusal. `kind` stays `malformed` so the budget axis is byte-identical
      // to TRA-4218; the EXPOSURE axis moves to `unknown`, where it belongs.
      return this.finishUnknown(
        intent,
        'Tradier order response missing order payload',
        'missing_order_payload',
        resp.status,
        undefined,
        options,
        'malformed',
      );
    }

    this.emitSubmitObserved(body, data.order.id, data.order.status);
    this.settleIntent(intent, 'acknowledged', undefined, now, data.order.id);
    return { kind: 'acknowledged', order: data.order, intent, recovered: false };
  }

  /** TRA-4476 — write a terminal status onto the journalled intent. Never throws. */
  private settleIntent(
    intent: OrderIntent,
    status: OrderIntent['status'],
    detail: string | undefined,
    now: () => number,
    orderId?: number,
  ): void {
    try {
      getOrderIntentJournal().update({
        ...intent,
        status,
        updatedAt: now(),
        ...(orderId !== undefined ? { orderId } : {}),
        ...(detail !== undefined ? { detail } : {}),
      });
    } catch {
      // see `journal.record` above — never into the order path
    }
  }

  /**
   * TRA-4476 — the `unknown` branch: reconcile, then decide whether the halt
   * engages. A reconcile that RECOVERS the order returns an `acknowledged`
   * outcome, which is the whole point — a response lost after the broker
   * accepted now resolves to the real order instead of a phantom retry.
   */
  private async finishUnknown(
    intent: OrderIntent,
    message: string,
    reason: UnknownSubmitReason,
    status: number | undefined,
    cause: unknown,
    options: PostOrderOptions,
    kind: 'transport' | 'malformed' = 'transport',
  ): Promise<TradierSubmitOutcome> {
    const now = options.now ?? Date.now;
    this.settleIntent({ ...intent, unknownReason: reason }, 'unknown', message, now);
    const verdict = await this.reconcileOneIntent({ ...intent, unknownReason: reason }, options);

    if (verdict.kind === 'placed') {
      // The broker HAS the order. Recover the id and hand the caller a real ack.
      const recovered: TradierOrderResponse = {
        id: verdict.orderId,
        status: verdict.rows[0]?.status ?? 'unknown',
      };
      // The submit observer's contract is "every id the broker acknowledged,
      // seen exactly once" (TRA-3939). An id we recovered qualifies, and it is
      // the case its own docblock says it could not capture.
      this.emitSubmitObserved(new URLSearchParams(), recovered.id, recovered.status, intent);
      return { kind: 'acknowledged', order: recovered, intent, recovered: true };
    }

    if (verdict.kind === 'not_placed') {
      const error = new TradierOrderError(message, kind, status, {
        outcome: 'not_placed',
        intentId: intent.intentId,
        unknownReason: reason,
        reconcile: verdict,
        cause,
      });
      return { kind: 'not_placed', error, intent };
    }

    const error = new TradierOrderError(message, kind, status, {
      outcome: 'unknown',
      intentId: intent.intentId,
      unknownReason: reason,
      reconcile: verdict,
      cause,
    });
    return { kind: 'unknown', error, intent, latchReason: verdict.reason };
  }

  /**
   * TRA-3939 — THE SUBMIT-TIME ID CHOKEPOINT. Emitted after the broker has
   * acknowledged an id and before the order returns to any caller, so a walk step
   * we are about to cancel is recorded exactly like the one that fills.
   *
   * Isolated from the order path entirely: a recorder that throws must never turn
   * an ACKNOWLEDGED live order into a caller-visible failure — the caller would
   * void a paper open for a real order that is working at the broker. The
   * observer counts its own failures on its own side (see
   * `tra3939-order-provenance-capture.ts`); a swallow that nothing counts is the
   * silent-clean shape this codebase keeps paying for.
   *
   * TRA-4476 — `intent` is passed on the RECOVERED path, where the submitted body
   * is not to hand but the intent's shape carries the same fields.
   */
  private emitSubmitObserved(
    body: URLSearchParams,
    orderId: unknown,
    ackStatus: unknown,
    intent?: OrderIntent,
  ): void {
    if (orderSubmitObserver === null || typeof orderId !== 'number') return;
    try {
      orderSubmitObserver({
        orderId,
        ackStatus: typeof ackStatus === 'string' ? ackStatus : 'unknown',
        env: this.env,
        accountId: this.accountId,
        orderClass: intent?.shape.orderClass ?? bodyString(body, 'class'),
        side: intent?.shape.side ?? bodyString(body, 'side', 'side[0]'),
        symbol: intent?.shape.symbol ?? bodyString(body, 'symbol', 'symbol[0]'),
        optionSymbol: intent?.shape.optionSymbol ?? bodyString(body, 'option_symbol', 'option_symbol[0]'),
        quantity: intent?.shape.quantity ?? bodyNumber(body, 'quantity', 'quantity[0]'),
        limitPrice: intent?.shape.limitPrice ?? bodyNumber(body, 'price', 'price[0]'),
        submittedAt: Date.now(),
      });
    } catch {
      // never into the order path
    }
  }

  /**
   * Submit an order, throwing on anything but an acknowledgement.
   *
   * The throwing contract is unchanged — every caller in the tree depends on it,
   * and `kind` on the thrown {@link TradierOrderError} is byte-for-byte what
   * TRA-4218 shipped. What TRA-4476 adds rides on `outcome`, and on the fact that
   * an unknown outcome has now already been reconciled and may have HALTED this
   * shape. Callers that want to branch rather than catch use
   * {@link submitOrderWithOutcome}.
   */
  protected async postOrder(
    body: URLSearchParams,
    options: PostOrderOptions = {},
  ): Promise<TradierOrderResponse> {
    const outcome = await this.submitOrderWithOutcome(body, options);
    if (outcome.kind === 'acknowledged') return outcome.order;
    throw outcome.error;
  }
}
