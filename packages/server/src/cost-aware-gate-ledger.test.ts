// TRA-1602 (TRA-1600C) — durable admit/reject telemetry for the cost-aware fire bar.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCostAwareGateDecision,
  recordEntryDeltaCeilingReject,
  recordEntryDeltaCeilingObserved,
  recordSpreadCeilingDecision,
  hydrateCostAwareGateFromDisk,
  summarizeCostAwareGate,
  clearCostAwareGateLedger,
  costAwareGateLogPath,
} from './cost-aware-gate-ledger.js';

const DAY = '2026-07-13';

describe('cost-aware-gate-ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cost-gate-'));
    clearCostAwareGateLedger();
  });

  afterEach(() => {
    clearCostAwareGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes an empty ledger as an honest zero', () => {
    const s = summarizeCostAwareGate(DAY);
    expect(s).toMatchObject({
      decisionsRecorded: 0,
      byStructure: [],
      admittedTotal: 0,
      rejectedTotal: 0,
      lastDecisionAt: null,
    });
  });

  it('splits admits/rejects per structure with the mean gross R either side of the bar', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordCostAwareGateDecision('single_leg_rv', true, 1.4, 1.25, DAY, 1_001);
    recordCostAwareGateDecision('single_leg_rv', true, 1.6, 1.25, DAY, 1_002);
    recordCostAwareGateDecision('single_leg_rv', false, 0.2, 1.25, DAY, 1_003);
    recordCostAwareGateDecision('directional', false, 0.5, 1.25, DAY, 1_004);

    const s = summarizeCostAwareGate(DAY);
    expect(s.admittedTotal).toBe(2);
    expect(s.rejectedTotal).toBe(2);
    expect(s.decisionsRecorded).toBe(4);
    expect(s.lastDecisionAt).toBe(1_004);

    // Busiest structure first.
    const [rv, dir_] = s.byStructure;
    expect(rv).toMatchObject({
      structure: 'single_leg_rv',
      admitted: 2,
      rejected: 1,
      avgAdmittedGrossR: 1.5,
      avgRejectedGrossR: 0.2,
      barR: 1.25,
    });
    expect(rv!.admitRate).toBeCloseTo(2 / 3, 3);
    expect(dir_).toMatchObject({ structure: 'directional', admitted: 0, rejected: 1, avgAdmittedGrossR: null });
  });

  it('records a non-finite modeled R as a reject with a finite 0 so the sums stay usable', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordCostAwareGateDecision('single_leg_otm', false, Number.NaN, 1.25, DAY, 1_001);
    const s = summarizeCostAwareGate(DAY);
    expect(s.byStructure[0]).toMatchObject({ rejected: 1, avgRejectedGrossR: 0 });
  });

  it('scopes counts to the requested ET day', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordCostAwareGateDecision('single_leg_rv', true, 1.4, 1.25, DAY, 1_001);
    recordCostAwareGateDecision('single_leg_rv', false, 0.1, 1.25, '2026-07-14', 1_002);
    expect(summarizeCostAwareGate(DAY).admittedTotal).toBe(1);
    expect(summarizeCostAwareGate(DAY).rejectedTotal).toBe(0);
    expect(summarizeCostAwareGate('2026-07-14').rejectedTotal).toBe(1);
  });

  it('survives a reboot: counts rebuild from the JSONL on hydrate', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordCostAwareGateDecision('single_leg_rv', true, 1.4, 1.25, DAY, 1_001);
    recordCostAwareGateDecision('single_leg_rv', false, 0.2, 1.25, DAY, 1_002);

    // Simulated reboot — in-memory state gone, disk survives.
    clearCostAwareGateLedger();
    expect(summarizeCostAwareGate(DAY).decisionsRecorded).toBe(0);

    const h = hydrateCostAwareGateFromDisk(dir, 2_000);
    expect(h).toMatchObject({ records: 2, days: 1 });
    const s = summarizeCostAwareGate(DAY);
    expect(s.admittedTotal).toBe(1);
    expect(s.rejectedTotal).toBe(1);
  });

  it('drops records past the 7-day retention window and compacts the file', () => {
    const now = 30 * 24 * 60 * 60 * 1000;
    const stale = now - 8 * 24 * 60 * 60 * 1000;
    const fresh = now - 60 * 1000;
    writeFileSync(
      costAwareGateLogPath(dir),
      [
        JSON.stringify({ ts: stale, etDay: '2026-07-01', structure: 'single_leg_rv', admit: true, grossR: 2, barR: 1.25 }),
        JSON.stringify({ ts: fresh, etDay: DAY, structure: 'single_leg_rv', admit: false, grossR: 0.3, barR: 1.25 }),
        '{ torn partial line',
      ].join('\n') + '\n',
      'utf8',
    );

    const h = hydrateCostAwareGateFromDisk(dir, now);
    expect(h.records).toBe(1);
    expect(summarizeCostAwareGate('2026-07-01').decisionsRecorded).toBe(1); // total is across retained days
    expect(summarizeCostAwareGate('2026-07-01').rejectedTotal).toBe(0); // the stale day is gone
    expect(summarizeCostAwareGate(DAY).rejectedTotal).toBe(1);

    const lines = readFileSync(costAwareGateLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1); // stale + torn line compacted away
    expect(JSON.parse(lines[0]!)).toMatchObject({ etDay: DAY, admit: false });
  });

  it('keeps in-memory counts without a dataDir (unit/CLI path, no file write)', () => {
    clearCostAwareGateLedger(); // no hydrate ⇒ no dataDir configured
    recordCostAwareGateDecision('directional', true, 1.9, 1.25, DAY, 1_001);
    expect(summarizeCostAwareGate(DAY).admittedTotal).toBe(1);
  });

  // TRA-1703 — an observed breach must survive a reboot AS AN OBSERVED BREACH.
  //
  // The hydrate sanitizer used to collapse every non-`delta_ceiling` kind to `cost_bar`,
  // so a `delta_ceiling_observed` line replayed as a cost-bar ADMIT carrying grossR 0 /
  // barR 0. That zeroed the observe counter, inflated `admitted`, dragged
  // `avgAdmittedGrossR` toward zero and clobbered the reported bar to 0.00R — and then
  // COMPACTION rewrote the file to the sanitized line, destroying the evidence on disk.
  // The observe window (TRA-1690) reads exactly this counter.
  it('survives a reboot: an OBSERVED breach rehydrates as observed, not as a cost-bar admit', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordCostAwareGateDecision('single_leg_rv', true, 1.4, 1.25, DAY, 1_001);
    recordEntryDeltaCeilingObserved('single_leg_rv', 0.71, DAY, 1_002);
    recordEntryDeltaCeilingReject('single_leg_otm', 0.68, DAY, 1_003);

    clearCostAwareGateLedger();
    hydrateCostAwareGateFromDisk(dir, 2_000);

    const rv = summarizeCostAwareGate(DAY).byStructure.find((s) => s.structure === 'single_leg_rv');
    expect(rv?.deltaCeilingObserved).toBe(1);
    expect(rv?.avgDeltaCeilingObservedAbsDelta).toBeCloseTo(0.71, 4);
    expect(rv?.deltaCeilingRejected).toBe(0);
    // The breach traded, but it is NOT a cost-bar verdict — the bar never ruled on it.
    expect(rv?.admitted).toBe(1); // the one real cost-bar admit, not two
    expect(rv?.avgAdmittedGrossR).toBeCloseTo(1.4, 4); // not dragged to 0.7 by a phantom grossR-0 admit
    expect(rv?.barR).toBeCloseTo(1.25, 4); // not clobbered to 0

    const otm = summarizeCostAwareGate(DAY).byStructure.find((s) => s.structure === 'single_leg_otm');
    expect(otm?.deltaCeilingRejected).toBe(1);
    expect(otm?.deltaCeilingObserved).toBe(0);

    // And the durable line still says what it was — compaction must not launder the kind.
    const lines = readFileSync(costAwareGateLogPath(dir), 'utf8').trim().split('\n');
    const kinds = lines.map((l) => JSON.parse(l).gate);
    expect(kinds).toContain('delta_ceiling_observed');
    expect(kinds).toContain('delta_ceiling');
  });

  // TRA-1703 — the observe window's ABORT tripwire is "deltaCeilingRejected > 0 on
  // single_leg_rv AT ANY POINT IN THE WINDOW" (TRA-1690 §6). `byStructure` is scoped to
  // ONE ET day by design, so that tripwire silently self-cleared at ET midnight: a reject
  // on day 3 read as 0 from day 4 on, and the window would keep accruing while the sleeve
  // it meant to measure was being cut. The retained rollup is the multi-day view.
  it('rolls the retained window across ET days so a ceiling reject cannot self-clear at midnight', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordEntryDeltaCeilingReject('single_leg_rv', 0.7, '2026-07-13', 1_001);
    recordEntryDeltaCeilingObserved('single_leg_rv', 0.66, '2026-07-13', 1_002);
    recordEntryDeltaCeilingObserved('single_leg_rv', 0.69, '2026-07-14', 1_003);

    // Read on 07-14: yesterday's reject is invisible to the day view...
    const today = summarizeCostAwareGate('2026-07-14');
    expect(today.deltaCeilingRejectedTotal).toBe(0);
    expect(today.deltaCeilingObservedTotal).toBe(1);

    // ...but the retained rollup still carries it. This is the tripwire.
    expect(today.retained.etDays).toEqual(['2026-07-13', '2026-07-14']);
    expect(today.retained.deltaCeilingRejectedTotal).toBe(1);
    expect(today.retained.deltaCeilingObservedTotal).toBe(2);
    const rv = today.retained.byStructure.find((s) => s.structure === 'single_leg_rv');
    expect(rv?.deltaCeilingRejected).toBe(1);
    expect(rv?.deltaCeilingObserved).toBe(2);
    expect(today.retained.retentionDays).toBe(7);
  });

  // TRA-1707 — `apply()` seeded `lastBarR` from whatever record CREATED the (day, structure)
  // tally. A ceiling record carries `barR: 0` (it has no modeled bar, correctly), and its own
  // branch then never writes the field again. So a day whose FIRST candidate on a structure
  // breached the ceiling opened with `barR: 0.00` on a structure whose bar is live —
  // a live bar and an absent bar reading identically, the same false-zero shape as the stale
  // `.js`, the impossible gate, and the laundered breach.
  //
  // `mergeTally()` already guarded this for the `retained` fold; the DAY view did not.
  it('a ceiling record that CREATES the tally must not publish a live bar as 0 (TRA-1707)', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    // The day's first OTM candidate breaches the ENFORCING ceiling. No cost-bar decision yet.
    recordEntryDeltaCeilingReject('single_leg_otm', 0.62, DAY, 1_001);

    const otm = summarizeCostAwareGate(DAY).byStructure.find((s) => s.structure === 'single_leg_otm');
    expect(otm?.deltaCeilingRejected).toBe(1);
    // NOT 0: the bar was never measured today. 0 is a number a reader would act on.
    expect(otm?.barR).toBeNull();
    // Same rule, one field up: the bar ruled on NOTHING, so there is no rate to report.
    // 0 here would be indistinguishable from a gate refusing 100% of candidates (TRA-1677).
    expect(otm?.admitRate).toBeNull();
    expect(otm?.admitted).toBe(0);
    expect(otm?.rejected).toBe(0);
  });

  it('the first cost-bar decision sets the bar, and a later ceiling record never regresses it', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordEntryDeltaCeilingReject('single_leg_otm', 0.62, DAY, 1_001); // creates the tally, no bar
    recordCostAwareGateDecision('single_leg_otm', true, 1.4, 0.485, DAY, 1_002); // the real bar lands
    recordEntryDeltaCeilingReject('single_leg_otm', 0.71, DAY, 1_003); // must NOT clobber it back to 0

    const otm = summarizeCostAwareGate(DAY).byStructure.find((s) => s.structure === 'single_leg_otm');
    expect(otm?.barR).toBeCloseTo(0.485, 4);
    expect(otm?.admitRate).toBe(1);
    expect(otm?.deltaCeilingRejected).toBe(2);

    // And it survives the reboot that TRA-1703 was about — through the retained fold too.
    clearCostAwareGateLedger();
    hydrateCostAwareGateFromDisk(dir, 2_000);
    const after = summarizeCostAwareGate(DAY);
    expect(after.byStructure.find((s) => s.structure === 'single_leg_otm')?.barR).toBeCloseTo(0.485, 4);
    expect(after.retained.byStructure.find((s) => s.structure === 'single_leg_otm')?.barR).toBeCloseTo(
      0.485,
      4,
    );
  });

  // The `retained` fold keys on structure across days. A day with ONLY ceiling records
  // contributes no bar and must not erase the bar a real cost-bar day established.
  it('a bar-less ceiling-only day does not erase a previous day\'s measured bar in the retained roll', () => {
    hydrateCostAwareGateFromDisk(dir, 1_000);
    recordCostAwareGateDecision('single_leg_otm', true, 1.4, 0.485, '2026-07-13', 1_001);
    recordEntryDeltaCeilingReject('single_leg_otm', 0.7, '2026-07-14', 1_002); // ceiling-only day

    const s = summarizeCostAwareGate('2026-07-14');
    // The DAY view honestly reports "not measured today" — not 0.
    expect(s.byStructure.find((x) => x.structure === 'single_leg_otm')?.barR).toBeNull();
    // The retained roll still carries the last REAL bar.
    expect(s.retained.byStructure.find((x) => x.structure === 'single_leg_otm')?.barR).toBeCloseTo(0.485, 4);
  });

  // ── TRA-1681: durability provenance ───────────────────────────────────────────
  //
  // `retained.etDays[]` was being read as a DATA_DIR proof (TRA-1690 assertion 6): empty
  // ⇒ fail-open, non-empty ⇒ a durable floor exists. The first half holds. The second is
  // FALSE, and these tests are here to keep it dead: `byDay` is fed by the live pass, so
  // `etDays` populates from in-memory decisions whether or not a byte ever reached disk.
  describe('durability (TRA-1681)', () => {
    const realDataDir = process.env.DATA_DIR;
    afterEach(() => {
      if (realDataDir === undefined) delete process.env.DATA_DIR;
      else process.env.DATA_DIR = realDataDir;
    });

    it('THE FALSE-PASS: a memory-only ledger still publishes a full etDays[] — only `durability` tells you nothing is on disk', () => {
      // No hydrate ⇒ dataDir stays null ⇒ applyAndAppend early-returns before the write.
      recordCostAwareGateDecision('single_leg_rv', true, 1.2, 0.4, DAY, 1_001);
      recordEntryDeltaCeilingObserved('single_leg_rv', 0.72, DAY, 1_002);

      const s = summarizeCostAwareGate(DAY);
      // The instrument that was being trusted reads exactly like a healthy ledger:
      expect(s.retained.etDays).toEqual([DAY]);
      expect(s.retained.deltaCeilingObservedTotal).toBe(1);
      expect(s.decisionsRecorded).toBe(2);
      // ...while NOTHING is durable. This is the field that separates the two states.
      expect(s.durability.dataDir).toBeNull();
      expect(s.durability.ephemeral).toBe(true);
      expect(s.durability.hydratedRecords).toBe(0);
    });

    it('an EPHEMERAL DATA_DIR (env unset ⇒ in-bundle fallback) writes and reads back cleanly, and is still flagged', () => {
      // The prod shape: the fallback path is real and writable, so every IO check PASSES.
      // mkdir succeeds, append succeeds, hydrate succeeds. Only the PATH gives it away.
      delete process.env.DATA_DIR;
      hydrateCostAwareGateFromDisk(dir, 1_000);
      recordCostAwareGateDecision('single_leg_rv', true, 1.2, 0.4, DAY, 1_001);

      const s = summarizeCostAwareGate(DAY);
      expect(readFileSync(costAwareGateLogPath(dir), 'utf8')).toContain('single_leg_rv'); // the write WORKED
      expect(s.retained.etDays).toEqual([DAY]); // and the counters look perfect
      expect(s.durability.ephemeral).toBe(true); // ...on a disk that dies at the redeploy
      expect(s.durability.appendErrors).toBe(0); // no error was ever raised. There is none to raise.
    });

    it('a DURABLE DATA_DIR is not flagged, and a reboot proves the floor via hydratedRecords', () => {
      process.env.DATA_DIR = dir;
      hydrateCostAwareGateFromDisk(dir, 1_000);
      recordCostAwareGateDecision('single_leg_rv', true, 1.2, 0.4, DAY, 1_001);
      recordEntryDeltaCeilingReject('single_leg_rv', 0.9, DAY, 1_002);
      expect(summarizeCostAwareGate(DAY).durability).toMatchObject({
        ephemeral: false,
        hydratedRecords: 0, // first boot: a clean floor is legitimately empty...
      });

      // ...so the floor is only PROVEN by surviving a restart. Reboot against the same dir:
      clearCostAwareGateLedger();
      hydrateCostAwareGateFromDisk(dir, 2_000);

      const s = summarizeCostAwareGate(DAY);
      expect(s.durability).toMatchObject({ dataDir: dir, ephemeral: false, hydratedRecords: 2, hydratedDays: 1 });
      expect(s.retained.deltaCeilingRejectedTotal).toBe(1); // the tripwire survived the reboot
    });

    it('a swallowed append is COUNTED — the tally shows a row that never reached disk', () => {
      process.env.DATA_DIR = dir;
      hydrateCostAwareGateFromDisk(dir, 1_000);
      // Make the append throw (EISDIR) without breaking the trade pass: a directory where
      // the log file belongs. mkdirSync(recursive) on the PARENT still succeeds.
      rmSync(costAwareGateLogPath(dir), { force: true });
      mkdirSync(costAwareGateLogPath(dir)); // exact path, not a file anymore

      expect(() => recordCostAwareGateDecision('single_leg_rv', true, 1.2, 0.4, DAY, 1_001)).not.toThrow();

      const s = summarizeCostAwareGate(DAY);
      expect(s.retained.etDays).toEqual([DAY]); // the counter moved...
      expect(s.durability.appendErrors).toBe(1); // ...and the row is NOT on disk. Loudly.
      expect(s.durability.lastAppendError).toBeTruthy();
    });
  });

  // ── TRA-2295 — the spread ceiling's SEPARATING instrument ──────────────────
  //
  // The directional sleeve opened 83 positions against a ceiling it never
  // evaluated and no counter moved, because the only thing anyone thinks to count
  // is rejections — and an unenforced gate rejects exactly as many candidates as a
  // gate with nothing to reject. These tests pin the field that tells them apart.
  describe('spread ceiling counters (TRA-2295)', () => {
    const S = 'single_leg_directional';
    const row = (day = DAY) => summarizeCostAwareGate(day).byStructure.find(b => b.structure === S);

    it('THE SEPARATOR: never-ran, ran-and-clean, and biting are three different readings', () => {
      // 1. Never ran. No structure row at all — not a reassuring zero.
      expect(row()).toBeUndefined();
      expect(summarizeCostAwareGate(DAY).spreadCeilingEvaluatedTotal).toBe(0);

      // 2. Ran, rejected nothing. `rejected` is 0 here TOO — identical to (1) on
      //    that field alone. `evaluated` is what makes the two distinguishable.
      recordSpreadCeilingDecision(S, true, 0.04, 'ok', DAY, 1_000);
      recordSpreadCeilingDecision(S, true, 0.06, 'ok', DAY, 1_001);
      expect(row()!.spreadCeilingRejected).toBe(0);
      expect(row()!.spreadCeilingEvaluated).toBe(2);
      expect(row()!.spreadCeilingRejectRate).toBe(0);

      // 3. Biting.
      recordSpreadCeilingDecision(S, false, 1.933, 'max_spread_pct', DAY, 1_002);
      expect(row()!.spreadCeilingEvaluated).toBe(3);
      expect(row()!.spreadCeilingRejected).toBe(1);
      expect(row()!.spreadCeilingRejectsByCode).toEqual({ max_spread_pct: 1 });
      expect(row()!.avgRejectedSpreadPct).toBeCloseTo(1.933, 6);
    });

    it('rejectRate is NULL — never 0 — when the gate ruled on nothing', () => {
      // Same rule as `admitRate` (TRA-1682): "did not run" is not a rate. If it
      // rendered as 0 it would sit in the payload looking like a clean bill of
      // health, which is the exact reading production gave for 83 fills.
      recordCostAwareGateDecision(S, true, 1.2, 0.4, DAY, 1_000);
      expect(row()!.spreadCeilingEvaluated).toBe(0);
      expect(row()!.spreadCeilingRejectRate).toBeNull();
      expect(row()!.maxAdmittedSpreadPct).toBeNull();
    });

    it('maxAdmittedSpreadPct is the invariant — it tracks the widest ADMITTED quote only', () => {
      recordSpreadCeilingDecision(S, true, 0.04, 'ok', DAY, 1_000);
      recordSpreadCeilingDecision(S, true, 0.098, 'ok', DAY, 1_001);
      // A REJECT of 1.933 must not touch it: the whole point is "what got through".
      recordSpreadCeilingDecision(S, false, 1.933, 'max_spread_pct', DAY, 1_002);
      expect(row()!.maxAdmittedSpreadPct).toBeCloseTo(0.098, 6);
      // An enforcing gate can never publish a value above its own ceiling.
      expect(row()!.maxAdmittedSpreadPct!).toBeLessThanOrEqual(0.1);
    });

    it('does NOT disturb the cost bar or the delta ceiling — four disjoint axes', () => {
      recordCostAwareGateDecision(S, true, 1.2, 0.4, DAY, 1_000);
      recordEntryDeltaCeilingReject(S, 0.62, DAY, 1_001);
      recordEntryDeltaCeilingObserved(S, 0.58, DAY, 1_002);
      recordSpreadCeilingDecision(S, false, 0.8, 'max_spread_pct', DAY, 1_003);

      const r = row()!;
      expect(r.admitted).toBe(1);
      expect(r.rejected).toBe(0); // spread rejects must NOT move the cost bar's admit rate
      expect(r.admitRate).toBe(1);
      expect(r.barR).toBe(0.4); // and must not clobber the live bar (TRA-1707 shape)
      expect(r.deltaCeilingRejected).toBe(1);
      expect(r.deltaCeilingObserved).toBe(1);
      expect(r.spreadCeilingRejected).toBe(1);
    });

    it('a no_quote reject omits spreadPct rather than zero-filling it', () => {
      // Zero-filling would drag `avgRejectedSpreadPct` toward 0 and — via the
      // compaction rewrite — could publish `maxAdmittedSpreadPct: 0` on a gate that
      // admitted something wide.
      recordSpreadCeilingDecision(S, false, null, 'no_quote', DAY, 1_000);
      expect(row()!.spreadCeilingRejected).toBe(1);
      expect(row()!.avgRejectedSpreadPct).toBe(0); // sum 0 over n 1 — but nothing was invented
      expect(row()!.spreadCeilingRejectsByCode).toEqual({ no_quote: 1 });
      expect(row()!.maxAdmittedSpreadPct).toBeNull();
    });

    it('SURVIVES A REBOOT with its kind intact — the TRA-1703 laundering trap', () => {
      // The precedent: hydrate once collapsed every unlisted kind to `cost_bar`,
      // which turned observe-only ceiling breaches into phantom cost-bar ADMITs and
      // — because compaction rewrites the file to the sanitized lines — DESTROYED
      // the evidence on disk at the first boot after a breach. New kinds have to be
      // in the preserved set or they inherit that bug.
      hydrateCostAwareGateFromDisk(dir, 1_000);
      recordSpreadCeilingDecision(S, true, 0.04, 'ok', DAY, 1_001);
      recordSpreadCeilingDecision(S, false, 1.933, 'max_spread_pct', DAY, 1_002);

      clearCostAwareGateLedger();
      hydrateCostAwareGateFromDisk(dir, 2_000);

      const r = row()!;
      expect(r.spreadCeilingEvaluated).toBe(2);
      expect(r.spreadCeilingRejected).toBe(1);
      expect(r.spreadCeilingRejectsByCode).toEqual({ max_spread_pct: 1 });
      expect(r.maxAdmittedSpreadPct).toBeCloseTo(0.04, 6);
      // NOT laundered into the cost bar.
      expect(r.admitted).toBe(0);
      expect(r.rejected).toBe(0);
      expect(r.barR).toBeNull();
      // And the multi-day roll sees it too — a one-day counter re-arms at midnight.
      expect(summarizeCostAwareGate(DAY).retained.spreadCeilingEvaluatedTotal).toBe(2);
      expect(summarizeCostAwareGate(DAY).retained.spreadCeilingRejectedTotal).toBe(1);
    });

    it('the retained roll sums across days, so a reject on day 1 is still visible on day 3', () => {
      recordSpreadCeilingDecision(S, false, 0.8, 'max_spread_pct', '2026-07-11', 1_000);
      recordSpreadCeilingDecision(S, true, 0.05, 'ok', '2026-07-13', 1_001);
      // Read from day 3: the day view has forgotten day 1's reject...
      expect(row('2026-07-13')!.spreadCeilingRejected).toBe(0);
      // ...the retained roll has not.
      expect(summarizeCostAwareGate('2026-07-13').retained.spreadCeilingRejectedTotal).toBe(1);
      expect(summarizeCostAwareGate('2026-07-13').retained.spreadCeilingEvaluatedTotal).toBe(2);
    });
  });
});
