import { createHmac, randomUUID } from 'crypto';

import type { Side } from '@trading-app/shared';

const DEFAULT_BASE_URL = 'https://api.coinbase.com';

export interface CoinbaseOrderClientOptions {
  apiKey: string;
  apiSecret: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Override clock — handy for tests so HMAC signatures are deterministic. */
  now?: () => number;
}

export interface CoinbaseAccountBalance {
  uuid: string;
  name: string;
  currency: string;
  available_balance: { value: string; currency: string };
  hold: { value: string; currency: string };
}

interface ListAccountsResponse {
  accounts?: CoinbaseAccountBalance[];
}

export interface CoinbaseOrderSuccessResponse {
  order_id: string;
  product_id: string;
  side: 'BUY' | 'SELL';
  client_order_id: string;
}

interface CreateOrderResponse {
  success: boolean;
  success_response?: CoinbaseOrderSuccessResponse;
  error_response?: { error?: string; message?: string; error_details?: string };
}

export interface MarketOrderParams {
  productId: string;
  side: Side;
  /** Amount of the base asset to trade (e.g. 0.001 BTC). Used for SELL and for size-based BUYs. */
  baseSize?: number;
  /** Amount of the quote asset to spend (e.g. 25 USD). Used for BUYs when sizing in dollars. */
  quoteSize?: number;
  clientOrderId?: string;
}

export interface LimitOrderParams {
  productId: string;
  side: Side;
  baseSize: number;
  limitPrice: number;
  postOnly?: boolean;
  clientOrderId?: string;
}

/**
 * Coinbase Advanced Trade REST client.
 *
 * Auth uses the HMAC method (CB-ACCESS-KEY / CB-ACCESS-TIMESTAMP / CB-ACCESS-SIGN
 * over `timestamp + method + requestPath + body`). Cloud trading keys (ECDSA JWT)
 * are out of scope for this client — operators using cloud keys should provision
 * a legacy HMAC trading key.
 *
 * The base/quote sizes are stringified with toFixed(8) before signing so the body
 * sent over the wire matches the body fed into the HMAC, and so we don't lose
 * precision on small fractional crypto amounts.
 */
export class CoinbaseOrderClient {
  private readonly apiKey: string;
  private readonly apiSecret: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: CoinbaseOrderClientOptions) {
    if (!opts.apiKey || !opts.apiSecret) {
      throw new Error('CoinbaseOrderClient requires apiKey and apiSecret');
    }
    this.apiKey = opts.apiKey;
    this.apiSecret = opts.apiSecret;
    this.baseUrl = opts.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /** Compute the CB-ACCESS-SIGN header for a given request. Exposed for testing. */
  signRequest(timestamp: string, method: string, requestPath: string, body: string): string {
    return createHmac('sha256', this.apiSecret)
      .update(timestamp + method.toUpperCase() + requestPath + body)
      .digest('hex');
  }

  /** GET /api/v3/brokerage/accounts — returns balances by currency. */
  async listAccounts(): Promise<CoinbaseAccountBalance[]> {
    const path = '/api/v3/brokerage/accounts';
    const data = await this.request<ListAccountsResponse>('GET', path, '');
    return data.accounts ?? [];
  }

  /**
   * POST /api/v3/brokerage/orders — places an immediate-or-cancel market order.
   *
   * For `side: 'buy'` you may pass either `quoteSize` (USD to spend) or
   * `baseSize` (units of base). For `side: 'sell'` pass `baseSize`.
   */
  async placeMarketOrder(params: MarketOrderParams): Promise<CoinbaseOrderSuccessResponse> {
    if (!params.baseSize && !params.quoteSize) {
      throw new Error('placeMarketOrder requires baseSize or quoteSize');
    }

    const market: Record<string, string> = {};
    if (params.baseSize != null) market.base_size = formatSize(params.baseSize);
    if (params.quoteSize != null) market.quote_size = formatSize(params.quoteSize);

    const body = {
      client_order_id: params.clientOrderId ?? randomUUID(),
      product_id: params.productId,
      side: params.side.toUpperCase(),
      order_configuration: { market_market_ioc: market },
    };

    return this.submitOrder(body);
  }

  /**
   * POST /api/v3/brokerage/orders — places a good-till-cancelled limit order.
   * Used for take-profit / stop levels when a strategy wants resting orders
   * rather than reactive market exits.
   */
  async placeLimitOrder(params: LimitOrderParams): Promise<CoinbaseOrderSuccessResponse> {
    const body = {
      client_order_id: params.clientOrderId ?? randomUUID(),
      product_id: params.productId,
      side: params.side.toUpperCase(),
      order_configuration: {
        limit_limit_gtc: {
          base_size: formatSize(params.baseSize),
          limit_price: formatSize(params.limitPrice),
          post_only: params.postOnly ?? false,
        },
      },
    };

    return this.submitOrder(body);
  }

  private async submitOrder(body: unknown): Promise<CoinbaseOrderSuccessResponse> {
    const path = '/api/v3/brokerage/orders';
    const resp = await this.request<CreateOrderResponse>('POST', path, body);
    if (!resp.success || !resp.success_response) {
      const err = resp.error_response;
      const detail = err?.error_details ?? err?.message ?? err?.error ?? 'unknown error';
      throw new Error(`Coinbase order rejected: ${detail}`);
    }
    return resp.success_response;
  }

  private async request<T>(method: string, path: string, body: unknown): Promise<T> {
    const timestamp = String(this.now());
    const bodyString = body === '' || body == null ? '' : JSON.stringify(body);
    const sign = this.signRequest(timestamp, method, path, bodyString);

    const resp = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        'CB-ACCESS-KEY': this.apiKey,
        'CB-ACCESS-TIMESTAMP': timestamp,
        'CB-ACCESS-SIGN': sign,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: method === 'GET' || bodyString === '' ? undefined : bodyString,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Coinbase ${method} ${path} failed (${resp.status}): ${text || resp.statusText}`);
    }

    return resp.json() as Promise<T>;
  }
}

/** Format a size/price for Coinbase. Coinbase accepts up to 8 decimal places. */
function formatSize(n: number): string {
  if (!Number.isFinite(n)) throw new Error(`invalid size: ${n}`);
  return n.toFixed(8).replace(/\.?0+$/, '') || '0';
}
