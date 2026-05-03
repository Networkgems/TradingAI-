import { createHmac, createVerify, generateKeyPairSync } from 'crypto';
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

  it('signs GET /accounts with empty body and an explicit limit', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({ accounts: [{ uuid: 'a', name: 'USD', currency: 'USD', available_balance: { value: '100', currency: 'USD' }, hold: { value: '0', currency: 'USD' } }], has_next: false }));

    const accounts = await client.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/accounts?limit=250');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['CB-ACCESS-KEY']).toBe(KEY);
    expect(headers['CB-ACCESS-TIMESTAMP']).toBe(String(TS));
    expect(headers['CB-ACCESS-SIGN']).toBe(expectedSign('GET', '/api/v3/brokerage/accounts?limit=250', ''));
    expect((init as RequestInit).body).toBeUndefined();
  });

  // TRA-224 follow-up — Coinbase paginates GET /accounts (default 49, max
  // 250). Coinbase also auto-creates an account per supported currency, so a
  // user's primary USD wallet can easily land past page 1. Without
  // pagination, refreshBalance sees only a slice of the user's accounts and
  // reports a fraction of true equity (the symptom the user reported: $0.14
  // shown vs $199.02 actually held).
  it('paginates listAccounts via cursor until has_next is false', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(jsonResponse({
      accounts: [{ uuid: 'a1', name: 'BTC', currency: 'BTC', available_balance: { value: '0.001', currency: 'BTC' }, hold: { value: '0', currency: 'BTC' } }],
      has_next: true,
      cursor: 'page2',
    }));
    fetchMock.mockResolvedValueOnce(jsonResponse({
      accounts: [{ uuid: 'a2', name: 'USD', currency: 'USD', available_balance: { value: '199.02', currency: 'USD' }, hold: { value: '0', currency: 'USD' } }],
      has_next: false,
    }));

    const accounts = await client.listAccounts();

    expect(accounts).toHaveLength(2);
    expect(accounts.map(a => a.currency)).toEqual(['BTC', 'USD']);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.coinbase.com/api/v3/brokerage/accounts?limit=250');
    expect(String(fetchMock.mock.calls[1][0])).toBe('https://api.coinbase.com/api/v3/brokerage/accounts?limit=250&cursor=page2');
  });

  it('stops paginating when the response is missing a cursor even if has_next is true', async () => {
    const client = makeClient();
    // Defensive: Coinbase shouldn't return has_next=true without a cursor,
    // but if it ever does, looping forever with cursor=undefined would spam
    // the same page. Bail on the first absent cursor instead.
    fetchMock.mockResolvedValueOnce(jsonResponse({
      accounts: [{ uuid: 'a1', name: 'USD', currency: 'USD', available_balance: { value: '10', currency: 'USD' }, hold: { value: '0', currency: 'USD' } }],
      has_next: true,
      cursor: undefined,
    }));

    const accounts = await client.listAccounts();

    expect(accounts).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

  it('falls through empty error_details to message/error so the user never sees a bare "rejected:"', async () => {
    // TRA-243 — Coinbase occasionally returns `{ error_details: "" }` (empty
    // string, not absent). The previous `??` chain short-circuited there
    // and produced `Coinbase order rejected:` with no body. `||` keeps
    // walking until it finds non-empty text.
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        error_response: { error_details: '', message: 'Invalid product_id', error: '' },
      }),
    );

    await expect(
      client.placeMarketOrder({ productId: 'BAD-USD', side: 'buy', quoteSize: 1 }),
    ).rejects.toThrow(/Invalid product_id/);
  });

  it('reports "unknown error" when every error field is empty rather than dropping the diagnosis text', async () => {
    const client = makeClient();
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        success: false,
        error_response: { error_details: '', message: '', error: '' },
      }),
    );

    await expect(
      client.placeMarketOrder({ productId: 'BTC-USD', side: 'buy', quoteSize: 1 }),
    ).rejects.toThrow(/unknown error/);
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

  it('reports the HMAC scheme when given a printable shared secret', () => {
    expect(makeClient().getAuthScheme()).toBe('hmac');
  });

  // TRA-224 — non-USD account balances need spot pricing so the live
  // dashboard equity reflects pre-existing crypto holdings, not just stable
  // cash.
  describe('getProductPrices (TRA-224)', () => {
    it('issues a single GET with the requested product_ids and returns a price map', async () => {
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          { product_id: 'BTC-USD', price: '60000.5' },
          { product_id: 'ETH-USD', price: '3000' },
        ],
      }));

      const prices = await client.getProductPrices(['BTC-USD', 'ETH-USD']);

      expect(prices.get('BTC-USD')).toBe(60_000.5);
      expect(prices.get('ETH-USD')).toBe(3_000);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url] = fetchMock.mock.calls[0];
      expect(String(url)).toBe(
        'https://api.coinbase.com/api/v3/brokerage/products?product_ids=BTC-USD&product_ids=ETH-USD',
      );
    });

    it('drops products with missing or non-numeric prices instead of returning NaN entries', async () => {
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          { product_id: 'BTC-USD', price: '60000' },
          { product_id: 'OBS-USD', price: '' },
          { product_id: 'BAD-USD', price: 'not-a-number' },
          { product_id: 'ZERO-USD', price: '0' }, // suspended/inactive
        ],
      }));

      const prices = await client.getProductPrices(['BTC-USD', 'OBS-USD', 'BAD-USD', 'ZERO-USD']);

      expect(prices.size).toBe(1);
      expect(prices.get('BTC-USD')).toBe(60_000);
    });

    it('short-circuits to an empty map without hitting the network when given no product ids', async () => {
      const client = makeClient();

      const prices = await client.getProductPrices([]);

      expect(prices.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // TRA-243 — Coinbase enforces a per-product `base_increment` step on order
  // sizing. Submitting a finer-grained `base_size` returns "Too many decimals
  // in order amount". `getProducts` exposes both spot price and increment so
  // CryptoLiveAccount can quantize order size to the product's actual step.
  describe('getProducts (TRA-243)', () => {
    it('returns price and base_increment for each listable product', async () => {
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          { product_id: 'BTC-USD', price: '60000', base_increment: '0.00000001' },
          { product_id: 'SHIB-USD', price: '0.000028', base_increment: '1' },
          { product_id: 'DOGE-USD', price: '0.12', base_increment: '0.1' },
        ],
      }));

      const products = await client.getProducts(['BTC-USD', 'SHIB-USD', 'DOGE-USD']);

      expect(products.get('BTC-USD')).toEqual({ price: 60_000, baseIncrement: '0.00000001' });
      expect(products.get('SHIB-USD')).toEqual({ price: 0.000028, baseIncrement: '1' });
      expect(products.get('DOGE-USD')).toEqual({ price: 0.12, baseIncrement: '0.1' });
    });

    it('drops products whose base_increment is missing or unparseable', async () => {
      // Sending an order without a known step is the more dangerous failure
      // mode (Coinbase rejects with "Too many decimals"). Better to skip the
      // ticker entirely so downstream sees it as "not listed".
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          { product_id: 'BTC-USD', price: '60000', base_increment: '0.00000001' },
          { product_id: 'NOINC-USD', price: '5' },
          { product_id: 'BADINC-USD', price: '5', base_increment: 'not-a-number' },
          { product_id: 'ZEROINC-USD', price: '5', base_increment: '0' },
        ],
      }));

      const products = await client.getProducts(['BTC-USD', 'NOINC-USD', 'BADINC-USD', 'ZEROINC-USD']);

      expect(products.size).toBe(1);
      expect(products.get('BTC-USD')).toBeDefined();
    });

    it('preserves padded-zero increment strings verbatim so callers can derive exact decimal counts', async () => {
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          { product_id: 'X-USD', price: '1', base_increment: '0.10000000' },
        ],
      }));

      const products = await client.getProducts(['X-USD']);

      // Verbatim — caller (CryptoLiveAccount.quantizeBaseSize) trims trailing
      // zeros to compute the canonical decimal count.
      expect(products.get('X-USD')?.baseIncrement).toBe('0.10000000');
    });

    it('short-circuits to an empty map without hitting the network when given no product ids', async () => {
      const client = makeClient();

      const products = await client.getProducts([]);

      expect(products.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // TRA-249-D — funding-rate accrual on open Coinbase INTX perp positions.
  // Coinbase nests funding under `future_product_details.perpetual_details`.
  // These tests pin the parse contract so a server-side schema drift surfaces
  // here rather than at runtime as silent zero-charge entries.
  describe('getFundingRates (TRA-249-D)', () => {
    it('parses funding_rate + funding_time off perp products and ignores non-perps', async () => {
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          {
            product_id: 'BTC-PERP-INTX',
            future_product_details: {
              perpetual_details: {
                funding_rate: '0.0001',
                funding_time: '2026-05-02T16:00:00Z',
              },
            },
          },
          {
            product_id: 'ETH-PERP-INTX',
            future_product_details: {
              perpetual_details: { funding_rate: '-0.00005' },
            },
          },
          // Spot product — no future_product_details, dropped.
          { product_id: 'BTC-USD', price: '60000', base_increment: '0.00000001' },
        ],
      }));

      const rates = await client.getFundingRates(['BTC-PERP-INTX', 'ETH-PERP-INTX', 'BTC-USD']);

      expect(rates.size).toBe(2);
      expect(rates.get('BTC-PERP-INTX')).toEqual({
        rate: 0.0001,
        nextFundingTimeMs: Date.parse('2026-05-02T16:00:00Z'),
      });
      // Negative funding (shorts pay longs) round-trips with sign intact.
      expect(rates.get('ETH-PERP-INTX')).toEqual({ rate: -0.00005, nextFundingTimeMs: undefined });
      expect(rates.get('BTC-USD')).toBeUndefined();
    });

    it('drops entries whose funding_rate is unparseable so a phantom 0 charge cannot mask outage', async () => {
      const client = makeClient();
      fetchMock.mockResolvedValueOnce(jsonResponse({
        products: [
          {
            product_id: 'BTC-PERP-INTX',
            future_product_details: { perpetual_details: { funding_rate: 'not-a-number' } },
          },
          {
            product_id: 'ETH-PERP-INTX',
            future_product_details: { perpetual_details: { funding_rate: '0.0002' } },
          },
        ],
      }));

      const rates = await client.getFundingRates(['BTC-PERP-INTX', 'ETH-PERP-INTX']);

      expect(rates.size).toBe(1);
      expect(rates.get('ETH-PERP-INTX')?.rate).toBe(0.0002);
    });

    it('short-circuits to an empty map without hitting the network when given no product ids', async () => {
      const client = makeClient();

      const rates = await client.getFundingRates([]);

      expect(rates.size).toBe(0);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  // TRA-249 — perp-trading surface added to the order client. These tests
  // pin (a) that the spot order body is byte-identical to pre-change when no
  // perp fields are passed, and (b) that perp fields land at the documented
  // top-level keys (`leverage`, `margin_type`, `position_side`) in the JSON.
  describe('perp surface (TRA-249)', () => {
    it('keeps the spot market-order body byte-identical when no perp fields are present', async () => {
      const client = makeClient();

      await client.placeMarketOrder({
        productId: 'BTC-USD',
        side: 'buy',
        quoteSize: 25,
        clientOrderId: 'cli-spot',
      });

      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      // Whitelist-style assertion: any extra top-level key would be a
      // regression for the spot path (and would change the HMAC signature).
      expect(Object.keys(body).sort()).toEqual([
        'client_order_id',
        'order_configuration',
        'product_id',
        'side',
      ]);
      expect(body).not.toHaveProperty('leverage');
      expect(body).not.toHaveProperty('margin_type');
      expect(body).not.toHaveProperty('position_side');
    });

    it('places a perp SHORT-open with leverage / margin_type / position_side at the top level', async () => {
      const client = makeClient();

      await client.placeMarketOrder({
        productId: 'BTC-PERP-INTX',
        side: 'sell',
        baseSize: 0.001,
        leverage: 1,
        marginType: 'ISOLATED',
        positionSide: 'SHORT',
        clientOrderId: 'cli-perp-open',
      });

      const init = fetchMock.mock.calls[0][1] as RequestInit;
      const body = init.body as string;
      const parsed = JSON.parse(body);
      expect(parsed.product_id).toBe('BTC-PERP-INTX');
      expect(parsed.side).toBe('SELL');
      expect(parsed.leverage).toBe('1');
      expect(parsed.margin_type).toBe('ISOLATED');
      expect(parsed.position_side).toBe('SHORT');
      expect(parsed.order_configuration.market_market_ioc.base_size).toBe('0.001');

      // The signature must be over the bytes that actually went out — perp
      // params included — or Coinbase will 401 us.
      const headers = init.headers as Record<string, string>;
      expect(headers['CB-ACCESS-SIGN']).toBe(
        expectedSign('POST', '/api/v3/brokerage/orders', body),
      );
    });

    it('distinguishes BUY vs SELL via position_side on perp orders', async () => {
      const client = makeClient();

      await client.placeMarketOrder({
        productId: 'BTC-PERP-INTX',
        side: 'buy',
        baseSize: 0.001,
        leverage: 1,
        marginType: 'ISOLATED',
        positionSide: 'LONG',
      });

      const buyBody = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(buyBody.side).toBe('BUY');
      expect(buyBody.position_side).toBe('LONG');

      await client.placeMarketOrder({
        productId: 'BTC-PERP-INTX',
        side: 'sell',
        baseSize: 0.001,
        leverage: 1,
        marginType: 'ISOLATED',
        positionSide: 'SHORT',
      });

      const sellBody = JSON.parse((fetchMock.mock.calls[1][1] as RequestInit).body as string);
      expect(sellBody.side).toBe('SELL');
      expect(sellBody.position_side).toBe('SHORT');
    });

    it('rejects CROSS margin so a typo cannot quietly enable an unsupported mode', async () => {
      const client = makeClient();

      await expect(
        client.placeMarketOrder({
          productId: 'BTC-PERP-INTX',
          side: 'sell',
          baseSize: 0.001,
          leverage: 1,
          marginType: 'CROSS',
          positionSide: 'SHORT',
        }),
      ).rejects.toThrow(/CROSS/);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('serialises leverage as a string (Coinbase rejects numeric leverage)', async () => {
      const client = makeClient();

      await client.placeMarketOrder({
        productId: 'BTC-PERP-INTX',
        side: 'sell',
        baseSize: 0.001,
        leverage: 5,
        marginType: 'ISOLATED',
        positionSide: 'SHORT',
      });

      const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
      expect(body.leverage).toBe('5');
      expect(typeof body.leverage).toBe('string');
    });

    describe('listProducts', () => {
      it('passes product_type and filters out inactive entries', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          products: [
            { product_id: 'BTC-PERP-INTX', product_type: 'FUTURE', status: 'online', price: '60000' },
            { product_id: 'PAUSED-PERP-INTX', product_type: 'FUTURE', trading_disabled: true, price: '0' },
            { product_id: 'DEAD-PERP-INTX', product_type: 'FUTURE', is_disabled: true, price: '0' },
            { product_id: 'CANCEL-ONLY-INTX', product_type: 'FUTURE', cancel_only: true, price: '1' },
            { product_id: 'ETH-PERP-INTX', product_type: 'FUTURE', status: 'online', price: '3000' },
          ],
        }));

        const products = await client.listProducts('FUTURE');

        expect(products.map((p) => p.product_id)).toEqual(['BTC-PERP-INTX', 'ETH-PERP-INTX']);
        const [url] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/products?product_type=FUTURE');
      });

      it('also works for SPOT (used as a sanity check by callers building a spot→perp map)', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          products: [{ product_id: 'BTC-USD', product_type: 'SPOT', status: 'online', price: '60000' }],
        }));

        const products = await client.listProducts('SPOT');

        expect(products).toHaveLength(1);
        expect(products[0].product_id).toBe('BTC-USD');
        const [url] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/products?product_type=SPOT');
      });

      // TRA-262 — perp products carry funding_rate + open_interest under
      // future_product_details.perpetual_details. listProducts must surface
      // these on `perp` so the §5 short filters can read them; spot products
      // (no perpetual_details block) must omit `perp` entirely.
      it('surfaces perp metrics (funding/OI) and converts open_interest to USD', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          products: [
            {
              product_id: 'BTC-PERP-INTX',
              product_type: 'FUTURE',
              status: 'online',
              price: '60000',
              future_product_details: {
                perpetual_details: {
                  funding_rate: '-0.0001',
                  funding_time: '2026-05-02T16:00:00Z',
                  open_interest: '1500',
                },
              },
            },
            {
              // Perp without OI — funding still rides through.
              product_id: 'ETH-PERP-INTX',
              product_type: 'FUTURE',
              status: 'online',
              price: '3000',
              future_product_details: { perpetual_details: { funding_rate: '0.00005' } },
            },
            {
              // Perp with OI but no price — OI must degrade to undefined,
              // not produce a NaN that silently bypasses the OI gate.
              product_id: 'NEW-PERP-INTX',
              product_type: 'FUTURE',
              status: 'online',
              future_product_details: { perpetual_details: { open_interest: '50000' } },
            },
            // Spot — no perpetual_details, `perp` omitted entirely.
            { product_id: 'BTC-USD', product_type: 'SPOT', status: 'online', price: '60000' },
          ],
        }));

        const products = await client.listProducts('FUTURE');
        const byId = new Map(products.map((p) => [p.product_id, p]));

        expect(byId.get('BTC-PERP-INTX')?.perp).toEqual({
          fundingRatePerHour: -0.0001,
          nextFundingTimeMs: Date.parse('2026-05-02T16:00:00Z'),
          openInterestUsd: 1500 * 60000,
        });
        expect(byId.get('ETH-PERP-INTX')?.perp).toEqual({ fundingRatePerHour: 0.00005 });
        expect(byId.get('NEW-PERP-INTX')?.perp).toBeUndefined();
        expect(byId.get('BTC-USD')?.perp).toBeUndefined();
      });

      it('drops a perp funding_rate that is unparseable rather than emitting NaN', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          products: [
            {
              product_id: 'BAD-PERP-INTX',
              product_type: 'FUTURE',
              status: 'online',
              price: '100',
              future_product_details: {
                perpetual_details: { funding_rate: 'not-a-number', open_interest: '10' },
              },
            },
          ],
        }));

        const [bad] = await client.listProducts('FUTURE');
        // funding_rate parse failed, OI still resolves → only OI is set.
        expect(bad.perp?.fundingRatePerHour).toBeUndefined();
        expect(bad.perp?.openInterestUsd).toBe(10 * 100);
      });
    });

    // TRA-262 — live order-book snapshot for the §5 spread gate. The endpoint
    // is greenfield (no spot variant existed pre-TRA-262); these tests pin
    // the URL shape, the mid/spread math, and the degraded-input semantics
    // (one-sided book, crossed book, missing pricebook).
    describe('getProductBook', () => {
      it('fetches /product_book?product_id=...&limit=1 and computes mid + spread', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          pricebook: {
            product_id: 'BTC-PERP-INTX',
            bids: [{ price: '60000', size: '0.5' }],
            asks: [{ price: '60030', size: '0.5' }],
            time: '2026-05-02T16:00:00Z',
          },
        }));

        const book = await client.getProductBook('BTC-PERP-INTX');

        expect(book.bestBid).toBe(60000);
        expect(book.bestAsk).toBe(60030);
        expect(book.midPrice).toBe(60015);
        // 30 / 60015 ≈ 0.0004999 — well above the 10 bps gate.
        expect(book.spreadFraction).toBeCloseTo(30 / 60015, 12);
        const [url] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/product_book?product_id=BTC-PERP-INTX&limit=1');
      });

      it('drops spread when the book is one-sided so the gate skips instead of reading a synthetic value', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          pricebook: { product_id: 'BTC-PERP-INTX', bids: [{ price: '60000', size: '0.5' }], asks: [], time: '...' },
        }));

        const book = await client.getProductBook('BTC-PERP-INTX');

        expect(book.bestBid).toBe(60000);
        expect(book.bestAsk).toBeUndefined();
        expect(book.midPrice).toBeUndefined();
        expect(book.spreadFraction).toBeUndefined();
      });

      it('drops spread on a crossed/inverted book (best ask < best bid) rather than emitting a negative fraction', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          pricebook: {
            product_id: 'THIN-PERP-INTX',
            bids: [{ price: '100.10', size: '1' }],
            asks: [{ price: '100.05', size: '1' }],
            time: '...',
          },
        }));

        const book = await client.getProductBook('THIN-PERP-INTX');

        expect(book.bestBid).toBe(100.10);
        expect(book.bestAsk).toBe(100.05);
        expect(book.midPrice).toBeUndefined();
        expect(book.spreadFraction).toBeUndefined();
      });

      it('throws when called with an empty productId (caller forgot to resolve the perp product_id)', async () => {
        const client = makeClient();
        await expect(client.getProductBook('')).rejects.toThrow(/productId/);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe('listPortfolios + listFuturesPositions', () => {
      it('listPortfolios passes portfolio_type and filters out deleted entries', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          portfolios: [
            { uuid: 'intx-1', name: 'Perpetuals', type: 'INTX' },
            { uuid: 'intx-old', name: 'Old INTX', type: 'INTX', deleted: true },
          ],
        }));

        const portfolios = await client.listPortfolios('INTX');

        expect(portfolios.map((p) => p.uuid)).toEqual(['intx-1']);
        const [url] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/portfolios?portfolio_type=INTX');
      });

      it('listFuturesPositions hits the INTX positions endpoint scoped to the supplied uuid', async () => {
        const client = makeClient();
        fetchMock.mockResolvedValueOnce(jsonResponse({
          positions: [
            {
              product_id: 'BTC-PERP-INTX',
              position_side: 'SHORT',
              net_size: '0.001',
              vwap: '60000',
              mark_price: '60500',
              liquidation_price: '120000',
              leverage: '1',
              margin_type: 'ISOLATED',
            },
          ],
        }));

        const positions = await client.listFuturesPositions('intx-1');

        expect(positions).toHaveLength(1);
        expect(positions[0]).toMatchObject({
          product_id: 'BTC-PERP-INTX',
          position_side: 'SHORT',
          net_size: '0.001',
        });
        const [url] = fetchMock.mock.calls[0];
        expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/intx/positions/intx-1');
      });

      it('listFuturesPositions throws when called with an empty uuid (caller forgot to resolve the portfolio)', async () => {
        const client = makeClient();
        await expect(client.listFuturesPositions('')).rejects.toThrow(/portfolio/);
        expect(fetchMock).not.toHaveBeenCalled();
      });
    });

    describe('closeFuturesPosition', () => {
      it('flattens a SHORT by submitting a BUY market order with position_side=SHORT preserved', async () => {
        const client = makeClient();

        await client.closeFuturesPosition({
          productId: 'BTC-PERP-INTX',
          positionSide: 'SHORT',
          baseSize: 0.002,
          leverage: 1,
          marginType: 'ISOLATED',
          clientOrderId: 'cli-close-short',
        });

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.side).toBe('BUY');
        expect(body.position_side).toBe('SHORT');
        expect(body.leverage).toBe('1');
        expect(body.margin_type).toBe('ISOLATED');
        expect(body.order_configuration.market_market_ioc.base_size).toBe('0.002');
        expect(body.client_order_id).toBe('cli-close-short');
      });

      it('flattens a LONG by submitting a SELL market order with position_side=LONG preserved', async () => {
        const client = makeClient();

        await client.closeFuturesPosition({
          productId: 'ETH-PERP-INTX',
          positionSide: 'LONG',
          baseSize: 0.5,
          leverage: 1,
          marginType: 'ISOLATED',
        });

        const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string);
        expect(body.side).toBe('SELL');
        expect(body.position_side).toBe('LONG');
      });
    });
  });
});

// --- CDP / JWT auth path (TRA-157) ---------------------------------------

const CDP_KID = 'organizations/abc/apiKeys/def';

/** Generate a fresh P-256 EC keypair for each test run so we exercise the real crypto path. */
function generateCdpKeypair(): { privatePem: string; publicPem: string } {
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }) as string,
  };
}

function decodeJwtParts(jwt: string): { header: Record<string, unknown>; payload: Record<string, unknown>; signingInput: string; signature: Buffer } {
  const [headerB64, payloadB64, sigB64] = jwt.split('.');
  const fromB64Url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  return {
    header: JSON.parse(fromB64Url(headerB64).toString('utf8')),
    payload: JSON.parse(fromB64Url(payloadB64).toString('utf8')),
    signingInput: `${headerB64}.${payloadB64}`,
    signature: fromB64Url(sigB64),
  };
}

describe('CoinbaseOrderClient (CDP/JWT auth)', () => {
  it('detects CDP credentials when the secret is a PEM private key', () => {
    const { privatePem } = generateCdpKeypair();
    const client = new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: privatePem });
    expect(client.getAuthScheme()).toBe('cdp');
  });

  it('rejects malformed PEM private keys at construction', () => {
    const broken = '-----BEGIN EC PRIVATE KEY-----\nnot-real-key-bytes\n-----END EC PRIVATE KEY-----';
    expect(() => new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: broken })).toThrow(/CDP private key/);
  });

  it('builds a JWT with ES256 alg, the api key as kid, and a ~2 minute expiry', () => {
    const { privatePem } = generateCdpKeypair();
    const client = new CoinbaseOrderClient({
      apiKey: CDP_KID,
      apiSecret: privatePem,
      now: () => TS,
      nonce: () => 'deadbeef',
    });

    const jwt = client.buildCdpJwt('GET', '/api/v3/brokerage/accounts');
    const { header, payload } = decodeJwtParts(jwt);

    expect(header).toMatchObject({ alg: 'ES256', typ: 'JWT', kid: CDP_KID, nonce: 'deadbeef' });
    expect(payload).toMatchObject({
      sub: CDP_KID,
      iss: 'cdp',
      nbf: TS,
      exp: TS + 120,
      uri: 'GET api.coinbase.com/api/v3/brokerage/accounts',
    });
  });

  it('produces a JWT signature that verifies against the public key (raw r||s form)', () => {
    const { privatePem, publicPem } = generateCdpKeypair();
    const client = new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: privatePem, now: () => TS });

    const jwt = client.buildCdpJwt('POST', '/api/v3/brokerage/orders');
    const { signingInput, signature } = decodeJwtParts(jwt);

    expect(signature).toHaveLength(64); // P-256 r||s = 32 + 32 bytes; DER would be ~70+
    const ok = createVerify('SHA256')
      .update(signingInput)
      .verify({ key: publicPem, dsaEncoding: 'ieee-p1363' }, signature);
    expect(ok).toBe(true);
  });

  it('places a market order with Authorization: Bearer <jwt> instead of CB-ACCESS-* headers', async () => {
    const { privatePem, publicPem } = generateCdpKeypair();
    const client = new CoinbaseOrderClient({
      apiKey: CDP_KID,
      apiSecret: privatePem,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => TS,
      nonce: () => 'nonce-xyz',
    });

    await client.placeMarketOrder({
      productId: 'BTC-USD',
      side: 'buy',
      quoteSize: 25,
      clientOrderId: 'cli-jwt',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.coinbase.com/api/v3/brokerage/orders');
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers['CB-ACCESS-KEY']).toBeUndefined();
    expect(headers['CB-ACCESS-SIGN']).toBeUndefined();
    expect(headers['CB-ACCESS-TIMESTAMP']).toBeUndefined();
    expect(headers.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);

    const jwt = headers.Authorization.slice('Bearer '.length);
    const { payload, signingInput, signature } = decodeJwtParts(jwt);
    expect(payload.uri).toBe('POST api.coinbase.com/api/v3/brokerage/orders');
    const ok = createVerify('SHA256')
      .update(signingInput)
      .verify({ key: publicPem, dsaEncoding: 'ieee-p1363' }, signature);
    expect(ok).toBe(true);
  });

  it('throws if buildCdpJwt is called on an HMAC client', () => {
    const client = makeClient();
    expect(() => client.buildCdpJwt('GET', '/api/v3/brokerage/accounts')).toThrow(/non-CDP/);
  });

  // TRA-249 — perp orders carry extra top-level body keys (leverage,
  // margin_type, position_side). Re-run the CDP signing path with those
  // params present to confirm the JWT is valid for the perp body too.
  // The body change doesn't affect the JWT (the URI claim is method+host+path
  // only) — this is a regression guard to make sure we didn't accidentally
  // start hashing the body into the claim while wiring perps.
  it('signs a perp order with a valid JWT that does not include the body in the URI claim', async () => {
    const { privatePem, publicPem } = generateCdpKeypair();
    const client = new CoinbaseOrderClient({
      apiKey: CDP_KID,
      apiSecret: privatePem,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => TS,
      nonce: () => 'nonce-perp',
    });

    await client.placeMarketOrder({
      productId: 'BTC-PERP-INTX',
      side: 'sell',
      baseSize: 0.001,
      leverage: 1,
      marginType: 'ISOLATED',
      positionSide: 'SHORT',
      clientOrderId: 'cli-perp-jwt',
    });

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    const sentBody = JSON.parse(init.body as string);
    expect(sentBody.leverage).toBe('1');
    expect(sentBody.margin_type).toBe('ISOLATED');
    expect(sentBody.position_side).toBe('SHORT');

    const headers = init.headers as Record<string, string>;
    const jwt = headers.Authorization.slice('Bearer '.length);
    const { payload, signingInput, signature } = decodeJwtParts(jwt);
    expect(payload.uri).toBe('POST api.coinbase.com/api/v3/brokerage/orders');
    const ok = createVerify('SHA256')
      .update(signingInput)
      .verify({ key: publicPem, dsaEncoding: 'ieee-p1363' }, signature);
    expect(ok).toBe(true);
  });

  // TRA-224 follow-up — Coinbase's CDP authenticator strips the query string
  // from the URL before validating the JWT `uri` claim (matching their
  // official Python SDK which builds the claim from `urlparse(url).path`
  // only). If we leave the query in our claim, GET /products?product_ids=…
  // 401s and the live dashboard silently falls back to cash-only equity.
  it('strips the query string from the URI claim so /products lookups authenticate', async () => {
    const { privatePem } = generateCdpKeypair();
    const client = new CoinbaseOrderClient({
      apiKey: CDP_KID,
      apiSecret: privatePem,
      fetchImpl: fetchMock as unknown as typeof fetch,
      now: () => TS,
      nonce: () => 'nonce-pp',
    });
    fetchMock.mockResolvedValueOnce(jsonResponse({
      products: [{ product_id: 'BTC-USD', price: '60000' }],
    }));

    await client.getProductPrices(['BTC-USD', 'ETH-USD']);

    const [url, init] = fetchMock.mock.calls[0];
    // The actual fetch URL must keep the query string so Coinbase filters by product.
    expect(String(url)).toBe(
      'https://api.coinbase.com/api/v3/brokerage/products?product_ids=BTC-USD&product_ids=ETH-USD',
    );
    const headers = (init as RequestInit).headers as Record<string, string>;
    const jwt = headers.Authorization.slice('Bearer '.length);
    const { payload } = decodeJwtParts(jwt);
    // …but the JWT's URI claim must NOT include the query string.
    expect(payload.uri).toBe('GET api.coinbase.com/api/v3/brokerage/products');
  });

  // TRA-222 — the Settings UI stores the API Secret in a single-line
  // <input type="password">, which strips real newlines from pasted PEMs.
  // CoinbaseOrderClient must still accept the mangled forms users actually
  // paste. Without this, every order fails before it leaves the process with
  // OpenSSL `error:1E08010C:DECODER routines::unsupported`.
  describe('forgiving CDP private key parsing', () => {
    it('accepts a key whose newlines have been replaced with literal \\n', () => {
      const { privatePem } = generateCdpKeypair();
      const escaped = privatePem.replace(/\n/g, '\\n');
      expect(escaped).not.toBe(privatePem);
      const client = new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: escaped });
      expect(client.getAuthScheme()).toBe('cdp');
    });

    it('accepts a key flattened to a single line (no newlines at all)', () => {
      const { privatePem } = generateCdpKeypair();
      // Single-line <input> paste: real newlines turn into spaces or vanish.
      const flattened = privatePem.replace(/\n/g, '');
      const client = new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: flattened });
      expect(client.getAuthScheme()).toBe('cdp');
    });

    it('accepts the full JSON download Coinbase produces (extracts privateKey)', () => {
      const { privatePem } = generateCdpKeypair();
      const blob = JSON.stringify({
        name: CDP_KID,
        privateKey: privatePem,
      });
      const client = new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: blob });
      expect(client.getAuthScheme()).toBe('cdp');
    });

    it('strips wrapping quotes from a copy-pasted JSON value', () => {
      const { privatePem } = generateCdpKeypair();
      const quoted = `"${privatePem.replace(/\n/g, '\\n')}"`;
      const client = new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: quoted });
      expect(client.getAuthScheme()).toBe('cdp');
    });

    it('still rejects PEMs with garbage between the markers', () => {
      const broken = '-----BEGIN EC PRIVATE KEY----- not-real-bytes -----END EC PRIVATE KEY-----';
      expect(() => new CoinbaseOrderClient({ apiKey: CDP_KID, apiSecret: broken })).toThrow(/CDP private key/);
    });
  });
});
