// TRA-4745 — THE REALISED PREDICATE: the comparison the live `cost_bar` actually
// performed on one candidate, both sides' numbers, and the outcome.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
// `/api/health/live-enforce-gates` published, for `cost_bar`, a bar
// (`arm.costBar.bar.barR` = 0.385) and a full `costR` distribution per cell
// (`byCell[].costRQuantiles`). A reader who has only those two surfaces makes the
// obvious inference — the share blocked should be the share of the `costR`
// distribution above the bar — and on 2026-09-20 the CFO's weekly roll-up
// (TRA-4741, witness comment `47a32c11`) measured it against live retained data:
// it held on one cell (−1.7pp) and failed by up to **+98.0pp** on three others.
// The clincher was `single_leg_rv::0.55-1.00`: median `costR` 0.1645 — 57% BELOW
// a 0.385R bar — and 633 of 633 refused.
//
// That inference is FALSE, and nothing on the payload said so. The deployed flat
// form is `tapeExpectancyVerdict`, and its comparison is
//
//     admit  ⟺  lowerCI95(cell) ≥ barR          i.e.  grossR ≥ barR
//
// `costR` is a RECORDER (TRA-3483) — it is computed on every verdict and consulted
// by NOTHING on the flat branch. The two published numbers were the bar and the
// one quantity the bar is never compared against, so the surface invited exactly
// the wrong reading and then corroborated it on the one cell where the shapes
// happened to agree.
//
// Two further facts this module makes readable, both invisible before it:
//
//   • Every row inside a cell shares the SAME `grossR` AT ONE INSTANT (it is the
//     cell's lower CI bound, a property of the CELL, not of the candidate). So a
//     100.0% cell is the EXPECTED shape of a cell whose bound sits under the bar
//     — not evidence of a mis-attributed non-cost refusal.
//     ⚠️ That does NOT make a cell's DAILY block rate 0% or 100%. An earlier
//     revision of this comment said it did, and QuantTrader refuted it on the
//     live retained fold (2026-09-20): `single_leg_otm::0.50-0.55` pools to
//     39.12% (1627/4159). BOTH sides of the comparison re-resolve while a day is
//     running — the tape table re-folds, and `barR` comes from
//     `admissionBarR(structure, resolveCostGateConfig(process.env))`, which a
//     redeploy can move under the fold. Measured on that cell's own `byEtDay`
//     roll: 08-21/24/25 were 0%, 08-26 and 08-27 were 100%, **08-28 split
//     168/387 = 43.4%**, and 08-31/09-01 returned to 0%. The pooled 39.12% is a
//     TIME AVERAGE of six per-day verdicts plus one mid-session flip; it is not
//     a per-candidate spread, and reading it as one is the same class of mistake
//     as reading `costR` against the bar. Read `byEtDay[].byCell[]`.
//   • Three of the flat form's branches refuse BEFORE reaching any comparison
//     (`gross_unknown`, `band_deauthorized`, `insufficient_evidence`). Those rows
//     are stamped `cost_bar` and land in `byReason`, but no bar and no cost was
//     ever weighed. `compared: false` is the field that says so, and it is the
//     direct discriminator the witness asked for: a cell refusing 100% under
//     `compared: false` is neither "the cost is too high" nor "the edge
//     collapsed" — it is "we never measured this cell".
//
// PURE. No env, no I/O, no state. It describes a decision that has already been
// made; it can never change one.

import { COST_GATE_SHORTFALL_BUCKETS_R } from './option-cost-gate.js';
import type { NetEdgeBarVerdict } from './option-net-edge-bar.js';
import type { TapeExpectancyVerdict } from './option-tape-expectancy.js';

/** Which admission form produced the verdict this predicate describes. */
export type LiveEnforcePredicateForm = 'tape_expectancy_flat' | 'net_edge';

/**
 * One realised comparison — left side, operator, right side, outcome.
 *
 * Read `compared` FIRST. `false` means the gate refused on a precondition and
 * `lhs`/`rhs` are null: there was no inequality, so no bar move and no cost
 * retune can reach that row, and quoting it as a bar decision is the TRA-4745
 * mis-reading one layer down.
 */
export interface LiveEnforceGatePredicate {
  form: LiveEnforcePredicateForm;
  /**
   * TRUE ⇒ the gate evaluated the inequality below and `lhs`/`rhs` are the
   * numbers it used. FALSE ⇒ it short-circuited on a precondition (see
   * `shortCircuit`) and never compared anything.
   */
  compared: boolean;
  /** What the left side IS, in words — the field the payload was missing. */
  lhsLabel: string;
  /** The left side's realised value; null ⇔ `compared === false`. */
  lhs: number | null;
  op: '>=' | '<=';
  /** What the right side IS, in words. */
  rhsLabel: string;
  /** The right side's realised value; null ⇔ `compared === false`. */
  rhs: number | null;
  /** The outcome. `admit === false` with `compared === true` is a real bar refusal. */
  admit: boolean;
  /**
   * The precondition that fired, when `compared === false` — the verdict's own
   * `reasonCode`, never a re-derived label. Null when the comparison ran.
   */
  shortCircuit: string | null;
}

/**
 * The flat form's branches that refuse WITHOUT comparing the cell bound to the
 * bar. Exported so a test can assert the list is exactly the set of
 * `tapeExpectancyVerdict` returns that never reach `lower >= barR`, rather than
 * the list drifting silently as branches are added.
 *
 *   • `gross_unknown`         — the candidate's |delta| maps to no cell at all.
 *   • `band_deauthorized`     — refused by the ratified sleeve mandate (TRA-3394),
 *                               which is upstream of every bar-derived number.
 *   • `insufficient_evidence` — the cell holds n < minCellN, so there is no
 *                               lower bound to compare. "We never measured" is
 *                               NOT "we measured a loser" (TRA-3388 Ruling 2.5).
 */
export const TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES: readonly string[] = [
  'gross_unknown',
  'band_deauthorized',
  'insufficient_evidence',
];

/**
 * The net-edge form's branches that refuse WITHOUT reaching the `k`-ratio.
 * `net_edge_abs_ceiling` is deliberately NOT here: it IS a comparison, just a
 * different one (`costFracOfPremium ≤ absCostFracCeiling`), and it is reported
 * as that comparison rather than flattened into the ratio it never ran.
 */
export const NET_EDGE_PRE_COMPARISON_REASON_CODES: readonly string[] = [
  'net_edge_quote_unusable',
  'net_edge_edge_unknown',
];

function finite(n: number | null | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * TRA-4745 — RE-EVALUATE the published inequality from the published numbers.
 *
 * Returns whether `lhs op rhs` HOLDS, or null when nothing was compared.
 *
 * ⚠️ This is deliberately derived from the three PUBLISHED fields rather than
 * read off `admit`. That is the whole point: it lets a reader ask whether the
 * comparison the payload SHOWS is the one that produced the outcome the payload
 * RECORDS. See {@link predicateOutcomeConsistent}.
 */
export function predicateHolds(p: LiveEnforceGatePredicate): boolean | null {
  if (!p.compared || p.lhs === null || p.rhs === null) return null;
  return p.op === '>=' ? p.lhs >= p.rhs : p.lhs <= p.rhs;
}

/**
 * ⭐ TRA-4745 — does the published comparison EXPLAIN the RECORDED outcome?
 *
 * `blockedOnTheRow` is the LEDGER's own outcome for that row ("what the deployed
 * form actually did"), NOT the predicate's `admit`. Comparing against `admit`
 * would only ask whether one verdict object is internally coherent; comparing
 * against the recorded block is what tests whether the comparison on display is
 * the thing that refused the candidate.
 *
 * The flat form admits exactly when its inequality holds, so on a compared row
 * `holds === !blocked` is an INVARIANT. A row where it fails was refused (or let
 * through) by something other than the comparison the payload displays — which
 * is reading **(A)**, "a non-cost refusal is being stamped `cost_bar`", caught
 * per row rather than inferred from an aggregate block rate.
 *
 * Null when no comparison ran (`compared: false`): a short-circuited row has no
 * inequality to be consistent OR inconsistent with, and scoring it either way
 * would manufacture a verdict about the precise rows this axis cannot see.
 *
 * ⛔ A `false` here is NOT "the gate is broken". It is "the displayed predicate
 * is not the operative one", and the remedy is in the gate's attribution, not in
 * the bar. Grade it against `rowsCompared` — 0 of 0 consistent is silence, not
 * health.
 */
export function predicateOutcomeConsistent(
  p: LiveEnforceGatePredicate,
  blockedOnTheRow: boolean,
): boolean | null {
  const holds = predicateHolds(p);
  return holds === null ? null : holds === !blockedOnTheRow;
}

/**
 * The realised predicate behind one {@link TapeExpectancyVerdict} — the DEPLOYED
 * flat form, and therefore the one every live `cost_bar` row on bqb1 was decided
 * by today.
 */
export function tapeExpectancyFlatPredicate(verdict: TapeExpectancyVerdict): LiveEnforceGatePredicate {
  const code = verdict.reasonCode ?? null;
  const shortCircuited =
    code !== null && TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES.includes(code);
  // Belt and braces: a branch that somehow reports a comparison code with no
  // bound is still published as NOT compared rather than as a comparison against
  // `null`. The failure this ticket fixes is a surface that lets a reader infer
  // a comparison that did not happen.
  const lhs = shortCircuited ? null : finite(verdict.lowerCI95);
  const compared = !shortCircuited && lhs !== null;
  return {
    form: 'tape_expectancy_flat',
    compared,
    lhsLabel: 'grossR — the cell\'s LOWER 95% CI bound of realized R_gate (tapeEdgeR)',
    lhs: compared ? lhs : null,
    op: '>=',
    rhsLabel: 'barR — admissionBarR(structure) = max(costModel + safetyMargin, minGrossR)',
    rhs: compared ? finite(verdict.barR) : null,
    admit: verdict.admit,
    shortCircuit: compared ? null : (code ?? 'no_comparison'),
  };
}

/**
 * The realised predicate behind one {@link NetEdgeBarVerdict}. Inert on bqb1
 * today (`OPTION_NET_EDGE_*` is off), but recorded on the same axis so arming it
 * cannot silently change what the published predicate means.
 */
export function netEdgeFormPredicate(
  verdict: NetEdgeBarVerdict,
  modeledGrossR: number,
  config: { k: number; absCostFracCeiling: number },
): LiveEnforceGatePredicate {
  const code = verdict.reasonCode ?? null;
  if (code !== null && NET_EDGE_PRE_COMPARISON_REASON_CODES.includes(code)) {
    return {
      form: 'net_edge',
      compared: false,
      lhsLabel: 'costR — round-trip cost in the trade\'s own R',
      lhs: null,
      op: '<=',
      rhsLabel: `k × grossR (k = ${config.k})`,
      rhs: null,
      admit: verdict.admit,
      shortCircuit: code,
    };
  }
  if (code === 'net_edge_abs_ceiling') {
    // The k-INDEPENDENT ceiling decided. Publishing the ratio here would name a
    // comparison the form never ran at this candidate.
    const lhs = finite(verdict.costFracOfPremium);
    return {
      form: 'net_edge',
      compared: lhs !== null,
      lhsLabel: 'costFracOfPremium — round-trip cost / premium',
      lhs,
      op: '<=',
      rhsLabel: 'absCostFracCeiling — the k-independent absolute ceiling',
      rhs: lhs === null ? null : config.absCostFracCeiling,
      admit: verdict.admit,
      shortCircuit: lhs === null ? code : null,
    };
  }
  const lhs = finite(verdict.costR);
  const gross = finite(modeledGrossR);
  const compared = lhs !== null && gross !== null;
  return {
    form: 'net_edge',
    compared,
    lhsLabel: 'costR — round-trip cost in the trade\'s own R',
    lhs: compared ? lhs : null,
    op: '<=',
    rhsLabel: `k × grossR (k = ${config.k}, grossR = the cell's lower 95% CI bound)`,
    rhs: compared ? config.k * gross! : null,
    admit: verdict.admit,
    shortCircuit: compared ? null : (code ?? 'no_comparison'),
  };
}

// ── TRA-4745 (2026-09-20 follow-up) — THE BAR AS APPLIED, RECOVERED FROM ROWS
//    THE LEDGER ALREADY HOLDS ─────────────────────────────────────────────────
//
// `predicate` (above) stamps the realised comparison at the decision site, which
// is the right instrument — but it can only ever describe rows written AFTER the
// deploy that added it. On the 30-day retained fold that is 0 of 9558 rows, and
// the first stamped row cannot arrive before the next RTH nomination. So the one
// question this ticket exists to answer — *was the published `barR` the bar that
// actually blocked these rows?* — is unanswerable from the stamp for a month.
//
// It is answerable TODAY, from rows recorded since TRA-3483, because `reasonCode`
// already carries a BOUNDED FUNCTION of the bar. The flat form buckets its blocks
// by `shortfall = barR − grossR` into half-open intervals, and `grossR` is
// recorded beside it on the same row. Inverting one row therefore bounds the bar:
//
//     reasonCode `shortfall_0.25_0.50`  ∧  grossR −0.051  ⇒  barR ∈ [0.199, 0.449)
//
// Intersecting those intervals over a (day × cell) group gives a hard two-sided
// bound on the bar AS APPLIED, over the whole retained census, with no new stamp.
// ADMITS bound it from the other side for free: `admit ⟺ grossR ≥ barR` means
// every admitted row proves `barR ≤ grossR`.
//
// ⚠️ Read `consistent` FIRST. An EMPTY intersection is a RESULT, not a bug: it
// says no single bar can explain that group's own rows, i.e. the bar MOVED while
// the group was accumulating. That is the finding, and nothing else on the
// payload can produce it — `arm.costBar.bar.barR` publishes today's scalar beside
// a 30-day fold, which is precisely the join this ticket was filed about.
//
// ⚠️ `rowsUnusable` is not noise. The three pre-comparison branches
// ({@link TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES}) refuse before any
// inequality runs, so they constrain the bar NOT AT ALL — folding them in would
// manufacture a bound from rows that never met a bar. A group at
// `rowsUsable: 0` bounds nothing and publishes `null`, never a default.

/** One already-recorded decision, as the inversion needs to see it. */
export interface ImpliedBarRRow {
  /** The cell's lower 95% CI bound as recorded AT THE DECISION (`tapeEdgeR`). */
  grossR: number | null;
  blocked: boolean;
  reasonCode: string | null;
}

/**
 * A two-sided bound on `barR` as applied, recovered from a group of rows.
 *
 * Bounds are reported INCLUSIVE on both ends. The underlying shortfall buckets
 * are half-open, so `upperBound` overstates by at most one ULP at a bucket edge;
 * that slack is deliberate and is always in the direction that makes the interval
 * WIDER, so an `excludesPublishedBarR: true` is never an artefact of it.
 */
export interface ImpliedBarR {
  /** `barR >= lowerBound`. Null when no row constrained it from below. */
  lowerBound: number | null;
  /** `barR <= upperBound`. Null when no row constrained it from above. */
  upperBound: number | null;
  /** Blocked rows whose `reasonCode` inverted to an interval. */
  rowsBlockedUsed: number;
  /** Admitted rows, each proving `barR <= grossR`. */
  rowsAdmittedUsed: number;
  /**
   * Rows that constrain nothing: no recorded `grossR`, or a blocked row on a
   * pre-comparison branch, or an unrecognised `reasonCode`. COVERAGE, not zero.
   */
  rowsUnusable: number;
  /**
   * `lowerBound <= upperBound`. FALSE ⇒ the group's own rows cannot all have
   * faced one bar ⇒ the bar MOVED inside the group. Read this before the bounds.
   */
  consistent: boolean;
  /** The bar this route publishes today, echoed so the reader performs no join. */
  publishedBarR: number | null;
  /**
   * `true` ⇒ the published bar lies OUTSIDE the recovered interval: the rows in
   * this group were NOT decided against the bar the payload advertises. `null`
   * when there is no published bar to grade, or when `consistent` is false (an
   * empty interval excludes everything and would read as a false positive).
   */
  excludesPublishedBarR: boolean | null;
}

/** Bucket edges, derived from the SAME constant the classifier buckets with, so a
 *  retune of the vocabulary cannot leave this inversion decoding a stale label. */
function shortfallInterval(reasonCode: string): readonly [number, number] | null {
  const edges = COST_GATE_SHORTFALL_BUCKETS_R;
  if (edges.length < 3) return null;
  const [near, mid, far] = edges as unknown as [number, number, number];
  if (reasonCode === `shortfall_lt_${near.toFixed(2)}`) return [0, near];
  if (reasonCode === `shortfall_${near.toFixed(2)}_${mid.toFixed(2)}`) return [near, mid];
  if (reasonCode === `shortfall_${mid.toFixed(2)}_${far.toFixed(2)}`) return [mid, far];
  if (reasonCode === `shortfall_gte_${far.toFixed(2)}`) return [far, Number.POSITIVE_INFINITY];
  return null;
}

/**
 * Recover the bar that a group of already-recorded flat-form decisions was
 * actually measured against. PURE; reads nothing but the rows handed to it.
 */
export function impliedBarR(
  rows: readonly ImpliedBarRRow[],
  publishedBarR: number | null = null,
): ImpliedBarR | null {
  let lower: number | null = null;
  let upper: number | null = null;
  let rowsBlockedUsed = 0;
  let rowsAdmittedUsed = 0;
  let rowsUnusable = 0;

  for (const row of rows) {
    const gross = finite(row.grossR);
    if (gross === null) {
      rowsUnusable += 1;
      continue;
    }
    if (!row.blocked) {
      // `admit ⟺ grossR >= barR` ⇒ this row proves `barR <= grossR`.
      rowsAdmittedUsed += 1;
      upper = upper === null ? gross : Math.min(upper, gross);
      continue;
    }
    const code = row.reasonCode;
    if (code === null || TAPE_EXPECTANCY_PRE_COMPARISON_REASON_CODES.includes(code)) {
      rowsUnusable += 1;
      continue;
    }
    if (code === 'gross_negative') {
      // The mean-negative override fires INSTEAD of a shortfall bucket, so it
      // carries no width — all it proves is that the block branch was reached.
      rowsBlockedUsed += 1;
      lower = lower === null ? gross : Math.max(lower, gross);
      continue;
    }
    const interval = shortfallInterval(code);
    if (interval === null) {
      rowsUnusable += 1;
      continue;
    }
    rowsBlockedUsed += 1;
    const lo = gross + interval[0];
    lower = lower === null ? lo : Math.max(lower, lo);
    if (Number.isFinite(interval[1])) {
      const hi = gross + interval[1];
      upper = upper === null ? hi : Math.min(upper, hi);
    }
  }

  if (rowsBlockedUsed === 0 && rowsAdmittedUsed === 0) return null;

  const EPS = 1e-9;
  const consistent = lower === null || upper === null || lower <= upper + EPS;
  const bar = finite(publishedBarR);
  const excludes =
    bar === null || !consistent
      ? null
      : (lower !== null && bar < lower - EPS) || (upper !== null && bar > upper + EPS);

  return {
    lowerBound: lower === null ? null : round6(lower),
    upperBound: upper === null ? null : round6(upper),
    rowsBlockedUsed,
    rowsAdmittedUsed,
    rowsUnusable,
    consistent,
    publishedBarR: bar,
    excludesPublishedBarR: excludes,
  };
}

function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}
