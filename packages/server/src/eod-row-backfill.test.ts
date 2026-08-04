import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { PnlTracker, type DailySnapshot } from './pnl-tracker.js';
import {
  countStaleTailSessions,
  staleTailSessions,
  foldJournalClosesByEtDay,
  type JournalDayCloses,
} from './pnl-reconciliation.js';
import {
  planLiveEodRowBackfill,
  isBackfilledRow,
  EOD_BACKFILL_ROW_SOURCE,
  CLOSING_EQUITY_BASIS_BROKER,
  CLOSING_EQUITY_BASIS_NOT_MEASURED,
  STOCK_LEG_BASIS_INERT,
  STOCK_LEG_BASIS_PROBE_DISAGREES,
  STOCK_LEG_BASIS_NOT_MEASURED,
} from './eod-row-backfill.js';

// TRA-2829 — the back-fill's contract, which is mostly about what it REFUSES to
// do: no inferred equity, no unmarked row, no overwrite, and above all no
// hard-coded session list.

/** Mon–Fri, no holiday table. Enough for the windows these tests use. */
function isWeekdayIso(iso: string): boolean {
  const d = new Date(`${iso}T00:00:00Z`).getUTCDay();
  return d !== 0 && d !== 6;
}

function row(date: string, over: Partial<DailySnapshot> = {}): DailySnapshot {
  return {
    date,
    openingEquity: 1000,
    closingEquity: 1000,
    dailyPnl: 0,
    optionsPnl: 0,
    combinedPnl: 0,
    trades: 0,
    ...over,
  };
}

function census(entries: Record<string, { closes: number; realizedPnlUsd: number }>) {
  return new Map<string, JournalDayCloses>(Object.entries(entries));
}

const CAL = { lastSettledSession: '2026-08-03', isMarketDay: isWeekdayIso };

describe('staleTailSessions — the single shared enumeration', () => {
  it('is the set countStaleTailSessions returns the size of', () => {
    // The property that matters: the writer's set and the health axis's number
    // describe the SAME sessions. If these ever diverge, the back-fill writes a
    // set nobody graded while both surfaces read correct.
    for (const anchor of ['2026-07-29', '2026-07-31', '2026-08-03', '2026-07-01']) {
      const list = staleTailSessions(anchor, '2026-08-03', isWeekdayIso);
      const n = countStaleTailSessions(anchor, '2026-08-03', isWeekdayIso);
      expect(list?.length ?? null).toBe(n);
    }
  });

  it('reproduces the live incident window without being told the dates', () => {
    expect(staleTailSessions('2026-07-29', '2026-08-03', isWeekdayIso)).toEqual([
      '2026-07-30',
      '2026-07-31',
      '2026-08-03',
    ]);
  });

  it('is NOT MEASURED (null), never [], when the book has no anchor', () => {
    expect(staleTailSessions(null, '2026-08-03', isWeekdayIso)).toBeNull();
    expect(staleTailSessions('2026-07-29', null, isWeekdayIso)).toBeNull();
  });

  it('excludes non-sessions', () => {
    // 08-01 Sat / 08-02 Sun must not appear.
    const list = staleTailSessions('2026-07-31', '2026-08-03', isWeekdayIso);
    expect(list).toEqual(['2026-08-03']);
  });
});

describe('planLiveEodRowBackfill — scope by identity', () => {
  it('scopes to the absent set, derived, not a constant 3', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-28'), row('2026-07-29')],
      censusByDate: census({}),
      balanceByDate: {},
      calendar: CAL,
    });
    expect(plan.anchorRowDate).toBe('2026-07-29');
    expect(plan.absentSessions).toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    expect(plan.rows.map(r => r.date)).toEqual(plan.absentSessions);
  });

  it('GROWS to 4 on its own when the next session also fails to write', () => {
    // The exact mis-scope the ruling warned about: a writer pinned to 3 would
    // report success while leaving 08-04 absent. Nothing here was re-configured
    // — only the settled session advanced.
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29')],
      censusByDate: census({}),
      balanceByDate: {},
      calendar: { lastSettledSession: '2026-08-04', isMarketDay: isWeekdayIso },
    });
    expect(plan.absentSessions).toHaveLength(4);
    expect(plan.absentSessions).toContain('2026-08-04');
  });

  it('SHRINKS to nothing once the ledger is current', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-08-03')],
      censusByDate: census({}),
      balanceByDate: {},
      calendar: CAL,
    });
    expect(plan.absentSessions).toEqual([]);
    expect(plan.rows).toEqual([]);
    // An empty plan on a current ledger is the SUCCESS case and must be
    // distinguishable from "could not ask".
    expect(plan.notMeasuredReason).toBeNull();
  });

  it('reports NOT MEASURED rather than clean when the book has no rows', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [],
      censusByDate: census({}),
      balanceByDate: {},
      calendar: CAL,
    });
    expect(plan.rows).toEqual([]);
    expect(plan.notMeasuredReason).toMatch(/no ledger rows/);
  });

  it('ships no date literal in the writer module', () => {
    // The acceptance criterion, enforced against the source rather than asserted.
    // Greps the bare ISO shape so a reordered or differently-quoted literal
    // cannot slip past a narrower pattern.
    const src = readFileSync(new URL('./eod-row-backfill.ts', import.meta.url), 'utf-8');
    const code = src
      .replace(/\/\*[\s\S]*?\*\//g, '')  // block comments (the incident IS documented there)
      .replace(/\/\/[^\n]*/g, '');       // line comments
    expect(code.match(/\d{4}-\d{2}-\d{2}/g)).toBeNull();
  });
});

describe('planLiveEodRowBackfill — the options leg is reconstructed at exact cents', () => {
  it('books the journal figure and close count per session', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29')],
      censusByDate: census({
        '2026-07-31': { closes: 3, realizedPnlUsd: 739 },
      }),
      balanceByDate: {},
      calendar: CAL,
    });
    const jul31 = plan.rows.find(r => r.date === '2026-07-31')!;
    expect(jul31.optionsDailyPnl).toBe(739);
    expect(jul31.optionsDailyJournalCloses).toBe(3);
    expect(jul31.optionsDailyPnlSource).toBe('journal-repair');
    // A session the journal names no closes on books a PROVEN zero, not a guess.
    const jul30 = plan.rows.find(r => r.date === '2026-07-30')!;
    expect(jul30.optionsDailyPnl).toBe(0);
    expect(jul30.optionsDailyJournalCloses).toBe(0);
    expect(plan.optionsBackfilledUsd).toBe(739);
  });

  it('satisfies combinedPnl = dailyPnl + optionsDailyPnl on every row', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29')],
      censusByDate: census({ '2026-07-31': { closes: 3, realizedPnlUsd: 739 } }),
      balanceByDate: {},
      calendar: CAL,
    });
    for (const r of plan.rows) {
      expect(r.combinedPnl).toBe(r.dailyPnl + (r.optionsDailyPnl ?? 0));
    }
  });

  it('folds a real journal shape through the shared census helper', () => {
    const closeTs = Date.parse('2026-07-31T13:43:00Z'); // 09:43 ET
    const folded = foldJournalClosesByEtDay(
      [{ closeTs, realizedPnlUsd: 713.99 }],
      ts => new Date(ts).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
    );
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29')],
      censusByDate: folded,
      balanceByDate: {},
      calendar: CAL,
    });
    expect(plan.rows.find(r => r.date === '2026-07-31')!.optionsDailyPnl).toBe(713.99);
  });
});

describe('planLiveEodRowBackfill — equity is measured or null, never inferred', () => {
  it('writes null when the broker balance series has no entry', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29', { closingEquity: 2243.48 })],
      censusByDate: census({}),
      balanceByDate: {},
      calendar: CAL,
    });
    for (const r of plan.rows) {
      expect(r.closingEquity).toBeNull();
      expect(r.closingEquityBasis).toBe(CLOSING_EQUITY_BASIS_NOT_MEASURED);
    }
    expect(plan.unmeasuredEquityRowCount).toBe(3);
    expect(plan.balanceWindow.absentSessionsUncovered).toBe(3);
    expect(plan.balanceWindow.sessions).toBe(0);
  });

  it('does NOT interpolate across a hole in the middle of the series', () => {
    // The tempting wrong answer: 07-30 and 08-03 are known, so "obviously"
    // 07-31 is between them. Refused — that number would read as recorded.
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29', { closingEquity: 2243.48 })],
      censusByDate: census({}),
      balanceByDate: { '2026-07-30': 2300, '2026-08-03': 2400 },
      calendar: CAL,
    });
    const byDate = Object.fromEntries(plan.rows.map(r => [r.date, r]));
    expect(byDate['2026-07-30']!.closingEquity).toBe(2300);
    expect(byDate['2026-07-31']!.closingEquity).toBeNull();
    expect(byDate['2026-08-03']!.closingEquity).toBe(2400);
    expect(plan.balanceWindow.absentSessionsCovered).toBe(2);
    expect(plan.balanceWindow.absentSessionsUncovered).toBe(1);
  });

  it('telescopes openingEquity off the prior close, and breaks the chain honestly', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29', { closingEquity: 2243.48 })],
      censusByDate: census({}),
      balanceByDate: { '2026-07-30': 2300, '2026-08-03': 2400 },
      calendar: CAL,
    });
    const byDate = Object.fromEntries(plan.rows.map(r => [r.date, r]));
    // First back-filled row joins the existing series.
    expect(byDate['2026-07-30']!.openingEquity).toBe(2243.48);
    // 07-31 opens where 07-30 closed — measured.
    expect(byDate['2026-07-31']!.openingEquity).toBe(2300);
    // 08-03 opens after an UNMEASURED close, so its open is unmeasured too.
    expect(byDate['2026-08-03']!.openingEquity).toBeNull();
  });

  it('reports how far the balance series reaches — the ruling deliverable', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29')],
      censusByDate: census({}),
      balanceByDate: { '2026-07-20': 1, '2026-07-30': 2300, '2026-08-03': 2400 },
      calendar: CAL,
    });
    expect(plan.balanceWindow.earliest).toBe('2026-07-20');
    expect(plan.balanceWindow.latest).toBe('2026-08-03');
    expect(plan.balanceWindow.sessions).toBe(3);
  });
});

describe('planLiveEodRowBackfill — the stock leg is shown inert, not assumed', () => {
  it('books zero and publishes an agreeing probe when equity moves match the options leg', () => {
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-30', { closingEquity: 2000 })],
      censusByDate: census({ '2026-07-31': { closes: 1, realizedPnlUsd: 100 } }),
      balanceByDate: { '2026-07-31': 2100 },
      calendar: { lastSettledSession: '2026-07-31', isMarketDay: isWeekdayIso },
    });
    const r = plan.rows[0]!;
    expect(r.dailyPnl).toBe(0);
    expect(r.stockLegProbeUsd).toBe(0);
    expect(r.stockLegBasis).toBe(STOCK_LEG_BASIS_INERT);
    expect(plan.stockLegProbeDisagreeCount).toBe(0);
  });

  it('NAMES the residual when equity moved more than the options leg explains', () => {
    // This is the trigger the ruling sets for building stock reconstruction. The
    // booked zero must stay falsifiable rather than silently absorbing $250.
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-30', { closingEquity: 2000 })],
      censusByDate: census({ '2026-07-31': { closes: 1, realizedPnlUsd: 100 } }),
      balanceByDate: { '2026-07-31': 2350 },
      calendar: { lastSettledSession: '2026-07-31', isMarketDay: isWeekdayIso },
    });
    const r = plan.rows[0]!;
    expect(r.stockLegProbeUsd).toBe(250);
    expect(r.stockLegBasis).toBe(STOCK_LEG_BASIS_PROBE_DISAGREES);
    expect(plan.stockLegProbeDisagreeCount).toBe(1);
  });

  it('leaves the probe null — not 0 — when it cannot be run', () => {
    // A probe that cannot run is NOT a probe that agrees. Collapsing the two is
    // how an unmeasurable session would read as proven-inert.
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-30', { closingEquity: null })],
      censusByDate: census({}),
      balanceByDate: {},
      calendar: { lastSettledSession: '2026-07-31', isMarketDay: isWeekdayIso },
    });
    expect(plan.rows[0]!.stockLegProbeUsd).toBeNull();
  });

  it('labels an unrunnable probe NOT MEASURED, distinctly from agreeing', () => {
    // Regression: the first cut labelled this `zero-probe-agrees`, and the live
    // plan came back claiming the probe agreed on all 3 sessions when it had run
    // on none of them. `stockLegProbeDisagreeCount: 0` must not be readable as
    // "the stock leg checks out" — hence the separate NOT-MEASURED counter.
    const plan = planLiveEodRowBackfill({
      snapshots: [row('2026-07-29', { closingEquity: 2243.48 })],
      censusByDate: census({ '2026-07-31': { closes: 3, realizedPnlUsd: 739 } }),
      balanceByDate: { '2026-08-03': 1547.15 },
      calendar: CAL,
    });
    expect(plan.rows.map(r => r.stockLegBasis)).toEqual([
      // 07-30: opens measured (from the anchor) but does not close -> unrunnable.
      STOCK_LEG_BASIS_NOT_MEASURED,
      STOCK_LEG_BASIS_NOT_MEASURED,
      STOCK_LEG_BASIS_NOT_MEASURED,
    ]);
    expect(plan.stockLegProbeNotMeasuredCount).toBe(3);
    expect(plan.stockLegProbeDisagreeCount).toBe(0);
    // The two counters must be independently readable — a zero disagree count
    // beside a full not-measured count is the honest reading of this plan.
    expect(plan.rows.every(r => r.stockLegProbeUsd === null)).toBe(true);
  });
});

describe('PnlTracker.applyEodRowBackfill', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'tra2829-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  function seeded(): PnlTracker {
    const t = new PnlTracker(dir, 1000);
    t.saveSnapshot(row('2026-07-28', { closingEquity: 2147.35, openingEquity: 2008.29 }));
    t.saveSnapshot(row('2026-07-29', { closingEquity: 2243.48, openingEquity: 2147.35 }));
    return t;
  }

  it('inserts the absent rows and marks every one of them', () => {
    const t = seeded();
    const plan = planLiveEodRowBackfill({
      snapshots: t.getSnapshots(),
      censusByDate: census({ '2026-07-31': { closes: 3, realizedPnlUsd: 739 } }),
      balanceByDate: {},
      calendar: CAL,
    });
    const inserted = t.applyEodRowBackfill(plan.rows);
    expect(inserted).toEqual(['2026-07-30', '2026-07-31', '2026-08-03']);
    const after = t.getSnapshots();
    expect(after.map(s => s.date)).toEqual([
      '2026-07-28', '2026-07-29', '2026-07-30', '2026-07-31', '2026-08-03',
    ]);
    for (const s of after.filter(s => s.date > '2026-07-29')) {
      expect(s.rowSource).toBe(EOD_BACKFILL_ROW_SOURCE);
      expect(isBackfilledRow(s)).toBe(true);
    }
  });

  it('leaves every pre-existing row BYTE-IDENTICAL — proven by diff, not asserted', () => {
    // The acceptance criterion. Compares the serialized bytes of the pre-existing
    // rows before and after, so a field silently added or an openingEquity
    // rebased would fail here rather than pass on a spot-check of one field.
    const t = seeded();
    const file = join(dir, 'daily-snapshots.json');
    const before = JSON.parse(readFileSync(file, 'utf-8')) as DailySnapshot[];
    const beforeBytes = JSON.stringify(before);

    const plan = planLiveEodRowBackfill({
      snapshots: t.getSnapshots(),
      censusByDate: census({ '2026-07-31': { closes: 3, realizedPnlUsd: 739 } }),
      balanceByDate: {},
      calendar: CAL,
    });
    t.applyEodRowBackfill(plan.rows);

    const after = JSON.parse(readFileSync(file, 'utf-8')) as DailySnapshot[];
    const preExisting = after.filter(s => before.some(b => b.date === s.date));
    expect(JSON.stringify(preExisting)).toBe(beforeBytes);
    expect(preExisting.map(s => s.openingEquity)).toEqual(before.map(s => s.openingEquity));
  });

  it('does NOT rebase the live dashboard anchor off a historical row', () => {
    // `saveSnapshot` would set openingEquity/openingDate from the row it writes.
    // A back-fill must not: it would hand the running dashboard a days-old anchor.
    const t = seeded();
    const anchorBefore = t.getOpeningEquity();
    const plan = planLiveEodRowBackfill({
      snapshots: t.getSnapshots(),
      censusByDate: census({}),
      balanceByDate: { '2026-08-03': 9999 },
      calendar: CAL,
    });
    t.applyEodRowBackfill(plan.rows);
    expect(t.getOpeningEquity()).toBe(anchorBefore);
  });

  it('is idempotent — bqb1 restarts several times an hour', () => {
    const t = seeded();
    const mk = () => planLiveEodRowBackfill({
      snapshots: t.getSnapshots(),
      censusByDate: census({ '2026-07-31': { closes: 3, realizedPnlUsd: 739 } }),
      balanceByDate: {},
      calendar: CAL,
    });
    expect(t.applyEodRowBackfill(mk().rows)).toHaveLength(3);
    // Second pass: the plan itself is now empty, because the rows exist.
    expect(mk().absentSessions).toEqual([]);
    expect(t.applyEodRowBackfill(mk().rows)).toEqual([]);
    expect(t.getSnapshots()).toHaveLength(5);
  });

  it('never overwrites a recorded row, even if handed one', () => {
    const t = seeded();
    const written = t.applyEodRowBackfill([
      row('2026-07-29', { closingEquity: 1, rowSource: EOD_BACKFILL_ROW_SOURCE }),
    ]);
    expect(written).toEqual([]);
    expect(t.getSnapshots().find(s => s.date === '2026-07-29')!.closingEquity).toBe(2243.48);
  });

  it('REFUSES an unmarked row rather than writing one that reads as recorded', () => {
    const t = seeded();
    expect(t.applyEodRowBackfill([row('2026-07-30')])).toEqual([]);
    expect(t.getSnapshots()).toHaveLength(2);
  });

  it('keeps peakEquity sane when a back-filled row has no equity anchor', () => {
    // Math.max(..., null) is 0, which would cap peak equity at zero and turn
    // every drawdown reading on the book into a fiction.
    const t = seeded();
    t.applyEodRowBackfill([
      row('2026-07-30', { closingEquity: null, openingEquity: null, rowSource: EOD_BACKFILL_ROW_SOURCE }),
    ]);
    expect(t.getCumulativeStats(2243.48).peakEquity).toBe(2243.48);
  });
});
