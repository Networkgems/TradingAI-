// TRA-4914 (Phase 0 item 3 of the TRA-4481 upgrade plan, ratified on TRA-4911) —
// the options path's STANDARD GRADING SURFACE.
//
// ── This module is WIRING, not new statistics ────────────────────────────────
//
// Every estimator below already existed in `packages/backtest` with ~15 source
// consumers, and not one of those consumers was the options path. This file does
// not reimplement any of them; it adapts the options journal into their input
// shapes and reports what they answer:
//
//   walk-forward IS/OOS windows   → `buildWindows`                (walk-forward.ts)
//   block-bootstrap MC bands      → `blockBootstrapEquityCurves`  (bootstrap.ts)
//   PSR / DSR / PBO               → `probabilisticSharpeRatio`,
//                                   `deflatedSharpeRatio`,
//                                   `probabilityOfBacktestOverfitting`
//                                                             (overfitting-stats.ts)
//   PF / Sharpe / Sortino / MDD   → `summarizeTrades`            (tra731-metrics.ts)
//   cost-inclusive re-pricing     → `priceCrossedRow`         (option-crossed-pnl.ts)
//   regime label at entry         → `regimeAtEntry`      (option-entry-provenance.ts)
//
// A diff that adds a second copy of any of those is wrong (TRA-4914 AC).
//
// ── The one discipline that matters here ────────────────────────────────────
//
// This is a grading surface, and a grading surface that prints a confident ratio
// off 11 trades is worse than one that prints nothing: it manufactures the exact
// "looks like an ordinary quiet result" reading that CLAUDE.md's health-field rule
// exists to kill. So EVERY cell in this report carries its own `status`, and:
//
//   • `INSUFFICIENT` is a first-class verdict, not an error and not a zero. A
//     section below its floor reports `status: 'INSUFFICIENT'` with `n` and
//     `floor` beside it and **null** metrics — never 0, never a ratio.
//   • `NOT_MEASURED` is distinct from `INSUFFICIENT`: the former means the input
//     was never exercised (no trial dimension, no priced rows), the latter means
//     we looked and there were too few.
//   • Cost is measured, not modelled away. A row whose bid/ask cost cannot be
//     measured is EXCLUDED from the graded population and counted with a named
//     reason — the matched-comparison discipline TRA-4674 already established,
//     rather than silently averaging a cost-inclusive row against a gross one.
//
// NOTHING here routes an order, reads a chain, or touches the broker. It is a
// pure fold over journal rows the caller already holds. No live behaviour change;
// the TRA-4168 posture is untouched and TRA-382 still gates live promotion.

import {
  blockBootstrapEquityCurves,
  buildWindows,
  deflatedSharpeRatio,
  probabilisticSharpeRatio,
  probabilityOfBacktestOverfitting,
  sampleMoments,
  summarizeTrades,
} from '@trading-app/backtest';
import type {
  ConfidenceBands,
  DeflatedSharpeResult,
  PboResult,
  TradeMetrics,
} from '@trading-app/backtest';
import type { Position } from '@trading-app/shared';
import { priceCrossedRow, type CrossedUnpricedReason } from './option-crossed-pnl.js';
import { DEFAULT_COST_GATE_CONFIG } from './option-cost-gate.js';
import type { JournalRegime, OptionEntryReason } from './option-entry-provenance.js';
import type { OptionTradeJournalRecord } from './option-trade-journal.js';

// ─────────────────────────────────────────────────────────────────────────────
// The constraint table — ADOPTED AS WRITTEN from the source proposal (TRA-4481).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TRA-4914 — the promotion constraint table, verbatim from the source proposal
 * and ratified on TRA-4911. These numbers are NOT tuned here and must not be
 * quietly relaxed to make a thin book pass: the whole point of adopting a table
 * written before the data was looked at is that it cannot be fitted to the data.
 *
 * `maxIsToOosDegradation` is a FRACTION (0.35 = 35%), applied to expectancy.
 */
export const OPTIONS_EVAL_CONSTRAINTS = {
  /** Minimum in-sample closed trades per walk-forward window. */
  minInSampleTrades: 300,
  /** Minimum out-of-sample closed trades per walk-forward window. */
  minOutOfSampleTrades: 100,
  /** Maximum free parameters tuned on this tape. See {@link OPTIONS_PATH_TUNED_PARAMS}. */
  maxParams: 10,
  /** Maximum tolerated IS→OOS expectancy degradation, as a fraction of the IS figure. */
  maxIsToOosDegradation: 0.35,
} as const;

/**
 * TRA-4914 — the DECLARED inventory of free parameters the options entry/exit
 * path carries, against which `maxParams` is graded.
 *
 * ⚠ THIS IS A HAND-MAINTAINED LOWER BOUND, AND IT SAYS SO IN THE REPORT. Nothing
 * in the tree can count "parameters tuned on this tape" automatically — a
 * constant that was never moved and a constant that was swept to three decimals
 * are byte-identical at rest. Publishing a machine-looking count off an
 * un-auditable derivation is the failure mode this file exists to avoid, so the
 * inventory is explicit, each row names WHERE the parameter lives, and the
 * report labels the verdict `declared_lower_bound`.
 *
 * Add a row when you add a tunable to the options path. The constraint is
 * `length <= OPTIONS_EVAL_CONSTRAINTS.maxParams`; overflowing it is a finding,
 * not something to fix by deleting rows.
 */
export const OPTIONS_PATH_TUNED_PARAMS: readonly { name: string; source: string }[] = [
  { name: 'entry |delta| floor', source: 'OTM_DELTA_FLOOR (exit-risk-rules-flag.ts)' },
  { name: 'entry |delta| ceiling', source: 'OPTION_ENTRY_DELTA_CEILING (demo-flags.ts)' },
  { name: 'cost-gate safety margin R', source: 'OPTION_COST_GATE_SAFETY_MARGIN_R (option-cost-gate.ts)' },
  { name: 'cost-gate commission R', source: 'OPTION_COST_GATE_COMMISSION_R (option-cost-gate.ts)' },
  { name: 'cost-gate maker-adjusted spread cross R', source: 'DEFAULT_COST_GATE_CONFIG (option-cost-gate.ts)' },
  { name: 'stop distance as a fraction of mark', source: 'STOP_DISTANCE_FRACTION_OF_MARK (option-spread-cost.ts)' },
  { name: 'per-sleeve spread ceiling', source: 'SLEEVE_SPREAD_CEILINGS (option-spread-cost.ts)' },
  { name: 'entry DTE band', source: 'entryDteBand (option-trade-journal.ts)' },
  { name: 'scratch band on realized R', source: 'outcomeForR (option-trade-journal.ts)' },
  { name: 'tape-expectancy minimum cell n', source: 'TAPE_EXPECTANCY_MIN_CELL_N (option-tape-expectancy.ts)' },
];

// ─────────────────────────────────────────────────────────────────────────────
// Sufficiency vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The status every cell in this report carries.
 *
 *  • `OK`            — measured, above its floor; the numbers beside it are real.
 *  • `INSUFFICIENT`  — measured, BELOW its floor. Metrics are `null`. n/floor say
 *                      how far short. This is an honest verdict, not an error.
 *  • `NOT_MEASURED`  — the input was never exercised (e.g. no trial dimension for
 *                      PBO, no priceable rows at all). Distinct from
 *                      `INSUFFICIENT` on purpose: "we looked and it was thin" and
 *                      "we never looked" are different pages to different people
 *                      (CLAUDE.md, the health-field rule).
 */
export type EvalStatus = 'OK' | 'INSUFFICIENT' | 'NOT_MEASURED';

/**
 * Floor for a metrics cell to read `OK` rather than `INSUFFICIENT`.
 *
 * Set to the tape-expectancy cell floor (30) rather than to the constraint
 * table's 300: the constraint table governs PROMOTION, this governs whether a
 * descriptive cell may print a ratio at all, and they are different questions.
 * A per-regime split at n=45 is worth printing and is not promotable; a split at
 * n=11 is neither.
 */
export const EVAL_CELL_MIN_N = 30;

/** Floor for the Monte-Carlo band to be worth drawing at all. */
export const EVAL_MC_MIN_N = 20;

/** Minimum trades a trial must carry to enter the DSR/PBO trial dimension. */
export const EVAL_TRIAL_MIN_N = 10;

/** Block length for the moving-block bootstrap. Matches the `bootstrap.ts` default (TRA-405 §4). */
export const EVAL_MC_BLOCK_LENGTH = 5;

/** Bootstrap iterations. Deterministic — see {@link EVAL_MC_SEED}. */
export const EVAL_MC_ITERATIONS = 2000;

/**
 * Fixed PRNG seed for the bootstrap.
 *
 * A scheduled artifact that moves when nothing moved is an artifact nobody reads
 * twice. Seeding makes today's band diffable against yesterday's, so a change in
 * the p5/p95 is attributable to the BOOK rather than to the sampler.
 */
export const EVAL_MC_SEED = 4914;

// ─────────────────────────────────────────────────────────────────────────────
// Cost-inclusive trade extraction
// ─────────────────────────────────────────────────────────────────────────────

/**
 * WHERE a graded trade's net P&L came from, in descending order of fidelity.
 *
 *  • `broker_fill`   — TRA-2819 restated: real entry/exit fills, already NET of
 *                      measured broker fees. The best number available.
 *  • `crossed_plus_fees` — TRA-4674 re-pricing at the cross (pay the ask, sell
 *                      the bid) minus the measured regulatory fee residue. The
 *                      pessimistic bound; real fills land between it and the mid.
 *  • `mark_minus_slippage_plus_fees` — booked mark P&L with the row's MEASURED
 *                      entry/exit slippage and the fee residue taken out. Used
 *                      only when the row has no two-sided quotes but does carry
 *                      slippage measurements.
 */
export type EvalCostBasis =
  | 'broker_fill'
  | 'crossed_plus_fees'
  | 'mark_minus_slippage_plus_fees';

/** Why a closed row could not enter the graded population. */
export type EvalExclusionReason =
  /** Still open, or closed with no fill to price against (`outcome: 'UNMEASURED'`). */
  | 'unresolved'
  /** `atRiskUsd` missing or non-positive — R has no divisor. */
  | 'no_r_divisor'
  /**
   * Neither a broker-fill restatement, nor a crossable two-sided quote, nor any
   * measured slippage. The row's bid/ask cost is UNMEASURED, and a gross number
   * averaged into a cost-inclusive population is exactly the silent
   * contamination this report exists to prevent. Carries the TRA-4674 reason.
   */
  | 'spread_cost_unmeasured';

/** One closed journal row, re-priced cost-inclusive and ready to grade. */
export interface EvaluatedOptionTrade {
  id: string;
  closeTs: number;
  symbol: string;
  structure: string;
  /** TRA-4912 regime at entry; `'unknown'` on pre-TRA-4912 rows — never a fabricated label. */
  regime: JournalRegime | 'unknown';
  /** TRA-4912 entry reason; `'unknown'` on pre-TRA-4912 rows. */
  entryReason: OptionEntryReason | 'unknown';
  exitReason: string;
  /** Cost-inclusive realized P&L, USD. */
  netPnlUsd: number;
  /** `netPnlUsd / atRiskUsd` — the same divisor `realizedR` uses. */
  netR: number;
  /** The booked (mark-basis, cost-EXCLUSIVE) figure, carried so the drag is readable. */
  bookedPnlUsd: number;
  costBasis: EvalCostBasis;
}

/** A closed row that could not be graded, and why. */
export interface EvalExcludedRow {
  id: string;
  reason: EvalExclusionReason;
  /** The TRA-4674 sub-reason, when `reason === 'spread_cost_unmeasured'`. */
  crossedUnpriced: CrossedUnpricedReason | null;
}

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/**
 * Measured regulatory/clearing fee residue per contract per side, USD.
 *
 * Derived from the cost gate's MEASURED `commissionR` (TRA-4890: the desk is on a
 * Tradier Pro plan at $0 commission; what survives is ORF + OCC + SEC/TAF) rather
 * than re-typed, so a retune there moves this too instead of leaving two copies to
 * drift. `commissionR` is a round trip over R = 25% of premium, i.e.
 * `2·fee / (0.25·mark·100·contracts)` per contract — inverting at the gate's own
 * reference point ($2.00 mark, 1 contract) recovers the per-side dollar figure.
 */
export const EVAL_FEE_PER_CONTRACT_PER_SIDE_USD =
  (DEFAULT_COST_GATE_CONFIG.optionsCost.commissionR * 0.25 * 2.0 * 100) / 2;

/** Round-trip fee residue for a fill, USD. `null` when the contract count is unknown. */
function roundTripFeesUsd(contracts: number | undefined): number | null {
  if (!finite(contracts) || contracts <= 0) return null;
  return 2 * EVAL_FEE_PER_CONTRACT_PER_SIDE_USD * contracts;
}

/**
 * TRA-4914 — re-price one closed journal row cost-inclusive, or say why it cannot
 * be graded.
 *
 * The fidelity ladder (broker fill → crossed → mark-minus-slippage) is walked in
 * order and the FIRST rung that lands wins; the chosen rung is stamped on the
 * trade so a fold can census the bases it mixed instead of publishing a blended
 * number with no tell. Returns `null` — never a zero-cost trade — when no rung
 * lands, so an unmeasured-cost row cannot enter the population by default.
 */
export function evaluateOptionTradeRow(
  row: OptionTradeJournalRecord,
): { trade: EvaluatedOptionTrade } | { excluded: EvalExcludedRow } {
  const excluded = (
    reason: EvalExclusionReason,
    crossedUnpriced: CrossedUnpricedReason | null = null,
  ) => ({ excluded: { id: row.id, reason, crossedUnpriced } });

  if (row.outcome === 'OPEN' || row.outcome === 'UNMEASURED') return excluded('unresolved');
  if (!finite(row.closeTs)) return excluded('unresolved');
  if (!finite(row.realizedPnlUsd)) return excluded('unresolved');
  if (!finite(row.atRiskUsd) || row.atRiskUsd <= 0) return excluded('no_r_divisor');

  const bookedPnlUsd = row.realizedPnlUsd;
  const fees = roundTripFeesUsd(row.contracts);

  let netPnlUsd: number | null = null;
  let costBasis: EvalCostBasis | null = null;
  let crossedUnpriced: CrossedUnpricedReason | null = null;

  // Rung 1 — TRA-2819 restatement. `realizedPnlUsd` is already broker fills net
  // of `feesUsd`, and `feesUsd` is never zero-filled (the restatement refuses
  // outright on an unmeasured leg), so nothing further is subtracted here.
  if (row.pnlBasis === 'broker-fill') {
    netPnlUsd = bookedPnlUsd;
    costBasis = 'broker_fill';
  } else {
    // Rung 2 — TRA-4674 cross. Needs both quotes and a contract count; `fees`
    // needs the same contract count, so when the cross prices, the fee term is
    // available by construction.
    const crossed = priceCrossedRow(row);
    if (crossed.crossedPnlUsd !== null && fees !== null) {
      netPnlUsd = crossed.crossedPnlUsd - fees;
      costBasis = 'crossed_plus_fees';
    } else {
      crossedUnpriced = crossed.crossedUnpriced;
      // Rung 3 — measured slippage. Positive slippage = COST (we paid worse than
      // mid), so both sides subtract. At least ONE side must be measured; a row
      // with neither has no bid/ask cost measurement at all and is excluded.
      const entrySlip = finite(row.entrySlippageUsd) ? row.entrySlippageUsd : null;
      const exitSlip = finite(row.exitSlippageUsd) ? row.exitSlippageUsd : null;
      if ((entrySlip !== null || exitSlip !== null) && fees !== null) {
        netPnlUsd = bookedPnlUsd - (entrySlip ?? 0) - (exitSlip ?? 0) - fees;
        costBasis = 'mark_minus_slippage_plus_fees';
      }
    }
  }

  if (netPnlUsd === null || costBasis === null) {
    return excluded('spread_cost_unmeasured', crossedUnpriced);
  }

  return {
    trade: {
      id: row.id,
      closeTs: row.closeTs,
      symbol: row.symbol,
      structure: row.structure,
      regime: row.regimeAtEntry ?? 'unknown',
      entryReason: row.entryReason ?? 'unknown',
      exitReason: row.exitReason ?? 'unknown',
      netPnlUsd,
      netR: netPnlUsd / row.atRiskUsd,
      bookedPnlUsd,
      costBasis,
    },
  };
}

/** Census of the cost bases the graded population mixed, plus what it dropped. */
export interface EvalCostCoverage {
  /** Closed rows seen (open rows are not counted — they were never candidates). */
  closedRows: number;
  /** Rows that entered the graded population. */
  graded: number;
  /** Rows excluded, by reason. Sums to `closedRows − graded`. */
  excludedReasons: Partial<Record<EvalExclusionReason, number>>;
  /** Of the `spread_cost_unmeasured` exclusions, the TRA-4674 sub-reason census. */
  crossedUnpricedReasons: Partial<Record<CrossedUnpricedReason, number>>;
  /** Graded rows by cost basis. Sums to `graded`. */
  byCostBasis: Partial<Record<EvalCostBasis, number>>;
  /** Σ booked (mark-basis) P&L over the GRADED rows — the matched cost-exclusive column. */
  bookedPnlUsd: number | null;
  /** Σ cost-inclusive P&L over the same rows. */
  netPnlUsd: number | null;
  /** `netPnlUsd − bookedPnlUsd`: what costs ate, USD. Negative = costs. */
  costDragUsd: number | null;
}

/**
 * Extract the graded population from journal rows, ordered by `closeTs`.
 *
 * Chronological order is load-bearing and not cosmetic: the walk-forward split,
 * the block bootstrap's autocorrelation preservation and the PBO column blocks
 * are all defined over the trade SEQUENCE. Sorting here once means no downstream
 * consumer can accidentally grade a shuffled book.
 */
export function extractEvaluatedTrades(rows: readonly OptionTradeJournalRecord[]): {
  trades: EvaluatedOptionTrade[];
  excluded: EvalExcludedRow[];
  coverage: EvalCostCoverage;
} {
  const trades: EvaluatedOptionTrade[] = [];
  const excluded: EvalExcludedRow[] = [];
  let closedRows = 0;

  for (const row of rows) {
    // An OPEN row was never a candidate; counting it as an exclusion would make
    // a healthy book full of live positions read as a broken measurement.
    if (row.outcome === 'OPEN') continue;
    closedRows += 1;
    const out = evaluateOptionTradeRow(row);
    if ('trade' in out) trades.push(out.trade);
    else excluded.push(out.excluded);
  }

  trades.sort((a, b) => a.closeTs - b.closeTs || a.id.localeCompare(b.id));

  const excludedReasons: Partial<Record<EvalExclusionReason, number>> = {};
  const crossedUnpricedReasons: Partial<Record<CrossedUnpricedReason, number>> = {};
  for (const e of excluded) {
    excludedReasons[e.reason] = (excludedReasons[e.reason] ?? 0) + 1;
    if (e.crossedUnpriced) {
      crossedUnpricedReasons[e.crossedUnpriced] = (crossedUnpricedReasons[e.crossedUnpriced] ?? 0) + 1;
    }
  }
  const byCostBasis: Partial<Record<EvalCostBasis, number>> = {};
  for (const t of trades) byCostBasis[t.costBasis] = (byCostBasis[t.costBasis] ?? 0) + 1;

  const booked = trades.length > 0 ? trades.reduce((a, t) => a + t.bookedPnlUsd, 0) : null;
  const net = trades.length > 0 ? trades.reduce((a, t) => a + t.netPnlUsd, 0) : null;

  return {
    trades,
    excluded,
    coverage: {
      closedRows,
      graded: trades.length,
      excludedReasons,
      crossedUnpricedReasons,
      byCostBasis,
      bookedPnlUsd: booked,
      netPnlUsd: net,
      costDragUsd: booked !== null && net !== null ? net - booked : null,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Headline / per-regime metrics cell
// ─────────────────────────────────────────────────────────────────────────────

/**
 * One metrics cell. Every ratio is `number | null`, and they are ALL null
 * together when `status !== 'OK'` — a thin cell must not leak a half-computed
 * figure that a dashboard then renders as if it were graded.
 */
export interface EvalMetricsCell {
  status: EvalStatus;
  n: number;
  floor: number;
  /** Mean cost-inclusive R per trade. */
  expectancyR: number | null;
  profitFactor: number | null;
  sharpe: number | null;
  sortino: number | null;
  winRate: number | null;
  /** Max peak-to-trough drawdown of the cumulative-R curve, in R. */
  maxDrawdownR: number | null;
  /** MEAN drawdown across the cumulative-R curve, in R — the "typical" pain, not the worst. */
  avgDrawdownR: number | null;
  /** Longest run of consecutive losing trades (netR < 0). */
  worstLossStreak: number | null;
  /** Longest run of consecutive winning trades (netR > 0). */
  worstWinStreak: number | null;
  netPnlUsd: number | null;
}

/** An empty cell at a stated status. Metrics null — never zero. */
function emptyCell(status: EvalStatus, n: number, floor: number): EvalMetricsCell {
  return {
    status,
    n,
    floor,
    expectancyR: null,
    profitFactor: null,
    sharpe: null,
    sortino: null,
    winRate: null,
    maxDrawdownR: null,
    avgDrawdownR: null,
    worstLossStreak: null,
    worstWinStreak: null,
    netPnlUsd: null,
  };
}

/**
 * Mean drawdown of a cumulative-R curve, in R.
 *
 * NOT a duplicate of `maxDrawdown` (tra731-metrics.ts) — that returns the single
 * worst excursion, this returns the average depth below the running peak across
 * the whole curve, which is the "max/avg DD" pair the TRA-4914 AC asks for and
 * which no existing helper computes.
 */
export function avgDrawdownR(rs: readonly number[]): number | null {
  if (rs.length === 0) return null;
  let acc = 0;
  let peak = 0;
  let sum = 0;
  for (const r of rs) {
    acc += r;
    if (acc > peak) peak = acc;
    sum += peak - acc;
  }
  return sum / rs.length;
}

/** Longest run of consecutive elements satisfying `pred`. */
function longestRun(rs: readonly number[], pred: (r: number) => boolean): number {
  let best = 0;
  let cur = 0;
  for (const r of rs) {
    if (pred(r)) {
      cur += 1;
      if (cur > best) best = cur;
    } else {
      cur = 0;
    }
  }
  return best;
}

/**
 * Fold a trade slice into a metrics cell.
 *
 * PF / Sharpe / Sortino / max-DD all come from `summarizeTrades` — the existing
 * TRA-731 implementation — so this report can never drift from the sweep on how
 * a profit factor or a Sortino is defined. Only `avgDrawdownR` and the streaks
 * are computed here, because nothing existing computes them.
 */
export function buildMetricsCell(
  trades: readonly EvaluatedOptionTrade[],
  floor: number = EVAL_CELL_MIN_N,
): EvalMetricsCell {
  const n = trades.length;
  if (n === 0) return emptyCell('NOT_MEASURED', 0, floor);
  if (n < floor) return emptyCell('INSUFFICIENT', n, floor);

  const rs = trades.map((t) => t.netR);
  const pnls = trades.map((t) => t.netPnlUsd);
  const m: TradeMetrics = summarizeTrades(rs, pnls);

  return {
    status: 'OK',
    n,
    floor,
    expectancyR: m.avgR,
    profitFactor: m.profitFactor,
    sharpe: m.sharpe,
    sortino: m.sortino,
    winRate: m.winRate,
    maxDrawdownR: m.maxDrawdownR,
    avgDrawdownR: avgDrawdownR(rs),
    worstLossStreak: longestRun(rs, (r) => r < 0),
    worstWinStreak: longestRun(rs, (r) => r > 0),
    netPnlUsd: m.totalPnl,
  };
}

/** A named split (per-regime, per-entry-reason, per-structure) with its own cell. */
export interface EvalSplit {
  key: string;
  cell: EvalMetricsCell;
}

/** Group trades by a key and fold each group, descending by n. */
function splitBy(
  trades: readonly EvaluatedOptionTrade[],
  key: (t: EvaluatedOptionTrade) => string,
): EvalSplit[] {
  const groups = new Map<string, EvaluatedOptionTrade[]>();
  for (const t of trades) {
    const k = key(t);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  }
  return [...groups.entries()]
    .map(([k, g]) => ({ key: k, cell: buildMetricsCell(g) }))
    .sort((a, b) => b.cell.n - a.cell.n || a.key.localeCompare(b.key));
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk-forward IS/OOS — `buildWindows` from walk-forward.ts
// ─────────────────────────────────────────────────────────────────────────────

/** One rolling-origin IS/OOS window over the trade sequence. */
export interface EvalWalkForwardWindow {
  index: number;
  isTrades: number;
  oosTrades: number;
  isExpectancyR: number;
  oosExpectancyR: number;
  /**
   * `(IS − OOS) / |IS|`. Positive = OOS is WORSE than IS (the direction the
   * constraint bounds). `null` when the IS expectancy is 0, where the ratio is
   * undefined — reporting a 0% degradation there would read as a clean pass.
   */
  degradation: number | null;
  /** `degradation <= maxIsToOosDegradation`. `null` when degradation is null. */
  pass: boolean | null;
}

export interface EvalWalkForward {
  status: EvalStatus;
  /** Trades required to form even one window: `minInSampleTrades + minOutOfSampleTrades`. */
  requiredTrades: number;
  availableTrades: number;
  isTradesPerWindow: number;
  oosTradesPerWindow: number;
  windows: EvalWalkForwardWindow[];
  /** Expectancy over every OOS slice concatenated — the forward estimate. `null` when no window formed. */
  pooledOosExpectancyR: number | null;
  /** The OOS net-R series, concatenated in window order. Feeds the DSR. */
  pooledOosReturns: number[];
  /** Windows that passed the degradation bound / total gradeable windows. */
  windowsPassed: number;
  windowsGraded: number;
}

const meanOf = (xs: readonly number[]): number =>
  xs.length > 0 ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

/**
 * TRA-4914 — walk-forward IS/OOS over the CLOSED-TRADE SEQUENCE, using
 * `buildWindows` from `walk-forward.ts` unchanged.
 *
 * ⚠ Deliberately `buildWindows` and NOT `walkForward`. The latter drives a
 * `BacktestRunner` over a candle array and re-optimizes parameters per window —
 * there is no such sweep on the options path, and more to the point there is no
 * OHLCV to re-run against: closed ledger rows carry none, and features rebuilt
 * off a reconstructed tape LEAK LOOK-AHEAD (TRA-4095, measured NO-GO at n=2098).
 * What is honest here is the SPLIT, not a re-simulation: `buildWindows` is
 * calendar-agnostic and expressed in counts, so it partitions the realized trade
 * sequence into the same rolling-origin IS/OOS structure without inventing a
 * single price. The constraint table's "max 35% IS→OOS degradation" is exactly a
 * statement about that partition.
 */
export function buildWalkForward(trades: readonly EvaluatedOptionTrade[]): EvalWalkForward {
  const isN = OPTIONS_EVAL_CONSTRAINTS.minInSampleTrades;
  const oosN = OPTIONS_EVAL_CONSTRAINTS.minOutOfSampleTrades;
  const required = isN + oosN;

  const specs = buildWindows(trades.length, isN, oosN);
  if (specs.length === 0) {
    return {
      status: trades.length === 0 ? 'NOT_MEASURED' : 'INSUFFICIENT',
      requiredTrades: required,
      availableTrades: trades.length,
      isTradesPerWindow: isN,
      oosTradesPerWindow: oosN,
      windows: [],
      pooledOosExpectancyR: null,
      pooledOosReturns: [],
      windowsPassed: 0,
      windowsGraded: 0,
    };
  }

  const windows: EvalWalkForwardWindow[] = [];
  const pooledOos: number[] = [];
  let passed = 0;
  let graded = 0;

  specs.forEach((w, index) => {
    const isRs = trades.slice(w.trainStart, w.trainEnd).map((t) => t.netR);
    const oosRs = trades.slice(w.testStart, w.testEnd).map((t) => t.netR);
    pooledOos.push(...oosRs);
    const isE = meanOf(isRs);
    const oosE = meanOf(oosRs);
    const degradation = isE !== 0 ? (isE - oosE) / Math.abs(isE) : null;
    const pass = degradation === null ? null : degradation <= OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation;
    if (pass !== null) {
      graded += 1;
      if (pass) passed += 1;
    }
    windows.push({
      index,
      isTrades: isRs.length,
      oosTrades: oosRs.length,
      isExpectancyR: isE,
      oosExpectancyR: oosE,
      degradation,
      pass,
    });
  });

  return {
    status: 'OK',
    requiredTrades: required,
    availableTrades: trades.length,
    isTradesPerWindow: isN,
    oosTradesPerWindow: oosN,
    windows,
    pooledOosExpectancyR: pooledOos.length > 0 ? meanOf(pooledOos) : null,
    pooledOosReturns: pooledOos,
    windowsPassed: passed,
    windowsGraded: graded,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Monte Carlo — `blockBootstrapEquityCurves` from bootstrap.ts
// ─────────────────────────────────────────────────────────────────────────────

export interface EvalMonteCarlo {
  status: EvalStatus;
  n: number;
  floor: number;
  /** Starting equity the band is expressed against. */
  initialEquityUsd: number;
  blockLength: number;
  /** p5 / p50 / p95 final equity and the worst drawdown across iterations. `null` below the floor. */
  bands: ConfidenceBands | null;
}

/**
 * The bootstrap reads exactly one field off each element (`t.pnl ?? 0`), but its
 * parameter is typed `ReadonlyArray<Position>`. Rather than cast — a cast is how
 * TRA-4912 got a green vitest against a tree that did not type-check — build real
 * `Position` values. Everything except `pnl`, `id` and `openedAt`/`closedAt` is a
 * structurally-required placeholder the bootstrap never reads.
 */
function asBootstrapPositions(trades: readonly EvaluatedOptionTrade[]): Position[] {
  return trades.map((t) => ({
    id: t.id,
    symbol: t.symbol,
    side: 'buy' as const,
    signalType: 'relative_value' as const,
    entryPrice: 0,
    quantity: 0,
    stopLoss: 0,
    takeProfit: 0,
    openedAt: t.closeTs,
    closedAt: t.closeTs,
    pnl: t.netPnlUsd,
  }));
}

/**
 * TRA-4914 — block-bootstrap MC bands over the cost-inclusive trade P&L, using
 * `blockBootstrapEquityCurves` unchanged.
 *
 * The BLOCK variant, not the IID one: options trades cluster (a regime drags a
 * whole run the same way), and the IID sampler destroys exactly that
 * autocorrelation, producing a drawdown band that is optimistic by construction.
 */
export function buildMonteCarlo(
  trades: readonly EvaluatedOptionTrade[],
  initialEquityUsd: number,
): EvalMonteCarlo {
  const n = trades.length;
  const base = {
    n,
    floor: EVAL_MC_MIN_N,
    initialEquityUsd,
    blockLength: EVAL_MC_BLOCK_LENGTH,
  };
  if (n === 0) return { status: 'NOT_MEASURED', ...base, bands: null };
  if (n < EVAL_MC_MIN_N) return { status: 'INSUFFICIENT', ...base, bands: null };
  return {
    status: 'OK',
    ...base,
    bands: blockBootstrapEquityCurves(asBootstrapPositions(trades), initialEquityUsd, {
      iterations: EVAL_MC_ITERATIONS,
      blockLength: EVAL_MC_BLOCK_LENGTH,
      seed: EVAL_MC_SEED,
    }),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overfitting — PSR / DSR / PBO from overfitting-stats.ts
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The TRIAL DIMENSION the multiple-testing penalties are computed over.
 *
 * ⚠ READ THIS BEFORE QUOTING A DSR OR A PBO OFF THIS REPORT. DSR and PBO both
 * need a set of CONFIGURATIONS that were tried and selected among. The options
 * path journals one live configuration, so there is no sweep to hand them. What
 * the journal does carry is the set of ENTRY REASONS (TRA-4912) actually run on
 * the same tape — genuinely distinct triggers, selected among by the people who
 * kept them — so the trial dimension is that set, one trial per entry reason
 * carrying at least {@link EVAL_TRIAL_MIN_N} trades.
 *
 * That is a LOWER BOUND on configurations tried, and the report says so in
 * `trialCountBasis`. Configurations that were tried and abandoned before they
 * ever journalled a row are invisible here and cannot be counted, which makes
 * the deflation penalty too SMALL and therefore the DSR too OPTIMISTIC. A DSR
 * that fails on this trial set is real evidence; a DSR that passes it is not
 * evidence of the absence of overfitting.
 */
export type EvalTrialBasis = 'entry_reason_declared_lower_bound';

export interface EvalTrial {
  key: string;
  n: number;
  /** Per-trade Sharpe of this trial's cost-inclusive R series. */
  sharpe: number;
}

export interface EvalOverfitting {
  /** PSR of the graded population's net-R series against SR* = 0. */
  psr: {
    status: EvalStatus;
    n: number;
    floor: number;
    observedSharpe: number | null;
    skew: number | null;
    kurtosis: number | null;
    /** P(true per-trade Sharpe > 0). */
    value: number | null;
  };
  /** Deflated Sharpe over the trial count. */
  dsr: {
    status: EvalStatus;
    trialCountBasis: EvalTrialBasis;
    trials: EvalTrial[];
    /** Which return series the observed Sharpe was measured on. */
    returnsBasis: 'walk_forward_pooled_oos' | 'full_graded_population' | null;
    result: DeflatedSharpeResult | null;
  };
  /** Probability of backtest overfitting (CSCV) over the trial × time-block matrix. */
  pbo: {
    status: EvalStatus;
    trialCountBasis: EvalTrialBasis;
    trials: number;
    /** Chronological observation blocks the trade sequence was cut into. */
    columns: number;
    /** Why PBO could not be computed, when it could not. */
    unmeasuredReason:
      | 'fewer_than_two_trials'
      | 'too_few_observation_blocks'
      | 'trial_absent_from_a_block'
      | null;
    result: PboResult | null;
  };
}

/** PSR needs enough observations for the higher moments to mean anything. */
export const EVAL_PSR_MIN_N = 30;

/** CSCV column count. Even, as the estimator requires. */
export const EVAL_PBO_COLUMNS = 8;

/**
 * TRA-4914 — PSR / DSR / PBO on the options path, by calling the existing
 * `overfitting-stats.ts` implementations.
 *
 * Every one of the three can legitimately come back `INSUFFICIENT` or
 * `NOT_MEASURED` on today's book, and that is the intended reading — a report
 * that printed a PBO off two trials and three trades would be the fabricated
 * confidence this whole ticket is a reaction to.
 */
export function buildOverfitting(
  trades: readonly EvaluatedOptionTrade[],
  walkForwardOos: readonly number[],
): EvalOverfitting {
  const rs = trades.map((t) => t.netR);

  // ── PSR ──────────────────────────────────────────────────────────────────
  const psrFloor = EVAL_PSR_MIN_N;
  let psr: EvalOverfitting['psr'];
  if (rs.length === 0) {
    psr = { status: 'NOT_MEASURED', n: 0, floor: psrFloor, observedSharpe: null, skew: null, kurtosis: null, value: null };
  } else if (rs.length < psrFloor) {
    psr = { status: 'INSUFFICIENT', n: rs.length, floor: psrFloor, observedSharpe: null, skew: null, kurtosis: null, value: null };
  } else {
    const mom = sampleMoments(rs);
    const observedSharpe = mom.std > 0 ? mom.mean / mom.std : 0;
    psr = {
      status: 'OK',
      n: mom.n,
      floor: psrFloor,
      observedSharpe,
      skew: mom.skew,
      kurtosis: mom.kurtosis,
      value: probabilisticSharpeRatio(observedSharpe, 0, mom.n, mom.skew, mom.kurtosis),
    };
  }

  // ── The trial dimension, shared by DSR and PBO ────────────────────────────
  const byReason = new Map<string, EvaluatedOptionTrade[]>();
  for (const t of trades) {
    const g = byReason.get(t.entryReason);
    if (g) g.push(t);
    else byReason.set(t.entryReason, [t]);
  }
  const trialGroups = [...byReason.entries()]
    .filter(([, g]) => g.length >= EVAL_TRIAL_MIN_N)
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const trials: EvalTrial[] = trialGroups.map(([key, g]) => {
    const mom = sampleMoments(g.map((t) => t.netR));
    return { key, n: g.length, sharpe: mom.std > 0 ? mom.mean / mom.std : 0 };
  });

  // ── DSR ──────────────────────────────────────────────────────────────────
  // Prefer the walk-forward pooled OOS series: deflating an IN-SAMPLE Sharpe
  // understates the problem the statistic exists to expose. Fall back to the
  // full graded population only when no walk-forward window formed, and LABEL
  // which one was used — the two are not interchangeable evidence.
  const dsrReturns = walkForwardOos.length >= 2 ? walkForwardOos : rs;
  const returnsBasis: 'walk_forward_pooled_oos' | 'full_graded_population' | null =
    dsrReturns.length < 2 ? null : walkForwardOos.length >= 2 ? 'walk_forward_pooled_oos' : 'full_graded_population';
  let dsr: EvalOverfitting['dsr'];
  if (trials.length === 0 || dsrReturns.length < 2) {
    dsr = {
      status: trials.length === 0 && rs.length === 0 ? 'NOT_MEASURED' : 'INSUFFICIENT',
      trialCountBasis: 'entry_reason_declared_lower_bound',
      trials,
      returnsBasis,
      result: null,
    };
  } else if (trials.length < 2) {
    // One trial means no multiple-testing inflation to deflate — `expectedMaxSharpe`
    // would return 0 and the "deflated" Sharpe would just be the PSR again wearing
    // a stronger name. Refuse rather than publish a tautology as a guard.
    dsr = {
      status: 'INSUFFICIENT',
      trialCountBasis: 'entry_reason_declared_lower_bound',
      trials,
      returnsBasis,
      result: null,
    };
  } else {
    dsr = {
      status: 'OK',
      trialCountBasis: 'entry_reason_declared_lower_bound',
      trials,
      returnsBasis,
      result: deflatedSharpeRatio({
        returns: dsrReturns,
        trialSharpes: trials.map((t) => t.sharpe),
        trialCount: trials.length,
      }),
    };
  }

  // ── PBO ──────────────────────────────────────────────────────────────────
  // The CSCV matrix is `trial × chronological block`, each cell the mean net R
  // of that trial's trades inside that block. A trial with NO trades in a block
  // has no honest cell value — a 0 there is a fabricated flat return, and it is
  // precisely the kind of manufactured datum that moves a PBO. So an absent cell
  // refuses the whole statistic rather than being filled.
  const columns = EVAL_PBO_COLUMNS;
  let pboUnmeasured: EvalOverfitting['pbo']['unmeasuredReason'] = null;
  let pboResult: PboResult | null = null;
  if (trials.length < 2) {
    pboUnmeasured = 'fewer_than_two_trials';
  } else if (trades.length < columns * EVAL_TRIAL_MIN_N) {
    pboUnmeasured = 'too_few_observation_blocks';
  } else {
    const blockSize = Math.floor(trades.length / columns);
    const matrix: number[][] = [];
    for (const trial of trials) {
      const rowVals: number[] = [];
      for (let c = 0; c < columns; c += 1) {
        const slice = trades.slice(c * blockSize, (c + 1) * blockSize).filter((t) => t.entryReason === trial.key);
        if (slice.length === 0) {
          pboUnmeasured = 'trial_absent_from_a_block';
          break;
        }
        rowVals.push(meanOf(slice.map((t) => t.netR)));
      }
      if (pboUnmeasured) break;
      matrix.push(rowVals);
    }
    if (!pboUnmeasured) {
      pboResult = probabilityOfBacktestOverfitting({ matrix, partitions: columns });
    }
  }

  return {
    psr,
    dsr,
    pbo: {
      status: pboResult ? 'OK' : trades.length === 0 ? 'NOT_MEASURED' : 'INSUFFICIENT',
      trialCountBasis: 'entry_reason_declared_lower_bound',
      trials: trials.length,
      columns,
      unmeasuredReason: pboUnmeasured,
      result: pboResult,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The constraint table verdict
// ─────────────────────────────────────────────────────────────────────────────

/** A single constraint, its bound, what was measured, and the verdict. */
export interface EvalConstraintRow {
  name: string;
  /** The bound, as written in the proposal. */
  required: string;
  /** What we measured, or `null` when the input was never exercised. */
  measured: string | null;
  /** `PASS` / `FAIL` / `INSUFFICIENT` (measured and below the evidence floor) / `NOT_MEASURED`. */
  verdict: 'PASS' | 'FAIL' | 'INSUFFICIENT' | 'NOT_MEASURED';
  /** One line naming why the verdict is what it is. Never empty. */
  note: string;
}

/** The constraint table, graded. */
export interface EvalConstraints {
  /** `PASS` only when every row is `PASS`. Any `FAIL` ⇒ `FAIL`; otherwise `INSUFFICIENT`. */
  overall: 'PASS' | 'FAIL' | 'INSUFFICIENT';
  rows: EvalConstraintRow[];
}

function gradeConstraints(
  wf: EvalWalkForward,
  headline: EvalMetricsCell,
  coverage: EvalCostCoverage,
): EvalConstraints {
  const rows: EvalConstraintRow[] = [];

  const maxIsSeen = wf.windows.reduce((a, w) => Math.max(a, w.isTrades), 0);
  rows.push({
    name: 'min in-sample trades',
    required: `>= ${OPTIONS_EVAL_CONSTRAINTS.minInSampleTrades}`,
    measured: wf.windows.length > 0 ? String(maxIsSeen) : String(coverage.graded),
    verdict: wf.windows.length > 0 ? 'PASS' : 'INSUFFICIENT',
    note:
      wf.windows.length > 0
        ? `${wf.windows.length} walk-forward window(s) formed, each with ${wf.isTradesPerWindow} IS trades.`
        : `${coverage.graded} graded trade(s) — a window needs ${wf.requiredTrades}. No IS slice exists yet.`,
  });

  rows.push({
    name: 'min out-of-sample trades',
    required: `>= ${OPTIONS_EVAL_CONSTRAINTS.minOutOfSampleTrades}`,
    measured: wf.windows.length > 0 ? String(wf.oosTradesPerWindow) : String(0),
    verdict: wf.windows.length > 0 ? 'PASS' : 'INSUFFICIENT',
    note:
      wf.windows.length > 0
        ? `Pooled OOS n=${wf.pooledOosReturns.length}.`
        : 'No walk-forward window formed, so no OOS slice exists. This is not a zero-OOS result; it is an unmeasured one.',
  });

  const paramCount = OPTIONS_PATH_TUNED_PARAMS.length;
  rows.push({
    name: 'max parameters',
    required: `<= ${OPTIONS_EVAL_CONSTRAINTS.maxParams}`,
    measured: String(paramCount),
    verdict: paramCount <= OPTIONS_EVAL_CONSTRAINTS.maxParams ? 'PASS' : 'FAIL',
    note:
      'DECLARED LOWER BOUND from OPTIONS_PATH_TUNED_PARAMS — hand-maintained, not derived. '
      + 'A parameter tuned and never registered there is invisible to this row.',
  });

  const degradations = wf.windows.map((w) => w.degradation).filter((d): d is number => d !== null);
  const worst = degradations.length > 0 ? Math.max(...degradations) : null;
  rows.push({
    name: 'max IS->OOS degradation',
    required: `<= ${(OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation * 100).toFixed(0)}%`,
    measured: worst !== null ? `${(worst * 100).toFixed(1)}% (worst window)` : null,
    verdict: worst === null ? 'INSUFFICIENT' : worst <= OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation ? 'PASS' : 'FAIL',
    note:
      worst === null
        ? 'No gradeable walk-forward window. Degradation is UNMEASURED, which is not a 0% degradation.'
        : `${wf.windowsPassed}/${wf.windowsGraded} window(s) inside the bound.`,
  });

  const profitable = headline.status === 'OK' && headline.netPnlUsd !== null ? headline.netPnlUsd > 0 : null;
  rows.push({
    name: 'profitable after costs',
    required: 'net P&L > $0 with commissions, bid/ask and slippage taken out',
    measured:
      headline.netPnlUsd !== null
        ? `$${headline.netPnlUsd.toFixed(2)} net vs $${(coverage.bookedPnlUsd ?? 0).toFixed(2)} booked`
        : null,
    verdict: profitable === null ? 'INSUFFICIENT' : profitable ? 'PASS' : 'FAIL',
    note:
      headline.status === 'OK'
        ? `Cost drag $${(coverage.costDragUsd ?? 0).toFixed(2)} over ${coverage.graded} graded row(s); `
          + `${coverage.closedRows - coverage.graded} closed row(s) excluded for unmeasurable cost.`
        : `Headline cell is ${headline.status} at n=${headline.n} (floor ${headline.floor}). `
          + 'No profitability verdict is owed off a sample this thin.',
  });

  const overall = rows.some((r) => r.verdict === 'FAIL')
    ? 'FAIL'
    : rows.every((r) => r.verdict === 'PASS')
      ? 'PASS'
      : 'INSUFFICIENT';

  return { overall, rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

/** Default notional the Monte-Carlo equity band is expressed against. */
export const EVAL_DEFAULT_INITIAL_EQUITY_USD = 25_000;

export interface OptionsEvaluationReport {
  /** Schema version — bump when a consumer-visible field changes shape. */
  version: 1;
  /** Ticket that owns the artifact, so a stray file is traceable. */
  ticket: 'TRA-4914';
  /** ms-epoch the report was built. */
  generatedAt: number;
  /** ET date the report is filed under. */
  asOfDate: string;
  /** The row basis the caller folded on (echoed, e.g. `desk+unattributed`). */
  journalBasis: string;
  /** Window of `closeTs` covered by the graded population; null when nothing graded. */
  window: { fromTs: number; toTs: number } | null;
  coverage: EvalCostCoverage;
  headline: EvalMetricsCell;
  byRegime: EvalSplit[];
  byEntryReason: EvalSplit[];
  byStructure: EvalSplit[];
  walkForward: EvalWalkForward;
  monteCarlo: EvalMonteCarlo;
  overfitting: EvalOverfitting;
  constraints: EvalConstraints;
  /** Excluded rows, capped, so a reader can see WHICH rows the report declined to grade. */
  excludedSample: EvalExcludedRow[];
}

/** Cap on the excluded-row sample carried in the artifact. */
export const EVAL_EXCLUDED_SAMPLE_MAX = 50;

export interface BuildOptionsEvaluationReportOptions {
  asOfDate: string;
  journalBasis?: string;
  initialEquityUsd?: number;
  now?: number;
}

/**
 * TRA-4914 — build the options evaluation report. PURE: no clock beyond
 * `opts.now`, no filesystem, no network, no chain read.
 *
 * The caller supplies the rows and names the basis it folded on; this function
 * does not decide which book it is grading. That keeps the demo/live and
 * desk/fixture pins where they already live (`model-facing-journal.ts`) rather
 * than growing a second, drifting copy here.
 */
export function buildOptionsEvaluationReport(
  rows: readonly OptionTradeJournalRecord[],
  opts: BuildOptionsEvaluationReportOptions,
): OptionsEvaluationReport {
  const { trades, excluded, coverage } = extractEvaluatedTrades(rows);
  const headline = buildMetricsCell(trades);
  const walkForward = buildWalkForward(trades);
  const monteCarlo = buildMonteCarlo(trades, opts.initialEquityUsd ?? EVAL_DEFAULT_INITIAL_EQUITY_USD);
  const overfitting = buildOverfitting(trades, walkForward.pooledOosReturns);

  return {
    version: 1,
    ticket: 'TRA-4914',
    generatedAt: opts.now ?? Date.now(),
    asOfDate: opts.asOfDate,
    journalBasis: opts.journalBasis ?? 'unspecified',
    window:
      trades.length > 0
        ? { fromTs: trades[0].closeTs, toTs: trades[trades.length - 1].closeTs }
        : null,
    coverage,
    headline,
    byRegime: splitBy(trades, (t) => t.regime),
    byEntryReason: splitBy(trades, (t) => t.entryReason),
    byStructure: splitBy(trades, (t) => t.structure),
    walkForward,
    monteCarlo,
    overfitting,
    constraints: gradeConstraints(walkForward, headline, coverage),
    excludedSample: excluded.slice(0, EVAL_EXCLUDED_SAMPLE_MAX),
  };
}
