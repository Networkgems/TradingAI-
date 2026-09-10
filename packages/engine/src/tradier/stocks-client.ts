import type { Candle } from '@trading-app/shared';
import { tradierBaseUrl, type TradierEnv } from './order-client.js';

// ── TRA-4441 — read the rate limit off the wire instead of modelling it ───────
//
// `TRADIER_ACCOUNT_BUDGET_PER_MIN` (yahoo-feed.ts) calls itself "a property of the
// UPSTREAM contract, not of our universe" and then hard-codes `200` — a number
// INFERRED on 2026-08-06 from the minute at which Tradier began returning
// `HTTP 400: Quota Violation`. Inference was never necessary: Tradier states the
// limit explicitly in `X-Ratelimit-*` on EVERY response, and all three call sites
// below already hold the `Response` object that carries them. We were discarding
// the authoritative answer and re-deriving a worse one by hand.
//
// ⭐ THE READING IS PER RATE-LIMIT BUCKET, NOT PER ACCOUNT — which is why this is
// recorded per endpoint class and not collapsed to one number here. If
// `/markets/quotes` and `/markets/timesales` report DIFFERENT `Allowed`, they are
// metered separately and the whole "one account-wide budget the bar path exhausts
// out from under the quote path" model is false — TRA-4441's premise included. A
// single merged number would hide exactly the disagreement that decides that.
// Deciding is the consumer's job; this layer only reports what each bucket said.
//
// ⛔ OBSERVE BEFORE THE THROW. The most informative response is the REFUSAL — a
// 400/429 carries the headers stating what we exceeded. Recording only on `ok`
// responses would blind the meter in precisely the window it exists for.

/** TRA-4441 — one Tradier `X-Ratelimit-*` reading, as reported by upstream. */
export interface TradierRateLimitReading {
  /** Which Tradier rate-limit bucket answered. Distinct classes may meter separately. */
  endpointClass: TradierEndpointClass;
  /** `X-Ratelimit-Allowed` — the plan's ceiling for this bucket. The AC1 answer. */
  allowed: number | null;
  /** `X-Ratelimit-Used` — consumed so far in the current window. */
  used: number | null;
  /** `X-Ratelimit-Available` — remaining in the current window. */
  available: number | null;
  /** `X-Ratelimit-Expiry` — epoch ms at which this window resets. */
  expiryMs: number | null;
  /** HTTP status of the response the headers rode in on. A 400/429 here is a refusal. */
  status: number;
  /** Local clock when read, so a consumer can age the reading and derive the window. */
  observedAtMs: number;
}

export type TradierEndpointClass = 'quotes' | 'timesales' | 'history';

type TradierRateLimitObserver = (reading: TradierRateLimitReading) => void;

let rateLimitObserver: TradierRateLimitObserver | null = null;

/**
 * TRA-4441 — register the sink for upstream rate-limit readings, or `null` to
 * unregister. Kept as an injected callback rather than module state read by the
 * server so this package keeps no process-wide meter of its own: the engine
 * reports, the server aggregates and publishes.
 */
export function setTradierRateLimitObserver(fn: TradierRateLimitObserver | null): void {
  rateLimitObserver = fn;
}

/**
 * Parse the `X-Ratelimit-*` family off a response's headers. Pure and exported so
 * the header contract can be tested without a live Tradier round-trip.
 *
 * Every field is independently nullable: Tradier does not promise the family on
 * every route, and a partially-present set is still worth recording. A missing
 * header must read as "not stated" (`null`) and never as `0` — `available: 0`
 * means "quota exhausted", which is the opposite of "we did not learn anything".
 */
export function parseTradierRateLimitHeaders(
  headers: { get(name: string): string | null },
  endpointClass: TradierEndpointClass,
  status: number,
  observedAtMs: number,
): TradierRateLimitReading {
  const num = (name: string): number | null => {
    const raw = headers.get(name);
    if (raw === null || raw.trim() === '') return null;
    const n = Number(raw);
    return Number.isFinite(n) ? n : null;
  };
  return {
    endpointClass,
    allowed: num('x-ratelimit-allowed'),
    used: num('x-ratelimit-used'),
    available: num('x-ratelimit-available'),
    expiryMs: num('x-ratelimit-expiry'),
    status,
    observedAtMs,
  };
}

/** Feed one response's headers to the registered observer. Never throws: an
 *  observability sink must not be able to fail a market-data fetch. */
function observeRateLimit(
  resp: { status: number; headers: { get(name: string): string | null } },
  endpointClass: TradierEndpointClass,
): void {
  const observer = rateLimitObserver;
  if (!observer) return;
  try {
    observer(parseTradierRateLimitHeaders(resp.headers, endpointClass, resp.status, Date.now()));
  } catch {
    // A broken observer must never take the quote feed down with it.
  }
}

export interface TradierEquityQuote {
  symbol: string;
  /** Last trade price. */
  price: number;
  /** Trailing 24h volume (from Tradier `volume`). */
  volume: number;
  /** Absolute change since previous close. */
  change: number;
  /** Pct change since previous close (0..100 scale, matching Yahoo). */
  changePct: number;
  /**
   * TRA-1980 — L1 best bid/ask (and displayed sizes, in shares) when the Tradier
   * quote carries them. Optional: the Yahoo/Stooq fallbacks and older cached rows
   * have no book, so a consumer (the pre-trade liquidity gate) that reads these
   * must tolerate their absence. Zero/absent ⇒ "no L1 book for this quote".
   */
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  /**
   * TRA-2045 — the quote's own timestamp (ms epoch), parsed from Tradier
   * `trade_date`. Feeds the order-time stale-quote gate, which measures the
   * age of the quote AT THE BROKER at submit — distinct from the feed's local
   * receive time (`symbolState.lastUpdated`). Optional: the Yahoo/Stooq
   * fallbacks carry no broker timestamp, so a consumer must tolerate its
   * absence (absent ⇒ "freshness unprovable for this quote").
   */
  quoteTimeMs?: number;
}

interface TradierRawQuote {
  symbol: string;
  last?: number;
  change?: number;
  change_percentage?: number;
  volume?: number;
  // TRA-1980 — the L1 book is now consumed: it feeds the pre-trade liquidity gate.
  bid?: number;
  ask?: number;
  bidsize?: number;
  asksize?: number;
  trade_date?: number;
}

interface TradierQuotesEnvelope {
  quotes?: { quote?: TradierRawQuote | TradierRawQuote[]; unmatched_symbols?: { symbol?: string | string[] } } | string | null;
}

/**
 * TRA-3385 — Tradier spells some index tickers differently from the Yahoo-style
 * spelling the rest of the app uses. The mapping is applied REQUEST-SCOPED in
 * `getQuotes`/`getQuotesDetailed`: aliased on the way out to Tradier, keyed back
 * under whatever spelling the caller asked for. It must never be a blanket
 * rewrite — `readVix()` (market-review.ts, TRA-586) deliberately falls back to
 * `fetchQuote('VIX')`, so a result map that only ever carries `^VIX` would break
 * that fallback and silently re-open the regime-gate exposure TRA-2682 reports
 * as closed.
 *
 * Only spellings CONFIRMED against Tradier belong here, and "confirmed" means
 * the row came back as the RIGHT INSTRUMENT — not merely that the spelling
 * resolved. TRA-3412 measured the trap directly: the obvious bare spelling for
 * the Nasdaq Composite, `COMP`, DOES resolve on Tradier — to `Compass Inc`, a
 * ~$12 real-estate stock (`type:'stock'`). An alias graded on "a row came back"
 * would have silently repriced the Nasdaq Composite at $12.73 and fed that into
 * the watchlist, `symbolState` and the EOD report as a good quote. Grade a
 * candidate on `type`, `description` AND magnitude before it lands here.
 *
 * `:GIDS` is NOT a general grammar — it is part of this one symbol's
 * identifier. `IXIC:GIDS`, `SPX:GIDS` and `VIX:GIDS` were all measured
 * `unmatched` in the same batch, so do not derive a new alias from the shape.
 * Resolve unknown spellings empirically with
 * `GET /markets/search?q=<name>&indexes=true` (that is what produced
 * `COMP:GIDS`; `/markets/lookup?types=index` returned 0 for every query tried).
 */
const TRADIER_SYMBOL_ALIASES: Readonly<Record<string, string>> = {
  '^VIX': 'VIX',
  // TRA-3412 — measured on the production host 2026-08-12T20:29Z:
  // `COMP:GIDS` → type:'index' exch:'Q' desc:"NASDAQ Composite" last 26588.488
  // (vs NDX 29683.27 the same second — ratio 0.896, so it is the Composite and
  // not the Nasdaq-100). `^IXIC`, `IXIC`, `$IXIC`, `.IXIC`, `IXIC.X`, `COMPX`,
  // `$COMPX`, `$COMP` and `NASX` all came back in `unmatched_symbols`.
  '^IXIC': 'COMP:GIDS',
};

/** Result of {@link TradierStocksClient.getQuotesDetailed}: the quote map plus
 * the symbols Tradier itself declared unknown (`unmatched_symbols`), both keyed
 * by the caller's requested spelling. */
export interface TradierQuotesRead {
  quotes: Map<string, TradierEquityQuote>;
  /**
   * TRA-3385 (Remedy B) — the symbols this batch asked for that Tradier
   * reported back in `unmatched_symbols`, i.e. the ones the primary feed can
   * NEVER serve. Previously parsed and discarded, which made the permanently
   * un-servable class unmeasurable (TRA-2682). Mapped back to the requested
   * spelling. Note: absence from this list does not guarantee a quote row —
   * Tradier can also return a row without a usable `last` price.
   */
  unmatchedSymbols: string[];
}

interface TradierTimeSalesRow {
  /** "YYYY-MM-DD HH:MM" — broker-local (US/Eastern) wall-clock for that bar. */
  time?: string;
  /** Unix epoch in seconds — preferred for precise UTC conversion. */
  timestamp?: number;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
  vwap?: number;
}

interface TradierTimeSalesEnvelope {
  series?: { data?: TradierTimeSalesRow | TradierTimeSalesRow[] } | string | null;
}

interface TradierHistoryDay {
  /** "YYYY-MM-DD" — trading session date. */
  date?: string;
  open?: number;
  high?: number;
  low?: number;
  close?: number;
  volume?: number;
}

interface TradierHistoryEnvelope {
  history?: { day?: TradierHistoryDay | TradierHistoryDay[] } | string | null;
}

function asArray<T>(value: T | T[] | undefined | null | string): T[] {
  if (value == null || value === '') return [];
  if (Array.isArray(value)) return value;
  return [value as T];
}

/**
 * Format a `Date` as `YYYY-MM-DD HH:MM` in US/Eastern, the format Tradier
 * `/markets/timesales` expects for `start` / `end`. Rather than pull a
 * timezone library we approximate ET as UTC minus 4h (EDT) or 5h (EST). The
 * EOD report's existing offset helper would be overkill here — this is a
 * data-fetch convenience that tolerates the half-hour-late edge case at DST.
 */
function formatEt(d: Date): string {
  // Round-trip via locale options so DST is handled correctly.
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (k: string): string => parts.find((p) => p.type === k)?.value ?? '';
  let hour = get('hour');
  // Intl emits "24" for midnight under hourCycle h23; normalise to "00".
  if (hour === '24') hour = '00';
  return `${get('year')}-${get('month')}-${get('day')} ${hour}:${get('minute')}`;
}

/** Format a `Date` as `YYYY-MM-DD` in US/Eastern — the form Tradier
 * `/markets/history` expects for the `start` / `end` day bounds. */
function formatDay(d: Date): string {
  return formatEt(d).slice(0, 10);
}

/**
 * Tradier equity-data client. Reuses the same auth/base-URL plumbing as
 * `TradierOrderClient` and `TradierOptionsClient` but exposes only the
 * read-only endpoints the SignalEngine needs:
 *
 *   • `getQuotes(symbols[])` → multi-symbol last/change/volume snapshot.
 *   • `getMinuteBars(symbol, count)` → up to `count` 1-minute OHLCV bars,
 *     intraday only (Tradier returns the current and prior trading day).
 *   • `getDailyBars(symbol, count)` → up to `count` daily OHLCV bars from the
 *     `/markets/history` endpoint (TRA-586 — the non-Yahoo trend-MA fallback for
 *     the market-review regime read).
 *
 * No constructor-level account id — quotes / timesales don't need account
 * scope, only the API token.
 */
export class TradierStocksClient {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;

  constructor(apiToken: string, env: TradierEnv = 'sandbox') {
    this.baseUrl = tradierBaseUrl(env);
    this.headers = {
      Authorization: `Bearer ${apiToken}`,
      Accept: 'application/json',
    };
  }

  /**
   * Fetch quotes for many symbols in a single round-trip. Tradier supports a
   * comma-separated `symbols=` parameter; one HTTP call gets the entire
   * watchlist's quote in one shot. Symbols Tradier doesn't recognise come
   * back in `unmatched_symbols` — see {@link getQuotesDetailed} for the read
   * that surfaces them; this wrapper keeps the original map-only shape.
   *
   * TRA-3385 — Yahoo-style spellings in {@link TRADIER_SYMBOL_ALIASES} (today
   * only `^VIX`→`VIX`) are aliased on the wire and keyed back under the
   * requested spelling, so `getQuotes(['^VIX'])` resolves under `^VIX` and
   * `getQuotes(['VIX'])` still resolves under `VIX` (the TRA-586 fallback).
   */
  async getQuotes(symbols: readonly string[]): Promise<Map<string, TradierEquityQuote>> {
    return (await this.getQuotesDetailed(symbols)).quotes;
  }

  /** {@link getQuotes} plus the batch's `unmatched_symbols` (TRA-3385 Remedy B). */
  async getQuotesDetailed(symbols: readonly string[]): Promise<TradierQuotesRead> {
    const out = new Map<string, TradierEquityQuote>();
    if (symbols.length === 0) return { quotes: out, unmatchedSymbols: [] };
    // Wire spelling → the requested spelling(s) that map onto it. Requesting
    // both `^VIX` and `VIX` collapses to ONE wire symbol whose row answers both.
    const wireToRequested = new Map<string, string[]>();
    for (const requested of symbols) {
      const wire = TRADIER_SYMBOL_ALIASES[requested] ?? requested;
      const list = wireToRequested.get(wire);
      if (list) list.push(requested);
      else wireToRequested.set(wire, [requested]);
    }
    const url = `${this.baseUrl}/markets/quotes?symbols=${encodeURIComponent([...wireToRequested.keys()].join(','))}`;
    const resp = await fetch(url, { headers: this.headers });
    observeRateLimit(resp, 'quotes'); // TRA-4441 — before the throw: a refusal is the informative one.
    if (!resp.ok) {
      throw new Error(`Tradier quotes HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await resp.json()) as TradierQuotesEnvelope;
    if (!data.quotes || typeof data.quotes !== 'object') return { quotes: out, unmatchedSymbols: [] };
    const unmatchedSymbols = asArray(data.quotes.unmatched_symbols?.symbol)
      .filter((s): s is string => typeof s === 'string' && s.length > 0)
      .flatMap((wire) => wireToRequested.get(wire) ?? [wire]);
    for (const q of asArray(data.quotes.quote)) {
      if (!q.symbol || typeof q.last !== 'number' || q.last <= 0) continue;
      for (const requested of wireToRequested.get(q.symbol) ?? [q.symbol]) out.set(requested, {
        symbol: requested,
        price: q.last,
        volume: q.volume ?? 0,
        change: q.change ?? 0,
        changePct: q.change_percentage ?? 0,
        // TRA-1980 — carry the L1 book through for the pre-trade liquidity gate.
        // Only surfaced when Tradier actually returns them (a finite touch);
        // `bidsize`/`asksize` are passed through in the native units Tradier reports
        // them in, matching the TradierFeed convention (packages/engine/src/feed/
        // tradier-feed.ts) — the shadow-first slippage KPI (TRA-1981) reconciles the
        // modeled-vs-realized depth so any lot/share unit skew is calibrated, not
        // hard-coded here.
        ...(typeof q.bid === 'number' ? { bid: q.bid } : {}),
        ...(typeof q.ask === 'number' ? { ask: q.ask } : {}),
        ...(typeof q.bidsize === 'number' ? { bidSize: q.bidsize } : {}),
        ...(typeof q.asksize === 'number' ? { askSize: q.asksize } : {}),
        // TRA-2045 — Tradier reports the quote timestamp as `trade_date` in ms
        // epoch. Carry it through only when finite and positive; a 0/absent
        // value means the source didn't stamp the quote (fallback feeds).
        ...(typeof q.trade_date === 'number' && Number.isFinite(q.trade_date) && q.trade_date > 0
          ? { quoteTimeMs: q.trade_date }
          : {}),
      });
    }
    return { quotes: out, unmatchedSymbols };
  }

  /**
   * Fetch up to `count` 1-minute OHLCV bars for `symbol`, ending at "now".
   *
   * Tradier `/markets/timesales` returns intraday bars between `start` and
   * `end` US/Eastern timestamps. We request a 2× window (in calendar minutes)
   * to absorb gaps from the off-hours / pre/post-market filtering, then take
   * the trailing `count` rows that look like a 1-minute regular-session bar.
   *
   * Returns `[]` when Tradier 4xx-errors or the series is empty (e.g.
   * outside trading hours and no recent intraday data) so callers can fall
   * through to a backup feed.
   */
  async getMinuteBars(symbol: string, count: number): Promise<Candle[]> {
    if (!Number.isFinite(count) || count <= 0) return [];
    const end = new Date();
    // TRA-934 — size the lookback off RTH density, not a flat 2×-minute window.
    // `session_filter=open` returns only regular-session minutes (~390/day), so a
    // flat `count×2` minute window silently under-covers multi-day pulls: a 2400-bar
    // request spans ~3.3 calendar days ≈ 2.4 trading days ≈ 930 RTH minutes — far
    // short of 2400. That starved the SupertrendConfluence 1h MTF confirm to ~15
    // hourly bars, below the TRA-840 ≥30-bar floor, so `evaluateShadowRow` returned
    // null every tick and the shadow ledger never accrued. For deep pulls (>1 day)
    // widen the window to ~1.5 calendar days per trading day (weekend/holiday slack)
    // so the trailing `count` RTH bars are actually present; the shallow hot-scan
    // path (count<390) keeps the original flat window unchanged. Output is unchanged
    // for any caller already getting its full `count` — we only add older history
    // before the trailing `slice(-count)`, never remove bars.
    const FLAT_WINDOW_MS = count * 60_000 * 2;
    const RTH_MINUTES_PER_DAY = 390;
    const rthAwareMs = (count / RTH_MINUTES_PER_DAY * 1.5 + 1) * 24 * 60 * 60 * 1000;
    const start = new Date(
      end.getTime() - (count >= RTH_MINUTES_PER_DAY ? Math.max(FLAT_WINDOW_MS, rthAwareMs) : FLAT_WINDOW_MS),
    );
    const params = new URLSearchParams({
      symbol,
      interval: '1min',
      start: formatEt(start),
      end: formatEt(end),
      session_filter: 'open',
    });
    const url = `${this.baseUrl}/markets/timesales?${params}`;
    const resp = await fetch(url, { headers: this.headers });
    observeRateLimit(resp, 'timesales'); // TRA-4441 — before the throw: a refusal is the informative one.
    if (!resp.ok) {
      throw new Error(`Tradier timesales(${symbol}) HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await resp.json()) as TradierTimeSalesEnvelope;
    if (!data.series || typeof data.series !== 'object') return [];
    const rows = asArray(data.series.data);
    const currentMinuteStart = Math.floor(end.getTime() / 60_000) * 60_000;
    const candles: Candle[] = [];
    for (const r of rows) {
      const ts = typeof r.timestamp === 'number'
        ? r.timestamp * 1000
        : r.time ? Date.parse(`${r.time.replace(' ', 'T')}:00${currentEtIsoOffset(end)}`) : NaN;
      if (!Number.isFinite(ts) || ts >= currentMinuteStart) continue; // skip in-progress bar
      if (
        typeof r.open !== 'number' ||
        typeof r.high !== 'number' ||
        typeof r.low !== 'number' ||
        typeof r.close !== 'number'
      ) continue;
      const v = r.volume ?? 0;
      if (v <= 0) continue;
      candles.push({
        symbol,
        timestamp: ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: v,
      });
    }
    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles.slice(-count);
  }

  /**
   * TRA-586 — fetch up to `count` *daily* OHLCV bars for `symbol`, ending today.
   *
   * Tradier `/markets/history` returns end-of-day bars between `start` and `end`
   * (US/Eastern day bounds). We request a generous calendar window (~1.6
   * calendar days per trading day, plus a week of slack) so weekends/holidays
   * still leave `count` sessions, then take the trailing `count` rows.
   *
   * Unlike intraday timesales, daily bars are NOT volume-filtered — cash indices
   * report zero daily volume — so an index/ETF series is preserved intact.
   *
   * Returns `[]` when the series is empty; throws on a non-2xx response so the
   * caller can trip its breaker and fall through to a backup feed.
   */
  async getDailyBars(symbol: string, count: number): Promise<Candle[]> {
    if (!Number.isFinite(count) || count <= 0) return [];
    const end = new Date();
    const start = new Date(end.getTime() - (count * 1.6 + 7) * 24 * 60 * 60 * 1000);
    const params = new URLSearchParams({
      symbol,
      interval: 'daily',
      start: formatDay(start),
      end: formatDay(end),
    });
    const url = `${this.baseUrl}/markets/history?${params}`;
    const resp = await fetch(url, { headers: this.headers });
    observeRateLimit(resp, 'history'); // TRA-4441 — before the throw: a refusal is the informative one.
    if (!resp.ok) {
      throw new Error(`Tradier history(${symbol}) HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await resp.json()) as TradierHistoryEnvelope;
    if (!data.history || typeof data.history !== 'object') return [];
    const candles: Candle[] = [];
    for (const r of asArray(data.history.day)) {
      if (!r.date) continue;
      if (
        typeof r.open !== 'number' ||
        typeof r.high !== 'number' ||
        typeof r.low !== 'number' ||
        typeof r.close !== 'number'
      ) continue;
      // Anchor the daily bar at ET market-day midnight so the timestamp lands on
      // the correct calendar session regardless of the runtime's local zone.
      const ts = Date.parse(`${r.date}T00:00:00${currentEtIsoOffset(end)}`);
      if (!Number.isFinite(ts)) continue;
      candles.push({
        symbol,
        timestamp: ts,
        open: r.open,
        high: r.high,
        low: r.low,
        close: r.close,
        volume: r.volume ?? 0,
      });
    }
    candles.sort((a, b) => a.timestamp - b.timestamp);
    return candles.slice(-count);
  }
}

/** ISO-style ET offset (`-04:00` or `-05:00`) usable inside `Date.parse`. */
function currentEtIsoOffset(d: Date): string {
  const dst = isUsEasternDst(d);
  return dst ? '-04:00' : '-05:00';
}

function isUsEasternDst(d: Date): boolean {
  // DST in the US: 2nd Sun of March → 1st Sun of November (transition at 2 AM local).
  // Approximate at UTC-day granularity — sufficient for parsing minute bars.
  const year = d.getUTCFullYear();
  const march1Day = new Date(Date.UTC(year, 2, 1)).getUTCDay();
  const dstStart = new Date(Date.UTC(year, 2, 1 + ((7 - march1Day) % 7) + 7));
  const nov1Day = new Date(Date.UTC(year, 10, 1)).getUTCDay();
  const dstEnd = new Date(Date.UTC(year, 10, 1 + ((7 - nov1Day) % 7)));
  const t = d.getTime();
  return t >= dstStart.getTime() && t < dstEnd.getTime();
}
