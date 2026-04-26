import YahooFinance from 'yahoo-finance2';
import type { Candle, NewsItem } from '@trading-app/shared';

const yf = new YahooFinance({ validation: { logErrors: false } });
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

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
  } catch {
    return [];
  }
}

export async function fetchCryptoQuote(symbol: string): Promise<{ price: number; volume: number; change: number; changePct: number } | null> {
  try {
    const q = await yf.quote(symbol);
    if (q.regularMarketPrice == null) return null;
    return {
      price: q.regularMarketPrice,
      volume: q.regularMarketVolume ?? 0,
      change: q.regularMarketChange ?? 0,
      changePct: q.regularMarketChangePercent ?? 0,
    };
  } catch {
    return null;
  }
}

export async function fetchCryptoQuotes(symbols: readonly string[]): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  for (const sym of symbols) {
    const q = await fetchCryptoQuote(sym);
    if (q) results.set(sym, q);
    await sleep(200);
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
  } catch {
    return [];
  }
}
