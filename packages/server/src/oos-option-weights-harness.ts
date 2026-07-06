// TRA-1133 (TRA-992 Step 1 tooling) — OUT-OF-SAMPLE validation harness for the
// learned option-setup weights.
//
// The option-trade journal (`option-trade-journal.ts`) records every setup→outcome
// pair; `learned-option-weights.ts` folds it into bounded per-dimension multipliers
// the selector can lean on. The open question TRA-992 asks is whether those learned
// multipliers carry REAL forward edge or just fit the noise in a thin journal. This
// module answers it the only honest way — out of sample — and reports a verdict
// against QuantTrader's pre-registered protocol.
//
// For each RESOLVED row it computes the multiplier that row's setup WOULD have been
// scored with had that row never existed:
//   - leave-one-out: fold the journal excluding the scored row, then score it;
//   - time-split: fold only rows closed strictly before T, score rows closed >= T.
// Either way the OOS multiplier comes from the REAL `computeOptionLearnedWeights` /
// `optionSetupMultiplier` (imported, never reimplemented) so the harness measures
// the deployed math, not a copy of it.
//
// Rows are then bucketed by their OOS multiplier (up-weighted / down-weighted /
// neutral) and the up-minus-down realized-R expectancy gap is bootstrapped for a
// 90% CI. The whole module is PURE + deterministic (seeded bootstrap, no clock, no
// I/O) so it is unit-testable on synthetic fixtures and a routine can capture it
// headless. It SCORES nothing live — observe/measure only (TRA-990 invariant 1).

import {
  computeOptionLearnedWeights,
  optionSetupMultiplier,
  setupKeyFromRow,
  DEFAULT_LEARNED_PARAMS,
  type LearnedWeightsParams,
  type OptionLearnedWeights,
  type OptionLearnedStat,
} from './learned-option-weights.js';
import type { OptionTradeJournalRecord, OptionTradeOutcome } from './option-trade-journal.js';

// ── pre-registered protocol constants (TRA-992 comment; do NOT invent new ones) ─

/** OOS multiplier strictly above this → the setup was UP-weighted. */
export const UP_THRESHOLD = 1.05;
/** OOS multiplier strictly below this → the setup was DOWN-weighted. */
export const DOWN_THRESHOLD = 0.95;
/** Verdict can only be REAL with at least this many resolved rows total. */
export const MIN_RESOLVED_TOTAL = 30;
/** Verdict can only be REAL with at least this many rows in EACH non-neutral cohort. */
export const MIN_PER_COHORT = 12;
/** Bootstrap confidence level for the expectancy-gap CI. */
export const CI_LEVEL = 0.9;
/** Bootstrap resample count — fixed so the report is reproducible. */
export const BOOTSTRAP_ITERATIONS = 2000;
/** Bootstrap RNG seed — fixed so the CI is deterministic across runs. */
export const BOOTSTRAP_SEED = 0x1133;

// ── TRA-1321 protocol v2 (expectancy mode) constants ────────────────────────────
// The legacy path scores every row against a fixed `baselineHitRate = 0.5`. In the
// single-leg long-option family every confident bucket wins < 50% (best 35.5%), so
// every dimension multiplier lands < 1.0 and the composite clamps to the 0.50 floor
// for ALL rows — the up-cohort is mathematically un-formable (`up.n = 0`) at any
// sample size. Protocol v2 (TRA-1284 Option A) recalibrates the null to the family's
// own realized base rate and compares cohorts on realized-R expectancy, not hit-rate.

/**
 * In expectancy mode the cohort split is around a multiplier of exactly 1.0 (recalibrated
 * "no edge vs the family's own average"), not the legacy ±0.05 dead-band — the whole
 * point of the recalibration is that 1.0 is the economically meaningful null.
 */
export const EXPECTANCY_COHORT_THRESHOLD = 1.0;
/**
 * A per-structure baseline is only used when that structure carries at least this many
 * DECISIVE (WIN+LOSS) rows; thinner structures fall back to the pooled family baseline.
 */
export const MIN_DECISIVE_PER_STRUCTURE = 12;

export type Cohort = 'up' | 'down' | 'neutral';

/** A resolved journal row scored with its out-of-sample multiplier. */
export interface ScoredRow {
  id: string;
  symbol: string;
  structure: string;
  outcome: OptionTradeOutcome;
  realizedR: number;
  /** OOS multiplier the row's setup was scored with (its own row excluded). */
  oosMultiplier: number;
  cohort: Cohort;
}

/** Per-cohort rollup over scored rows. */
export interface CohortStat {
  cohort: Cohort;
  n: number;
  /** Mean realized R; null when the cohort is empty. */
  meanR: number | null;
  /** WIN / n; null when the cohort is empty. */
  hitRate: number | null;
}

/** Bootstrapped up-minus-down expectancy gap with a `CI_LEVEL` CI. */
export interface ExpectancyGap {
  /** Point estimate: meanR(up) − meanR(down). null when either cohort is empty. */
  gap: number | null;
  ciLower: number | null;
  ciUpper: number | null;
  level: number;
  iterations: number;
}

export type Verdict = 'REAL' | 'INCONCLUSIVE' | 'NOISE';

/** One bucket of one diagnostic dimension (mirrors `OptionLearnedStat`). */
export interface DimensionBucket {
  key: string;
  resolved: number;
  winRate: number | null;
  avgR: number | null;
  /** Cleared the `minSamples` guard (the hard-gate multiplier may move). */
  clearedMinSamples: boolean;
  multiplierHardGate: number;
  multiplierShrunk: number;
}

/** Per-dimension diagnostic (structure / ivRank / trend / sentiment / sentimentIc / dte). */
export interface DimensionDiagnostic {
  dimension: string;
  buckets: DimensionBucket[];
}

export type SplitMode = 'loo' | 'time-split';

export interface OosHarnessOptions {
  mode?: SplitMode;
  /** time-split boundary (ms-epoch close ts); required when `mode === 'time-split'`. */
  splitTs?: number;
  /**
   * Whether the OOS multiplier uses the shrinkage path. Defaults to the hard-gate
   * path (`false`) — the conservative deployed default — and is recorded in the
   * report so the read is unambiguous. Not the live flag, to keep the harness
   * deterministic regardless of process env.
   */
  useShrinkage?: boolean;
  params?: LearnedWeightsParams;
  bootstrapIterations?: number;
  bootstrapSeed?: number;
  ciLevel?: number;
  /**
   * TRA-1321 — protocol v2. When true the harness recalibrates the neutral baseline
   * from the fixed 0.5 to the family's own decisive base rate, scores rows on a
   * decisive-basis fold, and grades the up-vs-down realized-R expectancy gap with a
   * median-split fallback. Legacy path (`false`, the default) is untouched.
   */
  expectancy?: boolean;
}

/** TRA-1321 — the recalibrated null the expectancy mode scores against. */
export interface BaselineCalibration {
  /** Pooled decisive win-rate WIN/(WIN+LOSS) over the resolved set; null when no decisive rows. */
  pooled: number | null;
  /** Per-structure decisive win-rate, only for structures with >= MIN_DECISIVE_PER_STRUCTURE decisive rows. */
  perStructure: Record<string, number>;
  /** True when at least one structure qualified for its own baseline. */
  usedPerStructure: boolean;
  /** Count of DECISIVE (WIN+LOSS) rows the baseline was formed over. */
  decisiveResolved: number;
}

/** TRA-1321 — the expectancy-mode read attached to the report when `expectancy` is on. */
export interface ExpectancyRead {
  enabled: true;
  baseline: BaselineCalibration;
  /**
   * `absolute` — cohorts split at multiplier 1.0. `median` — the absolute split
   * degenerated (a cohort under the per-cohort bar) so rows were split into
   * bottom-half / top-half by the median composite multiplier instead.
   */
  cohortBasis: 'absolute' | 'median';
  /** Distinct OOS multiplier values across scored rows — 1 means no signal to split on. */
  distinctMultipliers: number;
}

export interface OosReport {
  issue: 'TRA-1133';
  parent: 'TRA-992';
  mode: SplitMode;
  splitTs: number | null;
  useShrinkage: boolean;
  params: LearnedWeightsParams;
  thresholds: {
    up: number;
    down: number;
    minResolvedTotal: number;
    minPerCohort: number;
    ciLevel: number;
  };
  sample: {
    rowsTotal: number;
    resolvedTotal: number;
    scored: number;
  };
  cohorts: Record<Cohort, CohortStat>;
  gap: ExpectancyGap;
  verdict: Verdict;
  verdictReasons: string[];
  scoredRows: ScoredRow[];
  /** Secondary diagnostic across every fold dimension. */
  dimensions: DimensionDiagnostic[];
  /** TRA-992 Step 2 read: the `bySentimentIc` fold in isolation. */
  sentimentIcRead: DimensionDiagnostic;
  /** TRA-1321 — present only when protocol-v2 expectancy mode is on. */
  expectancy?: ExpectancyRead;
}

// ── helpers ──────────────────────────────────────────────────────────────────

/** Resolved rows usable for OOS scoring (closed AND carrying a realized R). */
export function resolvedRows(rows: OptionTradeJournalRecord[]): OptionTradeJournalRecord[] {
  return rows.filter((r) => r.outcome !== 'OPEN' && typeof r.realizedR === 'number');
}

export function cohortOf(multiplier: number): Cohort {
  if (multiplier > UP_THRESHOLD) return 'up';
  if (multiplier < DOWN_THRESHOLD) return 'down';
  return 'neutral';
}

/** TRA-1321 — expectancy-mode cohort split around the recalibrated null of 1.0. */
export function expectancyCohortOf(multiplier: number): Cohort {
  if (multiplier > EXPECTANCY_COHORT_THRESHOLD) return 'up';
  if (multiplier < EXPECTANCY_COHORT_THRESHOLD) return 'down';
  return 'neutral';
}

/** True for a row that resolved decisively (WIN or LOSS — a SCRATCH is not decisive). */
function isDecisive(r: OptionTradeJournalRecord): boolean {
  return r.outcome === 'WIN' || r.outcome === 'LOSS';
}

/**
 * TRA-1321 — pooled decisive win-rate WIN/(WIN+LOSS) over `rows`, excluding SCRATCH
 * from the denominator. Null when there are no decisive rows. This is the family's
 * own realized base rate: the economically meaningful null the recalibrated
 * multiplier centers on (1.0 = "no edge vs the family's own average").
 */
export function decisiveWinRate(rows: OptionTradeJournalRecord[]): number | null {
  let win = 0;
  let decisive = 0;
  for (const r of rows) {
    if (r.outcome === 'WIN') {
      win += 1;
      decisive += 1;
    } else if (r.outcome === 'LOSS') {
      decisive += 1;
    }
  }
  return decisive > 0 ? win / decisive : null;
}

/**
 * TRA-1321 — recalibrate the neutral baseline from the fixed 0.5 to the family's own
 * decisive base rate. Computes the pooled rate and, for each structure carrying at
 * least {@link MIN_DECISIVE_PER_STRUCTURE} decisive rows, that structure's own rate.
 */
export function calibrateBaseline(resolved: OptionTradeJournalRecord[]): BaselineCalibration {
  const pooled = decisiveWinRate(resolved);
  const byStructure = new Map<string, OptionTradeJournalRecord[]>();
  for (const r of resolved) {
    const list = byStructure.get(r.structure) ?? [];
    list.push(r);
    byStructure.set(r.structure, list);
  }
  const perStructure: Record<string, number> = {};
  for (const [structure, list] of byStructure) {
    const decisive = list.filter(isDecisive).length;
    const rate = decisiveWinRate(list);
    if (decisive >= MIN_DECISIVE_PER_STRUCTURE && rate !== null) perStructure[structure] = rate;
  }
  return {
    pooled,
    perStructure,
    usedPerStructure: Object.keys(perStructure).length > 0,
    decisiveResolved: resolved.filter(isDecisive).length,
  };
}

/**
 * The out-of-sample multiplier for one resolved row. In leave-one-out the training
 * fold is every OTHER row (the scored row is excluded — that is the whole point).
 * In time-split the training fold is every row closed strictly before `splitTs`.
 * The multiplier itself comes from the real `optionSetupMultiplier`.
 *
 * TRA-1321 — `decisiveFold` restricts the training fold to decisive (WIN/LOSS) rows so
 * each bucket's win-rate is measured on the SAME decisive basis as the recalibrated
 * baseline carried in `params.baselineHitRate`. Without it, SCRATCH rows inflate the
 * denominator and every bucket rate collapses far below any plausible baseline,
 * re-floor­ing the composite regardless of recalibration.
 */
export function oosMultiplierForRow(
  allRows: OptionTradeJournalRecord[],
  row: OptionTradeJournalRecord,
  opts: {
    mode: SplitMode;
    splitTs?: number;
    useShrinkage: boolean;
    params: LearnedWeightsParams;
    decisiveFold?: boolean;
  },
): number {
  let train =
    opts.mode === 'time-split'
      ? allRows.filter((r) => r.outcome !== 'OPEN' && (r.closeTs ?? Infinity) < (opts.splitTs ?? 0))
      : allRows.filter((r) => r.id !== row.id);
  if (opts.decisiveFold) train = train.filter(isDecisive);
  const weights = computeOptionLearnedWeights(train, opts.params);
  return optionSetupMultiplier(weights, setupKeyFromRow(row), opts.useShrinkage);
}

function cohortStat(cohort: Cohort, rows: ScoredRow[]): CohortStat {
  const n = rows.length;
  if (n === 0) return { cohort, n: 0, meanR: null, hitRate: null };
  const meanR = rows.reduce((acc, r) => acc + r.realizedR, 0) / n;
  const wins = rows.filter((r) => r.outcome === 'WIN').length;
  return { cohort, n, meanR, hitRate: wins / n };
}

/** Deterministic mulberry32 PRNG so the bootstrap CI is reproducible. */
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

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))));
  return sorted[idx]!;
}

/**
 * Bootstrap the up-minus-down expectancy gap. Resamples each cohort's realized-R
 * vector independently with replacement and takes the central `level` percentile
 * band of the resampled gap. Seeded → deterministic.
 */
export function bootstrapGap(
  upR: number[],
  downR: number[],
  opts: { level: number; iterations: number; seed: number },
): ExpectancyGap {
  const base: ExpectancyGap = {
    gap: null,
    ciLower: null,
    ciUpper: null,
    level: opts.level,
    iterations: opts.iterations,
  };
  if (upR.length === 0 || downR.length === 0) return base;
  const gap = mean(upR) - mean(downR);
  const rng = mulberry32(opts.seed);
  const resample = (xs: number[]): number => {
    let s = 0;
    for (let i = 0; i < xs.length; i++) s += xs[Math.floor(rng() * xs.length)]!;
    return s / xs.length;
  };
  const gaps: number[] = [];
  for (let b = 0; b < opts.iterations; b++) gaps.push(resample(upR) - resample(downR));
  gaps.sort((a, b) => a - b);
  const tail = (1 - opts.level) / 2;
  return {
    gap,
    ciLower: percentile(gaps, tail),
    ciUpper: percentile(gaps, 1 - tail),
    level: opts.level,
    iterations: opts.iterations,
  };
}

function statToBucket(s: OptionLearnedStat): DimensionBucket {
  return {
    key: s.key,
    resolved: s.resolved,
    winRate: s.winRate,
    avgR: s.avgR,
    clearedMinSamples: s.confident,
    multiplierHardGate: s.multiplierHardGate,
    multiplierShrunk: s.multiplierShrunk,
  };
}

function dimensionDiagnostics(weights: OptionLearnedWeights): DimensionDiagnostic[] {
  return [
    { dimension: 'structure', buckets: weights.byStructure.map(statToBucket) },
    { dimension: 'ivRank', buckets: weights.byIvRank.map(statToBucket) },
    { dimension: 'trend', buckets: weights.byTrend.map(statToBucket) },
    { dimension: 'sentiment', buckets: weights.bySentiment.map(statToBucket) },
    { dimension: 'sentimentIcBand', buckets: weights.bySentimentIc.map(statToBucket) },
    { dimension: 'dte', buckets: weights.byDte.map(statToBucket) },
  ];
}

/**
 * Grade per the pre-registered protocol. Sample bar is checked FIRST: too few rows
 * → INCONCLUSIVE regardless of the point estimate. Only with the bar cleared does a
 * positive, CI-clean gap read REAL; anything else with enough sample is NOISE.
 */
export function gradeVerdict(
  resolvedTotal: number,
  up: CohortStat,
  down: CohortStat,
  gap: ExpectancyGap,
): { verdict: Verdict; reasons: string[] } {
  const reasons: string[] = [];
  const underBar =
    resolvedTotal < MIN_RESOLVED_TOTAL || up.n < MIN_PER_COHORT || down.n < MIN_PER_COHORT;
  if (underBar) {
    reasons.push(
      `under sample bar: resolved=${resolvedTotal} (need >=${MIN_RESOLVED_TOTAL}), up.n=${up.n}/down.n=${down.n} (need >=${MIN_PER_COHORT} each)`,
    );
    return { verdict: 'INCONCLUSIVE', reasons };
  }
  const gapVal = gap.gap ?? 0;
  const lb = gap.ciLower ?? -Infinity;
  if (gapVal > 0 && lb > 0) {
    reasons.push(
      `gap=${gapVal.toFixed(3)}R > 0 and ${(gap.level * 100).toFixed(0)}% CI lower-bound=${lb.toFixed(3)} > 0 with sample bar cleared (resolved=${resolvedTotal}, up.n=${up.n}, down.n=${down.n})`,
    );
    return { verdict: 'REAL', reasons };
  }
  reasons.push(
    `sample bar cleared but gap=${gapVal.toFixed(3)}R / CI lower-bound=${lb.toFixed(3)} does not clear (need gap>0 AND CI-lb>0)`,
  );
  return { verdict: 'NOISE', reasons };
}

// ── top-level builder ────────────────────────────────────────────────────────

/**
 * Run the full OOS validation over a set of journal rows and return the structured
 * report. Pure: no clock, no I/O — the CLI runner supplies the rows and stamps the
 * generation time.
 */
export function buildOosReport(
  rows: OptionTradeJournalRecord[],
  options: OosHarnessOptions = {},
): OosReport {
  if (options.expectancy) return buildExpectancyReport(rows, options);
  const mode: SplitMode = options.mode ?? 'loo';
  const useShrinkage = options.useShrinkage ?? false;
  const params = options.params ?? DEFAULT_LEARNED_PARAMS;
  const bootstrapIterations = options.bootstrapIterations ?? BOOTSTRAP_ITERATIONS;
  const bootstrapSeed = options.bootstrapSeed ?? BOOTSTRAP_SEED;
  const ciLevel = options.ciLevel ?? CI_LEVEL;
  const splitTs = options.splitTs ?? null;

  const resolved = resolvedRows(rows);

  // In time-split, only rows closed at/after the boundary are scored OUT of sample.
  const scorable =
    mode === 'time-split'
      ? resolved.filter((r) => (r.closeTs ?? Infinity) >= (splitTs ?? 0))
      : resolved;

  const scoredRows: ScoredRow[] = scorable.map((r) => {
    const oosMultiplier = oosMultiplierForRow(rows, r, {
      mode,
      splitTs: splitTs ?? undefined,
      useShrinkage,
      params,
    });
    return {
      id: r.id,
      symbol: r.symbol,
      structure: r.structure,
      outcome: r.outcome as OptionTradeOutcome,
      realizedR: r.realizedR as number,
      oosMultiplier,
      cohort: cohortOf(oosMultiplier),
    };
  });

  const byCohort = (c: Cohort) => scoredRows.filter((r) => r.cohort === c);
  const up = cohortStat('up', byCohort('up'));
  const down = cohortStat('down', byCohort('down'));
  const neutral = cohortStat('neutral', byCohort('neutral'));

  const gap = bootstrapGap(
    byCohort('up').map((r) => r.realizedR),
    byCohort('down').map((r) => r.realizedR),
    { level: ciLevel, iterations: bootstrapIterations, seed: bootstrapSeed },
  );

  const { verdict, reasons } = gradeVerdict(scoredRows.length, up, down, gap);

  // Diagnostics fold over the resolved rows (full in-sample view, by design — this
  // is descriptive, not the OOS verdict).
  const diagWeights = computeOptionLearnedWeights(resolved, params);
  const dimensions = dimensionDiagnostics(diagWeights);
  const sentimentIcRead =
    dimensions.find((d) => d.dimension === 'sentimentIcBand') ??
    ({ dimension: 'sentimentIcBand', buckets: [] } as DimensionDiagnostic);

  return {
    issue: 'TRA-1133',
    parent: 'TRA-992',
    mode,
    splitTs,
    useShrinkage,
    params,
    thresholds: {
      up: UP_THRESHOLD,
      down: DOWN_THRESHOLD,
      minResolvedTotal: MIN_RESOLVED_TOTAL,
      minPerCohort: MIN_PER_COHORT,
      ciLevel,
    },
    sample: {
      rowsTotal: rows.length,
      resolvedTotal: scoredRows.length,
      scored: scoredRows.length,
    },
    cohorts: { up, down, neutral },
    gap,
    verdict,
    verdictReasons: reasons,
    scoredRows,
    dimensions,
    sentimentIcRead,
  };
}

// ── TRA-1321 expectancy mode (protocol v2) ──────────────────────────────────────

/**
 * Protocol-v2 OOS validation. Same report shape as the legacy path (so downstream
 * readers and the render are unchanged) but with three amendments:
 *   1. the neutral baseline is recalibrated to the family's own decisive base rate
 *      (pooled, or per-structure when a structure carries >= MIN_DECISIVE_PER_STRUCTURE
 *      decisive rows), so multiplier=1.0 means "no edge vs the family's own average";
 *   2. rows are scored on a DECISIVE-basis fold so bucket win-rate and baseline share
 *      the same denominator — the fix that lets the composite spread around 1.0 at all;
 *   3. cohorts split at 1.0 and are compared on realized-R EXPECTANCY. When the absolute
 *      split degenerates (a cohort under the per-cohort bar) rows are split top/bottom by
 *      the MEDIAN composite multiplier instead. Verdict follows the amended rules.
 * Diagnostics + the Step-2 `bySentimentIc` read are computed exactly as the legacy path
 * (over the full resolved set, default params) — left untouched per protocol point 5.
 */
function buildExpectancyReport(
  rows: OptionTradeJournalRecord[],
  options: OosHarnessOptions,
): OosReport {
  const mode: SplitMode = options.mode ?? 'loo';
  const useShrinkage = options.useShrinkage ?? false;
  const baseParams = options.params ?? DEFAULT_LEARNED_PARAMS;
  const bootstrapIterations = options.bootstrapIterations ?? BOOTSTRAP_ITERATIONS;
  const bootstrapSeed = options.bootstrapSeed ?? BOOTSTRAP_SEED;
  const ciLevel = options.ciLevel ?? CI_LEVEL;
  const splitTs = options.splitTs ?? null;

  const resolved = resolvedRows(rows);
  const baseline = calibrateBaseline(resolved);
  const baselineFor = (structure: string): number =>
    baseline.perStructure[structure] ?? baseline.pooled ?? baseParams.baselineHitRate;

  const scorable =
    mode === 'time-split'
      ? resolved.filter((r) => (r.closeTs ?? Infinity) >= (splitTs ?? 0))
      : resolved;

  let scoredRows: ScoredRow[] = scorable.map((r) => {
    const params: LearnedWeightsParams = { ...baseParams, baselineHitRate: baselineFor(r.structure) };
    const oosMultiplier = oosMultiplierForRow(rows, r, {
      mode,
      splitTs: splitTs ?? undefined,
      useShrinkage,
      params,
      decisiveFold: true,
    });
    return {
      id: r.id,
      symbol: r.symbol,
      structure: r.structure,
      outcome: r.outcome as OptionTradeOutcome,
      realizedR: r.realizedR as number,
      oosMultiplier,
      cohort: expectancyCohortOf(oosMultiplier),
    };
  });

  const distinctMultipliers = new Set(scoredRows.map((r) => r.oosMultiplier.toFixed(6))).size;

  // Absolute split at 1.0 first; fall back to the median split only when it degenerates.
  let cohortBasis: 'absolute' | 'median' = 'absolute';
  let up = cohortStat('up', scoredRows.filter((r) => r.cohort === 'up'));
  let down = cohortStat('down', scoredRows.filter((r) => r.cohort === 'down'));
  let neutral = cohortStat('neutral', scoredRows.filter((r) => r.cohort === 'neutral'));

  const absoluteDegenerate = up.n < MIN_PER_COHORT || down.n < MIN_PER_COHORT;
  if (absoluteDegenerate && distinctMultipliers > 1) {
    cohortBasis = 'median';
    const sorted = [...scoredRows].sort((a, b) => a.oosMultiplier - b.oosMultiplier);
    const mid = Math.floor(sorted.length / 2);
    const bottomIds = new Set(sorted.slice(0, mid).map((r) => r.id));
    // bottom-half (lower multiplier) → down; top-half → up. On odd counts the median
    // row rides with the top half.
    scoredRows = scoredRows.map((r) => ({ ...r, cohort: bottomIds.has(r.id) ? 'down' : 'up' }));
    up = cohortStat('up', scoredRows.filter((r) => r.cohort === 'up'));
    down = cohortStat('down', scoredRows.filter((r) => r.cohort === 'down'));
    neutral = cohortStat('neutral', []);
  }

  const gap = bootstrapGap(
    scoredRows.filter((r) => r.cohort === 'up').map((r) => r.realizedR),
    scoredRows.filter((r) => r.cohort === 'down').map((r) => r.realizedR),
    { level: ciLevel, iterations: bootstrapIterations, seed: bootstrapSeed },
  );

  let verdict: Verdict;
  let reasons: string[];
  if (distinctMultipliers <= 1) {
    // Even after recalibration every row carries the same multiplier — there is no
    // signal to split on, absolute OR median. Genuinely INCONCLUSIVE, not NOISE.
    verdict = 'INCONCLUSIVE';
    const only = scoredRows[0]?.oosMultiplier;
    reasons = [
      `OOS multipliers show no variation${only !== undefined ? ` (all = ${only.toFixed(3)})` : ''} even after recalibrating the baseline — cohorts cannot form on any basis`,
    ];
  } else {
    const graded = gradeVerdict(scoredRows.length, up, down, gap);
    verdict = graded.verdict;
    reasons = [
      `expectancy mode: baseline recalibrated to family decisive rate ${fmtRate(baseline.pooled)}${baseline.usedPerStructure ? ` (per-structure: ${fmtPerStructure(baseline.perStructure)})` : ''}; cohort basis = ${cohortBasis}${cohortBasis === 'median' ? ' (absolute up/down split degenerated → median split)' : ' (split at multiplier 1.0)'}; gap = up−down mean realized R`,
      ...graded.reasons,
    ];
  }

  const diagWeights = computeOptionLearnedWeights(resolved, baseParams);
  const dimensions = dimensionDiagnostics(diagWeights);
  const sentimentIcRead =
    dimensions.find((d) => d.dimension === 'sentimentIcBand') ??
    ({ dimension: 'sentimentIcBand', buckets: [] } as DimensionDiagnostic);

  return {
    issue: 'TRA-1133',
    parent: 'TRA-992',
    mode,
    splitTs,
    useShrinkage,
    params: baseParams,
    thresholds: {
      up: EXPECTANCY_COHORT_THRESHOLD,
      down: EXPECTANCY_COHORT_THRESHOLD,
      minResolvedTotal: MIN_RESOLVED_TOTAL,
      minPerCohort: MIN_PER_COHORT,
      ciLevel,
    },
    sample: {
      rowsTotal: rows.length,
      resolvedTotal: scoredRows.length,
      scored: scoredRows.length,
    },
    cohorts: { up, down, neutral },
    gap,
    verdict,
    verdictReasons: reasons,
    scoredRows,
    dimensions,
    sentimentIcRead,
    expectancy: {
      enabled: true,
      baseline,
      cohortBasis,
      distinctMultipliers,
    },
  };
}

function fmtRate(x: number | null): string {
  return x === null ? 'n/a' : x.toFixed(3);
}
function fmtPerStructure(m: Record<string, number>): string {
  return Object.entries(m)
    .map(([k, v]) => `${k}=${v.toFixed(3)}`)
    .join(', ');
}

// ── text report (compact, headless-capturable — mirrors the TRA-822 harness) ────

function fmtR(x: number | null, dp = 3): string {
  return x === null || !Number.isFinite(x) ? 'n/a' : x.toFixed(dp);
}
function fmtPct(x: number | null): string {
  return x === null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(1)}%`;
}

export function renderOosReport(report: OosReport, generatedAt: string): string {
  const L: string[] = [];
  L.push('# TRA-1133 — OOS Learned-Option-Weights Validation');
  L.push('');
  L.push(`**Generated:** ${generatedAt} · **Parent:** TRA-992 Step 1`);
  L.push(
    `**Mode:** ${report.mode}${report.mode === 'time-split' ? ` (splitTs=${report.splitTs})` : ''} · **Shrinkage:** ${report.useShrinkage ? 'on' : 'off (hard-gate)'}${report.expectancy ? ' · **Protocol:** v2 expectancy (TRA-1321)' : ''}`,
  );
  L.push('');
  L.push(`**VERDICT: ${report.verdict}**`);
  for (const r of report.verdictReasons) L.push(`- ${r}`);
  L.push('');
  if (report.expectancy) {
    const e = report.expectancy;
    L.push('## Recalibration (protocol v2)');
    L.push('');
    L.push(
      `- baseline (family decisive win-rate WIN/(WIN+LOSS)): pooled = ${fmtRate(e.baseline.pooled)} over ${e.baseline.decisiveResolved} decisive rows`,
    );
    if (e.baseline.usedPerStructure) {
      L.push(`- per-structure baseline: ${fmtPerStructure(e.baseline.perStructure)}`);
    } else {
      L.push(`- per-structure baseline: none qualified (need >=${MIN_DECISIVE_PER_STRUCTURE} decisive rows each)`);
    }
    L.push(
      `- cohort basis: **${e.cohortBasis}**${e.cohortBasis === 'median' ? ' (absolute 1.0 split degenerated → median composite-multiplier split)' : ' (split at recalibrated multiplier 1.0)'} · distinct OOS multipliers: ${e.distinctMultipliers}`,
    );
    L.push('');
  }
  const upLabel = report.expectancy
    ? report.expectancy.cohortBasis === 'median'
      ? 'top-half'
      : '> 1.0'
    : `> ${UP_THRESHOLD}`;
  const downLabel = report.expectancy
    ? report.expectancy.cohortBasis === 'median'
      ? 'bottom-half'
      : '< 1.0'
    : `< ${DOWN_THRESHOLD}`;
  const labelFor = (c: Cohort): string =>
    c === 'up' ? upLabel : c === 'down' ? downLabel : cohortLabel('neutral');
  L.push(`## Cohorts (by ${report.expectancy ? 'recalibrated ' : ''}OOS multiplier)`);
  L.push('');
  L.push('| Cohort | n | mean R | hit-rate |');
  L.push('|---|---|---|---|');
  for (const c of ['up', 'down', 'neutral'] as const) {
    const s = report.cohorts[c];
    L.push(`| ${c} (${labelFor(c)}) | ${s.n} | ${fmtR(s.meanR)} | ${fmtPct(s.hitRate)} |`);
  }
  L.push('');
  L.push('## Up − Down expectancy gap');
  L.push('');
  L.push(
    `- gap = ${fmtR(report.gap.gap)} R · ${(report.gap.level * 100).toFixed(0)}% CI [${fmtR(report.gap.ciLower)}, ${fmtR(report.gap.ciUpper)}] (${report.gap.iterations} bootstrap resamples)`,
  );
  L.push(
    `- sample: resolved/scored = ${report.sample.resolvedTotal} (need >=${report.thresholds.minResolvedTotal}); per non-neutral cohort need >=${report.thresholds.minPerCohort}`,
  );
  L.push('');
  L.push('## Per-dimension diagnostic (resolved-row folds)');
  L.push('');
  for (const dim of report.dimensions) {
    L.push(`### ${dim.dimension}`);
    if (dim.buckets.length === 0) {
      L.push('- (no rows)');
      L.push('');
      continue;
    }
    L.push('| bucket | n | winRate | avgR | cleared minSamples |');
    L.push('|---|---|---|---|---|');
    for (const b of dim.buckets) {
      L.push(
        `| ${b.key} | ${b.resolved} | ${fmtPct(b.winRate)} | ${fmtR(b.avgR)} | ${b.clearedMinSamples ? 'yes' : 'no'} |`,
      );
    }
    L.push('');
  }
  L.push('## TRA-992 Step 2 read — bySentimentIc fold (restricted)');
  L.push('');
  if (report.sentimentIcRead.buckets.length === 0) {
    L.push('- (no graded rows)');
  } else {
    L.push('| band | n | winRate | avgR | cleared minSamples |');
    L.push('|---|---|---|---|---|');
    for (const b of report.sentimentIcRead.buckets) {
      L.push(
        `| ${b.key} | ${b.resolved} | ${fmtPct(b.winRate)} | ${fmtR(b.avgR)} | ${b.clearedMinSamples ? 'yes' : 'no'} |`,
      );
    }
  }
  L.push('');
  L.push(
    '> Observe/measure only. No selector wiring, no live-capital path (TRA-992 Step 3 stays gated on this read).',
  );
  L.push('');
  return L.join('\n');
}

function cohortLabel(c: Cohort): string {
  if (c === 'up') return `> ${UP_THRESHOLD}`;
  if (c === 'down') return `< ${DOWN_THRESHOLD}`;
  return `${DOWN_THRESHOLD}–${UP_THRESHOLD}`;
}
