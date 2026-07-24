// TRA-1892 (parent TRA-1592 → TRA-1435) — durable, recoverable give-back arm-floor
// forward-test ledger.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, appendFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordGiveBackState,
  hydrateGiveBackArmFloorFromDisk,
  summarizeGiveBackArmFloor,
  getBookSessionPeak,
  clearGiveBackArmFloorLedger,
  giveBackArmFloorLogPath,
  type BookGiveBackSnapshot,
} from './giveback-arm-floor-ledger.js';

const DAY = '2026-07-15';
const CAP = 0.4;
const FLOOR = 25; // the abs arm floor for a small book

// TRA-2220 — the recorder's arm state is resolved from the env its ONE call site is
// gated on, so every fold assertion has to say which state it is folding under. These
// two envs are the whole point of the ticket: the same records read differently.
const ARMED_ENV = {
  live: { EXIT_RISK_RULES_ENABLED: '1' } as NodeJS.ProcessEnv,
  demo: { EXIT_RISK_RULES_ENABLED: '1' } as NodeJS.ProcessEnv,
};
const DARK_ENV = { live: {} as NodeJS.ProcessEnv, demo: {} as NodeJS.ProcessEnv };

/**
 * Summarize with the recorder ARMED and a FIXED clock. The classification tests below
 * fold synthetic 1970-epoch timestamps, so `now` must be pinned there too — a real
 * `Date.now()` would read every one of them as ~56 years stale.
 */
function sum(now = 1_100) {
  return summarizeGiveBackArmFloor({ now, recorderEnv: ARMED_ENV });
}

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
    const s = sum();
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

    const s = sum();
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

    const s = sum();
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

    const s = sum();
    expect(s.invalidations).toBe(1);
    expect(s.sessions[0]!.verdict).toBe('giveback_halt_sub_floor');
    expect(s.verdictCounts.giveback_halt_sub_floor).toBe(1);
  });

  it('classifies a session stop (net-negative after an up-move) — NOT floor-gated', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    // A small peak that then flipped net-negative; the session stop latches regardless of
    // the arm floor — a sub-floor peak here is NOT an invalidation.
    recordGiveBackState('demo', 'engine-1', DAY, snap(15, -20, { halt: true, reason: 'session_net_negative' }), 1_001);

    const s = sum();
    expect(s.invalidations).toBe(0);
    expect(s.sessions[0]!.verdict).toBe('session_stop');
  });

  it('does NOT record a flat/red book that never went green and never halted', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(0, -30), 1_001);
    recordGiveBackState('demo', 'engine-1', DAY, snap(0, -50), 1_002);

    const s = sum();
    expect(s.sessionsObserved).toBe(0);
    // Nothing on disk either.
    expect(() => readFileSync(giveBackArmFloorLogPath(dir), 'utf8')).toThrow();
  });

  it('SPLITS per (mode, engineId) — a sibling engine never clobbers the row (TRA-1834)', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 100), 1_001);
    recordGiveBackState('demo', 'engine-2', DAY, snap(50, 50), 1_002); // sibling demo engine
    recordGiveBackState('live', 'engine-3', DAY, snap(200, 120, { halt: true }), 1_003);

    const s = sum();
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
    expect(sum().sessions[0]!.peakPnl).toBe(30);
  });

  it('RECOVERS the session outcome after a reboot (re-hydrate from disk)', () => {
    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 100), 1_001);
    recordGiveBackState('demo', 'engine-1', DAY, snap(100, 50, { halt: true }), 1_002);

    // Simulate the nightly reboot: wipe in-memory state, then rebuild from the durable file.
    clearGiveBackArmFloorLedger();
    expect(sum().sessionsObserved).toBe(0);

    const h = hydrateGiveBackArmFloorFromDisk(dir, 1_100);
    expect(h.sessions).toBe(1);
    const s = sum();
    expect(s.sessions[0]).toMatchObject({
      peakPnl: 100,
      haltLatched: true,
      verdict: 'giveback_halt_above_floor',
    });
  });

  it('reports durability provenance — ephemeral when memory-only, real dir once hydrated', () => {
    // No hydrate ⇒ dataDir null ⇒ memory-only ⇒ ephemeral true.
    expect(sum().durability).toMatchObject({ dataDir: null, ephemeral: true });

    hydrateGiveBackArmFloorFromDisk(dir, 1_000);
    const d = sum().durability;
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
    expect(sum().sessions[0]!.sessionDate).toBe(DAY);
  });

  // TRA-2220 — DARKNESS IS A FIRST-CLASS VERDICT.
  //
  // The bug these guard: `recordGiveBackState` is called from inside the
  // `EXIT_RISK_RULES_ENABLED` master gate, so the master going down does not zero the
  // counters — it FREEZES them, and a frozen `giveback_halt_sub_floor: 0` is
  // byte-identical to "22 sessions observed, none breached". bqb1 served exactly that,
  // with `ok: true`, for the two sessions after the TRA-2136 env wipe.
  //
  // The controlling rule for this block: DO NOT merely assert the clean state looks
  // clean. Assert the dark and clean states are TELLABLE APART.
  describe('recorder liveness (TRA-2220)', () => {
    // 2026-07-24T00:55Z = Thu 2026-07-23 20:55 ET — after the cash close, so 07-23 is the
    // last COMPLETED trading day. This is the exact wall-clock of the live observation.
    const NOW = Date.UTC(2026, 6, 24, 0, 55);
    // 2026-07-23T17:00Z = Thu 2026-07-23 13:00 ET — mid-session, close not yet passed.
    const MIDDAY = Date.UTC(2026, 6, 23, 17, 0);

    /** The live bqb1 shape: a clean run through Tue 07-21, then nothing. */
    function recordThrough21(): void {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      recordGiveBackState('demo', 'engine-1', '2026-07-20', snap(100, 90), 1_001);
      recordGiveBackState('demo', 'engine-1', '2026-07-21', snap(100, 90), 1_002);
    }

    it('THE DISCRIMINATOR — the same records read DIFFERENTLY dark vs armed', () => {
      recordThrough21();
      const armed = summarizeGiveBackArmFloor({ now: NOW, recorderEnv: ARMED_ENV });
      const dark = summarizeGiveBackArmFloor({ now: NOW, recorderEnv: DARK_ENV });

      // The fold itself is identical — same rows, same verdicts, same n.
      expect(dark.sessionsObserved).toBe(armed.sessionsObserved);
      expect(dark.sessions).toEqual(armed.sessions);
      expect(dark.invalidationsRecorded).toBe(armed.invalidationsRecorded);

      // ...and yet a grader can tell them apart. This is the assertion the ticket asks
      // for: if these two payloads ever serialize the same, the instrument is blind again.
      expect(JSON.stringify(dark)).not.toBe(JSON.stringify(armed));
      expect(dark.recorder.state).toBe('dark');
      expect(armed.recorder.state).not.toBe('dark');
      expect(dark.recorder.armed).toBe(false);
      expect(armed.recorder.armed).toBe(true);
    });

    it('A CEILING-ONLY CHECK CANNOT SEPARATE THEM — the tripwire nulls while dark', () => {
      recordThrough21();
      const dark = summarizeGiveBackArmFloor({ now: NOW, recorderEnv: DARK_ENV });

      // `0` would pass "invalidations <= 0" forever against a recorder that stopped —
      // the TRA-1592 reopen tripwire ("giveback_halt_sub_floor > 0") is structurally
      // incapable of firing here, so the value must NOT read as a measurement.
      expect(dark.invalidations).toBeNull();
      expect(dark.verdictCounts.giveback_halt_sub_floor).toBeNull();
      // No information is destroyed by the nulling — only its authority.
      expect(dark.invalidationsRecorded).toBe(0);
      expect(dark.verdictCountsTotal).toBe(dark.sessionsObserved);
    });

    it('the FLOOR assertion: a frozen recorder is stale even though its counts look clean', () => {
      recordThrough21();
      // Armed, so darkness is NOT the explanation — yet Wed 07-22 and Thu 07-23 both
      // completed with zero rows. `sessionsObserved` did not move across ≥ 1 expected
      // trading day, which is the failure signal a ceiling-only check never sees.
      const s = summarizeGiveBackArmFloor({ now: NOW, recorderEnv: ARMED_ENV });
      expect(s.recorder.state).toBe('armed_but_stale');
      expect(s.recorder.staleTradingDays).toBe(2);
      expect(s.recorder.missingTradingDays).toEqual(['2026-07-22', '2026-07-23']);
      expect(s.recorder.lastRecordedSessionDate).toBe('2026-07-21');
      // ...while every count it publishes still reads perfectly healthy. That gap IS the bug.
      expect(s.invalidations).toBe(0);
      expect(s.verdictCounts.giveback_halt_above_floor).toBe(0);
      expect(s.sessionsObserved).toBe(2);
    });

    it('does NOT flag a session still in progress (no cry-wolf before the close)', () => {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      recordGiveBackState('demo', 'engine-1', '2026-07-22', snap(100, 90), 1_001);
      // Mid-session on Thu 07-23: today has no rows yet, but the day is not over. Only
      // COMPLETED trading days count, or this fires every morning and gets ignored.
      const s = summarizeGiveBackArmFloor({ now: MIDDAY, recorderEnv: ARMED_ENV });
      expect(s.recorder.state).toBe('armed_and_recording');
      expect(s.recorder.staleTradingDays).toBe(0);
      expect(s.recorder.missingTradingDays).toEqual([]);
    });

    it('skips weekends and NYSE holidays when counting missing days', () => {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      // Thu 2026-07-02, then nothing until Mon 2026-07-06. The gap spans Fri 07-03
      // (Independence Day observed), Sat 07-04 and Sun 07-05 — zero MISSING trading days.
      recordGiveBackState('demo', 'engine-1', '2026-07-02', snap(100, 90), 1_001);
      recordGiveBackState('demo', 'engine-1', '2026-07-06', snap(100, 90), 1_002);
      const s = summarizeGiveBackArmFloor({
        now: Date.UTC(2026, 6, 7, 0, 55), // Mon 07-06 20:55 ET — 07-06 just completed
        recorderEnv: ARMED_ENV,
      });
      expect(s.recorder.missingTradingDays).toEqual([]);
      expect(s.recorder.state).toBe('armed_and_recording');
    });

    it('an EMPTY armed ledger is never_recorded, not stale (a fresh box is not a broken one)', () => {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      const s = summarizeGiveBackArmFloor({ now: NOW, recorderEnv: ARMED_ENV });
      expect(s.recorder.state).toBe('never_recorded');
      expect(s.recorder.staleTradingDays).toBe(0);
      expect(s.recorder.firstRecordedSessionDate).toBeNull();
      // Armed with nothing recorded is still a MEASUREMENT of zero, so no null here.
      expect(s.invalidations).toBe(0);
    });

    it('reports the RECORDER gate, which is the master ALONE — not the arm-floor sub-flag', () => {
      recordThrough21();
      // Arm floor down but master up: the control is disarmed, yet rows STILL accrue and
      // the readout is still a live measurement. Conflating the two predicates is how a
      // disarmed floor gets mistaken for a dead recorder and vice versa.
      const s = summarizeGiveBackArmFloor({
        now: NOW,
        recorderEnv: {
          live: { EXIT_RISK_RULES_ENABLED: '1', BOOK_GIVEBACK_ARM_FLOOR_ENABLED: '0' },
          demo: { EXIT_RISK_RULES_ENABLED: '1', BOOK_GIVEBACK_ARM_FLOOR_ENABLED: '0' },
        },
      });
      expect(s.recorder.armed).toBe(true);
      expect(s.recorder.masterFlag).toBe('EXIT_RISK_RULES_ENABLED');
      expect(s.invalidations).not.toBeNull();
    });

    it('one book armed is enough to keep recording (per-book resolution)', () => {
      recordThrough21();
      const s = summarizeGiveBackArmFloor({
        now: NOW,
        recorderEnv: { live: {}, demo: { EXIT_RISK_RULES_ENABLED: 'true' } },
      });
      expect(s.recorder.armedByBook).toEqual({ demo: true, live: false });
      expect(s.recorder.armed).toBe(true);
      expect(s.recorder.state).not.toBe('dark');
    });
  });

  // TRA-2110 — the boot governor-hydration accessor. Reads the folded intraday peak
  // for one book's ET session; the seam that re-arms the give-back governor after a
  // mid-session restart.
  describe('getBookSessionPeak (TRA-2110)', () => {
    it('returns the folded intraday peak (monotonic max, not the last mark)', () => {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      // Peak climbs to +$183 then the book collapses to +$30.94 — the accessor must
      // return the HIGH-WATER +$183 (what the governor lost on restart), not +$30.94.
      recordGiveBackState('demo', 'engine-4', DAY, snap(50, 50), 1_001);
      recordGiveBackState('demo', 'engine-4', DAY, snap(183, 120), 1_002);
      recordGiveBackState('demo', 'engine-4', DAY, snap(183, 30.94), 1_003);
      expect(getBookSessionPeak('demo', 'engine-4', DAY)).toBeCloseTo(183, 5);
    });

    it('returns null for a book-session that was never recorded (null ≠ 0 — TRA-1707)', () => {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      recordGiveBackState('demo', 'engine-4', DAY, snap(183, 120), 1_001);
      // Wrong day, wrong engine, and wrong mode each read the absence decisively as
      // null — the boot seam must SKIP these, not seed a peak of 0.
      expect(getBookSessionPeak('demo', 'engine-4', '2026-07-14')).toBeNull();
      expect(getBookSessionPeak('demo', 'engine-9', DAY)).toBeNull();
      expect(getBookSessionPeak('live', 'engine-4', DAY)).toBeNull();
    });

    it('is SPLIT per (mode, engineId) — one book never reads another book\'s peak', () => {
      hydrateGiveBackArmFloorFromDisk(dir, 1_000);
      recordGiveBackState('demo', 'engine-4', DAY, snap(183, 30.94), 1_001);
      recordGiveBackState('live', 'engine-4', DAY, snap(40, 40), 1_002);
      expect(getBookSessionPeak('demo', 'engine-4', DAY)).toBeCloseTo(183, 5);
      expect(getBookSessionPeak('live', 'engine-4', DAY)).toBeCloseTo(40, 5);
    });
  });
});
