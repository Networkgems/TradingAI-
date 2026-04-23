import yahooFinance from 'yahoo-finance2';
import type { Candle } from '@trading-app/shared';

yahooFinance.setGlobalConfig({ validation: { logErrors: false } });

/** Fetch the last N 1-minute candles for a symbol from Yahoo Finance. */
export async function fetchMinuteBars(symbol: string, count = 60): Promise<Candle[]> {
  try {
    const now = new Date();
    const from = new Date(now.getTime() - count * 60 * 1000 * 2); // fetch 2× window to ensure enough bars

    const result = await yahooFinance.chart(symbol, {
      period1: from,
      period2: now,
      interval: '1m',
    });

    const quotes = result.quotes ?? [];
    const candles: Candle[] = quotes
      .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
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

    return candles;
  } catch {
    return [];
  }
}

/** Fetch the current quote for a symbol. */
export async function fetchQuote(symbol: string): Promise<{ price: number; volume: number; change: number; changePct: number } | null> {
  try {
    const q = await yahooFinance.quote(symbol);
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

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** Batch-fetch quotes for all symbols, serialised with a small delay to avoid rate limiting. */
export async function fetchQuotes(symbols: readonly string[]): Promise<Map<string, { price: number; volume: number; change: number; changePct: number }>> {
  const results = new Map<string, { price: number; volume: number; change: number; changePct: number }>();
  for (const sym of symbols) {
    const q = await fetchQuote(sym);
    if (q) results.set(sym, q);
    await sleep(150); // 150 ms gap — ~4 s for 25 symbols, well under Yahoo Finance rate limits
  }
  return results;
}
