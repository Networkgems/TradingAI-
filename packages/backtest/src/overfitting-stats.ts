/**
 * Overfitting statistics for the TRA-531 optimization harness (TRA-540).
 *
 * Two published, deterministic statistics that quantify how much a backtest's
 * headline performance is an artefact of multiple-testing / curve-fitting:
 *
 *   G2 — Probabilistic / Deflated Sharpe Ratio
 *        (Bailey & López de Prado, "The Deflated Sharpe Ratio", 2014).
 *   G3 — Probability of Backtest Overfitting via CSCV
 *        (López de Prado, "The Probability of Backtest Overfitting", 2015).
 *
 * Everything here is a pure function over plain arrays — no I/O, no globals, no
 * Math.random — so the unit tests can pin exact numbers with seeded inputs.
 */

/** Euler–Mascheroni constant — used by the expected-maximum-Sharpe benchmark. */
const EULER_GAMMA = 0.5772156649015329;

// ── Normal distribution helpers ───────────────────────────────────────────────

/**
 * Standard-normal CDF Φ(x) via the Abramowitz & Stegun 7.1.26 erf
 * approximation (max abs error ≈ 1.5e-7 — ample for a pass/fail guard).
 */
export function normalCdf(x: number): number {
  // Φ(x) = ½·erfc(−x/√2) = ½·(1 + erf(x/√2)).
  const z = x / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * Math.abs(z));
  const poly =
    t * (0.254829592 +
      t * (-0.284496736 +
        t * (1.421413741 +
          t * (-1.453152027 + t * 1.061405429))));
  const erf = 1 - poly * Math.exp(-z * z);
  const signed = z >= 0 ? erf : -erf;
  return 0.5 * (1 + signed);
}

/**
 * Inverse standard-normal CDF Φ⁻¹(p) (probit) via Peter Acklam's rational
 * approximation (relative error < 1.15e-9 across the open interval). Clamps to
 * a tiny epsilon at the boundaries so callers never get ±Infinity.
 */
export function normalPpf(p: number): number {
  const EPS = 1e-15;
  const pp = Math.min(1 - EPS, Math.max(EPS, p));

  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
    1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
    6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
    -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
    3.754408661907416];

  const plow = 0.02425;
  const phigh = 1 - plow;
  let q: number, r: number;

  if (pp < plow) {
    q = Math.sqrt(-2 * Math.log(pp));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (pp > phigh) {
    q = Math.sqrt(-2 * Math.log(1 - pp));
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) /
      ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  q = pp - 0.5;
  r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
    (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// ── Sample moments ────────────────────────────────────────────────────────────

export interface SampleMoments {
  n: number;
  mean: number;
  /** Sample standard deviation (ddof = 1). */
  std: number;
  /** Skewness (third standardized moment, population-style denominator). */
  skew: number;
  /** Kurtosis (fourth standardized moment, **non-excess** — normal ≈ 3). */
  kurtosis: number;
}

export function sampleMoments(xs: readonly number[]): SampleMoments {
  const n = xs.length;
  if (n === 0) return { n: 0, mean: 0, std: 0, skew: 0, kurtosis: 3 };
  const mean = xs.reduce((s, x) => s + x, 0) / n;
  let m2 = 0, m3 = 0, m4 = 0;
  for (const x of xs) {
    const d = x - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  m2 /= n; m3 /= n; m4 /= n;
  const std = n > 1 ? Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const skew = m2 > 0 ? m3 / m2 ** 1.5 : 0;
  const kurtosis = m2 > 0 ? m4 / (m2 * m2) : 3;
  return { n, mean, std, skew, kurtosis };
}

// ── G2: Probabilistic / Deflated Sharpe Ratio ────────────────────────────────

/**
 * Probabilistic Sharpe Ratio — P(true SR > SR*) given the observed (non-
 * annualized) Sharpe `srHat`, benchmark `srStar`, sample length `n`, and the
 * return distribution's `skew` (γ3) and non-excess `kurtosis` (γ4).
 *
 *   PSR(SR*) = Φ[ (SR̂ − SR*)·√(n−1) / √(1 − γ3·SR̂ + ((γ4−1)/4)·SR̂²) ]
 *
 * (Bailey & López de Prado 2014, eq. 3.) `srHat`/`srStar` are per-period
 * Sharpe — the same per-observation basis as the returns `n` counts.
 */
export function probabilisticSharpeRatio(
  srHat: number,
  srStar: number,
  n: number,
  skew: number,
  kurtosis: number,
): number {
  if (n < 2) return 0;
  const denom = 1 - skew * srHat + ((kurtosis - 1) / 4) * srHat * srHat;
  if (!(denom > 0)) return srHat > srStar ? 1 : 0;
  const z = ((srHat - srStar) * Math.sqrt(n - 1)) / Math.sqrt(denom);
  return normalCdf(z);
}

/**
 * Expected maximum Sharpe ratio across `nTrials` independent trials whose
 * Sharpe estimates have variance `varTrials` — the SR*(N) deflation benchmark.
 *
 *   SR*(N) = √Var[SR] · [ (1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)) ]
 *
 * (Bailey & López de Prado 2014, eq. 5; γ = Euler–Mascheroni.) With fewer than
 * two trials there is no multiple-testing inflation, so the benchmark is 0.
 */
export function expectedMaxSharpe(varTrials: number, nTrials: number): number {
  if (nTrials < 2 || !(varTrials > 0)) return 0;
  const sd = Math.sqrt(varTrials);
  const a = normalPpf(1 - 1 / nTrials);
  const b = normalPpf(1 - 1 / (nTrials * Math.E));
  return sd * ((1 - EULER_GAMMA) * a + EULER_GAMMA * b);
}

export interface DeflatedSharpeInput {
  /**
   * The per-period return series the observed Sharpe is measured on — e.g. the
   * blessed strategy's OOS per-trade R-multiples. Its mean/std define SR̂ and
   * its skew/kurtosis enter the PSR denominator.
   */
  returns: readonly number[];
  /**
   * Per-trial Sharpe estimates (same per-period basis) used only to estimate
   * Var[SR] for the deflation benchmark. One entry per distinct parameter point.
   */
  trialSharpes: readonly number[];
  /**
   * Total number of independent trials N for the multiple-testing penalty.
   * Defaults to `trialSharpes.length` when omitted.
   */
  trialCount?: number;
  /** PASS threshold for the deflated Sharpe (PSR vs SR*). Defaults to 0.95. */
  threshold?: number;
}

export interface DeflatedSharpeResult {
  /** Observed per-period Sharpe SR̂ = mean/std of `returns`. */
  observedSharpe: number;
  n: number;
  skew: number;
  kurtosis: number;
  trialCount: number;
  /** Variance of the supplied trial Sharpes. */
  trialSharpeVariance: number;
  /** Deflation benchmark SR*(N). */
  sharpeStar: number;
  /** Deflated Sharpe = PSR evaluated against SR*(N). */
  psr: number;
  threshold: number;
  pass: boolean;
}

/**
 * G2 guard — the Deflated Sharpe Ratio. Computes the observed per-period Sharpe
 * and its higher moments from `returns`, the SR*(N) benchmark from the trial
 * Sharpe spread, and reports PSR(SR*) with a pass flag (default PASS > 0.95).
 */
export function deflatedSharpeRatio(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const threshold = input.threshold ?? 0.95;
  const { n, mean, std, skew, kurtosis } = sampleMoments(input.returns);
  const observedSharpe = std > 0 ? mean / std : 0;

  const trialCount = input.trialCount ?? input.trialSharpes.length;
  const tm = sampleMoments(input.trialSharpes);
  const trialSharpeVariance = tm.std * tm.std;
  const sharpeStar = expectedMaxSharpe(trialSharpeVariance, trialCount);

  const psr = probabilisticSharpeRatio(observedSharpe, sharpeStar, n, skew, kurtosis);
  return {
    observedSharpe, n, skew, kurtosis,
    trialCount, trialSharpeVariance, sharpeStar,
    psr, threshold, pass: psr > threshold,
  };
}

// ── G3: Probability of Backtest Overfitting (CSCV) ───────────────────────────

/** Sharpe-style performance of a return slice (mean/std, ddof = 1). */
function sliceSharpe(rets: number[]): number {
  if (rets.length < 2) return rets.length === 1 ? rets[0] : 0;
  const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
  const variance = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : mean;
}

/** All C(items, k) combinations of indices [0..items). */
function combinations(items: number, k: number): number[][] {
  const out: number[][] = [];
  const combo: number[] = [];
  const rec = (start: number) => {
    if (combo.length === k) { out.push(combo.slice()); return; }
    for (let i = start; i <= items - (k - combo.length); i++) {
      combo.push(i);
      rec(i + 1);
      combo.pop();
    }
  };
  rec(0);
  return out;
}

export interface PboInput {
  /**
   * Performance matrix `matrix[trial][observation]` — one row per parameter
   * trial, one column per observation (e.g. per-walk-forward-window return).
   * The columns are partitioned into S disjoint blocks for CSCV.
   */
  matrix: number[][];
  /**
   * Number of disjoint sub-blocks S (must be even). Auto-reduced to the largest
   * even number ≤ the observation count when there are too few observations.
   * Defaults to 16.
   */
  partitions?: number;
  /**
   * Per-slice performance metric. Defaults to a Sharpe ratio (mean/std). Passed
   * the returns of one trial over the IS or OOS column subset.
   */
  metric?: (rets: number[]) => number;
  /** PASS threshold for PBO. Defaults to 0.50 (target < 0.25). */
  threshold?: number;
}

export interface PboResult {
  /** Probability of backtest overfitting ∈ [0,1] — fraction of splits where the IS-best trial lands below the OOS median. */
  pbo: number;
  /** Effective number of sub-blocks S actually used. */
  partitions: number;
  /** Number of CSCV combinations evaluated = C(S, S/2). */
  combinations: number;
  /** Logit of each split's OOS relative rank; PBO counts the negatives. */
  lambdas: number[];
  threshold: number;
  pass: boolean;
}

/**
 * G3 guard — Probability of Backtest Overfitting via Combinatorially-Symmetric
 * Cross-Validation. Splits the observation columns into S equal blocks, and for
 * every way of choosing S/2 blocks as in-sample: picks the IS-best trial, then
 * measures where that trial ranks out-of-sample on the complementary blocks.
 * PBO is the fraction of splits where the IS winner falls below the OOS median.
 */
export function probabilityOfBacktestOverfitting(input: PboInput): PboResult {
  const threshold = input.threshold ?? 0.5;
  const metric = input.metric ?? sliceSharpe;
  const nTrials = input.matrix.length;
  const tCols = nTrials > 0 ? input.matrix[0].length : 0;

  // S must be even and ≤ the column count. Degrade gracefully on thin data.
  let s = input.partitions ?? 16;
  if (s % 2 !== 0) s -= 1;
  while (s > tCols) s -= 2;
  if (s < 2 || nTrials < 2) {
    return { pbo: 0, partitions: Math.max(0, s), combinations: 0, lambdas: [], threshold, pass: true };
  }

  // Equal blocks — trim trailing remainder columns so every block is the same
  // size (CSCV requires balanced IS/OOS concatenations).
  const groupSize = Math.floor(tCols / s);
  const usable = groupSize * s;
  const blocks: number[][] = [];
  for (let g = 0; g < s; g++) {
    const cols: number[] = [];
    for (let c = g * groupSize; c < (g + 1) * groupSize; c++) cols.push(c);
    blocks.push(cols);
  }

  const combos = combinations(s, s / 2);
  const lambdas: number[] = [];
  let overfit = 0;

  for (const isBlocks of combos) {
    const isSet = new Set(isBlocks);
    const isCols: number[] = [];
    const oosCols: number[] = [];
    for (let g = 0; g < s; g++) {
      (isSet.has(g) ? isCols : oosCols).push(...blocks[g]);
    }

    // IS performance per trial → pick the in-sample winner.
    let bestTrial = 0;
    let bestIs = -Infinity;
    for (let t = 0; t < nTrials; t++) {
      const perf = metric(isCols.map(c => input.matrix[t][c]));
      if (perf > bestIs) { bestIs = perf; bestTrial = t; }
    }

    // OOS performance per trial → relative rank of the IS winner.
    const oosPerf = new Array<number>(nTrials);
    for (let t = 0; t < nTrials; t++) {
      oosPerf[t] = metric(oosCols.map(c => input.matrix[t][c]));
    }
    const winnerOos = oosPerf[bestTrial];
    let strictlyBelow = 0;
    for (let t = 0; t < nTrials; t++) if (oosPerf[t] < winnerOos) strictlyBelow++;
    const rank = strictlyBelow + 1;            // 1 = worst, nTrials = best
    const omega = rank / (nTrials + 1);        // relative rank ∈ (0,1)
    const clamped = Math.min(1 - 1e-12, Math.max(1e-12, omega));
    const lambda = Math.log(clamped / (1 - clamped));
    lambdas.push(lambda);
    if (lambda < 0) overfit++;                 // below OOS median ⇔ ω < 0.5 ⇔ λ < 0
  }

  const pbo = combos.length > 0 ? overfit / combos.length : 0;
  return { pbo, partitions: s, combinations: combos.length, lambdas, threshold, pass: pbo < threshold };
}
