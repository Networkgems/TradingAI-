import type { CandlePattern } from '@trading-app/engine';
import type { ReversalShadowRecord } from './reversal-shadow-ledger.js';
import { isLearnedShrinkageEnabled } from './learned-shrinkage-flag.js';

// TRA-925 (TRA-920 A) — the daily learning loop.
//
// The reversal shadow ledger (TRA-921) RECORDS every checklist setup and its
// forward TP/SL/TIMEOUT outcome but nothing reads those outcomes back into the
// signal. This module closes that loop: it folds the labelled ledger into
// per-dimension stats (by checklist score, by reversal pattern, by symbol) and
// derives a learned, bounded SCORING multiplier for each dimension value.
//
// Design rules that keep this honest rather than a curve-fit black box:
//   * Pure + deterministic. Same rows in -> same weights out. No clock, no I/O.
//   * Min-sample guard. A dimension's multiplier stays NEUTRAL (1.0) until it has
//     at least `minSamples` RESOLVED rows, so a lucky/unlucky handful of trades
//     can't swing the weighting.
//   * Bounded. Every multiplier is clamped to [floor, ceil]; the combined weight
//     is clamped again so stacking dimensions can't run away.
//   * Scoring, not gating. The output is a multiplier meant to scale a signal's
//     score — it never hard-blocks a trade, and there is no capital path here.

/** Tunables for how aggressively realized outcomes move a multiplier. */
export interface LearnedWeightsParams {
  /** Minimum RESOLVED rows before a dimension's multiplier may move off 1.0. */
  minSamples: number;
  /** Hit rate treated as neutral (multiplier 1.0). */
  baselineHitRate: number;
  /** Slope: how much one unit of (hitRate - baseline) moves the multiplier. */
  sensitivity: number;
  /** Extra down-weight per unit of negative mean R (expectancy guard). */
  expectancyPenalty: number;
  /** Lower clamp for any single and the combined multiplier. */
  floor: number;
  /** Upper clamp for any single and the combined multiplier. */
  ceil: number;
}

export const DEFAULT_LEARNED_PARAMS: LearnedWeightsParams = {
  minSamples: 10,
  baselineHitRate: 0.5,
  sensitivity: 1.0,
  expectancyPenalty: 0.1,
  floor: 0.5,
  ceil: 1.5,
};

/** One learned dimension value (e.g. score=4, pattern=hammer, symbol=SPY). */
export interface LearnedStat {
  /** Dimension value rendered as a string key. */
  key: string;
  /** All rows in this bucket, including still-OPEN setups. */
  total: number;
  /** Rows with a forward outcome (excludes OPEN). */
  resolved: number;
  tpHit: number;
  slHit: number;
  timeout: number;
  /** TP_HIT / resolved over resolved rows; null when none resolved. */
  hitRate: number | null;
  /** Mean realized R over resolved rows; null when none resolved. */
  avgR: number | null;
  /**
   * Hard-gate multiplier, kept as `multiplier` for backward-compat with readers
   * that predate the TRA-1056 A/B split (eod-report, etc.) and so the fold stays
   * deterministic on rows alone. Always equals {@link multiplierHardGate}; the
   * flag-gated switch to the shrunk estimate lives in the combined multiplier
   * functions, not in this pure fold.
   */
  multiplier: number;
  /**
   * TRA-1056 — today's behavior: neutral (1.0) until `resolved >= minSamples`,
   * then hit-rate driven. This is what the combined multiplier reads while the
   * shrinkage flag is OFF.
   */
  multiplierHardGate: number;
  /**
   * TRA-1056 — Beta-Binomial cold-start estimate: the bucket's hit-rate is pulled
   * toward the learner's global pooled `priorRate` with pseudo-count k=minSamples,
   * so a thin bucket leans on the prior and a confident bucket converges to its
   * own empirical rate. Neutral (1.0) when there is no reliable prior (global pool
   * below minSamples). Surfaced for the QuantTrader A/B diff; only feeds the
   * combined multiplier once the shrinkage flag is enabled.
   */
  multiplierShrunk: number;
  /** True once `resolved >= minSamples` — the hard-gate multiplier may move. */
  confident: boolean;
}

export interface LearnedWeights {
  /**
   * `priorRate` is the global pooled hit-rate fed to the shrinkage estimate, or
   * null when the global pool itself has not cleared `minSamples` (no prior).
   */
  generatedFrom: { rows: number; resolved: number; priorRate: number | null };
  params: LearnedWeightsParams;
  byScore: LearnedStat[];
  byPattern: LearnedStat[];
  bySymbol: LearnedStat[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * TRA-1056 — upper clamp for a SHRUNK multiplier. While a bucket is still thin
 * (`resolved < minSamples`) the ceil tapers to 1.25 so a cold bucket riding a
 * strong prior cannot reach the full 1.5 ceil; once confident the normal ceil
 * applies. The floor is unchanged.
 */
export const THIN_BUCKET_CEIL = 1.25;

/** Inputs the two multiplier estimators share for a single bucket. */
export interface BucketStats {
  resolved: number;
  /** TP/WIN count over the bucket's resolved rows. */
  hits: number;
  /** Empirical hit/win-rate over resolved rows; null when none resolved. */
  rate: number | null;
  /** Empirical mean realized R over resolved rows; null when none resolved. */
  avgR: number | null;
}

/** One-sided negative-expectancy guard: only a negative mean R down-weights. */
function expectancyGuard(avgR: number | null, p: LearnedWeightsParams): number {
  return avgR !== null && avgR < 0 ? p.expectancyPenalty * avgR : 0;
}

/**
 * TRA-1056 — today's HARD-GATE multiplier: stays neutral (1.0) until the bucket
 * clears the min-sample guard, then `1 + sensitivity*(rate-baseline) + rGuard`
 * clamped to [floor, ceil]. Shared by both learners so the A/B comparison is
 * apples-to-apples.
 */
export function hardGateMultiplier(b: BucketStats, p: LearnedWeightsParams): number {
  if (b.resolved < p.minSamples || b.rate === null) return 1;
  const hrTerm = p.sensitivity * (b.rate - p.baselineHitRate);
  return clamp(1 + hrTerm + expectancyGuard(b.avgR, p), p.floor, p.ceil);
}

/**
 * TRA-1056 — Beta-Binomial cold-start SHRUNK multiplier. `posteriorRate =
 * (k*priorRate + hits) / (k + resolved)` with k = minSamples, so a thin bucket is
 * pulled toward the global `priorRate` and a confident bucket (resolved >> k)
 * converges to its empirical rate. The avgR expectancy guard stays EMPIRICAL
 * (bucket-local, never shrunk). When `priorRate` is null — the global pool has not
 * itself cleared minSamples — there is no reliable prior, so the estimate falls
 * back to neutral 1.0 (no prior-on-prior). While the bucket is thin the ceil
 * tapers to {@link THIN_BUCKET_CEIL}; the floor is unchanged.
 */
export function shrunkMultiplier(
  b: BucketStats,
  priorRate: number | null,
  p: LearnedWeightsParams,
): number {
  if (priorRate === null) return 1;
  const k = p.minSamples; // pseudo-count, capped at minSamples
  const posteriorRate = (k * priorRate + b.hits) / (k + b.resolved);
  const rateTerm = p.sensitivity * (posteriorRate - p.baselineHitRate);
  const ceil = b.resolved < p.minSamples ? Math.min(p.ceil, THIN_BUCKET_CEIL) : p.ceil;
  return clamp(1 + rateTerm + expectancyGuard(b.avgR, p), p.floor, ceil);
}

/**
 * TRA-1056 — global pooled hit/win-rate over ALL resolved rows, the prior the
 * shrinkage estimate pulls toward. Null when the pool itself is below minSamples
 * (no prior-on-prior). `outcomeIsHit` adapts the per-learner notion of a "win".
 */
export function globalPriorRate<T>(
  rows: T[],
  isResolved: (r: T) => boolean,
  isHit: (r: T) => boolean,
  p: LearnedWeightsParams,
): number | null {
  const resolvedRows = rows.filter(isResolved);
  if (resolvedRows.length < p.minSamples) return null;
  return resolvedRows.filter(isHit).length / resolvedRows.length;
}

/**
 * Turn one bucket of rows into a learned stat. Computes BOTH multipliers
 * (TRA-1056): `multiplierHardGate` (today's confident-gated hit-rate driver) and
 * `multiplierShrunk` (Beta-Binomial cold-start estimate pulled toward `priorRate`).
 * Both carry a one-sided expectancy penalty so a bucket that "wins often but loses
 * big" (positive hit rate, negative mean R) still gets pulled down. `multiplier`
 * tracks whichever one the live combined weight reads (flag-selected).
 */
function statFor(
  key: string,
  rows: ReversalShadowRecord[],
  priorRate: number | null,
  p: LearnedWeightsParams,
): LearnedStat {
  const resolvedRows = rows.filter((r) => r.outcome !== 'OPEN');
  const resolved = resolvedRows.length;
  const tpHit = resolvedRows.filter((r) => r.outcome === 'TP_HIT').length;
  const slHit = resolvedRows.filter((r) => r.outcome === 'SL_HIT').length;
  const timeout = resolvedRows.filter((r) => r.outcome === 'TIMEOUT').length;
  const hitRate = resolved > 0 ? tpHit / resolved : null;
  const avgR =
    resolved > 0
      ? resolvedRows.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / resolved
      : null;

  const confident = resolved >= p.minSamples;
  const stats: BucketStats = { resolved, hits: tpHit, rate: hitRate, avgR };
  const multiplierHardGate = hardGateMultiplier(stats, p);
  const multiplierShrunk = shrunkMultiplier(stats, priorRate, p);
  const multiplier = multiplierHardGate; // live switch lives in the combined fn

  return {
    key,
    total: rows.length,
    resolved,
    tpHit,
    slHit,
    timeout,
    hitRate,
    avgR,
    multiplier,
    multiplierHardGate,
    multiplierShrunk,
    confident,
  };
}

function groupBy<T>(rows: ReversalShadowRecord[], keyOf: (r: ReversalShadowRecord) => T): Map<T, ReversalShadowRecord[]> {
  const m = new Map<T, ReversalShadowRecord[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}

/** Render a pattern bucket key; OPEN/leg-4-absent rows bucket under `none`. */
function patternKey(r: ReversalShadowRecord): string {
  return r.patternName ?? 'none';
}

/**
 * Fold the labelled ledger into learned per-dimension multipliers. This is the
 * whole digest — call it on the durable ledger (e.g. from the health endpoint or
 * a daily routine) and the weights are always current; no separate persisted
 * snapshot can drift from the source of truth.
 */
export function computeLearnedWeights(
  rows: ReversalShadowRecord[],
  params: LearnedWeightsParams = DEFAULT_LEARNED_PARAMS,
): LearnedWeights {
  const sortStat = (a: LearnedStat, b: LearnedStat) => a.key.localeCompare(b.key, undefined, { numeric: true });

  // Global pooled hit-rate is the prior the shrinkage estimate pulls toward; it is
  // identical across all buckets, so compute it once. The fold stays pure — it
  // carries BOTH multipliers per bucket and never reads the flag; the live switch
  // is applied downstream in `reversalSignalMultiplier`.
  const isResolved = (r: ReversalShadowRecord) => r.outcome !== 'OPEN';
  const priorRate = globalPriorRate(rows, isResolved, (r) => r.outcome === 'TP_HIT', params);

  const byScore = [...groupBy(rows, (r) => r.score).entries()]
    .map(([score, list]) => statFor(String(score), list, priorRate, params))
    .sort(sortStat);
  const byPattern = [...groupBy(rows, patternKey).entries()]
    .map(([pat, list]) => statFor(pat, list, priorRate, params))
    .sort(sortStat);
  const bySymbol = [...groupBy(rows, (r) => r.symbol).entries()]
    .map(([sym, list]) => statFor(sym, list, priorRate, params))
    .sort(sortStat);

  return {
    generatedFrom: { rows: rows.length, resolved: rows.filter(isResolved).length, priorRate },
    params,
    byScore,
    byPattern,
    bySymbol,
  };
}

/**
 * Combined scoring multiplier for a prospective reversal signal. Multiplies the
 * per-dimension multipliers (score x pattern x symbol) and clamps the product back
 * into [floor, ceil].
 *
 * Default (`ENABLE_LEARNED_WEIGHT_SHRINKAGE` OFF): the HARD-GATE behavior — only
 * CONFIDENT dimensions (resolved >= minSamples) contribute their multiplier; a
 * brand-new symbol or rare pattern stays neutral (1.0) until it has earned a
 * track record.
 *
 * Shrinkage ON (TRA-1056, pending QuantTrader A/B sign-off): every dimension
 * contributes its `multiplierShrunk` — a thin bucket leans on the global prior
 * (and is itself 1.0 when there is no reliable prior), so cold-start buckets are
 * weighted by the Beta-Binomial posterior instead of being hard-gated to neutral.
 *
 * `useShrinkage` defaults to the live flag but is injectable for deterministic
 * tests; the fold itself stays pure either way.
 */
export function reversalSignalMultiplier(
  weights: LearnedWeights,
  sig: { score: number; pattern: CandlePattern | null; symbol: string },
  useShrinkage: boolean = isLearnedShrinkageEnabled(),
): number {
  const find = (list: LearnedStat[], key: string): LearnedStat | undefined => list.find((s) => s.key === key);
  const dims = [
    find(weights.byScore, String(sig.score)),
    find(weights.byPattern, sig.pattern ?? 'none'),
    find(weights.bySymbol, sig.symbol),
  ];
  let m = 1;
  for (const d of dims) {
    if (!d) continue;
    if (useShrinkage) m *= d.multiplierShrunk; // neutral 1.0 when no reliable prior
    else if (d.confident) m *= d.multiplier; // hard-gate: confident dims only
  }
  return clamp(m, weights.params.floor, weights.params.ceil);
}
