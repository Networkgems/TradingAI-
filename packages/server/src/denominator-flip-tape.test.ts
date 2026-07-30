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
  DENOM_FLIP_TAPE_MAX_FILES,
  type DenominatorFlipTapeFile,
} from './denominator-flip-tape-writer.js';

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
      admitted: 2000,
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
