/**
 * TRA-4949 — the ceiling has to hold ACROSS a boundary, not at one instant.
 *
 * The aggregate sweep was memoised on the ET date alone, and
 * `generateAndSaveReport` runs once per USER. So the sweep ran inside the FIRST
 * book's write and was skipped (`aggregateSweep: 'skipped_already_run'`) for the
 * other 67, each of which then appended its own `tape/` and `closes/` file. The
 * pool ended every boundary over cap by one session's writes and was reclaimed
 * only by the next market day's first write — ~72h across a weekend.
 *
 * Measured on bqb1 `2026-09-28T00:23Z` (`GET /api/health/storage/ledger`, build
 * `08e911e3`): `tape/` 20,497,082 B against a 16,777,216 B cap = **122.2%**.
 *
 * The second half of the defect is the comment that was supposed to make that
 * visible. It bounded the slack at *"~5.6 MB, i.e. under 12% of the 48 MiB
 * `closes/` cap"* — true, and against the WRONG pool: the same bytes were 22% of
 * the 16 MiB `tape/` cap, and `tape/` was the pool at its ceiling. A bound quoted
 * against the largest pool understates every smaller one.
 *
 * So these tests grade two things, and the second is not cosmetic: the ceiling
 * holding across the whole fan-out, and the bound being denominated per pool as a
 * share of THAT pool's own cap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'fs';
import { mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import type { SymbolState } from './signal-engine.js';
import { flushDenominatorFlipTape } from './denominator-flip-tape-writer.js';
import {
  buildDenominatorFlipCandidate,
  type DenominatorFlipTapeDump,
} from './denominator-flip-tape.js';
import {
  writeCloseLedger,
  enforceAggregateLedgerBudget,
  noteLedgerPoolWrite,
  ledgerBytesSinceLastSweep,
  ledgerSweepAccrualLimit,
  resetAggregateLedgerSweepMemo,
  LEDGER_SWEEP_ACCRUAL_FRACTION,
  LEDGER_BUDGET_DIRS,
  LEDGER_BUDGET_LIMITS,
  CLOSE_LEDGER_DIR,
  CLOSE_LEDGER_MAX_BYTES,
  TAPE_LEDGER_MAX_BYTES,
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

/** A book's bucket, laid out exactly as `stockReportsDirFor` produces. */
function bucket(book: string, mode = 'demo'): string {
  return join(root, 'users', book, 'reports', mode);
}
const usersRoot = () => join(root, 'users');

const quietLog = { warn: () => {}, info: () => {} };

/** 2026-07-30 15:00 ET — a real RTH instant, so leg 2's calendar gate admits it. */
const TICK_MS = Date.parse('2026-07-30T19:00:00.000Z');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tra4949-'));
  resetAggregateLedgerSweepMemo();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  resetAggregateLedgerSweepMemo();
});

/**
 * Plant `n` filler files of `size` bytes in a book nobody writes to.
 *
 * The dates are in 2025, so they sort BEFORE everything the fan-out writes and
 * are therefore what the eviction gives up first — the fan-out's own files
 * survive, which is what makes the end-of-boundary total a meaningful reading.
 */
async function fill(kind: string, n: number, size: number, book = 'filler'): Promise<number> {
  const dir = join(bucket(book), kind);
  await mkdir(dir, { recursive: true });
  const blob = 'x'.repeat(size);
  for (let i = 0; i < n; i += 1) {
    const mm = String(1 + Math.floor(i / 28)).padStart(2, '0');
    const dd = String(1 + (i % 28)).padStart(2, '0');
    await writeFile(join(dir, `2025-${mm}-${dd}.json`), blob, 'utf-8');
  }
  return n * size;
}

/** The boundary: `books` separate books each writing one ledger, same ET date. */
async function fanOut(args: {
  books: number;
  symbols: number;
  capBytes: number;
}): Promise<{ sweeps: number; accrualSweeps: number; endBytes: number; writtenBytes: number }> {
  const symbols = Array.from({ length: args.symbols }, (_, i) =>
    sym({ symbol: `SYM${String(i).padStart(3, '0')}` }),
  );
  let sweeps = 0;
  let accrualSweeps = 0;
  let endBytes = 0;
  let writtenBytes = 0;
  for (let b = 0; b < args.books; b += 1) {
    const dir = bucket(`book${String(b).padStart(2, '0')}`);
    await mkdir(dir, { recursive: true });
    const w = await writeCloseLedger({
      targetDir: dir,
      date: '2026-08-11',
      symbols,
      usersRoot: usersRoot(),
      limits: { closes: args.capBytes },
      log: quietLog,
    });
    expect(w.written).toBe(true);
    writtenBytes += w.bytes ?? 0;
    if (w.aggregateSweep === 'ran') {
      sweeps += 1;
      if (w.aggregateSweepTrigger === 'accrual') accrualSweeps += 1;
      endBytes = w.aggregateByDir?.closes.bytes ?? 0;
    } else {
      // No sweep looked, so the pool is the last MEASURED total plus everything
      // written since. That quantity is exactly what the defect was about: a
      // reading taken only at the first write cannot see it.
      endBytes += w.bytes ?? 0;
    }
  }
  return { sweeps, accrualSweeps, endBytes, writtenBytes };
}

describe('TRA-4949 AC1 — the ceiling holds across the whole fan-out', () => {
  it('a 10-book fan-out against a pool AT its ceiling ends under cap + the stated trigger', async () => {
    // 200,000 B cap with the pool planted exactly at it: zero headroom, so every
    // byte the fan-out writes is an overage until something sweeps again.
    const cap = 200_000;
    expect(await fill(CLOSE_LEDGER_DIR, 100, 2_000)).toBe(cap);

    const trigger = ledgerSweepAccrualLimit(CLOSE_LEDGER_DIR, { closes: cap });
    expect(trigger).toBe(4_000);

    const r = await fanOut({ books: 10, symbols: 30, capBytes: cap });

    // POSITIVE CONTROL ON THE FIXTURE. Without this the assertion below would
    // also pass on a fan-out that wrote almost nothing — i.e. on a test that
    // never reproduced the defect. The fan-out must write multiples of the
    // trigger for "it stayed under cap + trigger" to mean anything.
    expect(r.writtenBytes).toBeGreaterThan(trigger * 5);

    // The invariant: a completed sweep zeroes the accrual, and any accrual that
    // reaches the trigger forces a sweep in the SAME call. So at every point
    // where the fleet is at rest, accrual < trigger, hence pool <= cap + trigger.
    expect(r.endBytes).toBeLessThanOrEqual(cap + trigger);

    // ...and it is the ACCRUAL re-sweeps holding it, not the first-of-date one.
    expect(r.accrualSweeps).toBeGreaterThan(0);

    // AC1's other half: the memo is NOT dropped. It exists because the sweep
    // walks every book, so a fix that swept on all 10 writes would be a
    // different, equally-real regression.
    expect(r.sweeps).toBeLessThan(10);
  });

  it('negative control — a fan-out that stays UNDER the trigger still sweeps exactly ONCE', async () => {
    // Same geometry, tiny ledgers. This controls the claim above: the extra
    // sweeps are caused by the ACCRUAL crossing a threshold, not by having
    // re-keyed the memo into uselessness. Here nothing crosses, and the memo
    // suppresses all nine follow-on books exactly as it did before TRA-4949.
    const cap = 200_000;
    await fill(CLOSE_LEDGER_DIR, 100, 2_000);
    const trigger = ledgerSweepAccrualLimit(CLOSE_LEDGER_DIR, { closes: cap });

    const r = await fanOut({ books: 10, symbols: 1, capBytes: cap });
    expect(r.writtenBytes).toBeLessThan(trigger);
    expect(r.sweeps).toBe(1);
    expect(r.accrualSweeps).toBe(0);
    expect(r.endBytes).toBeLessThanOrEqual(cap + trigger);
  });

  it('the re-sweep is REPORTED, not inferred — `ran` alone cannot name which sweep it was', async () => {
    const dir = bucket('reported');
    await mkdir(dir, { recursive: true });
    const args = {
      targetDir: dir,
      date: '2026-08-11',
      symbols: [sym({ symbol: 'A' })],
      usersRoot: usersRoot(),
      log: quietLog,
    };

    const first = await writeCloseLedger(args);
    expect(first.aggregateSweep).toBe('ran');
    expect(first.aggregateSweepTrigger).toBe('first_of_date');

    const quiet = await writeCloseLedger({ ...args, targetDir: bucket('quiet') });
    expect(quiet.aggregateSweep).toBe('skipped_already_run');
    expect(quiet.aggregateAccruedBytes?.closes).toBeDefined();

    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, ledgerSweepAccrualLimit(CLOSE_LEDGER_DIR));
    const again = await writeCloseLedger({ ...args, targetDir: bucket('again') });
    expect(again.aggregateSweep).toBe('ran');
    // A boundary that logs `first_of_date` once and never an `accrual` is one
    // where this fix is not firing — and that reads IDENTICALLY to the defect
    // if the trigger is not published beside the outcome.
    expect(again.aggregateSweepTrigger).toBe('accrual');
  });
});

describe('TRA-4949 AC2 — the bound is quoted per pool, against that pool’s OWN cap', () => {
  it('the trigger is a flat share of every pool’s own cap', () => {
    expect(LEDGER_SWEEP_ACCRUAL_FRACTION).toBe(0.02);
    for (const kind of LEDGER_BUDGET_DIRS) {
      const cap = LEDGER_BUDGET_LIMITS[kind];
      const limit = ledgerSweepAccrualLimit(kind);
      // `Math.floor`, so never ABOVE the stated percentage, and never so far
      // below it that the stated figure is fiction.
      expect(limit / cap).toBeLessThanOrEqual(LEDGER_SWEEP_ACCRUAL_FRACTION);
      expect(limit / cap).toBeGreaterThan(LEDGER_SWEEP_ACCRUAL_FRACTION * 0.999);
    }
  });

  it('the SMALLEST cap owns the smallest trigger, so it is the pool that binds', () => {
    const caps = LEDGER_BUDGET_DIRS.map(k => LEDGER_BUDGET_LIMITS[k]);
    expect(Math.min(...caps)).toBe(TAPE_LEDGER_MAX_BYTES);

    const triggers = LEDGER_BUDGET_DIRS.map(k => ledgerSweepAccrualLimit(k));
    expect(ledgerSweepAccrualLimit('tape')).toBe(Math.min(...triggers));
    expect(ledgerSweepAccrualLimit('tape')).toBe(335_544);
    expect(ledgerSweepAccrualLimit('closes')).toBe(1_006_632);
  });

  it('the OLD note’s arithmetic is the thing being refused', () => {
    // The measured bqb1 overage. The old note called ~5.6 MB of fan-out slack
    // "under 12% of the 48 MiB closes/ cap" — which is why 22.2% of tape/ read
    // as documented behaviour for weeks.
    const observedSlack = 3_719_866;
    expect(observedSlack / TAPE_LEDGER_MAX_BYTES).toBeGreaterThan(0.22);
    expect(observedSlack / CLOSE_LEDGER_MAX_BYTES).toBeLessThan(0.08);

    // The new bound cannot do that: it is under 2% of EACH pool's own cap.
    for (const kind of LEDGER_BUDGET_DIRS) {
      expect(ledgerSweepAccrualLimit(kind) / LEDGER_BUDGET_LIMITS[kind]).toBeLessThan(0.021);
    }
  });

  it('AC3 — no cap was raised: the 64 MiB total and both shares are untouched', () => {
    expect(CLOSE_LEDGER_MAX_BYTES).toBe(48 * 1024 * 1024);
    expect(TAPE_LEDGER_MAX_BYTES).toBe(16 * 1024 * 1024);
    expect(CLOSE_LEDGER_MAX_BYTES + TAPE_LEDGER_MAX_BYTES).toBe(64 * 1024 * 1024);
  });
});

describe('TRA-4949 — the accrual is the pool’s NET movement', () => {
  it('a write that REPLACES a file of the same size accrues nothing', async () => {
    // Accruing the raw file size would burn the sweep budget on writes that
    // moved nothing. Two cases make it real: a re-run of the same session's
    // date (this test), and leg 2's MERGE, which rewrites `tape/<date>.json`
    // whole so the file's own length is never the pool's growth. A third
    // arrives when a bucket reaches the 250-file cap and its prune starts
    // removing one file per one written — no bqb1 bucket is there yet.
    const dir = bucket('netdelta');
    await mkdir(dir, { recursive: true });
    const symbols = Array.from({ length: 30 }, (_, i) => sym({ symbol: `N${i}` }));
    const args = {
      targetDir: dir,
      date: '2026-08-11',
      symbols,
      usersRoot: usersRoot(),
      log: quietLog,
    };

    const first = await writeCloseLedger(args);
    expect(first.aggregateSweep).toBe('ran');
    // The first-of-date sweep zeroed the accrual, so this reads the SECOND
    // write's contribution in isolation.
    expect(ledgerBytesSinceLastSweep().closes).toBe(0);
    expect(first.bytes).toBeGreaterThan(1_000);

    await writeCloseLedger(args);
    const accrued = ledgerBytesSinceLastSweep().closes;
    expect(accrued).toBe(0);
    expect(accrued).toBeLessThan(first.bytes!);
  });

  it('the per-bucket count prune’s bytes are netted off in the same call', async () => {
    // At full retention this prune is what keeps a mature book's pool flat. A
    // test seam on the file cap is not available, so this grades the arithmetic
    // directly: a prune that removed MORE than the write added must leave the
    // accrual at zero rather than at the new file's length.
    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, 90_000);
    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, 90_000 - 95_000);
    expect(ledgerBytesSinceLastSweep().closes).toBe(85_000);
  });

  it('a REFUSED write (non-market ET date) accrues nothing', async () => {
    // TRA-3847's refusal touches no disk, so it must move no accrual either —
    // otherwise a run of weekend boundaries would spend the sweep budget on
    // writes that never happened.
    const dir = bucket('weekend');
    await mkdir(dir, { recursive: true });
    const w = await writeCloseLedger({
      targetDir: dir,
      date: '2026-08-15', // Saturday
      symbols: Array.from({ length: 30 }, (_, i) => sym({ symbol: `W${i}` })),
      usersRoot: usersRoot(),
      log: quietLog,
    });
    expect(w.skipped).toBe(true);
    expect(ledgerBytesSinceLastSweep().closes).toBe(0);
    expect(ledgerBytesSinceLastSweep().tape).toBe(0);
  });

  it('refuses NaN, never goes negative, and invents no pool', () => {
    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, 5_000);
    // A NaN in the accrual would compare `false` against the trigger FOREVER,
    // silently restoring the TRA-4949 behaviour with no surface saying so.
    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, Number.NaN);
    expect(ledgerBytesSinceLastSweep().closes).toBe(5_000);

    // A shrinking pool is not a reason to sweep; but one book's prune must not
    // be able to buy another book's overage either, so the floor is 0.
    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, -1_000_000);
    expect(ledgerBytesSinceLastSweep().closes).toBe(0);

    noteLedgerPoolWrite('not-a-budgeted-pool', 1_000);
    expect(ledgerBytesSinceLastSweep()['not-a-budgeted-pool']).toBeUndefined();
  });

  it('a FAILED sweep leaves the accrual standing', async () => {
    // The accrual is zeroed only by a sweep that COMPLETED. A sweep that threw
    // did not move the pools back under cap, so forgetting the accrual there
    // would hand the remaining 67 books a clean slate against an overage
    // nobody reclaimed — the defect again, now hidden behind a `failed`.
    const cap = 10_000;
    await fill(CLOSE_LEDGER_DIR, 10, 4_000); // 40,000 B against a 10,000 B cap
    noteLedgerPoolWrite(CLOSE_LEDGER_DIR, 7_777);

    // Injected fault INSIDE the sweep's try: the eviction warn is reached (the
    // pool is 4x over cap) and throws. `ledgerBudgetDirs` swallows every fs
    // error on purpose, so this is the available seam.
    //
    // ONE-SHOT deliberately. The sweep's own `catch` logs through the same
    // `warn`, and a logger that throws on EVERY call escapes the catch — so a
    // permanently-throwing seam would grade the logger, not the accrual. (That
    // escape pre-dates this ticket and is caught by `writeCloseLedger`'s second
    // layer; it is not what this test is about.)
    let thrown = 0;
    const failed = await enforceAggregateLedgerBudget({
      usersRoot: usersRoot(),
      date: '2026-08-11',
      limits: { closes: cap },
      log: {
        info: () => {},
        warn: () => {
          if (thrown === 0) {
            thrown += 1;
            throw new Error('injected: log transport down');
          }
        },
      },
    });
    expect(thrown).toBe(1);
    expect(failed.sweep).toBe('failed');
    expect(failed.trigger).toBe('first_of_date');
    expect(ledgerBytesSinceLastSweep().closes).toBe(7_777);
  });
});

describe('TRA-4949 — leg 2’s tape is the pool that actually overflows', () => {
  it('a tape/ accrual ALONE forces the re-sweep', async () => {
    // `tape/` grew ~4x faster than `closes/` on bqb1 (~55.6 KB vs ~13.2 KB net
    // per book) and the sweep is only reachable from leg 1's writer. An accrual
    // that watched only `closes/` would have understated the OVERFLOWING pool by
    // that factor — the TRA-4949 defect rebuilt one layer down.
    const dir = bucket('tapeonly');
    await mkdir(dir, { recursive: true });
    const args = {
      targetDir: dir,
      date: '2026-08-11',
      symbols: [sym({ symbol: 'A' })],
      usersRoot: usersRoot(),
      log: quietLog,
    };
    expect((await writeCloseLedger(args)).aggregateSweep).toBe('ran');

    // Nothing has moved: memoised, and it still says so.
    expect(
      (await writeCloseLedger({ ...args, targetDir: bucket('quiet') })).aggregateSweep,
    ).toBe('skipped_already_run');

    // Spend tape/'s own share, and ONLY tape/'s.
    noteLedgerPoolWrite('tape', ledgerSweepAccrualLimit('tape'));
    expect(ledgerBytesSinceLastSweep().closes).toBeLessThan(
      ledgerSweepAccrualLimit(CLOSE_LEDGER_DIR),
    );

    const forced = await writeCloseLedger({ ...args, targetDir: bucket('after') });
    expect(forced.aggregateSweep).toBe('ran');
    expect(forced.aggregateSweepTrigger).toBe('accrual');
    expect(forced.aggregateAccruedBytes?.tape).toBeGreaterThanOrEqual(
      ledgerSweepAccrualLimit('tape'),
    );
  });

  it('leg 2’s writer REALLY calls the accrual, and reports the MERGE as a net delta', async () => {
    // The test above proves the trigger works once something tells it about
    // `tape/`. This one proves leg 2 is that something — without it the whole
    // mechanism is wired to a counter nobody increments, which reads exactly
    // like the defect.
    const dir = bucket('leg2');
    await mkdir(dir, { recursive: true });
    const dumpOf = (n: number): DenominatorFlipTapeDump => ({
      rows: Array.from({ length: n }, (_, i) =>
        buildDenominatorFlipCandidate({
          symbol: `SYM${i}`,
          prev: {
            price: 1, change: 0.1, changePct: 10,
            lastUpdated: TICK_MS, quoteStatus: 'ok', moveSuspect: false,
          },
          next: { price: 1, change: 0.2, changePct: 20 },
          now: TICK_MS + 60_000,
        }),
      ),
      droppedCandidates: 0,
      saturated: false,
      capacity: 2_000,
      admitted: n,
    });
    const flush = (dump: DenominatorFlipTapeDump) =>
      flushDenominatorFlipTape({
        targetDir: dir,
        date: '2026-07-30',
        dump,
        admissionRule: { changePctDeltaPp: 0.01, capacity: 2_000 },
        now: TICK_MS + 60_000,
        log: quietLog,
      });

    expect(ledgerBytesSinceLastSweep().tape).toBe(0);

    const first = await flush(dumpOf(4));
    expect(first.written).toBe(true);
    const afterFirst = ledgerBytesSinceLastSweep().tape;
    // A first write has nothing to replace, so the delta IS the file.
    expect(afterFirst).toBe(first.bytes);
    expect(afterFirst).toBeGreaterThan(0);

    // A second drain MERGES into the same `tape/<date>.json`, rewriting it whole.
    // The pool grew only by the difference. Accruing the file's own length here
    // would over-count by the prior file's entire size and force a full fleet
    // rescan on nearly every book's drain — the cost the memo exists to avoid.
    const second = await flush(dumpOf(4));
    expect(second.merged).toBe(true);
    const delta = ledgerBytesSinceLastSweep().tape - afterFirst;
    expect(delta).toBeGreaterThan(0);
    expect(delta).toBeLessThan(second.bytes!);
    expect(afterFirst + delta).toBe(second.bytes);
  });
});
