import type { Side } from '@trading-app/shared';

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

const SANDBOX_BASE = 'https://sandbox.tradier.com/v1';
const PROD_BASE = 'https://api.tradier.com/v1';

export function tradierBaseUrl(env: TradierEnv): string {
  return env === 'production' ? PROD_BASE : SANDBOX_BASE;
}

export class TradierOrderClient {
  protected readonly baseUrl: string;
  protected readonly accountId: string;
  protected readonly headers: Record<string, string>;

  constructor(apiToken: string, accountId: string, env: TradierEnv = 'sandbox') {
    this.baseUrl = tradierBaseUrl(env);
    this.accountId = accountId;
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

  protected async postOrder(body: URLSearchParams): Promise<TradierOrderResponse> {
    const resp = await fetch(
      `${this.baseUrl}/accounts/${encodeURIComponent(this.accountId)}/orders`,
      { method: 'POST', headers: this.headers, body: body.toString() },
    );

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Tradier order failed (${resp.status}): ${text}`);
    }

    const data = (await resp.json()) as TradierOrderEnvelope;
    const errors = data.errors?.error ?? data.order?.errors?.error;
    if (errors) {
      const msg = Array.isArray(errors) ? errors.join('; ') : errors;
      throw new Error(`Tradier order rejected: ${msg}`);
    }
    if (!data.order) {
      throw new Error('Tradier order response missing order payload');
    }
    return data.order;
  }
}
