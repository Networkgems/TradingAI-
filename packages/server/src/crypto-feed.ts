import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem } from '@trading-app/shared';
import { isYahooBreakerOpen } from './yahoo-feed.js';

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

const CMC_API_KEY = process.env.CMC_API_KEY ?? '';
const CMC_BASE = 'https://pro-api.coinmarketcap.com';

if (!CMC_API_KEY) {
  console.warn('[crypto-feed] CMC_API_KEY is not set — CoinMarketCap fallback disabled');
}

// Convert Yahoo Finance crypto symbol format to CMC symbol (BTC-USD -> BTC)
function toCMCSymbol(yahooSymbol: string): string {
  return yahooSymbol.replace(/-USD$/, '').replace(/-USDT$/, '');
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
      console.warn(`[crypto-feed] quote(${symbol}) YF error: ${err instanceof Error ? err.message : String(err)} — trying CMC`);
    }
  }
  const cmcResults = await fetchCMCBatchQuotes([symbol]);
  return cmcResults.get(symbol) ?? null;
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
    const QUOTE_BATCH = 5;
    for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
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
          console.warn(`[crypto-feed] quote(${sym}) no regularMarketPrice — queuing CMC fallback`);
          return [sym, null] as const;
        } catch (err: unknown) {
          console.warn(`[crypto-feed] quote(${sym}) YF error: ${err instanceof Error ? err.message : String(err)} — queuing CMC fallback`);
          return [sym, null] as const;
        }
      }));
      for (const [sym, q] of settled) {
        if (q) results.set(sym, q);
        else failed.push(sym);
      }
      if (i + QUOTE_BATCH < symbols.length) await sleep(200);
    }
  }

  if (failed.length > 0) {
    console.log(`[crypto-feed] CMC fallback for ${failed.length} symbols: ${failed.join(', ')}`);
    const cmcResults = await fetchCMCBatchQuotes(failed);
    for (const [sym, quote] of cmcResults) {
      results.set(sym, quote);
    }
    const stillFailed = failed.filter(s => !cmcResults.has(s));
    if (stillFailed.length > 0) {
      console.error(`[crypto-feed] fetchCryptoQuotes: ${stillFailed.length} symbols had no data from YF or CMC: ${stillFailed.join(', ')}`);
    }
  }

  return results;
}

export async function fetchCryptoNews(): Promise<NewsItem[]> {
  try {
    const results = await withTimeout(
      yf.search('crypto bitcoin ethereum', { newsCount: 10, quotesCount: 0 }),
      FEED_CALL_TIMEOUT_MS,
      'search(crypto news)',
    );
    return (results.news ?? []).map(n => ({
      title: n.title,
      url: n.link,
      source: n.publisher ?? 'Yahoo Finance',
      publishedAt: new Date(Number(n.providerPublishTime ?? 0) * 1000).toISOString(),
    }));
  } catch (err: unknown) {
    console.error('[crypto-feed] fetchCryptoNews error:', err instanceof Error ? err.message : String(err));
    return [];
  }
}

/** Test CoinMarketCap connectivity — returns top coin or throws. */
export async function testCoinMarketCap(): Promise<{ symbol: string; price: number } | null> {
  if (!CMC_API_KEY) return null;
  const results = await fetchCMCBatchQuotes(['BTC-USD']);
  const btc = results.get('BTC-USD');
  if (!btc) throw new Error('No BTC-USD data from CMC');
  return { symbol: 'BTC-USD', price: btc.price };
}
