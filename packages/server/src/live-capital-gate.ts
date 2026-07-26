import { evaluateBookFeasibility, type ForwardTestReport } from './options-forward-test.js';
import { isOptionCostAwareGateEnabled, resolveCostGateConfig } from './option-cost-gate.js';
import type { FeasibilityResult } from './gate-feasibility.js';

// TRA-601 (TRA-595 C6) — the AI-Options-Ideas LIVE-CAPITAL GATE.
//
// The CTO's hard gate, codified: "Gate on evidence, not vibes." This module
// turns the forward-test report into an explicit pass/fail against documented,
// numeric criteria that MUST hold before live-capital wiring is even *proposed*.
//
// It is deliberately inert. Evaluating the gate wires nothing — there is no
// order path here and none is reachable from here. A `passed: true` result is
// the *permission to open the conversation* about live wiring, gated further by
// the existing per-strategy promotion gate (TRA-532) and human sign-off. Live
// auto-execution stays out of scope until this gate has passed on a real track
// record. The criteria live in code (the single source of truth) and are
// mirrored, with rationale, in `docs/live-capital-gate.md`.

export interface LiveCapitalGateCriteria {
  /** Minimum distinct ISO weeks that must carry ≥1 resolved (settled) idea. */
  minWeeksWithResolved: number;
  /** Minimum total resolved ideas — a sample-size floor against small-n noise. */
  minResolvedIdeas: number;
  /**
   * Required overall COST-NET R-expectancy (net P/L ÷ max-loss). Must be strictly
   * positive. TRA-678 (F1): the gate evaluates the cost-net figure, not the
   * optimistic pre-cost mid-to-mid R, so a marginal paper edge that costs eat
   * cannot clear the bar.
   */
  minExpectancyR: number;
  /** Minimum fraction of resolved-bearing weeks that show positive R-expectancy. */
  minPositiveWeekFraction: number;
  /** Max |hitRate − meanPOP| tolerated — the POP-calibration band. */
  maxPopCalibrationGap: number;
  /** Max tolerated realized max-loss breaches (defined-risk integrity). Default 0. */
  maxMaxLossBreaches: number;
}

/**
 * Shipped gate thresholds. These are the documented bar; changing the live-
 * capital stance is a one-line edit here (kept in sync with the doc). Chosen to
 * demand a *track record*, not a lucky week: ~2 months of weekly evidence, a
 * 30-idea sample floor, a positive risk-normalized edge that holds across most
 * weeks, a calibrated POP, and ZERO defined-risk integrity breaches.
 */
export const LIVE_CAPITAL_GATE: LiveCapitalGateCriteria = {
  minWeeksWithResolved: 8,
  minResolvedIdeas: 30,
  minExpectancyR: 0.0,
  minPositiveWeekFraction: 0.6,
  maxPopCalibrationGap: 0.1,
  maxMaxLossBreaches: 0,
};

/**
 * TRA-1600 (parent TRA-1599, deliverable B) — resolve the live-capital gate
 * criteria, applying the COST-AWARE raised expectancy bar when the cost-aware
 * gate flag is on.
 *
 * The shipped gate admits any cost-NET expectancy strictly `> 0` — the flat
 * "+0 gross" bar the TRA-1599 decomposition identified as the failure: on a
 * high-scratch, thin-edge options book a marginally-positive cost-net figure
 * still promotes a book whose per-idea net barely clears cost, with no buffer.
 * Deliverable (B) replaces that with `modeledGrossR >= costModel + safetyMargin`.
 * Because this gate already evaluates the cost-NET figure (net = gross − cost),
 * that inequality is exactly `expectancyNetR >= safetyMargin` — so the cost-aware
 * bar is applied here by lifting `minExpectancyR` from 0.0 to the configured
 * safety margin (default 0.20R, shared with the per-open cost-gate).
 *
 * OFF by default: with `ENABLE_OPTION_COST_AWARE_GATE` unset this returns the
 * shipped {@link LIVE_CAPITAL_GATE} byte-for-byte, so the gate's behaviour and
 * the `/api/health/live-capital-gate` readout are unchanged until an operator
 * opts in. The margin is env-tunable via `OPTION_COST_GATE_SAFETY_MARGIN_R`.
 */
export function resolveLiveCapitalGateCriteria(
  env: NodeJS.ProcessEnv = process.env,
): LiveCapitalGateCriteria {
  if (!isOptionCostAwareGateEnabled(env)) return LIVE_CAPITAL_GATE;
  const { safetyMarginR } = resolveCostGateConfig(env);
  return { ...LIVE_CAPITAL_GATE, minExpectancyR: safetyMarginR };
}

/**
 * TRA-2335 — the three states a criterion can be in.
 *
 * `FAIL` asserts a fact about the BOOK: it underperformed a bar it could have cleared.
 * `INFEASIBLE` asserts a fact about the EXPERIMENT: this bar cannot be tested with this
 * instrument, so no quantity of evidence can settle it. Collapsing the two is exactly
 * what let a bar 5.3× the book's arithmetic maximum grade it for four weeks — every
 * reader saw `FAIL` and concluded "keep accruing".
 *
 * ⚠️ `INFEASIBLE` is a LOUDER stop than `FAIL`, never a softer one, and must never read
 * as "pending". It carries `pass: false` (below) so it blocks promotion identically.
 */
export type GateCriterionStatus = 'PASS' | 'FAIL' | 'INFEASIBLE';

export interface GateCriterionResult {
  name: string;
  description: string;
  /** Threshold as a human string (e.g. "≥ 30"). */
  required: string;
  /** The measured value (null = not yet measurable, treated as fail). */
  actual: number | null;
  /**
   * ⚠️ TRA-2335 — `pass` KEEPS ITS EXACT PRIOR MEANING and stays the only thing
   * `passed` is computed from. An `INFEASIBLE` criterion is `pass: false`, so it blocks
   * promotion BY CONSTRUCTION rather than by every downstream consumer remembering to
   * handle a third state. Do not weaken this to `pass: status === 'PASS' || feasible`
   * or any variant that lets `INFEASIBLE` through — the whole point is that it is at
   * least as strict as `FAIL`.
   */
  pass: boolean;
  /** TRA-2335 — the richer disposition. `pass === (status === 'PASS')` always. */
  status: GateCriterionStatus;
  /** TRA-2335 — the bar (set on criteria carrying a feasibility precondition). */
  barR?: number;
  /** TRA-2335 — the payoff ceiling the bar was checked against; null when unknown. */
  ceilingR?: number | null;
  /** TRA-2335 — why the criterion is INFEASIBLE/unknown; names BOTH numbers (AC2). */
  feasibilityNote?: string;
}

export interface LiveCapitalGateResult {
  /** True iff EVERY criterion passes. */
  passed: boolean;
  asOfDate: string;
  criteria: GateCriterionResult[];
  /**
   * TRA-2335 — the payoff-ceiling precondition on `minExpectancyR`, surfaced whole so
   * the health route can publish the bar, the ceiling, and the reward-provenance the
   * ceiling was derived from. Read `verdict === 'infeasible'` as "this bar is
   * untestable with this instrument", NOT as "not yet".
   */
  feasibility: FeasibilityResult;
  /** One-line plain-English disposition. */
  summary: string;
  /** Standing reminder that a pass is permission-to-propose, not auto-wiring. */
  note: string;
}

const pct = (v: number | null): string => (v == null ? 'n/a' : `${Math.round(v * 100)}%`);

/**
 * Evaluate the live-capital gate against a forward-test report. Pure — given the
 * same report and criteria it always returns the same verdict, so it is fully
 * testable and the health probe can serve it without side effects.
 */
export function evaluateLiveCapitalGate(
  report: ForwardTestReport,
  criteria: LiveCapitalGateCriteria = LIVE_CAPITAL_GATE,
  opts: { useCalibratedPop?: boolean } = {},
): LiveCapitalGateResult {
  const t = report.totals;
  // TRA-678 (F1) — durability is measured on the COST-NET weekly edge.
  const positiveWeekFraction =
    t.weeksWithResolved > 0 ? t.weeksPositiveExpectancyNet / t.weeksWithResolved : null;
  // Calibration only meaningful once there's a hit-rate to compare against.
  // TRA-2006 — score the CALIBRATED gap when the calibration flag is on (caller
  // resolves the flag); OFF by default → the raw gap the gate has always scored,
  // byte-for-byte. The report surfaces both regardless.
  const useCalibratedPop = opts.useCalibratedPop === true;
  const calGap = useCalibratedPop ? t.popCalibrationGapCalibrated : t.popCalibrationGap;

  // TRA-2335 — the FEASIBILITY PRECONDITION, evaluated BEFORE the expectancy criterion
  // is graded (AC1). `minExpectancyR` is a bare R-constant; nothing here previously
  // asked whether the graded instrument can PRODUCE it. Since loss is pinned at −1R,
  // realized R is capped at maxProfit ÷ maxLoss pathwise, so a bar above that ceiling
  // is unreachable at a 100% hit rate. Computed by the SAME function the accumulation
  // monitor uses, so the health route and the weekly roll-up cannot disagree.
  const feasibility = evaluateBookFeasibility(report, criteria.minExpectancyR);

  // TRA-2335 — `pass` is computed ONCE and `status` is derived from it, so the two can
  // never drift apart for the criteria that have no feasibility precondition.
  const plain = (pass: boolean): GateCriterionStatus => (pass ? 'PASS' : 'FAIL');
  const weeksPass = t.weeksWithResolved >= criteria.minWeeksWithResolved;
  const samplePass = t.resolved >= criteria.minResolvedIdeas;
  const durabilityPass =
    positiveWeekFraction != null && positiveWeekFraction >= criteria.minPositiveWeekFraction;
  const calibrationPass = calGap != null && Math.abs(calGap) <= criteria.maxPopCalibrationGap;
  const integrityPass = t.maxLossBreaches <= criteria.maxMaxLossBreaches;

  // TRA-2335 — criterion 3, the defect site. The measured comparison is unchanged; what
  // is new is that an unreachable bar is reported as INFEASIBLE rather than as a FAIL
  // the book could have avoided. `pass` is false in BOTH cases (AC3), so promotion is
  // blocked identically and no existing consumer changes behaviour.
  const expectancyMeasuredPass =
    t.expectancyNetR != null && t.expectancyNetR > criteria.minExpectancyR;
  // ⚠️ Only a POSITIVE determination (`infeasible`) blocks — never `unknown`. `unknown`
  // means the ceiling could not be established (early book) or rests partly on
  // fabricated rewards; treating it as a stop would make the gate unpassable the moment
  // a single sketch-capped `long_call` entered the book, which is a NEW false negative,
  // not a fix. Note the two can never conflict: `expectancyNetR ≤ ceiling` holds
  // pathwise, so a measured pass is itself constructive proof of reachability.
  const barUnreachable = feasibility.verdict === 'infeasible';
  const expectancyStatus: GateCriterionStatus = barUnreachable
    ? 'INFEASIBLE'
    : plain(expectancyMeasuredPass);

  const criteriaResults: GateCriterionResult[] = [
    {
      name: 'weeks_of_evidence',
      description: 'Distinct weeks with ≥1 settled idea',
      required: `≥ ${criteria.minWeeksWithResolved}`,
      actual: t.weeksWithResolved,
      pass: weeksPass,
      status: plain(weeksPass),
    },
    {
      name: 'sample_size',
      description: 'Total resolved (settled) ideas',
      required: `≥ ${criteria.minResolvedIdeas}`,
      actual: t.resolved,
      pass: samplePass,
      status: plain(samplePass),
    },
    {
      name: 'positive_expectancy',
      description: 'Overall cost-NET risk-normalized expectancy (R = net P/L ÷ max-loss)',
      required: `> ${criteria.minExpectancyR}`,
      actual: t.expectancyNetR,
      // An INFEASIBLE bar can never be "met", so it is never a pass regardless of the
      // measured value — but the measured comparison still governs the feasible case.
      pass: !barUnreachable && expectancyMeasuredPass,
      status: expectancyStatus,
      barR: criteria.minExpectancyR,
      ceilingR: feasibility.ceilingR,
      feasibilityNote: feasibility.reason,
    },
    {
      name: 'expectancy_durability',
      description: 'Fraction of resolved-bearing weeks with positive cost-NET R-expectancy',
      required: `≥ ${pct(criteria.minPositiveWeekFraction)}`,
      actual: positiveWeekFraction == null ? null : Math.round(positiveWeekFraction * 100) / 100,
      pass: durabilityPass,
      status: plain(durabilityPass),
    },
    {
      name: 'pop_calibration',
      description: useCalibratedPop
        ? '|realized hit-rate − mean CALIBRATED POP| within band (TRA-2006)'
        : '|realized hit-rate − mean stated POP| within band',
      required: `≤ ${pct(criteria.maxPopCalibrationGap)}`,
      actual: calGap == null ? null : Math.abs(calGap),
      pass: calibrationPass,
      status: plain(calibrationPass),
    },
    {
      name: 'defined_risk_integrity',
      description: 'Realized losses that breached the stated defined-risk max',
      required: `≤ ${criteria.maxMaxLossBreaches}`,
      actual: t.maxLossBreaches,
      pass: integrityPass,
      status: plain(integrityPass),
    },
  ];

  const passed = criteriaResults.every((c) => c.pass);
  const failed = criteriaResults.filter((c) => !c.pass).map((c) => c.name);
  // TRA-2335 — an INFEASIBLE criterion gets its OWN headline. Folding it into the
  // "Unmet: …" list is precisely the collapse this ticket exists to undo: that list
  // reads as a to-do, and "keep accruing" is the wrong action when the bar is
  // untestable. AC2 — the summary names BOTH the bar and the ceiling.
  const infeasible = criteriaResults.filter((c) => c.status === 'INFEASIBLE');
  const summary = passed
    ? 'PASS — forward-test track record clears every documented criterion; live-capital wiring may now be PROPOSED (not auto-enabled).'
    : infeasible.length > 0
      ? `INFEASIBLE — live capital stays gated, and ${infeasible.length === 1 ? 'one criterion CANNOT BE TESTED' : `${infeasible.length} criteria CANNOT BE TESTED`} against this book: ${infeasible.map((c) => `${c.name} (bar ${c.barR}R vs payoff ceiling ${c.ceilingR == null ? 'unknown' : `${c.ceilingR}R`})`).join('; ')}. This is NOT a shortfall of evidence and MORE SAMPLE CANNOT RESOLVE IT — re-derive the bar or change the instrument.${failed.filter((n) => !infeasible.some((c) => c.name === n)).length > 0 ? ` Also unmet: ${failed.filter((n) => !infeasible.some((c) => c.name === n)).join(', ')}.` : ''}`
      : `HOLD — live capital stays gated. Unmet: ${failed.join(', ')}.`;

  return {
    passed,
    asOfDate: report.asOfDate,
    criteria: criteriaResults,
    feasibility,
    summary,
    note:
      'A passing gate is permission to PROPOSE live wiring to the board — it enables no orders. Live ' +
      'auto-execution remains out of scope and is further gated by the per-strategy promotion gate (TRA-532) ' +
      'and explicit human sign-off.',
  };
}
