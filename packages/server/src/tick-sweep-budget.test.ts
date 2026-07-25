import { describe, it, expect, beforeEach } from 'vitest';
import {
  runBudgetedSweep,
  nextSweepDelayMs,
  resetSweepCursors,
  SWEEP_BUDGET_MS,
  SWEEP_RESUME_INTERVAL_MS,
  type SweepCursorStore,
  type SweepPass,
} from './tick-sweep-budget.js';

// An in-memory cursor store, so the suite never touches DATA_DIR. The persisted
// default (`sweepCursors`) is the SAME interface; the only extra behaviour there
// is a throttled disk mirror that degrades to this on an IO failure.
function memoryCursors(seed: Record<string, string> = {}): SweepCursorStore & { map: Record<string, string> } {
  const map: Record<string, string> = { ...seed };
  return {
    map,
    get: (k) => map[k] ?? null,
    set: (k, v) => { map[k] = v; },
    clear: (k) => { delete map[k]; },
  };
}

/** A clock that only moves when a batch says it did — the budget is wall-clock, so tests own it. */
function fakeClock() {
  let t = 1_000_000;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

const universe = (n: number): string[] => Array.from({ length: n }, (_, i) => `S${i}`);

beforeEach(() => {
  resetSweepCursors();
});

describe('runBudgetedSweep — the bound', () => {
  it('stops once the budget is spent and parks the cursor on the first UNPROCESSED symbol', async () => {
    const cursors = memoryCursors();
    const clock = fakeClock();
    const symbols = universe(100);

    const pass = await runBudgetedSweep({
      key: 'mtf',
      symbols,
      cursors,
      budgetMs: 10_000,
      now: clock.now,
      run: async () => { clock.advance(2_000); },
    });

    // 5 batches × 2s == the 10s budget; the 5th is what trips it.
    expect(pass.processed).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
    expect(pass.complete).toBe(false);
    expect(pass.budgetExhausted).toBe(true);
    expect(pass.resumeAt).toBe('S5');
    expect(cursors.map['mtf']).toBe('S5');
  });

  it('resumes exactly where the previous pass stopped, and covers the universe across passes', async () => {
    const cursors = memoryCursors();
    const symbols = universe(12);
    const seen: string[] = [];
    const passes: SweepPass[] = [];

    for (let n = 0; n < 3; n++) {
      const clock = fakeClock();
      passes.push(await runBudgetedSweep({
        key: 'mtf',
        symbols,
        cursors,
        budgetMs: 10_000,
        now: clock.now,
        run: async (batch) => { seen.push(...batch); clock.advance(2_500); },
      }));
    }

    // 4 symbols per pass (the 4th trips the 10s budget) ⇒ full coverage in 3,
    // each symbol exactly once — the property a shard/modulo scheme gives up
    // when the universe size changes under it.
    expect(passes.map(p => p.processed.length)).toEqual([4, 4, 4]);
    expect(passes.map(p => p.startIndex)).toEqual([0, 4, 8]);
    expect(seen).toEqual(symbols);
    expect(passes[2]!.complete).toBe(true);
    expect(passes[2]!.resumeAt).toBeNull();
    // A completed sweep CLEARS the cursor, so the next rotation starts fresh.
    expect(cursors.map['mtf']).toBeUndefined();
  });

  it('never starves: a single batch that blows the whole budget still runs and still advances', async () => {
    const cursors = memoryCursors();
    const clock = fakeClock();

    const pass = await runBudgetedSweep({
      key: 'mtf',
      symbols: universe(10),
      cursors,
      budgetMs: 10_000,
      now: clock.now,
      run: async () => { clock.advance(900_000); }, // the 935s cold sweep, in one symbol
    });

    expect(pass.processed).toEqual(['S0']);
    expect(pass.budgetExhausted).toBe(true);
    expect(cursors.map['mtf']).toBe('S1');
  });

  it('fans out in batches when batchSize > 1 (the mtf BATCH=5 shape)', async () => {
    const cursors = memoryCursors();
    const clock = fakeClock();
    const rounds: string[][] = [];

    const pass = await runBudgetedSweep({
      key: 'mtf',
      symbols: universe(568),
      cursors,
      batchSize: 5,
      budgetMs: 10_000,
      now: clock.now,
      // 1.65 s/symbol at BATCH=5 (935.1s / 568, off the TRA-2203 tape).
      run: async (batch) => { rounds.push(batch); clock.advance(Math.round(1.646 * 5 * 1000)); },
    });

    // ~10s / 8.23s per round ⇒ 2 rounds ⇒ 10 symbols. The point of the assertion
    // is the BOUND, not the count: the pass is O(budget), not O(universe).
    expect(pass.elapsedMs).toBeLessThan(2 * 10_000);
    expect(pass.processed.length).toBeLessThan(568);
    expect(rounds.every(r => r.length === 5)).toBe(true);
    expect(pass.complete).toBe(false);
  });
});

describe('runBudgetedSweep — cursor integrity', () => {
  it('restarts when the parked symbol has left the universe (membership churn)', async () => {
    const cursors = memoryCursors({ mtf: 'GONE' });
    const clock = fakeClock();

    const pass = await runBudgetedSweep({
      key: 'mtf',
      symbols: ['AAPL', 'MSFT'],
      cursors,
      now: clock.now,
      run: async () => { clock.advance(1); },
    });

    expect(pass.startIndex).toBe(0);
    expect(pass.processed).toEqual(['AAPL', 'MSFT']);
    expect(pass.complete).toBe(true);
  });

  it('an empty universe completes and clears rather than parking a stale cursor', async () => {
    const cursors = memoryCursors({ mtf: 'AAPL' });
    const pass = await runBudgetedSweep({ key: 'mtf', symbols: [], cursors, run: async () => {} });
    expect(pass.complete).toBe(true);
    expect(pass.total).toBe(0);
    expect(cursors.map['mtf']).toBeUndefined();
  });

  it('a throw out of the worker advances PAST the offending batch (no livelock)', async () => {
    const cursors = memoryCursors();
    await expect(runBudgetedSweep({
      key: 'otm',
      symbols: universe(10),
      cursors,
      run: async () => { throw new Error('feed exploded'); },
    })).rejects.toThrow('feed exploded');

    // Parked on S1, not S0 — a symbol that fails every pass cannot wedge the sweep.
    expect(cursors.map['otm']).toBe('S1');
  });

  it('a worker-side gate (`false`) stops the sweep and leaves the cursor ON the un-run batch', async () => {
    const cursors = memoryCursors();
    const clock = fakeClock();
    const seen: string[] = [];

    const pass = await runBudgetedSweep({
      key: 'otm',
      symbols: universe(10),
      cursors,
      now: clock.now,
      // Mirrors runOtmScan's iv-rv daily-cap `break`: refuse from S3 on.
      run: async (batch) => {
        if (batch[0] === 'S3') return false;
        seen.push(...batch);
        clock.advance(10);
        return undefined;
      },
    });

    expect(seen).toEqual(['S0', 'S1', 'S2']);
    expect(pass.stopped).toBe(true);
    expect(pass.complete).toBe(false);
    expect(pass.budgetExhausted).toBe(false);
    expect(cursors.map['otm']).toBe('S3');
  });
});

describe('nextSweepDelayMs — the half of the bound that protects coverage', () => {
  const pass = (over: Partial<SweepPass>): SweepPass => ({
    processed: [], total: 10, startIndex: 0, complete: false,
    budgetExhausted: true, stopped: false, resumeAt: 'S1', elapsedMs: 10_000, ...over,
  });

  it('re-enters on the NEXT TICK while a sweep is unfinished, so slicing is not a coverage cut', () => {
    expect(nextSweepDelayMs(pass({}), 5 * 60_000)).toBe(0);
    expect(SWEEP_RESUME_INTERVAL_MS).toBe(0);
  });

  it('reverts to the sink throttle once the sweep completes', () => {
    expect(nextSweepDelayMs(pass({ complete: true, resumeAt: null }), 5 * 60_000)).toBe(5 * 60_000);
  });

  it('reverts to the sink throttle when a caller-side gate stopped the pass', () => {
    // The gate (e.g. the options daily cap) will still be shut on the next tick —
    // re-entering immediately would spin. The cursor holds its place either way.
    expect(nextSweepDelayMs(pass({ stopped: true }), 5 * 60_000)).toBe(5 * 60_000);
  });

  it('treats "no pass yet" as the normal throttle', () => {
    expect(nextSweepDelayMs(null, 5 * 60_000)).toBe(5 * 60_000);
  });
});

describe('the sizing, re-derived off the TRA-2203 tape', () => {
  // ⭐ The Σ-leader is not the tail owner: `mtf-refresh` is 12.0% of Σ and owns
  // 77% of the worst tick (935.1s of 1,214.9s). These pin the arithmetic the
  // bound was sized on, so a later edit to SWEEP_BUDGET_MS has to face it.
  const UNIVERSE = 568;
  const TICK_MS = 30_000; // SignalEngine.start(): setInterval(tick, 30_000)
  const MAX_S = { mtf: 935.1, shortPremium: 293.0, otm: 213.8, coldBar: 205.9 };
  const WORST_TICK_S = 1_214.9;

  /** Wall clock per symbol, amortised over the fan-out the max already contains. */
  const perSymbolS = (maxS: number): number => maxS / UNIVERSE;
  /** Minutes to sweep the universe at one budgeted pass per tick. */
  const sweepMinutes = (maxS: number, budgetMs: number): number =>
    (Math.ceil(UNIVERSE / Math.floor((budgetMs / 1000) / perSymbolS(maxS))) * TICK_MS) / 60_000;

  it('🔴 refutes the ticket: 1.65 s/symbol is ALREADY amortised over BATCH=5, so 10s buys 6 symbols, not 30', () => {
    // 935.1s over 568 symbols in 5-wide rounds = 114 rounds of 8.23s. Reading
    // 1.65 s/symbol as a per-symbol LATENCY and then crediting the batch a
    // second time is what produced the ticket's "≈30 symbols/tick".
    expect(perSymbolS(MAX_S.mtf)).toBeCloseTo(1.646, 3);
    expect(UNIVERSE / 5).toBeCloseTo(113.6, 1);
    expect(MAX_S.mtf / (UNIVERSE / 5)).toBeCloseTo(8.23, 2);

    expect(Math.floor(10 / perSymbolS(MAX_S.mtf))).toBe(6);          // not 30
    expect(sweepMinutes(MAX_S.mtf, 10_000)).toBeCloseTo(47.5, 1);    // vs 15.6 min today
  });

  it('30s is the coverage-parity point: every bounded sink sweeps within ~10% of today', () => {
    const today = (maxS: number) => maxS / 60;
    for (const maxS of [MAX_S.mtf, MAX_S.shortPremium, MAX_S.otm]) {
      const bounded = sweepMinutes(maxS, SWEEP_BUDGET_MS);
      expect(bounded).toBeGreaterThan(today(maxS) * 0.9);
      expect(bounded).toBeLessThan(today(maxS) * 1.15);
    }
    expect(SWEEP_BUDGET_MS).toBe(30_000);
  });

  it('the purchasable tail has a floor of ~280s that this ticket does not scope', () => {
    // Everything outside the three bounded sinks — `cold-bar-scan` (max 205.9s)
    // and the rest — survives at any budget, so the graded max is 3B + ~280s.
    const residualS = WORST_TICK_S - MAX_S.mtf;
    expect(residualS).toBeCloseTo(279.8, 1);
    expect(residualS).toBeGreaterThan(MAX_S.coldBar);

    const graded = (budgetMs: number) => (3 * budgetMs) / 1000 + residualS;
    expect(graded(SWEEP_BUDGET_MS)).toBeCloseTo(369.8, 1);   // 6.2 min
    // Tripling the coverage cost (30s → 10s) buys 60s off a ~370s tick.
    expect(graded(SWEEP_BUDGET_MS) - graded(10_000)).toBeCloseTo(60, 1);
    // Either way, the number gating the live arm falls from 20m15s to ~6m.
    expect(WORST_TICK_S / graded(SWEEP_BUDGET_MS)).toBeGreaterThan(3);
  });
});
