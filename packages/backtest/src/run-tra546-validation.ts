// TRA-546 (TRA-529 P3) — driver for the agent validation harness. Replays the
// P1 stub graph over a synthetic multi-regime 24/7 series under an as-of
// clock, persists every recommendation, and writes the four metric reports
// (ledger, scoring, calibration, net-of-cost edge) to disk + a console summary.
//
// INCURS NO LLM SPEND — it drives the deterministic P1 stub. It is the
// scaffolding QuantTrader points at a real recommendation stream once P2 lands;
// nothing here produces the real OOS verdict.
//
// Run:
//   pnpm --filter @trading-app/backtest exec tsx src/run-tra546-validation.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { syntheticCryptoSeries } from './synthetic.js';
import { momentumCandidate } from './agent-replay.js';
import { buildValidationMarkdown, runAgentValidation } from './agent-validation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

const SYMBOL = 'BTC-USD';
const DAYS = 120; // ~4 regimes of the synthetic generator.
const HORIZON_BARS = 24; // 1 day of look-forward at 1h bars.

async function main(): Promise<void> {
  // Deterministic, fixed-seed series — multi-regime so convictions span the
  // [0,1] band and the reliability curve has something to bin.
  const candles = syntheticCryptoSeries(DAYS, SYMBOL, 30_000, 60, 31);

  const { report } = await runAgentValidation(candles, {
    symbol: SYMBOL,
    candidateAt: momentumCandidate({ lookback: 10, threshold: 0.01, stopPct: 0.02, rr: 2 }),
    warmup: 30,
    step: 4, // every 4h — event-gate cadence, keeps the run light.
    horizonBars: HORIZON_BARS,
    calibrationBins: 10,
    riskBudgetUsd: 100,
    // No llm dep → P1 deterministic stub → costUsd = 0. Lower the trader's
    // no-edge band so the stub surfaces more directional (APPROVE) calls — this
    // only enriches the demo's reliability curve; it does not touch the
    // harness's scoring math, which P2 re-runs against the real graph.
    graphDeps: { trader: { actionThreshold: 0.05 } },
  });

  const md = buildValidationMarkdown(report);
  mkdirSync(REPORT_DIR, { recursive: true });
  const jsonPath = resolve(REPORT_DIR, 'tra546-validation.json');
  const mdPath = resolve(REPORT_DIR, 'tra546-validation.md');
  writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  writeFileSync(mdPath, md);

  // Console summary (the four reports at a glance).
  console.log(`\n=== TRA-546 Agent Validation Harness — ${SYMBOL} ===`);
  console.log(
    `Replayed ${report.decisions} decisions over ${report.bars} bars `
      + `(${report.horizonBars}-bar horizon).`,
  );
  console.log(`\n[1] Ledger: ${report.recommendations.length} recommendations persisted, `
    + `cost $${report.totalCostUsd.toFixed(4)}, latency ${report.totalLatencyMs}ms`);
  console.log(
    `[2] Scoring: agent hit-rate ${(report.scoring.agent.winRate * 100).toFixed(1)}% `
      + `(avg ${report.scoring.agent.avgRR.toFixed(2)}R) vs baseline `
      + `${(report.scoring.baseline.winRate * 100).toFixed(1)}% `
      + `(avg ${report.scoring.baseline.avgRR.toFixed(2)}R); `
      + `edge ${report.scoring.edgeVsBaseline.avgRDelta.toFixed(2)}R`,
  );
  console.log(
    `[3] Calibration: ECE ${report.calibration.expectedCalibrationError.toFixed(3)}, `
      + `Brier ${report.calibration.brierScore.toFixed(3)}, n=${report.calibration.sampleSize}`,
  );
  console.log(
    `[4] Net-of-cost edge: gross ${report.netEdge.grossEdgeR.toFixed(3)}R `
      + `($${report.netEdge.grossEdgeUsd.toFixed(2)}), net $${report.netEdge.netEdgeUsd.toFixed(2)} `
      + `over ${report.netEdge.trades} trades`,
  );
  console.log(`\nReports written:\n  ${jsonPath}\n  ${mdPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
