// TRA-544 (TRA-529 §1–4) — the orchestration graph skeleton. Wires the tiers
// in order:  analysts → bull/bear debate → trader synthesis → risk panel/manager
// → AgentRecommendation. P1 runs the DETERMINISTIC FAKE agents (no LLM, zero
// spend); the structure is the contract P2 fills with real, LlmClient-backed
// agents. The single emitted object is an `AgentRecommendation` (§4): in
// advisor mode it is logged + broadcast and rendered on the dashboard; only on
// APPROVE does it carry a routable `proposedSignal`.
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

  // 1. Analyst tier (parallel-safe pure fakes in P1).
  const analystReports = runAnalysts(input);
  // 2. Bull/bear debate + judge.
  const debateTranscript = runDebate(analystReports, deps.debateRounds ?? 2);
  // 3. Trader synthesis.
  const traderDecision = runTrader(input, analystReports, debateTranscript, deps.trader);
  // 4. Risk panel + manager.
  const riskVerdict = runRiskPanel(traderDecision, deps.risk);

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
    costUsd: 0, // P1 stub: no LLM spend.
    latencyMs: Math.max(0, now() - startedAt),
  };

  const errors = validateAgentRecommendation(recommendation);
  if (errors.length > 0) {
    throw new AgentGraphError('stub graph produced an invalid AgentRecommendation', errors);
  }
  return recommendation;
}
