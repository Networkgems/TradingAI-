import {
  DEFAULT_LEARNED_PARAMS,
  type LearnedWeightsParams,
  type BucketStats,
  hardGateMultiplier,
  shrunkMultiplier,
  globalPriorRate,
} from './learned-signal-weights.js';
import { isLearnedShrinkageEnabled } from './learned-shrinkage-flag.js';
import type {
  JournalTrend,
  OptionTradeJournalRecord,
  SentimentIcBand,
} from './option-trade-journal.js';
// TRA-1200 — single home for the DTE band vocabulary lives in the journal
// module (the base layer); re-export it as `dteBand` so the learned-weights
// fold and the journal summary can never split DTE on different thresholds.
import { entryDteBand as dteBand } from './option-trade-journal.js';
// TRA-2937 — the attribution predicate that keeps un-chosen trades out of the
// fold; see `excludedUnattributed` on {@link OptionLearnedWeights.generatedFrom}.
import { isUnattributedImportRow } from './option-trade-journal.js';
export { dteBand };

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
  /**
   * Hard-gate multiplier, kept as `multiplier` for backward-compat (eod-report,
   * etc.). Always equals {@link multiplierHardGate}; the flag-gated switch to the
   * shrunk estimate lives in {@link optionSetupMultiplier}, not in this pure fold.
   */
  multiplier: number;
  /** TRA-1056 — today's behavior: neutral (1.0) until `resolved >= minSamples`. */
  multiplierHardGate: number;
  /**
   * TRA-1056 — Beta-Binomial cold-start estimate: win-rate pulled toward the
   * learner's global pooled `priorRate` (k=minSamples), ceil-tapered to 1.25 while
   * thin, neutral when there is no reliable prior. Surfaced for the QuantTrader A/B
   * diff; feeds the combined multiplier only when the shrinkage flag is on.
   */
  multiplierShrunk: number;
  /** True once `resolved >= minSamples` — the hard-gate multiplier may move. */
  confident: boolean;
}

export interface OptionLearnedWeights {
  /**
   * `priorRate` is the global pooled win-rate fed to the shrinkage estimate, or
   * null when the global pool itself has not cleared `minSamples`.
   */
  generatedFrom: {
    rows: number;
    resolved: number;
    priorRate: number | null;
    /**
     * TRA-2937 — rows DROPPED before the fold because the firm did not choose
     * them (Tradier imports; see {@link isUnattributedImportRow}).
     *
     * Published rather than dropped silently. TRA-2937 made imported positions
     * journal an OPEN so their close (and its exit reason) stops vanishing —
     * which, without this filter, would have started teaching the selector from
     * trades no selector ever picked, with a fabricated trend and no entry
     * delta. A count of 0 must be readable as "there were none", not as "the
     * exclusion is not running", so it is emitted on every call.
     */
    excludedUnattributed: number;
  };
  params: LearnedWeightsParams;
  byStructure: OptionLearnedStat[];
  byIvRank: OptionLearnedStat[];
  byTrend: OptionLearnedStat[];
  bySentiment: OptionLearnedStat[];
  byDte: OptionLearnedStat[];
  /**
   * TRA-993 — 6th fold: by TRA-820 sentiment-IC grade band (`strong` / `weak` /
   * `none`, plus `unknown` for rows with no grade). The skill/quality of the
   * sentiment signal, distinct from {@link bySentiment} (the raw net number).
   * Observe-only: produced for the QuantTrader validation read but deliberately
   * held OUT of {@link optionSetupMultiplier} until TRA-992 Step 3 clears.
   */
  bySentimentIc: OptionLearnedStat[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * IV-rank (0–100) → coarse band the selector's premium gate cares about. A `null`
 * IV-rank (the TRA-1103 honest-unknown RV path, which deliberately does not pay
 * for an ATM-IV chain fetch just to journal) buckets under `unknown`, kept out of
 * the graded low/mid/high buckets — the same pattern as {@link sentimentIcBandKey}.
 */
export function ivRankBand(ivRank: number | null): 'low' | 'mid' | 'high' | 'unknown' {
  if (ivRank === null) return 'unknown';
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


/**
 * TRA-993 — sentiment-IC grade band → fold key. A missing grade (`null`/absent)
 * buckets under `unknown` so ungraded rows are counted separately and never
 * pollute the graded `strong` / `weak` / `none` buckets.
 */
export function sentimentIcBandKey(band: SentimentIcBand | undefined): string {
  return band ?? 'unknown';
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
  priorRate: number | null,
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
  const stats: BucketStats = { resolved, hits: win, rate: winRate, avgR };
  const multiplierHardGate = hardGateMultiplier(stats, p);
  const multiplierShrunk = shrunkMultiplier(stats, priorRate, p);
  const multiplier = multiplierHardGate; // live switch lives in the combined fn

  return {
    key,
    total: rows.length,
    resolved,
    win,
    loss,
    scratch,
    winRate,
    avgR,
    multiplier,
    multiplierHardGate,
    multiplierShrunk,
    confident,
  };
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

  // TRA-2937 — fold only trades the SELECTOR chose. A Tradier-imported row is a
  // real position in the book, but it carries no setup: no IV-rank, no measured
  // entry delta, and a trend regime no gate ever evaluated. Its outcome is
  // therefore an observation of the market, not of our selection rule, and every
  // dimension it would land in (`trend`, `sentiment`, `dte`) is a bucket the live
  // multiplier is read out of.
  //
  // Note this is NOT the censoring TRA-2937 was filed about, it is its mirror.
  // The filed defect was that the imported cohort contributed ENTRIES and never
  // OUTCOMES, biasing the fold toward trades the app kept track of. Journaling
  // the import fixes that asymmetry at the source; dropping the whole row here
  // keeps the fix from over-correcting into the opposite error of learning from
  // un-chosen trades. An engine-opened row that the reconcile re-adopted is NOT
  // excluded — adoption rebinds its close onto the ORIGINAL row, which keeps its
  // real structure label and its real setup, so it re-enters the fold with its
  // outcome attached. That is the de-censoring half.
  const attributed = rows.filter((r) => !isUnattributedImportRow(r));
  const excludedUnattributed = rows.length - attributed.length;

  // Global pooled win-rate is the prior the shrinkage estimate pulls toward, the
  // same across all folds. The fold stays pure (carries both multipliers, reads no
  // flag); the live switch is applied in `optionSetupMultiplier`.
  const isResolved = (r: OptionTradeJournalRecord) => r.outcome !== 'OPEN';
  const priorRate = globalPriorRate(attributed, isResolved, (r) => r.outcome === 'WIN', params);

  const fold = (keyOf: (r: OptionTradeJournalRecord) => string): OptionLearnedStat[] =>
    [...groupBy(attributed, keyOf).entries()]
      .map(([key, list]) => statFor(key, list, priorRate, params))
      .sort(sortStat);

  return {
    generatedFrom: {
      rows: attributed.length,
      resolved: attributed.filter(isResolved).length,
      priorRate,
      excludedUnattributed,
    },
    params,
    byStructure: fold((r) => r.structure),
    byIvRank: fold((r) => ivRankBand(r.ivRank)),
    byTrend: fold((r) => r.trend),
    bySentiment: fold((r) => sentimentBand(r.sentiment)),
    byDte: fold((r) => dteBand(r.entryDte)),
    bySentimentIc: fold((r) => sentimentIcBandKey(r.sentimentIcBand)),
  };
}

/** The prospective setup a multiplier is requested for. */
export interface OptionSetupKey {
  structure: string;
  /**
   * IV-rank 0–100, or `null` for the TRA-1103 honest-unknown RV path (buckets
   * under the fold's `unknown` band via {@link ivRankBand}). Widened from `number`
   * so a journal row's null IV-rank can be scored without being mis-bucketed as
   * `mid`.
   */
  ivRank: number | null;
  trend: JournalTrend;
  sentiment: number | null;
  dte: number;
}

/**
 * TRA-1133 — canonical mapping from a journalled trade back to the prospective
 * setup key the multiplier is scored on. Kept here (next to {@link OptionSetupKey})
 * so the OOS validation harness scores rows on EXACTLY the dimensions the live
 * selector reads, with no parallel mapping to drift.
 */
export function setupKeyFromRow(row: {
  structure: string;
  ivRank: number | null;
  trend: JournalTrend;
  sentiment: number | null;
  entryDte: number;
}): OptionSetupKey {
  return {
    structure: row.structure,
    ivRank: row.ivRank,
    trend: row.trend,
    sentiment: row.sentiment,
    dte: row.entryDte,
  };
}

/**
 * Combined scoring multiplier for a prospective option setup. Multiplies the
 * CONFIDENT dimension multipliers (structure × IV-rank × trend × sentiment ×
 * DTE) and clamps the product back into [floor, ceil]. Dimensions still inside
 * the min-sample guard contribute 1.0, so a brand-new structure or rare regime
 * never distorts the weight until it has earned a track record.
 *
 * TRA-993 — the `bySentimentIc` fold is intentionally NOT one of these factors:
 * it is observe-only and stays out of the combined multiplier until TRA-992
 * Step 3 (gated on QuantTrader's validation read) wires it into a decision.
 *
 * TRA-1056 — default (`ENABLE_LEARNED_WEIGHT_SHRINKAGE` OFF) is the hard-gate path
 * (confident dims only). With the flag on, every dimension contributes its
 * `multiplierShrunk` (cold-start Beta-Binomial posterior, neutral when no reliable
 * prior). `useShrinkage` defaults to the live flag but is injectable for tests.
 */
export function optionSetupMultiplier(
  weights: OptionLearnedWeights,
  setup: OptionSetupKey,
  useShrinkage: boolean = isLearnedShrinkageEnabled(),
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
    if (!d) continue;
    if (useShrinkage) m *= d.multiplierShrunk; // neutral 1.0 when no reliable prior
    else if (d.confident) m *= d.multiplier; // hard-gate: confident dims only
  }
  return clamp(m, weights.params.floor, weights.params.ceil);
}
