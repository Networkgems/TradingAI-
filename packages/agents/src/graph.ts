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
  type RiskVerdict,
  type TradeSignal,
  type TraderDecision,
} from '@trading-app/shared';
import type { AgentGraphInput, UserTradingMemory } from './types.js';
import type { LlmClient, LlmThinkingOptions } from './llm-client.js';
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
  /**
   * TRA-915 — notional (USD) at/above which the FINAL risk/decision step escalates to
   * the Opus `apex` tier; trades below it keep the routine `strong` (Sonnet) tier.
   * Undefined ⇒ never escalate (apex stays off until ops configures the threshold),
   * so the deterministic and low-notional paths can never silently incur Opus cost.
   */
  apexNotionalUsd?: number;
  /**
   * TRA-1042 — when set, the judgment tiers (trader synthesis + the final risk
   * verdict) run with adaptive thinking at this effort. Off by default (the
   * analyst fan-out on Haiku never gets thinking — it would 400 on `effort`). The
   * advisory layer sources this from an env flag; the client applies it only on
   * supporting models and lifts `max_tokens` / drops `temperature` accordingly.
   */
  thinking?: LlmThinkingOptions;
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
    const t = await runTraderLlm(input, a.reports, debate, deps.llm, {
      ...(deps.thinking ? { thinking: deps.thinking } : {}),
    });
    // 4. Risk panel + manager — the FINAL decision step. Escalates to the Opus `apex`
    //    tier only for high-notional trades (TRA-915); routine screening stays on Sonnet.
    const r = await runRiskPanelLlm(t.decision, deps.llm, {
      minRiskReward: deps.risk?.minRiskReward,
      tier: riskDecisionTier(input.notionalUsd, deps.apexNotionalUsd),
      ...(input.userMemory?.riskTolerance ? { riskTolerance: input.userMemory.riskTolerance } : {}),
      ...(deps.thinking ? { thinking: deps.thinking } : {}),
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
const round4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/**
 * TRA-915 — pick the model tier for the FINAL risk/decision step. Returns `apex`
 * (Opus) only when a finite, positive trade notional is at/above the configured
 * threshold; otherwise `strong` (Sonnet) for routine screening. An undefined or
 * non-positive threshold disables escalation entirely (apex never fires), so Opus
 * cost is only ever incurred for genuinely high-stakes trades once ops opts in.
 */
export function riskDecisionTier(
  notionalUsd: number | undefined,
  apexNotionalUsd: number | undefined,
): 'strong' | 'apex' {
  if (
    typeof apexNotionalUsd === 'number' &&
    apexNotionalUsd > 0 &&
    typeof notionalUsd === 'number' &&
    Number.isFinite(notionalUsd) &&
    notionalUsd >= apexNotionalUsd
  ) {
    return 'apex';
  }
  return 'strong';
}

/**
 * TRA-850 — the deterministic DE-RISK sizing tilt the user's persistent memory
 * implies, as a fraction in (0,1]. An explicit `sizingMultiplier` wins; otherwise
 * a stated `riskTolerance` supplies a default (conservative halves, moderate is
 * neutral, aggressive does NOT enlarge — the agent layer can only ever shrink, so
 * 1 is the ceiling). Absent/blank memory ⇒ 1 (no change). Clamped to (0,1].
 */
export function memorySizingTilt(memory: UserTradingMemory | undefined): number {
  if (!memory) return 1;
  if (typeof memory.sizingMultiplier === 'number' && Number.isFinite(memory.sizingMultiplier)) {
    return Math.min(1, Math.max(0.01, memory.sizingMultiplier));
  }
  switch (memory.riskTolerance) {
    case 'conservative':
      return 0.5;
    case 'moderate':
    case 'aggressive':
    default:
      return 1;
  }
}

/**
 * TRA-850 — apply the user's persistent PREFERENCES to the risk verdict, purely
 * as a DE-RISK personalization: the final + every persona size multiplier is
 * shrunk by {@link memorySizingTilt} (never enlarged — it is clamped at the
 * incoming size), and a one-line reason records the tilt so the personalization
 * is auditable. Verdict, panel personas, and the no-trade (VETO/size-0) case are
 * untouched — this changes HOW BIG, never WHETHER. Preferences only; the
 * promotion/calibration gate stays authoritative. Returns the verdict unchanged
 * when memory is absent or implies no shrink.
 */
export function personalizeRiskVerdict(
  verdict: RiskVerdict,
  memory: UserTradingMemory | undefined,
): RiskVerdict {
  const tilt = memorySizingTilt(memory);
  // Nothing to do when there is no tilt, no trade to size, or no memory at all.
  if (!memory || tilt >= 1 || verdict.sizeMultiplier <= 0) return verdict;
  const pct = Math.round(tilt * 100);
  const why = memory.sizingMultiplier != null
    ? `user sizing default ${pct}%`
    : `${memory.riskTolerance} risk tolerance`;
  return {
    verdict: verdict.verdict,
    sizeMultiplier: round4(verdict.sizeMultiplier * tilt),
    panel: verdict.panel.map((p) => ({
      persona: p.persona,
      sizeMultiplier: round4(p.sizeMultiplier * tilt),
      reasons: p.reasons,
    })),
    reasons: [
      ...verdict.reasons,
      `Personalized: shrunk size to ${pct}% per ${why} (preference only — de-risk, no gate change).`,
    ],
  };
}

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

  // TRA-850 — personalize the verdict from the user's persistent preferences. A
  // pure DE-RISK sizing tilt: it can shrink the size multiplier (never enlarge)
  // and never flips the verdict or routability, so the additive invariant and the
  // promotion gate are untouched.
  const personalizedVerdict = personalizeRiskVerdict(riskVerdict, input.userMemory);

  const routable = personalizedVerdict.verdict === 'APPROVE' && traderDecision.action !== 'HOLD';
  const proposedSignal = routable ? buildProposedSignal(input, traderDecision, input.asOf) : null;

  const recommendation: AgentRecommendation = {
    symbol: input.symbol,
    asOf: input.asOf,
    action: traderDecision.action,
    conviction: traderDecision.conviction,
    sizeMultiplier: personalizedVerdict.sizeMultiplier,
    proposedSignal,
    verdict: personalizedVerdict.verdict,
    analystReports,
    debateTranscript,
    traderDecision,
    riskVerdict: personalizedVerdict,
    costUsd: round6(costUsd),
    latencyMs: Math.max(0, now() - startedAt),
  };

  const errors = validateAgentRecommendation(recommendation);
  if (errors.length > 0) {
    throw new AgentGraphError('stub graph produced an invalid AgentRecommendation', errors);
  }
  return recommendation;
}
