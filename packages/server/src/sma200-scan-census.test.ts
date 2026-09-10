import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SignalEngine } from './signal-engine.js';
import * as yahooFeed from './yahoo-feed.js';
import {
  __resetSma200CandleMemoForTest,
  __sma200CandleMemoSizeForTest,
  SMA200_CANDLE_MEMO_MS,
} from './sma200-scan-admission.js';

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

/**
 * TRA-4457 — the VERDICT is published beside the counters, not left to readers.
 *
 * Raised by the TRA-3688 spec owner off the 2026-09-10T00:06:25Z live read: the
 * verdict was computed and logged inside `publishSma200Census` but never served,
 * so every grader had to re-derive `SWEPT`/`BLIND`/`NO_UNIVERSE` from the raw
 * counters — the exact re-implementation the helper exists to prevent — and the
 * sweep's own ruler sat behind a Render log query.
 */
describe('TRA-4457 — the sweep verdict is published, not re-derived', () => {
  it('serves BLIND beside the counters when the breaker starved the sweep', async () => {
    const engine = new SignalEngine();
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(true);

    await scan(engine, ['AAA', 'BBB', 'CCC']);
    const state = engine.getState();

    expect(state.sma200SweepVerdict).toBe('BLIND');
    // The verdict must agree with the denominator it is served next to. These
    // travel together or they are worse than nothing.
    expect(state.sma200ScanStats?.evaluated).toBe(0);
  });

  it('serves NO_UNIVERSE rather than folding it into BLIND', async () => {
    const engine = new SignalEngine();
    await scan(engine, []);
    // A broken watchlist and a starved bar feed have different owners and
    // different remedies; collapsing them re-hides one of the two.
    expect(engine.getState().sma200SweepVerdict).toBe('NO_UNIVERSE');
  });

  it('serves SWEPT for a healthy sweep that scored symbols and fired NOTHING', async () => {
    // 🔴 The load-bearing arm, and the one a reader keying on `fired` gets
    // backwards: a quiet market scores its universe and emits no signal. That
    // MUST read SWEPT — it is the only thing that separates an honest empty feed
    // from the starved one this ticket was filed on. 250 flat bars cannot produce
    // a pullback, so `fired` is 0 for a legitimate reason.
    const engine = new SignalEngine();
    const flat = Array.from({ length: 260 }, (_, i) => ({
      time: TRADING_TIME - (260 - i) * 86_400_000,
      open: 100, high: 100, low: 100, close: 100, volume: 1_000,
    }));
    vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(flat as never);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(false);

    await scan(engine, ['AAA', 'BBB']);
    const state = engine.getState();

    expect(state.sma200ScanStats?.evaluated).toBe(2);
    expect(state.sma200ScanStats?.fired).toBe(0);
    expect(state.sma200SweepVerdict).toBe('SWEPT');
  });

  it('is null before any sweep, so presence of the KEY proves the deployed bytes', () => {
    // TRA-3913 — `undefined` (old build) and `null` (S1 live, no sweep yet) are
    // different facts and the grader exits differently on each.
    const state = new SignalEngine().getState();
    expect('sma200SweepVerdict' in state).toBe(true);
    expect(state.sma200SweepVerdict ?? null).toBeNull();
  });
});

/**
 * TRA-4457 S2 — the fleet pulls each name ONCE, not once per engine.
 *
 * Measured 2026-09-10 off the S1 census: a fleet batch handed the sweep
 * 18,291-29,008 symbols against a union of <= 755, and the only sighted sweeps
 * were tripped by their own `dailyChart` pulls after ~2,400 requests. These arms
 * grade the dedup AND the one way it could make the starve worse (memoizing the
 * breaker's `[]`).
 */
describe('TRA-4457 S2 — the sweep shares daily bars across engines', () => {
  const bars = Array.from({ length: 260 }, (_, i) => ({
    symbol: 'X',
    timestamp: TRADING_TIME - (260 - i) * 86_400_000,
    open: 100, high: 100, low: 100, close: 100, volume: 1_000,
  }));

  it('a second engine sweeping the same universe issues NO requests', async () => {
    const fetchSpy = vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(bars as never);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(false);

    await scan(new SignalEngine(), ['AAA', 'BBB', 'CCC']);
    const second = new SignalEngine();
    await scan(second, ['AAA', 'BBB', 'CCC']);

    expect(fetchSpy).toHaveBeenCalledTimes(3);
    const stats = second.getState().sma200ScanStats;
    expect(stats?.memoHits).toBe(3);
    // Served-from-memo is still a real scored population, not a starve.
    expect(stats?.evaluated).toBe(3);
    expect(second.getState().sma200SweepVerdict).toBe('SWEPT');
  });

  it('NEVER memoizes the breaker\'s empty result — a starve must not be pinned fleet-wide', async () => {
    // 🔴 The failure mode that would make this change strictly worse: `[]` is
    // what `fetchDailyCandles` returns while the breaker is open WITHOUT asking.
    const fetchSpy = vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue([]);
    const breaker = vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(true);

    const blind = new SignalEngine();
    await scan(blind, ['AAA']);
    expect(blind.getState().sma200ScanStats?.starvedBreakerOpen).toBe(1);
    expect(__sma200CandleMemoSizeForTest()).toBe(0);

    fetchSpy.mockResolvedValue(bars as never);
    breaker.mockReturnValue(false);
    const next = new SignalEngine();
    await scan(next, ['AAA']);

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(next.getState().sma200ScanStats?.memoHits).toBe(0);
    expect(next.getState().sma200ScanStats?.evaluated).toBe(1);
  });

  it('a BLIND window is sighted off the memo a sighted engine filled (the fleet payoff)', async () => {
    const fetchSpy = vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(bars as never);
    const breaker = vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(false);
    await scan(new SignalEngine(), ['AAA', 'BBB']);

    // The breaker now trips — as it did at 20:15:23Z — and every further pull
    // would come back `[]` unasked.
    fetchSpy.mockResolvedValue([]);
    breaker.mockReturnValue(true);
    const late = new SignalEngine();
    await scan(late, ['AAA', 'BBB']);

    const stats = late.getState().sma200ScanStats;
    expect(stats?.evaluated).toBe(2);
    expect(stats?.starvedBreakerOpen).toBe(0);
    expect(stats?.memoHits).toBe(2);
    expect(late.getState().sma200SweepVerdict).toBe('SWEPT');
  });

  it('expires after the TTL and holds nothing resident between batches', async () => {
    const fetchSpy = vi.spyOn(yahooFeed, 'fetchDailyCandles').mockResolvedValue(bars as never);
    vi.spyOn(yahooFeed, 'isYahooBreakerOpen').mockReturnValue(false);
    await scan(new SignalEngine(), ['AAA', 'BBB']);
    expect(__sma200CandleMemoSizeForTest()).toBe(2);

    // Nothing sweeps for the next 4h, so only the prune timer can free these.
    vi.advanceTimersByTime(SMA200_CANDLE_MEMO_MS);
    expect(__sma200CandleMemoSizeForTest()).toBe(0);

    const later = new SignalEngine();
    await scan(later, ['AAA', 'BBB']);
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(later.getState().sma200ScanStats?.memoHits).toBe(0);
  });
});
