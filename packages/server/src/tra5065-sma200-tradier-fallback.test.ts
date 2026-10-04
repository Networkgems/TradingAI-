import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import * as yahooFeed from './yahoo-feed.js';
import {
  __resetSma200CandleMemoForTest,
  fetchSma200CandlesShared,
  orderSma200FallbackFairness,
} from './sma200-scan-admission.js';
import type { Candle } from '@trading-app/shared';

/**
 * TRA-5065 — THE SMA-200 SWEEP IS NO LONGER YAHOO-ONLY.
 *
 * Measured on bqb1 2026-10-02T14:2xZ: `evaluated` 0 fleet-wide,
 * `starvedBreakerOpen` 400/400, verdict BLIND — while `tradierBreakerOpen` was
 * FALSE and the chart fallback was already serving Tradier bars to every other
 * daily-bar consumer on the box. The sweep starved on a single-provider
 * dependency, and `evaluated: 0` made every downstream sma200 number vacuous
 * rather than reassuring.
 *
 * The load-bearing test here is AC4's POSITIVE CONTROL: a sweep with the Yahoo
 * breaker OPEN and `evaluated > 0`. That pair was impossible before this
 * commit, which is why it is the grade.
 */

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

/** 280 bars is what `SMA200_DAILY_BARS` asks for; 260 clears the 250 floor. */
function barsOf(n: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({
    symbol: 'X',
    timestamp: TRADING_TIME - (n - i) * 86_400_000,
    open: 100, high: 100, low: 100, close: 100, volume: 1_000,
  }));
}

const DEEP = barsOf(260);
/**
 * 🔴 AC2's trap, as a fixture. `OTM_DAILY_SERIES_BARS` is 120, so the TRA-4424
 * path had only ever been exercised to that depth. A 120-bar fallback still
 * trips `candles.length < SMA200_MIN_BARS` and would have landed in
 * `starvedShortHistory` — THE SAME ZERO WEARING A DIFFERENT LABEL.
 *
 * Measured against the live vendor before this was wired (2026-10-02):
 * Tradier `/markets/history` over the 280-bar calendar window returns 314
 * usable sessions for AAPL/SPY/NVTS/QQQ/ZM, 5/5. So the real feed is deep
 * enough; this fixture exists so the SHALLOW case stays distinguishable if it
 * ever stops being.
 */
const SHALLOW = barsOf(120);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  __resetSma200CandleMemoForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function scan(engine: SignalEngine, symbols: string[]): Promise<void> {
  return (engine as unknown as {
    runSma200Scan: (s: string[]) => Promise<void>;
  }).runSma200Scan(symbols);
}

/** Yahoo dark (breaker open, nothing served), Tradier healthy and deep. */
function yahooDarkTradierDeep() {
  const primary = vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
  vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(true);
  vi.spyOn(yahooFeed, 'isTradierDailyAvailable').mockReturnValue(true);
  const fallback = vi.spyOn(yahooFeed, 'fetchTradierDailyCandles')
    .mockResolvedValue(DEEP as never);
  return { primary, fallback };
}

describe('TRA-5065 — the sma200 sweep falls back to Tradier', () => {
  it('AC4 POSITIVE CONTROL: yahooBreakerOpen true AND evaluated > 0', async () => {
    const { primary, fallback } = yahooDarkTradierDeep();
    const engine = new SignalEngine();

    await scan(engine, ['AAA', 'BBB', 'CCC']);
    const stats = engine.getState().sma200ScanStats;

    // The pair that was impossible before this commit.
    expect(yahooFeed.isYahooBreakerOpen()).toBe(true);
    expect(stats?.evaluated).toBe(3);
    expect(engine.getState().sma200SweepVerdict).toBe('SWEPT');
    // …and NOT starved. 400/400 on `starvedBreakerOpen` was the filed defect.
    expect(stats?.starvedBreakerOpen).toBe(0);
    expect(stats?.starvedShortHistory).toBe(0);
    // The primary is never even asked while its breaker is open — an un-asked
    // breaker would launder the outage into "answered empty" (TRA-4424's rule).
    expect(primary).not.toHaveBeenCalled();
    expect(fallback).toHaveBeenCalledTimes(3);
  });

  it('AC3 — the fallback does NOT hide inside `evaluated`: servedFallback names it', async () => {
    yahooDarkTradierDeep();
    const engine = new SignalEngine();

    await scan(engine, ['AAA', 'BBB']);
    const stats = engine.getState().sma200ScanStats;

    // "Yahoo served" / "Tradier served" / "nobody served" must be three
    // readable states, not one `evaluated`.
    expect(stats?.servedFallback).toBe(2);
    expect(stats?.servedPrimary).toBe(0);
    expect(stats?.evaluated).toBe(2);
  });

  it('attributes to the PRIMARY when Yahoo is healthy — the fallback stays unasked', async () => {
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(DEEP as never);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(false);
    vi.spyOn(yahooFeed, 'isTradierDailyAvailable').mockReturnValue(true);
    const fallback = vi.spyOn(yahooFeed, 'fetchTradierDailyCandles')
      .mockResolvedValue(DEEP as never);
    const engine = new SignalEngine();

    await scan(engine, ['AAA', 'BBB']);
    const stats = engine.getState().sma200ScanStats;

    expect(stats?.servedPrimary).toBe(2);
    expect(stats?.servedFallback).toBe(0);
    // A healthy sweep costs ZERO Tradier requests and zero added latency.
    expect(fallback).not.toHaveBeenCalled();
  });

  it('a memo replay keeps the FALLBACK attribution — provenance survives the dedup', async () => {
    const { fallback } = yahooDarkTradierDeep();

    await scan(new SignalEngine(), ['AAA']);
    const second = new SignalEngine();
    await scan(second, ['AAA']);
    const stats = second.getState().sma200ScanStats;

    // One wire call, two scored sweeps — and the second one still says TRADIER.
    expect(fallback).toHaveBeenCalledTimes(1);
    expect(stats?.memoHits).toBe(1);
    expect(stats?.servedFallback).toBe(1);
    expect(stats?.servedPrimary).toBe(0);
  });

  it('🔴 AC2 — a SHALLOW fallback is not laundered into a clean short-history zero', async () => {
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(true);
    vi.spyOn(yahooFeed, 'isTradierDailyAvailable').mockReturnValue(true);
    vi.spyOn(yahooFeed, 'fetchTradierDailyCandles').mockResolvedValue(SHALLOW as never);
    const engine = new SignalEngine();

    await scan(engine, ['AAA', 'BBB']);
    const stats = engine.getState().sma200ScanStats;

    // Still zero scored — a 120-bar fallback cannot satisfy a 250-bar floor.
    expect(stats?.evaluated).toBe(0);
    // But it is READABLE: `servedFallback == considered` next to
    // `starvedShortHistory == considered` says "Tradier answered, too shallow",
    // which no single counter could. Without `servedFallback` this reads as an
    // ordinary population of recent IPOs.
    expect(stats?.servedFallback).toBe(2);
    expect(stats?.starvedShortHistory).toBe(2);
    expect(stats?.starvedBreakerOpen).toBe(0);
  });

  it('names the BUDGET when it, not a vendor, closed the door', async () => {
    const { fallback } = yahooDarkTradierDeep();
    const engine = new SignalEngine();
    // Burn the sweep's 6s fallback allowance on the first batch. `fetch` is the
    // only await inside a batch, so advancing the fake clock there is what a
    // slow vendor does to a real sweep.
    fallback.mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 7_000);
      return DEEP as never;
    });

    await scan(engine, Array.from({ length: 12 }, (_, i) => `S${i}`));
    const stats = engine.getState().sma200ScanStats;

    // Asserted as an INVARIANT, not an exact split: how many symbols of a
    // concurrent batch reach their budget check before a sibling's `fetch`
    // advances the clock is a scheduler detail, and pinning it would make this
    // a test of the event loop. What must hold is that the budget BITES, that
    // it is NAMED, and that nothing falls out of the census.
    expect(stats?.servedFallback).toBeGreaterThan(0);
    expect(stats?.starvedFallbackBudget).toBeGreaterThan(0);
    expect((stats?.servedFallback ?? 0) + (stats?.starvedFallbackBudget ?? 0)).toBe(12);
    // ⚠️ A SUB-TAG, NOT A DISJOINT BUCKET: budget-starved symbols are counted
    // in `starvedBreakerOpen` too, so `sma200SweepStarved` still reconciles to
    // `considered - evaluated`. A fourth independent bucket would quietly drop
    // them out of the starve total and read as a healthier sweep.
    expect(stats?.starvedBreakerOpen).toBe(stats?.starvedFallbackBudget);
    expect((stats?.evaluated ?? 0) + (stats?.starvedBreakerOpen ?? 0)).toBe(12);
    // TRA-5111 — the census names WHO, not just how many. The lists must agree
    // with their own counters, the sub-tag containment must hold symbol-wise,
    // and the partition must cover the whole universe: a count that cannot say
    // which names starved cannot distinguish a rotation from a permanent hole.
    expect(stats?.starvedFallbackBudgetSymbols?.length).toBe(stats?.starvedFallbackBudget);
    expect([...(stats?.starvedBreakerOpenSymbols ?? [])].sort())
      .toEqual([...(stats?.starvedFallbackBudgetSymbols ?? [])].sort());
    expect(stats?.evaluatedSymbols?.length).toBe(stats?.evaluated);
    const touched = new Set([
      ...(stats?.evaluatedSymbols ?? []), ...(stats?.starvedBreakerOpenSymbols ?? []),
    ]);
    expect(touched.size).toBe(12);
  });

  it('names TRADIER when both providers are down (TRA-4826 shape, not this one)', async () => {
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(true);
    vi.spyOn(yahooFeed, 'isTradierDailyAvailable').mockReturnValue(false);
    const fallback = vi.spyOn(yahooFeed, 'fetchTradierDailyCandles');
    const engine = new SignalEngine();

    await scan(engine, ['AAA', 'BBB']);
    const stats = engine.getState().sma200ScanStats;

    expect(stats?.fallbackUnavailable).toBe(2);
    expect(stats?.starvedBreakerOpen).toBe(2);
    expect(stats?.starvedFallbackBudget).toBe(0);
    // TRA-5111 — and the names ride with the tags.
    expect([...(stats?.fallbackUnavailableSymbols ?? [])].sort()).toEqual(['AAA', 'BBB']);
    expect([...(stats?.starvedBreakerOpenSymbols ?? [])].sort()).toEqual(['AAA', 'BBB']);
    expect(stats?.starvedFallbackBudgetSymbols).toEqual([]);
    // Asked BEFORE the call, so an unavailable vendor costs no request either.
    expect(fallback).not.toHaveBeenCalled();
  });
});

describe('TRA-5065 — the pull contract in isolation', () => {
  it('a primary THROW is carried by the fallback and is not a fetchFailed', async () => {
    const pull = await fetchSma200CandlesShared('AAA', 280,
      async () => { throw new Error('boom'); },
      {
        breakerOpen: () => false,
        fallback: { fetch: async () => DEEP, available: () => true },
      },
    );
    expect(pull.candles).toHaveLength(260);
    expect(pull.source).toBe('fallback');
  });

  it('…but a primary THROW the fallback cannot cover is still RETHROWN', async () => {
    // The caller's `fetchFailed` accounting must be unchanged in exactly the
    // world it already described: nobody served, and the cause is known.
    await expect(fetchSma200CandlesShared('AAA', 280,
      async () => { throw new Error('boom'); },
      {
        breakerOpen: () => false,
        fallback: { fetch: async () => [], available: () => true },
      },
    )).rejects.toThrow('boom');

    await expect(fetchSma200CandlesShared('BBB', 280,
      async () => { throw new Error('boom'); },
    )).rejects.toThrow('boom');
  });

  it('NEVER memoizes an empty result, from either leg', async () => {
    const primary = vi.fn(async () => [] as Candle[]);
    const fallback = vi.fn(async () => [] as Candle[]);
    for (let i = 0; i < 3; i++) {
      await fetchSma200CandlesShared('AAA', 280, primary, {
        breakerOpen: () => false,
        fallback: { fetch: fallback, available: () => true },
      });
    }
    // Caching `[]` would pin one engine's starve onto the whole fleet for the
    // TTL — the defect the memo exists to relieve, made worse.
    expect(primary).toHaveBeenCalledTimes(3);
    expect(fallback).toHaveBeenCalledTimes(3);
  });

  it('rotates fallback coverage: least-recently-served first', async () => {
    // A budget that cuts a sweep short must not pin a PERMANENT blind spot on
    // the tail. Coverage is keyed by SYMBOL, not by index, because every engine
    // sweeps its own universe (TRA-4830 tiers them per book) and an index
    // cursor over heterogeneous lists is not a rotation.
    expect(orderSma200FallbackFairness(['AAA', 'BBB', 'CCC']))
      .toEqual(['AAA', 'BBB', 'CCC']);

    await fetchSma200CandlesShared('AAA', 280, async () => [], {
      breakerOpen: () => true,
      fallback: { fetch: async () => DEEP, available: () => true },
    });
    vi.setSystemTime(Date.now() + 1_000);
    await fetchSma200CandlesShared('BBB', 280, async () => [], {
      breakerOpen: () => true,
      fallback: { fetch: async () => DEEP, available: () => true },
    });

    // CCC was never reached, so it goes first; AAA (oldest attempt) before BBB.
    expect(orderSma200FallbackFairness(['AAA', 'BBB', 'CCC']))
      .toEqual(['CCC', 'AAA', 'BBB']);
  });

  it('charges the rotation on the ATTEMPT, not the answer', async () => {
    // A fairness order that only advanced on success would re-pick the same
    // refusals every sweep and never reach anything behind them.
    await fetchSma200CandlesShared('AAA', 280, async () => [], {
      breakerOpen: () => true,
      fallback: { fetch: async () => [], available: () => true },
    });
    expect(orderSma200FallbackFairness(['AAA', 'ZZZ'])).toEqual(['ZZZ', 'AAA']);
  });
});
