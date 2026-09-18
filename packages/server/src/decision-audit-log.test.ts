// TRA-4658 — the decision audit log graded on both sides: rows land on disk
// with the fields the AC names (proposed vs executed, P&L attribution, hold
// time, actor, reason), AND a broken log is visibly broken — the append-
// failure positive control is the discriminator that keeps "no rows" from
// reading like "no decisions".

import { mkdtempSync, readFileSync, readdirSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  __resetDecisionAuditForTest,
  auditEquityExit,
  auditOptionFill,
  auditOrderAdmit,
  auditSignalFired,
  DECISION_AUDIT_CSV_COLUMNS,
  DECISION_AUDIT_RETENTION_DAYS,
  decisionAuditEventsToCsv,
  decisionAuditFlushForTests,
  getDecisionAuditState,
  pruneDecisionAuditFiles,
  queryDecisionAudit,
  recordDecisionAudit,
  type DecisionAuditEvent,
} from './decision-audit-log.js';
import {
  __resetHardControlsForTest,
  admitOrderThroughHardControls,
  engageHardKillSwitch,
  hydrateHardControlsFromDisk,
  recordHardControlsPnl,
} from './hard-controls.js';
import { etDateKey } from './et-clock.js';

// A weekday mid-session instant: 2026-09-16 14:00 ET.
const NOW = Date.parse('2026-09-16T18:00:00.000Z');
const TODAY = etDateKey(NOW);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'decision-audit-'));
  __resetDecisionAuditForTest({ dir });
});

async function rowsOnDisk(day: string): Promise<DecisionAuditEvent[]> {
  await decisionAuditFlushForTests();
  const file = join(dir, `decisions-${day}.jsonl`);
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf-8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as DecisionAuditEvent);
}

describe('recorder + persistence', () => {
  it('appends a JSONL row to the ET-day file and counts it by category', async () => {
    const event = recordDecisionAudit({
      category: 'signal', action: 'signal_fired', outcome: 'fired',
      atMs: NOW, symbol: 'AAPL', strategy: 'orb_breakout', signalId: 'sig-1', price: 232.1,
    });
    expect(event).not.toBeNull();
    const rows = await rowsOnDisk(TODAY);
    expect(rows).toHaveLength(1);
    expect(rows[0].etDay).toBe(TODAY);
    expect(rows[0].symbol).toBe('AAPL');
    expect(rows[0].price).toBe(232.1);
    const state = getDecisionAuditState();
    expect(state.written).toBe(1);
    expect(state.writtenByCategory['signal']).toBe(1);
    expect(state.appendFailures).toBe(0);
  });

  it('non-finite numerics are recorded as null, never coerced to 0', async () => {
    recordDecisionAudit({
      category: 'order', action: 'fill_booked', outcome: 'filled',
      atMs: NOW, qty: Number.NaN, price: undefined as unknown as number, pnlUsd: Infinity,
    });
    const [row] = await rowsOnDisk(TODAY);
    expect(row.qty).toBeNull();
    expect(row.price).toBeNull();
    expect(row.pnlUsd).toBeNull();
  });

  it('an unusable input is DROPPED AND COUNTED, never thrown', () => {
    const out = recordDecisionAudit({
      category: 'nonsense' as never, action: 'x', outcome: 'y',
    });
    expect(out).toBeNull();
    const state = getDecisionAuditState();
    expect(state.droppedInputs).toBe(1);
    expect(state.lastDropReason).toContain('nonsense');
  });

  it('POSITIVE CONTROL: a failing append increments the failure counter', async () => {
    // Point the audit dir AT A FILE so mkdir/append must fail.
    const blocked = join(dir, 'not-a-dir');
    writeFileSync(blocked, 'occupied', 'utf-8');
    __resetDecisionAuditForTest({ dir: blocked });
    recordDecisionAudit({ category: 'signal', action: 'signal_fired', outcome: 'fired', atMs: NOW });
    await decisionAuditFlushForTests();
    const state = getDecisionAuditState();
    expect(state.appendFailures).toBe(1);
    expect(state.lastAppendError).not.toBeNull();
    expect(state.written).toBe(0);
  });
});

describe('typed tees', () => {
  it('auditSignalFired: a skipped signal reads skipped, a clean one fired', async () => {
    auditSignalFired({ id: 's1', symbol: 'NVDA', type: 'orb_breakout', timestamp: NOW }, 'demo');
    auditSignalFired({
      id: 's2', symbol: 'NVDA', type: 'orb_breakout', timestamp: NOW + 1,
      signalSkipReason: 'below cost bar', signalSkipCode: 'cost_bar',
    }, 'demo');
    const rows = await rowsOnDisk(TODAY);
    expect(rows.map((r) => r.outcome)).toEqual(['fired', 'skipped']);
    expect(rows[1].reason).toBe('below cost bar');
  });

  it('auditOrderAdmit: quote age is derived from the intent timestamp', async () => {
    auditOrderAdmit(
      { kind: 'open', notionalUsd: 120, openPositionCount: 1, quoteAsOfMs: NOW - 2_000, idempotencyKey: 'k1' },
      { allowed: false, reasonCode: 'stale_quote', reason: 'too old' },
      NOW,
    );
    const [row] = await rowsOnDisk(TODAY);
    expect(row.category).toBe('order');
    expect(row.outcome).toBe('refused');
    expect(row.quote?.ageMs).toBe(2_000);
    expect((row.detail as { reasonCode: string }).reasonCode).toBe('stale_quote');
  });

  it('auditOptionFill: notional folds the 100-multiplier; the entry quote rides along', async () => {
    auditOptionFill({
      id: 'p1', symbol: 'TSLA', optionSymbol: 'TSLA260116C00300000', contracts: 2,
      premiumPaid: 1.25, openedAt: NOW, entryBidAtOpen: 1.2, entryAskAtOpen: 1.3, signalType: 'relative_value',
    }, 'live');
    const [row] = await rowsOnDisk(TODAY);
    expect(row.notionalUsd).toBe(250);
    expect(row.quote?.bid).toBe(1.2);
    expect(row.quote?.ask).toBe(1.3);
    expect(row.strategy).toBe('relative_value');
  });

  it('auditEquityExit: hold time, planned-vs-actual and win/loss attribution', async () => {
    auditEquityExit({
      id: 'p2', symbol: 'AMD', side: 'buy', signalType: 'vwap_bounce', quantity: 3,
      entryPrice: 100, stopLoss: 97, takeProfit: 106, exitPrice: 106.1,
      openedAt: NOW - 60_000, closedAt: NOW, pnl: 18.3, exitReason: 'take_profit',
    }, 'demo');
    const [row] = await rowsOnDisk(TODAY);
    expect(row.category).toBe('exit');
    expect(row.outcome).toBe('win');
    expect(row.holdMs).toBe(60_000);
    expect(row.price).toBe(106.1);
    expect(row.proposedPrice).toBe(106); // graded against the planned target
    expect(row.pnlUsd).toBe(18.3);
  });
});

describe('query + CSV export', () => {
  const seed = async () => {
    recordDecisionAudit({ category: 'signal', action: 'signal_fired', outcome: 'fired', atMs: NOW, symbol: 'AAPL', strategy: 'orb' });
    recordDecisionAudit({ category: 'order', action: 'hard_controls_admit', outcome: 'refused', atMs: NOW + 1, symbol: 'AAPL' });
    recordDecisionAudit({ category: 'order', action: 'hard_controls_admit', outcome: 'admitted', atMs: NOW + 2, symbol: 'MSFT' });
    recordDecisionAudit({ category: 'exit', action: 'exit_booked', outcome: 'loss', atMs: NOW + 3, symbol: 'MSFT', strategy: 'orb' });
    await decisionAuditFlushForTests();
  };

  it('filters by category, symbol, outcome and strategy; oldest first', async () => {
    await seed();
    expect(queryDecisionAudit({ fromDay: TODAY, toDay: TODAY }, NOW).events).toHaveLength(4);
    expect(queryDecisionAudit({ fromDay: TODAY, toDay: TODAY, category: 'order' }, NOW).events).toHaveLength(2);
    expect(queryDecisionAudit({ fromDay: TODAY, toDay: TODAY, symbol: 'MSFT' }, NOW).events).toHaveLength(2);
    expect(queryDecisionAudit({ fromDay: TODAY, toDay: TODAY, outcome: 'refused' }, NOW).events).toHaveLength(1);
    expect(queryDecisionAudit({ fromDay: TODAY, toDay: TODAY, strategy: 'orb' }, NOW).events).toHaveLength(2);
    const all = queryDecisionAudit({ fromDay: TODAY, toDay: TODAY }, NOW).events;
    expect(all.map((e) => e.atMs)).toEqual([NOW, NOW + 1, NOW + 2, NOW + 3]);
  });

  it('a day outside the range is not read; the limit truncates the OLD end', async () => {
    await seed();
    const other = queryDecisionAudit({ fromDay: '2020-01-01', toDay: '2020-01-02' }, NOW);
    expect(other.events).toHaveLength(0);
    const capped = queryDecisionAudit({ fromDay: TODAY, toDay: TODAY, limit: 2 }, NOW);
    expect(capped.truncated).toBe(true);
    expect(capped.events.map((e) => e.atMs)).toEqual([NOW + 2, NOW + 3]);
  });

  it('a corrupt line is counted, never silently skipped', async () => {
    await seed();
    const file = join(dir, `decisions-${TODAY}.jsonl`);
    writeFileSync(file, readFileSync(file, 'utf-8') + '{not json\n', 'utf-8');
    const res = queryDecisionAudit({ fromDay: TODAY, toDay: TODAY }, NOW);
    expect(res.events).toHaveLength(4);
    expect(res.corruptLines).toBe(1);
  });

  it('CSV: exact header, one line per event, quoting on embedded commas/quotes', async () => {
    recordDecisionAudit({
      category: 'intervention', action: 'force_close_all', outcome: 'executed',
      atMs: NOW, actor: 'ops', reason: 'flatten, now — he said "go"',
      detail: { handlers: ['paper-book'] },
    });
    await decisionAuditFlushForTests();
    const csv = decisionAuditEventsToCsv(queryDecisionAudit({ fromDay: TODAY, toDay: TODAY }, NOW).events);
    const lines = csv.trim().split('\r\n');
    expect(lines[0]).toBe(DECISION_AUDIT_CSV_COLUMNS.join(','));
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain('"flatten, now — he said ""go"""');
    expect(lines[1]).toContain('paper-book');
  });
});

describe('retention', () => {
  it('prunes strictly-older-than-retention files, keeps everything younger, and counts', () => {
    const oldDay = etDateKey(NOW - (DECISION_AUDIT_RETENTION_DAYS + 10) * 86_400_000);
    const youngDay = etDateKey(NOW - 10 * 86_400_000);
    writeFileSync(join(dir, `decisions-${oldDay}.jsonl`), '{}\n', 'utf-8');
    writeFileSync(join(dir, `decisions-${youngDay}.jsonl`), '{}\n', 'utf-8');
    writeFileSync(join(dir, 'unrelated.txt'), 'keep me', 'utf-8');
    const { pruned } = pruneDecisionAuditFiles(NOW);
    expect(pruned).toBe(1);
    const left = readdirSync(dir);
    expect(left).toContain(`decisions-${youngDay}.jsonl`);
    expect(left).toContain('unrelated.txt');
    expect(left).not.toContain(`decisions-${oldDay}.jsonl`);
    expect(getDecisionAuditState().retentionDays).toBeGreaterThanOrEqual(90); // the AC floor
  });
});

describe('choke-point integration (TRA-4655 seam)', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'decision-audit-hc-'));
    // Pins the audit dir to <dataDir>/decision-audit via the hard-controls seam.
    __resetHardControlsForTest({ dataDir, nowMs: NOW });
    hydrateHardControlsFromDisk(NOW);
  });

  async function auditRows(): Promise<DecisionAuditEvent[]> {
    await decisionAuditFlushForTests();
    const file = join(dataDir, 'decision-audit', `decisions-${TODAY}.jsonl`);
    if (!existsSync(file)) return [];
    return readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim())
      .map((l) => JSON.parse(l) as DecisionAuditEvent);
  }

  it('EVERY admit verdict is audited — allowed and refused alike', async () => {
    const ok = admitOrderThroughHardControls(
      { kind: 'open', notionalUsd: 100, openPositionCount: 0, quoteAsOfMs: NOW - 500, idempotencyKey: 'dup' }, NOW,
    );
    expect(ok.allowed).toBe(true);
    const dup = admitOrderThroughHardControls(
      { kind: 'open', notionalUsd: 100, openPositionCount: 0, quoteAsOfMs: NOW - 500, idempotencyKey: 'dup' }, NOW + 1,
    );
    expect(dup.allowed).toBe(false);
    const rows = await auditRows();
    const admits = rows.filter((r) => r.action === 'hard_controls_admit');
    expect(admits.map((r) => r.outcome)).toEqual(['admitted', 'refused']);
    expect((admits[1].detail as { reasonCode: string }).reasonCode).toBe('duplicate_order');
  });

  it('the kill switch and the day-loss lockout write intervention/state rows', async () => {
    engageHardKillSwitch('ops-cli', 'drill', NOW);
    recordHardControlsPnl(-600, NOW + 1);
    const rows = await auditRows();
    const kill = rows.find((r) => r.action === 'hard_kill_switch_engaged');
    expect(kill?.category).toBe('intervention');
    expect(kill?.actor).toBe('ops-cli');
    const lockout = rows.find((r) => r.action === 'daily_loss_lockout_latched');
    expect(lockout?.category).toBe('state_change');
    expect(lockout?.outcome).toBe('halted');
    expect(lockout?.reason).toContain('600.00');
  });
});
