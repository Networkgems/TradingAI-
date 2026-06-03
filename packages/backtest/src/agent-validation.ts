// TRA-546 (TRA-529 P3 §7/§8) — the validation harness entry point. Ties the
// three stages together: point-in-time replay → scoring (hit-rate, avg R,
// agent-vs-baseline) → conviction calibration + net-of-cost edge. Emits the
// four metric reports the acceptance criteria call for:
//   1. recommendations ledger (every AgentRecommendation persisted)
//   2. scoring report           (hit-rate, avg R-multiple, vs deterministic baseline)
//   3. conviction calibration   (reliability curve)
//   4. net-of-cost edge
//
// QuantTrader owns the scoring METHODOLOGY and runs the real OOS study once
// P2's real agents land; this module is the wiring that lets them point it at a
// real recommendation stream with zero code changes (swap the candle source +
// graphDeps.llm).
import type { Candle } from '@trading-app/shared';
import {
  replayAgents,
  type AgentReplayConfig,
  type AgentReplayRecord,
  type AgentReplayResult,
} from './agent-replay.js';
import { scoreReplay, type AgentScoreReport } from './agent-scoring.js';
import {
  netOfCostEdge,
  reliabilityCurve,
  type NetEdgeReport,
  type ReliabilityCurve,
} from './agent-calibration.js';

export interface AgentValidationOptions extends AgentReplayConfig {
  /** Bars of look-forward each replayed trade is scored over. Default 20. */
  horizonBars?: number;
  /** Reliability-curve bin count. Default 10. */
  calibrationBins?: number;
  /** $ risked per trade for the net-of-cost edge calc. Default 100. */
  riskBudgetUsd?: number;
}

/** The persisted recommendations ledger — report (1). */
export interface RecommendationLedgerRow {
  asOf: number;
  barIndex: number;
  action: string;
  verdict: string;
  conviction: number;
  routable: boolean;
  costUsd: number;
  latencyMs: number;
}

export interface AgentValidationReport {
  symbol: string;
  bars: number;
  decisions: number;
  horizonBars: number;
  /** (1) Every recommendation produced during replay (carries cost + latency). */
  recommendations: RecommendationLedgerRow[];
  totalCostUsd: number;
  totalLatencyMs: number;
  /** (2) Hit-rate / avg-R / agent-vs-deterministic-baseline. */
  scoring: AgentScoreReport;
  /** (3) Conviction reliability curve. */
  calibration: ReliabilityCurve;
  /** (4) Net-of-cost edge. */
  netEdge: NetEdgeReport;
}

function ledgerRow(rec: AgentReplayRecord): RecommendationLedgerRow {
  const r = rec.recommendation;
  return {
    asOf: rec.asOf,
    barIndex: rec.barIndex,
    action: r.action,
    verdict: r.verdict,
    conviction: r.conviction,
    routable: r.proposedSignal !== null,
    costUsd: r.costUsd,
    latencyMs: r.latencyMs,
  };
}

/**
 * Run the full validation harness end-to-end over a candle series and return
 * the four metric reports. Deterministic and free against the P1 stub.
 */
export async function runAgentValidation(
  candles: Candle[],
  options: AgentValidationOptions,
): Promise<{ replay: AgentReplayResult; report: AgentValidationReport }> {
  const horizonBars = options.horizonBars ?? 20;
  const replay = await replayAgents(candles, options);

  const scoring = scoreReplay(replay.records, candles, horizonBars);
  const calibration = reliabilityCurve(
    replay.records,
    candles,
    horizonBars,
    options.calibrationBins ?? 10,
  );
  const netEdge = netOfCostEdge(
    replay.records,
    candles,
    horizonBars,
    options.riskBudgetUsd ?? 100,
  );

  const report: AgentValidationReport = {
    symbol: replay.symbol,
    bars: replay.bars,
    decisions: replay.decisions,
    horizonBars,
    recommendations: replay.records.map(ledgerRow),
    totalCostUsd: replay.totalCostUsd,
    totalLatencyMs: replay.totalLatencyMs,
    scoring,
    calibration,
    netEdge,
  };
  return { replay, report };
}

const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

/** Render the four reports as a single human-readable markdown document. */
export function buildValidationMarkdown(report: AgentValidationReport): string {
  const { scoring, calibration, netEdge } = report;
  const lines: string[] = [];
  lines.push(`# Agent Validation Harness — ${report.symbol}`);
  lines.push('');
  lines.push(
    `Replayed **${report.decisions}** decisions over **${report.bars}** bars `
      + `(${report.horizonBars}-bar scoring horizon). P1 stub: no LLM spend.`,
  );
  lines.push('');

  // (1) Recommendations ledger summary.
  lines.push('## 1. Recommendations ledger');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Recommendations persisted | ${report.recommendations.length} |`);
  lines.push(`| Routable (APPROVE) | ${scoring.routableCount} |`);
  lines.push(`| Total cost (USD) | $${report.totalCostUsd.toFixed(4)} |`);
  lines.push(`| Total latency (ms) | ${report.totalLatencyMs} |`);
  lines.push('');

  // (2) Scoring.
  lines.push('## 2. Scoring — hit-rate, avg R, agent vs deterministic baseline');
  lines.push('');
  lines.push('| Stream | Signals | Hit-rate | Avg R |');
  lines.push('| --- | --- | --- | --- |');
  lines.push(
    `| Agent (routable) | ${scoring.agent.totalSignals} | `
      + `${pct(scoring.agent.winRate)} | ${scoring.agent.avgRR.toFixed(2)}R |`,
  );
  lines.push(
    `| Deterministic baseline | ${scoring.baseline.totalSignals} | `
      + `${pct(scoring.baseline.winRate)} | ${scoring.baseline.avgRR.toFixed(2)}R |`,
  );
  lines.push(
    `| **Edge (agent − baseline)** | — | `
      + `${pct(scoring.edgeVsBaseline.winRateDelta)} | `
      + `${scoring.edgeVsBaseline.avgRDelta.toFixed(2)}R |`,
  );
  lines.push('');

  // (3) Calibration.
  lines.push('## 3. Conviction calibration (reliability curve)');
  lines.push('');
  lines.push(
    `ECE **${calibration.expectedCalibrationError.toFixed(3)}** · `
      + `Brier **${calibration.brierScore.toFixed(3)}** · n=${calibration.sampleSize}`,
  );
  lines.push('');
  lines.push('| Conviction bin | n | Predicted | Observed hit-rate |');
  lines.push('| --- | --- | --- | --- |');
  for (const b of calibration.bins) {
    if (b.count === 0) continue;
    lines.push(
      `| [${b.lo.toFixed(1)}, ${b.hi.toFixed(1)}) | ${b.count} | `
        + `${pct(b.meanConviction)} | ${pct(b.hitRate)} |`,
    );
  }
  lines.push('');

  // (4) Net-of-cost edge.
  lines.push('## 4. Net-of-cost edge');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('| --- | --- |');
  lines.push(`| Trades | ${netEdge.trades} |`);
  lines.push(`| Gross edge | ${netEdge.grossEdgeR.toFixed(3)}R |`);
  lines.push(`| Risk budget / trade | $${netEdge.riskBudgetUsd.toFixed(2)} |`);
  lines.push(`| Gross edge | $${netEdge.grossEdgeUsd.toFixed(2)} |`);
  lines.push(`| LLM cost | $${netEdge.totalCostUsd.toFixed(4)} |`);
  lines.push(`| **Net edge** | $${netEdge.netEdgeUsd.toFixed(2)} |`);
  lines.push(`| Net edge / trade | $${netEdge.netEdgePerTradeUsd.toFixed(2)} |`);
  lines.push('');
  lines.push(
    '> P1 stub emits costUsd = 0, so net == gross. The subtraction is live for '
      + "P2's real per-call spend. The real OOS verdict needs P2's recommendations.",
  );
  lines.push('');
  return lines.join('\n');
}
