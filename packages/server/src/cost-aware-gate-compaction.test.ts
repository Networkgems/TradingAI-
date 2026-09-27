// TRA-4904 — the PERIODIC compaction of `cost-aware-gate.jsonl`.
//
// Until this ticket the boot hydrate was the ONLY compaction, so the file carried up to
// one boot interval of rows already past the 7-day cutoff: +70.4% at the observed
// 4.93-day max boot gap, 119.1 MiB worst case against a ~73 MiB steady state. This tape
// is the box's only exposed one because it pairs the highest write rate in `/data`
// (9.98 MiB/day) with the shortest retention (7d; every sibling holds 30d).
//
// These cover the timer path, its publication on `/api/health/cost-aware-gate`, and the
// two properties that make it safe to run mid-session on a money box: it never drops a
// row inside the window, and it never loses a live append to its own rewrite.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  clearCostAwareGateLedger,
  compactCostAwareGateLedgerNow,
  costAwareGateCompaction,
  costAwareGateLogPath,
  hydrateCostAwareGateFromDisk,
  noteCostAwareGateCompactionTimerArmed,
  recordCostAwareGateDecision,
  summarizeCostAwareGate,
  COST_AWARE_GATE_COMPACTION_INTERVAL_MS,
  COST_AWARE_GATE_RETENTION_DAYS,
} from './cost-aware-gate-ledger.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-25T18:00:00.000Z');
const DAY = '2026-09-20';

function line(ts: number, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    ts,
    etDay: DAY,
    structure: 'single_leg_rv',
    admit: true,
    grossR: 1,
    barR: 0.5,
    gate: 'cost_bar',
    ...extra,
  });
}

describe('cost-aware-gate periodic compaction (TRA-4904)', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cost-gate-compact-'));
    clearCostAwareGateLedger();
  });

  afterEach(() => {
    clearCostAwareGateLedger();
    rmSync(dir, { recursive: true, force: true });
  });

  it('caps the overshoot premium under the 30-day tapes 16.4%', () => {
    // AC1's bar, asserted rather than asserted-in-prose: premium = interval / retain.
    const premium = COST_AWARE_GATE_COMPACTION_INTERVAL_MS / (COST_AWARE_GATE_RETENTION_DAYS * DAY_MS);
    expect(premium).toBeLessThan(0.164);
    expect(premium).toBeCloseTo(0.0357, 4);
  });

  it('drops rows past the cutoff on the timer and publishes the outcome', async () => {
    const aged = [line(NOW - 30 * DAY_MS), line(NOW - 9 * DAY_MS)];
    const young = [line(NOW - 2 * DAY_MS), line(NOW - 60_000)];
    writeFileSync(costAwareGateLogPath(dir), [...aged, ...young].join('\n') + '\n', 'utf8');
    // Hydrate at an instant where EVERY line is inside the window, so the drop below is
    // attributable to the timer and to nothing else.
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);
    expect(costAwareGateCompaction().last).toMatchObject({ trigger: 'boot', rewrote: false });

    const out = await compactCostAwareGateLedgerNow(NOW);
    expect(out).toMatchObject({
      trigger: 'timer',
      rewrote: true,
      rewriteBasis: 'verbatim-suffix',
      linesBefore: 4,
      linesAfter: 2,
      linesDropped: 2,
      retentionDays: 7,
      bufferedAppendsFlushed: 0,
    });
    expect(out.error).toBeUndefined();
    expect(out.skipped).toBeUndefined();
    expect(out.bytesAfter).toBeLessThan(out.bytesBefore);
    expect(out.cutoff).toBe(new Date(NOW - 7 * DAY_MS).toISOString());

    expect(readFileSync(costAwareGateLogPath(dir), 'utf8').trim().split('\n')).toEqual(young);
  });

  it('publishes the hook on the health summary, where timerCompactions is the liveness field', async () => {
    writeFileSync(costAwareGateLogPath(dir), line(NOW - 30 * DAY_MS) + '\n' + line(NOW) + '\n', 'utf8');
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);

    // A build where the interval was never armed publishes exactly this: a perfectly
    // ordinary boot outcome and zero timer fires. That is the state TRA-4904 found, and
    // no other field on the payload separates it from a working hook.
    const before = summarizeCostAwareGate(DAY).compaction;
    expect(before.timerCompactions).toBe(0);
    expect(before.last?.trigger).toBe('boot');
    expect(before.intervalMs).toBe(6 * 60 * 60 * 1000);
    expect(before.retentionDays).toBe(7);

    await compactCostAwareGateLedgerNow(NOW);
    const after = summarizeCostAwareGate(DAY).compaction;
    expect(after.timerCompactions).toBe(1);
    expect(after.last).toMatchObject({ trigger: 'timer', rewrote: true, linesDropped: 1 });
  });

  it('does NOT lose a live append that lands during the rewrite', async () => {
    writeFileSync(
      costAwareGateLogPath(dir),
      line(NOW - 30 * DAY_MS) + '\n' + line(NOW - 60_000) + '\n',
      'utf8',
    );
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);

    // Started, NOT awaited: the interlock is raised synchronously, so this append is
    // buffered rather than written into a file the rewrite is about to replace.
    const pending = compactCostAwareGateLedgerNow(NOW);
    recordCostAwareGateDecision('single_leg_otm', false, 0.1, 0.4, '2026-09-25', NOW);
    const out = await pending;

    expect(out.bufferedAppendsFlushed).toBe(1);
    expect(out.rewrote).toBe(true);
    const onDisk = readFileSync(costAwareGateLogPath(dir), 'utf8').trim().split('\n');
    expect(onDisk).toHaveLength(2); // the young row + the buffered one; the aged row is gone
    expect(onDisk[1]).toContain('"structure":"single_leg_otm"');
    // Nothing was swallowed on the way through the flush.
    expect(summarizeCostAwareGate('2026-09-25').durability.appendErrors).toBe(0);
  });

  it('echoes retained bytes VERBATIM, so a field the rewrite does not know survives', async () => {
    const future = line(NOW - 60_000, { someFutureField: 'keep-me' });
    writeFileSync(costAwareGateLogPath(dir), line(NOW - 30 * DAY_MS) + '\n' + future + '\n', 'utf8');
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);

    await compactCostAwareGateLedgerNow(NOW);
    // The boot path re-serializes through a field whitelist and would have ERASED this —
    // TRA-1703 and TRA-2355 both paid for that. The timer path copies the bytes.
    expect(readFileSync(costAwareGateLogPath(dir), 'utf8')).toContain('"someFutureField":"keep-me"');
  });

  it('never rewrites when nothing aged out', async () => {
    const raw = line(NOW - 2 * DAY_MS) + '\n' + line(NOW - 60_000) + '\n';
    writeFileSync(costAwareGateLogPath(dir), raw, 'utf8');
    hydrateCostAwareGateFromDisk(dir, NOW);

    const out = await compactCostAwareGateLedgerNow(NOW);
    expect(out).toMatchObject({ rewrote: false, linesBefore: 2, linesAfter: 2, linesDropped: 0 });
    expect(out.bytesAfter).toBe(out.bytesBefore);
    expect(readFileSync(costAwareGateLogPath(dir), 'utf8')).toBe(raw);
  });

  it('keeps an out-of-order aged row rather than risk dropping a young one', async () => {
    // Append order is decision order in every real file. If it ever is not, the scan
    // stops at the first retained line and the straggler waits for the next boot: the
    // failure direction that matters is never deleting evidence still inside the window.
    const young = line(NOW - 60_000);
    const straggler = line(NOW - 30 * DAY_MS);
    writeFileSync(costAwareGateLogPath(dir), young + '\n' + straggler + '\n', 'utf8');
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);

    const out = await compactCostAwareGateLedgerNow(NOW);
    expect(out.rewrote).toBe(false);
    expect(readFileSync(costAwareGateLogPath(dir), 'utf8')).toContain(straggler);
  });

  it('stops on a line whose ts it cannot read, and says so', async () => {
    // Written AFTER the hydrate on purpose: the boot path parses every line and would
    // have dropped this one, so the only way the timer meets a torn line is one that
    // arrived during the uptime.
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);
    writeFileSync(
      costAwareGateLogPath(dir),
      'not json at all\n' + line(NOW - 30 * DAY_MS) + '\n' + line(NOW - 60_000) + '\n',
      'utf8',
    );

    const out = await compactCostAwareGateLedgerNow(NOW);
    expect(out.stoppedOnUnreadableTs).toBe(true);
    // It stopped at the torn line, so the aged row BEHIND it is kept too. Nothing is
    // dropped, nothing is corrupted, and the next boot hydrate clears the torn line.
    expect(out.rewrote).toBe(false);
    expect(readFileSync(costAwareGateLogPath(dir), 'utf8')).toContain(line(NOW - 30 * DAY_MS));
  });

  it('separates an unarmed hook from one that is merely not due yet', async () => {
    writeFileSync(costAwareGateLogPath(dir), line(NOW - 30 * DAY_MS) + '\n' + line(NOW) + '\n', 'utf8');
    hydrateCostAwareGateFromDisk(dir, NOW - 30 * DAY_MS + 1000);

    // Nothing armed anything: the pre-TRA-4904 state. Every other field on this object
    // reads perfectly healthy, which is why this one has to exist.
    expect(costAwareGateCompaction(NOW).hookState).toBe('timer_not_armed');
    expect(costAwareGateCompaction(NOW).nextFireDueAt).toBeNull();

    noteCostAwareGateCompactionTimerArmed(NOW);
    // 0 fires INSIDE the first interval is the ordinary healthy reading on bqb1, whose
    // uptime is usually shorter than 6h. It must not read as a dead hook…
    expect(costAwareGateCompaction(NOW + 60_000).hookState).toBe('armed_not_yet_due');
    expect(costAwareGateCompaction(NOW).timerCompactions).toBe(0);
    // …and it must not read as a working one either, once the fire is actually late.
    expect(costAwareGateCompaction(NOW + 7 * 60 * 60 * 1000).hookState).toBe('overdue');

    await compactCostAwareGateLedgerNow(NOW + 6 * 60 * 60 * 1000);
    const s = costAwareGateCompaction(NOW + 6 * 60 * 60 * 1000);
    expect(s.hookState).toBe('firing');
    expect(s.timerCompactions).toBe(1);
    expect(s.nextFireDueAt).toBe(new Date(NOW + 12 * 60 * 60 * 1000).toISOString());
  });

  it('names a skip instead of reporting a clean pass', async () => {
    clearCostAwareGateLedger(); // no dataDir ⇒ nothing is durable, nothing to compact
    const out = await compactCostAwareGateLedgerNow(NOW);
    expect(out.skipped).toBe('no_data_dir');
    expect(out.rewrote).toBe(false);

    hydrateCostAwareGateFromDisk(dir, NOW);
    const missing = await compactCostAwareGateLedgerNow(NOW);
    expect(missing.skipped).toBe('no_file');
  });
});
