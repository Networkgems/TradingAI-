import type { ForwardTestReport } from './options-forward-test.js';
import { isOptionCostAwareGateEnabled, resolveCostGateConfig } from './option-cost-gate.js';

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

export interface GateCriterionResult {
  name: string;
  description: string;
  /** Threshold as a human string (e.g. "≥ 30"). */
  required: string;
  /** The measured value (null = not yet measurable, treated as fail). */
  actual: number | null;
  pass: boolean;
}

export interface LiveCapitalGateResult {
  /** True iff EVERY criterion passes. */
  passed: boolean;
  asOfDate: string;
  criteria: GateCriterionResult[];
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
): LiveCapitalGateResult {
  const t = report.totals;
  // TRA-678 (F1) — durability is measured on the COST-NET weekly edge.
  const positiveWeekFraction =
    t.weeksWithResolved > 0 ? t.weeksPositiveExpectancyNet / t.weeksWithResolved : null;
  // Calibration only meaningful once there's a hit-rate to compare against.
  const calGap = t.popCalibrationGap;

  const criteriaResults: GateCriterionResult[] = [
    {
      name: 'weeks_of_evidence',
      description: 'Distinct weeks with ≥1 settled idea',
      required: `≥ ${criteria.minWeeksWithResolved}`,
      actual: t.weeksWithResolved,
      pass: t.weeksWithResolved >= criteria.minWeeksWithResolved,
    },
    {
      name: 'sample_size',
      description: 'Total resolved (settled) ideas',
      required: `≥ ${criteria.minResolvedIdeas}`,
      actual: t.resolved,
      pass: t.resolved >= criteria.minResolvedIdeas,
    },
    {
      name: 'positive_expectancy',
      description: 'Overall cost-NET risk-normalized expectancy (R = net P/L ÷ max-loss)',
      required: `> ${criteria.minExpectancyR}`,
      actual: t.expectancyNetR,
      pass: t.expectancyNetR != null && t.expectancyNetR > criteria.minExpectancyR,
    },
    {
      name: 'expectancy_durability',
      description: 'Fraction of resolved-bearing weeks with positive cost-NET R-expectancy',
      required: `≥ ${pct(criteria.minPositiveWeekFraction)}`,
      actual: positiveWeekFraction == null ? null : Math.round(positiveWeekFraction * 100) / 100,
      pass: positiveWeekFraction != null && positiveWeekFraction >= criteria.minPositiveWeekFraction,
    },
    {
      name: 'pop_calibration',
      description: '|realized hit-rate − mean stated POP| within band',
      required: `≤ ${pct(criteria.maxPopCalibrationGap)}`,
      actual: calGap == null ? null : Math.abs(calGap),
      pass: calGap != null && Math.abs(calGap) <= criteria.maxPopCalibrationGap,
    },
    {
      name: 'defined_risk_integrity',
      description: 'Realized losses that breached the stated defined-risk max',
      required: `≤ ${criteria.maxMaxLossBreaches}`,
      actual: t.maxLossBreaches,
      pass: t.maxLossBreaches <= criteria.maxMaxLossBreaches,
    },
  ];

  const passed = criteriaResults.every((c) => c.pass);
  const failed = criteriaResults.filter((c) => !c.pass).map((c) => c.name);
  const summary = passed
    ? 'PASS — forward-test track record clears every documented criterion; live-capital wiring may now be PROPOSED (not auto-enabled).'
    : `HOLD — live capital stays gated. Unmet: ${failed.join(', ')}.`;

  return {
    passed,
    asOfDate: report.asOfDate,
    criteria: criteriaResults,
    summary,
    note:
      'A passing gate is permission to PROPOSE live wiring to the board — it enables no orders. Live ' +
      'auto-execution remains out of scope and is further gated by the per-strategy promotion gate (TRA-532) ' +
      'and explicit human sign-off.',
  };
}
