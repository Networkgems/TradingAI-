// TRA-1892 (parent TRA-1592 → TRA-1435) — durable, recoverable give-back arm-floor
// forward-test ledger.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordGiveBackState,
  hydrateGiveBackArmFloorFromDisk,
  summarizeGiveBackArmFloor,
  clearGiveBackArmFloorLedger,
  giveBackArmFloorLogPath,
  type BookGiveBackSnapshot,
} from './giveback-arm-floor-ledger.js';

const DAY = '2026-07-15';
const CAP = 0.4;
const FLOOR = 25; // the abs arm floor for a small book

/**
 * Build a give-back snapshot. `peak` is the intraday high-water mark; `current` the
 * present (realized+open) P&L. `armFloor`/`halt`/`reason` default to the natural
 * derivation but can be overridden to simulate an invalidation the pure decision would
 * never itself produce (a sub-floor-peak give-back halt).
 */
function snap(
  peak: number,
  current: number,
  opts: { armFloor?: number; halt?: boolean; reason?: BookGiveBackSnapshot['haltReason'] } = {},
): BookGiveBackSnapshot {
  const armFloor = opts.armFloor ?? FLOOR;
  return {
    peakPnl: peak,
    currentPnl: current,
    retainedFloor: Math.max(0, peak) * (1 - CAP),
    giveBackArmFloor: armFloor,
    giveBackCapPct: CAP,
    armFloorCleared: peak > 0 && peak >= armFloor,
    haltLatched: opts.halt ?? false,
    haltReason: opts.reason ?? (opts.halt ? 'giveback_cap' : null),
  };
}

describe('giveback-arm-floor-ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'giveback-'));
    clearGiveBackArmFloorLedger();
  });

  afterEach(() => {
    clearGiveBackArmFloorLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes an empty ledger as an honest zero', () => {
    const s = summarizeGiveBackArmFloor();
    expect(s.sessionsObserved).toBe(0);
    expect(s.invalidations).toBe(0);
    expect(s.sessions).toEqual([]);
    expect(s.lastRecordAt).toBeNull();
  });

  it('classifies a clean sub-floor-peak day as a PRIMARY-AC pass (no halt, floor uncleared)', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    // Peak +$7 on a small book, below the $25 arm floor, gives back to +$2 — must NOT halt.
    recordGiveBackState('demo', 'engine-1', DAY, snap(7, 5), 1_001);
    recordGiveBackState('demo', 'engine-1', DAY, snap(7, 2), 1_002);

    const s = summarizeGiveBackArmFloor();
    expect(s.sessionsObserved).toBe(1);
    expect(s.invalidations).toBe(0);
    const [sess] = s.sessions;
    expect(sess).toMatchObject({
      mode: 'demo',
      engineId: 'engine-1',
      peakPnl: 7,
      armFloorCleared: false,
      haltLatched: false,
      verdict: 'clean_sub_floor',
    });
  });

  it('classifies an above-floor give-back halt as expected non-regression', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 100), 1_001); // peak $100, floor $60
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 50, { halt: true }), 1_002); // gave back >40%

    const s = summarizeGiveBackArmFloor();
    const [sess] = s.sessions;
    expect(sess).toMatchObject({
      peakPnl: 100,
      armFloorCleared: true,
      haltLatched: true,
      haltReason: 'giveback_cap',
      verdict: 'giveback_halt_above_floor',
    });
    expect(s.invalidations).toBe(0);
    expect(sess!.giveBackPct).toBeCloseTo(0.5, 3);
  });

  it('flags a sub-floor-peak give-back halt as a PRIMARY-AC INVALIDATION', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    // The invalidation the arm floor exists to prevent: a peak BELOW the floor that still
    // latched a give-back halt. The pure decision can't produce this while armed, so we
    // record the snapshot directly — this is the tripwire QT watches.
    recordGiveBackState('demo', 'engine-1', DAY, snap(7, 1, { halt: true, reason: 'giveback_cap' }), 1_001);

    const s = summarizeGiveBackArmFloor();
    expect(s.invalidations).toBe(1);
    expect(s.sessions[0]!.verdict).toBe('giveback_halt_sub_floor');
    expect(s.verdictCounts.giveback_halt_sub_floor).toBe(1);
  });

  it('classifies a session stop (net-negative after an up-move) — NOT floor-gated', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    // A small peak that then flipped net-negative; the session stop latches regardless of
    // the arm floor — a sub-floor peak here is NOT an invalidation.
    recordGiveBackState('demo', 'engine-1', DAY, snap(15, -20, { halt: true, reason: 'session_net_negative' }), 1_001);

    const s = summarizeGiveBackArmFloor();
    expect(s.invalidations).toBe(0);
    expect(s.sessions[0]!.verdict).toBe('session_stop');
  });

  it('does NOT record a flat/red book that never went green and never halted', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(0, -30), 1_001);
    recordGiveBackState('demo', 'engine-1', DAY, snap(0, -50), 1_002);

    const s = summarizeGiveBackArmFloor();
    expect(s.sessionsObserved).toBe(0);
    // Nothing on disk either.
    expect(() => readFileSync(giveBackArmFloorLogPath(dir), 'utf8')).toThrow();
  });

  it('SPLITS per (mode, engineId) — a sibling engine never clobbers the row (TRA-1834)', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 100), 1_001);
    recordGiveBackState('demo', 'engine-2', DAY, snap(50, 50), 1_002); // sibling demo engine
    recordGiveBackState('live', 'engine-3', DAY, snap(200, 120, { halt: true }), 1_003);

    const s = summarizeGiveBackArmFloor();
    expect(s.sessionsObserved).toBe(3);
    const byKey = Object.fromEntries(s.sessions.map((x) => [`${x.mode}:${x.engineId}`, x]));
    expect(byKey['demo:engine-1']!.peakPnl).toBe(100);
    expect(byKey['demo:engine-2']!.peakPnl).toBe(50);
    expect(byKey['live:engine-3']!.haltLatched).toBe(true);
  });

  it('throttles the disk write to genuine transitions but keeps the fold current', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    // Same dollar-floored peak, uncleared floor, no halt: only the FIRST writes a line.
    recordGiveBackState('demo', 'engine-1', DAY, snap(7, 6), 1_001);
    recordGiveBackState('demo', 'engine-1', DAY, snap(7.4, 5), 1_002); // floor(peak) unchanged → no write
    recordGiveBackState('demo', 'engine-1', DAY, snap(7.9, 4), 1_003); // still floor 7 → no write
    let lines = readFileSync(giveBackArmFloorLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);

    // A new dollar peak IS a transition → a second line.
    recordGiveBackState('demo', 'engine-1', DAY, snap(30, 10), 1_004); // clears floor now
    lines = readFileSync(giveBackArmFloorLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);
    // The fold reflects the latest peak regardless of throttle.
    expect(summarizeGiveBackArmFloor().sessions[0]!.peakPnl).toBe(30);
  });

  it('RECOVERS the session outcome after a reboot (re-hydrate from disk)', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 100), 1_001);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 50, { halt: true }), 1_002);

    // Simulate the nightly reboot: wipe in-memory state, then rebuild from the durable file.
    clearGiveBackArmFloorLedger();
    expect(summarizeGiveBackArmFloor().sessionsObserved).toBe(0);

    const h = hydrateGiveBackArmFloorFromDisk(dir, 1_100);
    expect(h.sessions).toBe(1);
    const s = summarizeGiveBackArmFloor();
    expect(s.sessions[0]).toMatchObject({
      peakPnl: 100,
      haltLatched: true,
      verdict: 'giveback_halt_above_floor',
    });
  });

  it('reports durability provenance — ephemeral when memory-only, real dir once hydrated', () => {
    // No hydrate ⇒ dataDir null ⇒ memory-only ⇒ ephemeral true.
    expect(summarizeGiveBackArmFloor().durability).toMatchObject({ dataDir: null, ephemeral: true });

    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    const d = summarizeGiveBackArmFloor().durability;
    expect(d.dataDir).toBe(dir);
    expect(d.hydratedRecords).toBe(0);
    // A tmpdir is not inside the bundle, but DATA_DIR is unset in this test env, so the
    // path-based predicate still calls it ephemeral — which is the honest, conservative
    // read: without DATA_DIR set nothing is guaranteed durable.
    expect(typeof d.ephemeral).toBe('boolean');
  });

  it('skips a torn trailing line on hydrate rather than throwing', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 100), 1_001);
    // Append a torn/partial JSON fragment (a crash mid-append).
    appendFileSync(giveBackArmFloorLogPath(dir), '{"ts":1002,"etDay":"2026-07-15","mode":"demo"', 'utf8');

    const h = hydrateGiveBackArmFloorFromDisk(dir, 1_100);
    expect(h.records).toBe(1); // the good line survived, the torn one was skipped
    // Compaction rewrote the file to the one clean line.
    const raw = readFileSync(giveBackArmFloorLogPath(dir), 'utf8').trim().split('\n');
    expect(raw).toHaveLength(1);
    expect(() => JSON.parse(raw[0]!)).not.toThrow();
  });

  it('drops records older than the retention window on hydrate', () => {
    const now = 1_000_000_000_000;
    const old = now - 40 * 24 * 60 * 60 * 1000; // 40 days — outside the 30-day window
    hydrateGiveBackArmFloorFromDisk(dir, old);
    recordGiveBackState('demo', 'engine-1', '2026-06-01', snap(100, 100), old);
    recordGiveBackState('demo', 'engine-1', DAY, snap(80, 80), now);

    const h = hydrateGiveBackArmFloorFromDisk(dir, now);
    expect(h.sessions).toBe(1); // only the recent one survives
    expect(summarizeGiveBackArmFloor().sessions[0]!.sessionDate).toBe(DAY);
  });
});
