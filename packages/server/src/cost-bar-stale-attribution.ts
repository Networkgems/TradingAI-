// TRA-4978 (parent TRA-4931) — WHO ACTUALLY REFUSED, AND IS THE SLEEVE TRADEABLE
// AT ALL? The remedy half of TRA-4875, which shipped the detector.
//
// ── WHAT WAS MEASURED, AND WHY A DETECTOR IS NOT ENOUGH ──────────────────────
// Live `faae9388` (pid 76, up since 2026-09-28T01:22:49Z), read 2026-10-01T18:13Z
// off `https://tradingai-bqb1.onrender.com/api/health/live-enforce-gates`:
//
//   • `degradations[cost_bar_edge_input_stale]` publishes `decisionsBlocked:
//     20678` across four cells at tape ages 57.1–63.1 d against a 10 d bar, and
//     its prose says those cells are "ENFORCING live refusals off an expectancy
//     constant" that stopped advancing in early August.
//   • The ROWS say something else. `byGate[cost_bar].byReason`, by ET day:
//       2026-09-22/23/24 → `shortfall_gte_0.50` + `shortfall_0.25_0.50`, 100%
//       2026-09-25/28/29/30 and 10-01 → `insufficient_real_fill_evidence`, 100%
//     Since-boot the gate reads `evaluated: 1024, blocked: 1024,
//     rowsCompared: 0, rowsShortCircuited: 1024`. **The constant is not being
//     read.** TRA-4894's real-fill arm refuses every candidate on a
//     precondition, upstream of the comparison, so on 8,100 of the fold's
//     20,678 refusals — and on 100% of the last five sessions — the input's age
//     caused nothing.
//
// So the detector's headline number counts refusals made WHILE the input was
// stale, not refusals CAUSED by it. That is the TRA-3897 shape: a filing read
// off the grade's own column while the ROWS held the discriminator all along.
// TRA-4745 shipped that discriminator and its own doc comment already says a
// cell at `blocked === evaluated` with `rowsCompared === 0` is "NEITHER a cost
// problem NOR an edge collapse — no bar move and no `k` can reach it". Nothing
// joined the two. Somebody who refreshed the tape on the strength of the 20,678
// would have moved ZERO decisions.
//
// ── THE FAIL DIRECTION, DECIDED AND PUBLISHED (TRA-4978 item 2) ──────────────
// Design **(a)**: fail closed, and say **NOT TRADEABLE at the cell and sleeve
// level** rather than leaving a reader to infer it from a candidate-by-candidate
// refusal stream that reads like a quiet market. Design (b) — fall back to a
// conservative prior — is rejected: there is no prior that admits, since the
// binding arm counts broker-truth rows rather than comparing a number, and a
// prior that refuses is what we already have with extra machinery.
//
// ⛔ EVERY FUNCTION HERE IS PURE AND READ-ONLY. Nothing on the admission path
// consults this module, no gate/arm/bar/reason-code branches on it, and a
// `NOT_TRADEABLE` verdict neither adds nor removes a refusal. The stand-down is
// a PUBLISHED VERDICT, deliberately:
//
//   • the cells cannot admit anything today (`admits` false on both arms), so a
//     code path that short-circuited the sleeve ahead of per-candidate
//     evaluation would add no safety;
//   • it would leave every upstream gate (`entry_window`, `contract_floor`,
//     `setup_confirmation`, `universe`, `underlying_asset_class`,
//     `otm_delta_floor`) evaluating into a decision that can no longer matter —
//     the vacuous-instrument shape `sleeve-stand-down.ts` exists to close,
//     re-committed one layer down;
//   • the per-candidate rows ARE the denominator separating "the gate is
//     enforcing" from "the gate is inert", and they are retained on purpose.
//
// Disarming `ENABLE_OPTION_LIVE_OTM` is the operational form of a stand-down and
// belongs to whoever owns that arm, not to a health route.

import {
  TAPE_EXPECTANCY_MIN_CELL_N,
  TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
  type TapeExpectancyCell,
} from './option-tape-expectancy.js';
import { TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES } from './live-enforce-gate-predicate.js';

/**
 * The subset of a `cost_bar` `byCell` ledger row this fold reads.
 *
 * Structurally typed rather than importing `LiveEnforceGateCellRow` so the
 * retained fold and the since-boot fold can both be passed, and so a test can
 * build the exact shape under test without standing up a ledger.
 */
export interface CostBarCellLedgerRow {
  cell: string;
  evaluated: number;
  blocked: number;
  /** Stamped rows the gate actually COMPARED against the constant (TRA-4745). */
  rowsCompared: number;
  /** Stamped rows refused by a precondition BEFORE the constant was read. */
  rowsShortCircuited: number;
  /** Rows carrying no predicate stamp at all. Coverage, not a clean bill. */
  predicateUnstamped: number;
  /** One sampled blocked row per ET day. A SAMPLE — never a census. */
  predicateSamples: readonly { shortCircuit: string | null }[];
  inputFreshness: {
    stale: boolean | null;
    tapeAgeDaysAtDecisionMax: number | null;
    tapeToIsoNewest: string | null;
  } | null;
}

/** One stale cell with its refusals attributed to what actually made them. */
export interface StaleCostBarCellAttribution {
  cell: string;
  tapeAgeDaysAtDecisionMax: number | null;
  tapeToIsoNewest: string | null;
  /** Refusals made WHILE the constant was stale. The TRA-4875 number, unchanged. */
  decisionsBlocked: number;
  decisionsEvaluated: number;
  /** ⭐ Refusals the stale constant actually DECIDED (`rowsCompared`). */
  decisionsDecidedByStaleInput: number;
  /** Refused upstream of the constant — its age caused nothing on these rows. */
  decisionsShortCircuitedUpstream: number;
  /** Rows carrying no predicate stamp. */
  decisionsUnstamped: number;
  /** Distinct short-circuit codes SEEN IN THE SAMPLES. Not a census. */
  shortCircuitReasonsSampled: string[];
  /** FALSE ⇒ this cell's staleness is currently deciding nothing at all. */
  staleInputGovernsDecisions: boolean;
}

/**
 * Fold the `cost_bar` cell rows into one attributed entry per STALE cell.
 *
 * Pass the retained fold first and the since-boot fold second; a cell appearing
 * in both keeps the WORSE reading (oldest tape, largest counts), so a fresh boot
 * can never wash out a staleness the 30-day fold recorded.
 *
 * ⚠️ `stale` is three-valued and only `true` enters this fold. `null` is NOT
 * COMPUTABLE and must never be coerced — a cell with no stamped rows has an
 * unknown tape age, which is not a clean bill, and it belongs to the coverage
 * conversation (`predicateUnstamped`), not to this one.
 *
 * ⚠️ The counts take a MAX independently of the age comparison. The inline
 * version this replaced skipped the count merge entirely whenever the newer row
 * read a LOWER age, so a since-boot fold with a newer tape silently discarded
 * its own refusal count — the counts and the age are different questions and are
 * now merged separately.
 */
export function foldStaleCostBarCells(
  ...folds: readonly (readonly CostBarCellLedgerRow[])[]
): StaleCostBarCellAttribution[] {
  const byKey = new Map<string, StaleCostBarCellAttribution>();
  for (const fold of folds) {
    for (const row of fold) {
      if (row.inputFreshness?.stale !== true) continue;
      const prior = byKey.get(row.cell);
      const reasons = new Set(prior?.shortCircuitReasonsSampled ?? []);
      for (const s of row.predicateSamples) {
        if (s.shortCircuit !== null) reasons.add(s.shortCircuit);
      }
      const olderTape =
        prior === undefined
        || (row.inputFreshness.tapeAgeDaysAtDecisionMax ?? 0)
          > (prior.tapeAgeDaysAtDecisionMax ?? 0);
      const decided = Math.max(prior?.decisionsDecidedByStaleInput ?? 0, row.rowsCompared);
      byKey.set(row.cell, {
        cell: row.cell,
        tapeAgeDaysAtDecisionMax: olderTape
          ? row.inputFreshness.tapeAgeDaysAtDecisionMax
          : (prior?.tapeAgeDaysAtDecisionMax ?? null),
        tapeToIsoNewest: olderTape
          ? row.inputFreshness.tapeToIsoNewest
          : (prior?.tapeToIsoNewest ?? null),
        decisionsBlocked: Math.max(prior?.decisionsBlocked ?? 0, row.blocked),
        decisionsEvaluated: Math.max(prior?.decisionsEvaluated ?? 0, row.evaluated),
        decisionsDecidedByStaleInput: decided,
        decisionsShortCircuitedUpstream: Math.max(
          prior?.decisionsShortCircuitedUpstream ?? 0,
          row.rowsShortCircuited,
        ),
        decisionsUnstamped: Math.max(prior?.decisionsUnstamped ?? 0, row.predicateUnstamped),
        shortCircuitReasonsSampled: [...reasons].sort(),
        staleInputGovernsDecisions: decided > 0,
      });
    }
  }
  return [...byKey.values()].sort(
    (a, b) => (b.tapeAgeDaysAtDecisionMax ?? 0) - (a.tapeAgeDaysAtDecisionMax ?? 0),
  );
}

/** Why a cell cannot admit. Low-cardinality, so a reader can group on it. */
export type CostBarStandDownReason =
  | 'insufficient_pooled_n'
  | 'pooled_bound_unknown'
  | 'pooled_bound_below_bar'
  | 'insufficient_real_fill_evidence'
  | 'real_fill_bound_below_bar'
  | 'cell_absent_from_estimator';

/** One cell's tradeability, as a published verdict. */
export interface CostBarCellStandDown {
  /** `true` admits, `false` stood down, `null` NOT COMPUTABLE (never read as either). */
  tradeable: boolean | null;
  reasonCodes: CostBarStandDownReason[];
  n: number | null;
  nRealFill: number | null;
  minCellN: number;
  minRealFillN: number;
  lowerCI95: number | null;
  barR: number | null;
  /** `barR − lowerCI95`: how far the pooled arm is from admitting, in gate R. */
  pooledShortfallR: number | null;
  admits: boolean | null;
  admitsPooled: boolean | null;
  admitsRealFill: boolean | null;
  realFillUnavailableReason: string | null;
  /**
   * ⭐ A DEDUCTION, NEVER A FORECAST. `admits` is `admitsPooled &&
   * admitsRealFill`, and `admitsRealFill` requires
   * `nRealFill >= TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N` — a count of rows
   * carrying broker truth on BOTH legs. Re-folding on a tape that ends today
   * adds no such row, so below that floor the answer is `false` by construction
   * and no claim is made about future market conditions. `null` above the floor:
   * what a fresher tape would say there is genuinely unknown, and this module
   * does not guess.
   */
  recencyAloneCanAdmit: boolean | null;
  statement: string;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Grade ONE estimator cell's tradeability.
 *
 * `cell: null` means the ledger recorded decisions in a cell the estimator table
 * does not hold. That reads `null`, with its own reason code — an unknown cell
 * is not a tradeable one and is not an untradeable one either.
 */
export function describeCostBarCellStandDown(
  cellKey: string,
  cell: TapeExpectancyCell | null,
): CostBarCellStandDown {
  if (cell === null) {
    return {
      tradeable: null,
      reasonCodes: ['cell_absent_from_estimator'],
      n: null,
      nRealFill: null,
      minCellN: TAPE_EXPECTANCY_MIN_CELL_N,
      minRealFillN: TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
      lowerCI95: null,
      barR: null,
      pooledShortfallR: null,
      admits: null,
      admitsPooled: null,
      admitsRealFill: null,
      realFillUnavailableReason: null,
      recencyAloneCanAdmit: null,
      statement:
        `NOT COMPUTABLE — the ledger recorded decisions in ${cellKey} but the estimator table holds `
        + 'no such cell, so this cell\'s tradeability cannot be graded. Unknown is NOT tradeable.',
    };
  }
  const reasonCodes: CostBarStandDownReason[] = [];
  if (cell.n < TAPE_EXPECTANCY_MIN_CELL_N) reasonCodes.push('insufficient_pooled_n');
  if (cell.lowerCI95 === null) reasonCodes.push('pooled_bound_unknown');
  else if (cell.lowerCI95 < cell.barR) reasonCodes.push('pooled_bound_below_bar');
  if (cell.nRealFill < TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N) {
    reasonCodes.push('insufficient_real_fill_evidence');
  } else if (!cell.admitsRealFill) reasonCodes.push('real_fill_bound_below_bar');
  const recencyAloneCanAdmit =
    cell.nRealFill < TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N ? false : null;
  const pooledShortfallR = cell.lowerCI95 === null ? null : round4(cell.barR - cell.lowerCI95);
  return {
    tradeable: cell.admits,
    reasonCodes,
    n: cell.n,
    nRealFill: cell.nRealFill,
    minCellN: TAPE_EXPECTANCY_MIN_CELL_N,
    minRealFillN: TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N,
    lowerCI95: cell.lowerCI95,
    barR: cell.barR,
    pooledShortfallR,
    admits: cell.admits,
    admitsPooled: cell.admitsPooled,
    admitsRealFill: cell.admitsRealFill,
    realFillUnavailableReason: cell.realFillUnavailableReason,
    recencyAloneCanAdmit,
    statement: cell.admits
      ? `TRADEABLE — ${cellKey} admits at n=${cell.n} (bound ${cell.lowerCI95} ≥ bar ${cell.barR}) `
        + `with the real-fill arm satisfied at nRealFill=${cell.nRealFill}.`
      : `⛔ STOOD DOWN — ${cellKey} CANNOT admit any candidate under the deployed estimator, `
        + `independently of how fresh the tape is: ${reasonCodes.join(' + ')}. `
        + `Pooled arm: n=${cell.n}, lowerCI95=`
        + `${cell.lowerCI95 === null ? 'unknown' : cell.lowerCI95} vs bar ${cell.barR}`
        + `${pooledShortfallR === null ? '' : ` (short by ${pooledShortfallR} R)`}. `
        + `Real-fill arm: nRealFill=${cell.nRealFill} of ${TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N} required`
        + `${cell.realFillUnavailableReason === null ? '' : ` — ${cell.realFillUnavailableReason}`}. `
        + (recencyAloneCanAdmit === false
          ? 'A TAPE REFRESH ALONE CANNOT CHANGE THIS: the real-fill arm counts rows carrying broker '
            + 'truth on BOTH legs, and re-folding on a tape that ends today adds none. '
          : '')
        + 'Read this as the sleeve being stood down in this cell, NOT as a quiet market — the '
        + 'per-candidate refusal rows are retained deliberately, as the denominator.',
  };
}

/** The sleeve-level roll-up: the published fail direction. */
export interface CostBarSleeveStandDown {
  verdict: 'NOT_TRADEABLE' | 'TRADEABLE_CELL_PRESENT' | 'NOT_MEASURED';
  sleeve: string;
  /** The scope the verdict is over, named so it cannot be read wider than it is. */
  scope: string;
  cellsConsidered: string[];
  cellsTradeable: string[];
  bindingConstraint: 'insufficient_real_fill_evidence' | 'pooled_bound_below_bar' | 'mixed' | null;
  statement: string;
}

export interface CostBarSleeveStandDownInput {
  /** Every estimator cell of the sleeve's published structure. */
  structureCells: readonly TapeExpectancyCell[];
  sleeve: string;
  /** The armed strike selector's band, or `null` when the selector is not armed. */
  armedBand: { min: number; max: number } | null;
  /** The TRA-4978 split, for the statement. */
  decidedByStaleInput: number;
  shortCircuitedUpstream: number;
}

/**
 * Roll the per-cell verdicts up to a sleeve verdict.
 *
 * ⚠️ SCOPED TO THE CELLS THE ARMED SELECTOR CAN ACTUALLY NOMINATE, for the same
 * reason TRA-4875 scoped its staleness verdict that way: on 2026-09-24 the
 * global staleness max read 78.1 d off `0.40-0.45`, a cell the armed band
 * `[0.25, 0.40)` can never reach, while the cells that actually refused the live
 * entry site sat at 52.3 d and 51.1 d. A roll-up over cells no decision depends
 * on is true for the wrong reason.
 *
 * ⚠️ OVERLAP, not containment. The bucket edges are not uniform — 0.05 wide and
 * 0.10 wide, plus `0.55-1.00` — so a band `[0.25, 0.40)` overlaps `0.20-0.30`
 * without containing it, and a containment test would drop the very cell that is
 * refusing 99% of the live flow.
 */
export function summarizeCostBarSleeveStandDown(
  input: CostBarSleeveStandDownInput,
): CostBarSleeveStandDown {
  const { structureCells, sleeve, armedBand, decidedByStaleInput, shortCircuitedUpstream } = input;
  const nominable =
    armedBand === null
      ? [...structureCells]
      : structureCells.filter((c) => c.deltaFrom < armedBand.max && c.deltaTo > armedBand.min);
  const tradeable = nominable.filter((c) => c.admits);
  const scope =
    armedBand === null
      ? 'every published cell of this structure (selector NOT armed, so no band narrows it)'
      : `cells overlapping the armed selector band |delta| [${armedBand.min}, ${armedBand.max})`;
  const bindingConstraint: CostBarSleeveStandDown['bindingConstraint'] =
    nominable.length === 0 || tradeable.length > 0
      ? null
      : nominable.every((c) => c.nRealFill < TAPE_EXPECTANCY_MIN_CELL_REAL_FILL_N)
        ? 'insufficient_real_fill_evidence'
        : nominable.every((c) => c.lowerCI95 === null || c.lowerCI95 < c.barR)
          ? 'pooled_bound_below_bar'
          : 'mixed';
  const verdict: CostBarSleeveStandDown['verdict'] =
    nominable.length === 0
      ? 'NOT_MEASURED'
      : tradeable.length === 0
        ? 'NOT_TRADEABLE'
        : 'TRADEABLE_CELL_PRESENT';
  const statement =
    verdict === 'NOT_MEASURED'
      ? 'NOT MEASURED — the estimator holds no cell this selector can nominate, so no tradeability '
        + 'verdict exists for this sleeve. Unknown is NOT tradeable.'
      : verdict === 'NOT_TRADEABLE'
        ? `⛔ SLEEVE STOOD DOWN — NOT TRADEABLE. None of the ${nominable.length} cell(s) the selector `
          + `can nominate (${nominable.map((c) => c.cellKey).join(', ')}) can admit a candidate under `
          + 'the deployed estimator. Every live candidate reaching this gate will be refused, so the '
          + 'refusal stream is the EXPECTED STEADY STATE — not a market observation, and not evidence '
          + 'the gate is discriminating. '
          + (decidedByStaleInput === 0
            ? 'The stale expectancy constant is currently deciding NOTHING: '
            : 'Mixed causes: ')
          + `${decidedByStaleInput} refusal(s) were decided by the stale constant and `
          + `${shortCircuitedUpstream} were refused upstream of it, before it was read.`
        : `${tradeable.length} of ${nominable.length} nominable cell(s) can admit `
          + `(${tradeable.map((c) => c.cellKey).join(', ')}), so the sleeve is NOT stood down.`;
  return {
    verdict,
    sleeve,
    scope,
    cellsConsidered: nominable.map((c) => c.cellKey),
    cellsTradeable: tradeable.map((c) => c.cellKey),
    bindingConstraint,
    statement,
  };
}

/* ------------------------------------------------------------------------- *
 * TRA-4978 — THE RECENCY ARM.
 *
 * `decisionsDecidedByStaleInput` above is folded over the RETAINED archive (30
 * ET days). That archive is append-only and has no backfill, so once a stale
 * constant has decided a single refusal, `staleInputGovernsAnyDecision` is TRUE
 * FOREVER — it cannot be cleared by any remedy, only by the row ageing out of
 * retention. An assertion that can never go green is an assertion that stops
 * being read, and it makes TRA-4978's own AC2 ("`tapeAgeDaysAtDecisionMax` must
 * be under `thresholdDays` for every cell that recorded a refusal") structurally
 * unsatisfiable: the cells that recorded those refusals recorded them in the
 * past, at ages that are now frozen in the archive.
 *
 * This is the TRA-3703 shape — an identity derived to EXPOSE a gap cannot grade
 * its own remedy, because it is an invariant and reads `breach` forever. The fix
 * is NOT to delete the lifetime counter (TRA-3660 §10: a consistency fix that
 * deletes the truthful surface is the failure, not the remedy). Both arms ship:
 * the lifetime one stays exactly as it was, and this one says WHEN.
 *
 * Measured live on `0d81630c` 2026-10-02T01:11Z, `retained.byGate[cost_bar]`
 * `byEtDay`, 17 ET days carrying refusals:
 *   2026-09-09 … 2026-09-24  →  100% `shortfall_*`                 (compared)
 *   2026-09-25 … 2026-10-01  →  100% `insufficient_real_fill_evidence`
 * A clean cutover on 2026-09-25 and FIVE consecutive sessions in which the
 * constant's age decided nothing, against a lifetime count of 7,179.
 *
 * ⚠️ The classifier is `TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES`, imported
 * from the DEPLOYED predicate rather than re-spelled as a `shortfall_` prefix
 * test. The prefix would be a second, drifting definition of the same split, and
 * `byEtDay` carries no `rowsCompared` column to check it against.
 *
 * ⚠️ `barRImplied` is NOT a usable discriminator here, which is why this folds
 * `byReason` instead. On 2026-09-25 two of three cells publish a non-null
 * `barRImplied` while 100% of that day's refusals are
 * `insufficient_real_fill_evidence`: the bound is derivable off the day's 178
 * ADMITTED rows (`excludesPublishedBarR: true`), not off a refusal the constant
 * decided.
 * ------------------------------------------------------------------------- */

/** One ET day's `cost_bar` refusals, as `retained.byGate[].byEtDay[]` publishes them. */
export interface CostBarEtDayReasonRow {
  etDay: string;
  blocked: number;
  byReason: readonly { reasonCode: string; blocked: number }[];
  /** Blocked rows carrying NO `reasonCode` — `byReason`'s missing denominator. */
  blockedUnclassified?: number;
}

/** WHEN the stale constant last decided anything, not merely WHETHER it ever did. */
export interface StaleCostBarRecency {
  /** ET days in the retained fold that recorded at least one refusal. */
  etDaysWithRefusals: number;
  /** The most recent such day, or null if the fold recorded no refusal at all. */
  latestEtDayWithRefusals: string | null;
  /** The most recent day on which the constant was COMPARED on a refusal. */
  latestEtDayDecidedByStaleInput: string | null;
  /**
   * Refusing sessions strictly AFTER {@link latestEtDayDecidedByStaleInput}.
   * `null` when the constant has never decided a refusal in the fold (there is
   * no "since" to count from) — never 0, which would read as "it decided one
   * today".
   */
  sessionsSinceStaleInputLastDecided: number | null;
  /**
   * ⭐ The arm to grade. THREE-VALUED on purpose:
   *   • `true`  — the constant decided >= 1 refusal on the latest refusing day.
   *   • `false` — that day's refusals were ALL refused upstream of it.
   *   • `null`  — NOT COMPUTABLE: the latest refusing day carries no classified
   *     row (all `blockedUnclassified`, e.g. a pre-stamp day). Unknown is not a
   *     clean bill, and coercing it to `false` would publish "the staleness is
   *     inert" off a day nobody measured.
   */
  staleInputGovernsLatestSession: boolean | null;
  /** Refusals on the latest refusing day the constant decided. */
  latestSessionDecidedByStaleInput: number;
  /** Refusals on that day refused by a precondition upstream of the constant. */
  latestSessionShortCircuitedUpstream: number;
  /** Refusals on that day carrying no `reasonCode` at all. */
  latestSessionUnclassified: number;
  statement: string;
}

/**
 * Fold the retained per-ET-day `cost_bar` reason census into the recency arm.
 *
 * Pure. Days with `blocked === 0` are skipped entirely — a session the gate
 * evaluated nothing on is silence, not evidence the constant stood down.
 */
export function foldStaleCostBarRecency(
  etDayRows: readonly CostBarEtDayReasonRow[],
): StaleCostBarRecency {
  const classify = (row: CostBarEtDayReasonRow) => {
    let decided = 0;
    let shortCircuited = 0;
    for (const r of row.byReason) {
      if (TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES.includes(r.reasonCode)) {
        shortCircuited += r.blocked;
      } else decided += r.blocked;
    }
    // Prefer the ledger's own unclassified column; fall back to the residual so
    // a fold that omits it still cannot silently drop rows.
    const unclassified = row.blockedUnclassified
      ?? Math.max(0, row.blocked - decided - shortCircuited);
    return { decided, shortCircuited, unclassified };
  };

  const refusing = etDayRows
    .filter((r) => r.blocked > 0)
    .slice()
    .sort((a, b) => a.etDay.localeCompare(b.etDay));

  if (refusing.length === 0) {
    return {
      etDaysWithRefusals: 0,
      latestEtDayWithRefusals: null,
      latestEtDayDecidedByStaleInput: null,
      sessionsSinceStaleInputLastDecided: null,
      staleInputGovernsLatestSession: null,
      latestSessionDecidedByStaleInput: 0,
      latestSessionShortCircuitedUpstream: 0,
      latestSessionUnclassified: 0,
      statement:
        'NOT MEASURED — the retained fold recorded no cost_bar refusal on any ET day, so there is '
        + 'no session in which to ask whether the stale constant decided anything.',
    };
  }

  const latest = refusing[refusing.length - 1] as CostBarEtDayReasonRow;
  const latestSplit = classify(latest);
  const decidedDays = refusing.filter((r) => classify(r).decided > 0);
  const lastDecidedDay = decidedDays.length === 0
    ? null
    : (decidedDays[decidedDays.length - 1] as CostBarEtDayReasonRow).etDay;
  const sessionsSince = lastDecidedDay === null
    ? null
    : refusing.filter((r) => r.etDay > lastDecidedDay).length;

  const governs = latestSplit.decided > 0
    ? true
    : latestSplit.shortCircuited > 0
      ? false
      : null;

  const statement =
    governs === true
      ? `⚠️ GOVERNING — on the latest refusing session (${latest.etDay}) the stale constant DECIDED `
        + `${latestSplit.decided} of ${latest.blocked} refusal(s). Refreshing the input would move `
        + 'live decisions.'
      : governs === false
        ? 'DORMANT — the stale constant has not decided a cost_bar refusal since '
          + `${lastDecidedDay ?? 'any recorded session'}`
          + (sessionsSince === null ? '' : ` (${sessionsSince} refusing session(s) ago)`)
          + `. On ${latest.etDay} all ${latestSplit.shortCircuited} refusal(s) were refused upstream `
          + 'of it. The input IS stale and the lifetime counter beside this one is CORRECT about the '
          + 'past; refreshing the tape today would move ZERO decisions. ⛔ Dormant is not clear — the '
          + 'constant resumes governing the moment the upstream arm admits.'
        : `NOT COMPUTABLE — the latest refusing session (${latest.etDay}) carries `
          + `${latestSplit.unclassified} refusal(s) with no reason code and none classified, so `
          + 'whether the stale constant decided them is UNKNOWN. Unknown is not a clean bill.';

  return {
    etDaysWithRefusals: refusing.length,
    latestEtDayWithRefusals: latest.etDay,
    latestEtDayDecidedByStaleInput: lastDecidedDay,
    sessionsSinceStaleInputLastDecided: sessionsSince,
    staleInputGovernsLatestSession: governs,
    latestSessionDecidedByStaleInput: latestSplit.decided,
    latestSessionShortCircuitedUpstream: latestSplit.shortCircuited,
    latestSessionUnclassified: latestSplit.unclassified,
    statement,
  };
}
