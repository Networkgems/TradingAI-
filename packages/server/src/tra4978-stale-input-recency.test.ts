// TRA-4978 (second pass) — the RECENCY arm of the cost_bar staleness assertion.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// The first pass shipped the attribution split: of 21,580 retained refusals,
// 7,179 were DECIDED by the stale expectancy constant and 7,422 were refused
// upstream of it. That split is correct and it is not gradeable. It folds the
// retained archive, which is append-only and has no backfill, so
// `staleInputGovernsAnyDecision` latches TRUE for the whole 30-day retention
// window regardless of what any remedy does — and TRA-4978's own AC2 ("the
// per-cell `tapeAgeDaysAtDecisionMax` must be under `thresholdDays` for every
// cell that recorded a refusal") is therefore unsatisfiable by construction.
// That is the TRA-3703 shape: an identity derived to EXPOSE a gap cannot grade
// its own remedy.
//
// The fixtures below are the LIVE per-ET-day census read off `0d81630c` at
// 2026-10-02T01:11Z, `retained.byGate[cost_bar].byEtDay`, 17 refusing days with
// a clean cutover on 2026-09-25.
import { describe, expect, it } from 'vitest';
import {
  foldStaleCostBarRecency,
  type CostBarEtDayReasonRow,
} from './cost-bar-stale-attribution.js';

const day = (
  etDay: string,
  reasons: Record<string, number>,
  blockedUnclassified = 0,
): CostBarEtDayReasonRow => ({
  etDay,
  blocked: Object.values(reasons).reduce((s, n) => s + n, 0) + blockedUnclassified,
  byReason: Object.entries(reasons).map(([reasonCode, blocked]) => ({ reasonCode, blocked })),
  blockedUnclassified,
});

/** The live fold, verbatim. Totals: 12,578 shortfall + 9,002 upstream = 21,580. */
const LIVE_ET_DAYS: CostBarEtDayReasonRow[] = [
  // Quiet sessions the gate evaluated nothing on — must be skipped entirely.
  { etDay: '2026-09-02', blocked: 0, byReason: [], blockedUnclassified: 0 },
  { etDay: '2026-09-08', blocked: 0, byReason: [], blockedUnclassified: 0 },
  day('2026-09-09', { 'shortfall_0.25_0.50': 268 }),
  day('2026-09-10', { 'shortfall_0.25_0.50': 157 }),
  day('2026-09-11', { 'shortfall_0.25_0.50': 710, 'shortfall_gte_0.50': 612 }),
  day('2026-09-14', { 'shortfall_gte_0.50': 457, 'shortfall_0.25_0.50': 353 }),
  day('2026-09-15', { 'shortfall_gte_0.50': 433, 'shortfall_0.25_0.50': 372 }),
  day('2026-09-16', { 'shortfall_gte_0.50': 365, 'shortfall_0.25_0.50': 275 }),
  day('2026-09-17', { 'shortfall_gte_0.50': 513, 'shortfall_0.25_0.50': 418 }),
  day('2026-09-18', { 'shortfall_gte_0.50': 247, 'shortfall_0.25_0.50': 219 }),
  day('2026-09-21', { 'shortfall_gte_0.50': 993, 'shortfall_0.25_0.50': 652 }),
  day('2026-09-22', { 'shortfall_gte_0.50': 913, 'shortfall_0.25_0.50': 649 }),
  day('2026-09-23', { 'shortfall_gte_0.50': 521, 'shortfall_0.25_0.50': 412 }),
  day('2026-09-24', { 'shortfall_gte_0.50': 1799, 'shortfall_0.25_0.50': 1240 }),
  day('2026-09-25', { insufficient_real_fill_evidence: 2193 }),
  day('2026-09-28', { insufficient_real_fill_evidence: 1331 }),
  day('2026-09-29', { insufficient_real_fill_evidence: 1676 }),
  day('2026-09-30', { insufficient_real_fill_evidence: 1876 }),
  day('2026-10-01', { insufficient_real_fill_evidence: 1926 }),
];

describe('TRA-4978 — foldStaleCostBarRecency, against the live fold', () => {
  it('dates the last decision instead of latching on the archive', () => {
    const r = foldStaleCostBarRecency(LIVE_ET_DAYS);
    expect(r.latestEtDayWithRefusals).toBe('2026-10-01');
    expect(r.latestEtDayDecidedByStaleInput).toBe('2026-09-24');
    expect(r.sessionsSinceStaleInputLastDecided).toBe(5);
    expect(r.staleInputGovernsLatestSession).toBe(false);
    expect(r.statement).toContain('DORMANT');
    expect(r.statement).toContain('2026-09-24');
    // ⛔ Dormant must never read as cleared — the constant resumes governing the
    // instant the upstream real-fill arm admits.
    expect(r.statement).toContain('Dormant is not clear');
  });

  it('skips sessions the gate evaluated nothing on — silence is not a stand-down', () => {
    // 19 rows in, 2 of them quiet. A quiet day counted as "a session since" would
    // overstate how long the constant has been inert.
    expect(foldStaleCostBarRecency(LIVE_ET_DAYS).etDaysWithRefusals).toBe(17);
  });

  it('splits the latest session on the DEPLOYED pre-comparison code list', () => {
    const r = foldStaleCostBarRecency(LIVE_ET_DAYS);
    expect(r.latestSessionShortCircuitedUpstream).toBe(1926);
    expect(r.latestSessionDecidedByStaleInput).toBe(0);
    expect(r.latestSessionUnclassified).toBe(0);
  });

  it('goes GOVERNING the moment the constant decides on the latest session', () => {
    const r = foldStaleCostBarRecency([
      ...LIVE_ET_DAYS,
      day('2026-10-02', { 'shortfall_gte_0.50': 40, insufficient_real_fill_evidence: 60 }),
    ]);
    expect(r.staleInputGovernsLatestSession).toBe(true);
    expect(r.latestEtDayDecidedByStaleInput).toBe('2026-10-02');
    expect(r.sessionsSinceStaleInputLastDecided).toBe(0);
    expect(r.latestSessionDecidedByStaleInput).toBe(40);
    expect(r.latestSessionShortCircuitedUpstream).toBe(60);
    expect(r.statement).toContain('GOVERNING');
  });

  it('a fully unstamped latest session is NOT COMPUTABLE, never a clean bill', () => {
    // The pre-TRA-4745 shape: refusals with no reason code at all. Coercing this
    // to `false` would publish "the staleness is inert" off a day nobody
    // measured — the `x != null` admits NaN failure (TRA-3440), one layer up.
    const r = foldStaleCostBarRecency([
      day('2026-09-24', { 'shortfall_gte_0.50': 1799 }),
      day('2026-09-25', {}, 500),
    ]);
    expect(r.staleInputGovernsLatestSession).toBeNull();
    expect(r.latestSessionUnclassified).toBe(500);
    expect(r.statement).toContain('NOT COMPUTABLE');
    expect(r.statement).not.toContain('DORMANT');
  });

  it('never reports 0 sessions-since when the constant has NEVER decided', () => {
    // `0` would read as "it decided one today". There is no "since" to count.
    const r = foldStaleCostBarRecency([day('2026-10-01', { insufficient_real_fill_evidence: 9 })]);
    expect(r.latestEtDayDecidedByStaleInput).toBeNull();
    expect(r.sessionsSinceStaleInputLastDecided).toBeNull();
    expect(r.staleInputGovernsLatestSession).toBe(false);
  });

  it('an empty fold is NOT MEASURED, not dormant', () => {
    const r = foldStaleCostBarRecency([]);
    expect(r.etDaysWithRefusals).toBe(0);
    expect(r.staleInputGovernsLatestSession).toBeNull();
    expect(r.statement).toContain('NOT MEASURED');
  });

  it('orders by ET day, not by array position', () => {
    // The ledger emits ascending today; a fold that trusted position would read
    // the wrong "latest" the first time it does not.
    const r = foldStaleCostBarRecency([...LIVE_ET_DAYS].reverse());
    expect(r.latestEtDayWithRefusals).toBe('2026-10-01');
    expect(r.latestEtDayDecidedByStaleInput).toBe('2026-09-24');
    expect(r.sessionsSinceStaleInputLastDecided).toBe(5);
  });

  it('falls back to the residual when the ledger omits blockedUnclassified', () => {
    const r = foldStaleCostBarRecency([
      { etDay: '2026-10-01', blocked: 100, byReason: [{ reasonCode: 'shortfall_gte_0.50', blocked: 70 }] },
    ]);
    expect(r.latestSessionDecidedByStaleInput).toBe(70);
    expect(r.latestSessionUnclassified).toBe(30);
    // Classified rows exist, so the verdict is computable despite the residual.
    expect(r.staleInputGovernsLatestSession).toBe(true);
  });
});
