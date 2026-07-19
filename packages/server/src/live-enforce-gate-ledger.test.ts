// TRA-2048 (parent TRA-2044) — durable LIVE gate-enforcement telemetry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordLiveEnforceDecision,
  hydrateLiveEnforceGateFromDisk,
  summarizeLiveEnforceGate,
  clearLiveEnforceGateLedger,
  liveEnforceGateLogPath,
} from './live-enforce-gate-ledger.js';

const DAY = '2026-07-18';

/** Convenience: pull one gate's fold out of the day view. */
function gate(day: string, g: 'cost_bar' | 'spread') {
  return summarizeLiveEnforceGate(day).byGate.find((x) => x.gate === g)!;
}

describe('live-enforce-gate-ledger', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'live-enforce-'));
    clearLiveEnforceGateLedger();
  });

  afterEach(() => {
    clearLiveEnforceGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('summarizes an empty ledger as an honest zero (both gates present, rate null)', () => {
    const s = summarizeLiveEnforceGate(DAY);
    expect(s.decisionsRecorded).toBe(0);
    expect(s.lastDecisionAt).toBeNull();
    // Both gates are always present so a reader never mistakes "gate absent" for "gate armed, nothing seen".
    expect(s.byGate.map((g) => g.gate).sort()).toEqual(['cost_bar', 'spread']);
    for (const g of s.byGate) {
      expect(g).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
    }
  });

  it('distinguishes armed-but-inert (0 evaluated) from armed-and-passing (evaluated>0, blocked 0)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    // cost_bar armed and saw two candidates, blocked neither.
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_001);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_002);

    const cost = gate(DAY, 'cost_bar');
    expect(cost).toMatchObject({ evaluated: 2, blocked: 0, blockRate: 0 });
    // spread gate never fired: evaluated 0, rate null — NOT 0 (0 would read as "saw orders, blocked none").
    expect(gate(DAY, 'spread')).toMatchObject({ evaluated: 0, blocked: 0, blockRate: null });
  });

  it('counts blocks per gate and per scope with a block rate', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, DAY, 'over cost bar', 1_001);
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', false, DAY, undefined, 1_002);
    recordLiveEnforceDecision('cost_bar', 'single_leg_rv', true, DAY, 'over cost bar', 1_003);
    recordLiveEnforceDecision('spread', 'AAPL', true, DAY, 'SPREAD_TOO_WIDE', 1_004);

    const cost = gate(DAY, 'cost_bar');
    expect(cost).toMatchObject({ evaluated: 3, blocked: 2 });
    expect(cost.blockRate).toBeCloseTo(2 / 3, 4);
    // Busiest scope first.
    expect(cost.byScope[0]).toMatchObject({ scope: 'single_leg_otm', evaluated: 2, blocked: 1, blockRate: 0.5 });
    expect(cost.byScope[1]).toMatchObject({ scope: 'single_leg_rv', evaluated: 1, blocked: 1, blockRate: 1 });

    const spread = gate(DAY, 'spread');
    expect(spread).toMatchObject({ evaluated: 1, blocked: 1, blockRate: 1 });

    const s = summarizeLiveEnforceGate(DAY);
    expect(s.decisionsRecorded).toBe(4);
    expect(s.lastDecisionAt).toBe(1_004);
  });

  it('writes a reason only on blocked rows, and persists them durably', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('spread', 'MSFT', true, DAY, 'SPREAD_TOO_WIDE', 1_001);
    recordLiveEnforceDecision('spread', 'MSFT', false, DAY, undefined, 1_002);

    const lines = readFileSync(liveEnforceGateLogPath(dir), 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ gate: 'spread', scope: 'MSFT', blocked: true, reason: 'SPREAD_TOO_WIDE' });
    // An allowed row carries no reason field (no false rejection-reason on disk).
    expect(lines[1]).toMatchObject({ gate: 'spread', scope: 'MSFT', blocked: false });
    expect(lines[1].reason).toBeUndefined();
  });

  it('rebuilds counts from disk on reboot (a fresh process re-hydrates the same tallies)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('cost_bar', 'directional', true, DAY, 'over cost bar', 1_001);
    recordLiveEnforceDecision('cost_bar', 'directional', false, DAY, undefined, 1_002);

    // Simulate a reboot: wipe memory, re-hydrate from the same dir.
    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, 2_000);
    expect(h.records).toBe(2);

    const cost = gate(DAY, 'cost_bar');
    expect(cost).toMatchObject({ evaluated: 2, blocked: 1 });
    const s = summarizeLiveEnforceGate(DAY);
    expect(s.durability.hydratedRecords).toBe(2);
    expect(s.durability.dataDir).toBe(dir);
  });

  it('folds every retained ET day (a one-day counter self-clears at midnight)', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    recordLiveEnforceDecision('spread', 'AAPL', true, '2026-07-17', 'SPREAD_TOO_WIDE', 1_001);
    recordLiveEnforceDecision('spread', 'AAPL', false, '2026-07-18', undefined, 1_002);

    // The day view for the 18th shows only that day's block (0).
    expect(gate('2026-07-18', 'spread').blocked).toBe(0);
    // But retained folds the 17th's block back in.
    const retained = summarizeLiveEnforceGate('2026-07-18').retained;
    expect(retained.etDays).toEqual(['2026-07-17', '2026-07-18']);
    const spread = retained.byGate.find((g) => g.gate === 'spread')!;
    expect(spread).toMatchObject({ evaluated: 2, blocked: 1 });
  });

  it('drops records older than the retention horizon on hydrate', () => {
    hydrateLiveEnforceGateFromDisk(dir, 1_000);
    const old = 1_000; // ts well before the cutoff when we re-hydrate at a far-future now
    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, '2026-01-01', 'stale', old);

    const farFuture = old + 40 * 24 * 60 * 60 * 1000; // > 30-day RETAIN_MS
    clearLiveEnforceGateLedger();
    const h = hydrateLiveEnforceGateFromDisk(dir, farFuture);
    expect(h.records).toBe(0);
  });
});
