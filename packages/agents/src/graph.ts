// TRA-544 (TRA-529 §1–4) — the orchestration graph. Wires the tiers in order:
// analysts → bull/bear debate → trader synthesis → risk panel/manager →
// AgentRecommendation. The single emitted object is an `AgentRecommendation`
// (§4): in advisor mode it is logged + broadcast and rendered on the dashboard;
// only on APPROVE does it carry a routable `proposedSignal`.
//
// TRA-747 (P2) — the graph is now MODEL-AWARE. When `deps.llm` is supplied it
// runs the REAL LlmClient-backed agents (analysts on the fast/Haiku tier, trader
// + risk manager on the strong/Sonnet tier) and stamps the summed real `costUsd`
// on the recommendation. With NO `llm` it runs the original DETERMINISTIC FAKES
// (zero spend) — kept for the P3 replay harness's determinism and for unit tests.
// The bull/bear debate stays deterministic (derived from the analyst reports) in
// both paths; only the analysts + trader + risk manager are LLM calls.
import {
  validateAgentRecommendation,
  type AgentRecommendation,
  type TradeSignal,
  type TraderDecision,
} from '@trading-app/shared';
import type { AgentGraphInput } from './types.js';
import type { LlmClient } from './llm-client.js';
import { runAnalysts } from './analysts.js';
import { runDebate } from './debate.js';
import { runTrader, type TraderConfig } from './trader.js';
import { runRiskPanel, type RiskPanelConfig } from './risk-panel.js';
import { runAnalystsLlm, runTraderLlm, runRiskPanelLlm } from './llm-agents.js';

export class AgentGraphError extends Error {
  constructor(message: string, readonly fieldErrors: string[] = []) {
    super(message);
    this.name = 'AgentGraphError';
  }
}

export interface AgentGraphDeps {
  /**
   * The model seam. Unused by the P1 deterministic fakes (no LLM spend) — it is
   * threaded through so P2 can back the agents with a real provider without
   * changing this signature. Defaults to undefined.
   */
  llm?: LlmClient;
  /** Clock injection for deterministic latency in tests. Defaults to Date.now. */
  now?: () => number;
  /** Debate rounds (TRA-529 §6.3 cap). Default 2. */
  debateRounds?: number;
  trader?: TraderConfig;
  risk?: RiskPanelConfig;
}

/** Build the routable TradeSignal an APPROVE recommendation carries (§4). */
function buildProposedSignal(input: AgentGraphInput, decision: TraderDecision, asOf: number): TradeSignal {
  const base = input.candidateSignal;
  return {
    id: `agent-${input.symbol}-${asOf}`,
    symbol: input.symbol,
    type: base?.type ?? 'momentum',
    side: decision.action === 'SELL' ? 'sell' : 'buy',
    entryPrice: decision.proposedEntry,
    stopLoss: decision.proposedStop,
    takeProfit: decision.proposedTarget,
    riskRewardRatio: decision.riskRewardRatio,
    timestamp: asOf,
    ...(base?.mode ? { mode: base.mode } : {}),
  };
}

/**
 * Run the full advisory graph for one symbol and return its single
 * AgentRecommendation. Deterministic and free in P1. Throws
 * {@link AgentGraphError} if the assembled recommendation fails its own schema
 * validation — a self-check that the scaffolding only ever emits contract-valid
 * objects (callers in the live tick wrap this in try/catch and fall back to the
 * deterministic path).
 */
export async function runAgentGraph(
  input: AgentGraphInput,
  deps: AgentGraphDeps = {},
): Promise<AgentRecommendation> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();

  if (deps.llm) {
    // TRA-747 (P2) — real model calls through the LlmClient seam, cost summed.
    // 1. Analyst tier (fast/Haiku, parallel fan-out).
    const a = await runAnalystsLlm(input, deps.llm);
    // 2. Bull/bear debate + judge (deterministic, derived from the reports).
    const debate = runDebate(a.reports, deps.debateRounds ?? 2);
    // 3. Trader synthesis (strong/Sonnet).
    const t = await runTraderLlm(input, a.reports, debate, deps.llm);
    // 4. Risk panel + manager (strong/Sonnet).
    const r = await runRiskPanelLlm(t.decision, deps.llm, {
      minRiskReward: deps.risk?.minRiskReward,
    });
    const costUsd = round6(a.costUsd + t.costUsd + r.costUsd);
    return assemble(input, now, startedAt, a.reports, debate, t.decision, r.verdict, costUsd);
  }

  // No model wired — deterministic fakes (zero spend). Kept for the P3 replay
  // harness's determinism and for unit tests.
  const reports = runAnalysts(input);
  const debate = runDebate(reports, deps.debateRounds ?? 2);
  const decision = runTrader(input, reports, debate, deps.trader);
  const verdict = runRiskPanel(decision, deps.risk);
  return assemble(input, now, startedAt, reports, debate, decision, verdict, 0);
}

const round6 = (v: number): number => Math.round(v * 1e6) / 1e6;

/**
 * Assemble + self-validate the single AgentRecommendation. Shared by the LLM and
 * deterministic paths so the §4 contract (APPROVE ⇒ routable signal; HOLD/VETO ⇒
 * none) and the schema self-check are enforced identically regardless of source.
 */
function assemble(
  input: AgentGraphInput,
  now: () => number,
  startedAt: number,
  analystReports: AgentRecommendation['analystReports'],
  debateTranscript: AgentRecommendation['debateTranscript'],
  traderDecision: TraderDecision,
  riskVerdict: AgentRecommendation['riskVerdict'],
  costUsd: number,
): AgentRecommendation {

  const routable = riskVerdict.verdict === 'APPROVE' && traderDecision.action !== 'HOLD';
  const proposedSignal = routable ? buildProposedSignal(input, traderDecision, input.asOf) : null;

  const recommendation: AgentRecommendation = {
    symbol: input.symbol,
    asOf: input.asOf,
    action: traderDecision.action,
    conviction: traderDecision.conviction,
    sizeMultiplier: riskVerdict.sizeMultiplier,
    proposedSignal,
    verdict: riskVerdict.verdict,
    analystReports,
    debateTranscript,
    traderDecision,
    riskVerdict,
    costUsd: round6(costUsd),
    latencyMs: Math.max(0, now() - startedAt),
  };

  const errors = validateAgentRecommendation(recommendation);
  if (errors.length > 0) {
    throw new AgentGraphError('stub graph produced an invalid AgentRecommendation', errors);
  }
  return recommendation;
}
