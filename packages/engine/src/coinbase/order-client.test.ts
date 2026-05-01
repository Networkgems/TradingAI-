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

  it('reports the HMAC scheme when given a printable shared secret', () => {
    expect(makeClient().getAuthScheme()).toBe('hmac');
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
