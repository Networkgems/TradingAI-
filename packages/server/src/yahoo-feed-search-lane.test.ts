import { describe, it, expect, vi, beforeEach } from 'vitest';

// TRA-4805 — the news sweep must not be silenced by the QUOTE feed's breaker.
//
// The incident: `/api/health/news-catalyst-signals` reported `queriesAttempted
// 25 / queriesSucceeded 0`, `reason "all market-news queries failed"`, for three
// consecutive sessions (2026-09-18, 09-21, 09-22) after 45-of-68 healthy runs on
// 09-17. It was triaged three times — as a scheduler gap, as a regression in the
// TRA-4682 loop cap, and as a vendor credential/quota/billing event — and all
// three were wrong, because the surface could not express the actual cause:
//
//   NOT ONE HTTP REQUEST WAS ISSUED.
//
// `yahoo-feed.ts` had ONE global `rateLimitedUntil`, and `withRetry` returns
// `null` before calling `fn()` while it is set. The ~577-symbol `fetchQuotes`
// secondary fan-out sustains ~6.3 calls/s against Yahoo's crumb endpoint on
// Render's shared egress, so the 90s cooldown is re-tripped the instant it
// lapses. bqb1's own coalesced log line reports single breaker-open episodes of
// 55,926s / 39,246s / 125,707s (15.5h / 10.9h / 34.9h) on the failing sessions,
// against 11s / 22s / 39s / 51s on 09-17, the last healthy one. The onset is a
// DUTY CYCLE crossing 100%, which is why no deploy correlates with it and why
// earlier episodes "self-healed" (a restart zeroes the flag).
//
// `yf.search()` — the only call `fetchMarketNews` makes — does not request a
// crumb (`node_modules/yahoo-finance2/esm/src/modules/search.js` sets no
// `needsCrumb`, versus `quote.js:130 needsCrumb: true`), and the free keyless
// endpoint was answering throughout (measured off-box 2026-09-23 with the
// identical client config: 10 headlines each, ~260ms).
//
// So: a separate breaker lane for `search`, and a per-query failure census so
// "we never asked" can never again be reported as "the feed is down".

const searchMock = vi.fn();
const chartMock = vi.fn();

vi.mock('yahoo-finance2', () => ({
  default: class {
    search = (...args: unknown[]) => searchMock(...args);
    chart = (...args: unknown[]) => chartMock(...args);
  },
}));

const {
  fetchMarketNews,
  fetchDailyCandles,
  tripYahooBreakerFromExternal,
  isYahooBreakerOpen,
  __resetYahooBreakerForTests,
  getFeedDegradationState,
} = await import('./yahoo-feed.js');
const { describeFeedFailure, fetchCatalystMetrics } = await import('./news-catalyst-source.js');

const UNIVERSE = ['AAA', 'BBB', 'CCC', 'DDD', 'EEE', 'FFF'];

const oneHeadline = (sym: string) => ({
  news: [
    {
      title: `${sym} headline`,
      link: `https://example.test/${sym}`,
      publisher: 'Test Wire',
      providerPublishTime: new Date(Date.UTC(2026, 8, 23, 13, 0, 0)),
    },
  ],
});

/** 22 ascending daily bars — enough for `fetchCatalystMetrics` to price a name. */
const dailyBars = () => ({
  quotes: Array.from({ length: 22 }, (_, i) => ({
    date: new Date(Date.UTC(2026, 7, 1 + i)),
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100 + i,
    volume: 1_000_000,
  })),
});

beforeEach(() => {
  searchMock.mockReset();
  chartMock.mockReset();
  chartMock.mockImplementation(async () => dailyBars());
  __resetYahooBreakerForTests();
});

describe('news sweep runs on its own breaker lane (TRA-4805)', () => {
  it('THE INCIDENT: an open crumb-lane breaker does not stop a single news query', async () => {
    searchMock.mockImplementation(async (q: string) => oneHeadline(q));

    // Exactly what the quote fan-out does to the shared breaker in prod.
    tripYahooBreakerFromExternal('quote(^NSEI)', 'Failed to get crumb, status 429, statusText: Too Many Requests');
    expect(isYahooBreakerOpen('crumb')).toBe(true);

    const res = await fetchMarketNews(UNIVERSE);

    // Pre-fix this read 6 / 0 / `breakerOpen: 6` — the shape that sat on the
    // health route for three sessions.
    expect(res.queriesAttempted).toBe(UNIVERSE.length);
    expect(res.queriesSucceeded).toBe(UNIVERSE.length);
    expect(searchMock).toHaveBeenCalledTimes(UNIVERSE.length);
    expect(res.failures).toEqual({ breakerOpen: 0, rateLimited: 0, timeout: 0, error: 0 });
    expect(res.firstFailureMessage).toBeNull();

    // …and the crumb lane is untouched. This is a lane split, not a bypass of
    // the quote-side backoff that TRA-1391 needs to stay in force.
    expect(isYahooBreakerOpen('crumb')).toBe(true);
  });

  it('a 429 raised BY a search call still opens the search lane — and only it', async () => {
    searchMock.mockImplementation(async () => {
      throw new Error('search quota: 429 Too Many Requests');
    });

    const res = await fetchMarketNews(UNIVERSE);

    expect(res.queriesSucceeded).toBe(0);
    expect(isYahooBreakerOpen('search')).toBe(true);
    // The news sweep's own refusal must not back off the quote path, which is
    // the money path and spends a different budget.
    expect(isYahooBreakerOpen('crumb')).toBe(false);

    // The first batch asks and is refused; every later batch short-circuits on
    // the lane this sweep just opened. Both causes are counted, separately.
    const f = res.failures!;
    expect(f.rateLimited).toBeGreaterThan(0);
    expect(f.breakerOpen).toBeGreaterThan(0);
    expect(f.rateLimited + f.breakerOpen + f.timeout + f.error).toBe(res.queriesAttempted);
  });

  it('classifies a plain failure as `error`, not as a rate limit or a starved call', async () => {
    searchMock.mockImplementation(async () => {
      throw new Error('socket hang up');
    });

    const res = await fetchMarketNews(['AAA']);

    expect(res.failures).toEqual({ breakerOpen: 0, rateLimited: 0, timeout: 0, error: 1 });
    expect(res.firstFailureMessage).toBe('error: socket hang up');
    expect(isYahooBreakerOpen('search')).toBe(false);
  });

  it('reports both lanes on the ops surface, without folding them together', async () => {
    tripYahooBreakerFromExternal('quote(DOL.TO)', 'Failed to get crumb, status 429');

    const y = getFeedDegradationState().yahoo;
    expect(y.open).toBe(true);
    expect(y.blockedUntil).not.toBeNull();
    // The field that would have dated this outage on day one.
    expect(y.searchOpen).toBe(false);
    expect(y.searchBlockedUntil).toBeNull();
  });
});

describe('catalyst price enrichment runs on the chart lane (TRA-4805)', () => {
  it('still prices a name while the crumb-lane breaker is open', async () => {
    tripYahooBreakerFromExternal('quote(^NSEI)', 'Failed to get crumb, status 429');

    const m = await fetchCatalystMetrics('AAPL');

    // Pre-fix: `fetchDailyCandles` short-circuited to `[]`, so this returned
    // `price: null` → `hasUsableQuote` false → quote coverage under the 0.50
    // floor → the run is degraded even with the news feed restored. That is the
    // second door `healthyRuns: 0` was coming through.
    expect(chartMock).toHaveBeenCalledTimes(1);
    expect(m.price).toBe(121);
    expect(m.avgDollarVol).not.toBeNull();
  });

  it('leaves every OTHER `fetchDailyCandles` caller on the crumb lane, unchanged', async () => {
    tripYahooBreakerFromExternal('quote(^NSEI)', 'Failed to get crumb, status 429');

    // The default lane is `crumb`, so the SMA-200 scan / minute-bar fallback /
    // market-review trend pull keep backing off exactly as TRA-1391 requires.
    // Widening them is a volume decision that wants its own measurement.
    expect(await fetchDailyCandles('SPY', 22)).toEqual([]);
    expect(chartMock).not.toHaveBeenCalled();
  });
});

describe('the run `reason` names the cause (TRA-4805)', () => {
  it('says we never asked, instead of "all market-news queries failed"', () => {
    const reason = describeFeedFailure({
      items: [],
      queriesAttempted: 25,
      queriesSucceeded: 0,
      failures: { breakerOpen: 25, rateLimited: 0, timeout: 0, error: 0 },
      firstFailureMessage: 'breaker_open: search breaker open — no request issued',
    });

    expect(reason).toContain('breaker_open x25');
    expect(reason).toContain('no request issued');
    // Three triages read the old sentence and drew three different wrong
    // conclusions. It must not survive as the whole message.
    expect(reason).not.toBe('all market-news queries failed');
  });

  it('falls back verbatim when the census was NOT MEASURED — never fabricates an attribution', () => {
    expect(
      describeFeedFailure({ items: [], queriesAttempted: 25, queriesSucceeded: 0 }),
    ).toBe('all market-news queries failed');
  });
});
