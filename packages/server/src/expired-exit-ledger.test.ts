import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearExpiredExitLedger,
  expiredExitLedgerPath,
  hydrateExpiredExitLedgerFromDisk,
  readExpiredExitLedger,
  recordExpiredExit,
  summarizeExpiredExitCounts,
} from './expired-exit-ledger.js';

const ev = (over: Record<string, unknown> = {}) => ({
  ts: 1_000, mode: 'live' as const, tradierEnv: 'production', optionId: 'o1',
  optionSymbol: 'TSLA260911C00555000', kind: 'sl', qty: 4, limitPrice: 1.25, pricing: 'limit',
  orderId: '123', consecutiveExpiries: 1, nextAttempt: 'market_escalation' as const, ...over,
});

describe('expired-exit ledger (TRA-5269)', () => {
  let dir: string;
  const saved = process.env.DATA_DIR;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'eel-')); process.env.DATA_DIR = dir; });
  afterEach(() => {
    clearExpiredExitLedger();
    rmSync(dir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.DATA_DIR; else process.env.DATA_DIR = saved;
  });

  it('a record written before a restart is readable after one (in-band durability)', () => {
    hydrateExpiredExitLedgerFromDisk(dir, 500);
    expect(readExpiredExitLedger().durability.state).toBe('unproven'); // first boot: no prior marker
    recordExpiredExit(ev());
    // "restart": a fresh process state re-reads the same file
    const h = hydrateExpiredExitLedgerFromDisk(dir, 2_000);
    expect(h).toEqual({ events: 1, bootMarkers: 1 });
    const v = readExpiredExitLedger();
    expect(v.durability.state).toBe('durable');
    expect(v.events[0]).toMatchObject({ optionSymbol: 'TSLA260911C00555000', orderId: '123', qty: 4 });
    expect(v.counts).toMatchObject({ total: 1, live: 1, escalatedNext: 1 });
  });

  it('a broken store does not read like an empty healthy one', () => {
    // no hydrate ⇒ no DATA_DIR resolved
    expect(readExpiredExitLedger().durability.state).toBe('unwritable');
    clearExpiredExitLedger();
    // unwritable path (a file where the directory should be)
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'x');
    hydrateExpiredExitLedgerFromDisk(join(blocker, 'sub'), 1);
    const d = readExpiredExitLedger().durability;
    expect(d.state).toBe('unwritable');
    expect(d.appendErrors).toBeGreaterThan(0);
    expect(summarizeExpiredExitCounts().state).toBe('unwritable');
  });

  it('the record is independent of any position row and never deleted', () => {
    hydrateExpiredExitLedgerFromDisk(dir, 1);
    recordExpiredExit(ev({ consecutiveExpiries: 3, nextAttempt: 'staging_stopped' }));
    const lines = readFileSync(expiredExitLedgerPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2); // boot marker + event
    expect(summarizeExpiredExitCounts().stagingStopped).toBe(1);
  });

  it('skips a torn trailing line', () => {
    hydrateExpiredExitLedgerFromDisk(dir, 1);
    recordExpiredExit(ev());
    writeFileSync(expiredExitLedgerPath(dir), readFileSync(expiredExitLedgerPath(dir), 'utf8') + '{"type":"expired_ex');
    expect(hydrateExpiredExitLedgerFromDisk(dir, 2).events).toBe(1);
  });
});
