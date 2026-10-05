import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TRA-5092 — `fetchDailyCandles` IS NO LONGER YAHOO-ONLY.
//
// Measured on bqb1 (TRA-5089): the Yahoo 429 breaker was open from 2026-10-01
// overnight through at least 2026-10-03T18:05Z, and every daily-bar consumer
// that had not wired its own Tradier leg starved for the whole 10-02 session
// (`candidates: 0` across 778/1,557 funnel passes). The fix folds the Tradier
// fallback into the feed function itself, so a consumer has to OPT OUT of
// resilience rather than opt in.
//
// The sweep-level positive control ("Yahoo breaker open AND evaluated > 0")
// lives in tra5065-sma200-tradier-fallback.test.ts; this file grades the feed
// function's own contract, including the `'none'` opt-out that the TRA-5065
// budget and census attribution depend on.
const provider = vi.hoisted(() => ({
  quote: vi.fn(async (_symbol: string) => ({}) as Record<string, unknown>),
  chart: vi.fn(async (_symbol: string, _opts: unknown) => ({ meta: {}, quotes: [] as unknown[] })),
}));

vi.mock('yahoo-finance2', () => ({
  default: class {
    quote = provider.quote;
    chart = provider.chart;
  },
}));

const {
  fetchDailyCandles,
  setTradierStocksFeedClient,
  __resetYahooBreakerForTests,
} = await import('./yahoo-feed.js');

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

/** Five valid Tradier `/markets/history` daily rows ending 2024-06-07. */
const TRADIER_HISTORY = {
  history: {
    day: [1, 2, 3, 4, 5].map((d) => ({
      date: `2024-06-0${d}`,
      open: 100 + d,
      high: 101 + d,
      low: 99 + d,
      close: 100.5 + d,
      volume: 1_000 * d,
    })),
  },
};

/** A Yahoo chart answer carrying usable daily quotes. */
const YAHOO_CHART = {
  meta: {},
  quotes: [1, 2, 3].map((d) => ({
    date: `2024-06-0${d}T13:30:00Z`,
    open: 50 + d,
    high: 51 + d,
    low: 49 + d,
    close: 50.5 + d,
    volume: 500 * d,
  })),
};

describe('TRA-5092 — fetchDailyCandles falls back to Tradier daily history', () => {
  let realFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;

  const historyRequests = (): string[] =>
    fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/markets/history'));

  beforeEach(() => {
    __resetYahooBreakerForTests();
    provider.chart.mockImplementation(async () => ({ meta: {}, quotes: [] }));
    realFetch = globalThis.fetch;
    fetchMock = vi.fn(async (_url: unknown) => jsonResponse(TRADIER_HISTORY));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    setTradierStocksFeedClient('tra5092-tok', 'production');
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
    setTradierStocksFeedClient('', 'production');
    vi.restoreAllMocks();
  });

  it('serves Tradier bars when the Yahoo leg yields zero bars', async () => {
    const bars = await fetchDailyCandles('AAPL', 5);
    expect(historyRequests()).toHaveLength(1);
    expect(bars).toHaveLength(5);
    // The bars are Tradier's (close 101.5…105.5), not Yahoo's.
    expect(bars[bars.length - 1]!.close).toBe(105.5);
    expect(bars.every((b) => b.symbol === 'AAPL')).toBe(true);
  });

  it('BOTH legs dead yields [], not a throw', async () => {
    fetchMock.mockImplementation(async () => jsonResponse({ history: null }));
    const bars = await fetchDailyCandles('AAPL', 5);
    expect(bars).toEqual([]);
  });

  it("fallback: 'none' never spends a Tradier request — the TRA-5065 opt-out contract", async () => {
    const bars = await fetchDailyCandles('AAPL', 5, 'crumb', 'none');
    expect(bars).toEqual([]);
    expect(historyRequests()).toHaveLength(0);
  });

  it('a served Yahoo leg costs no Tradier spend', async () => {
    provider.chart.mockImplementation(async () => YAHOO_CHART);
    const bars = await fetchDailyCandles('AAPL', 5);
    expect(bars).toHaveLength(3);
    expect(bars[bars.length - 1]!.close).toBe(53.5);
    expect(historyRequests()).toHaveLength(0);
  });

  it('an index symbol is refused by Tradier admission without an HTTP request', async () => {
    // `^GSPC` must not be sent to `/markets/history` — the admission gate
    // (TRA-4987) refuses index prefixes before the spend meter.
    const bars = await fetchDailyCandles('^GSPC', 5);
    expect(bars).toEqual([]);
    expect(historyRequests()).toHaveLength(0);
  });
});
