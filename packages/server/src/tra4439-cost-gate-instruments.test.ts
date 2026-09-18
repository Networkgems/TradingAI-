// TRA-4439 — four (+1) instrument defects in the cost-aware-gate ledger and the
// rv-scan admissibility fold. Every test here drives the SHIPPED recorder → fold →
// classifier chain; none grades a hand-typed ledger row against a literal, because
// a control that grades a local copy agrees with itself.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCostAwareGateDecision,
  hydrateCostAwareGateFromDisk,
  summarizeCostAwareGate,
  clearCostAwareGateLedger,
  costAwareGateLogPath,
} from './cost-aware-gate-ledger.js';
import { classifyRvScanAdmissibility, type RvScanAdmissibilityLedgerRead } from './rv-scan-telemetry.js';

const D1 = '2026-09-17';
const D2 = '2026-09-18';
const BAR = 0.385;

/** The ledger read exactly as `/api/health/rv-scan` builds it (health-routes.ts). */
function ledgerRead(): RvScanAdmissibilityLedgerRead {
  const retained = summarizeCostAwareGate(D2).retained;
  return { etDays: retained.etDays, byStructure: retained.byStructure };
}

function row(structure: string) {
  const r = summarizeCostAwareGate(D2).retained.byStructure.find((s) => s.structure === structure);
  if (!r) throw new Error(`no row ${structure}`);
  return r;
}

describe('TRA-4439', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'tra4439-'));
    clearCostAwareGateLedger();
  });
  afterEach(() => {
    clearCostAwareGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('D1 — a bypass admit cannot serve as the positive control', () => {
    /** The 2026-09-18 live shape: RV rejects only, directional admits = allowance only. */
    function seedIncident(): void {
      for (let i = 0; i < 40; i++) {
        recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 1_000 + i, { accountClass: 'fixture' });
      }
      for (let i = 0; i < 12; i++) {
        recordCostAwareGateDecision('directional', true, -0.6157, BAR, D2, 2_000 + i, {
          accountClass: 'desk',
          bypass: 'exploration_allowance',
        });
      }
      for (let i = 0; i < 30; i++) {
        recordCostAwareGateDecision('directional', false, -0.4, BAR, D2, 3_000 + i, { accountClass: 'fixture' });
      }
    }

    it('the only admit on the read is a bypass admit ⇒ `unmeasured`, not `admitting_nothing`', () => {
      seedIncident();
      const v = classifyRvScanAdmissibility('rv_scan', ledgerRead());
      expect(v.status).toBe('unmeasured');
      expect(v.positiveControl).toBeNull();
      expect(v.reason).toContain('cleared 0 of 40');
      // The ledger itself now says what those 12 were.
      expect(row('directional')).toMatchObject({ admitted: 12, admittedByBypass: 12, admittedOnMerit: 0 });
      expect(row('directional').avgAdmittedOnMeritGrossR).toBeNull();
    });

    it('MUTATION: drop the bypass tag and the pre-fix control wrongly fires; the gross-R check still refuses it', () => {
      // Identical population, recorded the way a.187fc14..0dc2baea did — untagged. This
      // is also exactly how every PRE-TRA-4439 bypass line hydrates, so it is the case
      // the tag alone cannot cover.
      for (let i = 0; i < 40; i++) recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 1_000 + i);
      for (let i = 0; i < 12; i++) recordCostAwareGateDecision('directional', true, -0.6157, BAR, D2, 2_000 + i);
      const read = ledgerRead();
      // The old rule (`admitted > 0`) is satisfied — that is the defect, reproduced.
      expect(read.byStructure.find((s) => s.structure === 'directional')!.admitted).toBe(12);
      const v = classifyRvScanAdmissibility('rv_scan', read);
      expect(v.status).toBe('unmeasured');
    });

    it('MUTATION: strip the new ledger fields ⇒ the row cannot testify (fails closed, not to the old rule)', () => {
      seedIncident();
      recordCostAwareGateDecision('single_leg_otm', true, 1.2, BAR, D2, 4_000);
      const read = ledgerRead();
      const stripped: RvScanAdmissibilityLedgerRead = {
        etDays: read.etDays,
        byStructure: read.byStructure.map(({ structure, admitted, rejected }) => ({ structure, admitted, rejected })),
      };
      expect(classifyRvScanAdmissibility('rv_scan', stripped).status).toBe('unmeasured');
    });

    it('POSITIVE CONTROL: a genuine bar clearance on a sibling still convicts the empty set', () => {
      seedIncident();
      recordCostAwareGateDecision('single_leg_otm', true, 1.2, BAR, D2, 4_000, { accountClass: 'desk' });
      recordCostAwareGateDecision('single_leg_otm', true, 0.9, BAR, D2, 4_001, { accountClass: 'desk' });
      const v = classifyRvScanAdmissibility('rv_scan', ledgerRead());
      expect(v.status).toBe('admitting_nothing');
      expect(v.positiveControl).toEqual({ structure: 'single_leg_otm', admitted: 2, rejected: 0 });
      expect(v.reason).toContain('on MERIT');
    });

    it('a path whose only admits are bypass admits says so instead of crediting the bar', () => {
      seedIncident();
      const v = classifyRvScanAdmissibility('directional', ledgerRead());
      expect(v.status).toBe('admitting'); // candidates DO reach an open
      expect(v.admittedByBypass).toBe(12);
      expect(v.reason).toContain('0 cleared the bar, 12 via the exploration-allowance bypass');
    });

    it('the bypass tag and class SURVIVE a reboot (hydrate + compaction rewrite)', () => {
      hydrateCostAwareGateFromDisk(dir, Date.parse('2026-09-18T15:00:00Z'));
      const now = Date.parse('2026-09-18T14:00:00Z');
      recordCostAwareGateDecision('directional', true, -0.6, BAR, D2, now, {
        accountClass: 'desk',
        bypass: 'exploration_allowance',
      });
      recordCostAwareGateDecision('directional', false, Number.NaN, BAR, D2, now + 1, { accountClass: 'fixture' });
      // An expired line forces the compaction rewrite path.
      writeFileSync(
        costAwareGateLogPath(dir),
        JSON.stringify({ ts: 1, etDay: '2026-01-01', structure: 'x', admit: false, grossR: 0, barR: 0 }) + '\n',
        { flag: 'a' },
      );
      hydrateCostAwareGateFromDisk(dir, Date.parse('2026-09-18T15:00:00Z'));
      hydrateCostAwareGateFromDisk(dir, Date.parse('2026-09-18T15:00:00Z'));
      const r = row('directional');
      expect(r).toMatchObject({ admitted: 1, admittedByBypass: 1, rejected: 1, grossRUnmeasurable: 1 });
      expect(r.costBarByAccountClass.desk).toMatchObject({ admitted: 1, admittedByBypass: 1 });
      expect(r.costBarByAccountClass.fixture).toMatchObject({ rejected: 1, grossRUnmeasurable: 1 });
    });
  });

  describe('D2 — the grossR zero-fill is counted and kept out of the measured mean/max', () => {
    it('counts NaN fills at the recorder, emits 0 when none, and excludes fills from mean + max', () => {
      recordCostAwareGateDecision('single_leg_otm', false, -0.2, BAR, D2, 1);
      expect(row('single_leg_otm').grossRUnmeasurable).toBe(0); // emitted at zero, not absent
      recordCostAwareGateDecision('single_leg_rv', false, -0.3, BAR, D2, 2);
      recordCostAwareGateDecision('single_leg_rv', false, 0.25, BAR, D2, 3);
      for (let i = 0; i < 8; i++) recordCostAwareGateDecision('single_leg_rv', false, Number.NaN, BAR, D2, 10 + i);
      const r = row('single_leg_rv');
      expect(r.rejected).toBe(10);
      expect(r.grossRUnmeasurable).toBe(8);
      // Byte-compatible pooled mean still carries the fills: (−0.3 + 0.25 + 8×0) / 10.
      expect(r.avgRejectedGrossR).toBeCloseTo(-0.005, 6);
      // The measured mean does not.
      expect(r.avgRejectedGrossRMeasured).toBeCloseTo(-0.025, 6);
      expect(r.maxRejectedGrossR).toBe(0.25);
    });

    it('MUTATION: a max over fills would read 0 on an all-negative population — it must stay the real max', () => {
      recordCostAwareGateDecision('single_leg_rv', false, -0.3, BAR, D2, 1);
      recordCostAwareGateDecision('single_leg_rv', false, Number.NaN, BAR, D2, 2);
      expect(row('single_leg_rv').maxRejectedGrossR).toBe(-0.3);
    });

    it('an all-fill population has NO measured mean or max (null, never 0)', () => {
      recordCostAwareGateDecision('single_leg_rv', false, Number.NaN, BAR, D2, 1);
      const r = row('single_leg_rv');
      expect(r.avgRejectedGrossRMeasured).toBeNull();
      expect(r.maxRejectedGrossR).toBeNull();
      expect(r.avgRejectedGrossR).toBe(0); // the old field, still reading a fill as a score
    });
  });

  describe('D3 — the reason quotes days with decisions, not the retention window', () => {
    it('one deciding day inside a multi-day window reads as ONE day', () => {
      // Another structure keeps D1 in the retention window.
      recordCostAwareGateDecision('single_leg_otm', true, 1.2, BAR, D1, 1);
      recordCostAwareGateDecision('single_leg_otm', true, 1.3, BAR, D2, 2);
      recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 3);
      const read = ledgerRead();
      expect(read.etDays).toEqual([D1, D2]);
      expect(row('single_leg_rv').costBarDecisionEtDays).toEqual([D2]);
      expect(row('single_leg_otm').costBarDecisionEtDays).toEqual([D1, D2]);
      const v = classifyRvScanAdmissibility('rv_scan', read);
      expect(v.decisionEtDays).toEqual([D2]);
      expect(v.reason).toContain('on 1 ET day(s) with decisions (of 2 retained)');
      expect(v.reason).not.toContain('across 2 retained');
    });

    it('MUTATION: without the per-structure days the reason names a WINDOW, never a span', () => {
      recordCostAwareGateDecision('single_leg_otm', true, 1.2, BAR, D1, 1);
      recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 3);
      const read = ledgerRead();
      const v = classifyRvScanAdmissibility('rv_scan', {
        etDays: read.etDays,
        byStructure: read.byStructure.map(({ costBarDecisionEtDays: _d, ...rest }) => rest),
      });
      expect(v.decisionEtDays).toBeNull();
      expect(v.reason).toContain('retention window (days with decisions not reported)');
    });

    it('the one-day view reports its own day only for structures that decided', () => {
      recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 3);
      const today = summarizeCostAwareGate(D2).byStructure.find((s) => s.structure === 'single_leg_rv')!;
      expect(today.costBarDecisionEtDays).toEqual([D2]);
    });
  });

  describe('D5 — the cost-bar counters split by account class, reconciled to the pool', () => {
    it('emits all three classes, and the classes sum to the pooled counters', () => {
      recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 1, { accountClass: 'fixture' });
      recordCostAwareGateDecision('single_leg_rv', false, -0.07, BAR, D2, 2, { accountClass: 'fixture' });
      recordCostAwareGateDecision('single_leg_rv', false, 0.3, BAR, D2, 3, { accountClass: 'desk' });
      recordCostAwareGateDecision('single_leg_rv', false, Number.NaN, BAR, D2, 4, { accountClass: 'desk' });
      recordCostAwareGateDecision('single_leg_rv', false, -0.1, BAR, D2, 5); // no class ⇒ unattributed, never desk
      const r = row('single_leg_rv');
      const cls = r.costBarByAccountClass;
      expect(Object.keys(cls).sort()).toEqual(['desk', 'fixture', 'unattributed']);
      expect(cls.desk).toMatchObject({ rejected: 2, grossRUnmeasurable: 1, avgRejectedGrossR: 0.3, maxRejectedGrossR: 0.3 });
      expect(cls.fixture).toMatchObject({ rejected: 2, maxRejectedGrossR: -0.05 });
      expect(cls.fixture.avgRejectedGrossR).toBeCloseTo(-0.06, 6);
      expect(cls.unattributed).toMatchObject({ rejected: 1, admitted: 0 });
      const sum = (k: 'admitted' | 'rejected' | 'grossRUnmeasurable' | 'admittedByBypass') =>
        cls.desk[k] + cls.fixture[k] + cls.unattributed[k];
      expect(sum('rejected')).toBe(r.rejected);
      expect(sum('admitted')).toBe(r.admitted);
      expect(sum('grossRUnmeasurable')).toBe(r.grossRUnmeasurable);
      expect(sum('admittedByBypass')).toBe(r.admittedByBypass);
    });

    it('an empty class is emitted at zero with null mean/max (absent ≠ passing)', () => {
      recordCostAwareGateDecision('single_leg_rv', false, -0.05, BAR, D2, 1, { accountClass: 'fixture' });
      expect(row('single_leg_rv').costBarByAccountClass.desk).toEqual({
        accountClass: 'desk',
        admitted: 0,
        admittedByBypass: 0,
        rejected: 0,
        grossRUnmeasurable: 0,
        avgRejectedGrossR: null,
        maxRejectedGrossR: null,
      });
    });

    it('a pre-TRA-4439 line (no class) hydrates as `unattributed`, never back-filled as desk', () => {
      const ts = Date.parse('2026-09-18T14:00:00Z');
      writeFileSync(
        costAwareGateLogPath(dir),
        JSON.stringify({ ts, etDay: D2, structure: 'single_leg_rv', admit: false, grossR: -0.05, barR: BAR, gate: 'cost_bar' }) + '\n',
      );
      hydrateCostAwareGateFromDisk(dir, ts + 1000);
      const cls = row('single_leg_rv').costBarByAccountClass;
      expect(cls.unattributed.rejected).toBe(1);
      expect(cls.desk.rejected).toBe(0);
    });
  });
});
