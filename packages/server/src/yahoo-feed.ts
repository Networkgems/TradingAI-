import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem } from '@trading-app/shared';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: true },
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 2): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (attempt < retries) {
        console.warn(`[yahoo-feed] ${label} attempt ${attempt + 1} failed: ${msg} — retrying in ${(attempt + 1) * 1000}ms`);
        await sleep((attempt + 1) * 1000);
      } else {
        console.error(`[yahoo-feed] ${label} failed after ${retries + 1} attempts: ${msg}`);
      }
    }
  }
  return null;
}

/** Fetch the last N 1-minute candles for a symbol from Yahoo Finance. */
export async function fetchMinuteBars(symbol: string, count = 60): Promise<Candle[]> {
  const now = new Date();
  const from = new Date(now.getTime() - count * 60 * 1000 * 2); // 2× window to guarantee enough bars
  // Drop the in-progress current-minute bar (partial volume skews volume-climax checks).
  const currentMinuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

  const result = await withRetry(
    () => yf.chart(symbol, { period1: from, period2: now, interval: '1m' }),
    `chart(${symbol})`,
  );
  if (!result) return [];

  const quotes = result.quotes ?? [];
  return quotes
    .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
    .filter(q => (q.volume ?? 0) > 0)                                // drop 0-volume gaps
    .filter(q => new Date(q.date).getTime() < currentMinuteStart)   // drop in-progress bar
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
}

/** Fetch the current quote for a symbol. */
export async function fetchQuote(symbol: string): Promise<{ price: number; volume: number; change: number; changePct: number } | null> {
  const q = await withRetry(() => yf.quote(symbol), `quote(${symbol})`);
  if (!q || q.regularMarketPrice == null) {
    if (q) console.warn(`[yahoo-feed] quote(${symbol}) returned no regularMarketPrice`);
    return null;
  }
  return {
    price: q.regularMarketPrice,
    volume: q.regularMarketVolume ?? 0,
    change: q.regularMarketChange ?? 0,
    changePct: q.regularMarketChangePercent ?? 0,
  };
}

/** Fetch quotes for all symbols serially with a delay to stay under rate limits. */
export async function fetchQuotes(symbols: readonly string[]): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  let failures = 0;
  for (const sym of symbols) {
    const q = await fetchQuote(sym);
    if (q) {
      results.set(sym, q);
    } else {
      failures++;
    }
    await sleep(200); // 200 ms gap — ~5 s for 25 symbols, well under Yahoo Finance rate limits
  }
  if (failures > 0) {
    console.warn(`[yahoo-feed] fetchQuotes: ${failures}/${symbols.length} symbols failed`);
  }
  return results;
}

export async function fetchStocksNews(): Promise<NewsItem[]> {
  const results = await withRetry(
    () => yf.search('stocks market NYSE trading', { newsCount: 10, quotesCount: 0 }),
    'search(stocks news)',
  );
  if (!results) return [];
  return (results.news ?? []).map(n => ({
    title: n.title,
    url: n.link,
    source: n.publisher ?? 'Yahoo Finance',
    publishedAt: new Date(Number(n.providerPublishTime ?? 0) * 1000).toISOString(),
  }));
}

/** Test Yahoo Finance connectivity — returns a quote or throws. */
export async function testYahooFinance(): Promise<{ symbol: string; price: number }> {
  const q = await yf.quote('AAPL');
  if (q.regularMarketPrice == null) throw new Error('regularMarketPrice is null');
  return { symbol: 'AAPL', price: q.regularMarketPrice };
}
