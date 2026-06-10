/**
 * TRA-550 OOS validation driver (TRA-529 P4 verdict).
 *
 * Thin glue that points the TRA-546 validation harness (`agent-validation.ts`)
 * at **real Coinbase 4H candles + the real `AnthropicLlmClient`** (TRA-747,
 * `e5807fe`) over the held-out OOS window **2026-03-09 → 2026-06-09**, per asset
 * (SOL-USD, DOGE-USD). No harness/graph changes — this is the driver only.
 *
 * Per asset it:
 *   1. Fetches real 4H candles via `coinbase-feed.ts` (1H + `aggregate1hTo4h`,
 *      wrapped by `fetchCoinbase4hBars`).
 *   2. Wires `graphDeps.llm = createAnthropicLlmClientFromEnv()` — fast=Haiku 4.5,
 *      strong=Sonnet 4.6 (the DEFAULT_TIER_MODELS in `anthropic-llm-client.ts`).
 *   3. Runs `runAgentValidation` with per-asset `horizonBars` (SOL=2, DOGE=10),
 *      `step=6`, `warmup=30`, `riskBudgetUsd=100`, `calibrationBins=10`; baseline
 *      candidate = the production `bb_fade` strategy, point-in-time, identical bars.
 *   4. Runs a bootstrap CI over the realized per-trade R: p5(net-of-cost avg-R)
 *      and p5(vs-baseline avg-R delta) per arm.
 *   5. Writes `reports/tra550-oos-{asset}.json` + a combined
 *      `reports/tra550-verdict.json` (the 5 metrics + the p5 gates + per-arm
 *      routable-trade counts).
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPEND SAFETY — this script does NOT spend by default.
 *   • `pnpm … exec tsx src/run-tra550-oos.ts`            → PLAN mode: prints the
 *     config + confirms Anthropic key reachability, runs NOTHING. Safe to run.
 *   • `… run-tra550-oos.ts --smoke`                       → free DETERMINISTIC
 *     smoke: the full pipeline (real candle fetch + bb_fade candidate + harness +
 *     bootstrap + report writing) driven by the P1 deterministic fakes (no `llm`,
 *     zero LLM spend). Proves the wiring end-to-end. Reports are tagged
 *     `mode: "smoke-deterministic"` so they're never mistaken for the verdict.
 *   • `… run-tra550-oos.ts --execute`                     → the REAL paid run:
 *     wires the live AnthropicLlmClient. **Gated on CFO approval (≤$50 one-time).**
 *     QuantTrader triggers this after sign-off; do NOT run it speculatively.
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra550-oos.ts [--smoke|--execute]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, TradeSignal } from '@trading-app/shared';
import { BbFadeStrategy } from '@trading-app/engine';
import {
  type AgentGraphDeps,
  type LlmClient,
  createAnthropicLlmClientFromEnv,
  describeAnthropicCredFromEnv,
  DEFAULT_TIER_MODELS,
} from '@trading-app/agents';
import { fetchCoinbase4hBars } from './coinbase-feed.js';
import { type CandidateGenerator } from './agent-replay.js';
import { realizedR } from './agent-scoring.js';
import { runAgentValidation, type AgentValidationReport } from './agent-validation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// Held-out OOS window — [fromMs, toMs); fetchCoinbase4hBars is half-open.
const WINDOW_START_MS = Date.UTC(2026, 2, 9); // 2026-03-09 00:00 UTC
const WINDOW_END_MS = Date.UTC(2026, 5, 9); // 2026-06-09 00:00 UTC

// Per-asset config. Horizons per the TRA-550 plan: SOL=2, DOGE=10 (4H bars).
interface AssetSpec {
  symbol: string;
  horizonBars: number;
}
const ASSETS: readonly AssetSpec[] = [
  { symbol: 'SOL-USD', horizonBars: 2 },
  { symbol: 'DOGE-USD', horizonBars: 10 },
];

const STEP = 6;
const WARMUP = 30;
const RISK_BUDGET_USD = 100;
const CALIBRATION_BINS = 10;
const BOOTSTRAP_ITERATIONS = 2000;

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;

// ─── bootstrap CI ────────────────────────────────────────────────────────────
// The realized-R distributions we resample here are per-trade R arrays, and the
// vs-baseline metric is a TWO-SAMPLE difference of means over two differently
// sized arms (agent routable trades vs every baseline candidate). `bootstrap.ts`
// resamples a single closed-trade list into a summed EQUITY curve and returns
// only percentile bands — it cannot express either an avg-R mean CI or a
// two-sample delta. So the CI here is a small, self-contained IID resampler that
// reuses `bootstrap.ts`'s exact methodology — Mulberry32 seeded draws + the same
// floor-index percentile — kept inline the same way `bootstrap.ts` itself inlines
// Mulberry32. Deterministic given the seed so the verdict is reproducible.
function mulberry32(seed: number): () => number {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function percentile(sortedAsc: number[], p: number): number {
  if (sortedAsc.length === 0) return 0;
  const idx = Math.min(
    sortedAsc.length - 1,
    Math.max(0, Math.floor((p / 100) * sortedAsc.length)),
  );
  return sortedAsc[idx]!;
}

export interface AvgRBand {
  /** Sample size the band was resampled from. */
  n: number;
  /** Point estimate (mean of the observed sample). */
  mean: number;
  p5: number;
  p50: number;
  p95: number;
  iterations: number;
}

const mean = (xs: readonly number[]): number =>
  xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;

/** One-sample bootstrap CI of the mean of `values` (e.g. net-of-cost avg-R). */
function bootstrapMean(values: number[], seed: number): AvgRBand {
  const n = values.length;
  if (n === 0) {
    return { n: 0, mean: 0, p5: 0, p50: 0, p95: 0, iterations: BOOTSTRAP_ITERATIONS };
  }
  const rand = mulberry32(seed);
  const means: number[] = [];
  for (let it = 0; it < BOOTSTRAP_ITERATIONS; it++) {
    let sum = 0;
    for (let k = 0; k < n; k++) sum += values[Math.floor(rand() * n)]!;
    means.push(sum / n);
  }
  means.sort((a, b) => a - b);
  return {
    n,
    mean: round(mean(values)),
    p5: round(percentile(means, 5)),
    p50: round(percentile(means, 50)),
    p95: round(percentile(means, 95)),
    iterations: BOOTSTRAP_ITERATIONS,
  };
}

/**
 * Two-sample bootstrap CI of `mean(agent) − mean(baseline)` — the vs-baseline
 * avg-R delta. Each iteration resamples both arms independently (they are
 * different sizes and not paired) and records the difference of resampled means.
 */
function bootstrapDelta(agent: number[], baseline: number[], seed: number): AvgRBand {
  const na = agent.length;
  const nb = baseline.length;
  if (na === 0 || nb === 0) {
    return {
      n: Math.min(na, nb),
      mean: round(mean(agent) - mean(baseline)),
      p5: 0,
      p50: 0,
      p95: 0,
      iterations: BOOTSTRAP_ITERATIONS,
    };
  }
  const rand = mulberry32(seed);
  const deltas: number[] = [];
  for (let it = 0; it < BOOTSTRAP_ITERATIONS; it++) {
    let a = 0;
    for (let k = 0; k < na; k++) a += agent[Math.floor(rand() * na)]!;
    let b = 0;
    for (let k = 0; k < nb; k++) b += baseline[Math.floor(rand() * nb)]!;
    deltas.push(a / na - b / nb);
  }
  deltas.sort((x, y) => x - y);
  return {
    n: Math.min(na, nb),
    mean: round(mean(agent) - mean(baseline)),
    p5: round(percentile(deltas, 5)),
    p50: round(percentile(deltas, 50)),
    p95: round(percentile(deltas, 95)),
    iterations: BOOTSTRAP_ITERATIONS,
  };
}

// ─── candidate ───────────────────────────────────────────────────────────────
/**
 * Point-in-time `bb_fade` candidate generator. At each decision bar it sees only
 * the as-of window (all candles ≤ asOf) and runs the production `BbFadeStrategy`
 * — `enforceTimeFilter: false` for 24/7 crypto, matching the TRA-453 / TRA-306
 * backtest config. Pure function of the window: it cannot look ahead.
 */
function bbFadeCandidate(symbol: string): CandidateGenerator {
  const strat = new BbFadeStrategy({ enforceTimeFilter: false });
  return (_asOf, window): TradeSignal | null => strat.evaluate(symbol, window as Candle[]);
}

// ─── per-trade R extraction ──────────────────────────────────────────────────
/**
 * Realized per-trade R for both arms over the SAME `horizonBars` look-forward the
 * harness scores on (no look-ahead — `realizedR` only sees bars strictly after
 * the decision bar). The agent arm is its routable (APPROVE) proposals; the
 * baseline arm is every deterministic candidate that gated a run. Net-of-cost
 * subtracts the run's total LLM spend, amortised per routable trade and converted
 * R-units at `riskBudgetUsd` — identical accounting to `netOfCostEdge`, where
 * net == gross − totalCost.
 */
function extractArms(
  records: ReadonlyArray<{
    recommendation: { proposedSignal: TradeSignal | null; costUsd: number };
    candidateSignal: TradeSignal | null;
    barIndex: number;
  }>,
  candles: Candle[],
  horizonBars: number,
  riskBudgetUsd: number,
): { agentGrossR: number[]; agentNetR: number[]; baselineR: number[]; totalCostUsd: number } {
  const futureAt = (barIndex: number): Candle[] =>
    candles.slice(barIndex + 1, barIndex + 1 + horizonBars);

  const totalCostUsd = records.reduce((s, r) => s + r.recommendation.costUsd, 0);
  const agentGrossR: number[] = [];
  const baselineR: number[] = [];
  for (const rec of records) {
    if (rec.candidateSignal) {
      baselineR.push(realizedR(rec.candidateSignal, futureAt(rec.barIndex)));
    }
    if (rec.recommendation.proposedSignal) {
      agentGrossR.push(realizedR(rec.recommendation.proposedSignal, futureAt(rec.barIndex)));
    }
  }
  // Amortise total spend across the routable trades, in R-units.
  const costPerTradeR =
    agentGrossR.length > 0 ? totalCostUsd / agentGrossR.length / riskBudgetUsd : 0;
  const agentNetR = agentGrossR.map((r) => round(r - costPerTradeR));
  return { agentGrossR, agentNetR, baselineR, totalCostUsd: round(totalCostUsd, 6) };
}

// ─── verdict shape ───────────────────────────────────────────────────────────
type RunMode = 'smoke-deterministic' | 'live-anthropic';

export interface AssetVerdict {
  symbol: string;
  mode: RunMode;
  horizonBars: number;
  bars: number;
  decisions: number;
  /** Per-arm routable-trade counts. */
  routableTrades: number;
  baselineTrades: number;
  /** The 5 headline metrics from the harness. */
  metrics: {
    agentWinRate: number;
    agentAvgR: number;
    vsBaselineAvgRDelta: number;
    expectedCalibrationError: number;
    netEdgeUsd: number;
  };
  /** Bootstrap CIs + the two p5 gates. */
  bootstrap: {
    netOfCostAvgR: AvgRBand;
    baselineAvgR: AvgRBand;
    vsBaselineAvgRDelta: AvgRBand;
  };
  gates: {
    /** p5(net-of-cost avg-R) > 0 — the edge survives its own cost on the tail. */
    netOfCostAvgRPositive: boolean;
    /** p5(vs-baseline avg-R delta) > 0 — the agent beats bb_fade on the tail. */
    vsBaselineDeltaPositive: boolean;
  };
  totalCostUsd: number;
}

async function runAsset(spec: AssetSpec, mode: RunMode, llm: LlmClient | null): Promise<{
  verdict: AssetVerdict;
  report: AgentValidationReport;
}> {
  const { symbol, horizonBars } = spec;
  console.log(
    `\n[tra550] ${symbol} — fetching 4H candles ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ${new Date(WINDOW_END_MS).toISOString().slice(0, 10)} …`,
  );
  const candles = await fetchCoinbase4hBars(symbol, WINDOW_START_MS, WINDOW_END_MS);
  console.log(`[tra550] ${symbol} — ${candles.length} bars; replaying (mode=${mode}) …`);

  // Wire the real LLM only in live mode; the smoke runs the deterministic fakes.
  const graphDeps: AgentGraphDeps = mode === 'live-anthropic' && llm ? { llm } : {};

  const { replay, report } = await runAgentValidation(candles, {
    symbol,
    candidateAt: bbFadeCandidate(symbol),
    warmup: WARMUP,
    step: STEP,
    horizonBars,
    calibrationBins: CALIBRATION_BINS,
    riskBudgetUsd: RISK_BUDGET_USD,
    graphDeps,
  });

  const arms = extractArms(replay.records, candles, horizonBars, RISK_BUDGET_USD);
  // Distinct seeds per arm/asset keep the resamples independent but reproducible.
  const seedBase = symbol.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);
  const netOfCostAvgR = bootstrapMean(arms.agentNetR, seedBase + 1);
  const baselineAvgR = bootstrapMean(arms.baselineR, seedBase + 2);
  const vsBaselineDelta = bootstrapDelta(arms.agentNetR, arms.baselineR, seedBase + 3);

  const verdict: AssetVerdict = {
    symbol,
    mode,
    horizonBars,
    bars: report.bars,
    decisions: report.decisions,
    routableTrades: report.scoring.routableCount,
    baselineTrades: report.scoring.baseline.totalSignals,
    metrics: {
      agentWinRate: report.scoring.agent.winRate,
      agentAvgR: report.scoring.agent.avgRR,
      vsBaselineAvgRDelta: report.scoring.edgeVsBaseline.avgRDelta,
      expectedCalibrationError: report.calibration.expectedCalibrationError,
      netEdgeUsd: report.netEdge.netEdgeUsd,
    },
    bootstrap: { netOfCostAvgR, baselineAvgR, vsBaselineAvgRDelta: vsBaselineDelta },
    gates: {
      netOfCostAvgRPositive: netOfCostAvgR.p5 > 0,
      vsBaselineDeltaPositive: vsBaselineDelta.p5 > 0,
    },
    totalCostUsd: arms.totalCostUsd,
  };

  console.log(
    `[tra550] ${symbol}: ${verdict.routableTrades} routable / ${verdict.baselineTrades} baseline · ` +
      `agent ${(verdict.metrics.agentWinRate * 100).toFixed(0)}% WR ${verdict.metrics.agentAvgR.toFixed(2)}R · ` +
      `Δ ${verdict.metrics.vsBaselineAvgRDelta.toFixed(2)}R · ` +
      `p5(net avg-R)=${netOfCostAvgR.p5.toFixed(3)} · p5(Δ)=${vsBaselineDelta.p5.toFixed(3)} · ` +
      `cost $${verdict.totalCostUsd.toFixed(4)}`,
  );
  return { verdict, report };
}

// ─── key availability ────────────────────────────────────────────────────────
function reportKeyAvailability(): { reachable: boolean; summary: string } {
  const cred = describeAnthropicCredFromEnv();
  const reachable = cred.mode !== 'none';
  const summary = reachable
    ? `Anthropic key REACHABLE via ${cred.mode} (prefix ${cred.prefix}…); ` +
      `tiers fast=${DEFAULT_TIER_MODELS.fast} strong=${DEFAULT_TIER_MODELS.strong}`
    : 'Anthropic key NOT reachable — neither ANTHROPIC_API_KEY/CLAUDE_API_KEY nor ' +
      'ANTHROPIC_AUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN is set in this runtime. ' +
      'The real OOS run is BLOCKED on QuantTrader/CFO provisioning the key.';
  return { reachable, summary };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const smoke = argv.includes('--smoke');
  const execute = argv.includes('--execute');

  const key = reportKeyAvailability();
  console.log(`[tra550] ${key.summary}`);
  console.log(
    `[tra550] window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ` +
      `${new Date(WINDOW_END_MS).toISOString().slice(0, 10)} · step=${STEP} warmup=${WARMUP} ` +
      `risk=$${RISK_BUDGET_USD} bins=${CALIBRATION_BINS} · assets ${ASSETS.map((a) => `${a.symbol}(h=${a.horizonBars})`).join(', ')}`,
  );

  if (!smoke && !execute) {
    console.log(
      '\n[tra550] PLAN mode — nothing run (no spend). Pass --smoke for the free ' +
        'deterministic wiring check, or --execute for the real paid run (CFO-gated).',
    );
    return;
  }

  let mode: RunMode;
  let llm: LlmClient | null = null;
  if (execute) {
    llm = createAnthropicLlmClientFromEnv();
    if (!llm) {
      console.error(
        '[tra550] --execute requested but no Anthropic credential is reachable. ' +
          'Aborting before any spend. This is a real blocker for QuantTrader/CFO.',
      );
      process.exit(2);
      return;
    }
    mode = 'live-anthropic';
    console.log('[tra550] --execute: REAL Anthropic run — this incurs LLM spend.');
  } else {
    mode = 'smoke-deterministic';
    console.log('[tra550] --smoke: deterministic fakes, zero LLM spend.');
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const verdicts: AssetVerdict[] = [];
  for (const spec of ASSETS) {
    const { verdict, report } = await runAsset(spec, mode, llm);
    verdicts.push(verdict);
    const assetSlug = spec.symbol.toLowerCase().replace('-usd', '');
    const path = resolve(REPORT_DIR, `tra550-oos-${assetSlug}.json`);
    writeFileSync(path, JSON.stringify({ verdict, report }, null, 2));
    console.log(`[tra550] wrote ${path}`);
  }

  const combinedPath = resolve(REPORT_DIR, 'tra550-verdict.json');
  writeFileSync(
    combinedPath,
    JSON.stringify(
      {
        generatedWindow: {
          start: new Date(WINDOW_START_MS).toISOString(),
          end: new Date(WINDOW_END_MS).toISOString(),
        },
        mode,
        keyReachable: key.reachable,
        config: { step: STEP, warmup: WARMUP, riskBudgetUsd: RISK_BUDGET_USD, calibrationBins: CALIBRATION_BINS, bootstrapIterations: BOOTSTRAP_ITERATIONS },
        assets: verdicts,
      },
      null,
      2,
    ),
  );
  console.log(`[tra550] wrote ${combinedPath}`);
}

const invoked = process.argv[1] && /[\\/]run-tra550-oos\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
