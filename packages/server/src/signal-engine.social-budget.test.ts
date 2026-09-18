// TRA-3019 — the wall-clock bound on `signal.doTick.social-sentiment`.
//
// This sink was the last `signal.doTick` sub-label over 60s (max 62.12s on the
// 2026-08-05 RTH tape) and the only one carrying NO wall-clock bound: two serial
// loops (8 crowd symbols, 9 curated accounts) whose sole ceiling was 17 ×
// `ST_CALL_TIMEOUT_MS` = 102s. It sits inside the tick exit region (TRA-2257),
// and with TRA-2607 shipping the exit hoist OFF on the real-money book, live
// exits still ride the tick — so this is an exit-latency term.
//
// ⚠️ TRA-1677 — the mock factories below must NOT call `importActual()`. With
// that form the stub reaches THIS file's binding but NOT `signal-engine.ts`'s,
// so the engine keeps the real function and goes to the network mid-test while
// the assertion reads 0 calls. A plain factory REPLACES the module, so every
// binding any module in this graph imports must be listed. (The sizing test
// below therefore reads the REAL `ST_CALL_TIMEOUT_MS` through `vi.importActual`
// inside the test body — a different mechanism, and the only way to assert the
// derivation against the shipped constant rather than against this file's copy.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('./yahoo-feed.js', () => ({
  fetchDailyCandles: vi.fn(async () => []),
  fetchTradierDailyCandles: vi.fn(async () => []),
  fetchMinuteBars: vi.fn(async () => []),
  fetchMinuteBarsWithSource: vi.fn(async () => ({ bars: [], source: 'yahoo' as const })),
  fetchQuote: vi.fn(async () => null),
  fetchQuotes: vi.fn(async () => []),
  fetchStocksNews: vi.fn(async () => []),
  fetchMarketNews: vi.fn(async () => ({ items: [], queriesAttempted: 0, queriesSucceeded: 0 })),
  fetchShortInterestFundamentals: vi.fn(async () => null),
  parseShortInterestFundamentals: vi.fn(() => null),
  toIsoTime: vi.fn((t: Date | number | string | undefined | null) =>
    new Date(t ?? 0).toISOString()),
  isYahooBreakerOpen: vi.fn(() => false),
  isTradierDailyAvailable: vi.fn(() => false),
  tripYahooBreakerFromExternal: vi.fn(),
  setActiveInterestSymbols: vi.fn(),
  setTradierStocksFeedClient: vi.fn(),
  // TRA-3068 — the split calendar `applyQuotes` consults. Inert; a plain factory
  // REPLACES the module, so a missing name is an undefined import.
  knownSplitForSession: vi.fn(() => null),
  knownSplits: vi.fn(() => []),
  fetchRecentSplits: vi.fn(async () => []),
}));

vi.mock('./stocktwits-feed.js', () => ({
  ST_CALL_TIMEOUT_MS: 6_000,
  fetchStockTwitsStream: vi.fn(async () => []),
  fetchStockTwitsUserStream: vi.fn(async () => []),
  getCuratedStockTwitsAccounts: vi.fn(() => ['acctA']),
  isStockTwitsBreakerOpen: vi.fn(() => false),
  stockTwitsBreakerOpenUntil: vi.fn(() => null),
  tripStockTwitsBreaker: vi.fn(),
  resetStockTwitsBreaker: vi.fn(),
  probeStockTwits: vi.fn(async () => ({ ok: true })),
  DEFAULT_CURATED_STOCKTWITS_ACCOUNTS: ['acctA'],
}));

import type { StockTwitsMessage } from '@trading-app/shared';
import {
  SignalEngine,
  SOCIAL_SWEEP_BUDGET_MS,
  SOCIAL_SWEEP_GRADED_MAX_MS,
} from './signal-engine.js';
import {
  fetchStockTwitsStream,
  fetchStockTwitsUserStream,
  getCuratedStockTwitsAccounts,
} from './stocktwits-feed.js';
import { resetSweepCursors, sweepCursorSnapshot, type SweepPass } from './tick-sweep-budget.js';

const TRADING_TIME = new Date('2024-06-03T15:00:00Z').getTime();

/** Charge `s` seconds of feed latency against the sweep's wall clock. */
const chargeSeconds = (s: number) => vi.setSystemTime(new Date(Date.now() + s * 1000));

const msg = (id: number, symbols: string[]): StockTwitsMessage => ({
  id,
  createdAt: new Date(TRADING_TIME).toISOString(),
  sentiment: 'Bullish',
  symbols,
  curated: true,
});

type Internals = {
  mode: 'demo' | 'live';
  refreshSocialSentiment(): Promise<SweepPass>;
  curatedSocialCache: Map<string, StockTwitsMessage[]>;
  socialCache: Map<string, StockTwitsMessage[]>;
};
const inner = (e: SignalEngine) => e as unknown as Internals;

/** Every call — crowd and curated — costs `secondsPerCall` of wall clock. */
function chargeEveryCall(secondsPerCall: number): void {
  vi.mocked(fetchStockTwitsStream).mockImplementation(async () => {
    chargeSeconds(secondsPerCall);
    return [];
  });
  vi.mocked(fetchStockTwitsUserStream).mockImplementation(async (user: string) => {
    chargeSeconds(secondsPerCall);
    return [msg(user.charCodeAt(user.length - 1), [user.toUpperCase()])];
  });
}

const CURATED_9 = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9'];

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(TRADING_TIME);
  resetSweepCursors();
  vi.mocked(getCuratedStockTwitsAccounts).mockReturnValue([...CURATED_9]);
  chargeEveryCall(0);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ── The sizing, as an executable assertion ───────────────────────────────────
// TRA-2262's lesson, applied at the point it was learned: PUT THE SPEC'S
// ARITHMETIC IN THE SUITE, NOT THE COMMENT. That ticket's own budget was 5×
// wrong and a prose review passed it; the unit test encoding its numbers is what
// caught it. A spec number that never executes is never falsified.
describe('the social-sentiment budget is sized against the graded bar (TRA-3019)', () => {
  it('worst pass = budget + one in-flight crowd call + one forced curated call <= the 30s bar', async () => {
    // The REAL constant, not this file's mock copy — the derivation must be
    // asserted against the value that actually ships.
    const { ST_CALL_TIMEOUT_MS } = await vi.importActual<
      typeof import('./stocktwits-feed.js')
    >('./stocktwits-feed.js');

    expect(ST_CALL_TIMEOUT_MS).toBeGreaterThan(0);

    // Why TWO timeouts and not one: the budget is checked AFTER a batch (it has
    // to be — the overrun is always the call already in flight), so the crowd
    // lane can cross the line and still owe one full call; and
    // `runBudgetedSweep`'s forward-progress invariant runs one curated account
    // even on a pass whose budget the crowd lane consumed entirely.
    const worstPassMs = SOCIAL_SWEEP_BUDGET_MS + 2 * ST_CALL_TIMEOUT_MS;

    expect(worstPassMs).toBeLessThanOrEqual(SOCIAL_SWEEP_GRADED_MAX_MS);
  });

  it('the shared 30s SWEEP_BUDGET_MS could NOT have met this bar — this sink needs its own', async () => {
    const { ST_CALL_TIMEOUT_MS } = await vi.importActual<
      typeof import('./stocktwits-feed.js')
    >('./stocktwits-feed.js');
    const { SWEEP_BUDGET_MS } = await vi.importActual<
      typeof import('./tick-sweep-budget.js')
    >('./tick-sweep-budget.js');

    // This is the whole reason TRA-3019 does not simply reuse the constant the
    // other four bounded sinks share: 30_000 + 12_000 = 42s against a 30s bar.
    // Stated as a test so "just reuse SWEEP_BUDGET_MS" fails loudly.
    expect(SWEEP_BUDGET_MS + 2 * ST_CALL_TIMEOUT_MS)
      .toBeGreaterThan(SOCIAL_SWEEP_GRADED_MAX_MS);
    expect(SOCIAL_SWEEP_BUDGET_MS).toBeLessThan(SWEEP_BUDGET_MS);
  });

  it('leaves the MODAL rotation untruncated — the budget clears the measured p90', () => {
    // Measured p90 for the whole sink on the 2026-08-05 RTH tape: 9.55s. The cap
    // must bite only the tail, or the bound becomes a coverage cut (TRA-2262).
    const MEASURED_P90_MS = 9_550;
    expect(SOCIAL_SWEEP_BUDGET_MS).toBeGreaterThan(MEASURED_P90_MS);
  });
});

describe('refreshSocialSentiment is budgeted and cursored (TRA-3019)', () => {
  // ── RED direction ──────────────────────────────────────────────────────────
  it('truncates instead of running 17 serial calls to exhaustion', async () => {
    chargeEveryCall(6); // every call times out — the pathological tape
    const engine = new SignalEngine();

    const pass = await inner(engine).refreshSocialSentiment();

    expect(pass.complete).toBe(false);
    expect(pass.budgetExhausted).toBe(true);
    // The old loop ran all 17 calls in one tick (102s). This one stops early.
    const calls = vi.mocked(fetchStockTwitsStream).mock.calls.length
      + vi.mocked(fetchStockTwitsUserStream).mock.calls.length;
    expect(calls).toBeLessThan(17);
  });

  it('one pass stays inside the graded 30s bar even when EVERY call times out', async () => {
    chargeEveryCall(6);
    const engine = new SignalEngine();

    const startedAt = Date.now();
    const pass = await inner(engine).refreshSocialSentiment();
    const elapsed = Date.now() - startedAt;

    // The measured defect was 62.12s. This is the assertion that fails if the
    // bound is ever removed or widened past its derivation.
    expect(elapsed).toBeLessThanOrEqual(SOCIAL_SWEEP_GRADED_MAX_MS);
    expect(pass.elapsedMs).toBeLessThanOrEqual(SOCIAL_SWEEP_GRADED_MAX_MS);
  });

  it('the curated lane still makes forward progress when the crowd lane ate the whole budget', async () => {
    chargeEveryCall(6);
    const engine = new SignalEngine();

    await inner(engine).refreshSocialSentiment();

    // Not zero: a budget the crowd lane consumed entirely must not starve the
    // curated rotation forever. `runBudgetedSweep` guarantees one batch per pass.
    expect(vi.mocked(fetchStockTwitsUserStream).mock.calls.length).toBe(1);
  });

  it('resumes where it stopped, and the rotation covers BOTH lanes across ticks', async () => {
    chargeEveryCall(6);
    const engine = new SignalEngine();

    for (let tick = 0; tick < 12 && !(await inner(engine).refreshSocialSentiment()).complete; tick++) {
      // re-enter on the next tick, exactly as the doTick call site does
    }

    // Every curated account visited exactly once across the rotation — no
    // account is skipped by the slicing, and none is fetched twice.
    const visited = vi.mocked(fetchStockTwitsUserStream).mock.calls.map(c => c[0]);
    expect([...visited].sort()).toEqual([...CURATED_9].sort());
  });

  // ── GREEN direction ────────────────────────────────────────────────────────
  // A control that only shows the detector FIRING is half a control (TRA-1787).
  // Below the budget this sink must behave exactly as it did before the bound.
  it('a fast rotation completes in ONE pass and clears both cursors — no change below the budget', async () => {
    chargeEveryCall(0);
    const engine = new SignalEngine();

    const pass = await inner(engine).refreshSocialSentiment();

    expect(pass.complete).toBe(true);
    expect(pass.budgetExhausted).toBe(false);
    expect(vi.mocked(fetchStockTwitsUserStream).mock.calls.length).toBe(CURATED_9.length);
    expect(sweepCursorSnapshot()['demo:-:social-crowd']).toBeUndefined();
    expect(sweepCursorSnapshot()['demo:-:social-curated']).toBeUndefined();
  });

  it('preserves the SOCIAL_SYMBOL_LIMIT quota control — a rotation is still at most 8 crowd fetches', async () => {
    chargeEveryCall(0);
    const engine = new SignalEngine();

    await inner(engine).refreshSocialSentiment();

    // The cursor rotates WITHIN the head slice; it does not widen it. This is
    // the quota concern the ticket insisted must not be conflated with latency.
    expect(vi.mocked(fetchStockTwitsStream).mock.calls.length).toBeLessThanOrEqual(8);
  });

  it('a cursor is per-ENGINE, so a live engine does not consume a demo rotation', async () => {
    chargeEveryCall(6);
    const demo = new SignalEngine();
    const live = new SignalEngine();
    inner(live).mode = 'live';

    // Advance demo TWO passes so its cursor is unambiguously mid-rotation. (One
    // pass each is not a discriminating test: both engines would start at 0 and
    // park on the same symbol, so equal cursor VALUES prove nothing either way —
    // the property is that the two lanes are separately keyed and separately
    // positioned, which only a differing START INDEX can show.)
    await inner(demo).refreshSocialSentiment();
    const demoSecond = await inner(demo).refreshSocialSentiment();
    const livePass = await inner(live).refreshSocialSentiment();

    expect(demoSecond.startIndex).toBeGreaterThan(0);
    expect(livePass.startIndex).toBe(0);
    expect(sweepCursorSnapshot()).toHaveProperty('live:-:social-curated');
    expect(sweepCursorSnapshot()).toHaveProperty('demo:-:social-curated');
  });
});

// ── The consumer hazard, which is the part that fails SILENTLY ───────────────
// TRA-2262: BEFORE YOU TRUNCATE A PRODUCER, ENUMERATE ITS CONSUMERS AND ASK
// WHICH ONE TREATS "ABSENT" AS "NOT YET". `curatedSocialCache` is rebuilt
// WHOLESALE, so a partial rotation would publish a thinner snapshot with nothing
// throwing and no fetch failing.
describe('a truncated curated rotation never publishes a partial snapshot (TRA-3019)', () => {
  it('leaves the previous whole-universe snapshot in place mid-rotation', async () => {
    chargeEveryCall(6);
    const engine = new SignalEngine();
    const previous = new Map([['OLD', [msg(1, ['OLD'])]]]);
    inner(engine).curatedSocialCache = previous;

    const pass = await inner(engine).refreshSocialSentiment();

    expect(pass.complete).toBe(false);
    // Untouched — NOT replaced by the 1-account slice that just ran.
    expect(inner(engine).curatedSocialCache).toBe(previous);
  });

  it('publishes the WHOLE rotation once it completes, not just its final slice', async () => {
    chargeEveryCall(6);
    const engine = new SignalEngine();

    for (let tick = 0; tick < 12 && !(await inner(engine).refreshSocialSentiment()).complete; tick++) {
      // drive the rotation to completion
    }

    // Every curated account contributed one message naming its own symbol, so a
    // whole-universe publish has all 9 keys. A "publish the last slice" bug
    // would leave 1-3 here — and would look completely healthy.
    expect(inner(engine).curatedSocialCache.size).toBe(CURATED_9.length);
  });

  it('keeps the last snapshot when NO account responded across the whole rotation', async () => {
    // Every account degrades to null (breaker open / 429 / cold) — the
    // pre-existing "a transient blip never wipes a good read" contract, which
    // must now be evaluated over the ROTATION rather than over one slice.
    vi.mocked(fetchStockTwitsUserStream).mockImplementation(async () => null);
    vi.mocked(fetchStockTwitsStream).mockImplementation(async () => null);
    const engine = new SignalEngine();
    const previous = new Map([['OLD', [msg(1, ['OLD'])]]]);
    inner(engine).curatedSocialCache = previous;

    const pass = await inner(engine).refreshSocialSentiment();

    expect(pass.complete).toBe(true);
    expect(inner(engine).curatedSocialCache).toBe(previous);
  });

  it('a crowd symbol the truncation never reached keeps its previous batch', async () => {
    chargeEveryCall(6);
    const engine = new SignalEngine();
    const stale = [msg(7, ['ZZZZ'])];
    inner(engine).socialCache.set('ZZZZ', stale);

    await inner(engine).refreshSocialSentiment();

    // `socialCache` is a per-symbol upsert, so an unvisited symbol degrades
    // exactly as it already did under a null fetch. No accumulator needed here.
    expect(inner(engine).socialCache.get('ZZZZ')).toBe(stale);
  });
});
