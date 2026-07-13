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

/**
 * TRA-1330 — the StockTwits stream endpoint is keyless but sits behind
 * Cloudflare, which bot-challenges/blocks requests that don't look like a real
 * browser. undici's default `fetch()` sends no `User-Agent`/`Accept` at all, so
 * every anonymous datacenter hit from Render egress cleanly degraded to null →
 * the TRA-822 recorder wrote `no_data` on every symbol-day (0 usable reads over
 * 13 captured days). Presenting a browser-like header fingerprint is the
 * zero-secret first mitigation: it addresses the request-fingerprint half of
 * Cloudflare's decision (the IP-reputation half is out of our hands, but many
 * datacenter blocks are fingerprint-only). Overridable via `STOCKTWITS_USER_AGENT`.
 */
const BROWSER_HEADERS: Readonly<Record<string, string>> = {
  'User-Agent':
    process.env['STOCKTWITS_USER_AGENT']?.trim() ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  Referer: 'https://stocktwits.com/',
  Origin: 'https://stocktwits.com',
};

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
  /** TRA-603 — tickers a message references; present on user-stream messages. */
  symbols?: Array<{ symbol?: string } | null> | null;
}

/** Raw StockTwits stream shape — only the fields we read are typed. */
interface RawStockTwitsStream {
  messages?: RawStockTwitsMessage[];
}

/**
 * Normalize one raw message; returns null when it lacks an id/timestamp.
 * When `curated` is set, the message is tagged `curated` and its `symbols`
 * entity is parsed into an uppercased, deduped ticker list (TRA-603) so it can
 * be folded onto every symbol it mentions.
 */
function normalizeMessage(
  raw: RawStockTwitsMessage,
  opts: { curated?: boolean } = {},
): StockTwitsMessage | null {
  if (typeof raw?.id !== 'number' || typeof raw?.created_at !== 'string') return null;
  const basic = raw.entities?.sentiment?.basic;
  const sentiment: StockTwitsMessage['sentiment'] =
    basic === 'Bullish' || basic === 'Bearish' ? basic : null;
  const msg: StockTwitsMessage = { id: raw.id, createdAt: raw.created_at, sentiment };
  if (opts.curated) {
    msg.curated = true;
    const symbols = Array.isArray(raw.symbols)
      ? raw.symbols
          .map(s => (typeof s?.symbol === 'string' ? s.symbol.toUpperCase() : null))
          .filter((s): s is string => !!s)
      : [];
    msg.symbols = [...new Set(symbols)];
  }
  return msg;
}

/**
 * Shared fetch+normalize path for the symbol and user stream endpoints. Honors
 * the rate-limit breaker, trips it on a 429, and degrades every failure to null
 * (never throws). `opts` is threaded to {@link normalizeMessage}.
 */
async function fetchStreamMessages(
  url: string,
  label: string,
  opts: { curated?: boolean } = {},
): Promise<StockTwitsMessage[] | null> {
  const now = Date.now();
  if (isStockTwitsBreakerOpen(now)) {
    log.debug('skipping fetch — rate-limit breaker open', { label });
    return null;
  }
  try {
    const resp = await withTimeout(fetch(url, { headers: BROWSER_HEADERS }), ST_CALL_TIMEOUT_MS, label);
    if (resp.status === 429) {
      const until = resetDeadlineFrom(resp, now);
      tripStockTwitsBreaker(until);
      log.warn('rate-limited (429); breaker open', { label, until: new Date(until).toISOString() });
      return null;
    }
    if (!resp.ok) {
      log.warn('stream fetch returned non-OK status', { label, status: resp.status });
      return null;
    }
    const body = (await resp.json()) as RawStockTwitsStream;
    const raw = Array.isArray(body?.messages) ? body.messages : [];
    const messages: StockTwitsMessage[] = [];
    for (const m of raw.slice(0, MAX_MESSAGES)) {
      const norm = normalizeMessage(m, opts);
      if (norm) messages.push(norm);
    }
    return messages;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    log.warn('stream fetch failed', { label, reason: msg });
    return null;
  }
}

/**
 * TRA-603 — curated high-signal StockTwits accounts whose user streams are
 * ingested as a higher-weight lane. Seeded from the `clipse2` Following list on
 * the TRA-602 screenshots (analysts + official feeds).
 */
export const DEFAULT_CURATED_STOCKTWITS_ACCOUNTS: readonly string[] = [
  'ivanhoff',
  'howardlindzon',
  'Jonathan_Morgan',
  'JFDI',
  'JoeyRockets',
  'StocktwitsNews',
  'StocktwitsEarnings',
  'Cryptotwits',
  'Stocktwits',
];

/**
 * TRA-603 — resolve the curated account list. Overridable via the
 * `CURATED_STOCKTWITS_ACCOUNTS` env (comma-separated usernames); falls back to
 * {@link DEFAULT_CURATED_STOCKTWITS_ACCOUNTS}.
 */
export function getCuratedStockTwitsAccounts(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.CURATED_STOCKTWITS_ACCOUNTS;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [...DEFAULT_CURATED_STOCKTWITS_ACCOUNTS];
}

/**
 * Fetch the recent message stream for one symbol, normalized to
 * {@link StockTwitsMessage}[]. Returns null on any failure (timeout, non-OK,
 * unparseable body) or when the rate-limit breaker is open. Never throws.
 */
export function fetchStockTwitsStream(symbol: string): Promise<StockTwitsMessage[] | null> {
  const sym = symbol.toUpperCase();
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`;
  return fetchStreamMessages(url, `stocktwits(${sym})`);
}

/**
 * TRA-603 — fetch the recent message stream for one curated account, normalized
 * to {@link StockTwitsMessage}[] with `curated: true` and each message's
 * `symbols` entity parsed. Reuses the TRA-602 rate-limit breaker and the same
 * degrade-to-null contract as {@link fetchStockTwitsStream}; never throws.
 */
export function fetchStockTwitsUserStream(username: string): Promise<StockTwitsMessage[] | null> {
  const user = username.trim();
  const url = `https://api.stocktwits.com/api/2/streams/user/${encodeURIComponent(user)}.json`;
  return fetchStreamMessages(url, `stocktwits-user(${user})`, { curated: true });
}

/** Test StockTwits connectivity — returns the message count for AAPL or throws. */
export async function testStockTwits(): Promise<{ symbol: string; messages: number }> {
  const stream = await fetchStockTwitsStream('AAPL');
  if (stream === null) {
    throw new Error(isStockTwitsBreakerOpen() ? 'rate-limit breaker open' : 'StockTwits returned no stream for AAPL');
  }
  return { symbol: 'AAPL', messages: stream.length };
}

/** TRA-1330 — live-connectivity diagnostics for one symbol probe. */
export interface StockTwitsProbeResult {
  /** True only when the endpoint returned HTTP 200 with a parseable body. */
  ok: boolean;
  /** The raw HTTP status (surfaces a Cloudflare 403/429/503 vs a network error). */
  status: number | null;
  /** Message count in the returned stream (0 = reached but empty). */
  messageCount: number | null;
  /** Whether the process-wide rate-limit breaker was open when probed. */
  breakerOpen: boolean;
  /** Human-readable failure reason, or null on success. */
  reason: string | null;
}

/**
 * TRA-1330 — a live one-shot connectivity probe that surfaces the actual HTTP
 * status (unlike {@link fetchStockTwitsStream}, which degrades everything to
 * null). Used by `/api/health/sentiment-probe` to verify from bqb1's Render
 * egress whether the browser-header fingerprint now clears Cloudflare — without
 * waiting for the daily TRA-822 sweep.
 *
 * The probe does not *trip* the breaker on a 429 (so a manual probe can't stall
 * the real recorder), but it does *honor* an already-open one: those are separate
 * directions. StockTwits throttles per-IP, so probing through an open breaker
 * would spend the very cooldown the breaker is serving and can extend the
 * throttle for the production recorder sharing that egress IP.
 */
export async function probeStockTwits(symbol = 'AAPL'): Promise<StockTwitsProbeResult> {
  const now = Date.now();
  const breakerOpen = isStockTwitsBreakerOpen(now);
  const sym = symbol.toUpperCase();
  if (breakerOpen) {
    return { ok: false, status: null, messageCount: null, breakerOpen, reason: 'rate-limit breaker open' };
  }
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`;
  try {
    const resp = await withTimeout(
      fetch(url, { headers: BROWSER_HEADERS }),
      ST_CALL_TIMEOUT_MS,
      `stocktwits-probe(${sym})`,
    );
    if (!resp.ok) {
      return { ok: false, status: resp.status, messageCount: null, breakerOpen, reason: `non-OK status ${resp.status}` };
    }
    const body = (await resp.json()) as RawStockTwitsStream;
    const count = Array.isArray(body?.messages) ? body.messages.length : 0;
    return { ok: true, status: resp.status, messageCount: count, breakerOpen, reason: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, messageCount: null, breakerOpen, reason: msg };
  }
}
