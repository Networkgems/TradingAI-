import type { CandlePattern } from '@trading-app/engine';
import type { ReversalShadowRecord } from './reversal-shadow-ledger.js';

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
  /** Learned scoring multiplier in [floor, ceil]; 1.0 until `confident`. */
  multiplier: number;
  /** True once `resolved >= minSamples` — the multiplier is allowed to move. */
  confident: boolean;
}

export interface LearnedWeights {
  generatedFrom: { rows: number; resolved: number };
  params: LearnedWeightsParams;
  byScore: LearnedStat[];
  byPattern: LearnedStat[];
  bySymbol: LearnedStat[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Turn one bucket of rows into a learned stat. The multiplier is hit-rate driven
 * (above baseline -> up-weight, below -> down-weight) with a one-sided
 * expectancy penalty so a bucket that "wins often but loses big" (positive hit
 * rate, negative mean R) still gets pulled down. Stays neutral until the bucket
 * clears the min-sample guard.
 */
function statFor(key: string, rows: ReversalShadowRecord[], p: LearnedWeightsParams): LearnedStat {
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
  let multiplier = 1;
  if (confident && hitRate !== null) {
    const hrTerm = p.sensitivity * (hitRate - p.baselineHitRate);
    const rGuard = avgR !== null && avgR < 0 ? p.expectancyPenalty * avgR : 0; // negative only
    multiplier = clamp(1 + hrTerm + rGuard, p.floor, p.ceil);
  }

  return { key, total: rows.length, resolved, tpHit, slHit, timeout, hitRate, avgR, multiplier, confident };
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

  const byScore = [...groupBy(rows, (r) => r.score).entries()]
    .map(([score, list]) => statFor(String(score), list, params))
    .sort(sortStat);
  const byPattern = [...groupBy(rows, patternKey).entries()]
    .map(([pat, list]) => statFor(pat, list, params))
    .sort(sortStat);
  const bySymbol = [...groupBy(rows, (r) => r.symbol).entries()]
    .map(([sym, list]) => statFor(sym, list, params))
    .sort(sortStat);

  return {
    generatedFrom: { rows: rows.length, resolved: rows.filter((r) => r.outcome !== 'OPEN').length },
    params,
    byScore,
    byPattern,
    bySymbol,
  };
}

/**
 * Combined scoring multiplier for a prospective reversal signal. Multiplies the
 * CONFIDENT dimension multipliers (score x pattern x symbol) and clamps the
 * product back into [floor, ceil]. Dimensions still inside the min-sample guard
 * contribute 1.0 (neutral), so a brand-new symbol or rare pattern never distorts
 * the weight until it has earned a track record.
 */
export function reversalSignalMultiplier(
  weights: LearnedWeights,
  sig: { score: number; pattern: CandlePattern | null; symbol: string },
): number {
  const find = (list: LearnedStat[], key: string): LearnedStat | undefined => list.find((s) => s.key === key);
  const dims = [
    find(weights.byScore, String(sig.score)),
    find(weights.byPattern, sig.pattern ?? 'none'),
    find(weights.bySymbol, sig.symbol),
  ];
  let m = 1;
  for (const d of dims) {
    if (d && d.confident) m *= d.multiplier;
  }
  return clamp(m, weights.params.floor, weights.params.ceil);
}
