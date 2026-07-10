import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordDirectionalOpen,
  anySleeveOpensFor,
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
// hydrate, ET-day keying/rollover, retention-window compaction.
//
// TRA-1564 — two grade-blocking blindspots the re-grade fire hit:
//   B2 (sleeve conflation): the durable open write lived in the SHARED chokepoint, so
//       `openCountsBySymbol` + the directional cap read conflated all five open
//       sleeves. Records now carry a `sleeve` tag; `directionalOpensFor` is
//       directional-only (the cap + health view) while `anySleeveOpensFor` stays
//       cross-sleeve (the TRA-1408 churn brake).
//   B1 (non-durable rejects): the reject-by-code counters were in-memory since-boot,
//       so the post-close re-grade fire (after the daily reboot) always read `{}`.
//       They are now JSONL-backed + ET-day-keyed and hydrate on boot.

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
    recordDirectionalOpen('rivn', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 1);
    recordDirectionalOpen('spy', ET_DAY, 'directional', NOW + 2);

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
    recordDirectionalOpen('RIVN', '2026-07-08', 'directional', NOW);
    recordDirectionalOpen('RIVN', '2026-07-08', 'directional', NOW + 1);
    recordDirectionalOpen('RIVN', '2026-07-09', 'directional', NOW + 2);
    expect(directionalOpensFor('RIVN', '2026-07-08')).toBe(2);
    expect(directionalOpensFor('RIVN', '2026-07-09')).toBe(1);
  });

  it('updates the in-memory count even with no dataDir (unit-test / CLI path)', () => {
    // no hydrate → dataDir null; the count still updates, only the write is skipped
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(1);
  });
});

describe('sleeve scoping — directional-only vs cross-sleeve (TRA-1564 B2)', () => {
  it('directionalOpensFor counts only `directional` opens; anySleeveOpensFor counts all', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    // NVDA: 1 directional + 2 non-directional (equity-swing / RV / OTM) opens.
    recordDirectionalOpen('NVDA', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('NVDA', ET_DAY, 'other', NOW + 1);
    recordDirectionalOpen('NVDA', ET_DAY, 'other', NOW + 2);

    // The directional cap read sees only the ONE directional open — a `count:3` on a
    // multi-sleeve name is no longer a false cap breach.
    expect(directionalOpensFor('NVDA', ET_DAY)).toBe(1);
    // The cross-sleeve churn brake still sees all three.
    expect(anySleeveOpensFor('NVDA', ET_DAY)).toBe(3);
  });

  it('defaults to `directional` when sleeve is omitted (back-compat with the record call)', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('SPY', ET_DAY);
    expect(directionalOpensFor('SPY', ET_DAY)).toBe(1);
    expect(anySleeveOpensFor('SPY', ET_DAY)).toBe(1);
  });

  it('the health view (summarize) is directional-only', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('QQQ', ET_DAY, 'other', NOW); // equity-swing, not directional
    recordDirectionalOpen('QQQ', ET_DAY, 'other', NOW + 1);
    recordDirectionalOpen('QQQ', ET_DAY, 'directional', NOW + 2);
    const s = summarizeDirectionalGate(ET_DAY);
    expect(s.openCountsBySymbol).toEqual([{ symbol: 'QQQ', count: 1 }]);
    expect(s.opensRecorded).toBe(1); // only the directional open
    expect(s.trackedSymbols).toBe(1);
  });
});

describe('hydrateDirectionalOpensFromDisk — reboot durability (TRA-1486 D2)', () => {
  it('rebuilds same-ET-day counts from disk after a "reboot"', () => {
    // session 1: three RIVN directional opens
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 1);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 2);

    // simulate reboot: in-memory dropped, then hydrate from the same file
    clearDirectionalOpenLedger();
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(0); // memory gone

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 3);
    expect(h.records).toBe(3);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(3); // restored → cap keeps biting
    expect(anySleeveOpensFor('RIVN', ET_DAY)).toBe(3);
  });

  it('rebuilds the sleeve split across a reboot', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('NVDA', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('NVDA', ET_DAY, 'other', NOW + 1);

    clearDirectionalOpenLedger();
    hydrateDirectionalOpensFromDisk(dir, NOW + 2);
    expect(directionalOpensFor('NVDA', ET_DAY)).toBe(1);
    expect(anySleeveOpensFor('NVDA', ET_DAY)).toBe(2);
  });

  it('treats a legacy untagged open line as `other` (never inflates the directional cap)', () => {
    const path = directionalOpenLogPath(dir);
    // A pre-TRA-1564 line: no `kind`, no `sleeve`.
    writeFileSync(path, JSON.stringify({ ts: NOW, etDay: ET_DAY, symbol: 'AMPG' }) + '\n', 'utf8');
    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 1);
    expect(h.records).toBe(1);
    expect(directionalOpensFor('AMPG', ET_DAY)).toBe(0); // NOT counted as directional
    expect(anySleeveOpensFor('AMPG', ET_DAY)).toBe(1);   // still counts cross-sleeve
  });

  it('drops records older than the retention window and COMPACTS the file', () => {
    const path = directionalOpenLogPath(dir);
    const stale = NOW - 10 * 24 * 60 * 60 * 1000; // 10 days ago — outside the window
    writeFileSync(
      path,
      [
        JSON.stringify({ kind: 'open', ts: stale, etDay: '2026-06-28', symbol: 'OLD', sleeve: 'directional' }),
        JSON.stringify({ kind: 'open', ts: NOW, etDay: ET_DAY, symbol: 'RIVN', sleeve: 'directional' }),
        JSON.stringify({ kind: 'open', ts: NOW + 1, etDay: ET_DAY, symbol: 'RIVN', sleeve: 'directional' }),
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
    expect(h.rejects).toBe(0);
    expect(h.days).toBe(0);
    expect(existsSync(directionalOpenLogPath(dir))).toBe(false);
  });

  it('skips a torn/partial trailing line rather than aborting', () => {
    const path = directionalOpenLogPath(dir);
    writeFileSync(
      path,
      JSON.stringify({ kind: 'open', ts: NOW, etDay: ET_DAY, symbol: 'RIVN', sleeve: 'directional' }) + '\n{ "ts": 12',
      'utf8',
    );
    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 1);
    expect(h.records).toBe(1);
    expect(directionalOpensFor('RIVN', ET_DAY)).toBe(1);
  });
});

describe('durable reject telemetry (TRA-1564 B1)', () => {
  it('appends a JSONL line per reject and rebuilds per-ET-day counts across a reboot', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalGateReject('min_price', ET_DAY, NOW);
    recordDirectionalGateReject('min_price', ET_DAY, NOW + 1);
    recordDirectionalGateReject('insufficient_liquidity_samples', ET_DAY, NOW + 2);
    recordDirectionalGateReject('per_name_cap', ET_DAY, NOW + 3);

    // simulate the post-close reboot: memory dropped, then hydrate from the file
    clearDirectionalOpenLedger();
    let s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRejectedTotal).toBe(0); // memory gone

    const h = hydrateDirectionalOpensFromDisk(dir, NOW + 4);
    expect(h.rejects).toBe(4);
    s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRejectedByCode.min_price).toBe(2);
    expect(s.opensRejectedByCode.insufficient_liquidity_samples).toBe(1);
    expect(s.opensRejectedByCode.per_name_cap).toBe(1);
    expect(s.opensRejectedTotal).toBe(4); // survives the daily close reboot
  });

  it('keys rejects by ET day so the graded day is isolated', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalGateReject('min_price', '2026-07-08', NOW);
    recordDirectionalGateReject('min_price', '2026-07-09', NOW + 1);
    expect(summarizeDirectionalGate('2026-07-08').opensRejectedByCode.min_price).toBe(1);
    expect(summarizeDirectionalGate('2026-07-09').opensRejectedByCode.min_price).toBe(1);
    expect(summarizeDirectionalGate('2026-07-08').opensRejectedTotal).toBe(1);
  });

  it('updates the in-memory reject count even with no dataDir', () => {
    recordDirectionalGateReject('min_dollar_volume', ET_DAY, NOW);
    expect(summarizeDirectionalGate(ET_DAY).opensRejectedByCode.min_dollar_volume).toBe(1);
  });
});

describe('summarizeDirectionalGate (TRA-1486 / TRA-1564)', () => {
  it('folds directional-only per-name counts and per-ET-day reject codes', () => {
    hydrateDirectionalOpensFromDisk(dir, NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW);
    recordDirectionalOpen('RIVN', ET_DAY, 'directional', NOW + 1);
    recordDirectionalOpen('SPY', ET_DAY, 'directional', NOW + 2);
    recordDirectionalOpen('SPY', ET_DAY, 'other', NOW + 3); // non-directional — excluded from the view
    recordDirectionalGateReject('min_price', ET_DAY, NOW + 4);
    recordDirectionalGateReject('min_price', ET_DAY, NOW + 5);
    recordDirectionalGateReject('insufficient_liquidity_samples', ET_DAY, NOW + 6);
    recordDirectionalGateReject('per_name_cap', ET_DAY, NOW + 7);

    const s = summarizeDirectionalGate(ET_DAY);
    expect(s.opensRecorded).toBe(3); // directional opens only
    expect(s.trackedSymbols).toBe(2);
    expect(s.openCountsBySymbol[0]).toEqual({ symbol: 'RIVN', count: 2 }); // busiest first
    expect(s.openCountsBySymbol).toContainEqual({ symbol: 'SPY', count: 1 }); // directional only
    expect(s.opensRejectedByCode.min_price).toBe(2);
    expect(s.opensRejectedByCode.insufficient_liquidity_samples).toBe(1);
    expect(s.opensRejectedByCode.per_name_cap).toBe(1);
    expect(s.opensRejectedTotal).toBe(4);
    expect(s.lastRejectAt).toBe(NOW + 7);
  });

  it('reports an empty per-name view for a day with no opens', () => {
    const s = summarizeDirectionalGate('2026-01-01');
    expect(s.openCountsBySymbol).toEqual([]);
    expect(s.trackedSymbols).toBe(0);
    expect(s.opensRejectedTotal).toBe(0);
  });
});
