import YahooFinance from 'yahoo-finance2';
import { TradierStocksClient, type TradierEnv, type TradierEquityQuote } from '@trading-app/engine';
import type { Candle, NewsItem, CorporateAction } from '@trading-app/shared';
import { corporateActionInSessionWindow, normalizeQuoteCurrency } from '@trading-app/shared';
import { fetchStooqQuote } from './stooq-feed.js';

/**
 * TRA-3390 — the currency of the venue the Tradier equity adapter queries. See
 * `tradierQuoteToResult` for why a venue constant is a different (and sound)
 * claim from a ticker-suffix inference table.
 */
const TRADIER_VENUE_CURRENCY = 'USD';

const yf = new YahooFinance({
  suppressNotices: ['yahooSurvey'],
  validation: { logErrors: true },
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// Per-call timeout. Yahoo Finance occasionally hangs without responding, which
// previously blocked the 30-second tick indefinitely (no quotes → watchlist stuck
// "Loading…", and signals couldn't open positions because price was unavailable).
// TRA-3441 — exported so the cold-bar sizing test can derive its budget against
// the value that actually ships, rather than restating a number in a comment.
export const YF_CALL_TIMEOUT_MS = 8_000;

/** Extra attempts {@link withRetry} makes after the first one. */
export const YF_RETRIES = 2;

/**
 * TRA-3441 — the structural ceiling of ONE `fetchMinuteBarsWithSource` call,
 * counting only the legs this repo actually bounds.
 *
 * 🔴 It is a LOWER bound on the true ceiling, deliberately. The Tradier primary
 * (`TradierStocksClient.getMinuteBars`) issues a bare `fetch()` with **no
 * `AbortSignal`**, so its only limit is whatever undici's default header/body
 * timeouts happen to be — a number this repo neither sets nor tests. What is
 * counted here is the fallback chain that IS ours:
 *
 *   Yahoo `withRetry`  (YF_RETRIES + 1) x YF_CALL_TIMEOUT_MS + 1s + 2s backoff
 *   Twelve Data        YF_CALL_TIMEOUT_MS
 *
 * = 35s today. Any wall-clock budget on a sink that calls this must be sized
 * against `budget + this`, and TRA-3441's bar is 60s — which is why the cold-bar
 * sweep ships a per-call deadline as well as a budget. Exported so that stays an
 * executable assertion instead of a comment that ages.
 */
export const MINUTE_BAR_FALLBACK_CEILING_MS =
  (YF_RETRIES + 1) * YF_CALL_TIMEOUT_MS   // Yahoo chart attempts
  + 1_000 + 2_000                          // …and their (attempt + 1) * 1s backoff
  + YF_CALL_TIMEOUT_MS;                    // Twelve Data fallback

// 429 circuit breaker for Yahoo. When Yahoo rate-limits us, retrying every tick
// burns the retry budget for nothing and risks extending the lock-out. Open the
// breaker for a cool-down window so we fall through to Stooq fast.
const RATE_LIMIT_COOLDOWN_MS = 90_000;
// TRA-1391 — during the first BOOT_WINDOW_MS of process uptime, use a much
// longer cooldown. The 90s base resets every 3rd 30s equity tick, re-arming
// the ~450-symbol secondary Yahoo fan-out storm before the process has
// stabilised and causing the bqb1 ~3-min health-timeout restart loop:
//
//   t=0   equity tick → secondary fan-out → 429/crumb → breaker trips (90s)
//   t=30  tick → breaker open → skipped ✓
//   t=60  tick → breaker open → skipped ✓
//   t=91  breaker RESETS → next tick fires new storm → new stall → Render 5s timeout
//   → Render restarts → t=0 again (self-perpetuating)
//
// With a 10-min boot cooldown the breaker stays open through the entire
// Render health-probe window. After BOOT_WINDOW_MS the breaker reverts to
// the 90s steady-state value, so RTH operation is unaffected.
const BOOT_WINDOW_MS = 5 * 60_000;        // 5 min
const BOOT_RATE_LIMIT_COOLDOWN_MS = 10 * 60_000; // 10 min
let rateLimitedUntil = 0;
function isRateLimited(): boolean {
  return Date.now() < rateLimitedUntil;
}
function tripBreaker(label: string, msg: string): void {
  const cooldownMs = process.uptime() * 1000 < BOOT_WINDOW_MS
    ? BOOT_RATE_LIMIT_COOLDOWN_MS
    : RATE_LIMIT_COOLDOWN_MS;
  rateLimitedUntil = Date.now() + cooldownMs;
  console.warn(`[yahoo-feed] circuit breaker tripped for ${cooldownMs / 1000}s after ${label}: ${msg}`);
}
function isRateLimitError(msg: string): boolean {
  return /\b429\b|Too Many Requests|crumb/i.test(msg);
}

// yahoo-finance2 v3 types `providerPublishTime` as Date (validation-converted),
// but the raw API returns a unix-seconds number. Accept either so we render
// real publish times instead of garbage when validation is bypassed.
export function toIsoTime(t: Date | number | string | undefined | null): string {
  if (t instanceof Date) return t.toISOString();
  if (typeof t === 'number') return new Date(t * 1000).toISOString();
  if (typeof t === 'string') {
    const asNum = Number(t);
    if (Number.isFinite(asNum)) return new Date(asNum * 1000).toISOString();
    const parsed = Date.parse(t);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return new Date(0).toISOString();
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

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = YF_RETRIES): Promise<T | null> {
  if (isRateLimited()) {
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

// ── Active-interest set (TRA-154) ─────────────────────────────────────────────
// signal-engine populates this each tick with symbols that have open positions
// or recent signals. The Twelve Data candle fallback is gated to this set so we
// stay inside its 800/day free-tier budget instead of burning credits on every
// watchlist symbol on every tick.

// TRA-739: union-with-decay rather than a replaceable set. The signal process
// runs many engines (one per account — ~100 in prod), and each calls
// setActiveInterestSymbols every ~30s tick with ITS OWN active-interest set.
// The old `= new Set(symbols)` let whichever engine ticked last overwrite the
// global set, so the process-global cold/hot bar-cache split below could not
// trust it. We now stamp each asserted symbol with the time it was last seen
// and treat it as active-interest for ACTIVE_INTEREST_TTL_MS afterwards, so the
// global view is the union of every engine's set and self-heals as symbols go
// quiet (no engine re-asserts them → they decay back to cold).
const ACTIVE_INTEREST_TTL_MS = 2 * 60_000;
const activeInterestSeenAt = new Map<string, number>();

export function setActiveInterestSymbols(symbols: Iterable<string>): void {
  const now = Date.now();
  for (const s of symbols) activeInterestSeenAt.set(s, now);
  for (const [s, seenAt] of activeInterestSeenAt) {
    if (now - seenAt > ACTIVE_INTEREST_TTL_MS) activeInterestSeenAt.delete(s);
  }
}

function isActiveInterest(symbol: string): boolean {
  const seenAt = activeInterestSeenAt.get(symbol);
  return seenAt !== undefined && Date.now() - seenAt <= ACTIVE_INTEREST_TTL_MS;
}

// ── Tradier primary feed (TRA-191 follow-up) ──────────────────────────────────
// Once the Tradier broker creds are configured, Tradier is the primary source
// for both quotes and 1-minute bars. Yahoo / Twelve Data / Stooq remain as
// successive fallbacks so the engine still returns *something* when Tradier
// 429s or the env vars are missing.

const TRADIER_ENV = (process.env['TRADIER_ENV'] as TradierEnv) ?? 'sandbox';
// TRA-1937: Tradier sandbox.tradier.com does NOT serve live market data — only
// api.tradier.com does. Use a dedicated token for market-data calls so the quote
// feed always reaches the production endpoint regardless of the trading env.
// On standard (prod) deployments this equals TRADIER_API_TOKEN. On sandbox
// runs, set TRADIER_MARKET_DATA_TOKEN to the production key separately.
const TRADIER_MARKET_DATA_TOKEN =
  (process.env['TRADIER_MARKET_DATA_TOKEN'] ?? process.env['TRADIER_API_TOKEN'] ?? '');

// The stock quote client is a process-global singleton. Its token can come from
// the boot env (seeded below) and/or from each logged-in user's saved Tradier
// creds (wired per engine via setTradierStocksFeedClient). See the multi-tenant
// note on that setter (TRA-572) for why tokens are tracked per context key
// instead of a single mutable slot.
let tradierStocksClient: TradierStocksClient | null = null;

const TRADIER_BREAKER_COOLDOWN_MS = 90_000;
// TRA-1940 — a Tradier account-wide quota breach surfaces as `HTTP 400: Quota
// Violation`, NOT a 429/5xx. The old breaker predicate only matched 429/5xx, so a
// quota breach was caught-and-logged but NEVER opened the breaker: the client kept
// getting re-hammered as "primary" every tick, every call failed, every leftover
// symbol spilled onto the (also-degraded) Yahoo secondary chain, and doTick
// stretched to minutes with trade accrual pinned at zero (the trade-volume-zero
// symptom). A quota breach means the whole account is over budget, so back off for
// the full cooldown instead of probing per tick. Tradier quota windows are per-
// minute, so 90s comfortably covers a reset while cutting re-hit rate from once a
// tick (~every 30s → every request) to at most one probe per cooldown.
const TRADIER_QUOTA_COOLDOWN_MS = 90_000;
// TRA-1996 — the Tradier market-data breaker is tracked PER SOURCE. The dominant
// request volume is per-symbol `timesales` (minute-bar) pulls across the tracked
// universe; when the universe grew (~364 → 545 symbols) that bar-pull rate
// climbed back over the account's per-minute quota and re-tripped the breaker.
// Under TRA-1940 the breaker was a SINGLE shared flag, so a quota trip caused by
// a bar pull ALSO blocked the once-per-tick, whole-universe quote batch — the
// cheap, freshness-critical call — for the full 90s cooldown. With quotes gated
// off Tradier and 545 symbols spilling onto the Yahoo secondary chain (capped at
// FEED_FANOUT_BUDGET_MS), every quote aged past MAX_QUOTE_AGE_MS and the feed
// read 0/545 fresh, 6×/session (the C4 stale-state regression). Splitting the
// breaker lets a BAR-pull quota storm back off bar pulls only, while the cheap
// quote batch keeps refreshing quotes. A quota trip on a QUOTE call means the
// account is genuinely saturated, so it backs off both paths.
let tradierBarBlockedUntil = 0;
let tradierQuoteBlockedUntil = 0;
let tradierBlockedReason: 'quota' | 'http_error' | null = null;
/**
 * TRA-1996 — pure per-source breaker decision. Extracted so the asymmetric
 * blocking (a BAR trip must NOT block the quote path; a QUOTE trip blocks both)
 * is unit-testable without a live feed.
 *  - `barBlocked`: bar pulls back off while EITHER source is cooling down — a
 *    quote-caused breach means the account is genuinely over budget.
 *  - `quoteBlocked`: the freshness-critical quote batch backs off ONLY when a
 *    QUOTE call itself tripped the breaker, so a bar-pull quota storm never takes
 *    quotes dark.
 */
export function tradierBreakerGate(
  now: number,
  barBlockedUntil: number,
  quoteBlockedUntil: number,
): { barBlocked: boolean; quoteBlocked: boolean } {
  return {
    barBlocked: now < Math.max(barBlockedUntil, quoteBlockedUntil),
    quoteBlocked: now < quoteBlockedUntil,
  };
}
function isTradierBlocked(): boolean {
  return tradierBreakerGate(Date.now(), tradierBarBlockedUntil, tradierQuoteBlockedUntil).barBlocked;
}
function isTradierQuoteBlocked(): boolean {
  return tradierBreakerGate(Date.now(), tradierBarBlockedUntil, tradierQuoteBlockedUntil).quoteBlocked;
}
/** ms epoch the Tradier breaker (either source) recovers, for diagnostics. */
function tradierBlockedUntilMax(): number {
  return Math.max(tradierBarBlockedUntil, tradierQuoteBlockedUntil);
}
/** Whether a Tradier error should open the breaker: transient server/rate errors
 *  (429/5xx) OR an account-wide quota violation (surfaced as an HTTP 400 whose body
 *  contains "Quota Violation"). See TRA-1940. */
export function shouldTripTradierBreaker(msg: string): boolean {
  return /HTTP\s+(429|5\d\d)/.test(msg) || /quota/i.test(msg);
}
function tripTradierBreaker(label: string, msg: string, source: 'quote' | 'bar'): void {
  const isQuota = /quota/i.test(msg);
  const cooldownMs = isQuota ? TRADIER_QUOTA_COOLDOWN_MS : TRADIER_BREAKER_COOLDOWN_MS;
  const until = Date.now() + cooldownMs;
  if (source === 'quote') tradierQuoteBlockedUntil = until;
  else tradierBarBlockedUntil = until;
  tradierBlockedReason = isQuota ? 'quota' : 'http_error';
  console.warn(`[yahoo-feed] Tradier ${source} breaker tripped for ${cooldownMs / 1000}s (${tradierBlockedReason}) after ${label}: ${msg}`);
}

export function isTradierStocksConfigured(): boolean {
  return tradierStocksClient !== null;
}

// TRA-1940 — hard ceiling on the wall-time any single fetchQuotes call may spend
// fanning symbols out to the Yahoo/Stooq secondary chain. Bounds a fully-degraded
// tick to seconds instead of minutes. Env-overridable for the simulated dual-feed-
// down acceptance window; default 8s comfortably covers the 25-symbol watchlist
// under a healthy secondary feed while capping a 535-symbol storm.
const FEED_FANOUT_BUDGET_MS = (() => {
  const raw = Number(process.env['FEED_FANOUT_BUDGET_MS']);
  return Number.isFinite(raw) && raw > 0 ? raw : 8_000;
})();

// TRA-2627 — hoisted out of fetchQuotes so the coverage ceiling below can be
// computed (and unit-tested) from the same constants the loop actually uses.
const QUOTE_BATCH = 5;
const FANOUT_SLEEP_MS = 200;

/**
 * TRA-2627 — the largest number of symbols the secondary fan-out can EVER price in
 * one `fetchQuotes` call, **before a single millisecond of network time is
 * counted**.
 *
 * The fan-out is sequential batches of `QUOTE_BATCH` with a `FANOUT_SLEEP_MS`
 * politeness sleep between them, and the deadline is re-checked before each batch.
 * So the budget is spent on *sleeps*, not on work: at the 8s default that is
 * `floor(8000/200) * 5` = **200 symbols**. `FEED_FANOUT_BUDGET_MS` was sized when
 * the comment above it said "comfortably covers the 25-symbol watchlist"; bqb1's
 * universe is now 614, so whenever Tradier is dark ≥414 symbols (67%) are unpriced
 * by arithmetic alone — measured 2026-07-29T00:30:10Z as `395/597 failed`, i.e. 202
 * covered against a predicted ceiling of 200.
 *
 * This is exported so the ceiling is a readable number rather than a property you
 * have to re-derive from three constants in two scopes.
 */
export function secondaryFanoutCeiling(
  budgetMs: number = FEED_FANOUT_BUDGET_MS,
  sleepMs: number = FANOUT_SLEEP_MS,
  batch: number = QUOTE_BATCH,
): number {
  if (!(budgetMs > 0) || !(sleepMs > 0) || !(batch > 0)) return 0;
  return Math.floor(budgetMs / sleepMs) * batch;
}

/**
 * How many dropped symbols the truncation warning names before it elides. A
 * degraded tick drops ~414 of 614; dumping all of them would push the useful
 * part of the line past most log viewers' truncation and make the whole thing
 * unreadable, which is how you get a "loud" log nobody reads.
 */
const DROPPED_SYMBOL_SAMPLE = 20;

/**
 * TRA-2643 — render the head of the dropped set for the truncation warning.
 *
 * `5d73aab` (TRA-2627) made the shortfall loud but only in the aggregate: it
 * logs the count and the ceiling. "395/597 symbols failed" does not tell you
 * whether the session lost its risk gate or 395 discovery names nobody trades,
 * and those are different incidents with different remedies. On 2026-07-29 it
 * was the former — `^VIX` sat at index 510 of 614 — and nothing in the log said
 * so; the loss had to be reconstructed by hand afterwards.
 *
 * Callers order `symbols` most-important-first (TRA-2643), so the head of the
 * dropped suffix is the marginal set — what the budget *just* failed to buy.
 * Returns `''` for an empty drop so the existing line is byte-identical when
 * the failures came from per-symbol provider misses rather than the deadline.
 */
export function formatDroppedSymbols(
  dropped: readonly string[],
  sample: number = DROPPED_SYMBOL_SAMPLE,
): string {
  if (dropped.length === 0) return '';
  const head = dropped.slice(0, Math.max(0, sample));
  const rest = dropped.length - head.length;
  return ` — dropped ${head.join(',')}${rest > 0 ? ` (+${rest} more)` : ''}`;
}

// TRA-3385 (Remedy B) — Tradier names the symbols it cannot serve in
// `unmatched_symbols` on every batch response; the client used to parse and
// discard it, which left TRA-2682's coverage question ("which universe members
// are permanently un-servable by the primary?") looking like an open research
// task. This surfaces the answer as a measurement: the FULL membership, never
// a capped prefix — the 20-name `DROPPED_SYMBOL_SAMPLE` prefix on the drop
// lines is exactly what made this class invisible. Logged once per session and
// again only when membership changes, so a 670-symbol universe costs one line
// per boot, not one per tick.
let lastUnmatchedLoggedKey: string | null = null;

/** Returns the warn line to log for this batch's `unmatched_symbols`, or null
 * when there is nothing new to say (empty set, or same membership as already
 * logged this session). Pure apart from the module-level dedupe key, so tests
 * can drive it directly. */
export function recordTradierUnmatched(unmatched: readonly string[], requestedCount: number): string | null {
  if (unmatched.length === 0) return null;
  const sorted = [...unmatched].sort();
  const key = sorted.join(',');
  if (key === lastUnmatchedLoggedKey) return null;
  lastUnmatchedLoggedKey = key;
  return `[yahoo-feed] tradier quotes(batch): ${unmatched.length}/${requestedCount} requested symbols un-servable by the primary feed (unmatched_symbols): ${sorted.join(', ')}`;
}

/** Test seam: forget the last-logged unmatched membership. */
export function __resetTradierUnmatchedForTests(): void {
  lastUnmatchedLoggedKey = null;
}

// ── TRA-505 / TRA-572: wire the quote feed to live UI creds, multi-tenant-safe ─
// TRA-505: the live app writes each user's Tradier creds into per-user account
// settings (Settings page), NOT env — so on a normal deployment `TRADIER_API_TOKEN`
// is empty and the feed has no Tradier source even after the user has a working
// Tradier production connection (balance + trades). Quotes then fall through to
// Yahoo's free per-IP feed, which 429s and surfaces "Quote unavailable — provider
// rate-limited". The signal-engine calls the setter below from applySettings so
// quotes flow through the SAME Tradier account that already powers trading.
//
// TRA-572: but `tradierStocksClient` is a PROCESS-GLOBAL singleton shared by every
// user context, while the token is supplied PER context. The old single-slot setter
// let one credential-less context (e.g. a fresh demo signup with no Tradier token)
// call this with an empty string and null the client for EVERY user — stock quotes
// went dark process-wide and the watchlist showed "provider rate-limited" even
// though another logged-in account had a perfectly good Tradier production feed.
// We now track tokens per context key: clearing one context only removes ITS entry,
// and the feed stays live as long as ANY context still supplies a token. Quotes are
// read-only market data, so serving them from whichever context has a working token
// is correct and account-agnostic. The boot env token (if any) registers under a
// reserved key so a per-user clear can never evict it.
const FEED_ENV_CONTEXT_KEY = '__env__';
const feedTokensByContext = new Map<string, { token: string; env: TradierEnv }>();
let tradierFeedToken = '';
let tradierFeedEnv: TradierEnv = TRADIER_ENV;

/** Pick the token the shared feed should use: prefer a production data feed,
 *  else any sandbox token. Returns null when no context supplies a token. */
function pickActiveFeedToken(): { token: string; env: TradierEnv } | null {
  let fallback: { token: string; env: TradierEnv } | null = null;
  for (const entry of feedTokensByContext.values()) {
    if (entry.env === 'production') return entry;
    if (!fallback) fallback = entry;
  }
  return fallback;
}

/** Rebuild the singleton client from the best available context token, but only
 *  when the effective (token, env) actually changes — so an unrelated context's
 *  update never churns the breaker/cache of an unchanged active feed. */
function reconcileTradierFeedClient(): void {
  const active = pickActiveFeedToken();
  const nextToken = active?.token ?? '';
  const nextEnv = active?.env ?? tradierFeedEnv;
  if (nextToken === tradierFeedToken && nextEnv === tradierFeedEnv) return;
  tradierFeedToken = nextToken;
  tradierFeedEnv = nextEnv;
  // TRA-1937: always use the production endpoint for market data — sandbox.tradier.com
  // has no live quotes feed. The trading client (order routing) separately uses sandbox
  // when TRADIER_ENV=sandbox; that is unaffected by this URL choice.
  tradierStocksClient = nextToken ? new TradierStocksClient(nextToken, 'production') : null;
  // A credential change earns Tradier an immediate retry: clear any breaker the
  // old (empty/stale) token tripped on a 401/429 so the next tick uses the new
  // token instead of staying on Yahoo for another cooldown window.
  tradierBarBlockedUntil = 0;
  tradierQuoteBlockedUntil = 0;
  // TRA-552 — drop quotes cached under the previous token so a key rotation never
  // serves stale-cred data from the short-TTL cache.
  clearQuoteCache();
  if (tradierStocksClient) {
    console.info(`[yahoo-feed] Tradier stocks feed enabled (env=${nextEnv}; ${feedTokensByContext.size} context(s) supplying creds) — Tradier is the primary quote source`);
  } else {
    console.warn('[yahoo-feed] Tradier stocks feed disabled (no context supplies a token) — using Yahoo as primary');
  }
}

/**
 * Register (or, with an empty token, unregister) one context's Tradier quote
 * creds. `contextKey` isolates each user/engine so a credential-less context can
 * never evict another context's working feed (TRA-572). Omitting it targets a
 * shared default slot (used by tests and any single-context caller).
 */
export function setTradierStocksFeedClient(
  token: string | null | undefined,
  env: TradierEnv,
  contextKey = '__default__',
): void {
  const next = (token ?? '').trim();
  if (next) feedTokensByContext.set(contextKey, { token: next, env });
  else feedTokensByContext.delete(contextKey);
  reconcileTradierFeedClient();
}

/**
 * TRA-2045 — expose the shared Tradier stocks-feed client so the order-time
 * quote-freshness / max-slippage guard can pull a FRESH L1 quote right before
 * an equity submit (bypassing the short-TTL quote cache), reusing the same
 * production market-data client that already powers `fetchQuotes`. Returns
 * `null` when no context supplies a token — the guard degrades to a
 * `no_fresh_quote` counted reason rather than blocking the path.
 */
export function getTradierStocksFeedClient(): TradierStocksClient | null {
  return tradierStocksClient;
}

// NOTE: the boot env-token seed call lives at the BOTTOM of this module
// (`seedBootEnvTradierToken()`), not here. It runs `reconcileTradierFeedClient`
// → `clearQuoteCache()` → `quoteCache.clear()`, and `quoteCache` is a `const`
// declared further down. `const`/`let` are not value-hoisted, so calling the
// seed here at module-init order threw a temporal-dead-zone ReferenceError
// ("Cannot access 'quoteCache' before initialization") and crash-looped the
// prod deploy (TRA-574, regression from the TRA-572 per-context registry).
// Deferring the call until after every declaration is initialized fixes it.

// ── Daily fallback request counters ──────────────────────────────────────────
// Tracks how many fallback minute-bar requests we send per provider per UTC day
// so the /api/health/quotes endpoint can show whether we're approaching free-
// tier caps. Resets on UTC midnight rollover.

type FallbackProvider = 'tradier' | 'twelveData';
const fallbackCounters: Record<FallbackProvider, number> = {
  tradier: 0,
  twelveData: 0,
};
let fallbackCountersDay = utcDayKey();

function utcDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

function rollFallbackCountersIfNeeded(): void {
  const today = utcDayKey();
  if (today !== fallbackCountersDay) {
    fallbackCounters.tradier = 0;
    fallbackCounters.twelveData = 0;
    fallbackCountersDay = today;
  }
}

function bumpFallbackCounter(provider: FallbackProvider): void {
  rollFallbackCountersIfNeeded();
  fallbackCounters[provider] += 1;
  // TRA-739 — feed the restart-resilient rolling bar-pull meter on every actual
  // upstream Tradier bar fetch (the only provider whose account-wide quota we are
  // tracking against). Defined below; safe to call here as a hoisted declaration.
  if (provider === 'tradier') recordTradierBarPullRequest(Date.now());
}

export function getFallbackRequestCounts(): { day: string; tradier: number; twelveData: number } {
  rollFallbackCountersIfNeeded();
  return {
    day: fallbackCountersDay,
    tradier: fallbackCounters.tradier,
    twelveData: fallbackCounters.twelveData,
  };
}

// ── TRA-552: short-TTL quote cache + Tradier request-rate meter ───────────────
// Tradier is now the SOLE stock-quote source — Yahoo 429s permanently on
// Render's shared egress IP. At ~168k quote requests/day the production Tradier
// account risks tripping its OWN rolling rate-limit window and re-breaking
// quotes (the failure that cost the board a week). Two guards bound the volume:
//   • a short-TTL per-symbol quote cache so repeated reads of the same symbol
//     inside a few seconds — the watchlist poll, the relative-value scanner spot
//     fetch, and the signal-engine tick all read overlapping symbols — collapse
//     to a single upstream Tradier call instead of one each, and
//   • a rolling requests/min meter surfaced in /api/health/quotes so we can see
//     how much headroom remains under the production quota.

const QUOTE_CACHE_TTL_MS = (() => {
  const raw = Number(process.env['QUOTE_CACHE_TTL_MS']);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 20_000;
})();

interface QuoteCacheEntry {
  quote: QuoteResult;
  storedAt: number;
}
const quoteCache = new Map<string, QuoteCacheEntry>();
// TRA-739: singleflight for Tradier quote batches. The previous approach keyed
// on the sorted stale-set per caller, but 103 engines each have slightly different
// stale subsets --> different keys --> N concurrent Tradier calls (thundering herd).
// Fix: single global key so ANY concurrent caller waits on the same in-flight.
// The winner fetches ALL globally-stale symbols at once so waiters find their
// symbols fresh in cache when they wake.
const quoteInflight = new Map<string, Promise<void>>();
const TRADIER_QUOTE_INFLIGHT_KEY = '_g';

/**
 * Pure split of a requested symbol list into cache-fresh hits and the stale
 * remainder that still needs an upstream fetch. Extracted so the TTL behaviour
 * is unit-testable without a live feed or fake timers (TRA-552). A symbol is
 * fresh when its entry is younger than `ttlMs`; everything else (miss or
 * expired) goes to `stale`.
 */
export function partitionCachedQuotes(input: {
  symbols: readonly string[];
  cache: ReadonlyMap<string, QuoteCacheEntry>;
  ttlMs: number;
  now: number;
}): { fresh: Map<string, QuoteResult>; stale: string[] } {
  const fresh = new Map<string, QuoteResult>();
  const stale: string[] = [];
  for (const sym of input.symbols) {
    const hit = input.cache.get(sym);
    if (hit && input.now - hit.storedAt < input.ttlMs) {
      fresh.set(sym, hit.quote);
    } else {
      stale.push(sym);
    }
  }
  return { fresh, stale };
}

function cacheFreshQuotes(entries: Iterable<readonly [string, QuoteResult]>, now: number): void {
  for (const [sym, q] of entries) quoteCache.set(sym, { quote: q, storedAt: now });
}

/** Clear every cached quote — called on a Tradier credential change so the
 * feed never serves a quote fetched under the old token after a key rotation. */
function clearQuoteCache(): void {
  quoteCache.clear();
}

// Rolling window of Tradier quote-request timestamps (epoch-ms). Only ACTUAL
// upstream Tradier quote calls are recorded — cache hits are free and must not
// inflate the meter, otherwise it can't show the quota headroom the cache buys.
const QUOTE_RATE_WINDOW_MS = 60_000;
const tradierQuoteReqTimestamps: number[] = [];

/**
 * Pure rolling-window count: how many of `timestamps` fall within `windowMs`
 * of `now`, plus the pruned list (entries still inside the window). Extracted
 * for unit testing the req/min meter without timers (TRA-552).
 */
export function requestsInWindow(
  timestamps: readonly number[],
  now: number,
  windowMs: number,
): { count: number; kept: number[] } {
  const cutoff = now - windowMs;
  const kept = timestamps.filter(t => t > cutoff);
  return { count: kept.length, kept };
}

/**
 * TRA-3104 — count of `timestamps` inside the **FIXED, boundary-ALIGNED** window
 * containing `now`, i.e. `[floor(now/windowMs)*windowMs, now]`.
 *
 * WHY THIS EXISTS, AND WHY {@link requestsInWindow} CANNOT REPLACE IT:
 * Tradier's account quota is enforced on a **fixed, minute-aligned** window, not
 * a sliding one. Measured 2026-08-06 on bqb1: **26/26** `HTTP 400: Quota
 * Violation` responses carried an `Expires` value landing exactly on the next
 * `:00` second boundary (11 distinct values, every one minute-aligned). The
 * upstream tells us where its boundary is; this counts against that boundary.
 *
 * THE MISMATCH IS ONE-DIRECTIONAL, AND THE DIRECTION IS THE OPPOSITE OF THE
 * OBVIOUS ONE. The aligned bucket `[floor(now/W)*W, now]` is always a SUBSET of
 * the trailing window `(now-W, now]`, so `slidingCount >= fixedCount` always ⇒ a
 * sliding gate at N is strictly MORE conservative than a fixed gate at N and can
 * never permit more than N inside an enforced minute. (TRA-3104 originally
 * asserted it "fails in both directions" and that a boundary-straddling burst
 * spends 2N-2; that is FALSE, and the unit test written to demonstrate it is what
 * refuted it. Brute-forced over 20,000 randomized bursty arrival patterns at
 * N=20: peak spend inside any fixed minute was exactly 20 under BOTH gates, zero
 * violations. The under-fire claim is retracted — do not re-derive a design from
 * it.)
 *
 * What the mismatch actually costs is CAPACITY, and at a universe where the
 * budget is already binding that is the expensive error:
 *   • it OVER-fires — a quiet enforced minute whose trailing 60s straddles a busy
 *     one reads at the ceiling, so cold pulls are deferred while real quota in the
 *     CURRENT minute goes unspent, and cold candles age past the shard cadence
 *     (the TRA-1539 regression) for nothing. Same brute force: 825 fixed minutes
 *     with refusals despite real headroom, 2,258 refusals a fixed gate allows.
 * So matching the enforcement window is still a correctness precondition — a
 * limiter that refuses while the metered window has headroom is measuring the
 * wrong thing — but it is a HEADROOM bug, not a safety bug, and it cannot be the
 * cause of a `Quota Violation`. See {@link barPullThrottleGate} for what can.
 *
 * The rolling meter is kept for TELEMETRY — it is the right shape for reading a
 * burst tail, just not for enforcement. Note the aligned bucket start is always
 * `>= now - windowMs`, so the rolling-pruned timestamp array always still holds
 * everything this counter needs; the two share one array with no extra storage
 * (asserted in the unit tests).
 */
export function requestsInFixedWindow(
  timestamps: readonly number[],
  now: number,
  windowMs: number,
): { count: number; windowStart: number } {
  const windowStart = Math.floor(now / windowMs) * windowMs;
  let count = 0;
  for (const t of timestamps) if (t >= windowStart && t <= now) count++;
  return { count, windowStart };
}

// TRA-3104 — session high-water of the FIXED-minute counts. A reservation sized
// off the *instantaneous* observed quote rate is fail-open in exactly the wrong
// world: when Tradier starts refusing us, the observed rate FALLS, which would
// shrink the quote reservation and hand the freed budget to the bar path that
// caused the trip. A monotone high-water cannot be dragged down by a refusal.
let tradierQuoteFixedMinutePeak = 0;
let tradierBarPullFixedMinutePeak = 0;

// TRA-3104 — per-minute histogram of ACCOUNT-WIDE Tradier calls, bounded to the
// most recent `ACCOUNT_MINUTE_HISTORY` completed minutes.
//
// WHY, AND IT IS NOT THE OBVIOUS REASON: the session high-waters above never
// decay, so a verdict read off them LATCHES — one open-bell burst makes `crossed`
// true for the rest of the process's life, and the field then answers "did this
// ever happen?" while reading like "is this happening?". Distinguishing a genuine
// capacity condition (the MEAN is at the plan; no throttle helps) from a burst
// (mean under, peak over; a limiter is exactly the right tool) needs a mean AND a
// peak over the same bounded, recent window. Peak-vs-mean is the whole remedy
// question, so the statistic has to be able to separate them.
const ACCOUNT_MINUTE_HISTORY = 30;
const tradierAccountMinuteCounts = new Map<number, number>();

function recordAccountMinute(now: number): void {
  const bucket = Math.floor(now / BAR_PULL_RATE_WINDOW_MS);
  tradierAccountMinuteCounts.set(bucket, (tradierAccountMinuteCounts.get(bucket) ?? 0) + 1);
  if (tradierAccountMinuteCounts.size > ACCOUNT_MINUTE_HISTORY) {
    // Prune oldest buckets. Insertion order is arrival order, and buckets only
    // ever advance, so the first keys are the oldest.
    const excess = tradierAccountMinuteCounts.size - ACCOUNT_MINUTE_HISTORY;
    let dropped = 0;
    for (const k of tradierAccountMinuteCounts.keys()) {
      if (dropped++ >= excess) break;
      tradierAccountMinuteCounts.delete(k);
    }
  }
}

/**
 * TRA-3104 — mean and peak account-wide req/min over the recent COMPLETED minutes.
 * The current (partial) minute is excluded: a minute sampled 3 seconds in reads as
 * a near-zero rate and would drag the mean toward a false all-clear.
 */
export function accountMinuteStats(
  counts: ReadonlyMap<number, number>,
  now: number,
  windowMs: number,
): { mean: number; peak: number; minutes: number } {
  const currentBucket = Math.floor(now / windowMs);
  const completed = [...counts.entries()].filter(([b]) => b < currentBucket).map(([, c]) => c);
  if (completed.length === 0) return { mean: 0, peak: 0, minutes: 0 };
  const sum = completed.reduce((a, b) => a + b, 0);
  return { mean: sum / completed.length, peak: Math.max(...completed), minutes: completed.length };
}

function recordTradierQuoteRequest(now: number): void {
  tradierQuoteReqTimestamps.push(now);
  const { kept } = requestsInWindow(tradierQuoteReqTimestamps, now, QUOTE_RATE_WINDOW_MS);
  tradierQuoteReqTimestamps.length = 0;
  for (const t of kept) tradierQuoteReqTimestamps.push(t);
  const { count } = requestsInFixedWindow(tradierQuoteReqTimestamps, now, QUOTE_RATE_WINDOW_MS);
  if (count > tradierQuoteFixedMinutePeak) tradierQuoteFixedMinutePeak = count;
}

/**
 * Tradier quote-request rate, surfaced by `/api/health/quotes` (TRA-552). At a
 * 30s tick the watchlist poll alone is ~2 calls/min; sustained values far above
 * that mean the cache/coalescing isn't engaging and we're approaching the
 * production rolling-window quota.
 */
export function getTradierQuoteRateState(now: number = Date.now()): {
  requestsLastMin: number;
  /** TRA-3104 — count inside the FIXED minute-aligned window Tradier meters. */
  requestsThisMinute: number;
  /** TRA-3104 — monotone session high-water of `requestsThisMinute`. */
  peakPerFixedMinute: number;
  windowSec: number;
  cachedSymbols: number;
  cacheTtlMs: number;
} {
  const { count } = requestsInWindow(tradierQuoteReqTimestamps, now, QUOTE_RATE_WINDOW_MS);
  const fixed = requestsInFixedWindow(tradierQuoteReqTimestamps, now, QUOTE_RATE_WINDOW_MS);
  return {
    requestsLastMin: count,
    requestsThisMinute: fixed.count,
    peakPerFixedMinute: tradierQuoteFixedMinutePeak,
    windowSec: QUOTE_RATE_WINDOW_MS / 1000,
    cachedSymbols: quoteCache.size,
    cacheTtlMs: QUOTE_CACHE_TTL_MS,
  };
}

// TRA-739 — rolling Tradier *bar-pull* requests/min (minute + daily timesales).
// `fallbackRequestsToday.tradier` is a cumulative per-instance daily counter that
// resets on every process restart (Render recycles instances), so it cannot be
// differenced across two /api/health/quotes reads to recover a rate — a restart
// between samples silently makes the delta negative. This 60s rolling meter
// mirrors the quote meter above and is restart-resilient, giving the TRA-554
// sampler a trustworthy bar-pull req/min reading separate from the quote path.
const BAR_PULL_RATE_WINDOW_MS = 60_000;
const tradierBarPullReqTimestamps: number[] = [];

function recordTradierBarPullRequest(now: number): void {
  tradierBarPullReqTimestamps.push(now);
  const { kept } = requestsInWindow(tradierBarPullReqTimestamps, now, BAR_PULL_RATE_WINDOW_MS);
  tradierBarPullReqTimestamps.length = 0;
  for (const t of kept) tradierBarPullReqTimestamps.push(t);
  const { count } = requestsInFixedWindow(tradierBarPullReqTimestamps, now, BAR_PULL_RATE_WINDOW_MS);
  if (count > tradierBarPullFixedMinutePeak) tradierBarPullFixedMinutePeak = count;
  // This meter is fed from every `bumpFallbackCounter('tradier')` site, including
  // the quote path, so it IS the account-wide population — see
  // `getTradierAccountSpendThisMinute` for why nothing may be added to it.
  recordAccountMinute(now);
}

/**
 * Rolling Tradier request rate, surfaced by `/api/health/quotes` (TRA-739).
 * Counts every actual upstream Tradier call (each `bumpFallbackCounter('tradier')`
 * site); cache hits are free and never recorded.
 *
 * ⛔⛔ TRA-3104 — THIS SERIES IS MISNAMED AND THE OLD DOCBLOCK HERE STATED THE
 * ARITHMETIC BACKWARDS. It said "the quota Tradier enforces is account-wide, so
 * total load = this bar-pull rate PLUS `tradierQuoteRate.requestsLastMin`". That
 * addition DOUBLE-COUNTS: the quote path calls `bumpFallbackCounter('tradier')`
 * before `recordTradierQuoteRequest`, so this array already contains every quote
 * batch. It is the ACCOUNT-WIDE total (daily bars + minute bars + quote batches),
 * and `tradierQuoteRate` is a SUBSET of it. The name is kept for the graders and
 * the cross-day series that already read `requestsLastMin`; the meaning is
 * documented here rather than silently changed underneath them.
 *
 * The stale sentence had already propagated into a measured conclusion: TRA-3104
 * was filed asserting "mean 184.0 + quotes 16 = 200 = the budget, fully consumed
 * in steady state". Corrected, steady-state account demand is ~184/min against a
 * ~200/min plan and the exhaustion is a BURST (tail 260), not the mean — which
 * changes the remedy from "buy capacity" to "smooth the peak".
 */
export function getTradierBarPullRateState(now: number = Date.now()): {
  requestsLastMin: number;
  /** TRA-3104 — count inside the FIXED minute-aligned window Tradier meters.
   * This is the statistic the throttle gate reads; `requestsLastMin` above is
   * telemetry (a burst tail), and a sliding count cannot bound a fixed quota. */
  requestsThisMinute: number;
  /** TRA-3104 — monotone session high-water of `requestsThisMinute`. */
  peakPerFixedMinute: number;
  windowSec: number;
} {
  const { count } = requestsInWindow(tradierBarPullReqTimestamps, now, BAR_PULL_RATE_WINDOW_MS);
  const fixed = requestsInFixedWindow(tradierBarPullReqTimestamps, now, BAR_PULL_RATE_WINDOW_MS);
  return {
    requestsLastMin: count,
    requestsThisMinute: fixed.count,
    peakPerFixedMinute: tradierBarPullFixedMinutePeak,
    windowSec: BAR_PULL_RATE_WINDOW_MS / 1000,
  };
}

// TRA-2170 — process-global bar-pull ceiling (req/min). Default DISABLED
// (Infinity) so the wired throttle is provably inert on the frozen bqb1 host
// until an operator opts in via the env knob.
//
// ⛔ DO NOT SET THIS FROM A NUMBER WRITTEN IN THIS FILE. RE-MEASURE FIRST.
//
// THE INVARIANT (true whenever it is read): the ceiling MUST sit ABOVE the
// steady-state bar-pull rate at the CURRENT symbol universe. A ceiling at or
// below steady state defers COLD pulls CONTINUOUSLY and ages cold candles past
// the shard cadence — the TRA-1539 regression. It is only a burst trim when it
// sits above the steady state and below the account-wide Tradier budget; that is
// a window, and BOTH of its edges move.
//
// WHY NO CONSTANT HERE IS SAFE TO INHERIT: this is an ABSOLUTE req/min value
// bounding a quantity that scales with the universe, and the universe grows.
// The spec's original ~150 was already below the then-measured steady state.
// Disposition A (2026-07-24) recalibrated the enable target to ~200 against a
// steady state measured at **568 symbols** — and by 2026-08-06 the universe was
// **633** (+11.4%), which pushes the scaled steady-state band up onto and across
// 200. So the recalibrated figure went stale in under two weeks, in the direction
// of the regression, without a single line of this file changing. Any successor
// number will do the same.
//
// BEFORE ENABLING: measure the steady-state mean at the live universe with
//   node scripts/tra2170-barpull-calibration.mjs --mark --report --ceiling=<n>
// (two sparse in-RTH marks, cumulative-counter differenced, build-pin asserted).
// It emits an explicit DO-NOT-SET verdict when the candidate is at or under the
// measured mean. Note also that enabling is an env write, which redeploys bqb1
// (`trigger: service_updated`, TRA-2186) and therefore resets the TRA-1648 soak
// clock — sequence it against that grade, off-hours.
//
// See barPullThrottleGate below for the scope caveat (this is NOT the C4 fix).
const TRADIER_BAR_PULL_CEILING = (() => {
  const raw = Number(process.env['TRADIER_BAR_PULL_CEILING']);
  return Number.isFinite(raw) && raw > 0 ? raw : Number.POSITIVE_INFINITY;
})();

// ── TRA-3104 — one account-wide budget, an explicit quote reservation, and the
//    bar ceiling DERIVED as the remainder ─────────────────────────────────────
//
// PUT THE CONSTANT WHERE THE CONSTANT ACTUALLY IS. `TRADIER_BAR_PULL_CEILING`
// above is an ABSOLUTE req/min number bounding a quantity that SCALES with our
// symbol universe, so it goes stale silently every time the universe grows — and
// it drifts TOWARD the TRA-1539 regression it was calibrated to avoid, with no
// code change and no event. The only quantity here that is genuinely constant is
// the one describing the UPSTREAM CONTRACT: the account's req/min plan. That is
// a property of Tradier's side, it does not move when our population moves, and
// everything that DOES scale with our population is derived from it below.
//
// ⛔ THE CONSTRAINTS ON THE ABSOLUTE KNOB HAVE CROSSED — DO NOT SET IT.
// Measured live on bqb1 during the 2026-08-06 RTH session at universe **640**
// (three sparse marks, identical build pin `f19fb1fa3068`/pid 72):
//   • steady-state bar-pull mean **184.0 req/min** (930 pulls / 5.056 min), with
//     a rolling `barPullsLastMin` tail of **260**;
//   • quote path **14-16 req/min**;
//   • 184 + 16 = **200 req/min** — the modelled account budget, and Tradier
//     confirmed it BINDING by refusing us: **26 `HTTP 400: Quota Violation`** in
//     RTH hour 1 (complete log page), on `timesales(...)` AND `quotes(batch)`,
//     first at 13:30:13Z.
// To reserve quote headroom the ceiling must sit BELOW budget - quote demand
// (~184); to avoid deferring cold pulls continuously it must sit ABOVE steady
// state (~184, realistically above the 260 tail). Those were compatible at 568
// symbols. At 640 they are EMPTY: no value satisfies both. The pre-authorised
// `200` lands in the worst position — below the rolling tail (so it throttles)
// and above the mean (so it reserves nothing).
//
// ⚠️ AND NEITHER ITEM BELOW CREATES CAPACITY. At 640 the account budget is
// already fully consumed in steady state. A throttle can only make the refusal
// ORDERLY — deferring OUR cold bar pulls instead of letting Tradier 400 the whole
// account, which today cascades bar-quota trip -> Yahoo fan-out at 640 -> Yahoo
// `Edge: Too Many Requests` -> both breakers open -> `fetchQuotes: 640/640
// symbols failed` -> `equity feed stale; skipping signal evaluation`. The
// capacity question (larger Tradier quota / smaller-or-tiered universe / longer
// cold-bar cadence) is UPSTREAM of all of this and is a board decision.

/** Tradier account-wide req/min plan. A property of the UPSTREAM contract, not of
 * our universe — see the block above for why that distinction is the whole point.
 * Override only if the account plan itself changes. */
const TRADIER_ACCOUNT_BUDGET_PER_MIN = (() => {
  const raw = Number(process.env['TRADIER_ACCOUNT_BUDGET_PER_MIN']);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 200;
})();

/** Opt-in switch for the DERIVED bar ceiling. Default OFF: the budget block is
 * observe-only, so it publishes the crossing diagnostic on every box without
 * changing a single fetch decision. Enabling it is a decision that needs the
 * capacity call above to have been made — a throttle cannot create capacity. */
const TRADIER_QUOTA_ENFORCE_BAR_CEILING = process.env['TRADIER_QUOTA_ENFORCE_BAR_CEILING'] === '1';

/**
 * TRA-3104 — the quote path's reserved slice of the account budget, in req/min.
 * Quotes get a FLOOR; bars get the remainder ({@link resolveBarPullCeiling}).
 *
 * Two inputs, both derived, neither an inherited absolute:
 *   • `structuralFloor` — what the quote path must be allowed even when it has
 *     never yet been observed: one batched `quotes(batch)` call per cache-TTL
 *     expiry, i.e. `ceil(60_000 / QUOTE_CACHE_TTL_MS)`. Note the Tradier quote
 *     path is a SINGLE batched HTTP call for the whole universe, so this floor
 *     does NOT scale with symbol count (measured: 14-16 req/min at 640 symbols).
 *   • `observedPeak` — the monotone session high-water of the FIXED-minute quote
 *     count. It must be a high-water and not the instantaneous rate: when
 *     Tradier begins refusing us the observed rate FALLS, and a reservation that
 *     tracked it down would hand the freed budget straight back to the bar path
 *     that caused the trip. Fail-open in exactly the world that matters.
 *
 * The margin is a FRACTION, never an absolute — a fraction cannot go stale when
 * the thing it is a fraction of moves.
 */
export function quoteReservationReqPerMin(input: {
  structuralFloor: number;
  observedPeak: number;
  marginFraction?: number;
  minMargin?: number;
}): number {
  const { structuralFloor, observedPeak } = input;
  const marginFraction = input.marginFraction ?? 0.25;
  const minMargin = input.minMargin ?? 2;
  const base = Math.max(0, structuralFloor, observedPeak);
  return base + Math.max(minMargin, Math.ceil(base * marginFraction));
}

/**
 * TRA-3104 — resolve the single bar-pull ceiling the gate enforces, and say which
 * rule produced it. Precedence is explicit so no caller has to guess:
 *   1. `derived_budget` — enforcement opted in: `accountBudget - quoteReservation`.
 *      Clamped at >= 1 so an over-large reservation degrades to "defer cold pulls"
 *      rather than to a nonsensical negative that reads as disabled.
 *   2. `absolute_env` — the legacy `TRADIER_BAR_PULL_CEILING`, kept working for
 *      backwards compatibility. ⛔ It is SUPERSEDED and must stay unset: its two
 *      constraints have crossed (see the block above).
 *   3. `disabled` — neither set: `Infinity`, and {@link barPullThrottleGate}
 *      short-circuits before reading any counter. This is the default on every
 *      box today, so the whole budget block is provably inert until opted into.
 */
export function resolveBarPullCeiling(input: {
  enforceDerived: boolean;
  accountBudget: number;
  quoteReservation: number;
  absoluteCeiling: number;
}): { ceiling: number; source: 'derived_budget' | 'absolute_env' | 'disabled' } {
  const { enforceDerived, accountBudget, quoteReservation, absoluteCeiling } = input;
  if (enforceDerived && Number.isFinite(accountBudget) && accountBudget > 0) {
    return { ceiling: Math.max(1, Math.floor(accountBudget - quoteReservation)), source: 'derived_budget' };
  }
  if (Number.isFinite(absoluteCeiling) && absoluteCeiling > 0) {
    return { ceiling: absoluteCeiling, source: 'absolute_env' };
  }
  return { ceiling: Number.POSITIVE_INFINITY, source: 'disabled' };
}

/**
 * TRA-3104 — is the account budget structurally unable to cover observed demand?
 *
 * This is the CROSSING, made self-reporting. The 2026-08-06 finding needed a
 * hand-run RTH calibration to discover that no ceiling value satisfies both
 * constraints; because bar demand scales with a universe that keeps growing, that
 * verdict expires and someone has to re-measure it by hand every time. Publishing
 * it means the next reader gets the answer off `/api/health/quotes` instead of
 * inheriting a number.
 *
 * ⭐ THE VERDICT IS THREE-VALUED BECAUSE THE REMEDIES ARE OPPOSITE. Collapsing
 * "demand exceeds the plan" into one boolean is what produced TRA-3104's wrong
 * headline. Separate them:
 *   • `budgetExhausted` — the recent MEAN is at the plan. Genuine capacity: no
 *     throttle creates capacity, so only a bigger quota / smaller universe / longer
 *     cold cadence helps.
 *   • `burstBound` — the mean is UNDER the plan but the peak is over it. A
 *     smoothing problem, and a correctly-windowed limiter is precisely the tool.
 *   • `ceilingUnsatisfiable` — peak demand already meets the derived allowance, so
 *     an enabled throttle can only bite and cannot reserve headroom without
 *     continuously aging cold candles (the TRA-1539 path).
 * Both mean and peak are read over the same bounded window of recent COMPLETED
 * minutes, so the verdict decays instead of latching on one open-bell burst.
 */
export function quotaCrossingVerdict(input: {
  barCeiling: number;
  /** Account-wide peak. ⛔ NOT bar-only, and NOT a sum with the quote peak — the
   * account meter already contains the quote calls (see
   * {@link getTradierAccountSpendThisMinute}). Summing double-counts them. */
  accountObservedPeak: number;
  accountObservedMean: number;
  accountBudget: number;
}): {
  crossed: boolean;
  /** Peak demand already meets its derived allowance ⇒ the throttle can only bite. */
  ceilingUnsatisfiable: boolean;
  /** MEAN demand meets the plan ⇒ a genuine CAPACITY condition: no throttle helps. */
  budgetExhausted: boolean;
  /** Mean is under the plan but the peak is over it ⇒ a SMOOTHING problem, which a
   * correctly-windowed limiter is the right tool for. Distinguished from
   * `budgetExhausted` because the two call for opposite remedies. */
  burstBound: boolean;
  headroomReqPerMin: number;
  peakOverBudgetReqPerMin: number;
} {
  const { barCeiling, accountObservedPeak, accountObservedMean, accountBudget } = input;
  // Graded against the BUDGET, never against the resolved ceiling alone: on a
  // default (inert) box the ceiling is Infinity, and a verdict read off it would
  // report `crossed:false` on every box — a gate satisfied by the absence of the
  // thing it grades.
  const ceilingUnsatisfiable = Number.isFinite(barCeiling) && accountObservedPeak >= barCeiling;
  const budgetExhausted = accountObservedMean >= accountBudget;
  const burstBound = !budgetExhausted && accountObservedPeak >= accountBudget;
  return {
    crossed: ceilingUnsatisfiable || budgetExhausted || burstBound,
    ceilingUnsatisfiable,
    budgetExhausted,
    burstBound,
    headroomReqPerMin: accountBudget - accountObservedMean,
    peakOverBudgetReqPerMin: accountObservedPeak - accountBudget,
  };
}

/**
 * TRA-3104 — the account-quota budget block, surfaced on `/api/health/quotes`.
 * Read-only: computing it changes no fetch decision. `enforcing` is the field
 * that says whether the derived ceiling is actually gating anything.
 */
export function getTradierQuotaBudgetState(now: number = Date.now()): {
  accountBudgetReqPerMin: number;
  quoteReservationReqPerMin: number;
  barCeilingReqPerMin: number | null;
  ceilingSource: 'derived_budget' | 'absolute_env' | 'disabled';
  enforcing: boolean;
  enforcementWindow: 'fixed_minute_aligned';
  /** Account-wide spend in the CURRENT (partial) fixed minute — the gate's input. */
  accountThisMinute: number;
  /** Mean / peak account-wide req/min over recent COMPLETED minutes. */
  accountMeanReqPerMin: number;
  accountPeakReqPerMin: number;
  accountMinutesObserved: number;
  /** The quote path's share, a SUBSET of the account figures above — never a term
   * to be added to them. TRA-3104's headline double-counted exactly this. */
  quoteSubsetThisMinute: number;
  quoteSubsetPeakPerFixedMinute: number;
  headroomReqPerMin: number;
  peakOverBudgetReqPerMin: number;
  crossed: boolean;
  ceilingUnsatisfiable: boolean;
  budgetExhausted: boolean;
  burstBound: boolean;
  /** ⚠️ The ceiling bounds only the COLD, deferrable subset — hot / deep-MTF pulls
   * and the whole quote path bypass it while still consuming quota. Published so a
   * consumer cannot read `enforcing:true` as "account spend is bounded". */
  boundsDeferrableSubsetOnly: true;
} {
  const quoteState = getTradierQuoteRateState(now);
  const accountState = getTradierBarPullRateState(now); // account-wide, not bars-only
  const stats = accountMinuteStats(tradierAccountMinuteCounts, now, BAR_PULL_RATE_WINDOW_MS);
  const reservation = quoteReservationReqPerMin({
    structuralFloor: Math.ceil(QUOTE_RATE_WINDOW_MS / Math.max(1, QUOTE_CACHE_TTL_MS)),
    observedPeak: quoteState.peakPerFixedMinute,
  });
  const resolved = resolveBarPullCeiling({
    enforceDerived: TRADIER_QUOTA_ENFORCE_BAR_CEILING,
    accountBudget: TRADIER_ACCOUNT_BUDGET_PER_MIN,
    quoteReservation: reservation,
    absoluteCeiling: TRADIER_BAR_PULL_CEILING,
  });
  // The crossing is a property of the BUDGET, not of whether we are enforcing —
  // so grade it against the ceiling the budget implies, even when inert. Reading
  // it off an `Infinity` ceiling would report `crossed: false` on every default
  // box, i.e. a gate satisfied by the absence of the thing it grades.
  const impliedCeiling = Math.max(1, TRADIER_ACCOUNT_BUDGET_PER_MIN - reservation);
  const verdict = quotaCrossingVerdict({
    barCeiling: impliedCeiling,
    accountObservedPeak: stats.peak,
    accountObservedMean: stats.mean,
    accountBudget: TRADIER_ACCOUNT_BUDGET_PER_MIN,
  });
  return {
    accountBudgetReqPerMin: TRADIER_ACCOUNT_BUDGET_PER_MIN,
    quoteReservationReqPerMin: reservation,
    barCeilingReqPerMin: Number.isFinite(resolved.ceiling) ? resolved.ceiling : null,
    ceilingSource: resolved.source,
    enforcing: resolved.source !== 'disabled',
    enforcementWindow: 'fixed_minute_aligned',
    accountThisMinute: accountState.requestsThisMinute,
    accountMeanReqPerMin: Number(stats.mean.toFixed(1)),
    accountPeakReqPerMin: stats.peak,
    accountMinutesObserved: stats.minutes,
    quoteSubsetThisMinute: quoteState.requestsThisMinute,
    quoteSubsetPeakPerFixedMinute: quoteState.peakPerFixedMinute,
    headroomReqPerMin: Number(verdict.headroomReqPerMin.toFixed(1)),
    peakOverBudgetReqPerMin: verdict.peakOverBudgetReqPerMin,
    crossed: verdict.crossed,
    ceilingUnsatisfiable: verdict.ceilingUnsatisfiable,
    budgetExhausted: verdict.budgetExhausted,
    burstBound: verdict.burstBound,
    boundsDeferrableSubsetOnly: true,
  };
}

/**
 * TRA-2170 — process-global bar-pull ceiling that reserves account-quota headroom
 * for the freshness-critical quote path. Pure so it can be unit-tested like
 * {@link tradierBreakerGate}.
 *
 * SCOPE CAVEAT (read before enabling): this ceiling was proposed as "the real
 * TRA-1996 C4 fix" on the shared-quota-exhaustion theory. That theory was
 * FALSIFIED at the byte level on the 2026-07-22 Render tape (TRA-1996 comment
 * `159816ca`): at all six `stale-state` windows `quotePathOpen` was false, zero
 * `Quota Violation`, zero quote-breaker trips — the C4 dark-feed was quote-
 * freshness STAMP starvation, fixed by `e5f43b4` (decoupled 30s quote refresh,
 * live on bqb1). This ceiling is therefore NOT the C4 remedy.
 *
 * It was then re-targeted (disposition A, 2026-07-24) at the second rationale:
 * doTick-I/O relief for the signal `doTick` wall-clock (900-1489s at 568 symbols).
 * ⚠️ THAT RATIONALE IS ALSO NOW DISCHARGED: TRA-2171 closed `done` on 2026-08-06
 * against its pre-registered bar on the 2026-08-05 RTH tape — `signal.doTick` p90
 * 21.87s vs a 45s bar and max 67.14s vs a 300s ceiling, measured at the CURRENT
 * (larger) universe and with this ceiling INERT. doTick is inside its bound
 * without it.
 *
 * What remains is OPT-IN quota-headroom insurance against a hazard that has not
 * recurred since `e5f43b4`. Both named rationales having been discharged, enabling
 * it is a cost (an env write redeploys bqb1) with no measured benefit — so treat
 * "enable this" as a decision that needs fresh evidence, not as a pending action.
 *
 * Decision:
 *   • disabled (unset / non-positive / non-finite ceiling) → never defer;
 *   • hot / active-interest pulls → never defer (live entry/exit needs fresh bars);
 *   • deep-MTF snapshot pulls (`count >= MTF_DEPTH_THRESHOLD`) → never defer;
 *   • cold pulls → defer only once the process-global bar-pull rate has reached
 *     the ceiling (the caller then serves cached bars instead of hitting Tradier).
 *
 * ⚠️ TRA-3104 — TWO CHANGES TO WHAT THIS GATE READS, both about matching the
 * statistic to the thing Tradier actually enforces.
 *
 * (1) `accountSpendThisMinute` must be a count over the FIXED, minute-ALIGNED
 * window Tradier meters ({@link requestsInFixedWindow}), NOT the rolling
 * `requestsLastMin` telemetry this parameter used to be fed. A sliding count is
 * strictly more conservative than the metered window (the aligned bucket is a
 * subset of the trailing 60s), so the mismatch cannot cause a violation — but it
 * refuses cold pulls while the enforced minute still has headroom, which at a
 * universe where the budget is binding is exactly the wrong error.
 *
 * (2) It is ACCOUNT-WIDE spend (bar pulls + quote calls), not bar pulls alone,
 * because the quota Tradier enforces is account-wide. ⚠️ THIS GATE CANNOT BOUND
 * THAT TOTAL, AND NO WINDOW SHAPE MAKES IT ABLE TO: `isActiveInterest` and
 * `isDeepMtf` pulls return `allowed` BEFORE the ceiling is consulted, and the
 * quote path is never gated at all — yet all three consume quota. So the ceiling
 * bounds only the DEFERRABLE (cold) subset of an unbounded total. Reading
 * "budget - reservation" as an enforceable bound on account spend is wrong; it is
 * a threshold at which we stop adding the one kind of load we are able to stop.
 * That is why item 3 of TRA-3104 (capacity) is upstream of this whole mechanism:
 * a throttle cannot create capacity, and this one cannot even see most of the
 * demand. Counting account-wide spend at least makes the reserve real — quotes
 * keep `quoteReservation` req/min because cold pulls stand down before the total
 * reaches `budget - reservation`.
 */
export function barPullThrottleGate(input: {
  isActiveInterest: boolean;
  isDeepMtf: boolean;
  accountSpendThisMinute: number;
  ceiling: number;
}): { allowed: boolean; reason: string } {
  const { isActiveInterest, isDeepMtf, accountSpendThisMinute, ceiling } = input;
  if (!(Number.isFinite(ceiling) && ceiling > 0)) return { allowed: true, reason: 'ceiling_disabled' };
  if (isActiveInterest) return { allowed: true, reason: 'active_interest' };
  if (isDeepMtf) return { allowed: true, reason: 'deep_mtf' };
  if (accountSpendThisMinute >= ceiling) return { allowed: false, reason: 'cold_deferred_ceiling' };
  return { allowed: true, reason: 'under_ceiling' };
}

/**
 * TRA-3104 — account-wide Tradier spend inside the FIXED minute Tradier meters.
 * This is the statistic {@link barPullThrottleGate} grades and the one
 * `/api/health/quotes` reports as `accountThisMinute`.
 *
 * ⛔⛔ DO NOT ADD THE QUOTE COUNT TO THIS. `tradierBarPullReqTimestamps` is fed
 * from `bumpFallbackCounter('tradier')`, and the QUOTE path calls that too (it
 * calls `bumpFallbackCounter('tradier')` and then `recordTradierQuoteRequest`).
 * So the "bar pull" array is ALREADY the account-wide population — daily bars +
 * minute bars + quote batches — and `tradierQuoteReqTimestamps` is a SUBSET of
 * it, not a sibling series. Summing them double-counts every quote call.
 *
 * 🔴 THIS IS THE SECOND CORRECTION TO TRA-3104's OWN HEADLINE, and it moves the
 * conclusion. The filed finding computed "bar-pull mean 184.0 + quote path 16 =
 * 200 req/min = the account budget, therefore the budget is FULLY CONSUMED IN
 * STEADY STATE". The 184.0 was differenced from `fallbackRequestsToday.tradier`,
 * which is bumped at all three call sites — so it was the account-wide total
 * ALREADY and the quote path was added to a number that contained it. Corrected:
 * steady-state account demand is ~184/min against a ~200/min plan, i.e. roughly
 * 8% headroom, NOT zero. What actually exhausts the quota is the BURST — the
 * rolling tail measured 260 — not the mean.
 *
 * That distinction decides the remedy. "Mean at budget" means only capacity can
 * help and no throttle creates capacity. "Mean under budget, peak over it" is a
 * SMOOTHING problem, which a correctly-windowed limiter is exactly the right tool
 * for. Do not carry the "fully consumed" framing forward.
 */
export function getTradierAccountSpendThisMinute(now: number = Date.now()): number {
  return requestsInFixedWindow(tradierBarPullReqTimestamps, now, BAR_PULL_RATE_WINDOW_MS).count;
}

// ── Per-symbol minute-bar cache ──────────────────────────────────────────────
// fetchMinuteBarsWithSource is called once per active symbol per 30-second
// signal-engine tick. Bars only refresh on the minute boundary, so two ticks
// inside the same minute produce identical work. The cache lets back-to-back
// ticks reuse the most recent successful provider response.

type MinuteBarSource = 'tradier' | 'yahoo' | 'twelvedata' | 'none';
type MinuteBarCacheEntry = {
  bars: Candle[];
  // `'none'` is a negative-cache marker (TRA-439): when the whole cascade
  // misses we record that miss for the rest of the minute so back-to-back
  // ticks don't re-fire the Twelve Data fallback for the same symbol.
  source: MinuteBarSource;
  expiresAt: number;
  // TRA-554: how many bars this cached pull *asked* the upstream for. Minute
  // bars are immutable within their own minute, so re-fetching the same symbol
  // never yields additional history before the minute boundary — the data that
  // exists is the data that exists. We therefore coalesce on the *requested*
  // depth, not the returned length: if we already asked Tradier for ≥ the
  // caller's `count` this minute, reuse the result. The old `bars.length >=
  // count` guard could never be satisfied near the open (fewer than `count`
  // RTH minutes have elapsed) or by the 2,000-bar MTF snapshot pull (a trading
  // day only has ~390 minutes), so those callers refetched Tradier every single
  // tick — the bulk of the RTH bar-request volume TRA-735 measured.
  requestedCount: number;
  // TRA-739: true when cached for a NON-active-interest ("cold") symbol on the
  // long discovery TTL. A cold entry that's reused after the symbol becomes
  // active-interest would serve minutes-stale bars to a live entry/exit
  // decision, so `canReuseCachedTradierBars` forces a refresh in that case.
  cold: boolean;
};
const minuteBarCache = new Map<string, MinuteBarCacheEntry>();

// TRA-739 singleflight: when many engines call fetchMinuteBarsWithSource for
// the same symbol concurrently (e.g. during a cold-scan tick after a restart
// or cache expiry), only ONE upstream Tradier request fires; the rest await
// the same promise. Prevents the "thundering herd" that caused 700+ req/min
// spikes after every Render deploy.
const minuteBarInflight = new Map<string, Promise<MinuteBarCacheEntry>>();

/**
 * TRA-554 — decide whether a cached Tradier minute-bar pull can be reused
 * instead of re-hitting the upstream feed. Pure so it can be unit-tested.
 *
 * Reuse requires all of:
 *   • the entry is still inside its minute (`expiresAt > now`) — bars roll on
 *     the minute boundary, so a cross-minute entry is genuinely stale;
 *   • the entry came from Tradier — Yahoo/Twelve-Data entries are re-tried so a
 *     recovered primary can reclaim the symbol;
 *   • the entry already *requested* at least as many bars as this caller wants.
 *
 * The last clause is the TRA-735 fix. The previous guard compared
 * `entry.bars.length >= count`, which a caller could never satisfy when its
 * `count` exceeds the bars that physically exist this session: the 80-bar
 * candle loop before 80 RTH minutes elapse, or the 2,000-bar MTF snapshot pull
 * (a session has ~390 minutes). Those callers refetched Tradier every tick.
 * Comparing on the *requested* depth instead lets them coalesce — re-fetching
 * within the same minute can't return more history anyway — while a genuinely
 * deeper caller (larger `count` than was last requested) still refetches once
 * and upgrades the cached entry.
 */
export function canReuseCachedTradierBars(
  entry: { source: MinuteBarSource; expiresAt: number; requestedCount: number; cold?: boolean } | undefined,
  count: number,
  now: number,
  symbolActiveInterest = false,
): boolean {
  if (!entry) return false;
  if (!(entry.expiresAt > now && entry.source === 'tradier' && entry.requestedCount >= count)) {
    return false;
  }
  // TRA-739: a long-TTL cold entry must not keep serving a symbol that has
  // since become active-interest — live entry/exit decisions need minute-fresh
  // bars. Force a refresh so the symbol is re-pulled and re-cached on the hot
  // (minute) TTL.
  if (symbolActiveInterest && entry.cold) return false;
  return true;
}

function nextMinuteBoundary(): number {
  const now = Date.now();
  return Math.floor(now / 60_000) * 60_000 + 60_000;
}

// TRA-739: cold (non-active-interest) discovery symbols are cached this long
// instead of just to the next minute boundary. The cold scan that pulls them
// runs on a ~5-min shard cadence, and the TTL is now held just below it
// (TRA-1539) so a cold symbol re-pulls once per shard visit — a few-minute-stale
// bar set introduces no discovery-latency regression while capping the
// PROCESS-GLOBAL Tradier bar-pull rate. The per-minute cache (TRA-552/554)
// already deduped to ~1 pull per symbol per minute, but with ~100 engines each
// cold-scanning + pulling active-interest on unsynchronized phases, the union
// re-covered nearly the whole ~364-symbol watchlist every minute (~265-320
// req/min observed, above the <200 budget). Pulling cold symbols once per ~5 min
// instead drops their contribution to ~watchlist/5 ≈ 73/min, leaving headroom
// for the (smaller) minute-fresh active-interest set.
//
// TRA-739 follow-up: active-interest symbols previously used nextMinuteBoundary()
// as their TTL, which can be just seconds away when a pull lands near a minute
// boundary. With engines ticking every 30s on unsynchronized phases, this caused
// each hot symbol to be re-pulled once per tick (~2x/min) rather than once/min.
// Using `Date.now() + HOT_BAR_CACHE_MS` (a full 60s) instead guarantees at most
// one Tradier pull per symbol per 60s regardless of where the pull falls within
// the minute. Minute bars are still immutable within their minute; a full 60s
// window just guarantees the dedup spans two ticks even when the pull lands at
// minute :58.
// TRA-739: The acceptance criterion is TOTAL (quote+bar) <200/min. Quote cache
// TTL=20s keeps quote rate ~3-5/min (vs ~48/min at 3s). With hot union ~80-100
// symbols and cold ~364 symbols:
//   hot:  served from 7-min MTF cache between MTF cycles --> 0/min
//   MTF burst (every 10 min): ~100 unique symbol fetches / 60s = ~100/min
//   cold: 364 / (COLD_BAR_CACHE_MS/60000) ≈ 364/4 ≈ 73/min (shard-bound to ~5 min)
//   bar total ≈ 173/min  +  quote ~5 = ~178/min  → under the 200 budget.
// 90s hot TTL is safe because minute bars are immutable within their minute;
// a signal engine ticking at 30s only misses a new bar for up to 60s after
// it's appended -- acceptable discovery latency vs 2.5x budget overrun.
//
// TRA-1539: the cold TTL was 10 min ("5-min shard cycle × 2 for safety margin"),
// but that "margin" made cold bars STALER, not safer. The cold-scan shard in the
// signal engine visits each cold symbol every ~5 min (COLD_SCAN_INTERVAL=10 ×
// 30s tick), yet a 10-min TTL let `canReuseCachedTradierBars` serve the cached
// entry on the intervening shard visit — so a cold symbol's cached minute bars
// only actually ADVANCED every ~10 min. Combined with the ~1-2 min lag of the
// newest completed bar, a cold symbol's freshest cached bar routinely aged to
// ~660-720s, brushing/crossing the equity feed-freshness gate
// (MAX_CANDLE_AGE_MS = 720s in feed-freshness.ts). On a quiet tape the whole
// tradable universe was cold at once (no open position / recent signal → nothing
// marked active-interest), so their refresh windows drifted into alignment and
// the risk-autopilot's "no active symbol is fresh" governor tripped a feed_stale
// halt — silently skipping every equity/options entry until the next real pull.
// (The deeper >900s spikes that tipped the whole set over at once were tick GAPS
// from event-loop starvation — owned separately by TRA-1463/TRA-1508 — not a
// provider outage: zero Tradier/Yahoo/Twelve-Data breaker trips in the incident
// window.) Fix: hold the cold TTL BELOW the ~5-min shard cadence so every shard
// visit forces a fresh upstream pull and the cache advances every ~5 min. Max
// cold bar age is then ~shard cadence (300s) + newest-bar lag (~120s) + tick
// jitter ≈ 450s — a ~270s margin under the 720s gate. Cold volume rises from
// ~36/min to ~73/min, still under the <200/min budget (see math above).
const HOT_BAR_CACHE_MS = 90_000;
const COLD_BAR_CACHE_MS = 4 * 60_000;
// TRA-739: the MTF technical snapshot fires every 5 min and requests count=2000
// bars. Those pulls miss the 90s hot cache (expired long before the next 5-min
// cycle) and re-hit Tradier for all active-interest symbols every 5 min, causing
// another 100+ req/min burst. Cache deep pulls (count > 400) for 7 min so the
// 5-min refresh always finds a live entry (even cycle = HIT). The miss cycle only
// fires every 10 min (after the 7-min TTL lapses), halving the burst frequency.
// The signal-engine candle loop uses count=80; the 7-min entry satisfies it too
// (requestedCount=2000 >= 80), so hot symbols see 0 Tradier requests between bursts.
const MTF_BAR_CACHE_MS = 7 * 60_000;
const MTF_DEPTH_THRESHOLD = 400;

function barCacheExpiry(symbol: string, count: number): number {
  if (count >= MTF_DEPTH_THRESHOLD) return Date.now() + MTF_BAR_CACHE_MS;
  return Date.now() + (isActiveInterest(symbol) ? HOT_BAR_CACHE_MS : COLD_BAR_CACHE_MS);
}

// ── Twelve Data fallback for stock minute bars ───────────────────────────────
// Twelve Data gives consolidated 1-minute bars on the free tier (800 req/day,
// 8 req/min). Budget is too tight for the full watchlist, so this branch only
// fires for "active interest" symbols — those with open positions or recent
// signals.

const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY ?? '';
const TWELVE_DATA_BASE = 'https://api.twelvedata.com';

if (!TWELVE_DATA_API_KEY) {
  console.warn('[yahoo-feed] TWELVE_DATA_API_KEY is not set — Twelve Data minute-bar fallback disabled');
}

// ── Twelve Data quota guard (TRA-439) ────────────────────────────────────────
// Twelve Data's free tier is 800 requests/day. Before TRA-439 the minute-bar
// fallback had no breaker and no daily cap: whenever Tradier timesales returned
// no bars and Yahoo's breaker was open, every active-interest symbol re-fired a
// Twelve Data request on every 30-second tick — which burned ~27.7k calls/day
// against the 800 limit (the TRA-436 regression). Two guards now bound this:
//
//   • Daily budget cap — once `TWELVE_DATA_DAILY_BUDGET` requests have been
//     spent in the current UTC day, the fallback is skipped until the
//     UTC-midnight counter rollover. Default 700 leaves headroom under 800 for
//     the per-day health-check probe.
//   • Circuit breaker — a credit/rate-limit error opens the breaker until the
//     next UTC midnight (Twelve Data's free-tier credits reset daily), so a
//     single "out of credits" response stops all further calls for the day
//     instead of retrying every tick.

const TWELVE_DATA_DAILY_BUDGET = (() => {
  const raw = Number(process.env.TWELVE_DATA_DAILY_BUDGET);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 700;
})();

let twelveDataBlockedUntil = 0;
function isTwelveDataBlocked(): boolean {
  return Date.now() < twelveDataBlockedUntil;
}

/** Epoch-ms of the next UTC midnight — when Twelve Data's daily credits reset. */
function nextUtcMidnight(): number {
  const d = new Date();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1, 0, 0, 0, 0);
}

function tripTwelveDataBreaker(reason: string): void {
  twelveDataBlockedUntil = nextUtcMidnight();
  console.warn(`[yahoo-feed] Twelve Data breaker tripped until next UTC midnight after ${reason}`);
}

export type TwelveDataGateReason = 'ok' | 'no_key' | 'not_active_interest' | 'breaker_open' | 'quota_exhausted';

/**
 * Pure decision function for whether a Twelve Data fallback request may fire.
 * Extracted so the quota / breaker logic is unit-testable without a live feed
 * or module-level env state (TRA-439).
 */
export function evaluateTwelveDataGate(input: {
  hasApiKey: boolean;
  isActiveInterest: boolean;
  breakerOpenUntil: number;
  callsToday: number;
  dailyBudget: number;
  now: number;
}): { allowed: boolean; reason: TwelveDataGateReason } {
  if (!input.hasApiKey) return { allowed: false, reason: 'no_key' };
  if (!input.isActiveInterest) return { allowed: false, reason: 'not_active_interest' };
  if (input.now < input.breakerOpenUntil) return { allowed: false, reason: 'breaker_open' };
  if (input.callsToday >= input.dailyBudget) return { allowed: false, reason: 'quota_exhausted' };
  return { allowed: true, reason: 'ok' };
}

/**
 * Current Twelve Data quota / breaker state — surfaced by `/api/health/quotes`
 * so QA can see how much of the daily budget is spent and whether the breaker
 * is open (TRA-439).
 */
export function getTwelveDataQuotaState(): {
  dailyBudget: number;
  callsToday: number;
  remaining: number;
  breakerOpen: boolean;
  breakerOpenUntil: string | null;
} {
  rollFallbackCountersIfNeeded();
  const used = fallbackCounters.twelveData;
  return {
    dailyBudget: TWELVE_DATA_DAILY_BUDGET,
    callsToday: used,
    remaining: Math.max(0, TWELVE_DATA_DAILY_BUDGET - used),
    breakerOpen: isTwelveDataBlocked(),
    breakerOpenUntil: twelveDataBlockedUntil > Date.now() ? new Date(twelveDataBlockedUntil).toISOString() : null,
  };
}

interface TwelveDataValue {
  datetime?: string;
  open?: string;
  high?: string;
  low?: string;
  close?: string;
  volume?: string;
}
interface TwelveDataResponse {
  values?: TwelveDataValue[];
  status?: string;
  code?: number;
  message?: string;
}

export interface TwelveDataCandleDiag {
  reason:
    | 'no_key'
    | 'not_active_interest'
    | 'breaker_open'
    | 'quota_exhausted'
    | 'http_error'
    | 'no_data'
    | 'parse_error'
    | 'fetch_error'
    | 'rate_limited'
    | 'ok';
  httpStatus?: number;
  rawLen?: number;
  filteredLen?: number;
  errorBody?: string;
  errorMsg?: string;
}

function parseTwelveDataTs(s: string): number {
  const norm = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const ms = new Date(norm).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

async function fetchTwelveDataMinuteBars(
  symbol: string,
  count: number,
  isActive: boolean,
): Promise<{ bars: Candle[]; diag: TwelveDataCandleDiag }> {
  const gate = evaluateTwelveDataGate({
    hasApiKey: TWELVE_DATA_API_KEY.length > 0,
    isActiveInterest: isActive,
    breakerOpenUntil: twelveDataBlockedUntil,
    callsToday: getFallbackRequestCounts().twelveData,
    dailyBudget: TWELVE_DATA_DAILY_BUDGET,
    now: Date.now(),
  });
  if (!gate.allowed) return { bars: [], diag: { reason: gate.reason } };
  const outputsize = Math.min(Math.max(count * 2, 30), 500);
  try {
    bumpFallbackCounter('twelveData');
    const url = `${TWELVE_DATA_BASE}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1min&outputsize=${outputsize}&apikey=${TWELVE_DATA_API_KEY}`;
    const resp = await withTimeout(fetch(url), YF_CALL_TIMEOUT_MS, `twelvedata candle(${symbol})`);
    if (!resp.ok) {
      const errorBody = await resp.text().catch(() => '');
      console.warn(`[yahoo-feed] twelvedata candle(${symbol}) HTTP ${resp.status}: ${errorBody.slice(0, 200)}`);
      if (resp.status === 429) {
        // Out of credits / rate-limited — stop calling Twelve Data for the day.
        tripTwelveDataBreaker(`HTTP 429 on candle(${symbol})`);
        return { bars: [], diag: { reason: 'rate_limited', httpStatus: resp.status, errorBody: errorBody.slice(0, 200) } };
      }
      return { bars: [], diag: { reason: 'http_error', httpStatus: resp.status, errorBody: errorBody.slice(0, 200) } };
    }
    const json = (await resp.json()) as TwelveDataResponse;
    if (json && json.status === 'error') {
      const msg = json.message ?? 'unknown error';
      const code = json.code ?? 0;
      if (code === 429 || /\b(rate|limit|credits|daily)\b/i.test(msg)) {
        // Twelve Data returns 200 OK with a JSON error body when the daily
        // credit budget is exhausted; open the breaker so we stop here.
        tripTwelveDataBreaker(`credit/rate-limit response on candle(${symbol}): ${msg.slice(0, 80)}`);
        return { bars: [], diag: { reason: 'rate_limited', httpStatus: resp.status, errorBody: msg.slice(0, 200) } };
      }
      return { bars: [], diag: { reason: 'http_error', httpStatus: resp.status, errorBody: msg.slice(0, 200) } };
    }
    if (!json || !Array.isArray(json.values)) {
      return { bars: [], diag: { reason: 'parse_error', httpStatus: resp.status, errorBody: JSON.stringify(json ?? {}).slice(0, 200) } };
    }
    const currentMinuteStart = Math.floor(Date.now() / 60_000) * 60_000;
    const candles: Candle[] = [];
    for (const row of json.values) {
      if (!row.datetime) continue;
      const ts = parseTwelveDataTs(row.datetime);
      if (!Number.isFinite(ts)) continue;
      if (ts >= currentMinuteStart) continue;
      const o = row.open != null ? Number(row.open) : NaN;
      const h = row.high != null ? Number(row.high) : NaN;
      const l = row.low != null ? Number(row.low) : NaN;
      const c = row.close != null ? Number(row.close) : NaN;
      const v = row.volume != null ? Number(row.volume) : 0;
      if (!Number.isFinite(o) || !Number.isFinite(h) || !Number.isFinite(l) || !Number.isFinite(c)) continue;
      candles.push({ symbol, timestamp: ts, open: o, high: h, low: l, close: c, volume: Number.isFinite(v) ? v : 0 });
    }
    candles.sort((a, b) => a.timestamp - b.timestamp);
    const sliced = candles.slice(-count);
    return {
      bars: sliced,
      diag: { reason: sliced.length > 0 ? 'ok' : 'no_data', httpStatus: resp.status, rawLen: json.values.length, filteredLen: sliced.length },
    };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[yahoo-feed] twelvedata candle(${symbol}) error: ${msg}`);
    return { bars: [], diag: { reason: 'fetch_error', errorMsg: msg } };
  }
}

/**
 * Fetch the last N 1-minute candles for a symbol.
 *
 * Ordered failover (TRA-418) — `tradier → yahoo → twelvedata` (see
 * `EQUITY_CANDLE_FAILOVER_ORDER` in `feed-freshness.ts`). Tradier timesales is
 * the primary source; when its breaker is open or it returns no usable bars we
 * cascade through Yahoo charts and then Twelve Data. Stooq is intentionally
 * not in the chart fallback chain — it's EOD-ish and would corrupt indicator
 * math built off intraday minute bars.
 */
export async function fetchMinuteBars(symbol: string, count = 60): Promise<Candle[]> {
  const { bars } = await fetchMinuteBarsWithSource(symbol, count);
  return bars;
}

// ── TRA-3068 — THE SPLIT CALENDAR (parent TRA-3065) ───────────────────────────
//
// Both deployed plausibility rules are INTERNAL-CONSISTENCY tests, and an
// unadjusted corporate action is internally consistent, so neither can reach it
// at any threshold — measured on TRA-3065, 128-row evasion grid. The ex-date is
// the only input that distinguishes a 3:2 split from a genuine -33% session, and
// it has to come from outside the row.
//
// It costs one query-string option. `yf.chart` is the v8 `/finance/chart` route
// this module already calls per symbol in three places, and it returns
// `events.splits` when asked for them — verified directly against NVDA's 10:1:
//
//   events.splits[0] = { date: 1718026200, numerator: 10, denominator: 1,
//                        splitRatio: "10:1" }   // ex-date 2024-06-10
//
// So: NO new provider, NO API key, NO extra HTTP call, and nothing here ever
// blocks a quote — the harvest is a side effect of a response we already parsed,
// and a symbol whose chart we never fetched simply has no calendar entry and is
// graded exactly as it was before this ticket.
//
// ⛔ THIS IS A CACHE, NOT A RECORD. Coverage is opportunistic by construction:
// the Tradier-primary paths only fall through to `yf.chart` when Tradier returns
// nothing, so on a healthy Tradier day most symbols are never harvested here.
// {@link fetchRecentSplits} is the explicit path for a caller that needs an
// answer for a specific symbol rather than whatever happens to be warm.

/** Per-symbol split calendar, harvested from any chart response that carried events. */
const splitCalendar = new Map<string, CorporateAction[]>();

/**
 * Cap on symbols held. This process has been OOM-killed by an unbounded
 * per-symbol cache before (TRA-937's `chainCache`), and the scanner universe is
 * open-ended, so the bound is stated rather than assumed. Eviction is
 * insertion-order (oldest harvested symbol first) — a symbol we stopped fetching
 * charts for is also a symbol nothing is about to grade.
 */
const SPLIT_CALENDAR_MAX_SYMBOLS = 2_000;

/**
 * How far back a harvested split is kept. Only the EX-DATE SESSION's own row has
 * a `prevClose` that straddles the action, so anything older than a couple of
 * weeks can no longer change a verdict — it would only grow the map.
 */
const SPLIT_RETENTION_DAYS = 21;

/** ET calendar date of an epoch-ms instant, `YYYY-MM-DD`. Matches `etDateKey`. */
function etDay(ms: number): string {
  return new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
}

/**
 * Harvest `events.splits` off a chart response into {@link splitCalendar}.
 *
 * Defensive to the point of paranoia about the payload shape, on purpose: this
 * runs inside the quote hot path, `validation: { logErrors: true }` means a
 * schema drift LOGS rather than throws, and a split calendar that can throw
 * would take out the quote it was supposed to annotate. Anything unrecognised is
 * dropped silently — the failure mode is "no calendar entry", i.e. exactly the
 * pre-TRA-3068 behaviour, never a bad one.
 */
function recordChartSplits(symbol: string, result: unknown): void {
  const events = (result as { events?: { splits?: unknown } } | null | undefined)?.events;
  const raw = events?.splits;
  // v3 returns an array for `return: 'array'` (our default) and a
  // timestamp-keyed object for `return: 'object'`. Accept both.
  const list: unknown[] = Array.isArray(raw)
    ? raw
    : (raw && typeof raw === 'object' ? Object.values(raw as Record<string, unknown>) : []);
  if (list.length === 0) return;

  const cutoff = etDay(Date.now() - SPLIT_RETENTION_DAYS * 86_400_000);
  const parsed: CorporateAction[] = [];
  for (const s of list) {
    if (!s || typeof s !== 'object') continue;
    const { date, numerator, denominator, splitRatio } = s as {
      date?: unknown; numerator?: unknown; denominator?: unknown; splitRatio?: unknown;
    };
    // `date` is a Date after validation and unix SECONDS when validation is
    // bypassed — the same duality `toIsoTime` above exists for.
    let ms: number | null = null;
    if (date instanceof Date) ms = date.getTime();
    else if (typeof date === 'number' && Number.isFinite(date)) ms = date * 1000;
    if (ms === null || !Number.isFinite(ms) || ms <= 0) continue;
    if (typeof numerator !== 'number' || typeof denominator !== 'number') continue;

    const exDate = etDay(ms);
    if (exDate < cutoff) continue;
    parsed.push({
      exDate,
      numerator,
      denominator,
      ...(typeof splitRatio === 'string' ? { splitRatio } : {}),
    });
  }
  if (parsed.length === 0) return;

  const key = symbol.toUpperCase();
  // Re-insert so the eviction order tracks last-harvest, not first-sight.
  splitCalendar.delete(key);
  splitCalendar.set(key, parsed);
  while (splitCalendar.size > SPLIT_CALENDAR_MAX_SYMBOLS) {
    const oldest = splitCalendar.keys().next();
    if (oldest.done) break;
    splitCalendar.delete(oldest.value);
  }
}

/** Every split known for `symbol` inside the retention window. Never `null`. */
export function knownSplits(symbol: string): readonly CorporateAction[] {
  return splitCalendar.get(symbol.toUpperCase()) ?? [];
}

/**
 * The split, if any, whose ex-date lands in `(priorSessionDate, currentSessionDate]`
 * — the window over which the row's published `changePct` is not a session move.
 *
 * Pass `null` for `priorSessionDate` on the LIVE quote path. The window then
 * collapses to `exDate === currentSessionDate`, which for a live quote is not an
 * approximation but the exact answer: the quote's `prevClose` is the immediately
 * preceding trading session's close, splits only ex-date on trading days, so the
 * ONE ex-date that can straddle it is the current session's own.
 */
export function knownSplitForSession(
  symbol: string,
  priorSessionDate: string | null | undefined,
  currentSessionDate: string,
): CorporateAction | null {
  return corporateActionInSessionWindow(knownSplits(symbol), priorSessionDate, currentSessionDate);
}

/**
 * Explicitly refresh `symbol`'s split calendar, then answer the same question
 * {@link knownSplitForSession} does.
 *
 * For the callers that need an ANSWER rather than whatever the hot path happened
 * to warm — today that is the EOD report, which runs once per session over a
 * handful of ranking candidates and is the exact surface where a fabricated
 * headline gets published as the session summary. One `1d` chart call over a
 * month-wide window; it honours the shared Yahoo breaker via `withRetry` and
 * returns `null` on any failure, so a dark Yahoo degrades to the pre-TRA-3068
 * behaviour rather than blocking the report.
 */
export async function fetchRecentSplits(symbol: string): Promise<readonly CorporateAction[]> {
  const now = new Date();
  const from = new Date(now.getTime() - SPLIT_RETENTION_DAYS * 2 * 86_400_000);
  const result = await withRetry(
    () => yf.chart(symbol, { period1: from, period2: now, interval: '1d', events: 'div|split' }),
    `splitCalendar(${symbol})`,
  );
  if (result) recordChartSplits(symbol, result);
  return knownSplits(symbol);
}

/** Test seam: drop the harvested calendar. */
export function __resetSplitCalendarForTests(): void {
  splitCalendar.clear();
}

/**
 * Test seam for {@link recordChartSplits}. Exported because the parser is the
 * one part of this leg that faces a payload we do not control, and the failure
 * mode it must never have — a throw on the quote hot path — is unreachable
 * through the network-bound functions above.
 */
export const __recordChartSplitsForTests = recordChartSplits;

/**
 * TRA-386 — fetch the last N *daily* candles for a symbol via Yahoo's chart
 * endpoint. Used by the automated market-review generator to read index-level
 * series (`^GSPC`, `^VIX`, `^TNX`) that the intraday minute-bar path does not
 * cover. Yahoo is the only provider queried here — Tradier's timesales feed is
 * intraday-only and these index symbols are not in the Twelve Data budget set.
 *
 * Returns an empty array on any failure; callers must tolerate a cold feed.
 */
export async function fetchDailyCandles(symbol: string, count = 30): Promise<Candle[]> {
  const now = new Date();
  // Pull a generous calendar window so weekends/holidays still leave `count`
  // trading sessions: ~1.6 calendar days per trading day, plus a week of slack.
  const from = new Date(now.getTime() - (count * 1.6 + 7) * 24 * 60 * 60 * 1000);
  const result = await withRetry(
    // TRA-3068 — `events` is the whole cost of the split calendar. Same route,
    // same round trip, one extra query-string key.
    () => yf.chart(symbol, { period1: from, period2: now, interval: '1d', events: 'div|split' }),
    `dailyChart(${symbol})`,
  );
  if (!result) return [];
  recordChartSplits(symbol, result);
  const candles: Candle[] = (result.quotes ?? [])
    .filter(q => q.open != null && q.high != null && q.low != null && q.close != null)
    .map(q => ({
      symbol,
      timestamp: new Date(q.date).getTime(),
      open: q.open!,
      high: q.high!,
      low: q.low!,
      close: q.close!,
      volume: q.volume ?? 0,
    }))
    .sort((a, b) => a.timestamp - b.timestamp);
  return candles.slice(-count);
}

/**
 * TRA-1207 — short-interest / float / market-cap fundamentals for the
 * short-squeeze screener. Yahoo's `quoteSummary` carries the short-interest set
 * (`defaultKeyStatistics`) and the size/liquidity fields (`summaryDetail` /
 * `price`) that the quote and bar feeds do not expose. Borrow-fee rate is NOT
 * available from Yahoo (no free feed carries it) and is intentionally omitted —
 * the screener treats that criterion as not-applicable unless a paid provider
 * is wired in later.
 */
export interface ShortInterestFundamentals {
  symbol: string;
  /** Fraction of float sold short (0.24 = 24%). */
  shortPercentOfFloat: number | null;
  /** Shares sold short (absolute count). */
  sharesShort: number | null;
  /** Days-to-cover (Yahoo `shortRatio`). */
  daysToCover: number | null;
  /** Free-float share count. */
  floatShares: number | null;
  /** Shares outstanding. */
  sharesOutstanding: number | null;
  /** Market cap in dollars. */
  marketCap: number | null;
  /** 10-day (fallback: general) average daily volume, for RVOL context. */
  averageDailyVolume: number | null;
  /**
   * FINRA settlement / as-of date of the short-interest datum (epoch ms), from
   * Yahoo `dateShortInterest`. Short interest is exchange-reported bi-monthly and
   * lags by ~1–2 weeks, so a forward squeeze move must NOT be graded against a
   * short-int reading that post-dates the entry. Null when Yahoo omits it.
   */
  shortInterestAsOf: number | null;
  /** Epoch ms the snapshot was taken. */
  asOf: number;
}

type QuoteSummaryModule = Record<string, unknown> | null | undefined;
type QuoteSummaryLike = {
  defaultKeyStatistics?: QuoteSummaryModule;
  summaryDetail?: QuoteSummaryModule;
  price?: QuoteSummaryModule;
} | null | undefined;

/** Read a numeric field, tolerating yahoo-finance2's `{ raw: number }` shape. */
function qsNum(mod: QuoteSummaryModule, key: string): number | null {
  if (!mod) return null;
  const v = mod[key];
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (v && typeof v === 'object' && 'raw' in v) {
    const raw = (v as { raw?: unknown }).raw;
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  return null;
}

/**
 * Pure parse of a Yahoo `quoteSummary` payload into {@link ShortInterestFundamentals}.
 * Exported so the mapping is unit-testable without a live Yahoo call. Every
 * field degrades to `null` when absent so the screener can mark it unknown.
 */
export function parseShortInterestFundamentals(
  symbol: string,
  qs: QuoteSummaryLike,
  asOf: number,
): ShortInterestFundamentals {
  const dks = qs?.defaultKeyStatistics ?? null;
  const sd = qs?.summaryDetail ?? null;
  const price = qs?.price ?? null;
  return {
    symbol,
    shortPercentOfFloat: qsNum(dks, 'shortPercentOfFloat'),
    sharesShort: qsNum(dks, 'sharesShort'),
    daysToCover: qsNum(dks, 'shortRatio'),
    floatShares: qsNum(dks, 'floatShares'),
    sharesOutstanding: qsNum(dks, 'sharesOutstanding') ?? qsNum(dks, 'impliedSharesOutstanding'),
    marketCap: qsNum(sd, 'marketCap') ?? qsNum(price, 'marketCap'),
    averageDailyVolume:
      qsNum(sd, 'averageDailyVolume10Day') ??
      qsNum(sd, 'averageVolume10days') ??
      qsNum(sd, 'averageVolume'),
    // `dateShortInterest` is a Yahoo epoch-SECONDS timestamp — normalize to ms so
    // it is directly comparable to the capture `scanTs`.
    shortInterestAsOf: (() => {
      const secs = qsNum(dks, 'dateShortInterest');
      return secs != null ? secs * 1000 : null;
    })(),
    asOf,
  };
}

/**
 * Fetch short-interest fundamentals for one symbol via Yahoo `quoteSummary`.
 * Honors the same 429 breaker + timeout + retry as the other Yahoo calls and
 * returns `null` on any failure so callers tolerate a cold feed.
 */
export async function fetchShortInterestFundamentals(
  symbol: string,
): Promise<ShortInterestFundamentals | null> {
  const result = await withRetry(
    () => yf.quoteSummary(symbol, { modules: ['defaultKeyStatistics', 'summaryDetail', 'price'] }),
    `quoteSummary(${symbol})`,
  );
  if (!result) return null;
  return parseShortInterestFundamentals(symbol, result as QuoteSummaryLike, Date.now());
}

/**
 * TRA-586 — fetch daily candles via the Tradier `/markets/history` feed.
 *
 * `fetchDailyCandles` above is Yahoo-only, so when Yahoo's chart breaker is open
 * (429 on Render's shared egress) the market-review regime read goes dark and
 * defaults to a cautious YELLOW. This routes the same trend-MA read through the
 * Tradier account that already powers `/api/health/quotes`, using `SPY` as the
 * S&P 500 proxy (Tradier serves listed ETFs, not the `^GSPC` cash index).
 *
 * Honors the shared Tradier circuit breaker and returns `[]` when Tradier is
 * unconfigured, blocked, or errors so callers tolerate a cold feed.
 */
export async function fetchTradierDailyCandles(symbol: string, count = 30): Promise<Candle[]> {
  if (!tradierStocksClient || isTradierBlocked()) return [];
  try {
    bumpFallbackCounter('tradier');
    return await tradierStocksClient.getDailyBars(symbol, count);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldTripTradierBreaker(msg)) tripTradierBreaker(`history(${symbol})`, msg, 'bar');
    else console.warn(`[yahoo-feed] tradier history(${symbol}) error: ${msg}`);
    return [];
  }
}

export interface TradierCandleDiag {
  reason: 'no_credentials' | 'breaker_open' | 'http_error' | 'no_data' | 'fetch_error' | 'ok';
  httpStatus?: number;
  rawLen?: number;
  filteredLen?: number;
  errorMsg?: string;
}

async function fetchTradierMinuteBars(
  symbol: string,
  count: number,
): Promise<{ bars: Candle[]; diag: TradierCandleDiag }> {
  if (!tradierStocksClient) return { bars: [], diag: { reason: 'no_credentials' } };
  if (isTradierBlocked()) return { bars: [], diag: { reason: 'breaker_open' } };
  try {
    bumpFallbackCounter('tradier');
    const bars = await tradierStocksClient.getMinuteBars(symbol, count);
    return { bars, diag: { reason: bars.length > 0 ? 'ok' : 'no_data', filteredLen: bars.length } };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (shouldTripTradierBreaker(msg)) tripTradierBreaker(`timesales(${symbol})`, msg, 'bar');
    return { bars: [], diag: { reason: 'fetch_error', errorMsg: msg } };
  }
}

/**
 * Diagnostic variant of {@link fetchMinuteBars} that also reports which provider
 * served the bars. Used by `/api/health/quotes` so QA can verify the fallback
 * chain is engaging when Tradier or Yahoo's breaker is open.
 */
export async function fetchMinuteBarsWithSource(
  symbol: string,
  count = 60,
): Promise<{
  bars: Candle[];
  source: MinuteBarSource;
  yahooSkipped: boolean;
  cached?: boolean;
  // TRA-2170: true when the bar-pull ceiling deferred a cold pull and we served
  // cached (possibly expired) bars instead of hitting Tradier.
  coldDeferred?: boolean;
  tradierDiag?: TradierCandleDiag;
  twelveDataDiag?: TwelveDataCandleDiag;
}> {
  const yahooSkipped = isRateLimited();

  // TRA-552 — minute bars are immutable within their own minute, but the signal
  // engine ticks every 30s (≈2 ticks/min) and pulls bars per symbol from two
  // call sites (the analysis loop + the MTF snapshot refresh). Re-hitting Tradier
  // each time doubles-plus the minute-bar request volume — the bulk of the ~168k
  // daily Tradier counter. If this minute already has a successful Tradier pull
  // with at least as many bars as requested, reuse it and skip the upstream call.
  // Guarded to `source === 'tradier'` (Yahoo/Twelve-Data entries are still
  // re-tried so a recovered primary can take over) and to `requestedCount >=
  // count` (TRA-554): reuse when this minute already asked Tradier for at least
  // as many bars as the caller wants. A deeper caller (e.g. the 2,000-bar MTF
  // pull behind an 80-bar candle-loop entry) still refetches once and upgrades
  // the cache, but a same-or-shallower caller never short-changes itself, and —
  // crucially — a caller whose `count` can't physically be filled this session
  // (80 bars before 80 RTH minutes have elapsed; 2,000 bars ever) coalesces
  // instead of hammering Tradier every tick.
  const fresh = minuteBarCache.get(symbol);
  if (fresh && canReuseCachedTradierBars(fresh, count, Date.now(), isActiveInterest(symbol))) {
    return { bars: fresh.bars.slice(-count), source: 'tradier', yahooSkipped, cached: true };
  }

  // TRA-2170 — process-global bar-pull ceiling (opt-in; DISABLED by default).
  // Before joining the singleflight / hitting Tradier, defer a COLD pull once the
  // reserved bar-pull ceiling is reached and serve cached (even expired) bars
  // instead, preserving account-quota headroom for the freshness-critical quote
  // path. Hot/active-interest and deep-MTF pulls are never deferred; a never-seen
  // symbol (no cached bars) falls through and still pulls.
  //
  // TRA-3104 — the ceiling is now RESOLVED (derived budget > legacy absolute knob
  // > disabled) and graded against the FIXED minute-aligned count Tradier meters,
  // not the rolling telemetry. Both are still `disabled` on every box today.
  const throttle = barPullThrottleGate({
    isActiveInterest: isActiveInterest(symbol),
    isDeepMtf: count >= MTF_DEPTH_THRESHOLD,
    accountSpendThisMinute: getTradierAccountSpendThisMinute(),
    ceiling: resolveBarPullCeiling({
      enforceDerived: TRADIER_QUOTA_ENFORCE_BAR_CEILING,
      accountBudget: TRADIER_ACCOUNT_BUDGET_PER_MIN,
      quoteReservation: quoteReservationReqPerMin({
        structuralFloor: Math.ceil(QUOTE_RATE_WINDOW_MS / Math.max(1, QUOTE_CACHE_TTL_MS)),
        observedPeak: getTradierQuoteRateState().peakPerFixedMinute,
      }),
      absoluteCeiling: TRADIER_BAR_PULL_CEILING,
    }).ceiling,
  });
  if (!throttle.allowed) {
    const stale = minuteBarCache.get(symbol);
    if (stale && stale.bars.length > 0) {
      return { bars: stale.bars.slice(-count), source: stale.source, yahooSkipped, cached: true, coldDeferred: true };
    }
    // never-seen symbol: nothing to serve — fall through and pull.
  }

  // TRA-739 singleflight: tier the key by depth so std (count<MTF_DEPTH_THRESHOLD)
  // and deep (count>=MTF_DEPTH_THRESHOLD) callers don't compete for the same slot.
  // Without this, the hot scan (count=80) in-flight at T=0 steals the slot from the
  // MTF (count=2000): MTF waits, gets 80-bar result, cache stays count=80, and the
  // T+5min MTF cycle misses again (80 < 2000) causing a sustained burst every cycle.
  // With separate keys, both std and deep fire independently at T=0. The deep entry
  // (count=2000, 7-min TTL) satisfies the hot scan (2000 >= 80), so subsequent hot
  // scans serve from cache. The next deep hit is at T+5min (cache valid), miss at
  // T+10min (expired at T+7min), effectively halving the deep burst frequency.
  const inflightKey = count >= MTF_DEPTH_THRESHOLD ? `${symbol}:deep` : symbol;
  const existingInflight = minuteBarInflight.get(inflightKey);
  if (existingInflight) {
    const entry = await existingInflight;
    return { bars: entry.bars.slice(-count), source: entry.source, yahooSkipped, cached: true };
  }

  const fetchPromise: Promise<MinuteBarCacheEntry> = (async () => {
    // Primary: Tradier intraday timesales.
    const tradier = await fetchTradierMinuteBars(symbol, count);
    if (tradier.bars.length > 0) {
      const entry: MinuteBarCacheEntry = { bars: tradier.bars, source: 'tradier', expiresAt: barCacheExpiry(symbol, count), requestedCount: count, cold: !isActiveInterest(symbol) };
      // Guard: don't overwrite a deeper cached entry with a shallower one.
      // At T+7min, both std (count=80) and deep (count=2000) may fire concurrently.
      // If deep completes first, std must not replace its richer entry.
      const existing = minuteBarCache.get(symbol);
      if (!existing || entry.requestedCount >= existing.requestedCount) {
        minuteBarCache.set(symbol, entry);
      }
      return entry;
    }

    const now = new Date();
    const from = new Date(now.getTime() - count * 60 * 1000 * 2);
    const currentMinuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

    // Fallback 1: Yahoo Finance.
    const result = await withRetry(
      // TRA-3068 — see the split-calendar section. One query-string key on a
      // request we already make; the harvest below never gates the bars.
      () => yf.chart(symbol, { period1: from, period2: now, interval: '1m', events: 'div|split' }),
      `chart(${symbol})`,
    );
    if (result) recordChartSplits(symbol, result);
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

    if (yahooBars.length > 0) {
      const entry: MinuteBarCacheEntry = { bars: yahooBars, source: 'yahoo', expiresAt: nextMinuteBoundary(), requestedCount: count, cold: false };
      minuteBarCache.set(symbol, entry);
      return entry;
    }

    // Reuse a recent fallback response within the same TTL rather than re-firing.
    const cached = minuteBarCache.get(symbol);
    if (cached && cached.expiresAt > Date.now() && cached.source !== 'yahoo') {
      return cached;
    }

    // Fallback 2: Twelve Data (gated to active-interest symbols to fit free-tier 800/day cap).
    const twelveData = await fetchTwelveDataMinuteBars(symbol, count, isActiveInterest(symbol));
    if (twelveData.bars.length > 0) {
      console.info(`[yahoo-feed] chart(${symbol}): served ${twelveData.bars.length} bars from Twelve Data fallback`);
      const entry: MinuteBarCacheEntry = { bars: twelveData.bars, source: 'twelvedata', expiresAt: nextMinuteBoundary(), requestedCount: count, cold: false };
      minuteBarCache.set(symbol, entry);
      return entry;
    }

    // Negative-cache the miss so a back-to-back tick in the same minute does not
    // re-run the Twelve Data fallback (TRA-439). Bars only roll on the minute
    // boundary, so a miss now is a miss until the next boundary.
    const emptyEntry: MinuteBarCacheEntry = { bars: [], source: 'none', expiresAt: nextMinuteBoundary(), requestedCount: count, cold: false };
    minuteBarCache.set(symbol, emptyEntry);
    return emptyEntry;
  })();

  minuteBarInflight.set(inflightKey, fetchPromise);
  try {
    const entry = await fetchPromise;
    return { bars: entry.bars.slice(-count), source: entry.source, yahooSkipped };
  } finally {
    minuteBarInflight.delete(inflightKey);
  }
}

type QuoteResult = {
  price: number;
  volume: number;
  change: number;
  changePct: number;
  /**
   * TRA-1980 — L1 book, present only on the Tradier quote path (the Yahoo / chart
   * / Stooq fallbacks carry no book). Feeds the SHADOW-first pre-trade liquidity
   * gate; every consumer must treat these as optional.
   */
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  /**
   * TRA-3390 — the currency this quote's `price` / `change` are denominated in,
   * as reported by the source that answered. Canonicalized through
   * `normalizeQuoteCurrency` (which preserves the `GBp` pence quotation as
   * `GBX`; see that function — the distinction is worth 100x on `AZN.L`).
   *
   * **ABSENT MEANS UNKNOWN, NOT USD.** The Stooq fallback carries no currency at
   * all, so its rows arrive here undefined and every consumer renders them with
   * no symbol rather than assuming dollars.
   */
  currency?: string;
};

/**
 * TRA-1980 — project a Tradier equity quote onto the internal {@link QuoteResult},
 * carrying the L1 book (bid/ask/sizes) through ONLY when Tradier reported a finite
 * touch. The Yahoo / chart / Stooq fallbacks build a `QuoteResult` with no book, so
 * a downstream reader (the pre-trade liquidity gate) treats the absence as "no L1".
 */
function tradierQuoteToResult(q: TradierEquityQuote): QuoteResult {
  return {
    price: q.price,
    volume: q.volume,
    change: q.change,
    changePct: q.changePct,
    // TRA-3390 — Tradier's quote payload carries no currency field, so this is a
    // property of THE ADAPTER'S OWN VENUE, not an inference from the ticker.
    // Tradier's equity book is US-listed securities only; a foreign listing comes
    // back in `unmatched_symbols` and never reaches this projection, so every row
    // that DOES reach it is a US listing and is denominated in USD by
    // construction. That is a different claim from a `.KS → KRW` suffix table:
    // it is scoped to the one venue this function is a projection of, and it
    // cannot be wrong for a symbol Tradier declined to answer for.
    currency: TRADIER_VENUE_CURRENCY,
    ...(typeof q.bid === 'number' ? { bid: q.bid } : {}),
    ...(typeof q.ask === 'number' ? { ask: q.ask } : {}),
    ...(typeof q.bidSize === 'number' ? { bidSize: q.bidSize } : {}),
    ...(typeof q.askSize === 'number' ? { askSize: q.askSize } : {}),
  };
}

/**
 * TRA-1035 — pure: synthesise a spot quote from a Yahoo *chart* result's `meta`
 * block (falling back to the most recent non-null bar close). Extracted so the
 * field-precedence logic is unit-testable without a live feed.
 *
 * Yahoo's quote endpoint (`yf.quote` → v7 `/finance/quote`) requires an
 * authenticated crumb and fails closed ("fetch failed") on some shared egress
 * IPs (e.g. the demo trading-server), while the chart endpoint
 * (`yf.chart` → v8 `/finance/chart`) needs no crumb and keeps working. The chart
 * response's `meta` carries `regularMarketPrice` / `previousClose` /
 * `regularMarketVolume`, so we can build a usable quote from the SAME working
 * endpoint that already powers the minute-bar fallback — no API key or secret
 * token required.
 */
export function chartQuoteFromResult(result: {
  meta?: {
    regularMarketPrice?: number;
    chartPreviousClose?: number;
    previousClose?: number;
    regularMarketVolume?: number;
    /**
     * TRA-3390 — Yahoo's chart `meta` carries the quote currency too (`KRW`,
     * `GBp`, `TWD`…), so the keyless fallback is not a currency blind spot.
     */
    currency?: string;
  };
  quotes?: ReadonlyArray<{ close?: number | null; volume?: number | null }>;
} | null | undefined): QuoteResult | null {
  if (!result) return null;
  const meta = result.meta ?? {};
  const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

  let price = finite(meta.regularMarketPrice) && meta.regularMarketPrice > 0 ? meta.regularMarketPrice : NaN;
  let volume = finite(meta.regularMarketVolume) ? meta.regularMarketVolume : 0;

  // Fall back to the latest non-null chart bar close when meta has no live price
  // (can happen pre-open or for thin symbols).
  if (!(Number.isFinite(price) && price > 0)) {
    const bars = result.quotes ?? [];
    for (let i = bars.length - 1; i >= 0; i--) {
      const c = bars[i]?.close;
      if (finite(c) && c > 0) {
        price = c;
        const v = bars[i]?.volume;
        if (volume === 0 && finite(v)) volume = v;
        break;
      }
    }
  }
  if (!(Number.isFinite(price) && price > 0)) return null;

  const prevClose = finite(meta.chartPreviousClose) && meta.chartPreviousClose > 0
    ? meta.chartPreviousClose
    : (finite(meta.previousClose) && meta.previousClose > 0 ? meta.previousClose : NaN);
  const change = Number.isFinite(prevClose) ? price - prevClose : 0;
  const changePct = Number.isFinite(prevClose) && prevClose > 0 ? (change / prevClose) * 100 : 0;
  // TRA-3390 — the keyless chart fallback answers for the currency too, so it is
  // NOT a currency blind spot. Spread-when-present: a `meta` without `currency`
  // yields an undefined currency, never a USD assumption.
  const currency = normalizeQuoteCurrency(meta.currency);
  return { price, volume, change, changePct, ...(currency !== undefined ? { currency } : {}) };
}

/**
 * TRA-1035 — derive a live(-ish) quote for a symbol from Yahoo's chart endpoint.
 * This is the keyless source that keeps the equity feed (and the demo swing
 * book) alive when Tradier is unconfigured and the Yahoo quote endpoint is dark.
 * Honors the shared Yahoo rate-limit breaker via {@link withRetry}.
 */
export async function fetchYahooChartQuote(symbol: string): Promise<QuoteResult | null> {
  const now = new Date();
  // A 2-day window at 1-minute granularity yields a current `meta.regularMarketPrice`
  // plus recent bars to back-fill from; short enough to keep the payload small.
  const from = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const result = await withRetry(
    // TRA-3068 — see the split-calendar section.
    () => yf.chart(symbol, { period1: from, period2: now, interval: '1m', events: 'div|split' }),
    `chartQuote(${symbol})`,
  );
  if (result) recordChartSplits(symbol, result);
  return chartQuoteFromResult(result as Parameters<typeof chartQuoteFromResult>[0]);
}

/**
 * Fetch the current quote for a single symbol.
 *
 * Ordered failover (TRA-418, TRA-1035) — `tradier → yahoo → yahooChart → stooq`
 * (see `EQUITY_QUOTE_FAILOVER_ORDER` in `feed-freshness.ts`). Tradier is the
 * primary source; when its breaker is open or it returns no quote we cascade
 * through the Yahoo quote endpoint, then the Yahoo *chart* endpoint (keyless,
 * survives a crumb-less quote-endpoint outage), then Stooq. Stooq stays
 * last-resort so the watchlist always has *something* to render even when every
 * Yahoo path is unreachable.
 */
export async function fetchQuote(symbol: string): Promise<QuoteResult | null> {
  // Primary: Tradier. (Single-symbol path — `fetchQuotes` uses the multi-symbol
  // endpoint to save round-trips for the watchlist refresh.)
  if (tradierStocksClient && !isTradierQuoteBlocked()) {
    try {
      const map = await tradierStocksClient.getQuotes([symbol]);
      const q = map.get(symbol);
      if (q) {
        return tradierQuoteToResult(q);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (shouldTripTradierBreaker(msg)) tripTradierBreaker(`quote(${symbol})`, msg, 'quote');
      else console.warn(`[yahoo-feed] tradier quote(${symbol}) error: ${msg}`);
    }
  }

  // Fallback 1: Yahoo Finance.
  const q = await withRetry(() => yf.quote(symbol), `quote(${symbol})`);
  if (q && q.regularMarketPrice != null) {
    return {
      price: q.regularMarketPrice,
      volume: q.regularMarketVolume ?? 0,
      change: q.regularMarketChange ?? 0,
      changePct: q.regularMarketChangePercent ?? 0,
      // TRA-3390 — the adapter's OWN answer for the unit. Yahoo returns `currency`
      // on the quote (`KRW` for `005930.KS`, `GBp` for `AZN.L`, `TWD` for
      // `2330.TW`). Absent => left undefined => rendered with no symbol; never
      // backfilled to USD, and never derived from the ticker suffix.
      ...(normalizeQuoteCurrency((q as { currency?: unknown }).currency) !== undefined
        ? { currency: normalizeQuoteCurrency((q as { currency?: unknown }).currency)! }
        : {}),
    };
  }
  if (q) console.warn(`[yahoo-feed] quote(${symbol}) returned no regularMarketPrice — trying Yahoo chart-quote fallback`);

  // Fallback 2: Yahoo chart endpoint (TRA-1035). Keyless, and survives when the
  // quote endpoint fails closed without a crumb while the chart endpoint still
  // resolves (the demo trading-server's egress).
  const chartQuote = await fetchYahooChartQuote(symbol);
  if (chartQuote) {
    console.info(`[yahoo-feed] ${symbol}: served from Yahoo chart-quote fallback`);
    return chartQuote;
  }

  // Fallback 3: Stooq (delayed but free, no API key).
  const stooq = await fetchStooqQuote(symbol);
  if (stooq) {
    console.info(`[yahoo-feed] ${symbol}: served from Stooq fallback (delayed)`);
    return stooq;
  }
  return null;
}

/**
 * Fetch quotes for all symbols.
 *
 * When Tradier is configured we try a single multi-symbol round-trip first —
 * Tradier accepts a comma-separated `symbols=` parameter, so the entire
 * watchlist refreshes in one HTTP call. Symbols Tradier doesn't return fall
 * through to the per-symbol Yahoo / Stooq cascade.
 */
export async function fetchQuotes(
  symbols: readonly string[],
  opts?: { maxStaleMs?: number },
): Promise<Map<string, QuoteResult>> {
  const results = new Map<string, QuoteResult>();
  if (symbols.length === 0) return results;

  const now = Date.now();
  // TRA-552 — serve symbols still inside the cache window without any upstream
  // call. `maxStaleMs` lets a staleness-tolerant caller (e.g. the relative-value
  // scanner's spot fetch) reuse a slightly older quote rather than burning a
  // fresh Tradier request; it defaults to the short live-quote TTL.
  const ttlMs = Math.max(0, opts?.maxStaleMs ?? QUOTE_CACHE_TTL_MS);
  const { fresh, stale } = partitionCachedQuotes({ symbols, cache: quoteCache, ttlMs, now });
  for (const [sym, q] of fresh) results.set(sym, q);
  if (stale.length === 0) return results;
  const staleSet = new Set(stale);

  // Primary: one Tradier call for the stale remainder (cache hits already served).
  // TRA-739 singleflight: coalesce concurrent callers that all find the same stale
  // symbols — only the first one fires a Tradier batch; the others await that same
  // promise and then read the now-populated cache entries.
  // TRA-1996: gate on the QUOTE-path breaker, not the shared one — a bar-pull
  // quota storm must not take this single cheap batch call dark (that is the
  // 0/545-fresh regression). See the per-source breaker note above.
  if (tradierStocksClient && !isTradierQuoteBlocked()) {
    const existingQuoteInflight = quoteInflight.get(TRADIER_QUOTE_INFLIGHT_KEY);
    if (existingQuoteInflight) {
      await existingQuoteInflight;
      // The in-flight fetched all globally-stale symbols; re-read cache.
      for (const sym of stale) {
        const entry = quoteCache.get(sym);
        if (entry) results.set(sym, entry.quote);
      }
    } else {
      // Collect ALL stale symbols across the whole cache (not just this caller's
      // subset) so concurrent waiters find their symbols fresh after this batch.
      const toFetch = new Set<string>(stale);
      for (const [sym, entry] of quoteCache) {
        if (now - entry.storedAt > ttlMs) toFetch.add(sym);
      }
      const toFetchArr = [...toFetch];
      const quoteFetch = (async () => {
        try {
          bumpFallbackCounter('tradier');
          recordTradierQuoteRequest(now);
          const { quotes: tradier, unmatchedSymbols } = await tradierStocksClient!.getQuotesDetailed(toFetchArr);
          const unmatchedLine = recordTradierUnmatched(unmatchedSymbols, toFetchArr.length);
          if (unmatchedLine) console.warn(unmatchedLine);
          const storedAt = Date.now();
          for (const [sym, q] of tradier) {
            const quote = tradierQuoteToResult(q);
            quoteCache.set(sym, { quote, storedAt });
            if (staleSet.has(sym)) results.set(sym, quote);
          }
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err);
          if (shouldTripTradierBreaker(msg)) tripTradierBreaker('quotes(batch)', msg, 'quote');
          else console.warn(`[yahoo-feed] tradier quotes(batch) error: ${msg}`);
        }
      })();
      quoteInflight.set(TRADIER_QUOTE_INFLIGHT_KEY, quoteFetch);
      try {
        await quoteFetch;
      } finally {
        quoteInflight.delete(TRADIER_QUOTE_INFLIGHT_KEY);
      }
    }
  }

  // Fan out the leftovers (symbols Tradier didn't return) to the secondary chain.
  const remaining = stale.filter((s) => !results.has(s));
  // TRA-1391 — short-circuit immediately when the Yahoo breaker is open.
  // withRetry already returns null for every symbol when isRateLimited() is true,
  // so the existing loop just burns N Promise.all() round-trips with zero data
  // gain and queues unnecessary microtask callbacks during the boot window.
  //
  // TRA-2627 — ...but COUNT THE DROP BEFORE YOU RETURN. This used to `return
  // results` unconditionally, several lines ABOVE the point where `failures` is even
  // declared, so every symbol in `remaining` vanished with no counter and no log
  // line at all. `applyQuotes` then stamped each of them `quoteStatus:'unavailable'`
  // — and the feed log said nothing whatsoever about why. That made the obvious
  // diagnosis wrong in the reassuring direction: a `fetchQuotes: 1/614 symbols
  // failed` line on the next tick reads as "only one symbol failed", when the whole
  // `remaining` set may have been dropped on the line above the counter. A silent
  // drop is the one failure a log-based investigation structurally cannot reach.
  // The distinct `pre-fanout` suffix separates this from the in-loop breaker trip,
  // which is a different event with a different remedy.
  if (remaining.length > 0 && isRateLimited()) {
    // TRA-2643 — name the head of the drop here too. This path loses the WHOLE
    // remainder, so it is the one most likely to take the risk gate with it.
    console.warn(`[yahoo-feed] fetchQuotes: ${remaining.length}/${symbols.length} symbols failed (Yahoo breaker open, pre-fanout short-circuit)${formatDroppedSymbols(remaining)}`);
    return results;
  }
  // TRA-2627 — say out loud when the budget CANNOT cover this universe. A line
  // reading "288/614 symbols failed (feed budget exhausted)" reads as a transient
  // that a retry would clear; at 614 symbols it is arithmetic, and it recurs on
  // every tick where Tradier is dark. Naming the ceiling and the three constants
  // that set it turns the next reader toward the sizing decision instead of toward
  // the provider.
  const fanoutCeiling = secondaryFanoutCeiling();
  if (remaining.length > fanoutCeiling) {
    console.warn(`[yahoo-feed] fetchQuotes: fan-out budget CANNOT cover this universe — ${remaining.length} symbols need a secondary quote, ceiling is ${fanoutCeiling} (FEED_FANOUT_BUDGET_MS=${FEED_FANOUT_BUDGET_MS} / ${FANOUT_SLEEP_MS}ms sleep x ${QUOTE_BATCH} per batch); >=${remaining.length - fanoutCeiling} will be left unpriced before any network time is counted`);
  }
  // TRA-1940 — cap total wall-time spent on the secondary fan-out per call. The
  // start-of-loop short-circuit above can't catch either (a) a Yahoo breaker that
  // trips PARTWAY through the loop — the remaining batches then each burn a 200ms
  // inter-batch sleep for zero data — or (b) a large universe (e.g. 535 symbols =
  // 107 batches) whose sleeps alone total ~21s before any network. Both stretch a
  // degraded-feed doTick into minutes and stall trade accrual. We re-check the
  // breaker AND a fan-out deadline before each batch and stop cleanly, leaving the
  // remaining symbols unpriced (the tick acts on the N it has; callers skip the
  // rest — see doTick quoteStatus handling).
  const fanoutDeadline = Date.now() + FEED_FANOUT_BUDGET_MS;
  let failures = 0;
  let budgetHit = false;
  // TRA-2643 — the truncation must say WHAT it dropped, not just how many.
  // TRA-2627 landed the count; "we dropped 414 symbols" is not actionable while
  // "we dropped ^VIX" is. `remaining` is now ordered most-important-first by the
  // caller (`SignalEngine.getQuoteFetchOrder`), so the FIRST names in the
  // dropped suffix are the marginal ones sitting just past the ceiling — the
  // rows a budget change would have bought back, and the ones worth naming.
  let dropped: readonly string[] = [];
  for (let i = 0; i < remaining.length; i += QUOTE_BATCH) {
    if (isRateLimited() || Date.now() >= fanoutDeadline) {
      budgetHit = true;
      failures += remaining.length - i;
      dropped = remaining.slice(i);
      break;
    }
    const slice = remaining.slice(i, i + QUOTE_BATCH);
    const settled = await Promise.all(slice.map(sym => fetchSecondaryQuote(sym).then(q => [sym, q] as const)));
    for (const [sym, q] of settled) {
      if (q) results.set(sym, q);
      else failures++;
    }
    if (i + QUOTE_BATCH < remaining.length) await sleep(FANOUT_SLEEP_MS);
  }
  if (failures > 0) {
    const reason = isRateLimited() ? ' (Yahoo breaker open)' : budgetHit ? ' (feed budget exhausted)' : '';
    console.warn(`[yahoo-feed] fetchQuotes: ${failures}/${symbols.length} symbols failed${reason}${formatDroppedSymbols(dropped)}`);
  }

  // TRA-552 — cache the freshly resolved (stale-set) quotes so overlapping
  // readers within the window reuse them. Pre-existing fresh hits keep their
  // original timestamp; only re-stamp what we just fetched.
  cacheFreshQuotes([...results].filter(([s]) => staleSet.has(s)), now);
  return results;
}

/**
 * Yahoo → Stooq path used by {@link fetchQuotes} for symbols Tradier didn't
 * return. Kept distinct from {@link fetchQuote} so the multi-symbol path
 * doesn't double-call Tradier per leftover (the batch already consulted it).
 */
async function fetchSecondaryQuote(symbol: string): Promise<QuoteResult | null> {
  const q = await withRetry(() => yf.quote(symbol), `quote(${symbol})`);
  if (q && q.regularMarketPrice != null) {
    return {
      price: q.regularMarketPrice,
      volume: q.regularMarketVolume ?? 0,
      change: q.regularMarketChange ?? 0,
      changePct: q.regularMarketChangePercent ?? 0,
      // TRA-3390 — the adapter's OWN answer for the unit. Yahoo returns `currency`
      // on the quote (`KRW` for `005930.KS`, `GBp` for `AZN.L`, `TWD` for
      // `2330.TW`). Absent => left undefined => rendered with no symbol; never
      // backfilled to USD, and never derived from the ticker suffix.
      ...(normalizeQuoteCurrency((q as { currency?: unknown }).currency) !== undefined
        ? { currency: normalizeQuoteCurrency((q as { currency?: unknown }).currency)! }
        : {}),
    };
  }
  // TRA-1035 — keyless Yahoo chart-quote before Stooq, mirroring fetchQuote's
  // cascade so the multi-symbol watchlist path also recovers when the quote
  // endpoint is crumb-broken but the chart endpoint works.
  const chartQuote = await fetchYahooChartQuote(symbol);
  if (chartQuote) return chartQuote;
  const stooq = await fetchStooqQuote(symbol);
  if (stooq) return stooq;
  return null;
}

// TRA-196 — per-symbol news aggregation.
//
// The previous broad query ('stocks market NYSE trading') frequently returned
// no `news` items from Yahoo's search endpoint, so the stocks News tab showed
// up empty. Yahoo also caches identical-query results aggressively, which made
// the rare non-empty response stick around unchanged. We now fan out per-symbol
// searches across the watchlist and aggregate fresh, varied results.
export async function fetchStocksNews(symbols: readonly string[]): Promise<NewsItem[]> {
  const NEWS_QUERY_LIMIT = 8;
  const NEWS_BATCH = 3;
  const PER_SYMBOL_NEWS = 5;
  const RESULT_CAP = 20;

  const querySymbols = symbols.slice(0, NEWS_QUERY_LIMIT);
  const items: NewsItem[] = [];
  const seen = new Set<string>();

  const collect = (newsArr: ReadonlyArray<{ title?: string; link?: string; publisher?: string; providerPublishTime?: Date | number | string }>): void => {
    for (const n of newsArr) {
      if (!n?.link || !n?.title || seen.has(n.link)) continue;
      seen.add(n.link);
      items.push({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'Yahoo Finance',
        publishedAt: toIsoTime(n.providerPublishTime),
      });
    }
  };

  for (let i = 0; i < querySymbols.length; i += NEWS_BATCH) {
    const slice = querySymbols.slice(i, i + NEWS_BATCH);
    const settled = await Promise.all(
      slice.map(sym =>
        withRetry(
          () => yf.search(sym, { newsCount: PER_SYMBOL_NEWS, quotesCount: 0 }),
          `search(news ${sym})`,
        ),
      ),
    );
    for (const r of settled) {
      if (!r) continue;
      collect(r.news ?? []);
    }
    if (i + NEWS_BATCH < querySymbols.length) await sleep(200);
  }

  if (items.length < RESULT_CAP) {
    const fallback = await withRetry(
      () => yf.search('stocks market trading', { newsCount: 10, quotesCount: 0 }),
      'search(stocks news fallback)',
    );
    if (fallback) collect(fallback.news ?? []);
  }

  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return items.slice(0, RESULT_CAP);
}

/** Outcome of a {@link fetchMarketNews} sweep — headlines PLUS feed health. */
export interface MarketNewsResult {
  items: NewsItem[];
  /** Queries actually issued (≤ symbols.length; a wall-clock cut lowers this). */
  queriesAttempted: number;
  /** Queries that returned a response. `0` with `attempted > 0` ⇒ feed outage. */
  queriesSucceeded: number;
}

// TRA-1629 (TRA-1623A) — news pull for catalyst discovery.
// TRA-2064 — REWRITTEN: this used four broad free-text topic queries
// ('stock market movers today', …). Yahoo's search endpoint resolves an *entity*
// (ticker / company name) and returns that entity's news; a topic phrase resolves
// to nothing and comes back `news: []` — **with no error and no throw**. Measured
// 2026-07-20: all four topic queries → 0 headlines, while 'AAPL'/'NVDA'/'Apple Inc'
// → 10 each. So this function returned an empty list *every session by
// construction*, which is the whole of TRA-1630's "0 rows in 6 armed sessions".
//
// `fetchStocksNews` above carries the same lesson in its TRA-196 header — a broad
// query 'stocks market NYSE trading' returning no news, fixed by per-symbol
// fan-out. TRA-1629 reintroduced the bug this codebase had already retired once.
//
// Discovery is NOT lost by going entity-scoped: `mapNewsToCandidates` only ever
// emits `universe ∩ mentioned`, so sweeping the universe directly yields exactly
// the reachable set — strictly more recall than the topic stream's zero. The
// discovery claim is relative to the *daily* price/volume watchlist, not to the
// universe. Keyless Yahoo search, $0 incremental cost.
export async function fetchMarketNews(symbols: readonly string[] = []): Promise<MarketNewsResult> {
  const PER_QUERY_NEWS = 12;
  const RESULT_CAP = 60;
  const NEWS_BATCH = 3;
  const BATCH_PAUSE_MS = 200;
  // TRA-1940 — bound the fan-out by WALL TIME, not by item count. This runs in
  // the pre-market hook ahead of the bell; a slow feed must not push the whole
  // watchlist build past 9:30. A cut here lowers `queriesAttempted`, so the
  // attempted/succeeded ratio stays an honest read of the queries we did issue.
  const DEADLINE_MS = 45_000;
  const startedAt = Date.now();

  // TRA-2088 — headlines are bucketed BY THE QUERY THAT RETURNED THEM, not piled
  // into one flat list. See the allocation comment at the tail of this function.
  const PER_SYMBOL_TOP_K = 3;

  const queries = [...symbols];
  const perSymbol = new Map<string, NewsItem[]>();
  const seen = new Set<string>();
  let queriesAttempted = 0;
  let queriesSucceeded = 0;
  const collect = (
    query: string,
    newsArr: ReadonlyArray<{
      title?: string;
      link?: string;
      publisher?: string;
      summary?: string;
      providerPublishTime?: Date | number | string;
    }>,
  ): void => {
    let bucket = perSymbol.get(query);
    if (!bucket) {
      bucket = [];
      perSymbol.set(query, bucket);
    }
    for (const n of newsArr) {
      // `seen` stays GLOBAL: a wire duplicate is attributed to the first query
      // that returned it. Downstream `mapNewsToCandidates` maps by mention text,
      // not by bucket key, so a shared headline still reaches every symbol it
      // names — the bucket only decides which symbol spends a slot on it.
      if (!n?.link || !n?.title || seen.has(n.link)) continue;
      seen.add(n.link);
      bucket.push({
        title: n.title,
        url: n.link,
        source: n.publisher ?? 'Yahoo Finance',
        publishedAt: toIsoTime(n.providerPublishTime),
        ...(n.summary ? { summary: n.summary } : {}),
      });
    }
  };

  for (let i = 0; i < queries.length; i += NEWS_BATCH) {
    // A cut shows up downstream as `queriesAttempted < universe size` on the
    // health probe — no log line, which nothing downstream could read anyway.
    if (Date.now() - startedAt > DEADLINE_MS) break;
    const slice = queries.slice(i, i + NEWS_BATCH);
    queriesAttempted += slice.length;
    const settled = await Promise.all(
      slice.map((q) =>
        withRetry(
          () => yf.search(q, { newsCount: PER_QUERY_NEWS, quotesCount: 0 }),
          `search(market news "${q}")`,
        ),
      ),
    );
    for (const [idx, r] of settled.entries()) {
      // `withRetry` yields `null` on exhaustion. Counting only non-null keeps a
      // feed outage separable from a genuinely quiet news day — the two used to
      // land on the identical empty array.
      if (!r) continue;
      queriesSucceeded += 1;
      collect(slice[idx]!, r.news ?? []);
    }
    if (i + NEWS_BATCH < queries.length) await sleep(BATCH_PAUSE_MS);
  }

  // TRA-2088 — ALLOCATION, not truncation.
  //
  // This used to be `items.sort(recency).slice(0, RESULT_CAP)` over one flat
  // list. That is a BIASED SAMPLER, not a bound: a global recency sort allocates
  // the 60 slots BY NEWS VOLUME, and `CATALYST_FRESHNESS_MAX_MINUTES` (6h) admits
  // far more than 60 items on a normal morning — so the cap binds before freshness
  // ever filters. Measured on the TRA-2064 run: `headlines=60 -> 13 mapped
  // candidates`; 12 of 25 names were structurally unreachable, crowded out by
  // NVDA/AAPL/TSLA rather than by having no fresh catalyst.
  //
  // That is close to the exact inverse of what a catalyst screener wants. Its
  // highest-information event is a single unexpected headline on a normally-quiet
  // name — precisely the row a volume-ranked sampler drops first.
  //
  // Fix: drain the per-symbol buckets RANK-INTERLEAVED. Every symbol's freshest
  // headline is admitted before any symbol's second, so a quiet name's one fresh
  // headline can never be evicted by a noisy name's twelfth.
  //
  // NOTE a plain per-symbol top-K followed by a global recency cap does NOT give
  // that guarantee: 25 symbols x K=3 is 75 > RESULT_CAP 60, so the global sort
  // would still evict ~15 by volume — the same defect, one order smaller. The
  // interleave is what makes the guarantee structural.
  //
  const buckets = [...perSymbol.values()]
    .map((b) => [...b].sort((x, y) => y.publishedAt.localeCompare(x.publishedAt)).slice(0, PER_SYMBOL_TOP_K))
    .filter((b) => b.length > 0);

  // The cap must never bind BELOW one-slot-per-symbol, or the rank-0 pass starts
  // truncating in QUERY ORDER — a positional bias just as arbitrary as the volume
  // bias removed above, and just as silent. Today this is inert (25 symbols, cap
  // 60); it exists so the guarantee survives a future universe widening instead of
  // depending on someone reading a comment. Still hard-bounded: the ceiling is
  // max(60, universe) and each symbol contributes at most PER_SYMBOL_TOP_K.
  const effectiveCap = Math.max(RESULT_CAP, buckets.length);

  const items: NewsItem[] = [];
  for (let rank = 0; rank < PER_SYMBOL_TOP_K && items.length < effectiveCap; rank += 1) {
    for (const b of buckets) {
      if (items.length >= effectiveCap) break;
      const pick = b[rank];
      if (pick) items.push(pick);
    }
  }

  // Callers receive a recency-ordered list, exactly as before — the interleave
  // decides MEMBERSHIP, not the emitted order.
  items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return { items, queriesAttempted, queriesSucceeded };
}

/** Test Yahoo Finance connectivity — returns a quote or throws. */
export async function testYahooFinance(): Promise<{ symbol: string; price: number }> {
  const q = await withTimeout(yf.quote('AAPL'), YF_CALL_TIMEOUT_MS, 'quote(AAPL) health-check');
  if (q.regularMarketPrice == null) throw new Error('regularMarketPrice is null');
  return { symbol: 'AAPL', price: q.regularMarketPrice };
}

/**
 * TRA-1035 — test the keyless Yahoo *chart-quote* path (the failover that keeps
 * stocks live when the Yahoo quote endpoint is crumb-broken). Surfaced as its
 * own `/api/health/quotes` probe and counted toward `stocksOk`, so the gauge
 * reports the truth (the equity engine can still price the universe) instead of
 * a false outage when only the quote endpoint is down.
 */
export async function testYahooChartQuote(): Promise<{ symbol: string; price: number }> {
  const q = await fetchYahooChartQuote('AAPL');
  if (!q) throw new Error('Yahoo chart-quote returned no price for AAPL');
  return { symbol: 'AAPL', price: q.price };
}

/** Test Tradier connectivity — returns a quote or throws / returns null when unconfigured. */
export async function testTradier(): Promise<{ symbol: string; price: number } | null> {
  if (!tradierStocksClient) return null;
  const map = await tradierStocksClient.getQuotes(['AAPL']);
  const q = map.get('AAPL');
  if (!q) throw new Error('Tradier returned no quote for AAPL');
  return { symbol: 'AAPL', price: q.price };
}

/** Test Twelve Data connectivity — returns bar count or throws / returns null when unconfigured. */
export async function testTwelveData(): Promise<{ symbol: string; bars: number } | null> {
  if (!TWELVE_DATA_API_KEY) return null;
  const { bars, diag } = await fetchTwelveDataMinuteBars('AAPL', 60, true);
  if (bars.length === 0) {
    throw new Error(`Twelve Data returned no bars for AAPL (reason=${diag.reason}${diag.httpStatus ? ` http=${diag.httpStatus}` : ''}${diag.errorBody ? ` body=${diag.errorBody}` : ''})`);
  }
  return { symbol: 'AAPL', bars: bars.length };
}

/** Whether the Yahoo rate-limit circuit breaker is currently open. */
export function isYahooBreakerOpen(): boolean {
  return isRateLimited();
}

/**
 * Trip the shared Yahoo rate-limit breaker from another module (e.g. the
 * crypto feed). Yahoo's 429 is per-IP, so a 429 on crypto quotes means the
 * stocks branch is also about to get rate-limited; tripping the shared
 * breaker stops both feeds from hammering YF until the cooldown elapses.
 */
export function tripYahooBreakerFromExternal(label: string, msg: string): void {
  tripBreaker(label, msg);
}

/** Whether the Tradier circuit breaker is currently open. */
export function isTradierBreakerOpen(): boolean {
  return isTradierBlocked();
}

/**
 * TRA-1940 — degraded-feed snapshot for the `/api/health/quotes` route so ops can
 * see, at a glance, WHICH provider is degraded, WHY, and WHEN it recovers:
 *  - Tradier breaker: open flag, why it tripped (quota vs http_error), and the
 *    expiry (quota-expiry) timestamp.
 *  - Yahoo breaker: open flag and its cooldown expiry.
 *  - `fanoutBudgetMs`: the per-tick secondary-fetch wall-time ceiling in force.
 */
export function getFeedDegradationState(): {
  tradier: {
    open: boolean;
    reason: 'quota' | 'http_error' | null;
    blockedUntil: string | null;
    // TRA-1996 — per-source split so ops can see whether QUOTES are still flowing
    // through Tradier while a BAR-pull quota storm backs off the bar path.
    // Naming follows the breaker convention: `*PathOpen === true` means the
    // breaker for that path is OPEN, i.e. that path is BLOCKED (backing off).
    quotePathOpen: boolean;
    barPathOpen: boolean;
  };
  yahoo: { open: boolean; blockedUntil: string | null };
  fanoutBudgetMs: number;
} {
  const tradierOpen = isTradierBlocked();
  const yahooOpen = isRateLimited();
  return {
    tradier: {
      open: tradierOpen,
      reason: tradierOpen ? tradierBlockedReason : null,
      blockedUntil: tradierOpen ? new Date(tradierBlockedUntilMax()).toISOString() : null,
      quotePathOpen: isTradierQuoteBlocked(),
      // TRA-2073: the EFFECTIVE bar-path block is `now < max(barUntil, quoteUntil)`
      // (a QUOTE-side quota trip means the account is genuinely saturated, so bars
      // back off too). The raw `now < tradierBarBlockedUntil` bypassed that `max()`
      // gate and under-reported `barPathOpen:false` on a quote-side trip while
      // `tradier.open` above already read true — a self-contradictory snapshot that
      // mis-led the first read of this telemetry. Route it through the same gate.
      barPathOpen: isTradierBlocked(),
    },
    yahoo: {
      open: yahooOpen,
      blockedUntil: yahooOpen ? new Date(rateLimitedUntil).toISOString() : null,
    },
    fanoutBudgetMs: FEED_FANOUT_BUDGET_MS,
  };
}

// ── Boot env-token seed (TRA-574) ─────────────────────────────────────────────
// Seed the boot env token (if present) under the reserved env key so it survives
// every per-user clear. Absent → the feed stays on Yahoo until a user supplies one.
//
// This MUST run after every module-level declaration above is initialized: the
// seed calls reconcileTradierFeedClient → clearQuoteCache → quoteCache.clear(),
// and `quoteCache` (and friends) are `const`/`let` declared earlier in the file
// but not value-hoisted. Invoking the seed at its original (mid-file) position
// hit those bindings inside their temporal dead zone and threw at module eval,
// crash-looping the prod deploy. Running it as the final top-level statement
// guarantees the caches exist before the seed touches them.
function seedBootEnvTradierToken(): void {
  if (TRADIER_MARKET_DATA_TOKEN) {
    // TRA-1937: seed with 'production' so market data always hits api.tradier.com.
    setTradierStocksFeedClient(TRADIER_MARKET_DATA_TOKEN, 'production', FEED_ENV_CONTEXT_KEY);
  } else {
    console.warn('[yahoo-feed] Tradier stocks feed disabled (no TRADIER_*_API_TOKEN at boot) — using Yahoo as primary until settings supply a token');
  }
}
seedBootEnvTradierToken();
