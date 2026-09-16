// TRA-3368 (parent TRA-2346 → TRA-2335 → TRA-2332) — the POWER-BASED DETECTABILITY
// criterion that replaces the raw `minResolvedIdeas = 30` floor as the gate's whole
// theory of "enough sample".
//
// ── The defect this exists to make impossible ────────────────────────────────
//
// The 30-idea floor answers "is n ≥ 30?", which is not the question the gate needs
// answered. The question is: CAN THIS SAMPLE RESOLVE THE EFFECT THE GATE MUST DETECT?
// For a mean-of-R criterion graded at bar b with a pre-registered minimum effect of
// δ = TARGET_EFFECT_R, the sample must be able to distinguish `E[R] = b` from
// `E[R] = b ± δ`. The standard error of the mean is σ/√n, so at a z of
// POWER_CONFIDENCE_SIGMA the required sample is
//
//     n_req = ceil( (POWER_CONFIDENCE_SIGMA · σ / δ)² )     — σ on the R SCALE
//
// Per-idea R on a defined-risk credit structure is TWO-POINT: `+c/(1−c)` on a win,
// `−1` on a loss, where `c = credit ÷ width`. At the breakeven hit rate `p = 1 − c`
// the parametric sd of R is
//
//     σ_param(c) = √(p(1−p)) / (1−c) = √(c/(1−c))          — p = 1 − c
//
// which makes the credit-sleeve required sample
//
//     n_req = ceil( 4·p(1−p) / ((1−c)²·δ²) )                (at σ = 2.0)
//
// ⚠️ THE SCALE MATTERS AND IS PINNED BY TEST. `√(p(1−p))` alone is the sd of the WIN
// INDICATOR; the gate grades R. On the R scale the reference values at δ = 0.03 are
// ~137.5 / ~1111.1 / ~1904.8 for c = 0.03 / 0.20 / 0.30 (ceil: 138 / 1112 / 1905) —
// NOT the hit-rate-scale 129 / 711 / 933, which understate the credit sleeves by
// (1−c)⁻², i.e. 1.6–2.0× exactly where the criterion has to bite.
//
// ── Why σ = max(σ̂, σ_param), never the raw sample sd ────────────────────────
//
// σ̂ in the denominator of "is my sample big enough" is a FAIL-OPEN that is WORSE than
// the constant it replaces: a book that has not lost yet has σ̂ ≈ 0 ⇒ n_req ≈ 0 ⇒
// "adequately powered" at n = 3 — and it fails in the direction that OPENS the gate.
// So the parametric floor σ_param(c) backstops σ̂ wherever a credit/width ratio exists.
// σ_param is evaluated at the BREAKEVEN p = 1−c deliberately: p(1−p) falls as p rises
// above ½, so the breakeven point dominates the alternative and the floor errs toward
// demanding MORE sample (answers TRA-1741's "compute what the gate can see in the
// world where you would act").
//
// ⛔ A χ² UPPER CONFIDENCE BOUND ON σ̂ WAS CONSIDERED AND REJECTED OUTRIGHT by the
// TRA-2346 sign-off (QuantTrader, 2026-08-12): the χ² interval assumes normality, and
// two-point R breaks that assumption badly enough to make its coverage fiction. Do
// NOT ship it later as an "upgrade" — that door is closed, not deferred.
//
// ⛔ Do NOT reuse the population-stdev helper in `strategy-introspection.ts` — its
// denominator is n ("we have the full sample") and it returns 0 for n < 2. Correct for
// ITS subject; wrong here on both counts: the resolved set is a SAMPLE (⇒ n−1, since
// denominator-n is downward-biased exactly at the small n where this criterion must
// bite), and a fabricated 0 at n < 2 reads as "infinitely well powered at n = 1" under
// the fail-open above. {@link sampleStdev} below is the n−1, null-never-0 replacement.
//
// Pure — no I/O, no env, no clock. Leaf module by construction (imports only
// `gate-feasibility.js` for the shared materiality constant): `options-forward-test.ts`
// computes the per-sleeve observations and `live-capital-gate.ts` evaluates them.

import { BLOCKING_SLEEVE_WEIGHT } from './gate-feasibility.js';

/**
 * δ — the minimum R-scale effect the gate must be able to DETECT, absolute and
 * pre-registered (TRA-2346 sign-off, Q4).
 *
 * ⛔ NEVER derive δ from the measured book — in particular never
 * `|expectancyNetR − minExpectancyR|`. An estimated δ̂ in the denominator of n_req is
 * self-certifying: a lucky mean far from the bar shrinks its own required sample, the
 * same disease as raw σ̂, on the other variable. The constant is the pre-registration.
 */
export const TARGET_EFFECT_R = 0.03;

/**
 * z — the confidence multiple on the standard error: n_req = (POWER_CONFIDENCE_SIGMA·σ/δ)².
 *
 * ⚠️ Be honest about what 2.0 buys: n = (2σ/δ)² puts δ at TWO standard errors, which is
 * ~95% confidence against a ZERO effect but only ~50% POWER at the effect δ itself (at
 * true effect δ, the estimate lands below the 2-SE line half the time). True 80% power
 * at δ needs z ≈ 2.80 (= 1.96 + 0.84). That is a PARAMETER CHANGE on this constant, not
 * a redesign — ratified as such by the TRA-2346 sign-off (Q3).
 */
export const POWER_CONFIDENCE_SIGMA = 2.0;

/** Where the σ used by a power evaluation came from. */
export type PowerSigmaSource =
  /** The n−1 sample sd of the graded R values — it exceeded the parametric floor. */
  | 'sample'
  /** σ_param(c) at breakeven p = 1−c — it exceeded (or replaced a degenerate) σ̂. */
  | 'parametric_floor'
  /**
   * No usable credit/width ratio (debit/long sleeve, or none derivable) ⇒ no parametric
   * floor exists; σ is the sample sd ALONE. ⚠️ By ratified rule (TRA-2346 Q2), a
   * `sample_only` unit whose σ̂ is 0 or null is UNDERPOWERED outright — with neither a
   * floor nor a live sd there is no sound n_req, and "powered" would be the σ̂≈0
   * fail-open wearing a debit face.
   */
  | 'sample_only';

/**
 * σ̂ at or below this is DEGENERATE — treated exactly like the ratified "σ̂ ∈ {0, null}".
 *
 * ⚠️ This is a FLOAT-DUST guard, not a hidden statistical threshold. An all-identical
 * sample (e.g. forty wins of exactly +0.98R) has σ̂ that is mathematically 0 but comes
 * out of the two-pass computation as ~1e−17, because the mean of forty 0.98s is not
 * bit-exactly 0.98. An exact `=== 0` check is a label-match on a float: the σ̂≈0
 * fail-open this module exists to kill walks straight through it wearing summation
 * dust. Measured on this codebase's own fixtures before this constant existed.
 * 1e−12 is ~10⁵× above double-precision dust at these magnitudes and ~10⁹× below any
 * real R-scale dispersion, so it cannot misclassify a genuine sample.
 */
export const SIGMA_DEGENERATE_EPS = 1e-12;

/**
 * Sample standard deviation, denominator n−1.
 *
 * Returns **null (never 0) below n = 2** — a fabricated 0 feeds the σ̂-fail-open this
 * module exists to kill. This is deliberately NOT `strategy-introspection.ts`'s
 * population-stdev helper; see the module doc for why that one must not be reused.
 */
export function sampleStdev(xs: readonly number[]): number | null {
  const n = xs.length;
  if (n < 2) return null;
  const m = xs.reduce((a, b) => a + b, 0) / n;
  const ss = xs.reduce((a, x) => a + (x - m) * (x - m), 0);
  return Math.sqrt(ss / (n - 1));
}

/**
 * σ_param(c) = √(p(1−p))/(1−c) at the breakeven hit rate p = 1−c — the R-scale sd of
 * the two-point outcome (`+c/(1−c)` win / `−1` loss). Algebraically `√(c/(1−c))`.
 *
 * Null unless `c ∈ (0, 1)`: a non-positive c (net-debit book, or an unformable ratio)
 * has a breakeven p ≥ 1, so the two-point parametric model degenerates and there is no
 * floor — the unit is graded `sample_only`.
 */
export function sigmaParametric(c: number | null): number | null {
  if (c == null || !Number.isFinite(c) || c <= 0 || c >= 1) return null;
  return Math.sqrt(c / (1 - c));
}

/** One power-gradeable population: the pooled book, or one sleeve of it. */
export interface PowerObservation {
  /** Graded rows in this population (the SAME resolved-and-included basis as the gate). */
  n: number;
  /**
   * Mean signed credit/width ratio over rows where one is derivable (width > 0);
   * null when none is. May be ≤ 0 on a net-debit population — the parametric floor
   * only engages for `c ∈ (0, 1)`; anything else grades `sample_only`.
   */
  c: number | null;
  /** n−1 sample sd of the graded cost-net R values ({@link sampleStdev}); null below n=2. */
  sigmaSample: number | null;
}

/** A sleeve observation — {@link PowerObservation} plus its identity and book weight. */
export interface SleevePowerObservation extends PowerObservation {
  key: string;
  /** `n ÷ bookN`, 0–1. Null only when the book is empty. */
  weight: number | null;
}

/**
 * The report-side inputs to the power criterion, computed by
 * `buildForwardTestReport` from the SAME `resolved && !excluded` array every other
 * gate metric aggregates — never a re-derived population (TRA-2346 §6: the looser
 * `maxLossUsd > 0` filter re-admits exactly the fabricated rows that fail open).
 */
export interface GatePowerInputs {
  pooled: PowerObservation;
  /** Partitioned on `strategy` — same axis as `ceilingAxes.byStructure`. */
  byStructure: SleevePowerObservation[];
  /** Partitioned on the sign of `entryNetUsd` — same axis as `ceilingAxes.byPremiumDirection`. */
  byPremiumDirection: SleevePowerObservation[];
}

/** One unit's power verdict (pooled book or single sleeve). */
export interface UnitPower {
  n: number;
  c: number | null;
  /** The σ the requirement was computed from: max(σ̂, σ_param(c)) where a floor exists. */
  sigmaUsed: number | null;
  sigmaSource: PowerSigmaSource;
  /**
   * `max(floor, ceil((POWER_CONFIDENCE_SIGMA·σ/δ)²))`. Null ONLY in the degenerate
   * `sample_only` case (σ̂ ∈ {0, null}) where no sound requirement exists — which is
   * `powered: false` by rule, never a pass.
   */
  nRequired: number | null;
  powered: boolean;
}

/** {@link UnitPower} for one sleeve, carrying its identity, weight and materiality. */
export interface SleevePower extends UnitPower {
  key: string;
  weight: number | null;
  /** True when `weight ≥ BLOCKING_SLEEVE_WEIGHT` (0.2) — the sleeves the conjunct binds on. */
  material: boolean;
}

/** The gate-level power verdict — the shape `/api/health/live-capital-gate` publishes. */
export interface GatePowerResult {
  targetEffectR: number;
  confidenceSigma: number;
  /** Pooled-book σ/source/requirement, mirrored top-level for the headline read. */
  sigmaUsed: number | null;
  sigmaSource: PowerSigmaSource;
  nRequired: number | null;
  nObserved: number;
  /**
   * THE criterion: `powered_pooled(book n, pooled c) AND every sleeve with
   * weight ≥ 0.2 powered at its own c` — on BOTH axes.
   *
   * The pooled conjunct is LOAD-BEARING, not a redundancy: a per-sleeve-only ∀ is
   * vacuously true on a fragmented book (six 15% sleeves), the same
   * materiality-quantifier fail-open TRA-2607 hit on a mixed population. Fixture (f)
   * exists to fail if this conjunct is dropped in review.
   */
  powered: boolean;
  pooled: UnitPower;
  byAxis: { byStructure: SleevePower[]; byPremiumDirection: SleevePower[] };
  /**
   * WHICH conjunct forced `powered: false` — `'pooled'` and/or `'{axis}:{sleeve key}'`
   * entries. Empty when powered. The reader must never have to re-derive the offender.
   */
  forcedBy: string[];
}

/**
 * `max(floor, ceil((z·σ/δ)²))` — the floor survives the redesign (TRA-2346 Q5): it is
 * strictly monotone on the sample axis and stays the hard bar when the computed
 * requirement is small. The 1e−9 slack keeps float noise on an exactly-integer
 * requirement from ceiling one row past it.
 */
export function requiredN(sigma: number, floor: number): number {
  const raw = (POWER_CONFIDENCE_SIGMA * sigma) / TARGET_EFFECT_R;
  return Math.max(floor, Math.ceil(raw * raw - 1e-9));
}

/** Evaluate one population's power. Pure. `floor` is the surviving 30-idea sample floor. */
export function evaluateUnitPower(obs: PowerObservation, floor: number): UnitPower {
  const sigmaParam = sigmaParametric(obs.c);
  if (sigmaParam == null) {
    // No parametric floor exists for this population (debit/long, or no ratio at all).
    const sigmaUsed = obs.sigmaSample;
    if (sigmaUsed == null || sigmaUsed <= SIGMA_DEGENERATE_EPS) {
      // Ratified rule (TRA-2346 Q2): `sample_only` with σ̂ ∈ {0, null} is UNDERPOWERED
      // outright. There is no sound n_req to publish — null, never a fabricated bar.
      return { n: obs.n, c: obs.c, sigmaUsed, sigmaSource: 'sample_only', nRequired: null, powered: false };
    }
    const nRequired = requiredN(sigmaUsed, floor);
    return { n: obs.n, c: obs.c, sigmaUsed, sigmaSource: 'sample_only', nRequired, powered: obs.n >= nRequired };
  }
  const sample = obs.sigmaSample;
  const useSample = sample != null && sample >= sigmaParam;
  const sigmaUsed = useSample ? sample : sigmaParam;
  const nRequired = requiredN(sigmaUsed, floor);
  return {
    n: obs.n,
    c: obs.c,
    sigmaUsed,
    sigmaSource: useSample ? 'sample' : 'parametric_floor',
    nRequired,
    powered: obs.n >= nRequired,
  };
}

/**
 * Evaluate the gate-level power criterion.
 *
 * `inputs` may be absent (legacy/partial report): that grades as the degenerate
 * `sample_only` case — UNDERPOWERED, fail-CLOSED. A report that cannot show its σ and c
 * cannot certify that its sample resolves anything, and the criterion is ratified
 * monotone non-increasing, so the degraded read must close the path, not open it.
 */
export function evaluateGatePower(
  inputs: GatePowerInputs | undefined,
  opts: { floor: number; nObserved: number },
): GatePowerResult {
  const pooledObs: PowerObservation = inputs?.pooled ?? {
    n: opts.nObserved,
    c: null,
    sigmaSample: null,
  };
  const pooled = evaluateUnitPower(pooledObs, opts.floor);

  const evalAxis = (sleeves: readonly SleevePowerObservation[] | undefined): SleevePower[] =>
    (sleeves ?? []).map((s) => ({
      ...evaluateUnitPower(s, opts.floor),
      key: s.key,
      weight: s.weight,
      material: s.weight != null && s.weight >= BLOCKING_SLEEVE_WEIGHT,
    }));
  const byStructure = evalAxis(inputs?.byStructure);
  const byPremiumDirection = evalAxis(inputs?.byPremiumDirection);

  const forcedBy: string[] = [];
  if (!pooled.powered) {
    forcedBy.push(inputs == null ? 'pooled (power inputs unavailable on this report)' : 'pooled');
  }
  for (const [axis, sleeves] of [
    ['byStructure', byStructure],
    ['byPremiumDirection', byPremiumDirection],
  ] as const) {
    for (const s of sleeves) {
      if (s.material && !s.powered) forcedBy.push(`${axis}:${s.key}`);
    }
  }

  return {
    targetEffectR: TARGET_EFFECT_R,
    confidenceSigma: POWER_CONFIDENCE_SIGMA,
    sigmaUsed: pooled.sigmaUsed,
    sigmaSource: pooled.sigmaSource,
    nRequired: pooled.nRequired,
    nObserved: pooled.n,
    powered: forcedBy.length === 0,
    pooled,
    byAxis: { byStructure, byPremiumDirection },
    forcedBy,
  };
}
