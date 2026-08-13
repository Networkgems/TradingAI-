import {
  evaluateBookFeasibility,
  evaluateBookSleeveFeasibility,
  type BookSleeveFeasibility,
  type ForwardTestReport,
} from './options-forward-test.js';
import { isOptionCostAwareGateEnabled, resolveCostGateConfig } from './option-cost-gate.js';
import type { FeasibilityResult } from './gate-feasibility.js';
// TRA-3368 (TRA-2346) — the power-based detectability criterion that replaces the raw
// 30-idea floor as the gate's theory of "enough sample". Constants + math live there.
import {
  evaluateGatePower,
  POWER_CONFIDENCE_SIGMA,
  TARGET_EFFECT_R,
  type GatePowerResult,
} from './gate-power.js';

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
  /**
   * The surviving hard SAMPLE FLOOR. TRA-3368 (TRA-2346): this is no longer the whole
   * sample criterion — `sample_size` is graded on the power-based requirement
   * `n_req = max(minResolvedIdeas, ceil((2σ/δ)²))` (see `gate-power.ts`), of which this
   * constant is the floor term. It survives deliberately: strictly monotone on the
   * sample axis, and the hard bar when the computed requirement degenerates.
   */
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
 *
 * TRA-3368 (TRA-2346) — the FOURTH state, `UNDERPOWERED`, asserts a third distinct
 * fact: the SAMPLE cannot resolve the question. Its remedy points the OPPOSITE way
 * from `INFEASIBLE`'s — more sample is the ONLY remedy — so folding it into either
 * neighbour prints an actively misdirecting instruction:
 *   • as `FAIL` it reads "the book underperformed a bar it could have cleared" on a
 *     sample that resolves nothing;
 *   • as `INFEASIBLE` it reads "MORE SAMPLE CANNOT RESOLVE IT", the exact inverse.
 * It attaches to BOTH `sample_size` and `positive_expectancy`, pre-empting `FAIL` AND
 * `PASS` (a mean clearing the bar on an unpowered sample is a coin flip, not evidence).
 * Precedence: `INFEASIBLE` > `UNDERPOWERED` > `FAIL`/`PASS`. `pass: false` always.
 */
export type GateCriterionStatus = 'PASS' | 'FAIL' | 'INFEASIBLE' | 'UNDERPOWERED';

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
  /**
   * TRA-2353 — the SAME ceiling, partitioned by sleeve, with the composition-fragility
   * sweep beside it.
   *
   * ⚠️ TRA-2361 — THIS BLOCK IS NO LONGER PURELY ADDITIVE. It used to say "`passed` and
   * every `pass` are byte-identical with or without this block"; that sentence was true
   * of TRA-2353 and went false the instant R1 landed. A sleeve with `blocking: true` makes
   * `positive_expectancy` INFEASIBLE and therefore `passed: false`. Read
   * `byStructure.blockingSleeves` / `byPremiumDirection.blockingSleeves` — non-empty on
   * EITHER axis is a stop.
   *
   * ⚠️ {@link feasibility} is the BOOK-level verdict and it still means exactly what it
   * meant: it is not the whole of what blocks. On 2026-07-26 the two disagreed about 74%
   * of the graded book, which is the reason R1 exists.
   */
  sleeveFeasibility: BookSleeveFeasibility;
  /**
   * TRA-3368 (TRA-2346) — the power criterion's full verdict: pooled + per-sleeve
   * `{σ used, σ source, n required, powered}` and `forcedBy` naming WHICH conjunct or
   * sleeve forced an unpowered read. Published whole on
   * `/api/health/live-capital-gate` as `power`.
   */
  power: GatePowerResult;
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

  // TRA-2353 — the same ceiling, per sleeve. The book bound is correct on any mix, but on
  // a MIXED book it averages an infeasible sleeve into a `feasible` verdict: measured
  // live 2026-07-26, the book read `feasible` (cost-net ceiling 0.2391R vs a 0.20R bar)
  // while the 35-idea credit sleeve inside it sat at ≈0.00R and could not reach the bar
  // at a REALIZED 100% hit rate.
  // ⚠️ TRA-2361 — this line used to end "Additive only — nothing below folds this into
  // `pass`." It does now: see `sleeveBlocking` below (rule R1).
  const sleeveFeasibility = evaluateBookSleeveFeasibility(
    report,
    criteria.minExpectancyR,
    feasibility.verdict,
  );

  // TRA-3368 (TRA-2346) — the POWER criterion, replacing the raw `resolved >= 30` read.
  // `powered` is the conjunct `pooled ∧ every ≥20%-weight sleeve at its own c`, computed
  // from observations the report derived over the SAME graded set as every total above.
  // Absent inputs (legacy report) grade UNDERPOWERED — fail-closed, because the change
  // is ratified monotone non-increasing and a degraded read must close, never open.
  // Note `powered ⇒ resolved ≥ minResolvedIdeas` by construction (the floor survives
  // inside `n_req = max(minResolvedIdeas, ceil((2σ/δ)²))`), so the old floor read is
  // strictly implied and `pass′ ≤ pass` holds on the sample criterion pointwise.
  const power = evaluateGatePower(t.powerInputs, {
    floor: criteria.minResolvedIdeas,
    nObserved: t.resolved,
  });
  // The sentence a reader lands on when either criterion reads UNDERPOWERED. Names the
  // forcing conjunct/sleeve, and states the remedy in the direction OPPOSITE to
  // INFEASIBLE's: more sample is the ONLY remedy here.
  const underpoweredNote = power.powered
    ? null
    : `⚠️ UNDERPOWERED (TRA-2346) — at δ = ${TARGET_EFFECT_R}R and ${POWER_CONFIDENCE_SIGMA}σ the graded sample cannot resolve the expectancy bar: required n ≥ ${power.nRequired ?? `uncomputable (σ degenerate: source ${power.sigmaSource}, σ̂ ${power.sigmaUsed ?? 'null'})`}, observed ${power.nObserved}. Forced by: ${power.forcedBy.join(', ')}. A PASS or FAIL read off this sample is a coin flip; MORE SAMPLE IS THE ONLY REMEDY — the bar itself stays as written.`;

  // TRA-2335 — `pass` is computed ONCE and `status` is derived from it, so the two can
  // never drift apart for the criteria that have no feasibility precondition.
  const plain = (pass: boolean): GateCriterionStatus => (pass ? 'PASS' : 'FAIL');
  const weeksPass = t.weeksWithResolved >= criteria.minWeeksWithResolved;
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

  // TRA-2361 — rule R1, pre-registered by QuantTrader on TRA-2353 before the first
  // per-sleeve read (verbatim in `gate-feasibility.ts` on BLOCKING_SLEEVE_WEIGHT and in
  // `docs/live-capital-gate.md`). A sleeve blocks iff it is POSITIVELY `infeasible` AND
  // carries ≥ 20% of the graded book; the gate blocks iff ≥1 sleeve blocks on EITHER axis.
  //
  // Why this is a stop and not a warning: the book ceiling is a MEAN over a mixed
  // population, and a mean can satisfy a bound that no material sub-population satisfies.
  // Live 2026-07-26 the book read `feasible` (net 0.2391R vs the 0.20R bar) while the
  // 35-idea credit sleeve inside it — 74% of the graded rows — sat at ≈0.00R at a
  // REALIZED 100% hit rate. Promoting on that number promotes on 26% of the evidence.
  //
  // ⚠️ Read off `blockingSleeves`, which is a derived projection of the per-sleeve
  // `blocking` flags — never a second predicate evaluated here.
  const sleeveBlocking =
    sleeveFeasibility.byStructure.blockingSleeves.length > 0 ||
    sleeveFeasibility.byPremiumDirection.blockingSleeves.length > 0;
  // The offenders themselves, heaviest first, for the headline. The same sleeve key can
  // appear on both axes (`credit` coarsens `bull_put_spread`); the axis label is carried
  // so a reader can tell which partition is talking.
  const blockingSleeveDetail = [
    ...sleeveFeasibility.byStructure.sleeves
      .filter((s) => s.blocking)
      .map((s) => ({ axis: sleeveFeasibility.byStructure.axis, s })),
    ...sleeveFeasibility.byPremiumDirection.sleeves
      .filter((s) => s.blocking)
      .map((s) => ({ axis: sleeveFeasibility.byPremiumDirection.axis, s })),
  ].sort((a, b) => (b.s.weight ?? 0) - (a.s.weight ?? 0) || a.s.key.localeCompare(b.s.key));

  // A sleeve block is the SAME KIND of stop as an unreachable book bar — more sample
  // cannot resolve either — so it reuses the loud `INFEASIBLE` headline path.
  //
  // TRA-3368 — precedence `INFEASIBLE` > `UNDERPOWERED` > `FAIL`/`PASS`: when the bar is
  // unreachable, accruing the required sample resolves nothing, so INFEASIBLE (whose
  // headline says exactly that) must win over a status whose remedy is "accrue more".
  // Below it, UNDERPOWERED pre-empts BOTH plain verdicts — a FAIL here would assert the
  // book underperformed a bar it could have cleared, and a PASS would promote on a
  // coin flip; neither is a fact this sample can carry.
  const expectancyStatus: GateCriterionStatus =
    barUnreachable || sleeveBlocking
      ? 'INFEASIBLE'
      : !power.powered
        ? 'UNDERPOWERED'
        : plain(expectancyMeasuredPass);

  /**
   * The clause the headline prints for an INFEASIBLE criterion.
   *
   * ⚠️ The book pair `(bar XR vs payoff ceiling YR)` is the ONLY thing this used to print,
   * and on a sleeve-driven block it CONTRADICTS ITSELF: live today it would render
   * `bar 0.2R vs payoff ceiling 0.2391R` — a headline saying the criterion cannot be
   * tested, beside two numbers saying the bar is comfortably reachable. The binding
   * constraint has to be the thing that gets named.
   */
  const infeasibleClause = (c: GateCriterionResult): string => {
    const bookPair = `bar ${c.barR}R vs payoff ceiling ${c.ceilingR == null ? 'unknown' : `${c.ceilingR}R`}`;
    if (c.name !== 'positive_expectancy' || blockingSleeveDetail.length === 0) {
      return `${c.name} (${bookPair})`;
    }
    const offenders = blockingSleeveDetail
      .map(
        ({ axis, s }) =>
          `\`${s.key}\` [${axis}] n=${s.n}, ${pct(s.weight)} of the graded book, cost-net payoff ceiling ${s.ceilingNetR == null ? 'unknown' : `${s.ceilingNetR}R`}`,
      )
      .join('; ');
    const blocked = `BLOCKED BY ${blockingSleeveDetail.length === 1 ? 'SLEEVE' : 'SLEEVES'} ${offenders} — against the ${c.barR}R bar, unreachable at ANY hit rate`;
    return barUnreachable
      ? `${c.name} (${bookPair}; AND ${blocked})`
      : `${c.name} (${blocked}. The BOOK aggregate reads ${bookPair} and is NOT the binding constraint: a mean over a mixed book can satisfy a bar that no material sleeve inside it can reach)`;
  };

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
      // TRA-3368 — no longer the raw 30-idea floor: the requirement is the power-based
      // n_req = max(minResolvedIdeas, ceil((2σ/δ)²)), σ = max(σ̂_{n−1}, σ_param(c)),
      // conjoined pooled ∧ every ≥20%-weight sleeve at its own c (both axes).
      description:
        'Total resolved (settled) ideas vs the power-required sample (TRA-2346: n_req = max(30, ceil((2σ/δ)²)), pooled AND every ≥20% sleeve)',
      required:
        power.nRequired == null
          ? `≥ max(${criteria.minResolvedIdeas}, (2σ/δ)²) — n_req uncomputable (σ degenerate)`
          : `≥ ${power.nRequired}${power.forcedBy.some((f) => f !== 'pooled') ? ' (pooled) + per-sleeve requirements' : ''}`,
      actual: t.resolved,
      // `powered` subsumes the old floor read: n_req ≥ minResolvedIdeas by construction,
      // so `pass` here is monotone non-increasing vs the pre-TRA-3368 criterion.
      pass: power.powered,
      // UNDERPOWERED pre-empts FAIL: "too few ideas" was a fact about a constant; "the
      // sample cannot resolve the effect" is the fact the criterion exists to state.
      status: power.powered ? 'PASS' : 'UNDERPOWERED',
      ...(underpoweredNote == null ? {} : { feasibilityNote: underpoweredNote }),
    },
    {
      name: 'positive_expectancy',
      description: 'Overall cost-NET risk-normalized expectancy (R = net P/L ÷ max-loss)',
      required: `> ${criteria.minExpectancyR}`,
      actual: t.expectancyNetR,
      // An INFEASIBLE bar can never be "met", so it is never a pass regardless of the
      // measured value — but the measured comparison still governs the feasible case.
      // TRA-2361 — `!sleeveBlocking` is a NEW CONJUNCT on an existing conjunction, which
      // is monotone non-increasing: `pass′ ≤ pass` and therefore `passed′ ≤ passed`. This
      // can only ever CLOSE the capital path, never open one.
      // TRA-3368 — `power.powered` is the SAME move again: a new conjunct, monotone
      // non-increasing, pre-empting PASS because a mean clearing the bar on an
      // unpowered sample is a coin flip, not evidence.
      pass: !barUnreachable && !sleeveBlocking && power.powered && expectancyMeasuredPass,
      status: expectancyStatus,
      barR: criteria.minExpectancyR,
      // ⚠️ Still the BOOK ceiling — the number the book verdict was derived from. On a
      // sleeve-driven block it is NOT the binding constraint, which is why the note below
      // and the headline both lead with the sleeve. (Deliberately not overwritten with the
      // sleeve's ceiling: `ceilingR` has meant "the ceiling `feasibility` compared against"
      // since TRA-2335 and silently changing its referent would break every reader of the
      // route who pairs it with `feasibility.ceilingR`.)
      ceilingR: feasibility.ceilingR,
      // TRA-2353 (AC2) — the sleeve sentence travels ON THE CRITERION, not only in a
      // sibling block: this is the field a reader lands on when they ask why criterion 3
      // reads the way it does, and a `feasible` book resting on 26% of its own
      // population is part of that answer. TRA-2361 — when a sleeve BLOCKS, the block
      // leads: this field is the criterion-level answer to "why is this INFEASIBLE?".
      feasibilityNote: [
        sleeveBlocking
          ? `⛔ SLEEVE BLOCK (TRA-2361 R1) — ${infeasibleClause(
              {
                name: 'positive_expectancy',
                barR: criteria.minExpectancyR,
                ceilingR: feasibility.ceilingR,
              } as GateCriterionResult,
            )}`
          : null,
        // TRA-3368 — the power sentence travels on the criterion ONLY when it is the
        // binding state. Under INFEASIBLE it is withheld here: the two remedies point
        // opposite ways, and a note saying "more sample is the only remedy" beside a
        // headline saying "more sample cannot resolve it" would be self-contradicting.
        expectancyStatus === 'UNDERPOWERED' ? underpoweredNote : null,
        feasibility.reason,
        sleeveFeasibility.note == null ? null : `⚠️ ${sleeveFeasibility.note}`,
      ]
        .filter((x): x is string => x != null)
        .join(' '),
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
  // TRA-3368 — UNDERPOWERED gets its OWN headline, below INFEASIBLE in precedence and
  // above the plain HOLD. The INFEASIBLE clause "MORE SAMPLE CANNOT RESOLVE IT" stays
  // scoped to INFEASIBLE only: for an under-powered sample more sample is the ONLY
  // remedy, and routing it through either neighbour prints the opposite instruction.
  const underpowered = criteriaResults.filter((c) => c.status === 'UNDERPOWERED');
  const headline = passed
    ? 'PASS — forward-test track record clears every documented criterion; live-capital wiring may now be PROPOSED (not auto-enabled).'
    : infeasible.length > 0
      ? `INFEASIBLE — live capital stays gated, and ${infeasible.length === 1 ? 'one criterion CANNOT BE TESTED' : `${infeasible.length} criteria CANNOT BE TESTED`} against this book: ${infeasible.map(infeasibleClause).join('; ')}. This is NOT a shortfall of evidence and MORE SAMPLE CANNOT RESOLVE IT — re-derive the bar or change the instrument.${failed.filter((n) => !infeasible.some((c) => c.name === n)).length > 0 ? ` Also unmet: ${failed.filter((n) => !infeasible.some((c) => c.name === n)).join(', ')}.` : ''}`
      : underpowered.length > 0
        ? `UNDERPOWERED — live capital stays gated: at δ = ${TARGET_EFFECT_R}R and ${POWER_CONFIDENCE_SIGMA}σ the graded sample cannot resolve the expectancy bar (required n ≥ ${power.nRequired ?? 'uncomputable — σ degenerate'}, observed ${power.nObserved}; forced by ${power.forcedBy.join(', ')}). A PASS or FAIL from this sample would be a coin flip. This IS a shortfall of evidence and MORE SAMPLE IS THE ONLY REMEDY — the bar and the instrument stay as written.${failed.filter((n) => !underpowered.some((c) => c.name === n)).length > 0 ? ` Also unmet: ${failed.filter((n) => !underpowered.some((c) => c.name === n)).join(', ')}.` : ''}`
        : `HOLD — live capital stays gated. Unmet: ${failed.join(', ')}.`;

  // TRA-2353 (AC4) — `unknown` MUST RENDER AS UNKNOWN IN THE HEADLINE, not only on the
  // criterion. The ceiling is an UPPER bound, so `unknown` is not the symmetric partner
  // of `feasible`: it can conceal a genuinely infeasible state. When it lands on a
  // criterion reading a bare `FAIL`, the headline asserts "the book underperformed" —
  // the exact conflation between a fact about the BOOK and a fact about the EXPERIMENT
  // that this gate's third verdict state exists to prevent. Non-blocking is correct
  // (`expectancyNetR ≤ ceiling` pathwise, so a measured pass is constructive proof of
  // reachability); invisible is not.
  const suffixes: string[] = [];
  if (expectancyStatus === 'FAIL' && feasibility.verdict === 'unknown') {
    suffixes.push(
      `⚠️ REACHABILITY UNKNOWN — \`positive_expectancy\` reads FAIL, but no payoff ceiling could be established for this book, so that FAIL does NOT establish that the book underperformed a bar it could have cleared. The ${criteria.minExpectancyR}R bar is UNGRADED for reachability, not cleared. ${feasibility.reason}`,
    );
  }
  if (sleeveFeasibility.note != null) suffixes.push(`⚠️ ${sleeveFeasibility.note}`);
  const summary = suffixes.length ? `${headline} ${suffixes.join(' ')}` : headline;

  return {
    passed,
    asOfDate: report.asOfDate,
    criteria: criteriaResults,
    feasibility,
    sleeveFeasibility,
    power,
    summary,
    note:
      'A passing gate is permission to PROPOSE live wiring to the board — it enables no orders. Live ' +
      'auto-execution remains out of scope and is further gated by the per-strategy promotion gate (TRA-532) ' +
      'and explicit human sign-off.',
  };
}
