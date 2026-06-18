import { describe, it, expect, beforeEach } from 'vitest';
import {
  checkDailyExecutionCaps,
  recordExecutedOrder,
  executionCapStatus,
  resetExecutionCapsForTests,
} from './agent-execution-caps-store.js';

// TRA-941 (TRA-813 P3) — daily execution caps per ratified TRA-939 §B/§C/§D.
// A noon-ET timestamp keeps both readings on the same ET calendar day so the
// day-roll logic doesn't interfere with the cap assertions.
const DAY1 = Date.parse('2026-06-18T16:00:00Z'); // 12:00 ET
const DAY2 = Date.parse('2026-06-19T16:00:00Z');

describe('agent-execution-caps-store — TRA-939 daily caps', () => {
  beforeEach(() => resetExecutionCapsForTests());

  it('live: blocks the 6th order once 5 are placed', () => {
    for (let i = 0; i < 5; i++) {
      const d = checkDailyExecutionCaps({ user: 'alice', mode: 'live', notional: 100, now: DAY1 });
      expect(d.allowed).toBe(true);
      recordExecutedOrder({ user: 'alice', mode: 'live', notional: 100, now: DAY1 });
    }
    const sixth = checkDailyExecutionCaps({ user: 'alice', mode: 'live', notional: 100, now: DAY1 });
    expect(sixth.allowed).toBe(false);
    expect(sixth.reason).toMatch(/order cap reached \(5\/5\)/);
  });

  it('live: blocks when the daily notional cap ($1,000) would be exceeded', () => {
    // Four $240 orders = $960 (4 orders, under the count cap). A 5th $240 → $1,200 > $1,000.
    for (let i = 0; i < 4; i++) {
      recordExecutedOrder({ user: 'bob', mode: 'live', notional: 240, now: DAY1 });
    }
    const d = checkDailyExecutionCaps({ user: 'bob', mode: 'live', notional: 240, now: DAY1 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/notional cap reached/);
  });

  it('live: blocks a single order above the $250 per-order ceiling', () => {
    const d = checkDailyExecutionCaps({ user: 'carol', mode: 'live', notional: 250.01, now: DAY1 });
    expect(d.allowed).toBe(false);
    expect(d.reason).toMatch(/per-order live notional/);
    // Exactly $250 is allowed (inclusive ceiling).
    expect(checkDailyExecutionCaps({ user: 'carol', mode: 'live', notional: 250, now: DAY1 }).allowed).toBe(true);
  });

  it('demo: uncapped on notional but stops at the 50-order runaway soft cap', () => {
    // A large demo notional is fine (no live ceiling applies to demo).
    expect(checkDailyExecutionCaps({ user: 'dave', mode: 'demo', notional: 100_000, now: DAY1 }).allowed).toBe(true);
    for (let i = 0; i < 50; i++) recordExecutedOrder({ user: 'dave', mode: 'demo', notional: 10, now: DAY1 });
    const blocked = checkDailyExecutionCaps({ user: 'dave', mode: 'demo', notional: 10, now: DAY1 });
    expect(blocked.allowed).toBe(false);
    expect(blocked.reason).toMatch(/runaway soft cap reached \(50\/50\)/);
  });

  it('demo and live caps are independent per mode', () => {
    for (let i = 0; i < 5; i++) recordExecutedOrder({ user: 'eve', mode: 'live', notional: 100, now: DAY1 });
    // Live is maxed but demo is unaffected.
    expect(checkDailyExecutionCaps({ user: 'eve', mode: 'live', notional: 100, now: DAY1 }).allowed).toBe(false);
    expect(checkDailyExecutionCaps({ user: 'eve', mode: 'demo', notional: 100, now: DAY1 }).allowed).toBe(true);
  });

  it('resets at the ET day boundary', () => {
    for (let i = 0; i < 5; i++) recordExecutedOrder({ user: 'frank', mode: 'live', notional: 100, now: DAY1 });
    expect(checkDailyExecutionCaps({ user: 'frank', mode: 'live', notional: 100, now: DAY1 }).allowed).toBe(false);
    // Next ET day, the budget is fresh.
    expect(checkDailyExecutionCaps({ user: 'frank', mode: 'live', notional: 100, now: DAY2 }).allowed).toBe(true);
  });

  it('status reflects recorded usage', () => {
    recordExecutedOrder({ user: 'grace', mode: 'live', notional: 200, now: DAY1 });
    recordExecutedOrder({ user: 'grace', mode: 'live', notional: 150, now: DAY1 });
    const s = executionCapStatus('grace', DAY1);
    expect(s.live.orders).toBe(2);
    expect(s.live.notionalUsd).toBeCloseTo(350, 2);
    expect(s.live.ordersCap).toBe(5);
    expect(s.live.notionalCap).toBe(1000);
  });
});
