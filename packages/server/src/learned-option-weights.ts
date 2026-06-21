import {
  DEFAULT_LEARNED_PARAMS,
  type LearnedWeightsParams,
} from './learned-signal-weights.js';
import type {
  JournalTrend,
  OptionTradeJournalRecord,
} from './option-trade-journal.js';

// TRA-990 (Learning B) — fold the option-trade journal into learned, bounded
// scoring weights, the options analog of `learned-signal-weights.ts`.
//
// The journal (`option-trade-journal.ts`) RECORDS every option setup and its
// realized WIN/LOSS/SCRATCH outcome; nothing reads those outcomes back into the
// next decision. This module closes that loop: it folds the journal into
// per-dimension stats (by structure, IV-rank band, trend regime, sentiment band,
// DTE band) and derives a bounded multiplier for each dimension value so the
// selector/agent can lean INTO setups the firm has actually profited from and
// AWAY from ones that bled.
//
// Same honesty rules as the reversal learner — pure + deterministic, neutral
// (1.0) until a dimension clears the min-sample guard, every multiplier clamped
// to [floor, ceil], and the combined product clamped again. It SCORES, it never
// gates: there is no capital path in this file. Reuses `LearnedWeightsParams`
// and `DEFAULT_LEARNED_PARAMS` verbatim so the two learners stay calibrated the
// same way (`baselineHitRate` 0.5 reads as a neutral 50% option win-rate).

export { DEFAULT_LEARNED_PARAMS, type LearnedWeightsParams };

/** One learned dimension value (e.g. structure=bull_put, ivRank=high). */
export interface OptionLearnedStat {
  /** Dimension value rendered as a string key. */
  key: string;
  /** All rows in this bucket, including still-OPEN trades. */
  total: number;
  /** Rows with a realized outcome (excludes OPEN). */
  resolved: number;
  win: number;
  loss: number;
  scratch: number;
  /** WIN / resolved over resolved rows; null when none resolved. */
  winRate: number | null;
  /** Mean realized R over resolved rows; null when none resolved. */
  avgR: number | null;
  /** Learned scoring multiplier in [floor, ceil]; 1.0 until `confident`. */
  multiplier: number;
  /** True once `resolved >= minSamples` — the multiplier is allowed to move. */
  confident: boolean;
}

export interface OptionLearnedWeights {
  generatedFrom: { rows: number; resolved: number };
  params: LearnedWeightsParams;
  byStructure: OptionLearnedStat[];
  byIvRank: OptionLearnedStat[];
  byTrend: OptionLearnedStat[];
  bySentiment: OptionLearnedStat[];
  byDte: OptionLearnedStat[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/** IV-rank (0–100) → coarse band the selector's premium gate cares about. */
export function ivRankBand(ivRank: number): 'low' | 'mid' | 'high' {
  if (ivRank >= 50) return 'high';
  if (ivRank <= 25) return 'low';
  return 'mid';
}

/** Net sentiment [-1,+1] (or null) → directional band. */
export function sentimentBand(sentiment: number | null): 'bearish' | 'neutral' | 'bullish' {
  if (sentiment === null) return 'neutral';
  if (sentiment > 0.15) return 'bullish';
  if (sentiment < -0.15) return 'bearish';
  return 'neutral';
}

/** Entry DTE → band around the engine's [30,45] preferred entry window. */
export function dteBand(dte: number): 'lt30' | '30to45' | 'gt45' {
  if (dte < 30) return 'lt30';
  if (dte > 45) return 'gt45';
  return '30to45';
}

/**
 * Turn one bucket of journal rows into a learned stat. Win-rate driven (above
 * baseline -> up-weight, below -> down-weight) with a one-sided expectancy
 * penalty so a bucket that "wins often but loses big" (positive win rate,
 * negative mean R) still gets pulled down. Neutral until the min-sample guard
 * clears. This is the option-record twin of `learned-signal-weights.ts:statFor`.
 */
function statFor(
  key: string,
  rows: OptionTradeJournalRecord[],
  p: LearnedWeightsParams,
): OptionLearnedStat {
  const resolvedRows = rows.filter((r) => r.outcome !== 'OPEN');
  const resolved = resolvedRows.length;
  const win = resolvedRows.filter((r) => r.outcome === 'WIN').length;
  const loss = resolvedRows.filter((r) => r.outcome === 'LOSS').length;
  const scratch = resolvedRows.filter((r) => r.outcome === 'SCRATCH').length;
  const winRate = resolved > 0 ? win / resolved : null;
  const avgR =
    resolved > 0
      ? resolvedRows.reduce((acc, r) => acc + (r.realizedR ?? 0), 0) / resolved
      : null;

  const confident = resolved >= p.minSamples;
  let multiplier = 1;
  if (confident && winRate !== null) {
    const hrTerm = p.sensitivity * (winRate - p.baselineHitRate);
    const rGuard = avgR !== null && avgR < 0 ? p.expectancyPenalty * avgR : 0; // negative only
    multiplier = clamp(1 + hrTerm + rGuard, p.floor, p.ceil);
  }

  return { key, total: rows.length, resolved, win, loss, scratch, winRate, avgR, multiplier, confident };
}

function groupBy<T>(
  rows: OptionTradeJournalRecord[],
  keyOf: (r: OptionTradeJournalRecord) => T,
): Map<T, OptionTradeJournalRecord[]> {
  const m = new Map<T, OptionTradeJournalRecord[]>();
  for (const r of rows) {
    const k = keyOf(r);
    const list = m.get(k) ?? [];
    list.push(r);
    m.set(k, list);
  }
  return m;
}

/**
 * Fold the journal into learned per-dimension multipliers. The whole digest is
 * computed from the rows on every call, so the weights are always current and no
 * persisted snapshot can drift from the journal.
 */
export function computeOptionLearnedWeights(
  rows: OptionTradeJournalRecord[],
  params: LearnedWeightsParams = DEFAULT_LEARNED_PARAMS,
): OptionLearnedWeights {
  const sortStat = (a: OptionLearnedStat, b: OptionLearnedStat) =>
    a.key.localeCompare(b.key, undefined, { numeric: true });
  const fold = (keyOf: (r: OptionTradeJournalRecord) => string): OptionLearnedStat[] =>
    [...groupBy(rows, keyOf).entries()]
      .map(([key, list]) => statFor(key, list, params))
      .sort(sortStat);

  return {
    generatedFrom: { rows: rows.length, resolved: rows.filter((r) => r.outcome !== 'OPEN').length },
    params,
    byStructure: fold((r) => r.structure),
    byIvRank: fold((r) => ivRankBand(r.ivRank)),
    byTrend: fold((r) => r.trend),
    bySentiment: fold((r) => sentimentBand(r.sentiment)),
    byDte: fold((r) => dteBand(r.entryDte)),
  };
}

/** The prospective setup a multiplier is requested for. */
export interface OptionSetupKey {
  structure: string;
  ivRank: number;
  trend: JournalTrend;
  sentiment: number | null;
  dte: number;
}

/**
 * Combined scoring multiplier for a prospective option setup. Multiplies the
 * CONFIDENT dimension multipliers (structure × IV-rank × trend × sentiment ×
 * DTE) and clamps the product back into [floor, ceil]. Dimensions still inside
 * the min-sample guard contribute 1.0, so a brand-new structure or rare regime
 * never distorts the weight until it has earned a track record.
 */
export function optionSetupMultiplier(
  weights: OptionLearnedWeights,
  setup: OptionSetupKey,
): number {
  const find = (list: OptionLearnedStat[], key: string): OptionLearnedStat | undefined =>
    list.find((s) => s.key === key);
  const dims = [
    find(weights.byStructure, setup.structure),
    find(weights.byIvRank, ivRankBand(setup.ivRank)),
    find(weights.byTrend, setup.trend),
    find(weights.bySentiment, sentimentBand(setup.sentiment)),
    find(weights.byDte, dteBand(setup.dte)),
  ];
  let m = 1;
  for (const d of dims) {
    if (d && d.confident) m *= d.multiplier;
  }
  return clamp(m, weights.params.floor, weights.params.ceil);
}
