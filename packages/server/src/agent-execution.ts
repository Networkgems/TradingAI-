// TRA-941 (TRA-813 P3) — the advisory→execution seam. ONE small, pure place that
// decides whether a CONFIRMED proposal may actually place an order. It composes
// every gate the issue requires, in precedence order, so the engine wiring stays
// a thin caller and every block reason is unit-testable:
//
//   1. Kill switch gates EXECUTION, not just LLM spend: a disabled per-user
//      banner toggle OR the env kill (TRADING_AGENTS_LLM_DISABLED) cuts order
//      placement to zero (TRA-941 Piece 3).
//   2. The TRA-526 risk circuit-breaker / global kill switch (halt) overrides
//      everything.
//   3. Per-mode independence: the per-mode setAutoTrading toggle for demo vs live
//      must be ON for that mode.
//   4. Live additionally requires the board+CTO go-live gate.
//   5. Daily execution caps (TRA-939): checked last so a cap message is precise.
//
// The caps themselves live in agent-execution-caps-store.ts (stateful, ET-day
// keyed); this module reads them through `capCheck` so the gate stays pure and
// the caller injects current state.
import {
  type AccountMode,
  type AgentOrderAudit,
  type Side,
} from '@trading-app/shared';
import { checkDailyExecutionCaps, type ExecutionGateDecision } from './agent-execution-caps-store.js';

export interface ExecutionGateInput {
  mode: AccountMode;
  /** Per-user "Trading Agents" banner toggle (AccountSettings.tradingAgentsEnabled). */
  bannerEnabled: boolean;
  /** Env kill switch TRADING_AGENTS_LLM_DISABLED is set (cuts execution to zero). */
  envKill: boolean;
  /** TRA-526 risk circuit-breaker / global kill switch engaged. */
  halted: boolean;
  /** Per-mode setAutoTrading toggle for this mode is ON. */
  autoTradeEnabled: boolean;
  /** Board+CTO live go-live gate cleared (only consulted in live mode). */
  liveGateCleared: boolean;
  /** Owning user for the daily-cap lookup. */
  user: string | undefined;
  /** Order notional in USD for the per-order + daily caps. */
  notional: number;
  /** Clock seam. */
  now?: number;
}

/** True when neither kill switch is engaged (banner ON and env kill not set). */
export function killSwitchClear(bannerEnabled: boolean, envKill: boolean): boolean {
  return bannerEnabled === true && envKill !== true;
}

/**
 * Decide whether a confirmed proposal may place an order. Pure: every input is
 * passed in and the only external read (daily caps) is itself a pure read of the
 * caps store. Returns the first failing gate's reason so the proposal can be left
 * pending with an accurate explanation (orders are never silently dropped).
 */
export function evaluateExecutionGate(input: ExecutionGateInput): ExecutionGateDecision {
  // 1 — kill switches gate execution to zero (banner OR env).
  if (input.envKill === true) {
    return { allowed: false, reason: 'execution blocked: env kill switch (TRADING_AGENTS_LLM_DISABLED) set' };
  }
  if (input.bannerEnabled !== true) {
    return { allowed: false, reason: 'execution blocked: Trading Agents banner toggle is OFF' };
  }
  // 2 — risk circuit-breaker / global kill switch overrides everything.
  if (input.halted === true) {
    return { allowed: false, reason: 'execution blocked: trading halted (risk circuit-breaker / kill switch)' };
  }
  // 3 — per-mode auto-trade toggle must be ON for this mode.
  if (input.autoTradeEnabled !== true) {
    return { allowed: false, reason: `execution blocked: ${input.mode} auto-trading toggle is OFF` };
  }
  // 4 — live needs the separate board+CTO go-live gate.
  if (input.mode === 'live' && input.liveGateCleared !== true) {
    return { allowed: false, reason: 'execution blocked: live routing disabled until board+CTO go-live gate is cleared' };
  }
  // 5 — daily execution caps (per-order + per-day), last for a precise message.
  return checkDailyExecutionCaps({
    user: input.user,
    mode: input.mode,
    notional: input.notional,
    ...(input.now !== undefined ? { now: input.now } : {}),
  });
}

/** Build the immutable audit record for one agent-placed order (TRA-941 Piece 3). */
export function buildOrderAudit(args: {
  agentId: string;
  recommendationId: string;
  proposalId: string;
  symbol: string;
  side: Side;
  size: number;
  notional: number;
  mode: AccountMode;
  orderId?: string | number | null;
  now: number;
}): AgentOrderAudit {
  return {
    agentId: args.agentId,
    recommendationId: args.recommendationId,
    proposalId: args.proposalId,
    symbol: args.symbol,
    side: args.side,
    size: args.size,
    notional: args.notional,
    mode: args.mode,
    orderId: args.orderId ?? null,
    timestamp: args.now,
  };
}
