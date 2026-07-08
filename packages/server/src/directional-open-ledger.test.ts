import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordDirectionalOpen,
  directionalOpensFor,
  recordDirectionalGateReject,
  hydrateDirectionalOpensFromDisk,
  summarizeDirectionalGate,
  clearDirectionalOpenLedger,
  directionalOpenLogPath,
} from './directional-open-ledger.js';

// TRA-1486 D2 — the DURABLE per-name/ET-day open ledger that fixes the per-name-cap
// leak (the in-memory counter reset on every bqb1 reboot → the cap restarted at 0
// and never bit). Proves: write-through append, reboot-durable per-day counts via a
// hydrate, ET-day keying/rollover, retention-window compaction, and the reject-code
// telemetry that backs /api/health/directional-quality-gate.

const ET_DAY = '2026-07-08';
const NOW = 1_751_990_000_000; // arbitrary fixed ms epoch (in the 2025-07 range)

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'directional-open-'));
  clearDirectionalOpenLedger();
});
afterEach(() => {
  clearDirectionalOpenLedger();
  rmSync(dir, { recursive: true, force: true });
});

describe('recordDirectionalOpen / directionalOpensFor (TRA-1486 D2)', () => {
  it('counts per name and appends one JSONL line per open under DATA_DIR', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW); // configures dataDir
    recordDirectionalOpen('rivn', ET_DAY, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, NOW + 1);
    recordDirectionalOpen('spy', ET_DAY, NOW + 2);

    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(2); // case-insensitive
    expect(directionalOpensFor('spy', ET_DAY)).toBe(1);
    expect(directionalOpensFor('nvda', ET_DAY)).toBe(0);

    const lines = readFileSync(directionalOpenLogPath(dir), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(3);
  });

  it('keys counts by ET day so a different day is independent', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', '2026-07-08', NOW);
    recordDirectionalOpen('RIVN', '2026-07-08', NOW + 1);
    recordDirectionalOpen('RIVN', '2026-07-09', NOW + 2);
    expect(directionalOpensFor('RIVN', '2026-07-08')).toBe(2);
    expect(directionalOpensFor('RIVN', '2026-07-09')).toBe(1);
  });

  it('updates the in-memory count even with no dataDir (unit-test / CLI path)', () => {
    // no hydrate → dataDir null; the count still updates, only the write is skipped
    recordDirectionalOpen('RIVN', ET_DAY, NOW);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(1);
  });
});

describe('hydrateDirectionalOpensFromDisk — reboot durability (TRA-1486 D2)', () => {
  it('rebuilds same-ET-day counts from disk after a "reboot"', () => {
    // session 1: three RIVN opens
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, NOW + 1);
    recordDirectionalOpen('RIVN', ET_DAY, NOW + 2);

    // simulate reboot: in-memory dropped, then hydrate from the same file
    clearDirectionalOpenLedger();
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(0); // memory gone

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 3);
    expect(h.records).toBe(3);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(3); // restored → cap keeps biting
  });

  it('drops records older than the retention window and COMPACTS the file', () => {
    const path = directionalOpenLogPath(dir);
    const stale = NOW - 10 * 24 * 60 * 60 * 1000; // 10 days ago — outside the window
    writeFileSync(
      path,
      [
        JSON.stringify({ ts: stale, etDay: '2026-06-28', symbol: 'OLD' }),
        JSON.stringify({ ts: NOW, etDay: ET_DAY, symbol: 'RIVN' }),
        JSON.stringify({ ts: NOW + 1, etDay: ET_DAY, symbol: 'RIVN' }),
      ].join('\n') + '\n',
      'utf8',
    );

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 2);
    expect(h.records).toBe(2); // stale line dropped
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(2);
    expect(directionalOpensFor('OLD', '2026-06-28')).toBe(0);

    // file was rewritten to just the retained lines
    const lines = readFileSync(path, 'utf8').split('\n').filter((l) => l.trim() !== '');
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('OLD'))).toBe(false);
  });

  it('is best-effort on a missing file (empty hydration, no throw)', () => {
    const h = hydrateDirectionalOpensFromDisk(dir, NOW);
    expect(h.records).toBe(0);
    expect(h.days).toBe(0);
    expect(existsSync(directionalOpenLogPath(dir))).toBe(false);
  });

  it('skips a torn/partial trailing line rather than aborting', () => {
    const path = directionalOpenLogPath(dir);
    writeFileSync(
      path,
      JSON.stringify({ ts: NOW, etDay: ET_DAY, symbol: 'RIVN' }) + '\n{ "ts": 12',
      'utf8',
    );
    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 1);
    expect(h.records).toBe(1);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(1);
  });
});

describe('summarizeDirectionalGate + reject telemetry (TRA-1486)', () => {
  it('folds per-name counts (current day) and reject codes for the health endpoint', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, NOW + 1);
    recordDirectionalOpen('SPY', ET_DAY, NOW + 2);
    recordDirectionalGateReject('min_price', NOW + 3);
    recordDirectionalGateReject('min_price', NOW + 4);
    recordDirectionalGateReject('insufficient_liquidity_samples', NOW + 5);
    recordDirectionalGateReject('per_name_cap', NOW + 6);

    const s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRecorded).toBe(3);
    expect(s.trackedSymbols).toBe(2);
    expect(s.openCountsBySymbol[0]).toEqual({ symbol: 'RIVN', count: 2 }); // busiest first
    expect(s.opensRejectedByCode.min_price).toBe(2);
    expect(s.opensRejectedByCode.insufficient_liquidity_samples).toBe(1);
    expect(s.opensRejectedByCode.per_name_cap).toBe(1);
    expect(s.opensRejectedTotal).toBe(4);
    expect(s.lastRejectAt).toBe(NOW + 6);
  });

  it('reports an empty per-name view for a day with no opens', () => {
    const s = summarizeDirectionalGate('2026-01-01');
    expect(s.openCountsBySymbol).toEqual([]);
    expect(s.trackedSymbols).toBe(0);
    expect(s.opensRejectedTotal).toBe(0);
  });
});
