/**
 * TRA-835 / TRA-797 — real P2 Agents-ON vs Agents-OFF A/B OOS driver.
 *
 * Implements the frozen TRA-797 methodology (doc "A/B Validation Methodology",
 * Sections 1–9). This is the RUN step delegated to LeadDev; the GO/NO-GO verdict
 * (§5) is QuantTrader's. No harness/graph changes — pure glue:
 *
 *   • OFF arm  = the **live preset's** real candidate generator
 *     (`SupertrendConfluenceStrategy`, TRA-728 shipped defaults — the Phase-2
 *     supertrend stream gated live on TRA-734), point-in-time, NOT the
 *     `momentumCandidate` toy.
 *   • ON arm   = the routable APPROVE stream (`proposedSignal !== null`) the
 *     real multi-agent panel green-lights, driven by the live `AnthropicLlmClient`
 *     wired into `graphDeps.llm`.
 *   • A/B delta = `scoring.edgeVsBaseline`; cost side = `netEdge`.
 *
 * Per symbol (SOL-USD, DOGE-USD, BTC-USD) over a ≥12-mo real Coinbase 1H chain:
 *   1. `runAgentValidation` once: step=4 (4h decision cadence — the §8 cost
 *      model's cadence), horizonBars=20, warmup=60, riskBudgetUsd=100.
 *   2. Persist the FULL `RecommendationLedgerRow[]` (carries costUsd + latencyMs)
 *      so spend is auditable, not just the summary (§1).
 *   3. Power gate (§4, BLOCKING): routable N ≥ 30 / arm, else
 *      `UNDERPOWERED / NO-VERDICT`; the routable rate is always logged.
 *   4. Per-regime slice (§3): SMA-50 ±1% hysteresis band → {trend-up, trend-down,
 *      chop}; recompute scoring + netEdge + bootstrap CI per slice.
 *   5. Bootstrap 95% CI lower bound on net per-trade edge (§5), reusing
 *      `bootstrap.ts` (`bootstrapEquityCurves`).
 *   6. Horizon sensitivity 12/20/30 is FREE — re-score the SAME persisted ledger;
 *      the graph is NOT re-run per horizon.
 *   7. Write `reports/tra797-agents-ab.{json,md}` + `…-ledger.json`.
 *
 * NOTE on timeframe (surfaced for QuantTrader's verdict): the live supertrend
 * preset evaluates on 5m signal + 1h confirm bars. This study runs on 1H bars
 * with step=4, the cadence the frozen §8 cost model is bounded on (~2,190
 * decision bars/symbol, ≈$60–150 total). On 1H input the strategy's internal 1h
 * MTF-confirm gate degenerates to the signal series, so it gates more freely than
 * live — which only widens the OFF arm and helps the §4 power gate. This is the
 * intentional cost-bounding approximation QuantTrader froze, called out here so
 * the verdict can weigh it.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * SPEND SAFETY — this script does NOT spend by default.
 *   • `… run-tra797-agents-ab.ts`                  → PLAN mode: prints config +
 *     Anthropic key reachability, runs NOTHING.
 *   • `… run-tra797-agents-ab.ts --smoke`          → free DETERMINISTIC smoke: the
 *     full pipeline (real candle fetch + supertrend candidate + harness + regime
 *     slice + power gate + bootstrap + report writing) on the P1 stub graph (no
 *     `llm`, zero LLM spend). Proves the wiring. Add `--synthetic` to also skip
 *     the network and drive the pipeline on a deterministic synthetic 1H series
 *     (for offline environments). Reports tag `mode: "smoke-deterministic"`.
 *   • `… run-tra797-agents-ab.ts --execute`        → the REAL paid run: wires the
 *     live AnthropicLlmClient behind a job-scoped BudgetedLlmClient (perDayUsd
 *     ≈$200 — NOT the live $2/user/day agent-spend-store cap, which would
 *     hard-stop the replay and corrupt the A/B). Aborts before any spend if no
 *     Anthropic credential is reachable. CFO budget-OK gated (~$60–150 one-time).
 *
 * Run:
 *   pnpm --filter @trading-app/backtest exec tsx src/run-tra797-agents-ab.ts [--smoke|--execute] [--synthetic]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Candle, Position, TradeSignal } from '@trading-app/shared';
import { SupertrendConfluenceStrategy } from '@trading-app/engine';
import {
  type AgentGraphDeps,
  type LlmClient,
  type LlmCompletionRequest,
  type LlmCompletionResponse,
  createAnthropicLlmClientFromEnv,
  describeAnthropicCredFromEnv,
  DEFAULT_TIER_MODELS,
} from '@trading-app/agents';
import { fetchCoinbaseHourlyBars } from './coinbase-feed.js';
import { type AgentReplayRecord, type CandidateGenerator } from './agent-replay.js';
import { scoreReplay, realizedR, type AgentScoreReport } from './agent-scoring.js';
import { netOfCostEdge, type NetEdgeReport } from './agent-calibration.js';
import { bootstrapEquityCurves } from './bootstrap.js';
import {
  runAgentValidation,
  buildValidationMarkdown,
  type AgentValidationReport,
  type RecommendationLedgerRow,
} from './agent-validation.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(HERE, '..', 'reports');

// ─── study window + config (TRA-797 §1 / §8) ───────────────────────────────────
// ≥12-mo real chain — a fixed, reproducible window ending 2026-06-09 (the TRA-550
// OOS end), entirely settled before today. fetchCoinbaseHourlyBars is half-open
// [fromMs, toMs). The real study uses the full 12-mo span; `TRA797_WINDOW_MONTHS`
// shortens it ONLY for fast offline wiring smokes (never for a verdict run).
const WINDOW_END_MS = Date.UTC(2026, 5, 9); // 2026-06-09 00:00 UTC
const WINDOW_MONTHS = Math.max(1, Number(process.env['TRA797_WINDOW_MONTHS'] ?? 12) || 12);
const WINDOW_START_MS = WINDOW_END_MS - WINDOW_MONTHS * 30 * 24 * 60 * 60 * 1000;

const SYMBOLS = ['SOL-USD', 'DOGE-USD', 'BTC-USD'] as const;

const STEP = 4; // 4h decision cadence on 1H bars (the §8 cost-model cadence).
const PRIMARY_HORIZON = 20;
const HORIZONS = [12, 20, 30] as const; // §1 sensitivity — free re-score of one ledger.
const WARMUP = 60; // ≥ regime SMA-50 + the strategy's indicator look-backs.
const RISK_BUDGET_USD = 100;
const CALIBRATION_BINS = 10;
const BOOTSTRAP_ITERATIONS = 2000;
const MIN_ROUTABLE_N = 30; // §4 power gate, per arm.

// §3 regime gate — SMA-50 ±1% hysteresis band, the live preset's gate (TRA-470,
// `packages/server/src/market-review.ts`: MA_PERIOD=50, TREND_HYSTERESIS=0.01).
// Inlined (backtest does not depend on @trading-app/server) and applied 3-way on
// the symbol's own point-in-time series: above the band = trend-up, below =
// trend-down, inside the ±1% band = chop.
const REGIME_MA_PERIOD = 50;
const REGIME_BAND = 0.01;

// §8 budget posture — job-scoped daily cap, well above the ~$60–150 study total,
// so it never trips in normal operation but hard-stops a runaway. NOT the live
// $2/user/day agent-spend-store cap.
const JOB_BUDGET_USD = 200;

type Regime = 'trend-up' | 'trend-down' | 'chop';
const REGIMES: readonly Regime[] = ['trend-up', 'trend-down', 'chop'];

const round = (v: number, dp = 4): number => Math.round(v * 10 ** dp) / 10 ** dp;
const mean = (xs: readonly number[]): number =>
  xs.length > 0 ? xs.reduce((s, v) => s + v, 0) / xs.length : 0;

// ─── OFF-arm candidate: the live preset's real generator ───────────────────────
/**
 * Point-in-time supertrend candidate — the live Phase-2 preset
 * (`SupertrendConfluenceStrategy`, TRA-728 shipped defaults, TRA-734-gated). At
 * each decision bar it sees only the as-of window (candles ≤ asOf) and runs the
 * production strategy. Pure function of the window: no look-ahead. This is the
 * real deployed baseline the OFF arm must be, NOT the `momentumCandidate` toy.
 */
function supertrendCandidate(symbol: string): CandidateGenerator {
  const strat = new SupertrendConfluenceStrategy();
  return (_asOf, window): TradeSignal | null => strat.evaluate(symbol, window as Candle[]);
}

// ─── §3 regime classification ──────────────────────────────────────────────────
/**
 * Classify the decision bar's regime from the symbol's own SMA-50 and the ±1%
 * hysteresis band (TRA-470). Point-in-time: uses only `candles[barIndex-49 …
 * barIndex]`. Returns `chop` when the 50-bar SMA is undefined (cannot happen with
 * warmup ≥ 50).
 */
function classifyRegime(candles: Candle[], barIndex: number): Regime {
  if (barIndex < REGIME_MA_PERIOD - 1) return 'chop';
  let sum = 0;
  for (let i = barIndex - REGIME_MA_PERIOD + 1; i <= barIndex; i++) sum += candles[i]!.close;
  const sma = sum / REGIME_MA_PERIOD;
  const close = candles[barIndex]!.close;
  if (close > sma * (1 + REGIME_BAND)) return 'trend-up';
  if (close < sma * (1 - REGIME_BAND)) return 'trend-down';
  return 'chop';
}

// ─── §5 bootstrap CI on net per-trade edge (reuses bootstrap.ts) ────────────────
export interface NetEdgeBand {
  /** Routable trades the band was resampled from. */
  n: number;
  /** Point estimate — mean net per-trade edge USD (= netEdge.netEdgePerTradeUsd). */
  meanUsd: number;
  /** Lower bound of the bootstrap 95% CI (5th percentile of the resampled mean). */
  ciLowerUsd: number;
  p50Usd: number;
  ciUpperUsd: number;
  iterations: number;
}

/**
 * The per-routable-trade net edge in USD: gross R → USD at `riskBudgetUsd`, minus
 * total LLM spend (summed over ALL recs — HOLD/VETO burn tokens too) amortised per
 * routable trade. Mean of this array === `netEdge.netEdgePerTradeUsd` by
 * construction, so the bootstrap is a CI around the exact §2/§4 net number.
 */
function netPerTradeEdgesUsd(
  records: AgentReplayRecord[],
  candles: Candle[],
  horizonBars: number,
  riskBudgetUsd: number,
): number[] {
  const totalCostUsd = records.reduce((s, r) => s + r.recommendation.costUsd, 0);
  const grossUsd: number[] = [];
  for (const rec of records) {
    const proposed = rec.recommendation.proposedSignal;
    if (!proposed) continue;
    const future = candles.slice(rec.barIndex + 1, rec.barIndex + 1 + horizonBars);
    grossUsd.push(realizedR(proposed, future) * riskBudgetUsd);
  }
  const n = grossUsd.length;
  if (n === 0) return [];
  const costPerTrade = totalCostUsd / n;
  return grossUsd.map((g) => g - costPerTrade);
}

/**
 * Bootstrap 95% CI on the MEAN net per-trade edge, reusing `bootstrap.ts`'s
 * `bootstrapEquityCurves`. Each trade's net edge is mapped to a closed-trade
 * `pnl`; resampling N draws and summing gives a synthetic N-trade total, whose
 * percentile band divided by N is the percentile band of the per-trade MEAN. p5
 * is the §5 lower-CI-bound robustness gate (mandated after the TRA-431 reversal).
 */
function bootstrapNetEdge(edgesUsd: number[], seed: number): NetEdgeBand {
  const n = edgesUsd.length;
  if (n === 0) {
    return { n: 0, meanUsd: 0, ciLowerUsd: 0, p50Usd: 0, ciUpperUsd: 0, iterations: BOOTSTRAP_ITERATIONS };
  }
  const trades = edgesUsd.map((pnl) => ({ pnl })) as unknown as Position[];
  const band = bootstrapEquityCurves(trades, 0, { iterations: BOOTSTRAP_ITERATIONS, seed });
  return {
    n,
    meanUsd: round(mean(edgesUsd), 4),
    ciLowerUsd: round(band.p5 / n, 4),
    p50Usd: round(band.p50 / n, 4),
    ciUpperUsd: round(band.p95 / n, 4),
    iterations: BOOTSTRAP_ITERATIONS,
  };
}

// A stable per-symbol seed so the bootstrap is reproducible.
const seedOf = (s: string): number => s.split('').reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7);

// ─── per-slice metric bundle (§2 scoring + §4 netEdge + §5 CI) ──────────────────
interface SliceMetrics {
  n: number; // routable (ON) trades in this slice — the §4 power dimension.
  baselineN: number; // OFF (candidate) signals in this slice.
  scoring: AgentScoreReport;
  netEdge: NetEdgeReport;
  bootstrap: NetEdgeBand;
}

function computeSlice(
  records: AgentReplayRecord[],
  candles: Candle[],
  horizonBars: number,
  seed: number,
): SliceMetrics {
  const scoring = scoreReplay(records, candles, horizonBars);
  const netEdge = netOfCostEdge(records, candles, horizonBars, RISK_BUDGET_USD);
  const bootstrap = bootstrapNetEdge(
    netPerTradeEdgesUsd(records, candles, horizonBars, RISK_BUDGET_USD),
    seed,
  );
  return {
    n: scoring.routableCount,
    baselineN: scoring.baseline.totalSignals,
    scoring,
    netEdge,
    bootstrap,
  };
}

// ─── verdict shape ───────────────────────────────────────────────────────────
type RunMode = 'smoke-deterministic' | 'live-anthropic';

export interface SymbolReport {
  symbol: string;
  mode: RunMode;
  bars: number;
  decisions: number;
  routableTrades: number;
  baselineTrades: number;
  routableRate: number;
  totalCostUsd: number;
  totalLatencyMs: number;
  /** §4 power gate — the BLOCKING feasibility check. */
  powerGate: {
    minRoutableN: number;
    onArmN: number;
    offArmN: number;
    passed: boolean;
    /** `UNDERPOWERED / NO-VERDICT` when the gate fails. */
    note: string;
  };
  /** §1 horizon sensitivity over the SAME ledger — 12/20/30, free re-score. */
  horizons: Record<string, { scoring: AgentScoreReport; netEdge: NetEdgeReport; bootstrap: NetEdgeBand }>;
  primaryHorizon: number;
  /** §3 per-regime slice at the primary horizon. */
  regimes: Record<Regime, SliceMetrics>;
}

async function runSymbol(
  symbol: string,
  mode: RunMode,
  llm: LlmClient | null,
  candles: Candle[],
): Promise<{ report: SymbolReport; ledger: RecommendationLedgerRow[]; validation: AgentValidationReport }> {
  console.log(`[tra797] ${symbol} — ${candles.length} 1H bars; replaying (mode=${mode}, step=${STEP}) …`);

  const graphDeps: AgentGraphDeps = mode === 'live-anthropic' && llm ? { llm } : {};
  const { replay, report: validation } = await runAgentValidation(candles, {
    symbol,
    candidateAt: supertrendCandidate(symbol),
    warmup: WARMUP,
    step: STEP,
    horizonBars: PRIMARY_HORIZON,
    calibrationBins: CALIBRATION_BINS,
    riskBudgetUsd: RISK_BUDGET_USD,
    graphDeps,
  });

  const records = replay.records;
  const seed = seedOf(symbol);

  // §1 horizon sensitivity — re-score the SAME persisted ledger, no graph re-run.
  const horizons: SymbolReport['horizons'] = {};
  for (const h of HORIZONS) {
    horizons[String(h)] = {
      scoring: scoreReplay(records, candles, h),
      netEdge: netOfCostEdge(records, candles, h, RISK_BUDGET_USD),
      bootstrap: bootstrapNetEdge(netPerTradeEdgesUsd(records, candles, h, RISK_BUDGET_USD), seed + h),
    };
  }

  // §3 per-regime slice at the primary horizon.
  const buckets: Record<Regime, AgentReplayRecord[]> = { 'trend-up': [], 'trend-down': [], chop: [] };
  for (const rec of records) buckets[classifyRegime(candles, rec.barIndex)].push(rec);
  const regimes = {} as Record<Regime, SliceMetrics>;
  REGIMES.forEach((r, i) => {
    regimes[r] = computeSlice(buckets[r], candles, PRIMARY_HORIZON, seed + 100 + i);
  });

  // §4 power gate — routable N ≥ 30 per arm (ON = routable, OFF = baseline signals).
  const onArmN = validation.scoring.routableCount;
  const offArmN = validation.scoring.baseline.totalSignals;
  const passed = onArmN >= MIN_ROUTABLE_N && offArmN >= MIN_ROUTABLE_N;
  const routableRate = validation.decisions > 0 ? round(onArmN / validation.decisions) : 0;

  const report: SymbolReport = {
    symbol,
    mode,
    bars: validation.bars,
    decisions: validation.decisions,
    routableTrades: onArmN,
    baselineTrades: offArmN,
    routableRate,
    totalCostUsd: round(validation.totalCostUsd, 6),
    totalLatencyMs: validation.totalLatencyMs,
    powerGate: {
      minRoutableN: MIN_ROUTABLE_N,
      onArmN,
      offArmN,
      passed,
      note: passed
        ? 'POWERED — §5 GO/NO-GO may be evaluated.'
        : `ON=${onArmN}, OFF=${offArmN} (< ${MIN_ROUTABLE_N}/arm). ` +
          `Routable rate ${(routableRate * 100).toFixed(1)}%. Recommend a longer window or looser APPROVE threshold; do not manufacture a verdict.`,
    },
    horizons,
    primaryHorizon: PRIMARY_HORIZON,
    regimes,
  };

  const ph = horizons[String(PRIMARY_HORIZON)]!;
  console.log(
    `[tra797] ${symbol}: ${onArmN} routable / ${offArmN} baseline (${(routableRate * 100).toFixed(1)}%) · ` +
      `${passed ? 'POWERED' : 'UNDERPOWERED'} · Δedge ${ph.scoring.edgeVsBaseline.avgRDelta.toFixed(2)}R · ` +
      `net/trade $${ph.netEdge.netEdgePerTradeUsd.toFixed(2)} · CI-lower $${ph.bootstrap.ciLowerUsd.toFixed(2)} · ` +
      `cost $${report.totalCostUsd.toFixed(4)}`,
  );
  return { report, ledger: validation.recommendations, validation };
}

// ─── job-scoped budget client (§2 / §8) ─────────────────────────────────────────
class BudgetExceededError extends Error {
  constructor(spentUsd: number, capUsd: number) {
    super(`Job LLM budget exhausted: spent $${spentUsd.toFixed(2)} ≥ cap $${capUsd.toFixed(2)}`);
    this.name = 'BudgetExceededError';
  }
}

/**
 * Wraps an `LlmClient` with a job-scoped cumulative spend cap. The replay must run
 * atomically — it must NOT be hard-stopped partway (the live $2/user/day
 * agent-spend-store cap would corrupt the A/B), so the cap here is set well above
 * the expected study total purely as a runaway backstop. Spend is read from each
 * response's real `costUsd` and accumulated; a call is refused only once the cap
 * is already reached.
 */
class BudgetedLlmClient implements LlmClient {
  private spentUsd = 0;
  constructor(private readonly inner: LlmClient, private readonly capUsd: number) {}
  get spent(): number {
    return this.spentUsd;
  }
  async complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (this.spentUsd >= this.capUsd) throw new BudgetExceededError(this.spentUsd, this.capUsd);
    const res = await this.inner.complete(req);
    this.spentUsd += res.costUsd;
    return res;
  }
}

// ─── transport resilience (429 backoff, TRA-755-style) ──────────────────────────
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

class ThrottledLlmClient implements LlmClient {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(
    private readonly inner: LlmClient,
    private readonly minGapMs = 250,
    private readonly maxRetries = 6,
  ) {}
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    const run = this.chain.then(() => this.exec(req));
    this.chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }
  private async exec(req: LlmCompletionRequest): Promise<LlmCompletionResponse> {
    if (this.minGapMs > 0) await sleep(this.minGapMs);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.inner.complete(req);
      } catch (e) {
        const status = (e as { status?: number } | null)?.status;
        if (status === 429 && attempt < this.maxRetries) {
          const wait = Math.min(60_000, 5_000 * 2 ** attempt);
          console.log(
            `[tra797] 429 on ${req.purpose ?? req.tier}; backoff ${wait}ms (retry ${attempt + 1}/${this.maxRetries})`,
          );
          await sleep(wait);
          continue;
        }
        throw e;
      }
    }
  }
}

// ─── synthetic 1H series (offline smoke only) ──────────────────────────────────
/**
 * Deterministic synthetic 1H candle series for offline smoke runs (`--synthetic`)
 * when the Coinbase feed is unreachable. A seeded random walk with mild trend
 * regimes so the regime slice and candidate generator both fire — NEVER used for
 * a real verdict (only reachable under `--smoke --synthetic`).
 */
function syntheticHourly(symbol: string, fromMs: number, toMs: number): Candle[] {
  let seed = seedOf(symbol);
  const rand = (): number => {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const out: Candle[] = [];
  let price = 100;
  const ONE_HOUR = 3_600_000;
  let i = 0;
  for (let ts = fromMs; ts < toMs; ts += ONE_HOUR, i++) {
    // Slow sinusoidal drift + noise → alternating trend-up / trend-down / chop.
    const drift = Math.sin(i / 400) * 0.004;
    const shock = (rand() - 0.5) * 0.01;
    const open = price;
    price = Math.max(1, price * (1 + drift + shock));
    const high = Math.max(open, price) * (1 + rand() * 0.003);
    const low = Math.min(open, price) * (1 - rand() * 0.003);
    out.push({ symbol, timestamp: ts, open, high, low, close: price, volume: 1000 + rand() * 500 });
  }
  return out;
}

// ─── markdown ────────────────────────────────────────────────────────────────
const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

function buildMarkdown(reports: SymbolReport[], mode: RunMode, keyReachable: boolean): string {
  const L: string[] = [];
  L.push('# TRA-797 — Agents-ON vs Agents-OFF A/B (real P2 OOS)');
  L.push('');
  L.push(`Run mode: **${mode}**${mode === 'smoke-deterministic' ? ' (P1 stub, costUsd=0 — wiring proof, NOT a verdict)' : ''}.`);
  L.push(
    `Window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ${new Date(WINDOW_END_MS).toISOString().slice(0, 10)} · ` +
      `1H bars · step=${STEP} (4h cadence) · warmup=${WARMUP} · horizons ${HORIZONS.join('/')} (primary ${PRIMARY_HORIZON}) · ` +
      `risk=$${RISK_BUDGET_USD} · power gate N≥${MIN_ROUTABLE_N}/arm · Anthropic key reachable: ${keyReachable}.`,
  );
  L.push('');
  L.push('OFF arm = live preset `SupertrendConfluenceStrategy` (TRA-728 defaults). ON arm = routable APPROVE stream.');
  L.push('');
  L.push('> **Verdict is QuantTrader\'s (§5).** This driver supplies the powered/underpowered status, the gross & net A/B numbers, the bootstrap CI lower bound, and the per-regime slice. It does not declare GO/NO-GO.');
  L.push('');

  // Per-symbol headline table.
  L.push('## Per-symbol (primary horizon)');
  L.push('');
  L.push('| Symbol | Decisions | Routable (ON) | Baseline (OFF) | Routable rate | Power gate | Δedge (gross R) | Net/trade $ | CI-lower $ | LLM cost $ |');
  L.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const r of reports) {
    const ph = r.horizons[String(PRIMARY_HORIZON)]!;
    L.push(
      `| ${r.symbol} | ${r.decisions} | ${r.routableTrades} | ${r.baselineTrades} | ${pct(r.routableRate)} | ` +
        `${r.powerGate.passed ? 'POWERED' : 'UNDERPOWERED'} | ${ph.scoring.edgeVsBaseline.avgRDelta.toFixed(2)} | ` +
        `${ph.netEdge.netEdgePerTradeUsd.toFixed(2)} | ${ph.bootstrap.ciLowerUsd.toFixed(2)} | ${r.totalCostUsd.toFixed(4)} |`,
    );
  }
  L.push('');

  for (const r of reports) {
    L.push(`## ${r.symbol}`);
    L.push('');
    L.push(`Power gate (§4): **${r.powerGate.passed ? 'POWERED' : 'UNDERPOWERED / NO-VERDICT'}** — ${r.powerGate.note}`);
    L.push('');
    // Horizon sensitivity.
    L.push('### Horizon sensitivity (free re-score of the same ledger)');
    L.push('');
    L.push('| Horizon | ON win% | ON avgR | OFF avgR | Δedge avgR | Net/trade $ | CI-lower $ |');
    L.push('| --- | --- | --- | --- | --- | --- | --- |');
    for (const h of HORIZONS) {
      const x = r.horizons[String(h)]!;
      L.push(
        `| ${h} | ${pct(x.scoring.agent.winRate)} | ${x.scoring.agent.avgRR.toFixed(2)} | ` +
          `${x.scoring.baseline.avgRR.toFixed(2)} | ${x.scoring.edgeVsBaseline.avgRDelta.toFixed(2)} | ` +
          `${x.netEdge.netEdgePerTradeUsd.toFixed(2)} | ${x.bootstrap.ciLowerUsd.toFixed(2)} |`,
      );
    }
    L.push('');
    // Regime slice.
    L.push(`### Per-regime slice (primary horizon ${PRIMARY_HORIZON}, SMA-50 ±1% band)`);
    L.push('');
    L.push('| Regime | Routable (ON) | Baseline (OFF) | Δedge avgR | Net/trade $ | CI-lower $ |');
    L.push('| --- | --- | --- | --- | --- | --- |');
    for (const rg of REGIMES) {
      const s = r.regimes[rg];
      L.push(
        `| ${rg} | ${s.n} | ${s.baselineN} | ${s.scoring.edgeVsBaseline.avgRDelta.toFixed(2)} | ` +
          `${s.netEdge.netEdgePerTradeUsd.toFixed(2)} | ${s.bootstrap.ciLowerUsd.toFixed(2)} |`,
      );
    }
    L.push('');
  }
  return L.join('\n');
}

// ─── key availability ────────────────────────────────────────────────────────
function reportKeyAvailability(): { reachable: boolean; summary: string } {
  const cred = describeAnthropicCredFromEnv();
  const reachable = cred.mode !== 'none';
  const summary = reachable
    ? `Anthropic key REACHABLE via ${cred.mode} (prefix ${cred.prefix}…); tiers fast=${DEFAULT_TIER_MODELS.fast} strong=${DEFAULT_TIER_MODELS.strong}`
    : 'Anthropic key NOT reachable — neither ANTHROPIC_API_KEY/CLAUDE_API_KEY nor ANTHROPIC_AUTH_TOKEN/CLAUDE_CODE_OAUTH_TOKEN is set. ' +
      'The real --execute run is BLOCKED on the key being provisioned in the runner env (TRA-797 §9).';
  return { reachable, summary };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const smoke = argv.includes('--smoke');
  const execute = argv.includes('--execute');
  const synthetic = argv.includes('--synthetic');

  const key = reportKeyAvailability();
  console.log(`[tra797] ${key.summary}`);
  console.log(
    `[tra797] window ${new Date(WINDOW_START_MS).toISOString().slice(0, 10)} → ${new Date(WINDOW_END_MS).toISOString().slice(0, 10)} · ` +
      `1H · step=${STEP} warmup=${WARMUP} risk=$${RISK_BUDGET_USD} bins=${CALIBRATION_BINS} · ` +
      `power N≥${MIN_ROUTABLE_N}/arm · symbols ${SYMBOLS.join(', ')} · OFF=SupertrendConfluence(defaults)`,
  );

  if (!smoke && !execute) {
    console.log(
      '\n[tra797] PLAN mode — nothing run (no spend). Pass --smoke (free deterministic wiring check; ' +
        '--synthetic to skip the network) or --execute for the real paid run (CFO-gated, ~$60–150 one-time).',
    );
    return;
  }

  let mode: RunMode;
  let llm: LlmClient | null = null;
  let budgeted: BudgetedLlmClient | null = null;
  if (execute) {
    const base = createAnthropicLlmClientFromEnv();
    if (!base) {
      console.error(
        '[tra797] --execute requested but no Anthropic credential is reachable. Aborting before any spend. ' +
          'This is the TRA-797 §9 blocker: provision ANTHROPIC_API_KEY (or CLAUDE_API_KEY) in the runner env.',
      );
      process.exit(2);
      return;
    }
    budgeted = new BudgetedLlmClient(new ThrottledLlmClient(base), JOB_BUDGET_USD);
    llm = budgeted;
    mode = 'live-anthropic';
    console.log(
      `[tra797] --execute: REAL Anthropic run, job-scoped budget cap $${JOB_BUDGET_USD} (NOT the live $2/user/day cap).`,
    );
  } else {
    mode = 'smoke-deterministic';
    console.log(`[tra797] --smoke: deterministic stub graph, zero LLM spend${synthetic ? ' (synthetic candles)' : ''}.`);
  }

  mkdirSync(REPORT_DIR, { recursive: true });
  const reports: SymbolReport[] = [];
  const ledgers: Record<string, RecommendationLedgerRow[]> = {};
  const validations: Record<string, AgentValidationReport> = {};

  for (const symbol of SYMBOLS) {
    let candles: Candle[];
    if (synthetic) {
      candles = syntheticHourly(symbol, WINDOW_START_MS, WINDOW_END_MS);
      console.log(`[tra797] ${symbol} — ${candles.length} SYNTHETIC 1H bars (offline smoke).`);
    } else {
      console.log(`[tra797] ${symbol} — fetching 1H candles …`);
      candles = await fetchCoinbaseHourlyBars(symbol, WINDOW_START_MS, WINDOW_END_MS);
    }
    const { report, ledger, validation } = await runSymbol(symbol, mode, llm, candles);
    reports.push(report);
    ledgers[symbol] = ledger;
    validations[symbol] = validation;
  }

  // §6 deliverables — report JSON + markdown + the full auditable ledger.
  const totalCostUsd = round(reports.reduce((s, r) => s + r.totalCostUsd, 0), 6);
  const jsonPath = resolve(REPORT_DIR, 'tra797-agents-ab.json');
  writeFileSync(
    jsonPath,
    JSON.stringify(
      {
        issue: 'TRA-835',
        parent: 'TRA-797',
        methodology: 'TRA-797 A/B Validation Methodology §1–9',
        generatedWindow: { start: new Date(WINDOW_START_MS).toISOString(), end: new Date(WINDOW_END_MS).toISOString() },
        mode,
        keyReachable: key.reachable,
        candleSource: synthetic ? 'synthetic-1h (offline smoke)' : 'coinbase-1h',
        offArm: 'SupertrendConfluenceStrategy (TRA-728 defaults)',
        regimeGate: `SMA-${REGIME_MA_PERIOD} ±${REGIME_BAND * 100}% (TRA-470)`,
        config: {
          step: STEP,
          warmup: WARMUP,
          horizons: HORIZONS,
          primaryHorizon: PRIMARY_HORIZON,
          riskBudgetUsd: RISK_BUDGET_USD,
          calibrationBins: CALIBRATION_BINS,
          bootstrapIterations: BOOTSTRAP_ITERATIONS,
          minRoutableN: MIN_ROUTABLE_N,
          jobBudgetUsd: JOB_BUDGET_USD,
        },
        totalCostUsd,
        symbols: reports,
        // Full per-symbol validation reports (scoring/calibration/netEdge at primary horizon).
        validations,
      },
      null,
      2,
    ),
  );
  console.log(`[tra797] wrote ${jsonPath}`);

  const ledgerPath = resolve(REPORT_DIR, 'tra797-agents-ab-ledger.json');
  writeFileSync(ledgerPath, JSON.stringify({ mode, generatedWindow: { start: new Date(WINDOW_START_MS).toISOString(), end: new Date(WINDOW_END_MS).toISOString() }, ledgers }, null, 2));
  console.log(`[tra797] wrote ${ledgerPath} (full RecommendationLedgerRow[] per symbol)`);

  const mdPath = resolve(REPORT_DIR, 'tra797-agents-ab.md');
  writeFileSync(mdPath, buildMarkdown(reports, mode, key.reachable));
  console.log(`[tra797] wrote ${mdPath}`);

  // Per-symbol harness markdown appendix (the four TRA-546 reports) for the curious.
  for (const symbol of SYMBOLS) {
    const slug = symbol.toLowerCase().replace('-usd', '');
    const p = resolve(REPORT_DIR, `tra797-agents-ab-harness-${slug}.md`);
    writeFileSync(p, buildValidationMarkdown(validations[symbol]!));
  }

  if (budgeted) console.log(`[tra797] total LLM spend this run: $${budgeted.spent.toFixed(4)} (cap $${JOB_BUDGET_USD}).`);
  console.log(`[tra797] DONE — total cost $${totalCostUsd.toFixed(4)} across ${reports.length} symbols.`);
}

const invoked = process.argv[1] && /[\\/]run-tra797-agents-ab\.(ts|js)$/.test(process.argv[1]);
if (invoked) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
