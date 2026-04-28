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

// TRA-149: throttle diagnostic logs for c=0 / non-OK Finnhub /quote responses
// to once per minute per (symbol, kind) so a stuck-throttled key during a Yahoo
// outage doesn't spam logs every 30s tick × N watchlist symbols.
const FINNHUB_LOG_THROTTLE_MS = 60_000;
const finnhubLogThrottle = new Map<string, number>();
function shouldLogFinnhub(symbol: string, kind: 'http' | 'c0'): boolean {
  const key = `${kind}:${symbol}`;
  const now = Date.now();
  const last = finnhubLogThrottle.get(key) ?? 0;
  if (now - last < FINNHUB_LOG_THROTTLE_MS) return false;
  finnhubLogThrottle.set(key, now);
  return true;
}

// TRA-149: tiny per-symbol cache in front of /quote so concurrent callers (and
// closely-spaced ticks) don't double-fire Finnhub during Yahoo outages, when
// Finnhub becomes the load-bearing source. 5s is short enough to keep the
// watchlist live and long enough to coalesce a single tick's parallel fan-out.
const FINNHUB_QUOTE_TTL_MS = 5_000;
type FinnhubQuoteResult = { price: number; volume: number; change: number; changePct: number };
const finnhubQuoteCache = new Map<string, { at: number; value: FinnhubQuoteResult | null }>();

async function fetchFinnhubQuote(symbol: string): Promise<FinnhubQuoteResult | null> {
  if (!FINNHUB_API_KEY) return null;
  const cached = finnhubQuoteCache.get(symbol);
  if (cached && Date.now() - cached.at < FINNHUB_QUOTE_TTL_MS) {
    return cached.value;
  }
  const value = await fetchFinnhubQuoteUncached(symbol);
  finnhubQuoteCache.set(symbol, { at: Date.now(), value });
  return value;
}

async function fetchFinnhubQuoteUncached(symbol: string): Promise<FinnhubQuoteResult | null> {
  try {
    const resp = await withTimeout(
      fetch(`${FINNHUB_BASE}/quote?symbol=${encodeURIComponent(symbol)}&token=${FINNHUB_API_KEY}`),
      YF_CALL_TIMEOUT_MS,
      `finnhub quote(${symbol})`,
    );
    if (!resp.ok) {
      // Pull a body sample so we can tell rate-limit (429) from auth-rejection
      // (401/403 with JSON error) from upstream-flake (5xx). Throttled per symbol.
      if (shouldLogFinnhub(symbol, 'http')) {
        const body = await resp.text().catch(() => '');
        console.warn(`[yahoo-feed] finnhub quote(${symbol}) HTTP ${resp.status} ${resp.statusText} body=${body.slice(0, 200)}`);
      } else {
        console.warn(`[yahoo-feed] finnhub quote(${symbol}) HTTP ${resp.status}`);
      }
      return null;
    }
    const json = (await resp.json()) as { c?: number; d?: number; dp?: number; pc?: number };
    if (!json || typeof json.c !== 'number' || json.c === 0) {
      // Finnhub returns c=0 for invalid symbols, off-hours blanks, AND silently
      // throttled keys. Log the full payload (throttled) so we can distinguish
      // these in production — see TRA-149.
      if (shouldLogFinnhub(symbol, 'c0')) {
        console.warn(`[yahoo-feed] finnhub quote(${symbol}) c=0 body=${JSON.stringify(json)}`);
      }
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

// Finnhub /stock/candle response: parallel arrays keyed by status `s`.
// `s: 'ok'` with non-empty o/h/l/c/v/t arrays of equal length, `s: 'no_data'` otherwise.
interface FinnhubCandleResponse {
  s?: string;
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
  v?: number[];
  t?: number[];
}

export interface FinnhubCandleDiag {
  reason: 'no_key' | 'http_error' | 'no_data' | 'parse_error' | 'fetch_error' | 'ok';
  httpStatus?: number;
  s?: string;
  rawLen?: number;
  filteredLen?: number;
  errorBody?: string;
  errorMsg?: string;
}

async function fetchFinnhubMinuteBars(
  symbol: string,
  count: number,
): Promise<{ bars: Candle[]; diag: FinnhubCandleDiag }> {
  if (!FINNHUB_API_KEY) return { bars: [], diag: { reason: 'no_key' } };
  const nowSec = Math.floor(Date.now() / 1000);
  // 2× window to absorb gaps from off-hours / illiquid minutes, matching Yahoo's branch.
  const fromSec = nowSec - count * 60 * 2;
  try {
    const url = `${FINNHUB_BASE}/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=1&from=${fromSec}&to=${nowSec}&token=${FINNHUB_API_KEY}`;
    const resp = await withTimeout(fetch(url), YF_CALL_TIMEOUT_MS, `finnhub candle(${symbol})`);
    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      console.warn(`[yahoo-feed] finnhub candle(${symbol}) HTTP ${resp.status}: ${errorBody.slice(0, 200)}`);
      return { bars: [], diag: { reason: 'http_error', httpStatus: resp.status, errorBody: errorBody.slice(0, 200) } };
    }
    const json = (await resp.json()) as FinnhubCandleResponse;
    if (!json || json.s !== 'ok' || !json.t || !json.o || !json.h || !json.l || !json.c || !json.v) {
      return { bars: [], diag: { reason: 'no_data', httpStatus: resp.status, s: json?.s, rawLen: json?.t?.length ?? 0 } };
    }
    const len = json.t.length;
    const currentMinuteStart = Math.floor(Date.now() / 60_000) * 60_000;
    const candles: Candle[] = [];
    for (let i = 0; i < len; i++) {
      const ts = (json.t[i] ?? 0) * 1000;
      const v = json.v[i] ?? 0;
      const o = json.o[i];
      const h = json.h[i];
      const l = json.l[i];
      const c = json.c[i];
      if (o == null || h == null || l == null || c == null) continue;
      if (v <= 0) continue;
      if (ts >= currentMinuteStart) continue; // drop in-progress bar, like Yahoo branch
      candles.push({ symbol, timestamp: ts, open: o, high: h, low: l, close: c, volume: v });
    }
    const sliced = candles.slice(-count);
    return { bars: sliced, diag: { reason: 'ok', httpStatus: resp.status, s: json.s, rawLen: len, filteredLen: sliced.length } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[yahoo-feed] finnhub candle(${symbol}) error: ${msg}`);
    return { bars: [], diag: { reason: 'fetch_error', errorMsg: msg } };
  }
}

/**
 * Fetch the last N 1-minute candles for a symbol.
 *
 * Yahoo Finance is the primary source. When the breaker is open (recent 429s) or
 * Yahoo returns no usable bars, fall back to Finnhub's `/stock/candle`. Without
 * this fallback the signal engine starves on indicator math whenever Yahoo
 * rate-limits Render's egress IP and stops opening new stock auto-trades.
 */
export async function fetchMinuteBars(symbol: string, count = 60): Promise<Candle[]> {
  const { bars } = await fetchMinuteBarsWithSource(symbol, count);
  return bars;
}

/**
 * Diagnostic variant of {@link fetchMinuteBars} that also reports which provider
 * served the bars. Used by `/api/health/quotes` so QA can verify the Finnhub
 * fallback is actually engaging when Yahoo's breaker is open.
 */
export async function fetchMinuteBarsWithSource(
  symbol: string,
  count = 60,
): Promise<{ bars: Candle[]; source: 'yahoo' | 'finnhub' | 'none'; yahooSkipped: boolean; finnhubDiag?: FinnhubCandleDiag }> {
  const now = new Date();
  const from = new Date(now.getTime() - count * 60 * 1000 * 2); // 2× window to guarantee enough bars
  // Drop the in-progress current-minute bar (partial volume skews volume-climax checks).
  const currentMinuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

  const yahooSkipped = isRateLimited();
  // withRetry returns null when the breaker is open, so Yahoo is skipped fast.
  const result = await withRetry(
    () => yf.chart(symbol, { period1: from, period2: now, interval: '1m' }),
    `chart(${symbol})`,
  );
  const yahooBars: Candle[] = result
    ? (result.quotes ?? [])
        .filter(q => q.open != null && q.high != null && q.low != null && q.close != null && q.volume != null)
        .filter(q => (q.volume ?? 0) > 0)
        .filter(q => new Date(q.date).getTime() < currentMinuteStart)
        .map(q => ({
          symbol,
          timestamp: new Date(q.date).getTime(),
          open: q.open!,
          high: q.high!,
          low: q.low!,
          close: q.close!,
          volume: q.volume!,
        }))
        .slice(-count)
    : [];

  if (yahooBars.length > 0) return { bars: yahooBars, source: 'yahoo', yahooSkipped };

  const finnhub = await fetchFinnhubMinuteBars(symbol, count);
  if (finnhub.bars.length > 0) {
    console.info(`[yahoo-feed] chart(${symbol}): served ${finnhub.bars.length} bars from Finnhub fallback`);
    return { bars: finnhub.bars, source: 'finnhub', yahooSkipped, finnhubDiag: finnhub.diag };
  }
  return { bars: [], source: 'none', yahooSkipped, finnhubDiag: finnhub.diag };
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
