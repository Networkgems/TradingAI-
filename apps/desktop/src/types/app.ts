// TRA-419 — App-level interfaces extracted from App.tsx.
import type { TradeSignal, AccountState, Position, OptionsAccountState, EngineMarketReviewState, AgentRecommendation } from '@trading-app/shared';

export interface SymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable';
}

export interface AppState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: Position[];
  options: OptionsAccountState;
  lastTick: number;
  tradingHalted: boolean;
  haltReason: string | null;
  autoTradingEnabled: boolean;
  // TRA-544 — true when the "Trading Agents" multi-agent layer is the active
  // decision-maker (deterministic auto-routing suspended). Optional so a
  // pre-TRA-544 server still type-checks against this state.
  tradingAgentsEnabled?: boolean;
  // TRA-796 / TRA-895 — gating mode. When BOTH tradingAgentsEnabled and
  // tradingAgentsGatingEnabled are on, an agent APPROVE recommendation is
  // auto-routed as a risk-checked order. In demo mode that means the agents
  // actually open/monitor/close paper trades (advisory-only when gating is
  // off). LIVE routing additionally requires tradingAgentsLiveGatingEnabled —
  // the board+CTO go-live gate. Optional so a pre-TRA-796 server still
  // type-checks against this state.
  tradingAgentsGatingEnabled?: boolean;
  tradingAgentsLiveGatingEnabled?: boolean;
  // TRA-544 — latest advisory recommendations from the multi-agent layer (P1
  // deterministic stub). Empty/absent when the layer is off.
  agentRecommendations?: AgentRecommendation[];
  // TRA-389 — market-review regime context. `enabled` is false when the
  // gate-consumption flag is off (or no review exists yet); optional so a
  // server running a pre-TRA-389 build still type-checks against this state.
  marketReview?: EngineMarketReviewState;
}
