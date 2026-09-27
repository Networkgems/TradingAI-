import { describe, expect, it } from 'vitest';
import {
  EVAL_CELL_MIN_N,
  EVAL_FEE_PER_CONTRACT_PER_SIDE_USD,
  EVAL_PSR_MIN_N,
  OPTIONS_EVAL_CONSTRAINTS,
  OPTIONS_PATH_TUNED_PARAMS,
  avgDrawdownR,
  buildMetricsCell,
  buildOptionsEvaluationReport,
  buildWalkForward,
  evaluateOptionTradeRow,
  extractEvaluatedTrades,
} from './options-evaluation-report.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// TRA-4914 — the options evaluation report. The properties under test are the
// ones that make the artifact trustworthy rather than the ones that make it
// pretty: thin samples must read INSUFFICIENT and never 0, costs must actually
// come out of the numbers, and the estimators must be the existing
// `packages/backtest` ones rather than a second copy.

const DAY = 86_400_000;

function row(over: Partial<OptionTradeJournalRecord>): OptionTradeJournalRecord {
  return {
    id: over.id ?? 'x',
    openTs: 1,
    symbol: 'AAPL',
    structure: 'single_leg_rv',
    mode: 'demo',
    ivRank: null,
    trend: 'up',
    sentiment: null,
    entryDelta: 0.5,
    entryDte: 40,
    atRiskUsd: 100,
    outcome: 'OPEN',
    ...over,
  };
}

/** A closed row priced off measured slippage (rung 3 of the cost ladder). */
function closedWithSlippage(
  id: string,
  closeTs: number,
  bookedPnlUsd: number,
  over: Partial<OptionTradeJournalRecord> = {},
): OptionTradeJournalRecord {
  return row({
    id,
    closeTs,
    outcome: bookedPnlUsd > 0 ? 'WIN' : 'LOSS',
    realizedPnlUsd: bookedPnlUsd,
    realizedR: bookedPnlUsd / 100,
    exitReason: 'trail',
    holdDays: 1,
    contracts: 1,
    entrySlippageUsd: 1,
    exitSlippageUsd: 1,
    ...over,
  });
}

describe('cost-inclusive extraction (TRA-4914 AC: costs, not gross numbers)', () => {
  it('takes measured slippage AND the fee residue out of a mark-basis row', () => {
    const out = evaluateOptionTradeRow(closedWithSlippage('a', 10, 20));
    expect('trade' in out).toBe(true);
    if (!('trade' in out)) return;
    const fees = 2 * EVAL_FEE_PER_CONTRACT_PER_SIDE_USD;
    expect(out.trade.costBasis).toBe('mark_minus_slippage_plus_fees');
    expect(out.trade.bookedPnlUsd).toBe(20);
    expect(out.trade.netPnlUsd).toBeCloseTo(20 - 1 - 1 - fees, 10);
    // R uses the SAME divisor as `realizedR`, so the two are comparable.
    expect(out.trade.netR).toBeCloseTo(out.trade.netPnlUsd / 100, 10);
  });

  it('EXCLUDES a row whose bid/ask cost is unmeasurable rather than grading it gross', () => {
    // No broker restatement, no two-sided quotes, no slippage: the row's spread
    // cost is unknown. Averaging it in would be the silent contamination the
    // matched-comparison discipline (TRA-4674) exists to prevent.
    const out = evaluateOptionTradeRow(
      row({
        id: 'b',
        closeTs: 10,
        outcome: 'WIN',
        realizedPnlUsd: 50,
        realizedR: 0.5,
        exitReason: 'tp1',
        holdDays: 1,
        contracts: 1,
      }),
    );
    expect('excluded' in out).toBe(true);
    if (!('excluded' in out)) return;
    expect(out.excluded.reason).toBe('spread_cost_unmeasured');
    // …and it names WHY the cross could not price it, not a bare null.
    expect(out.excluded.crossedUnpriced).not.toBeNull();
  });

  it('prefers the broker-fill restatement and does not double-charge its fees', () => {
    const out = evaluateOptionTradeRow(
      closedWithSlippage('c', 10, 33, { pnlBasis: 'broker-fill', feesUsd: 0.18 }),
    );
    if (!('trade' in out)) throw new Error('expected a graded trade');
    expect(out.trade.costBasis).toBe('broker_fill');
    // `realizedPnlUsd` is ALREADY net of `feesUsd` on a restated row.
    expect(out.trade.netPnlUsd).toBe(33);
  });

  it('never counts an OPEN row as an exclusion — a live book is not a broken measurement', () => {
    const { coverage } = extractEvaluatedTrades([row({ id: 'open' }), closedWithSlippage('d', 5, 10)]);
    expect(coverage.closedRows).toBe(1);
    expect(coverage.graded).toBe(1);
    expect(coverage.excludedReasons).toEqual({});
  });

  it('orders the graded population by closeTs — the sequence the splits are defined over', () => {
    const { trades } = extractEvaluatedTrades([
      closedWithSlippage('late', 300, 1),
      closedWithSlippage('early', 100, 1),
      closedWithSlippage('mid', 200, 1),
    ]);
    expect(trades.map((t) => t.id)).toEqual(['early', 'mid', 'late']);
  });

  it('publishes the cost drag as a matched comparison over the same rows', () => {
    const { coverage } = extractEvaluatedTrades([
      closedWithSlippage('a', 10, 20),
      closedWithSlippage('b', 20, -10),
    ]);
    expect(coverage.bookedPnlUsd).toBe(10);
    expect(coverage.netPnlUsd).toBeLessThan(10);
    expect(coverage.costDragUsd).toBeLessThan(0);
  });
});

describe('thin-sample honesty (TRA-4914 AC: INSUFFICIENT, never a confident zero)', () => {
  it('reports INSUFFICIENT with NULL metrics below the cell floor', () => {
    const trades = extractEvaluatedTrades(
      Array.from({ length: 11 }, (_, i) => closedWithSlippage(`t${i}`, i * DAY, 5)),
    ).trades;
    const cell = buildMetricsCell(trades);
    expect(cell.status).toBe('INSUFFICIENT');
    expect(cell.n).toBe(11);
    expect(cell.floor).toBe(EVAL_CELL_MIN_N);
    // The load-bearing assertion: a thin cell must not leak a ratio a dashboard
    // would render as if it were graded.
    expect(cell.expectancyR).toBeNull();
    expect(cell.profitFactor).toBeNull();
    expect(cell.sortino).toBeNull();
    expect(cell.maxDrawdownR).toBeNull();
    expect(cell.netPnlUsd).toBeNull();
  });

  it('distinguishes NOT_MEASURED (never exercised) from INSUFFICIENT (looked, too thin)', () => {
    expect(buildMetricsCell([]).status).toBe('NOT_MEASURED');
  });

  it('grades a cell at or above the floor', () => {
    const trades = extractEvaluatedTrades(
      Array.from({ length: EVAL_CELL_MIN_N }, (_, i) =>
        closedWithSlippage(`t${i}`, i * DAY, i % 3 === 0 ? -8 : 6),
      ),
    ).trades;
    const cell = buildMetricsCell(trades);
    expect(cell.status).toBe('OK');
    expect(cell.expectancyR).not.toBeNull();
    expect(cell.profitFactor).not.toBeNull();
    expect(cell.worstLossStreak).not.toBeNull();
    expect(cell.avgDrawdownR).not.toBeNull();
  });

  it('avgDrawdownR is the mean depth below the running peak, not the max', () => {
    // Cumulative R: 1, 0, 1 → peaks 1,1,1 → depths 0,1,0 → mean 1/3.
    expect(avgDrawdownR([1, -1, 1])).toBeCloseTo(1 / 3, 10);
    expect(avgDrawdownR([])).toBeNull();
  });
});

describe('walk-forward wiring (buildWindows from packages/backtest)', () => {
  it('forms NO window below the constraint table floor and says so without faking a 0%', () => {
    const trades = extractEvaluatedTrades(
      Array.from({ length: 50 }, (_, i) => closedWithSlippage(`t${i}`, i * DAY, 4)),
    ).trades;
    const wf = buildWalkForward(trades);
    expect(wf.status).toBe('INSUFFICIENT');
    expect(wf.windows).toEqual([]);
    expect(wf.requiredTrades).toBe(
      OPTIONS_EVAL_CONSTRAINTS.minInSampleTrades + OPTIONS_EVAL_CONSTRAINTS.minOutOfSampleTrades,
    );
    expect(wf.availableTrades).toBe(50);
    expect(wf.pooledOosExpectancyR).toBeNull();
  });

  it('forms windows at the floor and measures IS->OOS degradation in the bounded direction', () => {
    // 400 trades: one window of 300 IS / 100 OOS. Make the OOS half strictly
    // worse so `degradation` must come back POSITIVE (OOS below IS).
    const trades = extractEvaluatedTrades(
      Array.from({ length: 400 }, (_, i) => closedWithSlippage(`t${i}`, i * DAY, i < 300 ? 20 : 2)),
    ).trades;
    const wf = buildWalkForward(trades);
    expect(wf.status).toBe('OK');
    expect(wf.windows).toHaveLength(1);
    expect(wf.windows[0].isTrades).toBe(300);
    expect(wf.windows[0].oosTrades).toBe(100);
    expect(wf.windows[0].isExpectancyR).toBeGreaterThan(wf.windows[0].oosExpectancyR);
    expect(wf.windows[0].degradation).toBeGreaterThan(OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation);
    expect(wf.windows[0].pass).toBe(false);
    expect(wf.pooledOosReturns).toHaveLength(100);
  });
});

describe('the report as a whole', () => {
  it('renders a blank book as NOT_MEASURED everywhere and never as zeros', () => {
    const r = buildOptionsEvaluationReport([], { asOfDate: '2026-09-25', now: 1 });
    expect(r.headline.status).toBe('NOT_MEASURED');
    expect(r.headline.expectancyR).toBeNull();
    expect(r.window).toBeNull();
    expect(r.monteCarlo.status).toBe('NOT_MEASURED');
    expect(r.monteCarlo.bands).toBeNull();
    expect(r.overfitting.psr.status).toBe('NOT_MEASURED');
    expect(r.overfitting.psr.value).toBeNull();
    expect(r.overfitting.pbo.status).toBe('NOT_MEASURED');
    expect(r.overfitting.pbo.result).toBeNull();
    expect(r.coverage.bookedPnlUsd).toBeNull();
    expect(r.coverage.netPnlUsd).toBeNull();
    // The constraint table must not read PASS off an empty book.
    expect(r.constraints.overall).toBe('INSUFFICIENT');
    expect(r.constraints.rows.every((row_) => row_.note.length > 0)).toBe(true);
  });

  it('splits per-regime and buckets a pre-TRA-4912 row as unknown, never as a plausible label', () => {
    const rows = [
      ...Array.from({ length: 5 }, (_, i) =>
        closedWithSlippage(`u${i}`, i * DAY, 5), // no regimeAtEntry — pre-TRA-4912 shape
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        closedWithSlippage(`r${i}`, (10 + i) * DAY, 5, { regimeAtEntry: 'trend_up' }),
      ),
    ];
    const r = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    const keys = r.byRegime.map((s) => s.key).sort();
    expect(keys).toEqual(['trend_up', 'unknown']);
    // Both splits are thin, so both must read INSUFFICIENT rather than print a ratio.
    expect(r.byRegime.every((s) => s.cell.status === 'INSUFFICIENT')).toBe(true);
  });

  it('computes PSR and an MC band once the population clears their floors', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      closedWithSlippage(`t${i}`, i * DAY, i % 4 === 0 ? -12 : 7),
    );
    const r = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    expect(r.headline.status).toBe('OK');
    expect(r.overfitting.psr.status).toBe('OK');
    expect(r.overfitting.psr.n).toBe(60);
    expect(r.overfitting.psr.floor).toBe(EVAL_PSR_MIN_N);
    expect(r.overfitting.psr.value).toBeGreaterThan(0);
    expect(r.overfitting.psr.value).toBeLessThanOrEqual(1);
    expect(r.monteCarlo.status).toBe('OK');
    expect(r.monteCarlo.bands).not.toBeNull();
    expect(r.monteCarlo.bands!.p5).toBeLessThanOrEqual(r.monteCarlo.bands!.p50);
    expect(r.monteCarlo.bands!.p50).toBeLessThanOrEqual(r.monteCarlo.bands!.p95);
  });

  it('is deterministic — the seeded MC band does not move when the book does not', () => {
    const rows = Array.from({ length: 60 }, (_, i) => closedWithSlippage(`t${i}`, i * DAY, i % 3 ? 6 : -9));
    const a = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    const b = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    expect(a.monteCarlo.bands).toEqual(b.monteCarlo.bands);
  });

  it('refuses a PBO with fewer than two trials rather than publishing one off a single config', () => {
    const rows = Array.from({ length: 60 }, (_, i) =>
      closedWithSlippage(`t${i}`, i * DAY, 5, { entryReason: 'rv_long' }),
    );
    const r = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    expect(r.overfitting.pbo.status).toBe('INSUFFICIENT');
    expect(r.overfitting.pbo.unmeasuredReason).toBe('fewer_than_two_trials');
    expect(r.overfitting.pbo.result).toBeNull();
    // Same reason kills the DSR: deflating over one trial is a tautology, not a guard.
    expect(r.overfitting.dsr.status).toBe('INSUFFICIENT');
    expect(r.overfitting.dsr.result).toBeNull();
  });

  it('computes a DSR once two trials clear the trial floor, and labels the returns basis', () => {
    const rows = [
      ...Array.from({ length: 30 }, (_, i) =>
        closedWithSlippage(`a${i}`, i * DAY, i % 3 ? 6 : -9, { entryReason: 'rv_long' }),
      ),
      ...Array.from({ length: 30 }, (_, i) =>
        closedWithSlippage(`b${i}`, (40 + i) * DAY, i % 4 ? 4 : -11, { entryReason: 'ema_pullback' }),
      ),
    ];
    const r = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    expect(r.overfitting.dsr.status).toBe('OK');
    expect(r.overfitting.dsr.trials.map((t) => t.key).sort()).toEqual(['ema_pullback', 'rv_long']);
    expect(r.overfitting.dsr.result).not.toBeNull();
    // No walk-forward window can form at n=60, so the DSR must SAY it fell back
    // to the in-sample population rather than implying an OOS reading.
    expect(r.overfitting.dsr.returnsBasis).toBe('full_graded_population');
    expect(r.overfitting.dsr.trialCountBasis).toBe('entry_reason_declared_lower_bound');
  });
});

describe('the constraint table, adopted as written', () => {
  it('carries the proposal numbers verbatim', () => {
    expect(OPTIONS_EVAL_CONSTRAINTS).toEqual({
      minInSampleTrades: 300,
      minOutOfSampleTrades: 100,
      maxParams: 10,
      maxIsToOosDegradation: 0.35,
    });
  });

  it('grades the declared parameter inventory against the max-params bound', () => {
    const r = buildOptionsEvaluationReport([], { asOfDate: '2026-09-25', now: 1 });
    const params = r.constraints.rows.find((x) => x.name === 'max parameters')!;
    expect(params.measured).toBe(String(OPTIONS_PATH_TUNED_PARAMS.length));
    expect(params.verdict).toBe(
      OPTIONS_PATH_TUNED_PARAMS.length <= OPTIONS_EVAL_CONSTRAINTS.maxParams ? 'PASS' : 'FAIL',
    );
    // The honesty the row owes: it is a declared lower bound, and it says so.
    expect(params.note).toContain('DECLARED LOWER BOUND');
  });

  it('reports an unmeasured degradation as INSUFFICIENT, not as a passing 0%', () => {
    const rows = Array.from({ length: 60 }, (_, i) => closedWithSlippage(`t${i}`, i * DAY, 5));
    const r = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    const deg = r.constraints.rows.find((x) => x.name === 'max IS->OOS degradation')!;
    expect(deg.verdict).toBe('INSUFFICIENT');
    expect(deg.measured).toBeNull();
    expect(deg.note).toContain('UNMEASURED');
    expect(r.constraints.overall).not.toBe('PASS');
  });

  it('FAILs the profitability row on a book that is negative after costs', () => {
    // Booked +$1 a trade, but slippage + fees exceed it — gross-positive,
    // net-negative. This is the exact reading the AC is about.
    const rows = Array.from({ length: 40 }, (_, i) => closedWithSlippage(`t${i}`, i * DAY, 1));
    const r = buildOptionsEvaluationReport(rows, { asOfDate: '2026-09-25', now: 1 });
    expect(r.coverage.bookedPnlUsd).toBeGreaterThan(0);
    expect(r.coverage.netPnlUsd).toBeLessThan(0);
    const prof = r.constraints.rows.find((x) => x.name === 'profitable after costs')!;
    expect(prof.verdict).toBe('FAIL');
    expect(r.constraints.overall).toBe('FAIL');
  });
});
