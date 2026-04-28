import { createHmac } from 'crypto';
import { describe, it, expect, beforeEach, vi } from 'vitest';

import { CoinbaseOrderClient } from './order-client.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TS = 1_700_000_000;
const KEY = 'test-key';
const SECRET = 'test-secret';

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn(async () => jsonResponse({ success: true, success_response: { order_id: 'o1', product_id: 'BTC-USD', side: 'BUY', client_order_id: 'cli-1' } }));
});

function makeClient() {
  return new CoinbaseOrderClient({
    apiKey: KEY,
    apiSecret: SECRET,
    fetchImpl: fetchMock as unknown as typeof fetch,
    now: () => TS,
  });
}

function expectedSign(method: string, path: string, body: string): string {
  return createHmac('sha256', SECRET)
    .update(String(TS) + method + path + body)
    .digest('hex');
}

describe('CoinbaseOrderClient', () => {
  it('throws when constructed without credentials', () => {
    expect(() => new CoinbaseOrderClient({ apiKey: '', apiSecret: 's' })).toThrow();
    expect(() => new CoinbaseOrderClient({ apiKey: 'k', apiSecret: '' })).toThrow();
  });

  it('signs GET /accounts with empty body', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [{ uuid: 'a', name: 'USD', currency: 'USD', available_balance: { value: '100', currency: 'USD' }, hold: { value: '0', currency: 'USD' } }] }));

    const accounts = await client.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/accounts');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['CB-ACCESS-KEY']).toBe(KEY);
    expect(headers['CB-ACCESS-TIMESTAMP']).toBe(String(TS));
    expect(headers['CB-ACCESS-SIGN']).toBe(expectedSign('GET', '/api/v3/brokerage/accounts', ''));
    expect((init as RequestInit).body).toBeUndefined();
  });

  it('places a market BUY using quoteSize and signs the exact body that was sent', async () => {
    const client = makeClient();

    await client.placeMarketOrder({
      productId: 'BTC-USD',
      side: 'buy',
      quoteSize: 25,
      clientOrderId: 'cli-1',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    const body = (init as RequestInit).body as string;
    expect(body).toBeTruthy();
    const parsed = JSON.parse(body);
    expect(parsed.product_id).toBe('BTC-USD');
    expect(parsed.side).toBe('BUY');
    expect(parsed.client_order_id).toBe('cli-1');
    expect(parsed.order_configuration.market_market_ioc.quote_size).toBe('25');
    expect(parsed.order_configuration.market_market_ioc.base_size).toBeUndefined();

    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['CB-ACCESS-SIGN']).toBe(
      expectedSign('POST', '/api/v3/brokerage/orders', body),
    );
  });

  it('places a market SELL using baseSize with up-to-8-decimal formatting', async () => {
    const client = makeClient();

    await client.placeMarketOrder({
      productId: 'ETH-USD',
      side: 'sell',
      baseSize: 0.12345678,
      clientOrderId: 'cli-2',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.side).toBe('SELL');
    expect(body.order_configuration.market_market_ioc.base_size).toBe('0.12345678');
  });

  it('rejects market orders with no size at all', async () => {
    const client = makeClient();
    await expect(
      client.placeMarketOrder({ productId: 'BTC-USD', side: 'buy' }),
    ).rejects.toThrow(/baseSize or quoteSize/);
  });

  it('throws a helpful error when Coinbase responds with success=false', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        error_response: { error: 'INSUFFICIENT_FUNDS', message: 'not enough USD' },
      }),
    );

    await expect(
      client.placeMarketOrder({ productId: 'BTC-USD', side: 'buy', quoteSize: 1 }),
    ).rejects.toThrow(/not enough USD/);
  });

  it('surfaces non-2xx HTTP errors with status + body text', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      new Response('forbidden', { status: 403, statusText: 'Forbidden' }),
    );

    await expect(
      client.placeMarketOrder({ productId: 'BTC-USD', side: 'buy', quoteSize: 1 }),
    ).rejects.toThrow(/403.*forbidden/);
  });

  it('places a limit GTC order with formatted price and size', async () => {
    const client = makeClient();

    await client.placeLimitOrder({
      productId: 'BTC-USD',
      side: 'buy',
      baseSize: 0.001,
      limitPrice: 30000,
      postOnly: true,
      clientOrderId: 'cli-3',
    });

    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
    expect(body.order_configuration.limit_limit_gtc).toEqual({
      base_size: '0.001',
      limit_price: '30000',
      post_only: true,
    });
  });
});
