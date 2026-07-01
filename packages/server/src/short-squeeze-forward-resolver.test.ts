import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { Candle } from '@trading-app/shared';
import {
  computeForwardOutcome,
  resolveShortSqueezeForwardOutcomes,
} from './short-squeeze-forward-resolver.js';

function bar(date: string, close: number, high = close): Candle {
  return {
    symbol: 'GME',
    // Anchor to mid-day UTC; etDateKey maps to the ET calendar date.
    timestamp: Date.parse(`${date}T17:00:00Z`),
    open: close,
    high,
    low: close,
    close,
    volume: 1_000_000,
  };
}

describe('computeForwardOutcome', () => {
  it('computes +1/+3/+5 returns and the 5-session MFE', () => {
    const forward = [
      bar('2026-06-16', 11, 12),
      bar('2026-06-17', 12, 13),
      bar('2026-06-18', 12.5, 14),
      bar('2026-06-19', 13, 15),
      bar('2026-06-22', 14, 16),
    ];
    const o = computeForwardOutcome(10, forward, 123);
    expect(o.entryClose).toBe(10);
    expect(o.resolvedAt).toBe(123);
    expect(o.ret1d).toBeCloseTo(0.1); // 11/10 - 1
    expect(o.ret3d).toBeCloseTo(0.25); // 12.5/10 - 1
    expect(o.ret5d).toBeCloseTo(0.4); // 14/10 - 1
    expect(o.mfe5d).toBeCloseTo(0.6); // max high 16 / 10 - 1
    expect(o.sessionsForward).toBe(5);
  });

  it('resolves partially when fewer than 5 sessions have closed', () => {
    const o = computeForwardOutcome(10, [bar('2026-06-16', 11, 12), bar('2026-06-17', 12, 13)], 1);
    expect(o.ret1d).toBeCloseTo(0.1);
    expect(o.ret3d).toBeNull();
    expect(o.ret5d).toBeNull();
    expect(o.mfe5d).toBeCloseTo(0.3); // max high 13 / 10 - 1
    expect(o.sessionsForward).toBe(2);
  });

  it('caps the MFE window at 5 sessions even when more bars are supplied', () => {
    const forward = [
      bar('2026-06-16', 11, 12),
      bar('2026-06-17', 12, 13),
      bar('2026-06-18', 12, 14),
      bar('2026-06-19', 12, 15),
      bar('2026-06-22', 12, 16),
      bar('2026-06-23', 99, 99), // 6th session must be ignored
    ];
    const o = computeForwardOutcome(10, forward, 1);
    expect(o.sessionsForward).toBe(5);
    expect(o.mfe5d).toBeCloseTo(0.6); // 16/10 - 1, NOT 99
  });
});

describe('resolveShortSqueezeForwardOutcomes', () => {
  let tmpRoot: string;
  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'ss-forward-test-'));
  });
  afterEach(() => {
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  function writePartition(date: string, rows: unknown[]): void {
    const dir = join(tmpRoot, date);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'short-squeeze.json'),
      JSON.stringify({ date, recordedAt: Date.parse(`${date}T20:00:00Z`), universeSource: 't', thresholds: {}, symbols: rows }),
    );
  }

  function okRow(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      symbol: 'GME',
      scanTs: Date.parse('2026-06-15T20:00:00Z'),
      outcome: 'ok',
      rawInputs: { price: 10, rvol: 3, sma50: 9 },
      forward: null,
      score: 80,
      qualifies: true,
      ...over,
    };
  }

  it('appends the forward outcome once post-entry sessions are available', async () => {
    writePartition('2026-06-15', [okRow()]);
    const bars = [
      bar('2026-06-15', 10, 10), // entry session — must be excluded
      bar('2026-06-16', 11, 12),
      bar('2026-06-17', 12, 13),
      bar('2026-06-18', 12, 14),
      bar('2026-06-19', 13, 15),
      bar('2026-06-22', 14, 16),
    ];
    const res = await resolveShortSqueezeForwardOutcomes({
      outDir: tmpRoot,
      fetchDailyBars: async () => bars,
      now: () => 999,
    });
    expect(res.filesUpdated).toBe(1);
    expect(res.rowsResolved).toBe(1);
    expect(res.rowsComplete).toBe(1);

    const file = JSON.parse(readFileSync(join(tmpRoot, '2026-06-15', 'short-squeeze.json'), 'utf-8'));
    const fwd = file.symbols[0].forward;
    expect(fwd.sessionsForward).toBe(5);
    expect(fwd.ret1d).toBeCloseTo(0.1);
    expect(fwd.mfe5d).toBeCloseTo(0.6);
    expect(fwd.entryClose).toBe(10);
  });

  it('is idempotent — a second run with the same bars does not rewrite', async () => {
    writePartition('2026-06-15', [okRow()]);
    const bars = [bar('2026-06-16', 11, 12), bar('2026-06-17', 12, 13), bar('2026-06-18', 12, 14), bar('2026-06-19', 13, 15), bar('2026-06-22', 14, 16)];
    const opts = { outDir: tmpRoot, fetchDailyBars: async () => bars, now: () => 1 };
    await resolveShortSqueezeForwardOutcomes(opts);
    const second = await resolveShortSqueezeForwardOutcomes(opts);
    expect(second.filesUpdated).toBe(0);
    expect(second.rowsResolved).toBe(0);
  });

  it('leaves a row pending when no forward session has closed yet', async () => {
    writePartition('2026-06-15', [okRow()]);
    const res = await resolveShortSqueezeForwardOutcomes({
      outDir: tmpRoot,
      fetchDailyBars: async () => [bar('2026-06-15', 10, 10)], // only the entry session
      now: () => 1,
    });
    expect(res.rowsResolved).toBe(0);
    const file = JSON.parse(readFileSync(join(tmpRoot, '2026-06-15', 'short-squeeze.json'), 'utf-8'));
    expect(file.symbols[0].forward).toBeNull();
  });

  it('skips non-ok rows and rows without an entry price', async () => {
    writePartition('2026-06-15', [
      okRow({ outcome: 'no_data', rawInputs: null }),
      okRow({ symbol: 'AMC', rawInputs: { price: null } }),
    ]);
    const res = await resolveShortSqueezeForwardOutcomes({
      outDir: tmpRoot,
      fetchDailyBars: async () => [bar('2026-06-16', 11, 12)],
      now: () => 1,
    });
    expect(res.rowsResolved).toBe(0);
    expect(res.filesUpdated).toBe(0);
  });
});
