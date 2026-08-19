/**
 * TRA-2688 (leg 1 of TRA-2654) — the close ledger's own tests.
 *
 * The load-bearing one is `the ledger's own day 1`. Everything else here is
 * budget and failure-posture arithmetic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile, readdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { assessLevelContinuity } from '@trading-app/shared';
import { isMarketDayIso, previousMarketDayIso } from './scheduler.js';
import type { SymbolState } from './signal-engine.js';
import {
  writeCloseLedger,
  readCloseLedger,
  usableLedgerRows,
  priorSessionLedgerMovers,
  capCloseLedgerRows,
  toCloseLedgerRow,
  enforceAggregateLedgerBudget,
  resetAggregateLedgerSweepMemo,
  CLOSE_LEDGER_MAX_ROWS,
  CLOSE_LEDGER_MAX_FILES,
  CLOSE_LEDGER_DIR,
  type CloseLedgerFile,
  type CloseLedgerRow,
} from './close-ledger.js';

let root: string;

function sym(over: Partial<SymbolState> & { symbol: string }): SymbolState {
  return {
    price: 10,
    volume: 1_000,
    change: 0.5,
    changePct: 5,
    lastUpdated: 1_754_000_000_000,
    ...over,
  } as SymbolState;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tra2688-'));
  resetAggregateLedgerSweepMemo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetAggregateLedgerSweepMemo();
});

/** A book's stock bucket, laid out exactly as `stockReportsDirFor` produces. */
function bucket(book = 'admin', mode = 'live'): string {
  return join(root, 'users', book, 'reports', mode);
}
const usersRoot = () => join(root, 'users');

async function readLedger(dir: string, date: string): Promise<CloseLedgerFile> {
  return JSON.parse(await readFile(join(dir, CLOSE_LEDGER_DIR, `${date}.json`), 'utf-8'));
}

// ────────────────────────────────────────────────────────────────────────────
// AC4 — the ledger's own day 1
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-2688 AC4 — the ledger\'s own day 1 abstains, it is not `consistent`', () => {
  // The hazard is a reader (human or code) who assumes "a ledger exists =>
  // the population is covered". The ledger's FIRST session has no predecessor
  // either, so it is exactly as blind as FGMC's 07-28 row was, and nothing in
  // the artifact says so unless a test says it.
  //
  // ⭐ Graded in BOTH directions in this block: the day-1 abstain is only
  // evidence once the same instrument is shown to reach `consistent` on day 2.
  // A control that can only ever abstain discriminates nothing.
  const day1 = '2026-08-11';
  const day2 = '2026-08-12';

  it('day 1: the ledger is written, and the SAME session\'s prior lookup still abstains', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    const today = sym({ symbol: 'TDIC', price: 6.13, change: -1.66, changePct: -21.31 });

    const w = await writeCloseLedger({
      targetDir: dir, date: day1, symbols: [today], usersRoot: usersRoot(),
    });
    expect(w.written).toBe(true);

    // The ledger for day 1 exists. Its PREDECESSOR's does not.
    const prior = await priorSessionLedgerMovers({ targetDir: dir, prevSession: '2026-08-10' });
    expect(prior.source).toBe('ledger_absent');
    expect(prior.movers).toBeNull();

    // Which is what reaches the detector: no prior row => abstain.
    const v = assessLevelContinuity(null, today);
    expect(v.verdict).toBe('abstain');
    expect(v.reason).toBe('no_prior_observation');
    expect(v.verdict).not.toBe('consistent');
  });

  it('day 2: the same instrument DOES reach `consistent` — the day-1 abstain is not a broken gate', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    // 10.00 close on day 1; day 2 opens from it and moves +10% to 11.00.
    await writeCloseLedger({
      targetDir: dir, date: day1, usersRoot: usersRoot(),
      symbols: [sym({ symbol: 'TDIC', price: 10, change: 0.5, changePct: 5.26 })],
    });
    const today = sym({ symbol: 'TDIC', price: 11, change: 1, changePct: 10 });

    const prior = await priorSessionLedgerMovers({ targetDir: dir, prevSession: day1 });
    expect(prior.source).toBe('close_ledger');
    expect(prior.movers).toHaveLength(1);

    const v = assessLevelContinuity(prior.movers![0], today);
    expect(v.verdict).toBe('consistent');

    // …and it still CONDEMNS a genuine discontinuity, so `consistent` above is
    // not a rubber stamp either.
    const fabricated = sym({ symbol: 'TDIC', price: 11, change: 5.5, changePct: 100 });
    expect(assessLevelContinuity(prior.movers![0], fabricated).verdict).toBe('suspect');

    // Sanity on the date the write actually landed under.
    expect((await readLedger(dir, day1)).date).toBe(day1);
    void day2;
  });

  it('a ledger can never serve as its OWN prior session (residual 1.0 => a false `consistent`)', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    await writeCloseLedger({
      targetDir: dir, date: day2, usersRoot: usersRoot(),
      symbols: [sym({ symbol: 'TDIC', price: 11, change: 1, changePct: 10 })],
    });
    // The caller asks for the PREVIOUS session. Today's file is not it, and the
    // absence is what forces the abstain.
    const prior = await priorSessionLedgerMovers({ targetDir: dir, prevSession: day1 });
    expect(prior.source).toBe('ledger_absent');

    // And the second line of defence: a file mis-filed under the wrong name is
    // refused rather than read as the prior session.
    await writeFile(
      join(dir, CLOSE_LEDGER_DIR, `${day1}.json`),
      JSON.stringify({ ...(await readLedger(dir, day2)) }),
      'utf-8',
    );
    const mis = await readCloseLedger(dir, day1);
    expect(mis.state).toBe('unreadable');
    expect((await priorSessionLedgerMovers({ targetDir: dir, prevSession: day1 })).source)
      .toBe('ledger_unreadable');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Failure posture — never throws, never a partial parse
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-2688 failure posture', () => {
  it('a partial / unparseable ledger is discarded WHOLE, never row-by-row', async () => {
    const dir = bucket();
    await mkdir(join(dir, CLOSE_LEDGER_DIR), { recursive: true });
    const good = JSON.stringify({
      issue: 'TRA-2688', date: '2026-08-11', generatedAt: 'x', symbolsInState: 2,
      rowCap: CLOSE_LEDGER_MAX_ROWS, truncated: 0,
      rows: [{ symbol: 'A', price: 1, change: 0, changePct: 0, lastUpdated: 1, quoteStatus: 'ok', moveSuspect: false }],
    });
    // Truncated mid-array — the shape a write killed by a restart leaves.
    await writeFile(join(dir, CLOSE_LEDGER_DIR, '2026-08-11.json'), good.slice(0, good.length - 30), 'utf-8');

    const read = await readCloseLedger(dir, '2026-08-11');
    expect(read.state).toBe('unreadable');
    const prior = await priorSessionLedgerMovers({ targetDir: dir, prevSession: '2026-08-11' });
    expect(prior.movers).toBeNull();
    expect(prior.source).toBe('ledger_unreadable');
  });

  it('a ledger that parses but fails its shape check is unreadable, not empty', async () => {
    const dir = bucket();
    await mkdir(join(dir, CLOSE_LEDGER_DIR), { recursive: true });
    await writeFile(join(dir, CLOSE_LEDGER_DIR, '2026-08-11.json'), '{"date":"2026-08-11"}', 'utf-8');
    expect((await readCloseLedger(dir, '2026-08-11')).state).toBe('unreadable');
  });

  it('an absent ledger is `absent`, distinct from `unreadable`', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    expect((await readCloseLedger(dir, '2026-08-11')).state).toBe('absent');
  });

  it('the writer never throws — an unwritable target returns `written: false` with a reason', async () => {
    // A FILE where the directory must go: `mkdir` fails with ENOTDIR.
    const dir = join(root, 'not-a-dir');
    await mkdir(root, { recursive: true });
    await writeFile(dir, 'x', 'utf-8');
    const w = await writeCloseLedger({ targetDir: dir, date: '2026-08-11', symbols: [sym({ symbol: 'A' })] });
    expect(w.written).toBe(false);
    expect(w.error).toBeTruthy();
  });
});

// ────────────────────────────────────────────────────────────────────────────
// The reader is stricter than the writer
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-2688 freshness filter', () => {
  it('stores stale / never-fetched rows but refuses to serve them as a prior observation', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', usersRoot: usersRoot(),
      symbols: [
        sym({ symbol: 'FRESH', price: 10, lastUpdated: 1_754_000_000_000 }),
        sym({ symbol: 'NEVER', price: 8.3, lastUpdated: 0 }),
        sym({ symbol: 'ZERO', price: 0, lastUpdated: 1_754_000_000_000 }),
      ],
    });
    const file = await readLedger(dir, '2026-08-11');
    // The record is complete: leg 2 needs the stale rows to MEASURE staleness.
    expect(file.rows.map(r => r.symbol).sort()).toEqual(['FRESH', 'NEVER', 'ZERO']);
    // The consumer is not.
    expect(usableLedgerRows(file.rows).map(r => r.symbol)).toEqual(['FRESH']);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// State budget
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-2688 state budget', () => {
  it('truncates at the row cap, stamps the drop, and keeps the USABLE rows', () => {
    const rows: CloseLedgerRow[] = [];
    // 5 usable, 5 stale, cap 5 => the 5 usable survive.
    for (let i = 0; i < 5; i += 1) {
      rows.push({ symbol: `Z${i}`, price: 1, change: 0, changePct: 0, lastUpdated: 1, quoteStatus: 'ok', moveSuspect: false });
      rows.push({ symbol: `A${i}`, price: 1, change: 0, changePct: 0, lastUpdated: 0, quoteStatus: null, moveSuspect: false });
    }
    const capped = capCloseLedgerRows(rows, 5);
    expect(capped.truncated).toBe(5);
    expect(capped.rows.every(r => r.lastUpdated > 0)).toBe(true);
    // Deterministic: same input, same file.
    expect(capCloseLedgerRows(rows, 5).rows).toEqual(capped.rows);
  });

  it('`truncated` is stamped UNCONDITIONALLY, including 0', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols: [sym({ symbol: 'A' })], usersRoot: usersRoot(),
    });
    const file = await readLedger(dir, '2026-08-11');
    expect(file.truncated).toBe(0);
    expect(file.rowCap).toBe(CLOSE_LEDGER_MAX_ROWS);
    expect(file.symbolsInState).toBe(1);
  });

  it('a truncated write reports the drop back to the caller', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    const symbols = Array.from({ length: CLOSE_LEDGER_MAX_ROWS + 7 }, (_, i) =>
      sym({ symbol: `S${String(i).padStart(5, '0')}` }));
    const w = await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols, usersRoot: usersRoot(),
    });
    expect(w.truncated).toBe(7);
    expect(w.rows).toBe(CLOSE_LEDGER_MAX_ROWS);
    expect((await readLedger(dir, '2026-08-11')).truncated).toBe(7);
  });

  it('prunes the bucket to the file cap, oldest-first, and reports `prunedFiles`', async () => {
    const dir = bucket();
    const closes = join(dir, CLOSE_LEDGER_DIR);
    await mkdir(closes, { recursive: true });
    // Seed cap+3 older files; the write adds one more.
    for (let i = 0; i < CLOSE_LEDGER_MAX_FILES + 3; i += 1) {
      const d = new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10);
      await writeFile(join(closes, `${d}.json`), '{}', 'utf-8');
    }
    const w = await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols: [sym({ symbol: 'A' })], usersRoot: usersRoot(),
    });
    const names = (await readdir(closes)).sort();
    expect(names.length).toBe(CLOSE_LEDGER_MAX_FILES);
    expect(w.prunedFiles).toBe(4);
    // Oldest-first: the very first seeded date is gone, today's is present.
    expect(names).not.toContain('2020-01-01.json');
    expect(names).toContain('2026-08-11.json');
  });

  it('the 64 MB aggregate is SHARED with leg 2\'s tape and evicts the globally oldest', async () => {
    const closesA = join(root, 'users', 'a', 'reports', 'live', 'closes');
    const tapeB = join(root, 'users', 'b', 'reports', 'demo', 'tape');
    await mkdir(closesA, { recursive: true });
    await mkdir(tapeB, { recursive: true });
    const blob = 'x'.repeat(1000);
    await writeFile(join(closesA, '2026-01-02.json'), blob, 'utf-8');
    await writeFile(join(tapeB, '2026-01-01.json'), blob, 'utf-8');   // globally oldest
    await writeFile(join(closesA, '2026-01-03.json'), blob, 'utf-8');

    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', maxBytes: 2500, force: true,
    });
    expect(r.sweep).toBe('ran');
    expect(r.pruned).toBe(1);
    // Leg 2's file was the oldest, and the pool does not respect writer
    // boundaries — that is what "shared budget" means.
    expect(await readdir(tapeB)).toEqual([]);
    expect((await readdir(closesA)).sort()).toEqual(['2026-01-02.json', '2026-01-03.json']);
  });

  it('reports WHY the aggregate leg did nothing — a 0 that never looked is not a 0 under budget', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    const noRoot = await writeCloseLedger({ targetDir: dir, date: '2026-08-11', symbols: [] });
    expect(noRoot.aggregateSweep).toBe('skipped_no_root');

    const first = await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols: [], usersRoot: usersRoot(),
    });
    expect(first.aggregateSweep).toBe('ran');
    expect(first.aggregateBytes).toBeGreaterThan(0);

    // Second book, same ET date, same process: memoised, and it SAYS so.
    const second = await writeCloseLedger({
      targetDir: bucket('other'), date: '2026-08-11', symbols: [], usersRoot: usersRoot(),
    });
    expect(second.aggregateSweep).toBe('skipped_already_run');
  });
});

// ────────────────────────────────────────────────────────────────────────────
// Row projection
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-2688 row projection', () => {
  it('stores the EFFECTIVE `isMoveSuspect` verdict, not the raw stamp', () => {
    // A row the feed condemned earlier in the session (TRA-3243) whose
    // instantaneous stamp has since been cleared. Reading `s.moveSuspect`
    // directly is the fail-open `signal-engine.ts` forbids.
    const r = toCloseLedgerRow(sym({
      symbol: 'AZI', price: 10, change: 3.7, changePct: 58.42,
      moveSuspect: false, moveSuspectSession: true,
      moveSuspectSessionDay: '2026-08-11', moveSuspectPrevClose: 6.31,
    }));
    expect(r.moveSuspect).toBe(true);
    // …and the raw stamp survives beside it, precisely because they disagree.
    expect(r.moveSuspectStamp).toBe(false);
  });

  it('omits `moveSuspectStamp` when it agrees — it is pure cost on ~99% of rows', () => {
    const r = toCloseLedgerRow(sym({ symbol: 'AAPL', price: 200, change: 1, changePct: 0.5 }));
    expect(r.moveSuspect).toBe(false);
    expect('moveSuspectStamp' in r).toBe(false);
  });

  it('normalizes non-finite numerics to 0 rather than serializing them as null', () => {
    const r = toCloseLedgerRow(sym({ symbol: 'X', price: Number.NaN, changePct: Number.POSITIVE_INFINITY }));
    expect(r.price).toBe(0);
    expect(r.changePct).toBe(0);
    // Which the reader then refuses.
    expect(usableLedgerRows([r])).toEqual([]);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TRA-3847 — the WRITER's market-day gate (leg 1's copy of TRA-3844's)
//
// Read as PAIRS. A gate that refuses everything is exactly as useless as no
// gate, so every refusal arm below is joined to the adjacent session that must
// still write, over the same target and the same symbols.
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-3847 — the close-ledger writer refuses a non-market date', () => {
  const one = [sym({ symbol: 'AAPL', price: 200, lastUpdated: 1_754_000_000_000 })];

  it('a Saturday is refused and does not even create the bucket; the Friday beside it writes', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });

    // 2026-08-15 — the Saturday inside the weekend leg 2's shutdown drain minted
    // 67 tape files across (TRA-3844). This writer has no shutdown path, so the
    // reachable shape is `POST /api/reports/generate`, which passes no
    // `asOfDate` and therefore hands down TODAY's ET date.
    const sat = await writeCloseLedger({
      targetDir: dir, date: '2026-08-15', symbols: one, usersRoot: usersRoot(),
    });
    expect(sat.written).toBe(false);
    expect(sat.skipped).toBe(true);
    expect(sat.skipReason).toBe('non-market-day');
    // A refusal is NOT a failure. The distinction is the whole reason the two
    // fields are separate — see `CloseLedgerWriteResult`.
    expect(sat.error).toBeUndefined();
    // Ahead of `mkdir`: a refused write leaves no trace at all, not an empty
    // bucket a later reader has to interpret.
    await expect(readdir(join(dir, CLOSE_LEDGER_DIR))).rejects.toThrow();

    // …and the pair. Same target, same symbols, the adjacent session.
    const fri = await writeCloseLedger({
      targetDir: dir, date: '2026-08-14', symbols: one, usersRoot: usersRoot(),
    });
    expect(fri.written).toBe(true);
    expect(fri.skipped).toBeUndefined();
    expect((await readdir(join(dir, CLOSE_LEDGER_DIR))).sort()).toEqual(['2026-08-14.json']);
    expect((await readLedger(dir, '2026-08-14')).rows).toHaveLength(1);
  });

  it('Labor Day is refused too — the predicate is the CALENDAR, not day-of-week', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    // 2026-09-07 is a Monday. A day-of-week gate would happily write it.
    const holiday = await writeCloseLedger({
      targetDir: dir, date: '2026-09-07', symbols: one, usersRoot: usersRoot(),
    });
    expect(holiday.written).toBe(false);
    expect(holiday.skipReason).toBe('non-market-day');

    const tuesday = await writeCloseLedger({
      targetDir: dir, date: '2026-09-08', symbols: one, usersRoot: usersRoot(),
    });
    expect(tuesday.written).toBe(true);
    expect((await readdir(join(dir, CLOSE_LEDGER_DIR))).sort()).toEqual(['2026-09-08.json']);
  });

  it('a malformed date key is refused rather than written under a name no reader can resolve', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    for (const bad of ['2026-8-15', 'today', '']) {
      const w = await writeCloseLedger({
        targetDir: dir, date: bad, symbols: one, usersRoot: usersRoot(),
      });
      expect(w.written).toBe(false);
      expect(w.skipReason).toBe('non-market-day');
    }
    await expect(readdir(join(dir, CLOSE_LEDGER_DIR))).rejects.toThrow();
  });

  it('over 08-13..08-17 the written set EQUALS `isMarketDayIso` — the writer/reader drift test', async () => {
    // The defect itself was writer and reader disagreeing about what day it is.
    // Asserting the two sets rather than five individual outcomes is what makes
    // this a drift test instead of five restatements of the gate.
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    const span = ['2026-08-13', '2026-08-14', '2026-08-15', '2026-08-16', '2026-08-17'];
    for (const d of span) {
      await writeCloseLedger({ targetDir: dir, date: d, symbols: one, usersRoot: usersRoot() });
    }
    const onDisk = (await readdir(join(dir, CLOSE_LEDGER_DIR))).sort().map(n => n.replace('.json', ''));
    expect(onDisk).toEqual(span.filter(isMarketDayIso));
    expect(onDisk).toEqual(['2026-08-13', '2026-08-14', '2026-08-17']);
  });

  it('AC4 — `priorSessionLedgerMovers` still ANSWERS across the weekend gap', async () => {
    // The reason the gate cannot blind the reader is structural, not empirical:
    // `index.ts` only ever asks for `previousMarketDayIso(reportDate)`, so the
    // dates it can request are a SUBSET of the ones this gate admits. A weekend
    // ledger was unreachable residue even before the gate — nothing could ask
    // for it. This arm walks the exact Fri→Sat→Sun→Mon sequence.
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    await writeCloseLedger({
      targetDir: dir, date: '2026-08-14', usersRoot: usersRoot(),
      symbols: [
        sym({ symbol: 'AAPL', price: 200, changePct: 1.5, lastUpdated: 1_754_000_000_000 }),
        sym({ symbol: 'MSFT', price: 410, changePct: -0.4, lastUpdated: 1_754_000_000_000 }),
      ],
    });
    // Two ungated manual generates over the weekend, both refused.
    for (const d of ['2026-08-15', '2026-08-16']) {
      expect((await writeCloseLedger({ targetDir: dir, date: d, symbols: one, usersRoot: usersRoot() })).skipped).toBe(true);
    }

    // Monday's session asks the question exactly as `generateAndSaveReport` does.
    const prevSession = previousMarketDayIso('2026-08-17');
    expect(prevSession).toBe('2026-08-14');
    const prior = await priorSessionLedgerMovers({ targetDir: dir, prevSession: prevSession! });
    expect(prior.source).toBe('close_ledger');
    expect(prior.movers?.map(m => m.symbol).sort()).toEqual(['AAPL', 'MSFT']);
    expect(prior.rowsUsable).toBe(2);
  });
});
