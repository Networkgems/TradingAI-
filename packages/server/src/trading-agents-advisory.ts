// TRA-747 (TRA-529 P2) — the advisory orchestration seam. One small, testable
// place where the four CFO operating conditions are enforced before a single
// dollar of real LLM spend can flow:
//
//   #1 cap   — per-user/day spend hard-stops at the configured cap ($10/user/day per
//              TRA-915, agent-spend-store) AND a company-wide daily ceiling hard-stops
//              aggregate spend. When either is reached, this falls back to the
//              deterministic (zero-cost) graph instead of issuing another paid call.
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
  type NewsHeadline,
} from '@trading-app/agents';
import {
  nameAliasesFor,
  newsMentionsSymbol,
  type AgentRecommendation,
  type NewsItem,
} from '@trading-app/shared';
import {
  commitReservation,
  releaseReservation,
  tryReserveAgentSpend,
} from './agent-spend-store.js';

/** Cap on point-in-time headlines fed to the news analyst — small + cheap. */
const MAX_NEWS_HEADLINES = 12;

/**
 * TRA-795 — shape the engine's sentiment-scored news cache into the news analyst's
 * point-in-time `NewsHeadline[]` for one symbol. Keeps only articles that mention
 * the symbol (ticker or name alias) AND were published at/before `asOf` (the §3.1
 * no-look-ahead contract), newest first, capped. Pure + side-effect-free so the
 * filter is unit-testable without the engine; returns `[]` (analyst abstains)
 * when nothing matches.
 */
export function buildNewsHeadlines(
  newsCache: readonly NewsItem[],
  symbol: string,
  asOf: number,
): NewsHeadline[] {
  const sym = symbol.toUpperCase();
  const names = nameAliasesFor(sym);
  const out: NewsHeadline[] = [];
  for (const n of newsCache) {
    if (!newsMentionsSymbol(n, sym, names)) continue;
    const ts = Date.parse(n.publishedAt);
    if (!Number.isFinite(ts) || ts > asOf) continue;
    out.push({
      headline: n.title,
      timestamp: ts,
      source: n.source,
      ...(typeof n.sentiment?.score === 'number' ? { sentiment: n.sentiment.score } : {}),
    });
  }
  return out.sort((a, b) => b.timestamp - a.timestamp).slice(0, MAX_NEWS_HEADLINES);
}

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

/**
 * TRA-915 — env override for the notional threshold (USD) at/above which the FINAL
 * risk/decision step escalates to the Opus `apex` tier. Empty/invalid/non-positive ⇒
 * undefined, which leaves apex OFF (the graph never escalates), so Opus-tier cost is
 * incurred only once ops sets a real threshold. Routine screening always stays on
 * Haiku/Sonnet.
 */
export const OPUS_NOTIONAL_ENV_VAR = 'TRADING_AGENTS_OPUS_NOTIONAL_USD';

export function resolveApexNotionalUsd(env: NodeJS.ProcessEnv = process.env): number | undefined {
  const raw = env[OPUS_NOTIONAL_ENV_VAR];
  if (raw == null || raw.trim() === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * TRA-1042 — env flag activating adaptive thinking on the judgment tiers (trader
 * synthesis + the final risk verdict). Set to one of `low` / `medium` / `high` to
 * turn it on at that effort; empty/unset/invalid ⇒ undefined ⇒ OFF (current
 * behavior, no thinking). Default-off keeps live cost and behavior unchanged until
 * an operator opts in. The analyst fan-out (Haiku) is never affected — Haiku
 * rejects `effort`, and the client only applies thinking on supporting models.
 */
export const THINKING_EFFORT_ENV_VAR = 'TRADING_AGENTS_THINKING_EFFORT';

export function resolveThinkingEffort(
  env: NodeJS.ProcessEnv = process.env,
): 'low' | 'medium' | 'high' | undefined {
  const raw = env[THINKING_EFFORT_ENV_VAR]?.trim().toLowerCase();
  return raw === 'low' || raw === 'medium' || raw === 'high' ? raw : undefined;
}

/**
 * TRA-941 — true when the env kill switch (TRADING_AGENTS_LLM_DISABLED) is set.
 * Piece 3 makes this gate EXECUTION too, not just LLM spend, so the engine reads
 * it before placing any agent order. Independent of the per-user banner toggle.
 */
export function isTradingAgentsLlmDisabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return isTruthy(env[LLM_KILL_ENV_VAR]);
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
 * Produce one advisory AgentRecommendation for a symbol, enforcing the per-user cap,
 * the company-wide daily ceiling (TRA-915), and both kill switches before any paid
 * call. Runs the real LlmClient-backed graph only when the layer is enabled (banner),
 * a model is wired (env), the user is under the per-user daily cap, AND aggregate
 * company spend is under the daily ceiling; otherwise falls back to the deterministic
 * zero-cost graph. The final risk/decision step escalates to the Opus `apex` tier only
 * for trades whose notional is at/above the configured threshold (env-driven, off by
 * default). Records real spend against the per-user/day ledger. Never routes to capital.
 */
export async function adviseSymbol(
  input: AgentGraphInput,
  opts: AdviseOptions,
): Promise<AdviseResult> {
  const now = opts.now ?? Date.now();
  // TRA-1045 R2 — admit the paid path with an ATOMIC reserve-or-deny instead of a
  // read-then-write cap check. tryReserveAgentSpend checks the per-user cap AND the
  // company ceiling and books an in-flight reservation in one synchronous step, so two
  // concurrent adviseSymbol calls for the same user can no longer both slip under the
  // cap across the awaited model round-trip. A null return means no headroom → take the
  // deterministic zero-cost path, exactly as the old `!isOverUserDailyCap` gate did.
  const reservation = opts.enabled && opts.llm != null ? tryReserveAgentSpend(opts.user, now) : null;
  const useLlm = reservation != null;

  // TRA-915 — the Opus-escalation threshold comes from env unless the caller pinned one
  // explicitly on graphDeps (tests/overrides win).
  const apexNotionalUsd = opts.graphDeps?.apexNotionalUsd ?? resolveApexNotionalUsd();
  // TRA-1042 — adaptive thinking on the judgment tiers; env-driven, off by default,
  // and only meaningful on the LLM path (the deterministic fallback ignores it).
  const thinkingEffort = opts.graphDeps?.thinking?.effort ?? resolveThinkingEffort();

  const deps: AgentGraphDeps = {
    ...opts.graphDeps,
    ...(apexNotionalUsd != null ? { apexNotionalUsd } : {}),
    ...(useLlm && thinkingEffort ? { thinking: { effort: thinkingEffort } } : {}),
    ...(useLlm ? { llm: opts.llm! } : {}),
  };

  try {
    const recommendation = await runAgentGraph(input, deps);
    if (reservation) {
      // Reconcile the in-flight hold to the call's real cost. Only real, non-cached
      // spend is booked (the deterministic path stamps 0 → the hold is just released).
      commitReservation(reservation, recommendation.costUsd, now);
    }
    return { recommendation, llmUsed: useLlm, routedToCapital: false };
  } catch (err) {
    // The paid call threw — release the hold so a transient failure can't leak budget
    // and permanently shrink the user's daily headroom.
    if (reservation) releaseReservation(reservation, now);
    throw err;
  }
}
