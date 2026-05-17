import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isCoinbaseListed,
  fetchCoinbaseAdvancedTradeQuotes,
  _resetCoinbaseProductCatalogForTests,
  _seedCoinbaseProductCatalogForTests,
} from './crypto-feed.js';

// TRA-338 — the Coinbase product allowlist is the gate the crypto engine uses
// to decide whether to even consider opening a position on a symbol. Tests
// exercise it via the seed/reset hooks rather than a real /products fetch so
// they stay deterministic offline.
describe('isCoinbaseListed — Coinbase product allowlist gate (TRA-338)', () => {
  beforeEach(() => {
    _resetCoinbaseProductCatalogForTests();
  });

  it('returns null when the catalog has never been refreshed (fail-closed signal)', () => {
    // Caller must treat null as "do not open until we know" — see the engine's
    // doTick gate. Returning null instead of false lets a /products outage
    // distinguishably suppress entries without poisoning the cache.
    expect(isCoinbaseListed('BTC-USD')).toBeNull();
  });

  it('returns true for a product that is online and not trading-disabled', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BTC-USD', online: true, tradingDisabled: false },
    ]);
    expect(isCoinbaseListed('BTC-USD')).toBe(true);
  });

  it('returns false for a product Coinbase does not list', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BTC-USD', online: true, tradingDisabled: false },
    ]);
    // MEGA-USD is the TRA-337 root cause: not on Coinbase at all, and Yahoo's
    // ghost MEGA-USD ticker resolves to a delisted-2022 token.
    expect(isCoinbaseListed('MEGA-USD')).toBe(false);
  });

  it('returns false for a product whose status is not "online"', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'FOO-USD', online: false, tradingDisabled: false },
    ]);
    expect(isCoinbaseListed('FOO-USD')).toBe(false);
  });

  it('returns false for a product whose trading is disabled', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BAR-USD', online: true, tradingDisabled: true },
    ]);
    expect(isCoinbaseListed('BAR-USD')).toBe(false);
  });
});

// TRA-437 — the keyless Coinbase Advanced Trade public price fallback. This is
// the second keyless venue in the quote cascade: when the Exchange host
// (`api.exchange.coinbase.com`) is degraded for the egress IP and Yahoo's
// breaker is open with no CMC key, this `api.coinbase.com` endpoint is the
// only thing keeping demo crypto users from a watchlist of "Quote unavailable
// — provider rate-limited". Tests mock `fetch` so they stay deterministic
// offline.
describe('fetchCoinbaseAdvancedTradeQuotes — keyless Advanced Trade fallback (TRA-437)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns an empty map without calling fetch for an empty symbol list', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinbaseAdvancedTradeQuotes([]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('parses prices, 24h volume and change% from the public market/products response', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      // The endpoint must be the unauthenticated `market/` sibling on the
      // Advanced Trade host — no API key, no signing.
      expect(url).toContain('https://api.coinbase.com/api/v3/brokerage/market/products');
      expect(url).toContain('product_ids=BTC-USD');
      expect(url).toContain('product_ids=ETH-USD');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          products: [
            { product_id: 'BTC-USD', price: '64000', volume_24h: '1200', price_percentage_change_24h: '2.5' },
            { product_id: 'ETH-USD', price: '3100', volume_24h: '8000', price_percentage_change_24h: '-1.0' },
          ],
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchCoinbaseAdvancedTradeQuotes(['BTC-USD', 'ETH-USD']);

    expect(out.get('BTC-USD')).toEqual({
      price: 64000,
      volume: 1200,
      change: 64000 * 0.025,
      changePct: 2.5,
      source: 'coinbase',
    });
    expect(out.get('ETH-USD')?.price).toBe(3100);
    expect(out.get('ETH-USD')?.changePct).toBe(-1.0);
  });

  it('drops products with a non-positive or unparseable price', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        products: [
          { product_id: 'GOOD-USD', price: '5', volume_24h: '1', price_percentage_change_24h: '0' },
          { product_id: 'ZERO-USD', price: '0' },
          { product_id: 'NAN-USD', price: 'not-a-number' },
          { product_id: 'NOPRICE-USD' },
        ],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchCoinbaseAdvancedTradeQuotes(['GOOD-USD', 'ZERO-USD', 'NAN-USD', 'NOPRICE-USD']);

    expect(out.size).toBe(1);
    expect(out.get('GOOD-USD')?.price).toBe(5);
  });

  it('returns an empty map (does not throw) on a non-OK HTTP response', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinbaseAdvancedTradeQuotes(['BTC-USD']);
    expect(out.size).toBe(0);
  });

  it('returns an empty map (does not throw) when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinbaseAdvancedTradeQuotes(['BTC-USD']);
    expect(out.size).toBe(0);
  });
});
