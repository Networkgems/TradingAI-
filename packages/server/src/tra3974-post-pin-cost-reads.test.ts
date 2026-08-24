// TRA-3974 (parent TRA-3945) — the post-pin cost read the pre-registered window
// assumed was free.
//
// AC1: live-mode coverage of the fill-time quote on live `single_leg_otm` rows,
//      `rowsWithQuote / rowsTotal`, with the three MISS classes kept apart (a
//      recorder gap is fixable forward, a market-data gap never is) and an
//      EMPTY population reading `null`, never `0`.
// AC2: a window-scoped accumulator that is post-pin BY CONSTRUCTION — refuses a
//      pre-pin row, refuses another cell, refuses another gate, survives a
//      restart EXACTLY (no loss, no double-count across the boot replay), and
//      keeps a representative quantile at volumes where a head-truncated cap
//      would publish a p50 of the window's first weeks.
// AC3: the median-entry-spreadR split over the window's OWN counted closes,
//      withheld under a STATED blind below n=6 rather than published as a
//      2-vs-1 "finding".
// AC4: additive and read-only — an observer that throws cannot break the
//      ledger's own verdict or its counters.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  OTM_WINDOW_COST_RESERVOIR_MAX,
  armOtmWindowCostAccumulator,
  buildOtmWindowCostAccumulatorRecord,
  flushOtmWindowCostAccumulator,
  loadOtmWindowCostAccumulator,
  observeLiveEnforceRecordForOtmWindow,
  peekOtmWindowCostAccumulatorState,
  primeOtmWindowCostAccumulatorFromWindowState,
  reservoirAdmit,
  resolveOtmWindowCostCellKeys,
  setOtmWindowCostAccumulatorFileForTests,
} from './otm-window-cost-accumulator.js';
import {
  clearLiveEnforceGateLedger,
  onLiveEnforceRecord,
  recordLiveEnforceDecision,
  summarizeLiveEnforceGate,
  type LiveEnforceRecord,
} from './live-enforce-gate-ledger.js';
import {
  buildOtmEntryQuoteRecord,
  buildOtmEntryQuoteRow,
  foldOtmEntryQuoteCoverage,
  foldOtmEntrySpreadSplit,
  measureOtmEntryQuote,
  selectLiveOtmRows,
  type OtmEntryQuoteInputRow,
} from './otm-window-entry-quote.js';
import {
  buildOtmEvaluationWindowRecord,
  emptyOtmEvaluationWindowState,
  evaluateOtmEvaluationLiveness,
  foldOtmEvaluationWindow,
  selectOtmEvaluationCountedCloses,
  type OtmEvaluationWindowState,
} from './otm-evaluation-window.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

const PIN_MS = Date.UTC(2026, 7, 24, 20, 30); // 2026-08-24T20:30Z — the window pin
const MIN = 60_000;
const CELL = 'single_leg_otm::0.50-0.55';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'tra3974-'));
  setOtmWindowCostAccumulatorFileForTests(join(dir, 'otm-evaluation-window-cost.json'));
});

afterEach(() => {
  setOtmWindowCostAccumulatorFileForTests(null);
  rmSync(dir, { recursive: true, force: true });
});

function costRow(over: Partial<LiveEnforceRecord> = {}): LiveEnforceRecord {
  return {
    ts: PIN_MS + MIN,
    etDay: '2026-08-24',
    gate: 'cost_bar',
    scope: 'single_leg_otm',
    blocked: false,
    cell: CELL,
    book: 'trader1',
    grossR: 1.47,
    cost: { costR: 0.4, spreadR: 0.35, feeR: 0.05, costFracOfPremium: 0.1 },
    ...over,
  };
}

function arm(now = PIN_MS): void {
  loadOtmWindowCostAccumulator('otm-joint-arm-w1');
  armOtmWindowCostAccumulator({
    windowId: 'otm-joint-arm-w1',
    startedAt: PIN_MS,
    band: { deltaAbsMin: 0.5, deltaAbsMax: 0.55 },
    now,
  });
}

// ── AC2, the cell set ───────────────────────────────────────────────────────

describe('TRA-3974 AC2 — the population cell resolves to a SET of ledger cell labels', () => {
  it('option B [0.50,0.55) is exactly the one bucket the live tape stamps', () => {
    expect(resolveOtmWindowCostCellKeys({ deltaAbsMin: 0.5, deltaAbsMax: 0.55 }))
      .toEqual(['single_leg_otm::0.50-0.55']);
  });

  it('option A [0.25,0.40] spans THREE buckets and none of them is dropped', () => {
    // The defect this guards: narrowing a multi-bucket population cell to one
    // label would accrue a THIRD of the population while reporting a full count.
    expect(resolveOtmWindowCostCellKeys({ deltaAbsMin: 0.25, deltaAbsMax: 0.4 })).toEqual([
      'single_leg_otm::0.25-0.30',
      'single_leg_otm::0.30-0.35',
      'single_leg_otm::0.35-0.40',
    ]);
  });

  it('a band ending exactly on a bucket edge does NOT pick up the bucket above it', () => {
    expect(resolveOtmWindowCostCellKeys({ deltaAbsMin: 0.5, deltaAbsMax: 0.55 }))
      .not.toContain('single_leg_otm::0.55-0.60');
  });

  it('an empty or inverted band resolves to no cell at all, and the arm refuses', () => {
    expect(resolveOtmWindowCostCellKeys({ deltaAbsMin: 0.55, deltaAbsMax: 0.5 })).toEqual([]);
    loadOtmWindowCostAccumulator('otm-joint-arm-w1');
    const r = armOtmWindowCostAccumulator({
      windowId: 'otm-joint-arm-w1', startedAt: PIN_MS,
      band: { deltaAbsMin: 0.55, deltaAbsMax: 0.5 }, now: PIN_MS,
    });
    expect(r.armed).toBe(false);
    expect(peekOtmWindowCostAccumulatorState()?.startedAt).toBeNull();
  });
});

// ── AC2, post-pin by construction ───────────────────────────────────────────

describe('TRA-3974 AC2 — post-pin BY CONSTRUCTION, with every refusal named', () => {
  it('refuses everything before the arm and counts it under notArmed', () => {
    loadOtmWindowCostAccumulator('otm-joint-arm-w1');
    observeLiveEnforceRecordForOtmWindow(costRow());
    expect(peekOtmWindowCostAccumulatorState()!.evaluated).toBe(0);
    expect(peekOtmWindowCostAccumulatorState()!.refused.notArmed).toBe(1);
  });

  it('a PRE-pin row in the right cell is refused — this is the whole defect', () => {
    arm();
    // The 2713 rows on the live wire on 2026-08-24 are all of this shape.
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS - 1 }));
    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(0);
    expect(s.refused.prePin).toBe(1);
  });

  it('accrues a post-pin row in the cell, exactly and with its identity', () => {
    arm();
    observeLiveEnforceRecordForOtmWindow(costRow());
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + 2 * MIN, blocked: true }));
    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(2);
    expect(s.blocked).toBe(1);
    expect(s.spreadR.n).toBe(2);
    // The identity the gate ledger's own CostSample does not keep.
    expect(s.reservoir[0]!.ts).toBe(PIN_MS + MIN);
    expect(s.reservoir[0]!.book).toBe('trader1');
    expect(s.reservoir[0]!.cell).toBe(CELL);
  });

  it('refuses another gate, another cell, and an unstamped cell — separately', () => {
    arm();
    observeLiveEnforceRecordForOtmWindow(costRow({ gate: 'spread' }));
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + 2 * MIN, cell: 'single_leg_otm::0.45-0.50' }));
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + 3 * MIN, cell: undefined }));
    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(0);
    expect(s.refused.otherGate).toBe(1);
    expect(s.refused.otherCell).toBe(1);
    expect(s.refused.noCell).toBe(1);
  });

  it('a cost_bar row in the cell with NO usable cost is a counted coverage hole, not a skip', () => {
    arm();
    observeLiveEnforceRecordForOtmWindow(costRow({ cost: undefined }));
    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(0);
    expect(s.refused.noCost).toBe(1);
    // …and it still advances the replay cursor, so the boot replay cannot
    // re-offer it as if it were new.
    expect(s.lastTs).toBe(PIN_MS + MIN);
  });

  it('the pin is WRITE-ONCE: a second arm on a different pin does not re-key the accrued rows', () => {
    arm();
    observeLiveEnforceRecordForOtmWindow(costRow());
    armOtmWindowCostAccumulator({
      windowId: 'otm-joint-arm-w1', startedAt: PIN_MS + 99 * MIN,
      band: { deltaAbsMin: 0.25, deltaAbsMax: 0.4 }, now: PIN_MS + 99 * MIN,
    });
    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.startedAt).toBe(PIN_MS);
    expect(s.cellKeys).toEqual([CELL]);
    expect(s.evaluated).toBe(1);
  });
});

// ── AC2, durability ─────────────────────────────────────────────────────────

describe('TRA-3974 AC2 — survives the 30-day gate-ledger retention AND a restart, exactly', () => {
  it('persists beside the window state and reloads its counters', () => {
    arm();
    observeLiveEnforceRecordForOtmWindow(costRow());
    expect(flushOtmWindowCostAccumulator(PIN_MS + 5 * MIN)).toBe(true);
    const file = join(dir, 'otm-evaluation-window-cost.json');
    expect(existsSync(file)).toBe(true);
    const onDisk = JSON.parse(readFileSync(file, 'utf8')) as { evaluated: number; startedAt: number };
    expect(onDisk.evaluated).toBe(1);
    expect(onDisk.startedAt).toBe(PIN_MS);
  });

  it('a boot replay of rows ALREADY folded in does not double-count them', () => {
    arm();
    const rows = [
      costRow({ ts: PIN_MS + MIN }),
      costRow({ ts: PIN_MS + 2 * MIN }),
      // Two rows sharing one millisecond — the case a ts-only cursor gets wrong.
      costRow({ ts: PIN_MS + 3 * MIN }),
      costRow({ ts: PIN_MS + 3 * MIN, blocked: true }),
    ];
    for (const r of rows) observeLiveEnforceRecordForOtmWindow(r);
    expect(peekOtmWindowCostAccumulatorState()!.evaluated).toBe(4);
    flushOtmWindowCostAccumulator(PIN_MS + 4 * MIN);

    // Restart: drop the in-memory state, reload from disk, replay the SAME
    // JSONL (what `hydrateLiveEnforceGateFromDisk` does) plus one NEW row that
    // landed after the last persist.
    setOtmWindowCostAccumulatorFileForTests(join(dir, 'otm-evaluation-window-cost.json'));
    loadOtmWindowCostAccumulator('otm-joint-arm-w1');
    expect(peekOtmWindowCostAccumulatorState()!.evaluated).toBe(4);
    for (const r of rows) observeLiveEnforceRecordForOtmWindow(r);
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + 9 * MIN }));

    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(5);            // 4 recovered + 1 genuinely new
    expect(s.refused.replayDuplicate).toBe(4);
    expect(s.blocked).toBe(1);
  });

  // The live case on 2026-08-24: the window opened 2026-08-23T01:40:43Z and
  // this accumulator ships days later. Arming only on the window TICK would
  // refuse the entire boot replay under `notArmed` and throw away every
  // post-pin row the gate ledger still retains.
  it('primes from the TRA-3945 window state at BOOT, so the ledger replay recovers the arm lag', () => {
    const wsFile = join(dir, 'otm-evaluation-window.json');
    writeFileSync(wsFile, JSON.stringify({
      version: 1,
      windowId: 'otm-joint-arm-w1',
      startedAt: PIN_MS,
      populationCell: {
        deltaAbsMin: 0.5, deltaAbsMax: 0.55, tolerance: 0.005,
        floorBand: [0.5, 0.6], selectorBand: [0.45, 0.55],
        frozen: true, frozenAt: PIN_MS, pooledCellsForbidden: true,
      },
    }), 'utf8');
    setOtmWindowCostAccumulatorFileForTests(join(dir, 'otm-evaluation-window-cost.json'), wsFile);

    const primed = primeOtmWindowCostAccumulatorFromWindowState('otm-joint-arm-w1');
    expect(primed.armed).toBe(true);
    expect(peekOtmWindowCostAccumulatorState()!.startedAt).toBe(PIN_MS);

    // …now the hydrate replays the retained JSONL: pre-pin rows are refused,
    // post-pin ones are RECOVERED even though nothing armed while they landed.
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS - 10 * MIN }));
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + 10 * MIN }));
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + 20 * MIN }));
    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(2);
    expect(s.refused.prePin).toBe(1);
    expect(s.refused.notArmed).toBe(0);
  });

  it('refuses to prime off a PREVIEW cell — a band that can still move must not key the accrual', () => {
    const wsFile = join(dir, 'otm-evaluation-window.json');
    writeFileSync(wsFile, JSON.stringify({
      version: 1, windowId: 'otm-joint-arm-w1', startedAt: PIN_MS,
      populationCell: { deltaAbsMin: 0.5, deltaAbsMax: 0.55, frozen: false, frozenAt: null },
    }), 'utf8');
    setOtmWindowCostAccumulatorFileForTests(join(dir, 'otm-evaluation-window-cost.json'), wsFile);
    const primed = primeOtmWindowCostAccumulatorFromWindowState('otm-joint-arm-w1');
    expect(primed.armed).toBe(false);
    expect(primed.reason).toContain('FROZEN');
  });

  it('an unopened window is a stated reason, not a silent no-op', () => {
    setOtmWindowCostAccumulatorFileForTests(
      join(dir, 'otm-evaluation-window-cost.json'), join(dir, 'nope.json'),
    );
    const primed = primeOtmWindowCostAccumulatorFromWindowState('otm-joint-arm-w1');
    expect(primed.armed).toBe(false);
    expect(primed.reason).toContain('never opened');
  });

  it('a row recorded AFTER the last persist is recovered by the replay, not lost', () => {
    arm();
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + MIN }));
    flushOtmWindowCostAccumulator(PIN_MS + 2 * MIN);
    // …process dies here; this row reached the ledger JSONL but not our file.
    const orphan = costRow({ ts: PIN_MS + 3 * MIN });

    setOtmWindowCostAccumulatorFileForTests(join(dir, 'otm-evaluation-window-cost.json'));
    loadOtmWindowCostAccumulator('otm-joint-arm-w1');
    observeLiveEnforceRecordForOtmWindow(costRow({ ts: PIN_MS + MIN })); // replayed, skipped
    observeLiveEnforceRecordForOtmWindow(orphan);                        // replayed, RECOVERED

    const s = peekOtmWindowCostAccumulatorState()!;
    expect(s.evaluated).toBe(2);
    expect(s.refused.replayDuplicate).toBe(1);
  });
});

// ── AC2, the quantile that has to survive nine weeks ────────────────────────

describe('TRA-3974 AC2 — the reservoir keeps the quantile representative', () => {
  it('the accept/replace draw is a pure function of (seed, index) — identical across a restart', () => {
    const a = Array.from({ length: 200 }, (_, i) => reservoirAdmit(12345, 5000 + i, 4000));
    const b = Array.from({ length: 200 }, (_, i) => reservoirAdmit(12345, 5000 + i, 4000));
    expect(a).toEqual(b);
    // A different seed must NOT produce the identical sequence, or the "draw"
    // is a constant and the reservoir is just a head-truncating cap again.
    const c = Array.from({ length: 200 }, (_, i) => reservoirAdmit(999, 5000 + i, 4000));
    expect(c).not.toEqual(a);
  });

  it('fills the reservoir head-first, then admits at roughly k/i', () => {
    expect(reservoirAdmit(1, 0, 10).admit).toBe(true);
    expect(reservoirAdmit(1, 9, 10)).toEqual({ admit: true, replaceAt: 9 });
    const admits = Array.from({ length: 2000 }, (_, i) => reservoirAdmit(7, 1000 + i, 100))
      .filter((r) => r.admit).length;
    // Expectation is Σ 100/(i+1) over i∈[1000,3000) ≈ 110. A head-truncating cap
    // would admit ZERO of these, which is the bias this replaces.
    expect(admits).toBeGreaterThan(60);
    expect(admits).toBeLessThan(180);
    expect(admits).toBeLessThan(2000);
  });

  it('quantiles come off the reservoir and the record SAYS when it is sampling', () => {
    arm();
    for (let i = 0; i < 50; i += 1) {
      observeLiveEnforceRecordForOtmWindow(costRow({
        ts: PIN_MS + (i + 1) * MIN,
        cost: { costR: 0.4, spreadR: 0.3 + i * 0.001, feeR: 0.05, costFracOfPremium: 0.1 },
      }));
    }
    const rec = buildOtmWindowCostAccumulatorRecord(peekOtmWindowCostAccumulatorState(), PIN_MS + 60 * MIN);
    expect(rec.armed).toBe(true);
    if (!rec.armed) throw new Error('unreachable');
    expect(rec.evaluated).toBe(50);
    expect(rec.quantiles.sampling).toBe(false);
    expect(rec.quantiles.capacity).toBe(OTM_WINDOW_COST_RESERVOIR_MAX);
    expect(rec.quantiles.spreadR.p50).toBeCloseTo(0.3245, 4);
    // The EXACT block never samples, at any volume.
    expect(rec.exact.spreadR.n).toBe(50);
    expect(rec.exact.spreadR.mean).toBeCloseTo(0.32450, 5);
  });
});

// ── AC1 ─────────────────────────────────────────────────────────────────────

function journalRow(over: Partial<OtmEntryQuoteInputRow> = {}): OtmEntryQuoteInputRow {
  return {
    id: 'j1',
    symbol: 'XLF',
    optionSymbol: 'XLF261016C00045000',
    structure: 'single_leg_otm',
    mode: 'live',
    outcome: 'WIN',
    openTs: PIN_MS + MIN,
    closeTs: PIN_MS + 120 * MIN,
    entryDelta: 0.52,
    entryBid: 1.9,
    entryAsk: 2.1,
    entryMarkUsd: 2.0,
    realizedR: 0.3,
    realizedPnlUsd: 75,
    ...over,
  };
}

describe('TRA-3974 AC1 — live-mode coverage of the fill-time quote', () => {
  it('measures the spread in the GATE R basis, the same one the cost bar uses', () => {
    const m = measureOtmEntryQuote(journalRow());
    expect(m.miss).toBeNull();
    // (2.10 − 1.90) / (0.25 · 2.00) = 0.40
    expect(m.measurement!.spreadCrossR).toBeCloseTo(0.4, 10);
    // …and publishes the JOURNAL basis beside it, 4× smaller, so the two can
    // never be silently compared.
    expect(buildOtmEntryQuoteRow(journalRow()).entrySpreadRPremiumBasis).toBeCloseTo(0.1, 10);
  });

  it('keeps the three MISS classes apart — they have different remedies', () => {
    expect(measureOtmEntryQuote(journalRow({ entryBid: null, entryAsk: null, entryMarkUsd: null })).miss)
      .toBe('no_stamp');
    expect(measureOtmEntryQuote(journalRow({ entryMarkUsd: null })).miss).toBe('partial_stamp');
    // Crossed book: the recorder worked, the book did not. Never fixable.
    expect(measureOtmEntryQuote(journalRow({ entryBid: 2.2, entryAsk: 2.0 })).miss).toBe('unusable_quote');
  });

  it('a crossed book NEVER lands in the numerator as a free fill', () => {
    const rows = [journalRow(), journalRow({ id: 'j2', entryBid: 2.2, entryAsk: 2.0 })].map(buildOtmEntryQuoteRow);
    const c = foldOtmEntryQuoteCoverage(rows);
    expect(c.rowsTotal).toBe(2);
    expect(c.rowsWithQuote).toBe(1);
    expect(c.coverage).toBe(0.5);
    expect(c.misses.unusable_quote).toBe(1);
    // The p50 is over the ONE measurable row, not over two with a zero.
    expect(c.entrySpreadR.p50).toBeCloseTo(0.4, 10);
  });

  it('an EMPTY population reads null, never 0 — "never measured" is not "measured and empty"', () => {
    const c = foldOtmEntryQuoteCoverage([]);
    expect(c.coverage).toBeNull();
    expect(c.rowsTotal).toBe(0);
    const rec = buildOtmEntryQuoteRecord({ allLiveRows: [], postPinRows: null, startedAt: null, countedCloses: [] });
    expect(rec.urgency).toBe('no_population');
  });

  it('selects LIVE OTM rows only, and scopes to post-pin entries on request', () => {
    const records: OtmEntryQuoteInputRow[] = [
      journalRow({ id: 'pre', openTs: PIN_MS - MIN }),
      journalRow({ id: 'post' }),
      journalRow({ id: 'demo', mode: 'demo' }),
      journalRow({ id: 'rv', structure: 'single_leg_rv' }),
    ];
    expect(selectLiveOtmRows(records).map((r) => r.key)).toEqual(['pre', 'post']);
    expect(selectLiveOtmRows(records, { sinceOpenTs: PIN_MS }).map((r) => r.key)).toEqual(['post']);
  });

  it('calls the urgency AC1 exists to decide', () => {
    const uninstrumented = [journalRow({ entryBid: null, entryAsk: null, entryMarkUsd: null })]
      .map(buildOtmEntryQuoteRow);
    expect(buildOtmEntryQuoteRecord({
      allLiveRows: uninstrumented, postPinRows: null, startedAt: null, countedCloses: [],
    }).urgency).toBe('uninstrumented');

    const covered = Array.from({ length: 10 }, (_, i) => buildOtmEntryQuoteRow(journalRow({ id: `c${i}` })));
    expect(buildOtmEntryQuoteRecord({
      allLiveRows: covered, postPinRows: covered, startedAt: PIN_MS, countedCloses: [],
    }).urgency).toBe('recoverable');

    const half = [...covered.slice(0, 5), ...covered.slice(5).map((r) => ({ ...r, entrySpreadR: null, miss: 'no_stamp' as const }))];
    expect(buildOtmEntryQuoteRecord({
      allLiveRows: half, postPinRows: null, startedAt: null, countedCloses: [],
    }).urgency).toBe('partial');
  });
});

// ── AC3 ─────────────────────────────────────────────────────────────────────

describe('TRA-3974 AC3 — the median entry-spread split', () => {
  const spreadRow = (i: number, bid: number, ask: number, r: number) =>
    buildOtmEntryQuoteRow(journalRow({
      id: `s${i}`, entryBid: bid, entryAsk: ask, entryMarkUsd: 2.0,
      realizedR: r, realizedPnlUsd: r * 250,
    }));

  it('withholds the split below n=6 with a STATED blind, not a null result', () => {
    const split = foldOtmEntrySpreadSplit([spreadRow(0, 1.95, 2.05, 0.5), spreadRow(1, 1.8, 2.2, -0.5)]);
    expect(split.computable).toBe(false);
    expect(split.medianEntrySpreadR).toBeNull();
    expect(split.blindReason).toContain('UNDERPOWERED');
  });

  it('splits at the median and reports the R difference either side', () => {
    const rows = [
      spreadRow(0, 1.98, 2.02, 1.0),  // spreadR 0.08
      spreadRow(1, 1.97, 2.03, 0.8),  // 0.12
      spreadRow(2, 1.96, 2.04, 0.6),  // 0.16
      spreadRow(3, 1.90, 2.10, -0.2), // 0.40
      spreadRow(4, 1.85, 2.15, -0.4), // 0.60
      spreadRow(5, 1.80, 2.20, -0.6), // 0.80
    ];
    const split = foldOtmEntrySpreadSplit(rows);
    expect(split.n).toBe(6);
    expect(split.computable).toBe(true);
    expect(split.medianEntrySpreadR).toBeCloseTo(0.28, 6);
    expect(split.cheap.n).toBe(3);
    expect(split.rich.n).toBe(3);
    expect(split.cheap.avgR).toBeCloseTo(0.8, 6);
    expect(split.rich.avgR).toBeCloseTo(-0.4, 6);
    expect(split.avgRDelta).toBeCloseTo(1.2, 6);
  });

  it('a tape where every row shares one spread reads DEGENERATE, never as a comparison', () => {
    const rows = Array.from({ length: 8 }, (_, i) => spreadRow(i, 1.9, 2.1, i % 2 === 0 ? 0.5 : -0.5));
    const split = foldOtmEntrySpreadSplit(rows);
    expect(split.tiesGoTo).toBe('cheap');
    expect(split.cheap.n).toBe(8);
    expect(split.rich.n).toBe(0);
    expect(split.computable).toBe(false);
    expect(split.avgRDelta).toBeNull();
    expect(split.blindReason).toContain('DEGENERATE');
  });

  it('excludes rows with no usable quote — a split over them would be over a SELECTED population', () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => spreadRow(i, 1.9 - i * 0.01, 2.1 + i * 0.01, 0.1 * i)),
      buildOtmEntryQuoteRow(journalRow({ id: 'nq', entryBid: null, entryAsk: null, entryMarkUsd: null })),
    ];
    expect(foldOtmEntrySpreadSplit(rows).n).toBe(6);
  });
});

// ── AC3, the population is the WINDOW's, not a re-derived one ───────────────

describe('TRA-3974 AC3 — the split runs over the record\'s OWN counted closes', () => {
  function windowState(): OtmEvaluationWindowState {
    return {
      ...emptyOtmEvaluationWindowState(),
      startedAt: PIN_MS,
      populationCell: {
        deltaAbsMin: 0.5, deltaAbsMax: 0.55, tolerance: 0.005,
        floorBand: [0.5, 0.6], selectorBand: [0.45, 0.55],
        frozen: true, frozenAt: PIN_MS, pooledCellsForbidden: true,
      },
    };
  }

  it('a close outside the frozen delta cell is in neither the readout nor the split', () => {
    const base = (over: Partial<OptionTradeJournalRecord & { brokerOrderId?: number }>) => ({
      ...journalRow(), atRiskUsd: 250, entryDte: 30, ivRank: null, trend: 'up', sentiment: null,
      exitReason: 'trail', holdDays: 0.1, ...over,
    }) as unknown as OptionTradeJournalRecord & { brokerOrderId?: number };

    const records = [
      base({ id: 'in', brokerOrderId: 1, openTs: PIN_MS + MIN, closeTs: PIN_MS + 60 * MIN, entryDelta: 0.52 }),
      base({ id: 'out', brokerOrderId: 2, openTs: PIN_MS + MIN, closeTs: PIN_MS + 60 * MIN, entryDelta: 0.30 }),
      base({ id: 'pre', brokerOrderId: 3, openTs: PIN_MS - MIN, closeTs: PIN_MS + 60 * MIN, entryDelta: 0.52 }),
    ];
    const st = windowState();
    const { counted } = selectOtmEvaluationCountedCloses(records, st, PIN_MS + 999 * MIN);
    expect(counted.map((r) => r.id)).toEqual(['in']);
    // The refactor that split this out must not have moved the readout.
    const readout = foldOtmEvaluationWindow(records, st, PIN_MS + 999 * MIN);
    expect(readout.n).toBe(1);
    expect(readout.excludedCloses.reasons.outsideDeltaCell).toBe(1);
    expect(readout.excludedCloses.reasons.entryPredatesStart).toBe(1);
  });
});

// ── AC4 / AC5 — additive, read-only, and gradeable by field presence ────────

describe('TRA-3974 AC4+AC5 — additive, read-only, present on the wire', () => {
  it('the TRA-3945 record carries both blocks, and publishes NULL rather than omitting them', () => {
    const st = emptyOtmEvaluationWindowState();
    const liveness = evaluateOtmEvaluationLiveness({});
    const readout = foldOtmEvaluationWindow([], st, PIN_MS);

    const withoutReads = buildOtmEvaluationWindowRecord(st, liveness, null, readout);
    // An ABSENT key reads as "not deployed" to a grader pinning field presence;
    // a NULL key reads as "deployed, nothing to say". They must differ.
    expect('postPinCost' in withoutReads).toBe(true);
    expect(withoutReads.postPinCost).toBeNull();
    expect(withoutReads.postPinReadsIssue).toBe('TRA-3974');

    arm();
    observeLiveEnforceRecordForOtmWindow(costRow());
    const withReads = buildOtmEvaluationWindowRecord(st, liveness, null, readout, {
      costAccumulator: buildOtmWindowCostAccumulatorRecord(peekOtmWindowCostAccumulatorState(), PIN_MS + MIN),
      entryQuote: buildOtmEntryQuoteRecord({
        allLiveRows: [buildOtmEntryQuoteRow(journalRow())],
        postPinRows: null, startedAt: null, countedCloses: [],
      }),
    });
    expect(withReads.postPinCost).not.toBeNull();
    expect(withReads.postPinCost!.armed).toBe(true);
    expect(withReads.postPinCost!.readOnly).toBe(true);
    expect(withReads.entryQuote!.readOnly).toBe(true);
    expect(withReads.entryQuote!.mode).toBe('live');
    // AC4: nothing the record already published moved.
    expect(withReads.n).toBe(withoutReads.n);
    expect(withReads.criteria).toBe(withoutReads.criteria);
    expect(withReads.populationCell).toEqual(withoutReads.populationCell);
    expect(withReads.thresholds).toEqual(withoutReads.thresholds);
  });

  it('an UNARMED accumulator says so instead of publishing a zero that reads like a measurement', () => {
    const rec = buildOtmWindowCostAccumulatorRecord(null, PIN_MS);
    expect(rec.armed).toBe(false);
    expect(rec.note).toContain('NOT ARMED');
  });

  // Registered LAST in the file on purpose: `onLiveEnforceRecord` has no
  // unsubscribe (the call sites are module-init), so a throwing observer would
  // otherwise pollute every test after it.
  it('an observer that THROWS cannot break the ledger\'s own verdict or its counters', () => {
    clearLiveEnforceGateLedger();
    let armedToThrow = false;
    let seen = 0;
    onLiveEnforceRecord(() => {
      seen += 1;
      if (armedToThrow) throw new Error('TRA-3974 negative control');
    });

    recordLiveEnforceDecision('cost_bar', 'single_leg_otm', true, '2026-08-24', 'under bar', PIN_MS, {
      cell: CELL, cost: { costR: 0.4, spreadR: 0.35, feeR: 0.05, costFracOfPremium: 0.1 },
    });
    expect(seen).toBe(1);
    const clean = summarizeLiveEnforceGate('2026-08-24');

    armedToThrow = true;
    // The exact same decision, with the observer now throwing. If the throw
    // could reach the ledger this would either propagate (killing an order
    // path) or lose the row.
    expect(() => recordLiveEnforceDecision(
      'cost_bar', 'single_leg_otm', true, '2026-08-24', 'under bar', PIN_MS + 1, {
        cell: CELL, cost: { costR: 0.4, spreadR: 0.35, feeR: 0.05, costFracOfPremium: 0.1 },
      },
    )).not.toThrow();
    armedToThrow = false;

    const after = summarizeLiveEnforceGate('2026-08-24');
    expect(after.decisionsRecorded).toBe(clean.decisionsRecorded + 1);
    const cell = after.retained.byGate
      .find((g) => g.gate === 'cost_bar')?.byCell.find((c) => c.cell === CELL);
    expect(cell?.evaluated).toBe(2);
    expect(cell?.blocked).toBe(2);
  });
});
