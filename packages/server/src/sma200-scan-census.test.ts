import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import * as yahooFeed from './yahoo-feed.js';

/**
 * TRA-4457 — the census has to reach the WIRE, not just the pure grader.
 *
 * `sma200SweepVerdict` is unit-tested in `sma200-validity.test.ts`, but a
 * correct pure function published by nobody is exactly the defect this ticket
 * is about: on 2026-09-09 bqb1 served `signals: []` against 751 warm symbols
 * with no log line and no counter anywhere, so a starved sweep and a quiet
 * market were byte-identical on `/api/state`. These tests grade the surface a
 * live grader actually reads — `getState().sma200ScanStats` — for the three
 * sweep shapes that all render as an empty `signals[]`.
 */

const TRADING_TIME = Date.parse('2024-06-04T14:00:00Z');

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
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

describe('TRA-4457 — the sweep census reaches /api/state', () => {
  it('a STARVED sweep (breaker open, zero bars) is distinguishable from a quiet market', async () => {
    const engine = new SignalEngine();
    // The measured live shape: `withRetry` short-circuits on the global
    // `rateLimitedUntil`, so `fetchDailyCandles` resolves `[]` WITHOUT issuing
    // a request. Every symbol then falls out of the `< SMA200_MIN_BARS` guard.
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(true);

    await scan(engine, ['AAA', 'BBB', 'CCC']);
    const stats = engine.getState().sma200ScanStats;

    expect(stats).toBeTruthy();
    expect(stats?.considered).toBe(3);
    // The discriminating field. Zero scored ⇒ the empty feed carries NO
    // information about the market.
    expect(stats?.evaluated).toBe(0);
    expect(stats?.starvedBreakerOpen).toBe(3);
    expect(stats?.starvedShortHistory).toBe(0);
    expect(stats?.fired).toBe(0);
  });

  it('attributes a short listing history separately when the breaker is CLOSED', async () => {
    const engine = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(false);

    await scan(engine, ['AAA', 'BBB']);
    const stats = engine.getState().sma200ScanStats;

    // Same empty `signals[]`, same zero `evaluated` — but a different cause and
    // a different remedy, so the two starve counters must not be folded.
    expect(stats?.starvedShortHistory).toBe(2);
    expect(stats?.starvedBreakerOpen).toBe(0);
  });

  it('an EMPTY UNIVERSE still publishes a census — it is a distinct upstream fault', async () => {
    const engine = new SignalEngine();
    const fetchSpy = vi.spyOn(yahooFeed, 'fetchDailyCandles');

    await scan(engine, []);
    const stats = engine.getState().sma200ScanStats;

    // Regression guard on the bare `return` that used to sit at the top of
    // `runSma200Scan`: it made `NO_UNIVERSE` reachable only from a unit test,
    // so in production the one verdict that names a broken WATCHLIST (rather
    // than a starved bar feed) was itself another silent sweep.
    expect(stats).toBeTruthy();
    expect(stats?.considered).toBe(0);
    expect(stats?.evaluated).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('is null before any sweep runs, and is never restored stale', () => {
    // A census describes THIS process's most recent sweep. `null` honestly says
    // "no sweep has completed here yet"; a persisted `evaluated: 700` from
    // before a restart would be credited to a sweep that never ran.
    expect(new SignalEngine().getState().sma200ScanStats ?? null).toBeNull();
  });
});
