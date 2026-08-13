// TRA-3442 — the bound on `signal.doTick.agents-advisory`.
//
// Every behavioural test here is CONTROLLED IN BOTH DIRECTIONS: alongside the
// assertion that the bound holds sits the pre-fix parameterisation (unbounded
// budget / breaker disabled) which must turn the SAME assertion RED. A control
// that only proves the instrument can FIRE cannot tell a fix from the bug
// (TRA-1787); a control that only proves it stays SILENT cannot tell a working
// gate from a dead one (TRA-1727).
import { describe, expect, it, beforeEach } from 'vitest';
import { LLM_CALL_CEILING_MS, LLM_CALL_TIMEOUT_MS, LLM_MAX_RETRIES } from '@trading-app/agents';
import {
  AGENTS_ADVISORY_BREAK_STREAK,
  AGENTS_ADVISORY_BREAKER_COOLDOWN_MS,
  AGENTS_ADVISORY_GRADED_MAX_MS,
  AGENTS_ADVISORY_SWEEP_BUDGET_MS,
  AGENTS_ADVISORY_SYMBOL_DEADLINE_MS,
  AdvisoryDeadlineError,
  advisoryWorstPassMs,
  assertAdvisoryBudgetArithmetic,
  runAdvisorySweep,
  withSymbolDeadline,
} from './agents-advisory-bound.js';
import type { SweepCursorStore } from './tick-sweep-budget.js';

/** In-memory cursor store — never touch the persisted one from a unit test. */
function memCursors(): SweepCursorStore & { map: Map<string, string> } {
  const map = new Map<string, string>();
  return {
    map,
    get: (k) => map.get(k) ?? null,
    set: (k, v) => void map.set(k, v),
    clear: (k) => void map.delete(k),
  };
}

/** The live universe size measured on the 2026-08-12 RTH tape (639 unique symbols/pass). */
const UNIVERSE = Array.from({ length: 639 }, (_, i) => `S${String(i).padStart(3, '0')}`);

/** A clock seam that advances by `stepMs` on every read, so budgets are deterministic. */
function steppingClock(stepMs: number): () => number {
  let t = 1_000_000;
  return () => {
    const v = t;
    t += stepMs;
    return v;
  };
}

describe('TRA-3442 — the sizing arithmetic lives in the suite, not only in a comment', () => {
  it('the shipped constants meet the pre-registered 60s bar', () => {
    expect(() => assertAdvisoryBudgetArithmetic()).not.toThrow();
    expect(advisoryWorstPassMs()).toBe(
      AGENTS_ADVISORY_SWEEP_BUDGET_MS + AGENTS_ADVISORY_SYMBOL_DEADLINE_MS,
    );
    expect(advisoryWorstPassMs()).toBeLessThanOrEqual(AGENTS_ADVISORY_GRADED_MAX_MS);
  });

  // CONTROL (other direction): the assertion is not a tautology — a budget that
  // would ship green and grade FAIL on the tape is caught HERE.
  it('a budget+deadline pair that breaches the bar is REJECTED', () => {
    expect(advisoryWorstPassMs(45_000, 25_000)).toBeGreaterThan(AGENTS_ADVISORY_GRADED_MAX_MS);
    expect(advisoryWorstPassMs(30_000, 40_000)).toBeGreaterThan(AGENTS_ADVISORY_GRADED_MAX_MS);
  });

  it('the overrun term is owned by the provider client, not guessed here', () => {
    // TRA-3441's lesson: the number that sizes a budget must be imported from the
    // module that owns it, so raising it fails THIS test rather than the tape.
    expect(LLM_CALL_CEILING_MS).toBe(LLM_CALL_TIMEOUT_MS * (1 + LLM_MAX_RETRIES));
    // A symbol deadline shorter than half a call ceiling would abandon work in
    // flight on every truncation — a spend leak wearing a bound's face.
    expect(AGENTS_ADVISORY_SYMBOL_DEADLINE_MS).toBeGreaterThanOrEqual(LLM_CALL_CEILING_MS / 2);
  });
});

describe('TRA-3442 — the per-symbol deadline', () => {
  it('passes a fast graph through untouched', async () => {
    await expect(withSymbolDeadline('AAPL', 50, async () => 'reco')).resolves.toBe('reco');
  });

  it('rejects with AdvisoryDeadlineError once the symbol outruns its deadline', async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r('late'), 200));
    await expect(withSymbolDeadline('AAPL', 20, slow)).rejects.toBeInstanceOf(AdvisoryDeadlineError);
  });

  // CONTROL (other direction): with the pre-fix behaviour (no deadline, i.e. a
  // deadline longer than the work) the SAME call resolves — so the rejection
  // above is the bound biting, not the helper being broken.
  it('the same slow graph RESOLVES when the deadline is wide (pre-fix behaviour)', async () => {
    const slow = () => new Promise<string>((r) => setTimeout(() => r('late'), 20));
    await expect(withSymbolDeadline('AAPL', 5_000, slow)).resolves.toBe('late');
  });

  it('an abandoned graph that rejects LATER does not surface as an unhandled rejection', async () => {
    const seen: unknown[] = [];
    const onUnhandled = (e: unknown): void => void seen.push(e);
    process.on('unhandledRejection', onUnhandled);
    try {
      const boom = () => new Promise<string>((_, rej) => setTimeout(() => rej(new Error('late 400')), 30));
      await expect(withSymbolDeadline('AAPL', 5, boom)).rejects.toBeInstanceOf(AdvisoryDeadlineError);
      await new Promise((r) => setTimeout(r, 80));
      expect(seen).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('TRA-3442 — the failure circuit breaker', () => {
  let cursors: ReturnType<typeof memCursors>;
  beforeEach(() => { cursors = memCursors(); });

  it('reproduces the 2026-08-12 defect: 100% failure walks the WHOLE universe when the breaker is off', async () => {
    // CONTROL — the pre-fix arm. `breakStreak` beyond the universe disables the
    // breaker, which is exactly the shipped-before behaviour: 639 doomed calls.
    let calls = 0;
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      budgetMs: Number.MAX_SAFE_INTEGER,
      breakStreak: UNIVERSE.length + 1,
      advise: async () => { calls++; return false; },
    });
    expect(calls).toBe(639);
    expect(r.breakerTripped).toBe(false);
    expect(r.failures).toBe(639);
    expect(r.pass.complete).toBe(true);
  });

  it('with the breaker armed the SAME universe costs 5 calls, not 639', async () => {
    let calls = 0;
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      budgetMs: Number.MAX_SAFE_INTEGER,
      advise: async () => { calls++; return false; },
    });
    expect(calls).toBe(AGENTS_ADVISORY_BREAK_STREAK);
    expect(r.breakerTripped).toBe(true);
    expect(r.maxConsecutiveFailures).toBe(AGENTS_ADVISORY_BREAK_STREAK);
    // `stopped`, NOT `budgetExhausted` — the two are distinct witnesses and the
    // grading rule must accept either. A breakered pass emits no truncation
    // marker, so treating the budget marker as the only positive witness would
    // read a BLIND window as a pass.
    expect(r.pass.stopped).toBe(true);
    expect(r.pass.budgetExhausted).toBe(false);
    expect(r.pass.complete).toBe(false);
  });

  it('does NOT trip on isolated failures — one bad row is not a broken provider', async () => {
    const bad = new Set(['S003', 'S010', 'S099', 'S400']);
    let calls = 0;
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      budgetMs: Number.MAX_SAFE_INTEGER,
      advise: async (s) => { calls++; return !bad.has(s); },
    });
    expect(r.breakerTripped).toBe(false);
    expect(r.failures).toBe(4);
    expect(r.maxConsecutiveFailures).toBe(1);
    expect(calls).toBe(639);
    expect(r.pass.complete).toBe(true);
  });

  it('a failure run one SHORT of the streak does not trip, and the streak RESETS on a success', async () => {
    // 4 consecutive failures, then a success, then 4 more: 8 failures total but
    // never 5 in a row. The reset is the property — a counter that only ever
    // accumulated would trip on a healthy provider with a scattered 1% error rate.
    const fail = new Set(['S000', 'S001', 'S002', 'S003', 'S005', 'S006', 'S007', 'S008']);
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      budgetMs: Number.MAX_SAFE_INTEGER,
      advise: async (s) => !fail.has(s),
    });
    expect(r.breakerTripped).toBe(false);
    expect(r.maxConsecutiveFailures).toBe(4);
    expect(r.failures).toBe(8);
    expect(r.pass.complete).toBe(true);
  });

  it('a throw out of `advise` counts as a failure and still feeds the streak', async () => {
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      budgetMs: Number.MAX_SAFE_INTEGER,
      advise: async () => { throw new Error('400 credit balance is too low'); },
    });
    expect(r.breakerTripped).toBe(true);
    expect(r.firstError).toContain('credit balance is too low');
  });

  it('a skipped symbol is NOT a failure — a cold cache must not trip the provider breaker', async () => {
    // `adviseOneSymbol` returns true for a symbol with <15 candles. If a skip fed
    // the streak, a freshly booted box (empty candle cache) would stand the sink
    // down for 5 minutes on evidence about ITSELF, not about the provider.
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      budgetMs: Number.MAX_SAFE_INTEGER,
      advise: async () => true,
    });
    expect(r.breakerTripped).toBe(false);
    expect(r.failures).toBe(0);
    expect(r.pass.complete).toBe(true);
  });
});

describe('TRA-3442 — the wall-clock budget and its cursor', () => {
  let cursors: ReturnType<typeof memCursors>;
  beforeEach(() => { cursors = memCursors(); });

  it('truncates a long sweep and parks a cursor mid-universe', async () => {
    // 1s of simulated wall clock per symbol against the shipped 30s budget.
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      now: steppingClock(1_000),
      advise: async () => true,
    });
    expect(r.pass.budgetExhausted).toBe(true);
    expect(r.pass.complete).toBe(false);
    expect(r.pass.processed.length).toBeLessThan(UNIVERSE.length);
    expect(r.pass.resumeAt).not.toBeNull();
    expect(cursors.map.get('demo:agents-advisory')).toBe(r.pass.resumeAt);
  });

  // CONTROL (other direction): the pre-fix arm — an unbounded budget over the
  // SAME universe and the SAME clock walks all 639 and never truncates.
  it('the SAME sweep runs to completion when the budget is unbounded (pre-fix behaviour)', async () => {
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: UNIVERSE,
      cursors,
      now: steppingClock(1_000),
      budgetMs: Number.MAX_SAFE_INTEGER,
      advise: async () => true,
    });
    expect(r.pass.budgetExhausted).toBe(false);
    expect(r.pass.complete).toBe(true);
    expect(r.pass.processed.length).toBe(UNIVERSE.length);
    expect(cursors.map.has('demo:agents-advisory')).toBe(false);
  });

  it('the truncation ROTATES — the second pass resumes where the first parked, not at AAPL', async () => {
    // 🔴 The measured defect a budget WITHOUT a cursor would create: every one of
    // the 8 unbounded passes on 2026-08-12 ran `first=S000 last=S638`. Truncating
    // that at a fixed budget would refresh the head forever and starve the tail —
    // a coverage cut with no aggregate that shows it.
    const first = await runAdvisorySweep({
      key: 'demo:agents-advisory', symbols: UNIVERSE, cursors,
      now: steppingClock(1_000), advise: async () => true,
    });
    const second = await runAdvisorySweep({
      key: 'demo:agents-advisory', symbols: UNIVERSE, cursors,
      now: steppingClock(1_000), advise: async () => true,
    });
    expect(second.pass.startIndex).toBe(first.pass.processed.length);
    expect(second.pass.processed[0]).toBe(first.pass.resumeAt);
    expect(second.pass.processed).not.toContain(first.pass.processed[0]);
  });

  it('a full rotation covers the whole universe exactly once', async () => {
    const seen: string[] = [];
    for (let i = 0; i < 40; i++) {
      const r = await runAdvisorySweep({
        key: 'demo:agents-advisory', symbols: UNIVERSE, cursors,
        now: steppingClock(1_000), advise: async () => true,
      });
      seen.push(...r.pass.processed);
      if (r.pass.complete) break;
    }
    expect(seen).toEqual(UNIVERSE);
    expect(new Set(seen).size).toBe(UNIVERSE.length);
  });

  it('forward progress survives a symbol that fails every pass', async () => {
    // `runBudgetedSweep` parks the cursor PAST an awaited batch before running it,
    // so a permanently-failing symbol cannot wedge the rotation at one position.
    const r = await runAdvisorySweep({
      key: 'demo:agents-advisory',
      symbols: ['A', 'B', 'C'],
      cursors,
      budgetMs: 0, // budget already blown ⇒ exercises the forward-progress invariant
      advise: async (s) => s !== 'A',
    });
    expect(r.pass.processed.length).toBeGreaterThanOrEqual(1);
    expect(r.pass.startIndex).toBe(0);
  });

  it('the cooldown is long enough to matter and short enough to self-heal within a session', () => {
    // 639 calls/tick ⇒ AGENTS_ADVISORY_BREAK_STREAK calls per cooldown. At the
    // measured ~130ms/call that is ~0.65s per 5 min instead of ~83s per tick.
    expect(AGENTS_ADVISORY_BREAKER_COOLDOWN_MS).toBeGreaterThanOrEqual(60_000);
    expect(AGENTS_ADVISORY_BREAKER_COOLDOWN_MS).toBeLessThanOrEqual(30 * 60_000);
  });
});
