// TRA-4913 (Phase 0 item 2 of the TRA-4481 upgrade plan, ratified on TRA-4911) —
// the per-strategy DEGRADATION MONITOR.
//
// ── ADVISORY ONLY. This is the load-bearing constraint ──────────────────────
//
// Nothing in this module halts, throttles, resizes or disables anything. Hard
// halts are already owned — `options-risk-breaker` and its latched ledger, the
// `DailyRiskGovernor`, the churn brakes, and `shadow-expectancy-guard` on the
// promotion path. A second actor that can halt trading is how you get two halting
// systems that disagree about whether the desk is open. This module emits a FLAG
// and a size-down RECOMMENDATION; a human or one of those existing breakers acts.
// `recommendedSizeFactor` has no reader in the tree and must not acquire one
// without re-opening the TRA-4911 ruling.
//
// ── What is actually new here ───────────────────────────────────────────────
//
// Not the statistics. PF / expectancy / Sharpe / Sortino / drawdown all come from
// `buildMetricsCell` (TRA-4914), which itself delegates to `summarizeTrades`
// (TRA-731). The cost-inclusive re-pricing and the graded/excluded census come
// from `extractEvaluatedTrades` (TRA-4914). A diff that adds a second profit
// factor is wrong.
//
// What is new is the COMPARISON TARGET. `detectEdgeDecay`
// (`strategy-introspection.ts`) already answers "is this cohort worse than its own
// recent past" with a calibrated bootstrap boundary, and it is not being replaced.
// It cannot answer the question this issue asks, for two reasons:
//
//   1. Its baseline SLIDES. Every tick, the window it compares against absorbs
//      more of the degradation, so a slow bleed re-baselines itself and never
//      fires. An envelope that is RECORDED does not move.
//   2. It has never computed a profit factor, and it folds GROSS `realizedR`. A
//      cohort can hold its mean R while its win/loss geometry collapses, and on
//      this desk the spread is the whole margin (TRA-4238: median spread 0.49
//      engine-R), so a gross verdict is not the live verdict.
//
// ── The honest state of the envelope registry ───────────────────────────────
//
// `DECLARED_STRATEGY_ENVELOPES` ships EMPTY, and that is a measured finding, not
// an omission. Nothing in this tree records "cohort X was validated at PF a /
// expectancy b over n trades as of date d". The closest things are global: the
// TRA-4914 constraint table and the shadow-expectancy guard config — and the AC
// for this issue says in terms that the comparison must NOT be against a global
// constant. Seeding the table with invented numbers so the dashboard looks alive
// is precisely the fabrication CLAUDE.md's health-field rule exists to kill.
//
// So there are two envelope sources and they are LABELLED DIFFERENTLY:
//
//   • `declared` — a row in the registry below, carrying its own provenance
//     string. `isValidation: true`. Empty today; add a row when a cohort is
//     actually validated, and cite where.
//   • `trailing_baseline_derived` — minted from the cohort's OWN history before
//     the rolling window. `isValidation: false`, because it is not one: if the
//     baseline was already degraded the envelope is low and nothing fires. It is
//     a real comparison against a FIXED-for-this-run figure, which is strictly
//     more than we had, and it is strictly less than a validation.
//
// A cohort with neither reads `NO_ENVELOPE`, which is an alarm, not a pass.
//
// PURE. No clock (the caller supplies `asOfIso`), no I/O, no order path, no chain
// read, no broker. A fold over journal rows the caller already holds. No live
// behaviour change; TRA-4168 posture untouched, TRA-382 still gates live.

import type { OptionTradeJournalRecord } from './option-trade-journal.js';
import {
  OPTIONS_EVAL_CONSTRAINTS,
  buildMetricsCell,
  extractEvaluatedTrades,
  type EvalCostCoverage,
  type EvalMetricsCell,
  type EvaluatedOptionTrade,
} from './options-evaluation-report.js';

// ─────────────────────────────────────────────────────────────────────────────
// Cohort key
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The cohort key, `structure::entryArchetype` — IDENTICAL to the key the TRA-1691
 * delta rollup and the TRA-2215 introspection fold already use, so the three
 * surfaces name the same cohort the same way and a reader can join them.
 *
 * `structure` alone is NOT the sleeve and must never be the key: four sleeves
 * shared `single_leg_rv` before TRA-2245 split the directional callers off, and
 * TRA-2245 is forward-only, so historical rows still carry the shared label.
 * Keyed on the bare structure, one spurious flag covers four sleeves at once and
 * one real degradation is diluted by three healthy ones.
 */
export function degradationCohortKey(row: {
  structure: string;
  entryArchetype?: string;
}): string {
  return `${row.structure}::${row.entryArchetype ?? UNSPECIFIED_ARCHETYPE}`;
}

/** The archetype placeholder a pre-TRA-1682 row lands on. */
export const UNSPECIFIED_ARCHETYPE = 'unspecified';

/** Cohort-key suffix identifying the POOLED pre-tagging cohort. */
export const POOLED_COHORT_SUFFIX = `::${UNSPECIFIED_ARCHETYPE}`;

/**
 * `::unspecified` is NOT a sleeve, and a verdict on it is not a verdict on a
 * strategy. `entryArchetype` is forward-only from TRA-1682 — at the TRA-2215
 * measurement, 2,142 of 2,322 closed live rows (92.2%) predate the tagging — so
 * that cohort pools every sleeve that closed before tagging began and cannot be
 * backfilled. Rows carry `pooledCohort: true` so the blast radius is readable
 * rather than implicit.
 */
export const POOLED_COHORT_NOTE =
  '`unspecified` is NOT a sleeve: `entryArchetype` is forward-only from TRA-1682, so this '
  + 'cohort pools every sleeve that closed before tagging began and cannot be backfilled. '
  + 'This verdict covers all of them at once — read the blast radius accordingly.';

// ─────────────────────────────────────────────────────────────────────────────
// The validated envelope
// ─────────────────────────────────────────────────────────────────────────────

/** Where an envelope's numbers came from. Never collapse these into one label. */
export type EnvelopeSource = 'declared' | 'trailing_baseline_derived';

/** A hand-declared envelope row. Every field is required — including provenance. */
export interface DeclaredStrategyEnvelope {
  /** Cohort key, `structure::entryArchetype`. Must match {@link degradationCohortKey}. */
  strategy: string;
  /** Profit factor the cohort was validated to hold at or above. */
  minProfitFactor: number;
  /** Mean cost-inclusive R per trade the cohort was validated to hold at or above. */
  minExpectancyR: number;
  /** Closed trades the validation was measured over. */
  n: number;
  /** ISO date (YYYY-MM-DD) the validation was performed. */
  asOf: string;
  /**
   * WHERE these numbers came from — a ticket plus the artifact. Required, and a
   * row without a real one is worse than no row: it launders a guess into a
   * floor that then silently passes or fails live cohorts.
   */
  provenance: string;
}

/**
 * ⚠ DELIBERATELY EMPTY. See the module header.
 *
 * No cohort in this tree has a recorded validated envelope. Adding a row here is
 * a claim that somebody measured that cohort's PF and expectancy out-of-sample
 * and wrote the numbers down; `provenance` must name the ticket and the artifact
 * so the claim is auditable. Until then every cohort is graded against a
 * `trailing_baseline_derived` envelope, which the report labels as the weaker
 * thing it is.
 *
 * Do NOT seed this from the live tape to make the dashboard light up. A cohort
 * graded against its own current behaviour cannot fail, and a monitor that cannot
 * fail is indistinguishable from one that is not running.
 */
export const DECLARED_STRATEGY_ENVELOPES: readonly DeclaredStrategyEnvelope[] = [];

/** The envelope a cohort was actually graded against, with its provenance. */
export interface StrategyEnvelope {
  strategy: string;
  source: EnvelopeSource;
  minProfitFactor: number;
  minExpectancyR: number;
  n: number;
  asOf: string;
  provenance: string;
  /**
   * `true` only for `declared` rows. A derived envelope is a comparison against
   * the cohort's own past, NOT a validation: if the baseline was already
   * degraded the floor is low and the cohort passes while bleeding. Consumers
   * must not render a derived pass as "validated".
   */
  isValidation: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Verdict vocabulary
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The per-cohort verdict. Four of the five are non-green and they mean different
 * things — "could not check" and "checked and it is fine" never share a value
 * (CLAUDE.md, the health-field rule; the same fail-closed posture the deploy
 * gates use).
 *
 *  • `HEALTHY`      — window at or above its floor, envelope present, inside it.
 *  • `DEGRADED`     — window at or above its floor, envelope present, outside it.
 *                     ADVISORY. Nothing acts on this automatically.
 *  • `INSUFFICIENT` — we LOOKED and the rolling window is below `minWindowTrades`.
 *                     No call made in either direction. A degradation call on
 *                     n=6 is noise, and a green one is worse.
 *  • `NO_ENVELOPE`  — the window is gradeable but there is nothing to grade it
 *                     against: no declared row, and the trailing baseline was too
 *                     thin or non-positive to mint one from.
 *  • `NOT_MEASURED` — the cohort produced no gradeable rows at all in this fold.
 *                     Reached by a DECLARED cohort that has stopped trading, or
 *                     whose every row was excluded as cost-unmeasurable. A
 *                     strategy going silent must not vanish from the report.
 */
export type DegradationVerdict =
  | 'HEALTHY'
  | 'DEGRADED'
  | 'INSUFFICIENT'
  | 'NO_ENVELOPE'
  | 'NOT_MEASURED';

/** The verdicts that are NOT a clean bill of health. */
export const NON_GREEN_VERDICTS: readonly DegradationVerdict[] = [
  'DEGRADED',
  'INSUFFICIENT',
  'NO_ENVELOPE',
  'NOT_MEASURED',
];

/** One metric that fell through its envelope floor. */
export interface EnvelopeBreach {
  metric: 'profitFactor' | 'expectancyR';
  observed: number;
  floor: number;
  /**
   * `(floor − observed) / |floor|`, clamped to `[0, 1]`.
   *
   * Clamped at 1 so a cohort whose floor is near zero cannot produce an
   * unbounded shortfall that then dominates the sizing map. Clamped at 0 because
   * a breach is by construction non-negative. When `|floor| < 1e-9` the ratio is
   * undefined and the shortfall reads 1 — a full breach — rather than dividing.
   */
  shortfall: number;
}

/**
 * The advisory size-down. NOTHING READS THIS.
 *
 * `advisoryOnly` is a literal `true` in the type so that a consumer which tried
 * to thread this into a sizing path would have to delete it deliberately rather
 * than drift into it.
 */
export interface SizeDownRecommendation {
  advisoryOnly: true;
  /**
   * The multiplier a HUMAN may choose to apply to this cohort's risk, in
   * `[MIN_RECOMMENDED_SIZE_FACTOR, 1)`.
   *
   * `1 − worstShortfall`, clamped. Deliberately the simplest monotone map and
   * deliberately NOT calibrated: nothing consumes it automatically, so a tuned
   * number would be false precision dressed as a model output. It ranks cohorts
   * by how far outside their envelope they are; it does not price anything.
   */
  recommendedSizeFactor: number;
  rationale: string;
}

/** Floor on the recommendation. A monitor that recommends ~0 is recommending a halt. */
export const MIN_RECOMMENDED_SIZE_FACTOR = 0.25;

/** One cohort's row in the report. */
export interface StrategyDegradationRow {
  strategy: string;
  verdict: DegradationVerdict;
  /** `true` when the cohort key ends `::unspecified`. See {@link POOLED_COHORT_NOTE}. */
  pooledCohort: boolean;
  /** The rolling window's own metrics cell. Metrics are null unless its status is `OK`. */
  window: EvalMetricsCell;
  /** Total gradeable trades this cohort has, of which `window.n` are in the window. */
  cohortTrades: number;
  /** The envelope graded against, or `null` when there was none to grade against. */
  envelope: StrategyEnvelope | null;
  /** The floors that were breached. Empty unless `verdict === 'DEGRADED'`. */
  breaches: EnvelopeBreach[];
  /** Advisory only. `null` unless `verdict === 'DEGRADED'`. */
  sizeDown: SizeDownRecommendation | null;
  /** Why this verdict, in words, with the numbers that decided it. */
  reason: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Options
// ─────────────────────────────────────────────────────────────────────────────

export interface DegradationMonitorOptions {
  /** Most-recent N gradeable trades per cohort. Default {@link DEFAULT_RECENT_WINDOW}. */
  recentWindow?: number;
  /** Floor for the window to be judged at all. Default {@link DEFAULT_MIN_WINDOW_TRADES}. */
  minWindowTrades?: number;
  /** Floor for the trailing baseline to mint an envelope. Default {@link DEFAULT_MIN_BASELINE_TRADES}. */
  minBaselineTrades?: number;
  /** ISO instant this fold was computed at. The module holds no clock. */
  asOfIso?: string;
  /** Declared envelopes. Defaults to {@link DECLARED_STRATEGY_ENVELOPES}. Injected for tests. */
  declaredEnvelopes?: readonly DeclaredStrategyEnvelope[];
}

/**
 * What `generatedAtIso` reads when the caller supplied no `asOfIso`.
 *
 * A LITERAL, and deliberately the epoch. This module holds no clock — a
 * `new Date()` here would make the same rows yield a different artifact on every
 * call, so today's readout could not be diffed against yesterday's and a change
 * would not be attributable to the book. An unstamped artifact should be obvious
 * on sight rather than plausible.
 */
export const UNSTATED_AS_OF_ISO = '1970-01-01T00:00:00.000Z';

/**
 * Default rolling window, in trades.
 *
 * 50 rather than the introspection fold's 30: this surface compares against a
 * FIXED envelope rather than a resampled null, so it has no bootstrap to absorb
 * window noise, and a profit factor is a ratio of two sums that is materially
 * noisier at n=30 than a mean is. Configurable, and the window size is printed
 * in every row so a verdict can be read against the n it was taken at.
 */
export const DEFAULT_RECENT_WINDOW = 50;

/**
 * Minimum trades in the rolling window before ANY call is made. Matches
 * `EVAL_CELL_MIN_N` (30), the floor TRA-4914 uses for printing a ratio at all.
 * Below it the row reads `INSUFFICIENT` with null metrics.
 */
export const DEFAULT_MIN_WINDOW_TRADES = 30;

/**
 * Minimum trades in the trailing baseline before an envelope may be MINTED from
 * it. Deliberately higher than the window floor: an envelope is reused as a fixed
 * reference, so a noisy one mis-grades every subsequent window, and getting it
 * wrong is more expensive than declining to have one.
 */
export const DEFAULT_MIN_BASELINE_TRADES = 60;

/**
 * Tolerated degradation below the envelope, as a fraction.
 *
 * REUSED from `OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation` (0.35) rather than
 * introduced. That number is the TRA-4481 constraint table's answer to exactly
 * this question — "how much worse than validated is still acceptable" — and it
 * was written before the data was looked at, which is the property that makes it
 * un-fittable. Introducing a second, local tolerance here would be a new tuning
 * knob pointed at the same question, and the first thing anybody would do with it
 * is widen it until nothing fires.
 */
export const DEGRADATION_TOLERANCE = OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation;

// ─────────────────────────────────────────────────────────────────────────────
// Envelope resolution
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mint an envelope from the cohort's trailing baseline — every gradeable trade
 * BEFORE the rolling window.
 *
 * Returns `null`, never a fabricated floor, when:
 *   • the baseline is below `minBaselineTrades`; or
 *   • the baseline's own PF or expectancy is non-positive.
 *
 * The second guard is not cosmetic. A negative baseline expectancy multiplied by
 * `(1 − tolerance)` moves the floor UP toward zero, so a cohort that was losing
 * money would be handed a harder floor than one that was making it, and a cohort
 * that merely stopped losing as fast would read DEGRADED. `detectEdgeDecay`
 * carries the same `base > 0` guard for the same reason: there is nothing to
 * decay from.
 */
export function deriveTrailingEnvelope(
  strategy: string,
  baseline: readonly EvaluatedOptionTrade[],
  asOf: string,
  minBaselineTrades: number,
): StrategyEnvelope | null {
  if (baseline.length < minBaselineTrades) return null;
  const cell = buildMetricsCell(baseline, minBaselineTrades);
  if (cell.status !== 'OK') return null;
  if (cell.profitFactor === null || cell.expectancyR === null) return null;
  if (cell.profitFactor <= 0 || cell.expectancyR <= 0) return null;

  const keep = 1 - DEGRADATION_TOLERANCE;
  return {
    strategy,
    source: 'trailing_baseline_derived',
    minProfitFactor: cell.profitFactor * keep,
    minExpectancyR: cell.expectancyR * keep,
    n: cell.n,
    asOf,
    provenance:
      `TRA-4913 derived: cohort's own ${cell.n} gradeable trades before the rolling window, `
      + `PF ${cell.profitFactor.toFixed(3)} / expectancy ${cell.expectancyR.toFixed(4)}R, `
      + `less the ratified ${(DEGRADATION_TOLERANCE * 100).toFixed(0)}% tolerance `
      + '(OPTIONS_EVAL_CONSTRAINTS.maxIsToOosDegradation). NOT an out-of-sample validation.',
    isValidation: false,
  };
}

/** Promote a declared row to the graded envelope shape. */
function fromDeclared(d: DeclaredStrategyEnvelope): StrategyEnvelope {
  return {
    strategy: d.strategy,
    source: 'declared',
    minProfitFactor: d.minProfitFactor,
    minExpectancyR: d.minExpectancyR,
    n: d.n,
    asOf: d.asOf,
    provenance: d.provenance,
    isValidation: true,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Breach + recommendation
// ─────────────────────────────────────────────────────────────────────────────

const EPS = 1e-9;

function breachOf(
  metric: EnvelopeBreach['metric'],
  observed: number,
  floor: number,
): EnvelopeBreach | null {
  if (observed >= floor) return null;
  const raw = Math.abs(floor) < EPS ? 1 : (floor - observed) / Math.abs(floor);
  return { metric, observed, floor, shortfall: Math.min(1, Math.max(0, raw)) };
}

/**
 * The advisory size-down. See {@link SizeDownRecommendation} — this is a ranking
 * device, not a sizing model, and nothing in the tree reads it.
 */
export function recommendSizeDown(
  strategy: string,
  breaches: readonly EnvelopeBreach[],
): SizeDownRecommendation | null {
  if (breaches.length === 0) return null;
  const worst = breaches.reduce((a, b) => (b.shortfall > a.shortfall ? b : a));
  const factor = Math.max(
    MIN_RECOMMENDED_SIZE_FACTOR,
    Math.min(1, 1 - worst.shortfall),
  );
  const rounded = Math.round(factor * 100) / 100;
  return {
    advisoryOnly: true,
    recommendedSizeFactor: rounded,
    rationale:
      `ADVISORY: ${strategy} is outside its envelope on `
      + breaches.map((b) => b.metric).join(' and ')
      + `; worst relative shortfall ${(worst.shortfall * 100).toFixed(0)}% on ${worst.metric} `
      + `(observed ${worst.observed.toFixed(4)} vs floor ${worst.floor.toFixed(4)}). `
      + `A human or an existing breaker decides — nothing applies this automatically.`,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// The report
// ─────────────────────────────────────────────────────────────────────────────

export interface StrategyDegradationReport {
  issue: 'TRA-4913';
  /** Stated in the payload so no consumer has to infer it. */
  advisoryOnly: true;
  generatedAtIso: string;
  recentWindow: number;
  minWindowTrades: number;
  minBaselineTrades: number;
  degradationTolerance: number;
  /** The TRA-4914 graded/excluded census for the rows this fold saw. */
  coverage: EvalCostCoverage;
  /** One row per cohort, degraded first, then by window size. */
  rows: StrategyDegradationRow[];
  /** Count by verdict. An all-`NO_ENVELOPE` run is visible here at a glance. */
  verdictCensus: Record<DegradationVerdict, number>;
  /** Cohorts flagged degraded. Advisory. May legitimately be empty. */
  degradedStrategies: string[];
  /** Cohorts whose verdict is not a clean bill of health, for any reason. */
  nonGreenStrategies: string[];
  /** How many declared envelope rows were in force. 0 today — see the module header. */
  declaredEnvelopeCount: number;
}

function emptyCensus(): Record<DegradationVerdict, number> {
  return { HEALTHY: 0, DEGRADED: 0, INSUFFICIENT: 0, NO_ENVELOPE: 0, NOT_MEASURED: 0 };
}

/**
 * PURE — the whole advisory readout over closed option-journal rows.
 *
 * The population is the TRA-4914 GRADED population: cost-inclusive, with every
 * row whose bid/ask cost could not be measured EXCLUDED and counted by name
 * rather than averaged in gross (TRA-4674's matched-comparison discipline). A
 * degradation verdict computed off a mix of cost-inclusive and gross rows would
 * move when the mix moved, which is the silent contamination that surface exists
 * to prevent.
 */
export function buildStrategyDegradationReport(
  journalRows: readonly OptionTradeJournalRecord[],
  options: DegradationMonitorOptions = {},
): StrategyDegradationReport {
  const recentWindow = options.recentWindow ?? DEFAULT_RECENT_WINDOW;
  const minWindowTrades = options.minWindowTrades ?? DEFAULT_MIN_WINDOW_TRADES;
  const minBaselineTrades = options.minBaselineTrades ?? DEFAULT_MIN_BASELINE_TRADES;
  const asOfIso = options.asOfIso ?? UNSTATED_AS_OF_ISO;
  const declared = options.declaredEnvelopes ?? DECLARED_STRATEGY_ENVELOPES;

  const { trades, coverage } = extractEvaluatedTrades(journalRows);

  // `extractEvaluatedTrades` drops `entryArchetype`, so the cohort key is joined
  // back by row id. Keying on the bare `structure` it does carry would pool
  // sleeves — see `degradationCohortKey`.
  const archetypeById = new Map<string, string | undefined>();
  for (const r of journalRows) archetypeById.set(r.id, r.entryArchetype);

  const byCohort = new Map<string, EvaluatedOptionTrade[]>();
  for (const t of trades) {
    const key = degradationCohortKey({
      structure: t.structure,
      entryArchetype: archetypeById.get(t.id),
    });
    const g = byCohort.get(key);
    if (g) g.push(t);
    else byCohort.set(key, [t]);
  }

  // A DECLARED cohort that produced no gradeable rows still gets a row. A
  // strategy that went silent — or whose every row was excluded as
  // cost-unmeasurable — must not disappear into a clean-looking report.
  const declaredByKey = new Map<string, DeclaredStrategyEnvelope>();
  for (const d of declared) {
    declaredByKey.set(d.strategy, d);
    if (!byCohort.has(d.strategy)) byCohort.set(d.strategy, []);
  }

  const rows: StrategyDegradationRow[] = [];

  for (const [strategy, cohort] of byCohort.entries()) {
    const pooledCohort = strategy.endsWith(POOLED_COHORT_SUFFIX);
    const recent = cohort.slice(Math.max(0, cohort.length - recentWindow));
    const baseline = cohort.slice(0, Math.max(0, cohort.length - recentWindow));
    const window = buildMetricsCell(recent, minWindowTrades);

    const declaredRow = declaredByKey.get(strategy);
    const envelope =
      declaredRow !== undefined
        ? fromDeclared(declaredRow)
        : deriveTrailingEnvelope(strategy, baseline, asOfIso, minBaselineTrades);

    const base: Omit<StrategyDegradationRow, 'verdict' | 'reason'> = {
      strategy,
      pooledCohort,
      window,
      cohortTrades: cohort.length,
      envelope,
      breaches: [],
      sizeDown: null,
    };
    const note = pooledCohort ? ` — NOTE: ${POOLED_COHORT_NOTE}` : '';

    // Precedence is deliberate: a window we could not judge is reported as
    // unjudged even when an envelope exists, and an envelope we do not have is
    // reported as missing rather than defaulted. Neither reads as HEALTHY.
    if (window.status === 'NOT_MEASURED') {
      rows.push({
        ...base,
        verdict: 'NOT_MEASURED',
        reason:
          `No gradeable trades in this fold (cohort holds ${cohort.length}). `
          + (declaredRow
            ? 'This cohort has a DECLARED envelope and produced nothing to grade — it has either '
              + 'stopped trading or every row was excluded as cost-unmeasurable. Check the coverage census.'
            : 'Nothing to measure.')
          + note,
      });
      continue;
    }

    if (window.status === 'INSUFFICIENT') {
      rows.push({
        ...base,
        verdict: 'INSUFFICIENT',
        reason:
          `Looked, and the rolling window is thin: ${window.n} gradeable trades against a floor of `
          + `${minWindowTrades}. NO CALL MADE in either direction — a degradation verdict at this n `
          + `is noise, and a green one is worse.${note}`,
      });
      continue;
    }

    if (envelope === null) {
      rows.push({
        ...base,
        verdict: 'NO_ENVELOPE',
        reason:
          `Window is gradeable (${window.n} trades) but there is NOTHING TO GRADE IT AGAINST: no `
          + `declared envelope for this cohort, and its ${baseline.length}-trade trailing baseline `
          + `could not mint one (needs ${minBaselineTrades} trades with positive PF and expectancy). `
          + `This is a "could not check", not a pass.${note}`,
      });
      continue;
    }

    const pf = window.profitFactor;
    const exp = window.expectancyR;
    /* c8 ignore next 3 — unreachable: status 'OK' guarantees both are non-null. */
    if (pf === null || exp === null) {
      rows.push({ ...base, verdict: 'NO_ENVELOPE', reason: 'Window cell reported OK with null metrics.' });
      continue;
    }

    const breaches = [
      breachOf('profitFactor', pf, envelope.minProfitFactor),
      breachOf('expectancyR', exp, envelope.minExpectancyR),
    ].filter((b): b is EnvelopeBreach => b !== null);

    const envelopeLabel = envelope.isValidation
      ? `DECLARED envelope (${envelope.provenance})`
      : `DERIVED envelope — not a validation (${envelope.provenance})`;

    if (breaches.length === 0) {
      rows.push({
        ...base,
        verdict: 'HEALTHY',
        reason:
          `Inside its envelope over the last ${window.n} gradeable trades: PF ${pf.toFixed(3)} ≥ `
          + `${envelope.minProfitFactor.toFixed(3)}, expectancy ${exp.toFixed(4)}R ≥ `
          + `${envelope.minExpectancyR.toFixed(4)}R. ${envelopeLabel}${note}`,
      });
      continue;
    }

    rows.push({
      ...base,
      verdict: 'DEGRADED',
      breaches,
      sizeDown: recommendSizeDown(strategy, breaches),
      reason:
        `ADVISORY DEGRADATION over the last ${window.n} gradeable trades: `
        + breaches
            .map(
              (b) =>
                `${b.metric} ${b.observed.toFixed(4)} below floor ${b.floor.toFixed(4)} `
                + `(${(b.shortfall * 100).toFixed(0)}% short)`,
            )
            .join('; ')
        + `. ${envelopeLabel}. NO AUTOMATIC ACTION IS TAKEN — the existing breakers own halts; `
        + `this is a flag and a recommendation.${note}`,
    });
  }

  const verdictRank: Record<DegradationVerdict, number> = {
    DEGRADED: 0,
    NO_ENVELOPE: 1,
    INSUFFICIENT: 2,
    NOT_MEASURED: 3,
    HEALTHY: 4,
  };
  rows.sort(
    (a, b) =>
      verdictRank[a.verdict] - verdictRank[b.verdict]
      || b.window.n - a.window.n
      || a.strategy.localeCompare(b.strategy),
  );

  const verdictCensus = emptyCensus();
  for (const r of rows) verdictCensus[r.verdict] += 1;

  return {
    issue: 'TRA-4913',
    advisoryOnly: true,
    generatedAtIso: asOfIso,
    recentWindow,
    minWindowTrades,
    minBaselineTrades,
    degradationTolerance: DEGRADATION_TOLERANCE,
    coverage,
    rows,
    verdictCensus,
    degradedStrategies: rows.filter((r) => r.verdict === 'DEGRADED').map((r) => r.strategy),
    nonGreenStrategies: rows
      .filter((r) => NON_GREEN_VERDICTS.includes(r.verdict))
      .map((r) => r.strategy),
    declaredEnvelopeCount: declared.length,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Rendering — the brief / EOD section
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Markdown for the EOD report / morning brief.
 *
 * Returns `''` only when the fold saw no cohorts at all, so a quiet day adds no
 * noise. It does NOT return '' merely because nothing degraded: a run where every
 * cohort reads `INSUFFICIENT` or `NO_ENVELOPE` is exactly the run a reader must
 * not mistake for a clean one, so the census is always printed when there is
 * anything to print.
 */
export function renderStrategyDegradationMarkdown(report: StrategyDegradationReport): string {
  if (report.rows.length === 0) return '';

  const num = (v: number | null, digits: number) => (v === null ? '—' : v.toFixed(digits));
  const badge: Record<DegradationVerdict, string> = {
    DEGRADED: '⚠️ DEGRADED',
    NO_ENVELOPE: 'NO ENVELOPE',
    INSUFFICIENT: 'INSUFFICIENT',
    NOT_MEASURED: 'NOT MEASURED',
    HEALTHY: 'ok',
  };

  const body = report.rows
    .map((r) => {
      const env = r.envelope;
      const envCol = env === null
        ? '—'
        : `PF ${env.minProfitFactor.toFixed(2)} / ${env.minExpectancyR.toFixed(3)}R`
          + (env.isValidation ? ' (declared)' : ' (derived)');
      const size = r.sizeDown === null ? '—' : `${r.sizeDown.recommendedSizeFactor.toFixed(2)}×`;
      return (
        `| ${r.strategy}${r.pooledCohort ? ' ⚠pooled' : ''} | ${badge[r.verdict]} | ${r.window.n} | `
        + `${num(r.window.profitFactor, 2)} | ${num(r.window.expectancyR, 3)} | ${envCol} | ${size} |`
      );
    })
    .join('\n');

  const c = report.verdictCensus;
  const census =
    `${c.DEGRADED} degraded · ${c.HEALTHY} healthy · ${c.INSUFFICIENT} insufficient · `
    + `${c.NO_ENVELOPE} no-envelope · ${c.NOT_MEASURED} not-measured`;

  return `### Strategy degradation monitor (TRA-4913) — ADVISORY ONLY

_No automatic trade action, no automatic sizing change, no auto-disable. Hard halts stay with
\`options-risk-breaker\` / \`DailyRiskGovernor\` / the churn brakes. This section is a flag and a
recommendation; a human or one of those breakers acts._

Rolling window ${report.recentWindow} trades (floor ${report.minWindowTrades}) · tolerance ${(report.degradationTolerance * 100).toFixed(0)}% · ${census}
${report.declaredEnvelopeCount === 0
  ? '\n⚠️ **Zero DECLARED envelopes are in force.** Every verdict below is against a cohort\'s own trailing\nbaseline, which is not a validation — if the baseline was already degraded the floor is low and the\ncohort passes while bleeding. See `DECLARED_STRATEGY_ENVELOPES`.\n'
  : ''}
| Cohort | Verdict | n | PF | Expectancy | Envelope floor | Size-down |
|--------|---------|---|----|------------|----------------|-----------|
${body}`;
}
