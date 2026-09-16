import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
// Type-only: erased at compile time, so this does not defeat the `vi.mock` below.
import type { LagLedgerSample } from './event-loop-watchdog.js';

// TRA-4595 — `signal.doTick.news-refresh` was filed as a 6341ms un-preemptible
// block: "96.8% of the 2026-09-10 watchdog trip", on the TRA-4524 reading that a
// phase with NO internal yield boundary cannot be bounded by a process-wide yield
// gate. Step 1 of that ticket was to read the code and settle which it is, and the
// answer separates two very different fixes. This file pins both halves of the
// answer, because both were re-derived from a live health route that is gone the
// moment the box restarts.
//
// ── Half 1: the phase DOES yield (this is not a block) ────────────────────────
// `fetchStocksNews` is I/O all the way down — `await Promise.all(...)` per batch
// of 3 symbols, `await sleep(200)` between batches, one awaited fallback search,
// and inside `withRetry` an awaited `withTimeout` plus 1s/2s backoff sleeps. Its
// own synchronous work is `collect()` over <=5 items per symbol and a <=40-element
// sort. `withPhase` therefore records it `kind: 'async'`, whose whole meaning is
// "wall time includes awaited I/O — NOT a block".
//
// The separating assertion is NOT the call's duration: a yielding fan-out and a
// blocking one can take exactly the same wall time. It is whether the event loop
// TURNED OVER while the call was in flight. The control below busy-waits for the
// same order of wall time and is caught.
//
// ── Half 2: the 96.8% share was never causal ──────────────────────────────────
// The trip's own sampler published `straddleSamples: 0` beside that share. Per
// `LagLedgerEntry.straddleSamples`: the watchdog timer cannot fire DURING a block,
// so a sample lands just after the loop frees up, and a phase that had been
// running for less than the block lasted cannot have spanned it — it is what ran
// NEXT. `phase` and `phaseElapsedMs` are read from the same `activePhase` object,
// so a named entry with 0 straddles is a measurement, never an unread field.
// The replay below reproduces the live numbers exactly and pins the verdict.

const searchMock = vi.fn();

vi.mock('yahoo-finance2', () => ({
  default: class {
    search = (...args: unknown[]) => searchMock(...args);
  },
}));

const { fetchStocksNews } = await import('./yahoo-feed.js');
const { summarizeLagLedger } = await import('./event-loop-watchdog.js');

/**
 * Counts event-loop turns and the worst gap between them. A contiguous
 * synchronous stretch cannot let a `setImmediate` fire, so `turns` stops
 * advancing and `maxGapMs` absorbs the whole stretch — the same discriminator
 * `SyncSliceMeter`'s turn beacon uses.
 *
 * `turns` is read LIVE, not at stop: the delta across a subject measured from the
 * same synchronous frame it was started in is the whole test. A blocking subject
 * returns before the loop can turn (delta 0); a yielding one cannot.
 */
interface LoopBeacon {
  readonly turns: number;
  readonly maxGapMs: number;
  stop: () => void;
}
function startLoopBeacon(): LoopBeacon {
  let turns = 0;
  let maxGapMs = 0;
  let last = Date.now();
  let stopped = false;
  const tick = (): void => {
    if (stopped) return;
    const now = Date.now();
    if (now - last > maxGapMs) maxGapMs = now - last;
    last = now;
    turns++;
    setImmediate(tick);
  };
  setImmediate(tick);
  return {
    get turns() { return turns; },
    get maxGapMs() { return maxGapMs; },
    stop: () => { stopped = true; },
  };
}

/** Let the beacon get running so a zero-delta reading means the subject, not the setup. */
const warmUp = async (beacon: LoopBeacon): Promise<void> => {
  await new Promise(r => setTimeout(r, 20));
  expect(beacon.turns).toBeGreaterThan(0);
};

const SYMBOLS = ['AAPL', 'NVDA', 'TSLA', 'MSFT', 'AMZN', 'META', 'GOOG', 'AMD'];

/** Resolves on a real timer, the way an HTTP round trip does. */
const slowSearch = (ms: number) => (q: string) =>
  new Promise(resolve => setTimeout(() => resolve({
    news: Array.from({ length: 5 }, (_, i) => ({
      title: `${q} headline ${i}`,
      link: `https://example.test/${q}/${i}`,
      publisher: 'Test Wire',
      providerPublishTime: new Date(Date.UTC(2026, 8, 10, 16, 50, i)),
    })),
  }), ms));

beforeEach(() => {
  searchMock.mockReset();
  searchMock.mockImplementation(slowSearch(30));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('TRA-4595 — signal.doTick.news-refresh has yield boundaries', () => {
  it('ACCEPTANCE 1: the event loop turns over repeatedly while fetchStocksNews is in flight', async () => {
    const beacon = startLoopBeacon();
    await warmUp(beacon);

    const before = beacon.turns;
    const items = await fetchStocksNews(SYMBOLS);
    const turnsDuringCall = beacon.turns - before;
    const { maxGapMs } = beacon;
    beacon.stop();

    // The call really ran (a short-circuit would make the beacon reading vacuous).
    expect(items.length).toBeGreaterThan(0);

    // THE separating assertion. Three batches of awaited searches plus two
    // `sleep(200)`s: the loop is handed back, over and over, INSIDE the phase.
    // A fan-out with no internal boundary returns in the frame it started in and
    // this delta is 0 — see the CONTROL below, which is exactly that shape.
    expect(turnsDuringCall).toBeGreaterThan(10);

    // And no single stretch anywhere near the 4s watchdog budget, let alone the
    // 6341.79ms the ticket attributed to this phase.
    expect(maxGapMs).toBeLessThan(1_000);
  }, 20_000);

  it('CONTROL: the same beacon convicts a subject of equal wall time that does NOT yield', async () => {
    // Without this, `turnsDuringCall > 10` could be passing because the beacon is
    // free-running regardless of what the subject does.
    const BUSY_MS = 600;
    const beacon = startLoopBeacon();
    await warmUp(beacon);

    const before = beacon.turns;
    const until = Date.now() + BUSY_MS;
    while (Date.now() < until) { /* contiguous synchronous stretch */ }
    const turnsDuringCall = beacon.turns - before;

    expect(turnsDuringCall).toBe(0);

    await new Promise(r => setTimeout(r, 20)); // let the gap be recorded
    const { maxGapMs } = beacon;
    beacon.stop();
    expect(maxGapMs).toBeGreaterThanOrEqual(BUSY_MS - 50);
  });

  it('keeps yielding on the pessimal path, where every search exhausts its retries', async () => {
    // 3 attempts x (8s timeout) + 1s + 2s backoff per symbol, fanned out 3 at a
    // time, then a fallback query — the longest this phase can run. It is LONG,
    // and still not a block, because every one of those waits is an await.
    // Mocked to throw immediately so the test pays only the backoff sleeps.
    searchMock.mockImplementation(async () => {
      throw new Error('feed down');
    });
    const beacon = startLoopBeacon();
    await warmUp(beacon);

    const before = beacon.turns;
    const items = await fetchStocksNews(SYMBOLS.slice(0, 3));
    const turnsDuringCall = beacon.turns - before;
    const { maxGapMs } = beacon;
    beacon.stop();

    expect(items).toHaveLength(0); // a feed outage, not a quiet news day
    expect(turnsDuringCall).toBeGreaterThan(10);
    expect(maxGapMs).toBeLessThan(1_000);
  }, 30_000);
});

describe('TRA-4595 — the 2026-09-10 trip`s 96.8% share was coincident, not causal', () => {
  const S = (over: Partial<LagLedgerSample>): LagLedgerSample => ({
    atMs: 0,
    lagMeanMs: 0,
    lagMaxMs: 0,
    phase: null,
    phaseElapsedMs: null,
    ...over,
  });

  // Live numbers, `/api/health/watchdog` . `watchdog.lastTrip.attribution.sampler`,
  // read 2026-09-16T16:00Z on build f3ce18b6. Trip at 2026-09-10T16:50:32.418Z,
  // lagMeanMs 3320 / lagMaxMs 6342, verdict `partial`, explainedFraction 0.18276,
  // slowSyncPhase `yield-preempt@signal.doTick.pacer` 1159ms, gc null.
  const TRIP_AT_MS = 1_789_059_032_418;
  const WINDOW_MS = 8_341.787647;
  const LIVE_SAMPLES: LagLedgerSample[] = [
    // phaseElapsedMs < lagMaxMs on both: news-refresh had been running for less
    // time than the block lasted, so it started INSIDE the stall.
    S({ atMs: TRIP_AT_MS - 100, phase: 'signal.doTick.news-refresh', lagMeanMs: 6_544, lagMaxMs: 6_341.787647, phaseElapsedMs: 40 }),
    S({ atMs: TRIP_AT_MS - 1_100, phase: 'signal.doTick.news-refresh', lagMeanMs: 95.190016, lagMaxMs: 300, phaseElapsedMs: 120 }),
    S({ atMs: TRIP_AT_MS - 2_100, phase: 'signal.doTick.equity-entry-sweep', lagMeanMs: 124.535808, lagMaxMs: 278.921215, phaseElapsedMs: 50 }),
    S({ atMs: TRIP_AT_MS - 3_100, phase: 'signal.doTick.tradier-balance', lagMeanMs: 95.34370909090909, lagMaxMs: 280.756223, phaseElapsedMs: 900 }),
  ];

  it('reproduces the published share — and its zero straddle support', () => {
    const v = summarizeLagLedger({ samples: LIVE_SAMPLES, atMs: TRIP_AT_MS, windowMs: WINDOW_MS, ringFull: false });

    expect(v.coverage).toBe('complete');
    expect(v.samples).toBe(4);
    expect(v.lagSumMs).toBeCloseTo(6_859.069533090909, 6);
    expect(v.top!.name).toBe('signal.doTick.news-refresh');
    expect(v.top!.share).toBeCloseTo(0.9679432441922154, 9); // the ticket's 96.8%

    // …and the number that was published beside it and not read.
    expect(v.top!.straddleSamples).toBe(0);
    expect(v.top!.causalSupport).toBe('coincident');
  });

  it('names the ONLY causally-supported phase in the window — 280ms of a 6342ms block', () => {
    const v = summarizeLagLedger({ samples: LIVE_SAMPLES, atMs: TRIP_AT_MS, windowMs: WINDOW_MS, ringFull: false });

    const straddling = v.entries.filter(e => e.straddleSamples > 0);
    expect(straddling.map(e => e.name)).toEqual(['signal.doTick.tradier-balance']);
    // So nothing in this window supports a causal read of the 6342ms block. It is
    // residual-unattributed (verdict `partial`, 18.3% explained by a yield-preempt
    // WITNESS at the pacer), and pointing a yield-boundary fix at news-refresh
    // would have been a fix aimed at innocent code.
    expect(straddling[0].lagMaxMs).toBeLessThan(300);
  });

  it('CONTROL: the same window WITH straddle support reads `straddling`', () => {
    // Flip only `phaseElapsedMs` on the heavy sample — every lag number is
    // unchanged, so a field that ignored straddle support would read identically.
    const withStraddle = LIVE_SAMPLES.map(s =>
      s.phase === 'signal.doTick.news-refresh' && s.lagMaxMs > 6_000
        ? { ...s, phaseElapsedMs: 6_400 }
        : s);
    const v = summarizeLagLedger({ samples: withStraddle, atMs: TRIP_AT_MS, windowMs: WINDOW_MS, ringFull: false });

    expect(v.top!.share).toBeCloseTo(0.9679432441922154, 9); // identical share
    expect(v.top!.straddleSamples).toBe(1);
    expect(v.top!.causalSupport).toBe('straddling');
  });
});
