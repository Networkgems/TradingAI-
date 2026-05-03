import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem } from '@trading-app/shared';
import { fetchCoinbase4hBars } from '@trading-app/backtest';
import { isYahooBreakerOpen, toIsoTime, tripYahooBreakerFromExternal } from './yahoo-feed.js';

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

// Convert Yahoo Finance crypto symbol format to CMC symbol (BTC-USD -> BTC)
function toCMCSymbol(yahooSymbol: string): string {
  return yahooSymbol.replace(/-USD$/, '').replace(/-USDT$/, '');
}

/**
 * TRA-300 — Coinbase Exchange public stats endpoint as a third-tier quote
 * fallback. Used when both Yahoo Finance and CoinMarketCap miss (e.g. Yahoo
 * IP-blocking the Render egress and CMC quota / key issues), so the watchlist
 * keeps showing live crypto prices instead of "Quote unavailable" indefinitely.
 *
 * Public endpoint, no auth required. Per-product call to
 * `/products/{id}/stats` returns `{ open, high, low, last, volume, … }` —
 * `last` is the spot price, `volume` is 24h base-currency volume, and
 * change% is computed from `(last - open) / open * 100`. We fan out in
 * concurrency-5 batches with a 150ms gap between batches to stay well inside
 * Coinbase's public-data 10 req/s limit.
 */
const COINBASE_BASE = 'https://api.exchange.coinbase.com';
async function fetchCoinbaseStatsQuotes(
  symbols: readonly string[],
): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  if (symbols.length === 0) return results;
  const BATCH = 5;
  for (let i = 0; i < symbols.length; i += BATCH) {
    const slice = symbols.slice(i, i + BATCH);
    const settled = await Promise.all(slice.map(async sym => {
      try {
        const resp = await withTimeout(
          fetch(`${COINBASE_BASE}/products/${encodeURIComponent(sym)}/stats`, {
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
        return [sym, { price, volume, change, changePct }] as const;
      } catch {
        return [sym, null] as const;
      }
    }));
    for (const [sym, q] of settled) {
      if (q) results.set(sym, q);
    }
    if (i + BATCH < symbols.length) await sleep(150);
  }
  return results;
}

async function fetchCMCBatchQuotes(
  symbols: readonly string[],
): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
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
    const json = (await resp.json()) as any;
    const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
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
      });
    }
    return results;
  } catch (err: unknown) {
    console.error('[crypto-feed] CMC batch quotes error:', err instanceof Error ? err.message : String(err));
    return new Map();
  }
}

export async function fetchCryptoDailyBars(symbol: string, count = 260): Promise<Candle[]> {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - count * 24 * 60 * 60 * 1000 * 1.5); // fetch with buffer
    const result = await withTimeout(
      yf.chart(symbol, { period1: from, period2: now, interval: '1d' }),
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
  try {
    const now = Date.now();
    // Pad the request window so a fresh-cache miss still lands `count` bars
    // even if Coinbase drops a few 1H constituents (aggregation is strict —
    // see `aggregate1hTo4h`'s contiguity guard).
    const fromMs = now - count * 4 * 60 * 60 * 1000 * 1.25;
    const bars = await fetchCoinbase4hBars(symbol, fromMs, now);
    return bars.slice(-count);
  } catch (err: unknown) {
    console.error(`[crypto-feed] fetchCrypto4hBars(${symbol}):`, err instanceof Error ? err.message : String(err));
    return [];
  }
}

export async function fetchCryptoMinuteBars(symbol: string, count = 60): Promise<Candle[]> {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - count * 60 * 1000 * 2);
    // Request one extra bar so we always have `count` completed bars after dropping
    // the in-progress current-minute candle (which Yahoo Finance includes with partial
    // data and near-zero volume, causing volume-confirmation to always fail).
    const result = await withTimeout(
      yf.chart(symbol, { period1: from, period2: now, interval: '1m' }),
      FEED_CALL_TIMEOUT_MS,
      `chart-1m(${symbol})`,
    );
    const currentMinuteStart = Math.floor(now.getTime() / 60_000) * 60_000;
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

export async function fetchCryptoQuote(
  symbol: string,
): Promise<{ price: number; volume: number; change: number; changePct: number } | null> {
  if (!shouldSkipYahoo()) {
    try {
      const q = await withTimeout(yf.quote(symbol), FEED_CALL_TIMEOUT_MS, `quote(${symbol})`);
      if (q.regularMarketPrice != null) {
        return {
          price: q.regularMarketPrice,
          volume: q.regularMarketVolume ?? 0,
          change: q.regularMarketChange ?? 0,
          changePct: q.regularMarketChangePercent ?? 0,
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
  if (cmcResults.has(symbol)) return cmcResults.get(symbol) ?? null;
  // TRA-300 — Coinbase Exchange public stats fallback (no API key) so a
  // single-symbol UI lookup still resolves when YF and CMC both miss.
  const cbResults = await fetchCoinbaseStatsQuotes([symbol]);
  return cbResults.get(symbol) ?? null;
}

export async function fetchCryptoQuotes(
  symbols: readonly string[],
): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  const failed: string[] = [];

  if (shouldSkipYahoo()) {
    // Yahoo breaker is open — every symbol goes straight to CMC fallback.
    failed.push(...symbols);
  } else {
    // Fetch in parallel batches so one slow Yahoo response doesn't stall the whole tick.
    // First-429 short-circuit: as soon as Yahoo rate-limits us, trip the shared
    // breaker and route every remaining symbol straight to CMC instead of
    // burning 8s per call on doomed requests. Per-symbol warns are collapsed
    // into a single aggregate line so the deploy log doesn't get flooded.
    const QUOTE_BATCH = 5;
    let yahooBreakerJustTripped = false;
    let yahooQuoteErrors = 0;
    let yahooMissingPrice = 0;
    let firstYahooError: string | null = null;

    for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
      if (shouldSkipYahoo() || yahooBreakerJustTripped) {
        for (let j = i; j < symbols.length; j += 1) failed.push(symbols[j]);
        break;
      }
      const slice = symbols.slice(i, i + QUOTE_BATCH);
      const settled = await Promise.all(slice.map(async sym => {
        try {
          const q = await withTimeout(yf.quote(sym), FEED_CALL_TIMEOUT_MS, `quote(${sym})`);
          if (q.regularMarketPrice != null) {
            return [sym, {
              price: q.regularMarketPrice,
              volume: q.regularMarketVolume ?? 0,
              change: q.regularMarketChange ?? 0,
              changePct: q.regularMarketChangePercent ?? 0,
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
        else failed.push(sym);
      }
      if (i + QUOTE_BATCH < symbols.length) await sleep(200);
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
      console.warn(`[crypto-feed] YF quote batch: ${reasons.join(', ')} — routing to CMC`);
    }
  }

  if (failed.length > 0) {
    console.log(`[crypto-feed] CMC fallback for ${failed.length} symbols`);
    const cmcResults = await fetchCMCBatchQuotes(failed);
    for (const [sym, quote] of cmcResults) {
      results.set(sym, quote);
    }
    let stillFailed = failed.filter(s => !cmcResults.has(s));
    // TRA-300 — Coinbase Exchange public stats covers the major USD spot
    // pairs and works without an API key, so we use it to rescue symbols
    // that Yahoo (rate-limit / IP-block) and CMC (quota / no key) both
    // missed before flagging them "Quote unavailable" on the watchlist.
    if (stillFailed.length > 0) {
      console.log(`[crypto-feed] Coinbase fallback for ${stillFailed.length} symbols`);
      const cbResults = await fetchCoinbaseStatsQuotes(stillFailed);
      for (const [sym, quote] of cbResults) {
        results.set(sym, quote);
      }
      stillFailed = stillFailed.filter(s => !cbResults.has(s));
    }
    if (stillFailed.length > 0) {
      const list = stillFailed.length <= 10
        ? stillFailed.join(', ')
        : `${stillFailed.slice(0, 10).join(', ')}, …+${stillFailed.length - 10} more`;
      console.error(`[crypto-feed] fetchCryptoQuotes: ${stillFailed.length} symbols had no data from YF, CMC, or Coinbase: ${list}`);
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
