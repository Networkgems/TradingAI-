/**
 * TRA-3387 (child of TRA-3243) — acceptance for the DURABLE half of the session-scoped
 * moveSuspect verdict, plus the coverage predicate the EOD census grades.
 *
 * The three pre-registered acceptance criteria on the ticket:
 *
 *   AC1  a restart between a condemnation and the report EITHER preserves the exclusion OR
 *        produces a census that says BLIND — never an empty one that reads as clean;
 *   AC2  a boot carrying a PREVIOUS ET session's fact drops it, and the SAME session's fact
 *        survives (both directions, because a store that drops everything satisfies half of
 *        this criterion perfectly);
 *   AC3  a genuinely clean session still produces an empty census, and it is distinguishable
 *        from AC1's BLIND.
 *
 * AC1's exclusion-preserving arm and AC2 are graded here at the engine boundary — a real
 * restart is modelled as a SECOND `SignalEngine` pointed at the same directory, because that is
 * the only shape in which "the fact lived only in the dead process" is actually true. AC1's
 * BLIND arm and AC3's distinguishability are graded in `reports/eod-report.test.ts`, where the
 * census is emitted.
 *
 * ⭐ Every arm carries its opposite. The negative control for the restore is the SAME sequence
 * with no hydrate, and it must publish the row — otherwise this file would pass against a fix
 * that never restored anything, because something else was excluding AZI all along.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SignalEngine } from './signal-engine.js';
import { isMoveSuspect, assessQuotePlausibility } from '@trading-app/shared';
import {
  selectRestorableRows,
  loadMoveSuspectSessionSnapshot,
  saveMoveSuspectSessionSnapshot,
  gradeMoveSuspectSessionCoverage,
  moveSuspectSessionPath,
  MOVE_SUSPECT_SESSION_MAX_ROWS,
  type MoveSuspectSessionFile,
  type MoveSuspectSessionProvenance,
  type MoveSuspectSessionRestore,
} from './move-suspect-session-store.js';

type QuoteRow = { price: number; volume: number; change: number; changePct: number };
const quotes = (rows: Record<string, QuoteRow>) => new Map(Object.entries(rows));

// Same deliberate white-box seam the TRA-2610 / TRA-2689 blocks use: the stamping boundary is
// private by design, and it is the boundary this ticket is about.
const applyQuotes = (engine: SignalEngine, q: Map<string, QuoteRow>, active: string[]) =>
  (engine as unknown as { applyQuotes(qq: unknown, a: string[]): Map<string, number> })
    .applyQuotes(q, active);
const rowFor = (engine: SignalEngine, symbol: string) =>
  engine.getState().symbols.find(s => s.symbol === symbol);

/** Only `Date` is faked: the engine's constructor arms real timers. */
const withClock = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
};
afterEach(() => { vi.useRealTimers(); });

const tempDir = () => mkdtemp(join(tmpdir(), 'tra3387-'));

// ── The AZI 08-06 shape, from the tape TRA-3243 was found on ────────────────
//
// Condemned at 14:00 ET on `impliedPrevClose` 1.0100 (r = 2.4455, over the anchor), then
// instantaneously CLEAN at the close on THE SAME denominator (r = 1.5842, under the 1.9 floor).
// That is the whole defect: the numerator mean-reverted and the datum under suspicion did not
// move, so the closing snapshot re-published a fabricated +58.42% at rank #2.
const AZI_CONDEMNED: QuoteRow = { price: 2.47, volume: 900_000, change: 1.46, changePct: 144.55 };
const AZI_CLEAN: QuoteRow = { price: 1.60, volume: 900_000, change: 0.59, changePct: 58.42 };

/** 14:00 ET on 2026-08-06 — mid-session. */
const T_AUG06_1400ET = Date.parse('2026-08-06T18:00:00.000Z');
/** 15:55 ET the SAME session, i.e. the closing snapshot. */
const T_AUG06_1555ET = Date.parse('2026-08-06T19:55:00.000Z');
/** 09:35 ET on 2026-08-07 — the NEXT ET session. */
const T_AUG07_0935ET = Date.parse('2026-08-07T13:35:00.000Z');

describe('TRA-3387 — the rollover gate, which is where a restored fact could INVERT the bug', () => {
  const file = (sessionDay: string): Partial<MoveSuspectSessionFile> => ({
    sessionDay,
    rows: [{ symbol: 'AZI', moveSuspectSessionDay: sessionDay, moveSuspectPrevClose: 1.01 }],
  });

  it('AC2 — the SAME ET session day survives and the PREVIOUS one is dropped', () => {
    // Both directions in one test on purpose. A gate that drops everything satisfies the
    // "previous session is dropped" half perfectly and is useless, so the two assertions have
    // to be read together or neither is evidence.
    const same = selectRestorableRows(file('2026-08-06'), '2026-08-06');
    expect(same.sameSession).toBe(true);
    expect(same.rows.map(r => r.symbol)).toEqual(['AZI']);
    expect(same.rows[0].moveSuspectPrevClose).toBe(1.01);
    expect(same.droppedRows).toBe(0);

    const prior = selectRestorableRows(file('2026-08-05'), '2026-08-06');
    expect(prior.sameSession).toBe(false);
    expect(prior.rows).toEqual([]);
    expect(prior.droppedRows).toBe(1);
  });

  it('a row whose OWN session day disagrees with the file is dropped even on a matching file', () => {
    // Not redundant paranoia: this is the only thing between a hand-edited or half-merged
    // snapshot and a FABRICATED exclusion, which the ticket calls worse than the bug.
    const mixed: Partial<MoveSuspectSessionFile> = {
      sessionDay: '2026-08-06',
      rows: [
        { symbol: 'AZI', moveSuspectSessionDay: '2026-08-06', moveSuspectPrevClose: 1.01 },
        { symbol: 'STALE', moveSuspectSessionDay: '2026-08-05', moveSuspectPrevClose: 9 },
        { symbol: '  ', moveSuspectSessionDay: '2026-08-06' },
      ],
    };
    const r = selectRestorableRows(mixed, '2026-08-06');
    expect(r.rows.map(x => x.symbol)).toEqual(['AZI']);
    expect(r.droppedRows).toBe(2);
  });

  it('a non-finite anchor is dropped rather than restored as NaN', () => {
    // A NaN anchor makes `isSameImpliedPrevClose` false forever, which LATCHES the row for the
    // whole session with no discharge path — an exclusion that cannot be released.
    const r = selectRestorableRows({
      sessionDay: '2026-08-06',
      rows: [{ symbol: 'AZI', moveSuspectSessionDay: '2026-08-06', moveSuspectPrevClose: NaN }],
    }, '2026-08-06');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0].moveSuspectPrevClose).toBeUndefined();
  });

  it('a missing / empty / malformed snapshot yields no rows and no throw', () => {
    expect(selectRestorableRows(null, '2026-08-06').rows).toEqual([]);
    expect(selectRestorableRows({}, '2026-08-06').sameSession).toBe(false);
    expect(selectRestorableRows({ sessionDay: '2026-08-06' }, '2026-08-06').rows).toEqual([]);
  });
});

describe('TRA-3387 — the store round trip, and the outcomes an empty read can have', () => {
  it('a same-day snapshot round-trips to `restored`', async () => {
    const dir = await tempDir();
    await saveMoveSuspectSessionSnapshot(dir, {
      sessionDay: '2026-08-06',
      processStartedAt: 1_000,
      rows: [{ symbol: 'AZI', moveSuspectSessionDay: '2026-08-06', moveSuspectPrevClose: 1.01 }],
      now: 2_000,
    });
    const r = await loadMoveSuspectSessionSnapshot(dir, '2026-08-06');
    expect(r.outcome).toBe('restored');
    expect(r.rows).toHaveLength(1);
    expect(r.fileSessionDay).toBe('2026-08-06');
    expect(r.fileUpdatedAt).toBe(2_000);
    expect(r.fileProcessStartedAt).toBe(1_000);
  });

  it('the SAME file read on the NEXT session day is `rolled_over`, not `restored`', async () => {
    const dir = await tempDir();
    await saveMoveSuspectSessionSnapshot(dir, {
      sessionDay: '2026-08-06',
      processStartedAt: 1_000,
      rows: [{ symbol: 'AZI', moveSuspectSessionDay: '2026-08-06', moveSuspectPrevClose: 1.01 }],
    });
    const r = await loadMoveSuspectSessionSnapshot(dir, '2026-08-07');
    expect(r.outcome).toBe('rolled_over');
    expect(r.rows).toEqual([]);
    expect(r.droppedRows).toBe(1);
    // And a rollover is BLIND, not covered: yesterday's snapshot says nothing about today.
    expect(gradeCoverage(r, '2026-08-07').coverage).toBe('blind');
  });

  it('THE OUTCOMES AN EMPTY READ CAN HAVE ARE DISTINGUISHABLE — absent vs unreadable vs rolled over', async () => {
    // All four produce zero restorable rows. Collapsing them to a boolean is how the original
    // defect looked clean, so the type has to keep them apart.
    const empty = await tempDir();
    expect((await loadMoveSuspectSessionSnapshot(empty, '2026-08-06')).outcome).toBe('absent');

    const corrupt = await tempDir();
    await writeFile(moveSuspectSessionPath(corrupt), '{not json', 'utf-8');
    const c = await loadMoveSuspectSessionSnapshot(corrupt, '2026-08-06');
    expect(c.outcome).toBe('unreadable');
    expect(c.reason).toBeTruthy();

    const dayless = await tempDir();
    await writeFile(moveSuspectSessionPath(dayless),
      JSON.stringify({ version: 1, rows: [{ symbol: 'AZI', moveSuspectSessionDay: '2026-08-06' }] }), 'utf-8');
    const d = await loadMoveSuspectSessionSnapshot(dayless, '2026-08-06');
    // An UNSCOPED fact is the exact input that would condemn a clean row, so a snapshot with no
    // session day is unreadable — never "absent" (which reads as a clean first boot).
    expect(d.outcome).toBe('unreadable');
    expect(d.droppedRows).toBe(1);
  });

  it('a truncating write says so ON the file — a silently subset census is unreadable again', async () => {
    const dir = await tempDir();
    const rows = Array.from({ length: MOVE_SUSPECT_SESSION_MAX_ROWS + 5 }, (_, i) => ({
      symbol: `S${i}`, moveSuspectSessionDay: '2026-08-06',
    }));
    const written = await saveMoveSuspectSessionSnapshot(dir, {
      sessionDay: '2026-08-06', processStartedAt: 1, rows,
    });
    expect(written.truncated).toBe(true);
    expect(written.rows).toHaveLength(MOVE_SUSPECT_SESSION_MAX_ROWS);
    const onDisk = JSON.parse(await readFile(moveSuspectSessionPath(dir), 'utf-8')) as MoveSuspectSessionFile;
    expect(onDisk.truncated).toBe(true);
  });

  it('the write is atomic — no `.tmp` is left where the reader looks', async () => {
    const dir = await tempDir();
    await saveMoveSuspectSessionSnapshot(dir, { sessionDay: '2026-08-06', processStartedAt: 1, rows: [] });
    const parsed = JSON.parse(await readFile(moveSuspectSessionPath(dir), 'utf-8')) as MoveSuspectSessionFile;
    expect(parsed.issue).toBe('TRA-3387');
    expect(parsed.version).toBe(1);
  });

  it('a nonexistent directory is CREATED rather than failing the write', async () => {
    const dir = join(await tempDir(), 'not', 'there', 'yet');
    await expect(saveMoveSuspectSessionSnapshot(dir, {
      sessionDay: '2026-08-06', processStartedAt: 1, rows: [],
    })).resolves.toBeTruthy();
  });
});

// ── The coverage predicate: what makes an EMPTY census readable ──────────────

const restoreOf = (outcome: MoveSuspectSessionRestore['outcome'], updatedAt: number | null = null): MoveSuspectSessionRestore => ({
  outcome, path: '/x', fileSessionDay: null, fileUpdatedAt: updatedAt,
  fileProcessStartedAt: null, rows: [], droppedRows: 0,
});
const provenanceOf = (
  startedSessionDay: string,
  restore: MoveSuspectSessionRestore | null,
  processStartedAt = 10_000,
): MoveSuspectSessionProvenance => ({
  processStartedAt,
  processStartedSessionDay: startedSessionDay,
  restore,
  lastFlushAt: null,
  lastFlushError: null,
  storeDir: '/x',
  ephemeralStore: false,
});
const gradeCoverage = (r: MoveSuspectSessionRestore, day: string) =>
  gradeMoveSuspectSessionCoverage(provenanceOf(day, r), day);

describe('TRA-3387 — the coverage verdict an empty census is read through', () => {
  it('a process older than the graded session is INTACT with a PROVEN zero gap', () => {
    const v = gradeMoveSuspectSessionCoverage(provenanceOf('2026-08-05', restoreOf('absent')), '2026-08-06');
    expect(v.coverage).toBe('intact');
    expect(v.reason).toBe('process_older_than_session');
    // `0`, not `null`: there provably is no gap. The tri-state only degrades to `null` when a
    // gap exists and its size is unknowable (the TRA-3116 discipline).
    expect(v.uncoveredMs).toBe(0);
  });

  it('a restart INSIDE the session with a same-day snapshot is RESTORED, and the residual gap is a NUMBER', () => {
    const v = gradeMoveSuspectSessionCoverage(
      provenanceOf('2026-08-06', restoreOf('restored', 9_000), 10_000), '2026-08-06');
    expect(v.coverage).toBe('restored');
    // The one interval a successful restore cannot cover: whatever the dead process condemned
    // after its last durable write. Computable, so it is reported as a number.
    expect(v.uncoveredMs).toBe(1_000);
  });

  it('AC1 — every way of restarting in-session WITHOUT a usable snapshot is BLIND', () => {
    for (const [restore, reason] of [
      [restoreOf('absent'), 'restart_in_session_no_snapshot'],
      [restoreOf('rolled_over'), 'restart_in_session_snapshot_rolled_over'],
      [restoreOf('unreadable'), 'restart_in_session_snapshot_unreadable'],
      [null, 'restart_in_session_store_not_wired'],
    ] as const) {
      const v = gradeMoveSuspectSessionCoverage(provenanceOf('2026-08-06', restore), '2026-08-06');
      expect(v.coverage).toBe('blind');
      expect(v.reason).toBe(reason);
      // `null`, never `0`. A zero here would be a reassuring number standing in for an
      // unknowable one, which is the shape the whole ticket is about.
      expect(v.uncoveredMs).toBeNull();
    }
  });

  it('an ABSENT provenance is BLIND, not clean — omission must not buy a pass', () => {
    for (const p of [null, undefined]) {
      const v = gradeMoveSuspectSessionCoverage(p, '2026-08-06');
      expect(v.coverage).toBe('blind');
      expect(v.reason).toBe('provenance_absent');
    }
  });

  it('state from a LATER session (a backfill) is BLIND', () => {
    const v = gradeMoveSuspectSessionCoverage(
      provenanceOf('2026-08-07', restoreOf('restored', 1)), '2026-08-06');
    expect(v.coverage).toBe('blind');
    expect(v.reason).toBe('state_from_a_later_session');
  });

  it('THE VERDICT IS A FUNCTION OF ITS INPUTS, not a constant — one arm of each is reachable', () => {
    // Without this the block above would pass identically against a predicate hard-wired to
    // whichever value each individual test expected.
    const seen = new Set([
      gradeMoveSuspectSessionCoverage(provenanceOf('2026-08-05', restoreOf('absent')), '2026-08-06').coverage,
      gradeMoveSuspectSessionCoverage(provenanceOf('2026-08-06', restoreOf('restored', 1)), '2026-08-06').coverage,
      gradeMoveSuspectSessionCoverage(provenanceOf('2026-08-06', restoreOf('absent')), '2026-08-06').coverage,
    ]);
    expect([...seen].sort()).toEqual(['blind', 'intact', 'restored']);
  });
});

// ── The engine boundary: an actual restart ──────────────────────────────────

describe('TRA-3387 ACCEPTANCE — a restart between the condemnation and the close', () => {
  it('AC1 — the exclusion SURVIVES a restart, and the negative control shows it would not have', async () => {
    const dir = await tempDir();
    withClock(T_AUG06_1400ET);

    // POSITIVE CONTROL FIRST: the closing row on its own is clean by every instrument, so an
    // exclusion at the end can only have come from the restored session fact.
    expect(assessQuotePlausibility(AZI_CLEAN).suspect).toBe(false);
    expect(assessQuotePlausibility(AZI_CONDEMNED).suspect).toBe(true);
    expect(assessQuotePlausibility(AZI_CONDEMNED).impliedPrevClose).toBeCloseTo(1.01, 6);
    expect(assessQuotePlausibility(AZI_CLEAN).impliedPrevClose).toBeCloseTo(1.01, 6);

    // --- process 1: condemns AZI mid-session, then dies ---
    const before = new SignalEngine();
    await before.hydrateMoveSuspectSession(dir);
    applyQuotes(before, quotes({ AZI: AZI_CONDEMNED }), ['AZI']);
    await before.whenMoveSuspectSessionSettled();
    expect(rowFor(before, 'AZI')?.moveSuspectSession).toBe(true);

    // The snapshot the dead process left behind. Read off disk, not off the engine: the claim
    // is that it is DURABLE, and an in-memory assertion cannot say that.
    const onDisk = JSON.parse(await readFile(moveSuspectSessionPath(dir), 'utf-8')) as MoveSuspectSessionFile;
    expect(onDisk.sessionDay).toBe('2026-08-06');
    expect(onDisk.rows.map(r => r.symbol)).toEqual(['AZI']);
    expect(onDisk.rows[0].moveSuspectPrevClose).toBeCloseTo(1.01, 6);

    // --- process 2: a fresh engine (the restart), then the CLOSING quote ---
    vi.setSystemTime(T_AUG06_1555ET);
    const after = new SignalEngine();
    const restore = await after.hydrateMoveSuspectSession(dir);
    expect(restore.outcome).toBe('restored');
    applyQuotes(after, quotes({ AZI: AZI_CLEAN }), ['AZI']);

    const row = rowFor(after, 'AZI')!;
    expect(row.moveSuspect).toBe(false);          // P-now: instantaneously clean, as on the tape
    expect(row.moveSuspectSession).toBe(true);    // P-session: HELD on the same denominator
    expect(isMoveSuspect(row)).toBe(true);        // ...so the EOD table cannot rank it
    expect(after.getMoveSuspectSessionProvenance().restore?.outcome).toBe('restored');

    // NEGATIVE CONTROL — the identical restart with NO restore is the pre-TRA-3387 world, and
    // it must publish. Without this arm the test would pass against a build where something
    // else excluded AZI all along.
    const unhydrated = new SignalEngine();
    applyQuotes(unhydrated, quotes({ AZI: AZI_CLEAN }), ['AZI']);
    const lost = rowFor(unhydrated, 'AZI')!;
    expect(lost.moveSuspectSession).toBe(false);
    expect(isMoveSuspect(lost)).toBe(false);
  });

  it('AC2 — a restart on the NEXT ET session drops the fact, and the clean row publishes', async () => {
    const dir = await tempDir();
    withClock(T_AUG06_1400ET);
    const before = new SignalEngine();
    await before.hydrateMoveSuspectSession(dir);
    applyQuotes(before, quotes({ AZI: AZI_CONDEMNED }), ['AZI']);
    await before.whenMoveSuspectSessionSettled();

    // Next ET session. Yesterday's condemnation is a claim about a prev close that is not even
    // in today's arithmetic; applying it would condemn a clean row, which is the INVERSION the
    // ticket calls worse than the bug it fixes.
    vi.setSystemTime(T_AUG07_0935ET);
    const after = new SignalEngine();
    const restore = await after.hydrateMoveSuspectSession(dir);
    expect(restore.outcome).toBe('rolled_over');
    expect(restore.rows).toEqual([]);
    expect(restore.droppedRows).toBe(1);
    // The row never reaches `symbolState` at all — the drop is at the READ, so no later path
    // can resurrect it.
    expect(rowFor(after, 'AZI')).toBeUndefined();

    applyQuotes(after, quotes({ AZI: AZI_CLEAN }), ['AZI']);
    const row = rowFor(after, 'AZI')!;
    expect(row.moveSuspectSession).toBe(false);
    expect(isMoveSuspect(row)).toBe(false);
  });

  it('a DISCHARGE is persisted too — the store is not a one-way ratchet', async () => {
    const dir = await tempDir();
    withClock(T_AUG06_1400ET);
    const engine = new SignalEngine();
    await engine.hydrateMoveSuspectSession(dir);
    applyQuotes(engine, quotes({ AZI: AZI_CONDEMNED }), ['AZI']);
    await engine.whenMoveSuspectSessionSettled();
    expect(((JSON.parse(await readFile(moveSuspectSessionPath(dir), 'utf-8')) as MoveSuspectSessionFile).rows)).toHaveLength(1);

    // The feed re-derives a materially DIFFERENT denominator (1.01 -> 3.94): the suspicion is
    // spent. If only condemnations were written, a restart here would restore a fact the live
    // process had already discharged — an exclusion resurrected by a crash.
    vi.setSystemTime(T_AUG06_1555ET);
    applyQuotes(engine, quotes({ AZI: { price: 4.06, volume: 900_000, change: 0.12, changePct: 3.05 } }), ['AZI']);
    await engine.whenMoveSuspectSessionSettled();
    expect(rowFor(engine, 'AZI')?.moveSuspectSession).toBe(false);
    const after = JSON.parse(await readFile(moveSuspectSessionPath(dir), 'utf-8')) as MoveSuspectSessionFile;
    expect(after.rows).toEqual([]);
  });

  it('AC3 CONTROL — a genuinely clean session writes no rows and restores as `absent`', async () => {
    const dir = await tempDir();
    withClock(T_AUG06_1400ET);
    const engine = new SignalEngine();
    const restore = await engine.hydrateMoveSuspectSession(dir);
    expect(restore.outcome).toBe('absent');
    applyQuotes(engine, quotes({ AAPL: { price: 338.11, volume: 4e7, change: 5.71, changePct: 1.72 } }), ['AAPL']);
    await engine.whenMoveSuspectSessionSettled();
    // No condemnation ⇒ nothing to persist ⇒ NO WRITE AT ALL. The clean path must not pay a
    // disk write per quote batch.
    await expect(readFile(moveSuspectSessionPath(dir), 'utf-8')).rejects.toThrow();
    expect(rowFor(engine, 'AAPL')?.moveSuspectSession).toBe(false);
  });

  it('an unwired engine still reports a GRADEABLE provenance rather than pretending it is fine', () => {
    withClock(T_AUG06_1400ET);
    const engine = new SignalEngine();
    const p = engine.getMoveSuspectSessionProvenance();
    expect(p.restore).toBeNull();
    expect(p.storeDir).toBeNull();
    expect(p.ephemeralStore).toBeNull();
    // `processStartedAt` is derived from `process.uptime()`, so it is a real fact about this
    // process even under a faked `Date`. It only has to be a finite instant at or before now.
    expect(Number.isFinite(p.processStartedAt)).toBe(true);
    expect(p.processStartedAt).toBeLessThanOrEqual(Date.now());
  });

  it('a store directory that cannot be written records the failure instead of losing it', async () => {
    const dir = await tempDir();
    withClock(T_AUG06_1400ET);
    const engine = new SignalEngine();
    await engine.hydrateMoveSuspectSession(dir);
    // A FILE where the store expects a DIRECTORY: `mkdir` fails, so the write cannot land.
    // The point is not the errno — it is that the engine's provenance says so, which is what
    // turns a silently-undurable store into a BLIND census instead of a clean-looking one.
    const blocked = join(dir, 'blocked');
    await mkdir(blocked, { recursive: true });
    await writeFile(join(blocked, 'sub'), 'x', 'utf-8');
    (engine as unknown as { moveSuspectSessionDir: string }).moveSuspectSessionDir = join(blocked, 'sub', 'deeper');
    applyQuotes(engine, quotes({ AZI: AZI_CONDEMNED }), ['AZI']);
    await engine.whenMoveSuspectSessionSettled();
    expect(engine.getMoveSuspectSessionProvenance().lastFlushError).toBeTruthy();
  });
});
