import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem } from '@trading-app/shared';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: true },
});
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
    const resp = await fetch(
      `${CMC_BASE}/v1/cryptocurrency/quotes/latest?symbol=${cmcSymbolList}&convert=USD`,
      { headers: { 'X-CMC_PRO_API_KEY': CMC_API_KEY, Accept: 'application/json' } },
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
    const result = await yf.chart(symbol, { period1: from, period2: now, interval: '1d' });
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
    const result = await yf.chart(symbol, { period1: from, period2: now, interval: '1m' });
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
  try {
    const q = await yf.quote(symbol);
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
  const cmcResults = await fetchCMCBatchQuotes([symbol]);
  return cmcResults.get(symbol) ?? null;
}

export async function fetchCryptoQuotes(
  symbols: readonly string[],
): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  const failed: string[] = [];

  for (const sym of symbols) {
    try {
      const q = await yf.quote(sym);
      if (q.regularMarketPrice != null) {
        results.set(sym, {
          price: q.regularMarketPrice,
          volume: q.regularMarketVolume ?? 0,
          change: q.regularMarketChange ?? 0,
          changePct: q.regularMarketChangePercent ?? 0,
        });
      } else {
        console.warn(`[crypto-feed] quote(${sym}) no regularMarketPrice — queuing CMC fallback`);
        failed.push(sym);
      }
    } catch (err: unknown) {
      console.warn(`[crypto-feed] quote(${sym}) YF error: ${err instanceof Error ? err.message : String(err)} — queuing CMC fallback`);
      failed.push(sym);
    }
    await sleep(200);
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
    const results = await yf.search('crypto bitcoin ethereum', { newsCount: 10, quotesCount: 0 });
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
