// TRA-1602 (TRA-1600C) — durable admit/reject telemetry for the cost-aware fire bar.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordCostAwareGateDecision,
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
});
