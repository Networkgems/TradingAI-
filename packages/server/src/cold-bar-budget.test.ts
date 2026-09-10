// TRA-3441 (phase 2 of TRA-2171) — the `signal.doTick.cold-bar-scan` wall-clock
// bound.
//
// On the boot-excluded 2026-08-12 RTH tape this sink was n=2916, share 25.9%,
// p50 4.9s, p90 28.9s and **max 123.9s** — the #1 tail owner of `signal.doTick`
// and the largest unbounded fan-out left after TRA-2262 / TRA-2477 / TRA-3019.
// TRA-2171 phase 1 WRAPPED it for instrumentation and stopped there; measuring a
// sink is not bounding it.
//
// Three things have to hold for this bound to be a latency win rather than a
// coverage cut wearing one, and none of them fails loudly:
//
//   1. the overrun term must be a number this repo OWNS. The budget is checked
//      after a batch, so the worst pass is `budget + one batch`, and a batch is
//      one `refreshCandles` call deep — a call whose Tradier primary issues a
//      bare `fetch()` with no `AbortSignal` and whose fallback chain alone is
//      worth 35s against a 60s bar. Hence the per-call deadline;
//   2. the shard counter must advance once per SWEEP, never once per SLICE. The
//      sweep's cursor is a SYMBOL, so a resumed pass handed a differently-sharded
//      universe cannot find its position and restarts at 0 — the truncated tail
//      is then never fetched, and nothing anywhere says so;
//   3. the producer must UPSERT rather than REPLACE, or a truncated pass
//      publishes a partial snapshot as a whole one (TRA-3019's silent defect).
//
// Each of the three is pinned below, in both directions where the direction is
// meaningful.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

vi.mock('./yahoo-feed.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./yahoo-feed.js')>();
  return {
    ...actual,
    // Each per-symbol pull burns a fixed slice of the hand-driven clock and
    // returns one bar, so the cache-upsert property is observable alongside the
    // wall clock the pull costs.
    fetchMinuteBarsWithSource: vi.fn(async (symbol: string) => {
      clock += MS_PER_SYMBOL;
      return {
        bars: [{ symbol, timestamp: clock, open: 1, high: 1, low: 1, close: 1, volume: 1 }],
        source: 'tradier' as const,
        yahooSkipped: false,
      };
    }),
  };
});

import { DEFAULT_ACCOUNT_SETTINGS } from '@trading-app/shared';
import type { Candle } from '@trading-app/shared';
import {
  SignalEngine,
  COLD_BAR_SWEEP_BUDGET_MS,
  COLD_BAR_CALL_DEADLINE_MS,
  COLD_BAR_SWEEP_GRADED_MAX_MS,
  COLD_BAR_BATCH,
  COLD_SCAN_INTERVAL,
  coldScanUniverse,
  coldScanShardAdvances,
} from './signal-engine.js';
import { MINUTE_BAR_FALLBACK_CEILING_MS, YF_CALL_TIMEOUT_MS, fetchMinuteBarsWithSource } from './yahoo-feed.js';
import { resetSweepCursors, sweepCursorSnapshot, SWEEP_BUDGET_MS, type SweepPass } from './tick-sweep-budget.js';

/** Measured on the 2026-08-12 RTH tape — the numbers this budget is sized against. */
const MEASURED_P90_MS = 28_900;
const MEASURED_MAX_MS = 123_900;

/** 2.2s per symbol x 5-wide batch = an 11s batch, so three batches cross the 30s budget. */
const MS_PER_SYMBOL = 2_200;

let clock = 1_000_000;

/**
 * The clock spy, restored one-by-one rather than through `vi.restoreAllMocks()`:
 * that would also reset the `fetchMinuteBarsWithSource` module mock's
 * implementation to `undefined`, and the sweep tests would then walk a universe
 * whose pulls cost nothing — a budget test that can never see the budget bite.
 */
let nowSpy: ReturnType<typeof vi.spyOn> | null = null;

beforeEach(() => {
  clock = 1_000_000;
  nowSpy = vi.spyOn(Date, 'now').mockImplementation(() => clock);
  resetSweepCursors();
});

afterEach(() => {
  nowSpy?.mockRestore();
  nowSpy = null;
  resetSweepCursors();
});

type ColdBarInternals = {
  runColdBarScan(symbols: string[]): Promise<SweepPass>;
  candleCache: Map<string, Candle[]>;
};

function engine(mode: 'demo' | 'live' = 'demo', username?: string): {
  scan: (syms: string[]) => Promise<SweepPass>;
  candleCache: Map<string, Candle[]>;
} {
  const e = new SignalEngine({ ...DEFAULT_ACCOUNT_SETTINGS, mode });
  if (username) e.setAlertUsername(username);
  // `private` in TS only. The bound lives in this method, so drive the real
  // thing rather than a re-implementation of it.
  const inner = e as unknown as ColdBarInternals;
  return { scan: inner.runColdBarScan.bind(e), candleCache: inner.candleCache };
}

const universeOf = (n: number) => Array.from({ length: n }, (_, i) => `S${i}`);

// ── The sizing, as an executable assertion ───────────────────────────────────
// TRA-2262's lesson, applied at the spot it was learned: PUT THE SPEC'S
// ARITHMETIC IN THE SUITE, NOT THE COMMENT. That ticket's own budget was 5x
// wrong and a prose review passed it; the unit test encoding its numbers is what
// caught it. A spec number that never executes is never falsified.
describe('the cold-bar budget is sized against the graded bar (TRA-3441)', () => {
  it('worst pass = budget + the one call already in flight <= the 60s bar', () => {
    // Why ONE call and not five: a batch is `Promise.all` over COLD_BAR_BATCH
    // concurrent pulls, so the batch's wall clock is the SLOWEST call in it, not
    // their sum. Why a call at all: the budget is checked AFTER a batch — it has
    // to be, the overrun is always the call already in flight — and
    // `runBudgetedSweep`'s forward-progress invariant runs one batch even on a
    // pass whose budget is already spent.
    const worstPassMs = COLD_BAR_SWEEP_BUDGET_MS + COLD_BAR_CALL_DEADLINE_MS;

    expect(worstPassMs).toBeLessThanOrEqual(COLD_BAR_SWEEP_GRADED_MAX_MS);
  });

  it('a budget ALONE could not have met the bar — the per-call deadline is load-bearing', () => {
    // The real ceiling of one `fetchMinuteBarsWithSource`, off the shipped
    // constants: Yahoo's retry ladder + the Twelve Data fallback. It is a LOWER
    // bound — the Tradier primary has no `AbortSignal` at all — and it already
    // exceeds the headroom a 30s budget leaves under a 60s bar.
    expect(YF_CALL_TIMEOUT_MS).toBeGreaterThan(0);
    expect(MINUTE_BAR_FALLBACK_CEILING_MS).toBeGreaterThanOrEqual(4 * YF_CALL_TIMEOUT_MS);

    expect(COLD_BAR_SWEEP_BUDGET_MS + MINUTE_BAR_FALLBACK_CEILING_MS)
      .toBeGreaterThan(COLD_BAR_SWEEP_GRADED_MAX_MS);

    // …and the deadline is what brings the overrun term back under the bar.
    expect(COLD_BAR_CALL_DEADLINE_MS).toBeLessThan(MINUTE_BAR_FALLBACK_CEILING_MS);
  });

  it('the shared SWEEP_BUDGET_MS is reusable here — but only because the deadline exists', () => {
    // TRA-3019 could not reuse the shared constant (30s + 2 x 6s = 42s against a
    // 30s bar). This sink can, and the reason is stated as a test so that
    // "consistency" never silently becomes an unchecked assumption about the
    // overrun terms: the bar is twice as generous AND the overrun is capped.
    expect(COLD_BAR_SWEEP_BUDGET_MS).toBe(SWEEP_BUDGET_MS);
    expect(SWEEP_BUDGET_MS + COLD_BAR_CALL_DEADLINE_MS)
      .toBeLessThanOrEqual(COLD_BAR_SWEEP_GRADED_MAX_MS);
  });

  it('leaves the MODAL pass untruncated — the budget clears the measured p90', () => {
    // p90 28.9s on the 2026-08-12 tape. The cap must bite only the tail, or the
    // bound becomes a coverage cut (TRA-2262) — and this sink's coverage is
    // spent against `MAX_CANDLE_AGE_MS`, so overrunning it trips `feed_stale`.
    expect(COLD_BAR_SWEEP_BUDGET_MS).toBeGreaterThan(MEASURED_P90_MS);
    // …and the bar is a real improvement on the measured defect, not a restatement.
    expect(COLD_BAR_SWEEP_GRADED_MAX_MS).toBeLessThan(MEASURED_MAX_MS);
  });
});

// ── The bound itself, through the real engine method ─────────────────────────

describe('runColdBarScan is wall-clock bounded (TRA-3441)', () => {
  it('RED — stops at the budget and parks a cursor instead of walking the whole shard', async () => {
    const { scan } = engine();
    const universe = universeOf(40);

    const pass = await scan(universe);

    const perBatchMs = MS_PER_SYMBOL * COLD_BAR_BATCH;
    const expectedBatches = Math.ceil(COLD_BAR_SWEEP_BUDGET_MS / perBatchMs);
    expect(pass.processed).toHaveLength(expectedBatches * COLD_BAR_BATCH);
    expect(pass.complete).toBe(false);
    expect(pass.budgetExhausted).toBe(true);
    expect(pass.resumeAt).toBe(`S${expectedBatches * COLD_BAR_BATCH}`);
    expect(pass.total).toBe(40);
    // Per-ENGINE cursor: demo and live sweep the same watchlist and must not
    // consume each other's position.
    expect(sweepCursorSnapshot()['demo:-:cold-bar-scan']).toBe(pass.resumeAt);
  });

  it('one pass stays inside the graded 60s bar on the pathological tape', async () => {
    const { scan } = engine();
    const startedAt = clock;

    const pass = await scan(universeOf(400));

    // The measured defect was 123.9s. This is the assertion that fails if the
    // bound is removed or widened past its derivation.
    expect(clock - startedAt).toBeLessThanOrEqual(COLD_BAR_SWEEP_GRADED_MAX_MS);
    expect(pass.elapsedMs).toBeLessThanOrEqual(COLD_BAR_SWEEP_GRADED_MAX_MS);
  });

  it('GREEN control — a universe inside the budget completes and clears the cursor', async () => {
    const { scan } = engine();
    const universe = universeOf(5); // one 11s batch, well under 30s

    const pass = await scan(universe);

    expect(pass.complete).toBe(true);
    expect(pass.budgetExhausted).toBe(false);
    expect(pass.processed).toEqual(universe);
    expect(pass.resumeAt).toBeNull();
    expect(sweepCursorSnapshot()['demo:-:cold-bar-scan']).toBeUndefined();
  });

  it('successive passes resume where the last stopped and cover the universe exactly once', async () => {
    const { scan } = engine();
    const universe = universeOf(40);

    const seen: string[] = [];
    let pass: SweepPass | null = null;
    for (let i = 0; i < 10 && (pass == null || !pass.complete); i++) {
      pass = await scan(universe);
      seen.push(...pass.processed);
    }

    expect(pass?.complete).toBe(true);
    // No gaps and no repeats — the property a symbol cursor buys over an index.
    expect(seen).toEqual(universe);
    expect(sweepCursorSnapshot()['demo:-:cold-bar-scan']).toBeUndefined();
  });

  it('two engines keep separate cursors over the same watchlist', async () => {
    const universe = universeOf(40);
    await engine('demo').scan(universe);
    const demoAt = sweepCursorSnapshot()['demo:-:cold-bar-scan'];

    // The live engine starts its own rotation at 0 rather than inheriting demo's.
    const livePass = await engine('live').scan(universe);

    expect(livePass.startIndex).toBe(0);
    expect(sweepCursorSnapshot()['demo:-:cold-bar-scan']).toBe(demoAt);
    expect(sweepCursorSnapshot()['live:-:cold-bar-scan']).toBe(livePass.resumeAt);
  });
});

// ── TRA-4519 — an engine is a BOOK, not a mode ───────────────────────────────
// `initAllUserContexts` builds one engine per user and the cursor store is
// process-wide. bqb1 2026-09-10: 68 engines, THREE of them `live` (admin and
// v0nni on production, Richard on sandbox) — so a `${mode}:${sink}` key had the
// real-money book resume at whatever symbol another live book last parked on.

describe('the sweep cursor is keyed per BOOK, not per mode (TRA-4519)', () => {
  it('two books of the SAME mode with different universes do not share a cursor', async () => {
    const admin = engine('live', 'admin');
    const other = engine('live', 'v0nni');
    const adminUniverse = universeOf(40);

    const first = await admin.scan(adminUniverse);
    expect(first.resumeAt).not.toBeNull();

    // The other book holds admin's parked symbol MID-list — the shape that made a
    // shared cursor resume there and skip `[0..cursor)` of a universe not its own.
    const otherUniverse = ['B0', 'B1', first.resumeAt!, 'B3', 'B4', 'B5', 'B6', 'B7'];
    const otherPass = await other.scan(otherUniverse);
    expect(otherPass.startIndex).toBe(0);
    expect(otherPass.processed[0]).toBe('B0');

    // …and the other book's pass (which completed and CLEARED its cursor) did not
    // reset admin's rotation to 0 either.
    const second = await admin.scan(adminUniverse);
    expect(second.startIndex).toBe(adminUniverse.indexOf(first.resumeAt!));

    const keys = Object.keys(sweepCursorSnapshot()).filter((k) => k.endsWith(':cold-bar-scan'));
    expect(keys).toEqual(['live:admin:cold-bar-scan']);
  });

  it('no sink hand-rolls a mode-only cursor key — every one goes through `sweepKey`', () => {
    const src = readFileSync(fileURLToPath(new URL('./signal-engine.ts', import.meta.url)), 'utf8');
    // The one legitimate `${this.mode}:` template is `sweepKey`'s own body.
    expect(src.match(/`\$\{this\.mode\}:/g)).toHaveLength(1);
    const sinks = new Set([...src.matchAll(/this\.sweepKey\('([^']+)'\)/g)].map((m) => m[1]));
    expect([...sinks].sort()).toEqual([
      'agents-advisory',
      'cold-bar-scan',
      'mtf-refresh',
      'otm-daily-series',
      'otm-scan',
      'short-premium-scan',
      'social-crowd',
      'social-curated',
      'supertrend-series',
    ]);
  });
});

// ── Trap 2: does slicing this producer publish a partial as a whole? ──────────

describe('the cold-bar producer UPSERTS, so a truncated pass cannot shrink a snapshot', () => {
  it('a truncated pass refreshes only what it reached and leaves the rest untouched', async () => {
    const { scan, candleCache } = engine();
    const universe = universeOf(40);

    const first = await scan(universe);
    expect(first.complete).toBe(false);

    // Exactly the symbols the pass reached carry bars; the rest carry NOTHING —
    // as opposed to the whole map being replaced by the partial (TRA-3019's
    // `curatedSocialCache` defect). Absence here is already the steady state for
    // 9 ticks in 10 under TRA-739's shard, so no consumer learns a new word.
    expect([...candleCache.keys()].sort()).toEqual([...first.processed].sort());

    const second = await scan(universe);

    // The resumed pass ADDS to the map — it does not rebuild it, so the symbols
    // covered by pass 1 keep their bars.
    for (const sym of first.processed) expect(candleCache.has(sym)).toBe(true);
    for (const sym of second.processed) expect(candleCache.has(sym)).toBe(true);
    expect(candleCache.size).toBe(first.processed.length + second.processed.length);
  });
});

// ── Trap: the shard counter must advance per SWEEP, never per SLICE ──────────
// This is the failure that costs COVERAGE rather than latency, and it is silent:
// no fetch fails, no counter moves, the truncated tail is simply never pulled.

describe('the cold-scan shard is latched to the sweep (TRA-3441)', () => {
  // 200 symbols ⇒ each shard slice is 20 symbols ⇒ 4 batches of 11s, so a slice
  // genuinely overruns the 30s budget and the tail these tests are about exists.
  const activeSymbols = universeOf(200);
  const activeInterest = new Set<string>(['S0']);

  it('the shard advances on an idle, completed, or caller-stopped sweep', () => {
    expect(coldScanShardAdvances(null)).toBe(true);
    expect(coldScanShardAdvances({ complete: true, stopped: false } as SweepPass)).toBe(true);
    expect(coldScanShardAdvances({ complete: false, stopped: true } as SweepPass)).toBe(true);
  });

  it('…and does NOT advance while a sweep is parked mid-universe', () => {
    expect(coldScanShardAdvances({ complete: false, stopped: false } as SweepPass)).toBe(false);
  });

  it('POSITIVE CONTROL — advancing the shard mid-rotation LOSES the truncated tail', async () => {
    // The defect this latch exists to prevent, demonstrated against the real
    // sweep. A cursor parked on a symbol that is not in the next universe cannot
    // resolve, so `runBudgetedSweep` restarts at index 0 of a DIFFERENT shard and
    // the tail of the first one is never fetched at all.
    const { scan } = engine();
    const shardA = coldScanUniverse(activeSymbols, activeInterest, 0);
    const shardB = coldScanUniverse(activeSymbols, activeInterest, 1);

    const first = await scan(shardA);
    expect(first.complete).toBe(false);

    const parked = first.resumeAt!;
    expect(shardB).not.toContain(parked); // the universe moved out from under it

    const second = await scan(shardB);
    expect(second.startIndex).toBe(0);
    expect(second.processed).not.toContain(parked);
  });

  it('holding the shard is what lets the resumed pass pick the tail up', async () => {
    const { scan } = engine();
    const shardA = coldScanUniverse(activeSymbols, activeInterest, 0);

    const first = await scan(shardA);
    const parked = first.resumeAt!;

    // Same universe, because `coldScanShardAdvances(first)` is false.
    expect(coldScanShardAdvances(first)).toBe(false);
    const second = await scan(shardA);

    expect(second.startIndex).toBeGreaterThan(0);
    expect(second.processed[0]).toBe(parked);
  });

  it('the universe is active-interest UNION the shard, and the shards partition the rest', () => {
    const covered = new Set<string>();
    for (let shard = 0; shard < COLD_SCAN_INTERVAL; shard++) {
      for (const sym of coldScanUniverse(activeSymbols, activeInterest, shard)) covered.add(sym);
    }
    // One full rotation still reaches every symbol — the bound must not change
    // WHICH symbols a rotation covers, only how many ticks it is spread over.
    expect([...covered].sort()).toEqual([...activeSymbols].sort());
    // …and an active-interest symbol is in EVERY tick's universe, shard or not.
    for (let shard = 0; shard < COLD_SCAN_INTERVAL; shard++) {
      expect(coldScanUniverse(activeSymbols, activeInterest, shard)).toContain('S0');
    }
  });
});

// ── The per-call deadline ────────────────────────────────────────────────────

describe('a hung candle pull is abandoned at the deadline (TRA-3441)', () => {
  beforeEach(() => {
    // The deadline is a real `setTimeout`, so this block drives timers rather
    // than the hand-rolled `clock` the budget tests use.
    nowSpy?.mockRestore();
    nowSpy = null;
    vi.useFakeTimers();
    vi.mocked(fetchMinuteBarsWithSource).mockImplementation(
      () => new Promise(() => { /* never settles — the unbounded Tradier fetch */ }),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('the sweep returns instead of waiting on a call with no ceiling of its own', async () => {
    const { scan } = engine();

    const pending = scan(['HUNG']);
    let settled = false;
    void pending.then(() => { settled = true; });

    // Just short of the deadline the sweep is still waiting…
    await vi.advanceTimersByTimeAsync(COLD_BAR_CALL_DEADLINE_MS - 1);
    expect(settled).toBe(false);

    // …and at it, the pass completes rather than hanging the whole tick.
    await vi.advanceTimersByTimeAsync(2);
    const pass = await pending;
    expect(pass.processed).toEqual(['HUNG']);
    expect(pass.complete).toBe(true);
  });
});
