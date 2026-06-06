// TRA-596 (TRA-595 C1) — upcoming-earnings calendar feed.
//
// Provider: **Finnhub** `/calendar/earnings` (free tier).
//   GET https://finnhub.io/api/v1/calendar/earnings?from=YYYY-MM-DD&to=YYYY-MM-DD&token=…
// One round-trip returns every scheduled earnings event in the date window for
// the whole market; the caller filters down to its active symbol universe, so a
// universe of N symbols still costs a single HTTP call.
//
// Why Finnhub over the existing Tradier plumbing: Tradier's corporate-calendar
// lives behind its *beta* `/markets/fundamentals/calendars` endpoint, which
// requires a brokerage account with special fundamentals entitlement and is not
// available on the sandbox tier we run by default. Finnhub exposes a stable,
// documented, free earnings-calendar endpoint with a flat JSON shape — the right
// low-friction source for "is there an earnings event soon" signalling. The
// client is deliberately isolated behind `EarningsCalendarClient` so a future
// swap (Twelve Data, Tradier beta) only touches this file.

/** A single scheduled earnings event, normalised from the provider payload. */
export interface EarningsEvent {
  symbol: string;
  /** Event date, `YYYY-MM-DD` (provider-local trading date). */
  date: string;
  /** Consensus EPS estimate, when the provider supplies one. */
  epsEstimate?: number | null;
  /** Reporting time hint: `bmo` (before open), `amc` (after close), or `dmh`/''. */
  hour?: string;
}

/**
 * Whole-calendar-days from `asOf` until `dateIso` (`YYYY-MM-DD`), computed at
 * UTC-midnight granularity so the result is a clean integer independent of the
 * runtime's local zone or the time-of-day inside `asOf`.
 *
 * Returns `0` when the event is today, a positive count for a future event, a
 * negative count for a past one, and `null` when `dateIso` is unparseable.
 */
export function daysUntil(dateIso: string, asOf: number = Date.now()): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateIso)) return null;
  const eventMs = Date.parse(`${dateIso}T00:00:00Z`);
  if (!Number.isFinite(eventMs)) return null;
  const asOfDay = new Date(asOf).toISOString().slice(0, 10);
  const asOfMs = Date.parse(`${asOfDay}T00:00:00Z`);
  if (!Number.isFinite(asOfMs)) return null;
  return Math.round((eventMs - asOfMs) / 86_400_000);
}

/**
 * Pick the next (soonest, not-yet-past) earnings date for a symbol from a list
 * of candidate events, as of `asOf`. "Not past" means `daysUntil >= 0` — an
 * event dated today still counts. Returns the `YYYY-MM-DD` of the nearest such
 * event, or `null` when every event is in the past / the list is empty.
 */
export function nextEarningsDate(
  events: readonly EarningsEvent[],
  asOf: number = Date.now(),
): string | null {
  let best: string | null = null;
  let bestDays = Infinity;
  for (const ev of events) {
    const d = daysUntil(ev.date, asOf);
    if (d === null || d < 0) continue;
    if (d < bestDays) {
      bestDays = d;
      best = ev.date;
    }
  }
  return best;
}

interface FinnhubEarningsRow {
  symbol?: unknown;
  date?: unknown;
  epsEstimate?: unknown;
  hour?: unknown;
}

interface FinnhubEarningsEnvelope {
  earningsCalendar?: FinnhubEarningsRow[] | null;
}

/**
 * Parse a Finnhub `/calendar/earnings` payload into normalised `EarningsEvent`s.
 * Pure and defensive: rows missing a usable `symbol` or a `YYYY-MM-DD` `date`
 * are dropped, symbols are upper-cased, and a non-object / empty payload yields
 * `[]`. Kept separate from the HTTP client so the parse + days-until logic is
 * unit-testable without a network round-trip.
 */
export function parseFinnhubEarnings(payload: unknown): EarningsEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const rows = (payload as FinnhubEarningsEnvelope).earningsCalendar;
  if (!Array.isArray(rows)) return [];
  const out: EarningsEvent[] = [];
  for (const r of rows) {
    if (!r || typeof r !== 'object') continue;
    const symbol = typeof r.symbol === 'string' ? r.symbol.trim().toUpperCase() : '';
    const date = typeof r.date === 'string' ? r.date.trim() : '';
    if (!symbol || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    out.push({
      symbol,
      date,
      epsEstimate: typeof r.epsEstimate === 'number' ? r.epsEstimate : null,
      hour: typeof r.hour === 'string' ? r.hour : '',
    });
  }
  return out;
}

/** `YYYY-MM-DD` for `ms` in UTC — the format Finnhub's `from`/`to` expects. */
function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export interface EarningsWindowOptions {
  /** Calendar days back from `asOf` for the window's `from` bound. Default 0. */
  fromDays?: number;
  /** Calendar days forward from `asOf` for the window's `to` bound. Default 120. */
  toDays?: number;
  /** Anchor for the window (epoch ms). Default `Date.now()`. */
  asOf?: number;
}

/**
 * Finnhub earnings-calendar client. Read-only; only needs an API token.
 *
 * `getUpcomingEarnings(symbols)` fetches the full calendar for a forward window
 * in one call and returns a `symbol → next-earnings-date` map restricted to the
 * requested universe. Symbols with no scheduled event in the window are simply
 * absent from the map (callers treat that as "unknown").
 */
export class EarningsCalendarClient {
  private readonly baseUrl: string;
  private readonly apiToken: string;

  constructor(apiToken: string, baseUrl = 'https://finnhub.io/api/v1') {
    this.apiToken = apiToken;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Fetch + parse the raw earnings window (all symbols Finnhub returns). */
  async fetchWindow(opts: EarningsWindowOptions = {}): Promise<EarningsEvent[]> {
    const asOf = opts.asOf ?? Date.now();
    const fromDays = opts.fromDays ?? 0;
    const toDays = opts.toDays ?? 120;
    const from = isoDay(asOf - fromDays * 86_400_000);
    const to = isoDay(asOf + toDays * 86_400_000);
    const params = new URLSearchParams({ from, to, token: this.apiToken });
    const url = `${this.baseUrl}/calendar/earnings?${params}`;
    const resp = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!resp.ok) {
      throw new Error(
        `Finnhub earnings HTTP ${resp.status}: ${(await resp.text().catch(() => '')).slice(0, 200)}`,
      );
    }
    return parseFinnhubEarnings(await resp.json());
  }

  /**
   * Return a `symbol → next-earnings-date (YYYY-MM-DD)` map for `symbols`,
   * computed from a single forward-window fetch. Only symbols with a
   * not-yet-past event in the window appear in the result.
   */
  async getUpcomingEarnings(
    symbols: readonly string[],
    opts: EarningsWindowOptions = {},
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (symbols.length === 0) return out;
    const asOf = opts.asOf ?? Date.now();
    const want = new Set(symbols.map((s) => s.trim().toUpperCase()));
    const events = await this.fetchWindow(opts);
    const bySymbol = new Map<string, EarningsEvent[]>();
    for (const ev of events) {
      if (!want.has(ev.symbol)) continue;
      const list = bySymbol.get(ev.symbol);
      if (list) list.push(ev);
      else bySymbol.set(ev.symbol, [ev]);
    }
    for (const [symbol, list] of bySymbol) {
      const next = nextEarningsDate(list, asOf);
      if (next) out.set(symbol, next);
    }
    return out;
  }
}
