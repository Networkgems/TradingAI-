import { describe, it, expect, vi, beforeEach } from 'vitest';

// TRA-2088 — `fetchMarketNews` used to end with
//   items.sort(recency).slice(0, RESULT_CAP)
// over ONE flat list pooled across all 25 catalyst symbols. That is a biased
// sampler, not a bound: it allocates the 60 slots by NEWS VOLUME. Measured on the
// TRA-2064 run, `headlines=60 -> 13 mapped candidates` — 12 of 25 names were
// structurally unreachable, crowded out by NVDA/AAPL/TSLA rather than by having
// no fresh catalyst.
//
// These tests pin the crowding-out case. The load-bearing assertion is a COUNT
// OF DISTINCT SYMBOLS REACHED, not the headline count: the old code and the new
// code both return exactly 60 headlines here, so `items.length` reads IDENTICALLY
// in the fixed and the broken state. Only symbol coverage separates them.

const searchMock = vi.fn();

vi.mock('yahoo-finance2', () => ({
  default: class {
    search = (...args: unknown[]) => searchMock(...args);
  },
}));

const { fetchMarketNews } = await import('./yahoo-feed.js');

/** 24 loud names, then one quiet one — mirrors the shape of a real morning. */
const NOISY = Array.from({ length: 24 }, (_, i) => `LOUD${i}`);
const QUIET = 'QUIET';
const UNIVERSE = [...NOISY, QUIET];

const BASE = Date.UTC(2026, 6, 21, 13, 0, 0);

/** `n` headlines for `sym`, each `minutesAgo` older than the last. */
const headlines = (sym: string, n: number, oldestMinutesAgo: number) =>
  Array.from({ length: n }, (_, i) => ({
    title: `${sym} headline ${i}`,
    link: `https://example.test/${sym}/${i}`,
    publisher: 'Test Wire',
    providerPublishTime: new Date(BASE - (oldestMinutesAgo + i) * 60_000),
  }));

beforeEach(() => {
  searchMock.mockReset();
  // Every loud name gets 12 fresh headlines, all STRICTLY MORE RECENT than the
  // quiet name's only headline. Under a global recency sort the 24 loud names
  // supply 288 candidates for 60 slots, so QUIET is evicted with certainty.
  searchMock.mockImplementation(async (q: string) =>
    q === QUIET ? { news: headlines(QUIET, 1, 300) } : { news: headlines(q, 12, 1) },
  );
});

describe('fetchMarketNews per-symbol allocation (TRA-2088)', () => {
  it('does not let one noisy symbol evict a quiet symbol\'s single fresh headline', async () => {
    const { items } = await fetchMarketNews(UNIVERSE);

    // THE separating assertion. Old code: 0 QUIET headlines. New code: 1.
    expect(items.filter(i => i.title.startsWith(QUIET))).toHaveLength(1);
  });

  it('guarantees EVERY symbol in the universe a slot for its freshest headline', async () => {
    const { items } = await fetchMarketNews(UNIVERSE);

    const reached = new Set(items.map(i => i.title.split(' ')[0]));
    expect(reached.size).toBe(UNIVERSE.length);
    for (const sym of UNIVERSE) expect(reached.has(sym)).toBe(true);

    // Each symbol's admitted headline must be ITS freshest (rank 0), not an
    // arbitrary one — a round-robin that drained buckets unsorted would still
    // pass the coverage count above.
    for (const sym of NOISY) {
      expect(items.some(i => i.title === `${sym} headline 0`)).toBe(true);
    }
  });

  it('holds the global cap and stays recency-ordered', async () => {
    const { items } = await fetchMarketNews(UNIVERSE);

    expect(items.length).toBeLessThanOrEqual(60);
    // Guard against the cap being quietly removed to "fix" coverage: 25 symbols
    // x top-3 is 75 candidates, so the cap must actually bind here.
    expect(items.length).toBe(60);

    const times = items.map(i => i.publishedAt);
    expect([...times].sort((a, b) => b.localeCompare(a))).toEqual(times);
  });

  it('caps any single symbol at top-K so no name can monopolise the feed', async () => {
    const { items } = await fetchMarketNews(UNIVERSE);

    for (const sym of UNIVERSE) {
      expect(items.filter(i => i.title.startsWith(`${sym} `)).length).toBeLessThanOrEqual(3);
    }
  });

  // Out of scope for TRA-2088's 25 names, but pins the guarantee so it does not
  // silently degrade into a query-ORDER bias the day someone widens the universe.
  it('keeps the every-symbol guarantee when the universe exceeds the global cap', async () => {
    const wide = Array.from({ length: 80 }, (_, i) => `SYM${i}`);
    searchMock.mockImplementation(async (q: string) => ({ news: headlines(q, 12, 1) }));

    const { items } = await fetchMarketNews(wide);

    const reached = new Set(items.map(i => i.title.split(' ')[0]));
    expect(reached.size).toBe(wide.length);
    // Still bounded — one slot per symbol, not 80 x 3.
    expect(items).toHaveLength(80);
  }, 30_000);

  // These two counters are load-bearing for TRA-2081 grading — a regression here
  // makes a feed outage read as a quiet news day again (TRA-2064).
  it('leaves queriesAttempted / queriesSucceeded observability intact', async () => {
    const { queriesAttempted, queriesSucceeded } = await fetchMarketNews(UNIVERSE);

    expect(queriesAttempted).toBe(UNIVERSE.length);
    expect(queriesSucceeded).toBe(UNIVERSE.length);
  });

  // Small universe here on purpose: `withRetry` does REAL 1s/2s backoff and every
  // query exhausts all 3 attempts, so the full 25 would run ~27s of pure sleeping.
  it('still separates a total feed outage from a quiet day', async () => {
    searchMock.mockImplementation(async () => {
      throw new Error('feed down');
    });

    const { items, queriesAttempted, queriesSucceeded } = await fetchMarketNews(NOISY.slice(0, 3));

    expect(items).toHaveLength(0);
    expect(queriesAttempted).toBe(3);
    expect(queriesSucceeded).toBe(0); // vs a quiet day: succeeded === attempted
  }, 20_000);

  it('de-duplicates a headline returned by more than one symbol query', async () => {
    const shared = {
      title: 'shared headline',
      link: 'https://example.test/shared',
      publisher: 'Test Wire',
      providerPublishTime: new Date(BASE),
    };
    searchMock.mockImplementation(async () => ({ news: [shared] }));

    const { items } = await fetchMarketNews(UNIVERSE);
    expect(items).toHaveLength(1);
  });
});
