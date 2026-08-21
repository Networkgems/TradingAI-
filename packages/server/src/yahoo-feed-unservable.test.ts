import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// TRA-3804 — the skip list end to end, through the REAL `fetchQuotes` cascade.
//
// The providers are mocked at the module boundary rather than at `globalThis.fetch`
// for Yahoo, because the point of this file is to count *calls into the cascade*:
// "did `chartQuote` run for SBLX this tick?" is the acceptance criterion, and a
// spy on `yf.chart` answers it directly. Each mock resolves with an unusable
// payload rather than throwing, so a definitive failure costs no `withRetry`
// backoff and the suite stays fast — the retry ladder itself is not what is
// under test here, its ABSENCE on a skipped symbol is.
const provider = vi.hoisted(() => ({
  quote: vi.fn(async (_symbol: string) => ({}) as Record<string, unknown>),
  chart: vi.fn(async (_symbol: string, _opts: unknown) => ({ meta: {}, quotes: [] })),
  stooq: vi.fn(async (_symbol: string) => null),
}));

vi.mock('yahoo-finance2', () => ({
  default: class {
    quote = provider.quote;
    chart = provider.chart;
  },
}));

vi.mock('./stooq-feed.js', () => ({
  fetchStooqQuote: provider.stooq,
  toStooqSymbol: (s: string) => s.toLowerCase() + '.us',
  parseStooqCsv: () => null,
}));

const {
  fetchQuotes,
  setTradierStocksFeedClient,
  setActiveInterestSymbols,
  getUnservableSymbolsState,
  __resetYahooBreakerForTests,
} = await import('./yahoo-feed.js');
const { __resetUnservableSymbolsForTests, UNSERVABLE_TTL_MS, UNSERVABLE_STRIKES } =
  await import('./unservable-symbols.js');

/** SBLX/SELX are the two delisted tickers from bqb1's 2026-08-16T18:11Z tape. */
const DEAD = ['SBLX', 'SELX'];
/**
 * A symbol the primary DROPS from its response without naming it in
 * `unmatched_symbols`, and which no fallback serves either. Silence is not a
 * claim — a truncated or partial batch looks exactly like this — so it must
 * never earn a strike, however many ticks it fails for.
 */
const GHOST = 'GHOSTX';
const UNIVERSE = ['AAPL', ...DEAD, GHOST];

const jsonResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });

/**
 * Tradier's answer: `served` priced, the dead pair named back in
 * `unmatched_symbols` exactly as the live batch response does, and {@link GHOST}
 * simply absent from both lists. `served` lets a later tick start pricing a
 * previously-dead symbol (the recovery case).
 */
function tradierEnvelope(served: readonly string[]): unknown {
  const quote = served.map(symbol => ({
    symbol, last: 100, change: 0, change_percentage: 0, volume: 1_000,
  }));
  const unmatched = DEAD.filter(s => !served.includes(s));
  return {
    quotes: {
      quote,
      ...(unmatched.length > 0 ? { unmatched_symbols: { symbol: unmatched } } : {}),
    },
  };
}

describe('TRA-3804 — the un-servable skip list, through fetchQuotes', () => {
  let realFetch: typeof globalThis.fetch;
  let fetchMock: ReturnType<typeof vi.fn>;
  let served: string[];

  /** One tick. `maxStaleMs: 0` disables the quote cache so every tick is a real
   *  fetch decision — otherwise tick 2 would be served from tick 1's cache and
   *  the gate would never be exercised twice. */
  const tick = () => fetchQuotes(UNIVERSE, { maxStaleMs: 0 });

  const tradierSymbolsRequested = (): string[] =>
    fetchMock.mock.calls
      .map(c => String(c[0]))
      .filter(u => u.includes('/markets/quotes'))
      .flatMap(u => (new URL(u).searchParams.get('symbols') ?? '').split(',').filter(Boolean));

  const resetProviderSpies = (): void => {
    provider.quote.mockClear();
    provider.chart.mockClear();
    provider.stooq.mockClear();
    fetchMock.mockClear();
  };

  beforeEach(() => {
    __resetUnservableSymbolsForTests();
    // The 429 test below trips a process-global breaker whose cooldown is 10
    // real minutes inside a test run; without this every later test in the file
    // short-circuits before the fan-out and passes vacuously.
    __resetYahooBreakerForTests();
    provider.quote.mockImplementation(async () => ({}));
    provider.chart.mockImplementation(async () => ({ meta: {}, quotes: [] }));
    provider.stooq.mockImplementation(async () => null);
    setActiveInterestSymbols([]);
    served = ['AAPL'];
    realFetch = globalThis.fetch;
    fetchMock = vi.fn(async (_url: unknown) => jsonResponse(tradierEnvelope(served)));
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'info').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    setTradierStocksFeedClient('tra3804-tok', 'production');
    provider.quote.mockClear();
    provider.chart.mockClear();
    provider.stooq.mockClear();
  });

  afterEach(() => {
    setTradierStocksFeedClient('', 'production');
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it('ACCEPTANCE — after the strike threshold, a tick issues NO chartQuote ladder and NO stooq call for the dead pair', async () => {
    // Ticks 1..N accrue strikes: each one runs the whole cascade and gets nothing.
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) await tick();
    expect(provider.chart).toHaveBeenCalled();  // the cost this ticket is removing…
    expect(provider.stooq).toHaveBeenCalled();

    resetProviderSpies();
    const out = await tick();

    // …is gone on the next tick, for the dead pair and ONLY the dead pair.
    const chartedSymbols = provider.chart.mock.calls.map(c => String(c[0]));
    for (const s of DEAD) {
      expect(chartedSymbols).not.toContain(s);
      expect(provider.quote.mock.calls.map(c => String(c[0]))).not.toContain(s);
      expect(provider.stooq.mock.calls.map(c => String(c[0]))).not.toContain(s);
    }
    // And they no longer occupy a slot in the primary batch either.
    expect(tradierSymbolsRequested().sort()).toEqual(['AAPL', GHOST]);

    // THE UNIVERSE IS NOT SHRUNK BEYOND THE DEAD PAIR: AAPL still prices, GHOST
    // is still being tried on every leg, and the dead pair's absence from
    // `results` is byte-identical to what the full cascade returned for them on
    // ticks 1..N (nothing).
    expect(out.get('AAPL')?.price).toBe(100);
    expect(chartedSymbols).toContain(GHOST);
    for (const s of DEAD) expect(out.has(s)).toBe(false);
  });

  it('the census reports the skip as a present, non-zero counter with a live `evaluations`', async () => {
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) await tick();
    await tick();
    const s = getUnservableSymbolsState();
    expect(s.skippedCount).toBe(2);
    expect(s.skippedSymbols).toEqual(['SBLX', 'SELX']);
    expect(s.marks).toBe(2);
    // The discriminator: the gate demonstrably ran, so `skippedCount` is a
    // measurement rather than the shape a dead skip path also takes.
    expect(s.evaluations).toBeGreaterThan(0);
    expect(s.skips).toBeGreaterThanOrEqual(2);
  });

  it('a symbol the PRIMARY cannot serve but a fallback CAN is never marked (the foreign-ticker class)', async () => {
    // `AZN.L`/`ARX.TO`/`2330.TW` are in `unmatched_symbols` on every single tick
    // and are priced perfectly well by the Yahoo secondary. Marking on the
    // primary's verdict alone would silently un-price ~24 live rows — this is
    // the direction that must never regress.
    provider.quote.mockResolvedValue({ regularMarketPrice: 42, regularMarketVolume: 7, currency: 'GBp' });
    for (let i = 0; i < UNSERVABLE_STRIKES + 2; i++) await tick();
    const s = getUnservableSymbolsState();
    expect(s.skippedCount).toBe(0);
    expect(s.marks).toBe(0);
    // …and they really are being priced, from the fallback, every tick.
    const out = await tick();
    for (const sym of DEAD) expect(out.get(sym)?.price).toBe(42);
  });

  it('a breaker-driven blank never earns a strike (an outage is not a delisting)', async () => {
    // Yahoo 429s mid-slice → the shared breaker opens → every remaining leg
    // returns null without touching the wire. Those nulls are an outage. If they
    // earned strikes, a provider incident would take the affected symbols dark
    // for a whole TTL *after* the incident cleared.
    //
    // ONE tick, and the assertion is on `trackedCount`, not on `marks`: from the
    // second tick the pre-fanout short-circuit stops the fan-out from running at
    // all, so a `marks === 0` assertion over several ticks would hold even with
    // the guard deleted. `trackedCount` reads the strikes accrued by the one
    // tick that DID reach the fan-out, which is the only tick that can
    // distinguish the two.
    provider.quote.mockRejectedValue(new Error('Yahoo quote HTTP 429: Too Many Requests'));
    await tick();
    const s = getUnservableSymbolsState();
    expect(s.trackedCount).toBe(0); // ← nothing even accrued a first strike
    expect(s.marks).toBe(0);
    expect(s.skippedCount).toBe(0);
  });

  it('a symbol the primary SILENTLY omits never earns a strike (silence is not a claim)', async () => {
    // GHOST is absent from `quote` AND absent from `unmatched_symbols`, and no
    // fallback serves it. A truncated or partial batch response looks exactly
    // like this, so the primary has made no claim about it — half the mark
    // predicate is missing and it must stay off the list forever.
    for (let i = 0; i < UNSERVABLE_STRIKES + 3; i++) await tick();
    const s = getUnservableSymbolsState();
    expect(s.skippedSymbols).toEqual(['SBLX', 'SELX']); // ← GHOST is NOT here
    expect(s.trackedCount).toBe(0);
    expect(s.marks).toBe(2);
  });

  it('records nothing at all when the primary was never consulted (no Tradier creds)', async () => {
    // On a box with no Tradier token, Yahoo is the primary and there is no
    // `unmatched_symbols` verdict from anyone. Every symbol then fails the whole
    // (Yahoo-only) cascade — and marking on that would put the ENTIRE universe
    // on the skip list.
    setTradierStocksFeedClient('', 'production');
    for (let i = 0; i < UNSERVABLE_STRIKES + 1; i++) await tick();
    const s = getUnservableSymbolsState();
    expect(s.marks).toBe(0);
    expect(s.trackedCount).toBe(0);
    expect(s.skippedCount).toBe(0);
  });

  it('NEVER skips an active-interest symbol — the open-position guard, re-checked every tick', async () => {
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) await tick();
    expect(getUnservableSymbolsState().skippedCount).toBe(2);

    // The signal engine asserts this set each tick for symbols with open
    // positions or recent signals.
    setActiveInterestSymbols(['SELX']);
    resetProviderSpies();
    await tick();

    const chartedSymbols = provider.chart.mock.calls.map(c => String(c[0]));
    expect(chartedSymbols).toContain('SELX');   // still fully fetched despite the mark
    expect(chartedSymbols).not.toContain('SBLX');
    expect(tradierSymbolsRequested()).toEqual(expect.arrayContaining(['AAPL', 'SELX']));
    expect(tradierSymbolsRequested()).not.toContain('SBLX');
    expect(getUnservableSymbolsState().protectedDeclines).toBeGreaterThan(0);

    setActiveInterestSymbols([]);
  });

  it('re-checkable, not permanent: a symbol that starts serving again is re-fetched and un-marked', async () => {
    for (let i = 0; i < UNSERVABLE_STRIKES; i++) await tick();
    expect(getUnservableSymbolsState().skippedCount).toBe(2);

    // Jump past the TTL. The mark lapses, the symbol goes back through the
    // ordinary cascade, and the primary now serves it.
    const t1 = Date.now() + UNSERVABLE_TTL_MS + 60_000;
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(t1);
    try {
      served = ['AAPL', 'SBLX', 'SELX'];
      resetProviderSpies();
      const out = await tick();
      expect(tradierSymbolsRequested()).toEqual(expect.arrayContaining(DEAD));
      for (const s of DEAD) expect(out.get(s)?.price).toBe(100);
      const state = getUnservableSymbolsState();
      expect(state.skippedCount).toBe(0);
      expect(state.expiries).toBe(2);
      expect(state.recoveries).toBe(0); // the TTL lapse retired them, not a recovery record
    } finally {
      nowSpy.mockRestore();
    }
  });
});
