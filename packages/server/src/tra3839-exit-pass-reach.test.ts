import { describe, it, expect } from 'vitest';
import {
  optionsExitPassRuns,
  resolveLiveExitPassStatus,
  EXIT_PASS_STALE_MS,
} from './exit-pass-reach.js';

/**
 * TRA-3839 — controls for the CADENCE half: does an exit pass reach this book's
 * live rows, and if not, which blocker is doing it.
 *
 * This is the half that can produce a fleet-wide false alarm, so the negative
 * controls matter more than the positive ones. In particular a live book inside
 * RTH whose engine is ticking must read `reaches: true` no matter what the
 * decoupled hoist is doing — TRA-3821 measured three live engines at
 * `armedEngineCount: 0` next to `tickPassCount` 251/253/250, and a detector
 * keyed on that arm would have flagged all three.
 */

/** 2026-08-18T17:00Z — Tuesday, mid-session. `isStockMarketOpen` true. */
const MID_RTH = Date.UTC(2026, 7, 18, 17, 0, 0);
/** 2026-08-18T21:03Z — the live read the ticket was filed off. Market SHUT. */
const AT_2103Z = Date.UTC(2026, 7, 18, 21, 3, 0);

/** A live engine ticking normally: last pass 12s ago, 250 passes since boot. */
const HEALTHY = { mode: 'live' as const, exitPassCount: 250, lastExitPassAt: MID_RTH - 12_000 };

describe('TRA-3839 optionsExitPassRuns — the gate the health route predicts', () => {
  it('a LIVE book calls checkExits only inside RTH', () => {
    expect(optionsExitPassRuns('live', MID_RTH)).toBe(true);
    expect(optionsExitPassRuns('live', AT_2103Z)).toBe(false);
  });

  it('a DEMO book calls it around the clock', () => {
    expect(optionsExitPassRuns('demo', MID_RTH)).toBe(true);
    expect(optionsExitPassRuns('demo', AT_2103Z)).toBe(true);
  });
});

describe('TRA-3839 resolveLiveExitPassStatus — negative controls', () => {
  it('a healthy live book inside RTH reaches its rows', () => {
    const s = resolveLiveExitPassStatus({ ...HEALTHY, now: MID_RTH });
    expect(s).toEqual({
      reaches: true,
      blockedBy: null,
      resumesAt: null,
      lastPassAgeMs: 12_000,
    });
  });

  it('the DECOUPLED hoist being disarmed is NOT a blocker — the whole TRA-3821 lesson', () => {
    // There is deliberately no input for `timerArmed` / `armedEngineCount`. If
    // this walk ever grows one, this test is the thing that should have to be
    // deleted first. `doTick` calls `runOptionsExitPass` unconditionally, so on
    // 08-17 three live engines with `armedEngineCount: 0` were running exits at
    // ~30s. Reporting those as unattended is the inverse defect of the one this
    // ticket fixes, and strictly more damaging: it voids every clean read.
    expect(Object.keys(HEALTHY)).not.toContain('timerArmed');
    expect(resolveLiveExitPassStatus({ ...HEALTHY, now: MID_RTH }).reaches).toBe(true);
  });

  it('a pass just under the stale bound is still healthy', () => {
    const s = resolveLiveExitPassStatus({
      ...HEALTHY, lastExitPassAt: MID_RTH - EXIT_PASS_STALE_MS, now: MID_RTH,
    });
    // AT the bound, not past it — `>` not `>=`, so a tick landing exactly on
    // four periods is not an incident.
    expect(s.reaches).toBe(true);
    expect(s.lastPassAgeMs).toBe(EXIT_PASS_STALE_MS);
  });

  it('the stale bound is FOUR declared tick periods, not a fitted number', () => {
    expect(EXIT_PASS_STALE_MS).toBe(4 * 30_000);
  });
});

describe('TRA-3839 resolveLiveExitPassStatus — positive controls, in walk order', () => {
  it('market_closed: the 21:03Z fixture, with the next open as its horizon', () => {
    const s = resolveLiveExitPassStatus({
      ...HEALTHY, lastExitPassAt: AT_2103Z - 12_000, now: AT_2103Z,
    });
    expect(s).toEqual({
      reaches: false,
      blockedBy: 'market_closed',
      resumesAt: '2026-08-19T13:30:00.000Z',
      lastPassAgeMs: 12_000,
    });
  });

  it('engine_mode_demo: the pass runs, checkExits mode-skips every live row', () => {
    const s = resolveLiveExitPassStatus({ ...HEALTHY, mode: 'demo', now: MID_RTH });
    expect(s.blockedBy).toBe('engine_mode_demo');
    // No clock releases this — a human must flip the book.
    expect(s.resumesAt).toBeNull();
  });

  it('pass_stalled: one ms past the bound, and it carries no horizon', () => {
    const s = resolveLiveExitPassStatus({
      ...HEALTHY, lastExitPassAt: MID_RTH - EXIT_PASS_STALE_MS - 1, now: MID_RTH,
    });
    expect(s.blockedBy).toBe('pass_stalled');
    expect(s.resumesAt).toBeNull();
  });

  it('no_pass_observed is DISTINCT from pass_stalled — nothing to be late against', () => {
    const s = resolveLiveExitPassStatus({
      mode: 'live', exitPassCount: 0, lastExitPassAt: 0, now: MID_RTH,
    });
    expect(s.blockedBy).toBe('no_pass_observed');
    // `null`, never 0: a zero age would claim a pass we have not observed.
    expect(s.lastPassAgeMs).toBeNull();
  });

  it('names the OUTERMOST blocker when several apply', () => {
    // A demo-mode engine, outside RTH, stalled, on a box that has never stamped.
    // All four are true; only `no_pass_observed` would still be refusing once
    // the other three cleared, and reporting `market_closed` here would hand the
    // desk a 13:30Z horizon for a book that will still be dead after it.
    const s = resolveLiveExitPassStatus({
      mode: 'demo', exitPassCount: 0, lastExitPassAt: 0, now: AT_2103Z,
    });
    expect(s.blockedBy).toBe('no_pass_observed');
    expect(s.resumesAt).toBeNull();

    // And one layer in: stamped, but stalled AND demo AND shut.
    const stalled = resolveLiveExitPassStatus({
      mode: 'demo', exitPassCount: 9, lastExitPassAt: AT_2103Z - 900_000, now: AT_2103Z,
    });
    expect(stalled.blockedBy).toBe('pass_stalled');

    // And one further: ticking, but demo AND shut. The mode skip outranks the
    // session gate because flipping the calendar would not make it act.
    const demo = resolveLiveExitPassStatus({
      mode: 'demo', exitPassCount: 9, lastExitPassAt: AT_2103Z - 12_000, now: AT_2103Z,
    });
    expect(demo.blockedBy).toBe('engine_mode_demo');
  });
});
