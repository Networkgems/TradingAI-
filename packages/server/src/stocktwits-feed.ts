/**
 * TRA-602 — StockTwits social-sentiment feed.
 *
 * StockTwits exposes a free, key-less JSON endpoint that returns the most recent
 * messages for a symbol stream:
 *
 *   GET https://api.stocktwits.com/api/2/streams/symbol/{SYMBOL}.json
 *
 * Each message may carry a self-reported `entities.sentiment.basic` tag of
 * `Bullish` / `Bearish` (or none). We normalize the stream down to the minimal
 * {@link StockTwitsMessage} shape the pure `aggregateStockTwitsSentiment`
 * reducer needs, leaving the scoring math in `@trading-app/shared` so it stays
 * unit-testable without network IO.
 *
 * The endpoint rate-limits unauthenticated callers hard (HTTP 429 with an
 * `X-RateLimit-Reset` epoch). We honor that with a process-wide circuit breaker
 * so a throttled response stops the engine from hammering the API until the
 * window resets — the same backstop pattern the Yahoo feed uses. Every failure
 * path degrades to `null` (never throws to the caller), so a cold/throttled
 * social feed leaves the breadth bundle's `social` half null-with-a-reason
 * rather than 500ing.
 */
import type { StockTwitsMessage } from '@trading-app/shared';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'stocktwits-feed' });

const ST_CALL_TIMEOUT_MS = 6_000;
/** Default breaker cooldown when a 429 arrives without a parseable reset. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/** Cap the per-symbol message pull — the engine only needs a recent window. */
const MAX_MESSAGES = 30;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then(
      v => { clearTimeout(timer); resolve(v); },
      e => { clearTimeout(timer); reject(e); },
    );
  });
}

// --- rate-limit circuit breaker (process-wide; StockTwits throttles per-IP) ---
let breakerOpenUntil = 0;

/** Whether the StockTwits rate-limit breaker is currently open. */
export function isStockTwitsBreakerOpen(now = Date.now()): boolean {
  return now < breakerOpenUntil;
}

/** Trip the breaker until `until` (epoch ms). Exported for tests. */
export function tripStockTwitsBreaker(until: number): void {
  if (until > breakerOpenUntil) breakerOpenUntil = until;
}

/** Reset the breaker. Exported for tests. */
export function resetStockTwitsBreaker(): void {
  breakerOpenUntil = 0;
}

/** Parse the `X-RateLimit-Reset` header (epoch seconds) into an epoch-ms deadline. */
function resetDeadlineFrom(resp: Response, now: number): number {
  const raw = resp.headers.get('x-ratelimit-reset');
  const epochSec = raw ? Number(raw) : NaN;
  if (Number.isFinite(epochSec) && epochSec > 0) return epochSec * 1000;
  return now + DEFAULT_COOLDOWN_MS;
}

/** Raw StockTwits message shape — only the fields we read are typed. */
interface RawStockTwitsMessage {
  id?: number;
  created_at?: string;
  entities?: { sentiment?: { basic?: string } | null } | null;
}

/** Raw StockTwits stream shape — only the fields we read are typed. */
interface RawStockTwitsStream {
  messages?: RawStockTwitsMessage[];
}

/** Normalize one raw message; returns null when it lacks an id/timestamp. */
function normalizeMessage(raw: RawStockTwitsMessage): StockTwitsMessage | null {
  if (typeof raw?.id !== 'number' || typeof raw?.created_at !== 'string') return null;
  const basic = raw.entities?.sentiment?.basic;
  const sentiment: StockTwitsMessage['sentiment'] =
    basic === 'Bullish' || basic === 'Bearish' ? basic : null;
  return { id: raw.id, createdAt: raw.created_at, sentiment };
}

/**
 * Fetch the recent message stream for one symbol, normalized to
 * {@link StockTwitsMessage}[]. Returns null on any failure (timeout, non-OK,
 * unparseable body) or when the rate-limit breaker is open. Never throws.
 */
export async function fetchStockTwitsStream(symbol: string): Promise<StockTwitsMessage[] | null> {
  const now = Date.now();
  if (isStockTwitsBreakerOpen(now)) {
    log.debug('skipping fetch — rate-limit breaker open', { symbol });
    return null;
  }
  const sym = symbol.toUpperCase();
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`;
  try {
    const resp = await withTimeout(fetch(url), ST_CALL_TIMEOUT_MS, `stocktwits(${sym})`);
    if (resp.status === 429) {
      const until = resetDeadlineFrom(resp, now);
      tripStockTwitsBreaker(until);
      log.warn('rate-limited (429); breaker open', { symbol: sym, until: new Date(until).toISOString() });
      return null;
    }
    if (!resp.ok) {
      log.warn('stream fetch returned non-OK status', { symbol: sym, status: resp.status });
      return null;
    }
    const body = (await resp.json()) as RawStockTwitsStream;
    const raw = Array.isArray(body?.messages) ? body.messages : [];
    const messages: StockTwitsMessage[] = [];
    for (const m of raw.slice(0, MAX_MESSAGES)) {
      const norm = normalizeMessage(m);
      if (norm) messages.push(norm);
    }
    return messages;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('stream fetch failed', { symbol: sym, reason: msg });
    return null;
  }
}

/** Test StockTwits connectivity — returns the message count for AAPL or throws. */
export async function testStockTwits(): Promise<{ symbol: string; messages: number }> {
  const stream = await fetchStockTwitsStream('AAPL');
  if (stream === null) {
    throw new Error(isStockTwitsBreakerOpen() ? 'rate-limit breaker open' : 'StockTwits returned no stream for AAPL');
  }
  return { symbol: 'AAPL', messages: stream.length };
}
