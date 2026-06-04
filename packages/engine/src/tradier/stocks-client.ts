import type { Candle } from '@trading-app/shared';
import { tradierBaseUrl, type TradierEnv } from './order-client.js';

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
}

interface TradierRawQuote {
  symbol: string;
  last?: number;
  change?: number;
  change_percentage?: number;
  volume?: number;
  // Useful for diagnostics; not consumed today:
  bid?: number;
  ask?: number;
  trade_date?: number;
}

interface TradierQuotesEnvelope {
  quotes?: { quote?: TradierRawQuote | TradierRawQuote[]; unmatched_symbols?: { symbol?: string | string[] } } | string | null;
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
   * back in `unmatched_symbols` and are simply omitted from the result map.
   */
  async getQuotes(symbols: readonly string[]): Promise<Map<string, TradierEquityQuote>> {
    const out = new Map<string, TradierEquityQuote>();
    if (symbols.length === 0) return out;
    const url = `${this.baseUrl}/markets/quotes?symbols=${encodeURIComponent(symbols.join(','))}`;
    const resp = await fetch(url, { headers: this.headers });
    if (!resp.ok) {
      throw new Error(`Tradier quotes HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`);
    }
    const data = (await resp.json()) as TradierQuotesEnvelope;
    if (!data.quotes || typeof data.quotes !== 'object') return out;
    for (const q of asArray(data.quotes.quote)) {
      if (!q.symbol || typeof q.last !== 'number' || q.last <= 0) continue;
      out.set(q.symbol, {
        symbol: q.symbol,
        price: q.last,
        volume: q.volume ?? 0,
        change: q.change ?? 0,
        changePct: q.change_percentage ?? 0,
      });
    }
    return out;
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
    const start = new Date(end.getTime() - count * 60_000 * 2);
    const params = new URLSearchParams({
      symbol,
      interval: '1min',
      start: formatEt(start),
      end: formatEt(end),
      session_filter: 'open',
    });
    const url = `${this.baseUrl}/markets/timesales?${params}`;
    const resp = await fetch(url, { headers: this.headers });
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
