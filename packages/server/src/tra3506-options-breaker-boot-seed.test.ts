// TRA-3506 (split out of TRA-3488) — `SignalEngine.seedOptionsBreakerFromLedger`,
// the UNTESTED JOINT in the durable sleeve-halt restore.
//
// ── The gap this closes ──────────────────────────────────────────────────────
//
// The halt-survives-restart claim has three parts. Two were already covered:
//
//   • `hydrateOptionsBreakerLedgerFromDisk` / `getOptionsBreakerRestoreState`
//     — `tra3218-options-halt-scope.test.ts`;
//   • `OptionsRiskBreaker.restoreState`
//     — `packages/engine/src/options/options-risk-breaker.test.ts`.
//
// The function that JOINS them — resolve the ET day, read the ledger for this
// book, apply the result to the live breaker — had ZERO test references
// anywhere in the repo, and it is the entire mechanism by which a latched
// sleeve halt survives a reboot.
//
// ── Why the live readout could not stand in for a test ───────────────────────
//
// `/api/health/options-halt` at 2026-08-13T05:15:28Z (build e0ae2447, pid 74,
// startedAt 05:10:04Z — a real restart 5 minutes prior) reported
// `hydratedRecords: 58`, `sessionsObserved: 41`, and **`haltedSessions: 0`**.
//
// Hydration is therefore proven live, but no sleeve halt has EVER been latched
// across the whole 30-day retained window — so the RE-LATCH branch has never
// executed on real data. That reads VACUOUS, not clean: no evidence in either
// direction. Folding it into "working" is the error this codebase keeps naming,
// so the evidence has to come from here instead.
//
// ── What is exercised, and against what ──────────────────────────────────────
//
// The REAL `SignalEngine` and the REAL process-global ledger — not a re-implemented
// seam. Standing one up turned out to be cheap (`new SignalEngine()` takes no
// required args and starts no timers), and the engine already exposes the two
// seams this needs: `getOptionsHaltState()` for its `engineId`/`mode`, and
// `_optionsBreakerForTests()` for the breaker the seed is supposed to mutate.
// Asserting on the live breaker rather than on the seed's return value is the
// point — a seed that returned `{seeded:true}` while leaving the breaker cold is
// exactly the failure the return value alone cannot see.
//
// ── Clock discipline (the TRA-3488 lesson) ───────────────────────────────────
//
// TRA-3488 was date rot: fixtures pinned literal timestamps, took the ledger's
// default `now`, and aged out of their own 30-day retention window on a
// schedule. Nothing here pins a literal day. Every fixture day is derived from
// `etDateString(new Date())` — the SAME resolver the seed itself uses — and
// `haltAt` is always relative to `Date.now()`. These cannot rot, because they
// have no calendar basis to rot against.
//
// The retention cutoff is deliberately NOT retested here; TRA-3488 ruled it out
// as an un-halt mechanism by mechanism and pinned it at +0/+1/+5 years.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { SignalEngine } from './signal-engine.js';
import {
  clearOptionsBreakerLedger,
  hydrateOptionsBreakerLedgerFromDisk,
  recordOptionsBreakerState,
  getOptionsBreakerRestoreState,
  summarizeOptionsBreakerLedger,
} from './options-breaker-ledger.js';
import { etDateString } from './scheduler.js';
import type { OptionsBreakerPersistedState } from '@trading-app/engine';

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_SRC = readFileSync(join(HERE, 'index.ts'), 'utf8');

/** TODAY's ET day, resolved through the very function the seed resolves it with. */
function todayEt(): string {
  return etDateString(new Date());
}

/**
 * The previous ET calendar day. Derived by arithmetic on the day STRING (anchored
 * at 12:00Z, which no DST shift can push across a date boundary) rather than by
 * subtracting 24h from a wall clock — on a 25-hour fall-back day, `now - 24h` can
 * still land on the same ET date, which would silently turn the negative case
 * below into a duplicate of the positive one.
 */
function prevEtDay(etDay: string): string {
  const d = new Date(`${etDay}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

/** A sleeve that latched its −2R halt: the state a reboot must not silently clear. */
function haltedState(day: string, haltAt: number): OptionsBreakerPersistedState {
  return {
    day,
    cumulativeR: -2.4,
    dailyPnl: -480,
    closes: 3,
    sleeveEquityBaseline: 468,
    halted: true,
    haltReason: 'cumulative realized loss -2.4R at/below -2R',
    haltAt,
    haltsToday: 1,
    releasesToday: 0,
    reTripFloorR: null,
    reTripFloorPnl: null,
  };
}

/** A sleeve bleeding −1.9R but NOT yet halted — one close from the trip. */
function bleedingState(day: string): OptionsBreakerPersistedState {
  return {
    day,
    cumulativeR: -1.9,
    dailyPnl: -380,
    closes: 2,
    sleeveEquityBaseline: 468,
    halted: false,
    haltReason: null,
    haltAt: null,
    haltsToday: 0,
    releasesToday: 0,
    reTripFloorR: null,
    reTripFloorPnl: null,
  };
}

/** The engine under test plus the ledger coordinates its own seed will read. */
function bootEngine(): {
  engine: SignalEngine;
  mode: 'demo' | 'live';
  engineId: string;
} {
  const engine = new SignalEngine();
  const { engineId, mode } = engine.getOptionsHaltState();
  return { engine, mode, engineId };
}

describe('TRA-3506 — seedOptionsBreakerFromLedger: the boot re-latch', () => {
  beforeEach(() => {
    clearOptionsBreakerLedger();
  });

  it('AC#1 — re-latches TODAY\'s halt onto a cold breaker (the mid-RTH restart)', () => {
    // The load-bearing case: a deploy / crash / watchdog restart INSIDE the
    // session, which is when the persisted etDay still matches the live one.
    const { engine, mode, engineId } = bootEngine();
    const breaker = engine._optionsBreakerForTests();

    // The hole the seed exists to close: a freshly-constructed breaker is cold,
    // no matter what the sleeve did before the restart.
    expect(breaker.isHalted()).toBe(false);

    // `haltAt` is NOW, not a literal — the 60-minute cooldown must not have
    // expired by the time the seed reads it back, and anchoring to `Date.now()`
    // makes that true on every future run rather than until some fixed date.
    recordOptionsBreakerState(mode, engineId, haltedState(todayEt(), Date.now()));

    expect(engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: true, halted: true });
    // The assertion that matters: the LIVE breaker re-latched, not merely a
    // truthy return value.
    expect(breaker.isHalted()).toBe(true);
  });

  it('AC#1 — the tallies restore too, so a bleeding sleeve cannot reboot calm', () => {
    // The second direction the seed's own doc comment calls load-bearing: a
    // restart that zeroed `cumulativeR` would let a sleeve already −1.9R down
    // bleed another full −2R before its breaker ever tripped.
    const { engine, mode, engineId } = bootEngine();
    const breaker = engine._optionsBreakerForTests();

    recordOptionsBreakerState(mode, engineId, bleedingState(todayEt()));

    // Seeded but NOT halted — the two flags in the return value are independent.
    expect(engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: true, halted: false });
    expect(breaker.isHalted()).toBe(false);

    const s = breaker.snapshot();
    expect(s.cumulativeR).toBeCloseTo(-1.9, 5);
    expect(s.closes).toBe(2);
  });

  it('AC#2 — does NOT seed off YESTERDAY\'s row, and the miss is BY DAY KEY', () => {
    // bqb1's nightly reboot lands ~04:30Z = 00:30 ET, so the ET day has ALREADY
    // rolled: the seed asks for a day the ledger has no row for. This asserts
    // that miss is the day-key lookup and not an accident of an absent,
    // unreadable, or retention-dropped row.
    const { engine, mode, engineId } = bootEngine();
    const breaker = engine._optionsBreakerForTests();

    const today = todayEt();
    const yesterday = prevEtDay(today);
    expect(yesterday).not.toBe(today);

    recordOptionsBreakerState(mode, engineId, haltedState(yesterday, Date.now() - 26 * 3600_000));

    // CONTROL — the row is present, retained, and fully readable under its OWN
    // day key. Without this, "returns null" would be indistinguishable from
    // "the fixture never landed", and the test would pass for the wrong reason.
    //
    // This control is also the ONLY arm that answers the question the ticket
    // actually asked ("confirm the miss is by day-key and not by accident"),
    // because the stale row is refused TWICE by two independent guards: this
    // day-keyed lookup, and `OptionsRiskBreaker.restoreState`'s own
    // `state.day !== currentDay` check. Verified by mutation: rewriting the seed
    // to resolve YESTERDAY's ET day leaves the `{seeded:false}` assertion below
    // GREEN — the breaker's guard catches it — and only these two lines go red.
    // Asserting the seed's return value alone would not have located the guard.
    const underOwnKey = getOptionsBreakerRestoreState(mode, engineId, yesterday);
    expect(underOwnKey).not.toBeNull();
    expect(underOwnKey?.halted).toBe(true);

    // …and it is invisible under TODAY's key, which is the only key the seed asks for.
    expect(getOptionsBreakerRestoreState(mode, engineId, today)).toBeNull();

    expect(engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: false, halted: false });
    expect(breaker.isHalted()).toBe(false);
  });

  it('AC#2 — the DISCRIMINATING pair: the same halted fixture seeds under today\'s key', () => {
    // The negative case above only means something next to a positive arm that
    // differs in EXACTLY one input. Same state object, same book, same clock —
    // only `day` moves — so a seed that had quietly stopped working for some
    // unrelated reason cannot masquerade as correct day-key rejection.
    const today = todayEt();
    const yesterday = prevEtDay(today);
    const haltAt = Date.now();

    const stale = bootEngine();
    recordOptionsBreakerState(stale.mode, stale.engineId, haltedState(yesterday, haltAt));
    expect(stale.engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: false, halted: false });

    // A DIFFERENT engine — `feedContextKey` is per-instance, so this is a
    // separate book-session key and cannot inherit the row above.
    const fresh = bootEngine();
    recordOptionsBreakerState(fresh.mode, fresh.engineId, haltedState(today, haltAt));
    expect(fresh.engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: true, halted: true });

    expect(stale.engine._optionsBreakerForTests().isHalted()).toBe(false);
    expect(fresh.engine._optionsBreakerForTests().isHalted()).toBe(true);
  });

  it('AC#2 — another book\'s halt on the same day does not leak across the split', () => {
    // The ledger is keyed per (day, mode, engineId) — SPLIT per book (TRA-1834).
    // A halt latched by one sleeve must not re-latch a different one at boot.
    const other = bootEngine();
    recordOptionsBreakerState(other.mode, other.engineId, haltedState(todayEt(), Date.now()));

    const mine = bootEngine();
    expect(mine.engineId).not.toBe(other.engineId);
    expect(mine.engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: false, halted: false });
    expect(mine.engine._optionsBreakerForTests().isHalted()).toBe(false);
  });

  it('AC#3 — an EMPTY ledger returns {seeded:false}, it does not throw', () => {
    // Boot must survive a first-ever start, a wiped disk, or a book that has
    // simply never traded. `index.ts` wraps the call in try/catch precisely so a
    // seed failure cannot break boot — but a throw here would still mean every
    // LATER book in that `for` loop is skipped only by luck of ordering.
    const { engine } = bootEngine();
    expect(summarizeOptionsBreakerLedger().sessionsObserved).toBe(0);

    expect(() => engine.seedOptionsBreakerFromLedger()).not.toThrow();
    expect(engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: false, halted: false });
    expect(engine._optionsBreakerForTests().isHalted()).toBe(false);
  });

  it('a late seed cannot clobber a book that has already traded this session', () => {
    // The seed is a BOOT seam, not a merge. Once live closes have booked, the
    // in-memory state is the truth — `restoreState` refuses, and the joint must
    // report `seeded:false` rather than swallowing the refusal as success.
    const { engine, mode, engineId } = bootEngine();
    const breaker = engine._optionsBreakerForTests();

    recordOptionsBreakerState(mode, engineId, haltedState(todayEt(), Date.now()));
    breaker.recordClose({ pnl: 50, riskUsd: 200 }, 468); // live activity first

    expect(engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: false, halted: false });
    expect(breaker.isHalted()).toBe(false);
    expect(breaker.snapshot().cumulativeR).toBeCloseTo(0.25, 5);
  });

  it('survives a real disk round trip: record → hydrate → seed re-latches', () => {
    // End-to-end over the actual JSONL file, which is the path a genuine reboot
    // takes: the in-memory fold the earlier cases lean on is exactly what a
    // restart destroys.
    const dir = mkdtempSync(join(tmpdir(), 'tra3506-'));
    try {
      const today = todayEt();
      const haltAt = Date.now();

      // ── Session 1: the sleeve halts and the row is appended to disk.
      hydrateOptionsBreakerLedgerFromDisk(dir);
      const before = bootEngine();
      recordOptionsBreakerState(before.mode, before.engineId, haltedState(today, haltAt));

      // ── The reboot: drop every in-memory counter, then rebuild from the file.
      clearOptionsBreakerLedger();
      expect(getOptionsBreakerRestoreState(before.mode, before.engineId, today)).toBeNull();

      const h = hydrateOptionsBreakerLedgerFromDisk(dir);
      expect(h.records).toBe(1);

      // ── Session 2: a cold engine, seeded off the SAME book key the pre-reboot
      // engine wrote under (`feedContextKey` is per-instance, so a genuine
      // restart's engine is addressed by its own key — this pins the ledger
      // half; the engine-identity half is the caller's, not this seam's).
      const after = new SignalEngine();
      expect(after._optionsBreakerForTests().isHalted()).toBe(false);

      const restored = getOptionsBreakerRestoreState(before.mode, before.engineId, today);
      expect(restored).not.toBeNull();
      expect(after._optionsBreakerForTests().restoreState(restored!)).toBe(true);
      expect(after._optionsBreakerForTests().isHalted()).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      clearOptionsBreakerLedger();
    }
  });
});

/**
 * The anti-rot arm — the bar TRA-3488 set for this file's ancestors, applied to
 * this file itself.
 *
 * The cases above claim they cannot date-rot because every fixture day is
 * derived from `etDateString(new Date())` rather than pinned to a literal. That
 * is an assertion about the fixtures, and TRA-3488 is the ticket that exists
 * because such an assertion went unmeasured. So it is measured here: the whole
 * seed round trip is replayed against a FAKED system clock at +1 and +5 years,
 * and at two calendar shapes that break naive day arithmetic.
 *
 * Only `Date` is faked (`toFake: ['Date']`) — faking timers wholesale would stall
 * anything the engine schedules, and the clock is the only dependency at issue.
 */
describe('TRA-3506 — the fixtures cannot date-rot (replayed at +1y, +5y, and two edge dates)', () => {
  afterEach(() => {
    vi.useRealTimers();
    clearOptionsBreakerLedger();
  });

  /** Both directions of the seed, run entirely inside whatever "now" is current. */
  function replaySeedRoundTrip(): void {
    clearOptionsBreakerLedger();
    const today = todayEt();
    const yesterday = prevEtDay(today);
    expect(yesterday).not.toBe(today);

    // Positive: TODAY's halt re-latches.
    const live = bootEngine();
    recordOptionsBreakerState(live.mode, live.engineId, haltedState(today, Date.now()));
    expect(live.engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: true, halted: true });
    expect(live.engine._optionsBreakerForTests().isHalted()).toBe(true);

    // Negative: YESTERDAY's halt does not, and the row is still readable under
    // its own key — the day-key control travels with the clock.
    const stale = bootEngine();
    recordOptionsBreakerState(stale.mode, stale.engineId, haltedState(yesterday, Date.now()));
    expect(getOptionsBreakerRestoreState(stale.mode, stale.engineId, yesterday)).not.toBeNull();
    expect(getOptionsBreakerRestoreState(stale.mode, stale.engineId, today)).toBeNull();
    expect(stale.engine.seedOptionsBreakerFromLedger()).toEqual({ seeded: false, halted: false });
    expect(stale.engine._optionsBreakerForTests().isHalted()).toBe(false);
  }

  const YEAR_MS = 365 * 24 * 3600_000;
  const CLOCKS: Array<{ label: string; at: () => Date }> = [
    { label: '+1 year', at: () => new Date(Date.now() + YEAR_MS) },
    { label: '+5 years', at: () => new Date(Date.now() + 5 * YEAR_MS) },
    // The nightly bqb1 reboot (00:30 ET) landing on New Year's Day: the ET day
    // rolls the YEAR as well as the date, which is where naive `slice(0, 10)`
    // arithmetic on a mis-derived basis would produce a same-year off-by-one.
    { label: 'new-year rollover (00:30 ET, Jan 1)', at: () => new Date('2027-01-01T05:30:00Z') },
    // The US DST fall-back day, at the ONE instant where naive arithmetic
    // actually collapses. 2026-11-01 is 25 hours long in ET, so at 23:30 ET
    // (= 2026-11-02T04:30:00Z) `now - 24h` lands on 00:30 ET the SAME morning —
    // ET date '2026-11-01' both times. A naive `prevEtDay` would hand the
    // negative case TODAY's key, silently turning it into a duplicate of the
    // positive one. Measured, not assumed: 01:30 ET on Nov 1 (the obvious pick)
    // does NOT collapse, so an edge case placed there would be decorative.
    { label: 'DST fall-back (23:30 ET on the 25-hour day)', at: () => new Date('2026-11-02T04:30:00Z') },
  ];

  for (const clock of CLOCKS) {
    it(`re-latches TODAY and refuses YESTERDAY at ${clock.label}`, () => {
      const when = clock.at();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(when);
      // Sanity: the fake actually took, or this whole arm would be a no-op that
      // silently re-ran the +0 case four times.
      expect(Date.now()).toBe(when.getTime());
      replaySeedRoundTrip();
    });
  }

  it('the ET day the seed resolves is the one the ledger is keyed on, at every clock', () => {
    // Ties the arm above back to the mechanism: the seed and the fixtures agree
    // on the day because they call the SAME resolver, not because both happen to
    // be near today's date.
    for (const clock of CLOCKS) {
      const when = clock.at();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(when);

      const { engine, mode, engineId } = bootEngine();
      clearOptionsBreakerLedger();
      recordOptionsBreakerState(mode, engineId, haltedState(etDateString(when), Date.now()));
      expect(engine.seedOptionsBreakerFromLedger(when)).toEqual({ seeded: true, halted: true });

      vi.useRealTimers();
    }
  });
});

/**
 * AC#4 — the `durability.ephemeral === true` branch genuinely skips the seed.
 *
 * This gate lives at module top level in `index.ts`, so it cannot be driven
 * behaviourally without booting the whole server. It is covered from both
 * sides instead: the PREDICATE the gate reads is asserted for real, and the
 * gate's STRUCTURE is asserted against the source (the tra2331 house pattern —
 * line numbers shift, symbols don't), by brace-matching the block rather than
 * by a look-back window, so a seed call moved out of the guard fails loudly.
 */
describe('TRA-3506 — AC#4: the ephemeral-ledger gate on the boot seed', () => {
  const savedDataDir = process.env.DATA_DIR;

  beforeEach(() => {
    clearOptionsBreakerLedger();
  });

  afterEach(() => {
    if (savedDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = savedDataDir;
    clearOptionsBreakerLedger();
  });

  it('the predicate the gate reads is TRUE for a non-durable ledger', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tra3506-eph-'));
    try {
      // The failure mode TRA-1681 names: with `DATA_DIR` unset the process took
      // its in-bundle fallback, so every IO-level check passes and the data
      // still evaporates on redeploy. Only the PATH knows.
      delete process.env.DATA_DIR;
      hydrateOptionsBreakerLedgerFromDisk(dir);
      expect(summarizeOptionsBreakerLedger().durability.ephemeral).toBe(true);

      // Same for an in-bundle path even when DATA_DIR is set.
      process.env.DATA_DIR = join(dir, 'packages', 'server', 'data');
      hydrateOptionsBreakerLedgerFromDisk(process.env.DATA_DIR);
      expect(summarizeOptionsBreakerLedger().durability.ephemeral).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('…and FALSE for a mounted path, so the gate is not simply always-true', () => {
    // The positive control. Without it, "ephemeral is true" would be consistent
    // with a predicate that never returns false, and the gate would be dead
    // code that skips the seed forever.
    const dir = mkdtempSync(join(tmpdir(), 'tra3506-dur-'));
    try {
      process.env.DATA_DIR = dir;
      hydrateOptionsBreakerLedgerFromDisk(dir);
      expect(summarizeOptionsBreakerLedger().durability.ephemeral).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the ONLY seed call site in index.ts is lexically inside the ephemeral gate', () => {
    const GATE = 'if (breakerDurability.ephemeral === false) {';
    const gateAt = INDEX_SRC.indexOf(GATE);
    expect(gateAt, `boot gate \`${GATE}\` not found in index.ts`).toBeGreaterThanOrEqual(0);

    // Brace-match the guarded block so this asserts CONTAINMENT, not proximity.
    const open = gateAt + GATE.length - 1;
    let depth = 0;
    let close = -1;
    for (let i = open; i < INDEX_SRC.length; i += 1) {
      const ch = INDEX_SRC[i];
      if (ch === '{') depth += 1;
      else if (ch === '}') {
        depth -= 1;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close, 'unbalanced braces walking the boot gate block').toBeGreaterThan(open);

    const guarded = INDEX_SRC.slice(open, close + 1);
    const calls = [...INDEX_SRC.matchAll(/seedOptionsBreakerFromLedger\(/g)].map((m) => m.index ?? 0);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBeGreaterThan(open);
    expect(calls[0]).toBeLessThan(close);
    expect(guarded).toMatch(/ctx\.engine\.seedOptionsBreakerFromLedger\(\)/);

    // The else branch is the SKIP: it must announce itself and must not seed.
    const tail = INDEX_SRC.slice(close, close + 400);
    expect(tail).toMatch(/^\}\s*else\s*\{/);
    expect(tail).toMatch(/SKIPPED/);
    expect(tail).not.toMatch(/seedOptionsBreakerFromLedger/);
  });

  it('the gate reads durability from the ledger summary, not from a local guess', () => {
    // A second copy of the path predicate would drift, and the copy that drifts
    // is the one someone is trusting (the TRA-1681 lesson that created
    // `data-dir.ts`). The gate must read the value the health route publishes.
    expect(INDEX_SRC).toMatch(
      /const breakerDurability = summarizeOptionsBreakerLedger\(\)\.durability;/,
    );
  });
});
