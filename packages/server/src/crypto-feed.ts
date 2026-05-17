import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem, PositionQuoteSource } from '@trading-app/shared';
import {
  fetchCoinbase4hBars,
  fetchCoinbaseDailyBars,
  fetchCoinbaseMinuteBars,
  isCoinbaseBreakerOpen,
  paceCoinbaseFetch,
  aggregate1hTo4h,
  fillGrid4h,
} from '@trading-app/backtest';

export { isCoinbaseBreakerOpen };
import { isYahooBreakerOpen, toIsoTime, tripYahooBreakerFromExternal } from './yahoo-feed.js';
import { logger } from './observability/index.js';

const feedLog = logger.child({ module: 'crypto-feed' });

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: true },
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Per-call timeout. Yahoo and CMC occasionally hang; without a timeout the 60-second
// crypto tick blocks indefinitely, leaving the watchlist stuck "Loading…".
const FEED_CALL_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

// Yahoo and crypto-feed share the same outbound IP, so a 429 on stock quotes also
// applies to crypto quotes. Skip YF for crypto while the shared breaker is open and
// fall straight through to CMC, instead of burning 8s per symbol on a doomed call.
function shouldSkipYahoo(): boolean {
  return isYahooBreakerOpen();
}

function isYahooRateLimitError(msg: string): boolean {
  return /\b429\b|Too Many Requests|crumb/i.test(msg);
}

const CMC_API_KEY = process.env.CMC_API_KEY ?? '';
const CMC_BASE = 'https://pro-api.coinmarketcap.com';

if (!CMC_API_KEY) {
  console.warn('[crypto-feed] CMC_API_KEY is not set — CoinMarketCap fallback disabled');
}

/**
 * TRA-338 — typed crypto quote with provenance. Same numeric shape the cascade
 * has always emitted, plus a `source` tag that records which provider supplied
 * the price. The crypto engine threads this onto every new position so a
 * future incident (cf. TRA-337's MEGA-USD phantom $4.05 entry from a Yahoo
 * ghost ticker) can be triaged from the trades API rather than from the logs.
 */
export interface CryptoQuote {
  price: number;
  volume: number;
  change: number;
  changePct: number;
  source: PositionQuoteSource; // 'coinbase' | 'yahoo' | 'cmc' (never 'manual'/'unknown' from this path)
}

/**
 * TRA-338 — Coinbase Exchange product allowlist. Populated lazily by
 * `refreshCoinbaseProductCatalog()`; kept module-level so every per-user
 * crypto engine shares one catalog (the data is venue-wide). A symbol is
 * "tradable on Coinbase" iff it appears in the catalog AND its product entry
 * has `status === 'online' && trading_disabled === false`.
 *
 * The catalog is the gate the engine uses to decide whether to even consider
 * routing a strategy signal: if Coinbase doesn't list the symbol we don't
 * open a position, full stop. Yahoo / CMC stay on the path for *display*
 * refreshes only.
 */
let coinbaseProductCatalog: Map<string, { online: boolean; tradingDisabled: boolean }> | null = null;
let coinbaseCatalogLastRefreshed = 0;
/** Refresh cadence — catalog rarely changes intraday, so 1h is plenty. */
const COINBASE_CATALOG_TTL_MS = 60 * 60_000;

/**
 * TRA-338 — fetch (or refresh, when stale) the Coinbase Exchange product
 * catalog and populate the module-level allowlist. Best-effort: a network
 * blip leaves the prior catalog in place rather than nuking it (we'd rather
 * skip a possibly-listed symbol once than open a Yahoo-priced ghost).
 *
 * Behaviour:
 *  - First call after boot fans out one `GET /products` (returns ~600
 *    products; cheap and cached upstream). Subsequent calls inside the TTL
 *    window are no-ops.
 *  - On a successful refresh the catalog is replaced atomically; on failure
 *    the prior catalog (if any) is preserved.
 *  - The status fields on each entry are derived from Coinbase's per-product
 *    `status` and `trading_disabled` flags so `isCoinbaseListed` can answer
 *    "online + tradable" without a per-call /products lookup.
 */
export async function refreshCoinbaseProductCatalog(): Promise<void> {
  const now = Date.now();
  if (coinbaseProductCatalog && now - coinbaseCatalogLastRefreshed < COINBASE_CATALOG_TTL_MS) return;
  try {
    const resp = await withTimeout(
      paceCoinbaseFetch(`${COINBASE_BASE}/products`, {
        headers: { 'User-Agent': 'TRA-338/1.0', Accept: 'application/json' },
      }),
      FEED_CALL_TIMEOUT_MS,
      'Coinbase /products',
    );
    if (!resp.ok) {
      console.warn(`[crypto-feed] Coinbase /products HTTP ${resp.status} — catalog not refreshed`);
      return;
    }
    const json = (await resp.json()) as Array<{
      id?: string;
      status?: string;
      trading_disabled?: boolean;
    }>;
    const next = new Map<string, { online: boolean; tradingDisabled: boolean }>();
    for (const p of json) {
      if (!p?.id) continue;
      next.set(p.id, {
        online: p.status === 'online',
        tradingDisabled: p.trading_disabled === true,
      });
    }
    coinbaseProductCatalog = next;
    coinbaseCatalogLastRefreshed = now;
  } catch (err: unknown) {
    console.warn(`[crypto-feed] refreshCoinbaseProductCatalog: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * TRA-338 — `true` iff `symbol` is listed on Coinbase Exchange AND the
 * product is online and not trading-disabled. Returns `null` when the
 * catalog has never been successfully fetched, so callers can choose
 * fail-closed semantics (skip the signal until we know) instead of
 * fail-open (the failure mode that produced TRA-337).
 */
export function isCoinbaseListed(symbol: string): boolean | null {
  if (!coinbaseProductCatalog) return null;
  const entry = coinbaseProductCatalog.get(symbol);
  if (!entry) return false;
  return entry.online && !entry.tradingDisabled;
}

/** Test hook: clear the catalog so tests can simulate cold-start states. */
export function _resetCoinbaseProductCatalogForTests(): void {
  coinbaseProductCatalog = null;
  coinbaseCatalogLastRefreshed = 0;
}

/** Test hook: seed an in-memory catalog (instead of hitting Coinbase). */
export function _seedCoinbaseProductCatalogForTests(
  entries: ReadonlyArray<{ id: string; online: boolean; tradingDisabled: boolean }>,
): void {
  const next = new Map<string, { online: boolean; tradingDisabled: boolean }>();
  for (const e of entries) next.set(e.id, { online: e.online, tradingDisabled: e.tradingDisabled });
  coinbaseProductCatalog = next;
  coinbaseCatalogLastRefreshed = Date.now();
}

// Convert Yahoo Finance crypto symbol format to CMC symbol (BTC-USD -> BTC)
function toCMCSymbol(yahooSymbol: string): string {
  return yahooSymbol.replace(/-USD$/, '').replace(/-USDT$/, '');
}

/**
 * TRA-300 — Coinbase Exchange public stats endpoint, the primary quote
 * source for crypto. Same venue as the live trade account, so signal /
 * watchlist prices align with execution prices and we no longer depend on
 * Yahoo Finance for the major USD spot pairs (Yahoo's per-IP rate-limiter
 * would otherwise mark every symbol "Quote unavailable" the moment it
 * started 429-ing the egress IP).
 *
 * Public endpoint, no auth required. Per-product call to
 * `/products/{id}/stats` returns `{ open, high, low, last, volume, … }` —
 * `last` is the spot price, `volume` is 24h base-currency volume, and
 * change% is computed from `(last - open) / open * 100`. We fan out in
 * concurrency-5 batches with a 150ms gap between batches to stay well
 * inside Coinbase's public-data 10 req/s limit. Symbols Coinbase doesn't
 * list (BNB-USD, VET-USD, EGLD-USD, RUNE-USD, …) get a per-symbol 404 and
 * fall through to the YF / CMC fallbacks in `fetchCryptoQuotes`.
 */
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
async function fetchCoinbaseStatsQuotes(
  symbols: readonly string[],
): Promise<Map<string, CryptoQuote>> {
  const results = new Map<string, CryptoQuote>();
  if (symbols.length === 0) return results;
  // All requests route through `paceCoinbaseFetch` so they share the same
  // 10 req/s/IP budget as the candle fetchers (TRA-300 — see scheduler doc
  // in `coinbase-feed.ts`). Promise.all on the full list is safe because
  // the scheduler serialises with a 120 ms min gap; inflating concurrency
  // here just queues, it never bursts.
  const settled = await Promise.all(symbols.map(async sym => {
    try {
      const resp = await withTimeout(
        paceCoinbaseFetch(`${COINBASE_BASE}/products/${encodeURIComponent(sym)}/stats`, {
          headers: { 'User-Agent': 'TRA-300/1.0', Accept: 'application/json' },
        }),
        FEED_CALL_TIMEOUT_MS,
        `Coinbase stats(${sym})`,
      );
      if (!resp.ok) return [sym, null] as const;
      const json = (await resp.json()) as { open?: string; last?: string; volume?: string };
      const price = Number(json.last);
      const open = Number(json.open);
      const volume = Number(json.volume ?? 0);
      if (!Number.isFinite(price) || price <= 0) return [sym, null] as const;
      const changePct = Number.isFinite(open) && open > 0 ? ((price - open) / open) * 100 : 0;
      const change = price - (Number.isFinite(open) ? open : price);
      return [sym, { price, volume, change, changePct, source: 'coinbase' as const }] as const;
    } catch (err) {
      // TRA-406 — was a bare `catch {}`. A Coinbase feed failure is a degraded
      // signal source; log it (the caller still falls back to a null quote).
      feedLog.warn('Coinbase stats quote failed', {
        symbol: sym,
        reason: err instanceof Error ? err.message : String(err),
      });
      return [sym, null] as const;
    }
  }));
  for (const [sym, q] of settled) {
    if (q) results.set(sym, q);
  }
  return results;
}

/**
 * TRA-437 — keyless Coinbase Advanced Trade public price fallback.
 *
 * `fetchCoinbaseStatsQuotes` above hits `api.exchange.coinbase.com`. On the
 * Render egress IP that host can be rate-limited or unreachable independently
 * of the Advanced Trade host, which leaves the cascade with no working keyless
 * source once Yahoo's breaker is open and CMC has no API key — the exact
 * failure mode behind TRA-437 (every crypto watchlist symbol rendered
 * "Quote unavailable — provider rate-limited" for demo users).
 *
 * This fetcher hits the *public* Advanced Trade market endpoint —
 * `GET /api/v3/brokerage/market/products` on `api.coinbase.com`. No API key,
 * no request signing: it is the unauthenticated `market/` sibling of the
 * signed `/api/v3/brokerage/products` endpoint the live broker uses. Adding it
 * gives the cascade a second keyless venue on a different host, so demo crypto
 * engines (no live broker attached) still render real prices when the Exchange
 * host is degraded.
 *
 * One batched request covers every symbol (the endpoint accepts repeated
 * `product_ids` params). Symbols Coinbase doesn't list are simply absent from
 * the response and fall through to the caller's next provider. `source` is
 * tagged `coinbase` — same venue as live execution — so the engine's
 * Coinbase-strict entry gate (TRA-338) accepts these prices for entries.
 */
const COINBASE_ADVANCED_TRADE_BASE = 'https://api.coinbase.com';
export async function fetchCoinbaseAdvancedTradeQuotes(
  symbols: readonly string[],
): Promise<Map<string, CryptoQuote>> {
  const results = new Map<string, CryptoQuote>();
  if (symbols.length === 0) return results;
  try {
    const params = new URLSearchParams();
    for (const s of symbols) params.append('product_ids', s);
    const resp = await withTimeout(
      fetch(
        `${COINBASE_ADVANCED_TRADE_BASE}/api/v3/brokerage/market/products?${params.toString()}`,
        { headers: { 'User-Agent': 'TRA-437/1.0', Accept: 'application/json' } },
      ),
      FEED_CALL_TIMEOUT_MS,
      'Coinbase Advanced Trade market/products',
    );
    if (!resp.ok) {
      feedLog.warn('Coinbase Advanced Trade market/products failed', { status: resp.status });
      return results;
    }
    const json = (await resp.json()) as {
      products?: Array<{
        product_id?: string;
        price?: string;
        volume_24h?: string;
        price_percentage_change_24h?: string;
      }>;
    };
    for (const p of json.products ?? []) {
      if (!p?.product_id) continue;
      const price = Number(p.price);
      if (!Number.isFinite(price) || price <= 0) continue;
      const changePct = Number(p.price_percentage_change_24h);
      const volume = Number(p.volume_24h);
      const safeChangePct = Number.isFinite(changePct) ? changePct : 0;
      results.set(p.product_id, {
        price,
        volume: Number.isFinite(volume) ? volume : 0,
        change: price * (safeChangePct / 100),
        changePct: safeChangePct,
        source: 'coinbase',
      });
    }
  } catch (err: unknown) {
    feedLog.warn('Coinbase Advanced Trade quote fetch failed', {
      reason: err instanceof Error ? err.message : String(err),
    });
  }
  return results;
}

/**
 * TRA-438 — keyless Coinbase Advanced Trade public OHLCV candles fallback.
 *
 * TRA-437 gave the *quote* cascade a second keyless venue on `api.coinbase.com`
 * so demo crypto users keep getting prices when the Exchange host
 * (`api.exchange.coinbase.com`) is rate-limited / unreachable for the Render
 * egress IP. But the *candle* feeders (`fetchCryptoMinuteBars` /
 * `fetchCrypto4hBars` / `fetchCryptoDailyBars`) were never given the same
 * backstop: their cascade is Coinbase Exchange → Yahoo only. When the Exchange
 * breaker is open AND Yahoo's per-IP breaker is open, every candle fetcher
 * returns `[]` → strategies receive empty OHLC series → zero signals → zero
 * trades. Quotes alone don't help: strategies evaluate off candles, not the
 * last price (TRA-438 board report — "no signals or trades" in demo Crypto).
 *
 * This fetcher hits the *public* Advanced Trade market candles endpoint —
 * `GET /api/v3/brokerage/market/products/{product_id}/candles` on
 * `api.coinbase.com`. No API key, no request signing: the unauthenticated
 * `market/` sibling of the signed `/api/v3/brokerage/products/.../candles`
 * endpoint the live broker uses. It is a different host from the Exchange
 * feed, so a demo engine keeps a working keyless OHLC source when the Exchange
 * host is degraded.
 *
 * Granularity is an enum (`ONE_MINUTE` / `ONE_HOUR` / `ONE_DAY`); the endpoint
 * caps each response at 350 candles, so the `[fromMs, toMs)` window is
 * paginated in 300-bar chunks (300 < 350 leaves headroom). Rows come back as
 * `{ start, low, high, open, close, volume }` string fields. Result is
 * ascending-by-timestamp and deduped on the bar's open second, matching the
 * `Candle[]` shape the Exchange path emits.
 */
const COINBASE_AT_CANDLE_GRANULARITY: Record<number, string> = {
  60: 'ONE_MINUTE',
  3_600: 'ONE_HOUR',
  86_400: 'ONE_DAY',
};
const COINBASE_AT_MAX_CANDLES = 300; // endpoint hard cap is 350; 300 leaves headroom

export async function fetchCoinbaseAdvancedTradeCandles(
  symbol: string,
  granularitySeconds: 60 | 3_600 | 86_400,
  fromMs: number,
  toMs: number,
): Promise<Candle[]> {
  if (toMs <= fromMs) return [];
  const granEnum = COINBASE_AT_CANDLE_GRANULARITY[granularitySeconds];
  if (!granEnum) return [];
  const stepMs = COINBASE_AT_MAX_CANDLES * granularitySeconds * 1000;
  const all: Candle[] = [];
  try {
    let cursor = fromMs;
    while (cursor < toMs) {
      const winEnd = Math.min(cursor + stepMs, toMs);
      const params = new URLSearchParams({
        start: String(Math.floor(cursor / 1000)),
        end: String(Math.floor(winEnd / 1000)),
        granularity: granEnum,
        limit: String(COINBASE_AT_MAX_CANDLES),
      });
      const resp = await withTimeout(
        fetch(
          `${COINBASE_ADVANCED_TRADE_BASE}/api/v3/brokerage/market/products/${encodeURIComponent(symbol)}/candles?${params.toString()}`,
          { headers: { 'User-Agent': 'TRA-438/1.0', Accept: 'application/json' } },
        ),
        FEED_CALL_TIMEOUT_MS,
        `Coinbase AT candles(${symbol} ${granEnum})`,
      );
      if (!resp.ok) {
        // A failed window aborts the fetch — partial OHLC history would shift
        // every downstream indicator window, so we return what we have (or
        // nothing) and let the caller fall through to the next provider.
        feedLog.warn('Coinbase Advanced Trade candles failed', {
          symbol,
          granularity: granEnum,
          status: resp.status,
        });
        break;
      }
      const json = (await resp.json()) as {
        candles?: Array<{
          start?: string;
          low?: string;
          high?: string;
          open?: string;
          close?: string;
          volume?: string;
        }>;
      };
      for (const c of json.candles ?? []) {
        const ts = Number(c?.start) * 1000;
        const open = Number(c?.open);
        const high = Number(c?.high);
        const low = Number(c?.low);
        const close = Number(c?.close);
        const volume = Number(c?.volume);
        if (!Number.isFinite(ts) || ts <= 0) continue;
        if (![open, high, low, close].every(Number.isFinite) || close <= 0) continue;
        all.push({
          symbol,
          timestamp: ts,
          open,
          high,
          low,
          close,
          volume: Number.isFinite(volume) ? volume : 0,
        });
      }
      cursor = winEnd;
    }
  } catch (err: unknown) {
    feedLog.warn('Coinbase Advanced Trade candle fetch failed', {
      symbol,
      granularity: granEnum,
      reason: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
  all.sort((a, b) => a.timestamp - b.timestamp);
  const seen = new Set<number>();
  return all.filter(c => (seen.has(c.timestamp) ? false : (seen.add(c.timestamp), true)));
}

async function fetchCMCBatchQuotes(
  symbols: readonly string[],
): Promise<Map<string, CryptoQuote>> {
  if (!CMC_API_KEY || symbols.length === 0) return new Map();
  const cmcSymbolList = [...new Set(symbols.map(toCMCSymbol))].join(',');
  try {
    const resp = await withTimeout(
      fetch(
        `${CMC_BASE}/v1/cryptocurrency/quotes/latest?symbol=${cmcSymbolList}&convert=USD`,
        { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' } },
      ),
      FEED_CALL_TIMEOUT_MS,
      `CMC quotes(${cmcSymbolList})`,
    );
    if (!resp.ok) {
      console.error(`[crypto-feed] CMC quotes/latest HTTP ${resp.status} for ${cmcSymbolList}`);
      return new Map();
    }
    const json = (await resp.json()) as {
      data?: Record<
        string,
        { quote?: { USD?: { price?: number; percent_change_24h?: number; volume_24h?: number } } }
      >;
    };
    const results = new Map<string, CryptoQuote>();
    for (const sym of symbols) {
      const data = json?.data?.[toCMCSymbol(sym)]?.quote?.USD;
      if (data?.price == null) continue;
      const price = data.price as number;
      const changePct = (data.percent_change_24h as number) ?? 0;
      results.set(sym, {
        price,
        volume: (data.volume_24h as number) ?? 0,
        change: price * (changePct / 100),
        changePct,
        source: 'cmc',
      });
    }
    return results;
  } catch (err: unknown) {
    console.error('[crypto-feed] CMC batch quotes error:', err instanceof Error ? err.message : String(err));
    return new Map();
  }
}

/**
 * TRA-300 — daily bars from Coinbase Exchange (granularity=86400) with Yahoo
 * fallback for symbols Coinbase doesn't list. Same venue alignment as the
 * quote and 4H paths so signal/exit math matches execution prices.
 *
 * Behaviour matches the legacy YF-only path: bars with `volume <= 0` are
 * dropped (so 0-volume gaps don't pollute indicator math), and the
 * in-progress current UTC day is retained if it has non-zero volume — the
 * engine has always seen the partial-today bar and strategies are
 * calibrated to that input shape.
 */
export async function fetchCryptoDailyBars(symbol: string, count = 260): Promise<Candle[]> {
  const now = Date.now();
  const fromMs = now - count * 86_400_000 * 1.5; // buffer for Coinbase listing date / Yahoo gaps

  // Primary: Coinbase Exchange.
  try {
    const bars = await withTimeout(
      fetchCoinbaseDailyBars(symbol, fromMs, now),
      FEED_CALL_TIMEOUT_MS,
      `coinbase-1d(${symbol})`,
    );
    const usable = bars.filter(b => b.volume > 0);
    if (usable.length > 0) return usable.slice(-count);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // 404 = symbol not listed on Coinbase Exchange. Anything else (5xx,
    // network) → still try YF; both paths can recover independently.
    // TRA-329 — when the Coinbase breaker is open we expect to fall back;
    // the breaker logs a single trip line, so skip the per-symbol warn.
    if (!/Coinbase 404|Coinbase breaker open/.test(msg)) {
      console.warn(`[crypto-feed] fetchCryptoDailyBars(${symbol}) Coinbase: ${msg} — falling back to Yahoo`);
    }
  }

  // TRA-438 — keyless Coinbase Advanced Trade backstop on a different host.
  // Runs before Yahoo so a demo engine still gets daily OHLC when the Exchange
  // breaker is open AND Yahoo's per-IP breaker is open. Same volume>0 filter as
  // the Exchange path; the in-progress UTC day is retained when it has volume.
  try {
    const atBars = await fetchCoinbaseAdvancedTradeCandles(symbol, 86_400, fromMs, now);
    const usable = atBars.filter(b => b.volume > 0);
    if (usable.length > 0) return usable.slice(-count);
  } catch (err: unknown) {
    console.warn(`[crypto-feed] fetchCryptoDailyBars(${symbol}) Coinbase Advanced Trade: ${err instanceof Error ? err.message : String(err)} — falling back to Yahoo`);
  }

  // Fallback: Yahoo Finance.
  try {
    const fromDate = new Date(fromMs);
    const nowDate = new Date(now);
    const result = await withTimeout(
      yf.chart(symbol, { period1: fromDate, period2: nowDate, interval: '1d' }),
      FEED_CALL_TIMEOUT_MS,
      `chart-1d(${symbol})`,
    );
    const quotes = result.quotes ?? [];
    return quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
      .filter(q => (q.volume ?? 0) > 0)
      .map(q => ({
        symbol,
        timestamp: new Date(q.date).getTime(),
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume!,
      }))
      .slice(-count);
  } catch (err: unknown) {
    console.error(`[crypto-feed] fetchCryptoDailyBars(${symbol}):`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

/**
 * TRA-267 — fetch the trailing `count` 4H bars for `symbol` from Coinbase.
 * Mirrors {@link fetchCryptoDailyBars} ergonomics: returns `Candle[]` keyed
 * by symbol with timestamps in ms epoch UTC. Source is Coinbase Exchange
 * 1H bars aggregated to 4H locally (see `@trading-app/backtest` /
 * `coinbase-feed.ts` for the rationale).
 *
 * Failure-mode parity with the daily fetcher: any error short-circuits to
 * an empty array with a single warn line, so the live engine's tick loop
 * never crashes on a transient Coinbase blip.
 */
export async function fetchCrypto4hBars(symbol: string, count = 260): Promise<Candle[]> {
  const now = Date.now();
  // Pad the request window so a fresh-cache miss still lands `count` bars
  // even if Coinbase drops a few 1H constituents (aggregation is strict —
  // see `aggregate1hTo4h`'s contiguity guard).
  const fromMs = now - count * 4 * 60 * 60 * 1000 * 1.25;

  // Primary: Coinbase Exchange (1H bars aggregated + gap-filled to 4H).
  try {
    const bars = await fetchCoinbase4hBars(symbol, fromMs, now);
    if (bars.length > 0) return bars.slice(-count);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!/Coinbase 404|Coinbase breaker open/.test(msg)) {
      console.warn(`[crypto-feed] fetchCrypto4hBars(${symbol}) Coinbase: ${msg} — falling back to Advanced Trade`);
    }
  }

  // TRA-438 — keyless Coinbase Advanced Trade backstop on a different host.
  // The Exchange path was the *only* source for 4H bars (no Yahoo fallback),
  // so a degraded Exchange host starved the perp-shorts 4H layer entirely.
  // Fetch keyless 1H candles and run them through the same aggregate→gap-fill
  // pipeline (`aggregate1hTo4h` + `fillGrid4h`) the Exchange path uses, so the
  // 4H grid stays contiguous and shape-identical regardless of the source.
  try {
    const hourly = await fetchCoinbaseAdvancedTradeCandles(symbol, 3_600, fromMs, now);
    if (hourly.length > 0) {
      const aggregated = fillGrid4h(aggregate1hTo4h(hourly));
      if (aggregated.length > 0) return aggregated.slice(-count);
    }
  } catch (err: unknown) {
    console.error(`[crypto-feed] fetchCrypto4hBars(${symbol}) Advanced Trade:`, err instanceof Error ? err.message : String(err));
  }
  return [];
}

/**
 * TRA-300 — minute bars from Coinbase Exchange (granularity=60) with Yahoo
 * fallback for symbols Coinbase doesn't list.
 *
 * Behaviour parity with the legacy YF-only path: drop the in-progress
 * current minute (Coinbase, like Yahoo, includes it with partial data and
 * near-zero volume — leaving it in would misfire volume-confirmation
 * gates) and drop any 0-volume gap bars.
 */
export async function fetchCryptoMinuteBars(symbol: string, count = 60): Promise<Candle[]> {
  const now = Date.now();
  const currentMinuteStart = Math.floor(now / 60_000) * 60_000;
  const fromMs = now - count * 60 * 1000 * 2; // buffer for occasional missing minutes

  // Primary: Coinbase Exchange.
  try {
    const bars = await withTimeout(
      fetchCoinbaseMinuteBars(symbol, fromMs, now),
      FEED_CALL_TIMEOUT_MS,
      `coinbase-1m(${symbol})`,
    );
    const completed = bars
      .filter(b => b.timestamp < currentMinuteStart)
      .filter(b => b.volume > 0);
    if (completed.length > 0) return completed.slice(-count);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    // TRA-329 — see fetchCryptoDailyBars: suppress the per-symbol warn while
    // the breaker is open; the breaker logs a single trip line.
    if (!/Coinbase 404|Coinbase breaker open/.test(msg)) {
      console.warn(`[crypto-feed] fetchCryptoMinuteBars(${symbol}) Coinbase: ${msg} — falling back to Yahoo`);
    }
  }

  // TRA-438 — keyless Coinbase Advanced Trade backstop on a different host.
  // The minute-candle cache is the critical path for signal generation (every
  // router / bb_fade / swing strategy evaluates off it); without this backstop
  // a demo engine produced zero signals once both the Exchange and Yahoo
  // breakers were open. Same in-progress-bar and 0-volume-gap drops as the
  // Exchange path so indicator math sees an identical series shape.
  try {
    const atBars = await fetchCoinbaseAdvancedTradeCandles(symbol, 60, fromMs, now);
    const completed = atBars
      .filter(b => b.timestamp < currentMinuteStart)
      .filter(b => b.volume > 0);
    if (completed.length > 0) return completed.slice(-count);
  } catch (err: unknown) {
    console.warn(`[crypto-feed] fetchCryptoMinuteBars(${symbol}) Coinbase Advanced Trade: ${err instanceof Error ? err.message : String(err)} — falling back to Yahoo`);
  }

  // Fallback: Yahoo Finance.
  try {
    const fromDate = new Date(fromMs);
    const nowDate = new Date(now);
    const result = await withTimeout(
      yf.chart(symbol, { period1: fromDate, period2: nowDate, interval: '1m' }),
      FEED_CALL_TIMEOUT_MS,
      `chart-1m(${symbol})`,
    );
    const quotes = result.quotes ?? [];
    return quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
      .filter(q => (q.volume ?? 0) > 0)                                  // drop 0-volume gaps
      .filter(q => new Date(q.date).getTime() < currentMinuteStart)     // drop in-progress bar
      .map(q => ({
        symbol,
        timestamp: new Date(q.date).getTime(),
        open: q.open!,
        high: q.high!,
        low: q.low!,
        close: q.close!,
        volume: q.volume!,
      }))
      .slice(-count);
  } catch (err: unknown) {
    console.error(`[crypto-feed] fetchCryptoMinuteBars(${symbol}):`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchCryptoQuote(symbol: string): Promise<CryptoQuote | null> {
  // TRA-300 — same primary-Coinbase, YF-then-CMC-fallback ordering as
  // `fetchCryptoQuotes`. Coinbase Exchange public stats first because the
  // live trade account routes to the same venue, so quote ↔ execution
  // prices stay aligned and we no longer depend on YF for the major USD pairs.
  const cb = await fetchCoinbaseStatsQuotes([symbol]);
  if (cb.has(symbol)) return cb.get(symbol) ?? null;

  if (!shouldSkipYahoo()) {
    try {
      const q = await withTimeout(yf.quote(symbol), FEED_CALL_TIMEOUT_MS, `quote(${symbol})`);
      if (q.regularMarketPrice != null) {
        return {
          price: q.regularMarketPrice,
          volume: q.regularMarketVolume ?? 0,
          change: q.regularMarketChange ?? 0,
          changePct: q.regularMarketChangePercent ?? 0,
          source: 'yahoo',
        };
      }
      console.warn(`[crypto-feed] quote(${symbol}) returned no regularMarketPrice — trying CMC`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isYahooRateLimitError(msg)) {
        // 429 is per-IP and applies to the stocks branch too — trip the
        // shared breaker so subsequent calls (crypto or stocks) skip Yahoo
        // for the cooldown window instead of hammering it.
        tripYahooBreakerFromExternal(`crypto quote(${symbol})`, msg);
      } else {
        console.warn(`[crypto-feed] quote(${symbol}) YF error: ${msg} — trying CMC`);
      }
    }
  }
  const cmcResults = await fetchCMCBatchQuotes([symbol]);
  return cmcResults.get(symbol) ?? null;
}

/**
 * Crypto quote fetch with ordered failover (TRA-418).
 *
 * Failover order — `coinbase → yahoo → cmc` (see `CRYPTO_FEED_FAILOVER_ORDER`
 * in `feed-freshness.ts`):
 *   1. Coinbase Exchange `/products/{id}/stats` — primary. Same venue as the
 *      live crypto broker, so quote ↔ execution prices stay aligned.
 *   2. Coinbase Advanced Trade `market/products` — keyless backstop on a
 *      different host (TRA-437). Covers the residual when the Exchange host
 *      is degraded for the egress IP, so the cascade keeps a working keyless
 *      source even with Yahoo's breaker open and no CMC key.
 *   3. Yahoo Finance — backstops symbols Coinbase does not list (BNB-USD,
 *      VET-USD, …). Skipped while the shared Yahoo rate-limit breaker is open.
 *   4. CoinMarketCap — final fallback for the residual set.
 * Each symbol takes the result from the first provider in this order that
 * returns it; the `source` tag on every `CryptoQuote` records which one.
 */
export async function fetchCryptoQuotes(
  symbols: readonly string[],
): Promise<Map<string, CryptoQuote>> {
  const results = new Map<string, CryptoQuote>();
  if (symbols.length === 0) return results;

  // TRA-300 — Coinbase Exchange is the primary quote source for crypto. Same
  // venue as the live trade account, so signal/quote prices match execution
  // prices, and the public `/products/{id}/stats` endpoint needs no API key.
  // This removes Yahoo's per-IP rate-limiter as a single point of failure for
  // the watchlist (it would mark every symbol "Quote unavailable" the moment
  // Yahoo started 429-ing the Render egress).
  const cbResults = await fetchCoinbaseStatsQuotes(symbols);
  for (const [sym, quote] of cbResults) results.set(sym, quote);

  // TRA-437 — keyless Coinbase Advanced Trade backstop on a different host.
  // The Exchange host above can be rate-limited / unreachable for the Render
  // egress IP independently of the Advanced Trade host; this second keyless
  // venue keeps the cascade alive for demo crypto users when Yahoo's breaker
  // is open and CMC has no API key. One batched request covers the residual.
  const needCoinbaseAt = symbols.filter(s => !results.has(s));
  if (needCoinbaseAt.length > 0) {
    const atResults = await fetchCoinbaseAdvancedTradeQuotes(needCoinbaseAt);
    for (const [sym, quote] of atResults) results.set(sym, quote);
  }

  // Yahoo backstops symbols Coinbase doesn't list (e.g. BNB-USD, VET-USD,
  // EGLD-USD, RUNE-USD — Binance/Cosmos-only assets). Same parallel-batch
  // shape as before so a slow YF response can't stall the tick, with the
  // first-429 short-circuit preserved end-to-end.
  let needYahoo = symbols.filter(s => !results.has(s));
  if (needYahoo.length > 0 && !shouldSkipYahoo()) {
    const QUOTE_BATCH = 5;
    let yahooBreakerJustTripped = false;
    let yahooQuoteErrors = 0;
    let yahooMissingPrice = 0;
    let firstYahooError: string | null = null;

    for (let i = 0; i < needYahoo.length; i += QUOTE_BATCH) {
      if (shouldSkipYahoo() || yahooBreakerJustTripped) break;
      const slice = needYahoo.slice(i, i + QUOTE_BATCH);
      const settled = await Promise.all(slice.map(async sym => {
        try {
          const q = await withTimeout(yf.quote(sym), FEED_CALL_TIMEOUT_MS, `quote(${sym})`);
          if (q.regularMarketPrice != null) {
            return [sym, {
              price: q.regularMarketPrice,
              volume: q.regularMarketVolume ?? 0,
              change: q.regularMarketChange ?? 0,
              changePct: q.regularMarketChangePercent ?? 0,
              source: 'yahoo' as const,
            }] as const;
          }
          yahooMissingPrice += 1;
          return [sym, null] as const;
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (isYahooRateLimitError(msg) && !yahooBreakerJustTripped) {
            yahooBreakerJustTripped = true;
            tripYahooBreakerFromExternal(`crypto quote(${sym})`, msg);
          }
          yahooQuoteErrors += 1;
          if (!firstYahooError) firstYahooError = msg;
          return [sym, null] as const;
        }
      }));
      for (const [sym, q] of settled) {
        if (q) results.set(sym, q);
      }
      if (i + QUOTE_BATCH < needYahoo.length) await sleep(200);
    }

    if (yahooQuoteErrors > 0 || yahooMissingPrice > 0) {
      const reasons: string[] = [];
      // Cast: closures in the parallel batch can mutate `firstYahooError`
      // to a string, but TS's flow analysis can't see across the await
      // boundary so it keeps the variable narrowed to its initial `null`.
      const errVal = firstYahooError as string | null;
      const firstSnippet = errVal != null ? errVal.slice(0, 120) : '';
      if (yahooQuoteErrors > 0) reasons.push(`${yahooQuoteErrors} errors${firstSnippet ? ` (first: ${firstSnippet})` : ''}`);
      if (yahooMissingPrice > 0) reasons.push(`${yahooMissingPrice} missing regularMarketPrice`);
      console.warn(`[crypto-feed] YF quote batch (Coinbase miss fill-in): ${reasons.join(', ')} — routing to CMC`);
    }
  }

  // CMC is the final fallback for the residual set (Coinbase miss + Yahoo
  // miss / breaker). Same batched call as before; if CMC_API_KEY is unset
  // it returns an empty Map and we fall through to the "unavailable" log.
  needYahoo = symbols.filter(s => !results.has(s));
  if (needYahoo.length > 0) {
    console.log(`[crypto-feed] CMC fallback for ${needYahoo.length} symbols`);
    const cmcResults = await fetchCMCBatchQuotes(needYahoo);
    for (const [sym, quote] of cmcResults) results.set(sym, quote);
    const stillFailed = symbols.filter(s => !results.has(s));
    if (stillFailed.length > 0) {
      const list = stillFailed.length <= 10
        ? stillFailed.join(', ')
        : `${stillFailed.slice(0, 10).join(', ')}, …+${stillFailed.length - 10} more`;
      console.error(`[crypto-feed] fetchCryptoQuotes: ${stillFailed.length} symbols had no data from Coinbase, YF, or CMC: ${list}`);
    }
  }

  return results;
}

// TRA-196 — per-symbol crypto news aggregation.
//
// The previous broad query ('crypto bitcoin ethereum') hit Yahoo's search
// cache with the same key on every refresh, so users saw the same news items
// indefinitely. Fanning out per-symbol queries gives Yahoo distinct keys and
// produces fresh content as different coins generate news at different times.
export async function fetchCryptoNews(symbols: readonly string[]): Promise<NewsItem[]> {
  const NEWS_QUERY_LIMIT = 8;
  const NEWS_BATCH = 3;
  const PER_SYMBOL_NEWS = 5;
  const RESULT_CAP = 20;

  const querySymbols = symbols.slice(0, NEWS_QUERY_LIMIT);
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  type RawNews = { title?: string; link?: string; publisher?: string; providerPublishTime?: Date | number | string };

  const collect = (newsArr: ReadonlyArray<RawNews>): void => {
    for (const n of newsArr) {
      if (!n?.link || !n?.title || seen.has(n.link)) continue;
      seen.add(n.link);
      items.push({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'Yahoo Finance',
        publishedAt: toIsoTime(n.providerPublishTime),
      });
    }
  };

  const safeSearch = async (q: string, label: string): Promise<{ news?: ReadonlyArray<RawNews> } | null> => {
    if (shouldSkipYahoo()) return null;
    try {
      return await withTimeout(
        yf.search(q, { newsCount: PER_SYMBOL_NEWS, quotesCount: 0 }) as unknown as Promise<{ news?: ReadonlyArray<RawNews> }>,
        FEED_CALL_TIMEOUT_MS,
        label,
      );
    } catch (err: unknown) {
      console.error(`[crypto-feed] ${label} error:`, err instanceof Error ? err.message : String(err));
      return null;
    }
  };

  for (let i = 0; i < querySymbols.length; i += NEWS_BATCH) {
    const slice = querySymbols.slice(i, i + NEWS_BATCH);
    const settled = await Promise.all(slice.map(sym => safeSearch(sym, `search(crypto news ${sym})`)));
    for (const r of settled) {
      if (r) collect(r.news ?? []);
    }
    if (i + NEWS_BATCH < querySymbols.length) await sleep(200);
  }

  if (items.length < RESULT_CAP) {
    const fallback = await safeSearch('cryptocurrency', 'search(crypto news fallback)');
    if (fallback) collect(fallback.news ?? []);
  }

  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return items.slice(0, RESULT_CAP);
}

/** Test CoinMarketCap connectivity — returns top coin or throws. */
export async function testCoinMarketCap(): Promise<{ symbol: string; price: number } | null> {
  if (!CMC_API_KEY) return null;
  const results = await fetchCMCBatchQuotes(['BTC-USD']);
  const btc = results.get('BTC-USD');
  if (!btc) throw new Error('No BTC-USD data from CMC');
  return { symbol: 'BTC-USD', price: btc.price };
}

/**
 * TRA-331 — probe Coinbase Exchange (the live engine's primary crypto quote
 * source) so `/api/health/quotes` reflects the path the engine actually uses.
 * Without this, the endpoint only tested the *fallbacks* (YF/TwelveData/CMC),
 * and a degraded fallback chain made it impossible to tell whether crypto
 * quotes were flowing into the live engine.
 */
export async function testCoinbase(): Promise<{ symbol: string; price: number }> {
  const stats = await fetchCoinbaseStatsQuotes(['BTC-USD']);
  const btc = stats.get('BTC-USD');
  if (!btc) throw new Error('No BTC-USD data from Coinbase Exchange');
  return { symbol: 'BTC-USD', price: btc.price };
}
