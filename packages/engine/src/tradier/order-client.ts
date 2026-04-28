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

interface TradierOrderEnvelope {
  order?: TradierOrderResponse & { errors?: { error: string | string[] } };
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
