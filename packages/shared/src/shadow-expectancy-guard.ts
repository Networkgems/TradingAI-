// ── Shadow-expectancy promotion guard (TRA-2036) ─────────────────────────────
//
// Convergent finding from both TRA-2029 second opinions (internal CTO review
// TRA-2031 "shadow not gate-wired"; external ChatGPT review "negative shadow
// expectancy must block promotion, not merely be displayed"): the promotion gate
// DISPLAYS shadow expectancy but does not ENFORCE it. A strategy with negative
// net shadow E[R] can still clear the six statistical guards and advance.
//
// This module is the *pure*, I/O-free core of a new guard that BLOCKS promotion
// when net shadow expectancy (net of the shared TRA-2033 cost model — the caller
// supplies cost-netted R) is not confidently positive. Three v1 properties, all
// fail-closed:
//
//   1. Net shadow E[R] must be > `minExpectancyR` (default 0). A non-positive
//      point estimate blocks.
//   2. Sample size is read as an EFFECTIVE N, not the raw signal count. Shadow
//      signals are NOT independent — correlated symbols, overlapping holds, and
//      repeated regimes mean a "2098 signals" count materially overstates our
//      statistical confidence. Effective N deflates the raw count by the design
//      effect of the day/episode cluster structure, and a thin effective sample
//      blocks (we cannot confirm a positive edge on too few independent blocks).
//   3. The confidence interval on E[R] is a BLOCK bootstrap by day/episode, not
//      an IID-trade bootstrap, because trades within a cluster are dependent. The
//      guard blocks when the lower bound is not > `minExpectancyR` (E[R] not
//      confidently positive).
//
// Enforcement is staged: `enforce` distinguishes OBSERVE-ONLY (compute + report
// "would block: yes/no" per candidate, contribute NO promotion block) from
// ENFORCE (a would-block becomes a real `blockedReason`). The server flag layer
// decides whether the guard is wired in at all; when it is, the default is
// observe-only so we can first measure how many current candidates it would
// block. NOTHING here touches live capital — it is a promotion-gate check, and
// live stays OFF pending TRA-382.

/** One shadow signal folded into the guard: its net-of-cost R and its cluster. */
export interface ShadowExpectancySample {
  /**
   * Net realized R for this shadow signal AFTER the shared TRA-2033 cost model.
   * The caller is responsible for cost-netting; the guard's contract is that
   * `netR` already accounts for fees/slippage so the expectancy it certifies is
   * the cost-correct one.
   */
  netR: number;
  /**
   * Cluster/block key for the effective-N and block-bootstrap machinery — the
   * trading episode. Correlated signals share a key (e.g. all signals on the
   * same ET day, or `${etDay}:${symbol}` for a per-name episode). Signals that
   * share a key are treated as dependent; distinct keys are the independent
   * blocks the effective sample size and CI are built from.
   */
  clusterKey: string;
}

/** Tunable guard config. Defaults are the TRA-2036 v1 values. */
export interface ShadowExpectancyGuardConfig {
  /**
   * When true a `wouldBlock` becomes a real promotion `blockedReason`; when
   * false the guard is OBSERVE-ONLY (reports the would-block decision but blocks
   * nothing). The server flag layer sets this — default observe-only.
   */
  enforce: boolean;
  /** Net shadow E[R] must be strictly greater than this to pass. Default 0. */
  minExpectancyR: number;
  /**
   * Minimum EFFECTIVE sample size (correlation-adjusted N, not raw count). Below
   * this the guard blocks fail-closed: too few independent day/episode blocks to
   * confirm a positive edge. Default 30.
   */
  minEffectiveN: number;
  /** Two-sided confidence for the block-bootstrap CI (e.g. 0.90 → p5/p95). */
  confidence: number;
  /** Block-bootstrap resamples. Default 2000. */
  bootstrapIterations: number;
  /** Seed for the deterministic PRNG so the CI is reproducible. */
  seed: number;
}

export const DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG: ShadowExpectancyGuardConfig = {
  enforce: false, // observe-only by default (TRA-2036: measure before enforcing)
  minExpectancyR: 0,
  minEffectiveN: 30,
  confidence: 0.9,
  bootstrapIterations: 2000,
  seed: 0x5eed,
};

/** The block-bootstrap confidence interval on net shadow E[R]. */
export interface ShadowExpectancyCi {
  /** Point estimate — the pooled mean net R over all signals. */
  point: number;
  /** Lower / upper bounds at `confidence`. NaN when the sample is too degenerate. */
  lo: number;
  hi: number;
  /** Two-sided confidence the bounds were computed at. */
  confidence: number;
  /**
   * `block-bootstrap` when computed by resampling day/episode clusters;
   * `insufficient` when there are < 2 clusters (fail-closed → NaN bounds).
   */
  method: 'block-bootstrap' | 'insufficient';
}

/** Correlation-adjusted sample-size readout: raw count vs effective N. */
export interface EffectiveSampleSize {
  /** Raw signal count — every row, as if independent. */
  rawN: number;
  /** Distinct day/episode clusters (blocks). */
  clusterCount: number;
  /**
   * Correlation-adjusted N = `rawN / designEffect`, in `[clusterCount, rawN]`.
   * Deflates the raw count by the within-cluster correlation; equals `rawN` when
   * signals are independent (each its own cluster or zero intra-cluster
   * correlation) and falls toward `clusterCount` as within-cluster correlation
   * rises toward 1.
   */
  effectiveN: number;
  /** Intraclass correlation of net R across clusters (one-way ANOVA), in [0,1]. */
  icc: number;
  /** Design effect `1 + (meanClusterSize − 1) × icc`, ≥ 1. */
  designEffect: number;
}

/** Full guard verdict for one candidate. */
export interface ShadowExpectancyGuardVerdict {
  /** Raw signal count. */
  rawN: number;
  /** Correlation-adjusted effective sample size (< rawN when signals cluster). */
  effectiveN: number;
  /** The effective-sample-size breakdown (rawN, clusterCount, icc, designEffect). */
  sampleSize: EffectiveSampleSize;
  /** Net shadow E[R] point estimate (pooled mean of cost-netted R). */
  expectancyR: number;
  /** Block-bootstrap confidence interval on E[R]. */
  ci: ShadowExpectancyCi;
  /**
   * Would this candidate be blocked? The pure fail-closed decision, independent
   * of `enforce` — this is the "would block: yes/no" the observe-only readout
   * logs per candidate.
   */
  wouldBlock: boolean;
  /** Reasons behind `wouldBlock` (empty when it would not block). */
  reasons: string[];
  /** True iff enforcing — a `wouldBlock` under enforce becomes a real block. */
  enforced: boolean;
  /** `enforced && wouldBlock` — contributes a `blockedReason` to the gate. */
  blocks: boolean;
}

// ── Deterministic PRNG (mulberry32) ──────────────────────────────────────────
// Self-contained so `@trading-app/shared` needs no dependency on the backtest
// package (dependency direction is backtest → shared). Same generator the
// backtest bootstrap uses, so CIs are reproducible across runs and machines.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function mean(xs: readonly number[]): number {
  if (xs.length === 0) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

/** The p-th percentile (0..1) of a sample, linear-interpolated on the sorted values. */
function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return NaN;
  if (sorted.length === 1) return sorted[0]!;
  const idx = p * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo]!;
  const frac = idx - lo;
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac;
}

/** Group the sample's net-R values by cluster key, preserving insertion order. */
function clustersOf(sample: readonly ShadowExpectancySample[]): number[][] {
  const groups = new Map<string, number[]>();
  for (const s of sample) {
    if (!Number.isFinite(s.netR)) continue;
    const arr = groups.get(s.clusterKey);
    if (arr) arr.push(s.netR);
    else groups.set(s.clusterKey, [s.netR]);
  }
  return [...groups.values()];
}

/**
 * Correlation-adjusted effective sample size from the day/episode cluster
 * structure. Uses the survey-statistics **design effect**: signals within a
 * cluster are correlated, so `rawN` independent-looking rows are worth only
 * `rawN / Deff` truly-independent observations, where
 * `Deff = 1 + (m̄ − 1) × ICC`, `m̄` is the mean cluster size, and `ICC` is the
 * intraclass correlation of net R estimated by a one-way random-effects ANOVA
 * (`ICC = (MSB − MSW) / (MSB + (m0 − 1) × MSW)`, clamped to [0,1]).
 *
 * With every cluster a singleton (`m̄ = 1`) or zero intra-cluster correlation,
 * `Deff = 1` and `effectiveN = rawN` (no penalty for truly-independent signals).
 * As within-cluster correlation rises toward 1, `effectiveN` falls toward the
 * cluster count. Result is clamped to `[clusterCount, rawN]`.
 */
export function computeEffectiveSampleSize(
  sample: readonly ShadowExpectancySample[],
): EffectiveSampleSize {
  const clusters = clustersOf(sample);
  const clusterCount = clusters.length;
  const rawN = clusters.reduce((n, c) => n + c.length, 0);

  // No adjustment possible with < 2 clusters or < 2 rows: treat as independent.
  if (clusterCount < 2 || rawN < 2) {
    return { rawN, clusterCount, effectiveN: rawN, icc: 0, designEffect: 1 };
  }

  const grand = mean(clusters.flat());
  const meanClusterSize = rawN / clusterCount;

  // Between- and within-cluster mean squares (one-way ANOVA on net R).
  let ssBetween = 0;
  let ssWithin = 0;
  let sumNiSq = 0;
  for (const c of clusters) {
    const ni = c.length;
    sumNiSq += ni * ni;
    const ci = mean(c);
    ssBetween += ni * (ci - grand) ** 2;
    for (const x of c) ssWithin += (x - ci) ** 2;
  }
  const dfBetween = clusterCount - 1;
  const dfWithin = rawN - clusterCount;
  const msBetween = ssBetween / dfBetween;
  const msWithin = dfWithin > 0 ? ssWithin / dfWithin : 0;

  // Adjusted mean cluster size m0 for unequal group sizes (standard ANOVA form).
  const m0 = (rawN - sumNiSq / rawN) / dfBetween;

  // With every cluster a singleton (dfWithin === 0) there is no within-cluster
  // variance to estimate correlation from — it is unmeasurable, not perfect. Report
  // ICC = 0 (the design effect below is 1 regardless, since meanClusterSize === 1).
  let icc = 0;
  if (dfWithin > 0) {
    const denom = msBetween + (m0 - 1) * msWithin;
    if (denom > 0 && Number.isFinite(denom)) {
      icc = (msBetween - msWithin) / denom;
    }
    if (!Number.isFinite(icc)) icc = 0;
    icc = Math.max(0, Math.min(1, icc));
  }

  const designEffect = 1 + (meanClusterSize - 1) * icc;
  const effectiveRaw = designEffect > 0 ? rawN / designEffect : rawN;
  const effectiveN = Math.max(clusterCount, Math.min(rawN, effectiveRaw));

  return { rawN, clusterCount, effectiveN, icc, designEffect };
}

/**
 * Block-bootstrap confidence interval on net shadow E[R]. Resamples whole
 * day/episode clusters with replacement (preserving within-cluster dependence,
 * which an IID-trade bootstrap would destroy and so understate the CI width),
 * pools each resample's signals, and takes the mean. The `[lo, hi]` bounds are
 * the two-sided percentiles at `confidence`.
 *
 * Fail-closed: with < 2 clusters the block bootstrap is degenerate (every
 * resample is the same cluster) and the CI is reported as `insufficient` with
 * NaN bounds, which the guard treats as "not confidently positive" → block.
 */
export function blockBootstrapExpectancyCi(
  sample: readonly ShadowExpectancySample[],
  config: Pick<ShadowExpectancyGuardConfig, 'confidence' | 'bootstrapIterations' | 'seed'>,
): ShadowExpectancyCi {
  const clusters = clustersOf(sample);
  const point = mean(clusters.flat());
  const { confidence } = config;

  if (clusters.length < 2) {
    return { point, lo: NaN, hi: NaN, confidence, method: 'insufficient' };
  }

  const rand = mulberry32(config.seed);
  const iterations = Math.max(1, config.bootstrapIterations);
  const means: number[] = new Array(iterations);
  for (let b = 0; b < iterations; b++) {
    let sum = 0;
    let count = 0;
    // Resample as many clusters as the original has, with replacement.
    for (let k = 0; k < clusters.length; k++) {
      const pick = clusters[Math.floor(rand() * clusters.length)]!;
      for (const v of pick) {
        sum += v;
        count += 1;
      }
    }
    means[b] = count > 0 ? sum / count : 0;
  }
  means.sort((a, b) => a - b);
  const alpha = (1 - confidence) / 2;
  return {
    point,
    lo: percentile(means, alpha),
    hi: percentile(means, 1 - alpha),
    confidence,
    method: 'block-bootstrap',
  };
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  return Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(4).replace(/\.?0+$/, '');
}

/**
 * Evaluate the shadow-expectancy guard for one candidate over its cost-netted
 * shadow sample. Pure and fail-closed — it blocks (`wouldBlock = true`) when any
 * of these hold:
 *   • no shadow signals recorded (nothing to certify);
 *   • effective N < `minEffectiveN` (too few independent day/episode blocks);
 *   • net E[R] not > `minExpectancyR` (non-positive expectancy);
 *   • block-bootstrap CI lower bound not > `minExpectancyR` (not confidently
 *     positive), including the degenerate `insufficient` CI.
 *
 * `blocks` (which the promotion gate actually consumes) is only true under
 * `enforce`; in observe-only mode `wouldBlock` still reports the decision but
 * `blocks` stays false.
 */
export function evaluateShadowExpectancyGuard(
  sample: readonly ShadowExpectancySample[],
  config: ShadowExpectancyGuardConfig = DEFAULT_SHADOW_EXPECTANCY_GUARD_CONFIG,
): ShadowExpectancyGuardVerdict {
  const sampleSize = computeEffectiveSampleSize(sample);
  const ci = blockBootstrapExpectancyCi(sample, config);
  const expectancyR = ci.point;
  const reasons: string[] = [];

  if (sampleSize.rawN === 0) {
    reasons.push('no shadow signals recorded — cannot certify a positive edge (fail-closed)');
  } else {
    if (!(sampleSize.effectiveN >= config.minEffectiveN)) {
      reasons.push(
        `effective N ${fmt(sampleSize.effectiveN)} < ${config.minEffectiveN} `
          + `(raw N ${sampleSize.rawN}, ${sampleSize.clusterCount} clusters, `
          + `ICC ${fmt(sampleSize.icc)}) — sample too thin after correlation adjustment`,
      );
    }
    if (!(expectancyR > config.minExpectancyR)) {
      reasons.push(`net shadow E[R] ${fmt(expectancyR)} not > ${fmt(config.minExpectancyR)}`);
    }
    if (!(Number.isFinite(ci.lo) && ci.lo > config.minExpectancyR)) {
      reasons.push(
        `block-bootstrap ${Math.round(config.confidence * 100)}% CI lower bound ${fmt(ci.lo)} `
          + `not > ${fmt(config.minExpectancyR)} — expectancy not confidently positive`,
      );
    }
  }

  const wouldBlock = reasons.length > 0;
  return {
    rawN: sampleSize.rawN,
    effectiveN: sampleSize.effectiveN,
    sampleSize,
    expectancyR,
    ci,
    wouldBlock,
    reasons,
    enforced: config.enforce,
    blocks: config.enforce && wouldBlock,
  };
}
