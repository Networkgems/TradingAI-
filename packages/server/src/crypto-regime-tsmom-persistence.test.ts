import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  recordRegimeTsmomScan,
  summarizeRegimeTsmomScans,
  clearRegimeTsmomScans,
  persistRegimeTsmomPass,
  hydrateRegimeTsmomFromDisk,
  regimeTsmomRoundTripsPath,
  regimeTsmomStatePath,
  REGIME_TSMOM_ROUNDTRIPS_FILENAME,
  type RegimeTsmomResult,
  type RegimeTsmomRoundTrip,
  type RegimeTsmomState,
} from './crypto-regime-tsmom-scanner.js';

// TRA-1264 — the in-memory round-trip accrual is wiped by any restart/redeploy,
// which resets `n` to 0 before the multi-week n≥20 gate can land. These tests
// prove the JSONL + snapshot persistence survives a restart: prior round trips
// reload (n preserved), the turnover anchor/total carry, and an in-flight would-be
// position + last-bar dedupe map are restored. Observe-only: no order path here.

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'regime-tsmom-persist-'));
  clearRegimeTsmomScans();
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearRegimeTsmomScans();
});

function roundTrip(over: Partial<RegimeTsmomRoundTrip> = {}): RegimeTsmomRoundTrip {
  return {
    side: 'long',
    entryPrice: 100,
    exitPrice: 110,
    entryBarTime: '2026-07-01T00:00:00.000Z',
    exitBarTime: '2026-07-02T00:00:00.000Z',
    entryRegime: 'trend_up',
    grossMovePct: 10,
    netMovePct: 8.74,
    netR: 0.5,
    ...over,
  };
}

function result(
  symbol: string,
  over: Partial<RegimeTsmomResult> = {},
): RegimeTsmomResult {
  const flat: RegimeTsmomState = { position: 'flat', entryPrice: null, entryBarTime: null, entryRegime: null };
  return {
    symbol,
    action: 'exit_long',
    regime: 'trend_up',
    confidence: 0.8,
    rL: 0.12,
    entryBandPct: 10,
    exitBandPct: 10,
    wouldBeEntryPrice: null,
    lastBarTime: '2026-07-02T00:00:00.000Z',
    roundTrip: null,
    state: flat,
    ...over,
  };
}

describe('regime-tsmom persistence (TRA-1264)', () => {
  it('reloads prior round trips across a restart — n is preserved', () => {
    const now = 1_720_000_000_000;
    // Record 3 completed would-be round trips, as a live pass would.
    const results = [
      result('AAA-USD', { roundTrip: roundTrip({ netR: 0.5 }) }),
      result('BBB-USD', { roundTrip: roundTrip({ netR: -0.3 }) }),
      result('CCC-USD', { roundTrip: roundTrip({ netR: 0.9 }) }),
    ];
    recordRegimeTsmomScan(results, now);
    expect(summarizeRegimeTsmomScans(now).n).toBe(3);

    const wrote = persistRegimeTsmomPass(dir, results, new Map(), new Map(), now);
    expect(wrote).toBe(3);
    expect(existsSync(regimeTsmomRoundTripsPath(dir))).toBe(true);
    expect(regimeTsmomRoundTripsPath(dir).endsWith(REGIME_TSMOM_ROUNDTRIPS_FILENAME)).toBe(true);

    // Simulate a restart: the in-memory store is wiped.
    clearRegimeTsmomScans();
    expect(summarizeRegimeTsmomScans(now).n).toBe(0);

    // Boot hydration re-loads the accrual from disk.
    const h = hydrateRegimeTsmomFromDisk(dir);
    expect(h.roundTripsLoaded).toBe(3);
    expect(h.totalRoundTrips).toBe(3);
    expect(h.firstRecordedAt).toBe(now);

    const summary = summarizeRegimeTsmomScans(now);
    expect(summary.n).toBe(3);
    // Mean net-of-taker R over the reloaded trips: (0.5 − 0.3 + 0.9) / 3.
    expect(summary.rollingNetExpectancyR).toBeCloseTo((0.5 - 0.3 + 0.9) / 3, 4);
  });

  it('accumulates n across a restart boundary (append-only, not truncating)', () => {
    const t0 = 1_720_000_000_000;
    const first = [result('AAA-USD', { roundTrip: roundTrip() }), result('BBB-USD', { roundTrip: roundTrip() })];
    recordRegimeTsmomScan(first, t0);
    persistRegimeTsmomPass(dir, first, new Map(), new Map(), t0);

    // Restart, hydrate, then record + persist a further pass.
    clearRegimeTsmomScans();
    hydrateRegimeTsmomFromDisk(dir);
    const t1 = t0 + 4 * 60 * 60 * 1000;
    const second = [result('CCC-USD', { roundTrip: roundTrip() })];
    recordRegimeTsmomScan(second, t1);
    persistRegimeTsmomPass(dir, second, new Map(), new Map(), t1);

    // A second restart must see all 3 trips (the anchor stays at the first record).
    clearRegimeTsmomScans();
    const h = hydrateRegimeTsmomFromDisk(dir);
    expect(h.totalRoundTrips).toBe(3);
    expect(h.firstRecordedAt).toBe(t0);
    expect(summarizeRegimeTsmomScans(t1).n).toBe(3);
  });

  it('restores an in-flight would-be position and the last-bar dedupe map', () => {
    const now = 1_720_000_000_000;
    const longState: RegimeTsmomState = {
      position: 'long',
      entryPrice: 42,
      entryBarTime: '2026-07-02T00:00:00.000Z',
      entryRegime: 'trend_up',
    };
    const stateBySymbol = new Map<string, RegimeTsmomState>([['BBB-USD', longState]]);
    const lastBarBySymbol = new Map<string, string>([
      ['AAA-USD', '2026-07-02T00:00:00.000Z'],
      ['BBB-USD', '2026-07-02T00:00:00.000Z'],
    ]);
    // A pass that closed no round trip still snapshots the carried state.
    persistRegimeTsmomPass(dir, [result('BBB-USD', { action: 'hold_long', roundTrip: null })], stateBySymbol, lastBarBySymbol, now);

    const h = hydrateRegimeTsmomFromDisk(dir);
    expect(h.stateBySymbol.get('BBB-USD')).toEqual(longState);
    expect(h.lastBarBySymbol.get('AAA-USD')).toBe('2026-07-02T00:00:00.000Z');
    expect(h.lastBarBySymbol.get('BBB-USD')).toBe('2026-07-02T00:00:00.000Z');
    // No trips were closed, so the snapshot's total/anchor reflect an empty accrual.
    expect(h.totalRoundTrips).toBe(0);
    expect(summarizeRegimeTsmomScans(now).n).toBe(0);
  });

  it('writes the state snapshot even on a pass with no round trip', () => {
    persistRegimeTsmomPass(dir, [result('AAA-USD', { action: 'flat', roundTrip: null })], new Map(), new Map(), 1);
    expect(existsSync(regimeTsmomStatePath(dir))).toBe(true);
    // No trips ⇒ no JSONL file written.
    expect(existsSync(regimeTsmomRoundTripsPath(dir))).toBe(false);
    const snap = JSON.parse(readFileSync(regimeTsmomStatePath(dir), 'utf8'));
    expect(snap.version).toBe(1);
    expect(snap.totalRoundTrips).toBe(0);
  });

  it('yields an empty hydration when no files exist (fresh boot)', () => {
    const h = hydrateRegimeTsmomFromDisk(dir);
    expect(h.roundTripsLoaded).toBe(0);
    expect(h.totalRoundTrips).toBe(0);
    expect(h.firstRecordedAt).toBeNull();
    expect(h.stateBySymbol.size).toBe(0);
    expect(h.lastBarBySymbol.size).toBe(0);
    expect(summarizeRegimeTsmomScans(1).n).toBe(0);
  });
});
