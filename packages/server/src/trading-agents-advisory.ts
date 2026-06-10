// TRA-747 (TRA-529 P2) — the advisory orchestration seam. One small, testable
// place where the four CFO operating conditions are enforced before a single
// dollar of real LLM spend can flow:
//
//   #1 cap   — per-user/day spend hard-stops at $2.00 (agent-spend-store). When a
//              user has reached the cap, this falls back to the deterministic
//              (zero-cost) graph instead of issuing another paid call.
//   #2 advisor-mode — this module has ZERO path to capital. It takes no broker /
//              account / order client, performs no routing, and returns the
//              recommendation as DATA with `routedToCapital: false` (always). Even
//              an APPROVE with a routable proposedSignal is surfaced for display +
//              audit only; wiring it to positions is a NEW authorization (P4), out
//              of scope here.
//   #3 kill switches — TWO independent off-switches each cut LLM spend to zero:
//              the per-user banner toggle (`enabled`, from AccountSettings
//              .tradingAgentsEnabled) AND the env credential/kill (`resolveTradingAgentsLlm`
//              returns null when the Anthropic key is absent or the kill env is set).
//   #4 aggregate readout — every recorded call rolls into the daily aggregate the
//              CFO reads at `GET /api/health/agent-spend`.
//
// The deterministic graph (no `llm`) is always a safe fallback: it produces a
// schema-valid, zero-cost AgentRecommendation, so a disabled/capped/keyless run
// still surfaces an advisory read without spending.
import {
  runAgentGraph,
  createAnthropicLlmClientFromEnv,
  type AgentGraphDeps,
  type AgentGraphInput,
  type LlmClient,
} from '@trading-app/agents';
import type { AgentRecommendation } from '@trading-app/shared';
import {
  isOverUserDailyCap,
  recordAgentSpend,
} from './agent-spend-store.js';

/**
 * Explicit env kill switch (acceptance #3, second switch). When truthy the
 * advisory layer makes NO LLM calls regardless of credentials — a one-flag, ops-
 * level off-switch independent of the per-user banner toggle.
 */
export const LLM_KILL_ENV_VAR = 'TRADING_AGENTS_LLM_DISABLED';

function isTruthy(raw: string | undefined): boolean {
  if (raw == null) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * Resolve the LlmClient the advisory layer runs against, or `null` to run the
 * deterministic (zero-spend) fallback. Returns null when (a) the explicit env kill
 * is set, or (b) no Anthropic credential is configured. Either condition cuts LLM
 * spend to exactly zero — the env-side kill switch of acceptance #3.
 */
export function resolveTradingAgentsLlm(env: NodeJS.ProcessEnv = process.env): LlmClient | null {
  if (isTruthy(env[LLM_KILL_ENV_VAR])) return null;
  return createAnthropicLlmClientFromEnv(env);
}

export interface AdviseOptions {
  /** Owning user for the per-user/day cap + aggregate attribution. */
  user: string | undefined;
  /** The per-user "Trading Agents" banner toggle (AccountSettings.tradingAgentsEnabled). */
  enabled: boolean;
  /** Resolved LlmClient, or null to force the deterministic zero-spend path. */
  llm: LlmClient | null;
  /** Clock seam (epoch ms). Default Date.now(). */
  now?: number;
  /** Graph deps EXCEPT `llm` (this module owns whether the model is wired). */
  graphDeps?: Omit<AgentGraphDeps, 'llm'>;
}

export interface AdviseResult {
  recommendation: AgentRecommendation;
  /** True iff a real (paid) model path ran this call. */
  llmUsed: boolean;
  /**
   * ALWAYS false in P2 — the advisor-mode invariant (acceptance #2). The
   * recommendation is logged + broadcast for display/audit only; nothing here
   * routes it to capital. Flipping this is a new authorization (P4).
   */
  routedToCapital: false;
}

/**
 * Produce one advisory AgentRecommendation for a symbol, enforcing the cap + both
 * kill switches before any paid call. Runs the real LlmClient-backed graph only
 * when the layer is enabled (banner), a model is wired (env), AND the user is
 * under the daily cap; otherwise falls back to the deterministic zero-cost graph.
 * Records real spend against the per-user/day ledger. Never routes to capital.
 */
export async function adviseSymbol(
  input: AgentGraphInput,
  opts: AdviseOptions,
): Promise<AdviseResult> {
  const now = opts.now ?? Date.now();
  const underCap = !isOverUserDailyCap(opts.user, now);
  const useLlm = opts.enabled && opts.llm != null && underCap;

  const deps: AgentGraphDeps = {
    ...opts.graphDeps,
    ...(useLlm ? { llm: opts.llm! } : {}),
  };

  const recommendation = await runAgentGraph(input, deps);

  // Only real, non-cached spend is accounted (the deterministic path stamps 0).
  if (useLlm && recommendation.costUsd > 0) {
    recordAgentSpend(opts.user, recommendation.costUsd, now);
  }

  return { recommendation, llmUsed: useLlm, routedToCapital: false };
}
