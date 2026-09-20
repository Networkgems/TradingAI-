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
import { ProxyAgent, type Dispatcher } from 'undici';
import { logger } from './observability/index.js';

const log = logger.child({ module: 'stocktwits-feed' });

/**
 * Per-call timeout for every StockTwits fetch.
 *
 * TRA-3019 — exported because it is the term that SIZES the
 * `signal.doTick.social-sentiment` wall-clock budget: this sink's worst case is
 * its budget plus the calls that overrun it, and each overrun is bounded by
 * exactly this. The budget test imports it rather than re-typing `6000`, so
 * raising this timeout fails that test instead of silently pushing the sink back
 * over its 30s bar.
 */
export const ST_CALL_TIMEOUT_MS = 6_000;
/** Default breaker cooldown when a 429 arrives without a parseable reset. */
const DEFAULT_COOLDOWN_MS = 5 * 60_000;
/**
 * TRA-2519 — hard ceiling on any breaker cooldown, including one derived from
 * the response.
 *
 * `X-RateLimit-Reset` is epoch SECONDS, and we multiply by 1000. If StockTwits
 * (or an intermediary) ever emits it in milliseconds instead, that multiply
 * yields a deadline ~57,000 years out and the breaker latches for the entire
 * process lifetime with no way to observe the difference — `breakerOpen: true`
 * looks the same at 5 minutes and at 5 millennia. StockTwits' own window is
 * hourly, so nothing legitimate needs longer than this; clamping costs us at
 * most one extra 429 and removes the unbounded-latch failure mode outright.
 *
 * NOTE this is defence in depth, not the observed 07-27/07-28 cause: bqb1's 429s
 * carried no parseable reset header at all (all 68 trips took the 5-minute
 * default exactly). The real driver was a restart storm re-tripping it — see the
 * module header and TRA-2476.
 */
const MAX_COOLDOWN_MS = 60 * 60_000;
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

/**
 * TRA-1963 — optional authenticated access. The keyless v2 stream endpoints cap
 * anonymous callers at ~200 req/hr per IP; presenting a valid OAuth
 * `access_token` raises that ceiling (~400/hr) and is honored by every
 * `/api/2/streams/*` route (an invalid token → HTTP 401, verified live, so we
 * only attach a non-empty one). The token is a SECRET — supplied via the
 * `STOCKTWITS_ACCESS_TOKEN` env, never committed, and it is an OAuth
 * access_token, NOT an account username/password (this API has no password
 * grant). NOTE: a token raises rate limits but does NOT clear a Cloudflare
 * IP-reputation block on datacenter egress — that is a separate axis, mitigated
 * on the request-fingerprint side by {@link BROWSER_HEADERS} and otherwise a
 * function of the egress IP itself.
 */
function withAccessToken(url: string, env: NodeJS.ProcessEnv = process.env): string {
  const token = env['STOCKTWITS_ACCESS_TOKEN']?.trim();
  if (!token) return url;
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}access_token=${encodeURIComponent(token)}`;
}

/**
 * TRA-1969 — optional clean-egress proxy. The StockTwits stream sits behind
 * Cloudflare, which blocks our datacenter egress IP by *reputation*
 * (TRA-1330) — a decision Cloudflare makes at the edge BEFORE any token is
 * read, so neither {@link withAccessToken} nor {@link BROWSER_HEADERS} can
 * clear it. The only lever is presenting a clean/dedicated egress IP. When the
 * `STOCKTWITS_PROXY_URL` secret is set (a managed dedicated-IP HTTP proxy,
 * e.g. `http://user:pass@static.host:9293`), every StockTwits stream/probe
 * call is routed through it via an undici {@link ProxyAgent} dispatcher so
 * Cloudflare sees the proxy's clean IP instead of Render's. The proxy is
 * SCOPED to this feed only (per-call `dispatcher`, never the global one) so it
 * cannot touch broker/quote/execution egress. It is a SECRET — supplied via
 * env, never committed. When unset this is fully inert: no dispatcher is
 * attached and behavior is byte-for-byte identical to today.
 */
let cachedStockTwitsProxy: { url: string; agent: ProxyAgent } | null = null;

function stockTwitsProxyDispatcher(env: NodeJS.ProcessEnv = process.env): Dispatcher | undefined {
  const url = env['STOCKTWITS_PROXY_URL']?.trim();
  if (!url) return undefined;
  // Memoize by URL so we reuse one pooled agent across calls (and rebuild only
  // if the secret is rotated to a different endpoint).
  if (cachedStockTwitsProxy?.url !== url) {
    // TRA-1969 — `new ProxyAgent()` THROWS on a malformed URL, and this runs
    // inside every stream/probe call. Before this catch, a single typo in a
    // hand-set host secret did not degrade the feed — it took the feed DOWN,
    // turning a fat-finger into an outage. That matters more now that the
    // approved tier is a self-hosted micro-VM whose URL a human types in.
    //
    // Degrading to direct egress is the right failure, but it must not be
    // SILENT: `describeStockTwitsEgress` will then observe both lookups on the
    // same IP and report `proxy-bypassed` with `proxyHost: null`, which is the
    // loud, checkable signal that the secret is set and doing nothing.
    let agent: ProxyAgent | null = null;
    try {
      agent = new ProxyAgent(url);
    } catch (err) {
      log.warn('STOCKTWITS_PROXY_URL is not a usable proxy URL — falling back to DIRECT egress', {
        issue: 'TRA-1969',
        reason: err instanceof Error ? err.message : String(err),
      });
    }
    if (agent === null) return undefined;
    cachedStockTwitsProxy = { url, agent };
  }
  return cachedStockTwitsProxy.agent;
}

/** Reset the memoized proxy agent. Exported for tests. */
export function resetStockTwitsProxy(): void {
  cachedStockTwitsProxy = null;
}

/**
 * TRA-1969 — is the clean-egress proxy ACTUALLY in the request path?
 *
 * ── Why this is not paranoia ─────────────────────────────────────────────────
 * `STOCKTWITS_PROXY_URL` is a secret set by hand on the host. If it is wrong —
 * dead micro-VM, rotated password, wrong port, a scheme undici will not dial —
 * `new ProxyAgent(url)` still constructs, the dispatcher is still attached, and
 * the call still either succeeds via some other route or fails in a way that
 * looks exactly like the ordinary Cloudflare/rate-limit failures this feed has
 * had for months. **A misconfigured proxy and a working proxy produce the same
 * observable feed**, which is precisely the class of instrument this codebase
 * keeps getting burned by — and the board has now approved money for a tier
 * whose entire value proposition is "the egress IP changed".
 *
 * So prove it, by measurement rather than by configuration: resolve the egress
 * IP TWICE against the same echo service — once with the dispatcher attached and
 * once deliberately without — and compare. No stored baseline is needed and no
 * assumption about what Render's IP "should" be.
 *
 *   proxyIp !== directIp  -> `proxy-in-path`      (the money is buying something)
 *   proxyIp === directIp  -> `proxy-bypassed`     (⛔ configured and NOT working)
 *   no proxy configured   -> `no-proxy`
 *   either lookup failed  -> `unknown`            (NEVER silently 'no-proxy')
 *
 * The proxy URL carries credentials, so only `host:port` is ever reported and
 * the userinfo is dropped. An unparseable URL yields a null host rather than
 * risking leaking the raw string into a health payload.
 */
export interface StockTwitsEgressDescriptor {
  proxyConfigured: boolean;
  /** `host:port` ONLY — credentials are never surfaced. Null if unparseable. */
  proxyHost: string | null;
  tokenConfigured: boolean;
  /** Egress IP observed WITH the dispatcher attached (i.e. what StockTwits sees). */
  proxyEgressIp: string | null;
  /** Egress IP observed with the dispatcher deliberately omitted (the host's own). */
  directEgressIp: string | null;
  verdict: 'proxy-in-path' | 'proxy-bypassed' | 'no-proxy' | 'unknown';
  /** Why the verdict is `unknown`, when it is. */
  reason: string | null;
}

const EGRESS_ECHO_URL = 'https://api.ipify.org?format=json';

function proxyHostOnly(raw: string): string | null {
  try {
    const u = new URL(raw);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return null;
  }
}

async function echoEgressIp(init: StockTwitsFetchInit): Promise<string | null> {
  try {
    const resp = await withTimeout(fetch(EGRESS_ECHO_URL, init), ST_CALL_TIMEOUT_MS, 'egress-echo');
    if (!resp.ok) return null;
    const body = (await resp.json()) as { ip?: unknown };
    return typeof body?.ip === 'string' && body.ip.length > 0 ? body.ip : null;
  } catch {
    return null;
  }
}

export async function describeStockTwitsEgress(
  env: NodeJS.ProcessEnv = process.env,
): Promise<StockTwitsEgressDescriptor> {
  const raw = env['STOCKTWITS_PROXY_URL']?.trim();
  const proxyConfigured = Boolean(raw);
  const base = {
    proxyConfigured,
    proxyHost: raw ? proxyHostOnly(raw) : null,
    tokenConfigured: Boolean(env['STOCKTWITS_ACCESS_TOKEN']?.trim()),
  };

  // The direct lookup is worth taking even with no proxy configured: it records
  // the egress IP a future Cloudflare verdict would be about, so a later block
  // can be attributed to an IP rather than guessed at.
  const directEgressIp = await echoEgressIp({ headers: BROWSER_HEADERS });

  if (!proxyConfigured) {
    return {
      ...base,
      proxyEgressIp: null,
      directEgressIp,
      verdict: 'no-proxy',
      reason: null,
    };
  }

  const proxyEgressIp = await echoEgressIp(stockTwitsFetchInit(env));
  if (proxyEgressIp === null || directEgressIp === null) {
    return {
      ...base,
      proxyEgressIp,
      directEgressIp,
      verdict: 'unknown',
      // Fails to `unknown`, never to `no-proxy` or `proxy-in-path`. An
      // unanswerable question is not a pass in either direction.
      reason:
        proxyEgressIp === null && directEgressIp === null
          ? 'both egress lookups failed'
          : proxyEgressIp === null
            ? 'proxied egress lookup failed — the proxy may be down'
            : 'direct egress lookup failed, so there is nothing to compare against',
    };
  }

  return {
    ...base,
    proxyEgressIp,
    directEgressIp,
    verdict: proxyEgressIp === directEgressIp ? 'proxy-bypassed' : 'proxy-in-path',
    reason:
      proxyEgressIp === directEgressIp
        ? 'STOCKTWITS_PROXY_URL is set but egress is UNCHANGED — the proxy is not in the request path'
        : null,
  };
}

/** undici's `fetch` accepts a `dispatcher`; the DOM `RequestInit` type does not. */
type StockTwitsFetchInit = RequestInit & { dispatcher?: Dispatcher };

/**
 * Build the `fetch` init shared by every StockTwits call: the browser-like
 * header fingerprint (TRA-1330) plus, when `STOCKTWITS_PROXY_URL` is set, a
 * clean-egress proxy dispatcher (TRA-1969). Inert (headers only) when unset.
 */
function stockTwitsFetchInit(env: NodeJS.ProcessEnv = process.env): StockTwitsFetchInit {
  const init: StockTwitsFetchInit = { headers: BROWSER_HEADERS };
  const dispatcher = stockTwitsProxyDispatcher(env);
  if (dispatcher) init.dispatcher = dispatcher;
  return init;
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

// --- rate-limit circuit breaker (process-wide; StockTwits throttles per-IP) ---
let breakerOpenUntil = 0;

/** Whether the StockTwits rate-limit breaker is currently open. */
export function isStockTwitsBreakerOpen(now = Date.now()): boolean {
  return now < breakerOpenUntil;
}

/**
 * TRA-2519 — the breaker's current reset deadline (epoch ms), or null when
 * closed. Two things need this that `isStockTwitsBreakerOpen` cannot serve:
 *
 *   - the TRA-822 recorder's half-open retry, so it waits exactly as long as the
 *     cooldown actually has left instead of guessing at it, and
 *   - `/api/health/sentiment-probe`, so an operator can tell a routine 5-minute
 *     cooldown from a stuck breaker. A bare `breakerOpen: true` cannot: that is
 *     what made the 07-27/07-28 zero-days read as "latched open" when the
 *     breaker was in fact cycling normally 68 times over the two sessions.
 */
export function stockTwitsBreakerOpenUntil(now = Date.now()): number | null {
  return now < breakerOpenUntil ? breakerOpenUntil : null;
}

/** Trip the breaker until `until` (epoch ms). Exported for tests. */
export function tripStockTwitsBreaker(until: number): void {
  if (until > breakerOpenUntil) breakerOpenUntil = until;
}

/** Reset the breaker. Exported for tests. */
export function resetStockTwitsBreaker(): void {
  breakerOpenUntil = 0;
}

/**
 * Parse the `X-RateLimit-Reset` header (epoch seconds) into an epoch-ms
 * deadline, clamped to [now, now + {@link MAX_COOLDOWN_MS}].
 *
 * A header that resolves to the PAST is also treated as unusable: it would set a
 * deadline behind `now`, leaving the breaker effectively closed and letting the
 * caller hammer straight back into the throttle. Both out-of-range directions
 * fall back to the default cooldown, and the caller logs which happened.
 */
function resetDeadlineFrom(resp: Response, now: number): { until: number; source: string; rawHeader: string | null } {
  const raw = resp.headers.get('x-ratelimit-reset');
  const epochSec = raw ? Number(raw) : NaN;
  if (Number.isFinite(epochSec) && epochSec > 0) {
    const parsed = epochSec * 1000;
    if (parsed > now && parsed <= now + MAX_COOLDOWN_MS) {
      return { until: parsed, source: 'header', rawHeader: raw };
    }
    return {
      until: now + DEFAULT_COOLDOWN_MS,
      source: parsed > now ? 'default(header-beyond-max)' : 'default(header-in-past)',
      rawHeader: raw,
    };
  }
  return { until: now + DEFAULT_COOLDOWN_MS, source: 'default(no-header)', rawHeader: raw };
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
    const resp = await withTimeout(fetch(withAccessToken(url), stockTwitsFetchInit()), ST_CALL_TIMEOUT_MS, label);
    if (resp.status === 429) {
      const { until, source, rawHeader } = resetDeadlineFrom(resp, now);
      tripStockTwitsBreaker(until);
      // TRA-2519 — log the cooldown SOURCE and the raw header. Reading the
      // 07-27/07-28 tape, every trip showed `until = ts + 5min`, which is what
      // established that no reset header was arriving at all; that mattered more
      // than the deadline itself and was only inferable by hand until now.
      log.warn('rate-limited (429); breaker open', {
        label,
        until: new Date(until).toISOString(),
        cooldownMs: until - now,
        source,
        rawHeader,
      });
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
 * TRA-603 — curated high-signal StockTwits accounts whose user streams were
 * ingested as a higher-weight lane. Seeded from the `clipse2` Following list on
 * the TRA-602 screenshots (analysts + official feeds).
 *
 * TRA-4739 — RETIRED. This list is no longer the default; it is kept as the
 * documented seed for anyone who resurrects the lane via
 * `CURATED_STOCKTWITS_ACCOUNTS`. See {@link getCuratedStockTwitsAccounts} for
 * the measurement that retired it.
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
 * `CURATED_STOCKTWITS_ACCOUNTS` env (comma-separated usernames).
 *
 * TRA-4739 — the default is now EMPTY: the curated lane is retired by board
 * decision (card `35590c81`, 2026-09-20). What it actually delivered, measured
 * over the whole persisted series (`packages/backtest/data/sentiment-snapshots`,
 * 2026-06-15 → 2026-09-03, 875 recorded symbol-days):
 *
 *   - **55 curated messages total — 0.202%** of the 27,180-message population.
 *   - Present on **15 of 35** recorded days, never more than **2** on any one
 *     symbol-day, and **none at all since 2026-08-18**.
 *   - The crowd lane saturates its own 30-message-per-symbol cap (every dry day
 *     lands on exactly 25 × 30 = 750), so curated messages are strictly
 *     additive — dropping them cannot displace a crowd read.
 *
 * Nine account fetches per sweep bought that 0.2%, against a shared rate-limit
 * breaker those same fetches help trip. Note this is NOT "zero by construction":
 * the lane worked, intermittently, and its yield was simply too small to pay for
 * itself. Setting the env resurrects it (see
 * {@link DEFAULT_CURATED_STOCKTWITS_ACCOUNTS} for the seed list).
 *
 * An empty list is a no-op at both call sites by construction, not by accident:
 * `runBudgetedSweep` short-circuits a zero-length universe to
 * `complete: true`, so the paired social sweep's completion still tracks the
 * crowd lane alone, and the recorder's curated map is simply empty.
 */
export function getCuratedStockTwitsAccounts(
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const raw = env.CURATED_STOCKTWITS_ACCOUNTS;
  if (typeof raw === 'string' && raw.trim().length > 0) {
    return raw.split(',').map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/**
 * TRA-4739 — why the curated lane is empty, as a value rather than an inference.
 *
 * `curatedCount: 0` on a snapshot row has meant two different things across the
 * retirement date — "nine accounts were polled and none of them said anything
 * attributable" before it, "nobody was polled" after it — and those read
 * identically in the data. Anything that logs or persists a curated count is
 * expected to carry this beside it so a later re-grade can partition the series
 * instead of guessing where the composition changed.
 */
export function describeCuratedLane(
  env: NodeJS.ProcessEnv = process.env,
): { status: 'retired' | 'enabled_by_env'; accounts: number } {
  const accounts = getCuratedStockTwitsAccounts(env).length;
  return { status: accounts === 0 ? 'retired' : 'enabled_by_env', accounts };
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
  /**
   * TRA-2519 — when the open breaker resets (ISO), or null when closed. Without
   * this, `breakerOpen: true` is the same reading for a normal 5-minute cooldown
   * and for a breaker stuck open, which is exactly the ambiguity that got the
   * 07-27/07-28 zero-days diagnosed as "latched open".
   */
  breakerOpenUntil: string | null;
  /** TRA-2519 — ms left on the open cooldown, or null when closed. */
  breakerOpenForMs: number | null;
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
  const openUntil = stockTwitsBreakerOpenUntil(now);
  const breakerOpen = openUntil !== null;
  const breaker = {
    breakerOpen,
    breakerOpenUntil: openUntil === null ? null : new Date(openUntil).toISOString(),
    breakerOpenForMs: openUntil === null ? null : openUntil - now,
  };
  const sym = symbol.toUpperCase();
  if (breakerOpen) {
    return { ok: false, status: null, messageCount: null, ...breaker, reason: 'rate-limit breaker open' };
  }
  const url = `https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`;
  try {
    const resp = await withTimeout(
      fetch(withAccessToken(url), stockTwitsFetchInit()),
      ST_CALL_TIMEOUT_MS,
      `stocktwits-probe(${sym})`,
    );
    if (!resp.ok) {
      return { ok: false, status: resp.status, messageCount: null, ...breaker, reason: `non-OK status ${resp.status}` };
    }
    const body = (await resp.json()) as RawStockTwitsStream;
    const count = Array.isArray(body?.messages) ? body.messages.length : 0;
    return { ok: true, status: resp.status, messageCount: count, ...breaker, reason: null };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, status: null, messageCount: null, ...breaker, reason: msg };
  }
}
