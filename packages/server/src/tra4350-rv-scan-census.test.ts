/**
 * TRA-4350 — the durable per-ET-day scan census.
 *
 * The bar these tests hold the module to is the one the ticket set: a zero must
 * not be able to wear the same shape in "ran and declined", "never ran" and
 * "passed but never journalled". Two of those are counts; the third is the
 * ABSENCE of a cell, and the negative controls below are the ones that matter —
 * an instrument that renders every state identically passes a happy-path suite
 * perfectly.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import {
  recordRvScanCensus,
  hydrateRvScanCensusFromDisk,
  summarizeRvScanCensus,
  clearRvScanCensusLedger,
  classifyRvScanDayState,
  rvScanCensusLogPath,
  __setRvScanCensusBootId,
  GATE_OVERFLOW,
  CENSUS_RETAIN_MS,
  type RvScanCensusOwner,
} from './rv-scan-census-ledger.js';
import type { RvScanRecord } from './rv-scan-telemetry.js';

let dir: string;

const DESK: RvScanCensusOwner = {
  etDay: '2026-09-02',
  account: 'admin',
  accountClass: 'desk',
  mode: 'demo',
};

/**
 * A finished pass. Defaults describe the TRA-4350 state: evaluated, none passed.
 *
 * TRA-4357 AC3 — `reconciliation` is DERIVED from the finished fields rather than
 * hard-coded, so an override of `universeSize`/`candidatesEvaluated` cannot leave
 * this fixture asserting a reconciliation that contradicts its own counters. An
 * explicit `reconciliation` in `over` still wins, for the cases that pin a
 * deliberately inconsistent record.
 */
function pass(over: Partial<RvScanRecord> = {}): RvScanRecord {
  const base = {
    atMs: 1_788_000_000_000,
    universeSize: 152,
    candidatesEvaluated: 152,
    candidatesPassed: 0,
    opensPlaced: 0,
    rejectionsByGate: { no_candidates: 68, contract_floor_delta: 84 },
    bucketsBalance: true,
    stoppedEarlyReason: null,
    sweep: null,
    ...over,
  };
  const tagged = Object.values(base.rejectionsByGate).reduce((a, b) => a + b, 0);
  const notWalked = Math.max(0, base.universeSize - base.candidatesEvaluated);
  return {
    ...base,
    reconciliation: over.reconciliation ?? {
      denominator: base.candidatesEvaluated,
      accountedFor: tagged + base.candidatesPassed,
      balances: tagged === base.candidatesEvaluated - base.candidatesPassed,
      universeNotWalked: notWalked,
      notWalkedReason: notWalked > 0 ? base.stoppedEarlyReason : null,
    },
  };
}

function cell(etDay: string, path: string, accountClass: string) {
  const day = summarizeRvScanCensus().find((d) => d.etDay === etDay);
  return day?.cells.find((c) => c.path === path && c.accountClass === accountClass);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra4350-'));
  __setRvScanCensusBootId('boot-1');
  hydrateRvScanCensusFromDisk(dir);
});

afterEach(() => {
  clearRvScanCensusLedger();
  rmSync(dir, { recursive: true, force: true });
});

describe('TRA-4350 — the three states are distinguishable', () => {
  it('ran-and-declined names the gate that consumed the candidates', () => {
    recordRvScanCensus(DESK, 'otm', pass());
    const c = cell('2026-09-02', 'otm', 'desk');
    expect(c?.state).toBe('ran_and_declined');
    expect(c?.candidatesEvaluated).toBe(152);
    expect(c?.rejectionsByGate).toEqual({ contract_floor_delta: 84, no_candidates: 68 });
  });

  it('passed-but-no-open is NOT pooled with a drought', () => {
    // The engine cleared candidates and not one became a journal row. This is
    // the state QuantTrader could not separate; if it renders as
    // `ran_and_declined` the instrument has failed its whole purpose.
    recordRvScanCensus(DESK, 'otm', pass({ candidatesPassed: 3, opensPlaced: 0 }));
    expect(cell('2026-09-02', 'otm', 'desk')?.state).toBe('passed_but_no_open');
  });

  it('ran-and-opened outranks both', () => {
    recordRvScanCensus(DESK, 'otm', pass({ candidatesPassed: 3, opensPlaced: 2 }));
    expect(cell('2026-09-02', 'otm', 'desk')?.state).toBe('ran_and_opened');
  });

  it('a loop that turned over an empty universe is its own state', () => {
    recordRvScanCensus(
      DESK,
      'otm',
      pass({ universeSize: 0, candidatesEvaluated: 0, rejectionsByGate: {} }),
    );
    expect(cell('2026-09-02', 'otm', 'desk')?.state).toBe('ran_unfed');
  });

  it('NEGATIVE CONTROL — a path that never ran has NO cell, not a zero row', () => {
    recordRvScanCensus(DESK, 'otm', pass());
    // `directional` never completed a pass. An instrument that emitted a zeroed
    // `directional` row here would be asserting a measurement it never took —
    // the exact defect this ticket is about, one level down.
    expect(cell('2026-09-02', 'directional', 'desk')).toBeUndefined();
    // ...and a day nothing ran on is absent entirely.
    expect(summarizeRvScanCensus().find((d) => d.etDay === '2026-09-01')).toBeUndefined();
  });

  it('classifyRvScanDayState ranks opens over passes over evaluations', () => {
    expect(
      classifyRvScanDayState({ candidatesEvaluated: 9, candidatesPassed: 9, opensPlaced: 1 }),
    ).toBe('ran_and_opened');
    expect(
      classifyRvScanDayState({ candidatesEvaluated: 9, candidatesPassed: 9, opensPlaced: 0 }),
    ).toBe('passed_but_no_open');
    expect(
      classifyRvScanDayState({ candidatesEvaluated: 9, candidatesPassed: 0, opensPlaced: 0 }),
    ).toBe('ran_and_declined');
    expect(
      classifyRvScanDayState({ candidatesEvaluated: 0, candidatesPassed: 0, opensPlaced: 0 }),
    ).toBe('ran_unfed');
  });
});

describe('TRA-4350 — it survives the reboot that wipes the since-boot counters', () => {
  it('a same-ET-day restart ADDS to the day instead of resetting it', () => {
    // Spaced past the flush throttle so BOTH passes are on disk when the box
    // dies — the throttle's lossy tail is its own test below.
    const t0 = 1_788_000_000_000;
    recordRvScanCensus(DESK, 'otm', pass(), t0);
    recordRvScanCensus(DESK, 'otm', pass(), t0 + 6 * 60_000);
    expect(cell('2026-09-02', 'otm', 'desk')?.scans).toBe(2);

    // Second boot: new pid ⇒ new bootId ⇒ a distinct key that the reader SUMS.
    __setRvScanCensusBootId('boot-2');
    hydrateRvScanCensusFromDisk(dir, t0 + 7 * 60_000);
    expect(cell('2026-09-02', 'otm', 'desk')?.scans).toBe(2); // recovered from disk
    recordRvScanCensus(DESK, 'otm', pass(), t0 + 8 * 60_000);

    const c = cell('2026-09-02', 'otm', 'desk');
    expect(c?.scans).toBe(3);
    expect(c?.boots).toBe(2);
    expect(c?.candidatesEvaluated).toBe(456);
    expect(c?.rejectionsByGate.no_candidates).toBe(204);
  });

  it('the counts are LOWER BOUNDS — an unflushed tail is lost, and that is documented', () => {
    // Second pass lands inside the throttle window, so it is still in memory when
    // the process dies. The route says `scans` is a lower bound for exactly this
    // reason; pinning it here stops someone "fixing" it into a false exactness.
    const t0 = 1_788_000_000_000;
    recordRvScanCensus(DESK, 'otm', pass(), t0);
    recordRvScanCensus(DESK, 'otm', pass(), t0 + 1_000);
    __setRvScanCensusBootId('boot-2');
    hydrateRvScanCensusFromDisk(dir, t0 + 2_000);

    const c = cell('2026-09-02', 'otm', 'desk');
    expect(c?.scans).toBe(1);
    // The STATE survives the truncation, which is the property that matters:
    // an under-counted decline is still a decline.
    expect(c?.state).toBe('ran_and_declined');
  });

  it('a re-flush within one boot SUPERSEDES rather than double-counting', () => {
    const t0 = 1_788_000_000_000;
    // First sight writes; the next two are inside the 5-minute throttle, so only
    // the 6-minute one appends again — carrying the cumulative count, not a delta.
    recordRvScanCensus(DESK, 'otm', pass(), t0);
    recordRvScanCensus(DESK, 'otm', pass(), t0 + 60_000);
    recordRvScanCensus(DESK, 'otm', pass(), t0 + 6 * 60_000);
    const lines = readFileSync(rvScanCensusLogPath(dir), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    __setRvScanCensusBootId('boot-2');
    hydrateRvScanCensusFromDisk(dir, t0 + 7 * 60_000);
    // 1 + 3 naively; 3 if the supersede fold is right.
    expect(cell('2026-09-02', 'otm', 'desk')?.scans).toBe(3);
    // ...and compaction reclaimed the superseded line.
    expect(readFileSync(rvScanCensusLogPath(dir), 'utf8').trim().split('\n')).toHaveLength(1);
  });

  it('an OPEN is flushed on sight even inside the throttle window', () => {
    // The expensive direction of this instrument's error is a session that TRADED
    // reading back as a drought, so `opensPlaced` must never sit in an unflushed
    // tail when the watchdog kills the box mid-scan.
    const t0 = 1_788_000_000_000;
    recordRvScanCensus(DESK, 'otm', pass(), t0);
    recordRvScanCensus(DESK, 'otm', pass({ candidatesPassed: 1, opensPlaced: 1 }), t0 + 1_000);

    __setRvScanCensusBootId('boot-2');
    hydrateRvScanCensusFromDisk(dir, t0 + 2_000);
    expect(cell('2026-09-02', 'otm', 'desk')?.state).toBe('ran_and_opened');
  });

  it('books are attributed by class — a fixture cell says nothing about the desk', () => {
    recordRvScanCensus(DESK, 'otm', pass({ candidatesPassed: 2, opensPlaced: 2 }));
    recordRvScanCensus(
      { ...DESK, account: 'qa_1', accountClass: 'fixture' },
      'otm',
      pass(),
    );
    recordRvScanCensus(
      { ...DESK, account: 'qa_2', accountClass: 'fixture' },
      'otm',
      pass(),
    );
    expect(cell('2026-09-02', 'otm', 'desk')?.state).toBe('ran_and_opened');
    const fixture = cell('2026-09-02', 'otm', 'fixture');
    expect(fixture?.state).toBe('ran_and_declined');
    expect(fixture?.books).toBe(2);
  });
});

describe('TRA-4350 — the tape stays bounded and cannot be poisoned', () => {
  it('drops records older than the 30d retention', () => {
    const t0 = 1_788_000_000_000;
    recordRvScanCensus({ ...DESK, etDay: '2026-07-01' }, 'otm', pass(), t0);
    __setRvScanCensusBootId('boot-2');
    hydrateRvScanCensusFromDisk(dir, t0 + CENSUS_RETAIN_MS + 1);
    expect(summarizeRvScanCensus()).toHaveLength(0);
  });

  it('skips a torn trailing line instead of aborting the hydrate', () => {
    recordRvScanCensus(DESK, 'otm', pass());
    const path = rvScanCensusLogPath(dir);
    writeFileSync(path, readFileSync(path, 'utf8') + '{"kind":"scan-census","ts":17880', 'utf8');
    __setRvScanCensusBootId('boot-2');
    const h = hydrateRvScanCensusFromDisk(dir);
    expect(h.dropped).toBe(1);
    expect(cell('2026-09-02', 'otm', 'desk')?.scans).toBe(1);
  });

  it('folds unbounded gate labels into an overflow bucket rather than growing the line', () => {
    const many: Record<string, number> = {};
    for (let i = 0; i < 50; i += 1) many[`gate_${i}`] = 1;
    recordRvScanCensus(DESK, 'otm', pass({ candidatesEvaluated: 50, rejectionsByGate: many }));
    const gates = cell('2026-09-02', 'otm', 'desk')?.rejectionsByGate ?? {};
    expect(Object.keys(gates)).toHaveLength(33); // 32 real labels + the overflow bucket
    expect(gates[GATE_OVERFLOW]).toBe(18);
    // Nothing was dropped: the bucket sum still reconciles against the rejections.
    expect(Object.values(gates).reduce((a, b) => a + b, 0)).toBe(50);

    // IDEMPOTENCE. The fold runs once into the tally and again when the summary
    // merges across boots. If the overflow bucket consumed a label slot, the
    // second pass would evict one more real label than the first and this count
    // would creep every time the data was re-read.
    __setRvScanCensusBootId('boot-2');
    hydrateRvScanCensusFromDisk(dir);
    const after = cell('2026-09-02', 'otm', 'desk')?.rejectionsByGate ?? {};
    expect(after[GATE_OVERFLOW]).toBe(18);
    expect(Object.values(after).reduce((a, b) => a + b, 0)).toBe(50);
  });

  it('an unset dataDir keeps counting in memory and never throws', () => {
    clearRvScanCensusLedger();
    expect(() => recordRvScanCensus(DESK, 'otm', pass())).not.toThrow();
    expect(cell('2026-09-02', 'otm', 'desk')?.scans).toBe(1);
    expect(existsSync(rvScanCensusLogPath(dir))).toBe(false);
  });
});
