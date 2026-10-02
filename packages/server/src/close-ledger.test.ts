/**
 * TRA-2688 (leg 1 of TRA-2654) — the close ledger's own tests.
 *
 * The load-bearing one is `the ledger's own day 1`. Everything else here is
 * budget and failure-posture arithmetic.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile, readFile, readdir, utimes } from 'fs/promises';
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
  compareLedgerEviction,
  measureLedgerQueueOrdering,
  summarizeLedgerPools,
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

  it('TRA-4156 — a tape/ overage evicts ONLY tape/, even when closes/ holds the globally oldest file', async () => {
    // The pre-split behaviour this reverses: one shared pool evicted the
    // globally oldest file, so leg 2 filling the pool cost the LIVE book its
    // closes. Here closes/ holds the globally OLDEST file and tape/ is the
    // directory over ITS budget — under the old rule closes/ would pay.
    const closesA = join(root, 'users', 'a', 'reports', 'live', 'closes');
    const tapeB = join(root, 'users', 'b', 'reports', 'demo', 'tape');
    await mkdir(closesA, { recursive: true });
    await mkdir(tapeB, { recursive: true });
    const blob = 'x'.repeat(1000);
    await writeFile(join(closesA, '2026-01-01.json'), blob, 'utf-8');   // globally oldest
    await writeFile(join(tapeB, '2026-01-02.json'), blob, 'utf-8');
    await writeFile(join(tapeB, '2026-01-03.json'), blob, 'utf-8');
    await writeFile(join(tapeB, '2026-01-04.json'), blob, 'utf-8');

    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 2500, tape: 2500 },
    });
    expect(r.sweep).toBe('ran');
    expect(r.pruned).toBe(1);
    // tape/ paid its own overage, oldest-first; closes/ kept the globally
    // oldest file because it is under ITS OWN budget.
    expect((await readdir(tapeB)).sort()).toEqual(['2026-01-03.json', '2026-01-04.json']);
    expect(await readdir(closesA)).toEqual(['2026-01-01.json']);
    // …and the report says which directory paid.
    expect(r.byDir?.tape).toEqual({ bytes: 2000, maxBytes: 2500, pruned: 1 });
    expect(r.byDir?.closes).toEqual({ bytes: 1000, maxBytes: 2500, pruned: 0 });
  });

  it('TRA-4156 — a closes/ overage likewise cannot touch tape/, and evicts the oldest closes ACROSS books', async () => {
    const closesA = join(root, 'users', 'a', 'reports', 'live', 'closes');
    const closesB = join(root, 'users', 'b', 'reports', 'demo', 'closes');
    const tapeB = join(root, 'users', 'b', 'reports', 'demo', 'tape');
    await mkdir(closesA, { recursive: true });
    await mkdir(closesB, { recursive: true });
    await mkdir(tapeB, { recursive: true });
    const blob = 'x'.repeat(1000);
    await writeFile(join(closesB, '2026-01-01.json'), blob, 'utf-8');   // oldest closes, other book
    await writeFile(join(closesA, '2026-01-02.json'), blob, 'utf-8');
    await writeFile(join(closesA, '2026-01-03.json'), blob, 'utf-8');
    await writeFile(join(tapeB, '2025-12-31.json'), blob, 'utf-8');     // globally oldest, wrong pool

    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 2500, tape: 2500 },
    });
    expect(r.pruned).toBe(1);
    // Within closes/ the oldest session goes regardless of which book wrote
    // it; tape/'s file survives despite being globally oldest.
    expect(await readdir(closesB)).toEqual([]);
    expect((await readdir(closesA)).sort()).toEqual(['2026-01-02.json', '2026-01-03.json']);
    expect(await readdir(tapeB)).toEqual(['2025-12-31.json']);
  });

  it('TRA-4156 — the default ceilings are 48 MiB closes / 16 MiB tape, and the write result carries the per-dir view', async () => {
    const dir = bucket();
    await mkdir(dir, { recursive: true });
    const w = await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols: [sym({ symbol: 'A' })], usersRoot: usersRoot(),
    });
    expect(w.aggregateSweep).toBe('ran');
    // Separate budgets, separate bytes — the AC on TRA-4503.
    expect(w.aggregateByDir?.closes.maxBytes).toBe(48 * 1024 * 1024);
    expect(w.aggregateByDir?.tape.maxBytes).toBe(16 * 1024 * 1024);
    expect(w.aggregateByDir?.closes.bytes).toBeGreaterThan(0);
    expect(w.aggregateByDir?.tape).toEqual({ bytes: 0, maxBytes: 16 * 1024 * 1024, pruned: 0 });
    // The combined number is still reported, and it is the sum of the parts.
    expect(w.aggregateBytes).toBe(
      (w.aggregateByDir?.closes.bytes ?? 0) + (w.aggregateByDir?.tape.bytes ?? 0),
    );
  });

  it('TRA-4503 — a tape/ eviction does NOT mark the closes/ census INCOMPLETE, but is still stated', async () => {
    // Measured live at the 2026-09-24T01:00Z boundary: the admin LIVE book
    // logged `INCOMPLETE or evicted` with `closes: {pruned: 0}` — all 407
    // evictions were `tape/`. The file was whole; only the shared count said
    // otherwise. Both halves are asserted here: the false alarm is gone AND
    // the sibling overage is not swallowed with it.
    const dir = bucket();
    const tapeB = join(root, 'users', 'b', 'reports', 'demo', 'tape');
    await mkdir(dir, { recursive: true });
    await mkdir(tapeB, { recursive: true });
    const blob = 'x'.repeat(1000);
    await writeFile(join(tapeB, '2026-01-01.json'), blob, 'utf-8');
    await writeFile(join(tapeB, '2026-01-02.json'), blob, 'utf-8');
    await writeFile(join(tapeB, '2026-01-03.json'), blob, 'utf-8');

    const warns: string[] = [];
    const infos: string[] = [];
    const w = await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols: [sym({ symbol: 'A' })], usersRoot: usersRoot(),
      limits: { tape: 2500 },
      log: { warn: (m: string) => warns.push(m), info: (m: string) => infos.push(m) },
    });

    expect(w.aggregateByDir?.tape.pruned).toBe(1);
    expect(w.aggregateByDir?.closes.pruned).toBe(0);
    expect(w.prunedForAggregate).toBe(1);
    // The census claim is keyed on THIS file's pool, which did not evict.
    expect(warns).not.toContain(
      'TRA-2688 close ledger is INCOMPLETE or evicted under budget — do not read it as a full census',
    );
    expect(infos).toContain('TRA-2688 close ledger written');
    // …and narrowing the warn did not delete the surface: the sibling overage
    // is restated at the write, on top of the sweep's own line.
    expect(warns).toContain(
      'TRA-4156 a SIBLING ledger pool evicted during this write — this closes/ census is COMPLETE',
    );
    expect(warns).toContain('TRA-4156 per-directory ledger budget exceeded — evicted oldest sessions');
  });

  it('TRA-4503 — a closes/ eviction DOES still mark the census INCOMPLETE', async () => {
    // The negative control for the narrowing above: when this file's own pool
    // is the one paying, the original warn must be unchanged.
    const dir = bucket();
    const closes = join(dir, CLOSE_LEDGER_DIR);
    await mkdir(closes, { recursive: true });
    const blob = 'x'.repeat(4000);
    await writeFile(join(closes, '2026-01-01.json'), blob, 'utf-8');

    const warns: string[] = [];
    const w = await writeCloseLedger({
      targetDir: dir, date: '2026-08-11', symbols: [sym({ symbol: 'A' })], usersRoot: usersRoot(),
      limits: { closes: 2500 },
      log: { warn: (m: string) => warns.push(m), info: () => {} },
    });
    expect(w.aggregateByDir?.closes.pruned).toBeGreaterThan(0);
    expect(warns).toContain(
      'TRA-2688 close ledger is INCOMPLETE or evicted under budget — do not read it as a full census',
    );
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
// TRA-4898 — the real-money reservation INSIDE the closes/ pool
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-4898 — the live book is last in the eviction queue, not second', () => {
  /** Write `n` bytes at `<book>/<root>/<mode>/<kind>/<date>.json`. */
  async function plant(
    book: string, mode: string, date: string, bytes = 1000,
    kind = CLOSE_LEDGER_DIR, root = 'reports',
  ): Promise<string> {
    const dir = join(usersRoot(), book, root, mode, kind);
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${date}.json`);
    await writeFile(p, 'x'.repeat(bytes), 'utf-8');
    return p;
  }
  const names = async (book: string, mode: string, kind = CLOSE_LEDGER_DIR, root = 'reports') =>
    (await readdir(join(usersRoot(), book, root, mode, kind))).sort();

  it('AC2 negative control — the live book holds the OLDEST date and survives while QA books are unlinked', async () => {
    // This is the AC that fails on `main`: pre-TRA-4898 the comparator was
    // (date, path), so the oldest date went first no matter who wrote it — and
    // the live book here holds it. `Richard` is planted because it is the one
    // book that sorts ahead of `admin` on the path tie-break; the measured
    // 2026-09-25 ordering put the real-money book 2nd of 68.
    await plant('admin', 'live', '2026-01-01');       // OLDEST in the pool
    await plant('Richard', 'demo', '2026-06-03');
    await plant('qa_alpha', 'demo', '2026-06-01');
    await plant('qtverify_7', 'demo', '2026-06-02');

    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 2500, tape: 2500 },
    });

    expect(r.sweep).toBe('ran');
    expect(r.pruned).toBe(2);
    // The real-money session is untouched despite being the oldest file present.
    expect(await names('admin', 'live')).toEqual(['2026-01-01.json']);
    // The two oldest NON-LIVE sessions paid instead, oldest-first among them.
    expect(await names('qa_alpha', 'demo')).toEqual([]);
    expect(await names('qtverify_7', 'demo')).toEqual([]);
    expect(await names('Richard', 'demo')).toEqual(['2026-06-03.json']);
    expect(r.byDir?.closes).toEqual({ bytes: 2000, maxBytes: 2500, pruned: 2 });
  });

  it('the reservation is an ORDERING, not a carve-out — a pool of only live files still holds its ceiling', async () => {
    // A reserved QUOTA would leave nothing deletable and the pool permanently
    // over cap. Ordering degrades: the live files pay, oldest-first…
    await plant('admin', 'live', '2026-01-01');
    await plant('admin', 'live', '2026-01-02');
    await plant('admin', 'live', '2026-01-03');

    const warns: Array<[string, unknown]> = [];
    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 2500, tape: 2500 },
      log: { warn: (m: string, c?: unknown) => warns.push([m, c]), info: () => {} },
    });

    expect(r.pruned).toBe(1);
    expect(await names('admin', 'live')).toEqual(['2026-01-02.json', '2026-01-03.json']);
    // …and it says so with its own line, because "the reservation was
    // EXHAUSTED" is a different fact from an ordinary overage: the remedy is
    // capacity or a reap of the dead books, never a re-ordering.
    const live = warns.find(([m]) =>
      m === 'TRA-4898 a REAL-MONEY (live) ledger file was evicted — every non-live file in this pool was already gone');
    expect(live).toBeDefined();
    expect((live?.[1] as { prunedLive: number }).prunedLive).toBe(1);
  });

  it('a mixed pool exhausts every non-live file BEFORE the first live one', async () => {
    await plant('admin', 'live', '2026-01-01');       // oldest overall
    await plant('qa_alpha', 'demo', '2026-06-01');
    await plant('qa_beta', 'sandbox', '2026-06-02');
    // Needs 3 of 4 gone: both QA files, then the live one — in that order.
    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 500, tape: 500 },
    });
    expect(r.pruned).toBe(3);
    expect(await names('admin', 'live')).toEqual([]);
    expect(await names('qa_alpha', 'demo')).toEqual([]);
    expect(await names('qa_beta', 'sandbox')).toEqual([]);
  });

  it('crypto-reports/live is reserved too, and a non-live crypto book is not', async () => {
    await plant('admin', 'live', '2026-01-01', 1000, CLOSE_LEDGER_DIR, 'crypto-reports');
    await plant('qa_alpha', 'demo', '2026-06-01', 1000, CLOSE_LEDGER_DIR, 'crypto-reports');
    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 1500, tape: 1500 },
    });
    expect(r.pruned).toBe(1);
    expect(await names('admin', 'live', CLOSE_LEDGER_DIR, 'crypto-reports')).toEqual(['2026-01-01.json']);
    expect(await names('qa_alpha', 'demo', CLOSE_LEDGER_DIR, 'crypto-reports')).toEqual([]);
  });

  it('AC3 — the eviction warn names the book, root and mode it deleted from', async () => {
    await plant('qa_alpha', 'demo', '2026-06-01');
    await plant('qa_alpha', 'demo', '2026-06-02');
    await plant('qtverify_7', 'demo', '2026-06-03');
    await plant('admin', 'live', '2026-06-04');

    const warns: Array<[string, unknown]> = [];
    await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-08-11', force: true,
      limits: { closes: 1500, tape: 1500 },
      log: { warn: (m: string, c?: unknown) => warns.push([m, c]), info: () => {} },
    });

    const overage = warns.find(([m]) =>
      m === 'TRA-4156 per-directory ledger budget exceeded — evicted oldest sessions');
    expect(overage).toBeDefined();
    const ctx = overage?.[1] as {
      dir: string; prunedLive: number; liveFilesInPool: number; evictedFromBooks: number;
      evictedFrom: Array<{ book: string; root: string; mode: string; files: number; oldest: string; newest: string }>;
    };
    expect(ctx.dir).toBe('closes');
    expect(ctx.prunedLive).toBe(0);
    expect(ctx.liveFilesInPool).toBe(1);
    // One line, and it attributes every deletion: 2 from qa_alpha, 1 from qtverify_7.
    expect(ctx.evictedFromBooks).toBe(2);
    // TRA-5036 adds `inRegistry` per entry — `null` here because this case
    // asserts no roster, which is exactly the reading "not asserted".
    expect(ctx.evictedFrom).toEqual([
      { book: 'qa_alpha', root: 'reports', mode: 'demo', live: false, inRegistry: null, files: 2, bytes: 2000, oldest: '2026-06-01.json', newest: '2026-06-02.json' },
      { book: 'qtverify_7', root: 'reports', mode: 'demo', live: false, inRegistry: null, files: 1, bytes: 1000, oldest: '2026-06-03.json', newest: '2026-06-03.json' },
    ]);
  });

  it('the comparator itself: non-live before live, then date, then path', () => {
    const f = (book: string, mode: string, name: string) => ({
      path: `/users/${book}/reports/${mode}/closes/${name}`,
      name, size: 1, book, root: 'reports', mode, live: mode === 'live', mtimeMs: 0, digest: null,
      // TRA-5036 — `null` is "no roster asserted", which must reproduce the
      // TRA-4898 ordering exactly. That is what this case now also pins.
      inRegistry: null,
    });
    const sorted = [
      f('admin', 'live', '2020-01-01.json'),
      f('zz_qa', 'demo', '2026-06-02.json'),
      f('aa_qa', 'demo', '2026-06-02.json'),
      f('other', 'live', '2019-01-01.json'),
    ].sort(compareLedgerEviction).map((x) => x.path);
    expect(sorted).toEqual([
      '/users/aa_qa/reports/demo/closes/2026-06-02.json',   // non-live first…
      '/users/zz_qa/reports/demo/closes/2026-06-02.json',   // …ties on path
      '/users/other/reports/live/closes/2019-01-01.json',   // live last, oldest first
      '/users/admin/reports/live/closes/2020-01-01.json',
    ]);
  });

  it('AC4 — the census attributes pool bytes per book, and previews the eviction queue', async () => {
    await plant('admin', 'live', '2026-01-01', 1000);
    await plant('qa_alpha', 'demo', '2026-06-01', 3000);
    await plant('qa_alpha', 'demo', '2026-06-02', 1000);
    await plant('qtverify_7', 'demo', '2026-06-03', 500);
    await plant('qa_alpha', 'demo', '2026-06-01', 700, 'tape');

    const s = await summarizeLedgerPools({ usersRoot: usersRoot() });
    const closes = s.dirs.closes;
    expect(closes.bytes).toBe(5500);
    expect(closes.files).toBe(4);
    // The reserved class is measured separately — that is the number that says
    // how much of the ceiling the reservation can ever be asked to hold.
    expect(closes.liveBytes).toBe(1000);
    expect(closes.liveFiles).toBe(1);
    expect(closes.books.map((b) => [b.book, b.mode, b.files, b.bytes])).toEqual([
      ['qa_alpha', 'demo', 2, 4000],
      ['admin', 'live', 1, 1000],
      ['qtverify_7', 'demo', 1, 500],
    ]);
    // The live book is LAST in the queue now, so it cannot appear in a preview
    // that still has non-live files to name.
    expect(closes.nextToEvict.map((f) => `${f.book}/${f.name}`)).toEqual([
      'qa_alpha/2026-06-01.json',
      'qa_alpha/2026-06-02.json',
      'qtverify_7/2026-06-03.json',
      'admin/2026-01-01.json',
    ]);
    // Pools stay separate here too, and nothing was deleted by measuring.
    expect(s.dirs.tape.bytes).toBe(700);
    expect(await names('admin', 'live')).toEqual(['2026-01-01.json']);
  });

  // TRA-4902 — the three axes a reap predicate has to cross. Name pattern is
  // the caller's business; these are the two the box has to supply, plus the
  // fill rate that says whether deleting anything is durable.
  it('TRA-4902 — the census carries registry membership, and an absent roster is NOT "orphaned"', async () => {
    await plant('qa_alpha', 'demo', '2026-06-01');
    await plant('ghost', 'demo', '2026-06-01');

    // Roster supplied: `ghost` has no entry, `qa_alpha` does.
    const asserted = await summarizeLedgerPools({
      usersRoot: usersRoot(), registryBooks: ['qa_alpha', 'someone_with_no_tree'],
    });
    expect(asserted.dirs.closes.books.map((b) => [b.book, b.inRegistry]).sort())
      .toEqual([['ghost', false], ['qa_alpha', true]]);

    // Roster withheld: every row reads `null`. A caller that cannot see the
    // registry must not be handed `false`, which is the reading that argues
    // for deletion.
    const unasserted = await summarizeLedgerPools({ usersRoot: usersRoot() });
    expect(unasserted.dirs.closes.books.every((b) => b.inRegistry === null)).toBe(true);
    // Explicit null is the same abstention as omitting it.
    const nulled = await summarizeLedgerPools({ usersRoot: usersRoot(), registryBooks: null });
    expect(nulled.dirs.closes.books.every((b) => b.inRegistry === null)).toBe(true);
  });

  it('TRA-4902 — `newestMtime` is the MAX mtime, not the last file in eviction order', async () => {
    // Eviction order is (non-live, date, path), so the LAST file this row's
    // loop visits is its NEWEST DATE — which is not the newest write. Plant
    // the fresh mtime on the OLDER date to make the two disagree.
    const older = await plant('qa_alpha', 'demo', '2026-06-01');
    const newer = await plant('qa_alpha', 'demo', '2026-06-09');
    // BOTH get an explicit mtime: a freshly written file's real mtime is
    // `now`, which would dominate the max and make this pass for the wrong
    // reason.
    await utimes(older, new Date('2026-07-01T00:00:00Z'), new Date('2026-07-01T00:00:00Z'));
    await utimes(newer, new Date('2026-06-09T00:00:00Z'), new Date('2026-06-09T00:00:00Z'));

    const s = await summarizeLedgerPools({ usersRoot: usersRoot() });
    const row = s.dirs.closes.books.find((b) => b.book === 'qa_alpha')!;
    // The filename axis and the mtime axis are reported separately and DO
    // disagree here. A predicate that reads only one of them is guessing.
    expect(row.newest).toBe('2026-06-09.json');
    expect(row.newestMtime).toBe('2026-07-01T00:00:00.000Z');
  });

  it('TRA-4902 — `contentDigest` collapses books holding identical ledgers, and is opt-in', async () => {
    // Two QA books written the same empty-book ledger, one real book that
    // actually traded. Same dates, same sizes for the first two.
    for (const book of ['qa_alpha', 'qa_beta']) {
      await plant(book, 'demo', '2026-06-01', 0);
      await plant(book, 'demo', '2026-06-02', 0);
      await writeFile(join(usersRoot(), book, 'reports/demo/closes/2026-06-01.json'), '{"rows":[]}', 'utf-8');
      await writeFile(join(usersRoot(), book, 'reports/demo/closes/2026-06-02.json'), '{"rows":[]}', 'utf-8');
    }
    await plant('enock', 'demo', '2026-06-01', 0);
    await writeFile(join(usersRoot(), 'enock', 'reports/demo/closes/2026-06-01.json'), '{"rows":[1]}', 'utf-8');

    const s = await summarizeLedgerPools({ usersRoot: usersRoot(), withDigests: true });
    const dig = (b: string) => s.dirs.closes.books.find((x) => x.book === b)!.contentDigest;
    // The two QA books are ONE equivalence class: the pool holds their shared
    // ledger twice. That is the reap argument, and no name pattern makes it.
    expect(dig('qa_alpha')).toBe(dig('qa_beta'));
    expect(dig('qa_alpha')).not.toBeNull();
    // The book that actually traded is its own class, and would survive a
    // digest-driven reap even though it is only one file.
    expect(dig('enock')).not.toBe(dig('qa_alpha'));

    // Opt-in: the default walk never reads a file body.
    const cheap = await summarizeLedgerPools({ usersRoot: usersRoot() });
    expect(cheap.dirs.closes.books.every((b) => b.contentDigest === null)).toBe(true);
  });

  it('TRA-4902 — `byDate` reports the fill rate, oldest date first', async () => {
    await plant('qa_alpha', 'demo', '2026-06-02', 1000);
    await plant('qa_beta', 'demo', '2026-06-02', 1500);
    await plant('qa_alpha', 'demo', '2026-06-01', 400);
    await plant('qa_alpha', 'demo', '2026-06-03', 900, 'tape');

    const s = await summarizeLedgerPools({ usersRoot: usersRoot() });
    expect(s.dirs.closes.byDate).toEqual([
      { date: '2026-06-01', bytes: 400, files: 1 },
      { date: '2026-06-02', bytes: 2500, files: 2 },
    ]);
    // Per-pool, like every other figure here.
    expect(s.dirs.tape.byDate).toEqual([{ date: '2026-06-03', bytes: 900, files: 1 }]);
  });

  it('the census never throws on an absent root, and reports the live ceilings', async () => {
    const s = await summarizeLedgerPools({ usersRoot: join(root, 'nope') });
    expect(s.dirs.closes).toMatchObject({ bytes: 0, files: 0, liveBytes: 0, books: [], maxBytes: 48 * 1024 * 1024 });
    expect(s.dirs.tape.maxBytes).toBe(16 * 1024 * 1024);
  });
});

// ────────────────────────────────────────────────────────────────────────────
// TRA-5036 — the registry reservation: the ACTIVE non-live books, behind the
// dead-but-undeleted trees the TRA-4902 ruling left on disk
// ────────────────────────────────────────────────────────────────────────────

describe('TRA-5036 — registered books evict after unregistered ones, and before the live book', () => {
  async function plant(
    book: string, mode: string, date: string, bytes = 1000,
    kind = CLOSE_LEDGER_DIR, root = 'reports',
  ): Promise<string> {
    const dir = join(usersRoot(), book, root, mode, kind);
    await mkdir(dir, { recursive: true });
    const p = join(dir, `${date}.json`);
    await writeFile(p, 'x'.repeat(bytes), 'utf-8');
    return p;
  }
  const names = async (book: string, mode: string, kind = CLOSE_LEDGER_DIR, root = 'reports') =>
    (await readdir(join(usersRoot(), book, root, mode, kind))).sort();

  /** The measured 2026-10-02 shape: 2 active books behind dead QA tape. */
  async function plantBqb1Shape(kind = 'tape'): Promise<void> {
    // The two ACTIVE non-live books. `enock/demo`'s 09-24 file was 3rd in the
    // real queue at 4 writers — the file this ticket exists to keep.
    await plant('enock', 'demo', '2026-09-24', 1000, kind);
    await plant('Richard', 'sandbox', '2026-09-25', 1000, kind);
    // Dead QA trees: DEREGISTERED by TRA-4902 but still on disk by ruling, and
    // holding NEWER session dates, so plain age order puts them last.
    await plant('ctoverify_1', 'demo', '2026-09-30', 1000, kind);
    await plant('qa_alpha', 'demo', '2026-10-01', 1000, kind);
    // Real money, oldest of all — the TRA-4898 tier, which must stay last.
    await plant('admin', 'live', '2026-01-01', 1000, kind);
  }
  const ROSTER = ['enock', 'Richard', 'admin', 'v0nni'];

  it('AC1 negative control — the ACTIVE books hold the oldest dates and survive while dead trees pay', async () => {
    // This is the AC that fails on `main`. Pre-TRA-5036 the first sort key was
    // `live` alone, so among non-live files the oldest date went first no
    // matter whether anything still writes to it — and here the two active
    // books hold the two oldest dates in the pool.
    await plantBqb1Shape();

    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 3500, tape: 3500 },
      registryBooks: ROSTER,
    });

    expect(r.sweep).toBe('ran');
    expect(r.registryAsserted).toBe(true);
    expect(r.pruned).toBe(2);
    // The dead-but-undeleted trees paid, DESPITE holding the newest dates.
    expect(await names('ctoverify_1', 'demo', 'tape')).toEqual([]);
    expect(await names('qa_alpha', 'demo', 'tape')).toEqual([]);
    // Both active books keep their history, and so does real money.
    expect(await names('enock', 'demo', 'tape')).toEqual(['2026-09-24.json']);
    expect(await names('Richard', 'sandbox', 'tape')).toEqual(['2026-09-25.json']);
    expect(await names('admin', 'live', 'tape')).toEqual(['2026-01-01.json']);
  });

  it('scope item 2 — the 64 orphans stay FULLY evictable: an unregistered tree is tier 0, never protected', async () => {
    // The inversion this must not become. Only dead trees in the pool, and the
    // ceiling still binds: a reservation that protected them would leave the
    // sweep with nothing to delete and the pool permanently over cap.
    await plant('ctoverify_1', 'demo', '2026-09-28', 1000, 'tape');
    await plant('ctoverify_2', 'demo', '2026-09-29', 1000, 'tape');
    await plant('qa_alpha', 'demo', '2026-09-30', 1000, 'tape');

    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 1000, tape: 1000 },
      registryBooks: ROSTER,
    });
    expect(r.pruned).toBe(2);
    expect(r.byDir?.tape).toEqual({ bytes: 1000, maxBytes: 1000, pruned: 2 });
    // Oldest-first WITHIN the tier — the reservation reorders tiers, it does
    // not disturb age order inside one.
    expect(await names('ctoverify_1', 'demo', 'tape')).toEqual([]);
    expect(await names('ctoverify_2', 'demo', 'tape')).toEqual([]);
    expect(await names('qa_alpha', 'demo', 'tape')).toEqual(['2026-09-30.json']);
  });

  it('tier 1 sits strictly BETWEEN tier 0 and tier 2 — a registered book pays before real money', async () => {
    // Exhaust the unregistered tier and keep going. The order of the last two
    // deletions is the whole ordering claim: registered non-live, THEN live.
    await plant('admin', 'live', '2026-01-01', 1000, 'tape');
    await plant('enock', 'demo', '2026-09-24', 1000, 'tape');
    await plant('qa_alpha', 'demo', '2026-10-01', 1000, 'tape');

    const warns: Array<[string, unknown]> = [];
    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 500, tape: 500 },
      registryBooks: ROSTER,
      log: { warn: (m: string, c?: unknown) => warns.push([m, c]), info: () => {} },
    });
    expect(r.pruned).toBe(3);
    // …and the registered-tier exhaustion gets its OWN line, distinct from
    // TRA-4898's real-money line: an active demo book losing leg-2 history is
    // not a real-money event and must not page as one.
    const reg = warns.find(([m]) => m.startsWith('TRA-5036 a REGISTERED book'));
    expect(reg).toBeDefined();
    expect((reg?.[1] as { prunedRegistered: number }).prunedRegistered).toBe(1);
    expect((reg?.[1] as { evictedFrom: Array<{ book: string }> }).evictedFrom)
      .toEqual([{ book: 'enock', root: 'reports', mode: 'demo', files: 1, bytes: 1000, oldest: '2026-09-24.json', newest: '2026-09-24.json' }]);
    // TRA-4898's own warn still fires for the live file, unchanged.
    expect(warns.some(([m]) => m.startsWith('TRA-4898 a REAL-MONEY'))).toBe(true);
  });

  it('no roster asserted ⇒ the TRA-4898 ordering EXACTLY, and the sweep says the reservation was inert', async () => {
    // `null` must not read as "registered" — that would protect all 64 dead
    // trees the moment a caller forgot to wire the roster. It must not read as
    // a silent loss of protection either.
    await plantBqb1Shape();

    const warns: Array<[string, unknown]> = [];
    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 3500, tape: 3500 },
      log: { warn: (m: string, c?: unknown) => warns.push([m, c]), info: () => {} },
    });

    expect(r.registryAsserted).toBe(false);
    expect(r.pruned).toBe(2);
    // Pre-TRA-5036 order: oldest non-live dates, which are the ACTIVE books.
    expect(await names('enock', 'demo', 'tape')).toEqual([]);
    expect(await names('Richard', 'sandbox', 'tape')).toEqual([]);
    expect(await names('qa_alpha', 'demo', 'tape')).toEqual(['2026-10-01.json']);
    expect(await names('admin', 'live', 'tape')).toEqual(['2026-01-01.json']);
    // And it is VISIBLE. `prunedRegistered: 0` beside `registryAsserted: false`
    // is a different fact from `0` beside `true`, and the overage line carries
    // both so the two cannot be confused.
    expect(warns.some(([m]) => m.startsWith('TRA-5036 ledger eviction ran with NO users.json roster'))).toBe(true);
    const overage = warns.find(([m]) => m.startsWith('TRA-4156 per-directory'));
    expect(overage?.[1]).toMatchObject({ registryAsserted: false, prunedRegistered: 0, registeredFilesInPool: 0 });
  });

  it('AC3 — the PUBLISHED queue is gradable: zero registered rows ahead of any unregistered row, both pools', async () => {
    await plantBqb1Shape('tape');
    await plantBqb1Shape(CLOSE_LEDGER_DIR);

    const s = await summarizeLedgerPools({ usersRoot: usersRoot(), registryBooks: ROSTER, evictionPreview: 50 });
    expect(s.registryAsserted).toBe(true);

    for (const kind of ['closes', 'tape'] as const) {
      const q = s.dirs[kind].nextToEvict;
      expect(q.length).toBe(5);
      // The grading predicate, stated as the AC states it.
      const firstRegistered = q.findIndex((f) => f.inRegistry === true);
      const lastUnregistered = q.map((f) => f.inRegistry === false).lastIndexOf(true);
      expect(firstRegistered).toBeGreaterThan(lastUnregistered);
      // Tiers are monotonically non-decreasing down the queue, and the live
      // file is still strictly last (TRA-4898 keeps its exact position).
      expect(q.map((f) => f.evictionTier)).toEqual([0, 0, 1, 1, 2]);
      expect(q[q.length - 1]).toMatchObject({ book: 'admin', mode: 'live', live: true });
      // The reserved classes are sized separately and do not double-count.
      expect(s.dirs[kind].registeredFiles).toBe(2);
      expect(s.dirs[kind].liveFiles).toBe(1);
      expect(s.dirs[kind].registeredBytes).toBe(2000);
    }
    // The census row carries the tier beside the rank, so WHICH reservation
    // placed a row is readable without re-deriving the predicate.
    const enock = s.dirs.tape.books.find((b) => b.book === 'enock');
    expect(enock).toMatchObject({ inRegistry: true, evictionTier: 1 });
    expect(s.dirs.tape.books.find((b) => b.book === 'qa_alpha'))
      .toMatchObject({ inRegistry: false, evictionTier: 0 });
  });

  it('AC3 is graded off the UNCAPPED queue, not off the capped preview', async () => {
    // The bqb1 failure mode for a prefix-grader: the queue head is all dead QA
    // tape, so the default 10-entry preview contains ZERO registered rows and a
    // preview-grader reports "no registered row ahead of an unregistered one"
    // — vacuously, forever, whether or not the reservation shipped.
    for (let i = 0; i < 12; i += 1) {
      await plant(`ctoverify_${i}`, 'demo', `2026-09-${String(i + 10).padStart(2, '0')}`, 100, 'tape');
    }
    await plant('enock', 'demo', '2026-09-24', 100, 'tape');
    await plant('admin', 'live', '2026-01-01', 100, 'tape');

    const s = await summarizeLedgerPools({ usersRoot: usersRoot(), registryBooks: ROSTER });
    // The preview really is blind here — that is the premise, pinned.
    expect(s.dirs.tape.nextToEvict.length).toBe(10);
    expect(s.dirs.tape.nextToEvict.some((f) => f.inRegistry === true)).toBe(false);
    // …and the uncapped measurement is not.
    expect(s.dirs.tape.queueOrdering).toEqual({
      firstRegisteredRank: 13,
      lastUnregisteredRank: 12,
      firstLiveRank: 14,
      lastNonLiveRank: 13,
      registeredAheadOfUnregistered: 0,
      liveAheadOfNonLive: 0,
      tiersMonotone: true,
      registeredFiles: 1,
    });
  });

  it('the AC3 measurement DETECTS a violation — it is not a predicate that only ever returns 0', async () => {
    // A grader that cannot fail is not a grader. Feed `measureLedgerQueueOrdering`
    // the pre-TRA-5036 order (date-only among non-live) over the measured bqb1
    // shape and it must report the inversion, with its magnitude.
    const f = (book: string, mode: string, name: string, inRegistry: boolean | null) => ({
      path: `/users/${book}/reports/${mode}/tape/${name}`,
      name, size: 1, book, root: 'reports', mode, live: mode === 'live',
      mtimeMs: 0, digest: null, inRegistry,
    });
    const preTra5036 = [
      f('enock', 'demo', '2026-09-24.json', true),       // active, oldest date
      f('Richard', 'sandbox', '2026-09-25.json', true),  // active
      f('ctoverify_1', 'demo', '2026-09-30.json', false),// dead, newer date
      f('admin', 'live', '2026-01-01.json', true),
    ];
    const bad = measureLedgerQueueOrdering(preTra5036);
    expect(bad.registeredAheadOfUnregistered).toBe(2);
    expect(bad.tiersMonotone).toBe(false);
    expect(bad.firstRegisteredRank).toBe(1);
    expect(bad.lastUnregisteredRank).toBe(3);
    // Re-sorting the SAME files with the shipped comparator clears it, so the
    // difference is the comparator and nothing else in the fixture.
    const good = measureLedgerQueueOrdering([...preTra5036].sort(compareLedgerEviction));
    expect(good.registeredAheadOfUnregistered).toBe(0);
    expect(good.liveAheadOfNonLive).toBe(0);
    expect(good.tiersMonotone).toBe(true);
  });

  it('an unasserted census publishes tier 0/2 only, so AC3 cannot pass vacuously unnoticed', async () => {
    await plantBqb1Shape('tape');
    const s = await summarizeLedgerPools({ usersRoot: usersRoot() });
    expect(s.registryAsserted).toBe(false);
    expect(s.dirs.tape.nextToEvict.every((f) => f.inRegistry === null)).toBe(true);
    expect(s.dirs.tape.nextToEvict.map((f) => f.evictionTier)).toEqual([0, 0, 0, 0, 2]);
    expect(s.dirs.tape.registeredFiles).toBe(0);
    expect(s.dirs.tape.registeredBytes).toBe(0);
  });

  it('crypto-reports is tiered the same way — the registry axis is per BOOK, not per root', async () => {
    await plant('enock', 'demo', '2026-09-24', 1000, 'tape', 'crypto-reports');
    await plant('qa_alpha', 'demo', '2026-10-01', 1000, 'tape', 'crypto-reports');
    const r = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 1500, tape: 1500 },
      registryBooks: ROSTER,
    });
    expect(r.pruned).toBe(1);
    expect(await names('enock', 'demo', 'tape', 'crypto-reports')).toEqual(['2026-09-24.json']);
    expect(await names('qa_alpha', 'demo', 'tape', 'crypto-reports')).toEqual([]);
  });

  it('the reservation changes WHO pays, never HOW MUCH is kept', async () => {
    // Same invariant TRA-4898 pinned, re-pinned across the new tier: the
    // post-sweep total is a function of the ceiling alone, so this cannot grow
    // the footprint (the out-of-scope line CFO drew on TRA-4156 Phase 2).
    await plantBqb1Shape();
    const withRoster = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 3500, tape: 3500 }, registryBooks: ROSTER,
    });
    rmSync(usersRoot(), { recursive: true, force: true });
    await plantBqb1Shape();
    const without = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(), date: '2026-10-05', force: true,
      limits: { closes: 3500, tape: 3500 },
    });
    expect(withRoster.byDir?.tape).toEqual(without.byDir?.tape);
    expect(withRoster.pruned).toBe(without.pruned);
  });

  it('the writer forwards the roster — the production path is wired, not just the sweep', async () => {
    // `writeCloseLedger` is the ONLY production caller of the sweep, so the
    // reservation is only in force if the roster reaches it through here.
    await plant('enock', 'demo', '2026-09-24', 1000, 'tape');
    await plant('qa_alpha', 'demo', '2026-10-01', 1000, 'tape');
    const res = await writeCloseLedger({
      targetDir: join(usersRoot(), 'admin', 'reports', 'live'),
      date: '2026-10-05',
      symbols: [sym({ symbol: 'AAPL' })],
      usersRoot: usersRoot(),
      limits: { closes: 48 * 1024 * 1024, tape: 1500 },
      registryBooks: ROSTER,
    });
    expect(res.written).toBe(true);
    expect(await names('enock', 'demo', 'tape')).toEqual(['2026-09-24.json']);
    expect(await names('qa_alpha', 'demo', 'tape')).toEqual([]);
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
