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

/**
 * The out-of-sample multiplier for one resolved row. In leave-one-out the training
 * fold is every OTHER row (the scored row is excluded — that is the whole point).
 * In time-split the training fold is every row closed strictly before `splitTs`.
 * The multiplier itself comes from the real `optionSetupMultiplier`.
 */
export function oosMultiplierForRow(
  allRows: OptionTradeJournalRecord[],
  row: OptionTradeJournalRecord,
  opts: { mode: SplitMode; splitTs?: number; useShrinkage: boolean; params: LearnedWeightsParams },
): number {
  const train =
    opts.mode === 'time-split'
      ? allRows.filter((r) => r.outcome !== 'OPEN' && (r.closeTs ?? Infinity) < (opts.splitTs ?? 0))
      : allRows.filter((r) => r.id !== row.id);
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
    `**Mode:** ${report.mode}${report.mode === 'time-split' ? ` (splitTs=${report.splitTs})` : ''} · **Shrinkage:** ${report.useShrinkage ? 'on' : 'off (hard-gate)'}`,
  );
  L.push('');
  L.push(`**VERDICT: ${report.verdict}**`);
  for (const r of report.verdictReasons) L.push(`- ${r}`);
  L.push('');
  L.push('## Cohorts (by OOS multiplier)');
  L.push('');
  L.push('| Cohort | n | mean R | hit-rate |');
  L.push('|---|---|---|---|');
  for (const c of ['up', 'down', 'neutral'] as const) {
    const s = report.cohorts[c];
    L.push(`| ${c} (${cohortLabel(c)}) | ${s.n} | ${fmtR(s.meanR)} | ${fmtPct(s.hitRate)} |`);
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
