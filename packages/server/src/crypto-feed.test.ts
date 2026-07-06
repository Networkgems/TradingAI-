import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isCoinbaseListed,
  listTradableCoinbaseUsdSymbols,
  fetchCoinbaseAdvancedTradeQuotes,
  fetchCoinbaseAdvancedTradeCandles,
  fetchCoinGeckoQuotes,
  isCoinGeckoBreakerOpen,
  mapWithConcurrency,
  _resetCoinGeckoBreakerForTests,
  _resetCoinbaseProductCatalogForTests,
  _seedCoinbaseProductCatalogForTests,
} from './crypto-feed.js';

// TRA-1387 — the bounded-concurrency map that caps how many per-symbol Coinbase
// `/stats` request wrappers + native response buffers are in flight at once.
// The full-universe fan-out hanging on a blocked Render egress IP was the
// sub-minute RSS burst behind the bqb1 137 OOM; this helper is the fix, so the
// two invariants that make it safe — a hard cap on peak concurrency and
// order-preserving, complete results — are pinned here.
describe('mapWithConcurrency — bounded per-symbol fan-out (TRA-1387)', () => {
  it('never exceeds the concurrency cap and preserves input order', async () => {
    const items = Array.from({ length: 40 }, (_, i) => i);
    let inFlight = 0;
    let peak = 0;
    const out = await mapWithConcurrency(items, 6, async n => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      // Yield so multiple workers genuinely overlap before any resolves.
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return n * 2;
    });
    expect(peak).toBeLessThanOrEqual(6);
    expect(peak).toBeGreaterThan(1); // the pool actually parallelises
    expect(out).toEqual(items.map(n => n * 2));
  });

  it('handles an empty list and a cap larger than the item count', async () => {
    expect(await mapWithConcurrency([], 6, async () => 1)).toEqual([]);
    let peak = 0;
    let inFlight = 0;
    const out = await mapWithConcurrency([1, 2, 3], 100, async n => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise(resolve => setTimeout(resolve, 1));
      inFlight -= 1;
      return n;
    });
    expect(out).toEqual([1, 2, 3]);
    expect(peak).toBeLessThanOrEqual(3); // capped to item count, never over-spawns
  });
});

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

// TRA-693 — `listTradableCoinbaseUsdSymbols` is the "trade all Coinbase-tradable
// cryptos" universe (board directive). It feeds the engine's active-symbol set
// so the DCA roster covers the full ~395-pair Coinbase USD universe instead of a
// static watchlist. Same catalog + seed hooks as the gate tests above.
describe('listTradableCoinbaseUsdSymbols — full Coinbase USD universe (TRA-693)', () => {
  beforeEach(() => {
    _resetCoinbaseProductCatalogForTests();
  });

  it('returns an empty list on a cold catalog so callers fall back to their static watchlist', () => {
    expect(listTradableCoinbaseUsdSymbols()).toEqual([]);
  });

  it('returns only online, trading-enabled *-USD spot products', () => {
    _seedCoinbaseProductCatalogForTests([
      { id: 'BTC-USD', online: true, tradingDisabled: false },
      { id: 'SOL-USD', online: true, tradingDisabled: false },
      { id: 'WIF-USD', online: true, tradingDisabled: false },
      { id: 'OFFLINE-USD', online: false, tradingDisabled: false }, // delisted/maintenance
      { id: 'HALTED-USD', online: true, tradingDisabled: true },    // trading suspended
      { id: 'BTC-USDC', online: true, tradingDisabled: false },     // non-USD quote
      { id: 'ETH-EUR', online: true, tradingDisabled: false },      // non-USD quote
      { id: 'BTC-PERP-INTX', online: true, tradingDisabled: false },// perp, not spot USD
    ]);
    const out = listTradableCoinbaseUsdSymbols().sort();
    expect(out).toEqual(['BTC-USD', 'SOL-USD', 'WIF-USD']);
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

describe('fetchCoinGeckoQuotes — datacenter-reachable crypto fallback (TRA-833)', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
    _resetCoinGeckoBreakerForTests();
    vi.restoreAllMocks();
  });

  it('returns an empty map without calling fetch for an empty symbol list', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinGeckoQuotes([]);
    expect(out.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('maps TICKER-USD product ids to bare lowercase tickers in the symbols filter', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(url).toContain('https://api.coingecko.com/api/v3/coins/markets');
      expect(url).toContain('vs_currency=usd');
      // URLSearchParams encodes the comma in `btc,sol` as %2C.
      expect(decodeURIComponent(url)).toContain('symbols=btc,sol');
      return {
        ok: true,
        status: 200,
        json: async () => [
          { symbol: 'btc', current_price: 64000, price_change_percentage_24h: 1.5, total_volume: 100 },
          { symbol: 'sol', current_price: 68.2, price_change_percentage_24h: -2, total_volume: 50 },
        ],
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchCoinGeckoQuotes(['BTC-USD', 'SOL-USD']);

    expect(out.get('BTC-USD')).toEqual({
      price: 64000,
      volume: 100,
      change: 64000 * 0.015,
      changePct: 1.5,
      source: 'coingecko',
    });
    expect(out.get('SOL-USD')?.price).toBe(68.2);
    expect(out.get('SOL-USD')?.changePct).toBe(-2);
  });

  it('keeps the first (highest-market-cap) row when a ticker is ambiguous', async () => {
    // CoinGecko returns rows market-cap-descending; a lower-cap namesake later in
    // the page must not clobber the canonical price.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { symbol: 'btc', current_price: 64000, price_change_percentage_24h: 0, total_volume: 1 },
        { symbol: 'btc', current_price: 0.0001, price_change_percentage_24h: 99, total_volume: 1 },
      ],
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinGeckoQuotes(['BTC-USD']);
    expect(out.get('BTC-USD')?.price).toBe(64000);
  });

  it('drops rows with a non-positive or unparseable price', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => [
        { symbol: 'good', current_price: 5, price_change_percentage_24h: 0, total_volume: 1 },
        { symbol: 'zero', current_price: 0 },
        { symbol: 'nan', current_price: 'x' as unknown as number },
      ],
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinGeckoQuotes(['GOOD-USD', 'ZERO-USD', 'NAN-USD']);
    expect(out.size).toBe(1);
    expect(out.get('GOOD-USD')?.price).toBe(5);
  });

  it('opens a 60s breaker on HTTP 429 and short-circuits subsequent calls', async () => {
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ([]) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinGeckoQuotes(['BTC-USD']);
    expect(out.size).toBe(0);
    expect(isCoinGeckoBreakerOpen()).toBe(true);
    // While the breaker is open the next call must not hit the network at all.
    fetchMock.mockClear();
    const out2 = await fetchCoinGeckoQuotes(['ETH-USD']);
    expect(out2.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns an empty map (does not throw) when fetch rejects', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinGeckoQuotes(['ADA-USD']);
    expect(out.size).toBe(0);
  });
});

describe('fetchCoinbaseAdvancedTradeCandles — keyless OHLC candle fallback (TRA-438)', () => {
  const realFetch = globalThis.fetch;
  const HOUR = 3_600_000;

  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('returns an empty array without calling fetch for a non-positive window', async () => {
    const fetchMock = vi.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const now = Date.now();
    const out = await fetchCoinbaseAdvancedTradeCandles('BTC-USD', 3_600, now, now);
    expect(out).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hits the keyless market/products candles endpoint with the granularity enum', async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async (url: string) => {
      // Must be the unauthenticated `market/` sibling on the Advanced Trade
      // host — no API key, no signing.
      expect(url).toContain('https://api.coinbase.com/api/v3/brokerage/market/products/BTC-USD/candles');
      expect(url).toContain('granularity=ONE_HOUR');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          candles: [
            { start: String(Math.floor((now - HOUR) / 1000)), low: '99', high: '101', open: '100', close: '100.5', volume: '12' },
          ],
        }),
      };
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchCoinbaseAdvancedTradeCandles('BTC-USD', 3_600, now - 2 * HOUR, now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: 'BTC-USD', open: 100, high: 101, low: 99, close: 100.5, volume: 12 });
  });

  it('parses candle rows ascending and deduped on the open second', async () => {
    const now = Date.now();
    const t1 = Math.floor((now - 2 * HOUR) / 1000);
    const t2 = Math.floor((now - HOUR) / 1000);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        // Coinbase returns descending; one duplicate timestamp.
        candles: [
          { start: String(t2), low: '5', high: '7', open: '6', close: '6.5', volume: '2' },
          { start: String(t1), low: '4', high: '6', open: '5', close: '5.5', volume: '1' },
          { start: String(t2), low: '5', high: '7', open: '6', close: '6.5', volume: '2' },
        ],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchCoinbaseAdvancedTradeCandles('ETH-USD', 3_600, now - 3 * HOUR, now);
    expect(out).toHaveLength(2);
    expect(out[0].timestamp).toBeLessThan(out[1].timestamp);
  });

  it('drops rows with a non-positive or unparseable close', async () => {
    const now = Date.now();
    const base = Math.floor((now - 3 * HOUR) / 1000);
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        candles: [
          { start: String(base), low: '4', high: '6', open: '5', close: '5.5', volume: '1' },
          { start: String(base + 3600), low: '0', high: '0', open: '0', close: '0', volume: '0' },
          { start: String(base + 7200), low: 'x', high: 'x', open: 'x', close: 'x', volume: 'x' },
        ],
      }),
    }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await fetchCoinbaseAdvancedTradeCandles('BTC-USD', 3_600, now - 4 * HOUR, now);
    expect(out).toHaveLength(1);
    expect(out[0].close).toBe(5.5);
  });

  it('returns an empty array (does not throw) on a non-OK HTTP response', async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async () => ({ ok: false, status: 429, json: async () => ({}) }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinbaseAdvancedTradeCandles('BTC-USD', 60, now - HOUR, now);
    expect(out).toEqual([]);
  });

  it('returns an empty array (does not throw) when fetch rejects', async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async () => { throw new Error('network down'); });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    const out = await fetchCoinbaseAdvancedTradeCandles('BTC-USD', 86_400, now - 86_400_000, now);
    expect(out).toEqual([]);
  });
});
