// TRA-544 (TRA-529 §2B) — the single seam that decides which system owns the
// trade decision on a given tick. The engine consults this each tick; exactly
// one path is active so the deterministic and multi-agent systems never decide
// at once. The "Trading Agents" banner toggle flips the underlying setting.
import { resolveTradingAgentsEnabled, type AccountSettings } from '@trading-app/shared';

export type DecisionPath = 'deterministic' | 'agents';

/**
 * Resolve the active decision path from account settings. `'agents'` when the
 * runtime "Trading Agents" master switch is ON, else `'deterministic'`
 * (today's strategy/router/risk stack). Absent flag ↔ `'deterministic'`.
 */
export function selectDecisionPath(settings: AccountSettings): DecisionPath {
  return resolveTradingAgentsEnabled(settings) ? 'agents' : 'deterministic';
}

/** True when the multi-agent layer is the active decision-maker this tick. */
export function isAgentsPathActive(settings: AccountSettings): boolean {
  return selectDecisionPath(settings) === 'agents';
}

/**
 * True when the deterministic auto-router should run. It is SUSPENDED while the
 * agents path is active (TRA-529 §2B: "never both deciding at once"). The
 * engine ANDs this with its existing per-mode auto-trading flag and risk gates.
 */
export function isDeterministicPathActive(settings: AccountSettings): boolean {
  return selectDecisionPath(settings) === 'deterministic';
}
