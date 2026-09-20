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
//   • Every row inside a cell shares the SAME `grossR` (the cell's lower CI
//     bound). So within one cell on one day the flat predicate is CONSTANT: the
//     block rate is 0% or 100%, never in between. A 100.0% cell is therefore the
//     EXPECTED shape of a cell whose bound sits under the bar — not evidence of a
//     mis-attributed non-cost refusal.
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
