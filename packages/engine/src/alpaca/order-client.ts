import type { Side } from '@trading-app/shared';

export interface BracketOrderParams {
  symbol: string;
  qty: number;
  side: Side;
  limitPrice: number;
  takeProfitPrice: number;
  stopLossPrice: number;
}

export interface AlpacaOrderResponse {
  id: string;
  client_order_id: string;
  status: string;
  symbol: string;
  qty: string;
  side: string;
  type: string;
}

export class AlpacaOrderClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(apiKey: string, apiSecret: string, paper = true) {
    this.baseUrl = paper
      ? 'https://paper-api.alpaca.markets/v2'
      : 'https://api.alpaca.markets/v2';
    this.headers = {
      'APCA-API-KEY-ID': apiKey,
      'APCA-API-SECRET-KEY': apiSecret,
      'Content-Type': 'application/json',
    };
  }

  async submitBracketOrder(params: BracketOrderParams): Promise<AlpacaOrderResponse> {
    const body = {
      symbol: params.symbol,
      qty: String(params.qty),
      side: params.side,
      type: 'limit',
      time_in_force: 'day',
      limit_price: String(params.limitPrice.toFixed(2)),
      order_class: 'bracket',
      take_profit: { limit_price: String(params.takeProfitPrice.toFixed(2)) },
      stop_loss: { stop_price: String(params.stopLossPrice.toFixed(2)) },
    };

    const resp = await fetch(`${this.baseUrl}/orders`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify(body),
    });

    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Alpaca order failed (${resp.status}): ${text}`);
    }

    return resp.json() as Promise<AlpacaOrderResponse>;
  }

  async cancelOrder(orderId: string): Promise<void> {
    const resp = await fetch(`${this.baseUrl}/orders/${orderId}`, {
      method: 'DELETE',
      headers: this.headers,
    });
    if (!resp.ok && resp.status !== 422) {
      throw new Error(`Cancel failed (${resp.status})`);
    }
  }
}
