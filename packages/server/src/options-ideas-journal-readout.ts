// TRA-4646 (parent TRA-1965) — the per-idea journal readout, the per-sleeve
// expectancy in the R UNIT, and the debit-sleeve retirement's scoring pass +
// before/after comparison.
//
// WHY THIS MODULE EXISTS. The 2026-09-17 evidence roll-up had to derive its
// credit/debit finding from the power module's centered statistic `c`, because no
// route exposed the resolved journal per idea — `/api/options/ideas/journal`,
// `/api/options/idea-journal` and `/api/options/ideas/resolved` all 404'd, and
// `?detail=ideas` on the gate was ignored. `c` is NOT the same unit as the
// published `expectancyNetR`, so the roll-up could state the SIGN separation but
// not the R-denominated sleeve expectancy the retirement decision needs (AC2).
// This module closes both gaps: AC1's row-level read and AC2's per-sleeve
// `expectancyNetR` with n, sd and se, both served by
// `GET /api/health/options-ideas-journal` (index.ts).
//
// Pure — no I/O, no env, no clock beyond an injected `asOf` — so every shape here
// is unit-testable and the route stays a thin adapter.

import type { LiveCapitalGateCriteria } from './live-capital-gate.js';
import type { FeasibilityVerdict, RewardSourceCounts } from './gate-feasibility.js';
import { evaluateGatePower, sampleStdev, type PowerSigmaSource } from './gate-power.js';
import {
  buildForwardTestReport,
  evaluateBookFeasibility,
  premiumDirection,
  type ExcludeReason,
  type IdeaOutcome,
  type IdeaStatus,
} from './options-forward-test.js';

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

function mean(xs: readonly number[]): number | null {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
}

// ── AC3 — the scoring-time debit retirement ──────────────────────────────────

/**
 * TRA-4646 (AC3) — re-mark every DEBIT-entry outcome as excluded
 * (`off_mandate_debit`) so the gate is scored CREDIT-ONLY. FORWARD scoring only:
 * this maps the in-memory outcomes the routes just valued — the journal file is
 * never touched, so the debit rows remain readable evidence on every readout
 * (excluded, with the reason naming why).
 *
 * A row already excluded for a data-hygiene reason keeps that reason: the
 * retirement narrows the MANDATE universe, it does not re-litigate hygiene, and
 * preserving the original reason keeps the exclusion histogram comparable across
 * the flag flip. Direction is measured off the SIGN of `entryNetUsd` (the same
 * per-row measurement `ceilingAxes.byPremiumDirection` buckets on — never a
 * strategy-name list, per the TRA-2350 lesson); a zero/non-finite entry is
 * `unknown` and is NOT retired.
 */
export function applyDebitRetirement(outcomes: readonly IdeaOutcome[]): IdeaOutcome[] {
  return outcomes.map((o) => {
    if (premiumDirection(o) !== 'debit' || o.excluded) return o;
    return { ...o, excluded: true, excludeReason: 'off_mandate_debit' as ExcludeReason };
  });
}

// ── AC2 — per-sleeve expectancy in the R unit ────────────────────────────────

/** One sleeve's (or the pooled book's) expectancy read, all R figures at 4 dp. */
export interface SleeveExpectancyStat {
  /** `credit` / `debit` / `unknown` sleeve key, or `pooled`. */
  key: string;
  n: number;
  wins: number;
  losses: number;
  scratches: number;
  hitRate: number | null;
  /** Mean PRE-cost `pnlR`. */
  expectancyR: number | null;
  /** Mean COST-NET `pnlNetR` — THE AC2 number, same `?? 0` fold as the gate. */
  expectancyNetR: number | null;
  /** n−1 sample sd of the same `pnlNetR ?? 0` values ({@link sampleStdev}); null below n=2. */
  sdNetR: number | null;
  /** `sdNetR / √n` — the standard error of `expectancyNetR`. */
  seNetR: number | null;
  /**
   * Mean signed credit/width ratio — the power module's `c`, carried so a reader
   * can reconcile this block against `power.byAxis.byPremiumDirection` and see
   * that the two are different UNITS over the same rows, not two measurements.
   */
  meanCreditWidth: number | null;
}

export interface SleeveExpectancyReport {
  /** Rows the stats are computed over — see {@link gradeableForSleeves}. */
  n: number;
  pooled: SleeveExpectancyStat;
  /** One stat per premium-direction sleeve, largest first. */
  byPremiumDirection: SleeveExpectancyStat[];
  note: string;
}

/**
 * The sleeve-expectancy basis: resolved rows that are either included, or
 * excluded ONLY by the TRA-4646 retirement itself. The retirement must never be
 * able to hide the sleeve it retired — the 19 resolved debit rows are the
 * evidence for the decision, so they stay in THIS read whether or not the flag
 * is armed. Hygiene exclusions (fallback/stale/no-denom/cost) stay out exactly
 * as they are out of every gate metric.
 */
function gradeableForSleeves(outcomes: readonly IdeaOutcome[]): IdeaOutcome[] {
  return outcomes.filter(
    (o) => o.status === 'resolved' && (!o.excluded || o.excludeReason === 'off_mandate_debit'),
  );
}

function sleeveStatFor(key: string, rows: readonly IdeaOutcome[]): SleeveExpectancyStat {
  const n = rows.length;
  const wins = rows.filter((o) => o.win === true).length;
  const losses = rows.filter((o) => o.pnlUsd != null && o.pnlUsd < 0).length;
  const scratches = rows.filter((o) => o.pnlUsd != null && o.pnlUsd === 0).length;
  // The SAME `?? 0` fold the gate's totals use, so the pooled row here reproduces
  // `expectancyNetR` (at 4 dp instead of the gate's 2) rather than a variant of it.
  const netRs = rows.map((o) => o.pnlNetR ?? 0);
  const grossR = mean(rows.map((o) => o.pnlR ?? 0));
  const netR = mean(netRs);
  const sd = sampleStdev(netRs);
  const cw = rows
    .map((o) => {
      const width = o.maxProfitUsd + o.maxLossUsd;
      return width > 0 ? o.entryNetUsd / width : null;
    })
    .filter((x): x is number => x != null);
  const c = mean(cw);
  return {
    key,
    n,
    wins,
    losses,
    scratches,
    hitRate: n ? r4(wins / n) : null,
    expectancyR: grossR == null ? null : r4(grossR),
    expectancyNetR: netR == null ? null : r4(netR),
    sdNetR: sd == null ? null : r4(sd),
    seNetR: sd == null || n < 1 ? null : r4(sd / Math.sqrt(n)),
    meanCreditWidth: c == null ? null : r4(c),
  };
}

const SLEEVE_EXPECTANCY_NOTE =
  'TRA-4646 (AC2). All figures are in the R UNIT (P/L ÷ defined max-loss), 4 dp — the same unit ' +
  'as the gate\'s published expectancyNetR, NOT the power module\'s centered credit/width statistic ' +
  '`c` (meanCreditWidth is carried per sleeve precisely so the two units can be reconciled without ' +
  're-derivation). Basis: RESOLVED rows that are included OR excluded solely as `off_mandate_debit` ' +
  '— the retired debit rows are the evidence for the retirement decision and can never be hidden by ' +
  'the flag that retires them; data-hygiene exclusions stay out, as they are out of every gate ' +
  'metric. sdNetR is the n−1 sample sd of the same pnlNetR values the mean is computed from; ' +
  'seNetR = sdNetR/√n.';

/** TRA-4646 (AC2) — credit-only and debit-only `expectancyNetR` in R, with n/sd/se. Pure. */
export function buildSleeveExpectancy(outcomes: readonly IdeaOutcome[]): SleeveExpectancyReport {
  const rows = gradeableForSleeves(outcomes);
  const bySleeve = new Map<string, IdeaOutcome[]>();
  for (const o of rows) {
    const k = premiumDirection(o);
    const arr = bySleeve.get(k) ?? [];
    arr.push(o);
    bySleeve.set(k, arr);
  }
  return {
    n: rows.length,
    pooled: sleeveStatFor('pooled', rows),
    byPremiumDirection: [...bySleeve.entries()]
      .map(([k, os]) => sleeveStatFor(k, os))
      .sort((a, b) => b.n - a.n || a.key.localeCompare(b.key)),
    note: SLEEVE_EXPECTANCY_NOTE,
  };
}

// ── AC1 — the per-idea journal readout ───────────────────────────────────────

/** One journaled idea, valued — the row shape `/api/health/options-ideas-journal` serves. */
export interface IdeaJournalRow {
  /** The journal's stable dedupe key `${etDate}:${ticker}:${strategy}:${expiration}`. */
  ideaId: string;
  ticker: string;
  /** Engine structure id (`bull_put_spread`, `long_call`, …). */
  structure: string;
  /** `credit` / `debit` / `unknown`, measured off the sign of `entryNetUsd`. */
  premiumDirection: string;
  surfacedDate: string;
  surfacedWeek: string;
  expiration: string;
  dte: number | null;
  ivRank: number | null;
  status: IdeaStatus;
  /** ET date of the settlement chain (null unless resolved). */
  resolvedAt: string | null;
  /** `win` / `loss` / `scratch` over the PRE-cost realized P/L; null while unresolved. */
  outcome: 'win' | 'loss' | 'scratch' | null;
  statedPop: number;
  entryNetUsd: number;
  maxLossUsd: number;
  maxProfitUsd: number;
  costsUsd: number;
  costEfficiencyRatio: number | null;
  pnlUsd: number | null;
  pnlR: number | null;
  pnlNetUsd: number | null;
  pnlNetR: number | null;
  excluded: boolean;
  excludeReason: ExcludeReason | null;
}

export type JournalStatusFilter = 'all' | IdeaStatus;

export interface IdeaJournalReadout {
  /** Rows matching the status filter — the pagination denominator, offset-independent. */
  total: number;
  offset: number;
  limit: number;
  /** `rows.length` — equals `min(limit, total − offset)`, floored at 0. */
  returned: number;
  statusFilter: JournalStatusFilter;
  ordering: string;
  rows: IdeaJournalRow[];
  note: string;
}

export const JOURNAL_READOUT_DEFAULT_LIMIT = 200;
export const JOURNAL_READOUT_MAX_LIMIT = 1000;

function toRow(o: IdeaOutcome): IdeaJournalRow {
  const outcome: IdeaJournalRow['outcome'] =
    o.status !== 'resolved' || o.pnlUsd == null
      ? null
      : o.pnlUsd > 0
        ? 'win'
        : o.pnlUsd < 0
          ? 'loss'
          : 'scratch';
  return {
    ideaId: o.key,
    ticker: o.ticker,
    structure: o.strategy,
    premiumDirection: premiumDirection(o),
    surfacedDate: o.surfacedDate,
    surfacedWeek: o.surfacedWeek,
    expiration: o.expiration,
    dte: o.dte ?? null,
    ivRank: o.ivRank ?? null,
    status: o.status,
    resolvedAt: o.status === 'resolved' ? o.valuedAt : null,
    outcome,
    statedPop: o.pop,
    entryNetUsd: o.entryNetUsd,
    maxLossUsd: o.maxLossUsd,
    maxProfitUsd: o.maxProfitUsd,
    costsUsd: o.costsUsd,
    costEfficiencyRatio: o.costEfficiencyRatio,
    pnlUsd: o.pnlUsd,
    pnlR: o.pnlR,
    pnlNetUsd: o.pnlNetUsd,
    pnlNetR: o.pnlNetR,
    excluded: o.excluded,
    excludeReason: o.excludeReason,
  };
}

const JOURNAL_READOUT_NOTE =
  'TRA-4646 (AC1). Per-idea read of the forward-test journal, valued exactly as the gate values it ' +
  '(same valueIdea pass — pnlR/pnlNetR are the gate\'s own figures, per 1-lot). Ordering is journal ' +
  'order: ascending surface time, stable across calls, and `offset` counts from the FIRST row of ' +
  'that ordering — page k is rows [offset, offset+limit), the union of pages is the full filtered ' +
  'set, and `total` is offset-independent (the TRA-4607 conviction-DCA ledger bug, where a larger ' +
  'offset returned a strict subset of offset=0, is the failure mode this contract exists to rule ' +
  'out). `excludeReason: "off_mandate_debit"` marks rows retired from FORWARD gate scoring by ' +
  'ENABLE_OPTIONS_DEBIT_SLEEVE_RETIREMENT — the rows themselves are permanent evidence and are ' +
  'never deleted or amended.';

/**
 * TRA-4646 (AC1) — paginate the valued journal. Pure; the caller decides which
 * outcomes array (retired or not) to serve rows from.
 */
export function buildIdeaJournalReadout(
  outcomes: readonly IdeaOutcome[],
  opts: { status?: JournalStatusFilter; offset?: number; limit?: number } = {},
): IdeaJournalReadout {
  const statusFilter: JournalStatusFilter = opts.status ?? 'resolved';
  const filtered =
    statusFilter === 'all' ? [...outcomes] : outcomes.filter((o) => o.status === statusFilter);
  // Clamp, never reject: a malformed offset/limit must not 4xx a public probe.
  const offset = Math.max(0, Math.floor(Number.isFinite(opts.offset as number) ? (opts.offset as number) : 0));
  const rawLimit = Number.isFinite(opts.limit as number)
    ? Math.floor(opts.limit as number)
    : JOURNAL_READOUT_DEFAULT_LIMIT;
  const limit = Math.min(JOURNAL_READOUT_MAX_LIMIT, Math.max(1, rawLimit));
  const rows = filtered.slice(offset, offset + limit).map(toRow);
  return {
    total: filtered.length,
    offset,
    limit,
    returned: rows.length,
    statusFilter,
    ordering: 'journal order (ascending surfacedAt; stable)',
    rows,
    note: JOURNAL_READOUT_NOTE,
  };
}

// ── AC3 — the before/after comparison the gate route publishes ───────────────

/** One scoring basis' headline numbers — the exact fields AC3 asks to publish. */
export interface DebitRetirementBasisSnapshot {
  basis: 'all_structures' | 'credit_only';
  /** Graded (resolved && !excluded) rows under this basis. */
  resolved: number;
  expectancyNetR: number | null;
  /** Pooled power figures ({@link evaluateGatePower} over this basis' report). */
  sigmaUsed: number | null;
  sigmaSource: PowerSigmaSource;
  nRequired: number | null;
  nObserved: number;
  powered: boolean;
  feasibilityVerdict: FeasibilityVerdict;
  ceilingNetR: number | null;
  ceilingSources: RewardSourceCounts;
}

export interface DebitRetirementComparison {
  /** The named flag (AC3's reversibility requirement). */
  flag: string;
  enabled: boolean;
  /** Which basis the LIVE gate above is actually scored on right now. */
  scoringBasis: 'all_structures' | 'credit_only';
  /** Graded rows the retirement removes (`before.resolved − after.resolved`). */
  resolvedRetired: number;
  before: DebitRetirementBasisSnapshot;
  after: DebitRetirementBasisSnapshot;
  note: string;
}

function basisSnapshot(
  basis: DebitRetirementBasisSnapshot['basis'],
  outcomes: readonly IdeaOutcome[],
  criteria: LiveCapitalGateCriteria,
  opts: { asOf?: number; chainsDir?: string },
): DebitRetirementBasisSnapshot {
  const report = buildForwardTestReport(outcomes, opts);
  const power = evaluateGatePower(report.totals.powerInputs, {
    floor: criteria.minResolvedIdeas,
    nObserved: report.totals.resolved,
  });
  const feasibility = evaluateBookFeasibility(report, criteria.minExpectancyR);
  return {
    basis,
    resolved: report.totals.resolved,
    expectancyNetR: report.totals.expectancyNetR,
    sigmaUsed: power.sigmaUsed,
    sigmaSource: power.sigmaSource,
    nRequired: power.nRequired,
    nObserved: power.nObserved,
    powered: power.powered,
    feasibilityVerdict: feasibility.verdict,
    ceilingNetR: report.totals.ceilingNetR,
    ceilingSources: report.totals.ceilingSourceCounts,
  };
}

const DEBIT_RETIREMENT_NOTE =
  'TRA-4646 (AC3). `before` scores the whole graded book; `after` scores it CREDIT-ONLY (debit ' +
  'entries excluded as off_mandate_debit at scoring time — the journal rows are never deleted or ' +
  'amended). BOTH snapshots are computed on every read regardless of the flag, so the expected ' +
  'post-arm numbers are gradeable BEFORE arming and the pre-arm numbers stay visible after ' +
  '(TRA-2680: a gate you can only read by arming it is not auditable). `scoringBasis` names which ' +
  'basis the live gate payload above is actually scored on. Reversible: unset ' +
  'ENABLE_OPTIONS_DEBIT_SLEEVE_RETIREMENT and the next read scores all structures again.';

/**
 * TRA-4646 (AC3) — before/after `nRequired`, `sigmaUsed`, feasibility verdict and
 * `ceilingSources`, published on `/api/health/live-capital-gate` in BOTH flag
 * states. Pure given the un-retired outcomes.
 */
export function buildDebitRetirementComparison(
  allOutcomes: readonly IdeaOutcome[],
  criteria: LiveCapitalGateCriteria,
  enabled: boolean,
  opts: { asOf?: number; chainsDir?: string } = {},
): DebitRetirementComparison {
  const before = basisSnapshot('all_structures', allOutcomes, criteria, opts);
  const after = basisSnapshot('credit_only', applyDebitRetirement(allOutcomes), criteria, opts);
  return {
    flag: 'ENABLE_OPTIONS_DEBIT_SLEEVE_RETIREMENT',
    enabled,
    scoringBasis: enabled ? 'credit_only' : 'all_structures',
    resolvedRetired: before.resolved - after.resolved,
    before,
    after,
    note: DEBIT_RETIREMENT_NOTE,
  };
}
