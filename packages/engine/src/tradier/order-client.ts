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
  order?: (TradierOrderResponse & TradierOrderDetail) & { errors?: { error: string | string[] } };
  errors?: { error: string | string[] };
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
    const body = new URLSearchParams({
      class: 'otoco',
      symbol: params.symbol,
      duration: 'day',
      // Leg 0 — entry
      'side[0]': params.side,
      'quantity[0]': String(params.qty),
      'type[0]': 'limit',
      'price[0]': params.limitPrice.toFixed(2),
      'option_symbol[0]': '',
      // Leg 1 — take profit (close)
      'side[1]': params.side === 'buy' ? 'sell' : 'buy',
      'quantity[1]': String(params.qty),
      'type[1]': 'limit',
      'price[1]': params.takeProfitPrice.toFixed(2),
      // Leg 2 — stop loss (close)
      'side[2]': params.side === 'buy' ? 'sell' : 'buy',
      'quantity[2]': String(params.qty),
      'type[2]': 'stop',
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
      exec_quantity: typeof o.exec_quantity === 'number' ? o.exec_quantity : undefined,
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
