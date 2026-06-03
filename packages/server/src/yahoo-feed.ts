import YahooFinance from 'yahoo-finance2';
import { TradierStocksClient, type TradierEnv } from '@trading-app/engine';
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

// 429 circuit breaker for Yahoo. When Yahoo rate-limits us, retrying every tick
// burns the retry budget for nothing and risks extending the lock-out. Open the
// breaker for a cool-down window so we fall through to Stooq fast.
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

async function withRetry<T>(fn: () => Promise<T>, label: string, retries = 2): Promise<T | null> {
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

let activeInterestSymbols: ReadonlySet<string> = new Set<string>();

export function setActiveInterestSymbols(symbols: Iterable<string>): void {
  activeInterestSymbols = new Set(symbols);
}

function isActiveInterest(symbol: string): boolean {
  return activeInterestSymbols.has(symbol);
}

// ── Tradier primary feed (TRA-191 follow-up) ──────────────────────────────────
// Once the Tradier broker creds are configured, Tradier is the primary source
// for both quotes and 1-minute bars. Yahoo / Twelve Data / Stooq remain as
// successive fallbacks so the engine still returns *something* when Tradier
// 429s or the env vars are missing.

const TRADIER_ENV = (process.env['TRADIER_ENV'] as TradierEnv) ?? 'sandbox';
const TRADIER_API_TOKEN = TRADIER_ENV === 'production'
  ? (process.env['TRADIER_API_TOKEN'] ?? '')
  : (process.env['TRADIER_SANDBOX_API_TOKEN'] ?? process.env['TRADIER_API_TOKEN'] ?? '');

let tradierStocksClient: TradierStocksClient | null =
  TRADIER_API_TOKEN ? new TradierStocksClient(TRADIER_API_TOKEN, TRADIER_ENV) : null;

if (!tradierStocksClient) {
  console.warn('[yahoo-feed] Tradier stocks feed disabled (no TRADIER_*_API_TOKEN at boot) — using Yahoo as primary until settings supply a token');
}

const TRADIER_BREAKER_COOLDOWN_MS = 90_000;
let tradierBlockedUntil = 0;
function isTradierBlocked(): boolean {
  return Date.now() < tradierBlockedUntil;
}
function tripTradierBreaker(label: string, msg: string): void {
  tradierBlockedUntil = Date.now() + TRADIER_BREAKER_COOLDOWN_MS;
  console.warn(`[yahoo-feed] Tradier breaker tripped for ${TRADIER_BREAKER_COOLDOWN_MS / 1000}s after ${label}: ${msg}`);
}

export function isTradierStocksConfigured(): boolean {
  return tradierStocksClient !== null;
}

// ── TRA-505: wire the quote feed to the live UI creds ─────────────────────────
// The Tradier client above is seeded ONCE at module load from the TRADIER_*
// env vars. But the live app writes the user's Tradier creds into per-user
// account-settings (via the Settings page), NOT env — so on a normal deployment
// `TRADIER_API_TOKEN` is empty and this feed has no Tradier source, even after
// the user has a fully working Tradier production connection (balance + trades).
// Quotes then fall through to Yahoo Finance's free per-IP feed, which 429s and
// trips the breaker, surfacing "Quote unavailable — provider rate-limited" on
// the watchlist. The signal-engine calls the setter below from applySettings so
// quotes flow through the SAME Tradier account that already powers trading.
let tradierFeedToken = TRADIER_API_TOKEN;
let tradierFeedEnv: TradierEnv = TRADIER_ENV;
export function setTradierStocksFeedClient(token: string | null | undefined, env: TradierEnv): void {
  const next = (token ?? '').trim();
  if (next === tradierFeedToken && env === tradierFeedEnv) return;
  tradierFeedToken = next;
  tradierFeedEnv = env;
  tradierStocksClient = next ? new TradierStocksClient(next, env) : null;
  // A credential change earns Tradier an immediate retry: clear any breaker the
  // old (empty/stale) token had tripped on a 401/429 so the very next tick can
  // use the new token instead of staying on Yahoo for another cooldown window.
  tradierBlockedUntil = 0;
  if (tradierStocksClient) {
    console.info(`[yahoo-feed] Tradier stocks feed enabled from account settings (env=${env}) — Tradier is now the primary quote source`);
  } else {
    console.warn('[yahoo-feed] Tradier stocks feed disabled (no token in settings) — using Yahoo as primary');
  }
}

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
}

export function getFallbackRequestCounts(): { day: string; tradier: number; twelveData: number } {
  rollFallbackCountersIfNeeded();
  return {
    day: fallbackCountersDay,
    tradier: fallbackCounters.tradier,
    twelveData: fallbackCounters.twelveData,
  };
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
};
const minuteBarCache = new Map<string, MinuteBarCacheEntry>();
function nextMinuteBoundary(): number {
  const now = Date.now();
  return Math.floor(now / 60_000) * 60_000 + 60_000;
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
    () => yf.chart(symbol, { period1: from, period2: now, interval: '1d' }),
    `dailyChart(${symbol})`,
  );
  if (!result) return [];
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
    if (/HTTP\s+(429|5\d\d)/.test(msg)) tripTradierBreaker(`timesales(${symbol})`, msg);
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
  tradierDiag?: TradierCandleDiag;
  twelveDataDiag?: TwelveDataCandleDiag;
}> {
  const yahooSkipped = isRateLimited();

  // Primary: Tradier intraday timesales.
  const tradier = await fetchTradierMinuteBars(symbol, count);
  if (tradier.bars.length > 0) {
    minuteBarCache.set(symbol, { bars: tradier.bars, source: 'tradier', expiresAt: nextMinuteBoundary() });
    return { bars: tradier.bars, source: 'tradier', yahooSkipped, tradierDiag: tradier.diag };
  }

  const now = new Date();
  const from = new Date(now.getTime() - count * 60 * 1000 * 2);
  const currentMinuteStart = Math.floor(now.getTime() / 60_000) * 60_000;

  // Fallback 1: Yahoo Finance.
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

  if (yahooBars.length > 0) {
    minuteBarCache.set(symbol, { bars: yahooBars, source: 'yahoo', expiresAt: nextMinuteBoundary() });
    return { bars: yahooBars, source: 'yahoo', yahooSkipped, tradierDiag: tradier.diag };
  }

  // Reuse a recent fallback response within the same minute rather than re-firing providers.
  const cached = minuteBarCache.get(symbol);
  if (cached && cached.expiresAt > Date.now() && cached.source !== 'yahoo') {
    return { bars: cached.bars, source: cached.source, yahooSkipped, cached: true, tradierDiag: tradier.diag };
  }

  // Fallback 2: Twelve Data (gated to active-interest symbols to fit free-tier 800/day cap).
  const twelveData = await fetchTwelveDataMinuteBars(symbol, count, isActiveInterest(symbol));
  if (twelveData.bars.length > 0) {
    console.info(`[yahoo-feed] chart(${symbol}): served ${twelveData.bars.length} bars from Twelve Data fallback`);
    minuteBarCache.set(symbol, { bars: twelveData.bars, source: 'twelvedata', expiresAt: nextMinuteBoundary() });
    return {
      bars: twelveData.bars,
      source: 'twelvedata',
      yahooSkipped,
      tradierDiag: tradier.diag,
      twelveDataDiag: twelveData.diag,
    };
  }

  // Negative-cache the miss so a back-to-back tick in the same minute does not
  // re-run the Twelve Data fallback (TRA-439). Bars only roll on the minute
  // boundary, so a miss now is a miss until the next boundary.
  minuteBarCache.set(symbol, { bars: [], source: 'none', expiresAt: nextMinuteBoundary() });
  return {
    bars: [],
    source: 'none',
    yahooSkipped,
    tradierDiag: tradier.diag,
    twelveDataDiag: twelveData.diag,
  };
}

type QuoteResult = { price: number; volume: number; change: number; changePct: number };

/**
 * Fetch the current quote for a single symbol.
 *
 * Ordered failover (TRA-418) — `tradier → yahoo → stooq` (see
 * `EQUITY_QUOTE_FAILOVER_ORDER` in `feed-freshness.ts`). Tradier is the primary
 * source; when its breaker is open or it returns no quote we cascade through
 * Yahoo and then Stooq. Stooq stays last-resort so the watchlist always has
 * *something* to render even when both primary and Yahoo are unreachable.
 */
export async function fetchQuote(symbol: string): Promise<QuoteResult | null> {
  // Primary: Tradier. (Single-symbol path — `fetchQuotes` uses the multi-symbol
  // endpoint to save round-trips for the watchlist refresh.)
  if (tradierStocksClient && !isTradierBlocked()) {
    try {
      const map = await tradierStocksClient.getQuotes([symbol]);
      const q = map.get(symbol);
      if (q) {
        return { price: q.price, volume: q.volume, change: q.change, changePct: q.changePct };
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP\s+(429|5\d\d)/.test(msg)) tripTradierBreaker(`quote(${symbol})`, msg);
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
    };
  }
  if (q) console.warn(`[yahoo-feed] quote(${symbol}) returned no regularMarketPrice — trying Stooq fallback`);

  // Fallback 2: Stooq (delayed but free, no API key).
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
export async function fetchQuotes(symbols: readonly string[]): Promise<Map<string, QuoteResult>> {
  const results = new Map<string, QuoteResult>();
  if (symbols.length === 0) return results;

  // Primary: one Tradier call for the whole list.
  if (tradierStocksClient && !isTradierBlocked()) {
    try {
      bumpFallbackCounter('tradier');
      const tradier = await tradierStocksClient.getQuotes(symbols);
      for (const [sym, q] of tradier) {
        results.set(sym, { price: q.price, volume: q.volume, change: q.change, changePct: q.changePct });
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/HTTP\s+(429|5\d\d)/.test(msg)) tripTradierBreaker('quotes(batch)', msg);
      else console.warn(`[yahoo-feed] tradier quotes(batch) error: ${msg}`);
    }
  }

  // Fan out the leftovers to the secondary chain in parallel batches.
  const remaining = symbols.filter((s) => !results.has(s));
  if (remaining.length === 0) return results;

  const QUOTE_BATCH = 5;
  let failures = 0;
  for (let i = 0; i < remaining.length; i += QUOTE_BATCH) {
    const slice = remaining.slice(i, i + QUOTE_BATCH);
    const settled = await Promise.all(slice.map(sym => fetchSecondaryQuote(sym).then(q => [sym, q] as const)));
    for (const [sym, q] of settled) {
      if (q) results.set(sym, q);
      else failures++;
    }
    if (i + QUOTE_BATCH < remaining.length) await sleep(200);
  }
  if (failures > 0) {
    console.warn(`[yahoo-feed] fetchQuotes: ${failures}/${symbols.length} symbols failed${isRateLimited() ? ' (Yahoo breaker open)' : ''}`);
  }
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
    };
  }
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

/** Test Yahoo Finance connectivity — returns a quote or throws. */
export async function testYahooFinance(): Promise<{ symbol: string; price: number }> {
  const q = await withTimeout(yf.quote('AAPL'), YF_CALL_TIMEOUT_MS, 'quote(AAPL) health-check');
  if (q.regularMarketPrice == null) throw new Error('regularMarketPrice is null');
  return { symbol: 'AAPL', price: q.regularMarketPrice };
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
