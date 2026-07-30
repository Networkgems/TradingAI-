import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TRA-2643 — END-TO-END control for the claim the whole remedy rests on:
// `fetchQuotes` fans out in CALLER ORDER, so a caller that sorts by importance
// actually keeps the important symbols when the deadline truncates.
//
// That claim is currently three order-preserving steps in two scopes —
// `symbols` → `partitionCachedQuotes().stale` → `remaining = stale.filter(...)`
// — and NOTHING asserts it. A future `new Set(...)` round-trip, a `.sort()`, or
// a `Promise.all` over a map would destroy it silently, and the only symptom
// would be the wrong two thirds of the tape going unpriced on a degraded tick:
// a data-quality incident with no stack trace and no failing test.
//
// This file lives apart from `yahoo-feed.test.ts` because it needs two things
// that file must not have: a mocked `yahoo-finance2` module, and a
// `FEED_FANOUT_BUDGET_MS` set BEFORE the module is imported (the constant is
// read once in a module-level IIFE, so `vi.stubEnv` after import is inert).

const quoteCalls: string[] = [];

vi.mock('yahoo-finance2', () => {
  class FakeYahooFinance {
    async quote(symbol: string): Promise<{ regularMarketPrice: number }> {
      quoteCalls.push(symbol);
      return { regularMarketPrice: 100 };
    }
    async chart(): Promise<{ quotes: [] }> { return { quotes: [] }; }
    async search(): Promise<{ news: [] }> { return { news: [] }; }
    async quoteSummary(): Promise<null> { return null; }
  }
  return { default: FakeYahooFinance };
});

// Stooq is the last leg of `fetchSecondaryQuote`'s cascade. Stub it so a symbol
// the fan-out never reaches cannot be rescued by a real network call — an
// un-stubbed Stooq would make this test depend on the internet and could hand
// back a price for a symbol we are asserting went UNPRICED.
vi.mock('./stooq-feed.js', () => ({ fetchStooqQuote: async () => null }));

// 1s budget / 200ms sleep / 5 per batch. The ceiling formula gives 25, and the
// loop checks the deadline BEFORE each batch, so ~5-6 batches land. The exact
// count is timing-dependent and deliberately NOT asserted — every assertion
// below is about ORDER, which is timing-independent.
process.env['FEED_FANOUT_BUDGET_MS'] = '1000';

const { fetchQuotes, formatDroppedSymbols, secondaryFanoutCeiling } = await import('./yahoo-feed.js');

// DESCENDING on purpose. An ASCENDING universe is lexically sorted already, so
// a `.sort()` inserted into the fan-out would be a NO-OP against it and the
// prefix assertion below would pass over a genuinely broken implementation —
// measured, not hypothesised: with `SYM000…SYM119` the negative control (a
// `[...new Set(...)].sort()` on `remaining`) left this suite GREEN on the very
// assertion that exists to catch it. A control has to CONTAIN what it detects.
const UNIVERSE = Array.from({ length: 120 }, (_, i) => `SYM${String(119 - i).padStart(3, '0')}`);

describe('fetchQuotes fan-out order (TRA-2643)', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    quoteCalls.length = 0;
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => { warn.mockRestore(); });

  it('sanity: this harness really does exhaust the budget', () => {
    // A test that proved "order is preserved" over a fan-out that completed
    // would be a control that does not contain what it detects. The ceiling must
    // be below the universe size for the truncation to happen at all.
    expect(secondaryFanoutCeiling(1_000, 200, 5)).toBe(25);
    expect(UNIVERSE.length).toBeGreaterThan(25);
  });

  it('prices a PREFIX of the caller order and drops the SUFFIX — never an arbitrary subset', async () => {
    const results = await fetchQuotes(UNIVERSE, { maxStaleMs: 0 });

    // Positive control: the truncation fired, and it left work undone. Without
    // this, an empty `priced` and a full `priced` would both pass the prefix
    // check below (both are trivially prefixes).
    expect(results.size).toBeGreaterThan(0);
    expect(results.size).toBeLessThan(UNIVERSE.length);

    const priced = UNIVERSE.filter(s => results.has(s));
    // THE INVARIANT: the priced set is exactly the first N of the caller's
    // array. If any step between `symbols` and `remaining` ever reorders, this
    // is the assertion that fails.
    expect(priced).toEqual(UNIVERSE.slice(0, priced.length));

    // And it is the same prefix the fan-out actually REQUESTED, in order — so
    // the invariant holds at the network boundary, not just in the result map.
    expect(quoteCalls).toEqual(UNIVERSE.slice(0, quoteCalls.length));
  });

  it('the truncation warning NAMES what it dropped, starting with the first one lost', async () => {
    const results = await fetchQuotes(UNIVERSE, { maxStaleMs: 0 });
    const firstDropped = UNIVERSE.filter(s => !results.has(s))[0];

    const line = warn.mock.calls
      .map(c => String(c[0]))
      .find(l => l.includes('symbols failed'));
    expect(line).toBeDefined();
    expect(line).toContain('feed budget exhausted');
    // TRA-2627 landed the COUNT. "we dropped 414 symbols" is not actionable;
    // "we dropped ^VIX" is. The first name in the drop is the marginal symbol —
    // the one the budget just failed to buy.
    expect(line).toContain(firstDropped!);
    expect(line).toMatch(/\(\+\d+ more\)/);   // elided, not a 414-symbol wall
  });

  it('a caller that reorders by importance gets its important symbols priced', async () => {
    // The end-to-end statement of the remedy: same universe, ^VIX moved from the
    // far tail (its measured position: index 510 of 614 on bqb1) to the front,
    // and the outcome flips from unpriced to priced with no extra requests.
    const withVixLast = [...UNIVERSE, '^VIX'];
    const tailFirst = await fetchQuotes(withVixLast, { maxStaleMs: 0 });
    expect(tailFirst.has('^VIX')).toBe(false);

    quoteCalls.length = 0;
    const prioritized = ['^VIX', ...UNIVERSE];
    const vixFirst = await fetchQuotes(prioritized, { maxStaleMs: 0 });
    expect(vixFirst.has('^VIX')).toBe(true);

    // No extra coverage was bought — the same budget, the same ceiling. This is
    // an ordering change, not a widening, and that is the entire reason it does
    // not re-open TRA-1940 or the Yahoo per-IP 429.
    expect(vixFirst.size).toBeLessThan(prioritized.length);
  });
});

describe('formatDroppedSymbols (TRA-2643)', () => {
  it('returns EMPTY for an empty drop so the existing line stays byte-identical', () => {
    // Per-symbol provider misses are not a truncation; that line must not grow a
    // dangling "— dropped".
    expect(formatDroppedSymbols([])).toBe('');
  });

  it('names every symbol when the drop fits under the sample', () => {
    expect(formatDroppedSymbols(['^VIX', 'USO'])).toBe(' — dropped ^VIX,USO');
  });

  it('elides past the sample and says how many it elided', () => {
    const out = formatDroppedSymbols(['A', 'B', 'C', 'D'], 2);
    expect(out).toBe(' — dropped A,B (+2 more)');
  });

  it('degenerate: a zero/negative sample still reports the count rather than lying', () => {
    expect(formatDroppedSymbols(['A', 'B'], 0)).toBe(' — dropped  (+2 more)');
    expect(formatDroppedSymbols(['A', 'B'], -5)).toBe(' — dropped  (+2 more)');
  });
});
