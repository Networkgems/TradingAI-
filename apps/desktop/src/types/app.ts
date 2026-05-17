// TRA-419 — App-level interfaces extracted from App.tsx.
import type { TradeSignal, AccountState, Position, OptionsAccountState, EngineMarketReviewState } from '@trading-app/shared';

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
  // TRA-389 — market-review regime context. `enabled` is false when the
  // gate-consumption flag is off (or no review exists yet); optional so a
  // server running a pre-TRA-389 build still type-checks against this state.
  marketReview?: EngineMarketReviewState;
}
