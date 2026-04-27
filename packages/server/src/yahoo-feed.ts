import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem } from '@trading-app/shared';
import { fetchStooqQuote } from './stooq-feed.js';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: true },
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Per-call timeout. Yahoo Finance occasionally hangs without responding, which
// previously blocked the 30-second tick indefinitely (no quotes → watchlist stuck
// "Loading…", and signals couldn't open positions because price was unavailable).
const YF_CALL_TIMEOUT_MS = 8_000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 2): Promise<T | null> {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn(), YF_CALL_TIMEOUT_MS, label);
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

/**
 * Fetch the current quote for a symbol.
 *
 * Tries Yahoo Finance first; falls back to Stooq on failure (TRA-136).
 * Stooq is delayed ~15 min and the change% is derived from the intraday
 * open rather than previous close, but it keeps the EOD report from
 * showing all-zero quotes when Yahoo is unavailable.
 */
export async function fetchQuote(symbol: string): Promise<{ price: number; volume: number; change: number; changePct: number } | null> {
  const q = await withRetry(() => yf.quote(symbol), `quote(${symbol})`);
  if (q && q.regularMarketPrice != null) {
    return {
      price: q.regularMarketPrice,
      volume: q.regularMarketVolume ?? 0,
      change: q.regularMarketChange ?? 0,
      changePct: q.regularMarketChangePercent ?? 0,
    };
  }
  if (q) console.warn(`[yahoo-feed] quote(${symbol}) returned no regularMarketPrice — falling back to Stooq`);
  const stooq = await fetchStooqQuote(symbol);
  if (stooq) {
    console.info(`[yahoo-feed] ${symbol}: served from Stooq fallback`);
    return stooq;
  }
  return null;
}

/**
 * Fetch quotes for all symbols in parallel batches.
 * Serial fetching previously made tick latency O(N) and let one slow Yahoo response
 * stall the entire watchlist update; batched parallel calls keep total wall time
 * close to the per-call timeout while staying under Yahoo's rate limits.
 */
export async function fetchQuotes(symbols: readonly string[]): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  const QUOTE_BATCH = 5;
  let failures = 0;
  for (let i = 0; i < symbols.length; i += QUOTE_BATCH) {
    const slice = symbols.slice(i, i + QUOTE_BATCH);
    const settled = await Promise.all(slice.map(sym => fetchQuote(sym).then(q => [sym, q] as const)));
    for (const [sym, q] of settled) {
      if (q) results.set(sym, q);
      else failures++;
    }
    if (i + QUOTE_BATCH < symbols.length) await sleep(200);
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
  const q = await withTimeout(yf.quote('AAPL'), YF_CALL_TIMEOUT_MS, 'quote(AAPL) health-check');
  if (q.regularMarketPrice == null) throw new Error('regularMarketPrice is null');
  return { symbol: 'AAPL', price: q.regularMarketPrice };
}
