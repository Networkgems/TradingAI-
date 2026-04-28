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

// 429 circuit breaker. When Yahoo rate-limits us, retrying every tick burns the
// retry budget for nothing and risks extending the lock-out. Open the breaker for
// a cool-down window after a 429 so we fall through to fallback providers fast.
const RATE_LIMIT_COOLDOWN_MS = 90_000;
let rateLimitedUntil = 0;
function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}
function tripBreaker(label: string, msg: string): void {
  rateLimitedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  console.warn(`[yahoo-feed] circuit breaker tripped for ${RATE_LIMIT_COOLDOWN_MS / 1000}s after ${label}: ${msg}`);
}
function isRateLimitError(msg: string): boolean {
  return /\b429\b|Too Many Requests|crumb/i.test(msg);
}

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
  if (isRateLimited()) {
    // Skip outright while breaker is open — caller falls back to alternate provider.
    return null;
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await withTimeout(fn(), YF_CALL_TIMEOUT_MS, label);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isRateLimitError(msg)) {
        tripBreaker(label, msg);
        return null;
      }
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

// ── Finnhub fallback for stocks ───────────────────────────────────────────────
// Activated when FINNHUB_API_KEY is set. Free tier covers US equities at 60 req/min.

const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY ?? '';
const FINNHUB_BASE = 'https://finnhub.io/api/v1';

if (!FINNHUB_API_KEY) {
  console.warn('[yahoo-feed] FINNHUB_API_KEY is not set — Finnhub stock fallback disabled');
}

async function fetchFinnhubQuote(symbol: string): Promise<{ price: number; volume: number; change: number; changePct: number } | null> {
  if (!FINNHUB_API_KEY) return null;
  try {
    const resp = await withTimeout(
      fetch(`${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`),
      YF_CALL_TIMEOUT_MS,
      `finnhub quote(${symbol})`,
    );
    if (!resp.ok) {
      console.warn(`[yahoo-feed] finnhub quote(${symbol}) HTTP ${resp.status}`);
      return null;
    }
    const json = (await resp.json()) as { c?: number; d?: number; dp?: number; pc?: number };
    if (!json || typeof json.c !== 'number' || json.c === 0) {
      // Finnhub returns c=0 for invalid symbols / off-hours blanks.
      return null;
    }
    return {
      price: json.c,
      volume: 0, // Finnhub /quote does not include volume; the watchlist tolerates 0.
      change: json.d ?? 0,
      changePct: json.dp ?? 0,
    };
  } catch (err: unknown) {
    console.warn(`[yahoo-feed] finnhub quote(${symbol}) error: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
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
 * Yahoo Finance is the primary source. When it is rate-limited (breaker open) or
 * returns no `regularMarketPrice`, we cascade through fallbacks:
 *   1. Finnhub (real-time, 60 req/min on free tier — needs FINNHUB_API_KEY)
 *   2. Stooq (no key required, but ~15 min delayed and change% is intraday-open-based)
 * Stooq stays as the last resort so the watchlist always has *something* to show
 * even when no API keys are configured.
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
  if (q) console.warn(`[yahoo-feed] quote(${symbol}) returned no regularMarketPrice — trying fallbacks`);

  const finnhub = await fetchFinnhubQuote(symbol);
  if (finnhub) {
    console.info(`[yahoo-feed] ${symbol}: served from Finnhub fallback`);
    return finnhub;
  }
  const stooq = await fetchStooqQuote(symbol);
  if (stooq) {
    console.info(`[yahoo-feed] ${symbol}: served from Stooq fallback (delayed)`);
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
    console.warn(`[yahoo-feed] fetchQuotes: ${failures}/${symbols.length} symbols failed${isRateLimited() ? ' (Yahoo breaker open)' : ''}`);
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

/** Test Finnhub connectivity — returns a quote or throws / returns null when unconfigured. */
export async function testFinnhub(): Promise<{ symbol: string; price: number } | null> {
  if (!FINNHUB_API_KEY) return null;
  const q = await fetchFinnhubQuote('AAPL');
  if (!q) throw new Error('Finnhub returned no quote for AAPL');
  return { symbol: 'AAPL', price: q.price };
}

/** Whether the Yahoo rate-limit circuit breaker is currently open. */
export function isYahooBreakerOpen(): boolean {
  return isRateLimited();
}
