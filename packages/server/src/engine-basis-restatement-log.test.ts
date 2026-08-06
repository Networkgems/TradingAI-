/**
 * TRA-3010 — the durable half of the gate-A instrument.
 *
 * The property under test is the one that actually decides whether gate A is
 * gradeable: a restatement witnessed at 14:00Z must still be readable after the
 * box restarts at 15:00Z. bqb1 reboots several times a day and qualifying rows
 * arrive at most ~once a day, so an in-memory-only ledger would usually be empty
 * by the time anyone looked — and an empty ledger reads exactly like "the
 * restatement never fired".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  appendEngineBasisRestatement,
  readEngineBasisRestatements,
  engineBasisRestatementLogPath,
  clearEngineBasisRestatementLogErrors,
  type EngineBasisRestatementRecord,
} from './engine-basis-restatement-log.js';

let dir: string;

function record(over: Partial<EngineBasisRestatementRecord> = {}): EngineBasisRestatementRecord {
  return {
    ts: Date.parse('2026-08-06T14:31:00Z'),
    positionId: 'pos-1',
    optionSymbol: 'AAPL260904P00280000',
    contracts: 4,
    premiumPaidBefore: 0.995,
    premiumPaidAfter: 1.04,
    ratio: 1.04 / 0.995,
    brokerCostBasisUsd: 416,
    tp1PremiumBefore: 1.4925,
    tp1PremiumAfter: 1.56,
    stopLossPremiumBefore: 0.796,
    stopLossPremiumAfter: 0.832,
    trailingStopPremiumBefore: 1.1940000000000002,
    trailingStopPremiumAfter: 1.248,
    trailingActive: false,
    tp1RatioBefore: 1.5,
    tp1RatioAfter: 1.5,
    stopRatioBefore: 0.8,
    stopRatioAfter: 0.8,
    ...over,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra3010-'));
  clearEngineBasisRestatementLogErrors();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-3010 — durable engine-basis restatement log', () => {
  it('survives a process restart: the record is on disk, not in a buffer', () => {
    appendEngineBasisRestatement(dir, record());

    // A fresh read is exactly what a restarted process does — no shared state.
    const read = readEngineBasisRestatements(dir);
    expect(read.logPresent).toBe(true);
    expect(read.records).toHaveLength(1);
    expect(read.records[0]!.premiumPaidBefore).toBeCloseTo(0.995, 6);
    expect(read.records[0]!.premiumPaidAfter).toBeCloseTo(1.04, 6);
  });

  it('appends rather than truncating — a second restatement does not erase the first', () => {
    appendEngineBasisRestatement(dir, record({ positionId: 'pos-1' }));
    appendEngineBasisRestatement(dir, record({ positionId: 'pos-2' }));

    const read = readEngineBasisRestatements(dir);
    expect(read.records.map(r => r.positionId)).toEqual(['pos-1', 'pos-2']);
  });

  it('distinguishes "no log yet" from "log exists and is empty"', () => {
    // Nothing written: the branch may simply never have run.
    const before = readEngineBasisRestatements(dir);
    expect(before.logPresent).toBe(false);
    expect(before.records).toHaveLength(0);

    // An empty file is a different claim — the substrate is there.
    writeFileSync(engineBasisRestatementLogPath(dir), '', 'utf8');
    const after = readEngineBasisRestatements(dir);
    expect(after.logPresent).toBe(true);
    expect(after.records).toHaveLength(0);
  });

  it('is BLIND, not empty, when DATA_DIR is unset', () => {
    const read = readEngineBasisRestatements(undefined);
    expect(read.logPresent).toBe(false);
    expect(read.dataDir).toBeNull();
    expect(read.records).toHaveLength(0);
    // A caller that treats this as "zero restatements" would grade an
    // unconfigured box as a clean run.
  });

  it('counts malformed lines instead of silently dropping them', () => {
    appendEngineBasisRestatement(dir, record());
    const path = engineBasisRestatementLogPath(dir);
    writeFileSync(path, `${readFileSync(path, 'utf8')}{not json\n\n`, 'utf8');

    const read = readEngineBasisRestatements(dir);
    expect(read.records).toHaveLength(1);
    expect(read.malformedLines).toBe(1); // the blank line is not counted
  });

  it('publishes append failures so a write-through gap cannot read as an empty ledger', () => {
    // Nest the target under a path component that is a FILE, so the directory
    // create cannot succeed. The append must be swallowed AND counted.
    const blocker = join(dir, 'blocker');
    writeFileSync(blocker, 'not a directory', 'utf8');
    appendEngineBasisRestatement(join(blocker, 'nested'), record());

    const read = readEngineBasisRestatements(dir);
    expect(read.records).toHaveLength(0);
    expect(read.appendErrors).toBeGreaterThan(0);
    expect(read.lastAppendError).not.toBeNull();
  });

  it('is a no-op when no dir is configured, and does not count that as an error', () => {
    appendEngineBasisRestatement(undefined, record());
    expect(readEngineBasisRestatements(dir).appendErrors).toBe(0);
  });
});
