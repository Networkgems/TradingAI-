// ── External-intel source-quality scorer (TRA-1000) ─────────────────────────
//
// Component 3 of the TRA-996 external-intel program: learn WHO to listen to.
// The twin of `learned-signal-weights.ts` / `learned-option-weights.ts`, but the
// labelled outcome here is the BACKTEST G0 GATE, not a realized trade.
//
// External intel (`external-intel.ts`) writes two append-only logs: an
// attribution log (`hypothesisId → sourceKey`, many ingest occurrences → one
// hypothesis id) and, separately, the hypothesis pipeline's queue
// (`hypothesis-queue.jsonl`) records each hypothesis's G0 grade and any board
// decision. NOTHING reads those gate outcomes back to rank the sources that
// produced them. This module closes that loop: it JOINs attribution against the
// queue, accumulates per-`sourceKey` G0 pass/fail (+ ratified/rejected when a
// board decision has landed), and derives a bounded, min-sample-guarded weight.
//
// Honesty rules, identical to the two trade learners:
//   • Pure + deterministic. Same logs in ⇒ same weights out. No clock, no I/O in
//     the core (the async loader is a thin wrapper over the two log readers).
//   • Min-sample guard. A source's weight stays NEUTRAL (1.0) until it has at
//     least `minSamples` GRADED hypotheses, so a lucky/unlucky handful can't
//     swing it.
//   • Bounded. Every weight is clamped to [floor, ceil].
//   • Sample-size aware + monotonic. The weight is driven by the BETA POSTERIOR
//     MEAN of the gate pass-rate under a uniform Beta(1,1) prior — i.e.
//     (pass + 1) / (graded + 2). At low N it shrinks toward the neutral 0.5
//     prior (one lucky pass can't mint a high-quality source); as evidence
//     accrues it converges on the true pass-rate. It is strictly monotonic:
//     each added pass raises it, each added failure lowers it, so repeated
//     failures deweight a source monotonically. (Wilson's lower bound was the
//     other spec option but over-penalizes the "gains weight" direction at the
//     realistic, scarce gate-pass sample sizes here.)
//
// ADVISORY ONLY (TRA-990 invariants 1 & 2). The weight prioritizes/throttles
// ingestion + extraction effort per source and may rank the ratification queue.
// It NEVER sizes capital, gates promotion, or auto-promotes — every external
// hypothesis still faces the exact same backtest → G0 → board-ratification path
// regardless of its source's weight. There is NO capital path in this file.

import type { AttributionRecord } from './external-intel.js';
import {
  listAllAttribution,
} from './external-intel.js';
import type { PromotionItem } from './hypothesis-pipeline.js';
import { listPromotionItems } from './hypothesis-pipeline.js';

/** Tunables for how source gate-outcomes move a source's advisory weight. */
export interface SourceQualityParams {
  /** Minimum GRADED hypotheses before a source's weight may move off 1.0. */
  minSamples: number;
  /** Gate pass-rate treated as neutral (weight 1.0); also the Beta prior mean. */
  baselinePassRate: number;
  /**
   * Beta prior strength (pseudo-count). The posterior mean is
   * `(pass + priorStrength*baselinePassRate) / (graded + priorStrength)`, so a
   * larger value shrinks a small sample harder toward the neutral baseline.
   */
  priorStrength: number;
  /** Slope: how much one unit of (passRate estimate - baseline) moves the weight. */
  sensitivity: number;
  /** Lower clamp for a source weight. */
  floor: number;
  /** Upper clamp for a source weight. */
  ceil: number;
}

export const DEFAULT_SOURCE_QUALITY_PARAMS: SourceQualityParams = {
  // Gate passes are scarce, so 5 graded hypotheses is enough to start moving a
  // source off neutral without reacting to one or two flukes.
  minSamples: 5,
  baselinePassRate: 0.5,
  // 2 pseudo-observations ⇒ a uniform Beta(1,1) prior: posterior mean is
  // (pass + 1) / (graded + 2). Light enough to converge quickly once a source
  // has a real track record, heavy enough that 1/1 stays modest (0.667).
  priorStrength: 2,
  sensitivity: 1.0,
  floor: 0.5,
  ceil: 1.5,
};

/** Per-source rollup of gate outcomes + the derived advisory weight. */
export interface SourceQualityStat {
  /** Stable per-source key, e.g. `reddit:r/options`. */
  sourceKey: string;
  /** Distinct hypotheses this source surfaced (attribution deduped by hyp id). */
  hypotheses: number;
  /** Of those, how many have a G0 grade recorded in the queue (the sample N). */
  graded: number;
  /** Graded hypotheses that PASSED G0. */
  g0Pass: number;
  /** Graded hypotheses that FAILED G0. */
  g0Fail: number;
  /** Subset of `g0Pass` the board later ratified (when a decision has landed). */
  ratified: number;
  /** Subset of `g0Pass` the board later rejected. */
  rejected: number;
  /** g0Pass / graded (raw point estimate); null when nothing graded yet. */
  gatePassRate: number | null;
  /** Beta posterior mean of the gate pass-rate (drives the weight); null when none graded. */
  passRateEstimate: number | null;
  /** Advisory weight in [floor, ceil]; 1.0 (neutral) until `confident`. */
  weight: number;
  /** True once `graded >= minSamples` — the weight is allowed to move off 1.0. */
  confident: boolean;
}

export interface SourceQualityWeights {
  generatedFrom: { attributions: number; sources: number; graded: number };
  params: SourceQualityParams;
  /** One row per source, ranked by weight desc (who to prioritize listening to). */
  bySource: SourceQualityStat[];
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

/**
 * Beta posterior mean of a binomial pass-rate under a Beta prior centred on
 * `baseline` with total strength `priorStrength`:
 *   (successes + priorStrength*baseline) / (n + priorStrength)
 * Shrinks a small sample toward `baseline` (so one lucky pass can't mint a
 * high-quality source) and converges on `successes/n` as evidence accrues.
 * Strictly increases with each added pass and strictly decreases with each added
 * failure. PURE. `n === 0` ⇒ exactly `baseline` (no evidence ⇒ neutral).
 */
export function passRatePosteriorMean(
  successes: number,
  n: number,
  baseline: number,
  priorStrength: number,
): number {
  return (successes + priorStrength * baseline) / (n + priorStrength);
}

/**
 * Join the attribution log against the hypothesis queue and fold per-source gate
 * outcomes into bounded advisory weights. PURE — pass the two already-loaded logs
 * in; the whole digest is recomputed each call so the weights never drift from
 * the logs.
 *
 * The join dedups by `(sourceKey, hypothesisId)`: many ingest occurrences map to
 * one hypothesis id, and we count each (source, hypothesis) pair ONCE so a source
 * that re-surfaced the same idea ten times doesn't get ten votes. A hypothesis
 * with no queue row yet (attributed but not yet graded) is counted in
 * `hypotheses` but excluded from `graded` and the pass-rate.
 */
export function computeSourceQualityWeights(
  attribution: readonly AttributionRecord[],
  items: readonly PromotionItem[],
  params: SourceQualityParams = DEFAULT_SOURCE_QUALITY_PARAMS,
): SourceQualityWeights {
  const itemById = new Map<string, PromotionItem>();
  for (const it of items) itemById.set(it.hypothesis.id, it);

  // sourceKey → set of distinct hypothesis ids it surfaced.
  const hypsBySource = new Map<string, Set<string>>();
  for (const rec of attribution) {
    const set = hypsBySource.get(rec.sourceKey) ?? new Set<string>();
    set.add(rec.hypothesisId);
    hypsBySource.set(rec.sourceKey, set);
  }

  let totalGraded = 0;
  const bySource: SourceQualityStat[] = [];
  for (const [sourceKey, hypIds] of hypsBySource) {
    let graded = 0;
    let g0Pass = 0;
    let g0Fail = 0;
    let ratified = 0;
    let rejected = 0;
    for (const id of hypIds) {
      const item = itemById.get(id);
      if (!item) continue; // attributed but not yet graded — not part of the sample
      graded += 1;
      if (item.grade.pass) g0Pass += 1;
      else g0Fail += 1;
      if (item.status === 'ratified') ratified += 1;
      else if (item.status === 'rejected') rejected += 1;
    }
    totalGraded += graded;

    const gatePassRate = graded > 0 ? g0Pass / graded : null;
    const passRateEstimate =
      graded > 0
        ? passRatePosteriorMean(g0Pass, graded, params.baselinePassRate, params.priorStrength)
        : null;
    const confident = graded >= params.minSamples;
    let weight = 1;
    if (confident && passRateEstimate !== null) {
      weight = clamp(
        1 + params.sensitivity * (passRateEstimate - params.baselinePassRate),
        params.floor,
        params.ceil,
      );
    }

    bySource.push({
      sourceKey,
      hypotheses: hypIds.size,
      graded,
      g0Pass,
      g0Fail,
      ratified,
      rejected,
      gatePassRate,
      passRateEstimate,
      weight,
      confident,
    });
  }

  // Rank by weight desc (prioritize who to listen to); break ties by sample size
  // then key so the order is stable and deterministic.
  bySource.sort(
    (a, b) =>
      b.weight - a.weight ||
      b.graded - a.graded ||
      a.sourceKey.localeCompare(b.sourceKey),
  );

  return {
    generatedFrom: { attributions: attribution.length, sources: bySource.length, graded: totalGraded },
    params,
    bySource,
  };
}

/**
 * Advisory weight for a single source (1.0 / neutral for an unknown source or
 * one still inside the min-sample guard). For prioritizing ingestion/extraction
 * effort per source and for ranking the ratification queue. NEVER a capital or
 * promotion input — see the module header (invariants 1 & 2).
 */
export function sourceWeightFor(weights: SourceQualityWeights, sourceKey: string): number {
  return weights.bySource.find(s => s.sourceKey === sourceKey)?.weight ?? 1;
}

/**
 * Thin async wrapper: read both append-only logs and fold them. Mirrors the
 * `computeOptionLearnedWeights(await listOptionTradeJournal())` pattern so the
 * health route / EOD caller stays a one-liner.
 */
export async function loadSourceQualityWeights(
  params: SourceQualityParams = DEFAULT_SOURCE_QUALITY_PARAMS,
): Promise<SourceQualityWeights> {
  const [attribution, items] = await Promise.all([listAllAttribution(), listPromotionItems()]);
  return computeSourceQualityWeights(attribution, items, params);
}
