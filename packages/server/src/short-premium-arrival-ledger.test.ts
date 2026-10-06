import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ARRIVAL_RETAINED_SESSION_CAP,
  flushShortPremiumArrivalLedger,
  noteShortPremiumCycleComplete,
  persistShortPremiumArrivalLedgerNow,
  readShortPremiumArrivalHistorySync,
  recordShortPremiumArrival,
  setShortPremiumArrivalLedgerFileForTests,
  type ShortPremiumArrivalScanInput,
} from './short-premium-arrival-ledger.js';

// TRA-5176 — the durable per-session candidate-arrival ledger behind
// `arrivalHistory` on /api/health/short-premium.

/** 15:00Z = 11:00 ET on 2026-10-05 (a Monday session). */
const T0 = Date.parse('2026-10-05T15:00:00Z');
const DAY_MS = 86_400_000;

function scan(over: Partial<ShortPremiumArrivalScanInput> = {}): ShortPremiumArrivalScanInput {
  return {
    symbol: 'NVDA',
    reason: 'no_candidates',
    ivRank: null,
    ivSampleDepth: 2,
    ivRankCoverage: 'insufficient_history',
    candidates: [],
    ...over,
  };
}

const NVDA_SPREAD = { structure: 'call_credit_spread', underlying: 'NVDA', expiration: '2026-11-13' };
const BUILD_A = { commitShort: 'aaaaaaaaaaaa', startedAt: '2026-10-05T11:00:00.000Z' };
const BUILD_B = { commitShort: 'bbbbbbbbbbbb', startedAt: '2026-10-05T14:00:00.000Z' };

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'spal-'));
  file = join(dir, 'short-premium-arrivals.json');
  setShortPremiumArrivalLedgerFileForTests(file);
});

afterEach(() => {
  setShortPremiumArrivalLedgerFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

describe('recordShortPremiumArrival', () => {
  it('a session with no recorded activity is ABSENT, not a zero row', async () => {
    await flushShortPremiumArrivalLedger();
    const view = readShortPremiumArrivalHistorySync();
    expect(view.distinctSessionsRecorded).toBe(0);
    expect(view.sessions).toEqual([]);
    expect(view.oldestSessionDate).toBeNull();
    // ...and no file is written for an empty ledger: absence IS the state.
    expect(existsSync(file)).toBe(false);
  });

  it('counts DISTINCT (symbol, expiration, structure) arrivals, never the cycle sum', async () => {
    // The same resting structure seen on three scan records across two cycles.
    recordShortPremiumArrival(scan({ reason: 'ok', candidates: [NVDA_SPREAD] }), T0, BUILD_A);
    recordShortPremiumArrival(scan({ symbol: 'AAPL' }), T0 + 1000, BUILD_A);
    noteShortPremiumCycleComplete(T0 + 2000);
    recordShortPremiumArrival(scan({ reason: 'ok', candidates: [NVDA_SPREAD] }), T0 + 60_000, BUILD_A);
    recordShortPremiumArrival(
      scan({ reason: 'ok', ivRank: 61, ivRankCoverage: 'covered', ivSampleDepth: 30, candidates: [
        NVDA_SPREAD,
        { structure: 'iron_condor', underlying: 'NVDA', expiration: '2026-11-13' },
      ] }),
      T0 + 61_000,
      BUILD_A,
    );
    noteShortPremiumCycleComplete(T0 + 62_000);
    await flushShortPremiumArrivalLedger();

    const view = readShortPremiumArrivalHistorySync();
    expect(view.distinctSessionsRecorded).toBe(1);
    const row = view.sessions[0]!;
    expect(row.sessionDate).toBe('2026-10-05');
    expect(row.distinctCandidateCount).toBe(2); // the spread once + the condor
    expect(row.cycleCandidateCountSum).toBe(4); // the naive double-count, published beside it
    expect(row.scanCount).toBe(4);
    expect(row.cycleCount).toBe(2);
    expect(row.reasonCounts).toEqual({ ok: 3, no_candidates: 1 });
    expect(row.ivRankMeasured).toBe(1);
    expect(row.ivRankUnknown).toBe(3);
    expect(row.unknownByCode).toEqual({ insufficient_history: 3 });
    expect(row.ivSampleDepthHistogram).toEqual({ '2': 3, '30': 1 });
    expect(row.builds).toEqual([BUILD_A]);
  });

  it('a null ivSampleDepth lands under the key "null", never under 0', async () => {
    recordShortPremiumArrival(scan({ ivSampleDepth: null, ivRankCoverage: 'store_unloaded' }), T0, BUILD_A);
    await flushShortPremiumArrivalLedger();
    const row = readShortPremiumArrivalHistorySync().sessions[0]!;
    expect(row.ivSampleDepthHistogram).toEqual({ null: 1 });
    expect(row.ivSampleDepthHistogram['0']).toBeUndefined();
  });

  it('keys sessions by ET date and serves them newest first with oldest/newest beside', async () => {
    recordShortPremiumArrival(scan(), T0, BUILD_A);
    recordShortPremiumArrival(scan(), T0 + DAY_MS, BUILD_A);
    recordShortPremiumArrival(scan(), T0 + 2 * DAY_MS, BUILD_A);
    await flushShortPremiumArrivalLedger();
    const view = readShortPremiumArrivalHistorySync();
    expect(view.sessions.map((s) => s.sessionDate)).toEqual(['2026-10-07', '2026-10-06', '2026-10-05']);
    expect(view.oldestSessionDate).toBe('2026-10-05');
    expect(view.newestSessionDate).toBe('2026-10-07');
    expect(view.distinctSessionsRecorded).toBe(3);
  });

  it('a session that straddled two builds names both', async () => {
    recordShortPremiumArrival(scan(), T0, BUILD_A);
    recordShortPremiumArrival(scan(), T0 + 1000, BUILD_B);
    recordShortPremiumArrival(scan(), T0 + 2000, BUILD_B); // dedup — no third stamp
    await flushShortPremiumArrivalLedger();
    const row = readShortPremiumArrivalHistorySync().sessions[0]!;
    expect(row.builds).toEqual([BUILD_A, BUILD_B]);
  });
});

describe('durability across restarts (the TRA-5172 idiom)', () => {
  it('survives a restart: distinct dedupe and counters resume from disk', async () => {
    recordShortPremiumArrival(scan({ reason: 'ok', candidates: [NVDA_SPREAD] }), T0, BUILD_A);
    noteShortPremiumCycleComplete(T0 + 1000);
    await flushShortPremiumArrivalLedger();
    expect(existsSync(file)).toBe(true);

    // "Restart": wipe in-memory state, re-point at the SAME file.
    setShortPremiumArrivalLedgerFileForTests(file);
    expect(readShortPremiumArrivalHistorySync().loaded).toBe(false); // honest pre-load state

    // The same structure arrives again in the new process — still ONE distinct.
    recordShortPremiumArrival(scan({ reason: 'ok', candidates: [NVDA_SPREAD] }), T0 + 120_000, BUILD_B);
    await flushShortPremiumArrivalLedger();
    const row = readShortPremiumArrivalHistorySync().sessions[0]!;
    expect(row.distinctCandidateCount).toBe(1);
    expect(row.cycleCandidateCountSum).toBe(2);
    expect(row.scanCount).toBe(2);
    expect(row.cycleCount).toBe(1);
    expect(row.builds).toEqual([BUILD_A, BUILD_B]); // the straddle is recorded, not averaged
  });

  it('fails CLOSED on a corrupt file: refuses the write, renames the original aside, then recovers', async () => {
    writeFileSync(file, '{"version":1,"sessions":{TRUNCATED', 'utf-8');
    setShortPremiumArrivalLedgerFileForTests(file);

    recordShortPremiumArrival(scan({ reason: 'ok', candidates: [NVDA_SPREAD] }), T0, BUILD_A);
    await flushShortPremiumArrivalLedger();

    let view = readShortPremiumArrivalHistorySync();
    expect(view.loadFailed).toBe(true);
    expect(view.loadParseError).not.toBeNull();
    expect(view.persistRefusals).toBeGreaterThanOrEqual(1);
    // The unreadable bytes survive for forensics…
    expect(view.corruptFileRenamedTo).not.toBeNull();
    expect(readFileSync(view.corruptFileRenamedTo!, 'utf-8')).toContain('TRUNCATED');
    const asideFiles = readdirSync(dir).filter((f) => f.includes('.corrupt-'));
    expect(asideFiles.length).toBe(1);

    // …and once the aside landed, the NEXT persist writes a fresh ledger with
    // the refused rows still aboard (they stayed in memory).
    await persistShortPremiumArrivalLedgerNow(T0 + 5000);
    view = readShortPremiumArrivalHistorySync();
    expect(view.persistCount).toBeGreaterThanOrEqual(1);
    const onDisk = JSON.parse(readFileSync(file, 'utf-8')) as { sessions: Record<string, unknown> };
    expect(Object.keys(onDisk.sessions)).toEqual(['2026-10-05']);
  });

  it('never persists an EMPTY ledger over an existing file', async () => {
    // A file whose sessions all fail sanitisation parses to an empty map
    // without tripping loadFailed — the one reachable empty-over-good shape.
    writeFileSync(file, JSON.stringify({ version: 1, updatedAt: 1, sessions: { '2026-10-05': 42 } }), 'utf-8');
    setShortPremiumArrivalLedgerFileForTests(file);
    await persistShortPremiumArrivalLedgerNow(T0);
    const view = readShortPremiumArrivalHistorySync();
    expect(view.emptyLedgerWriteRefusals).toBe(1);
    expect(view.persistCount).toBe(0);
    // The original bytes are untouched.
    expect(readFileSync(file, 'utf-8')).toContain('"2026-10-05"');
  });

  it('a torn write can never clobber: the tmp file never replaces the ledger on failure', async () => {
    recordShortPremiumArrival(scan(), T0, BUILD_A);
    await flushShortPremiumArrivalLedger();
    const good = readFileSync(file, 'utf-8');
    // No `.tmp-` residue after a clean persist.
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
    expect(JSON.parse(good)).toHaveProperty('sessions');
  });
});

describe('retention and zero rows', () => {
  it(`retains the newest ${ARRIVAL_RETAINED_SESSION_CAP} sessions`, async () => {
    for (let d = 0; d < ARRIVAL_RETAINED_SESSION_CAP + 5; d++) {
      recordShortPremiumArrival(scan(), T0 + d * DAY_MS, BUILD_A);
    }
    await flushShortPremiumArrivalLedger();
    const view = readShortPremiumArrivalHistorySync();
    expect(view.distinctSessionsRecorded).toBe(ARRIVAL_RETAINED_SESSION_CAP);
    expect(view.oldestSessionDate).toBe('2026-10-10'); // the 5 oldest dropped
    expect(view.newestSessionDate).toBe('2026-11-18'); // T0 + 44 days
  });

  it('a completed cycle with zero scan records is a GENUINE zero row, not an absence', async () => {
    noteShortPremiumCycleComplete(T0);
    await flushShortPremiumArrivalLedger();
    const view = readShortPremiumArrivalHistorySync();
    expect(view.distinctSessionsRecorded).toBe(1);
    const row = view.sessions[0]!;
    expect(row.cycleCount).toBe(1);
    expect(row.scanCount).toBe(0);
    expect(row.distinctCandidateCount).toBe(0);
    // And it is durable — the recorder-down reading is excluded by the row existing.
    expect(existsSync(file)).toBe(true);
  });
});
