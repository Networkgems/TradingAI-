import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import type { EodSignalAccuracy } from '@trading-app/shared';
import type { AgentScoreReport } from '@trading-app/backtest';
import { logger } from './observability/index.js';
import type { ForwardTestReport } from './options-forward-test.js';

// TRA-1141 (TRA-1139) — the combined accuracy scorecard.
//
// One read-only view that puts BOTH idea engines side by side on out-of-sample
// data, so the board can compare them honestly instead of guessing "which is
// more accurate":
//
//   • Proposals (equity/crypto agent-debate graph) — OOS accuracy comes from the
//     TRA-797 agents A/B replay study (`packages/backtest` agent-scoring.ts):
//     routable APPROVE trades vs the deterministic candidate baseline they gated,
//     scored over a fixed look-forward horizon. There is NO live proposals
//     outcome ledger (the pending-proposal store is ephemeral, 15-min TTL — see
//     proposal-store.ts), so this side surfaces the latest persisted A/B report
//     artifact when present and is clearly marked unavailable otherwise.
//
//   • AI Ideas (defined-risk options) — OOS accuracy comes from the TRA-601
//     forward-test of the idea journal: each surfaced idea re-priced ONLY against
//     option chains recorded on/after its surface date (no look-ahead), rolled up
//     to hit-rate / expectancy / POP-calibration over PRICED-only resolved ideas.
//
// This module ONLY reads and re-shapes those two existing computations — it does
// not change how either ledger is computed (out of scope per the ticket). Both
// sides carry an explicit sample-size verdict so a thin sample can never be read
// as a winner: we never declare one engine "more accurate" until both clear the
// documented floor — and even then they trade different asset classes, so the
// view reports the numbers and leaves the call to the board.

const log = logger.child({ module: 'engine-scorecard' });

const __dirname = dirname(fileURLToPath(import.meta.url));

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

/**
 * Shared OOS sample-size floor. Both engines independently document a 30-unit
 * floor against small-n noise, so the scorecard uses one number:
 *   • Proposals — TRA-797 §4 power gate `MIN_ROUTABLE_N = 30` (per arm).
 *   • AI Ideas  — TRA-601 live-capital gate `minResolvedIdeas = 30`.
 */
export const SCORECARD_MIN_SAMPLE = 30;

export type SampleLabel = 'insufficient' | 'thin' | 'adequate';

/** A sample's adequacy verdict — surfaced on every metric block so the UI can
 *  flag small/insufficient samples and never imply a winner before data clears. */
export interface SampleAdequacy {
  /** Sample size (routable trades for proposals; resolved priced ideas for AI Ideas). */
  n: number;
  /** The documented floor below which the sample is too small to trust. */
  minSample: number;
  /** `adequate` ≥ floor, `thin` ≥ half-floor, else `insufficient`. */
  label: SampleLabel;
  /** True only when `n >= minSample`. The "data has cleared" boolean. */
  sufficient: boolean;
}

/** Classify a sample against the floor. Pure. */
export function classifySample(n: number, minSample = SCORECARD_MIN_SAMPLE): SampleAdequacy {
  const half = Math.ceil(minSample / 2);
  const label: SampleLabel = n >= minSample ? 'adequate' : n >= half ? 'thin' : 'insufficient';
  return { n, minSample, label, sufficient: n >= minSample };
}

/** Pooled win-rate / avg-R for one side (agent or baseline). */
export interface AccuracyPair {
  /** Hit-rate (R > 0), 0–1. Null when the pool is empty. */
  winRate: number | null;
  /** Mean realized R-multiple. Null when the pool is empty. */
  avgR: number | null;
  /** Scored-signal count contributing to the pool. */
  n: number;
}

export interface ProposalsScorecard {
  engine: 'proposals';
  label: string;
  /** True when a parseable OOS A/B report was loaded. */
  available: boolean;
  /** Provenance, or the reason the side is unavailable. */
  source: string;
  /** Routable APPROVE trades the agent layer produced. */
  agent: AccuracyPair;
  /** Deterministic candidate signals that gated the runs. */
  baseline: AccuracyPair;
  /** Agent − baseline edge (the value the agent layer added). */
  edgeVsBaseline: { winRateDelta: number | null; avgRDelta: number | null };
  /** Bars of look-forward each trade was scored over (null when unavailable). */
  horizonBars: number | null;
  /** Total recommendations replayed across symbols. */
  totalRecommendations: number;
  /** Sample verdict — n = routable agent trades. */
  sample: SampleAdequacy;
  /** OOS window the report covered, when the artifact carried it. */
  generatedWindow: { start: string; end: string } | null;
}

export interface AiIdeasScorecard {
  engine: 'ai-ideas';
  label: string;
  /** Always true — the forward-test report is computed live (empty when no data). */
  available: boolean;
  source: string;
  /** Total ideas surfaced/journaled. */
  surfaced: number;
  /** PRICED-only resolved ideas (the gate sample; excludes fallback/stale/no-denom). */
  resolved: number;
  /** Open (marked-to-market, not yet settled) ideas. */
  open: number;
  /** Outcomes excluded from every metric (fallback-priced / stale / no max-loss). */
  excluded: number;
  /** Wins ÷ resolved. Null when nothing resolved. */
  hitRate: number | null;
  /** Mean PRE-cost realized P/L (USD/1-lot) over resolved. */
  expectancyUsd: number | null;
  /** Mean PRE-cost realized R-multiple over resolved. */
  expectancyR: number | null;
  /** Mean COST-NET realized R-multiple — the figure the live-capital gate reads. */
  expectancyNetR: number | null;
  /** Mean model probability-of-profit over resolved. */
  avgPredictedPop: number | null;
  /** hitRate − avgPredictedPop: + = under-promised, − = over-promised. */
  popCalibrationGap: number | null;
  /** Resolved ideas whose realized loss breached the stated defined-risk max. */
  maxLossBreaches: number;
  /** Sample verdict — n = resolved priced ideas. */
  sample: SampleAdequacy;
}

export interface EngineScorecard {
  proposals: ProposalsScorecard;
  aiIdeas: AiIdeasScorecard;
  comparison: {
    /** True only when BOTH engines have cleared the sample floor. */
    bothSamplesSufficient: boolean;
    /** Honest, winner-free disposition string for the panel header. */
    note: string;
  };
}

const PROPOSALS_LABEL = 'Proposals — equity/crypto agent-debate graph (OOS A/B replay)';
const AI_IDEAS_LABEL = 'AI Ideas — defined-risk options (forward-test journal)';

function unavailableProposals(source: string): ProposalsScorecard {
  return {
    engine: 'proposals',
    label: PROPOSALS_LABEL,
    available: false,
    source,
    agent: { winRate: null, avgR: null, n: 0 },
    baseline: { winRate: null, avgR: null, n: 0 },
    edgeVsBaseline: { winRateDelta: null, avgRDelta: null },
    horizonBars: null,
    totalRecommendations: 0,
    sample: classifySample(0),
    generatedWindow: null,
  };
}

/**
 * Pool a set of per-symbol {@link AgentScoreReport}s into one agent/baseline
 * accuracy pair + edge. Pooling is sample-size weighted: win-rate pools exactly
 * from the per-symbol win counts, and avg-R pools as `Σ(avgRR·n) / Σn` — a
 * faithful re-aggregation of the existing scores, NOT a recomputation of any
 * trade's R (out of scope). Pure.
 */
export function poolProposalScores(reports: readonly AgentScoreReport[]): {
  agent: AccuracyPair;
  baseline: AccuracyPair;
  edgeVsBaseline: { winRateDelta: number | null; avgRDelta: number | null };
  horizonBars: number | null;
  totalRecommendations: number;
} {
  const poolSide = (pick: (r: AgentScoreReport) => EodSignalAccuracy): AccuracyPair => {
    let n = 0;
    let wins = 0;
    let rSum = 0;
    for (const r of reports) {
      const s = pick(r);
      n += s.totalSignals;
      wins += s.winningSignals;
      rSum += s.avgRR * s.totalSignals;
    }
    return {
      n,
      winRate: n > 0 ? round(wins / n) : null,
      avgR: n > 0 ? round(rSum / n) : null,
    };
  };
  const agent = poolSide((r) => r.agent);
  const baseline = poolSide((r) => r.baseline);
  const horizonBars = reports.length > 0 ? (reports[0]!.horizonBars ?? null) : null;
  const totalRecommendations = reports.reduce((s, r) => s + r.totalRecommendations, 0);
  return {
    agent,
    baseline,
    edgeVsBaseline: {
      winRateDelta:
        agent.winRate != null && baseline.winRate != null
          ? round(agent.winRate - baseline.winRate)
          : null,
      avgRDelta:
        agent.avgR != null && baseline.avgR != null ? round(agent.avgR - baseline.avgR) : null,
    },
    horizonBars,
    totalRecommendations,
  };
}

interface ParsedProposalsArtifact {
  reports: AgentScoreReport[];
  window: { start: string; end: string } | null;
}

function isScoreReport(v: unknown): v is AgentScoreReport {
  if (!v || typeof v !== 'object') return false;
  const o = v as Record<string, unknown>;
  const acc = (x: unknown): boolean =>
    !!x &&
    typeof x === 'object' &&
    typeof (x as Record<string, unknown>)['totalSignals'] === 'number' &&
    typeof (x as Record<string, unknown>)['winRate'] === 'number' &&
    typeof (x as Record<string, unknown>)['avgRR'] === 'number';
  return acc(o['agent']) && acc(o['baseline']);
}

/**
 * Extract the per-symbol {@link AgentScoreReport}s from a parsed TRA-797
 * agents-A/B artifact (`tra797-agents-ab.json`). The artifact carries
 * `validations: Record<symbol, { scoring: AgentScoreReport }>` and an optional
 * `generatedWindow`. Returns null if no scoring blocks are present. Pure.
 */
export function parseProposalsArtifact(raw: unknown): ParsedProposalsArtifact | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const validations = o['validations'];
  if (!validations || typeof validations !== 'object') return null;
  const reports: AgentScoreReport[] = [];
  for (const v of Object.values(validations as Record<string, unknown>)) {
    if (!v || typeof v !== 'object') continue;
    const scoring = (v as Record<string, unknown>)['scoring'];
    if (isScoreReport(scoring)) reports.push(scoring);
  }
  if (reports.length === 0) return null;
  const win = o['generatedWindow'];
  let window: { start: string; end: string } | null = null;
  if (win && typeof win === 'object') {
    const w = win as Record<string, unknown>;
    if (typeof w['start'] === 'string' && typeof w['end'] === 'string') {
      window = { start: w['start'], end: w['end'] };
    }
  }
  return { reports, window };
}

/** Build the Proposals side from already-parsed per-symbol scores. Pure. */
export function buildProposalsScorecard(parsed: ParsedProposalsArtifact, source: string): ProposalsScorecard {
  const pooled = poolProposalScores(parsed.reports);
  return {
    engine: 'proposals',
    label: PROPOSALS_LABEL,
    available: true,
    source,
    agent: pooled.agent,
    baseline: pooled.baseline,
    edgeVsBaseline: pooled.edgeVsBaseline,
    horizonBars: pooled.horizonBars,
    totalRecommendations: pooled.totalRecommendations,
    sample: classifySample(pooled.agent.n),
    generatedWindow: parsed.window,
  };
}

/**
 * Default candidate paths for the persisted Proposals OOS A/B artifact. The
 * report is produced by an offline backtest run (`run-tra797-agents-ab.ts` →
 * `packages/backtest/reports/tra797-agents-ab.json`) and is NOT generated on the
 * server, so on a deploy that never ran the harness this resolves to "unavailable"
 * — which the scorecard reports honestly rather than faking a sample.
 */
export function proposalsReportCandidates(): string[] {
  const env = process.env['PROPOSALS_OOS_REPORT_PATH'];
  const candidates: string[] = [];
  if (env && env.trim() !== '') candidates.push(env.trim());
  const dataDir = process.env['DATA_DIR'];
  if (dataDir) candidates.push(join(dataDir, 'proposals-oos-report.json'));
  // Monorepo dev layout: server/src → backtest/reports.
  candidates.push(resolve(__dirname, '..', '..', 'backtest', 'reports', 'tra797-agents-ab.json'));
  return candidates;
}

/** Load + build the Proposals side, gracefully degrading to "unavailable". */
export async function loadProposalsScorecard(paths?: readonly string[]): Promise<ProposalsScorecard> {
  const candidates = paths && paths.length > 0 ? [...paths] : proposalsReportCandidates();
  const found = candidates.find((p) => existsSync(p));
  if (!found) {
    return unavailableProposals(
      'no persisted OOS A/B report found (run the TRA-797 agents A/B harness; ' +
        'set PROPOSALS_OOS_REPORT_PATH to surface it). Proposals have no live outcome ledger.',
    );
  }
  try {
    const parsed = parseProposalsArtifact(JSON.parse(await readFile(found, 'utf-8')));
    if (!parsed) return unavailableProposals(`OOS report at ${found} carried no agent scoring blocks`);
    return buildProposalsScorecard(parsed, `TRA-797 agents A/B report (${found})`);
  } catch (err) {
    log.error('failed to read proposals OOS report', {
      path: found,
      reason: err instanceof Error ? err.message : String(err),
    });
    return unavailableProposals(`OOS report at ${found} could not be parsed`);
  }
}

/** Build the AI Ideas side from the TRA-601 forward-test report. Pure. */
export function buildAiIdeasScorecard(report: ForwardTestReport): AiIdeasScorecard {
  const t = report.totals;
  return {
    engine: 'ai-ideas',
    label: AI_IDEAS_LABEL,
    available: true,
    source: `TRA-601 forward-test @ ${report.asOfDate} (chains: ${report.chainsDir})`,
    surfaced: t.surfaced,
    resolved: t.resolved,
    open: t.open,
    excluded: t.excluded,
    hitRate: t.hitRate,
    expectancyUsd: t.expectancyUsd,
    expectancyR: t.expectancyR,
    expectancyNetR: t.expectancyNetR,
    avgPredictedPop: t.avgPredictedPop,
    popCalibrationGap: t.popCalibrationGap,
    maxLossBreaches: t.maxLossBreaches,
    sample: classifySample(t.resolved),
  };
}

/**
 * Assemble the side-by-side scorecard + an honest, winner-free disposition. Pure.
 * The `note` deliberately never names a "more accurate" engine: until BOTH
 * samples clear the floor the comparison is statistically meaningless, and even
 * once they clear, the two engines trade different asset classes — so the view
 * reports the numbers and leaves the judgement to the board.
 */
export function buildEngineScorecard(
  proposals: ProposalsScorecard,
  aiIdeas: AiIdeasScorecard,
): EngineScorecard {
  const bothSamplesSufficient = proposals.sample.sufficient && aiIdeas.sample.sufficient;
  let note: string;
  if (!proposals.available && aiIdeas.sample.n === 0) {
    note =
      'No out-of-sample data on either engine yet. Proposals need the TRA-797 A/B harness; ' +
      'AI Ideas need resolved journaled ideas. No comparison possible.';
  } else if (!bothSamplesSufficient) {
    const thin: string[] = [];
    if (!proposals.sample.sufficient) thin.push(`Proposals n=${proposals.sample.n}`);
    if (!aiIdeas.sample.sufficient) thin.push(`AI Ideas n=${aiIdeas.sample.n}`);
    note =
      `Sample below the ${SCORECARD_MIN_SAMPLE}-unit floor (${thin.join(', ')}). ` +
      'Numbers shown for transparency only — no engine is more/less accurate at this sample size.';
  } else {
    note =
      'Both engines have cleared the sample floor. They trade different asset classes ' +
      '(equity/crypto directional vs defined-risk options), so read the per-engine metrics ' +
      'directly rather than as a single "winner".';
  }
  return { proposals, aiIdeas, comparison: { bothSamplesSufficient, note } };
}
