// TRA-419 — App-level interfaces extracted from App.tsx.
import type { TradeSignal, AccountState, Position, OptionsAccountState, EngineMarketReviewState, AgentRecommendation } from '@trading-app/shared';

export interface SymbolState {
  symbol: string;
  price: number;
  volume: number;
  change: number;
  changePct: number;
  lastUpdated: number;
  // TRA-2610 — FRESHNESS / AVAILABILITY ONLY. `'suspect'` was removed from this
  // union; plausibility is `moveSuspect` below. One field could not hold both facts
  // — `'unavailable'` overwrote `'suspect'` and a fabricated move reached #1.
  // TRA-418 — `'stale'` was already emitted by the crypto path and was missing from
  // this copy of the union; added while I was here.
  quoteStatus?: 'ok' | 'rate_limited' | 'unavailable' | 'stale';
  // TRA-2610 — the price is live but the published session move is not believable
  // (unadjusted prev close). `change` / `changePct` are still the RAW server values;
  // the UI degrades the cells rather than trusting them. Read it through
  // `isQuoteMoveUnreliable()`, which also re-executes the rule.
  moveSuspect?: boolean;
}

export interface AppState {
  symbols: SymbolState[];
  signals: TradeSignal[];
  account: AccountState;
  closedPositions: Position[];
  options: OptionsAccountState;
  lastTick: number;
  // TRA-1350 — ms timestamp of the last completed engine scan tick (0 before
  // the first tick). Optional so a pre-TRA-1350 server still type-checks.
  lastScanAt?: number;
  // TRA-1350 — true when the US equities session is open. Surfaced by the
  // server (`isStockMarketOpen()`); optional for pre-TRA-1350 compatibility.
  marketOpen?: boolean;
  tradingHalted: boolean;
  haltReason: string | null;
  // TRA-2246 — machine-readable class of the active halt, so the HaltBanner can
  // decide whether its "Clear halt" control applies. Only 'daily_breaker' is
  // cleared by /api/trading/reset-halt; 'book_giveback' / 'session_stop' are
  // day-latched risk controls that lift only on the ET day roll (offering a
  // dead "Clear halt" button for those was the reported bug). Optional so a
  // pre-TRA-2246 server still type-checks.
  haltKind?: 'kill_switch' | 'daily_breaker' | 'book_giveback' | 'session_stop' | 'feed_stale' | null;
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
