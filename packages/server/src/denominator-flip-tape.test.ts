/**
 * TRA-2689 (leg 2 of TRA-2654) — acceptance for the WRITE-ONLY denominator-flip
 * candidate recorder.
 *
 * The four pre-registered acceptance criteria on the ticket are the four
 * `ACCEPTANCE` tests below. Everything else here is a CONTROL, and the controls
 * are deliberately bidirectional: a recorder that admits everything is exactly as
 * unmeasurable as a detector nobody ran, so each arm has a known-good beside its
 * known-bad. The `emits no verdict` block is the boundary check — if it ever goes
 * red, the change has become a detector and is out of boundary.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtemp, readdir, readFile, writeFile, mkdir } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { SignalEngine } from './signal-engine.js';
import {
  DenominatorFlipTape,
  DENOM_FLIP_TAPE_CAPACITY,
  DENOM_FLIP_CHANGEPCT_DELTA_PP,
  buildDenominatorFlipCandidate,
  isDenominatorFlipCandidate,
  type DenominatorFlipCandidate,
} from './denominator-flip-tape.js';
import {
  flushDenominatorFlipTape,
  serializeTapeWithinBudget,
  computeTapeCoverage,
  DENOM_FLIP_TAPE_MAX_FILES,
  type DenominatorFlipTapeFile,
} from './denominator-flip-tape-writer.js';
import { etWallClockToUtcMs } from './et-clock.js';
import {
  summarizeDenominatorFlipTape,
  gradeTapeSession,
  computeBarDays,
  type TapeSessionSummary,
} from './denominator-flip-tape-summary.js';

type QuoteRow = { price: number; volume: number; change: number; changePct: number };
const quotes = (rows: Record<string, QuoteRow>) => new Map(Object.entries(rows));

// `applyQuotes` is private, and the recorder lives inside it by ruling ("quoted
// branch only"). Same deliberate white-box seam the TRA-2610 block already uses.
const applyQuotes = (engine: SignalEngine, q: Map<string, QuoteRow>, active: string[]) =>
  (engine as unknown as { applyQuotes(qq: unknown, a: string[]): Map<string, number> })
    .applyQuotes(q, active);
const drain = (engine: SignalEngine) => engine.drainDenominatorFlipTape();
const rowFor = (engine: SignalEngine, symbol: string) =>
  engine.getState().symbols.find(s => s.symbol === symbol);

/**
 * The FGMC 07-28/29 shape, taken from the live tape TRA-2610 was found on:
 * `price 8.30`, `changePct +110.66` from an unadjusted prev close of 3.94, then
 * the SAME price republished against a corrected denominator.
 *
 * This is the ticket's positive control, and it is a positive control in the
 * strict sense TRA-1727 demands: the pair genuinely CONTAINS a frozen numerator
 * over a moved denominator, which is the only thing the recorder claims to see.
 */
const FGMC_BEFORE = { price: 8.30, volume: 12_000, change: 4.36, changePct: 110.66 };
const FGMC_AFTER = { price: 8.30, volume: 12_000, change: 0.12, changePct: 1.47 };
const AAPL_QUOTE = { price: 338.11, volume: 40_000_000, change: 5.71, changePct: 1.72 };

/** 15:00 ET on 2026-07-28 — mid-session, well clear of any boundary. */
const T_JUL28_1500ET = Date.parse('2026-07-28T19:00:00.000Z');
/** 15:05 ET the SAME day. */
const T_JUL28_1505ET = Date.parse('2026-07-28T19:05:00.000Z');
/** 09:35 ET on 2026-07-29 — the next session. */
const T_JUL29_0935ET = Date.parse('2026-07-29T13:35:00.000Z');

/** Only `Date` is faked: the engine's constructor arms real timers. */
const withClock = (ms: number) => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ms);
};

afterEach(() => {
  vi.useRealTimers();
});

describe('TRA-2689 — the admission rule, stated and pinned', () => {
  const prev = { price: 8.30, change: 4.36, changePct: 110.66, lastUpdated: T_JUL28_1500ET };

  it('ACCEPTANCE: a frozen price with a moved denominator IS a candidate', () => {
    expect(isDenominatorFlipCandidate(prev, FGMC_AFTER)).toBe(true);
  });

  it('KNOWN-GOOD: an identical republish (price AND changePct unchanged) is NOT', () => {
    // The single most common shape on a thin name — a carried-forward or
    // re-served cache row. If this admitted, the tape would be mostly noise and
    // its false-positive rate uninterpretable.
    expect(isDenominatorFlipCandidate(prev, { ...FGMC_BEFORE })).toBe(false);
  });

  it('KNOWN-GOOD: a genuine price move is NOT, however far changePct travelled', () => {
    // Rule 1 is exact equality, so the recorder is silent on every tick where the
    // numerator moved. That is a stated LIMIT of this instrument, not an
    // oversight: day 1 of the fabrication is the frozen-price case.
    expect(isDenominatorFlipCandidate(prev, { price: 8.31, change: 4.37, changePct: 111.0 })).toBe(false);
  });

  it('there is NO eps: one cent on a $8 name already disqualifies', () => {
    expect(isDenominatorFlipCandidate(prev, { price: 8.29, change: 4.35, changePct: 110.0 })).toBe(false);
  });

  it('the changePct threshold is a ROUNDING floor and it is STRICT', () => {
    // Exactly one unit in the last published place is NOT admitted; two are.
    //
    // This arm caught a real defect in the rule as first written. `110.66 + 0.01`
    // is `110.67000000000002`, so `Math.abs(next - prev)` is
    // `0.010000000000019327` and a bare `> 0.01` ADMITTED it — the threshold had
    // silently degraded to "any change at all", which is precisely what it exists
    // to prevent. The predicate now rounds to the published precision first. Do
    // not relax this arm to an approximate compare: the approximation is what the
    // bug looked like.
    const atThreshold = { ...FGMC_BEFORE, changePct: prev.changePct + DENOM_FLIP_CHANGEPCT_DELTA_PP };
    expect(Math.abs(atThreshold.changePct - prev.changePct)).toBeGreaterThan(DENOM_FLIP_CHANGEPCT_DELTA_PP);
    expect(isDenominatorFlipCandidate(prev, atThreshold)).toBe(false);
    const overThreshold = { ...FGMC_BEFORE, changePct: prev.changePct + DENOM_FLIP_CHANGEPCT_DELTA_PP * 2 };
    expect(isDenominatorFlipCandidate(prev, overThreshold)).toBe(true);
  });

  it('sub-rounding jitter below the published precision is NOT admitted', () => {
    // The other direction of the same control: a provider that publishes more
    // than 2 dp must not fill the tape with noise.
    expect(isDenominatorFlipCandidate(prev, { ...FGMC_BEFORE, changePct: prev.changePct + 0.004 })).toBe(false);
  });

  it('a never-quoted prior row (lastUpdated 0) is NOT a prior observation', () => {
    // Boot state carries zeros. Admitting it would manufacture candidates out of
    // the engine starting up, which is the "day 1" hole all over again.
    const boot = { price: 8.30, change: 0, changePct: 0, lastUpdated: 0 };
    expect(isDenominatorFlipCandidate(boot, FGMC_AFTER)).toBe(false);
    expect(isDenominatorFlipCandidate(undefined, FGMC_AFTER)).toBe(false);
  });

  it('a non-finite changePct on either side is NOT admitted', () => {
    expect(isDenominatorFlipCandidate({ ...prev, changePct: NaN }, FGMC_AFTER)).toBe(false);
    expect(isDenominatorFlipCandidate(prev, { ...FGMC_AFTER, changePct: Infinity })).toBe(false);
  });
});

describe('TRA-2689 — the recorder at the feed boundary', () => {
  it('ACCEPTANCE: a frozen-price / moving-denominator pair produces a row with straddlesSessionRollover:false', () => {
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
    vi.setSystemTime(T_JUL28_1505ET);
    applyQuotes(engine, quotes({ FGMC: FGMC_AFTER }), ['FGMC']);

    const dump = drain(engine);
    expect(dump.rows).toHaveLength(1);
    const row = dump.rows[0];
    expect(row.symbol).toBe('FGMC');
    expect(row.straddlesSessionRollover).toBe(false);
    expect(row.prevSessionEtDate).toBe('2026-07-28');
    expect(row.sessionEtDate).toBe('2026-07-28');
    // Every benign-cause discriminator the ruling enumerated must be present.
    expect(row.prevPrice).toBe(8.30);
    expect(row.price).toBe(8.30);
    expect(row.prevChange).toBe(4.36);
    expect(row.change).toBe(0.12);
    expect(row.prevChangePct).toBe(110.66);
    expect(row.changePct).toBe(1.47);
    expect(row.changePctDelta).toBeCloseTo(1.47 - 110.66, 9);
    expect(row.prevLastUpdated).toBe(T_JUL28_1500ET);
    expect(row.lastUpdated).toBe(T_JUL28_1505ET);
    // Staleness is RECORDED, never filtered on: 5 minutes here, ~104 min on the
    // FGMC incident. Nothing anywhere excludes on this number.
    expect(row.prevStalenessMs).toBe(5 * 60_000);
    expect(row.stalenessMs).toBe(0);
    expect(row.prevQuoteStatus).toBe('ok');
    expect(row.quoteStatus).toBe('ok');
    expect(row.prevMoveSuspect).toBe(true);
    // `fetchQuotes` exposes no provider; the field is present and honestly empty
    // so a later reader cannot mistake "never recorded" for "provider unknown".
    expect(row.quoteSource).toBeNull();
    expect(row.hasL1Book).toBe(false);
  });

  it('ACCEPTANCE: a rollover pair produces a row with straddlesSessionRollover:true', () => {
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
    vi.setSystemTime(T_JUL29_0935ET);
    applyQuotes(engine, quotes({ FGMC: FGMC_AFTER }), ['FGMC']);

    const dump = drain(engine);
    expect(dump.rows).toHaveLength(1);
    expect(dump.rows[0].straddlesSessionRollover).toBe(true);
    expect(dump.rows[0].prevSessionEtDate).toBe('2026-07-28');
    expect(dump.rows[0].sessionEtDate).toBe('2026-07-29');
  });

  it('the two arms differ ONLY in the clock — same quotes, opposite verdict on the deciding field', () => {
    // Without this the two tests above would both pass if `straddlesSessionRollover`
    // were hard-wired to whichever value each expected. This is the field the CTO
    // said decides the follow-up ticket; it has to be shown to be a FUNCTION of
    // the inputs, not a constant.
    const run = (secondTickMs: number) => {
      withClock(T_JUL28_1500ET);
      const engine = new SignalEngine();
      applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
      vi.setSystemTime(secondTickMs);
      applyQuotes(engine, quotes({ FGMC: FGMC_AFTER }), ['FGMC']);
      return drain(engine).rows[0].straddlesSessionRollover;
    };
    expect(run(T_JUL28_1505ET)).toBe(false);
    expect(run(T_JUL29_0935ET)).toBe(true);
  });

  it('KNOWN-GOOD: an ordinary session records NOTHING and allocates no tape', () => {
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ AAPL: AAPL_QUOTE }), ['AAPL']);
    vi.setSystemTime(T_JUL28_1505ET);
    applyQuotes(engine, quotes({ AAPL: { ...AAPL_QUOTE, price: 338.40, change: 6.00, changePct: 1.81 } }), ['AAPL']);
    vi.setSystemTime(T_JUL28_1505ET + 60_000);
    applyQuotes(engine, quotes({ AAPL: { ...AAPL_QUOTE, price: 338.40, change: 6.00, changePct: 1.81 } }), ['AAPL']);

    const dump = drain(engine);
    expect(dump.rows).toHaveLength(0);
    expect(dump.droppedCandidates).toBe(0);
    expect(dump.saturated).toBe(false);
    expect(dump.admitted).toBe(0);
  });

  it('the NO-QUOTE branch never records — the ruling scopes this to the quoted branch', () => {
    // The carry-forward loop republishes the previous price with the previous
    // changePct, so it can never satisfy the rule anyway; this pins that the
    // recorder is not reachable from there even if that changes.
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
    vi.setSystemTime(T_JUL28_1505ET);
    applyQuotes(engine, quotes({}), ['FGMC']);
    expect(drain(engine).rows).toHaveLength(0);
  });

  it('drain RESETS the tape — a second flush of the same session is empty, not doubled', () => {
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
    vi.setSystemTime(T_JUL28_1505ET);
    applyQuotes(engine, quotes({ FGMC: FGMC_AFTER }), ['FGMC']);
    expect(drain(engine).rows).toHaveLength(1);
    expect(drain(engine).rows).toHaveLength(0);
  });
});

describe('TRA-2689 — it emits NO verdict (the boundary check)', () => {
  it('leaves moveSuspect and quoteStatus exactly as TRA-2610 stamps them', () => {
    // The recorder runs between the read of the prior row and the write of the
    // new one. If it ever writes a verdict, THESE are the fields it would reach
    // for, and this is the test that goes red.
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
    expect(rowFor(engine, 'FGMC')?.moveSuspect).toBe(true);
    expect(rowFor(engine, 'FGMC')?.quoteStatus).toBe('ok');

    vi.setSystemTime(T_JUL28_1505ET);
    applyQuotes(engine, quotes({ FGMC: FGMC_AFTER }), ['FGMC']);
    const after = rowFor(engine, 'FGMC');
    // A candidate WAS recorded on this very tick…
    expect(drain(engine).rows).toHaveLength(1);
    // …and the published row is byte-for-byte what TRA-2610 alone would produce:
    // the corrected numbers, believable, NOT suspect, NOT excluded.
    expect(after?.moveSuspect).toBe(false);
    expect(after?.quoteStatus).toBe('ok');
    expect(after?.price).toBe(8.30);
    expect(after?.changePct).toBe(1.47);
  });

  it('the price map returned to callers is unchanged by recording', () => {
    withClock(T_JUL28_1500ET);
    const engine = new SignalEngine();
    applyQuotes(engine, quotes({ FGMC: FGMC_BEFORE }), ['FGMC']);
    vi.setSystemTime(T_JUL28_1505ET);
    const prices = applyQuotes(engine, quotes({ FGMC: FGMC_AFTER }), ['FGMC']);
    expect(prices.get('FGMC')).toBe(8.30);
    expect(prices.size).toBe(1);
  });
});

describe('TRA-2689 — the ring is bounded', () => {
  const row = (i: number): DenominatorFlipCandidate =>
    buildDenominatorFlipCandidate({
      symbol: `S${i}`,
      prev: { price: 1, change: 0.1, changePct: 10, lastUpdated: T_JUL28_1500ET, quoteStatus: 'ok', moveSuspect: false },
      next: { price: 1, change: 0.2, changePct: 20 },
      now: T_JUL28_1505ET,
    });

  it('ACCEPTANCE: saturation stamps `saturated` and reports `droppedCandidates`', () => {
    const tape = new DenominatorFlipTape(DENOM_FLIP_TAPE_CAPACITY);
    for (let i = 0; i < DENOM_FLIP_TAPE_CAPACITY + 137; i += 1) tape.record(row(i));
    const dump = tape.drain();
    expect(dump.rows).toHaveLength(DENOM_FLIP_TAPE_CAPACITY);
    expect(dump.droppedCandidates).toBe(137);
    expect(dump.saturated).toBe(true);
    expect(dump.capacity).toBe(DENOM_FLIP_TAPE_CAPACITY);
    expect(dump.admitted).toBe(DENOM_FLIP_TAPE_CAPACITY + 137);
    // The retained rows are the LAST 2,000 — a contiguous SUFFIX of the session,
    // not an arbitrary sample. A later reader computing any rate over a saturated
    // tape is computing it over that suffix and the field names say so.
    expect(dump.rows[0].symbol).toBe('S137');
    expect(dump.rows[DENOM_FLIP_TAPE_CAPACITY - 1].symbol).toBe(`S${DENOM_FLIP_TAPE_CAPACITY + 136}`);
  });

  it('KNOWN-GOOD: an unsaturated tape reports saturated:false and drops nothing', () => {
    // The other direction of the saturation control. Without it, `saturated:true`
    // would also pass on an implementation that hard-codes it.
    const tape = new DenominatorFlipTape(DENOM_FLIP_TAPE_CAPACITY);
    for (let i = 0; i < 5; i += 1) tape.record(row(i));
    const dump = tape.drain();
    expect(dump.rows).toHaveLength(5);
    expect(dump.droppedCandidates).toBe(0);
    expect(dump.saturated).toBe(false);
    expect(dump.rows.map(r => r.symbol)).toEqual(['S0', 'S1', 'S2', 'S3', 'S4']);
  });

  it('the default capacity is the budgeted 2,000', () => {
    expect(DENOM_FLIP_TAPE_CAPACITY).toBe(2000);
    expect(new DenominatorFlipTape().drain().capacity).toBe(2000);
  });
});

describe('TRA-2689 — the bounded flush', () => {
  const dumpOf = (n: number, dropped = 0) => {
    const rows: DenominatorFlipCandidate[] = [];
    for (let i = 0; i < n; i += 1) {
      rows.push(buildDenominatorFlipCandidate({
        symbol: `SYM${i}`,
        prev: { price: 1, change: 0.1, changePct: 10, lastUpdated: T_JUL28_1500ET, quoteStatus: 'ok', moveSuspect: false },
        next: { price: 1, change: 0.2, changePct: 20 },
        now: T_JUL28_1505ET,
      }));
    }
    return { rows, droppedCandidates: dropped, saturated: dropped > 0, capacity: DENOM_FLIP_TAPE_CAPACITY, admitted: n + dropped };
  };

  it('writes tape/<date>.json carrying its OWN admission rule', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra2689-'));
    const res = await flushDenominatorFlipTape({
      targetDir: dir,
      date: '2026-07-30',
      dump: dumpOf(3),
      admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: DENOM_FLIP_TAPE_CAPACITY },
      now: T_JUL28_1505ET,
    });
    expect(res.written).toBe(true);
    expect(res.rows).toBe(3);
    const parsed = JSON.parse(await readFile(join(dir, 'tape', '2026-07-30.json'), 'utf-8')) as DenominatorFlipTapeFile;
    expect(parsed.issue).toBe('TRA-2689');
    expect(parsed.admissionRule).toEqual({ priceEquality: 'exact', changePctDeltaPp: 0.01, capacity: 2000 });
    expect(parsed.rows).toHaveLength(3);
    expect(parsed.saturated).toBe(false);
    expect(parsed.truncatedForSize).toBe(0);
  });

  it('a saturated dump is stamped saturated in the FILE, not just in the log', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra2689-'));
    await flushDenominatorFlipTape({
      targetDir: dir,
      date: '2026-07-30',
      dump: dumpOf(2, 41),
      admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: DENOM_FLIP_TAPE_CAPACITY },
    });
    const parsed = JSON.parse(await readFile(join(dir, 'tape', '2026-07-30.json'), 'utf-8')) as DenominatorFlipTapeFile;
    expect(parsed.saturated).toBe(true);
    expect(parsed.droppedCandidates).toBe(41);
    expect(parsed.admitted).toBe(43);
  });

  it('holds the 1 MB ceiling and STAMPS what it dropped to get there', () => {
    const file: DenominatorFlipTapeFile = {
      issue: 'TRA-2689',
      date: '2026-07-30',
      generatedAt: new Date(T_JUL28_1505ET).toISOString(),
      admissionRule: { priceEquality: 'exact', changePctDeltaPp: 0.01, capacity: 2000 },
      saturated: false,
      droppedCandidates: 0,
      truncatedForSize: 0,
      droppedOnMerge: 0,
      admitted: 2000,
      segments: [],
      segmentCount: 0,
      restartBoundaries: 0,
      coverage: {
        rthOpenUtc: null,
        rthCloseUtc: null,
        observedMs: null,
        uncoveredMs: null,
        rowsLostToRestart: null,
      },
      coverageComplete: false,
      rows: dumpOf(2000).rows,
    };
    const tiny = serializeTapeWithinBudget(file, 20_000);
    expect(Buffer.byteLength(tiny.json, 'utf-8')).toBeLessThanOrEqual(20_000);
    expect(tiny.file.truncatedForSize).toBeGreaterThan(0);
    expect(tiny.file.rows.length + tiny.file.truncatedForSize).toBe(2000);
    // Oldest-first, matching the ring: the survivors are the newest rows.
    expect(tiny.file.rows[tiny.file.rows.length - 1].symbol).toBe('SYM1999');
    expect(JSON.parse(tiny.json).truncatedForSize).toBe(tiny.file.truncatedForSize);

    // KNOWN-GOOD: a full 2,000-row tape fits the real 1 MB ceiling untouched, so
    // the truncation path is not silently firing on every normal session.
    const full = serializeTapeWithinBudget(file);
    expect(full.file.truncatedForSize).toBe(0);
    expect(Buffer.byteLength(full.json, 'utf-8')).toBeLessThanOrEqual(1024 * 1024);
  });

  it('prunes oldest-first to the retention budget and leaves foreign files alone', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra2689-'));
    const tapeDir = join(dir, 'tape');
    await mkdir(tapeDir, { recursive: true });
    for (let i = 1; i <= DENOM_FLIP_TAPE_MAX_FILES + 4; i += 1) {
      await writeFile(join(tapeDir, `2026-06-${String(i).padStart(2, '0')}.json`), '{}', 'utf-8');
    }
    await writeFile(join(tapeDir, 'README.md'), 'not a tape', 'utf-8');

    const res = await flushDenominatorFlipTape({
      targetDir: dir,
      date: '2026-07-30',
      dump: dumpOf(1),
      admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: DENOM_FLIP_TAPE_CAPACITY },
    });
    const names = (await readdir(tapeDir)).sort();
    const tapes = names.filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
    expect(tapes).toHaveLength(DENOM_FLIP_TAPE_MAX_FILES);
    // 34 pre-existing + today's = 35; five oldest go.
    expect(res.prunedFiles).toBe(5);
    expect(tapes).toContain('2026-07-30.json');
    expect(tapes).not.toContain('2026-06-01.json');
    expect(names).toContain('README.md');
  });

  it('NEVER throws into report generation — an unwritable target returns an error result', async () => {
    const base = await mkdtemp(join(tmpdir(), 'tra2689-'));
    // A path whose parent is a FILE, not a directory: `mkdir -p` rejects ENOTDIR.
    await writeFile(join(base, 'blocker'), 'i am a file', 'utf-8');
    const res = await flushDenominatorFlipTape({
      targetDir: join(base, 'blocker', 'nested'),
      date: '2026-07-30',
      dump: dumpOf(1),
      admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: DENOM_FLIP_TAPE_CAPACITY },
    });
    expect(res.written).toBe(false);
    expect(res.error).toBeTruthy();
  });
});

/**
 * TRA-3116 — the tape survived admission and then died between the close and the
 * 01:00Z drain. These are the acceptance arms for the CTO's three-part ruling.
 *
 * Read the controls as pairs. The whole failure this ticket closes is a file
 * that reads CLEAN over a session it barely observed, so for every arm that
 * proves a gap is caught there is a known-good beside it proving the same
 * predicate still passes a genuinely complete session — a coverage check that
 * says "incomplete" unconditionally is exactly as useless as the
 * `droppedCandidates: 0` it replaces.
 */
describe('TRA-3116 — the drain survives a restart (merge, coverage, orphan)', () => {
  /** 2026-07-30 is EDT: RTH is 13:30Z–20:00Z. */
  const DATE = '2026-07-30';
  const OPEN_Z = Date.parse('2026-07-30T13:30:00.000Z');
  const CLOSE_Z = Date.parse('2026-07-30T20:00:00.000Z');
  const PRE_OPEN_Z = Date.parse('2026-07-30T12:00:00.000Z');

  const rowsOf = (n: number, tag: string) => {
    const rows: DenominatorFlipCandidate[] = [];
    for (let i = 0; i < n; i += 1) {
      const row = buildDenominatorFlipCandidate({
        symbol: `${tag}${i}`,
        prev: { price: 1, change: 0.1, changePct: 10, lastUpdated: T_JUL28_1500ET, quoteStatus: 'ok', moveSuspect: false },
        next: { price: 1, change: 0.2, changePct: 20 },
        now: T_JUL28_1505ET,
      });
      rows.push(row);
    }
    return rows;
  };
  const dump = (rows: DenominatorFlipCandidate[], dropped = 0, capacity = DENOM_FLIP_TAPE_CAPACITY) => ({
    rows, droppedCandidates: dropped, saturated: dropped > 0, capacity, admitted: rows.length + dropped,
  });
  const flush = (
    dir: string,
    d: ReturnType<typeof dump>,
    opts: { trigger: 'eod' | 'shutdown'; startedAt: number; now: number; capacity?: number },
  ) => flushDenominatorFlipTape({
    targetDir: dir,
    date: DATE,
    dump: d,
    admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: opts.capacity ?? DENOM_FLIP_TAPE_CAPACITY },
    trigger: opts.trigger,
    processStartedAt: new Date(opts.startedAt).toISOString(),
    now: opts.now,
  });
  const readTape = async (dir: string, name = `${DATE}.json`) =>
    JSON.parse(await readFile(join(dir, 'tape', name), 'utf-8')) as DenominatorFlipTapeFile;

  // ── Part 1 + 2: the merge ────────────────────────────────────────────────

  it('ACCEPTANCE — a shutdown drain then an EOD drain MERGE; the second does not overwrite the first', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // Process A: boots pre-open, dies mid-session. This is the drain that did
    // not exist before this ticket, and its absence is what destroyed the tape.
    await flush(dir, dump(rowsOf(3, 'A')), {
      trigger: 'shutdown', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-30T17:00:00.000Z'),
    });
    // Process B: boots straight after, runs to the 01:00Z EOD drain.
    await flush(dir, dump(rowsOf(2, 'B')), {
      trigger: 'eod', startedAt: Date.parse('2026-07-30T17:00:00.000Z'), now: Date.parse('2026-07-31T01:00:00.000Z'),
    });

    const parsed = await readTape(dir);
    // THE REGRESSION LOCK. Pre-fix this file held 2 rows: last-write-wins.
    expect(parsed.rows).toHaveLength(5);
    expect(parsed.rows.map(r => r.symbol)).toEqual(['A0', 'A1', 'A2', 'B0', 'B1']);
    expect(parsed.segmentCount).toBe(2);
    expect(parsed.segments.map(s => s.trigger)).toEqual(['shutdown', 'eod']);
    expect(parsed.admitted).toBe(5);
  });

  it('counters SUM across segments, and `admitted` is NOT re-derived from rows + dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    await flush(dir, dump(rowsOf(2, 'A'), 7), { trigger: 'shutdown', startedAt: OPEN_Z, now: OPEN_Z + 3_600_000 });
    await flush(dir, dump(rowsOf(3, 'B'), 11), { trigger: 'eod', startedAt: OPEN_Z + 3_600_000, now: CLOSE_Z });

    const parsed = await readTape(dir);
    // Summing is only correct because `drain()` resets `dropped` — each segment
    // describes ONLY its own slice. A merge built on `peek()` (which does not
    // clear) would double-count both of these.
    expect(parsed.droppedCandidates).toBe(18);
    expect(parsed.admitted).toBe(23);
    expect(parsed.saturated).toBe(true);
    // 5 rows + 18 dropped happens to equal 23 here; the point is the file's own
    // number comes from the segments, so it stays right when a third loss source
    // (`droppedOnMerge`) fires. Pinned by the merge-eviction arm below.
    expect(parsed.admitted).toBe(parsed.segments.reduce((n, s) => n + s.admitted, 0));
  });

  it('ACCEPTANCE — merge-time eviction lands on `droppedOnMerge`, NOT on the other two counters', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // Capacity 4 across two 3-row segments: the merge must evict 2, and those 2
    // are rows no segment's own counters ever saw.
    await flush(dir, dump(rowsOf(3, 'A'), 0, 4), { trigger: 'shutdown', startedAt: OPEN_Z, now: OPEN_Z + 60_000, capacity: 4 });
    await flush(dir, dump(rowsOf(3, 'B'), 0, 4), { trigger: 'eod', startedAt: OPEN_Z + 60_000, now: CLOSE_Z, capacity: 4 });

    const parsed = await readTape(dir);
    expect(parsed.rows).toHaveLength(4);
    // Oldest-first, so the survivors are a contiguous SUFFIX.
    expect(parsed.rows.map(r => r.symbol)).toEqual(['A2', 'B0', 'B1', 'B2']);
    expect(parsed.droppedOnMerge).toBe(2);
    // The load-bearing half: folding this into either existing field would
    // re-create the silent cap inside the fix.
    expect(parsed.droppedCandidates).toBe(0);
    expect(parsed.truncatedForSize).toBe(0);
    // `admitted` still says 6 even though `rows + droppedCandidates` is 4.
    expect(parsed.admitted).toBe(6);
    expect(parsed.rows.length + parsed.droppedCandidates).not.toBe(parsed.admitted);

    // KNOWN-GOOD: the same two drains under a capacity that fits evict nothing,
    // so `droppedOnMerge` is not simply always-on.
    const roomy = await mkdtemp(join(tmpdir(), 'tra3116-'));
    await flush(roomy, dump(rowsOf(3, 'A')), { trigger: 'shutdown', startedAt: OPEN_Z, now: OPEN_Z + 60_000 });
    await flush(roomy, dump(rowsOf(3, 'B')), { trigger: 'eod', startedAt: OPEN_Z + 60_000, now: CLOSE_Z });
    expect((await readTape(roomy)).droppedOnMerge).toBe(0);
  });

  // ── Part 3: coverage ─────────────────────────────────────────────────────

  it('ACCEPTANCE — a restart gap makes `coverageComplete` false and `rowsLostToRestart` NULL, never 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // Process A observes 13:30Z–15:00Z, then a 2-hour hole, then process B.
    await flush(dir, dump(rowsOf(1, 'A')), { trigger: 'shutdown', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-30T15:00:00.000Z') });
    await flush(dir, dump(rowsOf(1, 'B')), { trigger: 'eod', startedAt: Date.parse('2026-07-30T17:00:00.000Z'), now: Date.parse('2026-07-31T01:00:00.000Z') });

    const parsed = await readTape(dir);
    expect(parsed.coverageComplete).toBe(false);
    expect(parsed.coverage.uncoveredMs).toBe(2 * 3_600_000);
    // THE POINT OF PART 3. Those rows died with process A; nothing counted them
    // and nothing can. A `0` here would be the same fail-open as the
    // `droppedCandidates: 0` on the real 08-05 file — true and useless.
    expect(parsed.coverage.rowsLostToRestart).toBeNull();
    expect(parsed.restartBoundaries).toBe(1);
    // The pre-fix trap in one assertion: every OTHER counter reads clean.
    expect(parsed.saturated).toBe(false);
    expect(parsed.truncatedForSize).toBe(0);
    expect(parsed.droppedOnMerge).toBe(0);
  });

  it('KNOWN-GOOD — one process spanning the whole session is coverageComplete with rowsLostToRestart 0', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    await flush(dir, dump(rowsOf(4, 'A')), {
      trigger: 'eod', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-31T01:00:00.000Z'),
    });
    const parsed = await readTape(dir);
    expect(parsed.coverage.rthOpenUtc).toBe('2026-07-30T13:30:00.000Z');
    expect(parsed.coverage.rthCloseUtc).toBe('2026-07-30T20:00:00.000Z');
    expect(parsed.coverage.observedMs).toBe(CLOSE_Z - OPEN_Z);
    expect(parsed.coverage.uncoveredMs).toBe(0);
    expect(parsed.coverage.rowsLostToRestart).toBe(0);
    expect(parsed.coverageComplete).toBe(true);
    expect(parsed.restartBoundaries).toBe(0);
  });

  it('two drains by ONE process are not a restart, and their overlap cannot double-count past 100%', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    const started = PRE_OPEN_Z;
    // The EOD drain, then that same process's own shutdown drain minutes later.
    await flush(dir, dump(rowsOf(1, 'A')), { trigger: 'eod', startedAt: started, now: Date.parse('2026-07-31T01:00:00.000Z') });
    await flush(dir, dump(rowsOf(1, 'B')), { trigger: 'shutdown', startedAt: started, now: Date.parse('2026-07-31T01:05:00.000Z') });
    const parsed = await readTape(dir);
    expect(parsed.segmentCount).toBe(2);
    // Same `processStartedAt` on both — a seam in the file is not a seam in time.
    expect(parsed.restartBoundaries).toBe(0);
    expect(parsed.coverage.observedMs).toBe(CLOSE_Z - OPEN_Z);
    expect(parsed.coverageComplete).toBe(true);
  });

  it('a SIGKILL writes no segment at all, and coverage still sees the hole', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // Process A drains at 15:00Z. Process B boots at 15:01Z and is SIGKILLed at
    // 18:00Z — it never writes anything. Process C boots at 18:00Z.
    await flush(dir, dump(rowsOf(1, 'A')), { trigger: 'shutdown', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-30T15:00:00.000Z') });
    await flush(dir, dump(rowsOf(1, 'C')), { trigger: 'eod', startedAt: Date.parse('2026-07-30T18:00:00.000Z'), now: Date.parse('2026-07-31T01:00:00.000Z') });
    const parsed = await readTape(dir);
    // B's entire lifetime is an uncovered interval BETWEEN the surviving
    // segments. A coverage number derived from successful drains would score
    // this clean; one derived from process start times cannot.
    expect(parsed.coverage.uncoveredMs).toBe(3 * 3_600_000);
    expect(parsed.coverageComplete).toBe(false);
    expect(parsed.coverage.rowsLostToRestart).toBeNull();
  });

  it('ACCEPTANCE — a ZERO-row session under complete coverage is still WRITTEN, and counts', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    const res = await flush(dir, dump([]), {
      trigger: 'eod', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-31T01:00:00.000Z'),
    });
    expect(res.written).toBe(true);
    const parsed = await readTape(dir);
    expect(parsed.rows).toHaveLength(0);
    // Per the promotion bar: a proven-full-coverage session with no candidates
    // is a real observation. The old "skip the empty write" rule made this file
    // unrepresentable, so the bar could never be reached by a quiet session.
    expect(parsed.coverageComplete).toBe(true);
    expect(parsed.saturated).toBe(false);
    expect(parsed.truncatedForSize).toBe(0);
    expect(parsed.droppedOnMerge).toBe(0);
  });

  it('a pre-open-only process contributes no observed time and does not fake coverage', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // Boots 11:00Z, dies 12:00Z — entirely before the 13:30Z open.
    await flush(dir, dump([]), {
      trigger: 'shutdown',
      startedAt: Date.parse('2026-07-30T11:00:00.000Z'),
      now: Date.parse('2026-07-30T12:00:00.000Z'),
    });
    const parsed = await readTape(dir);
    expect(parsed.coverage.observedMs).toBe(0);
    expect(parsed.coverageComplete).toBe(false);
  });

  // ── Part 2c: the orphan ──────────────────────────────────────────────────

  it('ACCEPTANCE — an UNREADABLE prior file is orphaned, never overwritten', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    const tapeDir = join(dir, 'tape');
    await mkdir(tapeDir, { recursive: true });
    // A partial write: valid-looking prefix, truncated mid-object. This is the
    // exact state in which we have the LEAST idea what we would be destroying.
    await writeFile(join(tapeDir, `${DATE}.json`), '{"issue":"TRA-2689","rows":[{"sym', 'utf-8');

    const res = await flush(dir, dump(rowsOf(2, 'B')), { trigger: 'eod', startedAt: OPEN_Z, now: CLOSE_Z });
    expect(res.written).toBe(true);
    expect(res.mergeDegraded).toBe(true);
    expect(res.orphanedPriorFile).toBe(`${DATE}.orphan1.json`);

    // The bytes we could not parse SURVIVE, untouched.
    expect(await readFile(join(tapeDir, `${DATE}.orphan1.json`), 'utf-8'))
      .toBe('{"issue":"TRA-2689","rows":[{"sym');
    const parsed = await readTape(dir);
    expect(parsed.mergeDegraded).toBe(true);
    expect(parsed.orphanedPriorFile).toBe(`${DATE}.orphan1.json`);
    expect(parsed.rows).toHaveLength(2);
  });

  it('orphan names do not collide, and orphans COUNT against the 30-file retention budget', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    const tapeDir = join(dir, 'tape');
    await mkdir(tapeDir, { recursive: true });
    await writeFile(join(tapeDir, `${DATE}.json`), 'not json', 'utf-8');
    await flush(dir, dump(rowsOf(1, 'A')), { trigger: 'shutdown', startedAt: OPEN_Z, now: OPEN_Z + 1000 });
    await writeFile(join(tapeDir, `${DATE}.json`), 'still not json', 'utf-8');
    const res2 = await flush(dir, dump(rowsOf(1, 'B')), { trigger: 'eod', startedAt: OPEN_Z, now: CLOSE_Z });
    expect(res2.orphanedPriorFile).toBe(`${DATE}.orphan2.json`);

    // Retention must see the orphan form, or an unreadable file grows the budget
    // without bound. Fill past the cap and check the count includes orphans.
    for (let i = 1; i <= DENOM_FLIP_TAPE_MAX_FILES; i += 1) {
      await writeFile(join(tapeDir, `2026-06-${String(i).padStart(2, '0')}.json`), '{}', 'utf-8');
    }
    await flush(dir, dump(rowsOf(1, 'C')), { trigger: 'eod', startedAt: OPEN_Z, now: CLOSE_Z });
    const kept = (await readdir(tapeDir)).filter(n => /^\d{4}-\d{2}-\d{2}(?:\.orphan\d+)?\.json$/.test(n));
    expect(kept).toHaveLength(DENOM_FLIP_TAPE_MAX_FILES);
    expect(kept).toContain(`${DATE}.json`);
  });

  it('CONTROL — a MISSING prior file is the ordinary first drain, not degradation', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    const res = await flush(dir, dump(rowsOf(1, 'A')), { trigger: 'eod', startedAt: OPEN_Z, now: CLOSE_Z });
    expect(res.written).toBe(true);
    expect(res.merged).toBe(false);
    expect(res.mergeDegraded).toBeUndefined();
    expect((await readdir(join(dir, 'tape'))).some(n => n.includes('orphan'))).toBe(false);
  });

  // ── Part 2d: re-admission ────────────────────────────────────────────────

  it('ACCEPTANCE — a failed write re-admits its rows instead of eating the session', () => {
    const tape = new DenominatorFlipTape(10);
    const rows = rowsOf(3, 'A');
    for (const r of rows) tape.record(r);
    const drained = tape.drain();
    expect(tape.length).toBe(0);

    // The writer said `written: false`; the caller hands the rows back.
    tape.readmit(drained.rows);
    expect(tape.length).toBe(3);
    expect(tape.peek().map(r => r.symbol)).toEqual(['A0', 'A1', 'A2']);
    expect(tape.droppedCandidates).toBe(0);
  });

  it('over-capacity re-admission inflates `droppedCandidates` rather than vanishing', () => {
    const tape = new DenominatorFlipTape(4);
    const drained = { rows: rowsOf(3, 'X') };
    // The ring refilled while the failed write was in flight.
    for (const r of rowsOf(3, 'N')) tape.record(r);
    tape.readmit(drained.rows);
    expect(tape.length).toBe(4);
    // 6 rows through a 4-slot ring: 2 overflowed, and they are NAMED.
    expect(tape.droppedCandidates).toBe(2);
    expect(tape.saturated).toBe(true);
  });

  // ── The session window itself ────────────────────────────────────────────

  it('the RTH window is DST-correct, not a hard-coded 13:30Z', () => {
    // EDT — the case a hard-coded constant gets right by luck.
    expect(etWallClockToUtcMs('2026-07-30', 9, 30)).toBe(Date.parse('2026-07-30T13:30:00.000Z'));
    expect(etWallClockToUtcMs('2026-07-30', 16, 0)).toBe(Date.parse('2026-07-30T20:00:00.000Z'));
    // EST — the case it gets wrong by a full hour, which would grade a complete
    // session as partial (and, worse, a partial one as complete).
    expect(etWallClockToUtcMs('2026-01-15', 9, 30)).toBe(Date.parse('2026-01-15T14:30:00.000Z'));
    expect(etWallClockToUtcMs('2026-01-15', 16, 0)).toBe(Date.parse('2026-01-15T21:00:00.000Z'));
    // A malformed key publishes ignorance rather than a plausible number.
    expect(etWallClockToUtcMs('not-a-date', 9, 30)).toBeNull();
  });

  // ── Part 5: the bar is only real if it can be READ ───────────────────────

  it('ACCEPTANCE — the bar rule grades a complete session in and every loss source out', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    await flush(dir, dump(rowsOf(2, 'A')), {
      trigger: 'eod', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-31T01:00:00.000Z'),
    });
    const summary = await summarizeDenominatorFlipTape(
      [{ username: 'admin', mode: 'live', targetDir: dir }],
      { todayEt: DATE },
    );
    expect(summary.verdict).toBe('complete');
    expect(summary.complete).toBe(1);
    expect(summary.partial).toBe(0);
    expect(summary.absent).toBe(0);
    expect(summary.sessions[0].countsTowardBar).toBe(true);
    expect(summary.sessions[0].disqualifiers).toEqual([]);

    // Each loss source disqualifies ON ITS OWN NAME, so a reader can tell WHICH
    // one fired rather than being handed a bare boolean.
    const ok = { coverageComplete: true, saturated: false, truncatedForSize: 0, droppedOnMerge: 0 };
    expect(gradeTapeSession(ok).countsTowardBar).toBe(true);
    expect(gradeTapeSession({ ...ok, coverageComplete: false }).disqualifiers).toEqual(['coverageComplete:false']);
    expect(gradeTapeSession({ ...ok, saturated: true }).disqualifiers).toEqual(['saturated']);
    expect(gradeTapeSession({ ...ok, truncatedForSize: 3 }).disqualifiers).toEqual(['truncatedForSize']);
    expect(gradeTapeSession({ ...ok, droppedOnMerge: 1 }).disqualifiers).toEqual(['droppedOnMerge']);
    expect(gradeTapeSession({ ...ok, mergeDegraded: true }).disqualifiers).toEqual(['mergeDegraded']);
  });

  it('a PRE-FIX file (no coverage fields) does NOT grade clean by virtue of the fields being missing', () => {
    // The 2026-08-04 and 08-05 files on the live box are exactly this shape:
    // `droppedCandidates: 0`, `saturated: false`, and no coverage stamp at all.
    // Both are five minutes of after-hours residue. An absent field read as a
    // passing one would bank them as sessions 1 and 2 of the bar.
    const preFix = { saturated: false, droppedCandidates: 0, truncatedForSize: 0 };
    const graded = gradeTapeSession(preFix);
    expect(graded.countsTowardBar).toBe(false);
    expect(graded.disqualifiers).toContain('coverageComplete:absent');
    expect(graded.disqualifiers).toContain('droppedOnMerge:absent');
  });

  it('a zero-row COMPLETE session counts, and a partial one is retained rather than dropped', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // 07-30: complete coverage, no candidates. Counts.
    await flush(dir, dump([]), { trigger: 'eod', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-31T01:00:00.000Z') });
    const summary = await summarizeDenominatorFlipTape(
      [{ username: 'admin', mode: 'live', targetDir: dir }],
      { todayEt: DATE },
    );
    expect(summary.sessions[0].rows).toBe(0);
    expect(summary.sessions[0].countsTowardBar).toBe(true);
    expect(summary.sessionsTowardBar).toBe(1);
  });

  it('BLIND is not CLEAN — no tape on record reports verdict null, never a green', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    const summary = await summarizeDenominatorFlipTape(
      [{ username: 'admin', mode: 'live', targetDir: dir }],
      { todayEt: DATE },
    );
    expect(summary.verdict).toBeNull();
    expect(summary.blindReason).toBeTruthy();
    expect(summary.sessionsTowardBar).toBe(0);
    // The trap this closes: `complete === 0 && partial === 0` must not be
    // reportable as "nothing wrong".
    expect(summary.verdict).not.toBe('complete');
  });

  it('absent MARKET days are counted against the denominator, and holidays do not inflate them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    // Two sessions a week apart. 2026-07-30 (Thu) .. 2026-08-05 (Wed) contains
    // market days 07-30, 07-31, 08-03, 08-04, 08-05 — three of them have no file.
    await flush(dir, dump(rowsOf(1, 'A')), { trigger: 'eod', startedAt: PRE_OPEN_Z, now: Date.parse('2026-07-31T01:00:00.000Z') });
    await flushDenominatorFlipTape({
      targetDir: dir, date: '2026-08-05', dump: dump(rowsOf(1, 'B')),
      admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: DENOM_FLIP_TAPE_CAPACITY },
      trigger: 'eod',
      processStartedAt: '2026-08-05T12:00:00.000Z',
      now: Date.parse('2026-08-06T01:00:00.000Z'),
    });
    const summary = await summarizeDenominatorFlipTape(
      [{ username: 'admin', mode: 'live', targetDir: dir }],
      { todayEt: '2026-08-05' },
    );
    expect(summary.absent).toBe(3);
    expect(summary.absentSessions).toEqual([
      'admin/live@2026-07-31', 'admin/live@2026-08-03', 'admin/live@2026-08-04',
    ]);
    // Weekend days are not absences — a calendar-blind count would say 5.
    expect(summary.absentSessions.some(s => s.endsWith('2026-08-01'))).toBe(false);
    // A gap means the fleet reading is PARTIAL even though both files are clean.
    expect(summary.verdict).toBe('partial');
  });

  it('an unreadable tape file stays IN the denominator as evidence, not out of it', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3116-'));
    await mkdir(join(dir, 'tape'), { recursive: true });
    await writeFile(join(dir, 'tape', `${DATE}.json`), '{ truncated', 'utf-8');
    const summary = await summarizeDenominatorFlipTape(
      [{ username: 'admin', mode: 'live', targetDir: dir }],
      { todayEt: DATE },
    );
    expect(summary.sessions).toHaveLength(1);
    expect(summary.sessions[0].unreadable).toBeTruthy();
    expect(summary.sessions[0].countsTowardBar).toBe(false);
    expect(summary.partial).toBe(1);
  });

  it('an unresolvable date publishes coverage as NULL, never as zero', () => {
    const cov = computeTapeCoverage('garbage', [
      { processStartedAt: new Date(OPEN_Z).toISOString(), flushedAt: new Date(CLOSE_Z).toISOString(), trigger: 'eod', rows: 1, droppedCandidates: 0, truncatedForSize: 0, admitted: 1 },
    ]);
    expect(cov.observedMs).toBeNull();
    expect(cov.uncoveredMs).toBeNull();
    // `null`, not `0` — an unknown coverage must not read as a complete one.
    expect(cov.rowsLostToRestart).toBeNull();
  });
});

/**
 * TRA-3494 — the bar's UNIT.
 *
 * The instrument as first shipped counted BOOK-DAYS and read 64/10 on the first
 * clean night, clearing a ">= 10 RTH sessions" bar on one calendar day of
 * evidence pooled across 66 books (61 demo). These arms are the ruling made
 * executable, and they are bidirectional on purpose: for every arm proving the
 * pooled reading is gone there is one proving a genuinely clean live day still
 * banks, because a counter that never advances is exactly as useless as one that
 * clears on night one.
 */
describe('TRA-3494 — the bar counts market DAYS on the live-money cohort', () => {
  /** Both are NYSE sessions (Wed/Thu). */
  const D1 = '2026-08-12';
  const D2 = '2026-08-13';

  const session = (
    o: Partial<TapeSessionSummary> & { username: string; mode: string; date: string },
  ): TapeSessionSummary => ({
    generatedAt: null,
    rows: 1,
    admitted: 1,
    droppedCandidates: 0,
    truncatedForSize: 0,
    droppedOnMerge: 0,
    saturated: false,
    segmentCount: 1,
    restartBoundaries: 0,
    coverageComplete: true,
    observedMs: 23_400_000,
    uncoveredMs: 0,
    rowsLostToRestart: 0,
    mergeDegraded: false,
    countsTowardBar: true,
    disqualifiers: [],
    ...o,
  });

  /** The 2026-08-12 fleet exactly as TRA-3466 read it: 64 clean of 66. */
  const nightOne = (): TapeSessionSummary[] => {
    const out: TapeSessionSummary[] = [];
    for (let i = 0; i < 61; i += 1) out.push(session({ username: `demo${i}`, mode: 'demo', date: D1 }));
    out.push(session({ username: 'sbx', mode: 'sandbox', date: D1 }));
    out.push(session({ username: 'admin', mode: 'live', date: D1, rows: 1057 }));
    out.push(session({ username: 'v0nni', mode: 'live', date: D1, rows: 74 }));
    // The two that did NOT clear: demo books stamped `observedMs: 0`.
    for (const u of ['idleA', 'idleB']) {
      out.push(session({
        username: u, mode: 'demo', date: D1, rows: 0, observedMs: 0, segmentCount: 0,
        coverageComplete: false, countsTowardBar: false, disqualifiers: ['coverageComplete:false'],
      }));
    }
    return out;
  };

  it('ACCEPTANCE — night one banks ONE day, not 64', () => {
    const days = computeBarDays(nightOne(), []);
    expect(days).toHaveLength(1);
    expect(days[0].date).toBe(D1);
    expect(days[0].live).toBe('counted');
    // The pooled number is not deleted, it is just not the unit any more.
    expect(days[0].bookSessionsClean).toBe(64);
    expect(days[0].bookSessions).toBe(66);
    expect(days.filter(d => d.live === 'counted')).toHaveLength(1);
    // Both rejected quorums are published, and they disagree — which is the
    // whole reason the ruling had to name one.
    expect(days[0].anyBookClean).toBe(true);   // B1 would pass
    expect(days[0].allBooksClean).toBe(false); // B2 would fail
  });

  it('a clean DEMO fleet cannot bank a day the live book failed', () => {
    const sessions = nightOne().map(s =>
      s.username === 'admin'
        ? { ...s, countsTowardBar: false, disqualifiers: ['droppedOnMerge'], droppedOnMerge: 4 }
        : s,
    );
    const days = computeBarDays(sessions, []);
    expect(days[0].live).toBe('failed');
    expect(days[0].liveFailingBooks).toEqual(['admin/live']);
    // ...even though 63 books were clean and quorum B1 would still have passed.
    expect(days[0].anyBookClean).toBe(true);
    expect(days[0].bookSessionsClean).toBe(63);
  });

  it('an EMPTY live cohort is `vacuous` — neither a credit nor a failure', () => {
    // `every` is true on the empty set; a day with only demo books must not bank.
    const days = computeBarDays([session({ username: 'demo0', mode: 'demo', date: D1 })], []);
    expect(days[0].live).toBe('vacuous');
    expect(days[0].vacuousReason).toBeTruthy();
    expect(days[0].liveObserved).toBe(0);
    expect(days.filter(d => d.live === 'counted')).toHaveLength(0);
    expect(days.filter(d => d.live === 'failed')).toHaveLength(0);
  });

  it('an IDLE live book is `vacuous`, but an UNREADABLE one FAILS', () => {
    // Idle: a file exists, but nothing in it says the process observed anything.
    const idle = computeBarDays([session({
      username: 'admin', mode: 'live', date: D1,
      rows: 0, observedMs: 0, segmentCount: 0, coverageComplete: false,
      countsTowardBar: false, disqualifiers: ['coverageComplete:false'],
    })], []);
    expect(idle[0].live).toBe('vacuous');
    expect(idle[0].liveIdle).toBe(1);

    // Unreadable: also zero observation on its face, but it is EVIDENCE of a
    // problem. Letting it read as idle would buy a corrupt write a free pass.
    const corrupt = computeBarDays([session({
      username: 'admin', mode: 'live', date: D1,
      rows: 0, observedMs: null, segmentCount: null, coverageComplete: null,
      countsTowardBar: false, disqualifiers: ['unreadable'], unreadable: 'Unexpected end of JSON input',
    })], []);
    expect(corrupt[0].live).toBe('failed');
  });

  it('any ONE of observedMs / rows / segmentCount is enough to prove the book ran', () => {
    // A regression of the TRA-3116 fix attacks these one at a time, so a book
    // that lost its coverage stamp must still be graded, not excused as idle.
    for (const shape of [
      { observedMs: 1, rows: 0, segmentCount: 0 },
      { observedMs: 0, rows: 1, segmentCount: 0 },
      { observedMs: 0, rows: 0, segmentCount: 1 },
    ]) {
      const days = computeBarDays([session({
        username: 'admin', mode: 'live', date: D1, ...shape,
        coverageComplete: false, countsTowardBar: false, disqualifiers: ['coverageComplete:false'],
      })], []);
      expect(days[0].live).toBe('failed');
    }
  });

  it('SANDBOX is not live money — a sandbox book cannot bank a day', () => {
    // `stockModeKey` stamps `sandbox` for mode:'live' on Tradier's sandbox env.
    const days = computeBarDays([session({ username: 'sbx', mode: 'sandbox', date: D1 })], []);
    expect(days[0].live).toBe('vacuous');
  });

  it('a WEEKEND tape file cannot fill a trading-session bar', () => {
    // 2026-08-15 is a Saturday. After-hours residue, not an RTH session.
    const days = computeBarDays([
      session({ username: 'admin', mode: 'live', date: '2026-08-15' }),
      session({ username: 'admin', mode: 'live', date: D1 }),
    ], []);
    expect(days.map(d => d.date)).toEqual([D1]);
  });

  it('an ABSENT live tape is PUBLISHED, and cannot vacuously bank a day on its own', () => {
    const days = computeBarDays([], [`admin/live@${D2}`, `demo0/demo@${D2}`]);
    expect(days).toHaveLength(1);
    expect(days[0].live).toBe('vacuous');
    // The live absence is named; the demo one is not the deciding cohort.
    expect(days[0].liveAbsentBooks).toEqual(['admin/live']);
    expect(days[0].liveAbsent).toBe(1);
  });

  it('days accrue independently, and a failure does not erase a banked day', () => {
    const days = computeBarDays([
      session({ username: 'admin', mode: 'live', date: D1 }),
      session({ username: 'admin', mode: 'live', date: D2, countsTowardBar: false, disqualifiers: ['saturated'] }),
    ], []);
    expect(days.map(d => d.live)).toEqual(['counted', 'failed']);
  });

  it('ACCEPTANCE — the summary publishes the DAY count and RETAINS the pooled one', async () => {
    // Two live books, one date. The pooled reading is 2; the ruled unit is 1.
    const a = await mkdtemp(join(tmpdir(), 'tra3494-a-'));
    const b = await mkdtemp(join(tmpdir(), 'tra3494-b-'));
    for (const dir of [a, b]) {
      await flushDenominatorFlipTape({
        targetDir: dir, date: '2026-07-30',
        dump: { rows: [], droppedCandidates: 0, saturated: false, capacity: DENOM_FLIP_TAPE_CAPACITY, admitted: 0 },
        admissionRule: { changePctDeltaPp: DENOM_FLIP_CHANGEPCT_DELTA_PP, capacity: DENOM_FLIP_TAPE_CAPACITY },
        trigger: 'eod',
        processStartedAt: '2026-07-30T12:00:00.000Z',
        now: Date.parse('2026-07-31T01:00:00.000Z'),
      });
    }
    const summary = await summarizeDenominatorFlipTape(
      [
        { username: 'admin', mode: 'live', targetDir: a },
        { username: 'v0nni', mode: 'live', targetDir: b },
      ],
      { todayEt: '2026-07-30' },
    );
    expect(summary.complete).toBe(2);
    expect(summary.completeBookSessions).toBe(2);
    expect(summary.sessionsTowardBar).toBe(1);
    expect(summary.barTarget).toBe(10);
    expect(summary.barUnit).toBe('distinct-et-market-days:live-money-cohort');
    expect(summary.barDays).toHaveLength(1);
    expect(summary.barDaysVacuous).toBe(0);
    expect(summary.barDaysFailed).toBe(0);
    expect(summary.unclassifiedModes).toEqual([]);
  });

  it('an unrecognised mode is NAMED rather than silently graded not-live', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tra3494-x-'));
    const summary = await summarizeDenominatorFlipTape(
      [{ username: 'admin', mode: 'live-options', targetDir: dir }],
      { todayEt: '2026-07-30' },
    );
    // The trap: a future writer's mode string falls out of the live cohort, every
    // day reads `vacuous`, and the header still looks orderly.
    expect(summary.unclassifiedModes).toEqual(['live-options']);
  });
});
