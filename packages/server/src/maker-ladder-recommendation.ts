// TRA-1982 (parent TRA-1967 item 3) — DATA-DRIVEN maker-ladder recommendation.
//
// The maker-walk ladder (`tradier-smart-open.ts` buildWalkLimits / derivePricingPath,
// configured by `option-maker-config.ts`) still ships the static TRA-374 defaults —
// `fractions = [0,0.25,0.5,0.75,1]`, `stepWaitMs = 30_000`, `maxCrossTicks = 0`. Those
// were never tuned against how the ladder actually fills; the maker-fill telemetry
// ledger (`option-maker-fill-ledger.ts`) has been recording the outcomes — which walk
// step fills, realised-vs-mid by step, time-to-fill — precisely so the schedule can be
// RE-DERIVED from measurement instead of guessed.
//
// This module is that re-derivation, modelled on the option-spread-cost probe
// (`option-spread-cost.ts`): a PURE fold of the raw ledger into a read-only ladder
// recommendation. It NEVER routes an order and NEVER mutates the config — the flip from
// recommendation to live config is a separate, governance-gated step (TRA-1967). The
// derivation is echoed alongside the current config and the per-step histogram so a
// reviewer can audit every recommended number against the raw `option-maker-fills.jsonl`.
//
// ── WHAT IS SAFE TO RECOMMEND FROM FILL DATA (and what is NOT) ────────────────
// A `filled` event carries the step that filled; a chase that DIDN'T fill (walk_exhausted)
// carries no step. So the histogram is "where fills landed", not "conditional fill
// probability at each step reached". That asymmetry bounds what we can honestly propose:
//
//   • DROP an INTERIOR step only when its fill share is negligible — an interior step
//     that essentially never fills only costs a wait window; removing it makes the walk
//     reach the ask FASTER without abandoning fills (a chase that would have filled there
//     is rare by construction). We NEVER drop the opener (step 0) or the ask (the terminal
//     fraction 1.0): dropping the ask would stop the walk short of the market-equivalent
//     backstop and REDUCE fills — the opposite of tuning.
//   • stepWaitMs from the per-step fill latency: if fills that DO happen arrive well
//     inside the window, the window can be shortened so the walk reaches deeper steps
//     sooner; if they arrive near the end, the window is about right. (The latency is a
//     proxy — see perStepLatency note.)
//   • maxCrossTicks only where cross-tick fills were actually OBSERVED. A cross-tick fill
//     can only exist if the config that produced the data already ran maxCrossTicks > 0;
//     with the default 0 the walk never crosses the ask, so there is no data to justify
//     RAISING it from 0 — that requires a deliberate experiment, not this fold.
//
// ── TIER LIMITATION (honest scope of v1) ─────────────────────────────────────
// The parent asks "e.g. per-liquidity-tier fraction schedule". The maker-fill ledger event
// does NOT carry a liquidity tier (only side/symbol/step/slippage/latency), so a per-tier
// schedule cannot be derived here without first stamping a tier on the fill event. This v1
// recommends per SIDE (open/close), which is what the recorded data supports; the per-tier
// split is called out in `tierLimitation` as the follow-up.

import {
  type MakerFillEvent,
  type MakerFillSide,
} from './option-maker-fill-ledger.js';
import {
  type MakerWalkConfig,
  MAKER_MAX_CROSS_TICKS_LIMIT,
} from './option-maker-config.js';

/** Minimum measured fills (carrying a walk step) before a side yields an actionable recommendation. */
export const DEFAULT_MIN_LADDER_SAMPLES = 30;
/** An interior step whose share of fills is below this is treated as a dead wait window and dropped. */
export const DEFAULT_MIN_STEP_SHARE = 0.05;
/** Never recommend a wait window shorter than this — a floor so a fast-fill cohort can't collapse the walk. */
export const MIN_RECOMMENDED_STEP_WAIT_MS = 2_000;
/** Never recommend a wait window longer than this — bounds a slow-fill tail from stalling the walk. */
export const MAX_RECOMMENDED_STEP_WAIT_MS = 120_000;

export interface LadderRecommendationOptions {
  /** Fills-with-step floor per side before `status: 'ok'`. Default {@link DEFAULT_MIN_LADDER_SAMPLES}. */
  minSamples?: number;
  /** Interior-step fill-share drop threshold. Default {@link DEFAULT_MIN_STEP_SHARE}. */
  minStepShare?: number;
}

/** Per-walk-step fill statistics, the auditable backbone of the recommendation. */
export interface StepFillStat {
  /** 0-indexed walk step. `step >= fractions.length` is a bounded cross-tick step past the ask. */
  step: number;
  /** True when this step sits past the ask (a `maxCrossTicks` cross-tick step). */
  isCrossTick: boolean;
  /** Fills recorded at this step. */
  fills: number;
  /** `fills ÷ filledWithStep` for the side — the share this step carries. */
  shareOfFills: number;
  /** Mean signed realised-vs-mid USD at this step (positive = cost); null when none measured. */
  avgRealizedVsMidUsd: number | null;
  /** Mean total time-to-fill ms at this step; null when none measured. */
  avgTimeToFillMs: number | null;
  /** Mean per-step latency proxy (`timeToFillMs ÷ (step+1)`) at this step; null when none measured. */
  avgPerStepLatencyMs: number | null;
}

/** The recommended ladder params for one side, or null when data is insufficient. */
export interface LadderParamRecommendation {
  /** Recommended walk fractions (interior dead steps dropped; opener + ask preserved). */
  fractions: number[];
  /** True iff `fractions` differs from the current config. */
  fractionsChanged: boolean;
  /** How many interior steps were dropped as dead wait windows. */
  droppedInteriorSteps: number;
  /** Recommended per-attempt wait window, ms. */
  stepWaitMs: number;
  /** True iff `stepWaitMs` differs from the current config. */
  stepWaitMsChanged: boolean;
  /** The p90 per-step latency proxy the wait was derived from; null when none measured. */
  perStepLatencyP90Ms: number | null;
  /** Recommended cross-tick tail (only where cross-tick fills were observed). */
  maxCrossTicks: number;
  /** True iff `maxCrossTicks` differs from the current config. */
  maxCrossTicksChanged: boolean;
  /** Human-readable derivation summary. */
  rationale: string;
}

/** Per-side (open/close) recommendation and the evidence it rests on. */
export interface SideLadderRecommendation {
  side: MakerFillSide;
  /** Total chases recorded for this side (the fill-rate denominator). */
  chases: number;
  /** Chases that reached a `filled` terminal. */
  fills: number;
  /** `fills ÷ chases`, 0 when no chases. */
  fillRate: number;
  /** Fills carrying a measurable walk step — the recommendation denominator. */
  filledWithStep: number;
  /** Per-step fill histogram, ascending by step. */
  stepHistogram: StepFillStat[];
  /** Deepest step that ever filled; null when no measured fills. */
  deepestFillStep: number | null;
  /** Whether any fill landed on a cross-tick step (past the ask). */
  crossTickFillsObserved: boolean;
  /** `ok` once `filledWithStep >= minSamples`, else `insufficient_data`. */
  status: 'ok' | 'insufficient_data';
  /** Null under `insufficient_data` — keep the current config until enough fills accrue. */
  recommendation: LadderParamRecommendation | null;
}

/** The current ladder config echoed for audit (the recommendation is deltas against this). */
export interface CurrentLadderConfig {
  fractions: number[];
  stepWaitMs: number;
  maxCrossTicks: number;
  tickSize: number;
}

/** Top-level read-only recommendation payload. */
export interface MakerLadderRecommendation {
  minSamples: number;
  minStepShare: number;
  /** Current resolved ladder config the recommendation is measured against. */
  current: CurrentLadderConfig;
  open: SideLadderRecommendation;
  close: SideLadderRecommendation;
  /** Why v1 is per-side and not per-liquidity-tier (the ledger event carries no tier). */
  tierLimitation: string;
  /** Reader guidance: recommendation-only; the flip is governance-gated. */
  note: string;
}

function meanOrNull(xs: number[]): number | null {
  if (xs.length === 0) return null;
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function quantile(sortedAsc: readonly number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  if (sortedAsc.length === 1) return sortedAsc[0] as number;
  const idx = (sortedAsc.length - 1) * p;
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  const loV = sortedAsc[lo] as number;
  if (lo === hi) return loV;
  const hiV = sortedAsc[hi] as number;
  return loV + (hiV - loV) * (idx - lo);
}

function finiteOr(n: number | undefined): number | null {
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

/**
 * Build the per-side step histogram from the `filled` events that carry a measurable
 * walk step. Steps at or beyond `fractionCount` are cross-tick steps past the ask.
 */
function buildStepHistogram(
  filledWithStep: MakerFillEvent[],
  fractionCount: number,
): StepFillStat[] {
  const denom = filledWithStep.length;
  const byStep = new Map<number, MakerFillEvent[]>();
  for (const e of filledWithStep) {
    const step = e.walk as number;
    const bucket = byStep.get(step) ?? [];
    bucket.push(e);
    byStep.set(step, bucket);
  }
  const steps = Array.from(byStep.keys()).sort((a, b) => a - b);
  return steps.map((step) => {
    const rows = byStep.get(step) ?? [];
    const slips = rows.map((r) => finiteOr(r.realizedVsMidUsd)).filter((v): v is number => v !== null);
    const times = rows.map((r) => finiteOr(r.timeToFillMs)).filter((v): v is number => v !== null);
    const perStep = rows
      .map((r) => {
        const t = finiteOr(r.timeToFillMs);
        return t === null ? null : t / (step + 1);
      })
      .filter((v): v is number => v !== null);
    return {
      step,
      isCrossTick: step >= fractionCount,
      fills: rows.length,
      shareOfFills: denom > 0 ? rows.length / denom : 0,
      avgRealizedVsMidUsd: meanOrNull(slips),
      avgTimeToFillMs: meanOrNull(times),
      avgPerStepLatencyMs: meanOrNull(perStep),
    };
  });
}

/**
 * Derive the recommended ladder params for one side from its histogram + latency data.
 * Called only once the side clears `minSamples` (so the caller returns `null` below the
 * floor). The rules are exactly the "SAFE TO RECOMMEND" set in the file header.
 */
function deriveRecommendation(
  filledWithStep: MakerFillEvent[],
  histogram: StepFillStat[],
  config: MakerWalkConfig,
  minStepShare: number,
): LadderParamRecommendation {
  const fractions = [...config.fractions];
  const lastIdx = fractions.length - 1;
  const shareByStep = new Map<number, number>();
  for (const h of histogram) shareByStep.set(h.step, h.shareOfFills);

  // Fractions: always keep the opener (0) and the ask (last fraction); drop only interior
  // steps whose fill share is below the threshold (dead wait windows). Never touches the
  // envelope, so the walk still ends at the ask.
  const keptFractions: number[] = [];
  let droppedInteriorSteps = 0;
  for (let i = 0; i < fractions.length; i += 1) {
    if (i === 0 || i === lastIdx) {
      keptFractions.push(fractions[i] as number);
      continue;
    }
    const share = shareByStep.get(i) ?? 0;
    if (share >= minStepShare) keptFractions.push(fractions[i] as number);
    else droppedInteriorSteps += 1;
  }
  const fractionsChanged =
    keptFractions.length !== fractions.length ||
    keptFractions.some((f, i) => f !== fractions[i]);

  // maxCrossTicks: the deepest cross-tick step (past the ask) that carries a material
  // share of fills. With the default maxCrossTicks = 0 the walk never crosses, so there
  // are no cross-tick fills and this stays 0 (we never RAISE from 0 without data).
  let recommendedCrossTicks = 0;
  for (const h of histogram) {
    if (h.isCrossTick && h.shareOfFills >= minStepShare) {
      recommendedCrossTicks = Math.max(recommendedCrossTicks, h.step - lastIdx);
    }
  }
  recommendedCrossTicks = Math.min(recommendedCrossTicks, MAKER_MAX_CROSS_TICKS_LIMIT);

  // stepWaitMs: p90 of the per-step latency proxy, clamped to a sane band. Filling that
  // typically lands well inside the current window ⇒ a shorter window reaches deeper steps
  // sooner without abandoning fills.
  const perStepLatencies = filledWithStep
    .map((e) => {
      const t = finiteOr(e.timeToFillMs);
      const step = e.walk as number;
      return t === null ? null : t / (step + 1);
    })
    .filter((v): v is number => v !== null)
    .sort((a, b) => a - b);
  const p90 = quantile(perStepLatencies, 0.9);
  const recommendedWait =
    p90 === null
      ? config.stepWaitMs
      : Math.min(
          MAX_RECOMMENDED_STEP_WAIT_MS,
          Math.max(MIN_RECOMMENDED_STEP_WAIT_MS, Math.round(p90)),
        );

  const rationaleParts: string[] = [];
  if (fractionsChanged) {
    rationaleParts.push(
      `dropped ${droppedInteriorSteps} interior step(s) with fill share < ${(minStepShare * 100).toFixed(0)}% (dead wait windows; opener + ask preserved)`,
    );
  } else {
    rationaleParts.push('every interior step carries a material fill share — schedule kept');
  }
  if (p90 !== null) {
    const dir =
      recommendedWait < config.stepWaitMs ? 'shorten' : recommendedWait > config.stepWaitMs ? 'lengthen' : 'unchanged';
    rationaleParts.push(
      `stepWaitMs ${dir} → ${recommendedWait}ms from p90 per-step fill latency ${Math.round(p90)}ms (proxy: timeToFill ÷ (step+1))`,
    );
  } else {
    rationaleParts.push('no measured time-to-fill — stepWaitMs kept');
  }
  rationaleParts.push(
    recommendedCrossTicks > 0
      ? `cross-tick fills observed — maxCrossTicks ${recommendedCrossTicks}`
      : 'no cross-tick fills observed — maxCrossTicks 0 (raising from 0 needs a deliberate experiment, not this fold)',
  );

  return {
    fractions: keptFractions,
    fractionsChanged,
    droppedInteriorSteps,
    stepWaitMs: recommendedWait,
    stepWaitMsChanged: recommendedWait !== config.stepWaitMs,
    perStepLatencyP90Ms: p90 === null ? null : Math.round(p90),
    maxCrossTicks: recommendedCrossTicks,
    maxCrossTicksChanged: recommendedCrossTicks !== config.maxCrossTicks,
    rationale: rationaleParts.join('; '),
  };
}

function summarizeSide(
  events: MakerFillEvent[],
  side: MakerFillSide,
  config: MakerWalkConfig,
  minSamples: number,
  minStepShare: number,
): SideLadderRecommendation {
  const sideEvents = events.filter((e) => e.side === side);
  const fills = sideEvents.filter((e) => e.result === 'filled');
  const filledWithStep = fills.filter(
    (e) => typeof e.walk === 'number' && Number.isFinite(e.walk) && (e.walk as number) >= 0,
  );
  const histogram = buildStepHistogram(filledWithStep, config.fractions.length);
  const deepestFillStep =
    filledWithStep.length > 0 ? Math.max(...filledWithStep.map((e) => e.walk as number)) : null;
  const crossTickFillsObserved = histogram.some((h) => h.isCrossTick && h.fills > 0);
  const status: 'ok' | 'insufficient_data' =
    filledWithStep.length >= minSamples ? 'ok' : 'insufficient_data';
  return {
    side,
    chases: sideEvents.length,
    fills: fills.length,
    fillRate: sideEvents.length > 0 ? fills.length / sideEvents.length : 0,
    filledWithStep: filledWithStep.length,
    stepHistogram: histogram,
    deepestFillStep,
    crossTickFillsObserved,
    status,
    recommendation:
      status === 'ok'
        ? deriveRecommendation(filledWithStep, histogram, config, minStepShare)
        : null,
  };
}

/**
 * PURE fold of the raw maker-fill events into the read-only ladder recommendation.
 * `config` is the currently-resolved {@link MakerWalkConfig} (threaded in, not read from
 * env, so the fold stays testable) and the recommendation is expressed as deltas against
 * it. No IO, no order routing, no config mutation. See the file header for the exact set
 * of params that fill data can safely tune.
 */
export function buildMakerLadderRecommendation(
  events: readonly MakerFillEvent[],
  config: MakerWalkConfig,
  options: LadderRecommendationOptions = {},
): MakerLadderRecommendation {
  const minSamples = options.minSamples ?? DEFAULT_MIN_LADDER_SAMPLES;
  const minStepShare = options.minStepShare ?? DEFAULT_MIN_STEP_SHARE;
  const list = [...events];
  return {
    minSamples,
    minStepShare,
    current: {
      fractions: [...config.fractions],
      stepWaitMs: config.stepWaitMs,
      maxCrossTicks: config.maxCrossTicks,
      tickSize: config.tickSize,
    },
    open: summarizeSide(list, 'open', config, minSamples, minStepShare),
    close: summarizeSide(list, 'close', config, minSamples, minStepShare),
    tierLimitation:
      'v1 recommends per SIDE (open/close). The maker-fill ledger event carries no liquidity tier, '
      + 'so a per-liquidity-tier fraction schedule needs a tier stamp on the fill event first (follow-up).',
    note:
      'Recommendation-only, re-derived from the raw option-maker-fills ledger — nothing here mutates the '
      + 'live ladder config. Applying a recommendation is a separate governance-gated step (TRA-1967).',
  };
}
